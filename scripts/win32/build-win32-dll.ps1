# Builds scripts/lib/XfcWin32.dll from scripts/lib/xfc-win32.cs.
#
# The .cs is the source of truth; the .dll is what the scripts actually load
# (see win32.ps1 for why). Run this after editing the .cs, and commit both.
#
#   powershell -ExecutionPolicy Bypass -File scripts\lib\build-win32-dll.ps1
#
# NOTE: keep this file pure ASCII and BOM-less (Windows PowerShell 5.1 reads a
# BOM-less .ps1 as GBK, so non-ASCII comments would break the parser).
$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'xfc-win32.cs'
$dll = Join-Path $PSScriptRoot 'XfcWin32.dll'
if (-not (Test-Path -LiteralPath $src)) { throw "Source not found: $src" }

if (Test-Path -LiteralPath $dll) { Remove-Item -LiteralPath $dll -Force }

Add-Type -TypeDefinition (Get-Content -LiteralPath $src -Raw) -OutputAssembly $dll -OutputType Library

$size = (Get-Item -LiteralPath $dll).Length
Write-Output "Built $dll ($size bytes)"

# Prove the freshly built assembly actually loads and exposes the five classes.
# Load the bytes rather than Assembly.LoadFrom: LoadFrom builds a file:// URI and
# this repo's path has Chinese characters in it, which makes that URI invalid
# (measured: COR_E_FILELOAD 0x80131515). See win32.ps1.
$asm = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll))
foreach ($name in @('ScreenDpi', 'DisplayMode', 'GameWindowFocus', 'GameKeyInput', 'GameKeyFocus', 'GameKeySend', 'WindowCapture')) {
  if (-not $asm.GetType($name)) { throw "Type $name is missing from the built assembly" }
}
Write-Output "Verified: ScreenDpi, DisplayMode, GameWindowFocus, GameKeyInput, GameKeyFocus, GameKeySend, WindowCapture"
