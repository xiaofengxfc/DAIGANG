# Grab the primary screen into a PNG. ASCII-only (see ocr.ps1 for why).
#   powershell -File grab.ps1 -Out "shot.png"
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $bounds.Width
$h = $bounds.Height
if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $h = [int]($h * $MaxWidth / $w)
  $w = $MaxWidth
}
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object System.Drawing.Size($bounds.Width, $bounds.Height)))
} finally {
  $g.Dispose()
}
try {
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bmp.Dispose()
}
Write-Host "ok $w x $h"
