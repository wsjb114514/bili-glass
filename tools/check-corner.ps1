param(
  [string]$Image = "D:\新建文件夹 (4)\artifacts\corner-test.png",
  [int]$Left = 9,
  [int]$Top = 138
)
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap($Image)
Write-Output "图像尺寸: $($bmp.Width) x $($bmp.Height)"
Write-Output "窗口左上角: ($Left,$Top)"
Write-Output ""

function Sample([int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { return "越界" }
  $c = $bmp.GetPixel($x, $y)
  return ("#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B)
}

Write-Output "== 沿窗口左上角对角线采样（判断圆角）=="
foreach ($d in @(-6, -2, 0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30)) {
  $x = $Left + $d
  $y = $Top + $d
  Write-Output ("  相对偏移 {0,4},{0,4}  →  {1}" -f $d, (Sample $x $y))
}

Write-Output ""
Write-Output "== 水平/垂直边界对比 =="
Write-Output ("  窗口外 6px 处 ($($Left-6),$($Top+20)) : $(Sample ($Left-6) ($Top+20))")
Write-Output ("  窗口内 20px  ($($Left+20),$($Top+20)) : $(Sample ($Left+20) ($Top+20))")
Write-Output ("  正角落      ($Left,$Top)               : $(Sample $Left $Top)")
Write-Output ("  上边中点    ($($Left+244),$Top)         : $(Sample ($Left+244) $Top)")
Write-Output ("  左边中点    ($Left,$($Top+353))         : $(Sample $Left ($Top+353))")
$bmp.Dispose()
