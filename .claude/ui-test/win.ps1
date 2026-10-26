# Windows: `win.ps1 idle` (seconds since the user's last input), `win.ps1 shot out.png` (the
# main window as drawn, even behind other windows; in pixels).
param([string]$cmd, [string]$out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static uint Idle() { var i = new LASTINPUTINFO(); i.cbSize = 8; GetLastInputInfo(ref i); return ((uint)Environment.TickCount - i.dwTime) / 1000; }
}
"@
[void][W]::SetProcessDPIAware()
switch ($cmd) {
  "idle" { [W]::Idle() }
  "shot" {
    $p = Get-Process canvas-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { "no window"; exit 1 }
    $r = New-Object W+RECT; [void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
    [void][W]::PrintWindow($p.MainWindowHandle, $dc, 2)  # 2: PW_RENDERFULLCONTENT (WebView2 draws with the GPU)
    $g.ReleaseHdc($dc); $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); "saved $($bmp.Width)x$($bmp.Height)"
  }
}
