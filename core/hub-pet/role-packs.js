'use strict';
// 桌宠形象包（2026-10-17 用户：默认只带小猫、企鹅，其余形象在线下载，在「助理 → 设置 → 桌宠」里选）。
// 下载机制照抄 AI 头像包（core/appearance-packs.js）：catalog.json + <id>-<version>.json 包，逐个核对字节数与 SHA-256，
// 多源依次尝试；只在用户点「下载 / 检查新形象」时联网；失败不影响正在用的形象。
// 包只是数据：webp 图片按白名单文件名写到 <数据目录>/hub-pet/roles/<id>/，不执行、不解析任何别的内容。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { checkManifests, downloadWithFallback } = require('../app-update/downloader');
const { boundedCatalogFetch, compareVersion } = require('../appearance-packs');
const { ROLES } = require('./state');

const MAX_PACK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^\d{2}-[a-z][a-z0-9-]{0,30}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const FILE = /^(?:idle|typing|happy|sleep|seq-[a-z][a-z-]{0,23})\.webp$/;
const POSE_NAMES = new Set(['idle', 'typing', 'happy', 'sleep']);
// 下载只走公司内源（openx）；内源不生效时（纯 Node 单测）由调用方注入源，默认不提供外网源。
const SOURCES = Object.freeze([]);
const DEFAULT_ROLE = '01-cat';

function isWebp(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}
function decodeWebp(value) {
  const m = typeof value === 'string' && /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_FILE_BYTES || buf.toString('base64') !== m[1] || !isWebp(buf)) return null;
  return buf;
}

// 角色元数据：和 renderer/assets/hub-pet/manifest.json 里每一项同形（poses / sequences）。
function validateMeta(raw) {
  const list = (v, ok) => Array.isArray(v) && v.length <= 12 && v.every(x => typeof x === 'string' && ok(x)) ? [...new Set(v)] : null;
  const poses = list(raw?.poses, x => POSE_NAMES.has(x));
  const sequences = list(raw?.sequences || [], x => FILE.test('seq-' + x + '.webp'));
  if (!poses || !poses.includes('idle') || !sequences) throw new Error('形象包的姿态清单无效');
  // clipped：5×5 序列图里不播的帧（2026-11-17 r27h 下载形象补帧起用）。只认包里有的序列、0–24 的帧号，别的一律不收。
  const clipped = {};
  if (raw?.clipped != null) {
    if (typeof raw.clipped !== 'object' || Array.isArray(raw.clipped)) throw new Error('形象包的裁切帧清单无效');
    for (const [name, frames] of Object.entries(raw.clipped)) {
      if (!sequences.includes(name) || !Array.isArray(frames) || frames.length > 25 || !frames.every(f => Number.isInteger(f) && f >= 0 && f <= 24)) throw new Error('形象包的裁切帧清单无效');
      clipped[name] = [...new Set(frames)];
    }
  }
  const out = { ...raw, poses, sequences, clipped };
  if (raw?.credit != null) out.credit = validateCredit(raw.credit);
  else delete out.credit;
  return JSON.parse(JSON.stringify(out));
}

// 形象来源与授权（2026-11-18 r49b，拟人形象起用）：作者链、协议、条款原话、改动说明、协议全文。只收纯文本，
// 设置页按文本显示（不当 HTML 解析）；网址只收 https。字段超长或类型不对整包拒收，免得把半截署名装上去。
const CREDIT_TEXT = { summary: 200, changes: 600, note: 300, legal: 40000 };
function validateCredit(raw) {
  const bad = () => { throw new Error('形象包的署名信息无效'); };
  const text = (v, max, need) => { if (v == null && !need) return ''; if (typeof v !== 'string' || v.length > max || (need && !v.trim())) bad(); return v; };
  const url = v => { if (v == null || v === '') return ''; if (typeof v !== 'string' || v.length > 300 || !/^https:\/\/[^\s]+$/.test(v)) bad(); return v; };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  const list = (v, max) => { if (v == null) return []; if (!Array.isArray(v) || v.length > max) bad(); return v; };
  const out = { summary: text(raw.summary, CREDIT_TEXT.summary, true) };
  out.authors = list(raw.authors, 8).map(a => (a && typeof a === 'object' ? { name: text(a.name, 80, true), role: text(a.role, 120), url: url(a.url) } : bad()));
  if (raw.license != null) {
    if (typeof raw.license !== 'object' || Array.isArray(raw.license)) bad();
    out.license = { name: text(raw.license.name, 120, true), url: url(raw.license.url) };
  }
  out.terms = list(raw.terms, 8).map(t => (t && typeof t === 'object' ? { quote: text(t.quote, 400, true), source: text(t.source, 120), url: url(t.url) } : bad()));
  for (const k of ['changes', 'note', 'legal']) out[k] = text(raw[k], CREDIT_TEXT[k]);
  return out;
}

// 校验整个包，返回 { id, version, name, description, meta, buffers: { 文件名: Buffer } }。
function validatePack(raw) {
  if (!raw || raw.schema !== 1 || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error('形象包标识或版本无效');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 20) throw new Error('形象包名称无效');
  const meta = validateMeta(raw.meta);
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) throw new Error('形象包缺少图片');
  const buffers = {};
  for (const [name, value] of Object.entries(raw.files)) {
    if (!FILE.test(name)) throw new Error(`形象包里有不允许的文件：${String(name).slice(0, 40)}`);
    const buf = decodeWebp(value);
    if (!buf) throw new Error(`${name} 不是有效的 WebP 图片`);
    buffers[name] = buf;
  }
  for (const pose of meta.poses) if (!buffers[pose + '.webp']) throw new Error(`形象包缺少 ${pose}.webp`);
  for (const seq of meta.sequences) if (!buffers['seq-' + seq + '.webp']) throw new Error(`形象包缺少 seq-${seq}.webp`);
  return { id: raw.id, version: raw.version, name: raw.name.trim(), description: String(raw.description || '').slice(0, 120), meta, buffers };
}

function validateCatalog(raw) {
  if (!raw || raw.schema !== 1 || typeof raw.version !== 'string' || !VERSION.test(raw.version) || !Array.isArray(raw.packs) || raw.packs.length > 60) throw new Error('形象目录格式无效');
  const ids = new Set();
  const packs = raw.packs.map(p => {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id) || ids.has(p.id) || typeof p.version !== 'string' || !VERSION.test(p.version) || p.file !== `${p.id}-${p.version}.json`
      || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_PACK_BYTES || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('形象包清单字段无效');
    ids.add(p.id);
    return { id: p.id, version: p.version, file: p.file, bytes: p.bytes, sha256: p.sha256, name: String(p.name || p.id).slice(0, 20), description: String(p.description || '').slice(0, 120),
      ...(typeof p.credit === 'string' && p.credit.trim() ? { credit: p.credit.slice(0, 200) } : {}) };
  });
  return { schema: 1, version: raw.version, packs };
}

function readJson(file, max) {
  if (fs.statSync(file).size > max) throw new Error('文件超过允许大小');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function dirBytes(dir) {
  try { return fs.readdirSync(dir).reduce((n, f) => n + (FILE.test(f) ? fs.statSync(path.join(dir, f)).size : 0), 0); } catch (_) { return 0; }
}

// assetsDir：随程序带的 renderer/assets/hub-pet；dataDir：Hub 数据目录。
function createRolePackStore({ assetsDir, dataDir, sources = SOURCES, fetchImpl = globalThis.fetch, emit = () => {}, catalogBodyTimeoutMs = 12000, logger = console,
  snapshotFile = path.join(__dirname, 'catalog-snapshot.json'), env = process.env } = {}) {
  const root = path.join(dataDir, 'hub-pet', 'roles');
  const catalogFile = path.join(dataDir, 'hub-pet', 'catalog.json');
  let bundledManifest = {};
  try { bundledManifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8')); } catch (error) { logger.warn?.('[hub-pet] manifest missing:', error.message); }
  let catalog = null;
  try { catalog = validateCatalog(readJson(catalogFile, 128 * 1024)); } catch (_) {}
  let state = { phase: 'idle', activeId: null, progress: null, error: null, checks: [], attempts: [], failedId: null };
  let checking = null, downloading = null, abort = null;
  const notify = patch => { state = { ...state, ...patch }; try { emit('hub-pet:roles-state', snapshot()); } catch (_) {} return state; };

  const bundledDir = id => path.join(assetsDir, id);
  const downloadedDir = id => path.join(root, id);
  function bundled(id) { return ID.test(id) && fs.existsSync(path.join(bundledDir(id), 'idle.webp')); }
  function downloadedInfo(id) {
    if (!ID.test(id)) return null;
    try {
      const info = readJson(path.join(downloadedDir(id), 'pack.json'), 64 * 1024);
      if (info.id !== id || !VERSION.test(info.version)) return null;
      const meta = validateMeta(info.meta);
      if (!fs.existsSync(path.join(downloadedDir(id), 'idle.webp'))) return null;
      return { ...info, meta };
    } catch (_) { return null; }
  }
  // 程序自带的优先（自用版内置 6 个）；没带的看下载目录。
  function source(id) {
    if (bundled(id)) return { kind: 'bundled', dir: bundledDir(id), assetBase: `../assets/hub-pet/${id}/`, meta: bundledManifest[id] || { poses: ['idle'], sequences: [] } };
    const info = downloadedInfo(id);
    if (info) return { kind: 'downloaded', dir: downloadedDir(id), assetBase: pathToFileURL(downloadedDir(id)).href + '/', meta: info.meta, version: info.version, name: info.name };
    return null;
  }
  const installed = id => !!source(id);
  function meta(id) { return source(id)?.meta || null; }
  function assetBase(id) { return source(id)?.assetBase || null; }
  // 下载形象的包版本（自带形象为 null）。同一形象更新后版本变了，桌宠窗口据此换图、重新量轮廓（r27i 审查第 2 项）。
  function version(id) { const src = source(id); return src && src.kind === 'downloaded' ? src.version : null; }

  function listRoles() {
    const ids = new Map(ROLES.map(r => [r.id, r.name]));
    for (const p of catalog?.packs || []) if (!ids.has(p.id)) ids.set(p.id, p.name);
    try { for (const d of fs.readdirSync(root)) if (ID.test(d) && !ids.has(d)) { const info = downloadedInfo(d); if (info) ids.set(d, info.name); } } catch (_) {}
    return [...ids.entries()].map(([id, name]) => {
      const src = source(id);
      const entry = catalog?.packs.find(p => p.id === id) || null;
      const thumb = path.join(assetsDir, 'thumbs', id + '.webp');
      const preview = src ? src.assetBase + 'idle.webp' + (src.kind === 'downloaded' ? '?v=' + encodeURIComponent(src.version) : '') : fs.existsSync(thumb) ? `../assets/hub-pet/thumbs/${id}.webp` : null;
      const update = !!(src && src.kind === 'downloaded' && entry && compareVersion(entry.version, src.version) > 0);
      // 署名：装好的用包里的全文；没装的先给目录里的一句话，下载后再看全文。
      const credit = src?.meta?.credit ? { ...src.meta.credit, full: true } : entry?.credit ? { summary: entry.credit, full: false } : null;
      return {
        id, name: src?.name || name, bundled: src?.kind === 'bundled', installed: !!src, version: src?.version || (src?.kind === 'bundled' ? 'bundled' : null),
        bytes: src ? (src.kind === 'downloaded' ? dirBytes(src.dir) : null) : (entry ? entry.bytes : null),
        available: !!entry, update, preview, credit,
        // preview 相对 renderer/hub-pet/ 写的；主窗口（renderer/index.html）用 previewMain。
        previewMain: preview && preview.startsWith('../assets/') ? preview.slice(3) : preview,
      };
    });
  }
  function snapshot() { return { roles: listRoles(), catalog, state: { ...state } }; }

  async function check() {
    if (checking) return checking;
    if (downloading) return snapshot();
    checking = (async () => {
      notify({ phase: 'checking', error: null, checks: [], attempts: [], progress: null });
      // R29：只走内源时读程序自带的目录快照，不碰外网。
      const results = require('../app-update/openx-source').active(env) ? [require('../app-update/bundled-catalog').bundledCatalog(snapshotFile, validateCatalog)]
        : await checkManifests({ sources, fetchImpl: boundedCatalogFetch(fetchImpl, catalogBodyTimeoutMs), validate: validateCatalog, gate: true });
      const best = results.filter(r => r.ok).sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))[0];
      const checks = results.map(({ id, name, ok, reason, blocked, url }) => ({ id, name, ok, reason, blocked, url }));
      if (!best) { notify({ phase: 'error', checks, error: '暂时连不上形象目录，已安装的形象照常可用，稍后可重试。' }); return snapshot(); }
      catalog = best.manifest;
      atomicJson(catalogFile, catalog);
      notify({ phase: 'available', checks, error: null });
      return snapshot();
    })().finally(() => { checking = null; });
    return checking;
  }

  // 安装：先写到临时目录，全部写完再整体换上；旧目录最后删。
  function install(raw, expected) {
    const pack = validatePack(raw);
    if (expected && (pack.id !== expected.id || pack.version !== expected.version)) throw new Error('形象包与目录不一致');
    fs.mkdirSync(root, { recursive: true });
    const temp = path.join(root, `.tmp-${pack.id}-${crypto.randomUUID()}`);
    fs.mkdirSync(temp);
    try {
      for (const [name, buf] of Object.entries(pack.buffers)) fs.writeFileSync(path.join(temp, name), buf);
      fs.writeFileSync(path.join(temp, 'pack.json'), JSON.stringify({ id: pack.id, version: pack.version, name: pack.name, description: pack.description, meta: pack.meta, installedAt: Date.now() }));
      const dest = downloadedDir(pack.id);
      let old = null;
      if (fs.existsSync(dest)) { old = path.join(root, `.old-${pack.id}-${crypto.randomUUID()}`); fs.renameSync(dest, old); }
      try { fs.renameSync(temp, dest); }
      catch (error) { if (old) fs.renameSync(old, dest); throw error; }
      if (old) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (_) {} }
    } finally {
      if (fs.existsSync(temp)) { try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {} }
    }
    return { id: pack.id, version: pack.version };
  }

  async function download(id) {
    if (downloading) throw new Error('正在下载另一个形象，请等它完成');
    if (!catalog?.packs.some(p => p.id === id)) await check();
    const entry = catalog?.packs.find(p => p.id === id);
    if (!entry) { notify({ phase: 'error', failedId: id, error: state.error || '形象目录里没有这个形象' }); return snapshot(); }
    abort = new AbortController();
    downloading = (async () => {
      notify({ phase: 'downloading', activeId: id, failedId: null, error: null, attempts: [], progress: null });
      const dest = path.join(dataDir, 'hub-pet', 'downloads', entry.file);
      const activeAbort = abort;
      const cancellableFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, activeAbort.signal]) });
      const result = await downloadWithFallback({ sources, version: entry.version, openx: { release: `pet-role-${entry.version}` }, expect: entry, dest, fetchImpl: cancellableFetch, signal: abort.signal,
        onProgress: progress => notify({ progress }), onAttempt: attempts => notify({ attempts }) });
      if (!result.ok) { notify({ phase: result.cancelled ? 'cancelled' : 'error', activeId: null, failedId: id, error: result.cancelled ? '下载已取消' : (require('../app-update/bundled-catalog').onlyFailReason(result) || '下载没成功，可以重试') + '；正在用的形象不受影响。' }); return snapshot(); }
      try { install(readJson(dest, MAX_PACK_BYTES * 2), entry); } finally { try { fs.unlinkSync(dest); } catch (_) {} }
      notify({ phase: 'installed', activeId: null, installedId: id, progress: null, error: null });
      return snapshot();
    })().catch(error => { notify({ phase: 'error', activeId: null, failedId: id, error: error.message }); return snapshot(); })
      .finally(() => { downloading = null; abort = null; });
    return downloading;
  }

  return { snapshot, listRoles, check, download, install, installed, meta, assetBase, version, cancel: () => abort?.abort(), root };
}

module.exports = { DEFAULT_ROLE, FILE, MAX_PACK_BYTES, SOURCES, isWebp, validateCatalog, validateCredit, validateMeta, validatePack, createRolePackStore };
