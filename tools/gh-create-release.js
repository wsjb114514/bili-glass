'use strict';
/** 创建 GitHub Release 并上传构建产物 */
const fs = require('fs');
const path = require('path');

const token = fs.readFileSync(process.env.GH_TOKEN_FILE, 'utf8').trim();
const OWNER = process.env.GH_OWNER || 'wsjb114514';
const REPO = process.env.GH_REPO || 'bili-glass';
const TAG = process.env.GH_TAG || 'v1.0.0';

const H = { Authorization: 'Bearer ' + token, 'User-Agent': 'BiliGlass', Accept: 'application/vnd.github+json' };

const BODY = `## BiliGlass v1.0.0

开机自动拉起哔哩哔哩客户端 → 模拟观看视频 → 领取大会员每日 10 经验。**本版新增：开机先检测，已领取就直接退出进程；可自定义观看哪个视频。**

### 本版新增

**① 开机先检测，已领取就直接退出**

开机后先向服务端确认「今天这 10 经验领了没」，而不是无脑跑整套流程：

| 预检结果 | 行为 |
| --- | --- |
| \`69198\` 已领取 | **立刻退出进程**：不拉起客户端、不看视频、不弹窗 |
| \`0\` 领取成功 | 这次不需要观看前置，直接记成功并弹结果卡片 |
| \`235004\` 被限流 | 回退用本地记录判断，本程序今天领过就同样直接退出 |
| 其他 | 继续执行：拉起客户端 → 观看 62 秒 → 领取 |

本机实测：已领取时整轮 **0.3 秒**结束（原先 63.8 秒）。

**② 自定义观看哪个视频**

设置里粘贴下面任意一种都能识别：

| 粘贴内容 | 识别方式 |
| --- | --- |
| \`BV1GJ411x7h7\` | 直接取 BV 号（前后带其它文字也能认出） |
| \`av2\` | 转 avid 查询 |
| \`https://b23.tv/xxxxx\` | 手机 App 分享短链，自动跟跳转解析 |
| 完整视频页链接 | 直接取 BV 号 |

点「解析」会显示解析到的标题和时长供确认；点「随机」恢复自动从排行榜挑。指定稿件被删会自动回退。

### 下载哪个

| 文件 | 说明 |
| --- | --- |
| \`BiliGlass-1.1.0-setup.exe\` | **推荐（安装版）**。一键安装到用户目录，免管理员，启动约 2 秒 |
| \`BiliGlass-1.1.0-portable.exe\` | 免安装单文件（便携版）。⚠️ 每次启动要自解压约 500MB，实测约 28 秒，**不适合开机自启** |

> 资源名用 ASCII 是因为 GitHub 会剥掉资源文件名里的非 ASCII 字符，中文名会导致两个包重名冲突。

### 首次使用

1. 打开程序 → 点「扫码登录」→ 用手机哔哩哔哩 App 扫码
2. 看到账号卡显示昵称 + 大会员徽章即成功
3. 打开底部「开机自启」开关

**发布包里不含任何账号凭据** —— 登录态是运行时用 Windows DPAPI 加密存在本机 \`%APPDATA%\\BiliGlass\` 的，换台电脑需要重新扫码。

### 修复

- 新增 B 站限流返回码 \`235004\` 的识别（与 \`6034007\` 不同）
- 最终领取被限流时等 30 秒自动重试一次，避免整轮白跑

### 已知限制

- 仅在 Windows 10 (19045) + Electron 44 上实测。
- 使用 B 站**非官方接口**，接口变动可能导致失效。
- 每天只请求 1 次检测 + 1 次领取 + 一轮观看上报（约 5 次心跳），仍有理论风控风险，请自行评估。
- 哔哩哔哩 PC 客户端 1.17.6 把登录态加密存在自身配置里，不写网页 Cookie，所以「读客户端登录态」在该版本下通常取不到凭据，请以扫码登录为主。

仅供个人学习自用，请勿用于批量、多账号或其他违反 B 站用户协议的场景。
`;

async function api(pathname, init = {}) {
  const res = await fetch('https://api.github.com' + pathname, { headers: H, ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

async function uploadAsset(uploadUrl, file, assetName) {
  const name = assetName || path.basename(file);
  const size = fs.statSync(file).size;
  const url = uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(name)}`);
  process.stdout.write(`上传 ${name}（${(size / 1048576).toFixed(1)} MB）... `);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'BiliGlass',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: fs.readFileSync(file),
    duplex: 'half',
  });
  const text = await res.text();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status === 201) {
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    console.log(`✅ ${secs}s  ${j ? (j.size / 1048576).toFixed(1) + ' MB' : ''}`);
    return true;
  }
  console.log(`❌ HTTP ${res.status} ${text.slice(0, 200)}`);
  return false;
}

(async () => {
  const root = path.join(__dirname, '..');
  const distDir = path.join(root, 'dist');

  // 自动识别产物，不硬编码版本号。
  // GitHub 会剥掉资源名里的非 ASCII 字符（中文名会互相冲突），所以上传时改成 ASCII 名。
  const version = require(path.join(root, 'package.json')).version;
  const found = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((f) => f.endsWith('.exe')) : [];
  const assets = found
    .map((f) => {
      const src = path.join(distDir, f);
      const isSetup = /安装版/.test(f);
      const isPortable = /便携版/.test(f);
      if (!isSetup && !isPortable) return null;
      return { src, name: isSetup ? `BiliGlass-${version}-setup.exe` : `BiliGlass-${version}-portable.exe` };
    })
    .filter(Boolean);

  console.log(`版本: ${version}`);
  console.log('待上传产物:', assets.map((a) => `${path.basename(a.src)} → ${a.name}`).join(', ') || '(无)');

  const exist = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  let release = exist.status === 200 ? exist.json : null;
  if (release) {
    console.log('ℹ️  Release 已存在:', release.html_url);
  } else {
    const created = await api(`/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: TAG, name: `BiliGlass ${TAG}`, body: BODY, draft: false, prerelease: false }),
    });
    if (created.status !== 201) {
      console.log('❌ 创建 Release 失败:', created.status, created.text.slice(0, 300));
      process.exit(1);
    }
    release = created.json;
    console.log('✅ Release 已创建:', release.html_url);
  }

  const existing = new Set((release.assets || []).map((a) => a.name));
  for (const a of assets) {
    if (existing.has(a.name)) {
      console.log(`ℹ️  已存在同名资源，跳过: ${a.name}`);
      continue;
    }
    await uploadAsset(release.upload_url, a.src, a.name);
  }

  const final = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  console.log('\n=== Release 最终状态 ===');
  console.log('页面:', final.json.html_url);
  for (const a of final.json.assets || []) {
    console.log(`  · ${a.name}  ${(a.size / 1048576).toFixed(1)} MB  下载 ${a.download_count} 次`);
  }
})();
