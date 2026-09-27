'use strict';
/**
 * 登记/取消开机自启（与程序内部逻辑完全一致，并同步配置）。
 * 用法：node tools/register-autostart.js [enable|disable|status] [exe路径]
 */
const path = require('path');
const fs = require('fs');
const autostart = require('../src/main/autostart');
const store = require('../src/main/store');

const action = process.argv[2] || 'status';
const USER_DATA = path.join(process.env.APPDATA, 'BiliGlass');
const defaultExe = path.join(__dirname, '..', 'dist', 'BiliGlass-1.0.0-便携版.exe');
const exe = process.argv[3] || defaultExe;

store.init(USER_DATA);
// 模拟「已打包便携版」的运行环境
process.env.PORTABLE_EXECUTABLE_FILE = exe;
const fakeApp = { isPackaged: true, getAppPath: () => path.join(__dirname, '..') };

(async () => {
  if (!fs.existsSync(exe)) {
    console.error(`找不到 exe：${exe}`);
    process.exit(1);
  }
  const cfg = store.get();
  console.log(`配置里的方式：${cfg.autostartMethod}  当前状态：${cfg.autostart ? '已开启' : '未开启'}`);

  if (action === 'enable' || action === 'disable') {
    const want = action === 'enable';
    const r = await autostart.set(fakeApp, want, cfg.autostartMethod);
    console.log('执行结果:', JSON.stringify(r, null, 2));
    if (r.ok) {
      const patch = { autostart: want };
      if (r.method) patch.autostartMethod = r.method; // 回退时同步实际生效的方式
      store.patch(patch);
    }
  }

  const st = await autostart.status(fakeApp);
  console.log('\n系统实际状态:', JSON.stringify({ enabled: st.enabled, method: st.method }, null, 2));
  console.log('命令行:', autostart.commandLine(fakeApp));
  console.log('配置已同步为:', JSON.stringify({ autostart: store.get().autostart, method: store.get().autostartMethod }));
})();
