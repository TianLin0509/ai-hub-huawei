#!/usr/bin/env node
'use strict';
// r60（2026-11-20）：刷新随程序发布的下载清单快照，发版时由 member-release.js 自动调用。
// 用途：公司网络把阿里云整个拦掉时（403 / 确认页），Hub 读不到组件目录和 PPT Doctor 清单，内源上明明有包也装不了；
// 有了快照就照快照去内源下，文件仍按快照里的 sha256 核对。
//   core/cli-tools/catalog-snapshot.json                     命令行组件目录（原样保存，带签名，Hub 用同一把公钥验签）
//   core/company-assistant/ppt-doctor-manifest-snapshot.json PPT Doctor 清单（只留版本与完整包字段，去掉逐文件列表）
//   core/company-assistant/ppt-materials-manifest-snapshot.json 团队素材包清单（r60b：阿里云被拦时 GitHub 上只有旧版清单）
// 读不到或校验不过就保留旧快照、不报错（快照旧一点只是装到稍旧的版本）。
// 用法：node scripts/refresh-bundled-manifests.js [--check]   --check 只报告是否需要刷新，不写文件。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI_FILE = 'core/cli-tools/catalog-snapshot.json';
const DOCTOR_FILE = 'core/company-assistant/ppt-doctor-manifest-snapshot.json';
const NL = String.fromCharCode(10);
const MATERIALS_FILE = 'core/company-assistant/ppt-materials-manifest-snapshot.json';

async function getText(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).replace(/^\uFEFF/, '');
}

async function cliCatalog(root) {
  const catalog = require(path.join(root, 'core/cli-tools/catalog'));
  const edition = JSON.parse(fs.readFileSync(path.join(root, 'community-edition.json'), 'utf8'));
  const sources = catalog.catalogSources({ config: edition.update, env: {} });
  let best = null, bestText = '';
  const errors = [];
  for (const s of sources) {
    try {
      const text = await getText(s.manifest);
      const raw = JSON.parse(text);
      catalog.validateCatalog(raw);
      if (!best || (Date.parse(raw.publishedAt) || 0) > (Date.parse(best.publishedAt) || 0)) { best = raw; bestText = text; }
    } catch (error) { errors.push(`${s.name}：${error.message}`); }
  }
  if (!best) throw new Error(`组件目录读不到（${errors.join('；') || '没有配置下载源'}）`);
  return { file: CLI_FILE, content: bestText.endsWith('\n') ? bestText : bestText + '\n', label: `命令行组件目录 ${best.publishedAt}` };
}

async function doctorManifest(root) {
  const { MIRROR_MANIFEST_URLS } = require(path.join(root, 'core/company-assistant/ppt-doctor-protocol'));
  const { fullArchive } = require(path.join(root, 'core/company-assistant/ppt-doctor-install'));
  const errors = [];
  for (const url of MIRROR_MANIFEST_URLS) {
    try {
      const { files, ...rest } = JSON.parse(await getText(url));
      fullArchive(rest, url);
      return { file: DOCTOR_FILE, content: JSON.stringify(rest, null, 2) + '\n', label: `PPT Doctor 清单 ${rest.version}（完整包 ${rest.full && rest.full.version}）` };
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`PPT Doctor 清单读不到（${errors.join('；')}）`);
}

async function materialsManifest(root) {
  const { packSources, validTeamManifest } = require(path.join(root, 'core/company-assistant/ppt-materials'));
  const errors = [];
  // 只读阿里云的两个地址（GitHub 上的是旧版清单，不能拿来刷新快照）。
  for (const base of packSources({ openx: false }).filter(u => !u.includes('github.com'))) {
    try {
      const raw = JSON.parse(await getText(new URL('component.json', base).href));
      if (!validTeamManifest(raw)) throw new Error('清单格式不对');
      return { file: MATERIALS_FILE, content: JSON.stringify(raw, null, 1) + NL, label: `团队素材包清单 ${raw.version}` };
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`团队素材包清单读不到（${errors.join('；')}）`);
}

// 返回内容有变化的快照 [{ file, content, label }]；读不到的写进 warnings，不抛错。
async function fetchBundledManifests(root = ROOT) {
  const changed = [], warnings = [];
  for (const get of [cliCatalog, doctorManifest, materialsManifest]) {
    try {
      const item = await get(root);
      let old = '';
      try { old = fs.readFileSync(path.join(root, item.file), 'utf8').replace(/\r\n/g, '\n'); } catch (_) {}
      if (old !== item.content) changed.push(item);
    } catch (error) { warnings.push(error.message); }
  }
  return { changed, warnings };
}

function writeBundled(root, changed) {
  for (const item of changed) fs.writeFileSync(path.join(root, item.file), item.content, 'utf8');
}

module.exports = { fetchBundledManifests, writeBundled, CLI_FILE, DOCTOR_FILE, MATERIALS_FILE };

if (require.main === module) {
  (async () => {
    const { changed, warnings } = await fetchBundledManifests();
    for (const w of warnings) console.log('⚠ ' + w + '（保留旧快照）');
    if (!changed.length) { console.log('清单快照已是最新'); return; }
    if (process.argv.includes('--check')) { console.log('需要刷新：' + changed.map(c => c.label).join('、')); return; }
    writeBundled(ROOT, changed);
    console.log('已刷新：' + changed.map(c => c.label).join('、'));
  })().catch(error => { console.error(error.message); process.exit(1); });
}
