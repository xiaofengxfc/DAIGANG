# Key-injection probe for game-key-check.mjs. KEEP THIS FILE PURE ASCII.
#
# Opens a small window, brings it to the front, and records every WM_KEYDOWN /
# WM_KEYUP it receives -- including the hardware scan code from lParam, which is
# the number that matters: game-key.ps1 used to send sc=0 (keybd_event with a
# hardcoded 0), and game input paths that map by scan code drop such an event.
# That was silent because the script still reported success.
#
# Usage (driven by game-key-check.mjs, not by hand):
#   powershell -File key-probe.ps1 -Out <prefix> -Seconds 25
# It writes "<prefix>.hwnd" = "<hwnd>|<pid>" once the window is focused, logs to
# "<prefix>.log", and exits when "<prefix>.stop" appears or the deadline passes.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Seconds = 25
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class KeyProbeWindow : Form {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  public string LogPath;
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0100 || m.Msg == 0x0101) {
      long l = m.LParam.ToInt64();
      int vk = (int)m.WParam;
      int sc = (int)((l >> 16) & 0xFF);
      File.AppendAllText(LogPath, (m.Msg == 0x100 ? "DOWN" : "UP") + " vk=" + vk + " sc=" + sc + "\n");
    }
    base.WndProc(ref m);
  }
  public void Force() { ShowWindowAsync(this.Handle, 9); SetForegroundWindow(this.Handle); }
}
'@

$form = New-Object KeyProbeWindow
$form.LogPath = "$Out.log"
$form.Text = 'KEYPROBE'
$form.Width = 320
$form.Height = 200
$form.StartPosition = 'Manual'
$form.Left = 40
$form.Top = 40
$form.Show()
$form.Force()
Start-Sleep -Milliseconds 150
[void]$form.Force()

Set-Content -LiteralPath "$Out.hwnd" -Value ("{0}|{1}" -f $form.Handle.ToInt64(), $PID)

$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath "$Out.stop")) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 25
}
$form.Close()
