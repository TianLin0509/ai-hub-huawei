'use strict';
// r58：不依赖运行中实例的下载点，在这里统一登记「内源上找什么」（见 core/app-update/download-points.js）。
// 每一项的文件名与内源版本名，和该组件真正下载时传给 downloadWithFallback 的一致（行号写在注释里，改下载时一起改）。
const points = require('../core/app-update/download-points');

function gatedFetch(fetchImpl) {
  const base = typeof fetchImpl === 'function' ? fetchImpl : (...args) => require('electron').net.fetch(...args);
  try { return require('../core/own-gate').gatedFetch(base); } catch (_) { return base; }
}

function registerStaticDownloadPoints({ fetchImpl } = {}) {
  // 本来就走公司内部渠道的两项：界面照样显示来源，方便核对没有遗漏。
  points.register('codeagent', async () => ({ internal: 'CodeAgent 官方渠道' }));          // main/ipc/codeagent-install-handlers.js
  points.register('welink', async () => ({ internal: '公司内部 npm 源' }));                 // core/company-assistant/welink-install.js
  // 会议室组件：room-runtime-download.js ensure()，release room-runtime-<baseline 版本>，文件 baseline.exe.file。签名清单在本地，不联网。
  points.register('room-runtime', async () => {
    const { baseline } = require('../core/company-assistant/room-component').bundledRuntime();
    return { items: [{ file: baseline.exe.file, release: `room-runtime-${baseline.version}`, version: baseline.version }] };
  });
  // 会议本地转写包：meeting-asr.js installPack()，release meeting-asr-<包版本>，每个分片单独查。
  points.register('meeting-asr', async () => {
    const pack = require('../core/company-assistant/meeting-speech-pack.json');
    const items = [];
    for (const f of pack.files || []) for (const part of (f.parts && f.parts.length ? f.parts : [{ file: f.name }])) {
      items.push({ file: part.file, release: `meeting-asr-${pack.version}`, version: pack.version });
    }
    return { items };
  });
  // PPT Doctor 完整包：ppt-doctor-install.js perform()，release ppt-doctor-<完整包版本>，文件 = 清单里完整包地址的文件名。
  // 内源生效时和安装时一样只用程序自带的清单快照，不去外网读清单（R29/R35）；内源不生效（测试）时读给定清单地址。
  points.register('ppt-doctor', async () => {
    const { MIRROR_MANIFEST_URLS } = require('../core/company-assistant/ppt-doctor-protocol');
    const { fullArchive, bundledDoctorManifest } = require('../core/company-assistant/ppt-doctor-install');
    const spec = (manifest, base) => {
      const meta = fullArchive(manifest, base);
      const file = require('node:path').posix.basename(new URL(meta.url).pathname);
      return { items: [{ file, release: `ppt-doctor-${meta.version}`, version: meta.version }] };
    };
    if (require('../core/app-update/openx-source').active(process.env)) {
      const snap = bundledDoctorManifest();
      if (!snap) throw new Error('程序自带的 PPT Doctor 清单缺失');
      return spec(snap, MIRROR_MANIFEST_URLS[0]);
    }
    const fetch = gatedFetch(fetchImpl);
    let last = null;
    for (const base of MIRROR_MANIFEST_URLS) {
      try {
        const res = await fetch(base, { signal: AbortSignal.timeout(12000), redirect: 'error' });
        if (!res.ok) throw new Error(`清单 HTTP ${res.status}`);
        return spec(JSON.parse(String(await res.text()).replace(/^\uFEFF/, '')), base);
      } catch (error) { last = error; }
    }
    throw last || new Error('PPT Doctor 清单读不到');
  });
  // PPT 识别组件：ppt-ocr-component.js perform()，release ocr-<版本>，文件 pptdoctor-ocr-<版本>.zip。
  points.register('ppt-ocr', async () => {
    const ocr = require('../core/company-assistant/ppt-ocr-component');
    const { manifest } = await ocr.fetchManifest(gatedFetch(fetchImpl), {});
    return { items: [{ file: ocr.openxFile(manifest.version), release: `ocr-${manifest.version}`, version: manifest.version }] };
  });
  // 团队素材包：ppt-materials.js teamPackFromOpenx()，release ppt-materials-<版本>，文件 pptutor-materials-<版本>.zip。
  points.register('ppt-materials', async () => {
    const { teamPackManifest } = require('../core/company-assistant/ppt-materials');
    const { manifest } = await teamPackManifest({});
    return { items: [{ file: `pptutor-materials-${manifest.version}.zip`, release: `ppt-materials-${manifest.version}`, version: manifest.version }] };
  });
}

module.exports = { registerStaticDownloadPoints };
