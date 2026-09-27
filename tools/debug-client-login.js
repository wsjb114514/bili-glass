'use strict';
/** 深入排查：客户端登录态到底存在哪里 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite = require('../src/main/bili/sqlite');

const ROAM = process.env.APPDATA;
const LOCAL = process.env.LOCALAPPDATA;

console.log('=== 含 bili 的 AppData 目录 ===');
for (const root of [ROAM, LOCAL]) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (/bili|哔哩/i.test(e.name)) {
      const full = path.join(root, e.name);
      let size = 0;
      try {
        const walk = (d) => {
          for (const x of fs.readdirSync(d, { withFileTypes: true })) {
            const f = path.join(d, x.name);
            if (x.isDirectory()) walk(f);
            else size += fs.statSync(f).size;
          }
        };
        walk(full);
      } catch {}
      console.log(`${full}  ${(size / 1048576).toFixed(1)} MB`);
    }
  }
}

(async () => {
  const db = path.join(ROAM, 'bilibili', 'Network', 'Cookies');
  const copy = path.join(os.tmpdir(), 'dbg2-' + crypto.randomBytes(4).toString('hex'));
  fs.copyFileSync(db, copy);
  console.log('\n=== 所有 bilibili 相关 cookie ===');
  const rows = await sqlite.readRows(
    copy,
    "SELECT host_key, name, length(value) AS vlen, length(encrypted_value) AS elen FROM cookies WHERE host_key LIKE '%bilibili%'"
  );
  console.log(JSON.stringify(rows, null, 1));

  console.log('\n=== 总 cookie 数 ===');
  console.log(JSON.stringify(await sqlite.readRows(copy, 'SELECT COUNT(*) AS n FROM cookies')));
  fs.unlinkSync(copy);

  console.log('\n=== Local Storage / IndexedDB 中搜索 SESSDATA / DedeUserID ===');
  const targets = [
    path.join(ROAM, 'bilibili', 'Local Storage', 'leveldb'),
    path.join(ROAM, 'bilibili', 'Session Storage'),
  ];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const buf = fs.readFileSync(full);
      for (const needle of ['SESSDATA', 'DedeUserID', 'bili_jct', 'access_token', 'refresh_token']) {
        const i = buf.indexOf(Buffer.from(needle, 'utf8'));
        if (i >= 0) {
          const chunk = buf.slice(Math.max(0, i - 60), i + 200).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
          console.log(`${f} 命中 ${needle} @${i}: ${chunk}`);
        }
      }
    }
  }

  console.log('\n=== 日志目录 ===');
  const logDir = path.join(ROAM, 'bilibili', 'logs');
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir).slice(-6)) {
      const st = fs.statSync(path.join(logDir, f));
      console.log(f, st.size, new Date(st.mtimeMs).toLocaleString('zh-CN'));
    }
  }
})();
