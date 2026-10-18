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
  [long]$WindowHandle = 0,
  # Try to read the window's own pixels (PrintWindow) when it is NOT in front.
  # Why: SetForegroundWindow is subject to Windows' foreground-lock rules and can
  # be refused outright (both the direct call and the AttachThreadInput retry),
  # which used to make capture impossible even though the window was right there.
  # CopyFromScreen copies from the SCREEN, so it needs the window in front;
  # PrintWindow asks the window to draw itself into our DC, front or not.
  [switch]$AllowUnfocused
)
$ErrorActionPreference = 'Stop'

# The DPI block below needs Win32 calls, which come from lib/XfcWin32.dll. This
# used to compile the C# inline with Add-Type -TypeDefinition; when that compile
# fails the DPI block fails and the damage is SILENT -- the screenshot comes out
# at the wrong scale (measured: a 2560x1600 screen captured as 1707x1067) and
# every recognition after that is wrong. The compile can be blocked outright on
# some machines, so load a prebuilt assembly instead: no csc.exe, no temp
# directory, nothing to fail. See lib/win32.ps1.
. "$PSScriptRoot\win32.ps1"
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
  # A minimized window reports a real size but is parked far off-screen at
  # (-32000, -32000). Capturing that rect yields black (or whatever the desktop
  # has out there), and the caller would then diagnose "exclusive fullscreen"
  # and tell the user to change the display mode -- for a window that is merely
  # minimized. Refuse with its own code so the message can be right.
  # Checked against the virtual screen so a legitimately negative origin
  # (a monitor placed left of / above the primary one) is not rejected.
  $onScreen = $false
  try {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $onScreen = ($rect.Left + $w -gt $vs.Left) -and ($rect.Left -lt $vs.Right) -and ($rect.Top + $h -gt $vs.Top) -and ($rect.Top -lt $vs.Bottom)
  } catch {
    $onScreen = $rect.Left -gt -30000 -and $rect.Top -gt -30000
  }
  if (-not $onScreen) {
    $code = 'window_minimized'
    try {
      [IO.File]::WriteAllText("$Out.error", $code, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
    [Console]::Error.WriteLine($code)
    exit 7
  }
} else {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = $bounds.X
  $y = $bounds.Y
  $w = $bounds.Width
  $h = $bounds.Height
}

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
# '' = not decided yet. When the window is NOT in front and we cannot read its own
# pixels, we must NOT fall back to CopyFromScreen: that copies from the SCREEN
# (usually covered by the browser) and yields a plausible-looking desktop image.
# ASCII only on purpose -- see the header note.
$method = ''
# How much of the desktop the capture rect covers. A window covering essentially
# the whole screen cannot be told apart from "the whole screen", which matters
# when we are NOT allowed to rely on focus (see the caller's -AllowUnfocused).
#
# MUST be computed from the ORIGINAL $w/$h, before MaxWidth scales the bitmap
# down: a 2560x1600 window scaled to 1920 would look like it covers only 75% of
# the screen and the caller would wrongly trust a desktop capture (measured).
$srcW = $w
$srcH = $h
$covered = $false
try {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $covered = ($srcW -ge [int]($screen.Width * 0.98)) -and ($srcH -ge [int]($screen.Height * 0.98))
} catch { }

# Can we read the window's own pixels? Only meaningful when we have a window
# handle; a whole-screen grab has no window to ask.
$canAskWindow = $AllowUnfocused -and $WindowHandle -gt 0

if ($canAskWindow -and [WindowCapture]::IsForeground([IntPtr]::new([Int64]$WindowHandle))) {
  # Already in front: CopyFromScreen is the cheapest correct path.
  $canAskWindow = $false
}

if ($canAskWindow) {
  # Try PrintWindow (with PW_RENDERFULLCONTENT for DirectX surfaces), and if that
  # refuses, BitBlt straight from the window DC.
  #
  # The Graphics object owns the HDC for the whole block: GetHdc() and ReleaseHdc()
  # must bracket every use, and releasing early would leave it drawing into a dead
  # DC (silent black image, not an exception).
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  try {
    $hwnd = [IntPtr]::new([Int64]$WindowHandle)
    if ([WindowCapture]::PrintWindow($hwnd, $hdc, [WindowCapture]::PW_RENDERFULLCONTENT)) {
      $method = 'PrintWindow-full'
    } elseif ([WindowCapture]::PrintWindow($hwnd, $hdc, [WindowCapture]::PW_CLIENTONLY)) {
      $method = 'PrintWindow-client'
    } else {
      $winDc = [WindowCapture]::GetWindowDC($hwnd)
      if ($winDc -ne [IntPtr]::Zero) {
        try {
          if ([WindowCapture]::BitBlt($hdc, 0, 0, $w, $h, $winDc, 0, 0, [WindowCapture]::SRCCOPY)) { $method = 'BitBlt' }
        } finally {
          [void][WindowCapture]::ReleaseDC($hwnd, $winDc)
        }
      }
    }
  } catch {
    # Previously this said $method = 'CopyFromScreen', which is exactly what must
    # NOT happen: the window is not in front, so the screen area is covered by
    # whatever is on top of it. Leave it unset and let the check below refuse.
    $method = ''
  } finally {
    $g.ReleaseHdc($hdc)
    $g.Dispose()
  }
}

if ($canAskWindow -and -not $method) {
  # We wanted the window's own pixels and all three ways failed (DirectX exclusive
  # fullscreen, or the OS refused). Do NOT fall back to CopyFromScreen: silently
  # storing a desktop screenshot is worse than an error. The caller turns this
  # code into a user-facing message (<out>.error is read by src/vision/screen.mjs).
  $code = 'window_pixels_unavailable'
  try {
    [IO.File]::WriteAllText("$Out.error", $code, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
  $bmp.Dispose()
  [Console]::Error.WriteLine($code)
  exit 6
}

if (-not $method) {
  $method = 'CopyFromScreen'
}

if ($method -eq 'CopyFromScreen') {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  } finally {
    $g.Dispose()
  }
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
# Sidecar metadata: the caller needs to know HOW this was captured. A PNG on its
# own cannot say "I am a PrintWindow of a DirectX window that came back as the
# desktop" -- and that failure mode produces a plausible-looking image.
try {
  $meta = @{
    method = $method
    width = $w
    height = $h
    src_width = $srcW
    src_height = $srcH
    covered = $covered
    dpi = $dpiAware
    windowHandle = $WindowHandle
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText("$Out.json", $meta, (New-Object System.Text.UTF8Encoding($false)))
} catch { }
Write-Host "ok $w x $h dpi=$dpiAware method=$method covered=$covered"
