'use strict';
/**
 * 自绘应用图标 → build/icon.png + build/icon.ico（多尺寸，PNG 压缩条目）
 * 无需任何图像库，纯 zlib + 手写 PNG/ICO 封装。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [256, 128, 64, 48, 32, 16];
const SS = 4; // 每像素超采样

const C_PINK = [251, 114, 153];
const C_BLUE = [35, 173, 229];
const C_VIOLET = [139, 124, 246];

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const inX = x < x0 + r || x > x1 - r;
  const inY = y < y0 + r || y > y1 - r;
  if (inX && inY) {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 归一化坐标 u,v ∈ [0,1]，返回 [r,g,b,a] */
function sample(u, v) {
  const inset = 0.024;
  const radius = 0.26;
  if (!insideRoundRect(u, v, inset, inset, 1 - inset, 1 - inset, radius)) return [0, 0, 0, 0];

  // 渐变底：粉 → 紫 → 蓝
  const t = clamp01((u + v) / 2);
  let base;
  if (t < 0.5) base = mix(C_PINK, C_VIOLET, t / 0.5);
  else base = mix(C_VIOLET, C_BLUE, (t - 0.5) / 0.5);

  // 顶部玻璃高光
  const gl = clamp01(1 - Math.hypot((u - 0.3) / 0.62, (v - 0.12) / 0.5));
  const gA = Math.pow(gl, 2.1) * 0.42;

  // 底部内阴影，增加体积感
  const sh = clamp01((v - 0.55) / 0.5) * 0.22;

  let r = base[0] * (1 - sh) + 8 * sh;
  let g = base[1] * (1 - sh) + 10 * sh;
  let b = base[2] * (1 - sh) + 18 * sh;

  r = r * (1 - gA) + 255 * gA;
  g = g * (1 - gA) + 255 * gA;
  b = b * (1 - gA) + 255 * gA;

  // 中央白色玻璃「播放 / 领取」三角
  const tri = [
    [0.415, 0.315],
    [0.415, 0.685],
    [0.705, 0.5],
  ];
  let a = 1;
  if (insideTriangle(u, v, ...tri.flat())) {
    // 三角内部再做一次柔和渐变，模拟玻璃质感
    const ty = clamp01((v - 0.315) / 0.37);
    const tint = mix([255, 255, 255], [255, 226, 238], ty);
    const k = 0.96;
    r = r * (1 - k) + tint[0] * k;
    g = g * (1 - k) + tint[1] * k;
    b = b * (1 - k) + tint[2] * k;
  }

  // 外圈玻璃描边
  const edge = 1 - clamp01((Math.min(u, v, 1 - u, 1 - v) - inset) / 0.012);
  if (edge > 0) {
    const e = edge * 0.5;
    r = r * (1 - e) + 255 * e;
    g = g * (1 - e) + 255 * e;
    b = b * (1 - e) + 255 * e;
  }

  return [r, g, b, a];
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const n = SS * SS;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const s = sample(u, v);
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        buf[i] = Math.max(0, Math.min(255, Math.round(r / a)));
        buf[i + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
        buf[i + 2] = Math.max(0, Math.min(255, Math.round(b / a)));
      }
      buf[i + 3] = Math.max(0, Math.min(255, Math.round((a / n) * 255)));
    }
  }
  return buf;
}

// ------------------------------------------------------------ PNG 编码
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ ICO 封装
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ------------------------------------------------------------ 输出
fs.mkdirSync(OUT_DIR, { recursive: true });
const entries = SIZES.map((size) => ({ size, png: encodePNG(renderRGBA(size), size) }));

fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), entries[0].png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeICO(entries));

console.log(
  `icon.ico 生成完成：${SIZES.join('/')} → ${(fs.statSync(path.join(OUT_DIR, 'icon.ico')).size / 1024).toFixed(1)} KB`
);
