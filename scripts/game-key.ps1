# Send a single whitelisted virtual key to the already-foreground game window.
# The caller activates the game first; this script refuses to type into any
# other application if focus changed while the recognition flow was running.
param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('B', 'M', 'ESC')][string]$Key
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# The Win32 calls below come from lib/XfcWin32.dll (prebuilt, so no csc.exe and
# no temp directory are needed -- see lib/win32.ps1).
. "$PSScriptRoot\lib\win32.ps1"
[void](Import-XfcWin32)

$foreground = [GameKeyInput]::GetForegroundWindow()
$foregroundProcessId = [uint32]0
[void][GameKeyInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
if ($foreground.ToInt64() -ne $WindowHandle -or $foregroundProcessId -ne $ProcessId) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'game_not_foreground' } | ConvertTo-Json -Compress))
  exit 2
}

$virtualKey = switch ($Key) {
  'B' { 0x42; break }
  'M' { 0x4D; break }
  'ESC' { 0x1B; break }
}

try {
  [GameKeyInput]::keybd_event([byte]$virtualKey, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
} finally {
  [GameKeyInput]::keybd_event([byte]$virtualKey, 0, 2, [UIntPtr]::Zero)
}

[Console]::Out.WriteLine((@{ ok = $true; key = $Key } | ConvertTo-Json -Compress))
