param(
  [Parameter(Mandatory = $true)][string]$WindowHandle
)

# Hand the foreground back to an already-known top-level window.
#
# The reading flow calls focus-game.ps1 first, which reports the window that was
# in front before the game took over (the browser the user clicked in). When the
# reading is finished this script puts that window back, so nobody has to
# Alt+Tab by hand.
#
# Same activation technique as focus-game.ps1 -- ShowWindowAsync + SetForegroundWindow,
# then an AttachThreadInput retry if Windows' foreground lock refuses -- but the
# window is handed in instead of searched for. All the P/Invoke lives in
# lib/xfc-win32.cs.

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\win32.ps1"
[void](Import-XfcWin32)

$hwnd = [IntPtr]::Zero
try {
  $hwnd = [IntPtr]::new([Int64]$WindowHandle)
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'bad_window_handle' } | ConvertTo-Json -Compress))
  exit 4
}

if ($hwnd -eq [IntPtr]::Zero) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'bad_window_handle' } | ConvertTo-Json -Compress))
  exit 4
}

# A window that was closed in the meantime: IsWindow is not in the shared set, so
# probe by asking for its thread -- a dead handle returns 0.
if ([GameWindowFocus]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero) -eq 0) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'window_gone' } | ConvertTo-Json -Compress))
  exit 5
}

[void][GameWindowFocus]::ShowWindowAsync($hwnd, 9) # SW_RESTORE (it may be minimised)
[void][GameWindowFocus]::SetForegroundWindow($hwnd)
$foreground = [GameWindowFocus]::GetForegroundWindow()
$done = $foreground.ToInt64() -eq $hwnd.ToInt64()

if (-not $done) {
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
    $done = $foreground.ToInt64() -eq $hwnd.ToInt64()
  } finally {
    foreach ($thread in $attached) { [void][GameWindowFocus]::AttachThreadInput($currentThread, $thread, $false) }
  }
}

if (-not $done) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'activate_denied' } | ConvertTo-Json -Compress))
  exit 3
}

[Console]::Out.WriteLine((@{ ok = $true; hwnd = [string]$hwnd.ToInt64() } | ConvertTo-Json -Compress))
