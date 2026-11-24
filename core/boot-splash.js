'use strict';
// 开场动画（2026-11-22）：默认播 Hub 群星；随包带群星·星座和 Claude / Codex / DeepSeek 各一套（18 号「掌心魔法阵」）；
// 其余 61 套做成资源包按需下载。下载机制照抄桌宠形象包（core/hub-pet/role-packs.js）：catalog.json + <id>-<version>.json，
// 逐个核对字节数与 SHA-256，内源优先多源依次尝试；只在用户点「下载」时联网；失败不影响正在用的开场动画。
// 包只是数据：一张 webp 图写到 <数据目录>/boot-splash/packs/<id>/image.webp，不执行、不解析任何别的内容。
// 原作视频（anim=video，2026-11-22）：目录条目直接是 <id>-<版本>.mp4，核对字节数与 SHA-256 后原样放到 packs/<id>/intro.mp4（不转码不剪辑，
// 原作授权 CC BY-NC-ND 4.0 要求原样分发并署名，署名写在离线清单 index.json 的 credit 里）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { checkManifests, downloadWithFallback } = require('./app-update/downloader');
const { boundedCatalogFetch, compareVersion } = require('./appearance-packs');

const MAX_PACK_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 640 * 1024;
const MAX_VIDEO_BYTES = 96 * 1024 * 1024;
const ID = /^(?:claude|codex|deepseek|galaxy)-[a-z0-9]{2,20}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const WHO = new Set(['claude', 'codex', 'deepseek', 'hub']);
const ANIM = new Set(['soft', 'rush', 'galaxy', 'video']);
const WEATHER = new Set(['snow', 'rain', 'bokeh', 'dust', 'petals', 'sparks', 'stars', 'fireflies', 'embers']);
const FREQUENCIES = Object.freeze(['daily', 'always', 'off']);
const DEFAULT_ID = 'galaxy-constellation';
const DEFAULT_PREFERENCES = Object.freeze({ selected: DEFAULT_ID, frequency: 'daily' });
// 2026-11-22 2.0.0 起目录里有 mp4 视频包，v5.6.79 及更早版本的校验会整份拒收 → 新目录改名 catalog-v2.json，旧 catalog.json 留给老版本。
const SOURCES = Object.freeze([
  { id: 'aliyun-fast', name: '阿里云高速', manifest: 'https://dl.lt-stockpartner.tech/hub-update/boot-splash/catalog-v2.json', files: 'https://dl.lt-stockpartner.tech/hub-update/boot-splash/' },
  { id: 'github', name: 'GitHub', manifest: 'https://github.com/TianLin0509/ai-hub-huawei/releases/download/boot-splash-v1/catalog-v2.json', files: 'https://github.com/TianLin0509/ai-hub-huawei/releases/download/boot-splash-v1/' },
  { id: 'aliyun', name: '阿里云', manifest: 'https://me.lt-stockpartner.tech/hub-update/boot-splash/catalog-v2.json', files: 'https://me.lt-stockpartner.tech/hub-update/boot-splash/' },
]);

function isWebp(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}
function isMp4(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); return b.toString('ascii', 4, 8) === 'ftyp'; } finally { fs.closeSync(fd); }
}
function decodeWebp(value) {
  const m = typeof value === 'string' && /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length <= MAX_IMAGE_BYTES && isWebp(buf) ? buf : null;
}
function fields(raw, what) {
  if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error(`${what}的标识或版本无效`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 40) throw new Error(`${what}的名称无效`);
  if (!WHO.has(raw.who) || !ANIM.has(raw.anim) || !WEATHER.has(raw.weather)) throw new Error(`${what}的角色、动画或天气无效`);
  return { id: raw.id, version: raw.version, name: raw.name, who: raw.who, anim: raw.anim, weather: raw.weather };
}
function validatePack(raw) {
  if (!raw || raw.schema !== 1) throw new Error('开场动画包格式无效');
  const pack = fields(raw, '开场动画包');
  const image = decodeWebp(raw.image);
  if (!image) throw new Error('开场动画包的图片缺失或格式无效');
  return { ...pack, image };
}
function validateCatalog(raw) {
  if (!raw || raw.schema !== 1 || typeof raw.version !== 'string' || !VERSION.test(raw.version) || !Array.isArray(raw.packs) || raw.packs.length > 200) throw new Error('开场动画目录格式无效');
  const ids = new Set();
  const packs = raw.packs.map(p => {
    const f = fields(p, '开场动画目录条目');
    const video = f.anim === 'video';
    if (ids.has(f.id) || p.file !== `${f.id}-${f.version}.${video ? 'mp4' : 'json'}` || !Number.isSafeInteger(p.bytes) || p.bytes < 1
      || p.bytes > (video ? MAX_VIDEO_BYTES : MAX_PACK_BYTES) || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('开场动画目录条目无效');
    ids.add(f.id);
    return { ...f, file: p.file, bytes: p.bytes, sha256: p.sha256 };
  });
  return { schema: 1, version: raw.version, packs };
}
function readJson(file) {
  if (fs.statSync(file).size > MAX_PACK_BYTES * 2) throw new Error('文件超过允许大小');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function localDay(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createBootSplashStore({ dataDir, assetsDir = path.join(__dirname, '..', 'renderer', 'assets', 'boot-splash'), sources = SOURCES,
  fetchImpl = globalThis.fetch, emit = () => {}, now = () => Date.now(), catalogBodyTimeoutMs = 12000,
  snapshotFile = path.join(__dirname, 'boot-splash-catalog-snapshot.json'), env = process.env } = {}) {
  const root = path.join(dataDir, 'boot-splash');
  const prefsFile = path.join(root, 'preferences.json');
  const catalogFile = path.join(root, 'catalog.json');
  const packsDir = path.join(root, 'packs');
  const index = JSON.parse(fs.readFileSync(path.join(assetsDir, 'index.json'), 'utf8')).items;
  let catalog = null;
  try { catalog = validateCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8'))); } catch (_) {}
  let state = { phase: 'idle', activeId: null, failedId: null, error: null, progress: null, attempts: [], checks: [], sources: sources.map(({ id, name }) => ({ id, name })) };
  let checking = null, downloading = null, abort = null;

  function notify(patch) { state = { ...state, ...patch }; emit('boot-splash:state', { ...state }); }
  function preferences() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) || {}; } catch (_) {}
    return {
      selected: typeof saved.selected === 'string' && ID.test(saved.selected) ? saved.selected : DEFAULT_ID,
      frequency: FREQUENCIES.includes(saved.frequency) ? saved.frequency : DEFAULT_PREFERENCES.frequency,
      lastPlayedDay: typeof saved.lastPlayedDay === 'string' ? saved.lastPlayedDay : '',
      hintSeen: !!saved.hintSeen,
    };
  }
  function writePrefs(next) { atomicJson(prefsFile, next); return next; }
  function installedInfo(id) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(packsDir, id, 'pack.json'), 'utf8'));
      const image = path.join(packsDir, id, info.anim === 'video' ? 'intro.mp4' : 'image.webp');
      if (info.id !== id || !fs.existsSync(image)) return null;
      return { ...info, image };
    } catch (_) { return null; }
  }
  // 每一套的当前状态：内置 / 已下载 / 可下载（目录里有或离线清单里有）。缩略图都随包带着，不联网也能浏览。
  function items() {
    return index.map(base => {
      const installed = base.bundled ? null : installedInfo(base.id);
      const entry = catalog?.packs.find(p => p.id === base.id) || null;
      const src = base.bundled ? `assets/boot-splash/${base.id}.webp` : installed ? pathToFileURL(installed.image).href + '?v=' + encodeURIComponent(installed.version) : null;
      return {
        ...base, thumb: `assets/boot-splash/thumbs/${base.id}.webp`, src, installed: !!(base.bundled || installed),
        version: installed?.version || null, bytes: entry?.bytes || null,
        update: !!(installed && entry && compareVersion(entry.version, installed.version) > 0),
      };
    });
  }
  function snapshot() {
    const { lastPlayedDay, ...prefs } = preferences();
    return { preferences: prefs, items: items(), catalog, state: { ...state } };
  }
  function playable(id) {
    const item = items().find(i => i.id === id);
    return item && item.src ? item : null;
  }
  // 启动时问一次：该不该播、播哪一套。选中的那套被删了就退回默认群星。每天第一次播放才记日期。
  function startup() {
    const prefs = preferences();
    if (prefs.frequency === 'off') return null;
    const today = localDay(now());
    if (prefs.frequency === 'daily' && prefs.lastPlayedDay === today) return null;
    writePrefs({ ...prefs, lastPlayedDay: today });
    const item = playable(prefs.selected) || playable(DEFAULT_ID);
    return item ? { ...item, showHint: true, firstHint: !prefs.hintSeen } : null;
  }
  function savePreferences(input = {}) {
    const prefs = preferences();
    const next = { ...prefs };
    if (input.selected !== undefined) {
      if (!playable(String(input.selected))) throw new Error('这一套开场动画还没下载，下载后再使用');
      next.selected = String(input.selected);
    }
    if (input.frequency !== undefined) {
      if (!FREQUENCIES.includes(input.frequency)) throw new Error('播放频率无效');
      next.frequency = input.frequency;
    }
    if (input.hintSeen) next.hintSeen = true;
    writePrefs(next);
    const snap = snapshot();
    emit('boot-splash:changed', snap);
    return snap;
  }

  // 原作视频：下载器已按目录核过字节数与 SHA-256，这里只认 mp4 文件头，然后整个文件原样搬进去。
  function installVideo(file, entry) {
    if (!isMp4(file)) throw new Error('开场视频格式无效');
    fs.mkdirSync(packsDir, { recursive: true });
    const temp = path.join(packsDir, `.tmp-${entry.id}-${crypto.randomUUID()}`);
    fs.mkdirSync(temp);
    try {
      fs.renameSync(file, path.join(temp, 'intro.mp4'));
      fs.writeFileSync(path.join(temp, 'pack.json'), JSON.stringify({ id: entry.id, version: entry.version, name: entry.name, who: entry.who, anim: 'video', weather: entry.weather, installedAt: now() }));
      const dest = path.join(packsDir, entry.id);
      let old = null;
      if (fs.existsSync(dest)) { old = path.join(packsDir, `.old-${entry.id}-${crypto.randomUUID()}`); fs.renameSync(dest, old); }
      try { fs.renameSync(temp, dest); } catch (error) { if (old) fs.renameSync(old, dest); throw error; }
      if (old) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (_) {} }
    } finally {
      if (fs.existsSync(temp)) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {} }
    }
    return { id: entry.id, version: entry.version };
  }

  function install(raw, expected) {
    const pack = validatePack(raw);
    if (expected && (pack.id !== expected.id || pack.version !== expected.version)) throw new Error('开场动画包与目录不一致');
    fs.mkdirSync(packsDir, { recursive: true });
    const temp = path.join(packsDir, `.tmp-${pack.id}-${crypto.randomUUID()}`);
    fs.mkdirSync(temp);
    try {
      fs.writeFileSync(path.join(temp, 'image.webp'), pack.image);
      fs.writeFileSync(path.join(temp, 'pack.json'), JSON.stringify({ id: pack.id, version: pack.version, name: pack.name, who: pack.who, anim: pack.anim, weather: pack.weather, installedAt: now() }));
      const dest = path.join(packsDir, pack.id);
      let old = null;
      if (fs.existsSync(dest)) { old = path.join(packsDir, `.old-${pack.id}-${crypto.randomUUID()}`); fs.renameSync(dest, old); }
      try { fs.renameSync(temp, dest); } catch (error) { if (old) fs.renameSync(old, dest); throw error; }
      if (old) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (_) {} }
    } finally {
      if (fs.existsSync(temp)) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {} }
    }
    return { id: pack.id, version: pack.version };
  }

  async function check() {
    if (checking) return checking;
    if (downloading) return snapshot();
    checking = (async () => {
      notify({ phase: 'checking', error: null, checks: [], attempts: [], progress: null });
      // R29：只走内源时读程序自带的目录快照，不碰外网、不弹放行窗。
      const results = require('./app-update/openx-source').onlyChannel(env) ? [require('./app-update/bundled-catalog').bundledCatalog(snapshotFile, validateCatalog)]
        : await checkManifests({ sources, fetchImpl: boundedCatalogFetch(fetchImpl, catalogBodyTimeoutMs), validate: validateCatalog, gate: true });
      const best = results.filter(r => r.ok).sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))[0];
      const checks = results.map(({ id, name, ok, reason, blocked, url }) => ({ id, name, ok, reason, blocked, url }));
      if (!best) { notify({ phase: 'error', checks, error: '暂时连不上开场动画目录，已有的开场动画照常可用，稍后可重试。' }); return snapshot(); }
      catalog = best.manifest;
      atomicJson(catalogFile, catalog);
      notify({ phase: 'available', checks, error: null });
      return snapshot();
    })().finally(() => { checking = null; });
    return checking;
  }

  async function download(id) {
    if (downloading) throw new Error('正在下载另一套开场动画，请等它完成');
    if (!catalog?.packs.some(p => p.id === id)) await check();
    const entry = catalog?.packs.find(p => p.id === id);
    if (!entry) { notify({ phase: 'error', failedId: id, error: state.error || '目录里暂时没有这一套，稍后再试' }); return snapshot(); }
    abort = new AbortController();
    downloading = (async () => {
      notify({ phase: 'downloading', activeId: id, failedId: null, error: null, attempts: [], progress: null });
      const dest = path.join(root, 'downloads', entry.file);
      const activeAbort = abort;
      const cancellableFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, activeAbort.signal]) });
      const result = await downloadWithFallback({ gate: true, sources, version: entry.version, openx: { release: `boot-splash-${entry.version}` }, expect: entry, dest, fetchImpl: cancellableFetch, signal: abort.signal,
        onProgress: progress => notify({ progress }), onAttempt: attempts => notify({ attempts }) });
      if (!result.ok) { notify({ phase: result.cancelled ? 'cancelled' : 'error', activeId: null, failedId: id, error: result.cancelled ? '下载已取消' : (require('./app-update/bundled-catalog').onlyFailReason(result) || '下载没成功，可以重试') + '；正在用的开场动画不受影响。' }); return snapshot(); }
      try { if (entry.anim === 'video') installVideo(dest, entry); else install(readJson(dest), entry); } finally { try { fs.unlinkSync(dest); } catch (_) {} }
      notify({ phase: 'installed', activeId: null, installedId: id, progress: null, error: null });
      return snapshot();
    })().catch(error => { notify({ phase: 'error', activeId: null, failedId: id, error: error.message }); return snapshot(); })
      .finally(() => { downloading = null; abort = null; });
    return downloading;
  }

  return { snapshot, startup, savePreferences, check, download, install, cancel: () => abort?.abort(), root, get catalog() { return catalog; } };
}

module.exports = { DEFAULT_ID, DEFAULT_PREFERENCES, FREQUENCIES, SOURCES, validateCatalog, validatePack, createBootSplashStore };
