'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./store');
const log = require('./logger');
const win32 = require('./win32');
const QRCode = require('qrcode');
const autostart = require('./autostart');
const client = require('./client');
const runner = require('./runner');
const auth = require('./bili/auth');
const api = require('./bili/api');
const watch = require('./bili/watch');
const { QrSession } = require('./bili/auth');

const ARGS = process.argv.slice(1);
const T0 = Date.now();
const ms = () => `+${Date.now() - T0}ms`;
/** 启动耗时埋点：仅 --debug 时输出 */
const dbg = (msg) => {
  if (DEBUG) log.info(`[计时] ${msg} ${ms()}`);
};
const hasFlag = (f) => ARGS.some((a) => a === f || a.startsWith(f + '='));
const flagValue = (f) => {
  const hit = ARGS.find((a) => a.startsWith(f + '='));
  return hit ? hit.slice(f.length + 1) : null;
};

const IS_AUTOSTART = hasFlag('--autostart');
const FORCE_VIEW = flagValue('--view'); // 仅用于开发/截图：main | qr | settings | result
const SHOT_PATH = flagValue('--shot'); // 仅用于开发/截图：把渲染结果存成 PNG
const SHOT_DELAY = Number(flagValue('--shot-delay')) || 2000;
const SHOT_EXIT = hasFlag('--shot-exit');
const FORCE_TOP = hasFlag('--top');
const DEBUG = hasFlag('--debug');
const DRAG_BENCH = hasFlag('--drag-bench'); // 开发用：窗口移动性能基准
const FORCE_ACRYLIC = hasFlag('--force-acrylic'); // 开发用：强制走亚克力路径做 A/B 对比
const NO_TRANSPARENT = hasFlag('--no-transparent'); // 开发用：不透明窗口（牺牲圆角换流畅）

/**
 * 本机 GPU 加速是否可用。软件渲染下 backdrop-filter / SVG 滤镜会反复重栅格化，
 * 首帧可能卡十几秒，因此需要自动降级为轻量玻璃。
 */
function detectGpu() {
  try {
    const st = app.getGPUFeatureStatus();
    const compositing = st.gpu_compositing || '';
    const raster = st.rasterization || '';
    const ok = !/disabled_software/.test(compositing) && !/disabled_software/.test(raster);
    return { ok, compositing, raster, status: st };
  } catch (err) {
    return { ok: true, error: String(err.message) };
  }
}
const GPU = { ok: true, directComposition: null };
const PERF = () => (GPU.ok ? 'full' : 'lite');

/** 本次运行实际生效的材质，窗口创建前就已确定 */
let currentEffective = 'acrylic';
const FRAME_MARGIN = 8; // opaque 模式下给 CSS 圆角+阴影留的透明边距（每边 8px）

/**
 * 探测 DWM 是否支持 DirectComposition。
 * 没有它时 SetWindowCompositionAttribute 依然返回成功，但窗口其实不会出现磨砂效果，
 * 只会变成「半透明透视图」——这种情况下必须退回不透明底色，否则文字可读性很差。
 */
async function detectComposition() {
  try {
    const info = await Promise.race([
      app.getGPUInfo('basic'),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    const dc = info && info.auxAttributes ? info.auxAttributes.directComposition : null;
    GPU.directComposition = dc === true ? true : dc === false ? false : null;
    log.info(`DirectComposition 探测：${dc === undefined ? '字段缺失' : JSON.stringify(dc)}`);
  } catch (err) {
    GPU.directComposition = null;
    log.warn(`DirectComposition 探测失败：${err.message}`);
  }
  return GPU.directComposition;
}
const SIZE = {
  main: { width: 472, height: 690 },
  result: { width: 420, height: 320 },
};

/**
 * 实际窗口尺寸。
 * opaque 模式（原生模糊不可用）下用 CSS 画圆角+投影，需要四周留出透明边距，
 * 否则圆角会被窗口矩形裁掉、投影也无处渲染。
 */
function windowSize(mode) {
  const base = SIZE[mode] || SIZE.main;
  if (currentEffective !== 'opaque') return base;
  return { width: base.width + FRAME_MARGIN * 2, height: base.height + FRAME_MARGIN * 2 };
}

let win = null;
let currentMode = 'main';
let qrSession = null;
let running = false;
let lastAccount = null;
let lastResult = null;

nativeTheme.themeSource = 'dark';

// ---------------------------------------------------------------- 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function emitLog(entry) {
  send('evt:log', entry);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* ignore */
    }
  }
}

/** 开发用：构造渲染进程查询参数（result-demo 用于截图验证结果弹窗） */
function queryFor(mode) {
  const q = { mode, perf: PERF(), material: currentEffective };
  if (FORCE_VIEW === 'result-demo') q.view = 'demo';
  else if (FORCE_VIEW) q.view = FORCE_VIEW;
  const scroll = flagValue('--scroll');
  if (scroll) q.scroll = scroll;
  return q;
}

/** 判断最终生效的材质：原生模糊不可用时退回不透明玻璃底 */
function resolveMaterial(material, applied) {
  if (FORCE_ACRYLIC) return material === 'none' ? 'none' : material;
  if (material === 'none') return 'opaque';
  if (!applied || !applied.ok) return 'opaque';
  if (GPU.directComposition === false) return 'opaque';
  // 软件渲染（GPU 加速不可用）时 DWM 的窗口模糊同样不会出现
  if (GPU.ok === false) return 'opaque';
  return material;
}

/**
 * 窗口移动性能基准：一边连续移动窗口，一边统计渲染进程的 rAF 帧率。
 * 帧率最能反映「拖动时到底是谁在拖后腿」。
 */
async function runDragBench() {
  const [x0, y0] = win.getPosition();
  const startFrames = () =>
    win.webContents.executeJavaScript(
      'window.__rafN = 0; window.__rafOn = true; (function l(){ if(!window.__rafOn) return; window.__rafN++; requestAnimationFrame(l); })(); 0'
    );
  const stopFrames = (ms) =>
    win.webContents
      .executeJavaScript(`window.__rafOn=false; window.__rafN`)
      .then((n) => ({ n, ms }));

  await startFrames();
  await new Promise((r) => setTimeout(r, 500)); // 预热
  await win.webContents.executeJavaScript('window.__rafN = 0; 0');

  const N = 200;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    win.setPosition(x0 + ((i % 50) - 25) * 2, y0 + (Math.floor(i / 50) - 2) * 2);
    await new Promise((r) => setTimeout(r, 6));
  }
  const dt = Date.now() - t0;
  const { n } = await stopFrames(dt);
  win.setPosition(x0, y0);

  log.info(
    `[拖拽基准] 透明度=${!NO_TRANSPARENT} 材质=${currentEffective} 阴影=${!opaqueNoShadow()} | ` +
      `${N} 次移动用时 ${dt}ms（平均 ${(dt / N).toFixed(2)}ms/次）| 移动期间渲染帧数 ${n} → ${(n / (dt / 1000)).toFixed(1)} fps`
  );
}

function opaqueNoShadow() {
  return currentEffective === 'opaque';
}

// ---------------------------------------------------------------- 自绘拖拽
/**
 * Windows 上 `-webkit-app-region: drag` 走的是系统模态拖拽循环，
 * 实测拖起来会明显迟滞（渲染进程本身稳定 60fps，瓶颈在这个循环）。
 * 这里改成自己跟鼠标：按下时记录光标与窗口位置，之后按屏幕光标位移移动窗口，
 * 并用 GetAsyncKeyState 判断左键是否松开（鼠标移出窗口也能正确结束）。
 */
let dragTimer = null;
let dragOrigin = null;
const DRAG_INTERVAL_MS = 8;

function stopSelfDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOrigin = null;
}

function startSelfDrag() {
  if (!win || win.isDestroyed()) return { ok: false };
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOrigin = { cursor, wx, wy };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopSelfDrag();
    if (!win32.isLeftButtonDown()) return stopSelfDrag();
    const c = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(dragOrigin.wx + (c.x - dragOrigin.cursor.x)),
      Math.round(dragOrigin.wy + (c.y - dragOrigin.cursor.y))
    );
  }, DRAG_INTERVAL_MS);
  return { ok: true, selfDrag: true };
}

async function ensureLoaded() {
  if (!win || win.isDestroyed()) return;
  if (!win.webContents.isLoading()) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** 开发用：把渲染结果直接存成 PNG（不受窗口 z-order 影响） */
function scheduleShot() {
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(SHOT_PATH), { recursive: true });
      fs.writeFileSync(SHOT_PATH, img.toPNG());
      log.info(`界面截图已保存：${SHOT_PATH}`);
    } catch (err) {
      log.error(`截图失败：${err.message}`);
    }
    if (SHOT_EXIT) setTimeout(() => app.quit(), 300);
  }, SHOT_DELAY);
}

// ---------------------------------------------------------------- 窗口
function createWindow(mode = 'main', autoShow = true) {
  currentMode = mode;
  const size = windowSize(mode);
  const opaque = currentEffective === 'opaque' && !NO_TRANSPARENT;

  const opts = {
    width: size.width,
    height: size.height,
    frame: false,
    transparent: !NO_TRANSPARENT,
    resizable: false,
    maximizable: false,
    minimizable: mode === 'main',
    fullscreenable: false,
    show: false,
    backgroundColor: NO_TRANSPARENT ? '#12141d' : '#00000000',
    // opaque 模式下圆角与投影都由 CSS 绘制，系统再画一层矩形阴影就会露出直角
    hasShadow: !opaque,
    roundedCorners: false,
    title: 'BiliGlass · 大会员每日经验',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  };

  if (mode === 'result') {
    const area = screen.getPrimaryDisplay().workArea;
    opts.x = Math.round(area.x + area.width - size.width - 28);
    opts.y = Math.round(area.y + area.height - size.height - 28);
    opts.alwaysOnTop = true;
  }

  win = new BrowserWindow(opts);
  win.setMenuBarVisibility(false);
  dbg('窗口对象创建完成');

  const query = queryFor(mode);
  win.webContents.on('dom-ready', () => dbg('dom-ready'));
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
  dbg('loadFile 已调用');

  // 把渲染进程的报错转发到日志，便于排查白屏/透明窗问题
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    if (ev && typeof ev === 'object' && 'message' in ev) {
      log.warn(`[渲染进程:${ev.level || 'log'}] ${ev.message} (${ev.sourceId || ''}:${ev.lineNumber || 0})`);
    } else {
      const [, level, message, line, source] = args;
      log.warn(`[渲染进程:${level}] ${message} (${source}:${line})`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error(`页面加载失败：${desc} (${code}) ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`渲染进程退出：${details.reason}`);
  });

  win.once('ready-to-show', () => {
    dbg('ready-to-show');
    const cfg = store.get();
    // 关键：effective 为 opaque 时必须把原生的亚克力策略彻底关掉。
    // Win10 上 SetWindowCompositionAttribute 会把整块窗口矩形填上底色，
    // 直接盖掉 CSS 圆角，而且它的模糊运算正是拖拽迟滞的元凶。
    const applyMode = currentEffective === 'opaque' ? 'none' : cfg.material;
    const res = win32.applyMaterial(win, applyMode, { alpha: cfg.tintAlpha });
    if (!opaque) win32.applyDwm(win);
    log.info(
      `窗口材质：请求=${cfg.material} 实际调用=${applyMode} → ${res.ok ? '调用成功' : '失败：' + (res.error || '未知')}`
    );
    log.info(
      `实际生效材质：${currentEffective}` +
        (currentEffective === 'opaque'
          ? '（本机不支持窗口模糊 → 已关闭原生亚克力，改用 CSS 圆角+投影+不透明玻璃底，拖拽更顺滑）'
          : '')
    );
    send('evt:material', { material: cfg.material, native: res, effective: currentEffective });
    if (autoShow) {
      if (FORCE_TOP) win.setAlwaysOnTop(true, 'screen-saver');
      win.show();
      win.moveTop();
      if (mode === 'main') win.focus();
    }
    // 首帧出来之后再跑检测，避免子进程抢占 CPU 拖慢显示
    if (!hasFlag('--no-detect')) setTimeout(() => refreshDetection().catch(() => {}), 600);
    if (DRAG_BENCH) setTimeout(() => runDragBench().catch(() => {}), 800);
    if (SHOT_PATH) scheduleShot();
  });

  win.on('closed', () => {
    win = null;
  });

  return win;
}

function switchMode(mode) {
  const size = windowSize(mode);
  if (!win || win.isDestroyed()) return createWindow(mode);
  currentMode = mode;
  win.setAlwaysOnTop(mode === 'result');
  if (mode === 'main') {
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      width: size.width,
      height: size.height,
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: Math.round(area.y + (area.height - size.height) / 2),
    });
    win.center();
  }
  win.setSize(size.width, size.height);
  const query = queryFor(mode);
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
  win.show();
  win.focus();
  return win;
}

// ---------------------------------------------------------------- 状态
/**
 * 检测结果缓存。自启状态与客户端路径都要跑 PowerShell（数百毫秒到数秒），
 * 必须在后台异步刷新，buildState() 只读缓存，否则会阻塞窗口首帧。
 */
const cache = { autostart: null, client: null };

async function refreshDetection({ announce = true } = {}) {
  const cfg = store.get();
  const [auto, detected] = await Promise.all([
    autostart.status(app).catch((err) => ({ enabled: !!cfg.autostart, method: cfg.autostartMethod, error: err.message })),
    client.detectClientPath(cfg.clientPath).catch(() => ''),
  ]);
  cache.autostart = auto;
  cache.client = { path: cfg.clientPath || detected, detected, exists: !!detected };
  // 以实际注册状态为准回写配置，避免「界面显示已开启但其实没注册」
  if (typeof auto.enabled === 'boolean' && !!cfg.autostart !== !!auto.enabled) {
    store.patch({ autostart: !!auto.enabled });
    if (announce) send('evt:state-patch', { autostart: !!auto.enabled });
  }
  if (announce) send('evt:detected', { autostart: cache.autostart, client: cache.client });
  return cache;
}

function buildState() {
  const cfg = store.get();
  return {
    config: cfg,
    autostart:
      cache.autostart ||
      {
        enabled: !!cfg.autostart,
        method: cfg.autostartMethod,
        command: autostart.commandLine(app),
        targetExe: autostart.commandFor(app).exe,
        pending: true,
      },
    client:
      cache.client || {
        path: cfg.clientPath,
        detected: cfg.clientPath,
        exists: !!cfg.clientPath,
        pending: true,
      },
    account: lastAccount,
    lastResult,
    running,
    material: cfg.material,
    nativeMaterial: win32.available(),
    materialError: win32.loadError(),
    effectiveMaterial: resolveMaterial(cfg.material, { ok: win32.available() }),
    perf: { mode: PERF(), gpu: GPU },
    logs: log.history(),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    paths: {
      userData: app.getPath('userData'),
      logFile: log.file(),
    },
    isAutostart: IS_AUTOSTART,
    platform: `${process.platform} ${process.arch}`,
    logFile: log.file(),
  };
}

// ---------------------------------------------------------------- 执行
async function startRun({ manual = false } = {}) {
  if (running) return { ok: false, message: '任务正在执行中' };
  running = true;
  try {
    const result = await runner.runOnce({
      manual,
      onState: (s) => send('evt:run', s),
    });
    lastResult = {
      ok: !!result.ok,
      skipped: !!result.skipped,
      needLogin: !!result.needLogin,
      message: result.message,
      code: result.claim ? result.claim.code : undefined,
      at: Date.now(),
    };
    if (result.info) lastAccount = result.info;
    send('evt:run', { phase: 'finished', result: lastResult, account: lastAccount });
    return result;
  } catch (err) {
    log.error(`执行异常：${err.message}`);
    lastResult = { ok: false, message: `执行异常：${err.message}`, at: Date.now() };
    send('evt:run', { phase: 'finished', result: lastResult });
    return { ok: false, message: err.message };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:state', () => buildState());

  ipcMain.handle('config:save', async (_e, patch) => {
    const before = store.get();
    const next = store.patch(patch || {});
    const materialChanged =
      (patch && patch.material && patch.material !== before.material) || (patch && typeof patch.tintAlpha === 'number');
    if (materialChanged && win) {
      currentEffective = resolveMaterial(next.material, { ok: win32.available() });
      const applyMode = currentEffective === 'opaque' ? 'none' : next.material;
      win32.applyMaterial(win, applyMode, { alpha: next.tintAlpha });
      if (currentEffective !== 'opaque') win32.applyDwm(win);
      send('evt:material', { material: next.material, effective: currentEffective });
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autostart')) {
      const r = await autostart.set(app, !!patch.autostart, next.autostartMethod || 'registry');
      send('evt:autostart', r);
      await refreshDetection({ announce: false });
    }
    return buildState();
  });

  ipcMain.handle('autostart:set', async (_e, { enabled, method, delaySec } = {}) => {
    if (method) store.patch({ autostartMethod: method });
    if (typeof delaySec === 'number') store.patch({ startupDelaySec: delaySec });
    const cfg = store.get();
    const r = await autostart.set(app, !!enabled, cfg.autostartMethod);
    // 方式回退（例如计划任务需要管理员权限）时，把配置也改成实际生效的方式
    if (r.ok && r.fellBackFrom && r.method) store.patch({ autostartMethod: r.method });
    if (r.ok) store.patch({ autostart: !!enabled });
    send('evt:autostart', r);
    await refreshDetection({ announce: false });
    return { result: r, state: buildState() };
  });

  ipcMain.handle('client:launch', async () => {
    const cfg = store.get();
    return client.launch(cfg.clientPath, log);
  });

  ipcMain.handle('client:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择哔哩哔哩客户端主程序',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    store.patch({ clientPath: r.filePaths[0] });
    await refreshDetection({ announce: false });
    return { canceled: false, path: r.filePaths[0], state: buildState() };
  });

  ipcMain.handle('client:redetect', async () => {
    const p = await client.detectClientPath('');
    store.patch({ clientPath: p });
    await refreshDetection({ announce: false });
    return { path: p, state: buildState() };
  });

  ipcMain.handle('run:start', async (_e, opts) => {
    const result = await startRun({ manual: true, ...(opts || {}) });
    return { result, state: buildState() };
  });

  ipcMain.handle('auth:qr-start', async () => {
    if (qrSession) qrSession.stop();
    qrSession = new QrSession((evt) => {
      send('evt:qr', evt);
      if (evt.state === 'success' && evt.info) {
        lastAccount = evt.info;
        log.ok(`扫码登录成功：${evt.info.uname}`);
      }
    });
    try {
      const r = await qrSession.start();
      const image = await QRCode.toDataURL(r.url, {
        margin: 1,
        width: 340,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b0e16ff', light: '#ffffffff' },
      });
      return { ok: true, image, url: r.url, key: r.key };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('auth:qr-stop', () => {
    if (qrSession) qrSession.stop();
    qrSession = null;
    return { ok: true };
  });

  ipcMain.handle('auth:logout', async () => {
    auth.clearCookie();
    lastAccount = null;
    log.info('已清除本地保存的扫码登录态');
    return buildState();
  });

  ipcMain.handle('account:refresh', async () => {
    const cred = await auth.resolve({
      preferQr: true,
      allowClient: store.get().allowClientCredentials !== false,
    });
    if (cred.source && cred.info) {
      lastAccount = cred.info;
      log.ok(`已刷新账号信息：${cred.info.uname}（${cred.source === 'qr' ? '扫码登录' : '客户端登录态'}）`);
    }
    return { source: cred.source, info: cred.info || null, notes: cred.notes, state: buildState() };
  });

  ipcMain.handle('watch:resolve', async (_e, input) => {
    const cred = auth.loadCookie(); // 本地已保存的扫码登录态；没有也能取标题
    const r = await watch.resolveVideoInput(input, cred ? cred.cookie : '');
    if (r.ok && !r.empty) {
      store.patch({ watchBvid: r.bvid, watchBvidTitle: r.title || '' });
      log.ok(`已指定观看视频：${r.bvid}《${r.title}》（${r.duration}s，来源：${r.via}）`);
    } else if (r.ok && r.empty) {
      store.patch({ watchBvid: '', watchBvidTitle: '' });
      log.info('已清空指定视频，改回自动从排行榜挑选');
    } else {
      log.warn(`视频号解析失败：${r.error}`);
    }
    return { result: r, state: buildState() };
  });

  ipcMain.handle('ui:open-main', () => {
    switchMode('main');
    return { ok: true };
  });

  ipcMain.handle('ui:open-result', () => {
    switchMode('result');
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('shell:open-log', () => {
    const f = log.file();
    if (f && fs.existsSync(f)) shell.showItemInFolder(f);
    return { ok: true, file: f };
  });

  ipcMain.handle('shell:open-userdata', () => {
    shell.openPath(app.getPath('userData'));
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => {
    if (win) win.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:close', () => {
    if (win) win.close();
    return { ok: true };
  });

  ipcMain.handle('win:drag-start', () => {
    const cfg = store.get();
    if (cfg.dragSelf === false) return { ok: true, selfDrag: false };
    return startSelfDrag();
  });

  ipcMain.handle('win:drag-end', () => {
    stopSelfDrag();
    return { ok: true };
  });

  ipcMain.handle('window:set-material', (_e, material) => {
    const cfg = store.patch({ material });
    currentEffective = resolveMaterial(cfg.material, { ok: win32.available() });
    const applyMode = currentEffective === 'opaque' ? 'none' : cfg.material;
    const res = win ? win32.applyMaterial(win, applyMode, { alpha: cfg.tintAlpha }) : { ok: false };
    if (win && currentEffective !== 'opaque') win32.applyDwm(win);
    log.info(`切换窗口材质：请求=${cfg.material} 生效=${currentEffective}`);
    send('evt:material', { material: cfg.material, native: res, effective: currentEffective });
    return { result: res, material: cfg.material, effective: currentEffective };
  });
}

// ---------------------------------------------------------------- 启动
app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  store.init(userData);
  log.init(path.join(userData, 'logs'));
  auth.init(userData);
  log.onEntry(emitLog);

  const gpu = detectGpu();
  GPU.ok = gpu.ok;
  GPU.compositing = gpu.compositing;
  GPU.raster = gpu.raster;
  // 窗口创建前就定下实际生效的材质，这样窗口尺寸/阴影/圆角方案一次到位
  currentEffective = resolveMaterial(store.get().material, { ok: win32.available() });
  log.info(`GPU 合成：${gpu.compositing} / 光栅化：${gpu.raster} → 界面性能模式：${PERF()}`);
  log.info(`预判窗口材质：${currentEffective}`);

  // 异步探测 DirectComposition（决定窗口模糊是否真的有效），不阻塞窗口显示
  detectComposition().then((dc) => {
    if (dc === false && currentEffective !== 'opaque') {
      currentEffective = 'opaque';
      log.warn('本机 DWM 不支持 DirectComposition，窗口模糊不会生效 → 已切换为不透明玻璃底并关闭原生亚克力');
      if (win && !win.isDestroyed()) {
        const applied = win32.applyMaterial(win, 'none');
        send('evt:material', { material: store.get().material, native: applied, effective: 'opaque' });
      }
    }
  });

  log.info(`BiliGlass 启动（v${app.getVersion()}，Electron ${process.versions.electron}）`);
  log.info(`运行模式：${IS_AUTOSTART ? '开机自启' : '手动启动'}${FORCE_VIEW ? ' · 视图 ' + FORCE_VIEW : ''}`);
  log.info(`日志文件：${log.file()}`);

  if (!win32.available()) {
    log.warn(`原生亚克力材质不可用（${win32.loadError() || '未知原因'}），已退回 CSS 毛玻璃`);
  }
  if (!gpu.ok) {
    log.warn('检测到软件渲染（GPU 加速不可用），已自动切换为轻量玻璃模式以加快启动');
  }

  registerIpc();

  if (IS_AUTOSTART) {
    const cfg = store.get();
    const delay = Math.max(0, Number(cfg.startupDelaySec) || 0);
    log.info(`开机自启模式：等待 ${delay}s 后开始执行`);
    // 静默执行，不弹主界面；结束后只弹出结果卡片
    createWindow('result', false);
    await new Promise((r) => setTimeout(r, delay * 1000));
    const result = await startRun({ manual: false });

    // 开机先检测发现今日经验已领取 → 立刻退出进程，不弹任何窗口
    if (result && result.silentExit) {
      log.ok('今日经验此前已领取，进程直接退出（不弹结果窗）');
      app.exit(0);
      return;
    }

    await ensureLoaded();
    if (win && !win.isDestroyed()) {
      send('evt:run', { phase: 'finished', result: lastResult, account: lastAccount });
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
    }
    return;
  }

  createWindow(FORCE_VIEW === 'result' || FORCE_VIEW === 'result-demo' ? 'result' : 'main');
  return;
});

app.on('before-quit', () => {
  if (qrSession) qrSession.stop();
});
