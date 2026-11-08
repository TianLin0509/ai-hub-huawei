'use strict';
// CLI 一键安装（2026-11-07 用户：没装 Claude Code / Codex / DSH 的同事，点一下就装好，不用去官网）。
//
// 流程：读组件目录（签名校验）→ 下载（多源依次试，每个源都核对字节数和 sha256，被公司网络放行页拦住就自动放行再试）
// → 解压到临时目录 → 核对主程序、试跑一次 --version → 改名成 <数据目录>/tools/<组件>/<版本>/ → 写 installed.json。
// 任何一步失败都只删这次的临时文件，已经装好的上一版原样保留；新版装好后上一版留着，再下一次安装时才清掉更早的。
// 全程在用户自己的数据目录里，不要管理员权限；起的进程都隐藏窗口。
// DSH 需要 Node 22+：本机没有或版本太低时，顺带装组件目录里的 node。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { checkManifests, downloadWithFallback, fmtBytes } = require('../app-update/downloader');
const catalogLib = require('./catalog');
const registry = require('./registry');
const { extractTgz } = require('./tar');

const CATALOG_TTL_MS = 10 * 60 * 1000;
const NAMES = { claude: 'Claude Code', codex: 'Codex', dsh: 'DSH 运行环境', node: 'Node.js 运行环境', git: 'Git for Windows' };
const gitBash = require('../git-bash');

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  return globalThis.fetch;
}

// 试跑一次（隐藏窗口）：装好的程序能启动才算装好。
function runVersion(file, args, { timeoutMs = 90000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout || '').trim()));
  });
}

// 本机的 Node 能不能给 DSH 用：PATH 上第一个 node.exe，版本 >= minNode。
async function pathNodeUsable(env, minNode, run = runVersion) {
  const file = require('../company-model-proxy').findNodeOnPath(env);
  if (!file) return { ok: false, reason: '本机没有 Node.js' };
  try {
    const out = await run(file, ['--version'], { timeoutMs: 15000, env });
    const major = Number((/^v?(\d+)\./.exec(out) || [])[1]);
    return major >= minNode ? { ok: true, file, version: out } : { ok: false, reason: `本机 Node.js 版本是 ${out}，DSH 需要 ${minNode} 或更新` };
  } catch { return { ok: false, reason: '本机的 Node.js 启动不了' }; }
}

async function renameWithRetry(from, to, tries = 40) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; }
    catch (error) {
      // 刚解压出来的 exe 常被杀毒软件扫描占用几秒；等一等再改名。
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
async function removeQuietly(target) {
  try { await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
}

const GIT_ADVICE = '没找到 Git for Windows：Claude Code 会改用 PowerShell 执行命令（官方预览功能，复杂命令偶尔不如 bash 顺手），建议装上 Git for Windows。';

function attemptsText(attempts) {
  return (attempts || []).map(a => `${a.name}：${a.status === 'ok' ? '可用' : a.reason || '失败'}`).join('；');
}

function createCliInstaller({ sources = [], fetchImpl, env = process.env, key, onState = () => {},
  unblock = null, isOwnUrl = () => false, unblockPassed = () => {}, run = runVersion, nodeUsable = null,
  idleTimeoutMs, connectTimeoutMs, logger = console } = {}) {
  const root = () => registry.toolsRoot(env);
  let catalog = null, catalogAt = 0, catalogFrom = [];
  let busy = null, abort = null;
  const tools = {};
  for (const id of registry.IDS) tools[id] = { phase: 'idle' };

  function snapshot() {
    const installed = {};
    for (const id of registry.IDS) { const m = registry.managed(id, env); if (m) installed[id] = { version: m.version, dir: m.dir }; }
    // Git Bash（2026-11-07）：Claude Code 优先用它执行命令，没有时改用 PowerShell。git 为 null 表示这台电脑上没找到，
    // 界面在 Claude Code 的安装区块里给「一键安装 Git for Windows」。
    let git = null, advice = null;
    if (process.platform === 'win32') {
      try { const hit = gitBash.locateGitBash(env); git = hit ? { bash: hit.bash, source: hit.source } : null; } catch (_) {}
      if (!git && installed.claude) advice = { claude: GIT_ADVICE };
    }
    return { available: sources.length > 0, busy, tools: JSON.parse(JSON.stringify(tools)), installed, advice, git,
      catalog: catalog ? catalog.components.map(c => ({ id: c.id, name: c.name, version: c.version, license: c.license,
        bytes: c.files.reduce((n, f) => n + f.bytes, 0) })) : null };
  }
  const set = (id, patch) => { tools[id] = { ...tools[id], ...patch }; try { onState(snapshot()); } catch (_) {} };

  async function tryUnblock(url) {
    if (!unblock || !isOwnUrl(url)) return false;
    try { const ok = !!(await unblock(url)); if (ok) { try { unblockPassed(); } catch (_) {} } return ok; }
    catch (error) { logger.warn?.('[cli-tools] 自动放行出错：', error.message); return false; }
  }

  async function loadCatalog(signal) {
    if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
    if (!sources.length) throw new Error('这个版本没有配置组件下载源，暂不能一键安装');
    const validate = raw => catalogLib.validateCatalog(raw, key === undefined ? {} : { key });
    const fetchFn = resolveFetch(fetchImpl);
    let results = await checkManifests({ sources, fetchImpl: fetchFn, validate, signal });
    const blocked = results.find(r => !r.ok && r.blocked);
    if (blocked && await tryUnblock(blocked.url)) results = await checkManifests({ sources, fetchImpl: fetchFn, validate, signal });
    const ok = results.filter(r => r.ok);
    if (!ok.length) {
      const why = results.map(r => `${r.name}：${r.reason}`).join('；');
      throw Object.assign(new Error(`读不到组件目录（${why}）`), { blocked: results.find(r => r.blocked)?.url || null });
    }
    // 取发布时间最新的那份目录（高速镜像每 5 分钟才同步一次，刚发的组件可能只在旧服务器上）；一样新时按源的顺序。
    // 目录和它一样新的源排在前面下载；其余的源留作后备（文件可能还在）。
    const when = r => Date.parse(r.manifest.publishedAt) || 0;
    const best = ok.reduce((a, r) => (when(r) > when(a) ? r : a), ok[0]);
    const same = ok.filter(r => when(r) === when(best));
    catalog = best.manifest;
    catalogAt = Date.now();
    catalogFrom = [...sources.filter(s => same.some(r => r.id === s.id)), ...sources.filter(s => !same.some(r => r.id === s.id))];
    return catalog;
  }

  // 一个组件：下载 → 校验 → 解压 → 试跑 → 转正。返回装好的版本信息。
  async function installOne(component, signal, progress) {
    const base = root();
    const staging = path.join(base, '.staging', `${component.id}-${crypto.randomUUID().slice(0, 8)}`);
    const file = component.files[0];
    const download = path.join(staging, 'download', file.name);
    // 临时目录名尽量短：DSH 的 node_modules 里最深的路径有 170 多个字符，整体要留在 Windows 260 字符以内。
    const unpack = path.join(base, component.id, `.tmp-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const list = catalogLib.fileSources(component, file, catalogFrom);
      const expect = { file: file.name, bytes: file.bytes, sha256: file.sha256 };
      const go = () => downloadWithFallback({ sources: list, version: component.version, expect, dest: download,
        fetchImpl: resolveFetch(fetchImpl), signal, idleTimeoutMs, connectTimeoutMs,
        onProgress: p => progress({ phase: 'downloading', received: p.received, total: p.total, speed: p.speed, sourceName: p.sourceName }),
        onAttempt: attempts => progress({ attempts: attempts.map(a => ({ name: a.name, status: a.status, reason: a.reason, blocked: !!a.blocked, url: a.url })) }) });
      let result = await go();
      const blocked = !result.ok && !result.cancelled && (result.attempts || []).find(a => a.blocked);
      if (blocked && await tryUnblock(blocked.url)) result = await go();
      if (!result.ok) {
        if (result.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
        const err = new Error(`${component.name}没下载成功（${attemptsText(result.attempts)}）`);
        err.blocked = (result.attempts || []).find(a => a.blocked)?.url || null;
        throw err;
      }
      // 下载器边下边算过 sha256；这里只是让界面停在「校验」一下，表示已核对。
      progress({ phase: 'verifying' });
      progress({ phase: 'installing', files: 0 });
      await removeQuietly(unpack);
      if (component.kind === 'exe') {
        const bin = path.join(unpack, ...component.install.bin.split('/'));
        await fs.promises.mkdir(path.dirname(bin), { recursive: true });
        await fs.promises.copyFile(download, bin);
      } else {
        let last = 0;
        await extractTgz(download, unpack, { strip: component.install.strip || '', signal,
          onEntry: ({ files }) => { const now = Date.now(); if (now - last > 200) { last = now; progress({ phase: 'installing', files }); } } });
      }
      const must = [...(component.install.bin ? [component.install.bin] : []), ...(component.install.check || []),
        ...(component.id === 'dsh' ? registry.DSH_RUNTIME_FILES.map(f => 'node_modules/' + f) : [])];
      for (const rel of must) {
        if (!fs.existsSync(path.join(unpack, ...rel.split('/')))) throw new Error(`${component.name}的安装包里缺少 ${rel}，没有装上`);
      }
      // DSH 没有自己的 exe：用它将来要用的 node（Hub 刚装的，或本机 PATH 上的）跑一次入口脚本。
      let probe = null;
      if (component.install.versionArgs && component.install.bin) probe = [path.join(unpack, ...component.install.bin.split('/')), component.install.versionArgs];
      else if (component.install.versionArgs && component.id === 'dsh') {
        const node = registry.managedBin('node', env) || require('../company-model-proxy').findNodeOnPath(env);
        if (node) probe = [node, [path.join(unpack, 'node_modules', ...registry.DSH_RUNTIME_FILES[0].split('/')), ...component.install.versionArgs]];
      }
      if (probe) {
        progress({ phase: 'probing' });
        try { await run(probe[0], probe[1], { env }); }
        catch (error) {
          throw new Error(`${component.name}已下载，但试运行没有通过（${error.killed ? '90 秒内没有响应' : String(error.message || '').slice(0, 120)}）。`
            + '可能是安全软件正在扫描或拦截，请稍后重试');
        }
      }
      // 转正：<组件>/<版本>/ 已存在（以前装过同一版又被改坏）就先挪开，新的改名进去后再删旧的。
      const final = path.join(base, component.id, component.version);
      let aside = null;
      if (fs.existsSync(final)) { aside = `${final}.${crypto.randomUUID().slice(0, 8)}.old`; await renameWithRetry(final, aside); }
      try { await renameWithRetry(unpack, final); }
      catch (error) { if (aside) { try { await renameWithRetry(aside, final); } catch (_) {} } throw new Error(`安装目录改名失败：${error.message}`); }
      if (aside) await removeQuietly(aside);
      const installed = registry.readInstalled(base);
      const before = installed.tools[component.id];
      const record = { version: component.version, dir: `${component.id}/${component.version}`,
        ...(component.install.bin ? { bin: component.install.bin } : {}),
        ...(component.install.pathDirs ? { pathDirs: component.install.pathDirs } : {}),
        installedAt: new Date().toISOString(), sha256: file.sha256,
        ...(before && before.version !== component.version ? { previous: before.version } : before?.previous ? { previous: before.previous } : {}) };
      registry.writeInstalled(base, { tools: { ...installed.tools, [component.id]: record } });
      // 只留这一版和上一版；更早的版本、以前失败留下的临时目录都清掉。
      const keep = new Set([component.version, record.previous].filter(Boolean));
      for (const name of fs.readdirSync(path.join(base, component.id))) {
        if (!keep.has(name)) await removeQuietly(path.join(base, component.id, name));
      }
      return record;
    } finally {
      await removeQuietly(staging);
      await removeQuietly(unpack);
    }
  }

  // 后台深度找一遍 Git Bash（注册表、各硬盘、VS 自带），找到了就推一次新状态，界面不再提示安装。
  let gitSearch = null;
  function refreshGit() {
    if (process.platform !== 'win32' || gitSearch) return gitSearch;
    const before = snapshot().git;
    gitSearch = gitBash.searchGitBash(env).then(() => {
      const now = snapshot();
      if ((now.git && now.git.bash) !== (before && before.bash)) { try { onState(now); } catch (_) {} }
      return now.git;
    }).catch(() => null).finally(() => { gitSearch = null; });
    return gitSearch;
  }

  async function install(id) {
    if (!registry.IDS.includes(id) || id === 'node') throw new Error('不认识的组件');
    if (busy) {
      if (busy === id) return snapshot();
      throw new Error(`正在安装 ${NAMES[busy]}，请等它装完再装下一个`);
    }
    busy = id;
    abort = new AbortController();
    const signal = abort.signal;
    set(id, { phase: 'checking', error: null, blocked: null, received: 0, total: 0, files: 0, attempts: [], step: null });
    try { work: {
      // Git：先全局找一遍（注册表、各硬盘、VS 自带的），本机已有就不重复装。查找期间界面显示「正在全局查找」、别的组件排队。
      if (id === 'git') {
        const hit = await gitBash.searchGitBash(env, { force: true }).catch(() => null);
        if (hit) { set(id, { phase: 'done', error: null, found: hit.bash, foundSource: hit.source, finishedAt: Date.now() }); break work; }
      }
      // 上次 Hub 中途退出留下的临时下载：安装一次只跑一个，这里整个清掉。
      await removeQuietly(path.join(root(), '.staging'));
      const cat = await loadCatalog(signal);
      const main = cat.components.find(c => c.id === id);
      if (!main) throw new Error(`组件目录里还没有${NAMES[id]}，请联系管理员上传`);
      const plan = [main];
      if (main.install.requires?.includes('node') && !registry.managed('node', env)) {
        const minNode = main.install.minNode || 22;
        const check = nodeUsable ? await nodeUsable(minNode) : await pathNodeUsable(env, minNode, run);
        if (!check.ok) {
          const node = cat.components.find(c => c.id === 'node');
          if (!node) throw new Error(`${check.reason}，组件目录里也没有 Node.js，请先安装 Node.js ${minNode} 或更新版本`);
          plan.unshift(node);
        }
      }
      const total = plan.reduce((n, c) => n + c.files[0].bytes, 0);
      let doneBytes = 0;
      for (let i = 0; i < plan.length; i++) {
        const c = plan[i];
        const step = { index: i + 1, count: plan.length, name: c.name };
        set(id, { phase: 'downloading', step, received: doneBytes, total, version: main.version });
        await installOne(c, signal, patch => set(id, { ...patch, step, total,
          ...(patch.received !== undefined ? { received: doneBytes + patch.received } : {}) }));
        doneBytes += c.files[0].bytes;
      }
      set(id, { phase: 'done', received: total, total, error: null, version: main.version, finishedAt: Date.now() });
    } } catch (error) {
      const cancelled = error.cancelled || signal.aborted;
      set(id, { phase: cancelled ? 'cancelled' : 'error', error: cancelled ? null : error.message, blocked: error.blocked || null });
    } finally {
      busy = null;
      abort = null;
      if (id === 'git') gitBash.invalidate();
    }
    return snapshot();
  }

  return { snapshot, install, refreshGit, cancel: () => { abort?.abort(); return snapshot(); }, loadCatalog };
}

module.exports = { createCliInstaller, runVersion, pathNodeUsable, NAMES, fmtBytes };
