# Send a single whitelisted virtual key to the already-foreground game window.
# The caller activates the game first; this script refuses to type into any
# other application if focus changed while the recognition flow was running.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as
# GBK, so a non-ASCII comment corrupts the following quote characters and the
# whole script fails to parse ("missing expression after ','").
#
# The key goes out through [GameKeySend] (SendInput + MapVirtualKey), not
# keybd_event. The reasons are in xfc-win32.cs next to that class: the scan code
# must be real (games map keys by scan code and drop sc=0), and the result must
# be readable (SendInput returns 0 when UIPI refused, keybd_event returns
# nothing). Do not switch back.
param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  # F2 / F12 are the game's own screenshot keys (the game saves a file into its
  # screenshot folder). Our own capture is CopyFromScreen, a different path.
  [Parameter(Mandatory = $true)][ValidateSet('B', 'M', 'ESC', 'F2', 'F12')][string]$Key
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# The Win32 calls below come from XfcWin32.dll (prebuilt, so no csc.exe and
# no temp directory are needed -- see win32.ps1, which lives next to this file).
. "$PSScriptRoot\win32.ps1"
[void](Import-XfcWin32)

$target = [IntPtr]::new([Int64]$WindowHandle)

function Get-ForegroundInfo {
  $fg = [GameKeyInput]::GetForegroundWindow()
  $fgProcessId = [uint32]0
  [void][GameKeyInput]::GetWindowThreadProcessId($fg, [ref]$fgProcessId)
  return [pscustomobject]@{
    Handle = $fg
    HandleValue = $fg.ToInt64()
    ProcessId = [int64]$fgProcessId
  }
}

function Test-TargetForeground {
  param($Info)
  return ($Info.HandleValue -eq [int64]$WindowHandle) -and ($Info.ProcessId -eq [int64]$ProcessId)
}

# Focus can be lost between activating the window and sending the key: the
# game's splash animation, a UAC prompt, an IME window, another app. Re-take it
# below before giving up, otherwise the key is never sent.
#
# Attempt 1: ALT tap + SetForegroundWindow (same as focus-game.ps1).
if (-not (Test-TargetForeground (Get-ForegroundInfo))) {
  try {
    # Synthesize one ALT press: Windows' foreground lock then treats the
    # caller as having just received user input.
    try { [GameKeyFocus]::TapAlt() } catch { }
    Start-Sleep -Milliseconds 30
    [void][GameKeyFocus]::ShowWindowAsync($target, 9) # SW_RESTORE
    [void][GameKeyFocus]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 120
  } catch { }
}

# Attempt 2: attach our input queue to the foreground window and the game's
# (focus-game.ps1's second half). Attempt 1 alone is refused on some machines.
if (-not (Test-TargetForeground (Get-ForegroundInfo))) {
  $current = Get-ForegroundInfo
  $currentThread = [GameKeyFocus]::GetCurrentThreadId()
  $foregroundThread = [GameKeyFocus]::GetWindowThreadProcessId($current.Handle, [IntPtr]::Zero)
  $targetThread = [GameKeyFocus]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
  $attached = @()
  foreach ($thread in (@($foregroundThread, $targetThread) | Select-Object -Unique)) {
    if ($thread -and $thread -ne $currentThread -and [GameKeyFocus]::AttachThreadInput($currentThread, $thread, $true)) {
      $attached += $thread
    }
  }
  try {
    [GameKeyFocus]::TapAlt()
    Start-Sleep -Milliseconds 30
    [void][GameKeyFocus]::ShowWindowAsync($target, 9)
    [void][GameKeyFocus]::BringWindowToTop($target)
    [void][GameKeyFocus]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 250
  } finally {
    foreach ($thread in $attached) { [void][GameKeyFocus]::AttachThreadInput($currentThread, $thread, $false) }
  }
}

$foreground = Get-ForegroundInfo
if (-not (Test-TargetForeground $foreground)) {
  # Never send when focus is not on the game: B would land in whatever window is
  # in front (a browser, a chat box). Report both handles -- a bare
  # game_not_foreground cannot tell a stale handle from stolen focus.
  [Console]::Out.WriteLine((@{
    ok = $false
    code = 'game_not_foreground'
    want = $WindowHandle
    got = $foreground.HandleValue
    gotProcessId = $foreground.ProcessId
  } | ConvertTo-Json -Compress))
  exit 2
}

$virtualKey = switch ($Key) {
  'B' { 0x42; break }
  'M' { 0x4D; break }
  'ESC' { 0x1B; break }
  # VK_F2 = 0x71, VK_F12 = 0x7B (function keys are 0x70 + (n-1))
  'F2' { 0x71; break }
  'F12' { 0x7B; break }
}
$scan = [GameKeySend]::ScanOf([int]$virtualKey)

# Press, hold 80ms, release: the timing of a physical key press. 1 = Windows
# inserted the event, 0 = refused (UIPI), and LastErrorValue says why.
$down = [GameKeySend]::SendDown([int]$virtualKey)
if ($down -ne 1) {
  [Console]::Out.WriteLine((@{
    ok = $false
    code = 'input_blocked'
    key = $Key
    scan = $scan
    sent = 0
    win32_error = [GameKeySend]::LastErrorValue
  } | ConvertTo-Json -Compress))
  exit 4
}
Start-Sleep -Milliseconds 80
$up = [GameKeySend]::SendUp([int]$virtualKey)
if ($up -ne 1) {
  # The down went through but the release did not. Retry once, otherwise the game
  # sees the key held down.
  $retry = [GameKeySend]::SendUp([int]$virtualKey)
  if ($retry -ne 1) {
    [Console]::Out.WriteLine((@{
      ok = $false
      code = 'input_blocked'
      key = $Key
      scan = $scan
      sent = 1
      stuck = $true
      win32_error = [GameKeySend]::LastErrorValue
    } | ConvertTo-Json -Compress))
    exit 4
  }
}

[Console]::Out.WriteLine((@{
  ok = $true
  key = $Key
  scan = $scan
  sent = 2
} | ConvertTo-Json -Compress))
