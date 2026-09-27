'use strict';
/**
 * 编排顺序测试（打桩账号）：
 * 客户端 → 登录态 → 观看视频 → 领取经验 → 落记录
 * 其中「观看视频」走真实网络（真实心跳上报），只有账号信息与领取结果被替换，
 * 以便在没有登录态的情况下验证整条链路的顺序与状态流转。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = path.join(os.tmpdir(), 'biliglass-order-test');
fs.rmSync(dir, { recursive: true, force: true });

const store = require('../src/main/store');
const log = require('../src/main/logger');
const auth = require('../src/main/bili/auth');
const api = require('../src/main/bili/api');

store.init(dir);
log.init(path.join(dir, 'logs'));
auth.init(dir);
log.onEntry(() => {});

const FAKE_JAR = { SESSDATA: 'fake', bili_jct: 'fake', DedeUserID: '1' };
let claimCalledAt = 0;
let watchDoneAt = 0;

auth.resolve = async () => ({
  source: 'qr',
  cookie: 'SESSDATA=fake; bili_jct=fake; DedeUserID=1',
  jar: FAKE_JAR,
  info: { uname: '打桩大会员', level: 5, exp: 12300, nextExp: 15000, vipStatus: 1, vipLabel: '年度大会员' },
  notes: ['打桩'],
});
api.nav = async () => ({ ok: true, uname: '打桩大会员', level: 5, exp: 12310, nextExp: 15000, vipStatus: 1 });
api.claimVipExperience = async () => {
  claimCalledAt = Date.now();
  return { ok: true, code: 0, message: '领取成功', isGrant: true };
};

const watch = require('../src/main/bili/watch');
const realSimulate = watch.simulateWatch;
watch.simulateWatch = async (cookie, jar, opts) => {
  const r = await realSimulate(cookie, jar, opts);
  watchDoneAt = Date.now();
  return r;
};

const runner = require('../src/main/runner');
store.patch({ launchClient: false, watchBeforeClaim: true, watchSeconds: 20, autoClaim: true });

(async () => {
  const states = [];
  const result = await runner.runOnce({
    manual: true,
    onState: (s) => states.push(`${s.phase}\t${s.message}`),
  });

  console.log('--- 状态流转 ---');
  console.log(states.join('\n'));
  console.log('\n--- 顺序校验 ---');
  console.log('观看完成时间:', watchDoneAt, ' 领取调用时间:', claimCalledAt);
  console.log('观看早于领取:', watchDoneAt > 0 && claimCalledAt >= watchDoneAt ? '✅ 是' : '❌ 否');
  console.log('\n--- 结果 ---');
  console.log(
    JSON.stringify({ ok: result.ok, message: result.message, watched: result.watched, code: result.claim && result.claim.code }, null, 2)
  );
  console.log('\n--- 记录 ---');
  console.log(JSON.stringify(store.get().lastRun, null, 2));
})();
