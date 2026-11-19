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

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, '../../scripts/ppt-doctor-extract.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), '-Archive', zip, '-Destination', dest],
    { windowsHide: true, timeout: 180000, maxBuffer: 65536 }, (error) => error ? reject(new Error('安装包解压失败或超过 3 分钟，请重试')) : resolve());
  });
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

function createDoctorInstaller({ dataDir, onState = () => {}, configure, fetchImpl, sources = MIRROR_MANIFEST_URLS,
  download = downloadWithFallback, extract = extractZip, verify = capability } = {}) {
  let state = { phase: 'idle' }, pending = null, abort = null;
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; try { onState(snapshot()); } catch { /* a closed view must not interrupt installation */ } };
  async function perform() {
    abort = new AbortController();
    const signal = abort.signal, fetch = require('../own-gate').gatedFetch(resolveFetch(fetchImpl));
    const root = path.resolve(dataDir, 'tools', 'ppt-doctor');
    const job = path.join(root, 'install-' + randomUUID());
    let registered = false;
    set({ phase: 'checking', message: '正在读取安装清单…', error: null, received: 0, total: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null, openxMiss: null });
    try {
      await fs.mkdir(job, { recursive: true });
      let chosen = null;
      const failures = [];
      for (const base of sources) {
        if (signal.aborted) throw new Error('已取消');
        try {
          const response = await fetch(base, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
          if (!response.ok) throw new Error(`清单 HTTP ${response.status}`);
          if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('安装清单过大');
          const body = await response.text();
          if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('安装清单过大');
          const meta = fullArchive(JSON.parse(body.replace(/^\uFEFF/, '')), base);
          // 公司内源（r24）：公开版按文件名在 openx 找同名附件（大文件是 .000/.001… 分片），版本名固定为 ppt-doctor-<完整包版本>。
          // 清单没给大小：内源命中就用内源附件的大小，外网 ZIP 的 HEAD 被拦、超时也不影响走内源（r24 审查阻断项）；
          // 内源没有才问外网 HEAD。找内源总共最多等 6 秒；内容最终都按清单的 sha256 核对。
          const file = path.posix.basename(new URL(meta.url).pathname);
          const openx = { release: `ppt-doctor-${meta.version}`, unknownBudgetMs: 6000, maxMs: 6000 };
          const sane = n => Number.isSafeInteger(n) && n >= 1 && n <= 4 * 1024 ** 3;
          const externalSize = async () => {
            const head = await fetch(meta.url, { method: 'HEAD', signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
            const n = Number(head.headers.get('content-length'));
            if (!head.ok || /text\/html/i.test(head.headers.get('content-type') || '') || !sane(n)) throw new Error('完整包大小无法确认或被网络确认页挡住');
            return n;
          };
          let bytes = NaN;
          if (openxSource.enabled(process.env)) {
            const hit = await openxSource.findForDownload({ ...openx, file, version: meta.version, fetchImpl: fetch, signal }).catch(() => null);
            if (hit) bytes = await openxSource.headSize(hit, { fetchImpl: fetch, signal });
          }
          const sizedByOpenx = sane(bytes);
          if (!sizedByOpenx) bytes = await externalSize();
          const fetchArchive = (n, viaOpenx) => {
            set({ phase: 'downloading', message: '正在下载 PPT Doctor…', version: meta.version, latestVersion: meta.latestVersion, total: n, received: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null, openxMiss: null });
            return download({ gate: true, sources: [{ id: 'doctor', name: require('../app-update/downloader').friendlySourceName(meta.url), url: meta.url }],
              version: meta.version, openx: viaOpenx ? openx : false, expect: { file, bytes: n, sha256: meta.sha256 },
              dest: path.join(job, 'package.zip'), fetchImpl: fetch, signal,
              onProgress: progress => set(progress) });
          };
          let result = await fetchArchive(bytes, true);
          // 大小取自内源、内源那份又不对：外网按自己 HEAD 到的大小再下一次（不让内源上的坏文件连累外网）。
          if (!result.ok && !result.cancelled && sizedByOpenx) result = await fetchArchive(await externalSize(), false);
          if (!result.ok) throw new Error(result.cancelled ? '已取消' : result.attempts.map(a => a.reason).join('；'));
          set({ source: result.source && result.source.name });
          chosen = meta; break;
        } catch (error) { failures.push(error.message); }
      }
      if (!chosen) throw new Error(failures.join('；') || '没有可用的下载源');
      if (signal.aborted) throw new Error('已取消');
      set({ phase: 'extracting', message: '正在解压并校验联动组件，最多约 3 分钟…' });
      const unpacked = path.join(job, 'app');
      await fs.mkdir(unpacked);
      await extract(path.join(job, 'package.zip'), unpacked);
      if (signal.aborted) throw new Error('已取消');
      const exe = await findExecutable(unpacked);
      const info = await verify(exe);
      if (!info) throw new Error('PPT Doctor 联动能力或程序校验不通过，原有安装未更改');
      if (signal.aborted) throw new Error('已取消');
      // No existing installation is overwritten. Publish the path only after verification succeeds.
      await configure(exe);
      registered = true;
      await fs.unlink(path.join(job, 'package.zip')).catch(() => {});
      set({ phase: 'done', message: `PPT Doctor v${chosen.version} 已安装${chosen.latestVersion !== chosen.version ? '；这是完整基线，后续更新由 PPT Doctor 提供' : ''}`, version: chosen.version, latestVersion: chosen.latestVersion });
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
module.exports = { fullArchive, createDoctorInstaller, extractZip, findExecutable };
