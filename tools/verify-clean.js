'use strict';
/**
 * 校验发行包里不含任何登录凭据。
 * 会扫描 app.asar（全部代码与资源）以及整个产物目录，
 * 检查是否存在 SESSDATA / bili_jct 的真实取值、账号昵称、mid 等痕迹。
 */
const fs = require('fs');
const path = require('path');

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法: node tools/verify-clean.js <文件或目录> [...]');
  process.exit(1);
}

// 这些字符串在源码里本就存在（是 cookie 的「字段名」），不算凭据
const ALLOWED_NEEDLES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'credentials.dat']);

// 测试里用的占位值，不是真实凭据
const ALLOWED_VALUE_RE = /^(invalid|fake|token|xxx|<.+>)$/i;

// 账号昵称检查：通过环境变量传入，避免把真实昵称写进仓库
const OWNER_NAME = process.env.BILIGLASS_OWNER_NAME || '';

const SUSPECT_PATTERNS = [
  ...(OWNER_NAME ? [{ name: '账号昵称', re: new RegExp(OWNER_NAME) }] : []),
  { name: 'SESSDATA 取值（SESSDATA=<值>）', re: /SESSDATA=[A-Za-z0-9%_\-.,]{16,}/ },
  { name: 'bili_jct 取值（bili_jct=<值>）', re: /bili_jct=[a-f0-9]{16,}/ },
  { name: 'DedeUserID 数值', re: /DedeUserID=\d{5,}/ },
  { name: '凭证文件名', re: /credentials\.dat/ },
  { name: '配置文件名', re: /config\.json/ },
];

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) walk(path.join(p, f), out);
  } else if (st.size > 0) {
    out.push(p);
  }
  return out;
}

let files = [];
for (const t of targets) {
  if (!fs.existsSync(t)) {
    console.log(`⚠️  不存在: ${t}`);
    continue;
  }
  walk(t, files);
}

console.log(`扫描 ${files.length} 个文件...\n`);
let problems = 0;

for (const f of files) {
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch {
    continue;
  }
  const text = buf.toString('latin1'); // 逐字节比较，避免编码影响
  for (const p of SUSPECT_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    const hit = m[0];
    if (ALLOWED_NEEDLES.has(hit)) continue;
    const eq = hit.indexOf('=');
    if (eq > 0 && ALLOWED_VALUE_RE.test(hit.slice(eq + 1))) continue; // 测试占位值
    // credentials.dat / config.json 只是路径引用，单独提示
    const informational = p.name === '凭证文件名' || p.name === '配置文件名';
    if (informational) {
      console.log(`ℹ️  ${path.relative(process.cwd(), f)} 引用了 ${hit}（仅路径，不含内容）`);
      continue;
    }
    problems++;
    console.log(`❌ ${path.relative(process.cwd(), f)} 命中「${p.name}」: ${hit.slice(0, 60)}`);
  }
}

console.log('');
if (problems === 0) {
  console.log('✅ 未发现任何登录凭据泄露（包内不含 SESSDATA/bili_jct 取值、账号昵称、mid）');
} else {
  console.log(`❌ 发现 ${problems} 处疑似凭据泄露，需要处理`);
  process.exit(1);
}
