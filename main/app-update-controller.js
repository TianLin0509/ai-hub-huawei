'use strict';
// 一键更新的主进程控制器（2026-10-13，公司版）：查版本 → 下载（多源自动切换）→ 暂存 → 用户点「立即重启」替换。
// 只有发行目标写了 update（community-edition.json）才会创建；主仓库和公开社区版没有这个入口。
// 状态全部推给渲染进程（app-update:state），界面照着画。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateManifest, planUpdate, currentRuntime, compareVersions, isNotableUpdate } = require('../core/app-update/manifest');
const { checkManifests, downloadWithFallback } = require('../core/app-update/downloader');
const { stageIncremental, stagingPaths, launchHelper, takeLastResult, canWriteDir } = require('../core/app-update/apply');
const { verifyLocalFiles } = require('../core/app-update/payload');

const STARTUP_CHECK_DELAY_MS = 20000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;
// 小版本静默送达：只改末位的版本不打扰用户（不弹窗、不挂红点），但也要真的送到。后台下载校验，用户下次关闭 Hub 时隐藏替换、不重开，
// 下次打开就是新版，并由更新日志告诉用户多了什么。装在受保护目录（要管理员授权）的不静默，仍走设置菜单。用户可以在更新窗口里关掉。
const QUIET_OFF_FILE = 'quiet-updates-off.flag';

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  return globalThis.fetch;
}

// 测试用 AI_HUB_UPDATE_SOURCES（JSON 数组）把源换成本机服务；否则用发行目标里写的。
function resolveSources(config, env) {
  if (env.AI_HUB_UPDATE_SOURCES) {
    const list = JSON.parse(env.AI_HUB_UPDATE_SOURCES);
    if (!Array.isArray(list) || !list.length) throw new Error('AI_HUB_UPDATE_SOURCES 必须是非空数组');
    return list;
  }
  const list = config && Array.isArray(config.sources) ? config.sources : [];
  return list.filter(s => s && s.id && /^https:\/\//.test(String(s.manifest || '')) && /^https:\/\//.test(String(s.files || '')));
}

function createAppUpdateController({ app, config, dataDir, currentVersion, sendToRenderer = () => {}, logger = console,
  // 自家阿里云被公司网络放行页拦住时：在看不见的窗口里自动放行一次再重试（core/net-unblock.js，2026-10-29 用户选默认开、无感）。
  // unblock(url) → 是否点到了放行按钮；isOwnUrl(url) → 是不是自家地址（GitHub 被拦不碰）。
  unblock = null, isOwnUrl = () => false, unblockPassed = () => {},
  env = process.env, fetchImpl, resourcesPath = process.resourcesPath, isPackaged = !!(app && app.isPackaged), spawnImpl = spawn,
  // 拉起新程序用的干净环境与工作目录（core/clean-launch-env.js，2026-10-19）：main.js 传入；没传时按当前环境现算。
  prepareLaunch = () => require('../core/clean-launch-env').prepareHubLaunch({ env, isPackaged, appRoot: app && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined }),
  restartWait = () => null,
  // 点「立即重启」后最多等替换脚本留下「已开始」标记这么久，看不到就不退出（杀软重的电脑上 PowerShell 启动就要好几秒）。
  helperStartWaitMs = Number(env.AI_HUB_UPDATE_HELPER_WAIT_MS) || 15000,
  // 小版本静默送达（11-07 定：先不上线）：默认关，代码保留；测试或日后放开时传 true 或设 AI_HUB_QUIET_UPDATE=1。
  quietDelivery = env.AI_HUB_QUIET_UPDATE === '1' }) {
  let sources = resolveSources(config, env);
  let allowSame = !!(config && config.switchEdition);
  const releasePage = (config && config.releasePage) || '';
  let state = { phase: 'idle', current: currentVersion, sources: sources.map(s => ({ id: s.id, name: s.name })), releasePage, canApply: isPackaged || env.AI_HUB_UPDATE_FORCE_APPLY === '1' };
  let manifest = null, plan = null, abort = null, checkAbort = null, staged = null, checking = null, lastResult = null, timer = null;
  const quietTried = new Set();
  const quietOffFile = () => path.join(stagingPaths(dataDir).root, QUIET_OFF_FILE);
  const quietEnabled = () => { if (!quietDelivery) return false; try { return !fs.existsSync(quietOffFile()); } catch (_) { return true; } };
  // 查版本时清单里就是这一版的源：下载先走它们，查不到或版本不同的源只留作后备，免得先报一次 404（旧 GitHub 库改私有后实测，2026-10-28）。
  let confirmedIds = [];

  try { lastResult = takeLastResult(dataDir); } catch (error) { logger.warn?.('[app-update] 读取上次结果失败：', error.message); }
  if (lastResult) state.lastResult = lastResult;
  state.quietEnabled = quietEnabled();
  state.quietFeature = !!quietDelivery;

  // 界面看到的 = 控制器状态 + 等待重启的状态（读不到就当没在等）。
  const view = () => { let wait = null; try { wait = restartWait() || null; } catch (_) {} return { ...state, restartWait: wait }; };
  const emit = patch => { state = { ...state, ...patch }; try { sendToRenderer('app-update:state', view()); } catch (_) {} return state; };

  async function check({ silent = false, quietAllowed = silent } = {}) {
    if (checking) return checking;
    if (state.phase === 'ready' && state.quiet && silent) {
      let discarded = false;
      checking = revalidateQuiet().then(result => { discarded = result; return state; }).finally(() => { checking = null; checkAbort = null; });
      await checking;
      return discarded ? check({ silent, quietAllowed }) : state;
    }
    if (['downloading', 'ready'].includes(state.phase)) return state;
    checking = (async () => {
      if (!silent) emit({ phase: 'checking', error: null });
      const fetchFn = resolveFetch(fetchImpl);
      checkAbort = new AbortController();
      let results = await checkManifests({ sources, fetchImpl: fetchFn, validate: validateManifest, signal: checkAbort.signal });
      if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
      const blockedOwn = results.find(r => r.blocked && !r.ok && isOwnUrl(r.url));
      if (blockedOwn && unblock && await tryUnblock(blockedOwn.url)) {
        results = await checkManifests({ sources, fetchImpl: fetchFn, validate: validateManifest, signal: checkAbort.signal });
        if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
        // 放行成功：清掉放行器的连续失败计数（不然累计 3 次就进 30 分钟冷却）
        if (results.some(r => r.ok && r.id === blockedOwn.id)) { try { unblockPassed(); } catch (_) {} }
      }
      const checks = results.map(r => ({ id: r.id, name: r.name, ok: r.ok, version: r.ok ? r.manifest.version : null, reason: r.reason || null,
        ...(r.blocked ? { blocked: true, url: r.url } : {}) }));
      const best = results.filter(r => r.ok).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
      if (!best) return emit({ phase: silent ? 'idle' : 'error', checks, checkedAt: new Date().toISOString(),
        error: '所有更新源都连不上，暂时查不到新版本', silentFailure: silent });
      manifest = best.manifest;
      confirmedIds = results.filter(r => r.ok && compareVersions(r.manifest.version, manifest.version) === 0).map(r => r.id);
      // 能核对本机文件时才走小包（开发运行、没打包又没指定 resources 时无从核对）。
      const resDir = isPackaged || env.AI_HUB_UPDATE_RESOURCES ? (env.AI_HUB_UPDATE_RESOURCES || resourcesPath) : null;
      let runtime;
      try { runtime = currentRuntime({ resourcesPath: resDir }); }
      catch (_) { runtime = { electron: process.versions.electron, native: {} }; }
      if (!isPackaged && !env.AI_HUB_UPDATE_RESOURCES) runtime = { ...runtime, native: { ...manifest.runtime.native } };
      plan = planUpdate(manifest, { version: currentVersion, runtime, allowSame });
      let variant = null;
      if (plan.kind === 'incremental') {
        const delta = manifest.incrementalDelta;
        if (delta && resDir && verifyLocalFiles(delta.requires, resDir).ok) variant = 'delta';
        else if (manifest.incremental) {
          variant = 'complete';
          // 小包的前提是本机那些没变的文件确实还是上一版的样子；对不上就退回完整更新包，仍然一步升到最新版。
          if (delta) plan = { ...plan, reason: '本机有些程序文件和这一版对不上，改为下载完整更新包（仍是一步升到最新版）' };
        } else plan = { kind: 'full', reason: '这一版只提供变化的程序文件，本机的程序文件对不上，需要完整安装包' };
      }
      const asset = plan.kind === 'incremental' ? (variant === 'delta' ? manifest.incrementalDelta : manifest.incremental) : plan.kind === 'full' ? manifest.installer : null;
      plan = { ...plan, variant, asset };
      const checked = emit({ phase: plan.kind === 'none' ? 'none' : 'available', checks, checkedAt: new Date().toISOString(), error: null,
        latest: { version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt, sourceName: best.name, notify: isNotableUpdate(currentVersion, manifest.version) },
        plan: { kind: plan.kind, variant: plan.variant, reason: plan.reason, bytes: plan.asset ? plan.asset.bytes : 0, file: plan.asset ? plan.asset.file : null } });
      if (quietAllowed && shouldQuietDownload(resDir)) void quietDownload();
      return checked;
    })().catch(error => emit({ phase: silent ? 'idle' : 'error', error: `检查更新失败：${error.message}` }))
      .finally(() => { checking = null; checkAbort = null; });
    return checking;
  }

  // 只有后台自动查到的、只改末位、走增量、能直接写安装目录的才静默；同一版本失败一次就不再试，等下一版。
  function shouldQuietDownload(resDir) {
    if (!quietEnabled() || state.phase !== 'available' || !state.canApply || !manifest || manifest.quiet === false || !plan || plan.kind !== 'incremental') return false;
    if (isNotableUpdate(currentVersion, manifest.version) || quietTried.has(manifest.version) || !resDir) return false;
    try { return canWriteDir(resDir); } catch (_) { return false; }
  }
  async function quietDownload() {
    const version = manifest.version;
    quietTried.add(version);
    emit({ quiet: true });
    try {
      const result = await download();
      if (result.phase !== 'ready') { logger.warn?.('[app-update] 静默下载没有完成：', result.error || result.phase); emit({ phase: 'available', quiet: false, error: null }); }
    } catch (error) {
      logger.warn?.('[app-update] 静默下载出错：', error.message);
      emit({ phase: 'available', quiet: false, error: null });
    }
  }
  // 已下好还没换上的静默包：定时再看一眼清单。远程写了 quiet:false 就不再替换，又发了新版就丢掉旧包，回到正常检查。
  // 查不到清单时保持原样。返回是否丢掉了旧包。
  async function revalidateQuiet() {
    try {
      checkAbort = new AbortController();
      const results = await checkManifests({ sources, fetchImpl: resolveFetch(fetchImpl), validate: validateManifest, signal: checkAbort.signal });
      const best = results.filter(r => r.ok).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
      if (!best || (best.manifest.quiet !== false && compareVersions(best.manifest.version, staged?.plan?.version || currentVersion) === 0)) return false;
      staged = null;
      emit({ phase: 'idle', quiet: false, error: null });
      return true;
    } catch (error) {
      logger.warn?.('[app-update] 复查静默更新失败：', error.message);
      return false;
    }
  }
  // 退出时替换：只处理静默下好的增量包，不重开程序、不弹任何东西；失败时脚本自己回滚，下次打开时只记日志。
  function applyOnQuit() {
    if (state.phase !== 'ready' || !state.quiet || !quietEnabled() || !staged || staged.installer || staged.needsAdmin) return false;
    try {
      const planFile = staged.paths.plan;
      const written = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      // 多开时计划文件可能是另一个窗口写的：版本对不上就不动；要等退出的进程换成自己。
      if (staged.plan && written.version !== staged.plan.version) return false;
      const next = { ...written, pid: process.pid, relaunch: false, quiet: true };
      fs.writeFileSync(planFile, JSON.stringify(next, null, 2), 'utf8');
      try { fs.rmSync(staged.paths.started, { force: true }); fs.rmSync(staged.paths.cancel, { force: true }); } catch (_) {}
      launchHelper(staged.paths, { env, spawnImpl });
      staged = null;
      return true;
    } catch (error) {
      logger.warn?.('[app-update] 退出时替换没能启动：', error.message);
      return false;
    }
  }
  function setQuietEnabled(on) {
    try {
      if (on) fs.rmSync(quietOffFile(), { force: true });
      else { fs.mkdirSync(path.dirname(quietOffFile()), { recursive: true }); fs.writeFileSync(quietOffFile(), new Date().toISOString(), 'utf8'); }
    } catch (error) { logger.warn?.('[app-update] 保存自动更新开关失败：', error.message); }
    return emit({ quietEnabled: quietEnabled() });
  }

  async function tryUnblock(url) {
    try { return !!(await unblock(url)); }
    catch (error) { logger.warn?.('[app-update] 自动放行出错：', error.message); return false; }
  }

  async function download(_afterRecheck = false) {
    if (!manifest || !plan || plan.kind === 'none') throw new Error('还没有可下载的新版本，请先检查更新');
    if (state.phase === 'downloading') return state;
    const asset = plan.asset;
    const p = stagingPaths(dataDir);
    const dest = path.join(p.downloads, asset.file);
    abort = new AbortController();
    emit({ phase: 'downloading', attempts: [], progress: { received: 0, total: asset.bytes }, error: null });
    let lastEmit = 0;
    const ordered = [...sources.filter(s => confirmedIds.includes(s.id)), ...sources.filter(s => !confirmedIds.includes(s.id))];
    const runDownload = () => downloadWithFallback({ sources: ordered, version: manifest.version, expect: asset, dest, fetchImpl: resolveFetch(fetchImpl), signal: abort.signal,
      onAttempt: attempts => emit({ attempts }),
      onProgress: progress => { const now = Date.now(); if (now - lastEmit > 200 || progress.received === progress.total) { lastEmit = now; emit({ progress }); } } });
    let result = await runDownload();
    const blockedOwn = !result.ok && !result.cancelled && (result.attempts || []).find(a => a.blocked && isOwnUrl(a.url));
    if (blockedOwn && unblock && await tryUnblock(blockedOwn.url)) { result = await runDownload(); if (result.ok) { try { unblockPassed(); } catch (_) {} } }
    abort = null;
    // 查到新版后发布源又发了一版、旧版目录被删：所有源都回 404。重新查一次清单，换到新版本再下一次（只重试一次）。
    if (!result.ok && !result.cancelled && !_afterRecheck && (result.attempts || []).length && result.attempts.every(a => /HTTP 404/.test(a.reason || ''))) {
      const triedFile = asset.file;
      emit({ phase: 'available' });
      await check({ silent: true, quietAllowed: false });
      if (plan && plan.kind !== 'none' && plan.asset && plan.asset.file !== triedFile) return download(true);
      return emit({ phase: 'error', attempts: result.attempts, error: '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。' });
    }
    if (!result.ok) {
      return emit({ phase: result.cancelled ? 'available' : 'error', attempts: result.attempts,
        error: result.cancelled ? null : '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。' });
    }
    try {
      if (plan.kind === 'incremental') {
        if (!state.canApply) return emit({ phase: 'error', attempts: result.attempts, error: '开发运行的 Hub 不能自动替换程序文件，请用安装版' });
        staged = stageIncremental({ dataDir, payloadFile: dest, resourcesDir: env.AI_HUB_UPDATE_RESOURCES || resourcesPath, version: manifest.version, from: currentVersion,
          exe: process.execPath, args: process.argv.slice(1), simulateFailure: env.AI_HUB_UPDATE_SIMULATE_FAILURE || null,
          elevateMode: env.AI_HUB_UPDATE_ELEVATE_MODE || null });
        fs.rmSync(dest, { force: true });
      } else {
        staged = { installer: dest };
      }
    } catch (error) {
      // 下载到解包之间程序文件被改动过（很少见）：让用户再检查一次，下一次会自动改用完整更新包。
      if (error.code === 'stale-local') return emit({ phase: 'error', attempts: result.attempts,
        error: `本机程序文件在下载期间被改动过（${error.stale?.[0]?.path || '未知文件'}），请重新检查更新，这次会自动改用完整更新包` });
      return emit({ phase: 'error', attempts: result.attempts, error: `更新包解开或校验失败：${error.message}` });
    }
    // 装在 Program Files 这类目录时，重启那一步 Windows 会弹一次管理员确认框：界面提前说一声（2026-10-30）。
    return emit({ phase: 'ready', attempts: result.attempts, readySource: result.source.name, needsAdmin: !!(staged && staged.needsAdmin) });
  }

  function cancel() { if (abort) abort.abort(); if (checkAbort) checkAbort.abort(); return state; }

  // 用户点「立即重启」：增量 → 启动替换脚本后退出；完整安装包 → 打开安装程序后退出。
  function apply() {
    if (state.phase !== 'ready' || !staged) throw new Error('更新还没有下载好');
    // 安装程序装完会拉起新程序、替换脚本换完文件也会拉起新程序：都给干净环境（工作目录明显异常时才换成安装目录）。
    let launch = null;
    try { launch = prepareLaunch(); } catch (error) { logger.warn?.('[app-update] 准备干净启动环境失败，按当前环境启动：', error.message); }
    if (staged.installer) {
      // 安装包被杀软隔离或删除：不能让 spawn 的异步 error 变成未捕获异常把 Hub 带崩，报人话、回到可重试状态。
      const failInstall = detail => {
        staged = null;
        logger.warn?.('[app-update] 启动安装程序失败：', detail);
        emit({ phase: 'error', error: '安装程序启动不了（文件可能被安全软件删除或隔离）。Hub 没有退出，请点「重试」重新下载。' });
      };
      let missing = false;
      try { missing = !fs.existsSync(staged.installer); } catch (_) {}
      if (missing) { failInstall('文件不存在'); return state; }
      let child;
      try {
        child = spawnImpl(staged.installer, [], { detached: true, stdio: 'ignore', windowsHide: false,
          ...(launch ? { env: launch.env, ...(launch.cwd ? { cwd: launch.cwd } : {}) } : {}) });
      } catch (error) { failInstall(error.message); return state; }
      let failed = false;
      child?.on?.('error', error => { failed = true; failInstall(error.message); });
      child?.unref?.();
      emit({ phase: 'applying' });
      setTimeout(() => { if (failed) return; try { app.quit(); } catch (error) { logger.warn?.('[app-update] 退出失败：', error.message); } }, 300);
      return state;
    } else {
      try { fs.rmSync(staged.paths.started, { force: true }); fs.rmSync(staged.paths.cancel, { force: true }); } catch (_) {}
      launchHelper(staged.paths, { env: launch ? launch.env : env, spawnImpl });
      emit({ phase: 'applying' });
      // 替换脚本被组策略（AllSigned、AppLocker）或杀软拦住时不会开始执行；先等它留下「已开始」标记再退出，
      // 约 15 秒看不到就不退出，如实告诉用户，仍是当前版本，可重试或改用完整安装包。留一个放弃标记，脚本晚到时看到就退出，不会过后再多开一个 Hub。
      const startedAt = Date.now();
      const poll = () => {
        let seen = false;
        try { seen = fs.existsSync(staged.paths.started); } catch (_) {}
        if (seen) { try { app.quit(); } catch (error) { logger.warn?.('[app-update] 退出失败：', error.message); } return; }
        if (Date.now() - startedAt >= helperStartWaitMs) {
          try { fs.writeFileSync(staged.paths.cancel, new Date().toISOString()); } catch (_) {}
          emit({ phase: 'error', error: '更新程序没能启动（可能被安全软件或组策略拦截），Hub 没有退出，仍是当前版本。可以点「重试」，或改用完整安装包更新。' });
          return;
        }
        setTimeout(poll, 150);
      };
      setTimeout(poll, 300);
      return state;
    }
  }

  function useConfig(next) {
    if (state.phase === 'ready' && state.quiet) { staged = null; emit({ phase: 'idle', quiet: false }); }
    if (['downloading', 'ready'].includes(state.phase)) throw new Error('正在下载或已下载好别的版本，先完成或取消再换');
    sources = resolveSources(next, env); allowSame = !!(next && next.switchEdition);
    manifest = null; plan = null; confirmedIds = [];
    return emit({ phase: 'idle', sources: sources.map(s => ({ id: s.id, name: s.name })), latest: null, plan: null, error: null });
  }
  function startBackgroundChecks() {
    if (!sources.length) return;
    timer = setTimeout(function tick() {
      void check({ silent: true });
      timer = setTimeout(tick, PERIODIC_CHECK_MS);
      timer.unref?.();
    }, Number(env.AI_HUB_UPDATE_STARTUP_DELAY_MS || STARTUP_CHECK_DELAY_MS));
    timer.unref?.();
  }

  function dismissLastResult() { delete state.lastResult; return state; }

  // 环境体检用（5.5.24）：只看各更新源连不连得上、清单读不读得出，不改更新状态、不触发下载、不弹放行窗口。
  async function probeSources({ timeoutMs = 7000 } = {}) {
    const results = await checkManifests({ sources, fetchImpl: resolveFetch(fetchImpl), validate: validateManifest, timeoutMs });
    return { current: currentVersion, sources: results.map(r => ({ id: r.id, name: r.name, ok: r.ok, version: r.ok ? r.manifest.version : null,
      reason: r.reason || null, blocked: !!r.blocked })) };
  }

  return { check, probeSources, download, cancel, apply, applyOnQuit, setQuietEnabled, getState: () => state, view, startBackgroundChecks, useConfig, dismissLastResult, lastResult: () => lastResult,
    dispose: () => { clearTimeout(timer); if (abort) abort.abort(); if (checkAbort) checkAbort.abort(); } };
}

// { mode:'auto' } 有在途问题时回 needsConfirm；'wait' 答完再重启；'now' 立即重启（在途的记下、重启后接着做）；'cancel' 取消等待。
function registerAppUpdateIpc(ipcMain, controller, { gate = null } = {}) {
  ipcMain.handle('app-update:get-state', () => (controller.view ? controller.view() : controller.getState()));
  ipcMain.handle('app-update:check', () => controller.check({ silent: false }));
  ipcMain.handle('app-update:download', () => controller.download());
  ipcMain.handle('app-update:cancel', () => controller.cancel());
  ipcMain.handle('app-update:apply', (_e, opts) => {
    const mode = opts && ['auto', 'wait', 'now', 'cancel'].includes(opts.mode) ? opts.mode : 'auto';
    const viaGate = gate && typeof gate.apply === 'function' ? gate.apply({ mode }) : null;
    if (viaGate) return viaGate;
    if (mode === 'cancel') return controller.view ? controller.view() : controller.getState();
    return controller.apply();
  });
  ipcMain.handle('app-update:dismiss-result', () => controller.dismissLastResult());
  ipcMain.handle('app-update:set-quiet', (_e, on) => controller.setQuietEnabled(on !== false));
}

module.exports = { createAppUpdateController, registerAppUpdateIpc, resolveSources };
