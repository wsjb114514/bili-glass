'use strict';
/**
 * 开机自启管理：注册表 Run 键（免管理员）/ 计划任务（支持登录后延迟）。
 *
 * 性能约束：只用 reg.exe / schtasks.exe 这类轻量原生命令（约 20~120ms），
 * 绝不使用 PowerShell（启动就要 400ms+ 且吃 CPU，实测会拖慢窗口首帧 10 秒），
 * 也绝不使用 spawnSync（会阻塞主进程事件循环）。
 */
const { execFile } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'BiliGlass';
const TASK_NAME = 'BiliGlass_Autostart';

/** reg.exe / schtasks.exe 的输出是 OEM 码页（简体中文系统为 GBK），按 UTF-8 解会乱码 */
let gbkDecoder = null;
try {
  gbkDecoder = new TextDecoder('gbk');
} catch {
  gbkDecoder = null;
}

function decodeOutput(buf) {
  if (!buf) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (gbkDecoder) {
    try {
      return gbkDecoder.decode(b).trim();
    } catch {
      /* 退回 utf8 */
    }
  }
  return b.toString('utf8').trim();
}

/** 运行原生命令，返回 { ok, code, stdout, stderr } */
function run(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout, encoding: 'buffer', maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const out = decodeOutput(stdout);
      const errText = decodeOutput(stderr);
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: out,
        stderr: errText || (err && err.status ? `退出码 ${err.status}` : '') || (err ? String(err.message) : ''),
      });
    });
  });
}

/**
 * 计算自启命令。打包成便携版时 process.execPath 指向临时解包目录，
 * 必须用 PORTABLE_EXECUTABLE_FILE 才能拿到用户双击的那个 exe。
 */
function commandFor(app) {
  const flag = '--autostart';
  if (!app.isPackaged) {
    return { exe: process.execPath, args: [app.getAppPath(), flag] };
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  return { exe, args: [flag] };
}

function commandLine(app) {
  const { exe, args } = commandFor(app);
  return [exe, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

// ------------------------------------------------------------------ 注册表
async function registryStatus() {
  const r = await run('reg.exe', ['query', RUN_KEY, '/v', VALUE_NAME]);
  // 输出为控制台代码页字节，中文可能乱码，因此只以退出码判定存在性
  return { enabled: r.ok, raw: r.stdout.split(/\r?\n/).filter((l) => l.includes(VALUE_NAME)).join(' ') };
}

async function setRegistry(app, enable) {
  const cmd = commandLine(app);
  if (enable) {
    const r = await run('reg.exe', ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', cmd, '/f']);
    if (!r.ok) return { ok: false, error: r.stderr || '写入注册表失败' };
    return { ok: true, method: 'registry', enabled: true, command: cmd };
  }
  await run('reg.exe', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  return { ok: true, method: 'registry', enabled: false };
}

// ---------------------------------------------------------------- 计划任务
async function taskStatus() {
  const r = await run('schtasks.exe', ['/query', '/tn', TASK_NAME]);
  return { enabled: r.ok };
}

async function setTask(app, enable) {
  const cmd = commandLine(app);
  if (enable) {
    // 触发延迟统一由程序内部的「启动后延迟」控制，避免两处延迟叠加
    const args = ['/create', '/tn', TASK_NAME, '/tr', cmd, '/sc', 'onlogon', '/f'];
    const r = await run('schtasks.exe', args, 30000);
    if (!r.ok) {
      const raw = (r.stderr || r.stdout || '').split(/\r?\n/)[0] || '';
      const denied = /拒绝访问|Access is denied|denied/i.test(raw);
      return {
        ok: false,
        needsAdmin: denied,
        error: denied ? '创建计划任务需要管理员权限（拒绝访问）' : raw || '创建计划任务失败',
        raw,
      };
    }
    return { ok: true, method: 'task', enabled: true, command: cmd };
  }
  await run('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f']);
  return { ok: true, method: 'task', enabled: false };
}

// -------------------------------------------------------------------- 组合
/**
 * 开启/关闭自启。开启时先按用户选择的方式，失败则自动回退到另一种。
 * 实测 `schtasks /sc onlogon` 需要管理员权限，普通权限下会「拒绝访问」，
 * 这种情况下注册表 Run 键是唯一可用的免管理员方案。
 */
async function set(app, enable, method = 'registry') {
  // 先清掉另一种方式，避免开机重复启动
  try {
    if (method === 'task') await setRegistry(app, false);
    else await setTask(app, false);
  } catch {
    /* ignore */
  }

  const r = await (method === 'task' ? setTask(app, enable) : setRegistry(app, enable));
  if (r.ok || !enable) return r;

  const fallbackMethod = method === 'task' ? 'registry' : 'task';
  const fb = fallbackMethod === 'task' ? await setTask(app, true) : await setRegistry(app, true);
  if (fb.ok) {
    return {
      ...fb,
      fellBackFrom: method,
      note: `${r.error || '所选方式不可用'}，已自动改用${fallbackMethod === 'task' ? '计划任务' : '注册表'}方式`,
    };
  }
  return r;
}

async function status(app) {
  const [reg, task] = await Promise.all([registryStatus(), taskStatus()]);
  return {
    enabled: reg.enabled || task.enabled,
    method: task.enabled ? 'task' : reg.enabled ? 'registry' : null,
    command: commandLine(app),
    registry: reg,
    task,
    targetExe: commandFor(app).exe,
  };
}

module.exports = { set, status, commandLine, commandFor, TASK_NAME, VALUE_NAME, run };
