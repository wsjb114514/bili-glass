'use strict';
/** 验证 koffi 原生调用链是否可用（不真正改窗口） */
const koffi = require('koffi');

console.log('koffi version:', koffi.version);

try {
  const user32 = koffi.load('user32.dll');
  const ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
    AccentState: 'int',
    AccentFlags: 'int',
    GradientColor: 'uint32',
    AnimationId: 'int',
  });
  const WCADATA = koffi.struct('WINDOWCOMPOSITIONATTRIBDATA', {
    Attribute: 'int',
    Data: koffi.pointer('void'),
    SizeOfData: 'size_t',
  });
  const SetWindowCompositionAttribute = user32.func(
    'int SetWindowCompositionAttribute(uint64 hwnd, WINDOWCOMPOSITIONATTRIBDATA *data)'
  );
  const policy = { AccentState: 4, AccentFlags: 2, GradientColor: 0xcc1d1412, AnimationId: 0 };
  const data = {
    Attribute: 19,
    Data: koffi.as(policy, koffi.pointer(ACCENT_POLICY)),
    SizeOfData: koffi.sizeof(ACCENT_POLICY),
  };
  const ret = SetWindowCompositionAttribute(0n, data);
  console.log('SetWindowCompositionAttribute(hwnd=0) 返回:', ret, '（0=预期，说明调用链正常）');
} catch (err) {
  console.log('user32 调用失败:', err.message);
}

try {
  const dwmapi = koffi.load('dwmapi.dll');
  const DwmSetWindowAttribute = dwmapi.func('int DwmSetWindowAttribute(uint64 hwnd, uint32 attr, void *value, uint32 size)');
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(1, 0);
  console.log('DwmSetWindowAttribute(hwnd=0) 返回:', DwmSetWindowAttribute(0n, 20, buf, 4));
} catch (err) {
  console.log('dwmapi 调用失败:', err.message);
}

// DPAPI：正确写法（结构体按注册名引用）
try {
  const crypt32 = koffi.load('crypt32.dll');
  const DATA_BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: koffi.pointer('uint8') });
  const CryptProtectData = crypt32.func(
    'int CryptProtectData(DATA_BLOB *pDataIn, void *szDesc, DATA_BLOB *pEntropy, void *pvReserved, void *pPrompt, uint32 flags, _Out_ DATA_BLOB *pDataOut)'
  );
  const CryptUnprotectData = crypt32.func(
    'int CryptUnprotectData(DATA_BLOB *pDataIn, void *pDesc, DATA_BLOB *pEntropy, void *pvReserved, void *pPrompt, uint32 flags, _Out_ DATA_BLOB *pDataOut)'
  );
  const kernel32 = koffi.load('kernel32.dll');
  const LocalFree = kernel32.func('void *LocalFree(void *h)');

  const secret = Buffer.from('hello-koffi', 'utf8');
  const out = {};
  const ok1 = CryptProtectData({ cbData: secret.length, pbData: secret }, null, null, null, null, 0, out);
  console.log('CryptProtectData:', ok1, 'cbData:', out.cbData);
  const enc = Buffer.from(koffi.decode(out.pbData, 'uint8', out.cbData));
  LocalFree(out.pbData);

  const out2 = {};
  const ok2 = CryptUnprotectData({ cbData: enc.length, pbData: enc }, null, null, null, null, 0, out2);
  const dec = Buffer.from(koffi.decode(out2.pbData, 'uint8', out2.cbData));
  LocalFree(out2.pbData);
  console.log('CryptUnprotectData:', ok2, '内容:', dec.toString('utf8'));
} catch (err) {
  console.log('crypt32 调用失败:', err.message);
}
