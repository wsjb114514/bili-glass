'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('biliglass', {
  getState: () => ipcRenderer.invoke('app:state'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  setAutostart: (payload) => ipcRenderer.invoke('autostart:set', payload),
  run: (opts) => ipcRenderer.invoke('run:start', opts),
  launchClient: () => ipcRenderer.invoke('client:launch'),
  pickClient: () => ipcRenderer.invoke('client:pick'),
  redetectClient: () => ipcRenderer.invoke('client:redetect'),
  qrStart: () => ipcRenderer.invoke('auth:qr-start'),
  qrStop: () => ipcRenderer.invoke('auth:qr-stop'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  refreshAccount: () => ipcRenderer.invoke('account:refresh'),
  openMain: () => ipcRenderer.invoke('ui:open-main'),
  openResultView: () => ipcRenderer.invoke('ui:open-result'),
  quit: () => ipcRenderer.invoke('app:quit'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  setMaterial: (m) => ipcRenderer.invoke('window:set-material', m),
  dragStart: () => ipcRenderer.invoke('win:drag-start'),
  dragEnd: () => ipcRenderer.invoke('win:drag-end'),
  openLog: () => ipcRenderer.invoke('shell:open-log'),
  openUserData: () => ipcRenderer.invoke('shell:open-userdata'),
  onLog: on('evt:log'),
  onRun: on('evt:run'),
  onQr: on('evt:qr'),
  onMaterial: on('evt:material'),
  onAutostart: on('evt:autostart'),
  onDetected: on('evt:detected'),
  onStatePatch: on('evt:state-patch'),
});
