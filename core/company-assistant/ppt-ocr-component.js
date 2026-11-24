'use strict';
// PPT Doctor 识别组件（文字识别 OCR 旁车）由 Hub 一键更新（r54，2026-11-19）。
// 起因：增强转字要求识别组件带 assistApiVersion:1（v1.2.0 起），早先按需下载过 v1.0.0 的电脑转到一半才报
// 「增强转字需要更新识别组件」，页面又没有更新入口。
// 为什么由 Hub 下载、而不是让 Doctor 加一个联动操作：已装在用户电脑上的 Doctor（2.1.x）都没有这个操作，
// 要它们先升级 Doctor 才能修，等于把一个按钮变成两次安装；Hub 这边下载还能走公司内源（openx）优先。
// 发布物与 Doctor 自己的「设置 → 组件」完全同一份（component.json + component.zip），安装结果和 Doctor 自己装的一样：
//   %LOCALAPPDATA%\pptx-finder\ocr\（PPTX_FINDER_DATA_DIR 可覆盖）里放解开的文件，再写 component.json
//   {version, assistApiVersion, archive_hash}。Doctor 读这个文件判断能不能增强转字。
// 校验两层：整包 sha256（下载器核对）+ 解开后逐个文件对清单 sha256，清单外的文件整批拒绝；全部就绪才整体换入，
// 中途失败旧组件原样保留。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

// 下载只走公司内源（R29/R35）；这组地址只在内源不生效时（纯 Node 单测、测试注入）使用。
const OCR_SOURCES = Object.freeze([
  'https://dl.lt-stockpartner.tech/pptutor/ocr/',
  'https://me.lt-stockpartner.tech/pptutor/ocr/',
  'https://github.com/TianLin0509/PPTutor/releases/download/ocr-v1.2.0/',
]);
// 清单取不到时界面显示的大概下载量（与 Doctor 组件页同一口径，MB）。
const APPROX_MB = 82;
const HEX64 = /^[0-9a-f]{64}$/;
// 公司内源上的附件名（发版同步 openx_sync.py 按同一规则上传；component.zip 太泛，会和别的组件撞名）。
const openxFile = version => `pptdoctor-ocr-${version}.zip`;

function doctorDataDir(env = process.env) { return require('./ppt-materials').doctorDataDir(env); }

function safeRel(rel) {
  const text = String(rel || '').replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[a-z]:/i.test(text) || text.split('/').some(s => !s || s === '.' || s === '..')) throw new Error(`识别组件清单含非法路径：${rel}`);
  return text;
}

// 清单校验：版本、增强转字能力、整包与逐文件 sha256。被公司代理换成网页时这里就会拒绝。
function validManifest(m) {
  if (!m || typeof m !== 'object' || !/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) throw new Error('识别组件清单格式不对（可能被网络拦截页替换）');
  const ar = m.archive || {};
  if (!HEX64.test(ar.hash || '') || !Number.isSafeInteger(ar.size) || ar.size < 1 || ar.size > 2 * 1024 ** 3 || !/^[A-Za-z0-9._-]+\.zip$/.test(ar.name || '')) throw new Error('识别组件清单缺少完整包校验值');
  const files = m.files && typeof m.files === 'object' ? Object.entries(m.files) : [];
  if (!files.length || files.length > 20000) throw new Error('识别组件清单没有文件列表');
  for (const [rel, meta] of files) { safeRel(rel); if (!HEX64.test(meta?.hash || '')) throw new Error(`识别组件清单含非法哈希：${rel}`); }
  if (m.assistApiVersion !== 1) throw new Error(`下载源上的识别组件 v${m.version} 还不支持增强转字`);
  return m;
}

function sources(deps = {}) {
  return deps.urls || OCR_SOURCES;
}

// R29 审查 #1：只走内源时读程序自带的清单快照（scripts/refresh-bundled-manifests.js 发版时刷新），不去外网读、不弹放行窗。
const SNAPSHOT_FILE = path.join(__dirname, 'ppt-ocr-manifest-snapshot.json');
function bundledManifest(file = SNAPSHOT_FILE) {
  return { base: OCR_SOURCES[0], manifest: validManifest(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))) };
}

async function fetchManifest(fetch, deps = {}) {
  if (deps.openx !== false && require('../app-update/openx-source').active(deps.env || process.env)) {
    try { return bundledManifest(deps.snapshotFile); }
    catch (error) { throw new Error(`这个版本没带上识别组件清单（${error.code === 'ENOENT' ? '找不到清单文件' : error.message}），升级 Hub 后再试；一直如此请点「一键反馈」`); }
  }
  const { reasonOf } = require('../app-update/downloader');
  const reasons = []; let gateNote = '';
  for (const base of sources(deps)) {
    try {
      const response = await fetch(new URL('component.json', base).href, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
      if (!response.ok) throw new Error(`清单 HTTP ${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('识别组件清单过大');
      return { base, manifest: validManifest(JSON.parse(body.replace(/^\uFEFF/, ''))) };
    } catch (error) { reasons.push(reasonOf(error)); if (error.blocked || error.passed) gateNote = error.message; }
  }
  if (gateNote) throw new Error(gateNote);
  throw new Error(`识别组件清单暂时取不到：${reasons[reasons.length - 1] || '没有可用的下载源'}`);
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error('识别组件压缩包含链接，已拒绝');
      if (e.isDirectory()) await walk(file); else out.push(file);
    }
  }
  await walk(root);
  return out;
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// 解开后逐个文件对清单：缺文件、多文件、内容不对都整批拒绝。
async function verifyUnpacked(dir, manifest, signal) {
  const expected = new Map(Object.entries(manifest.files).map(([rel, meta]) => [safeRel(rel).toLowerCase(), meta.hash]));
  const seen = new Set();
  for (const file of await listFiles(dir)) {
    if (signal?.aborted) throw new Error('已取消');
    const rel = path.relative(dir, file).replace(/\\/g, '/').toLowerCase();
    if (!expected.has(rel)) throw new Error(`识别组件压缩包含清单之外的文件：${rel}`);
    if (await hashFile(file) !== expected.get(rel)) throw new Error(`识别组件文件校验失败：${rel}`);
    seen.add(rel);
  }
  for (const rel of expected.keys()) if (!seen.has(rel)) throw new Error(`识别组件缺少文件：${rel}`);
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
// 换入：旧目录先挪开（Windows 上有程序在用时挪不动，就等它空闲），新目录整体改名进来；失败把旧的放回去。
// Doctor 的识别会话空闲 45 秒自动退出，所以最多等约 75 秒。
async function swapIn(staged, target, { waitMs = 75000, stepMs = 1000, onWait = () => {}, signal } = {}) {
  const retired = target + '.hub-old-' + randomUUID().slice(0, 8);
  const deadline = Date.now() + waitMs;
  let moved = false;
  for (;;) {
    try { if (fs.existsSync(target)) { fs.renameSync(target, retired); moved = true; } break; }
    catch (error) {
      if (!BUSY.has(error.code) || Date.now() >= deadline || signal?.aborted) throw new Error('识别组件正被 PPT Doctor 占用（可能有识别还没结束），没能换上；关掉 PPT Doctor 里正在进行的识别后再点一次更新');
      onWait();
      await new Promise(resolve => setTimeout(resolve, stepMs));
    }
  }
  try { fs.renameSync(staged, target); }
  catch (error) { if (moved && !fs.existsSync(target)) { try { fs.renameSync(retired, target); } catch { /* 放不回去时留着 .hub-old 目录，Doctor 设置里可重装 */ } } throw new Error('识别组件换入失败：' + error.message); }
  if (moved) await fsp.rm(retired, { recursive: true, force: true }).catch(() => {});
}

function createOcrComponentInstaller(deps = {}) {
  const env = deps.env || process.env;
  const download = deps.download || require('../app-update/downloader').downloadWithFallback;
  const extract = deps.extract || require('./ppt-doctor-install').extractZip;
  let state = { phase: 'idle' }, pending = null, abort = null;
  const listeners = new Set();
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; for (const fn of [...listeners, deps.onState].filter(Boolean)) { try { fn(snapshot()); } catch { /* 界面关了不影响安装 */ } } };
  async function perform() {
    abort = new AbortController();
    const signal = abort.signal;
    const fetch = require('../own-gate').gatedFetch(require('./fetch-util').resolveFetch(deps.fetchImpl));
    const root = doctorDataDir(env), target = path.join(root, 'ocr');
    const job = path.join(root, '.hub-ocr-' + randomUUID());
    set({ phase: 'checking', message: '正在读取识别组件清单…', error: null, received: 0, total: 0, percent: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null });
    try {
      // 内源优先：读清单的同时先在后台探测内源版本列表，第一个请求就打到内源；随后下载包时内源状态已知。
      if (deps.openx !== false) require('../app-update/openx-source').prewarm({ ...(deps.openx || {}), env, fetchImpl: fetch });
      const { base, manifest } = await fetchManifest(fetch, { ...deps, env });
      const ar = manifest.archive, version = manifest.version;
      set({ phase: 'downloading', message: `正在下载识别组件 v${version}（${(ar.size / 1048576).toFixed(0)} MB）…`, version, total: ar.size, sizeMb: Math.round(ar.size / 1048576) });
      await fsp.mkdir(job, { recursive: true });
      const bases = [base, ...sources({ ...deps, env }).filter(u => u !== base)];
      const result = await download({ gate: true, version,
        sources: bases.map(b => ({ id: new URL(b).hostname, name: require('../app-update/downloader').friendlySourceName(b), url: new URL(ar.name, b).href })),
        openx: deps.openx === false ? false : { release: `ocr-${version}`, env, ...(deps.openx || {}) },   // 探测预算用内源默认的 3 秒
        expect: { file: openxFile(version), bytes: ar.size, sha256: ar.hash },
        dest: path.join(job, 'component.zip'), fetchImpl: fetch, signal,
        onProgress: p => set({ received: p.received, total: p.total, speed: p.speed, etaSec: p.etaSec, sourceId: p.sourceId, sourceName: p.sourceName, percent: p.total ? Math.min(99, Math.floor(p.received / p.total * 100)) : 0,
          message: `正在下载识别组件 v${version} ${p.total ? Math.min(99, Math.floor(p.received / p.total * 100)) + '%' : ''}${p.sourceName ? '（' + p.sourceName + '）' : ''}` }) });
      if (!result.ok) throw new Error(result.cancelled ? '已取消' : '识别组件下载失败：' + (require('../app-update/bundled-catalog').onlyFailReason(result) || (result.attempts || []).map(a => `${a.name}：${a.reason}`).join('；')));
      if (signal.aborted) throw new Error('已取消');
      set({ phase: 'extracting', message: '正在解压并逐个校验识别组件文件…', source: result.source?.name || '' });
      const unpacked = path.join(job, 'ocr');
      await fsp.mkdir(unpacked);
      await extract(path.join(job, 'component.zip'), unpacked);
      await verifyUnpacked(unpacked, manifest, signal);
      fs.writeFileSync(path.join(unpacked, 'component.json'), JSON.stringify({ version, assistApiVersion: manifest.assistApiVersion, archive_hash: ar.hash }), 'utf8');
      if (signal.aborted) throw new Error('已取消');
      set({ phase: 'installing', message: '正在换上新识别组件…' });
      await swapIn(unpacked, target, { ...(deps.swap || {}), signal, onWait: () => set({ message: '识别组件正被 PPT Doctor 占用，等它空闲（最多约 1 分钟）…' }) });
      set({ phase: 'done', message: `识别组件已更新到 v${version}`, percent: 100 });
    } catch (error) {
      set({ phase: signal.aborted ? 'cancelled' : 'error', error: signal.aborted ? null : error.message, message: signal.aborted ? '已取消更新' : '识别组件更新未完成：' + error.message });
    } finally {
      // job 是本次新建的 UUID 目录，只放本次下载与解压的文件。
      await fsp.rm(job, { recursive: true, force: true }).catch(() => {});
      abort = null;
    }
    return snapshot();
  }
  return {
    snapshot,
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    install() { if (!pending) pending = perform().finally(() => { pending = null; }); return pending; },
    cancel() { abort?.abort(); return snapshot(); },
    busy: () => !!pending,
  };
}

module.exports = { createOcrComponentInstaller, bundledManifest, SNAPSHOT_FILE, validManifest, verifyUnpacked, swapIn, fetchManifest, openxFile, OCR_SOURCES, APPROX_MB };
