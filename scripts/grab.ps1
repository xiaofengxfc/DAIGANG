# Grab a specified game window, or the primary screen, into a PNG.
# ASCII-only (see ocr.ps1 for why).
#   powershell -File grab.ps1 -Out "shot.png"
#
# DPI: this script MUST become DPI aware *before* it reads the window bounds.
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
  [int]$MaxWidth = 0,
  [long]$WindowHandle = 0
)
$ErrorActionPreference = 'Stop'

# The DPI block below needs Win32 calls, which come from lib/XfcWin32.dll. This
# used to compile the C# inline with Add-Type -TypeDefinition; when that compile
# fails the DPI block fails and the damage is SILENT -- the screenshot comes out
# at the wrong scale (measured: a 2560x1600 screen captured as 1707x1067) and
# every recognition after that is wrong. The compile can be blocked outright on
# some machines, so load a prebuilt assembly instead: no csc.exe, no temp
# directory, nothing to fail. See lib/win32.ps1.
. "$PSScriptRoot\lib\win32.ps1"
# Swallow a load failure here and let the block below report dpi=failed, exactly
# as a failed Add-Type used to: the caller prints the dpi value but does not act
# on it, so the loud signal is that string showing up in the capture line.
try { [void](Import-XfcWin32 -TempFallback (Split-Path -Parent $Out)) } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Per-monitor-v2 (Win10 1703+) -> per-monitor (Win8.1+) -> system aware (Vista+).
# Old systems may not have the newer entry points; fall back and keep going.
$dpiAware = 'no'
try {
  if (-not ('ScreenDpi' -as [type])) { throw 'ScreenDpi helper is not loaded' }
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

$x = 0
$y = 0
if ($WindowHandle -gt 0) {
  $rect = [ScreenDpi+RECT]::new()
  $hwnd = [IntPtr]::new([Int64]$WindowHandle)
  if (-not [ScreenDpi]::GetWindowRect($hwnd, [ref]$rect)) {
    throw 'Failed to read game window bounds (the window may have closed)'
  }
  $x = $rect.Left
  $y = $rect.Top
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -lt 1 -or $h -lt 1) { throw 'Game window has no visible capture area' }
} else {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = $bounds.X
  $y = $bounds.Y
  $w = $bounds.Width
  $h = $bounds.Height
}

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
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
