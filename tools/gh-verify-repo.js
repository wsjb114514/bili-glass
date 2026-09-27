'use strict';
/** 从 GitHub API 侧核对远程仓库内容与安全性 */
const fs = require('fs');
const token = fs.readFileSync(process.env.GH_TOKEN_FILE, 'utf8').trim();
const H = { Authorization: 'Bearer ' + token, 'User-Agent': 'BiliGlass', Accept: 'application/vnd.github+json' };

const OWNER = process.env.GH_OWNER || 'wsjb114514';
const REPO = process.env.GH_REPO || 'bili-glass';

async function api(path) {
  const res = await fetch('https://api.github.com' + path, { headers: H });
  return { status: res.status, json: await res.json().catch(() => null) };
}

(async () => {
  const repo = await api(`/repos/${OWNER}/${REPO}`);
  if (repo.status !== 200) {
    console.log('❌ 仓库不可访问:', repo.status);
    process.exit(1);
  }
  const r = repo.json;
  console.log('仓库:', r.full_name);
  console.log('可见性:', r.private ? '私有' : '公开');
  console.log('默认分支:', r.default_branch);
  console.log('大小:', r.size, 'KB');
  console.log('描述:', r.description);
  console.log('话题:', (r.topics || []).join(', '));
  console.log('许可:', r.license ? r.license.spdx_id : '未识别');
  console.log('主页:', r.html_url);

  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/${r.default_branch}?recursive=1`);
  const files = (tree.json.tree || []).filter((f) => f.type === 'blob');
  console.log(`\n文件数: ${files.length}`);
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  console.log(`总体积: ${(total / 1024).toFixed(0)} KB`);

  // 安全检查
  const bad = files.filter((f) =>
    /(^|\/)(node_modules|dist|artifacts)\//.test(f.path) ||
    /(^|\/)(config\.json|credentials\.dat|\.env)$/.test(f.path) ||
    /\.log$/.test(f.path) ||
    /\.exe$/.test(f.path)
  );
  console.log('\n=== 不应入库的文件 ===');
  if (bad.length) bad.forEach((f) => console.log('  ❌', f.path));
  else console.log('  ✅ 没有 node_modules / dist / exe / 配置 / 凭据 / 日志');

  console.log('\n=== 顶层结构 ===');
  const top = [...new Set(files.map((f) => f.path.split('/')[0]))].sort();
  console.log('  ' + top.join('  '));

  console.log('\n=== 仓库地址 ===');
  console.log('  ' + r.html_url);
  console.log('  clone: ' + r.clone_url);
})();
