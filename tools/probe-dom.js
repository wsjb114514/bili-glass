'use strict';
/**
 * 渲染层 DOM 探针：加载真实界面并打印指定区域的实际渲染文本。
 * 用来客观核对界面元素是否真的渲染出来了（不依赖截图/肉眼）。
 * 用法：electron tools/probe-dom.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const STUB_STATE = {
  config: {
    autostart: true,
    autostartMethod: 'registry',
    startupDelaySec: 12,
    launchClient: true,
    clientPath: '',
    clientWaitSec: 5,
    autoClaim: true,
    authPrefer: 'client',
    allowClientCredentials: true,
    watchBeforeClaim: true,
    watchSeconds: 62,
    watchBvid: '',
    watchBvidTitle: '',
    precheckFirst: true,
    material: 'acrylic',
    tintAlpha: 204,
    dragSelf: true,
    lastClaimDate: '',
    lastRun: null,
    history: [],
  },
  autostart: { enabled: true, method: 'registry' },
  client: { path: '', detected: 'C:\\Program Files\\bilibili\\哔哩哔哩.exe', exists: true },
  account: null,
  lastResult: null,
  running: false,
  material: 'acrylic',
  nativeMaterial: true,
  perf: { mode: 'lite', gpu: { ok: false } },
  logs: [],
  versions: { app: '1.1.0', electron: process.versions.electron, node: process.versions.node, chrome: 'x' },
  paths: { userData: '', logFile: '' },
  isAutostart: false,
  platform: 'win32 x64',
  logFile: '',
};

ipcMain.handle('app:state', () => STUB_STATE);
['config:save', 'autostart:set', 'run:start', 'auth:qr-start', 'watch:resolve'].forEach((ch) =>
  ipcMain.handle(ch, () => ({ ok: true, state: STUB_STATE }))
);
ipcMain.handle('window:set-material', () => ({ ok: true }));
ipcMain.handle('app:quit', () => app.quit());

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 500,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), {
    query: { mode: 'main', perf: 'lite', material: 'opaque', view: 'settings' },
  });
  await new Promise((r) => setTimeout(r, 1200));

  const text = await win.webContents.executeJavaScript(
    `document.querySelector('.sheet-body') ? document.querySelector('.sheet-body').innerText : '(找不到设置面板)'`
  );
  console.log('===== 设置面板实际渲染文本 =====');
  console.log(text);

  const checks = await win.webContents.executeJavaScript(`(() => {
    const ids = ['swPrecheckFirst','swWatchBeforeClaim','txtWatchBvid','btnResolveBvid','btnClearBvid','resolvedLine','swDragSelf','rngWatchSeconds'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? (el.offsetParent !== null ? 'visible' : 'hidden') : 'MISSING';
    }
    out['precheckRowText'] = (document.getElementById('swPrecheckFirst')||{}).closest
      ? (document.getElementById('swPrecheckFirst').closest('.row')||{}).innerText : '';
    return out;
  })()`);
  console.log('\n===== 关键控件存在性 =====');
  console.log(JSON.stringify(checks, null, 1));

  app.exit(0);
});
