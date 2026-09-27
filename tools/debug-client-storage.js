'use strict';
/** 目标：判断客户端 Local Storage / IndexedDB / 其它文件中是否存有可用的 SESSDATA */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROAM = process.env.APPDATA;
const base = path.join(ROAM, 'bilibili');

function safeCopyFile(src) {
  const dst = path.join(os.tmpdir(), 'cp-' + crypto.randomBytes(5).toString('hex'));
  try {
    fs.copyFileSync(src, dst);
    return dst;
  } catch (err) {
    // 尝试逐字节读取（共享读）
    try {
      const fd = fs.openSync(src, 'r');
      const buf = Buffer.alloc(fs.fstatSync(fd).size);
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      fs.writeFileSync(dst, buf);
      return dst;
    } catch (err2) {
      return null;
    }
  }
}

function walk(d, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else out.push(full);
  }
  return out;
}

const needles = ['SESSDATA', 'DedeUserID', 'bili_jct', 'access_token', 'refresh_token'];
const dirs = ['Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'shared_proto_db'];

let hits = 0;
for (const d of dirs) {
  const root = path.join(base, d);
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    const st = (() => {
      try {
        return fs.statSync(f).size;
      } catch {
        return 0;
      }
    })();
    if (st > 8 * 1024 * 1024 || st === 0) continue;
    const copy = safeCopyFile(f);
    if (!copy) continue;
    const buf = fs.readFileSync(copy);
    fs.unlinkSync(copy);
    for (const n of needles) {
      const i = buf.indexOf(Buffer.from(n, 'utf8'));
      if (i >= 0) {
        hits++;
        console.log(`[命中] ${path.relative(base, f)} :: ${n} @${i}`);
        console.log('   ' + buf.slice(Math.max(0, i - 40), i + 220).toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '.'));
      }
    }
  }
}
console.log(`\n共 ${hits} 处命中`);

// 顺带看一眼客户端是否在运行（锁文件）
try {
  fs.accessSync(path.join(base, 'lockfile'), fs.constants.R_OK);
  console.log('lockfile 可读');
} catch (e) {
  console.log('lockfile:', e.code);
}
