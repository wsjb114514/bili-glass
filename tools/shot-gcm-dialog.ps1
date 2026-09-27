param([string]$Out = "D:\新建文件夹 (4)\artifacts\gcm-dialog.png")
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class GD {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
"@

$pids = @((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'credential' }).Id)
Write-Output "GCM 进程: $($pids -join ',')"

$target = [IntPtr]::Zero
$cb = [GD+EnumProc]{
  param($h,$l)
  $p = 0
  [GD]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($pids -contains $p -and [GD]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 300
    [GD]::GetWindowTextW($h, $sb, 300) | Out-Null
    if ($sb.ToString()) { $script:target = $h }
  }
  return $true
}
[GD]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($target -eq [IntPtr]::Zero) { Write-Output "未找到 GCM 窗口"; exit 1 }
[GD]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 600

$r = New-Object GD+RECT
[GD]::GetWindowRect($target, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h2 = $r.B - $r.T
Write-Output "窗口位置: $($r.L),$($r.T) 尺寸: ${w}x${h2}"

$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen((New-Object System.Drawing.Point($r.L, $r.T)), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size($w, $h2)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "已保存: $Out"
