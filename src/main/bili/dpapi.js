'use strict';
/**
 * Windows DPAPI 加解密（CurrentUser 作用域）。
 * 首选 koffi 直调 crypt32，失败时回退到 PowerShell（-EncodedCommand，规避引号/编码问题）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let koffi = null;
let crypt32 = null;
let DATA_BLOB = null;
let pCryptProtect = null;
let pCryptUnprotect = null;
let kernel32 = null;
let pLocalFree = null;
let nativeBroken = false;

function initNative() {
  if (nativeBroken) return false;
  if (pCryptProtect) return true;
  try {
    koffi = require('koffi');
    crypt32 = koffi.load('crypt32.dll');
    kernel32 = koffi.load('kernel32.dll');
    DATA_BLOB = koffi.struct('DATA_BLOB', {
      cbData: 'uint32',
      pbData: koffi.pointer('uint8'),
    });
    pCryptProtect = crypt32.func(
      'int CryptProtectData(DATA_BLOB *pDataIn, void *szDesc, DATA_BLOB *pEntropy, void *pvReserved, void *pPrompt, uint32 flags, _Out_ DATA_BLOB *pDataOut)'
    );
    pCryptUnprotect = crypt32.func(
      'int CryptUnprotectData(DATA_BLOB *pDataIn, void *pDesc, DATA_BLOB *pEntropy, void *pvReserved, void *pPrompt, uint32 flags, _Out_ DATA_BLOB *pDataOut)'
    );
    pLocalFree = kernel32.func('void *LocalFree(void *h)');
    // 自检：一次真实的加解密往返，失败则整体退回 PowerShell
    const probe = Buffer.from('biliglass-probe', 'utf8');
    const enc = nativeCall(pCryptProtect, probe);
    const dec = nativeCall(pCryptUnprotect, enc);
    if (!dec.equals(probe)) throw new Error('DPAPI 自检失败');
    return true;
  } catch {
    nativeBroken = true;
    pCryptProtect = null;
    return false;
  }
}

function nativeCall(fn, input) {
  const inBlob = { cbData: input.length, pbData: input };
  const out = {};
  const ok = fn(inBlob, null, null, null, null, 0, out);
  if (!ok) throw new Error('DPAPI 调用返回 0');
  const ptr = out.pbData;
  if (!ptr || !out.cbData) throw new Error('DPAPI 输出为空');
  let result;
  try {
    result = Buffer.from(koffi.decode(ptr, 'uint8', out.cbData));
  } finally {
    try {
      pLocalFree(ptr);
    } catch {
      /* ignore */
    }
  }
  return result;
}

function psRun(mode, input) {
  const tmpDir = os.tmpdir();
  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(tmpDir, `bg-dp-${tag}.bin`);
  const outFile = path.join(tmpDir, `bg-dp-${tag}.out`);
  fs.writeFileSync(inFile, input);
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$raw=[IO.File]::ReadAllBytes('${inFile.replace(/'/g, "''")}')
$out=[System.Security.Cryptography.ProtectedData]::${mode === 'protect' ? 'Protect' : 'Unprotect'}($raw,$null,'CurrentUser')
[IO.File]::WriteAllBytes('${outFile.replace(/'/g, "''")}',$out)
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 20000,
  });
  let out = null;
  try {
    out = fs.readFileSync(outFile);
  } catch {
    out = null;
  }
  for (const f of [inFile, outFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (!out) {
    throw new Error(`PowerShell DPAPI 失败: ${(r.stderr || '').toString().trim() || r.status}`);
  }
  return out;
}

function protect(buf) {
  if (initNative()) {
    try {
      return nativeCall(pCryptProtect, buf);
    } catch {
      /* 回退 */
    }
  }
  return psRun('protect', buf);
}

function unprotect(buf) {
  if (initNative()) {
    try {
      return nativeCall(pCryptUnprotect, buf);
    } catch {
      /* 回退 */
    }
  }
  return psRun('unprotect', buf);
}

module.exports = { protect, unprotect, nativeAvailable: initNative };
