# Find and activate the Wuthering Waves window after an explicit user click.
# ASCII-only source; use code points for the Chinese window title.
param(
  [string]$ProcessName = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$focusSig = @'
using System;
using System.Runtime.InteropServices;
public static class GameWindowFocus {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
Add-Type -TypeDefinition $focusSig

$chineseTitle = ([char]0x9E23).ToString() + ([char]0x6F6E)
$candidates = @()
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  $hwnd = $p.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { continue }
  $title = [string]$p.MainWindowTitle
  try { $exePath = [string]$p.Path } catch { $exePath = '' }

  if ($ProcessName) {
    $matched = $p.ProcessName -ieq $ProcessName
  } else {
    $matched =
      ($p.ProcessName -match '(?i)wuthering|mingchao') -or
      ($title -match '(?i)wuthering|mingchao') -or
      $title.Contains($chineseTitle) -or
      ($exePath -match '(?i)wuthering|mingchao') -or
      $exePath.Contains($chineseTitle)
  }
  if ($matched) {
    $score = 0
    if ($p.ProcessName -match '(?i)Client-Win64-Shipping') { $score += 100 }
    if ($exePath -match '(?i)Client-Win64-Shipping\.exe$') { $score += 50 }
    if ($p.ProcessName -match '(?i)^Wuthering') { $score += 80 }
    if (-not $ProcessName -and $p.ProcessName -match '(?i)launcher|updater') { $score -= 200 }
    $candidates += [pscustomobject]@{
      Process = $p.ProcessName
      ProcessId = $p.Id
      Title = $title
      Hwnd = $hwnd.ToInt64()
      Score = $score
    }
  }
}

if (-not $candidates.Count) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'game_window_missing' } | ConvertTo-Json -Compress))
  exit 2
}

$target = $candidates | Sort-Object Score -Descending | Select-Object -First 1
$hwnd = [IntPtr]::new([Int64]$target.Hwnd)
[void][GameWindowFocus]::ShowWindowAsync($hwnd, 9) # SW_RESTORE
[void][GameWindowFocus]::SetForegroundWindow($hwnd)
$foreground = [GameWindowFocus]::GetForegroundWindow()
$focused = $foreground.ToInt64() -eq [Int64]$target.Hwnd

# SetForegroundWindow is subject to Windows' foreground-lock rules. If the
# direct attempt was refused, temporarily join the input queues and retry.
if (-not $focused) {
  $currentThread = [GameWindowFocus]::GetCurrentThreadId()
  $foregroundThread = [GameWindowFocus]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
  $targetThread = [GameWindowFocus]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
  $attached = @()
  $threads = @($foregroundThread, $targetThread) | Select-Object -Unique
  foreach ($thread in $threads) {
    if ($thread -and $thread -ne $currentThread -and [GameWindowFocus]::AttachThreadInput($currentThread, $thread, $true)) {
      $attached += $thread
    }
  }
  try {
    [void][GameWindowFocus]::ShowWindowAsync($hwnd, 9)
    [void][GameWindowFocus]::BringWindowToTop($hwnd)
    [void][GameWindowFocus]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 350
    $foreground = [GameWindowFocus]::GetForegroundWindow()
    $focused = $foreground.ToInt64() -eq [Int64]$target.Hwnd
  } finally {
    foreach ($thread in $attached) { [void][GameWindowFocus]::AttachThreadInput($currentThread, $thread, $false) }
  }
}

if (-not $focused) {
  [Console]::Out.WriteLine((@{ ok = $false; code = 'focus_denied' } | ConvertTo-Json -Compress))
  exit 3
}

[Console]::Out.WriteLine((@{
  ok = $true
  process = $target.Process
  processId = $target.ProcessId
  title = $target.Title
  hwnd = [string]$target.Hwnd
} | ConvertTo-Json -Compress))
