param(
  [Parameter(Mandatory = $true)][UInt32]$ProcessId,
  [Parameter(Mandatory = $true)][UInt64]$Hwnd
)
$ErrorActionPreference = 'Stop'

# 探一次「本程序能不能把按键送到这个游戏窗口」。
#
# 高完整性（以管理员运行的）游戏窗口会拒绝低完整性进程的一切输入投递 ——
# 窗口照样能切到前台，但按键永远到不了游戏。详见 xfc-input-probe.cs 的注释。
# 输出一行 JSON：{post_ok, post_err, self_elevated, target_elevated, input_ok}
. "$PSScriptRoot\ensure-tmp.ps1"

Add-Type -Path (Join-Path $PSScriptRoot 'xfc-input-probe.cs')

Write-Output ([XfcInputProbe]::Probe($Hwnd, $ProcessId))
