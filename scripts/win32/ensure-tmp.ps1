# Shared temp-directory guard for every script here that compiles C# with
# Add-Type -TypeDefinition.
#
# Why: Add-Type compiles C# on the fly, and that compile needs a writable temp
# directory. When the temp directory is not writable the compile throws
# ("Access is denied" / "The system cannot find the path specified"), and what
# that costs depends on the caller -- all of it bad:
#   * grab.ps1        -> the DPI block fails and the screenshot silently comes
#                        out at the wrong scale (2560x1600 captured as 1707x1067)
#   * focus-game.ps1  -> the script dies before it can focus the game window
#   * game-key.ps1    -> the script dies before it can send the key
#   * screen-info.ps1 -> prints nothing, which silently disables the self-test's
#                        "was the capture DPI-virtualized?" comparison
# Measured on a real machine: writes to %TEMP% can be denied (EPERM) for a
# specific process even though the same user can write there from a shell.
#
# Dot-source it, then call Ensure-WritableTemp:
#   . "$PSScriptRoot\ensure-tmp.ps1"
#   Ensure-WritableTemp -FallbackDir (Split-Path -Parent $Out)   # or omit for data/tmp
#
# NOTE: keep this file pure ASCII and BOM-less. Windows PowerShell 5.1 reads a
# BOM-less .ps1 as GBK, so non-ASCII comments in .ps1 files break the parser.

function Test-WritableDir([string]$dir) {
  if (-not $dir) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $dir)) { return $false }
    $probe = Join-Path $dir ('.xfc-write-test-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe, 'ok')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch { return $false }
}

# Point $env:TEMP / $env:TMP at a directory that can actually be written to, and
# return it. The current temp directory is kept whenever it works, so behaviour
# is unchanged on a healthy machine. Falls back to -FallbackDir, and to
# <repo>\data\tmp when no fallback is given.
function Ensure-WritableTemp([string]$FallbackDir = '') {
  if (Test-WritableDir $env:TEMP) { return $env:TEMP }
  if (-not $FallbackDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    $FallbackDir = Join-Path $repoRoot 'data\tmp'
  }
  try { New-Item -ItemType Directory -Force -Path $FallbackDir | Out-Null } catch { }
  if (Test-WritableDir $FallbackDir) {
    $env:TEMP = $FallbackDir
    $env:TMP = $FallbackDir
    return $FallbackDir
  }
  return $env:TEMP
}
