param(
  [string]$Out = "D:\新建文件夹 (4)\artifacts\shot.png",
  [string]$WindowTitle = ""
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($WindowTitle) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
  $h = [W]::FindWindow($null, $WindowTitle)
  if ($h -ne [IntPtr]::Zero) {
    [W]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 700
    $r = New-Object W+RECT
    [W]::GetWindowRect($h, [ref]$r) | Out-Null
    $bounds = New-Object System.Drawing.Rectangle($r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
  } else {
    Write-Output "未找到窗口: $WindowTitle"
  }
}

$dir = Split-Path -Parent $Out
if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "已保存: $Out  ($($bounds.Width)x$($bounds.Height) @ $($bounds.X),$($bounds.Y))"
