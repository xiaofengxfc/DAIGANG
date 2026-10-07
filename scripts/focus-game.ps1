# Find and activate a supported game window after an explicit user click.
# ASCII-only source; use code points for the Chinese window titles.
#
# -Profile names the game (wuwa = Wuthering Waves, nte = Neverness to Everness).
# Matching used to be Wuthering-only, which meant "recognize" could never find
# any other game: it reported "no game window" while the game sat right there.
param(
  [string]$ProcessName = '',
  [string]$Profile = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# The Win32 calls below come from lib/XfcWin32.dll. This used to compile the C#
# inline with Add-Type -TypeDefinition, which needs csc.exe and a writable temp
# directory and gets blocked outright on some machines (measured: "Access is
# denied", and at another time "A required privilege is not held by the client").
# Loading a prebuilt assembly needs neither. See lib/win32.ps1.
. "$PSScriptRoot\lib\win32.ps1"
[void](Import-XfcWin32)

# Chinese window titles built from code points so this file stays ASCII.
#   0x9E23 0x6F6E = Wuthering Waves (CN title)
#   0x5F02 0x73AF = Neverness to Everness (CN title)
$wuwaTitle = ([char]0x9E23).ToString() + ([char]0x6F6E)
$nteTitle = ([char]0x5F02).ToString() + ([char]0x73AF)

# Per-game window fingerprints. Add a game = add an entry; nothing else in this
# script is game-specific. `Boost` only orders candidates when several match.
# `Fallback = $true` allows the "some Unreal game that is not another supported
# game" guess -- only turn it on for a game whose process name we are NOT sure
# about. It stays off for games we know: guessing there would happily focus the
# OTHER game and read the wrong screen (which looks like "recognition is broken").
$GAME_PROFILES = @{
  'wuwa' = [pscustomobject]@{
    Title = $wuwaTitle
    Patterns = @('(?i)wuthering', '(?i)mingchao')
    Boost = @('(?i)Client-Win64-Shipping', '(?i)^Wuthering')
    Fallback = $false
  }
  'nte' = [pscustomobject]@{
    Title = $nteTitle
    # Measured on this machine: process HTGame, window title 异环,
    # exe ...\Neverness To Everness\Client\WindowsNoEditor\HT\Binaries\win64\HTGame.exe.
    # The process name is NOT a *-Win64-Shipping one, so matching has to lean on
    # the install path and the Chinese title as well.
    Patterns = @('(?i)^HTGame$', '(?i)neverness', '(?i)\\HT\\Binaries', '(?i)NTE-Win64')
    Boost = @('(?i)^HTGame$', '(?i)neverness')
    # Signature is known now, so guessing is off: a wrong guess here would focus
    # the other game and read its screen, which looks like "recognition is broken".
    Fallback = $false
  }
}
# No -Profile (older callers) keeps the original Wuthering-first behaviour.
$wanted = if ($Profile -and $GAME_PROFILES.ContainsKey($Profile)) { $GAME_PROFILES[$Profile] } else { $null }

function Test-AnyPattern {
  param([string]$Value, [string[]]$Patterns)
  if (-not $Value) { return $false }
  foreach ($pattern in $Patterns) { if ($Value -match $pattern) { return $true } }
  return $false
}

$candidates = @()
$fallbackCandidates = @()
# Unreal-ish windows we saw but did not accept. Reported when nothing matched:
# otherwise "no game window" looks identical to "your process name is not what
# we predicted", and the fix (set XFC_GAME_PROCESS) is impossible to guess.
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
  $usedFallback = $false
  if ($ProcessName) {
    $matched = $p.ProcessName -ieq $ProcessName
  } elseif ($wanted) {
    $matched =
      (Test-AnyPattern $p.ProcessName $wanted.Patterns) -or
      (Test-AnyPattern $title $wanted.Patterns) -or
      (Test-AnyPattern $exePath $wanted.Patterns) -or
      $title.Contains($wanted.Title) -or
      $exePath.Contains($wanted.Title)
    if (-not $matched -and $wanted.Fallback) {
      # Unreal games ship as *-Win64-Shipping.exe. When the game's own name does
      # not show up anywhere we can read, fall back to "the Unreal game that is
      # NOT one of the other supported games" -- reported as matchedBy=fallback
      # so the UI can say it guessed. Without this, a game whose process name we
      # did not predict looks identical to "the game is not running".
      $isUnreal = (Test-AnyPattern $p.ProcessName '(?i)-Win64-Shipping$') -or (Test-AnyPattern $exePath '(?i)-Win64-Shipping\.exe$')
      $isOtherGame = $false
      foreach ($key in $GAME_PROFILES.Keys) {
        if ($key -eq $Profile) { continue }
        $other = $GAME_PROFILES[$key]
        if ((Test-AnyPattern $p.ProcessName $other.Patterns) -or (Test-AnyPattern $title $other.Patterns) -or (Test-AnyPattern $exePath $other.Patterns) -or $title.Contains($other.Title)) {
          $isOtherGame = $true
          break
        }
      }
      if ($isUnreal -and -not $isOtherGame) {
        $matched = $true
        $usedFallback = $true
      }
    }
  } else {
    # No profile: original Wuthering-only heuristic
    $wuthering = $GAME_PROFILES['wuwa']
    $matched =
      (Test-AnyPattern $p.ProcessName $wuthering.Patterns) -or
      (Test-AnyPattern $title $wuthering.Patterns) -or
      $title.Contains($wuthering.Title) -or
      (Test-AnyPattern $exePath $wuthering.Patterns) -or
      $exePath.Contains($wuthering.Title)
  }

  if ($matched) {
    $score = 0
    if ($wanted) {
      if (Test-AnyPattern $p.ProcessName $wanted.Boost) { $score += 100 }
      if (Test-AnyPattern $exePath $wanted.Boost) { $score += 50 }
    } else {
      if ($p.ProcessName -match '(?i)Client-Win64-Shipping') { $score += 100 }
      if ($exePath -match '(?i)Client-Win64-Shipping\.exe$') { $score += 50 }
      if ($p.ProcessName -match '(?i)^Wuthering') { $score += 80 }
    }
    if (-not $ProcessName -and $p.ProcessName -match '(?i)launcher|updater') { $score -= 200 }
    $row = [pscustomobject]@{
      Process = $p.ProcessName
      ProcessId = $p.Id
      Title = $title
      Hwnd = $hwnd.ToInt64()
      Score = $score
      MatchedBy = if ($usedFallback) { 'fallback' } else { 'name' }
      ExePath = $exePath
    }
    if ($usedFallback) { $fallbackCandidates += $row } else { $candidates += $row }
  }
}
# A named match always wins over a guess.
if (-not $candidates.Count -and $fallbackCandidates.Count) { $candidates = $fallbackCandidates }

if (-not $candidates.Count) {
  # Say WHY nothing turned up. A process running at LOW integrity cannot see a
  # game that runs elevated -- Get-Process silently drops it -- and a plain
  # "window not found" message sends people looking in the wrong place (measured:
  # a repo directory carrying a "Low" mandatory label made the app low integrity,
  # which hid the game entirely; the same label also broke %TEMP% writes and
  # Add-Type). whoami reports the SID, which is language-independent.
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

$target = $candidates | Sort-Object Score -Descending | Select-Object -First 1
$hwnd = [IntPtr]::new([Int64]$target.Hwnd)

# Remember what was in front BEFORE we steal focus. That is the window the user
# clicked "recognize" in -- their browser -- and the reading flow hands it back
# when it is done (see activate-window.ps1). Doing it this way beats guessing at
# browser titles: it works for any browser, and it is literally "go back".
$previous = [GameWindowFocus]::GetForegroundWindow()

[void][GameWindowFocus]::ShowWindowAsync($hwnd, 9) # SW_RESTORE
[void][GameWindowFocus]::SetForegroundWindow($hwnd)
$foreground = [GameWindowFocus]::GetForegroundWindow()
$focused = $foreground.ToInt64() -eq [Int64]$target.Hwnd

# SetForegroundWindow is subject to Windows' foreground-lock rules. If the
# direct attempt was refused, temporarily join the input queues and retry.
if (-not $focused) {
  $currentThread = [GameWindowFocus]::GetCurrentThreadId()
  $foregroundThread = [GameWindowFocus]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
  $targetThread = [GameWindowFocus]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
  $attached = @()
  $threads = @($foregroundThread, $targetThread) | Select-Object -Unique
  foreach ($thread in $threads) {
    if ($thread -and $thread -ne $currentThread -and [GameWindowFocus]::AttachThreadInput($currentThread, $thread, $true)) {
      $attached += $thread
    }
  }
  try {
    [void][GameWindowFocus]::ShowWindowAsync($hwnd, 9)
    [void][GameWindowFocus]::BringWindowToTop($hwnd)
    [void][GameWindowFocus]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 350
    $foreground = [GameWindowFocus]::GetForegroundWindow()
    $focused = $foreground.ToInt64() -eq [Int64]$target.Hwnd
  } finally {
    foreach ($thread in $attached) { [void][GameWindowFocus]::AttachThreadInput($currentThread, $thread, $false) }
  }
}

if (-not $focused) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'focus_denied' } | ConvertTo-Json -Compress))
  exit 3
}

# Only report a window worth going back to: zero means there was nothing in
# front, and the game itself means we did not actually come from anywhere else.
$previousHwnd = 0
if ($previous -ne [IntPtr]::Zero -and $previous.ToInt64() -ne [Int64]$target.Hwnd) {
  $previousHwnd = $previous.ToInt64()
}

[Console]::Out.WriteLine((@{
  ok = $true
  process = $target.Process
  processId = $target.ProcessId
  title = $target.Title
  hwnd = [string]$target.Hwnd
  previous = [string]$previousHwnd
  profile = $Profile
  matchedBy = $target.MatchedBy
  exePath = $target.ExePath
} | ConvertTo-Json -Compress))
