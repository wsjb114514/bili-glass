'use strict';
/**
 * 登录态解析：
 *   1) 优先使用扫码登录保存的登录态（DPAPI 加密存本地）
 *   2) 失效或从未扫码 → 自动回退读取本机哔哩哔哩客户端的登录态
 *   3) 都没有 → 需要用户扫码
 */
const fs = require('fs');
const path = require('path');
const api = require('./api');
const dpapi = require('./dpapi');
const clientCookies = require('./clientCookies');
const log = require('../logger');

let credFile = null;

function init(userDataDir) {
  credFile = path.join(userDataDir, 'credentials.dat');
}

function saveCookie(jar, source = 'qr') {
  if (!credFile) return false;
  try {
    const payload = Buffer.from(JSON.stringify({ jar, source, savedAt: Date.now() }), 'utf8');
    fs.writeFileSync(credFile, dpapi.protect(payload));
    return true;
  } catch (err) {
    log.warn(`保存登录态失败：${err.message}`);
    return false;
  }
}

function loadCookie() {
  if (!credFile || !fs.existsSync(credFile)) return null;
  try {
    const raw = dpapi.unprotect(fs.readFileSync(credFile));
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed && parsed.jar && parsed.jar.SESSDATA) {
      return { ...parsed, cookie: api.buildCookie(parsed.jar) };
    }
  } catch (err) {
    log.warn(`读取本地登录态失败：${err.message}`);
  }
  return null;
}

function clearCookie() {
  try {
    if (credFile && fs.existsSync(credFile)) fs.unlinkSync(credFile);
  } catch {
    /* ignore */
  }
}

/**
 * 解析登录态。两种来源**都会尝试**，只是顺序按设置里的「优先级」来：
 *   扫码优先  → 先扫码登录态，失败再读客户端
 *   客户端优先 → 先读客户端，失败再回退到扫码登录态
 * 之前这里只实现了「扫码 → 客户端」单向回退，一旦用户选了「客户端优先」，
 * 已保存的扫码登录态就永远不会被使用，导致「刚扫码成功却提示需要登录」。
 *
 * @returns {Promise<{source:'qr'|'client'|null, cookie?:string, jar?:object, info?:object, needLogin?:boolean, notes:string[]}>}
 */
async function resolve({ preferQr = true, allowClient = true, logger = log } = {}) {
  const notes = [];

  const tryQr = async () => {
    const cred = loadCookie();
    if (!cred) {
      notes.push('尚无扫码登录态');
      return null;
    }
    logger.step('校验本地扫码登录态…');
    const info = await api.nav(cred.cookie);
    if (!info.ok) {
      logger.warn(`扫码登录态已失效（${info.error}）${allowClient ? '，尝试读取客户端登录态' : ''}`);
      notes.push(`扫码登录态已失效：${info.error}`);
      return null;
    }
    // B 站在访问时会顺带刷新 SESSDATA，抓到就续期，延长免扫码周期
    if (info.refresh) {
      const jar = { ...cred.jar, ...info.refresh };
      saveCookie(jar, 'qr');
      logger.info('已自动续期登录态（SESSDATA 刷新成功）');
      notes.push('使用扫码登录态（已续期）');
      return { source: 'qr', cookie: api.buildCookie(jar), jar, info, notes };
    }
    notes.push('使用扫码登录态');
    return { source: 'qr', cookie: cred.cookie, jar: cred.jar, info, notes };
  };

  const tryClient = async () => {
    if (!allowClient) {
      notes.push('已按设置禁用客户端登录态');
      return null;
    }
    logger.step('尝试读取哔哩哔哩客户端的登录态…');
    const r = await clientCookies.readClientCookie(logger);
    if (!r.ok) {
      logger.warn(`读取客户端登录态失败：${r.error}`);
      notes.push(r.error);
      return null;
    }
    const info = await api.nav(r.cookie);
    if (!info.ok) {
      logger.warn(`客户端登录态校验失败：${info.error}`);
      notes.push(`客户端登录态无效：${info.error}`);
      return null;
    }
    notes.push('使用客户端登录态');
    return { source: 'client', cookie: r.cookie, jar: r.jar, info, notes };
  };

  const order = preferQr ? [tryQr, tryClient] : [tryClient, tryQr];
  for (const attempt of order) {
    const result = await attempt();
    if (result) return result;
  }

  return { source: null, needLogin: true, notes };
}

/** 扫码登录会话 */
class QrSession {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.key = null;
    this.timer = null;
    this.stopped = false;
    this.deadline = 0;
  }

  async start() {
    this.stop();
    this.stopped = false;
    const { url, key } = await api.qrGenerate();
    this.key = key;
    this.deadline = Date.now() + 180000;
    this.onEvent({ type: 'qr', state: 'waiting', url, key, message: '请使用哔哩哔哩手机客户端扫码' });
    this.timer = setInterval(() => this.tick(), 2000);
    return { url, key };
  }

  async tick() {
    if (this.stopped || !this.key) return;
    if (Date.now() > this.deadline) {
      this.onEvent({ type: 'qr', state: 'expired', message: '二维码已过期，请点击刷新' });
      this.stop();
      return;
    }
    try {
      const r = await api.qrPoll(this.key);
      if (r.code === 86101) {
        this.onEvent({ type: 'qr', state: 'waiting', message: '等待扫码…' });
      } else if (r.code === 86090) {
        this.onEvent({ type: 'qr', state: 'scanned', message: '已扫码，请在手机上确认登录' });
      } else if (r.code === 86038) {
        this.onEvent({ type: 'qr', state: 'expired', message: '二维码已过期，请点击刷新' });
        this.stop();
      } else if (r.code === 0) {
        this.stop();
        if (!r.jar || !r.jar.SESSDATA) {
          this.onEvent({ type: 'qr', state: 'error', message: '登录成功但未获取到 Cookie，请重试' });
          return;
        }
        const cookie = api.buildCookie(r.jar);
        saveCookie(r.jar, 'qr');
        const info = await api.nav(cookie);
        this.onEvent({ type: 'qr', state: 'success', message: '登录成功', info: info.ok ? info : null });
      }
    } catch (err) {
      this.onEvent({ type: 'qr', state: 'error', message: `状态查询失败：${err.message}` });
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { init, resolve, saveCookie, loadCookie, clearCookie, QrSession };
