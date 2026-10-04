$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$svgPath = Join-Path $projectRoot 'public\favicon.svg'
$outputPath = Join-Path $PSScriptRoot 'daigan.ico'
if (-not (Test-Path -LiteralPath $svgPath)) { throw "Web favicon was not found: $svgPath" }

$edgeCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) {
  $edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($edgeCommand) { $edge = $edgeCommand.Source }
}
if (-not $edge) { throw 'Microsoft Edge was not found. It is required to rasterize public/favicon.svg.' }

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('daigan-icon-' + [Guid]::NewGuid().ToString('N'))
$svgContent = [IO.File]::ReadAllText($svgPath)
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

Add-Type -AssemblyName System.Drawing

function Render-SvgPng {
  param(
    [int]$Size,
    [string]$PngPath
  )

  $htmlPath = Join-Path $tempRoot ('source-' + $Size + '.html')
  $profile = Join-Path $tempRoot ('profile-' + $Size)
  $html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{width:' + $Size + 'px;height:' + $Size + 'px;margin:0;overflow:hidden;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>' + $svgContent + '</body></html>'
  [IO.File]::WriteAllText($htmlPath, $html, [Text.UTF8Encoding]::new($false))
  $htmlUri = ([Uri]::new([IO.Path]::GetFullPath($htmlPath))).AbsoluteUri
  $edgeArgs = @(
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1000',
    ('--user-data-dir=' + $profile),
    '--hide-scrollbars',
    '--default-background-color=00000000',
    ('--window-size=' + $Size + ',' + $Size),
    ('--screenshot=' + $PngPath),
    $htmlUri
  )
  & $edge @edgeArgs *> $null
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $lastLength = -1
  $stableReads = 0
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $PngPath) {
      $length = (Get-Item -LiteralPath $PngPath).Length
      if ($length -gt 0 -and $length -eq $lastLength) {
        $stableReads++
        if ($stableReads -ge 2) { break }
      }
      else { $stableReads = 0 }
      $lastLength = $length
    }
    Start-Sleep -Milliseconds 50
  }
  if (-not (Test-Path -LiteralPath $PngPath)) { throw "Edge did not produce a ${Size}x${Size} PNG." }
}

try {
  $sourcePngPath = Join-Path $tempRoot 'source-256.png'
  Render-SvgPng -Size 256 -PngPath $sourcePngPath
  $sourceBytes = [IO.File]::ReadAllBytes($sourcePngPath)
  $sourceStream = [IO.MemoryStream]::new($sourceBytes, $false)
  $sourceBitmap = [Drawing.Bitmap]::new($sourceStream)
  try {
    $images = @()
    foreach ($size in $sizes) {
      if ($size -eq 256) {
        $images += ,$sourceBytes
        continue
      }
      $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
          $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.Clear([Drawing.Color]::Transparent)
          $graphics.DrawImage($sourceBitmap, 0, 0, $size, $size)
        }
        finally { $graphics.Dispose() }
        $resizedPngPath = Join-Path $tempRoot ($size.ToString() + '.png')
        $bitmap.Save($resizedPngPath, [Drawing.Imaging.ImageFormat]::Png)
        $images += ,([IO.File]::ReadAllBytes($resizedPngPath))
      }
      finally { $bitmap.Dispose() }
    }
  }
  finally {
    $sourceBitmap.Dispose()
    $sourceStream.Dispose()
  }

  $parent = Split-Path -Parent $outputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $stream = [IO.File]::Open($outputPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $writer = [IO.BinaryWriter]::new($stream)
    try {
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$sizes.Count)
      $offset = 6 + (16 * $sizes.Count)
      for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        $bytes = $images[$i]
        $writer.Write([Byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([Byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([Byte]0)
        $writer.Write([Byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $bytes.Length
      }
      foreach ($bytes in $images) { $writer.Write($bytes) }
    }
    finally { $writer.Dispose() }
  }
  finally { $stream.Dispose() }
  Write-Host "Generated: $outputPath"
}
finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
