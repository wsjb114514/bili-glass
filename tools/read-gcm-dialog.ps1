Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, "Device code authentication")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if (-not $win) {
  Write-Output "未找到 GCM 认证窗口"
  exit 1
}

Write-Output "=== 窗口内容 ==="
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  $name = $el.Current.Name
  $type = $el.Current.ControlType.ProgrammaticName
  if ($name) { Write-Output ("[{0}] {1}" -f $type.Replace('ControlType.',''), $name) }
}
