'use strict';
/**
 * 用本机真实保存的扫码登录态验证登录态解析（只读，不领取）。
 * 用法：node tools/test-real.js [--run]
 *   不带参数：只校验登录态解析与账号信息
 *   带 --run ：继续跑完整的「观看 + 领取」流程（会真的领取当天经验）
 */
const path = require('path');
const os = require('os');
const log = require('../src/main/logger');
const auth = require('../src/main/bili/auth');
const api = require('../src/main/bili/api');
const store = require('../src/main/store');

const REAL_DIR = path.join(process.env.APPDATA, 'BiliGlass'); // 与正式版共用同一份配置/凭据
const tmpLog = path.join(os.tmpdir(), 'biliglass-real');

log.init(tmpLog);
log.onEntry((e) => console.log(`[${e.time}] [${e.level.toUpperCase()}] ${e.msg}`));
store.init(REAL_DIR);
auth.init(REAL_DIR);

const WITH_RUN = process.argv.includes('--run');

(async () => {
  const cfg = store.get();
  console.log(`当前设置：登录态优先级=${cfg.authPrefer}  允许客户端=${cfg.allowClientCredentials}\n`);

  // 复现用户的场景：设置里选的是「客户端优先」
  const preferQr = cfg.authPrefer !== 'client';
  console.log(`--- 1) 解析登录态（preferQr=${preferQr}，即"${preferQr ? '扫码优先' : '客户端优先'}"）---`);
  const cred = await auth.resolve({ preferQr, allowClient: cfg.allowClientCredentials !== false });

  if (!cred.source) {
    console.log('\n❌ 仍然没有可用登录态：', JSON.stringify(cred.notes, null, 1));
    process.exit(1);
  }
  console.log(`\n✅ 登录态来源：${cred.source === 'qr' ? '扫码登录' : '客户端'}`);
  const info = cred.info || {};
  console.log(`   账号：${info.uname}（mid ${info.mid}）`);
  console.log(`   等级：Lv${info.level}  经验：${info.exp}/${info.nextExp}`);
  console.log(`   大会员：${Number(info.vipStatus) === 1 ? '是' : '否'}  ${info.vipLabel || ''}`);

  if (!WITH_RUN) {
    console.log('\n（未加 --run，仅做只读校验）');
    return;
  }

  console.log('\n--- 2) 跑完整流程（观看 + 领取）---');
  const runner = require('../src/main/runner');
  store.patch({ launchClient: false });
  const result = await runner.runOnce({
    manual: true,
    onState: (s) => console.log(`   [状态] ${s.phase}  ${s.message}`),
  });
  console.log('\n--- 结果 ---');
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        message: result.message,
        watched: result.watched,
        claimCode: result.claim && result.claim.code,
        claimDetail: result.claim && result.claim.detail,
        diagnosis: result.diagnosis,
      },
      null,
      2
    )
  );
})();
