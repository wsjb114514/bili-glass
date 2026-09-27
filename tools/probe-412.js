'use strict';
/** 排查 412：对比不同 Referer / Cookie 下的 view 接口表现 */
const os = require('os');
const path = require('path');
const log = require('../src/main/logger');
const api = require('../src/main/bili/api');

log.init(path.join(os.tmpdir(), 'biliglass-412'));
log.onEntry(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BVID = 'BV1GJ411x7h7';

async function callView(referer, withFinger) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`, {
    headers: {
      'User-Agent': api.UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: referer,
      ...(withFinger ? { Cookie: withFinger } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let code = null;
  try {
    code = JSON.parse(text).code;
  } catch {
    code = 'HTML';
  }
  return { status: r.status, code, len: text.length };
}

(async () => {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({ round: i + 1, generic: await callView('https://www.bilibili.com/', '') });
    await sleep(900);
    rows.push({ round: i + 1, videoPage: await callView(`https://www.bilibili.com/video/${BVID}/`, '') });
    await sleep(900);
    rows.push({ round: i + 1, withUa: await callView('https://www.bilibili.com/', await api.__finger()) });
    await sleep(900);
  }
  console.log(JSON.stringify(rows, null, 1));
})();
