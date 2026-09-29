'use strict';
/** 一次完整执行：拉起客户端 → 解析登录态 → 领取大会员每日经验 */
const api = require('./bili/api');
const auth = require('./bili/auth');
const watch = require('./bili/watch');
const client = require('./client');
const store = require('./store');
const log = require('./logger');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{manual?:boolean, onState?:(s:object)=>void}} opts
 */
async function runOnce(opts = {}) {
  const { manual = false, onState = () => {} } = opts;
  const cfg = store.get();
  const started = Date.now();
  const state = (phase, message, extra = {}) => onState({ phase, message, ...extra });

  log.info(`开始执行每日任务${manual ? '（手动触发）' : '（开机自动）'}`);

  // 1) 解析登录态（自动登录：扫码登录态优先，客户端登录态兜底，双向回退）
  state('auth', '正在获取登录态…');
  const cred = await auth.resolve({
    preferQr: cfg.authPrefer !== 'client',
    allowClient: cfg.allowClientCredentials !== false,
  });

  if (!cred.source) {
    state('need-login', '需要登录才能领取经验', { needLogin: true, notes: cred.notes });
    log.warn('登录态不可用，需要扫码登录');
    return finalize({
      ok: false,
      needLogin: true,
      message: '没有可用的登录态，请扫码登录后再试',
      notes: cred.notes,
      cfg,
      started,
      manual,
    });
  }

  const info = cred.info || {};
  state('auth', `已登录：${info.uname || '未知用户'}`, { info, source: cred.source });
  log.ok(`登录态来源：${cred.source === 'qr' ? '扫码登录' : 'B站客户端'}，账号：${info.uname || '未知'}`);

  if (Number(info.vipStatus) !== 1) {
    log.warn('该账号当前不是大会员，接口可能无法领取每日经验');
  }

  const csrf = cred.jar && cred.jar.bili_jct;

  // 2) 开机先检测：直接问服务端「今天这 10 经验领了没」
  //    已领取 → 立刻退出进程（不拉起客户端、不观看、不弹窗）
  if (cfg.precheckFirst !== false) {
    state('precheck', '正在检测今日经验是否已领取…');
    const pre = await api.claimVipExperience(cred.cookie, csrf);
    if (pre.ok) {
      const isAlready = !!pre.already;
      const message = isAlready ? '今日经验已经领取过啦' : '大会员每日经验 +10 领取成功（无需观看）';
      log[isAlready ? 'ok' : 'ok'](`${message}（返回码 ${pre.code}）`);
      state('done', message, { claim: pre, info });
      return finalize({
        ok: true,
        already: isAlready,
        silentExit: isAlready && !manual, // 已领取 → 立即退出，不弹结果窗
        precheckOnly: true,
        message,
        claim: pre,
        info,
        cred,
        cfg,
        started,
        manual,
      });
    }
    if (pre.limited && cfg.lastClaimDate === today() && cfg.lastRun && cfg.lastRun.ok) {
      // 预检被限流（通常是本程序自己刚刚调过），本地记录显示今日已领 → 同样直接退出
      const message = '今日经验已领取（本地记录，预检被限流）';
      log.ok(`${message}（返回码 ${pre.code}）`);
      state('done', message, { claim: pre, info });
      return finalize({
        ok: true,
        already: true,
        silentExit: !manual,
        precheckOnly: true,
        message,
        claim: pre,
        info,
        cred,
        cfg,
        started,
        manual,
      });
    }
    log.info(`预检未通过（返回码 ${pre.code}：${pre.message}），继续执行观看前置`);
  }

  // 3) 拉起哔哩哔哩客户端
  let clientResult = { ok: true, started: false, alreadyRunning: false };
  if (cfg.launchClient) {
    state('launching-client', '正在拉起哔哩哔哩客户端…');
    await sleep(150);
    clientResult = await client.launch(cfg.clientPath, log);
    if (!clientResult.ok) {
      log.warn(clientResult.error);
      state('launching-client', clientResult.error, { warn: true });
    } else if (cfg.clientWaitSec > 0) {
      state('launching-client', `等待客户端就绪（${cfg.clientWaitSec}s）…`);
      await sleep(Math.max(0, cfg.clientWaitSec * 1000));
    }
  } else {
    log.info('按设置跳过启动客户端');
  }

  // 4) 观看前置：B站「观看视频」任务要靠播放器心跳累积，不能跳过
  let watchResult = null;
  if (cfg.watchBeforeClaim !== false) {
    const secs = Number(cfg.watchSeconds) || 62;
    state('watching', `正在模拟观看视频（约 ${secs} 秒）…`);
    try {
      watchResult = await watch.simulateWatch(cred.cookie, cred.jar, {
        seconds: secs,
        bvid: cfg.watchBvid || '',
        onProgress: (p) => state('watching', `观看中 ${p.played}/${p.seconds}s · ${p.title}`),
      });
    } catch (err) {
      log.warn(`观看前置异常：${err.message}`);
      watchResult = { ok: false, error: err.message };
    }
    if (!watchResult.ok) {
      log.warn('观看前置未成功，仍继续尝试领取（失败原因见上）');
    }
  } else {
    log.info('按设置跳过观看前置');
  }

  // 5) 领取经验
  if (!cfg.autoClaim && !manual) {
    state('done', '按设置未执行领取', { skipped: true });
    return finalize({ ok: true, skipped: true, message: '已跳过领取（设置中已关闭）', info, cred, clientResult, cfg, started, manual });
  }

  state('claiming', '正在领取大会员每日经验…');
  let claim = await api.claimVipExperience(cred.cookie, csrf);

  // 被 B 站限流时限流冷却通常比观看时长略长，退避后重试一次，避免整轮白跑
  if (!claim.ok && claim.limited) {
    const waitSec = 30;
    state('claiming', `遇 B站限流，等待 ${waitSec}s 后重试…`);
    log.warn(`领取被限流（${claim.code}），${waitSec}s 后重试一次`);
    await sleep(waitSec * 1000);
    claim = await api.claimVipExperience(cred.cookie, csrf);
  }

  let message;
  if (claim.ok && claim.already) message = '今日经验已经领取过啦';
  else if (claim.ok) message = '大会员每日经验 +10 领取成功';
  else message = claim.message;

  if (claim.ok) log.ok(`${message}（返回码 ${claim.code}）`);
  else log.error(`${message}（返回码 ${claim.code}）`);

  // 领取失败时拉一次大会员大积分任务面板，看看是不是还有别的任务没完成
  let diagnosis = null;
  if (!claim.ok) {
    try {
      diagnosis = await api.vipPointHomepage(cred.cookie);
      if (diagnosis.ok) {
        const t = diagnosis.task || {};
        log.warn(`任务面板诊断：${JSON.stringify(t).slice(0, 400)}`);
      } else {
        log.warn(`任务面板诊断失败：${diagnosis.error}`);
      }
    } catch {
      /* ignore */
    }
  }

  // 6) 复核经验值
  let after = null;
  try {
    if (claim.ok) {
      after = await api.nav(cred.cookie);
    }
  } catch {
    /* ignore */
  }

  state('done', message, { claim, info: after && after.ok ? after : info });
  return finalize({
    ok: !!claim.ok,
    already: !!claim.already,
    message,
    claim,
    watched: watchResult && watchResult.ok ? watchResult.watched : 0,
    diagnosis,
    info: after && after.ok ? after : info,
    cred,
    clientResult,
    cfg,
    started,
    manual,
  });
}

function finalize(result) {
  const cfg = store.get();
  const record = {
    at: Date.now(),
    date: today(),
    ok: !!result.ok,
    skipped: !!result.skipped,
    message: result.message,
    code: result.claim ? result.claim.code : undefined,
    watched: result.watched || 0,
    uname: result.info ? result.info.uname : undefined,
    source: result.cred ? result.cred.source : undefined,
    durationMs: Date.now() - result.started,
    manual: !!result.manual,
  };
  store.patch({ lastRun: record });
  if (result.ok && !result.skipped) store.patch({ lastClaimDate: record.date });
  store.pushHistory(record);
  log.info(`本次执行结束：${record.message}（耗时 ${(record.durationMs / 1000).toFixed(1)}s）`);
  return result;
}

module.exports = { runOnce, today };
