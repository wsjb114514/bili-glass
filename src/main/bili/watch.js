'use strict';
/**
 * 领取前置：模拟「观看视频」。
 *
 * 背景：B 站「观看视频」类任务（含大会员相关经验/积分任务的 ogvwatch「观看任意正片内容」）
 * 不是靠点一下按钮完成的，而是由播放器每 15 秒向
 * `POST /x/click-interface/web/heartbeat` 上报播放心跳来累积。
 * 所以这里按真实播放器的节奏上报一整段观看过程，而不是伪造一次请求。
 */
const crypto = require('crypto');
const api = require('./api');
const log = require('../logger');

/** 兜底稿件：优先用排行榜动态选，失败时用这几个长期存在的稿件 */
const FALLBACK_BVIDS = ['BV1GJ411x7h7', 'BV1xx411c7mD', 'BV17x411w7KC'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveVideo(cookie, { bvid, minDuration }) {
  if (bvid) {
    const info = await api.getVideoInfo({ bvid }, cookie);
    if (info.ok) return info;
    log.warn(`指定视频 ${bvid} 不可用（${info.error}），改用排行榜挑选`);
  }
  const ranked = await api.pickVideoByRanking(minDuration, cookie);
  if (ranked.ok && ranked.bvid) {
    const info = await api.getVideoInfo({ bvid: ranked.bvid }, cookie);
    if (info.ok) return info;
  } else {
    log.warn(`排行榜挑视频失败：${ranked.error}`);
  }
  for (const fb of FALLBACK_BVIDS) {
    const info = await api.getVideoInfo({ bvid: fb }, cookie);
    if (info.ok) return info;
  }
  return { ok: false, error: '无法获取任何可用视频' };
}

/**
 * @param {string} cookie
 * @param {object} jar 需含 bili_jct、DedeUserID
 * @param {{seconds?:number, bvid?:string, onProgress?:(p:object)=>void}} opts
 */
async function simulateWatch(cookie, jar, opts = {}) {
  const seconds = Math.max(20, Math.min(600, Number(opts.seconds) || 62));
  const csrf = jar && jar.bili_jct;
  const mid = Number(jar && jar.DedeUserID) || 0;
  const onProgress = opts.onProgress || (() => {});
  const minDuration = seconds + 10;

  if (!csrf) {
    return { ok: false, error: '登录态缺少 bili_jct，无法上报观看' };
  }
  const video = await resolveVideo(cookie, { bvid: opts.bvid, minDuration });
  if (!video.ok) {
    log.warn(`观看前置失败：${video.error}`);
    return { ok: false, error: video.error };
  }
  log.step(`准备观看：《${video.title}》（${video.duration}s）`);

  const session = crypto.randomUUID().replace(/-/g, '');
  const startTs = Math.floor(Date.now() / 1000);
  const base = {
    aid: video.aid,
    bvid: video.bvid,
    cid: video.cid,
    mid,
    duration: video.duration,
    startTs,
    session,
  };

  const results = [];
  const send = async (label, patch) => {
    const r = await api.reportHeartbeat(cookie, csrf, {
      ...base,
      realtime: patch.playedTime,
      realPlayedTime: patch.playedTime,
      lastPlayProgressTime: patch.playedTime,
      maxPlayProgressTime: patch.playedTime,
      ...patch,
    });
    results.push({ label, ...r });
    if (r.code === 0) log.info(`观看上报[${label}] 成功（已观看 ${patch.playedTime}s）`);
    else log.warn(`观看上报[${label}] 返回 ${r.code}：${r.message}`);
    return r;
  };

  // play_type: 1 开始播放 / 0 播放中 / 4 结束播放
  await send('开始播放', { playedTime: 0, playType: 1 });

  const tick = 15;
  let played = 0;
  while (played < seconds) {
    const step = Math.min(tick, seconds - played);
    await sleep(step * 1000);
    played += step;
    onProgress({ played, seconds, total: video.duration, title: video.title });
    await send(played >= seconds ? '结束播放' : '播放中', {
      playedTime: played,
      playType: played >= seconds ? 4 : 0,
    });
  }

  // 真实播放器还会写一条观看历史（best-effort，失败不影响观看上报）
  const hist = await api.reportHistory(cookie, csrf, { aid: video.aid, cid: video.cid, progress: played });
  if (hist.code === 0) log.info('观看进度已写入历史记录');
  else log.info(`观看历史上报返回 ${hist.code}（该接口需要有效登录态，不影响观看任务）`);

  const okCodes = results.filter((r) => r.code === 0).length;
  const ok = okCodes > 0;
  log[ok ? 'ok' : 'warn'](`观看模拟完成：共上报 ${results.length} 次，成功 ${okCodes} 次，累计 ${played}s`);
  return { ok, watched: played, video, results, history: hist };
}

module.exports = { simulateWatch, resolveVideo, FALLBACK_BVIDS };
