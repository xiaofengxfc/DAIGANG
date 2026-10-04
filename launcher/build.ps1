$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$cscCandidates = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'CSharp compiler was not found.' }

$source = Join-Path $PSScriptRoot 'DaiganLauncher.cs'
$output = Join-Path $projectRoot 'DaiganLauncher.exe'
$icon = Join-Path $PSScriptRoot 'daigan.ico'
if (-not (Test-Path -LiteralPath $icon)) {
  throw "Launcher icon was not found: $icon. Generate it with .\launcher\generate-icon.ps1 first."
}
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /debug- /utf8output /codepage:65001 `
  /out:$output `
  /win32icon:$icon `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Management.dll `
  /reference:System.Windows.Forms.dll `
  $source
if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
Write-Host "Built: $output"
