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
const launchGuard = require('../core/app-update/launch-guard');

const STARTUP_CHECK_DELAY_MS = 20000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;
// 小版本静默送达：只改末位的版本不打扰用户（不弹窗、不挂红点），但也要真的送到。后台下载校验，用户下次关闭 Hub 时隐藏替换、不重开，
// 下次打开就是新版，并由更新日志告诉用户多了什么。装在受保护目录（要管理员授权）的不静默，仍走设置菜单。用户可以在更新窗口里关掉。
const QUIET_OFF_FILE = 'quiet-updates-off.flag';
// 上一轮升级留下的进度与标记，多久没动过算残留（r43）。
const STALE_UPGRADE_MS = 10 * 60 * 1000;
const canary = require('../core/app-update/canary');
const catalogLib = require('../core/app-update/version-catalog');
const openxSource = require('../core/app-update/openx-source');

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  return globalThis.fetch;
}

// 测试用 AI_HUB_UPDATE_SOURCES（JSON 数组）把源换成本机服务；否则用发行目标里写的。
// 程序更新包的内源查找参数（r56）：公开版按文件名在公开版版本里找；成员版只精确查 member-v<版本>（strict）。
function appOpenxOptions(version, editionOn = require('../core/app-update/openx-source').EDITION_ON) {
  if (editionOn) return {};
  return { release: require('../core/app-update/openx-source').memberReleaseName(version), strict: true };
}

// 免安装包文件名（package.json build.win.artifactName）：安装包 <名>-Setup-<版本>.exe → <名>-<版本>-win-x64.zip；认不出就仍给安装包。
function portableZipName(installerFile, version) {
  const m = /^(.+)-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(String(installerFile || ''));
  return m && m[2] === String(version) ? `${m[1]}-${m[2]}-win-x64.zip` : installerFile;
}

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
  unblock = null, unblockInteractive = null, isOwnUrl = () => false, unblockPassed = () => {},
  // 内源版本清单验签用的公钥（只给单测换测试密钥；正式运行用 core/app-update/manifest-signing.js 内置公钥）。
  manifestPublicKey,
  env = process.env, fetchImpl, resourcesPath = process.resourcesPath, isPackaged = !!(app && app.isPackaged), spawnImpl = spawn,
  // 拉起新程序用的干净环境与工作目录（core/clean-launch-env.js，2026-10-19）：main.js 传入；没传时按当前环境现算。
  prepareLaunch = () => require('../core/clean-launch-env').prepareHubLaunch({ env, isPackaged, appRoot: app && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined }),
  restartWait = () => null,
  // 点了「立即重启」但 Hub 没退出、回到「已下载好」时通知调用方（main.js 用它放开公司版的等待重启，r43）。
  onApplyCancelled = () => {},
  // 点「立即重启」后最多等替换脚本留下「已开始」标记这么久，看不到就不退出（杀软重的电脑上 PowerShell 启动就要好几秒）。
  helperStartWaitMs = Number(env.AI_HUB_UPDATE_HELPER_WAIT_MS) || 15000,
  // 小版本静默送达：11-07 定先不上线；2026-11-20（第三批 K / 第四批 O）改为默认开——只改末位的版本后台下好，
  // 设置图标挂小点、底栏一行「已就绪，重启生效」，关 Hub 时换上、下次打开生效；更新窗里可关。设 AI_HUB_QUIET_UPDATE=0 整体关掉。
  quietDelivery = env.AI_HUB_QUIET_UPDATE !== '0',
  // 本机是不是免安装版（zip 解压即用，目录里没有卸载程序）：完整安装包会装到另一处，原目录仍是旧版（O②）。测试可注入。
  portableCopy = null }) {
  const productName = () => { try { return (config && config.productName) || (isPackaged && app && typeof app.getName === 'function' && app.getName()) || 'AI Hub'; } catch (_) { return 'AI Hub'; } };
  // 老用户本机存的抢先版开关（它的源由外网源推出）也按「关」处理，不报错。版本清单只从内源读（签名清单，fetchManifest）。
  const only = () => openxSource.onlyChannel(env);
  const effectiveSources = next => (only() ? [] : resolveSources(next, env));
  const withPreview = base => (previewEnabled && !only() ? [...canary.previewSources(base), ...base] : base);
  let baseSources = effectiveSources(config);
  let previewEnabled = !only() && canary.read(dataDir).enabled === true;
  let sources = withPreview(baseSources);
  let allowSame = !!(config && config.switchEdition);
  const releasePage = only() ? '' : (config && config.releasePage) || '';
  const sourceEdition = openxSource.EDITION_ON ? '公开版' : '成员版';
  // r56：两个版本都真实探测内源；成员版只看 member-v<版本>（与下载时的 appOpenxOptions 同一口径）。
  const initialInternalSource = () => ({ id: 'openx', name: '内源（公司内网）', informational: true, ok: false, status: 'unknown', reason: '等待检查' });
  const probeInternalSource = async (version, file, timeoutMs) => openxSource.probe({ version, file, fetchImpl: resolveFetch(fetchImpl), env, timeoutMs,
    ...(openxSource.EDITION_ON ? {} : { strict: true, release: version ? openxSource.memberReleaseName(version) : undefined }) });
  let state = { phase: 'idle', current: currentVersion, sourceEdition, internalSource: initialInternalSource(), sources: sources.map(s => ({ id: s.id, name: s.name })), releasePage, openxOnly: only(), previewSupported: !only(), canApply: isPackaged || env.AI_HUB_UPDATE_FORCE_APPLY === '1' };
  let manifest = null, plan = null, abort = null, checkAbort = null, staged = null, checking = null, lastResult = null, timer = null;
  const quietTried = new Set();
  let skipQuitApply = false;
  const quietOffFile = () => path.join(stagingPaths(dataDir).root, QUIET_OFF_FILE);
  const quietEnabled = () => { if (!quietDelivery && !(previewEnabled && canary.read(dataDir).enabled === true)) return false; try { return !fs.existsSync(quietOffFile()); } catch (_) { return true; } };
  // rsi-e：外网清单（GitHub、阿里云）全部读不到时，再从公司内源读同一份 latest.json（core/app-update/openx-source.js fetchManifest）。
  // 公司网络拦了阿里云、又没外网权限的同事以前「检查更新」永远报错；有任一外网源能读到时完全不走这里。
  // 内源清单要验签、版本不低于当前，总共最多 8 秒（budgetMs 可再收紧，如环境体检只给剩余时间）。
  const withInternalManifest = async (results, signal, budgetMs) => {
    if (results.some(r => r.ok) || (signal && signal.aborted)) return results;
    try {
      const r = await openxSource.fetchManifest({ fetchImpl: resolveFetch(fetchImpl), validate: validateManifest, signal, env, currentVersion,
        publicKey: manifestPublicKey, ...(budgetMs != null ? { timeoutMs: budgetMs } : {}) });
      if (!r.ok) logger.warn?.('[app-update] 内源版本清单未采用：' + r.reason);
      return [...results, r];
    }
    catch (error) { logger.warn?.('[app-update] 内源版本清单兜底出错：', error.message); return results; }
  };
  // 只走内源时查不到清单：说清原因（连不上 → 检查公司网络；内源上还没有 → 稍后再试）。
  const noManifestError = results => {
    const r = (results || []).find(x => x && x.id === 'openx-manifest');
    return '查不到新版本：' + openxSource.userReason(r ? r.reason : '内源连不上', { file: '版本清单' });
  };
  // 只走内源时下载没成：说清原因，不再提发布页或别的下载源。
  const openxOnlyDownloadError = result => {
    const a = ((result && result.attempts) || []).find(x => x && x.status === 'failed' && x.reason);
    return '更新包下载没有完成：' + (a ? a.reason : openxSource.userReason('内源连不上'));
  };
  // 查版本时清单里就是这一版的源：下载先走它们，查不到或版本不同的源只留作后备，免得先报一次 404（旧 GitHub 库改私有后实测，2026-10-28）。
  let confirmedIds = [];

  try { lastResult = takeLastResult(dataDir); } catch (error) { logger.warn?.('[app-update] 读取上次结果失败：', error.message); }
  // 关 Hub 时顺手替换没成（O）：这一版不再后台反复下、反复试，改由界面挂点提醒用户手动更新。
  if (lastResult && !lastResult.ok && lastResult.quiet && lastResult.version) quietTried.add(String(lastResult.version));
  // 上次升级半路断了、没留下结果（替换脚本还在等旧窗口时电脑重启或被结束，r43）：进度停在「进行中 / 没换成」、
  // （脚本正常结束一定会写成完成 / 放弃 / 已取消 / 最终失败，只有被打断才会停在这两种）
  // 版本比当前新、脚本已不在，就当作一次没成的升级，界面照「没升成」处理（提示原因、这一版重新提醒）。
  if (!lastResult) {
    try {
      const sp = stagingPaths(dataDir);
      const pr = JSON.parse(fs.readFileSync(sp.progress, 'utf8').replace(/^﻿/, ''));
      if (pr && (pr.state === 'running' || (pr.state === 'failed' && pr.need)) && pr.version && compareVersions(pr.version, currentVersion) > 0 && !launchGuard.lockHeld(sp.lock)) {
        lastResult = { ok: false, version: pr.version, from: pr.from || currentVersion, rolledBack: false, quiet: false, interrupted: true,
          reason: pr.reason || '上次升级在「' + (pr.label || '替换') + '」这一步中断了（升级小窗被关掉后电脑重启或程序被结束），没有换上新版本' };
        fs.rmSync(sp.progress, { force: true });
      }
    } catch (_) {}
  }
  // 上一轮升级留下的进度、按钮选择、标记（r43）：替换脚本已不在（没占着 helper.lock）、且 10 分钟没动过的才清掉。
  // 刚升级完重新打开时进度小窗还在读 progress.json（「升级完成」显示几秒后自己关），删早了它读不到状态就关不掉。
  try {
    const sp = stagingPaths(dataDir);
    if (!launchGuard.lockHeld(sp.lock)) {
      for (const x of [sp.progress, sp.decision, sp.focus, sp.started, sp.cancel]) {
        let old = false; try { old = Date.now() - fs.statSync(x).mtimeMs > STALE_UPGRADE_MS; } catch (_) {}
        if (old) fs.rmSync(x, { force: true });
      }
    }
  } catch (_) {}
  if (lastResult) state.lastResult = lastResult;
  state.quietEnabled = quietEnabled();
  state.quietFeature = !!quietDelivery;
  const isPortable = () => {
    if (typeof portableCopy === 'boolean') return portableCopy;
    // 测试与隔离模拟：AI_HUB_UPDATE_PORTABLE=1/0 指定；用 AI_HUB_UPDATE_RESOURCES 模拟安装目录时默认按安装版。
    if (env.AI_HUB_UPDATE_PORTABLE === '1' || env.AI_HUB_UPDATE_PORTABLE === '0') return env.AI_HUB_UPDATE_PORTABLE === '1';
    if (!isPackaged || env.AI_HUB_UPDATE_RESOURCES) return false;
    try { return !require('../core/portable-desktop-shortcut').isInstalledCopy(process.execPath); } catch (_) { return false; }
  };
  state.portable = isPortable();
  state.previewEnabled = previewEnabled;
  // 固定版本（回退后）：自动更新与更新提醒暂停；回退没换上就清掉固定并告诉用户（version-catalog.js）。
  let pinned = null, versionList = null;
  try { const settled = catalogLib.settlePin(dataDir, currentVersion, lastResult); pinned = settled.pin; if (settled.failed) state.rollbackFailed = { version: settled.failed.version }; }
  catch (error) { logger.warn?.('[app-update] 读取固定版本失败：', error.message); }
  state.pinned = pinned;
  try { const rr = catalogLib.readRestoreResult(dataDir); if (rr && Date.now() - Date.parse(rr.at) < 24 * 3600 * 1000) state.restoreResult = rr; } catch (_) {}

  // 界面看到的 = 控制器状态 + 等待重启的状态（读不到就当没在等）。
  const view = () => { let wait = null; try { wait = restartWait() || null; } catch (_) {} return { ...state, restartWait: wait }; };
  const emit = patch => { state = { ...state, ...patch }; if (needsFullPackage(state)) lookupFullPackage(); try { sendToRenderer('app-update:state', view()); } catch (_) {} return state; };
  // r27（2026-11-24，WeLink 2 人：老版本找不到更新途径）：检查或下载失败、上次升级没成时（读到了版本清单、只是要完整包的，原有按钮已能下），
  // 在后台从内源找最近一个比当前新的完整安装包（不依赖版本清单，openx-source.js findLatestFull），找到就放进 state.fullPackage，
  // 更新窗和失败提示据此给「下载完整安装包」按钮。没找到不报错，1 分钟内不重找。
  let fullLookup = null, fullTriedAt = 0;
  function needsFullPackage(s) { return !s.fullPackage && (s.phase === 'error' || !!(s.lastResult && !s.lastResult.ok)); }
  function lookupFullPackage() {
    if (fullLookup || Date.now() - fullTriedAt < 60 * 1000) return;
    fullTriedAt = Date.now();
    fullLookup = openxSource.findLatestFull({ fetchImpl: resolveFetch(fetchImpl), portable: isPortable(), currentVersion, env })
      .then(r => {
        if (r && r.ok) emit({ fullPackage: { url: r.url, file: r.file, version: r.version, releaseId: r.releaseId } });
        else logger.info?.('[app-update] 内源完整安装包未找到：' + (r && r.reason));
      })
      .catch(error => logger.warn?.('[app-update] 查内源完整安装包出错：', error.message))
      .finally(() => { fullLookup = null; });
  }
  if (needsFullPackage(state)) lookupFullPackage();

  async function check({ silent = false, quietAllowed = silent } = {}) {
    if (checking) return checking;
    // 固定在旧版时：后台不查、不提醒、不静默下载；用户在版本页点「回到最新版」才恢复。
    if (pinned && silent) return state;
    // An administrator may set the same local preference through the existing managed command facility.
    const preferred = !only() && canary.read(dataDir).enabled === true;
    if (preferred !== previewEnabled && !['downloading', 'ready'].includes(state.phase)) setPreviewEnabled(preferred);
    if (state.phase === 'ready' && state.quiet && silent) {
      let discarded = false;
      checking = revalidateQuiet().then(result => { discarded = result; return state; }).finally(() => { checking = null; checkAbort = null; });
      await checking;
      return discarded ? check({ silent, quietAllowed }) : state;
    }
    // 正在应用（已点「立即重启」）时不另查：否则会把界面改成「有新版本」，盖掉替换进度（r43）。
    if (['downloading', 'ready', 'applying'].includes(state.phase)) return state;
    checking = (async () => {
      if (!silent) emit({ phase: 'checking', error: null });
      const fetchFn = resolveFetch(fetchImpl);
      checkAbort = new AbortController();
      // R29：只走内源时不查外网清单，直接读内源上的签名清单；用户点「检查更新」要真的再连一次内源。
      if (only()) openxSource.clearDown();
      let results = only() ? [] : await checkManifests({ sources, fetchImpl: fetchFn, validate: validateManifest, signal: checkAbort.signal });
      if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
      const blockedOwn = results.find(r => r.blocked && !r.ok && isOwnUrl(r.url));
      if (blockedOwn && unblock && await tryUnblock(blockedOwn.url)) {
        results = await checkManifests({ sources, fetchImpl: fetchFn, validate: validateManifest, signal: checkAbort.signal });
        if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
        // 放行成功：清掉放行器的连续失败计数（不然累计 3 次就进 30 分钟冷却）
        if (results.some(r => r.ok && r.id === blockedOwn.id)) { try { unblockPassed(); } catch (_) {} }
      }
      results = await withInternalManifest(results, checkAbort.signal);
      if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
      const checks = results.map(r => ({ id: r.id, name: r.name, ok: r.ok, version: r.ok ? r.manifest.version : null, reason: r.reason || null,
        ...(r.blocked ? { blocked: true, url: r.url } : {}) }));
      const best = results.filter(r => r.ok).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
      const internalSource = await probeInternalSource(best?.manifest.version, best && [best.manifest.incremental?.file, best.manifest.incrementalDelta?.file, best.manifest.installer?.file].filter(Boolean));
      if (checkAbort.signal.aborted) return emit({ phase: 'idle', error: null });
      checks.unshift(internalSource);
      // R29 审查 #4：内源上最新的有效清单比本机还旧（本机装了更新的包）——就是已是最新，不报错。
      const olderRow = !best && only() ? results.find(r => r && r.id === 'openx-manifest' && r.older) : null;
      if (olderRow) {
        manifest = null; plan = null;
        const row = checks.find(c => c.id === 'openx-manifest');
        if (row) Object.assign(row, { ok: true, version: olderRow.version || null, reason: null });
        return emit({ phase: 'none', checks, internalSource, checkedAt: new Date().toISOString(), error: null, latest: null, plan: null });
      }
      if (!best) return emit({ phase: silent ? 'idle' : 'error', checks, internalSource, checkedAt: new Date().toISOString(),
        error: only() ? noManifestError(results) : '所有更新源都连不上，暂时查不到新版本', silentFailure: silent });
      manifest = best.manifest;
      if (manifest.canary && manifest.version === currentVersion && previewEnabled) canary.write(dataDir, { releaseSha: manifest.canary.sha, releaseVersion: currentVersion });
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
        if (delta && resDir && (delta.schema !== 3 || delta.baseVersion === currentVersion)
          && verifyLocalFiles(delta.requires, resDir).ok) variant = 'delta';
        else if (manifest.incremental) {
          variant = 'complete';
          // 小包的前提是本机那些没变的文件确实还是上一版的样子；对不上就退回完整更新包，仍然一步升到最新版。
          if (delta) plan = { ...plan, reason: '本机有些程序文件和这一版对不上，改为下载完整更新包（仍是一步升到最新版）' };
        } else plan = { kind: 'full', reason: '这一版只提供变化的程序文件，本机的程序文件对不上，需要完整安装包' };
      }
      const asset = plan.kind === 'incremental' ? (variant === 'delta' ? manifest.incrementalDelta : manifest.incremental) : plan.kind === 'full' ? manifest.installer : null;
      // 完整安装包能否无人值守：安装目录不用授权就能写（个人安装，或关了授权提示的管理员）才算（2026-11-15）。
      let unattended = plan.kind !== 'full';
      if (plan.kind === 'full') { try { unattended = !!(resDir && canWriteDir(resDir)); } catch (_) { unattended = false; } }
      // 免安装版遇到完整安装包（O②）：安装程序会装到「本机程序」另一处，桌面快捷方式指向的免安装目录仍是旧版，
      // 用户看到的就是「下完重启还是旧版」。不走安装程序，就地给「下载新的免安装包」。
      const portableFull = plan.kind === 'full' && isPortable();
      if (portableFull) { unattended = false; plan = { ...plan, reason: '免安装版不能用安装程序原地升级（会装到另一处，原目录仍是旧版）。请下载新的免安装包，解压覆盖原目录' }; }
      // 装在受保护目录（例如安装时选了「所有用户」→ Program Files，O③）：每次替换都要管理员授权；公司电脑常常没有，就永远升不上。
      let protectedDir = false;
      if (plan.kind === 'incremental' && resDir && state.canApply) { try { protectedDir = !canWriteDir(resDir); } catch (_) { protectedDir = false; } }
      plan = { ...plan, variant, asset, silent: unattended, ...(portableFull ? { portable: true } : {}), ...(protectedDir ? { protectedDir: true } : {}) };
      const checked = emit({ phase: plan.kind === 'none' ? 'none' : 'available', checks, internalSource, checkedAt: new Date().toISOString(), error: null,
        latest: { version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt, sourceName: best.name, installer: manifest.installer, notify: isNotableUpdate(currentVersion, manifest.version), canary: manifest.canary || null },
        plan: { kind: plan.kind, variant: plan.variant, reason: plan.reason, silent: plan.silent, bytes: plan.asset ? plan.asset.bytes : 0, file: plan.asset ? plan.asset.file : null,
          ...(plan.portable ? { portable: true } : {}), ...(plan.protectedDir ? { protectedDir: true } : {}) } });
      // quietPending（Codex 审查 P2-4）：这一版会不会由后台送达。界面据此决定小版本挂不挂点——送不到（下载失败、远程停更、
      // 受保护目录、用户关了）就挂点，不再「以为会送到」而整版沉默。
      const willQuiet = shouldQuietDownload(resDir);
      emit({ quietPending: willQuiet });
      if (quietAllowed && willQuiet) void quietDownload();
      return checked;
    })().catch(error => emit({ phase: silent ? 'idle' : 'error', error: `检查更新失败：${error.message}` }))
      .finally(() => { checking = null; checkAbort = null; });
    return checking;
  }

  // 完整安装包静默参数（electron-builder NSIS）：/S 不出向导；--updated 按升级处理、沿用原安装目录；
  // 按原来的安装方式指定 /allusers 或 /currentuser，免得静默时装到另一处；relaunch 时 --force-run 装完重新打开。
  // 程序还开着时安装程序会自动关掉同一用户的实例，关不掉就放弃安装、原版本不受影响。
  function installerArgs({ relaunch }) {
    const norm = p => path.resolve(String(p)).toLowerCase();
    const exe = norm(process.execPath || '');
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean).map(norm);
    const perMachine = roots.some(r => exe.startsWith(r + path.sep));
    return ['/S', '--updated', perMachine ? '/allusers' : '/currentuser', ...(relaunch ? ['--force-run'] : [])];
  }

  // 只有后台自动查到的、只改末位、走增量、能直接写安装目录的才静默；同一版本失败一次就不再试，等下一版。
  function shouldQuietDownload(resDir) {
    if (!quietEnabled() || state.phase !== 'available' || !manifest || manifest.quiet === false || !plan) return false;
    // 完整安装包（原生组件或运行时变了）也静默：下好后退出时静默安装，不再弹安装向导（2026-11-15）。
    if (plan.kind === 'full') return !!(plan.silent && plan.asset && !isNotableUpdate(currentVersion, manifest.version) && !quietTried.has(manifest.version));
    if (!state.canApply || plan.kind !== 'incremental') return false;
    if (isNotableUpdate(currentVersion, manifest.version) || quietTried.has(manifest.version) || !resDir) return false;
    try { return canWriteDir(resDir); } catch (_) { return false; }
  }
  async function quietDownload() {
    const version = manifest.version;
    quietTried.add(version);
    emit({ quiet: true });
    try {
      const result = await download();
      // 下载途中用户固定了版本（审查 P2-4）：下好的静默包直接丢弃，不留到退出时替换。
      if (pinned) { staged = null; return void emit({ phase: 'idle', quiet: false, error: null }); }
      if (result.phase !== 'ready') { logger.warn?.('[app-update] 静默下载没有完成：', result.error || result.phase); emit({ phase: 'available', quiet: false, quietPending: false, error: null }); }
    } catch (error) {
      logger.warn?.('[app-update] 静默下载出错：', error.message);
      emit({ phase: 'available', quiet: false, quietPending: false, error: null });
    }
  }
  // 已下好还没换上的静默包：定时再看一眼清单。远程写了 quiet:false 就不再替换，又发了新版就丢掉旧包，回到正常检查。
  // 查不到清单时保持原样。返回是否丢掉了旧包。
  async function revalidateQuiet() {
    try {
      checkAbort = new AbortController();
      const results = only() ? await withInternalManifest([], checkAbort.signal)
        : await checkManifests({ sources, fetchImpl: resolveFetch(fetchImpl), validate: validateManifest, signal: checkAbort.signal });
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
  // 退出时替换：静默下好的包，以及用户自己点了「下载更新」、下好后点了「稍后」或叉掉更新窗的增量包（O①，2026-11-20）——
  // 以前后者在关 Hub 时被丢掉，下次打开这一版已提醒过、红点也已消掉，就再也不提醒（群友：叉掉小窗后不再自动升）。
  // 不重开程序、不弹任何东西；失败时脚本自己回滚，下次打开时设置挂点提醒。受保护目录（要管理员授权）不在退出时换。
  function applyOnQuit() {
    if (pinned || skipQuitApply || state.phase !== 'ready' || !quietEnabled() || !staged || staged.needsAdmin) return false;
    if (!state.quiet && staged.installer) return false;
    // 远程总开关（清单 quiet:false，Codex 审查 P1）：退出时一律不自动换；用户点「立即重启」不受影响。
    if (manifest && manifest.quiet === false) return false;
    // 点过「立即重启」又被取消（applyCancelled）后马上关 Hub：上一个替换脚本可能还在等旧窗口退出（占着 helper.lock），
    // 这时删放弃标记会让它按 relaunch=true 接着换并重开程序（Codex 审查 P2-2）。它还在就不动，下次关 Hub 再换。
    try { if (staged.paths && launchGuard.lockHeld(staged.paths.lock)) return false; } catch (_) {}
    if (staged.installer) {
      // 静默下好的完整安装包：退出时静默安装，不重开程序（和增量包一样，下次打开就是新版）。
      try {
        if (!fs.existsSync(staged.installer)) return false;
        const child = spawnImpl(staged.installer, installerArgs({ relaunch: false }), { detached: true, stdio: 'ignore', windowsHide: true });
        child?.on?.('error', error => logger.warn?.('[app-update] 退出时静默安装没能启动：', error.message));
        child?.unref?.();
        staged = null;
        return true;
      } catch (error) { logger.warn?.('[app-update] 退出时静默安装没能启动：', error.message); return false; }
    }
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
    return emit({ quietEnabled: quietEnabled(), ...(quietEnabled() ? {} : { quietPending: false }) });
  }

  async function tryUnblock(url) {
    try { return !!(await unblock(url)); }
    catch (error) { logger.warn?.('[app-update] 自动放行出错：', error.message); return false; }
  }

  async function download(_afterRecheck = false) {
    if (!manifest || !plan || plan.kind === 'none') throw new Error('还没有可下载的新版本，请先检查更新');
    if (state.phase === 'downloading') return state;
    if (plan.portable) return emit({ phase: 'error', attempts: [], error: plan.reason });
    const asset = plan.asset;
    const p = stagingPaths(dataDir);
    const dest = path.join(p.downloads, asset.file);
    abort = new AbortController();
    emit({ phase: 'downloading', attempts: [], progress: { received: 0, total: asset.bytes }, error: null });
    let lastEmit = 0;
    const ordered = [...sources.filter(s => confirmedIds.includes(s.id)), ...sources.filter(s => !confirmedIds.includes(s.id))];
    // 程序更新包：两个版本都先走内源（r56，2026-11-19 用户定）。成员版只认内源上的 member-v<版本>（同名不同内容，
    // 不与公开版混用），文件名、大小、sha256 都按清单核对；内源没有或不对就回到原顺序（阿里云高速 → 阿里云 → GitHub）。
    const runDownload = () => downloadWithFallback({ sources: ordered, version: manifest.version, expect: asset, dest, fetchImpl: resolveFetch(fetchImpl), signal: abort.signal,
      openx: { ...appOpenxOptions(manifest.version), ...(only() ? { env } : {}) },
      onAttempt: attempts => emit({ attempts }),
      onProgress: progress => { const now = Date.now(); if (now - lastEmit > 200 || progress.received === progress.total) { lastEmit = now; emit({ progress }); } } });
    let result = await runDownload();
    const blockedOwn = !result.ok && !result.cancelled && (result.attempts || []).find(a => a.blocked && isOwnUrl(a.url));
    if (blockedOwn && unblock && await tryUnblock(blockedOwn.url)) { result = await runDownload(); if (result.ok) { try { unblockPassed(); } catch (_) {} } }
    // 下载是用户点的：后台放行没成功就在 Hub 里弹出放行页，放行后接着下（2026-11-08 用户定）。
    const stillBlocked = !result.ok && !result.cancelled && (result.attempts || []).find(a => a.blocked && isOwnUrl(a.url));
    // 后台静默下载不弹可见的放行窗口（Codex 审查 P2-3）：只有用户自己点的下载才弹。
    if (stillBlocked && unblockInteractive && !state.quiet) {
      try { await unblockInteractive(stillBlocked.url); } catch (error) { logger.warn?.('[app-update] 放行窗口出错：', error.message); }
      result = await runDownload();
      if (result.ok) { try { unblockPassed(); } catch (_) {} }
    }
    abort = null;
    // 查到新版后发布源又发了一版、旧版目录被删：所有源都回 404。重新查一次清单，换到新版本再下一次（只重试一次）。
    if (!result.ok && !result.cancelled && !_afterRecheck && !manifest.rollback && (result.attempts || []).length && result.attempts.every(a => /HTTP 404/.test(a.reason || ''))) {
      const triedFile = asset.file;
      emit({ phase: 'available' });
      await check({ silent: true, quietAllowed: false });
      if (plan && plan.kind !== 'none' && plan.asset && plan.asset.file !== triedFile) return download(true);
      if (plan?.variant === 'delta' && manifest.incremental) return downloadComplete('差量包暂时不可用，正在自动下载完整更新包');
      return emit({ phase: 'error', attempts: result.attempts, error: result.openxOnly ? openxOnlyDownloadError(result) : '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。' });
    }
    if (!result.ok && !result.cancelled && plan.variant === 'delta' && manifest.incremental) {
      return downloadComplete('差量包下载或校验失败，正在自动下载完整更新包');
    }
    if (!result.ok) {
      return emit({ phase: result.cancelled ? 'available' : 'error', attempts: result.attempts,
        error: result.cancelled ? null : result.openxOnly ? openxOnlyDownloadError(result) : '所有下载源都失败了。可以稍后再试，或打开发布页手动下载安装包。' });
    }
    try {
      if (plan.kind === 'incremental') {
        if (!state.canApply) return emit({ phase: 'error', attempts: result.attempts, error: '开发运行的 Hub 不能自动替换程序文件，请用安装版' });
        staged = stageIncremental({ dataDir, payloadFile: dest, resourcesDir: env.AI_HUB_UPDATE_RESOURCES || resourcesPath, version: manifest.version, from: currentVersion,
          exe: process.execPath, args: process.argv.slice(1), simulateFailure: env.AI_HUB_UPDATE_SIMULATE_FAILURE || null,
          elevateMode: env.AI_HUB_UPDATE_ELEVATE_MODE || null,
          expectedAsar: plan.variant === 'delta' ? manifest.incrementalDelta?.resultAsar : null,
          // 升级进度小窗（core/app-update/progress-ui.js，2026-11-13）：只在用户点「立即重启」的替换里出现；测试可设 AI_HUB_UPDATE_PROGRESS_UI=0 关掉。
          progressUi: env.AI_HUB_UPDATE_PROGRESS_UI !== '0', productName: productName() });
        fs.rmSync(dest, { force: true });
      } else {
        staged = { installer: dest };
      }
    } catch (error) {
      if (plan.variant === 'delta' && manifest.incremental) {
        fs.rmSync(dest, { force: true });
        return downloadComplete('差量重建或校验失败，正在自动下载完整更新包');
      }
      // 下载到解包之间程序文件被改动过（很少见）：让用户再检查一次，下一次会自动改用完整更新包。
      if (error.code === 'stale-local') return emit({ phase: 'error', attempts: result.attempts,
        error: `本机程序文件在下载期间被改动过（${error.stale?.[0]?.path || '未知文件'}），请重新检查更新，这次会自动改用完整更新包` });
      return emit({ phase: 'error', attempts: result.attempts, error: `更新包解开或校验失败：${error.message}` });
    }
    // 装在 Program Files 这类目录时，重启那一步 Windows 会弹一次管理员确认框：界面提前说一声（2026-10-30）。
    if (previewEnabled && manifest.canary) {
      const saved = canary.read(dataDir);
      canary.write(dataDir, { releases: { ...(saved.releases || {}), [manifest.version]: manifest.canary.sha } });
    }
    return emit({ phase: 'ready', attempts: result.attempts, readySource: result.source.name, needsAdmin: !!(staged && staged.needsAdmin) });
  }

  function downloadComplete(reason) {
    staged = null;
    plan = { ...plan, variant: 'complete', asset: manifest.incremental, reason };
    emit({ phase: 'available', error: null, plan: { kind: plan.kind, variant: plan.variant,
      reason, bytes: plan.asset.bytes, file: plan.asset.file } });
    // The complete variant cannot recurse back into the delta fallback.
    return download(true);
  }

  // —— 版本选择与回退（2026-11-16）——
  // 本机运行时；开发运行没有解包目录可读，原生依赖按参照版本算，免得全部被过滤掉。
  function localRuntime(refNative) {
    const resDir = isPackaged || env.AI_HUB_UPDATE_RESOURCES ? (env.AI_HUB_UPDATE_RESOURCES || resourcesPath) : null;
    let rt; try { rt = currentRuntime({ resourcesPath: resDir }); } catch (_) { rt = { electron: process.versions.electron, native: {} }; }
    return !resDir && refNative ? { ...rt, native: { ...refNative } } : rt;
  }
  // 版本列表：从各更新源（不含抢先版源）读 versions.json，第一个读得到的为准；只列与本机运行时一致的版本。
  async function listVersions() {
    const fetchFn = resolveFetch(fetchImpl);
    const tried = [];
    for (const src of baseSources) {
      const url = catalogLib.versionsUrl(src.manifest);
      try {
        const res = await fetchFn(url, { cache: 'no-store' });
        if (!res.ok) { tried.push(`${src.name}：HTTP ${res.status}`); continue; }
        const versions = catalogLib.validateVersions(await res.text());
        if (!versions.length) { tried.push(`${src.name}：列表是空的`); continue; }
        let history = [];
        try { history = require('../core/app-update/release-history').loadHistory(); } catch (_) {}
        versionList = versions;
        const catalog = catalogLib.buildCatalog(versions, { current: currentVersion, runtime: localRuntime(versions[0].runtime.native), history });
        return { ok: true, current: currentVersion, source: src.name, ...catalog, pinned, backups: catalogLib.listBackups(dataDir).slice(0, 5) };
      } catch (error) {
        tried.push(`${src.name}：${error.message === 'fetch failed' ? '网络请求没有发出去' : error.message}`);
      }
    }
    return { ok: false, current: currentVersion, pinned, items: [], hidden: [], backups: catalogLib.listBackups(dataDir).slice(0, 5),
      error: baseSources.length ? `读不到版本列表（${tried.join('；')}）` : only() ? '版本选择暂不可用：公司内源上还没有版本列表，目前只能更新到最新版' : '这个版本没有配置更新源，不能选择版本' };
  }
  // 回退：先备份小文件，再下载目标版的完整更新包（不走差量）；下载好后由用户点「立即重启」换上。
  async function rollbackTo(version) {
    if (checking || ['downloading', 'ready', 'applying'].includes(state.phase)) throw new Error('正在检查或下载别的版本，先完成或取消再回退');
    if (!versionList) await listVersions();
    const entry = (versionList || []).find(v => v.version === version);
    if (!entry) throw new Error(`镜像上找不到 v${version}`);
    const target = catalogLib.targetManifest(entry);
    const next = planUpdate(target, { version: currentVersion, runtime: localRuntime(entry.runtime.native), allowDowngrade: true });
    if (next.kind !== 'incremental' || !next.downgrade) throw new Error(next.reason || `不能回退到 v${version}`);
    // 另一个 Hub 开着同一份数据时不回退：备份拿不到一致快照、换程序时它也还在写（r16 返工2）。
    catalogLib.assertNoOtherHub(dataDir);
    const backup = catalogLib.backupForRollback(dataDir, { from: currentVersion, to: version });
    manifest = target;
    plan = { ...next, variant: 'complete', asset: entry.incremental, silent: false };
    confirmedIds = [];
    pinned = catalogLib.writePin(dataDir, { version, from: currentVersion, at: new Date().toISOString(), pending: true, backup: backup.dir,
      supportsPin: (entry.capabilities || []).includes('version-pin') });
    emit({ pinned, rollback: { version, backup: { dir: backup.dir, files: backup.files, bytes: backup.bytes } },
      latest: { version, notes: entry.notes, publishedAt: entry.publishedAt, notify: false, rollback: true },
      plan: { kind: plan.kind, variant: plan.variant, reason: plan.reason, silent: false, bytes: plan.asset.bytes, file: plan.asset.file, downgrade: true } });
    const result = await download();
    if (result.phase !== 'ready') { catalogLib.clearPin(dataDir); pinned = null; manifest = null; plan = null; emit({ pinned: null }); }
    else if (previewEnabled) {
      // 抢先版开着时，旧版会在后台静默下载最新版并在退出时自动升回去：旧包下好、换上之前替用户关掉抢先版（确认框已写明）。
      previewEnabled = false; canary.write(dataDir, { enabled: false });
      sources = baseSources;
      emit({ previewEnabled: false, quietEnabled: quietEnabled() });
    }
    return view();
  }
  // 回到最新版：清掉固定，照常检查并下载最新版；下载好后用户点「立即重启」。
  async function returnToLatest() {
    if (['downloading', 'applying'].includes(state.phase)) throw new Error('正在下载，先完成或取消');
    if (state.phase === 'ready') staged = null;
    catalogLib.clearPin(dataDir); pinned = null;
    manifest = null; plan = null;
    emit({ pinned: null, rollback: null, phase: 'idle' });
    const checked = await check({ silent: false, quietAllowed: false });
    // 增量与完整安装包都接上现有下载流程（审查 P2-5）；下好后版本页给「立即重启 / 立即安装」。
    if (checked.phase === 'available' && plan && ['incremental', 'full'].includes(plan.kind)) await download();
    return view();
  }
  // 关掉「跟随最新版」但不回退：固定在当前版本，自动更新与提醒暂停。
  // 后台静默下载在途就取消、已暂存的静默包丢弃（审查 P2-4）；用户自己点的下载不动。
  function pinCurrent() {
    pinned = catalogLib.writePin(dataDir, { version: currentVersion, from: currentVersion, at: new Date().toISOString(), manual: true, supportsPin: true });
    if (state.quiet && state.phase === 'downloading' && abort) abort.abort();
    if (state.quiet && state.phase === 'ready') { staged = null; return emit({ pinned, phase: 'idle', quiet: false, error: null }); }
    return emit({ pinned });
  }
  // 一键还原：数据库可能正开着，登记后重启，下次启动在打开任何数据库前还原。
  function restoreBackup(dir) {
    catalogLib.assertNoOtherHub(dataDir);
    const res = catalogLib.scheduleRestore(dataDir, dir);
    // 还原要重启：这次退出不顺手替换（Codex 审查 P2-5），免得替换脚本和重启后的新进程撞在一起。
    skipQuitApply = true;
    setTimeout(() => { try { app.relaunch(); app.quit(); } catch (error) { logger.warn?.('[app-update] 还原后重启失败：', error.message); } }, 300);
    return res;
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
        child = spawnImpl(staged.installer, installerArgs({ relaunch: true }), { detached: true, stdio: 'ignore', windowsHide: true,
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
      emit({ phase: 'applying', applyCancelled: null });
      // 替换脚本被组策略（AllSigned、AppLocker）或杀软拦住时不会开始执行；先等它留下「已开始」标记再退出，
      // 约 15 秒看不到就不退出，如实告诉用户，仍是当前版本，可重试或改用完整安装包。留一个放弃标记，脚本晚到时看到就退出，不会过后再多开一个 Hub。
      const startedAt = Date.now();
      const poll = () => {
        let seen = false;
        try { seen = fs.existsSync(staged.paths.started); } catch (_) {}
        if (seen) { watchApplying(staged.paths); try { app.quit(); } catch (error) { logger.warn?.('[app-update] 退出失败：', error.message); } return; }
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

  // 退出被取消后回到「已下载好」（r43，2026-11-18）。以前点「立即重启」后 Hub 的退出被拦下（会议有未保存内容、会话没收尾完等），
  // 替换脚本在进度小窗里停在第 1 步干等 90 秒（用户看到的「卡住」），之后放弃；旧 Hub 却一直停在「正在应用」：
  // 弹窗没有按钮，同一版本的提醒已经弹过，后台检查也不会再弹，自动更新就此失效。现在两路兜底，回到「已就绪」并说明原因，可以再点「立即重启」：
  //   1) main.js 退出被取消时直接告诉控制器（applyCancelled）：留下放弃标记，替换脚本立即结束、进度小窗随之关闭；
  //   2) 替换脚本因任何原因先结束了（helper.lock 被放开）而本进程还活着：同样回到「已就绪」。
  let applyWatch = null;
  function watchApplying(paths) {
    clearInterval(applyWatch);
    const since = Date.now();
    applyWatch = setInterval(() => {
      if (state.phase !== 'applying') { clearInterval(applyWatch); applyWatch = null; return; }
      if (Date.now() - since < 3000) return;
      let held = true;
      try { held = launchGuard.lockHeld(paths.lock); } catch (_) {}
      if (!held) applyCancelled('替换程序已经结束，但 Hub 没有退出');
    }, 1000);
    applyWatch.unref?.();
  }
  function applyCancelled(reason = '') {
    if (state.phase !== 'applying' || !staged || staged.installer) return state;
    clearInterval(applyWatch); applyWatch = null;
    try { fs.writeFileSync(staged.paths.cancel, new Date().toISOString()); } catch (_) {}
    // 替换脚本放弃时写的「没有升级」结果是给下次启动看的；本进程已经在界面上说了，不留到下次再报一遍。
    try { takeLastResult(dataDir); } catch (_) {}
    const why = String(reason || '').trim();
    try { onApplyCancelled(why); } catch (_) {}
    return emit({ phase: 'ready', error: null, applyCancelled: { at: new Date().toISOString(),
      reason: `Hub 没有退出，这次没有升级${why ? `（${why}）` : ''}。新版本已经下好，处理完后再点「立即重启」即可。` } });
  }

  function useConfig(next) {
    if (state.phase === 'ready' && state.quiet) { staged = null; emit({ phase: 'idle', quiet: false }); }
    if (['downloading', 'ready'].includes(state.phase)) throw new Error('正在下载或已下载好别的版本，先完成或取消再换');
    baseSources = effectiveSources(next);
    sources = withPreview(baseSources);
    allowSame = !!(next && next.switchEdition);
    manifest = null; plan = null; confirmedIds = [];
    return emit({ phase: 'idle', internalSource: initialInternalSource(), checks: [], attempts: [], sources: sources.map(s => ({ id: s.id, name: s.name })), latest: null, plan: null, error: null });
  }
  function startBackgroundChecks() {
    if (!sources.length && !only()) return;
    timer = setTimeout(function tick() {
      void check({ silent: true });
      timer = setTimeout(tick, PERIODIC_CHECK_MS);
      timer.unref?.();
    }, Number(env.AI_HUB_UPDATE_STARTUP_DELAY_MS || STARTUP_CHECK_DELAY_MS));
    timer.unref?.();
  }

  function dismissLastResult() { delete state.lastResult; return state; }

  function setPreviewEnabled(on) {
    if (checking || ['downloading', 'ready'].includes(state.phase)) throw new Error('更新正在进行，请完成或取消后再切换抢先版');
    // R29：只走内源时没有抢先版清单，开关不生效（界面也不显示）。
    if (only()) { previewEnabled = false; return emit({ previewEnabled: false, previewSupported: false }); }
    previewEnabled = on === true;
    canary.write(dataDir, { enabled: previewEnabled });
    sources = withPreview(baseSources);
    manifest = null; plan = null; confirmedIds = [];
    return emit({ phase: 'idle', previewEnabled, quietEnabled: quietEnabled(), latest: null, plan: null, error: null });
  }

  // 环境体检用（5.5.24）：只看各更新源连不连得上、清单读不读得出，不改更新状态、不触发下载、不弹放行窗口。
  async function probeSources({ timeoutMs = 7000 } = {}) {
    const started = Date.now();
    // R29 审查 #5：体检要真的再连一次内源，不吃 5 分钟「连不上」的缓存。
    if (only()) openxSource.clearDown();
    const external = only() ? [] : await checkManifests({ sources, fetchImpl: resolveFetch(fetchImpl), validate: validateManifest, timeoutMs });
    // 内源清单只用体检剩下的时间，到点就中断，体检总时长不因内源变长（rsi-e 返工）。
    const remaining = timeoutMs - (Date.now() - started);
    const probeAbort = new AbortController();
    const probeTimer = setTimeout(() => probeAbort.abort(), Math.max(1, remaining));
    let results;
    try { results = remaining > 0 ? await withInternalManifest(external, probeAbort.signal, remaining) : external; }
    finally { clearTimeout(probeTimer); }
    const best = results.filter(r => r.ok).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
    const internalSource = await probeInternalSource(best?.manifest.version, best && [best.manifest.incremental?.file, best.manifest.incrementalDelta?.file, best.manifest.installer?.file].filter(Boolean), Math.max(1, timeoutMs - (Date.now() - started)));
    // 只走内源时内源清单比本机旧 = 已是最新，算连得上（R29 审查 #4）。
    const olderOk = r => only() && !r.ok && r.older;
    return { current: currentVersion, ...(only() ? { only: true } : {}), sources: [internalSource, ...results.map(r => ({ id: r.id, name: r.name, ok: r.ok || olderOk(r),
      version: r.ok ? r.manifest.version : olderOk(r) ? r.version || null : null, reason: olderOk(r) ? null : r.reason || null, blocked: !!r.blocked }))] };
  }

  // r58：程序更新与版本回退的下载源标识，和 download() 查内源的参数一致（appOpenxOptions）。
  // 「app-update」看当前要下的包（还没检查过就看清单里的增量包）；「app-version:<版本>」看回退到该版本要下的完整更新包。
  {
    const pts = require('../core/app-update/download-points');
    const spec = (version, file) => {
      const o = appOpenxOptions(version);
      return file ? { items: [{ file, release: o.release, version }], strict: !!o.strict } : null;
    };
    pts.register('app-update', async () => {
      if (!manifest) { try { await check({ silent: true, quietAllowed: false }); } catch (_) {} }
      if (!manifest) return null;
      const file = plan && plan.asset ? plan.asset.file : (manifest.incremental && manifest.incremental.file) || (manifest.installer && manifest.installer.file);
      return spec(manifest.version, file);
    });
    // 「下载完整安装包」手动入口：先找内源上的安装包，没有再用阿里云地址（renderer/app-update.js manualDownload）。
    // 启动时的失败提示里也有这个按钮（O④），那时可能还没检查过：先静默查一次。免安装版找同版本的免安装包（zip）。
    pts.register('app-installer', async () => {
      if (!manifest) { try { await check({ silent: true, quietAllowed: false }); } catch (_) {} }
      if (!manifest || !manifest.installer) return null;
      return spec(manifest.version, isPortable() ? portableZipName(manifest.installer.file, manifest.version) : manifest.installer.file);
    });
    pts.register('app-version:', async point => {
      const version = String(point).slice('app-version:'.length);
      if (!versionList) { try { await listVersions(); } catch (_) {} }
      const entry = (versionList || []).find(v => v.version === version);
      return entry && entry.incremental ? spec(version, entry.incremental.file) : null;
    });
  }
  return { check, probeSources, listVersions, rollbackTo, returnToLatest, restoreBackup, pinCurrent, download, cancel, apply, applyCancelled, applyOnQuit, setQuietEnabled, setPreviewEnabled, getState: () => state, view, startBackgroundChecks, useConfig, dismissLastResult, lastResult: () => lastResult,
    dispose: () => { clearTimeout(timer); clearInterval(applyWatch); if (abort) abort.abort(); if (checkAbort) checkAbort.abort(); } };
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
  ipcMain.handle('app-update:list-versions', () => controller.listVersions());
  ipcMain.handle('app-update:rollback', (_e, version) => controller.rollbackTo(String(version || '')));
  ipcMain.handle('app-update:return-latest', () => controller.returnToLatest());
  ipcMain.handle('app-update:pin-current', () => controller.pinCurrent());
  ipcMain.handle('app-update:restore-backup', (_e, dir) => controller.restoreBackup(String(dir || '')));
  ipcMain.handle('app-update:set-preview', (_e, on) => controller.setPreviewEnabled(on === true));
}

module.exports = { createAppUpdateController, registerAppUpdateIpc, resolveSources, appOpenxOptions, portableZipName };
