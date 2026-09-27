'use strict';
/** 完整编排链路测试（不依赖 Electron）：拉起客户端 → 解析登录态 → 领取 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = path.join(os.tmpdir(), 'biliglass-run-test');
fs.rmSync(dir, { recursive: true, force: true });

const store = require('../src/main/store');
const log = require('../src/main/logger');
const auth = require('../src/main/bili/auth');
const runner = require('../src/main/runner');

store.init(dir);
log.init(path.join(dir, 'logs'));
auth.init(dir);
log.onEntry(() => {});
store.patch({ launchClient: true, clientWaitSec: 1, autoClaim: true, startupDelaySec: 0 });

(async () => {
  const states = [];
  const result = await runner.runOnce({
    manual: true,
    onState: (s) => states.push(`${s.phase}: ${s.message}`),
  });
  console.log('--- 状态流转 ---');
  console.log(states.join('\n'));
  console.log('\n--- 最终结果 ---');
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        needLogin: result.needLogin,
        message: result.message,
        notes: result.notes,
        client: result.clientResult,
        source: result.cred ? result.cred.source : null,
      },
      null,
      2
    )
  );
  console.log('\n--- 记录 ---');
  console.log(JSON.stringify(store.get().lastRun, null, 2));
})();
