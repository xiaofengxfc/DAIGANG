# Loads the shared Win32 helper assembly for the scripts that need P/Invoke.
#
# Add-Type -TypeDefinition compiles C# on the fly, which needs csc.exe and a
# writable temp directory -- and on some machines that is blocked outright.
# Measured on a real machine, the same call failed with "Access is denied" and,
# at another time, "A required privilege is not held by the client", even when
# the temp directory was provably writable. Loading a prebuilt assembly needs
# neither a compiler nor a temp directory, and it is far faster (no 100-300ms
# compile on every call -- focus-game.ps1 runs before every recognition).
#
# Usage from a script:
#   . "$PSScriptRoot\win32.ps1"
#   [void](Import-XfcWin32)
#
# NOTE: keep this file pure ASCII and BOM-less. Windows PowerShell 5.1 reads a
# BOM-less .ps1 as GBK, so non-ASCII comments here break the parser.

function Import-XfcWin32([string]$TempFallback = '') {
  # Already loaded in this session (a script may call this twice).
  if ('ScreenDpi' -as [type]) { return 'loaded' }

  $dll = Join-Path $PSScriptRoot 'XfcWin32.dll'
  if (Test-Path -LiteralPath $dll) {
    try {
      # Load the BYTES, not Add-Type -Path / Assembly.LoadFrom. LoadFrom turns the
      # path into a file:// URI, and this repo lives in a folder whose name has
      # Chinese characters in it, which makes that URI invalid -- measured:
      # COR_E_FILELOAD (0x80131515) "Operation is not supported", on a perfectly
      # good assembly. The same file loads fine from an ASCII path, which is what
      # pinned the cause down. Loading bytes never touches a URI, so any path works.
      [void][Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll))
      return 'dll'
    } catch {
      # Unreadable or not a real assembly: fall through and compile instead.
    }
  }

  # No prebuilt assembly (a source-only checkout, or someone deleted it): compile
  # the .cs once. This path is the one that can be blocked outright, so it also
  # needs the temp guard. Rebuild the .dll with lib/build-win32-dll.ps1.
  . "$PSScriptRoot\ensure-tmp.ps1"
  [void](Ensure-WritableTemp -FallbackDir $TempFallback)
  $src = Join-Path $PSScriptRoot 'xfc-win32.cs'
  Add-Type -TypeDefinition (Get-Content -LiteralPath $src -Raw)
  return 'compiled'
}
