'use strict';
/** 调试：客户端 Cookies 库到底有什么 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const clientCookies = require('../src/main/bili/clientCookies');
const sqlite = require('../src/main/bili/sqlite');
const dpapi = require('../src/main/bili/dpapi');

const dir = clientCookies.findUserDataDir();
console.log('userData dir:', dir);

function walk(d, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(full, depth + 1));
    else if (e.name === 'Cookies' || e.name.endsWith('.sqlite') || e.name === 'Local State') out.push(full);
  }
  return out;
}

console.log('\n=== 候选文件 ===');
console.log(walk(dir).join('\n'));

(async () => {
  // 尝试 node:sqlite
  let driver = 'sql.js';
  try {
    require('node:sqlite');
    driver = 'node:sqlite';
  } catch (e) {
    console.log('node:sqlite 不可用:', e.message);
  }
  console.log('\n使用的 sqlite 驱动:', driver);

  const cookieFiles = walk(dir).filter((f) => f.endsWith('Cookies'));
  for (const cf of cookieFiles) {
    const copy = path.join(os.tmpdir(), 'dbg-' + crypto.randomBytes(4).toString('hex'));
    fs.copyFileSync(cf, copy);
    console.log(`\n=== ${cf} (${fs.statSync(cf).size} bytes) ===`);
    try {
      const hosts = await sqlite.readRows(copy, 'SELECT host_key, COUNT(*) AS n FROM cookies GROUP BY host_key ORDER BY n DESC LIMIT 40');
      console.log('host_keys:', JSON.stringify(hosts, null, 1));
      const names = await sqlite.readRows(copy, 'SELECT name, host_key, length(value) AS vlen, length(encrypted_value) AS elen, substr(encrypted_value,1,3) AS prefix FROM cookies ORDER BY name LIMIT 60');
      console.log('cookies:', JSON.stringify(names, null, 1));
    } catch (err) {
      console.log('查询失败:', err.message);
    }
    fs.unlinkSync(copy);
  }

  // 主密钥
  console.log('\n=== 主密钥 ===');
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    console.log('os_crypt keys:', Object.keys(ls.os_crypt || {}));
    const raw = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
    console.log('encrypted_key prefix:', raw.slice(0, 5).toString('ascii'), 'len:', raw.length);
    const key = dpapi.unprotect(raw.slice(5));
    console.log('解出主密钥长度:', key.length);
  } catch (err) {
    console.log('主密钥失败:', err.message);
  }
})();
