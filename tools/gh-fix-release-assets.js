'use strict';
/**
 * 修正 Release 资源：GitHub 会剥掉资源名里的非 ASCII 字符
 * （"BiliGlass-1.0.0-安装版.exe" 会变成 "BiliGlass-1.0.0-.exe"，两个包名因此冲突），
 * 所以上传时统一用 ASCII 名，并在正文里说明对应关系。
 */
const fs = require('fs');
const path = require('path');

const token = fs.readFileSync(process.env.GH_TOKEN_FILE, 'utf8').trim();
const OWNER = process.env.GH_OWNER || 'wsjb114514';
const REPO = process.env.GH_REPO || 'bili-glass';
const TAG = process.env.GH_TAG || 'v1.0.0';

const H = { Authorization: 'Bearer ' + token, 'User-Agent': 'BiliGlass', Accept: 'application/vnd.github+json' };

const ASSETS = [
  {
    file: path.join(__dirname, '..', 'dist', 'BiliGlass-1.0.0-安装版.exe'),
    name: 'BiliGlass-1.0.0-setup.exe',
    label: '安装版（推荐）',
  },
  {
    file: path.join(__dirname, '..', 'dist', 'BiliGlass-1.0.0-便携版.exe'),
    name: 'BiliGlass-1.0.0-portable.exe',
    label: '便携版',
  },
];

const BODY = `## BiliGlass v1.0.0

开机自动拉起哔哩哔哩客户端 → 模拟观看视频 → 领取大会员每日 10 经验，全过程静默，跑完弹一张结果卡片。

### 下载哪个

| 文件 | 说明 |
| --- | --- |
| \`BiliGlass-1.0.0-setup.exe\` | **推荐（安装版）**。一键安装到用户目录，免管理员，启动约 2 秒 |
| \`BiliGlass-1.0.0-portable.exe\` | 免安装单文件（便携版）。⚠️ 每次启动要自解压约 500MB 到临时目录，本机实测约 28 秒，**不适合开机自启** |

> 资源名用 ASCII 是因为 GitHub 会剥掉资源文件名里的非 ASCII 字符，中文名会导致两个包重名冲突。

### 首次使用

1. 打开程序 → 点「扫码登录」→ 用手机哔哩哔哩 App 扫码
2. 看到账号卡显示昵称 + 大会员徽章即成功
3. 打开底部「开机自启」开关

之后每天开机自动执行。**发布包里不含任何账号凭据** —— 登录态是运行时用 Windows DPAPI 加密存在本机 \`%APPDATA%\\BiliGlass\` 的，换台电脑需要重新扫码。

### 实现要点

- **领取前置是「看视频」**：B站「观看视频」类任务靠播放器每 15 秒上报一次心跳累积，不是点一下按钮完成的。程序按真实播放器节奏走完 62 秒（开始播放 → 每 15s 上报进度 → 结束播放 → 写观看历史），再调领取接口。
- **登录态**：扫码登录态优先，客户端登录态兜底，**双向**自动回退（选「客户端优先」也会在失败时回退扫码），并会抓取 B 站返回的新 SESSDATA 自动续期。
- **防 412 风控**：\`x/web-interface/view\` 的 Referer 必须指向稿件页，用站点根域名会稳定 412（实测 4/4 复现）；所有接口按资源设置 Referer，并对 412/403 退避重试。
- **界面**：无边框透明窗 + 液态玻璃（SVG 位移折射、跟随鼠标的高光、噪点、氛围光斑），按 GPU 能力自动降级，首帧从 11s 优化到 1s。
- **修掉的两个体验问题**：opaque 模式下彻底关闭 \`SetWindowCompositionAttribute\`（它会填满窗口矩形盖掉 CSS 圆角，其模糊运算还正是 Win10 拖拽迟滞的元凶）；改用自绘拖拽绕开系统模态拖拽循环。

### 已知限制

- 仅在 Windows 10 (19045) + Electron 44 上实测。
- 使用 B 站**非官方接口**，接口变动可能导致失效。
- 每天只请求 1 次领取 + 一轮观看上报（约 5 次心跳），但仍存在理论风控风险，请自行评估。
- 哔哩哔哩 PC 客户端 1.17.6 把登录态加密存在自身配置里，不写网页 Cookie，所以「读客户端登录态」在该版本下通常取不到凭据，请以扫码登录为主。

仅供个人学习自用，请勿用于批量、多账号或其他违反 B 站用户协议的场景。
`;

async function api(pathname, init = {}) {
  const res = await fetch('https://api.github.com' + pathname, { headers: H, ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

(async () => {
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (rel.status !== 200) {
    console.log('❌ 找不到 Release:', rel.status);
    process.exit(1);
  }
  const release = rel.json;

  // 1) 清掉名称被破坏的旧资源
  for (const a of release.assets || []) {
    console.log(`删除旧资源: ${a.name}`);
    const d = await api(`/repos/${OWNER}/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
    console.log(d.status === 204 ? '  ✅ 已删除' : `  ⚠️ HTTP ${d.status}`);
  }

  // 2) 更新正文
  const patched = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: BODY }),
  });
  console.log(patched.status === 200 ? '✅ Release 正文已更新' : `⚠️ 正文更新 HTTP ${patched.status}`);

  // 3) 用 ASCII 名重新上传
  for (const a of ASSETS) {
    if (!fs.existsSync(a.file)) {
      console.log(`⚠️ 缺少文件: ${a.file}`);
      continue;
    }
    const size = fs.statSync(a.file).size;
    process.stdout.write(`上传 ${a.name}（${(size / 1048576).toFixed(1)} MB，${a.label}）... `);
    const t0 = Date.now();
    const url = release.upload_url.replace('{?name,label}', `?name=${encodeURIComponent(a.name)}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'User-Agent': 'BiliGlass',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
      body: fs.readFileSync(a.file),
      duplex: 'half',
    });
    const text = await res.text();
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (res.status === 201) {
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {}
      console.log(`✅ ${secs}s → 资源名 ${j ? j.name : '?'}`);
    } else {
      console.log(`❌ HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }

  const final = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  console.log('\n=== Release 最终状态 ===');
  console.log('页面:', final.json.html_url);
  for (const a of final.json.assets || []) {
    console.log(
      `  · ${a.name}  ${(a.size / 1048576).toFixed(1)} MB  下载链接 ${a.browser_download_url}`
    );
  }
})();
