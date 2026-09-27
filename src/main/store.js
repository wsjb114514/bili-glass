'use strict';
/** 配置持久化（userData/config.json） */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 开机自启
  autostart: false,
  autostartMethod: 'registry', // registry | task
  startupDelaySec: 12, // 启动后等待多少秒再执行（等网络/客户端就绪）

  // 客户端
  launchClient: true,
  clientPath: '',
  clientWaitSec: 6,

  // 领取
  autoClaim: true,
  authPrefer: 'qr', // qr(扫码登录态) → client(客户端登录态)
  allowClientCredentials: true,

  // 观看前置：B站「观看视频」类任务/大会员经验需要先有观看行为
  watchBeforeClaim: true,
  watchSeconds: 62,
  watchBvid: '',

  // 外观
  material: 'acrylic', // acrylic | blur | none
  tintAlpha: 0xcc,
  dragSelf: true, // true=自绘拖拽（绕开系统模态循环，更顺滑）

  // 记录
  lastClaimDate: '',
  lastRun: null,
  history: [],
};

let file = null;
let data = { ...DEFAULTS };

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...DEFAULTS, ...raw };
  } catch {
    data = { ...DEFAULTS };
    persist();
  }
  return data;
}

function persist() {
  if (!file) return;
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

function get() {
  return data;
}

function patch(partial) {
  data = { ...data, ...partial };
  persist();
  return data;
}

function pushHistory(record) {
  const list = Array.isArray(data.history) ? data.history.slice(0, 59) : [];
  list.unshift(record);
  data.history = list.slice(0, 60);
  persist();
}

function reset() {
  data = { ...DEFAULTS };
  persist();
  return data;
}

module.exports = { init, get, patch, pushHistory, reset, DEFAULTS, filePath: () => file };
