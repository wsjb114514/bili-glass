'use strict';
/** B 站接口封装（扫码登录 / 登录态校验 / 大会员每日经验领取） */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const CLAIM_URL = 'https://api.bilibili.com/x/vip/experience/add';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const QR_GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const RANKING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const HEARTBEAT_URL = 'https://api.bilibili.com/x/click-interface/web/heartbeat';
const HISTORY_REPORT_URL = 'https://api.bilibili.com/x/v2/history/report';
const VIP_POINT_URL = 'https://api.biliapi.com/x/vip_point/homepage/combine';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

const CLAIM_CODES = {
  0: { ok: true, text: '领取成功' },
  '-101': { ok: false, text: '账号未登录，登录态已失效' },
  '-111': { ok: false, text: 'csrf 校验失败，登录态不完整' },
  69198: { ok: true, already: true, text: '今日经验已经领取过了' },
  6034007: { ok: false, retry: true, text: '请求过于频繁，请稍后再试' },
  235004: { ok: false, retry: true, limited: true, text: '请求过于频繁（B站限流），请稍后再试' },
  235007: { ok: false, notVip: true, text: '当前账号不是有效大会员，无法领取每日经验' },
  '-400': { ok: false, text: '请求参数错误' },
  '-403': { ok: false, text: '访问被拒绝（可能触发风控）' },
  '-412': { ok: false, text: '请求被拦截（风控校验失败）' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一请求：遇到风控（HTTP 412 / 403 或非 JSON 的拦截页）自动退避重试。
 * 领取类接口重试是安全的——重复领取只会返回「已领取」。
 */
async function request(url, { method = 'GET', headers = {}, body, timeout = 15000 } = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...BASE_HEADERS, ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (attempt < 2) {
      await sleep(1200 + attempt * 800);
      return request(url, { method, headers, body, timeout }, attempt + 1);
    }
    throw err;
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON：通常是风控拦截页 */
  }
  const blocked = !json || json.code === -412 || json.code === -403 || res.status === 412 || res.status === 403;
  if (blocked && attempt < 2) {
    await sleep(1500 + attempt * 1000);
    return request(url, { method, headers, body, timeout }, attempt + 1);
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, setCookies, attempts: attempt + 1 };
}

/** 把非 JSON 响应变成可读的错误信息（风控页/空响应都能看出来） */
function describeBadResponse(r) {
  const snip = String(r.text || '').replace(/\s+/g, ' ').slice(0, 120);
  return `接口未返回 JSON（HTTP ${r.status}）${snip ? '：' + snip : ''}`;
}

function parseCookieJar(setCookies) {
  const jar = {};
  for (const line of setCookies) {
    const first = line.split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (value) jar[name] = value;
  }
  return jar;
}

function buildCookie(jar) {
  return ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
    .filter((n) => jar[n])
    .map((n) => `${n}=${jar[n]}`)
    .join('; ');
}

/**
 * 设备指纹 Cookie（buvid3/buvid4/b_nut…）。
 * 不带这些指纹直接打接口很容易吃 412 风控，所以进程内取一次并复用。
 */
let fingerCookie = '';
let fingerTried = false;

async function ensureFingerprint() {
  if (fingerCookie || fingerTried) return fingerCookie;
  fingerTried = true;
  try {
    const r = await request(SPI_URL, { headers: { Referer: 'https://www.bilibili.com/' } });
    const jar = parseCookieJar(r.setCookies || []);
    if (r.json && r.json.code === 0 && r.json.data) {
      if (r.json.data.b_3) jar.buvid3 = r.json.data.b_3;
      if (r.json.data.b_4) jar.buvid4 = r.json.data.b_4;
    }
    fingerCookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } catch {
    fingerCookie = '';
  }
  return fingerCookie;
}

/** 把指纹 Cookie 拼到业务 Cookie 前面 */
function mergeCookie(cookie) {
  return [fingerCookie, cookie].filter(Boolean).join('; ');
}

/** 生成扫码登录二维码 */
async function qrGenerate() {
  const { json } = await request(QR_GEN_URL, { headers: { Referer: 'https://www.bilibili.com/' } });
  if (!json || json.code !== 0) throw new Error(`二维码生成失败：${json ? json.message : '网络异常'}`);
  return { url: json.data.url, key: json.data.qrcode_key };
}

/**
 * 轮询扫码状态
 * code: 0 成功 / 86038 已过期 / 86090 已扫码待确认 / 86101 未扫码
 */
async function qrPoll(key) {
  const { json, setCookies } = await request(`${QR_POLL_URL}?qrcode_key=${encodeURIComponent(key)}`, {
    headers: { Referer: 'https://www.bilibili.com/' },
    timeout: 12000,
  });
  if (!json) throw new Error('扫码状态查询失败：网络异常');
  const data = json.data || {};
  const jar = parseCookieJar(setCookies);
  return {
    code: data.code,
    message: data.message || json.message,
    jar: Object.keys(jar).length ? jar : null,
  };
}

/** 登录态 / 账号信息 */
async function nav(cookie) {
  await ensureFingerprint();
  const { json, setCookies } = await request(NAV_URL, {
    headers: { Cookie: mergeCookie(cookie), Referer: 'https://www.bilibili.com/' },
  });
  if (!json) return { ok: false, error: '网络异常，无法获取账号信息' };
  if (json.code !== 0) return { ok: false, code: json.code, error: json.message || '接口返回异常' };
  const d = json.data || {};
  if (!d.isLogin) return { ok: false, code: -101, error: '未登录' };
  const li = d.level_info || {};
  const refresh = parseCookieJar(setCookies || []);
  // vip_label 在不同接口版本下可能是字符串，也可能是 { text, label_theme, ... } 对象
  const label = d.vip_label;
  const vipLabel =
    typeof label === 'string' ? label : label && typeof label === 'object' && label.text ? String(label.text) : '';
  return {
    ok: true,
    raw: d,
    refresh: Object.keys(refresh).length ? refresh : null,
    uname: d.uname,
    mid: d.mid,
    face: d.face,
    money: d.money,
    level: li.current_level,
    exp: li.current_exp,
    nextExp: li.next_exp,
    vipStatus: d.vipStatus,
    vipType: d.vipType,
    vipLabel: vipLabel || (Number(d.vipStatus) === 1 ? '大会员' : '普通用户'),
    vipDueDate: d.vipDueDate,
  };
}

/** 领取大会员每日经验 */
async function claimVipExperience(cookie, csrf) {
  const body = new URLSearchParams();
  body.set('csrf', csrf || '');
  await ensureFingerprint();
  const { json, status } = await request(CLAIM_URL, {
    method: 'POST',
    headers: {
      Cookie: mergeCookie(cookie),
      Referer: 'https://www.bilibili.com/vip/',
      Origin: 'https://www.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!json) return { ok: false, error: `接口无响应（HTTP ${status}）` };
  const mapped = CLAIM_CODES[String(json.code)];
  if (mapped) {
    return {
      ok: !!mapped.ok,
      already: !!mapped.already,
      retry: !!mapped.retry,
      limited: !!mapped.limited,
      notVip: !!mapped.notVip,
      code: json.code,
      message: mapped.text,
      detail: json.message,
      isGrant: json.data ? json.data.is_grant : undefined,
    };
  }
  return {
    ok: false,
    code: json.code,
    message: json.message || `未知返回码 ${json.code}`,
    detail: json.message,
    isGrant: json.data ? json.data.is_grant : undefined,
  };
}

// ---------------------------------------------------------------- 观看视频
/**
 * 拉取稿件信息（拿 aid / cid / 时长 / UP主mid），观看上报需要这些字段
 * @param {{bvid?:string, aid?:number}} ref
 */
async function getVideoInfo(ref, cookie) {
  const qs = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${encodeURIComponent(ref.aid)}`;
  // 注意：view 接口的 Referer 必须指向该稿件页，用站点根域名会被 WAF 判 412
  const referer = ref.bvid ? `https://www.bilibili.com/video/${ref.bvid}/` : `https://www.bilibili.com/video/av${ref.aid}/`;
  await ensureFingerprint();
  const r = await request(`${VIEW_URL}?${qs}`, {
    headers: { Cookie: mergeCookie(cookie), Referer: referer },
  });
  const json = r.json;
  if (!json || json.code !== 0 || !json.data) {
    return {
      ok: false,
      code: json ? json.code : -1,
      error: json ? json.message || `code ${json.code}` : describeBadResponse(r),
    };
  }
  const d = json.data;
  return {
    ok: true,
    aid: d.aid,
    bvid: d.bvid,
    cid: d.cid,
    title: d.title,
    duration: d.duration,
    mid: d.owner ? d.owner.mid : 0,
    pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, duration: p.duration })),
  };
}

/** 从排行榜里挑一个时长足够的视频（避免写死某个稿件被删） */
async function pickVideoByRanking(minDurationSec, cookie) {
  await ensureFingerprint();
  const { json } = await request(`${RANKING_URL}?rid=0&type=all`, {
    headers: { Cookie: mergeCookie(cookie), Referer: 'https://www.bilibili.com/v/popular/rank/all' },
  });
  if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.list)) {
    return { ok: false, error: json ? json.message || `code ${json.code}` : '网络异常' };
  }
  const list = json.data.list.filter((v) => Number(v.duration) >= minDurationSec);
  if (!list.length) return { ok: false, error: '排行榜里没有时长足够的视频' };
  const v = list[Math.floor(Math.random() * Math.min(list.length, 12))];
  return { ok: true, bvid: v.bvid, aid: v.aid, title: v.title, duration: v.duration };
}

/**
 * 上报视频播放心跳（web 端播放器每 15 秒调一次的那个接口）
 * 这是官方文档里明确的「观看行为」上报通道，打卡「观看视频」类任务靠它。
 */
async function reportHeartbeat(cookie, csrf, p) {
  const qs = new URLSearchParams({
    w_start_ts: p.startTs,
    w_mid: p.mid,
    w_aid: p.aid,
    w_dt: 2,
    w_realtime: p.realtime,
    w_playedtime: p.playedTime,
    w_real_played_time: p.realPlayedTime,
    w_video_duration: p.duration,
    w_last_play_progress_time: p.lastPlayProgressTime,
    web_location: 1315873,
  });
  const body = new URLSearchParams({
    aid: String(p.aid),
    bvid: p.bvid || '',
    cid: String(p.cid),
    mid: String(p.mid || 0),
    played_time: String(p.playedTime),
    realtime: String(p.realtime),
    real_played_time: String(p.realPlayedTime),
    video_duration: String(p.duration),
    last_play_progress_time: String(p.lastPlayProgressTime),
    max_play_progress_time: String(p.maxPlayProgressTime != null ? p.maxPlayProgressTime : p.lastPlayProgressTime),
    start_ts: String(p.startTs),
    type: 3,
    sub_type: 0,
    dt: 2,
    outer: 0,
    play_type: String(p.playType),
    session: p.session || '',
    csrf: csrf || '',
  });
  await ensureFingerprint();
  const { json } = await request(`${HEARTBEAT_URL}?${qs.toString()}`, {
    method: 'POST',
    headers: {
      Cookie: mergeCookie(cookie),
      Referer: `https://www.bilibili.com/video/${p.bvid || 'av' + p.aid}`,
      Origin: 'https://www.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  return { code: json ? json.code : -1, message: json ? json.message : '网络异常' };
}

/** 上报观看进度（会写入观看历史，真实播放器同样会调） */
async function reportHistory(cookie, csrf, { aid, cid, progress }) {
  const body = new URLSearchParams({
    aid: String(aid),
    cid: String(cid),
    progress: String(progress),
    platform: 'android', // 文档示例即为 android
    csrf: csrf || '',
  });
  await ensureFingerprint();
  const { json, status, text } = await request(HISTORY_REPORT_URL, {
    method: 'POST',
    headers: {
      Cookie: mergeCookie(cookie),
      Referer: `https://www.bilibili.com/video/av${aid}`,
      Origin: 'https://www.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!json) return { code: -1, message: `HTTP ${status} ${String(text).slice(0, 80)}` };
  return { code: json.code, message: json.message };
}

/**
 * 大会员大积分任务面板（诊断用）
 * 里面会列出 ogvwatch「观看任意正片内容」等任务的完成状态，
 * 领取经验失败时用它来判断到底缺哪一步。
 */
async function vipPointHomepage(cookie) {
  await ensureFingerprint();
  const { json, status, text } = await request(`${VIP_POINT_URL}?platform=web&mobi_app=android&build=0`, {
    headers: { Cookie: mergeCookie(cookie), Referer: 'https://www.bilibili.com/' },
  });
  if (!json) return { ok: false, code: -1, error: `HTTP ${status} ${String(text).slice(0, 80)}` };
  if (json.code !== 0) return { ok: false, code: json.code, error: json.message || `code ${json.code}` };
  const d = json.data || {};
  return { ok: true, point: d.point_info, task: d.task };
}

module.exports = {
  qrGenerate,
  qrPoll,
  nav,
  claimVipExperience,
  buildCookie,
  parseCookieJar,
  getVideoInfo,
  pickVideoByRanking,
  reportHeartbeat,
  reportHistory,
  vipPointHomepage,
  UA,
};
