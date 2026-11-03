'use strict';
const { DOWNLOAD_URL, GITHUB_DOWNLOAD_URL } = require('./ppt-doctor-protocol');
const { resolveFetch } = require('./fetch-util');
const { reasonOf } = require('../app-update/downloader');
const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version);

function archiveUrl(manifest) {
  if (!validVersion(manifest?.version)) throw new Error('版本清单没有有效版本号');
  if (!Object.hasOwn(manifest, 'full')) return new URL(`PPT-Doctor-v${manifest.version}.zip`, DOWNLOAD_URL).href;
  const full = manifest.full;
  if (!full || typeof full !== 'object' || !validVersion(full.version) || typeof full.path !== 'string') throw new Error('完整安装包字段无效');
  // The publisher points full at the latest existing archive, or the retained
  // baseline when only delta blocks were uploaded. Never follow an external URL.
  if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9][a-z0-9._-]*\.zip$/i.test(full.path)) throw new Error('完整安装包路径必须是镜像目录内的相对ZIP路径');
  return new URL(full.path, DOWNLOAD_URL).href;
}

async function downloadDoctor(source = 'mirror', deps = {}) {
  if (!['mirror', 'github'].includes(source)) throw new Error('请选择镜像下载或 GitHub 备用入口');
  let url = GITHUB_DOWNLOAD_URL;
  if (source === 'mirror') {
    const fetch = resolveFetch(deps.pptDownloadFetch), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(DOWNLOAD_URL, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`版本清单 HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('版本清单过大');
      const text = await response.text(); if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('版本清单过大');
      const manifest = JSON.parse(text.replace(/^\uFEFF/, ''));
      // Layout is owned by PPT Doctor tools/mirror_release.py. No arbitrary URL
      // from a remote JSON is passed to shell.openExternal.
      url = archiveUrl(manifest);
      const archive = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'error' });
      if (!archive.ok || /text\/html/i.test(archive.headers.get('content-type') || '')) throw new Error('对应版本的完整安装包暂不可用');
    } catch (error) { throw new Error('镜像下载暂不可用：' + reasonOf(error) + '。请稍后重试，或使用 GitHub 备用入口'); }
    finally { clearTimeout(timer); }
  }
  await (deps.pptOpenExternal || (target => require('electron').shell.openExternal(target)))(url);
  return { ok: true, source, url };
}
module.exports = { downloadDoctor };
