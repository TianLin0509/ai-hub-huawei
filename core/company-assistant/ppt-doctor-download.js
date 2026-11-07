'use strict';
const { DOWNLOAD_URL, MIRROR_MANIFEST_URLS, GITHUB_DOWNLOAD_URL } = require('./ppt-doctor-protocol');
const { resolveFetch } = require('./fetch-util');
const { reasonOf } = require('../app-update/downloader');
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

async function downloadDoctor(source = 'mirror', deps = {}) {
  if (!['mirror', 'github'].includes(source)) throw new Error('请选择镜像下载或 GitHub 备用入口');
  let url = GITHUB_DOWNLOAD_URL;
  if (source === 'mirror') {
    const fetch = resolveFetch(deps.pptDownloadFetch);
    const bases = deps.pptMirrorUrls || MIRROR_MANIFEST_URLS;
    const reasons = [];
    url = null;
    // 高速镜像排第一；读不到、或清单里那一版的安装包还没同步到，就换下一个镜像。
    for (const base of bases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(base, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error(`版本清单 HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('版本清单过大');
        const text = await response.text(); if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('版本清单过大');
        const manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
        // Layout is owned by PPT Doctor tools/mirror_release.py. No arbitrary URL
        // from a remote JSON is passed to shell.openExternal.
        const candidate = archiveUrl(manifest, base);
        const archive = await fetch(candidate, { method: 'HEAD', signal: controller.signal, redirect: 'error' });
        if (!archive.ok || /text\/html/i.test(archive.headers.get('content-type') || '')) throw new Error('对应版本的完整安装包暂不可用');
        url = candidate;
        break;
      } catch (error) { reasons.push(reasonOf(error)); }
      finally { clearTimeout(timer); }
    }
    if (!url) throw new Error('镜像下载暂不可用：' + (reasons[reasons.length - 1] || '未知原因') + '。请稍后重试，或使用 GitHub 备用入口');
  }
  await (deps.pptOpenExternal || (target => require('electron').shell.openExternal(target)))(url);
  return { ok: true, source, url };
}
module.exports = { downloadDoctor };
