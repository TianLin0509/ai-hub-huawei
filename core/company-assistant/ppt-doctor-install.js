'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { MIRROR_MANIFEST_URLS } = require('./ppt-doctor-protocol');
const { archiveUrl } = require('./ppt-doctor-download');
const { resolveFetch } = require('./fetch-util');
const { downloadWithFallback } = require('../app-update/downloader');
const openxSource = require('../app-update/openx-source');
const { capability } = require('./ppt-doctor-discovery');

// Only a verified full archive is installed. The retained mirror baseline may be older than its latest delta.
function fullArchive(manifest, base) {
  const full = manifest?.full;
  const url = archiveUrl(manifest, base);
  if (!full || !/^[a-f0-9]{64}$/.test(full.sha256 || '')) throw new Error('安装清单缺少完整包校验值，请使用下载页');
  return { url, version: full.version, latestVersion: manifest.version, sha256: full.sha256 };
}

// R31（2026-11-24）：镜像只留一个完整基线包（现为 2.0.7）+ 从基线到最新的文件块（PPT Doctor tools/mirror_release.py 的布局，
// 和它自己的增量更新同一套：清单 files 里每个文件的 sha256，块放在清单同目录 files/<sha256>）。
// 以前一键升级只装基线，已装 2.1.x 的电脑点了反被装回 2.0.7。现在：清单带文件表就「基线 + 增量补到最新」；
// 补不到最新、而基线又比本机已装的旧时，拒绝安装、原有安装不动。
const HEX64 = /^[a-f0-9]{64}$/;
function safeRel(rel) {
  const s = String(rel || '');
  // 和 scripts/ppt-doctor-extract.ps1 同一口径：拦冒号（盘符、NTFS 备用数据流）、结尾点或空格、设备保留名。
  if (!s || s.length > 400 || /^[\\/]|:|\\|\0/.test(s)
      || s.split('/').some(p => p === '' || p === '.' || p === '..' || /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('增量清单里有越界路径，已整批放弃');
  return s;
}
function deltaFiles(manifest) {
  const files = manifest?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  const out = [];
  for (const [rel, meta] of Object.entries(files)) {
    const size = Number(meta?.size);
    if (!HEX64.test(String(meta?.hash || '')) || !Number.isSafeInteger(size) || size < 0) throw new Error('增量清单的文件校验值无效，已整批放弃');
    out.push({ rel: safeRel(rel), hash: meta.hash, size });
  }
  return out.length ? out : null;
}
// installed：本机已装版本（读不到为空）。返回这次能装成哪一版，或 refuse 说明为什么不装。
function installPlan(manifest, meta, installed = '') {
  const { compareVersions } = require('../tool-discovery/candidates');
  const files = deltaFiles(manifest);
  const delta = !!files && compareVersions(meta.latestVersion, meta.version) > 0;
  const target = delta ? meta.latestVersion : meta.version;
  const floor = installed && compareVersions(meta.version, installed) < 0;   // 只装基线会比已装旧
  if (installed && compareVersions(target, installed) < 0) return { refuse: true, target, files, floor };
  return { refuse: false, delta, target, files, floor };
}
const tooOld = (base, installed) => `公司内源上只有完整基线 v${base}，比本机已装的 v${installed} 旧，Hub 不会装回旧版`;

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '../../scripts/ppt-doctor-extract.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), '-Archive', zip, '-Destination', dest],
    { windowsHide: true, timeout: 180000, maxBuffer: 65536 }, (error) => error ? reject(new Error('安装包解压失败或超过 3 分钟，请重试')) : resolve());
  });
}

async function sha256File(file) {
  const hash = require('node:crypto').createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// 把刚解开的完整基线（dir 是 PPT-Doctor.exe 所在目录）补到清单那一版。块先全部下到 staging 并逐个核对 sha256 和大小，
// 全部到手才换进 dir；中途失败 dir 原样还是基线。只动本次新建的安装目录，不碰用户已有的安装。
async function applyDelta({ dir, manifest, files, base, fetch, signal, staging, onProgress = () => {} }) {
  let local = {};
  try { local = JSON.parse((await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')).replace(/^﻿/, '')).files || {}; } catch { /* 基线包没带清单：逐个按文件内容比 */ }
  const need = [];
  for (const f of files) {
    const target = path.join(dir, f.rel);
    try {
      const st = await fs.stat(target);
      if (st.isFile() && st.size === f.size && (local[f.rel]?.hash === f.hash || await sha256File(target) === f.hash)) continue;
    } catch { /* 基线里没有这个文件 */ }
    need.push(f);
  }
  const blocks = [...new Map(need.map(f => [f.hash, f])).values()];
  const total = blocks.reduce((n, f) => n + f.size, 0);
  if (total > 4 * 1024 ** 3) throw new Error('增量文件总量异常，已放弃');
  await fs.mkdir(staging, { recursive: true });
  let received = 0, mutated = false;
  try {
  onProgress({ received, total, files: blocks.length });
  for (const f of blocks) {
    if (signal.aborted) throw new Error('已取消');
    const url = new URL('files/' + f.hash, base).href;
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`增量文件 HTTP ${response.status}`);
    if (/text\/html/i.test(response.headers.get('content-type') || '') && f.size > 0) throw new Error('增量文件被网络确认页挡住');
    const hash = require('node:crypto').createHash('sha256'), out = path.join(staging, f.hash);
    const handle = await fs.open(out, 'w');
    let got = 0;
    try {
      if (response.body) for await (const chunk of response.body) {
        const buf = Buffer.from(chunk); got += buf.length;
        if (got > f.size) throw new Error('增量文件比清单写的大，已放弃');
        hash.update(buf); await handle.write(buf);
        received += buf.length; onProgress({ received, total, files: blocks.length });
      }
    } finally { await handle.close(); }
    if (got !== f.size || hash.digest('hex') !== f.hash) throw new Error('增量文件校验不通过，已放弃');
  }
  // 全部核对通过才换入：同一份内容可能对应多个路径，复制而不是移动。从这里起目录已不再是纯基线。
  mutated = true;
  for (const f of need) {
    const target = path.join(dir, f.rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(staging, f.hash), target);
  }
  const keep = new Set(files.map(f => f.rel));
  for (const rel of Object.keys(local)) {
    if (keep.has(rel)) continue;
    let safe; try { safe = safeRel(rel); } catch { continue; }
    await fs.rm(path.join(dir, safe), { force: true });
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { files: need.length, bytes: total };
  } catch (error) { error.dirMutated = mutated; throw error; }
  finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

async function findExecutable(root) {
  const choices = [root];
  for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) choices.push(path.join(root, e.name));
  for (const dir of choices) for (const name of ['PPT-Doctor.exe', 'PPT Doctor.exe']) {
    const file = path.join(dir, name);
    try { if ((await fs.lstat(file)).isFile()) return file; } catch { /* next candidate */ }
  }
  throw new Error('安装包里没有找到 PPT Doctor 程序');
}

// r60：随程序发布的 PPT Doctor 清单快照（只含版本与完整包校验值；scripts/refresh-bundled-manifests.js 在发版时刷新）。
function bundledDoctorManifest() {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'ppt-doctor-manifest-snapshot.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { return null; }
}

function createDoctorInstaller({ dataDir, onState = () => {}, configure, fetchImpl, sources = MIRROR_MANIFEST_URLS,
  download = downloadWithFallback, extract = extractZip, verify = capability, bundledManifest = bundledDoctorManifest,
  installedVersion = async () => '' } = {}) {
  let state = { phase: 'idle' }, pending = null, abort = null;
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; try { onState(snapshot()); } catch { /* a closed view must not interrupt installation */ } };
  async function perform() {
    abort = new AbortController();
    const signal = abort.signal, fetch = require('../own-gate').gatedFetch(resolveFetch(fetchImpl));
    const root = path.resolve(dataDir, 'tools', 'ppt-doctor');
    const job = path.join(root, 'install-' + randomUUID());
    let registered = false;
    set({ phase: 'checking', message: '正在读取安装清单…', error: null, received: 0, total: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null });
    try {
      await fs.mkdir(job, { recursive: true });
      let chosen = null, plan = null, refused = '';
      const failures = [];
      const installed = String(await Promise.resolve().then(installedVersion).catch(() => '') || '');
      // R29/R35：内源生效时只用程序自带的清单快照（发版时刷新），不去外网读清单；完整包只从内源下。
      const only = openxSource.active(process.env);
      const tries = only && bundledManifest && sources.length && bundledManifest() ? [{ base: sources[0], bundled: true }]
        : [...sources.map(base => ({ base })), ...(bundledManifest && sources.length ? [{ base: sources[0], bundled: true }] : [])];
      const tried = new Set();
      for (const { base, bundled } of tries) {
        if (signal.aborted) throw new Error('已取消');
        try {
          let manifest;
          if (bundled) {
            manifest = bundledManifest();
            if (!manifest) throw new Error('程序自带的清单不可用');
          } else {
            const response = await fetch(base, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
            if (!response.ok) throw new Error(`清单 HTTP ${response.status}`);
            if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('安装清单过大');
            const body = await response.text();
            if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('安装清单过大');
            manifest = JSON.parse(body.replace(/^\uFEFF/, ''));
          }
          const meta = fullArchive(manifest, base);
          // 自带清单和刚才在线读到、已经下载失败的是同一个包：不再重复下一遍。
          if (bundled && tried.has(meta.sha256)) continue;
          const thisPlan = installPlan(manifest, meta, installed);
          // 下 600 MB 之前先判断：这个源最多只能装成比已装还旧的版本，就不下（自带清单快照没有文件表，只能装基线）。
          if (thisPlan.refuse) { refused = tooOld(meta.version, installed); continue; }
          tried.add(meta.sha256);
          // 公司内源（r24）：按文件名在 openx 找同名附件（大文件是 .000/.001… 分片），版本名固定为 ppt-doctor-<完整包版本>。
          // 清单没给大小：用内源附件的大小；内容最终都按清单的 sha256 核对。内源不生效（测试）时问给定地址 HEAD。
          const file = path.posix.basename(new URL(meta.url).pathname);
          const openx = { release: `ppt-doctor-${meta.version}` };
          const sane = n => Number.isSafeInteger(n) && n >= 1 && n <= 4 * 1024 ** 3;
          const externalSize = async () => {
            const head = await fetch(meta.url, { method: 'HEAD', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
            const n = Number(head.headers.get('content-length'));
            if (!head.ok || /text\/html/i.test(head.headers.get('content-type') || '') || !sane(n)) throw new Error('完整包大小无法确认或被网络确认页挡住');
            return n;
          };
          let bytes = NaN;
          if (only) {
            openxSource.clearDown();
            const hit = await openxSource.find({ release: openx.release, file, version: meta.version, fetchImpl: fetch, signal }).catch(() => null);
            if (hit) bytes = await openxSource.headSize(hit, { fetchImpl: fetch, signal });
          }
          const sizedByOpenx = sane(bytes);
          // 内源上没有（或量不出大小）就直接说原因，不去外网量大小、不从外网下。
          if (!sizedByOpenx && only) throw new Error(openxSource.userReason(openxSource.lastReason() || '内源上没有这个文件', { file }));
          if (!sizedByOpenx) bytes = await externalSize();
          const fetchArchive = n => {
            set({ phase: 'downloading', message: '正在下载 PPT Doctor…', version: meta.version, latestVersion: meta.latestVersion, total: n, received: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null });
            return download({ gate: true, sources: [{ id: 'doctor', name: require('../app-update/downloader').friendlySourceName(meta.url), url: meta.url }],
              version: meta.version, openx, expect: { file, bytes: n, sha256: meta.sha256 },
              dest: path.join(job, 'package.zip'), fetchImpl: fetch, signal,
              onProgress: progress => set(progress) });
          };
          const result = await fetchArchive(bytes);
          if (!result.ok) throw new Error(result.cancelled ? '已取消' : result.attempts.map(a => a.reason).join('；'));
          set({ source: result.source && result.source.name });
          chosen = { ...meta, base, manifest }; plan = thisPlan; break;
        } catch (error) { failures.push(error.message); }
      }
      if (!chosen && refused) {
        // 在线源的真实失败原因不能被「只有旧基线」盖掉：两者一起写。
        const online = failures.length ? `在线下载源这次用不了（${[...new Set(failures)].join('；')}），` : '';
        throw new Error(`本机已装 PPT Doctor v${installed}，${online}${refused}；请打开 PPT Doctor 点「检查更新」，或关掉它后重新运行 PPT Doctor 安装包`);
      }
      if (!chosen) throw new Error([...new Set(failures)].join('；') || '没有可用的下载源');
      if (signal.aborted) throw new Error('已取消');
      set({ phase: 'extracting', message: '正在解压并校验联动组件，最多约 3 分钟…' });
      const unpacked = path.join(job, 'app');
      await fs.mkdir(unpacked);
      await extract(path.join(job, 'package.zip'), unpacked);
      if (signal.aborted) throw new Error('已取消');
      const exe = await findExecutable(unpacked);
      let installedAs = chosen.version;
      if (plan.delta) {
        set({ phase: 'applying', message: `正在把完整基线 v${chosen.version} 补到最新 v${chosen.latestVersion}…`, received: 0, total: 0, speed: 0, etaSec: null });
        try {
          await applyDelta({ dir: path.dirname(exe), manifest: chosen.manifest, files: plan.files, base: chosen.base, fetch, signal,
            staging: path.join(job, 'delta'), onProgress: p => set({ received: p.received, total: p.total }) });
          installedAs = chosen.latestVersion;
        } catch (error) {
          if (signal.aborted) throw new Error('已取消');
          // 补不上最新：基线不比已装旧（或本机没装）才退回只装基线，否则原有安装不动。
          if (plan.floor) throw new Error(`增量文件没下完（${error.message}），${tooOld(chosen.version, installed)}，原有安装未更改`);
          // 换入做到一半：目录已半新半旧，不能当基线登记。
          if (error.dirMutated) throw new Error(`增量文件换入中途失败（${error.message}），原有安装未更改`);
          console.warn('[ppt-doctor] 增量补齐失败，按完整基线安装：', error.message);
        }
      }
      if (signal.aborted) throw new Error('已取消');
      const info = await verify(exe);
      // 新装的这一份必须标记和主程序完全对得上（哈希不一致的宽容只给用户已有的安装）。
      if (!info || info.exeHashMismatch) throw new Error('PPT Doctor 联动能力或程序校验不通过，原有安装未更改');
      if (signal.aborted) throw new Error('已取消');
      // No existing installation is overwritten. Publish the path only after verification succeeds.
      await configure(exe);
      registered = true;
      await fs.unlink(path.join(job, 'package.zip')).catch(() => {});
      set({ phase: 'done', message: `PPT Doctor v${installedAs} 已安装${chosen.latestVersion !== installedAs ? '；这是完整基线，后续更新由 PPT Doctor 提供' : ''}`, version: installedAs, latestVersion: chosen.latestVersion });
    } catch (error) {
      set({ phase: signal.aborted ? 'cancelled' : 'error', error: signal.aborted ? null : error.message, message: signal.aborted ? '已取消安装' : '安装未完成：' + error.message });
    } finally {
      // job is a newly created UUID directory under our component root, never an existing user installation.
      if (!registered) await fs.rm(job, { recursive: true, force: true }).catch(() => {});
      abort = null;
    }
    return snapshot();
  }
  return { snapshot, install() { if (!pending) pending = perform().finally(() => { pending = null; }); return pending; }, cancel() { abort?.abort(); return snapshot(); } };
}
module.exports = { fullArchive, installPlan, applyDelta, createDoctorInstaller, extractZip, findExecutable, bundledDoctorManifest };
