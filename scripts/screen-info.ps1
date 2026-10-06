# Physical display mode of the primary screen, DPI-virtualization proof.
#   powershell -File screen-info.ps1
#
# Why this exists: the DPI-unaware screen size (what a non-DPI-aware process gets
# from GetSystemMetrics / Screen.Bounds) is a virtualized value, e.g. 1707x1067 on
# a 2560x1600 screen at 150% scaling. EnumDisplaySettings reports the real video
# mode instead, so this is an independent way to tell whether a capture covered
# the whole screen or just the top-left crop of it (see grab.ps1).
#
# Output: "2560 x 1600" (or "unknown" if the API cannot be reached).
$ErrorActionPreference = 'Stop'

# Add-Type compiles C# on the fly and needs a writable temp directory. When the temp
# directory is not writable the compile throws ("The system cannot find the path
# specified") and this script prints nothing -- which matters more than it looks:
# this is the ruler the self-test uses to notice a DPI-virtualized capture, so a
# broken ruler silently disables that guard. Fall back to the project's own data/tmp.
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as
# GBK, so non-ASCII comments here would break the parser.
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
if (-not (Test-WritableDir $env:TEMP)) {
  $fallbackTmp = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\tmp'
  try { New-Item -ItemType Directory -Force -Path $fallbackTmp | Out-Null } catch { }
  if (Test-WritableDir $fallbackTmp) {
    $env:TEMP = $fallbackTmp
    $env:TMP = $fallbackTmp
  }
}

$sig = @'
using System;
using System.Runtime.InteropServices;

public static class DisplayMode {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion;
    public ushort dmDriverVersion;
    public ushort dmSize;
    public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public uint dmDisplayOrientation;
    public uint dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel;
    public uint dmPelsWidth;
    public uint dmPelsHeight;
    public uint dmDisplayFlags;
    public uint dmDisplayFrequency;
    public uint dmICMMethod;
    public uint dmICMIntent;
    public uint dmMediaType;
    public uint dmDitherType;
    public uint dmReserved1;
    public uint dmReserved2;
    public uint dmPanningWidth;
    public uint dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

  public static string Primary() {
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, -1, ref dm)) return "unknown";
    return dm.dmPelsWidth + " x " + dm.dmPelsHeight;
  }
}
'@
Add-Type -TypeDefinition $sig
Write-Output ([DisplayMode]::Primary())
