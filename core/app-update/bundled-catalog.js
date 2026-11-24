'use strict';
// R29 审查 #1（2026-11-24）：外观包、桌宠形象、开场动画、PPT 识别组件的目录随程序自带快照。
// 只走内源时直接读快照、不去阿里云或 GitHub 读目录，也就不会弹放行窗；包本身照快照里的 sha256 从内源下载核对。
// 快照由 scripts/refresh-bundled-manifests.js 在发版时刷新。
const fs = require('node:fs');

const NAME = '公司内源';
// 读快照并按各组件自己的规则校验；返回和 checkManifests 一样的一行结果，调用方原有的「挑最高版本」逻辑不用改。
function bundledCatalog(file, validate) {
  try {
    const manifest = validate(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return { id: 'openx', name: NAME, ok: true, manifest };
  } catch (error) {
    return { id: 'openx', name: NAME, ok: false, reason: `这个版本没带上组件目录（${error.code === 'ENOENT' ? '找不到目录文件' : error.message}），升级 Hub 后再试；一直如此请点「一键反馈」` };
  }
}

// 只走内源时下载失败：取下载器给的人话原因（连不上 → 查公司网络；缺包 → 稍后再试）。其余情况返回空串。
function onlyFailReason(result) {
  if (!result || !result.openxOnly) return '';
  const a = (result.attempts || []).find(x => x && x.reason);
  return a ? a.reason : '';
}

module.exports = { bundledCatalog, onlyFailReason };
