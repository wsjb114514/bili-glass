'use strict';
/** 校验某个已安装/已打包的 app.asar 里是否包含全部修复 */
const fs = require('fs');
const path = require('path');

const target =
  process.argv[2] ||
  path.join(process.env.LOCALAPPDATA, 'Programs', 'bili-glass', 'resources', 'app.asar');

const checks = [
  ['登录态双向往返（客户端优先也会回退扫码）', 'tryClient, tryQr'],
  ['计划任务失败自动回退注册表', '已自动改用'],
  ['vip_label 对象正确处理', 'label_theme'],
  ['reg/schtasks 输出 GBK 正确解码', "TextDecoder('gbk')"],
  ['观看前置：播放器心跳模拟', 'simulateWatch'],
  ['Referer 防风控 412', '会被 WAF 判 412'],
  ['opaque 模式关闭原生亚克力（修圆角+拖拽迟滞）', 'opaque-frame'],
  ['自绘拖拽绕开系统拖拽模态循环', 'isLeftButtonDown'],
  ['光斑去掉 filter: blur（软件渲染重绘优化）', 'opaqueNoShadow'],
];

const buf = fs.readFileSync(target);
console.log('目标:', target);
console.log('大小:', (buf.length / 1048576).toFixed(1), 'MB');
console.log('修改时间:', fs.statSync(target).mtime.toLocaleString('zh-CN'));
console.log('');
let allOk = true;
for (const [name, needle] of checks) {
  const ok = buf.includes(Buffer.from(needle, 'utf8'));
  if (!ok) allOk = false;
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}
console.log('\n结论:', allOk ? '包含全部修复 ✅' : '缺少部分修复 ❌');
