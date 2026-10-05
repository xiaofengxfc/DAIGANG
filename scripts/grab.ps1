# Grab the primary screen into a PNG. ASCII-only (see ocr.ps1 for why).
#   powershell -File grab.ps1 -Out "shot.png"
#
# DPI: this script MUST become DPI aware *before* it asks for the screen size.
#
# Why: a DPI-unaware process gets a virtualized screen size from Windows. On a
# 2560x1600 screen at 150% scaling that is 1707x1067, and CopyFromScreen then
# copies that many *physical* pixels -- i.e. it grabs the top-left 1707x1067
# crop of the screen instead of the whole screen. The game HUD sits in the top
# bar across the full width (the anchor icon measured at ~0.89 of the width),
# so the right-hand resources fell outside the capture and nothing was ever
# recognized. Measured on such a box: unaware -> 1707x1067 (a crop, verified by
# comparing against a DPI-aware capture: mean pixel diff 4.1 for "crop" vs 41.3
# for "whole screen scaled down"), aware -> 2560x1600.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Per-monitor-v2 (Win10 1703+) -> per-monitor (Win8.1+) -> system aware (Vista+).
# Old systems may not have the newer entry points; fall back and keep going.
$dpiSig = @'
using System;
using System.Runtime.InteropServices;
public static class ScreenDpi {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
$dpiAware = 'no'
try {
  Add-Type -TypeDefinition $dpiSig -ErrorAction Stop
  $done = $false
  try { $done = [ScreenDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $done = $false }
  if ($done) { $dpiAware = 'per-monitor-v2' }
  if (-not $done) {
    try { $done = ([ScreenDpi]::SetProcessDpiAwareness(2) -eq 0) } catch { $done = $false }
    if ($done) { $dpiAware = 'per-monitor' }
  }
  if (-not $done) {
    try { $done = [ScreenDpi]::SetProcessDPIAware() } catch { $done = $false }
    if ($done) { $dpiAware = 'system' }
  }
} catch {
  $dpiAware = 'failed'
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $bounds.Width
$h = $bounds.Height

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object System.Drawing.Size($bounds.Width, $bounds.Height)))
} finally {
  $g.Dispose()
}

# MaxWidth (if asked for) scales the whole capture down afterwards -- shrinking
# the bitmap first would only clip the copy, not resize it.
$final = $bmp
if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $sw = $MaxWidth
  $sh = [int]($h * $MaxWidth / $w)
  $scaled = New-Object System.Drawing.Bitmap($sw, $sh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  try {
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $sw, $sh)
  } finally {
    $sg.Dispose()
  }
  $bmp.Dispose()
  $final = $scaled
  $w = $sw
  $h = $sh
}

try {
  $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $final.Dispose()
}
Write-Host "ok $w x $h dpi=$dpiAware"
