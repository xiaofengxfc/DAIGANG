# OCR one image with the engine built into Windows, and write word boxes as TSV.
# ASCII-only on purpose: powershell.exe reads .ps1 as ANSI when there is no BOM,
# so any non-ASCII comment here could corrupt parsing. Output is written as UTF-8.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ImagePath a.png -OutPath a.tsv
#
# Output format: one word per line, "x<TAB>y<TAB>w<TAB>h<TAB>text".
# Positions matter: the caller pairs a label ("xing sheng") with the number on the
# same row to its right. Windows OCR sometimes returns that number on a later
# output line, so line order alone is not enough.
#
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$Lang = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

  # WinRT async operations must be turned into a .NET Task before they can be awaited.
  $asTask = $null
  foreach ($m in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
    if ($m.Name -ne 'AsTask') { continue }
    $ps = $m.GetParameters()
    if ($ps.Count -eq 1 -and $ps[0].ParameterType.Name -eq 'IAsyncOperation`1') { $asTask = $m; break }
  }
  if (-not $asTask) {
    [System.IO.File]::WriteAllText($OutPath, 'ERROR:NO_AWAIT_HELPER', (New-Object System.Text.UTF8Encoding($false)))
    exit 3
  }

  function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  # Engine: requested language first, otherwise whatever the user profile has.
  $engine = $null
  try {
    $language = New-Object Windows.Globalization.Language($Lang)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  } catch {
    $engine = $null
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) {
    [System.IO.File]::WriteAllText($OutPath, 'ERROR:NO_ENGINE', (New-Object System.Text.UTF8Encoding($false)))
    exit 2
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $sb = New-Object System.Text.StringBuilder
  $tab = [char]9
  foreach ($line in $result.Lines) {
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      # Plain concatenation with an explicit tab char: no format operator, no escapes.
      $row = [string][int]$r.X + $tab + [string][int]$r.Y + $tab + [string][int]$r.Width + $tab + [string][int]$r.Height + $tab + $word.Text
      $null = $sb.AppendLine($row)
    }
  }

  [System.IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  exit 0
} catch {
  [System.IO.File]::WriteAllText($OutPath, ('ERROR:' + $_.Exception.Message), (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}
