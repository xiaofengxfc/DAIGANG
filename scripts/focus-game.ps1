# Find and activate the Wuthering Waves window after an explicit user click.
# ASCII-only source; use code points for the Chinese window title.
param(
  [string]$ProcessName = ''
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

$chineseTitle = ([char]0x9E23).ToString() + ([char]0x6F6E)
$candidates = @()
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  $hwnd = $p.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { continue }
  $title = [string]$p.MainWindowTitle
  try { $exePath = [string]$p.Path } catch { $exePath = '' }

  if ($ProcessName) {
    $matched = $p.ProcessName -ieq $ProcessName
  } else {
    $matched =
      ($p.ProcessName -match '(?i)wuthering|mingchao') -or
      ($title -match '(?i)wuthering|mingchao') -or
      $title.Contains($chineseTitle) -or
      ($exePath -match '(?i)wuthering|mingchao') -or
      $exePath.Contains($chineseTitle)
  }
  if ($matched) {
    $score = 0
    if ($p.ProcessName -match '(?i)Client-Win64-Shipping') { $score += 100 }
    if ($exePath -match '(?i)Client-Win64-Shipping\.exe$') { $score += 50 }
    if ($p.ProcessName -match '(?i)^Wuthering') { $score += 80 }
    if (-not $ProcessName -and $p.ProcessName -match '(?i)launcher|updater') { $score -= 200 }
    $candidates += [pscustomobject]@{
      Process = $p.ProcessName
      ProcessId = $p.Id
      Title = $title
      Hwnd = $hwnd.ToInt64()
      Score = $score
    }
  }
}

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
  [Console]::Out.WriteLine((@{ ok = $false; code = 'game_window_missing'; integrity = $integrity } | ConvertTo-Json -Compress))
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
} | ConvertTo-Json -Compress))
