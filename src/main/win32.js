'use strict';
/**
 * Win32 原生窗口效果：亚克力（Acrylic）背景模糊、DWM 圆角。
 * 通过 koffi 直接调用 user32.dll / dwmapi.dll，无需编译原生模块。
 * 任何一步失败都不会抛到调用方，只是让上层退化到 CSS 方案。
 */
const path = require('path');

const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const ACCENT_ENABLE_HOSTBACKDROP = 5;

const WCA_ACCENT_POLICY = 19;

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_ROUND = 2;

let koffi = null;
let user32 = null;
let dwmapi = null;
let ACCENT_POLICY = null;
let WCADATA = null;
let SetWindowCompositionAttribute = null;
let DwmSetWindowAttribute = null;
let GetAsyncKeyState = null;
let loadError = null;

function init() {
  if (koffi || loadError) return !loadError;
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    dwmapi = koffi.load('dwmapi.dll');

    ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
      AccentState: 'int',
      AccentFlags: 'int',
      GradientColor: 'uint32',
      AnimationId: 'int',
    });

    WCADATA = koffi.struct('WINDOWCOMPOSITIONATTRIBDATA', {
      Attribute: 'int',
      Data: koffi.pointer('void'),
      SizeOfData: 'size_t',
    });

    SetWindowCompositionAttribute = user32.func(
      'int SetWindowCompositionAttribute(uint64 hwnd, WINDOWCOMPOSITIONATTRIBDATA *data)'
    );
    DwmSetWindowAttribute = dwmapi.func(
      'int DwmSetWindowAttribute(uint64 hwnd, uint32 attr, void *value, uint32 size)'
    );
    GetAsyncKeyState = user32.func('int16 GetAsyncKeyState(int vKey)');
    return true;
  } catch (err) {
    loadError = err;
    koffi = null;
    return false;
  }
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  return BigInt(buf.readUInt32LE(0));
}

/** ABGR 打包（Win10 亚克力要求 alpha 非 0，否则完全不透明） */
function packAbgr(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (((alpha & 0xff) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * @param {'acrylic'|'blur'|'none'} material
 * @param {{tint?:string, alpha?:number}} [opts]
 */
function applyMaterial(win, material = 'acrylic', opts = {}) {
  if (!init()) return { ok: false, error: String(loadError && loadError.message) };
  const tint = opts.tint || '#12141d';
  const alpha = typeof opts.alpha === 'number' ? opts.alpha : 0xcc;

  let state = ACCENT_DISABLED;
  let flags = 0;
  if (material === 'acrylic') {
    state = ACCENT_ENABLE_ACRYLICBLURBEHIND;
    flags = 2; // ENABLE_GRADIENT_COLOR
  } else if (material === 'blur') {
    state = ACCENT_ENABLE_BLURBEHIND;
    flags = 0;
  }

  try {
    const policy = {
      AccentState: state,
      AccentFlags: flags,
      GradientColor: material === 'none' ? 0 : packAbgr(tint, material === 'blur' ? 0x01 : alpha),
      AnimationId: 0,
    };
    const data = {
      Attribute: WCA_ACCENT_POLICY,
      Data: koffi.as(policy, koffi.pointer(ACCENT_POLICY)),
      SizeOfData: koffi.sizeof(ACCENT_POLICY),
    };
    const ret = SetWindowCompositionAttribute(hwndOf(win), data);
    return { ok: !!ret, material };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/** Win11 圆角 + 深色标题栏；Win10 上会静默失败（用 CSS 圆角代替） */
function applyDwm(win) {
  if (!init() || !DwmSetWindowAttribute) return false;
  try {
    const hwnd = hwndOf(win);
    const dark = Buffer.alloc(4);
    dark.writeInt32LE(1, 0);
    DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, dark, 4);
    const round = Buffer.alloc(4);
    round.writeInt32LE(DWMWCP_ROUND, 0);
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, round, 4);
    return true;
  } catch {
    return false;
  }
}

/**
 * 重新把窗口置顶/失焦时的亚克力刷新一下（Win10 某些显卡切换主题后会掉）。
 */
function refresh(win, material, opts) {
  return applyMaterial(win, material, opts);
}

/**
 * 鼠标左键当前是否按下（VK_LBUTTON = 0x01）。
 * 自绘拖拽靠它判断「即使鼠标移出窗口也能正确结束拖拽」。
 */
function isLeftButtonDown() {
  if (!init() || !GetAsyncKeyState) return false;
  try {
    return (GetAsyncKeyState(0x01) & 0x8000) !== 0;
  } catch {
    return false;
  }
}

module.exports = {
  init,
  available: () => init(),
  applyMaterial,
  applyDwm,
  refresh,
  packAbgr,
  isLeftButtonDown,
  loadError: () => (loadError ? String(loadError.message) : null),
};
