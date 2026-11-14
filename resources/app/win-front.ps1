# Bring a MuMu window to the front WITHOUT stealing focus.
#
# Why this exists (2026-10-30): `MuMuManager control show_window` only does ShowWindow(SW_SHOW),
# so the window ends up *behind* whatever is already full-screen (the DSH window). The pet itself
# is always-on-top, so the "booting" card is visible -- and then it disappears and the phone never
# shows up in front. That is exactly the "I clicked the third gear and no phone came out" report.
#
# The trick: SetWindowPos(HWND_TOPMOST) then SetWindowPos(HWND_NOTOPMOST). The window stays at the
# top of the non-topmost stack, without becoming permanently topmost and without taking focus.
#
# ASCII only: Windows PowerShell reads a BOM-less .ps1 as ANSI.
param(
  [int]$ProcessId = 0,
  [string]$ProcessName = 'MuMuNxDevice',
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DshWinFront {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$script:best = [IntPtr]::Zero
$script:bestArea = 0.0

$cb = [DshWinFront+EnumWindowsProc] {
  param($h, $l)
  if (-not [DshWinFront]::IsWindowVisible($h)) { return $true }
  $r = New-Object DshWinFront+RECT
  [void][DshWinFront]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  if ($w -le 200 -or $hh -le 200) { return $true }
  $owner = 0
  [void][DshWinFront]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($ProcessId -gt 0) {
    if ([int]$owner -ne $ProcessId) { return $true }
  } else {
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -ne $ProcessName) { return $true }
  }
  # Prefer the window whose size is closest to what we just laid out (the device window also owns
  # small toolbar/popup windows; the phone itself is the big one).
  $score = [double]($w * $hh)
  if ($Width -gt 0 -and $Height -gt 0) {
    $score = 1.0 / (1.0 + [math]::Abs($w - $Width) + [math]::Abs($hh - $Height))
  }
  if ($score -gt $script:bestArea) { $script:bestArea = $score; $script:best = $h }
  return $true
}

[void][DshWinFront]::EnumWindows($cb, [IntPtr]::Zero)

if ($script:best -eq [IntPtr]::Zero) {
  Write-Output '{"ok":false,"why":"no window"}'
  exit 1
}

$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE
[void][DshWinFront]::SetWindowPos($script:best, [IntPtr](-1), 0, 0, 0, 0, $flags)   # HWND_TOPMOST
[void][DshWinFront]::SetWindowPos($script:best, [IntPtr](-2), 0, 0, 0, 0, $flags)   # HWND_NOTOPMOST

Write-Output ('{"ok":true,"hwnd":' + $script:best.ToInt64() + '}')
