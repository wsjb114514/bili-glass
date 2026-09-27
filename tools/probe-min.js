'use strict';
/** 基准：分离测量「Electron 环境本身」与「本应用界面」的首帧耗时（结果写文件，避免 GUI 子系统吞掉 stdout） */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || path.join(require('os').tmpdir(), 'probe-out.txt');
const t0 = Date.now();
const lines = [];
function log(msg) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(2)}s] ${msg}`;
  lines.push(line);
  try {
    fs.appendFileSync(OUT, line + '\r\n', 'utf8');
  } catch {}
}
fs.writeFileSync(OUT, `probe start mode=${process.argv.join(' ')}\r\n`, 'utf8');

const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=plain').slice(7);

setTimeout(() => {
  log('HARD TIMEOUT 30s → quit');
  app.quit();
}, 30000);

app.whenReady().then(() => {
  log(`app ready (mode=${mode})`);
  const opts = { width: 472, height: 690, show: false };
  if (mode === 'transparent' || mode === 'real' || mode === 'exact' || mode === 'noicon') {
    opts.frame = false;
    opts.transparent = true;
    opts.backgroundColor = '#00000000';
  }
  if (mode === 'exact' || mode === 'noicon') {
    opts.resizable = false;
    opts.maximizable = false;
    opts.minimizable = true;
    opts.fullscreenable = false;
    opts.hasShadow = true;
    opts.roundedCorners = false;
    opts.title = 'BiliGlass · 大会员每日经验';
    if (mode === 'exact') opts.icon = path.join(__dirname, '..', 'build', 'icon.ico');
  }
  if (mode === 'real' || mode === 'exact' || mode === 'noicon') {
    opts.webPreferences = {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    };
  }
  const win = new BrowserWindow(opts);
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('dom-ready', () => log('dom-ready'));
  win.webContents.on('did-fail-load', (_e, c, d) => log(`did-fail-load ${d} ${c}`));
  win.webContents.once('ready-to-show', () => {
    log('ready-to-show → show()');
    win.show();
  });

  if (mode === 'real' || mode === 'exact' || mode === 'noicon') {
    win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), { query: { mode: 'main', perf: 'lite' } });
  } else if (mode === 'heavy') {
    win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:linear-gradient(#123,#456)">' +
            '<svg width="0" height="0"><filter id="f"><feTurbulence baseFrequency="0.01" numOctaves="2"/><feGaussianBlur stdDeviation="2"/><feDisplacementMap in="SourceGraphic" scale="30"/></filter></svg>' +
            '<div style="filter:url(#f);width:400px;height:300px;background:#fff3"></div>' +
            '</body></html>'
        )
    );
  } else {
    win.loadURL('data:text/html,<body style="background:%23123456">hello</body>');
  }
});

app.on('quit', () => log('quit'));
