'use strict';
// PPT Doctor 完整包地址解析（一键安装用）。浏览器手动下载（镜像 / GitHub 入口）已随下载源废弃删除（R35）。
const { DOWNLOAD_URL } = require('./ppt-doctor-protocol');
const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version);

function archiveUrl(manifest, base = DOWNLOAD_URL) {
  if (!validVersion(manifest?.version)) throw new Error('版本清单没有有效版本号');
  if (!Object.hasOwn(manifest, 'full')) return new URL(`PPT-Doctor-v${manifest.version}.zip`, base).href;
  const full = manifest.full;
  if (!full || typeof full !== 'object' || !validVersion(full.version) || typeof full.path !== 'string') throw new Error('完整安装包字段无效');
  // The publisher points full at the latest existing archive, or the retained
  // baseline when only delta blocks were uploaded. Never follow an external URL.
  if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9][a-z0-9._-]*\.zip$/i.test(full.path)) throw new Error('完整安装包路径必须是镜像目录内的相对ZIP路径');
  return new URL(full.path, base).href;
}

module.exports = { archiveUrl };
