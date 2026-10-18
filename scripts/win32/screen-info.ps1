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

# The Win32 call below comes from lib/XfcWin32.dll. This used to compile the C#
# inline with Add-Type -TypeDefinition, and a failed compile made this script
# print nothing -- which matters more than it looks: this is the ruler the
# self-test uses to notice a DPI-virtualized capture, so a broken ruler silently
# disables that guard. Loading a prebuilt assembly needs no csc.exe and no temp
# directory, so there is nothing left to fail. See lib/win32.ps1.
. "$PSScriptRoot\win32.ps1"
[void](Import-XfcWin32)

Write-Output ([DisplayMode]::Primary())
