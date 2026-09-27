'use strict';
/** 核心链路自测（不依赖 Electron）：DPAPI、客户端 Cookies 解密、账号信息接口 */
const os = require('os');
const path = require('path');
const log = require('../src/main/logger');
const dpapi = require('../src/main/bili/dpapi');
const clientCookies = require('../src/main/bili/clientCookies');
const api = require('../src/main/bili/api');

log.init(path.join(os.tmpdir(), 'biliglass-test'));

(async () => {
  const out = {};

  // 1) DPAPI 往返
  try {
    const secret = Buffer.from('biliglass-测试-secret', 'utf8');
    const enc = dpapi.protect(secret);
    const dec = dpapi.unprotect(enc);
    out.dpapi = { ok: dec.equals(secret), native: dpapi.nativeAvailable(), encLen: enc.length };
  } catch (err) {
    out.dpapi = { ok: false, error: err.message };
  }

  // 2) 客户端登录态
  try {
    const r = await clientCookies.readClientCookie(log);
    out.client = r.ok
      ? { ok: true, dir: r.dir, names: Object.keys(r.jar), sessdataLen: (r.jar.SESSDATA || '').length }
      : { ok: false, reason: r.reason, error: r.error };
  } catch (err) {
    out.client = { ok: false, error: err.message, stack: String(err.stack).split('\n').slice(0, 4) };
  }

  // 3) 账号信息（只读接口）
  if (out.client && out.client.ok) {
    try {
      const r = await clientCookies.readClientCookie(log);
      const info = await api.nav(r.cookie);
      out.nav = info.ok
        ? { ok: true, uname: info.uname, level: info.level, exp: info.exp, vip: info.vipStatus, vipLabel: info.vipLabel }
        : { ok: false, code: info.code, error: info.error };
    } catch (err) {
      out.nav = { ok: false, error: err.message };
    }
  }

  // 4) 二维码接口
  try {
    const qr = await api.qrGenerate();
    out.qr = { ok: !!qr.key, urlHost: new URL(qr.url).host };
  } catch (err) {
    out.qr = { ok: false, error: err.message };
  }

  console.log(JSON.stringify(out, null, 2));
})();
