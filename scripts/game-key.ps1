# Send a single whitelisted virtual key to the already-foreground game window.
# The caller activates the game first; this script refuses to type into any
# other application if focus changed while the recognition flow was running.
param(
  [Parameter(Mandatory = $true)][long]$WindowHandle,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  # F2 / F12 是游戏自带的截图键：按下去游戏自己会把图存到它的截图目录。
  # 我们抓屏是另一条路（CopyFromScreen），但玩家习惯按 F2，所以允许发。
  [Parameter(Mandatory = $true)][ValidateSet('B', 'M', 'ESC', 'F2', 'F12')][string]$Key
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

# 焦点在「切过去」和「发按键」之间可能已经掉了（游戏自己的启动动画、UAC 提示、
# 输入法窗口、后台程序抢焦点…）。以前这里直接放弃并返回 game_not_foreground，
# 于是用户看到的现象是「窗口切过去了，但界面没翻开」—— 因为 B 根本没发出去。
# 现在：先试着自己重新抢一次焦点（和 focus-game.ps1 同一套办法），再发。
if ($foreground.ToInt64() -ne $WindowHandle -or $foregroundProcessId -ne $ProcessId) {
  $hwnd = [IntPtr]::new([Int64]$WindowHandle)
  try {
    # 合成一次 ALT：Windows 的前台锁会据此认为「调用方刚收到过用户输入」
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
  # 还是抢不过去就老实说：**不盲发按键**。打到别的窗口上（浏览器、聊天框）
  # 比报错危险得多 —— B 会变成往别人的输入框里打字。
  [Console]::Out.WriteLine((@{
    ok = $false
    code = 'game_not_foreground'
    # 把「期望的」和「实际的」都报出来：只报一句 not_foreground 的话，
    # 排查时分不清是窗口句柄过期，还是焦点被别人抢了。
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
  # VK_F2 = 0x71, VK_F12 = 0x7B（功能键就是 0x70 + (n-1)）
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
