# Send a single whitelisted virtual key to the already-foreground game window.
# The caller activates the game first; this script refuses to type into any
# other application if focus changed while the recognition flow was running.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as
# GBK, so a non-ASCII comment corrupts the following quote characters and the
# whole script fails to parse ("missing expression after ','").
param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  # F2 / F12 are the game's own screenshot keys: pressing one makes the game
  # save a shot into its screenshot folder. Our own capture is a different
  # path (CopyFromScreen), but players habitually press F2, so allow it.
  [Parameter(Mandatory = $true)][ValidateSet('B', 'M', 'ESC', 'F2', 'F12')][string]$Key
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# The Win32 calls below come from XfcWin32.dll (prebuilt, so no csc.exe and
# no temp directory are needed -- see win32.ps1, which lives next to this file).
. "$PSScriptRoot\win32.ps1"
[void](Import-XfcWin32)

$foreground = [GameKeyInput]::GetForegroundWindow()
$foregroundProcessId = [uint32]0
[void][GameKeyInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)

# Focus can be lost between "activate the window" and "send the key" (the
# game's own splash animation, a UAC prompt, an IME window, another app
# stealing focus...). This used to give up and return game_not_foreground,
# which looked to the user like "the window did switch but the screen never
# advanced" -- because B was never sent at all.
# Now: first try to take focus back ourselves (same approach as
# focus-game.ps1), then send.
if ($foreground.ToInt64() -ne $WindowHandle -or $foregroundProcessId -ne $ProcessId) {
  $hwnd = [IntPtr]::new([Int64]$WindowHandle)
  try {
    # Synthesize one ALT press: Windows' foreground lock then treats the
    # caller as having just received user input.
    try { [GameKeyFocus]::TapAlt() } catch { }
    Start-Sleep -Milliseconds 30
    [void][GameKeyFocus]::ShowWindowAsync($hwnd, 9) # SW_RESTORE
    [void][GameKeyFocus]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 120
  } catch { }

  $foreground = [GameKeyInput]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  [void][GameKeyInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
}

if ($foreground.ToInt64() -ne $WindowHandle -or $foregroundProcessId -ne $ProcessId) {
  # If focus still will not come back, say so honestly: do NOT send blindly.
  # Typing into whatever window happens to be in front (a browser, a chat
  # box) is far more dangerous than failing -- B would become text in
  # someone else's input field.
  [Console]::Out.WriteLine((@{
    ok = $false
    code = 'game_not_foreground'
    # Report both the expected and the actual handle: a bare not_foreground
    # makes it impossible to tell a stale handle from stolen focus.
    want = $WindowHandle
    got = $foreground.ToInt64()
    gotProcessId = $foregroundProcessId
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

try {
  [GameKeyInput]::keybd_event([byte]$virtualKey, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
} finally {
  [GameKeyInput]::keybd_event([byte]$virtualKey, 0, 2, [UIntPtr]::Zero)
}

[Console]::Out.WriteLine((@{ ok = $true; key = $Key } | ConvertTo-Json -Compress))
