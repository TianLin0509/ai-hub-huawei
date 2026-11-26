#!/usr/bin/env node
'use strict';
// r60（2026-11-20）：刷新随程序发布的下载清单快照，发版时由 member-release.js 自动调用。
// 用途：Hub 只走公司内源，不去外网读组件目录和 PPT Doctor 清单；
// 有了快照就照快照去内源下，文件仍按快照里的 sha256 核对。
//   core/cli-tools/catalog-snapshot.json                     命令行组件目录（原样保存，带签名，Hub 用同一把公钥验签）
//   core/company-assistant/ppt-doctor-manifest-snapshot.json PPT Doctor 清单（只留版本与完整包字段，去掉逐文件列表）
//   core/company-assistant/ppt-materials-manifest-snapshot.json 团队素材包清单
// R29（2026-11-24）：只走内源的客户端不再去外网读目录，下面四类也随程序带快照（原样保存，客户端按各自规则校验）：
//   core/appearance-catalog-snapshot.json                    外观包目录
//   core/hub-pet/catalog-snapshot.json                       桌宠形象目录
//   core/boot-splash-catalog-snapshot.json                   开场动画目录
//   core/company-assistant/ppt-ocr-manifest-snapshot.json    PPT 识别组件清单（含逐文件 sha256，解压后要逐个核对）
// 读不到或校验不过就保留旧快照、不报错（快照旧一点只是装到稍旧的版本）。
// 2026-11-27：客户端代码不再写任何外网目录地址。发版机从本机配置读镜像根地址（不进仓库、不进安装包）：
//   环境变量 AI_HUB_RELEASE_MIRRORS（JSON 数组，或指向 JSON 文件的路径），否则 ~/.ai-hub-release/manifest-mirrors.json，
//   内容形如 { "bases": ["https://<主机>/"] }；没有配置就跳过对应快照，保留旧的。
// 用法：node scripts/refresh-bundled-manifests.js [--check]   --check 只报告是否需要刷新，不写文件。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI_FILE = 'core/cli-tools/catalog-snapshot.json';
const DOCTOR_FILE = 'core/company-assistant/ppt-doctor-manifest-snapshot.json';
const NL = String.fromCharCode(10);
const MATERIALS_FILE = 'core/company-assistant/ppt-materials-manifest-snapshot.json';
const APPEARANCE_FILE = 'core/appearance-catalog-snapshot.json';
const PET_FILE = 'core/hub-pet/catalog-snapshot.json';
const BOOT_SPLASH_FILE = 'core/boot-splash-catalog-snapshot.json';
const OCR_FILE = 'core/company-assistant/ppt-ocr-manifest-snapshot.json';

function releaseMirrors(env = process.env) {
  let raw = null;
  try {
    const v = String(env.AI_HUB_RELEASE_MIRRORS || '').trim();
    if (v) raw = v.startsWith('[') || v.startsWith('{') ? JSON.parse(v) : JSON.parse(fs.readFileSync(v, 'utf8'));
    else {
      const file = path.join(require('node:os').homedir(), '.ai-hub-release', 'manifest-mirrors.json');
      if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (_) { raw = null; }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.bases) ? raw.bases : [];
  return list.map(String).filter(u => /^https:\/\//i.test(u)).map(u => u.replace(/\/?$/, '/'));
}
const mirrorUrls = (rel, env) => releaseMirrors(env).map(base => new URL(rel, base).href);

async function getText(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).replace(/^\uFEFF/, '');
}

async function cliCatalog(root) {
  const catalog = require(path.join(root, 'core/cli-tools/catalog'));
  const edition = JSON.parse(fs.readFileSync(path.join(root, 'community-edition.json'), 'utf8'));
  let sources = catalog.catalogSources({ config: edition.update, env: {} });
  if (!sources.length) sources = mirrorUrls('hub-update/components/components.json').map((manifest, i) => ({ id: 'mirror-' + i, name: new URL(manifest).host, manifest }));
  if (!sources.length) return null;
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
  const urls = mirrorUrls('pptutor/manifest.json');
  if (!urls.length) return null;
  const { fullArchive } = require(path.join(root, 'core/company-assistant/ppt-doctor-install'));
  const errors = [];
  for (const url of urls) {
    try {
      const { files, ...rest } = JSON.parse(await getText(url));
      fullArchive(rest, url);
      return { file: DOCTOR_FILE, content: JSON.stringify(rest, null, 2) + '\n', label: `PPT Doctor 清单 ${rest.version}（完整包 ${rest.full && rest.full.version}）` };
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`PPT Doctor 清单读不到（${errors.join('；')}）`);
}

async function materialsManifest(root) {
  const { validTeamManifest } = require(path.join(root, 'core/company-assistant/ppt-materials'));
  const bases = mirrorUrls('pptutor/materials/');
  if (!bases.length) return null;
  const errors = [];
  for (const base of bases) {
    try {
      const raw = JSON.parse(await getText(new URL('component.json', base).href));
      if (!validTeamManifest(raw)) throw new Error('清单格式不对');
      return { file: MATERIALS_FILE, content: JSON.stringify(raw, null, 1) + NL, label: `团队素材包清单 ${raw.version}` };
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`团队素材包清单读不到（${errors.join('；')}）`);
}

const lf = t => { t = t.split(String.fromCharCode(13) + NL).join(NL); return t.endsWith(NL) ? t : t + NL; };
// 组件目录：逐个源读，校验通过的里面取版本最高的一份，原样保存。
// 客户端模块不再写外网目录地址（SOURCES 为空）；有 rel 时按发版机配置的镜像读，没有配置就跳过、保留旧快照。
async function componentCatalog(root, { mod, file, label, rel }) {
  const m = require(path.join(root, mod));
  const { compareVersions } = require(path.join(root, 'core/app-update/manifest'));
  const list = m.SOURCES && m.SOURCES.length ? m.SOURCES
    : rel ? mirrorUrls(rel).map(manifest => ({ name: new URL(manifest).host, manifest })) : [];
  if (!list.length) return null;
  let best = null, bestText = '';
  const errors = [];
  for (const s of list) {
    try {
      const text = await getText(s.manifest);
      const parsed = m.validateCatalog(JSON.parse(text));
      if (!best || compareVersions(parsed.version, best.version) > 0) { best = parsed; bestText = text; }
    } catch (error) { errors.push(`${s.name}：${error.message}`); }
  }
  if (!best) throw new Error(`${label}读不到（${errors.join('；')}）`);
  return { file, content: lf(bestText), label: `${label} ${best.version}` };
}
const appearanceCatalog = root => componentCatalog(root, { mod: 'core/appearance-packs', file: APPEARANCE_FILE, label: '外观包目录', rel: 'hub-update/appearance/catalog.json' });
const petCatalog = root => componentCatalog(root, { mod: 'core/hub-pet/role-packs', file: PET_FILE, label: '桌宠形象目录', rel: 'hub-update/hub-pet/catalog.json' });
const bootSplashCatalog = root => componentCatalog(root, { mod: 'core/boot-splash', file: BOOT_SPLASH_FILE, label: '开场动画目录' });

async function ocrManifest(root) {
  const { validManifest } = require(path.join(root, 'core/company-assistant/ppt-ocr-component'));
  const bases = mirrorUrls('pptutor/ocr/');
  if (!bases.length) return null;
  const errors = [];
  for (const base of bases) {
    try {
      const text = lf(await getText(new URL('component.json', base).href));
      const m = validManifest(JSON.parse(text));
      return { file: OCR_FILE, content: text, label: `PPT 识别组件清单 ${m.version}` };
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`PPT 识别组件清单读不到（${errors.join('；')}）`);
}

// 返回内容有变化的快照 [{ file, content, label }]；读不到的写进 warnings，不抛错。
async function fetchBundledManifests(root = ROOT) {
  const changed = [], warnings = [];
  for (const get of [cliCatalog, doctorManifest, materialsManifest, appearanceCatalog, petCatalog, bootSplashCatalog, ocrManifest]) {
    try {
      const item = await get(root);
      if (!item) continue;
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

module.exports = { fetchBundledManifests, writeBundled, releaseMirrors, CLI_FILE, DOCTOR_FILE, MATERIALS_FILE, APPEARANCE_FILE, PET_FILE, BOOT_SPLASH_FILE, OCR_FILE };

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
