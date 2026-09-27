'use strict';
/** 极简日志：内存环形缓冲 + 文件落盘 + 推送给渲染进程 */
const fs = require('fs');
const path = require('path');

let logDir = null;
let logFile = null;
let sink = null; // (entry) => void
const ring = [];
const MAX_RING = 500;

function init(dir) {
  logDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  logFile = path.join(dir, `biliglass-${day}.log`);
}

function onEntry(fn) {
  sink = fn;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level, msg, extra) {
  const entry = { ts: Date.now(), time: stamp(), level, msg: String(msg) };
  if (extra && typeof extra === 'object') entry.extra = extra;
  ring.push(entry);
  if (ring.length > MAX_RING) ring.shift();

  const line = `[${entry.time}] [${level.toUpperCase()}] ${entry.msg}${extra ? ' ' + safeJson(extra) : ''}`;
  try {
    if (logFile) fs.appendFileSync(logFile, line + '\r\n', 'utf8');
  } catch {
    /* ignore */
  }
  try {
    if (sink) sink(entry);
  } catch {
    /* ignore */
  }
  return entry;
}

function safeJson(o) {
  try {
    return JSON.stringify(o);
  } catch {
    return '';
  }
}

module.exports = {
  init,
  onEntry,
  write,
  history: () => ring.slice(),
  info: (m, e) => write('info', m, e),
  ok: (m, e) => write('ok', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
  step: (m, e) => write('step', m, e),
  file: () => logFile,
  dir: () => logDir,
};
