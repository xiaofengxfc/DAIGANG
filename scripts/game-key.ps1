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

# Add-Type below compiles C# and needs a writable temp directory; without this
# the script dies here instead of sending the key (see lib/ensure-tmp.ps1).
. "$PSScriptRoot\lib\ensure-tmp.ps1"
[void](Ensure-WritableTemp)

$keySig = @'
using System;
using System.Runtime.InteropServices;
public static class GameKeyInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $keySig

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
