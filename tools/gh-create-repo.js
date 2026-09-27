'use strict';
/**
 * 通过 GitHub API 创建仓库并设置 topics。
 * Token 从环境变量 GH_TOKEN_FILE 指定的文件读取，绝不打印到输出里。
 */
const fs = require('fs');

const tokenFile = process.env.GH_TOKEN_FILE;
if (!tokenFile || !fs.existsSync(tokenFile)) {
  console.error('缺少 GH_TOKEN_FILE');
  process.exit(1);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const H = {
  Authorization: 'Bearer ' + token,
  'User-Agent': 'BiliGlass',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

const NAME = process.argv[2] || 'bili-glass';
const DESCRIPTION =
  process.argv[3] ||
  'B站大会员每日经验自动领取 · 开机自启 · 液态玻璃界面 | Auto-claim Bilibili VIP daily experience, liquid-glass Electron app for Windows';
const TOPICS = ['bilibili', 'electron', 'windows', 'liquid-glass', 'acrylic', 'automation', 'desktop-app'];

async function api(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, { headers: H, ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

(async () => {
  const me = await api('/user');
  if (me.status !== 200) {
    console.log('❌ 无法读取用户信息:', me.status, me.text.slice(0, 200));
    process.exit(1);
  }
  const owner = me.json.login;

  const exist = await api(`/repos/${owner}/${NAME}`);
  if (exist.status === 200) {
    console.log(`ℹ️  仓库已存在: ${exist.json.html_url}`);
  } else {
    const created = await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: NAME,
        description: DESCRIPTION,
        private: false,
        has_issues: true,
        has_projects: false,
        has_wiki: false,
        auto_init: false,
      }),
    });
    if (created.status !== 201) {
      console.log('❌ 创建仓库失败:', created.status, created.text.slice(0, 300));
      process.exit(1);
    }
    console.log(`✅ 仓库已创建: ${created.json.html_url}`);
    console.log(`   可见性: ${created.json.private ? '私有' : '公开'}`);
  }

  const t = await api(`/repos/${owner}/${NAME}/topics`, {
    method: 'PUT',
    body: JSON.stringify({ names: TOPICS }),
  });
  if (t.status === 200) console.log('✅ topics 已设置:', (t.json.names || []).join(', '));
  else console.log('⚠️  topics 设置返回', t.status, t.text.slice(0, 150));

  console.log('\nREMOTE_URL=https://github.com/' + owner + '/' + NAME + '.git');
  console.log('OWNER=' + owner);
})();
