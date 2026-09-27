'use strict';
/**
 * 观看前置链路测试（无需登录）：
 * 验证取稿、排行榜挑视频、心跳上报、历史上报、任务面板诊断的请求形态是否正确。
 * 用无效 Cookie 时，预期返回 -101（账号未登录）而不是 -400（参数错误）——
 * 这就说明请求参数、Header、Referer 都是对的。
 */
const os = require('os');
const path = require('path');
const log = require('../src/main/logger');
const api = require('../src/main/bili/api');
const watch = require('../src/main/bili/watch');

log.init(path.join(os.tmpdir(), 'biliglass-watch-test'));
log.onEntry(() => {});

const FAKE_COOKIE = 'SESSDATA=invalid; bili_jct=invalid; DedeUserID=1';

(async () => {
  const out = {};

  // 1) 排行榜挑视频
  const ranked = await api.pickVideoByRanking(72, '');
  out.ranking = ranked.ok ? { bvid: ranked.bvid, title: ranked.title, duration: ranked.duration } : ranked;

  // 2) 取稿件信息（该接口不需要登录）
  const ref = ranked.ok ? { bvid: ranked.bvid } : { bvid: 'BV1GJ411x7h7' };
  const info = await api.getVideoInfo(ref, '');
  out.videoInfo = info.ok
    ? { bvid: info.bvid, aid: info.aid, cid: info.cid, duration: info.duration, title: info.title, mid: info.mid }
    : info;

  // 3) 心跳上报（无效 Cookie → 预期 -101）
  if (info.ok) {
    const hb = await api.reportHeartbeat(FAKE_COOKIE, 'invalid', {
      aid: info.aid,
      bvid: info.bvid,
      cid: info.cid,
      mid: 1,
      duration: info.duration,
      startTs: Math.floor(Date.now() / 1000) - 30,
      session: 'test' + Date.now(),
      playedTime: 30,
      realtime: 30,
      realPlayedTime: 30,
      lastPlayProgressTime: 30,
      maxPlayProgressTime: 30,
      playType: 0,
    });
    out.heartbeat = hb;
  }

  // 4) 历史进度上报
  if (info.ok) {
    out.historyReport = await api.reportHistory(FAKE_COOKIE, 'invalid', { aid: info.aid, cid: info.cid, progress: 30 });
  }

  // 5) 任务面板诊断
  out.vipPointHomepage = await api.vipPointHomepage(FAKE_COOKIE);

  // 6) 完整观看循环（缩短到 20 秒，验证循环与结束逻辑不崩）
  const t0 = Date.now();
  const sim = await watch.simulateWatch(FAKE_COOKIE, { bili_jct: 'invalid', DedeUserID: '1' }, { seconds: 20 });
  out.simulateWatch = {
    ok: sim.ok,
    watched: sim.watched,
    video: sim.video ? { bvid: sim.video.bvid, title: sim.video.title } : null,
    codes: (sim.results || []).map((r) => `${r.label}:${r.code}`),
    history: sim.history,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };

  console.log(JSON.stringify(out, null, 2));
})();
