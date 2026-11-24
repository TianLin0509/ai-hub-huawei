'use strict';
// CLI 一键安装（2026-11-07 用户：没装 Claude Code / Codex / DSH 的同事，点一下就装好，不用去官网）。
//
// 流程：读组件目录（签名校验）→ 从公司内源下载（核对字节数和 sha256）
// → 直接解压到 <数据目录>/tools/<组件>/<版本>/ → 核对主程序、试跑一次 --version → 写「装好了」标记 → 写 installed.json。
// 不再「先解压到临时目录、再整体改名」（r31：公司电脑上安全软件扫描新 exe 时整个目录改不了名，一键安装卡在 EPERM）。
// installed.json 才是「装好了」的判据（标记文件 .aihub-ready.json 是旁证）：没写进去的目录都是半成品，下次安装时清掉。
// 任何一步失败都只删这次的目录，已经装好的上一版原样保留；新版装好后上一版留着，再下一次安装时才清掉更早的。
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
const NAMES = { claude: 'Claude Code', codex: 'Codex', dsh: 'DSH 运行环境', node: 'Node.js 运行环境', git: 'Git for Windows', pi: 'pi 终端 Agent' };
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

// 本机的 Node 能不能用：版本 >= minNode。minNode 可以是大版本 22，也可以是完整版本 "22.19.0"（pi 要 22.19，r39 审查）。
async function pathNodeUsable(env, minNode, run = runVersion, name = 'DSH') {
  // 和启动时用同一套查找（core/local-node.js）：PATH 之外的常见目录、CodeAgent 自带的 Node 也算本机有。
  const local = require('../local-node');
  const file = local.findNode({ env, minVersion: String(minNode) }) || local.findNode({ env, minMajor: 0 });
  if (!file) return { ok: false, reason: '本机没有 Node.js' };
  try {
    const out = await run(file, ['--version'], { timeoutMs: 15000, env });
    return local.versionAtLeast(out, minNode) ? { ok: true, file, version: out } : { ok: false, reason: `本机 Node.js 版本是 ${out}，${name} 需要 ${minNode} 或更新` };
  } catch { return { ok: false, reason: '本机的 Node.js 启动不了' }; }
}
// 组件要求的最低 Node：组件目录里写的是大版本（老版本 Hub 只认整数），pi 另按包里 engines 的完整版本（22.19.0）核。
function requiredNode(component) {
  const min = component.install?.minNode || 22;
  if (component.id !== 'pi') return min;
  const pi = require('../pi-cli-profile').PI_MIN_NODE;
  return require('../local-node').versionAtLeast(String(min), pi) ? min : pi;
}

const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const READY_MARK = '.aihub-ready.json';
const cancelledError = () => Object.assign(new Error('已取消'), { cancelled: true });
// 用户点了「取消」就立即停：每一步动手前都看一眼（r31 审查：等占用期间点取消，之前仍会切换版本并报完成）。
function throwIfCancelled(signal) { if (signal && signal.aborted) throw cancelledError(); }
// 可被取消的等待：点取消时立刻醒来。
const sleepMs = (ms, signal) => new Promise(resolve => {
  if (signal && signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', done, { once: true });
});
// 文件被别的程序（多是安全软件在扫描新 exe）占着时等一等再试：250ms 起每次翻倍、单次最多 8 秒，总共约 60 秒。
// 每次尝试前、每次等完后都检查取消；已取消就抛出「已取消」，不再试。
async function retryBusy(fn, { totalMs = 60000, firstMs = 250, maxStepMs = 8000, sleep = sleepMs, codes = BUSY_CODES, signal = null } = {}) {
  for (let waited = 0, step = firstMs; ; step = Math.min(step * 2, maxStepMs)) {
    throwIfCancelled(signal);
    try { return await fn(); }
    catch (error) {
      if (waited >= totalMs || !codes.includes(error && error.code)) throw error;
      const delay = Math.min(step, totalMs - waited);
      await sleep(delay, signal);
      waited += delay;
    }
  }
}
// installed.json 里这一版和上一版占用的 <组件>/ 下的目录名（npm 兜底装的 dsh/user-npm 也算）。
function keptNames(id, record) {
  const dirs = [record?.dir, record?.previousDir || (record?.previous && `${id}/${record.previous}`)];
  return dirs.filter(d => typeof d === 'string').map(d => d.replace(/\\/g, '/').split('/')).filter(p => p[0] === id && p[1]).map(p => p[1]);
}
// 安装器自己建的目录才清：版本目录（数字开头的版本号）、旁装目录（~ 加随机串；含本分支早期的 <版本>~<随机>）、
// 旧版留下的临时目录 .tmp-* 和 <版本>.<随机>.old。DSH 的拼接目录 paired-*（core/dsh-cli-profile.js）、
// npm 兜底装的 user-npm 和其他不认识的目录一律不碰。
const SIDE_PREFIX = '~';
function ownedName(name) {
  return /^\d[0-9A-Za-z.+-]*$/.test(name) || /^\d[0-9A-Za-z.+-]*~[0-9a-f]{6}$/.test(name)
    || /^~[0-9a-f]{6}$/.test(name) || /^\.tmp-[0-9a-f]{8}$/.test(name) || /^\d[0-9A-Za-z.+-]*\.[0-9a-f]{8}\.old$/.test(name);
}
// 正在运行的程序（可执行文件路径和命令行）：还被会话用着的目录不删——DSH 这类 node 脚本被删时不会报「占用」。
// 查不到时返回 null，调用方这次就不清理，留到下次。
function runningCommandLines() {
  return new Promise(resolve => {
    const done = (error, stdout) => resolve(error ? null : String(stdout || '').split(/\r?\n/).filter(Boolean));
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath; $_.CommandLine }'],
      { windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, done);
    } else execFile('ps', ['-axo', 'command='], { windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, done);
  });
}
function referencedBy(lines, dir) {
  const norm = p => { const t = String(p).split('\\').join('/'); return process.platform === 'win32' ? t.toLowerCase() : t; };
  const needle = norm(dir).replace(/\/+$/, '') + '/';
  return lines.some(line => norm(line).includes(needle));
}
async function removeQuietly(target) {
  try { await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
}

const GIT_ADVICE = '没找到 Git for Windows：Claude Code 会改用 PowerShell 执行命令（官方预览功能，复杂命令偶尔不如 bash 顺手），建议装上 Git for Windows。';

// r60：随程序发布的组件目录快照（scripts/refresh-bundled-manifests.js 在发版时刷新）；验签不过或没有快照返回 null。
function bundledCatalog(validate) {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'catalog-snapshot.json'), 'utf8').replace(/^\uFEFF/, ''));
    return validate(raw);
  } catch (_) { return null; }
}

// 快照里的 DSH 条目（只读版本号给手动安装命令用，不拿它下载，所以不验签）。
function bundledDsh() {
  try { return bundledCatalog(raw => raw).components.find(c => c.id === 'dsh') || null; } catch (_) { return null; }
}

function attemptsText(attempts) {
  return (attempts || []).map(a => `${a.name}：${a.status === 'ok' ? '可用' : a.reason || '失败'}`).join('；');
}

function createCliInstaller({ sources = [], fetchImpl, env = process.env, key, onState = () => {},
  run = runVersion, nodeUsable = null,
  idleTimeoutMs, connectTimeoutMs, logger = console, npmRun, getDshEntry = () => ({}), busyRetry = {},
  processLines = runningCommandLines } = {}) {
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
  // r59：同时推到下载进度总线（point = cli:<id>），没接 cli-tools:state 的入口也能挂统一进度条。
  const set = (id, patch) => {
    tools[id] = { ...tools[id], ...patch };
    try { onState(snapshot()); } catch (_) {}
    if (patch.phase || patch.received != null) { try { require('../app-update/progress-bus').emit('cli:' + id, { ...tools[id], message: '' }); } catch (_) {} }
  };
  // 「装到我的全局 npm」/ 修复用户自己那份：装进用户已有的那个目录（核心或界面包所在处）；用户什么都没装时，
  // 明确选了全局（target: 'user-global'）才问 npm 的全局目录（npm prefix -g，读用户自己的 npm 配置）。
  async function dshRepairRoot(target, signal) {
    const entry = getDshEntry() || {};
    const explicit = entry.cliRoot || env.AI_HUB_DSH_CLI_ROOT;
    if (explicit) {
      if (!path.isAbsolute(explicit)) throw new Error('DSH 运行环境目录必须是绝对路径');
      return explicit;
    }
    const profile = require('../dsh-cli-profile');
    let d = null;
    try { d = profile.diagnoseDshRuntime(entry, env); } catch (_) {}
    if (d && d.userRoot) return d.userRoot;
    if (target === 'user-global') {
      const npm = require('./npm-fallback');
      const prefix = String(await (npmRun || npm.runNpm)(['prefix', '-g'], { env, signal, timeoutMs: 30000 }) || '').trim().split(/\r?\n/).pop().trim();
      if (!prefix || !path.isAbsolute(prefix)) throw new Error('没读到你的 npm 全局目录（npm prefix -g），请确认本机装了 npm');
      return prefix;
    }
    return profile.resolveDshCliRuntime(entry, env).root;
  }

  async function loadCatalog(signal) {
    if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
    const validate = raw => catalogLib.validateCatalog(raw, key === undefined ? {} : { key });
    // R29/R35：内源生效时只用随程序发布的签名目录快照（发版时刷新、同一把公钥验签），不去外网读目录；文件只从内源下。
    // 内源不生效（纯 Node 单测、测试注入 AI_HUB_UPDATE_SOURCES）时读给定源上的目录。
    if (require('../app-update/openx-source').active(env)) {
      const snap = bundledCatalog(validate);
      if (!snap) throw new Error('程序自带的组件目录缺失或校验没通过，请更新 Hub 后再试');
      catalog = snap; catalogAt = Date.now(); catalogFrom = sources; return catalog;
    }
    if (!sources.length) throw new Error('这个版本没有配置组件下载源，暂不能一键安装');
    const fetchFn = resolveFetch(fetchImpl);
    const results = await checkManifests({ sources, fetchImpl: fetchFn, validate, signal });
    const ok = results.filter(r => r.ok);
    if (!ok.length) {
      const why = results.map(r => `${r.name}：${r.reason}`).join('；');
      if (signal && signal.aborted) throw new Error('已取消');
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

  // 版本目录：<组件>/<版本>。已有同名目录时：installed.json 记着的或带「装好了」标记的不动（同一版修复安装），
  // 其余是以前中途失败的半成品，先删掉再用；删不掉（文件被占着）或不能动，就换一个旁装目录 ~<6位随机>
  // （7 个字符，比旧版的 .tmp-xxxxxxxx 还短，DSH 的深路径不会因此更接近 260 字符上限）。
  async function pickInstallDir(base, component, record) {
    const name = component.version;
    const full = path.join(base, component.id, name);
    const used = new Set(keptNames(component.id, record));
    if (!fs.existsSync(full)) return { name, full };
    if (!used.has(name) && !fs.existsSync(path.join(full, READY_MARK))) {
      await removeQuietly(full);
      if (!fs.existsSync(full)) return { name, full };
    }
    for (;;) {
      const alt = `${SIDE_PREFIX}${crypto.randomBytes(3).toString('hex')}`;
      if (!fs.existsSync(path.join(base, component.id, alt))) return { name: alt, full: path.join(base, component.id, alt) };
    }
  }

  // 一个组件：下载 → 校验 → 解压到版本目录 → 试跑 → 写标记和 installed.json。返回装好的版本信息。
  async function installOne(component, signal, progress) {
    const base = root();
    const staging = path.join(base, '.staging', `${component.id}-${crypto.randomUUID().slice(0, 8)}`);
    const file = component.files[0];
    const download = path.join(staging, 'download', file.name);
    // 目录名尽量短：DSH 的 node_modules 里最深的路径有 170 多个字符，整体要留在 Windows 260 字符以内。
    let unpack = null, done = false;
    try {
      const list = catalogLib.fileSources(component, file, catalogFrom);
      const expect = { file: file.name, bytes: file.bytes, sha256: file.sha256 };
      const go = () => downloadWithFallback({ sources: list, version: component.version, openx: { release: `cli-${component.id}-${component.version}`, env }, expect, dest: download,
        fetchImpl: resolveFetch(fetchImpl), signal, idleTimeoutMs, connectTimeoutMs,
        onProgress: p => progress({ phase: 'downloading', received: p.received, total: p.total, speed: p.speed, etaSec: p.etaSec, sourceId: p.sourceId, sourceName: p.sourceName }),
        onAttempt: attempts => progress({ attempts: attempts.map(a => ({ name: a.name, status: a.status, reason: a.reason, blocked: !!a.blocked, url: a.url })) }) });
      const result = await go();
      if (!result.ok) {
        if (result.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
        const err = new Error(`${component.name}没下载成功（${attemptsText(result.attempts)}）`);
        err.blocked = (result.attempts || []).find(a => a.blocked)?.url || null;
        err.reasonText = attemptsText(result.attempts);
        err.componentId = component.id;
        throw err;
      }
      // 下载器边下边算过 sha256；这里只是让界面停在「校验」一下，表示已核对。
      progress({ phase: 'verifying' });
      progress({ phase: 'installing', files: 0 });
      const before = registry.readInstalled(base).tools[component.id];
      throwIfCancelled(signal);
      const target = await pickInstallDir(base, component, before);
      unpack = target.full;
      await fs.promises.mkdir(unpack, { recursive: true });
      if (component.kind === 'exe') {
        const bin = path.join(unpack, ...component.install.bin.split('/'));
        await fs.promises.mkdir(path.dirname(bin), { recursive: true });
        await retryBusy(() => fs.promises.copyFile(download, bin), { ...busyRetry, signal });
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
      else if (component.install.versionArgs && ['dsh', 'pi'].includes(component.id)) {
        const node = component.id === 'pi' ? require('../pi-cli-profile').nodeFor(env)
          : registry.managedBin('node', env) || require('../local-node').findNode({ env });
        if (!node && component.id === 'pi') throw new Error(`${component.name}需要 Node.js ${requiredNode(component)} 或更新版本，本机没有找到，没有登记为装好`);
        const entry = component.id === 'pi' ? require('../pi-cli-profile').PI_ENTRY : registry.DSH_RUNTIME_FILES[0];
        if (node) probe = [node, [path.join(unpack, 'node_modules', ...entry.split('/')), ...component.install.versionArgs]];
      }
      if (probe) {
        progress({ phase: 'probing' });
        // 安全软件正在扫描新 exe 时启动会报 EBUSY/EPERM：按退避等它扫完再试。
        try { await retryBusy(() => run(probe[0], probe[1], { env }), { ...busyRetry, signal }); }
        catch (error) {
          if (error.cancelled) throw error;
          throw new Error(`${component.name}已下载，但试运行没有通过（${error.killed ? '90 秒内没有响应' : String(error.message || '').slice(0, 120)}）。`
            + '可能是安全软件正在扫描或拦截，请稍后重试');
        }
      }
      throwIfCancelled(signal);
      await fs.promises.writeFile(path.join(unpack, READY_MARK),
        JSON.stringify({ id: component.id, version: component.version, sha256: file.sha256, readyAt: new Date().toISOString() }), 'utf8');
      const installed = registry.readInstalled(base);
      const dir = `${component.id}/${target.name}`;
      const changed = before && before.version !== component.version;
      const previous = changed ? { previous: before.version, previousDir: before.dir }
        : before?.previous ? { previous: before.previous, previousDir: before.previousDir || `${component.id}/${before.previous}` } : {};
      const record = { version: component.version, dir,
        ...(component.install.bin ? { bin: component.install.bin } : {}),
        ...(component.install.pathDirs ? { pathDirs: component.install.pathDirs } : {}),
        installedAt: new Date().toISOString(), sha256: file.sha256, ...previous };
      await retryBusy(async () => registry.writeInstalled(base, { tools: { ...installed.tools, [component.id]: record } }), { ...busyRetry, signal });
      done = true;
      // 只留这一版和上一版；更早的版本、以前失败留下的半成品（含旧版的 .tmp-*、*.old）都清掉。
      // 只清安装器自己建的目录；还被正在运行的会话用着的、删不掉的（还被占着）都留到下次。
      const keep = new Set(keptNames(component.id, record));
      const stale = fs.readdirSync(path.join(base, component.id)).filter(name => !keep.has(name) && ownedName(name));
      if (stale.length) {
        const lines = await processLines();
        for (const name of stale) {
          const dir = path.join(base, component.id, name);
          if (lines && !referencedBy(lines, dir)) await removeQuietly(dir);
        }
      }
      return record;
    } finally {
      await removeQuietly(staging);
      if (unpack && !done) await removeQuietly(unpack);
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

  // pi 的 npm 后备：先保证有 22.19 以上的 Node。本机没有就从组件目录补装 Hub 自管的 Node（和主路径一样），补不上就说清楚。
  async function ensurePiNode(signal, progress) {
    const pi = require('../pi-cli-profile');
    let node = pi.nodeFor(env);
    if (node) return node;
    let reason = '';
    try {
      const cat = catalog || await loadCatalog(signal);
      const comp = cat.components.find(c => c.id === 'node');
      if (!comp) reason = '组件目录里没有 Node.js';
      else if (!require('../local-node').versionAtLeast(comp.version, pi.PI_MIN_NODE)) reason = `组件目录里的 Node.js 是 ${comp.version}，不够新`;
      else {
        const step = { index: 1, count: 2, name: comp.name };
        progress({ phase: 'downloading', step, received: 0, total: comp.files[0].bytes });
        await installOne(comp, signal, patch => progress({ ...patch, step }));
        node = pi.nodeFor(env);
        if (!node) reason = 'Hub 装好的 Node.js 没有通过版本检查';
      }
    } catch (e) {
      if (e.cancelled || signal.aborted) throw e;
      reason = e.message;
    }
    if (node) return node;
    throw new Error(`pi 需要 Node.js ${pi.PI_MIN_NODE} 或更新版本，本机没有找到，Hub 也没能补装（${reason}）。请先安装 Node.js ${pi.PI_MIN_NODE} 或更新版本，再点一次「一键安装 pi」`);
  }

  async function install(id, { repair = false, target } = {}) {
    if (!registry.IDS.includes(id) || id === 'node') throw new Error('不认识的组件');
    if (busy) {
      if (busy === id) return snapshot();
      throw new Error(`正在安装 ${NAMES[busy]}，请等它装完再装下一个`);
    }
    busy = id;
    abort = new AbortController();
    const signal = abort.signal;
    set(id, { phase: 'checking', error: null, blocked: null, received: 0, total: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null, files: 0, attempts: [], step: null });
    try { work: {
      // repair（「装到我的全局 npm」）：按界面包要求把配套版本以 npm 全局模式装进用户自己的目录（生成 dsh.cmd，终端里能直接用）。
      // 不带 repair 的默认动作永远装进 Hub 自管目录，与识别到哪个目录、设置里指定了哪个目录无关，绝不写用户目录
      // （r26a 审查：以前指定了 DSH 目录时默认按钮会直接 npm 写进那个目录）。指定目录不完整时，识别会改用 Hub 自管的那份
      // （core/dsh-cli-profile.js），所以这里装好立即生效。
      if (id === 'dsh' && repair) {
        const result = await require('./npm-fallback').installDshWithUserNpm({ env, signal, run: npmRun, global: true,
          targetRoot: await dshRepairRoot(target, signal), onProgress: patch => set(id, patch) });
        set(id, { phase: 'done', error: null, version: result.version, source: result.source, finishedAt: Date.now() });
        break work;
      }
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
      const minNode = requiredNode(main);
      const hubNode = registry.managed('node', env);
      const local = require('../local-node');
      // Hub 自管的 Node 也要核版本（r39 审查：以前有就跳过，22.0 的自管 Node 也当够用）。
      if (main.install.requires?.includes('node') && !(hubNode && local.versionAtLeast(local.nodeVersion(hubNode.bin) || hubNode.version, minNode))) {
        const check = nodeUsable ? await nodeUsable(minNode) : await pathNodeUsable(env, minNode, run, NAMES[id]);
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
      // pi（r39）：组件目录里还没有 pi 或下载失败时，按用户自己的 npm 配置装进 Hub 自管目录（不改全局 npm）。
      if (id === 'pi' && !cancelled && !/签名|校验不一致|校验没通过|文件大小不对/.test(error.message)) {
        const targetRoot = path.join(root(), 'pi', 'user-npm');
        try {
          // 后备也要先有够版本的 Node（r39 审查：以前只看文件和版本号就报装好，Node 不够或入口跑不起来也算成功）。
          const node = await ensurePiNode(signal, patch => set(id, { ...patch, fallbackReason: error.message }));
          const result = await require('./npm-fallback').installPiWithUserNpm({ env, signal, run: npmRun, targetRoot, node,
            probe: (file, args) => retryBusy(() => run(file, args, { env }), { ...busyRetry, signal }),
            onProgress: patch => set(id, { ...patch, fallbackReason: error.message, step: null }) });
          const installed = registry.readInstalled(root());
          installed.tools.pi = { version: result.version, dir: path.relative(root(), targetRoot), installedAt: Date.now() };
          registry.writeInstalled(root(), installed);
          set(id, { phase: 'done', error: null, blocked: null, version: result.version, source: result.source, finishedAt: Date.now() });
        } catch (npmError) {
          const stopped = signal.aborted || npmError.name === 'AbortError';
          // 试运行没过：以前登记过的同一目录已被覆盖成跑不起来的文件，撤掉登记，体检如实显示没装好。
          try {
            const installed = registry.readInstalled(root());
            if (installed.tools.pi && path.resolve(root(), installed.tools.pi.dir) === path.resolve(targetRoot)) {
              delete installed.tools.pi; registry.writeInstalled(root(), installed);
            }
          } catch (_) {}
          set(id, { phase: stopped ? 'cancelled' : 'error', error: stopped ? null
            : `${error.message}；按你的 npm 配置安装 pi 也没有成功：${String(npmError.stderr || npmError.message).slice(0, 800)}`, blocked: error.blocked || null });
        }
      } else if (id === 'dsh' && !repair && !cancelled && error.reasonText && error.componentId === 'dsh') {
        // R37（2026-11-24）/ R35：下载只走公司内源，不落回 npm（公司内部 npm 源缺 DSH 同代插件，会卡到 npm 超时）。
        // 一行写清原因和能照抄的手动安装命令（版本取自程序自带的组件快照；体检认出缺哪些插件就只补那些）。
        let diagnosis = null;
        try { diagnosis = require('../dsh-cli-profile').diagnoseDshRuntime(getDshEntry() || {}, env); } catch (_) {}
        const ver = (catalog && catalog.components.find(c => c.id === 'dsh') || bundledDsh() || {}).version || '';
        const cmd = require('./npm-fallback').dshManualCommand({ catalogVersion: ver, diagnosis });
        set(id, { phase: 'error', blocked: error.blocked || null, manualCommand: cmd,
          error: `DSH 运行环境 ${ver || ''} 没能从公司内源装上（${error.reasonText || error.message}）。Hub 只从内源下载，不改走 npm；可先在终端手动安装：${cmd}，装好后点「重新检测」` });
      // R35：DSH 组件下载失败不再自动改走 npm（下载只走公司内源）；Node 补装失败、试运行没过等照实报原因（R37 审查 #4）。
      } else set(id, { phase: cancelled ? 'cancelled' : 'error', error: cancelled ? null : error.message, blocked: error.blocked || null });
    } finally {
      busy = null;
      abort = null;
      if (id === 'git') gitBash.invalidate();
    }
    return snapshot();
  }

  return { snapshot, install, refreshGit, cancel: () => { abort?.abort(); return snapshot(); }, loadCatalog };
}

module.exports = { createCliInstaller, runVersion, pathNodeUsable, retryBusy, ownedName, runningCommandLines, NAMES, fmtBytes, READY_MARK };
