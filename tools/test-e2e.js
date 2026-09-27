'use strict';
/** 端到端链路测试：自启注册表读写、客户端检测、领取接口错误映射 */
const path = require('path');
const log = require('../src/main/logger');
const autostart = require('../src/main/autostart');
const client = require('../src/main/client');
const api = require('../src/main/bili/api');
const os = require('os');

log.init(path.join(os.tmpdir(), 'biliglass-test'));

// 伪装一个最小 app 对象供 autostart 使用
const fakeApp = { isPackaged: false, getAppPath: () => 'D:\\新建文件夹 (4)' };

(async () => {
  const out = {};

  out.commandLine = autostart.commandLine(fakeApp);
  out.delayArg30 = autostart.delayArg(30);

  // 1) 注册表自启：开 → 查 → 关 → 查
  const before = await autostart.status(fakeApp);
  out.before = { enabled: before.enabled, method: before.method };

  const on = await autostart.set(fakeApp, true, 'registry');
  out.enable = on;
  const mid = await autostart.status(fakeApp);
  out.afterEnable = { enabled: mid.enabled, method: mid.method };

  const off = await autostart.set(fakeApp, false, 'registry');
  const after = await autostart.status(fakeApp);
  out.afterDisable = { enabled: after.enabled, method: after.method, ok: off.ok };

  // 2) 客户端检测
  out.clientPath = client.findClientPath('');
  out.clientRunning = client.isRunning();
  out.clientDataDir = client.userDataDir();

  // 3) 领取接口：用无效 cookie 验证错误映射（不会影响真实账号）
  const fake = 'SESSDATA=invalid; bili_jct=invalid';
  const claim = await api.claimVipExperience(fake, 'invalid');
  out.claimWithBadCookie = { code: claim.code, ok: claim.ok, message: claim.message };

  const nav = await api.nav(fake);
  out.navWithBadCookie = { ok: nav.ok, code: nav.code, error: nav.error };

  console.log(JSON.stringify(out, null, 2));
})();
