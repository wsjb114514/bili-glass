'use strict';
/** 哔哩哔哩桌面客户端的定位与拉起 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./logger');

const CANDIDATES = [
  'C:\\Program Files\\bilibili\\哔哩哔哩.exe',
  'C:\\Program Files (x86)\\bilibili\\哔哩哔哩.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'bilibili', '哔哩哔哩.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'bilibili', '哔哩哔哩.exe'),
  'C:\\Program Files\\bilibili\\bilibili.exe',
];

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 客户端数据目录（用于判断是否在运行） */
function userDataDir() {
  const roam = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const name of ['bilibili', 'Bilibili', '哔哩哔哩']) {
    const dir = path.join(roam, name);
    if (exists(path.join(dir, 'lockfile')) || exists(path.join(dir, 'Local State'))) return dir;
  }
  return '';
}

/** 同步版本：只做本地文件系统检查（快） */
function findClientPath(preferred) {
  if (exists(preferred)) return preferred;
  for (const c of CANDIDATES) if (exists(c)) return c;
  for (const root of ['C:\\Program Files', 'C:\\Program Files (x86)', path.join(process.env.LOCALAPPDATA || '', 'Programs')]) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (/bili|哔哩/i.test(name)) {
          const dir = path.join(root, name);
          for (const f of fs.readdirSync(dir)) {
            if (/\.exe$/i.test(f) && /bili|哔哩/i.test(f) && !/卸载|uninstall/i.test(f)) {
              return path.join(dir, f);
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** 完整检测（当前与同步版等价，保留异步形态便于以后扩展） */
async function detectClientPath(preferred) {
  return findClientPath(preferred);
}

/**
 * 客户端是否已在运行：Chromium 会独占持有 userData/lockfile，
 * 用「尝试写打开」探测即可，无需启动任何子进程。
 */
function isRunning() {
  const dir = userDataDir();
  if (!dir) return false;
  const lock = path.join(dir, 'lockfile');
  try {
    if (!fs.existsSync(lock)) return false;
  } catch {
    return false;
  }
  try {
    const fd = fs.openSync(lock, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
  }
}

/**
 * 拉起客户端；已在运行则只把窗口带到前台（客户端自身单例）
 * @returns {Promise<{ok:boolean, started:boolean, alreadyRunning:boolean, path?:string, error?:string}>}
 */
async function launch(clientPath, logger = log) {
  const exe = findClientPath(clientPath) || (await detectClientPath(clientPath));
  if (!exe) {
    return { ok: false, started: false, alreadyRunning: false, error: '未找到哔哩哔哩客户端，请在设置里手动指定路径' };
  }
  const running = isRunning();
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(exe),
    });
    child.unref();
    if (running) {
      logger.info('哔哩哔哩客户端已在运行，本次只唤起窗口');
    } else {
      logger.ok(`已拉起哔哩哔哩客户端：${path.basename(exe)}`);
    }
    return { ok: true, started: true, alreadyRunning: running, path: exe };
  } catch (err) {
    return { ok: false, started: false, alreadyRunning: running, path: exe, error: err.message };
  }
}

module.exports = { findClientPath, detectClientPath, isRunning, launch, userDataDir, CANDIDATES };
