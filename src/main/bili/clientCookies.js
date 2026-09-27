'use strict';
/**
 * 从本机哔哩哔哩客户端（Electron）读取已登录 Cookie。
 * 原理：Local State 里的 os_crypt.encrypted_key 用 DPAPI 解出 AES-256-GCM 主密钥，
 * 再用它解密 Network/Cookies 中 encrypted_value（v10/v11 前缀）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dpapi = require('./dpapi');
const sqlite = require('./sqlite');
const log = require('../logger');

const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CANDIDATE_DIRS = [
  path.join(ROAMING, 'bilibili'),
  path.join(ROAMING, 'Bilibili'),
  path.join(ROAMING, '哔哩哔哩'),
  path.join(ROAMING, 'bilibili-electron'),
  path.join(ROAMING, 'com.bilibili.pc'),
];

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findUserDataDir() {
  for (const dir of CANDIDATE_DIRS) {
    if (exists(path.join(dir, 'Local State'))) return dir;
  }
  return null;
}

/** 递归查找 Network/Cookies（含 Partition 目录） */
function findCookieFiles(userDataDir, depth = 0) {
  const out = [];
  if (!userDataDir || depth > 3) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(userDataDir, e.name);
    if (e.isDirectory()) {
      if (['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'logs', 'IndexedDB', 'Local Storage'].includes(e.name)) continue;
      if (e.name === 'Network' && exists(path.join(full, 'Cookies'))) {
        out.push(path.join(full, 'Cookies'));
        continue;
      }
      out.push(...findCookieFiles(full, depth + 1));
    }
  }
  return out;
}

function getMasterKey(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  const ls = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const b64 = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!b64) throw new Error('Local State 中未找到 os_crypt.encrypted_key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 5).toString('ascii') !== 'DPAPI') throw new Error('encrypted_key 前缀异常');
  return dpapi.unprotect(raw.slice(5));
}

/** Chromium 新版应用绑定加密（v20）无法离线解密 */
function decryptValue(encBuf, key) {
  if (!encBuf || !encBuf.length) return '';
  const prefix = encBuf.slice(0, 3).toString('ascii');
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) throw new Error('缺少主密钥');
    const nonce = encBuf.slice(3, 15);
    const tag = encBuf.slice(encBuf.length - 16);
    const data = encBuf.slice(15, encBuf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }
  if (prefix === 'v20') throw new Error('APPBOUND_ENCRYPTION');
  // 老版本：整块 DPAPI
  return dpapi.unprotect(encBuf).toString('utf8');
}

function tempCopy(file) {
  const dst = path.join(os.tmpdir(), `bg-cookies-${crypto.randomBytes(6).toString('hex')}`);
  fs.copyFileSync(file, dst);
  return dst;
}

/**
 * @returns {Promise<{ok:boolean, cookie?:string, jar?:object, dir?:string, error?:string, reason?:string}>}
 */
async function readClientCookie(logger = log) {
  const dir = findUserDataDir();
  if (!dir) return { ok: false, reason: 'NOT_INSTALLED', error: '未找到哔哩哔哩客户端数据目录（说明客户端可能从未登录过）' };

  const files = findCookieFiles(dir);
  if (!files.length) return { ok: false, reason: 'NO_COOKIE_DB', error: '未找到客户端 Cookies 数据库', dir };

  let key = null;
  try {
    key = getMasterKey(dir);
  } catch (err) {
    logger.warn(`读取客户端加密主密钥失败：${err.message}`);
  }

  let lastError = 'Cookies 数据库中未找到登录态';
  for (const cookieFile of files) {
    let copy = null;
    try {
      copy = tempCopy(cookieFile);
      const names = COOKIE_NAMES.map((n) => `'${n}'`).join(',');
      const rows = await sqlite.readRows(
        copy,
        `SELECT host_key, name, value, encrypted_value, length(encrypted_value) AS len FROM cookies WHERE name IN (${names})`
      );
      const jar = {};
      let appBound = false;
      for (const row of rows) {
        const host = String(row.host_key || '');
        if (!/bilibili\.com$/i.test(host)) continue;
        let value = row.value || '';
        const enc = row.encrypted_value;
        if (!value && enc) {
          const buf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc);
          try {
            value = decryptValue(buf, key);
          } catch (err) {
            if (String(err.message).includes('APPBOUND')) appBound = true;
            continue;
          }
        }
        if (value) {
          // SESSDATA 等主账号 Cookie 优先取根域
          if (!jar[row.name] || host === '.bilibili.com') jar[row.name] = value;
        }
      }
      if (appBound && !jar.SESSDATA) {
        lastError = '客户端启用了应用绑定加密（v20），无法离线解密，请改用扫码登录';
        continue;
      }
      if (jar.SESSDATA && jar.bili_jct) {
        const cookie = COOKIE_NAMES.filter((n) => jar[n]).map((n) => `${n}=${jar[n]}`).join('; ');
        logger.ok('已从哔哩哔哩客户端读取到登录态');
        return { ok: true, cookie, jar, dir, file: cookieFile };
      }
      lastError =
        '客户端本地数据库里没有网页登录态（未找到 SESSDATA / bili_jct）。' +
        '新版哔哩哔哩客户端把账号登录态加密存放在自身配置中，不写入网页 Cookie —— 这种情况下请使用扫码登录。';
    } catch (err) {
      lastError = err.message;
      logger.warn(`解析客户端 Cookies 失败：${err.message}`);
    } finally {
      if (copy) {
        try {
          fs.unlinkSync(copy);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { ok: false, reason: 'NO_SESSION', error: lastError, dir };
}

module.exports = { readClientCookie, findUserDataDir };
