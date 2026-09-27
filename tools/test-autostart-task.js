'use strict';
/**
 * 测试「计划任务」方式的开机自启（免管理员）：
 * 创建 → 查询 → 读回命令行 → 删除（除非加 --keep）
 * 用法：node tools/test-autostart-task.js [--keep]
 */
const path = require('path');
const autostart = require('../src/main/autostart');

const exe = path.join(__dirname, '..', 'dist', 'BiliGlass-1.0.0-便携版.exe');
process.env.PORTABLE_EXECUTABLE_FILE = exe;
const fakeApp = { isPackaged: true, getAppPath: () => path.join(__dirname, '..') };
const keep = process.argv.includes('--keep');

function ps(script) {
  const { execFileSync } = require('child_process');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

(async () => {
  console.log('目标命令行:', autostart.commandLine(fakeApp), '\n');

  console.log('--- 创建计划任务 ---');
  const on = await autostart.set(fakeApp, true, 'task');
  console.log(JSON.stringify(on, null, 2));

  console.log('\n--- 读回任务定义 ---');
  try {
    const info = ps(`
$t = Get-ScheduledTask -TaskName '${autostart.TASK_NAME}' -ErrorAction SilentlyContinue
if ($t) {
  Write-Output ("State=" + $t.State)
  Write-Output ("Execute=" + $t.Actions[0].Execute)
  Write-Output ("Args=" + $t.Actions[0].Arguments)
  Write-Output ("Trigger=" + $t.Triggers[0].CimClass.CimClassName)
} else { Write-Output 'NOT_FOUND' }
`);
    console.log(info);
  } catch (err) {
    console.log('查询失败:', err.message);
  }

  const st = await autostart.status(fakeApp);
  console.log('\n--- status() 判定 ---');
  console.log(JSON.stringify({ enabled: st.enabled, method: st.method, task: st.task }, null, 2));

  if (!keep) {
    console.log('\n--- 清理（删除任务）---');
    const off = await autostart.set(fakeApp, false, 'task');
    console.log(JSON.stringify(off, null, 2));
    const after = await autostart.status(fakeApp);
    console.log('清理后 enabled =', after.enabled);
  } else {
    console.log('\n（--keep：保留任务，未删除）');
  }
})();
