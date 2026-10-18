# Find a supported game window WITHOUT touching focus.
#
# Why this exists: focus-game.ps1 both finds the window AND brings it to the
# front, and Windows' foreground-lock rules can refuse the second half outright.
# When that happened, the window handle was never recorded, so grab.ps1 had
# nothing to capture from and fell back to a whole-screen grab -- which returns
# the desktop with whatever is covering the game (measured: the browser). A
# screenshot that looks plausible but is the wrong thing is worse than an error.
#
# So: this script only *looks*. It shares the same fingerprints as focus-game.ps1
# on purpose -- if the two disagreed, "found it" and "focused it" could point at
# different windows.
#
# ASCII-only; Chinese titles are built from code points (see focus-game.ps1).
param(
  [string]$ProcessName = '',
  [string]$Profile = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

. "$PSScriptRoot\lib\win32.ps1"
[void](Import-XfcWin32)

# Window bounds need a DPI-aware process for the same reason grab.ps1 does:
# a DPI-unaware process gets a *virtualized* screen size from Windows. Measured on
# a 2560x1600 screen at 150% scaling: an unaware process reports this game's
# window as 1707x1067 instead of its real size -- i.e. it reports a crop. The
# capture that follows then uses those bounds and grabs the wrong region.
# So the DPI block MUST run before GetWindowRect below, not after.
try {
  if ('ScreenDpi' -as [type]) {
    $done = $false
    try { $done = [ScreenDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $done = $false }
    if (-not $done) { try { $done = ([ScreenDpi]::SetProcessDpiAwareness(2) -eq 0) } catch { $done = $false } }
    if (-not $done) { try { $done = [ScreenDpi]::SetProcessDPIAware() } catch { $done = $false } }
  }
} catch { }

$wuwaTitle = ([char]0x9E23).ToString() + ([char]0x6F6E)
$nteTitle = ([char]0x5F02).ToString() + ([char]0x73AF)

$GAME_PROFILES = @{
  'wuwa' = [pscustomobject]@{
    Title = $wuwaTitle
    Patterns = @('(?i)wuthering', '(?i)mingchao')
    Boost = @('(?i)Client-Win64-Shipping', '(?i)^Wuthering')
  }
  'nte' = [pscustomobject]@{
    Title = $nteTitle
    Patterns = @('(?i)^HTGame$', '(?i)neverness', '(?i)\\HT\\Binaries', '(?i)NTE-Win64')
    Boost = @('(?i)^HTGame$', '(?i)neverness')
  }
}
$wanted = if ($Profile -and $GAME_PROFILES.ContainsKey($Profile)) { $GAME_PROFILES[$Profile] } else { $null }

function Test-AnyPattern {
  param([string]$Value, [string[]]$Patterns)
  if (-not $Value) { return $false }
  foreach ($pattern in $Patterns) { if ($Value -match $pattern) { return $true } }
  return $false
}

$candidates = @()
# Windows we saw but did not accept, reported when nothing matched. Without
# them, "the game is not running" and "your process name is not what we
# predicted" look identical -- and the fix (set XFC_GAME_PROCESS) is impossible
# to guess. Same wording as focus-game.ps1 so both paths tell the same story.
$seenGames = @()
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  $hwnd = $p.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { continue }
  $title = [string]$p.MainWindowTitle
  try { $exePath = [string]$p.Path } catch { $exePath = '' }
  if ((Test-AnyPattern $p.ProcessName '(?i)-Win64-Shipping$') -or (Test-AnyPattern $exePath '(?i)-Win64-Shipping\.exe$')) {
    $seenGames += "$($p.ProcessName) | $title"
  }

  $matched = $false
  if ($ProcessName) {
    $matched = $p.ProcessName -ieq $ProcessName
  } elseif ($wanted) {
    $matched =
      (Test-AnyPattern $p.ProcessName $wanted.Patterns) -or
      (Test-AnyPattern $title $wanted.Patterns) -or
      (Test-AnyPattern $exePath $wanted.Patterns) -or
      $title.Contains($wanted.Title) -or
      $exePath.Contains($wanted.Title)
  } else {
    $w = $GAME_PROFILES['wuwa']
    $matched = (Test-AnyPattern $p.ProcessName $w.Patterns) -or (Test-AnyPattern $title $w.Patterns) -or $title.Contains($w.Title)
  }
  if (-not $matched) { continue }

  $score = 0
  if ($wanted) {
    if (Test-AnyPattern $p.ProcessName $wanted.Boost) { $score += 100 }
    if (Test-AnyPattern $exePath $wanted.Boost) { $score += 50 }
  } else {
    if ($p.ProcessName -match '(?i)Client-Win64-Shipping') { $score += 100 }
  }
  if (-not $ProcessName -and $p.ProcessName -match '(?i)launcher|updater') { $score -= 200 }

  # A window with no area cannot be captured (minimized to tray, mid-close).
  $rect = [ScreenDpi+RECT]::new()
  $hasArea = $false
  if ([ScreenDpi]::GetWindowRect($hwnd, [ref]$rect)) {
    $hasArea = ($rect.Right - $rect.Left) -ge 2 -and ($rect.Bottom - $rect.Top) -ge 2
  }

  $candidates += [pscustomobject]@{
    Process = $p.ProcessName
    ProcessId = $p.Id
    Title = $title
    Hwnd = $hwnd.ToInt64()
    Score = $score
    HasArea = $hasArea
    Rect = "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
  }
}

if (-not $candidates.Count) {
  # Say WHY nothing turned up, exactly as focus-game.ps1 does: a process running
  # at LOW integrity cannot see an elevated game at all (Get-Process silently
  # drops it), and telling the user "no window found" sends them looking in the
  # wrong place. whoami reports the SID, which is language-independent.
  $integrity = 'unknown'
  try {
    $groups = (whoami /groups) 2>$null
    if ($groups -match 'S-1-16-12288') { $integrity = 'high' }
    elseif ($groups -match 'S-1-16-8192') { $integrity = 'medium' }
    elseif ($groups -match 'S-1-16-4096') { $integrity = 'low' }
  } catch { }
  [Console]::Out.WriteLine((@{ ok = $false; code = 'game_window_missing'; integrity = $integrity; seen = @($seenGames) } | ConvertTo-Json -Compress))
  exit 2
}

# Prefer a window we can actually capture from.
$target = $candidates | Sort-Object HasArea, Score -Descending | Select-Object -First 1

[Console]::Out.WriteLine((@{
  ok = $true
  process = $target.Process
  processId = $target.ProcessId
  title = $target.Title
  hwnd = [string]$target.Hwnd
  hasArea = $target.HasArea
  rect = $target.Rect
  profile = $Profile
  candidates = @($candidates.Count)
} | ConvertTo-Json -Compress))
