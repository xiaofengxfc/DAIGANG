// Win32 P/Invoke declarations shared by the four scripts that need them
// (focus-game.ps1, game-key.ps1, grab.ps1, screen-info.ps1).
//
// Why this file exists instead of each script compiling its own C# with
// Add-Type -TypeDefinition: compiling on the fly needs csc.exe and a writable
// temp directory, and on some machines that is blocked outright. Measured on a
// real machine, the same Add-Type call failed with two different errors at
// different times -- "Access is denied" and "A required privilege is not held by
// the client" -- and it failed even when the temp directory was provably
// writable, so the temp directory was never the whole story. It also costs
// 100-300ms per call, and focus-game.ps1 runs before every recognition.
//
// So: compile this once into XfcWin32.dll (scripts/lib/build-win32-dll.ps1) and
// have the scripts load the assembly with Add-Type -Path, which needs no
// compiler, no temp directory and no privilege. lib/win32.ps1 still falls back
// to compiling this file when the .dll is missing.
//
// Keep this file pure ASCII, and keep the class/member names stable: the scripts
// reference them directly ([ScreenDpi]::..., [DisplayMode]::Primary(), ...).
using System;
using System.Runtime.InteropServices;

// DPI awareness + window rect, used by grab.ps1.
public static class ScreenDpi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}

// Physical display mode, used by screen-info.ps1 to prove a capture was not
// DPI-virtualized.
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

// Bringing the game window to the foreground, used by focus-game.ps1.
public static class GameWindowFocus {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}

// Sending one whitelisted key, used by game-key.ps1. Its
// GetWindowThreadProcessId overload differs from the one above on purpose: this
// script needs the process id back, so it takes an out parameter.
public static class GameKeyInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
