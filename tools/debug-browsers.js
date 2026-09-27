'use strict';
/** 探测：本机浏览器里能否拿到 bilibili 登录态（Chrome/Edge v10 vs v20 app-bound、Firefox 明文） */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dpapi = require('../src/main/bili/dpapi');
const sqlite = require('../src/main/bili/sqlite');

const LOCAL = process.env.LOCALAPPDATA;
const ROAM = process.env.APPDATA;

const CHROMIUM = {
  Chrome: path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
  Edge: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
  Brave: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  'Chrome Beta': path.join(LOCAL, 'Google', 'Chrome Beta', 'User Data'),
};
const FIREFOX = path.join(ROAM, 'Mozilla', 'Firefox', 'Profiles');

function copy(src) {
  const dst = path.join(os.tmpdir(), 'bw-' + crypto.randomBytes(5).toString('hex'));
  try {
    fs.copyFileSync(src, dst);
    return dst;
  } catch {
    return null;
  }
}

function masterKey(userData) {
  const ls = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
  const b64 = ls.os_crypt.encrypted_key;
  if (!b64) return null;
  const raw = Buffer.from(b64, 'base64');
  return dpapi.unprotect(raw.slice(5));
}

function tryDecrypt(enc, key) {
  if (!enc || !enc.length) return null;
  const pfx = enc.slice(0, 3).toString('ascii');
  if (pfx === 'v20') return { prefix: 'v20', value: null, note: 'APP_BOUND（无法解密）' };
  if (pfx !== 'v10' && pfx !== 'v11') return { prefix: pfx, value: null, note: '未知前缀' };
  if (!key) return { prefix: pfx, value: null, note: '无主密钥' };
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, enc.slice(3, 15));
    d.setAuthTag(enc.slice(enc.length - 16));
    const v = Buffer.concat([d.update(enc.slice(15, enc.length - 16)), d.final()]).toString('utf8');
    return { prefix: pfx, value: v, note: '解密成功' };
  } catch (err) {
    return { prefix: pfx, value: null, note: '解密失败: ' + err.message };
  }
}

(async () => {
  for (const [name, userData] of Object.entries(CHROMIUM)) {
    if (!fs.existsSync(path.join(userData, 'Local State'))) {
      console.log(`\n### ${name}: 未安装`);
      continue;
    }
    console.log(`\n### ${name} → ${userData}`);
    let key = null;
    try {
      key = masterKey(userData);
      console.log('   主密钥长度:', key && key.length);
    } catch (err) {
      console.log('   主密钥读取失败:', err.message);
    }
    const profiles = fs
      .readdirSync(userData, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
      .map((e) => e.name);
    for (const p of profiles) {
      for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
        const f = path.join(userData, p, rel);
        if (!fs.existsSync(f)) continue;
        const cp = copy(f);
        if (!cp) continue;
        try {
          const rows = await sqlite.readRows(
            cp,
            "SELECT name, host_key, value, encrypted_value FROM cookies WHERE host_key LIKE '%bilibili.com' AND name IN ('SESSDATA','bili_jct','DedeUserID')"
          );
          if (!rows.length) {
            console.log(`   [${p}] 无 bilibili 登录 cookie`);
          }
          for (const r of rows) {
            const enc = r.encrypted_value ? Buffer.from(r.encrypted_value) : null;
            const res = r.value ? { prefix: 'plain', value: r.value, note: '明文' } : tryDecrypt(enc, key);
            console.log(
              `   [${p}] ${r.name}@${r.host_key} → ${res && res.prefix} / ${res && res.note} / len=${res && res.value ? res.value.length : 0}`
            );
          }
        } catch (err) {
          console.log(`   [${p}] 查询失败: ${err.message}`);
        }
        fs.unlinkSync(cp);
      }
    }
  }

  console.log('\n### Firefox');
  if (!fs.existsSync(FIREFOX)) console.log('   未安装');
  else {
    for (const p of fs.readdirSync(FIREFOX)) {
      const f = path.join(FIREFOX, p, 'cookies.sqlite');
      if (!fs.existsSync(f)) continue;
      const cp = copy(f);
      if (!cp) continue;
      try {
        const rows = await sqlite.readRows(
          cp,
          "SELECT name, host, length(value) AS len FROM moz_cookies WHERE host LIKE '%bilibili.com'"
        );
        console.log(`   [${p}] ${rows.length} 条 bilibili cookie`, JSON.stringify(rows.slice(0, 8)));
      } catch (err) {
        console.log(`   [${p}] 失败: ${err.message}`);
      }
      fs.unlinkSync(cp);
    }
  }
})();
