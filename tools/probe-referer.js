'use strict';
/** 探测各接口在什么 Referer 下不会吃 412（412 是 B站 WAF 的 Referer 校验） */
const api = require('../src/main/bili/api');

const UA = api.UA;
const FAKE = 'SESSDATA=invalid; bili_jct=invalid; DedeUserID=1';

async function probe(label, url, { referer, method = 'GET', body, cookie = FAKE } = {}) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (referer) headers.Origin = new URL(referer).origin;
  }
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let code = 'HTML/非JSON';
    let msg = '';
    try {
      const j = JSON.parse(text);
      code = j.code;
      msg = j.message;
    } catch {
      /* ignore */
    }
    return `${String(res.status).padEnd(4)} code=${String(code).padEnd(8)} ${msg ? 'msg=' + msg : ''} ← ${referer || '(无 Referer)'}`;
  } catch (err) {
    return `ERR  ${err.message} ← ${referer || '(无 Referer)'}`;
  }
}

(async () => {
  console.log('===== 领取经验 x/vip/experience/add（POST csrf）=====');
  for (const ref of [
    undefined,
    'https://www.bilibili.com/',
    'https://www.bilibili.com/vip/',
    'https://account.bilibili.com/account/big/myVipCenter',
    'https://www.bilibili.com/video/BV1GJ411x7h7/',
  ]) {
    console.log(
      await probe('claim', 'https://api.bilibili.com/x/vip/experience/add', {
        referer: ref,
        method: 'POST',
        body: new URLSearchParams({ csrf: 'invalid' }).toString(),
      })
    );
  }

  console.log('\n===== 账号信息 x/web-interface/nav =====');
  for (const ref of [undefined, 'https://www.bilibili.com/', 'https://space.bilibili.com/', 'https://message.bilibili.com/']) {
    console.log(await probe('nav', 'https://api.bilibili.com/x/web-interface/nav', { referer: ref }));
  }

  console.log('\n===== 指纹 x/frontend/finger/spi =====');
  for (const ref of [undefined, 'https://www.bilibili.com/']) {
    console.log(await probe('spi', 'https://api.bilibili.com/x/frontend/finger/spi', { referer: ref, cookie: '' }));
  }

  console.log('\n===== 排行榜 x/web-interface/ranking/v2 =====');
  for (const ref of [undefined, 'https://www.bilibili.com/', 'https://www.bilibili.com/v/popular/rank/all']) {
    console.log(await probe('ranking', 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', { referer: ref, cookie: '' }));
  }

  console.log('\n===== 观看历史上报 x/v2/history/report =====');
  for (const ref of [
    'https://www.bilibili.com/video/BV1GJ411x7h7/',
    'https://www.bilibili.com/',
  ]) {
    console.log(
      await probe('history', 'https://api.bilibili.com/x/v2/history/report', {
        referer: ref,
        method: 'POST',
        body: new URLSearchParams({ aid: '2', cid: '62131', progress: '30', platform: 'android', csrf: 'invalid' }).toString(),
      })
    );
  }

  console.log('\n===== 播放心跳 x/click-interface/web/heartbeat =====');
  for (const ref of [
    'https://www.bilibili.com/video/BV1GJ411x7h7/',
    'https://www.bilibili.com/',
  ]) {
    console.log(
      await probe('heartbeat', 'https://api.bilibili.com/x/click-interface/web/heartbeat?w_aid=2&w_dt=2', {
        referer: ref,
        method: 'POST',
        body: new URLSearchParams({ aid: '2', cid: '62131', played_time: '30', realtime: '30', type: '3', dt: '2', play_type: '0', csrf: 'invalid' }).toString(),
      })
    );
  }
})();
