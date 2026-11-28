// Windows 上改名替换遇到短暂占用（EPERM/EBUSY）稍等重试，必须在其他模块加载前装上（core/fs-rename-retry.js）。
require('./core/fs-rename-retry').install();
const { app, BrowserWindow, BaseWindow, ipcMain, clipboard, dialog, nativeImage, screen, shell, Menu, Tray, crashReporter, protocol, net, powerMonitor } = require('electron');
// 「个人」页计分：必须在注册任何 IPC 之前装上，之后注册的功能入口才会被记到（main/profile-controller.js）。
const profileTap = require('./main/profile-controller').installProfileTap(ipcMain);
let profileController = null;
const path = require('path');
const { fileURLToPath } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
// Opt-in main-process CPU profile for isolated performance runs; inert unless
// HUB_MAIN_CPU_PROFILE is set (see core/main-cpu-profiler.js).
if (process.env.HUB_MAIN_CPU_PROFILE) {
  require('./core/main-cpu-profiler.js').startMainCpuProfiler({ dataDir: require('./core/data-dir.js').getHubDataDir() });
}

// 2026-05-16 maintainer：防卡死后门 — 默认开 Chromium CDP 端口（OS 自动分配）。
//   实际分配的端口在启动后写入 <dataDir>/control/<pid>.json 的 cdpPort 字段，
//   救援脚本 tools/hub-escape.ps1 + Playwright/DevTools 可 attach 进 Hub。
//   设环境变量 CLAUDE_HUB_NO_CDP=1 可关闭。
//   必须在 app.whenReady() 之前 appendSwitch 才生效。
//   注：如果启动命令行已经传了 --remote-debugging-port（E2E 测试用 hub-launcher 的场景），
//   不重复 append，避免 Chromium argv 冲突。
const _hasCdpSwitch = process.argv.some(a => a.startsWith('--remote-debugging-port'));
if (process.env.CLAUDE_HUB_NO_CDP !== '1' && !_hasCdpSwitch) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
const { SessionManager, clearSessionManagerConfigCache } = require('./core/session-manager.js');
const { WorkspaceService, normalizeKey: normalizeWorkspaceKey } = require('./core/workspace-service.js');
const stateStore = require('./core/state-store.js');
const { primeV8MemoryPoolForExit } = require('./core/v8-exit-guard.js');
const { getHubDataDir, isIsolatedHub, getMeetingWorkspaceDir } = require('./core/data-dir.js');
// 版本回退后的「一键还原」（2026-11-16；R42 恢复，core/app-update/version-catalog.js）：数据库打开前把登记过的备份拷回数据目录。
try { const restored = require('./core/app-update/version-catalog.js').applyPendingRestore(getHubDataDir()); if (restored) console.log('[app-update] 回退备份还原：', JSON.stringify(restored)); } catch (error) { console.warn('[app-update] 回退备份还原失败：', error && error.message); }
const {
  appendManagedLaunchAudit,
  inspectManagedLaunchAudit,
  managedLaunchAuditPath,
} = require('./core/managed-launch-audit.js');
const { spawn } = require('child_process');
const { launchHubInstance } = require('./core/hub-instance-launcher.js');
const {
  HUB_APP_USER_MODEL_ID,
  ensureWindowsShellIntegration,
  startWindowsShellIntegrationWatchdog,
} = require('./core/windows-shell-integration.js');
const {
  describeBrandingHealth,
  resolveHubLaunchExePath,
} = require('./core/hub-exe-branding.js');
const { isPackagedHubRuntime } = require('./core/electron-runtime-mode.js');
const {
  ensureClaudeHookIntegration,
  startClaudeHookIntegrationWatchdog,
} = require('./core/claude-hook-integration.js');
const { cleanupFileClaimsTmp } = require('./core/file-claims-tmp-cleanup.js');
const hubControl = require('./core/hub-control.js');
const { MeetingRoomManager } = require('./core/meeting-room.js');
const meetingStore = require('./core/meeting-store.js');
const sessionStore = require('./core/session-store.js');
const { TranscriptTap } = require('./core/transcript-tap');
const { CompletionNotifier } = require('./core/completion-notifier.js');
const { createHtmlArtifactPreviewRenderer } = require('./core/html-artifact-preview.js');
const { normalizeEventTime } = require('./core/session-attention-state.js');
const { createUsageFilter } = require('./core/usage-filter.js');
const scenes = require('./core/group-chat-scenes.js');
const groupchat = require('./core/group-chat-orchestrator.js');
const cliReadyDetector = require('./core/group-chat-cli-ready-detector.js');
const { getConfig: getHubConfig } = require('./core/hub-config.js');
const {
  createFixtureProbe: createNetworkEgressFixtureProbe,
  createNetworkEgressMonitor,
} = require('./core/network-egress-monitor.js');
const {
  resolveCodexUsageScope,
  attachCodexUsageScope,
  filterUsageCacheForCodexScope,
} = require('./core/codex-usage-scope.js');
const { ALL_AI_KINDS, isClaudeFamily, isCodexCliKind, isKimiCliKind, isCodeAgentKind, SLOT_IDS, KIND_LABELS, getSlotPromptName, getSlotDisplayLabel, slotIdToIndex, slotIndexToId } = require('./core/ai-kinds.js');
const { registerConfigIpc } = require('./main/ipc/config-handlers.js');
const { registerWorkbenchOperationsIpc } = require('./main/ipc/workbench-operations-handlers.js');
const { createWorkbenchOperationsService } = require('./core/workbench-operations.js');
const { registerPathIpc } = require('./main/ipc/path-handlers.js');
const { registerSessionIpc } = require('./main/ipc/session-handlers.js');
const { registerPromptSubmitIpc } = require('./main/ipc/prompt-submit-handlers.js');
const { createClaudeQuotaResume, registerClaudeQuotaIpc } = require('./main/claude-quota-resume.js');
const { registerWorkspaceIpc } = require('./main/ipc/workspace-handlers.js');
const { getTerminalBatchDelay, isBackgroundMember } = require('./main/terminal-output-policy.js');
const { TerminalOutputBatcher } = require('./main/terminal-output-batcher.js');
const { registerUsageIpc } = require('./main/ipc/usage-handlers.js');
const { registerMeetingIpc } = require('./main/ipc/meeting-handlers.js');
const { registerMeetingCreateIpc } = require('./main/ipc/meeting-create-handlers.js');
const { registerMeetingTimelineIpc } = require('./main/ipc/meeting-timeline-handlers.js');
const { registerTranscriptIpc } = require('./main/ipc/transcript-handlers.js');
const { registerCliStatusIpc } = require('./main/ipc/cli-status-handlers.js');
const { registerPromptInspectIpc } = require('./main/ipc/prompt-inspect-handlers.js');
const { registerPersistenceIpc } = require('./main/ipc/persistence-handlers.js');
const { registerAppUtilityIpc } = require('./main/ipc/app-utility-handlers.js');
const { createDesktopNotificationController } = require('./main/desktop-notification-controller.js');
const { createHubPetController } = require('./main/hub-pet-controller.js');
const { registerProcessReclaimIpc } = require('./main/ipc/process-reclaim-handlers.js');
const { registerMemoryReleaseIpc } = require('./main/ipc/memory-release-handlers.js');
const { registerDiskReleaseIpc } = require('./main/ipc/disk-release-handlers.js');
const { registerDesktopOrganizerIpc } = require('./main/ipc/desktop-organizer-handlers.js');
const { registerAutoSuspendIpc } = require('./main/ipc/auto-suspend-handlers.js');
const { registerGroupchatQueryIpc } = require('./main/ipc/groupchat-query-handlers.js');
const { registerGroupchatRecoveryIpc } = require('./main/ipc/groupchat-recovery-handlers.js');
const { registerGroupchatSupplementIpc, createRunningInjector } = require('./main/ipc/groupchat-supplement-handlers.js');
const { registerGroupchatTurnIpc } = require('./main/ipc/groupchat-turn-handlers.js');
const { createResumeSessionHandler, registerResumeSessionIpc } = require('./main/ipc/resume-session-handlers.js');
const { createGroupChatDispatcher } = require('./main/groupchat/dispatcher.js');
const {
  collectProtectedSessionIds,
  createSessionAutoSuspendScheduler,
} = require('./main/session-auto-suspend.js');
// 低开销模式的会话与运行期节能（2026-11-23 P1 v2，L1–L6）：跟随 optionalFeatures 的总开关，建窗前初始化（见 low-overhead:set 旁）。
let lowOverheadController = null;
const { createAutoTitleManager } = require('./main/auto-title-manager.js');
const {
  parseCodexUsage,
  parseGeminiUsage,
  parseKimiUsage,
  stripAnsi,
} = require('./main/usage/agent-usage-parser.js');
const {
  expireCodexUsageWindows,
  readCodexAccountUsage,
  shouldPreferCodexLiveUsage,
} = require('./main/usage/codex-app-server-usage.js');
const { readKimiAccountUsage } = require('./main/usage/kimi-account-usage.js');
const { createTokenPlanUsageService } = require('./main/usage/token-plan-usage.js');
const { readDeepSeekAccountBalance } = require('./main/usage/deepseek-account-balance.js');
const {
  didClaudeSnapshotAdvance,
  selectClaudeStatuslineUsage,
} = require('./main/usage/claude-statusline-usage.js');
const {
  pruneCodexCliUsage,
  recordCodexCliUsage,
  selectCodexCliUsageForScope,
} = require('./main/usage/scoped-codex-cli-usage.js');
const {
  mergeCodexEntry,
  mergeUsageCacheSnapshots,
  readUsageCacheFile,
  writeMergedUsageCacheFile,
  writeMergedUsageCacheFileSync,
} = require('./main/usage/usage-cache-merge.js');

function isCodexBaseKind(kind) {
  return isCodexCliKind(kind);
}
const { readLastAssistantMessage } = require('./core/read-last-assistant.js');
const { readTranscriptTail } = require('./core/session-manager');
const { parseClaudeTranscriptToTurns, isTaskNotificationText } = require('./core/claude-transcript-parser.js');
const { TranscriptParserService } = require('./core/transcript-parser-service.js');
const { CodexJsonlUsageService } = require('./main/usage/codex-jsonl-usage-service.js');
const {
  claudeProjectRoots,
  codeAgentProjectsRoot,
  findTranscriptByCCSessionId,
  healPersistedCwds,
  projectSlug,
} = require('./core/claude-transcript-locator.js');
const { sameWorkDir, transcriptBucketMatches } = require('./core/hook-cwd-match');
const {
  DEFAULT_CODEX_SESSIONS_ROOT,
  parseCodexRolloutToTurns,
  findCodexRolloutBySid,
  findCodexRolloutByCwd,
  isUsableCodexRolloutPath,
  isCodexSubagentRolloutPath,
  readCodexRolloutMeta,
} = require('./core/codex-transcript-parser.js');
const { registerArchiveIpc } = require('./main/ipc/archive-handlers.js');
const { registerSessionReferenceIpc } = require('./main/ipc/session-reference-handlers.js');
const { SessionSearchService } = require('./core/session-search-service.js');
const transcriptParserService = new TranscriptParserService();
const codexJsonlUsageService = new CodexJsonlUsageService();
function sessionSearchRoots(envName, defaults) {
  if (process.env.HUB_SESSION_SEARCH_DISABLE_NATIVE === '1') return [];
  const configured = String(process.env[envName] || '').trim();
  return configured
    ? configured.split(path.delimiter).map(value => value.trim()).filter(Boolean)
    : defaults;
}
function antigravityHistoryRoots() {
  const profiles=require('./core/antigravity-subscription-profiles'),config=getHubConfig();
  return profiles.normalizeProfiles(config.antigravitySubscriptionProfiles).flatMap(row=>{
    try {return [path.join(profiles.resolveProfile(config,row.id).home,'.gemini','tmp')];}
    catch(error){console.warn('[antigravity-history] 账号目录未加入索引:',row.id,error.message);return [];}
  });
}
// 第一次全量建索引等电脑空闲再做，阶段变化写进 window-events.log（见 core/session-search-first-build.js）。
const searchFirstBuild = require('./core/session-search-first-build.js');
// 隔离测试 Hub 默认不等（搜索类 e2e 打开预热后要立即建索引），显式设了秒数才等。
const searchFirstBuildIdleSec = isIsolatedHub() && String(process.env.HUB_SESSION_SEARCH_FIRST_BUILD_IDLE_SEC ?? '').trim() === ''
  ? 0 : searchFirstBuild.idleSecondsSetting();
const searchEventLog = require('./core/window-keep-rendering.js').createWindowEventLog(path.join(getHubDataDir(), 'logs', 'window-events.log'), { logger: {} });
const sessionSearchService = new SessionSearchService({
  getIdleSeconds: () => require('electron').powerMonitor.getSystemIdleTime(),
  // 只在会自动预热的 Hub 上生效（隔离测试 Hub 本来就不预热）。
  holdBackground: searchFirstBuildIdleSec > 0 && !searchFirstBuild.firstBuildDone(getHubDataDir()),
  onStatusChange: status => {
    searchEventLog('search-index', searchFirstBuild.statusLogDetail(status));
    if (!status.ready || searchFirstBuild.firstBuildDone(getHubDataDir())) return;
    searchFirstBuild.markFirstBuildDone(getHubDataDir(), searchFirstBuild.statusLogDetail(status));
    sessionSearchService.releaseBackground();
  },
  cachePath: path.join(getHubDataDir(), 'cache', 'session-search-v2.json'),
  claudeRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CLAUDE_ROOTS', claudeProjectRoots()),
  // 公司 CodeAgent 的记录目录：该目录下的记录在「昨日之我」里标为 CodeAgent，恢复时用 CodeAgent。
  codeagentRoots: [codeAgentProjectsRoot()].filter(Boolean),
  codexRoots: sessionSearchRoots('HUB_SESSION_SEARCH_CODEX_ROOTS', [DEFAULT_CODEX_SESSIONS_ROOT]),
  // 2026-08-28：补上 Kimi 与 Gemini。此前只有 claude/codex/meeting 三个适配器，
  // Kimi 的 45 个会话、Gemini 的 21 个会话正文一条都进不了索引。
  kimiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_KIMI_ROOTS', [path.join(os.homedir(), '.kimi-code', 'sessions')]),
  geminiRoots: sessionSearchRoots('HUB_SESSION_SEARCH_GEMINI_ROOTS', antigravityHistoryRoots()),
  meetingDir: path.join(getHubDataDir(), 'meetings'),
  // 每个会话一份只含对话的 md 聊天记录，供分享路径与造梦阅读；由索引派生，可重建。
  transcriptDir: require('./core/data-dir').getHubTranscriptDir(),
  refreshTtlMs: Number(process.env.HUB_SESSION_SEARCH_REFRESH_TTL_MS) || 60_000,
  // Production watches for indexing work after the latency-sensitive boot
  // path; unchanged inventories do not allocate a search child. Isolated Hubs
  // stay opt-in so an unrelated E2E can never scan the
  // user's real native transcript roots merely because it launched the app.
  prewarmEnabled: process.env.HUB_SESSION_SEARCH_PREWARM === '1'
    || (process.env.HUB_SESSION_SEARCH_PREWARM !== '0' && !isIsolatedHub()),
});
const transcriptTap = new TranscriptTap({ parserService: transcriptParserService });
// PTY Claude 在 /clear、/resume、重启后跟随新的原生身份；判据见 core/claude-identity-switch.js。
const claudeIdentitySwitch = require('./core/claude-identity-switch').createClaudeIdentitySwitch();
// AIHubCommunity.exe is a branded copy of Electron's default-app host. Electron
// 41 reports app.isPackaged=true solely because the exe was renamed, while
// process.defaultApp remains true and argv still contains this source tree.
// Using app.isPackaged directly strips the app-root from Jump List launches and
// also points hook deployment at the wrong resources directory.
const HUB_IS_PACKAGED = isPackagedHubRuntime({
  appIsPackaged: app.isPackaged,
  defaultApp: process.defaultApp,
});
// Recovery can temporarily attach several listeners per group-chat seat.
try { transcriptTap.setMaxListeners(100); } catch {}

// === EPIPE 防护（隔离 Hub 启动必需）===
// PowerShell `& exe ...` + run_in_background 启动模式下，parent 退出后
// stdout/stderr 管道关闭。任何 console.log/warn/error 写入会触发 EPIPE，
// 未捕获时整个 Electron 主进程崩溃（红色 "JavaScript error" dialog）。
// 真实触发点：listenWithFallback 端口被占用时 console.warn → EPIPE → uncaught。
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EPIPE') return;
  // 先写崩溃文件、弹人话对话框再退出（之前原样 rethrow，用户只看到 Hub 消失）。
  require('./core/fatal-error-report.js').reportFatal(e, {
    dataDir: require('./core/data-dir.js').getHubDataDir(),
    showDialog: (title, content) => require('electron').dialog.showErrorBox(title, content),
    exit: code => { try { require('electron').app.exit(code); } catch { process.exit(code); } },
    version: (() => { try { return require('./package.json').version; } catch { return ''; } })(),
  });
});

const STARTUP_TRACE = process.env.HUB_STARTUP_TRACE === '1';
const STARTUP_T0 = Date.now();
function traceStartup(msg) {
  if (!STARTUP_TRACE) return;
  console.log(`[startup +${Date.now() - STARTUP_T0}ms] ${msg}`);
}

// Isolate Chromium userData when CLAUDE_HUB_DATA_DIR is set (parallel test
// instances). Must run before app.whenReady(). Production Hub unaffected
// because the env var is only set by test harnesses.
if (process.env.CLAUDE_HUB_DATA_DIR) {
  app.setPath('userData', path.join(process.env.CLAUDE_HUB_DATA_DIR, 'electron-userdata'));
}
// 崩溃转储只留在本机（<userData>/Crashpad/reports，不上传），界面或子进程崩溃后能看到崩在哪
// （2026-10-14 公司真机界面进程崩溃时没有任何转储）。AI_HUB_CRASH_DUMPS=0 可关掉。
if (String(process.env.AI_HUB_CRASH_DUMPS || '').trim() !== '0') {
  try { crashReporter.start({ uploadToServer: false, compress: true }); }
  catch (error) { console.warn('[crash] crashReporter start failed:', error && error.message); }
}
const HIDDEN_E2E_WINDOW_REQUESTED = process.env.CLAUDE_HUB_E2E === '1'
  && process.env.CLAUDE_HUB_E2E_WINDOW_MODE === 'hidden';
const HIDDEN_E2E_DATA_DIR_SAFE = isIsolatedHub()
  && path.resolve(getHubDataDir()).toLowerCase()
    !== path.resolve(path.join(os.homedir(), '.ai-hub-community')).toLowerCase();
if (HIDDEN_E2E_WINDOW_REQUESTED && !HIDDEN_E2E_DATA_DIR_SAFE) {
  throw new Error('hidden E2E window mode requires a non-production CLAUDE_HUB_DATA_DIR');
}
// Isolated meeting diagnostics only: preserve renderer heartbeats in the main
// process log even if the renderer later stops responding to CDP.
let observeMeetingE2E = null;
if (HIDDEN_E2E_WINDOW_REQUESTED && HIDDEN_E2E_DATA_DIR_SAFE
    && process.env.CLAUDE_HUB_E2E_MEETING_DIAGNOSTICS === '1') {
  const { performance } = require('node:perf_hooks');
  const observe = observeMeetingE2E = (kind, details = {}) => console.log('[meeting-e2e-observe] ' + JSON.stringify({ kind, mainAt: Date.now(), mainNow: performance.now(), ...details }));
  const rendererIdentity = contents => {
    try { return { webContentsId: contents.id, rendererPid: contents.getOSProcessId() }; }
    catch (error) { return { webContentsId: contents.id, rendererPidError: error.message }; }
  };
  app.on('child-process-gone', (_event, details) => observe('child-process-gone', {
    type: details.type, reason: details.reason, exitCode: details.exitCode,
    name: details.name, serviceName: details.serviceName }));
  app.whenReady().then(() => observe('gpu-feature-status', { status: app.getGPUFeatureStatus() }))
    .catch(error => observe('gpu-feature-status-error', { error: error.message }));
  const finiteResource = value => Number.isFinite(value) ? value : null;
  const cpuFields = ['percentCPUUsage', 'idleWakeupsPerSecond'];
  const memoryFields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
  const resourceNumbers = (value, fields) => value && typeof value === 'object'
    ? Object.fromEntries(fields.map(key => [key, finiteResource(value[key])])) : undefined;
  const resourceDetails = value => {
    if (!value || typeof value !== 'object') return undefined;
    return { sampleAt: finiteResource(value.sampleAt),
      cpuStatus: typeof value.cpuStatus === 'string' ? value.cpuStatus.slice(0, 32) : 'unknown',
      memoryStatus: typeof value.memoryStatus === 'string' ? value.memoryStatus.slice(0, 32) : 'unknown',
      cpu: resourceNumbers(value.cpu, cpuFields), memory: resourceNumbers(value.memory, memoryFields),
      cpuError: typeof value.cpuError === 'string' ? value.cpuError.slice(0, 160) : undefined,
      memoryError: typeof value.memoryError === 'string' ? value.memoryError.slice(0, 160) : undefined };
  };
  // Synchronous in-process counters only: no OS process query or overlapping
  // memory-info promises can add work to a stalled isolated test instance.
  const resourceTimer = setInterval(() => {
    const resources = { sampleAt: Date.now(), cpuStatus: 'unsupported', memoryStatus: 'unsupported' };
    if (typeof process.getCPUUsage === 'function') try {
      resources.cpu = process.getCPUUsage(); resources.cpuStatus = 'ok';
    } catch (error) { resources.cpuStatus = 'error'; resources.cpuError = String(error?.message || error); }
    if (typeof process.memoryUsage === 'function') try {
      resources.memory = process.memoryUsage(); resources.memoryStatus = 'ok';
    } catch (error) { resources.memoryStatus = 'error'; resources.memoryError = String(error?.message || error); }
    observe('main-resources', { resources: resourceDetails(resources) });
  }, 1000);
  resourceTimer.unref?.();
  app.once('will-quit', () => clearInterval(resourceTimer));
  ipcMain.on('meeting-e2e-observe', (event, payload = {}) => {
    if (!['heartbeat', 'step-before', 'step-after'].includes(payload?.kind)) return;
    const details = { webContentsId: event.sender.id, step: String(payload.step || '').slice(0, 320),
      rendererNow: finiteResource(payload.rendererNow),
      visibility: String(payload.visibility || '').slice(0, 20), focus: payload.focus === true };
    if (payload.kind !== 'heartbeat') {
      if (typeof payload.shot === 'string') details.shot = payload.shot.slice(0, 120);
      if (typeof payload.selector === 'string') details.selector = payload.selector.slice(0, 320);
    } else {
      details.resources = resourceDetails(payload.resources);
      const observer = payload.longTaskObserver;
      if (['active', 'unsupported', 'error'].includes(observer?.status)) details.longTaskObserver = {
        status: observer.status, error: typeof observer.error === 'string' ? observer.error.slice(0, 160) : undefined };
      if (Array.isArray(payload.longTasks)) details.longTasks = payload.longTasks.slice(0, 8)
        .filter(task => Number.isFinite(task?.startTime) && task.startTime >= 0 && Number.isFinite(task?.duration) && task.duration >= 0)
        .map(task => ({ startTime: task.startTime, duration: task.duration }));
      details.longTaskDropped = Number.isInteger(payload.longTaskDropped) && payload.longTaskDropped >= 0 ? payload.longTaskDropped : null;
    }
    observe(payload.kind, details);
  });
  app.on('web-contents-created', (_event, contents) => {
    for (const kind of ['unresponsive', 'responsive']) contents.on(kind, () => observe(kind, rendererIdentity(contents)));
    contents.on('render-process-gone', (_event, details) => observe('render-process-gone', {
      ...rendererIdentity(contents), reason: details.reason, exitCode: details.exitCode }));
    contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      let recovered = null, urlParseError;
      try { recovered = new URL(url).searchParams.get('recovered'); } catch (error) { urlParseError = error.message; }
      observe('navigation-start', { ...rendererIdentity(contents), recovered, urlParseError });
    });
    contents.on('did-finish-load', () => observe('navigation-finished', rendererIdentity(contents)));
  });
}
// Background E2E: the window renders like a visible one but sits off-screen,
// never activates and stays out of the taskbar, so a test run cannot steal the
// keyboard from someone typing in the production Hub.
const BACKGROUND_E2E_WINDOW_REQUESTED = process.env.CLAUDE_HUB_E2E_WINDOW_MODE === 'background';
if (BACKGROUND_E2E_WINDOW_REQUESTED && !HIDDEN_E2E_DATA_DIR_SAFE) {
  throw new Error('background E2E window mode requires a non-production CLAUDE_HUB_DATA_DIR');
}
const e2eDesktopSandbox = require('./core/e2e-desktop-sandbox.js');
if (BACKGROUND_E2E_WINDOW_REQUESTED) {
  e2eDesktopSandbox.prepareBackgroundChromium(app);
  app.on('browser-window-created', (_event, win) => e2eDesktopSandbox.keepWindowInBackground(win));
}
// Isolated E2E runs (background or hidden) keep their own in-memory clipboard;
// a test that must check the real one opts in with CLAUDE_HUB_E2E_REAL_CLIPBOARD=1.
if (HIDDEN_E2E_DATA_DIR_SAFE
    && ['background', 'hidden'].includes(process.env.CLAUDE_HUB_E2E_WINDOW_MODE)
    && process.env.CLAUDE_HUB_E2E_REAL_CLIPBOARD !== '1') {
  e2eDesktopSandbox.installFakeClipboard({ clipboard, nativeImage, ipcMain });
  process.env.CLAUDE_HUB_E2E_FAKE_CLIPBOARD_ACTIVE = '1';
  console.log('[e2e] in-memory clipboard active. Native copies (Ctrl+C in pages, webContents.copy) still reach the system '
    + 'clipboard and are not visible here; a test that checks them sets CLAUDE_HUB_E2E_REAL_CLIPBOARD=1.');
}

// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — keeps Hub-owned entries current and preserves unrelated hooks.
// claudeDirPath: target Claude config dir (e.g. ~/.claude or ~/.claude-deepseek)
// Claude 多账号的独立配置目录（主账号就是 ~/.claude，不在此列）；只取已存在的目录，不凭空创建。
function claudeProfileHookDirs() {
  try {
    return require('./core/claude-subscription-profiles').normalizeProfiles(getHubConfig().claudeSubscriptionProfiles)
      .map(profile => profile.home).filter(dir => dir && fs.existsSync(dir));
  } catch (error) {
    console.warn('[claude-profile] 读取账号目录失败：' + error.message);
    return [];
  }
}

function alignClaudeProfileDir(dir) {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    // 账号绑定专用出口时，对齐不能把主账号的共享代理带过去（2026-10-26 账号3/4 曾因此被改回共享 IP）。
    // 出口配置读不出来就整个不对齐：宁可设置不同步，也不让账号换 IP。
    const tools = require('./core/claude-subscription-profiles');
    const owner = tools.normalizeProfiles(getHubConfig().claudeSubscriptionProfiles)
      .find(p => p.home && path.resolve(p.home).toLowerCase() === path.resolve(dir).toLowerCase());
    const pinnedEnv = owner ? require('./core/claude-account-network').environment(owner) : null;
    const report = require('./core/claude-profile-align').alignClaudeProfile({
      primaryDir: path.join(home, '.claude'), primaryStateFile: path.join(home, '.claude.json'), profileDir: dir, pinnedEnv });
    if (report.backup) console.log(`[claude-profile-align] 首次对齐，原配置已备份到 ${report.backup}`);
    if (report.errors.length) console.warn(`[claude-profile-align] ${dir}：${report.errors.join('；')}`);
  } catch (error) { console.warn(`[claude-profile-align] ${dir}：${error.message}`); }
}

function ensureHooksDeployed(claudeDirPath) {
  const claudeDir = claudeDirPath;
  const srcDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  const hookResult = ensureClaudeHookIntegration({
    claudeDir,
    sourceScriptsDir: srcDir,
    logger: console,
  });
  if (hookResult.errors.length) {
    console.warn(`[claude-hooks] ${claudeDir}: ${hookResult.errors.join('；')}`);
  }

  // Ensure .claude.json project trust — Claude Code 将"信任文件夹"状态
  //    存在 .claude.json 而非 settings.json。隔离配置(~/.claude-deepseek)缺少
  //    主配置(~/.claude)的历史信任记录，需要每次启动检查并修复。
  const statePath = path.join(claudeDir, '.claude.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    if (state.projects && typeof state.projects === 'object') {
      let trustChanged = false;
      for (const [projectDir, proj] of Object.entries(state.projects)) {
        if (proj && typeof proj === 'object' && proj.hasTrustDialogAccepted === false) {
          proj.hasTrustDialogAccepted = true;
          trustChanged = true;
          console.log(`[群聊] .claude.json trust fixed: ${projectDir}`);
        }
      }
      if (trustChanged) {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
        console.log('[群聊] .claude.json trust state updated');
      }
    }
  } catch { /* .claude.json 不存在或格式异常，跳过（首次启动可能尚未生成） */ }
}

// Repair only the known duplicate blocks left by old Hub versions. The
// missing status line is supplied per launch, never appended to user config.
function ensureCodexContextConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const configPath = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  try {
    require('./core/codex-user-config-guard').repairUserCodexConfigFile(configPath);
  } catch (e) {
    console.warn('[群聊] codex config patch failed:', e.message);
  }
}

function ensureGeminiMcpInstalled() {}

// Read the last user message text from a Claude Code transcript JSONL file.
// Reads the trailing chunk(s) only (not the whole file) — long sessions can be
// 10MB+ and we used to readFileSync the whole thing on every hook POST, which
// stalled the main-process event loop. Now we seek from EOF and walk backward
// in 64KB chunks until we hit the first complete `user`-typed entry.
// Returns null on any failure — caller should treat absence as non-fatal.
async function readLastUserMessage(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // The first fragment may be an incomplete line — keep it for the next pass
      // by prepending it back to `tail`, except when we've reached the very start.
      const firstFragment = pos === 0 ? null : lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const role = entry.type || entry.role;
        if (role !== 'user') continue;
        const msg = entry.message;
        let text = '';
        if (typeof msg === 'string') {
          text = msg;
        } else if (msg && typeof msg.content === 'string') {
          text = msg.content;
        } else if (msg && Array.isArray(msg.content)) {
          // CC stores tool_result entries as role=user too (Anthropic API
          // convention). Skip those — they pollute the preview with strings
          // like "[Image: source: ]" pulled from tool return payloads.
          const hasTool = msg.content.some(c => c && c.type === 'tool_result');
          if (hasTool) continue;
          text = msg.content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ').trim();
        }
        // 后台任务 / Monitor 的续跑由引擎注入，不是用户说的话，继续往前找真正的提问。
        if (entry.origin?.kind === 'task-notification' || isTaskNotificationText(text)) continue;
        if (text) return text;
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

const { listenWithPortFallback, fallbackMessage } = require('./core/port-fallback');
let hookBinding = { port: null, failures: [] };
// Random per-launch token; hook POSTs must carry it. Stops any other local
// process from forging unread bumps.
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');
const TEAM_SECRET = crypto.randomBytes(32);
const teamTokenFor = hubSessionId => crypto.createHmac('sha256', TEAM_SECRET).update(hubSessionId).digest('hex');

let hookPort = null;  // set after listen() succeeds
let claudeHookWatchdog = null;
let codeagentSettingsWatch = null; // 个人账号 settings.json 默认模型的留痕（core/codeagent-default-model-guard.js）
let windowsShellWatchdog = null;

let mainWindow;
let desktopNotificationController = null;
function desktopNoticesAllowed(payload = {}) {
  return hubPetController?.getSettings?.()?.notifyMode !== 'off'
    || require('./core/hub-pet/settings').isUrgentNotice(payload);
}
let hubPetController = null;
// 桌宠「敲键盘」看的是助理会话本轮是否还在跑（CLI hook 报告的状态）。
const HUB_PET_ASSISTANT_PURPOSES = new Set(['company-assistant', 'hub-assistant']);
const sessionManager = new SessionManager();
// 会话的 CLI 进程还在不在：true 在 / false 已退出 / null 说不准（会话没打开、没有进程号）。公司联动与助理共用。
function sessionProcessAlive(id) {
  // CodeAgent-Lite 正在改回终端：旧对象收尾、新进程未建的窗口里说不准，别让助理把它判死。
  if (sessionManager.serveFallbackPending?.(id)) return null;
  const entry = sessionManager.sessions?.get?.(id);
  if (!entry) return null; // 会话已关闭由调用方单独判断
  if (entry.confirmedExit) return false;
  const pid = Number(entry.pty?.pid);
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; }
}
const { SessionTokenUsageService } = require('./main/usage/session-token-usage-service.js');
const { isSessionViewer } = require('./core/session-observer-policy');
const { createContentUpdateBatcher } = require('./core/content-update-batcher');
const nativeItemNotifications = createContentUpdateBatcher();
const sessionUsageService = new SessionTokenUsageService({
  publish(id, usage) {
    const current = sessionManager.getSession(id);
    if (!current || current.status === 'exited') return;
    const persisted = lastPersistedSessions.find(item => item.hubId === id);
    const old = current?.sessionUsage || persisted?.sessionUsage;
    if (old?.sourcePath === usage.sourcePath && old.total > usage.total) return;
    const updated = sessionManager.updateSessionMeta(id, { sessionUsage: usage });
    if (persisted) persisted.sessionUsage = usage;
    if (updated) sessionStore.markDirty(id, updated);
    sendToRenderer('session-usage-updated', { sessionId: id, usage });
  },
});
sessionManager.on('session-token-usage', event => {
  sessionUsageService.native(sessionManager.getSession(event.sessionId), event.total, event.source);
});
sessionManager.on('session-usage-snapshot',event=>sessionUsageService.publish(event.sessionId,event.usage));
sessionManager.on('session-exited', event => sessionUsageService.remove(event.sessionId));
transcriptTap.on('session-bound', event => {
  const session = sessionManager.getSession(event.hubSessionId);
  if (session) sessionUsageService.bind({ ...session, transcriptPath: event.transcriptPath || event.rolloutPath || session.transcriptPath });
});
// 提示闸门拦下的提示（renderer 的 core/notice-gate.js）：不打扰用户，只记进 window-events.log，诊断包里能看到。每小时最多记 300 行。
let noticeMutedWindow = { start: 0, count: 0, overflow: new Map() };
// 每小时最多逐条记 300 行；超出的按原因聚合计数，下一小时开头或退出时补 notice-muted-overflow 行（次数 + 最后一次时间和原文）。
function flushNoticeMutedOverflow() {
  const over = noticeMutedWindow.overflow;
  if (!over || !over.size) return;
  for (const [reason, v] of over) searchEventLog('notice-muted-overflow', { reason: reason.slice(0, 200), count: v.count, lastAt: new Date(v.lastAt).toISOString(), lastMessage: v.lastMessage });
  over.clear();
}
app.once('will-quit', () => { try { flushNoticeMutedOverflow(); } catch { /* 退出时日志写不了就算了 */ } });
ipcMain.on('notice-gate:muted', (_event, detail) => {
  const now = Date.now();
  if (now - noticeMutedWindow.start > 3600000) { flushNoticeMutedOverflow(); noticeMutedWindow = { start: now, count: 0, overflow: new Map() }; }
  const d = detail && typeof detail === 'object' ? detail : {};
  if (++noticeMutedWindow.count > 300) {
    const over = noticeMutedWindow.overflow;
    const reason = `${d.why || ''}|${d.sessionId || '-'}|${require('./core/notice-gate').normalizeReason(d.message).slice(0, 160)}`;
    const v = over.get(reason) || { count: 0, lastAt: 0, lastMessage: '' };
    v.count += 1; v.lastAt = now; v.lastMessage = String(d.message || '').slice(0, 300);
    if (over.size < 500 || over.has(reason)) over.set(reason, v);
    return;
  }
  searchEventLog('notice-muted', { why: String(d.why || ''), kind: String(d.kind || ''), level: String(d.level || ''), sessionId: String(d.sessionId || '').slice(0, 80), message: String(d.message || '').slice(0, 300) });
});

ipcMain.on('session-usage:watch', (_event, ids) => {
  if (!Array.isArray(ids)) return;
  for (const id of new Set(ids.filter(id => typeof id === 'string'))) {
    const session = sessionManager.getSession(id);
    if (session) sessionUsageService.bind(session);
  }
});
sessionManager.on('managed-launch', (record) => {
  appendManagedLaunchAudit(record, { logger: console });
});
sessionManager.on('codex-session-updated', session => {
  sessionUsageService.bind(session);
  sessionStore.markDirty(session.id, session);
  sendToRenderer('session-updated', {session});
});
sessionManager.on('codex-content-updated', event => sendToRenderer('codex-content-updated',event));
sessionManager.on('codex-backstage-updated', event => sendToRenderer('codex-backstage-updated',event));
sessionManager.on('codex-locate-request', ({ sessionId }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendToRenderer('codex-focus-session', { sessionId });
  }
});
// Token Plan 额度用完的改道控制器（main/token-plan-fallback-controller.js），会话操作就绪后才创建。
let tokenPlanFallback = null;
// 软压缩：AI 在断点留标记后，Hub 替用户发 /compact（main/soft-compact-controller.js）。
let softCompact = null;
sessionManager.on('codex-lifecycle', event => {
  // 千问把额度墙包成普通回答：先改成本轮失败，再交给群聊、通知与卡片。
  const ev = tokenPlanFallback ? tokenPlanFallback.filterLifecycle(event) : event;
  transcriptTap.emit(ev.type, ev);
});
const meetingManager = new MeetingRoomManager();
require('./core/work-file-root').configureAtStartup(getHubConfig().workFileRoot, getHubConfig().workFileRootHistory);
// Hub 设置里的「新建会话默认工作目录」先于工作区服务生效（环境变量 AI_HUB_WORKSPACE_ROOT 仍优先）。
// 启动时重新校验：目录不存在、是盘根/主目录/Hub 目录就当没设，设置页显示原因。
try { require('./main/ipc/config-handlers.js').startupDefaultWorkspaceRoot(getHubConfig().defaultWorkspaceRoot); }
catch (error) { console.warn('[workspace] default root setting:', error && error.message); }
const workspaceService = new WorkspaceService();
let networkEgressProbe;
if (process.env.CLAUDE_HUB_E2E === '1' && process.env.CLAUDE_HUB_EGRESS_FIXTURE) {
  try {
    networkEgressProbe = createNetworkEgressFixtureProbe(
      JSON.parse(process.env.CLAUDE_HUB_EGRESS_FIXTURE),
    );
  } catch (error) {
    console.warn('[network-egress] invalid E2E fixture:', error && error.message);
  }
}
const windowsNetworkContext = require('./core/windows-network-context').createWindowsNetworkContext();
// 系统代理出口的后备探测（2026-10-18）：独立的会话分区，代理模式固定为「系统设置」，不受 Hub 其他会话的代理影响。
let egressProbeSession = null;
async function systemProxyFetch(url, { timeoutMs = 12000 } = {}) {
  const { session } = require('electron');
  if (!egressProbeSession) {
    egressProbeSession = session.fromPartition('egress-probe');
    await egressProbeSession.setProxy({ mode: 'system' });
  }
  const response = await egressProbeSession.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'AI-Hub-Network-Monitor/1.0' }, signal: AbortSignal.timeout(timeoutMs), bypassCustomProtocolHandlers: true });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}
const networkEgressMonitor = createNetworkEgressMonitor({
  getProxy: () => getHubConfig().proxy,
  systemFetch: (url, opts) => systemProxyFetch(url, opts),
  getSystemProxy: () => windowsNetworkContext.systemProxy(),
  getTunnel: () => windowsNetworkContext.tunnel(),
  statePath: path.join(getHubDataDir(), 'network-egress-state.json'),
  ...(networkEgressProbe ? { probe: networkEgressProbe } : {}),
  logger: console,
});
const completionNotifier = new CompletionNotifier({
  getConfig: getHubConfig,
  getLogPath: () => path.join(getHubDataDir(), 'notification-delivery.jsonl'),
  renderHtmlPreview: createHtmlArtifactPreviewRenderer({
    BrowserWindow,
    getOutputDir: getHubDataDir,
    logger: console,
  }),
  logger: console,
});
// SessionManager 构造不接收依赖；kimi 会话 spawn 前的 AGENTS.md seed 需要它
// （core/session-manager.js 里 this.workspaceService.seedUngovernedAgentsFile）。
sessionManager.workspaceService = workspaceService;
const workspaceMigrationSessionIds = new Set();

// 原生 Claude 撞到额度上限后的等待与续跑。CLI 的 REPL 以前自己干这件事，
//   stream-json 传输下没有输入框可敲，于是等待和发送都搬到 Hub 这边来。
//   判据全在 core/claude-quota-watchdog.js，这里只负责副作用。
const claudeQuotaResume = createClaudeQuotaResume({
  sessionManager,
  statePath: path.join(getHubDataDir(), 'claude-quota-waits.json'),
  isEnabled: () => getHubConfig().claudeQuotaAutoResume !== false,
  logger: console,
});

const claudeAccountFetch = require('./core/claude-account-network').createAccountFetch({
  legacyFetch: (url, options) => require('electron').net.fetch(url, options),
  sharedProxy: () => require('./core/claude-subscription-profiles').sharedNetworkEnv(getHubConfig()).HTTPS_PROXY,
});
// 额度预压缩 + 主动换号（main/claude-quota-precompact.js）；用量回调里要用到，先占位。
let claudeQuotaPrecompact = null;
const claudeAccountBroker = require('./core/claude-account-credentials').createClaudeCredentialBroker({
  stateDir: path.join(getHubDataDir(), 'claude-account-refresh'),
  request: async (url, options = {}, profile) => {
    const response = await claudeAccountFetch(profile, url, { ...options, signal: AbortSignal.timeout(15_000) });
    let data = null, errorCode = '';
    if (response.status === 200) data = await response.json();
    // 失败时只取 OAuth 错误码（如 invalid_grant）进刷新日志，便于区分凭据作废和别的原因；正文不保留。
    else { try { const body = await response.json(); errorCode = typeof body?.error === 'string' ? body.error : typeof body?.error?.type === 'string' ? body.error.type : ''; } catch {} }
    const retryAfter = response.headers.get('retry-after');
    return { status: response.status, data, errorCode, retryAfterMs: /^\d+$/.test(retryAfter || '')
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0 };
  },
  // Request-free readings (status line, earlier answers) for the same account.
  cachedUsage: profile => claudeCache(currentClaudeScope(profile.id)),
  onUsage: (profile, snapshot) => {
    const window = value => value && typeof value.utilization === 'number'
      ? { pct: value.utilization, resetsAt: Date.parse(value.resets_at) || 0 } : null;
    cacheAccountUsage({ usage5h: window(snapshot.usage.five_hour), usage7d: window(snapshot.usage.seven_day), ts: snapshot.observedAt }, currentClaudeScope(profile.id));
    try { claudeQuotaPrecompact?.onUsage(profile, snapshot); }
    catch (error) { console.warn('[quota-precompact] onUsage failed:', error.message); }
  },
});
// 账号风控标记（2026-10-31）：观察期内不推荐，自动换号不选；手动使用不受限。
const accountRiskStore = require('./core/account-risk-flags').createAccountRiskStore({ dataDir: getHubDataDir() });
const claudeAccountSwitch = require('./main/claude-account-switch').createClaudeAccountSwitch({
  sessionManager, broker: claudeAccountBroker,
  isRiskFlagged: id => accountRiskStore.isFlagged('claude', id),
  profiles: () => {
    const tools = require('./core/claude-subscription-profiles');
    const config = getHubConfig();
    return tools.normalizeProfiles(config.claudeSubscriptionProfiles).map(p => tools.resolveProfile(config, p.id));
  },
  scopeFor: id => require('./core/claude-subscription-profiles').usageScope(getHubConfig(), id),
  sendToPty: (...args) => require('./core/group-chat-watcher').sendToPty(...args),
  drainSubmission: id => require('./core/group-chat-watcher').drainSubmission(id),
  saveSession: session => sessionStore.saveSessionFile(session.id, session),
  prefreshEnabled: () => getHubConfig().claudeBackend !== 'api',
  // 换号后在新进程里接着原对话，并换一个新的原生会话编号（2026-10-28）。
  relaunch: (id, guard) => relaunchClaudeAfterAccountSwitch(id, guard),
  // 跨出口换号前经目标线路实测出口 IP（2026-10-29）：专线对配置 IP，共享出口对已记录的基线。
  verifyRoute: profile => {
    const tools = require('./core/claude-subscription-profiles'), network = require('./core/claude-account-network');
    let sharedProxy = null, sharedBaseline = null;
    try { sharedProxy = network.sharedRouteProxy(tools.sharedNetworkEnv(getHubConfig()).HTTPS_PROXY); } catch {}
    try { sharedBaseline = JSON.parse(fs.readFileSync(path.join(getHubDataDir(), 'claude-egress-baseline.json'), 'utf8')).shared || null; } catch {}
    return network.verifyRoute(profile, { sharedProxy, sharedBaseline });
  },
});
function relaunchClaudeAfterAccountSwitch(id, guard) {
  return sessionOperations.restartSession(id, { claudeForkOnResume: true }, { reason: 'account-switch', guard });
}
sessionManager.claudeAccountSwitch = claudeAccountSwitch;
try {
  claudeQuotaPrecompact = require('./main/claude-quota-precompact').createClaudeQuotaPrecompact({
    sessionManager, broker: claudeAccountBroker,
    isRiskFlagged: id => accountRiskStore.isFlagged('claude', id),
    profiles: () => {
      const tools = require('./core/claude-subscription-profiles');
      const config = getHubConfig();
      return tools.normalizeProfiles(config.claudeSubscriptionProfiles).map(p => tools.resolveProfile(config, p.id));
    },
    // 2026-10-29 起可跨出口换号：候选不再限同出口，出口核对在换号那一步做。
    sameRoute: () => true,
    requestAccount: (id, profileId) => claudeAccountSwitch.requestAccount(id, profileId),
    notify: (sessionId, message, level) => sendToRenderer('session-notice', { sessionId, message, level }),
  });
} catch (error) { console.error('[quota-precompact] unavailable:', error.message); }
ipcMain.handle('session:set-claude-auto-switch', (_event, payload = {}) => claudeAccountSwitch.setAutoSwitch(payload.sessionId, payload.enabled));
ipcMain.handle('session:claude-account-options', (_event, payload = {}) => claudeAccountSwitch.accountOptions(payload.sessionId));
ipcMain.handle('session:set-claude-account', (_event, payload = {}) => claudeAccountSwitch.requestAccount(payload.sessionId, payload.profileId));
const restartCodexAccount = require('./main/codex-account-restart').createCodexAccountRestart({
  sessionManager, restartSession:(...args) => sessionOperations.restartSession(...args),
  saveSession:session => sessionStore.saveSessionFile(session.id,session), sendToRenderer,
  confirmResume:(session,guard)=>require('./main/codex-account-status').confirmCodexAccountResume({
    manager:sessionManager,session,guard,sendToPty:(...args)=>require('./core/group-chat-watcher').sendToPty(...args)}),
  validateLaunch:session=>ensureCodexAccountNamespace(session.kind,session),
});
const codexCredentialBackoff = new Map();
const codexAccountSwitch = require('./main/codex-account-switch').createCodexAccountSwitch({
  sessionManager,
  isRiskFlagged: id => accountRiskStore.isFlagged('codex', id),
  profiles:() => {
    const config = require('./core/codex-global-account').currentConfig();
    return config.codexSubscriptionProfiles.map(profile => {
      // One unusable account (e.g. a built-in home outside an isolated test root)
      // is listed as unavailable; it must not make every send in the Hub fail.
      let resolved;
      try { resolved = require('./core/codex-global-account').resolveAccount({...config,codexSubscriptionProfile:profile.id}); }
      catch (error) { return {id:profile.id,label:profile.label,home:'',available:false,reason:error.message}; }
      let available = false;
      try {
        const auth = JSON.parse(fs.readFileSync(path.join(resolved.home,'auth.json'),'utf8').replace(/^\uFEFF/,''));
        available = !!auth.tokens?.access_token && !auth.OPENAI_API_KEY;
      } catch { /* Missing or unreadable credentials are displayed as unavailable. */ }
      return {...resolved,available,reason:available ? '' : '此账号尚未登录，请在账号中心登录'};
    });
  },
  readUsage:profile => readCodexAccountUsage({home:profile.home,proxy:getHubConfig().proxy,
    env:require('./main/codex-account-namespace').cleanCodexAccountEnv(process.env),
    cwd:os.homedir(),timeoutMs:12000,exactPercent:true}),
  prepareCredentials:async (id,profile) => {
    const session = sessionManager.getSession(id);
    if (!session?.codexRuntimeHome) return {needsRestart:false};
    const runtime = require('./core/codex-account-runtime');
    let state;
    try { state = runtime.getCredentialState(profile,session.codexRuntimeHome); }
    catch (error) { if (error.code !== 'CODEX_RUNTIME_EXPIRED') throw error; }
    if (!state || (state.expiresAt && state.expiresAt-Date.now() < 120000)) {
      if ((codexCredentialBackoff.get(profile.id) || 0) > Date.now()) throw new Error('账号凭据续期暂未完成，请稍后再试；消息未发送');
      try {
        await readCodexAccountUsage({home:profile.home,proxy:getHubConfig().proxy,cwd:os.homedir(),
          env:require('./main/codex-account-namespace').cleanCodexAccountEnv(process.env),
          timeoutMs:12000,refreshCredentials:true,exactPercent:true});
        state = runtime.getCredentialState(profile,session.codexRuntimeHome);
      } catch (error) { codexCredentialBackoff.set(profile.id,Date.now()+60000); throw error; }
    }
    return {needsRestart:state.needsUpdate};
  },
  switchAccount:restartCodexAccount,
  sendToPty:(...args) => require('./core/group-chat-watcher').sendToPty(...args),
  saveSession:session => sessionStore.saveSessionFile(session.id,session),
});
sessionManager.codexAccountSwitch = codexAccountSwitch;
ipcMain.handle('session:set-codex-auto-switch', (_event,payload={}) => codexAccountSwitch.setAutoSwitch(payload.sessionId,payload.enabled));
ipcMain.handle('session:codex-account-options', (_event,payload={}) => codexAccountSwitch.accountOptions(payload.sessionId));
ipcMain.handle('session:set-codex-account', (_event,payload={}) => codexAccountSwitch.requestAccount(payload.sessionId,payload.profileId));
function codexAccountTurnEvent(ev) {
  const session = sessionManager.getSession(ev.hubSessionId);
  return {sessionId:ev.hubSessionId,nativeSessionId:ev.codexSid || session?.codexSid,
    turnId:ev.turnId,at:normalizeEventTime(ev.startedAt ?? ev.failedAt ?? ev.completedAt,Date.now()),
    prompt:ev.prompt || ev.text,error:ev.message,errorDetails:ev.errorInfo};
}
async function ensureCodexAccountNamespace(kind,opts={}) {
  if (!/^codex(?:-resume)?$/.test(kind) || !(opts.codexAccountPinned || opts.codexRuntimeHome)
      || require('./core/chatgpt-web-models').isChatgptWebModel(opts.model)) return;
  const config = require('./core/codex-global-account').currentConfig();
  if (config.companyCli || config.codexBackend === 'api') return;
  const context = require('./core/codex-global-account').resolveAccount({...config,
    codexSubscriptionProfile:opts.codexContextProfile || opts.codexProfile || config.codexSubscriptionProfile});
  let cwd=opts.cwd;
  try { if (!cwd || !fs.statSync(cwd).isDirectory()) cwd=null; } catch {cwd=null;}
  const namespace=require('./main/codex-account-namespace');
  await namespace.assertCodexAccountNamespace({cache:namespace.passCache,
    home:opts.codexRuntimeHome || context.home,cwd:cwd || process.env.USERPROFILE || process.env.HOME || os.homedir(),env:process.env});
}


sessionManager.on('session-updated', session => {
  if (isCodeAgentKind(session.kind)) {
    sessionStore.markDirty(session.id, sessionManager.getSession(session.id));
    sendToRenderer('session-updated', { session });
    return;
  }
  if (session.agentRuntime === 'pty' && /^codex(?:-resume)?$/.test(session.kind) && session.codexProfile) {
    sessionStore.markDirty(session.id, sessionManager.getSession(session.id));
    sendToRenderer('session-updated', {session});
    queueMicrotask(() => codexAccountSwitch.onRuntimeChanged(session.id));
    return;
  }
  if (session.agentRuntime === 'pty' && session.claudeRuntimeHome) {
    sessionStore.markDirty(session.id, sessionManager.getSession(session.id));
    sendToRenderer('session-updated', { session });
    return;
  }
  if (session.agentRuntime === 'pty' && isCodexCliKind(session.kind) && session.runtimeTruth) {
    sendToRenderer('session-updated', { session });
    return;
  }
  if (session.runtimeBackend !== 'claude-stream-json') return;
  sessionUsageService.bind(session);
  if(!isSessionViewer(session))sessionStore.markDirty(session.id, sessionManager.getSession(session.id));
  sendToRenderer('session-updated', { session });
});
sessionManager.on('native-agent-item', event => {
  const {sessionId,source,userMessageId,clientSubmissionId,epoch,providerSessionId}=event;
  nativeItemNotifications.schedule(sessionId,userMessageId || clientSubmissionId || '',()=>
    sendToRenderer('native-agent-item',{sessionId,source,userMessageId,clientSubmissionId,epoch,providerSessionId}));
});
sessionManager.on('native-agent-lifecycle', event => {
  nativeItemNotifications.flush(event.sessionId);
  if (event.signalSource !== 'claude-stream-json') return;
  const native = sessionManager.getNativeClaude(event.sessionId);
  const record = native?.records.get(event.clientSubmissionId);
  if (!native || !record) return;
  const payload = { ...event, submittedAt: record.createdAt, startedAt: native.runtime.startedAt,
    completedAt: native.runtime.completedAt, transcriptPath: null };
  if (event.type === 'submission-accepted') {
    transcriptTap.emit('prompt-submitted', { ...payload, text: record.text });
    sendToRenderer('session:prompt-receipt', { sessionId: event.sessionId,
      clientSubmissionId: event.clientSubmissionId, status: 'confirmed' });
  } else if (event.type === 'agent-turn-started') transcriptTap.emit('turn-started', payload);
  else if (event.type === 'agent-turn-complete') {
    if (event.status === 'completed') transcriptTap.emit('turn-complete', payload);
    else if (event.status === 'interrupted') transcriptTap.emit('turn-aborted', payload);
    else transcriptTap.emit('turn-error', { ...payload, message: native.runtime.reason });
    // 只有失败的一轮会武装等待，而且要在失败之后重读一次账号额度才作数。
    void Promise.resolve(claudeQuotaResume.onTurnComplete(event))
      .catch(error => console.warn('[claude-quota] arm failed:', error && error.message));
  }
});

// Deep-summary service singleton: instantiated from config-driven fallback chain.
// Providers tried in order; first one with a parseable response wins.

// Claude / CodeAgent / Codex: refresh from the bound transcript at turn end.
// Stop hook 那一刻才开始盯的记录拿不到 model（尾巴从文件末尾读起），这时从记录末尾补读最后一条回答的 model。
// 2026-10-13 公司真机：会话答了几十轮，Hub 一次实际模型都没记下（回合结束事件没走到这里）。
// 所以 CodeAgent 的 Stop hook 也直接来这里读一次（via=stop-hook）。
// 两条路可能乱序：完成事件携带的 tail 缓存可落后于磁盘，模型与用量必须取同一条最新回答。
// 按实际 writer 排序异步读取；关闭重开或读期间改选模型后，旧结果不能回写。
const codeAgentModelObservations = new WeakMap();
async function observeCodeAgentModel(hubSessionId, ev, transcriptPath, source = 'turn-complete') {
  try {
    const writer = sessionManager.sessions.get(hubSessionId);
    const before = sessionManager.getSession(hubSessionId);
    if (!writer || !before) return;
    const observation = { epoch: writer.modelSubmissionEpoch };
    codeAgentModelObservations.set(writer, observation);
    const requestedModel = before.currentModel?.id;
    const codeAgentModels = require('./core/codeagent-models');
    const actualModels = require('./core/session-actual-model');
    const file = before.transcriptPath;
    const last = await actualModels.readActualModel(before, { file,
      parserService: typeof transcriptParserService === 'undefined' ? null : transcriptParserService });
    if (!last) return;
    const modelId = last.model.trim(), modelAt = last.ts, usage = last.usage || null;
    let session = sessionManager.getSession(hubSessionId);
    if (!session || sessionManager.sessions.get(hubSessionId) !== writer
      || ['closed', 'dormant', 'exited'].includes(session.status)
      || writer.closeRequestedAt || writer.suspendRequestedAt || writer.confirmedExit || writer.pty?.closed
      || codeAgentModelObservations.get(writer) !== observation
      || session.currentModel?.id !== requestedModel
      || session.fixedModel !== before.fixedModel
      || session.ccSessionId !== before.ccSessionId || session.codexSid !== before.codexSid
      || writer.modelSubmissionEpoch !== observation.epoch
      || session.transcriptPath !== before.transcriptPath) return;
    // Apply the same confirmation floor to every provider, before any model
    // or usage update. Missing/equal timestamps cannot prove a newer answer.
    if (Number.isFinite(session.modelSwitchConfirmedAt)
      && (!Number.isFinite(modelAt) || modelAt <= session.modelSwitchConfirmedAt)) return;
    if (!codeAgentModels.isCodeAgentSession(session)) {
      const fields = actualModels.actualModelFields(session, modelId);
      if (Object.keys(fields).length) {
        const updated = sessionManager.updateSessionMeta(hubSessionId, fields);
        if (updated) { sessionStore.markDirty(hubSessionId, updated); sendToRenderer('session-updated', { session: updated }); }
      }
      return;
    }
    // 上下文占比（输入框旁的圆环）：CodeAgent 没有状态栏回调，按这一轮的用量算，见 core/codeagent-models.js。
    if (session && usage) {
      const configDir = session.codeagentConfigDir || require('./core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      const { window } = codeAgentModels.contextWindowFor(configDir, [session.currentModel?.id, modelId], fs,
        { dataDir: getHubDataDir(), accountKey: session.codeagentPoolAccount || 'personal', provider: session.codeagentModelProvider || session.currentModel?.provider || '' });
      const context = codeAgentModels.contextFromUsage(usage, window);
      if (context && (context.contextUsed !== session.contextUsed || context.contextEffectiveMax !== session.contextEffectiveMax)) {
        const withContext = sessionManager.updateSessionMeta(hubSessionId, context);
        if (withContext) { session = withContext; sessionStore.markDirty(hubSessionId, withContext); }
        sendToRenderer('status-event', { sessionId: hubSessionId, ...context });
      }
    }
    // 后台（终端里 /model）换了模型时，把回答里的后端模型名对回这个号的模型清单（同版本号候选里优先 CodeAgent 当前默认模型）。
    const resolveSwitch = actual => {
      const guard = require('./core/codeagent-default-model-guard');
      const dir = guard.sessionConfigDir(session, { dataDir: getHubDataDir() });
      return require('./core/codeagent-resume-model').resolveAccountModel(actual, {
        dataDir: getHubDataDir(), configDir: dir, accountKey: session.codeagentPoolAccount || 'personal',
      });
    };
    const observed = session && modelId ? codeAgentModels.observeModel(session, modelId, { at: modelAt, resolveSwitch, followActual: true }) : null;
    // 分身启动没选上、用户到后台终端里手动 /model 选上了：回答的实际模型就是所选的，撤掉分身页的提示（R53b）。
    try {
      // 回答里报的是后端名（maas-glm-5-3-*）时，按观察到的会话模型名、再按对回号清单的模型名认（复审 2 P2-1）。
      if (session?.codeagentPickMiss && require('./core/avatar/agent-session').pickMissResolvedByAnswer(session, modelId,
        { observedModel: observed?.fields?.currentModel?.id || '', resolveSwitch })) {
        sessionManager.updateSessionMeta(hubSessionId, { codeagentPickMiss: null });
        sendToRenderer('avatar:changed', {});
      }
    } catch (error) { console.warn('[codeagent-model] 撤分身选型提示失败：' + error.message); }
    try {
      if (source === 'turn-complete' && !session.purpose && !session.autonomous && !observed?.mismatch
        && !require('./core/company-assistant/turn-api-error').lastApiError(file)) {
        const configDir = session.codeagentConfigDir || require('./core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
        let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')); } catch { /* 无配置时只认明确的会话线路。 */ }
        require('./core/codeagent-assistant-route').rememberSuccess(getHubDataDir(), session, last, {
          options: codeAgentModels.modelOptions(getHubDataDir(), { configDir, accountKey: session.codeagentPoolAccount || 'personal' }), settings });
      }
    } catch (error) { console.warn('[codeagent-model] 保存手动成功线路失败：' + error.message); }
    if (observed || !modelId) {
      codeAgentModels.appendModelLog(getHubDataDir(), {
        event: 'observe', via: source, session: String(hubSessionId || '').slice(0, 8),
        current: session?.currentModel?.id, actual: modelId || '(none)', transcript: file ? 'yes' : 'no',
        switched: observed?.fields?.currentModel?.id,
        ...(observed?.backendSwitch ? { backendSwitch: observed.backendSwitch.resolved ? 'menu' : 'display-only' } : {}),
      });
    }
    if (!observed) return;
    if (observed.fields.fixedModel && writer.codeagentSettingsActive) {
      // Only a transcript-confirmed, catalog-resolved launch id may replace
      // the session's --settings pin. Unknown backend spellings stay display-only.
      try {
        require('./core/session-manager')._private.writeCodeAgentLaunchSettings(getHubDataDir(), hubSessionId, observed.fields.fixedModel);
      } catch (error) {
        delete observed.fields.fixedModel;
        delete observed.fields.codeagentUserModel;
        delete observed.fields.modelPinSource;
        delete observed.fields.modelChange;
        sendToRenderer('session-notice', { sessionId: hubSessionId, level: 'warning',
          message: `实际模型已确认，但同步会话启动设置失败：${error.message}` });
      }
    }
    if (observed.settingsOnlyVerification) codeAgentModels.appendModelLog(getHubDataDir(), { event: 'switch-settings-only-verified',
      session: String(hubSessionId).slice(0, 8), ...observed.settingsOnlyVerification });
    const updated = Object.keys(observed.fields).length ? sessionManager.updateSessionMeta(hubSessionId, observed.fields) : null;
    if (updated) {
      sessionStore.markDirty(hubSessionId, updated);
      sendToRenderer('session-updated', { session: updated });
    }
    if (observed.mismatch) {
      codeAgentModels.appendModelLog(getHubDataDir(), { event: 'switch-mismatch', session: String(hubSessionId).slice(0, 8),
        requested: observed.mismatch.requested, actual: observed.mismatch.actual });
      sendToRenderer('session-notice', { sessionId: hubSessionId, message: codeAgentModels.mismatchNotice(observed.mismatch), level: 'warning' });
    }
    if (codeAgentModels.recordObserved(getHubDataDir(), modelId)) {
      sendToRenderer('codeagent-models-changed', { options: require('./core/codeagent-config').localModelOptions(getHubDataDir()) });
    }
  } catch (error) {
    console.warn('[codeagent-model] observe failed:', error && error.message);
  }
}

// Wire TranscriptTap → MeetingRoomManager timeline.
// When a sub-session's CLI finishes a turn, append the AI text to its
// meeting's timeline (if the sub-session belongs to a meeting).
transcriptTap.on('turn-complete', (ev) => {
  const { hubSessionId, text, completedAt } = ev || {};
  try { assistantService?.onTurnComplete?.(hubSessionId, { ...(ev || {}), completedAt: normalizeEventTime(completedAt, Date.now()) }); } catch (error) { console.warn('[assistant] usage', error.message); }
  sessionManager.noteAgentTurnFinished(hubSessionId, ev || {});
  codexAccountSwitch.onCompleted(codexAccountTurnEvent(ev || {}));
  const completionAt = normalizeEventTime(completedAt, Date.now());
  let session = sessionManager.getSession(hubSessionId);
  // Persist reply recency in main as well as renderer. This closes the gap where
  // a renderer reload/suspend between transcript completion and its IPC handler
  // left a dormant card anchored to the prompt time.
  if (session && completionAt >= (Number(session.lastCompletedAt) || 0)) {
    const updated = sessionManager.updateSessionMeta(hubSessionId, { lastCompletedAt: completionAt });
    if (updated) {
      session = updated;
      sessionStore.markDirty(hubSessionId, updated);
    }
  }
  if (session && /^codeagent(?:-resume)?$/.test(String(session.kind || ''))) {
    require('./core/codeagent-usage-menu').markUsageDirty(getHubDataDir(), session.codeagentPoolAccount || 'personal');
    void observeCodeAgentModel(hubSessionId, ev || {}, session.transcriptPath);
  } else if (session && require('./core/session-actual-model').transcriptKind(session)) {
    void observeCodeAgentModel(hubSessionId, ev || {}, session.transcriptPath);
  }
  Promise.resolve(completionNotifier.handleTurnComplete(ev || {}, session)).catch((error) => {
    console.warn('[completion-notifier] session completion handling failed:', error && error.message);
  });
  if (session && session.meetingId) {
    const turn = meetingManager.appendTurn(
      session.meetingId,
      hubSessionId,
      text,
      completionAt,
    );
    if (turn) {
      sendToRenderer('meeting-timeline-updated', { meetingId: session.meetingId, turn });
    }
    // (Driver-mode auto-review removed when driver mode was deprecated.)
  }

  // spec2/S3：把 turn-complete 广播给 renderer，供历史会话/侧边栏卡片实时刷新。
  // 注意：这里独立于上面的 meeting timeline 逻辑——非群聊的普通会话也要广播。
  try {
    let transcriptPath = ev && ev.transcriptPath ? ev.transcriptPath : null;
    if (!transcriptPath && session && session.transcriptPath) {
      transcriptPath = session.transcriptPath;
    }
    if (!transcriptPath && session && session.ccSessionId) {
      try { transcriptPath = findTranscriptByCCSessionId(session.ccSessionId); } catch {}
    }
    sendToRenderer('turn-complete-event', {
      hubSessionId,
      ccSessionId: session ? session.ccSessionId : null,
      transcriptPath,
      text,
      completedAt: completionAt,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      durationMs: ev ? ev.durationMs : null,
      signalSource: ev ? ev.signalSource : null,
      turnId: ev ? ev.turnId || null : null,
    });
  } catch (e) {
    console.warn('[spec2/S3] turn-complete-event broadcast failed:', e && e.message);
  }
});

let companyAiTasks = null;
const runCompanyAi = (request, options) => {
  if (!companyAiTasks) return Promise.reject(new Error('CodeAgent 服务尚未准备好，请稍后重试'));
  return companyAiTasks.run(request, options);
};
const autoTitleManager = createAutoTitleManager({
  runCompanyAi,
  allAiKinds: ALL_AI_KINDS,
  getHubConfig,
  kindLabels: KIND_LABELS,
  meetingManager,
  sendToRenderer,
  sessionManager,
  workspaceService,
});
const { maybeAutoTitleMeetingFromPrompt } = autoTitleManager;
// 交接跟人走（2026-10-20，main/reference-handoff.js）：带【引用会话】的消息发出时，把被引用的旧会话（已关闭的）名下的公司联动编号转过来。
// 和自动起标题挂在同一处：三条上报路径（原生记录、Claude hook、Codex hook）都经过这里。
const referenceHandoff = require('./main/reference-handoff.js').createReferenceHandoff({
  getTranscriptDir: () => require('./core/data-dir').getHubTranscriptDir(),
  getBridge: () => null,
});
function maybeAutoTitleSessionFromPrompt(ev) {
  try { referenceHandoff.onPrompt(ev); } catch (error) { console.warn('[reference-handoff]', error && error.message); }
  return autoTitleManager.maybeAutoTitleSessionFromPrompt(ev);
}
// Codex /goal auto-continuations can begin without a user_message event. Keep
// this lifecycle signal separate from prompt-submitted so it cannot trigger
// auto-title or notification prompt bookkeeping with synthetic text.
transcriptTap.on('turn-started', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  codexAccountSwitch.onPrompt(codexAccountTurnEvent(ev));
  completionNotifier.noteTurnStarted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    if (session?.runtimeBackend !== 'claude-stream-json') sessionManager.noteAgentTurnStarted(ev.hubSessionId, {
      startedAt: ev.startedAt,
      signalSource: ev.signalSource || 'task_started',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] main-process lifecycle note failed:', error && error.message);
  }
  try {
    sendToRenderer('turn-started-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      startedAt: ev.startedAt != null ? ev.startedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_started',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-started-event broadcast failed:', error && error.message);
  }
});

// r27d：真实失败交给桌宠，亮橙灯、举「出错了」卡。只有权威失败事件（Codex task_complete.error、CLI 退回终端）
// 走这里并带 err:true；中止、警示色都不算出错。同一次失败重复上报时 failedAt 相同，桌宠按 id 去重。
function petTurnFailed(sessionId, failedAt, message) {
  try {
    const notice = require('./core/hub-pet/state').failureNotice(sessionManager.getSession(sessionId), sessionId, failedAt, message, HUB_PET_ASSISTANT_PURPOSES);
    if (notice) hubPetController?.routeDesktopNotice?.(notice);
  } catch (error) {
    console.warn('[hub-pet] turn-failed notice failed:', error && error.message);
  }
}
// Stop 到了但最后一条没有正文：转成 pending 的回合，延时后收尾（core/stop-pending-settle.js）。
const stopPendingSettle = require('./core/stop-pending-settle').createStopPendingSettle({
  manager: sessionManager, getTurnSeq: id => sessionManager.sessions.get(id)?.agentTurnStartSeq || 0,
});
// CodeAgent 回合中 CLI 退回宿主 shell：结束这一轮并让界面退出"工作中"（core/cli-exit-watch.js）。
require('./core/cli-exit-watch').createCliExitWatch({
  manager: sessionManager,
  onExited: ({ sessionId, failedAt, kind }) => {
    const session = sessionManager.getSession(sessionId);
    sendToRenderer('turn-failed-event', {
      hubSessionId: sessionId, transcriptPath: session ? session.transcriptPath : null, failedAt,
      meetingId: session ? session.meetingId : null, kind, signalSource: 'cli-exited-to-shell', turnId: null,
      message: 'CLI 已退出到系统终端，本轮没有完成；请重连会话后再发消息。',
      occurrenceId: `cli-exit:${sessionId}:${failedAt}`,
    });
    petTurnFailed(sessionId, failedAt, 'CLI 已退出到系统终端，本轮没有完成。');
  },
}).start();
// CodeAgent 在终端里报了会话级错误（如部门模型管控 SessionRequestError），原生记录里没有：结束这一轮并把原文显示出来（core/codeagent-screen-error.js）。
async function recoverCodeAgentModelRevocation({ sessionId, modelRevoked, message }) {
  const session = sessionManager.getSession(sessionId);
  // 分身后台会话自己处理（换代码仓库目录或就地报错，core/avatar/agent-session.js），不弹前台的选模型确认、不挂常驻横幅（R64 审查 P2）。
  if (!session || session.purpose === 'avatar-agent' || !modelRevoked || typeof sessionOperations?.confirmSessionModel !== 'function') return;
  const model = session.fixedModel || session.currentModel?.id || modelRevoked.model || '';
  const reason = modelRevoked.reason || '当前模型已不可用';
  const error = Object.assign(require('./core/session-model-pin').unavailableError(model, reason, []), { modelRevoked: true });
  const updated = sessionManager.updateSessionMeta(sessionId, {
    modelConfirmationRequired: true,
    modelUnavailableReason: `${reason}：${String(message || modelRevoked.text || '').slice(0, 240)}`,
  });
  if (updated) sendToRenderer('session-updated', { session: updated });
  const requestId = `model-revoked-${sessionId}-${Date.now()}`;
  try {
    const result = await sessionOperations.confirmSessionModel(sessionId, error, { clientSubmissionId: requestId });
    // 群聊/小队的等待状态由 session-model-wait 驱动成员卡片；没有可关联的
    // 单条工作流消息时不擅自重发，避免把同一轮任务发两遍。
    if (result?.ok && !session.meetingId && typeof promptOperations?.resendAfterModelSwitch === 'function') {
      await promptOperations.resendAfterModelSwitch(sessionId, { clientSubmissionId: requestId + '-retry' });
    }
  } catch (recoveryError) {
    console.warn('[codeagent] 模型权限恢复失败：' + recoveryError.message);
  }
}

// 最近一次屏幕报错按会话记一份：后台功能（分身）不看界面事件，靠它及时认出「外部模型管控 / 不在可信仓」（R64）。
const codeagentScreenErrors = new Map();
require('./core/codeagent-screen-error').createScreenErrorWatch({
  manager: sessionManager,
  readScreen: id => {
    const entry = sessionManager.sessions?.get?.(id);
    const text = sessionManager.getSessionBuffer(id);
    return text == null ? null : { text, cols: Number(entry?.pty?.cols) || 120, rows: Number(entry?.pty?.rows) || 30 };
  },
  renderRows: raw => require('./core/hub-phone/session-chat').renderRows(raw),
  onError: ({ sessionId, failedAt, kind, message, modelRevoked, trustedRepoRequired }) => {
    const session = sessionManager.getSession(sessionId);
    codeagentScreenErrors.delete(sessionId);
    codeagentScreenErrors.set(sessionId, { at: Number(failedAt) || Date.now(), message: String(message || '').slice(0, 400), trustedRepo: !!trustedRepoRequired, modelRevoked: !!modelRevoked });
    if (codeagentScreenErrors.size > 64) codeagentScreenErrors.delete(codeagentScreenErrors.keys().next().value);
    if (trustedRepoRequired) {
      // 屏幕报错不进入原生记录；显式结束群聊成员的等待，卡片持久化目录限制原因。
      try { groupChatDispatcher?.getActiveWatchers().get(sessionId)?.markErrored('trusted_repo_required'); }
      catch (error) { console.warn('[codeagent] 群聊可信仓错误结算失败：' + error.message); }
    } else if (modelRevoked) void recoverCodeAgentModelRevocation({ sessionId, modelRevoked, message });
    sendToRenderer('turn-failed-event', {
      hubSessionId: sessionId, transcriptPath: session ? session.transcriptPath : null, failedAt,
      meetingId: session ? session.meetingId : null, kind, signalSource: 'codeagent-screen-error', turnId: null,
      message, trustedRepoRequired: !!trustedRepoRequired, occurrenceId: `codeagent-screen-error:${sessionId}:${failedAt}`,
    });
    petTurnFailed(sessionId, failedAt, message);
  },
}).start();
transcriptTap.on('turn-pending', (ev) => { try { stopPendingSettle.onPending(ev); } catch (error) { console.warn('[stop-settle]', error.message); } });

transcriptTap.on('turn-aborted', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  sessionManager.noteAgentTurnFinished(ev.hubSessionId, ev);
  completionNotifier.noteTurnAborted(ev);
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-aborted-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      abortedAt: ev.abortedAt != null ? ev.abortedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'turn_aborted',
      turnId: ev.turnId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-aborted-event broadcast failed:', error && error.message);
  }
});

// Codex writes transport failures as task_complete.error. Forward the
// authoritative occurrence instead of relying only on PTY text, because the
// full-screen TUI can redraw an old error line during every later turn.
transcriptTap.on('turn-error', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  // Rollout errors carry completedAt. Label the terminal event before main
  // retains it, so renderer reload cannot turn a failed request into success.
  const failedAt = ev.failedAt != null ? ev.failedAt : ev.completedAt != null ? ev.completedAt : Date.now();
  const accepted = sessionManager.noteAgentTurnFinished(ev.hubSessionId, { ...ev, failedAt });
  // 桌宠只认本回合的失败：上一轮迟到的失败（旧回合标识或早于本回合开始）不弹卡、不亮橙灯（r27e）。
  const petCurrent = accepted || sessionManager.isCurrentAgentTurnEvent(ev.hubSessionId, { ...ev, failedAt });
  completionNotifier.noteTurnFailed(ev);
  void codexAccountSwitch.onFailure(codexAccountTurnEvent(ev)).catch(error => console.error('[codex-account]',error.message));
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('turn-failed-event', {
      hubSessionId: ev.hubSessionId,
      transcriptPath: ev.transcriptPath || (session ? session.transcriptPath : null),
      failedAt,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev.signalSource || 'task_complete_error',
      turnId: ev.turnId || null,
      message: ev.message || ev.reason || ev.error || '本轮执行失败（没有拿到具体原因）',
      errorInfo: ev.errorInfo || null,
      occurrenceId: ev.occurrenceId || null,
    });
  } catch (error) {
    console.warn('[codex task] turn-failed-event broadcast failed:', error && error.message);
  }
  if (petCurrent) petTurnFailed(ev.hubSessionId, failedAt, ev.message);
});

transcriptTap.on('prompt-submitted', (ev) => {
  const { hubSessionId, text, submittedAt } = ev || {};
  completionNotifier.notePromptSubmitted(ev || {});
  if (!hubSessionId) return;
  const session = sessionManager.getSession(hubSessionId);
  maybeAutoTitleSessionFromPrompt({ ...ev, text: require('./core/memory-index-envelope').splitMemoryIndex(text).userText });
  try {
    sendToRenderer('prompt-submitted-event', {
      hubSessionId,
      transcriptPath: ev ? ev.transcriptPath : null,
      text,
      submittedAt: submittedAt != null ? submittedAt : Date.now(),
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : null,
      signalSource: ev ? ev.signalSource : null,
      turnId: ev ? ev.turnId || null : null,
    });
  } catch (e) {
    console.warn('[codex prompt] prompt-submitted-event broadcast failed:', e && e.message);
  }
});

// Kimi's main wire stays quiet while an Agent/Coder sub-agent does the actual
// work. PTY byte bursts cannot be used as a status signal for Kimi because its
// interactive TUI redraws on ordinary typing. Forward the authoritative
// Agent tool.call/tool.result lifecycle instead, so the sidebar stays running
// for the whole background job rather than turning idle after the main step.
transcriptTap.on('background-work-changed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const session = sessionManager.getSession(ev.hubSessionId);
  try {
    sendToRenderer('background-work-event', {
      ...ev,
      meetingId: session ? session.meetingId : null,
      kind: session ? session.kind : (ev.kind || null),
    });
  } catch (error) {
    console.warn('[kimi background] background-work-event broadcast failed:', error && error.message);
  }
});

// `contextMax` is the user's launch request. Codex can clamp it to the current
// model catalog and then applies its effective-window percentage. The actual
// runtime value arrives in token_count.model_context_window; persist it under a
// separate key so a later resume never turns the clamp into the next request.
transcriptTap.on('context-window-observed', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  const contextEffectiveMax = Number(ev.contextEffectiveMax);
  if (!Number.isInteger(contextEffectiveMax) || contextEffectiveMax <= 0) return;
  const observedAtValue = Number(ev.observedAt);
  const contextEffectiveObservedAt = Number.isFinite(observedAtValue) && observedAtValue > 0
    ? observedAtValue
    : Date.now();
  try {
    const current = sessionManager.getSession(ev.hubSessionId);
    if (!current) return;
    if (current.contextEffectiveMax === contextEffectiveMax
        && Number(current.contextEffectiveObservedAt) >= contextEffectiveObservedAt) return;
    const updated = sessionManager.updateSessionMeta(ev.hubSessionId, {
      contextEffectiveMax,
      contextEffectiveObservedAt,
    });
    if (!updated) return;
    void sessionStore.markDirtyImmediate(ev.hubSessionId, updated).catch((error) => {
      console.warn('[codex-context] per-session persist failed:', error && error.message);
    });
    const persisted = lastPersistedSessions.find(item => item && item.hubId === ev.hubSessionId);
    if (persisted) {
      persisted.contextEffectiveMax = contextEffectiveMax;
      persisted.contextEffectiveObservedAt = contextEffectiveObservedAt;
      persisted.updatedAt = Date.now();
    }
    sendToRenderer('session-updated', { session: updated });
  } catch (error) {
    console.warn('[codex-context] observation handling failed:', error && error.message);
  }
});

// Persist resume meta when transcript-tap binds a sub-session to its native CLI sid.
transcriptTap.on('session-bound', (ev) => {
  if (!ev || !ev.hubSessionId) return;
  try {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      const current = sessionManager.getSession(ev.hubSessionId);
      const patch = {};
      if (ev.codexSid) patch.codexSid = ev.codexSid;
      if (ev.rolloutPath) patch.transcriptPath = ev.rolloutPath;
      if (current && current.codexSessionsRoot) patch.codexSessionsRoot = current.codexSessionsRoot;
      if (current && current.codexAllowMtimeFallback) patch.codexAllowMtimeFallback = true;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (isClaudeFamily(ev.kind) && ev.transcriptPath) {
      sessionManager.updateSessionMeta(ev.hubSessionId, {transcriptPath:ev.transcriptPath});
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      const patch = {};
      if (ev.geminiChatId) patch.geminiChatId = ev.geminiChatId;
      if (ev.geminiProjectHash) patch.geminiProjectHash = ev.geminiProjectHash;
      if (ev.geminiProjectRoot) patch.geminiProjectRoot = ev.geminiProjectRoot;
      if (ev.sessionPath) patch.transcriptPath = ev.sessionPath;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      const patch = {};
      if (ev.kimiSid) patch.kimiSid = ev.kimiSid;
      if (ev.sessionDir) patch.kimiSessionDir = ev.sessionDir;
      if (ev.wirePath) patch.transcriptPath = ev.wirePath;
      sessionManager.updateSessionMeta(ev.hubSessionId, patch);
    }
  } catch {}
  // A recovered group-chat attempt may have resumed before its rollout was
  // bound. Binding is the strongest moment to retry collection: never resend
  // the prompt, just reconcile the persisted final answer for this sid.
  const recoveryTimer = setTimeout(() => {
    if (groupChatDispatcher && typeof groupChatDispatcher.recoverSession === 'function') {
      groupChatDispatcher.recoverSession(ev.hubSessionId).catch((error) => {
        console.warn('[groupchat] transcript-bound recovery failed:', error && error.message);
      });
    }
  }, 0);
  recoveryTimer.unref?.();
  // Find the session in lastPersistedSessions and merge new fields.
  const idx = lastPersistedSessions.findIndex(s => s.hubId === ev.hubSessionId);
  if (idx < 0) {
    if (isCodexCliKind(ev.kind) && (ev.codexSid || ev.rolloutPath)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        codexSid: ev.codexSid,
        transcriptPath: ev.rolloutPath,
        codexSessionsRoot: sessionManager.getSession(ev.hubSessionId)?.codexSessionsRoot || null,
        codexAllowMtimeFallback: !!sessionManager.getSession(ev.hubSessionId)?.codexAllowMtimeFallback,
      });
    } else if ((ev.kind === 'gemini' || ev.kind === 'gemini-resume')
        && (ev.geminiChatId || ev.geminiProjectHash || ev.geminiProjectRoot)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        geminiChatId: ev.geminiChatId,
        geminiProjectHash: ev.geminiProjectHash,
        geminiProjectRoot: ev.geminiProjectRoot,
        transcriptPath: ev.sessionPath,
      });
    } else if (isKimiCliKind(ev.kind) && (ev.kimiSid || ev.wirePath || ev.sessionDir)) {
      sendToRenderer('session-meta-updated', {
        hubSessionId: ev.hubSessionId,
        kind: ev.kind,
        kimiSid: ev.kimiSid,
        kimiSessionDir: ev.sessionDir,
        transcriptPath: ev.wirePath,
      });
    }
    return;
  }
  const cur = lastPersistedSessions[idx];
  let changed = false;
  if (isCodexCliKind(ev.kind) && ev.codexSid && cur.codexSid !== ev.codexSid) {
    cur.codexSid = ev.codexSid;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && ev.rolloutPath && cur.transcriptPath !== ev.rolloutPath) {
    cur.transcriptPath = ev.rolloutPath;
    changed = true;
  }
  const liveSession = isCodexCliKind(ev.kind) ? sessionManager.getSession(ev.hubSessionId) : null;
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexSessionsRoot && cur.codexSessionsRoot !== liveSession.codexSessionsRoot) {
    cur.codexSessionsRoot = liveSession.codexSessionsRoot;
    changed = true;
  }
  if (isCodexCliKind(ev.kind) && liveSession && liveSession.codexAllowMtimeFallback && cur.codexAllowMtimeFallback !== true) {
    cur.codexAllowMtimeFallback = true;
    changed = true;
  }
  if (ev.kind === 'gemini') {
    if (ev.sessionPath && cur.transcriptPath !== ev.sessionPath) { cur.transcriptPath = ev.sessionPath; changed = true; }
    if (ev.geminiChatId && cur.geminiChatId !== ev.geminiChatId) { cur.geminiChatId = ev.geminiChatId; changed = true; }
    if (ev.geminiProjectHash && cur.geminiProjectHash !== ev.geminiProjectHash) { cur.geminiProjectHash = ev.geminiProjectHash; changed = true; }
    if (ev.geminiProjectRoot && cur.geminiProjectRoot !== ev.geminiProjectRoot) { cur.geminiProjectRoot = ev.geminiProjectRoot; changed = true; }
  }
  if (isKimiCliKind(ev.kind)) {
    if (ev.kimiSid && cur.kimiSid !== ev.kimiSid) { cur.kimiSid = ev.kimiSid; changed = true; }
    if (ev.sessionDir && cur.kimiSessionDir !== ev.sessionDir) { cur.kimiSessionDir = ev.sessionDir; changed = true; }
    if (ev.wirePath && cur.transcriptPath !== ev.wirePath) { cur.transcriptPath = ev.wirePath; changed = true; }
  }
  if (changed) {
    cur.updatedAt = Date.now();  // 让后续 stateStore merge 用最新版本胜出
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: meetingManager.getAllMeetings(),
      immersiveByMeeting: _immersiveByMeeting,
    });
    // 2026-05-07 maintainer：sid 类字段一旦确定就立刻 sync 写 per-session JSON。
    //   不靠 200ms debounce，不靠 state.json 防抖 500ms——任何一个 race / crash
    //   都不会再让 Codex/Gemini 的 transcript 关联丢失。
    try { void sessionStore.markDirtyImmediate(ev.hubSessionId, cur); }
    catch (e) { console.warn('[hub] sessionStore sync persist failed:', e.message); }

    // Spec 3 · W12：广播给 renderer 让 sessions Map 即刻同步（之前只写磁盘，
    // renderer 内存不更新 → codex/gemini 的 resume meta 必须 reboot 才生效）
    sendToRenderer('session-meta-updated', {
      hubSessionId: ev.hubSessionId,
      kind: ev.kind,
      codexSid: cur.codexSid,
      transcriptPath: cur.transcriptPath,
      codexSessionsRoot: cur.codexSessionsRoot,
      codexAllowMtimeFallback: !!cur.codexAllowMtimeFallback,
      geminiChatId: cur.geminiChatId,
      geminiProjectHash: cur.geminiProjectHash,
      geminiProjectRoot: cur.geminiProjectRoot,
      kimiSid: cur.kimiSid,
      kimiSessionDir: cur.kimiSessionDir,
    });
    console.log(`[群聊] persisted resume meta for ${ev.kind} session ${ev.hubSessionId.slice(0,8)}`);
  }
});

sessionManager.hookToken = HOOK_TOKEN;  // port set after listen
sessionManager.teamTokenFor = teamTokenFor;

// Pin a stable AppUserModelID before creating the window so Windows keeps Hub's
// taskbar identity independent from electron.exe. Native toast notifications are
// intentionally disabled; this identity is still required by shell shortcuts and
// Explorer taskbar reconstruction. win32-only.
if (process.platform === 'win32' && !isIsolatedHub()) {
  app.setAppUserModelId(HUB_APP_USER_MODEL_ID); // = package.json build.appId
}

// Windows drops the window HICON whenever the taskbar identity is rebuilt, and
// the button then falls back to electron.exe's own icon — the Electron atom.
//
// 2026-08-08：b4fd5d5 已经预见到这点，但只挂了 'show'/'restore'，而这两个事件
// 对一个**始终可见**的窗口永远不会触发。实测链条：系统 08-06 14:11 启动 →
// Hub 14:17 起来图标正常 → explorer.exe 08-07 19:56:47 崩溃重启（Application
// Error 1000/1001 三条）→ 任务栏重建、HICON 丢失 → 08-08 17:40 截图已是原子图标，
// 期间窗口一直开着，没有任何事件把图标补回去。
// 所以除事件外，还要在 shell watchdog 的每一拍无条件重贴一次。setIcon 幂等，
// NativeImage 缓存后单次开销就是一个 WM_SETICON，15 秒一次可以忽略。
let _cachedHubWindowIcon = null;
function getHubWindowIcon() {
  if (_cachedHubWindowIcon && !_cachedHubWindowIcon.isEmpty()) return _cachedHubWindowIcon;
  _cachedHubWindowIcon = nativeImage.createFromPath(path.join(__dirname, 'claude-wx.ico'));
  return _cachedHubWindowIcon;
}
function reassertHubWindowIcon() {
  if (process.platform !== 'win32') return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const icon = getHubWindowIcon();
  if (!icon || icon.isEmpty()) return false;
  mainWindow.setIcon(icon);
  return true;
}

function keepIsolatedE2EWindowHidden() {
  return HIDDEN_E2E_WINDOW_REQUESTED && HIDDEN_E2E_DATA_DIR_SAFE;
}

function focusPrimaryWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // A hidden isolated E2E still exercises the real BrowserWindow/webContents,
  // but must never flash a Hub look-alike onto the user's production desktop.
  // Requiring both flags keeps normal and production launches unchanged.
  if (keepIsolatedE2EWindowHidden()) return true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  reassertHubWindowIcon();
  return true;
}

module.exports.focusPrimaryWindow = focusPrimaryWindow;

// T6：窗口按钮区的底色与符号色。默认值对应 dark 皮肤，换皮肤时由渲染层把
// **当前皮肤真实算出来的颜色**发过来（见 hub:titlebar-overlay）—— 主进程不再
// 维护第二份调色板，否则加一套皮肤就得改两个地方，迟早对不上。
const HUB_TITLE_BAR_OVERLAY_DEFAULT = Object.freeze({
  color: '#0f1319',
  symbolColor: '#7f8a9a',
  height: 44,
});

// 合法的 #rgb / #rrggbb。渲染层送来的是 getComputedStyle 的结果，
// 主题里偶尔会是 rgb() 或带 alpha 的写法，setTitleBarOverlay 不认，
// 认不出就退回默认值 —— 宁可颜色不跟，也不要让整个调用抛异常。
function normalizeOverlayColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? text : fallback;
}

// 最后一次真正应用成功的 overlay 颜色。E2E 要断言「换皮肤时窗口按钮区跟着变」，
// 而这件事在页面里看不见（那三个按钮是 Windows 画的，不在 DOM 里）—— 不记一笔
// 就只能靠截图比色，那既不稳也说不清到底是哪一步没生效。
let lastAppliedTitleBarOverlay = null;

function applyHubTitleBarOverlay(colors = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // 原生标题栏模式下没有 overlay 可改，调了会抛。
  if (mainWindow._hubNativeTitleBar) return null;
  const next = {
    color: normalizeOverlayColor(colors.color, HUB_TITLE_BAR_OVERLAY_DEFAULT.color),
    symbolColor: normalizeOverlayColor(colors.symbolColor, HUB_TITLE_BAR_OVERLAY_DEFAULT.symbolColor),
    height: HUB_TITLE_BAR_OVERLAY_DEFAULT.height,
  };
  try {
    mainWindow.setTitleBarOverlay(next);
    lastAppliedTitleBarOverlay = next;
    return next;
  } catch (error) {
    // 非 Windows 平台、或窗口已经在销毁流程里 —— 换个颜色而已，不值得让它冒泡。
    console.warn('[titlebar] setTitleBarOverlay failed:', error && error.message);
    return null;
  }
}

// 窗口的真实形态。E2E 专用：页面里问不出「我上面有没有一条系统标题栏」，
// 只有主进程知道。
ipcMain.handle('debug:window-shape', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return {
    title: mainWindow.getTitle(),
    nativeTitleBar: !!mainWindow._hubNativeTitleBar,
    maximized: mainWindow.isMaximized(),
    overlay: lastAppliedTitleBarOverlay,
    // 截屏黑屏排查：只读回报主窗口状态，不改用户的渲染或防截屏设置。
    contentProtected: mainWindow.isContentProtected(),
    backgroundColor: mainWindow.getBackgroundColor(),
  };
});

ipcMain.on('hub:titlebar-overlay', (_event, colors) => {
  applyHubTitleBarOverlay(colors || {});
});

// 双击工具栏空白处最大化 / 还原。原生标题栏本来就有这个行为，隐掉它之后必须
// 自己补 —— 少了这一下，用户会觉得顶部这条栏「是个假标题栏」。
ipcMain.handle('hub:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // 返回的是「这次做了哪个动作」，不是做完之后的状态：Windows 上
  // maximize() 是异步的，紧跟着读 isMaximized() 拿到的还是旧值，
  // 那个返回值会稳定地骗人。真状态由 maximize / unmaximize 事件推给渲染层。
  const action = mainWindow.isMaximized() ? 'unmaximize' : 'maximize';
  mainWindow[action]();
  return action;
});

// 由 Hub 拉起自己的所有路径（远程重启、重启并继续、增量更新脚本、完整安装包、任务栏「新 Hub」）都先经
// core/clean-launch-env.js：去掉会话标记和确认不该用的 CodeAgent 配置目录，工作目录明显异常时换成安装目录（2026-10-19）。
function hubLaunchTarget() {
  return {
    execPath: process.execPath, appRoot: __dirname, isPackaged: HUB_IS_PACKAGED,
    // 继承目录判定还没出来时现算（不读注册表：落在号池里照样去掉，其余不动）
    decide: env => require('./core/codeagent-config').decideInherited({ env, dataDir: getHubDataDir(), persisted: { user: null, system: null, error: '还没读' } }),
  };
}
function relaunchHubClean(options = {}) {
  // 清环境出任何错都不能影响 Hub 被拉起：退回原来的 app.relaunch（relaunchApp 内部对准备阶段也有同样的兜底）。
  try {
    return require('./core/clean-launch-env').relaunchApp(app, options, hubLaunchTarget(), { dataDir: getHubDataDir() });
  } catch (error) {
    console.warn('[launch-env] 干净再启动失败，按原环境再启动：' + (error && error.message));
    app.relaunch(options && Object.keys(options).length ? options : undefined);
    return { removed: [], cwd: null, fallback: true, error: String(error && error.message || error) };
  }
}
function prepareHubLaunchClean() {
  return require('./core/clean-launch-env').prepareHubLaunch(hubLaunchTarget());
}

ipcMain.handle('hub:new-instance', () => launchHubInstance({
  appRoot: __dirname,
  execPath: isIsolatedHub() || HUB_IS_PACKAGED ? process.execPath : resolveHubLaunchExePath({
    execPath: process.execPath,
    icoPath: path.join(__dirname, 'claude-wx.ico'),
    productVersion: require('./package.json').version,
  }),
  isPackaged: HUB_IS_PACKAGED,
  env: prepareHubLaunchClean().env,
}));

// 端到端测试读主进程的启动环境（只在隔离实例里有）：启动自检清掉了什么、当前工作目录、指定变量的值。
if (isIsolatedHub()) {
  ipcMain.handle('debug:launch-env', async (_event, names = []) => {
    const launchEnv = require('./core/clean-launch-env');
    const report = launchEnv.startupReport();
    const pickEnv = {};
    for (const n of Array.isArray(names) ? names : []) pickEnv[n] = process.env[n] === undefined ? null : process.env[n];
    const strip = r => (r ? { removed: r.removed.map(x => x.name), initialCwd: r.initialCwd, cwdChanged: r.cwdChanged, configDir: r.configDir } : null);
    return { pid: process.pid, cwd: process.cwd(), startup: strip(report), env: pickEnv };
  });
}

let hangStackOptIn = null;
function createWindow() {
  // Load the icon as a NativeImage so we can pass it to BrowserWindow AND
  // re-apply via setIcon — on Windows the constructor `icon` alone sometimes
  // misses the taskbar; the explicit setIcon nails it.
  const iconPath = path.join(__dirname, 'claude-wx.ico');
  const winIcon = getHubWindowIcon();

  // 标题动态读 package.json 版本号，避免硬编码漂移（card-redesign 0.2.0 起）
  const _pkgVersion = (() => {
    try { return require('./package.json').version || ''; } catch { return ''; }
  })();
  // 2026-05-03 maintainer：标题带 PID，方便桌面同时存在多个 Hub 窗口（生产+测试）时
  //   一眼区分哪个对应哪个 PID — 调试时不再需要 Get-Process 反查。
  // 社区版标题同时写出社区版本与所基于的上游版本，用户报问题时一眼可见。
  // 产品名和版本标注随发行目标（公司版的名字与标注见 target.json）。
  const { upstreamVersion: _upstreamVersion, productName: _productName, editionBadge: _editionBadge } = require('./core/distribution');
  const _hubTitle = `${_productName}${_editionBadge ? ' ' + _editionBadge : ''} v${_pkgVersion}${_upstreamVersion ? `（上游 ${_upstreamVersion}）` : ''}：PID ${process.pid}`;
  // T6 冷杉 v2：隐藏原生标题栏，让渲染层那条 44px 工具栏直接顶到窗口顶边。
  // 三个系统窗口按钮仍由 Windows 自己画（titleBarOverlay），所以最大化 / 还原 /
  // 关闭的行为、Snap Layouts、右键系统菜单全部保持原生，不需要 Hub 自己复刻一套。
  //
  // 逃生口：CLAUDE_HUB_NATIVE_TITLEBAR=1 时整段跳过，回到原生标题栏。
  // 无边框窗口出问题（远程桌面、某些 Windows 版本、辅助工具）时，用户还有一条
  // 不改代码就能开回去的路 —— Hub 是每天要用的工具，不能只有一种能开的形态。
  const nativeTitleBar = process.env.CLAUDE_HUB_NATIVE_TITLEBAR === '1';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: _hubTitle,
    backgroundColor: '#0d1117',
    icon: winIcon,
    show: false,
    autoHideMenuBar: true,
    ...(nativeTitleBar ? {} : {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...HUB_TITLE_BAR_OVERLAY_DEFAULT },
    }),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      // 关闭了显卡加速（兼容渲染）时告诉界面进程：终端改用 DOM 渲染（见 renderer loadGpuRenderer）。
      additionalArguments: process.__hubGpuDisabledReason ? ['--ai-hub-gpu-disabled'] : [],
    },
  });
  mainWindow._hubNativeTitleBar = nativeTitleBar;
  // 窗口在屏幕上就一直出帧 + 窗口事件日志（公司真机「点后台冻住、半分钟后黑屏」，见该模块注释）。
  let windowEventLog = null;
  try {
    const keepRendering = require('./core/window-keep-rendering.js');
    windowEventLog = keepRendering.installWindowKeepRendering(mainWindow, {
      app, ipcMain, dataDir: getHubDataDir(),
      enabled: keepRendering.shouldKeepRendering({ community: require('./core/distribution').community }),
    })?.log || null;
  } catch (error) { console.warn('[window] keep-rendering setup failed:', error && error.message); }
  // 窗口缩放兜底（core/window-scale-guard.js，2026-10-19 公司真机「自动拉起后按 100% 排版」）：
  // 只在检测到窗口缩放和所在显示器不一致时做一次 setBounds / 重新最大化，正常启动只读不改。
  // 测试窗口（屏幕外的后台窗口、隐藏窗口）不装；隔离实例设 CLAUDE_HUB_E2E_SCALE_GUARD=1 才装，
  // CLAUDE_HUB_E2E_SCALE_PROBE 可覆盖读数来模拟不一致。
  try {
    const e2eScaleGuard = isIsolatedHub() && process.env.CLAUDE_HUB_E2E_SCALE_GUARD === '1';
    if (e2eScaleGuard || (!mainWindow.__hubBackgroundE2E && !keepIsolatedE2EWindowHidden())) {
      let probeOverride = null;
      if (e2eScaleGuard && process.env.CLAUDE_HUB_E2E_SCALE_PROBE) {
        try { probeOverride = JSON.parse(process.env.CLAUDE_HUB_E2E_SCALE_PROBE); } catch { probeOverride = null; }
      }
      require('./core/window-scale-guard.js').installWindowScaleGuard(mainWindow, {
        screen, powerMonitor, probeOverride,
        log: windowEventLog || ((event, detail) => console.warn('[window]', event, JSON.stringify(detail))),
      });
    }
  } catch (error) { console.warn('[window] scale guard setup failed:', error && error.message); }
  // 界面进程崩溃（公司真机 crashed -36861，原因待崩溃转储区分）后自动重新载入界面，会话都在主进程里不受影响；
  // 卡住时记下界面正在跑的代码和内存（见该模块注释）。
  try {
    const win = mainWindow;
    require('./core/renderer-crash-recovery.js').installRendererCrashRecovery(win, {
      app, ipcMain,
      log: windowEventLog || ((event, detail) => console.warn('[window]', event, JSON.stringify(detail))),
      reload: ({ reason, exitCode, attempt }) => {
        observeMeetingE2E?.('crash-recovery-reload', { reason, exitCode, attempt, webContentsId: win.webContents.id });
        hangStackOptIn?.arm(); return win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { recovered: String(reason || 'crashed') } });
      },
      hangStacks: !!hangStackOptIn,
      // 卡死自救的秒数：AI_HUB_STALL_RESCUE_SEC=0 关掉，其余数字按秒改。
      ...(String(process.env.AI_HUB_STALL_RESCUE_SEC || '').trim() !== '' && Number.isFinite(Number(process.env.AI_HUB_STALL_RESCUE_SEC))
        ? { rescueStallMs: Math.max(0, Number(process.env.AI_HUB_STALL_RESCUE_SEC)) * 1000 } : {}),
    });
  } catch (error) { console.warn('[window] crash recovery setup failed:', error && error.message); }
  require('./main/ipc/preview-immersive-handlers.js').bindPreviewImmersiveWindow(mainWindow);
  // 工具栏要知道窗口是不是最大化：Windows 最大化一个隐藏标题栏的窗口时，
  // 窗口会比屏幕大出一圈边框，顶部那几像素会被切掉。渲染层拿这个状态决定
  // 要不要补那一圈，而不是靠猜。
  const emitWindowState = () => {
    sendToRenderer('hub:window-state', {
      maximized: !mainWindow.isMaximized ? false : mainWindow.isMaximized(),
      fullScreen: !mainWindow.isFullScreen ? false : mainWindow.isFullScreen(),
      nativeTitleBar,
      version: _pkgVersion,
      pid: process.pid,
    });
  };
  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);
  mainWindow.on('enter-full-screen', emitWindowState);
  mainWindow.on('leave-full-screen', emitWindowState);
  mainWindow.webContents.on('did-finish-load', emitWindowState);
  if (!desktopNotificationController) {
    desktopNotificationController = createDesktopNotificationController({
      BrowserWindow,
      screen,
      ipcMain,
      htmlPath: path.join(__dirname, 'renderer', 'desktop-notification.html'),
      preloadPath: path.join(__dirname, 'renderer', 'desktop-notification-preload.js'),
      getMainWindow: () => mainWindow,
      focusPrimaryWindow,
      sendToRenderer,
      canShow: payload => desktopNoticesAllowed(payload) && (!keepIsolatedE2EWindowHidden()
        || process.env.CLAUDE_HUB_E2E_SHOW_NOTIFICATION === '1'),
      // 开着桌宠时，通知由桌宠举卡片说；桌宠没开或被收起时照旧弹这张卡（2026-11-09）。
      route: payload => hubPetController?.routeDesktopNotice?.(payload) === true,
      logger: console,
    });
  }
  if (!hubPetController) {
    try {
      const petDistribution = require('./core/distribution');
      hubPetController = createHubPetController({
        BrowserWindow, BaseWindow, screen, ipcMain, Menu, powerMonitor, app,
        htmlPath: path.join(__dirname, 'renderer', 'hub-pet', 'pet.html'),
        preloadPath: path.join(__dirname, 'renderer', 'hub-pet', 'pet-preload.js'),
        assetsDir: path.join(__dirname, 'renderer', 'assets', 'hub-pet'),
        dataDir: getHubDataDir(),
        company: petDistribution.target === 'company',
        available: petDistribution.featureEnabled('hubPet'),
        getMainWindow: () => mainWindow,
        focusPrimaryWindow,
        sendToRenderer,
        noticeBus: require('./core/company-assistant/notice-bus').noticeBus(),
        // 等级联动（2026-11-12）：桌宠身上的等级与特效来自「个人」页；摸桌宠记一次亲密度。
        getProfile: () => profileController?.brief() || null,
        // 低开销模式（2026-11-23 P1 L3）：开着时桌宠静默省电，提醒气泡照常。
        lowOverhead: () => lowOverheadController?.isEnabled() === true,
        // 蒸馏自己（2026-11-28）：勾了「应用到桌宠」才有内容；模块不在或出错时当作没应用。
        getSelfLike: () => { try { return require('./main/self-distill-service').forTargetCurrent?.('pet') ?? null; } catch { return null; } },
        onPetted: () => { try { profileController?.notePet(); } catch { /* 个人页没启动 */ } },
        isAssistantBusy: () => {
          for (const s of sessionManager.sessions.values()) {
            if (s && s.agentTurnActive && HUB_PET_ASSISTANT_PURPOSES.has(s.info && s.info.purpose)) return true;
          }
          return false;
        },
        // 桌宠联动（2026-11-09）：正在跑的会话数（助理自己的会话另算）、问助理、右键菜单里的页面入口。
        getSessionActivity: () => {
          let running = 0;
          const sessions = [];   // r27c：会话状态灯，每个在跑的会话一盏（点灯直达）
          // r27d：侧栏里还活着的全部会话（当前名字、最近一轮开始时间）。桌宠据此丢掉已关闭/休眠会话的灯、
          // 刷新改名后的标题、淘汰上一轮的完成/出错灯。休眠会话已移出这张表，所以不留灯，点灯不会落空。
          const known = [];
          for (const [id, s] of sessionManager.sessions) {
            const info = (s && s.info) || {};
            if (!s || HUB_PET_ASSISTANT_PURPOSES.has(info.purpose) || info.hiddenFromSidebar || info.meetingId) continue;
            if (/^(dormant|closed)$/.test(String(info.status || ''))) continue;
            const title = String(info.title || '').slice(0, 40);
            if (known.length < 500) known.push({ id: String(id), title, startedAt: Number(s.agentTurnStartedAt) || 0 });
            if (s.agentTurnActive) {
              running += 1;
              if (sessions.length < 30) sessions.push({ id: String(id), title });
            }
          }
          return { running, sessions, known };
        },
        // r27d：额度快用完 → 低电量道具。读当前 Claude 账号的用量读数（与侧栏同源），30 秒缓存一次，
        // 切号后读新账号、过了重置时间自动熄。
        isQuotaLow: (() => {
          let at = 0, low = false;
          return () => {
            const t = Date.now();
            if (t - at < 30_000) return low;
            at = t;
            try { low = require('./core/hub-pet/state').quotaIsLow(claudeCache(), t); } catch { low = false; }
            return low;
          };
        })(),
        askAssistant: (text, { enableAssistant = false } = {}) => {
          if (!companyAssistantService) throw new Error('这个版本没有助理');
          if (!optionalFeatures.get('assistant')) {
            if (!enableAssistant) throw Object.assign(new Error('助理还没开启。点「开启助理并发送」，会开启助理并发送刚才的问题。'), { code: 'ASSISTANT_DISABLED' });
            optionalFeatures.set('assistant', true); companyAssistantService.start();
            broadcastOptionalFeatures(); // 设置「资源与后台」与助理页开关同步（R66）
          }
          return companyAssistantService.ask(text, { via: 'pet' });
        },
        getPages: () => ({
          assistant: !!companyAssistantService,
          rooms: companyAssistantService && companyAssistantService.rooms
            ? { label: '会议室', hint: companyAssistantService.rooms.settings().enabled ? '自动抢订开着' : '' } : null,
        }),
        // 硬盘快满时桌宠提醒：系统盘和 Hub 数据所在的盘。
        inMeeting: () => !!(companyAssistantService && companyAssistantService.meetings && companyAssistantService.meetings.live && companyAssistantService.meetings.live.size > 0),
        diskRoots: () => [path.parse(process.env.SystemRoot || process.cwd()).root, require('./core/hub-pet/disk-watch').driveRoot(getHubDataDir())],
        canShow: () => !keepIsolatedE2EWindowHidden() || process.env.CLAUDE_HUB_E2E_SHOW_PET === '1',
        debug: isIsolatedHub(),
        logger: console,
        // 在线下载形象走 Electron 的网络栈（跟系统代理）；隔离测试用 AI_HUB_PET_SOURCES 指向本地源。
        fetchImpl: (...args) => net.fetch(...args),
        roleSources: process.env.AI_HUB_PET_SOURCES ? JSON.parse(process.env.AI_HUB_PET_SOURCES) : null,
      });
    } catch (error) { console.warn('[hub-pet] setup failed:', error && error.message); }
  }
  if (hubPetController) {
    // 桌宠跟着主窗口走：主窗口加载完才出现；主窗口关掉时先收起桌宠，
    // 否则这个小窗会让 Electron 等不到 window-all-closed、Hub 退不干净。
    mainWindow.once('closed', () => { try { hubPetController?.stop(); } catch (_) {} });
  }
  mainWindow.webContents.once('did-finish-load', () => {
    try { trayController?.sync(); } catch (error) { console.warn('[tray] sync failed:', error && error.message); }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    try { hubPetController?.start(); } catch (error) { console.warn('[hub-pet] start failed:', error && error.message); }
    companyAssistantService?.petReminders.start();
  });
  // index.html 的 <title>AI Hub Community</title> 在页面加载完成后会触发 page-title-updated 覆盖
  // BrowserWindow.title — preventDefault 阻止覆盖，保留带 PID 的标题
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });

  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
    // Windows can drop the source-mode HICON after the taskbar identity is
    // rebuilt (shortcut repair, Explorer refresh, multi-window regrouping).
    // These two cover the "window was hidden and came back" case; the
    // always-visible case is handled by the watchdog tick (see
    // reassertHubWindowIcon above).
    mainWindow.on('show', reassertHubWindowIcon);
    mainWindow.on('restore', reassertHubWindowIcon);
    mainWindow.on('focus', reassertHubWindowIcon);
  } else {
    console.warn('[icon] failed to load', iconPath);
  }

  let hasShown = false;
  const showMainWindow = () => {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;
    hasShown = true;
    if (keepIsolatedE2EWindowHidden()) {
      traceStartup('main window kept hidden for isolated E2E');
      return;
    }
    mainWindow.maximize();
    mainWindow.show();
  };
  ipcMain.once('renderer-sidebar-ready', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    traceStartup('did-finish-load');
    // 低开销模式：页面每次加载完主动推一次真值，界面上的开关、「省」徽章、终端与轮询不会停在默认的「关」（Codex R2）。
    try { sendToRenderer('low-overhead:changed', lowOverheadState()); } catch { /* 窗口刚关 */ }
    if (bootState.storageWriteError && ['EPERM', 'EBUSY', 'EACCES'].includes(bootState.storageWriteError.code)
        && !global.__bootStorageRetryStarted) {
      global.__bootStorageRetryStarted = true;
      sendToRenderer('session-notice', { message: '数据文件暂时被占用，稍后自动重试', level: 'warning', persistent: true, noticeKind: 'auto' });
      // 占用通常几秒就解除，只进日志；超过 60 秒仍写不进去（权限被拒、被别的程序长期锁住），升级成一行数据风险提示，恢复后再说一声。
      const retryStartedAt = Date.now();
      let escalated = false;
      const retry = async () => {
        try {
          await stateStore.saveForRestart({ version: 1, cleanShutdown: false, sessions: lastPersistedSessions,
            meetings: meetingManager.getAllMeetings(), immersiveByMeeting: _immersiveByMeeting });
          sendToRenderer('session-notice', { message: '数据文件占用已解除，保存已恢复', level: 'info', noticeKind: escalated ? 'blocking' : 'recovered' });
        } catch (error) {
          if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
            if (!escalated && Date.now() - retryStartedAt >= 60000) {
              escalated = true;
              sendToRenderer('session-notice', { message: `数据文件持续写不进去（${error.code}），最近的改动还没保存；请关掉占用它的程序或检查权限，Hub 会继续重试`,
                level: 'error', persistent: true, noticeKind: 'data-risk' });
            }
            setTimeout(retry, 5000).unref();
          }
          else sendToRenderer('session-notice', { message: `数据保存失败：${error.message}`, level: 'error', persistent: true });
        }
      };
      setTimeout(retry, 5000).unref();
    }
    sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort, message: fallbackMessage(hookBinding) });
    if (hubRestart.bootToken && !global.__loopResumeScanned) {
      global.__loopResumeScanned = true;
      // Keep the scanner available for future user-created workflows, while
      // admitting only groups restored by this restart or opened by the user.
      global.__devFileEngine?.start({onlyIds:[]});
    }
    // Phase 2b：boot 后由 main 循环引擎扫描未完成循环并自动续跑（main 驱动 + 自动 wake 成员）。once 守卫 + 延迟(等 session 恢复) + try，绝不影响启动。
    if (!global.__loopResumeScanned && !hubRestart.bootToken) {
      global.__loopResumeScanned = true;
      setTimeout(() => {
        if (hubRestart.isRestarting()) return;
        try { if (global.__loopEngine) global.__loopEngine.resumePending(); }
        catch (e) { console.warn('[loop] boot resume failed:', e && e.message); }
        global.__devFileEngine?.start();
      }, 8000);
    }
    if (!global.__groupChatRecoveryScanned && !hubRestart.bootToken) {
      global.__groupChatRecoveryScanned = true;
      setTimeout(() => {
        if (hubRestart.isRestarting()) return;
        Promise.resolve(groupChatDispatcher && groupChatDispatcher.recoverPendingAttempts())
          .then((summary) => {
            if (summary && summary.checked) console.log('[groupchat] boot attempt recovery:', summary);
          })
          .catch((error) => console.warn('[groupchat] boot attempt recovery failed:', error && error.message));
      }, 2000);
    }
  });
  setTimeout(showMainWindow, 4000);

  // 主 webContents 导航防护（2026-05-17 maintainer，2026-07-31 收紧）：renderer 若误把链接
  //   交给浏览器默认导航，会让主 webContents 整个跳走、Hub shell 和操作按钮一起消失。
  //   旧逻辑放行了所有 file://，所以本地 HTML 正好能绕过保护。主窗口现在只允许加载
  //   自己的 renderer/index.html；其他本地文件重新投递给 Hub preview webview。
  //   webview 内部导航走 guest webContents，不受这里影响。
  const hubShellPath = path.resolve(path.join(__dirname, 'renderer', 'index.html'));
  const isHubShellUrl = (urlStr) => {
    try {
      const u = new URL(urlStr);
      return u.protocol === 'file:'
        && path.resolve(fileURLToPath(u)).toLowerCase() === hubShellPath.toLowerCase();
    } catch { return false; }
  };
  const routeBlockedMainNavigation = (urlStr) => {
    try {
      const u = new URL(urlStr);
      if (u.protocol === 'file:') {
        const targetPath = fileURLToPath(u);
        console.warn('[nav-guard] block local file from main webContents -> preview', targetPath);
        sendToRenderer('preview-local-file', targetPath);
        return;
      }
      if (u.protocol === 'about:' || u.protocol === 'chrome:' || u.protocol === 'devtools:') {
        console.warn('[nav-guard] block internal protocol from main webContents:', urlStr);
        return;
      }
    } catch {}
    console.log('[nav-guard] block main webContents navigate to', urlStr, '→ openExternal');
    shell.openExternal(urlStr).catch((e) => console.warn('[nav-guard] openExternal failed:', e && e.message));
  };
  const interceptNavigate = (event, urlStr) => {
    if (isHubShellUrl(urlStr)) return;
    event.preventDefault();
    routeBlockedMainNavigation(urlStr);
  };
  mainWindow.webContents.on('will-navigate', interceptNavigate);
  mainWindow.webContents.on('will-redirect', interceptNavigate);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeBlockedMainNavigation(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (['closing-windows', 'drained', 'finalizing'].includes(shutdownDrainState)) return;
    // 「可选功能」里开了「关窗口最小化到托盘」：只藏窗口，会话照常跑（main/tray-controller.js）。
    if (trayController && trayController.interceptClose(event)) return;
    // Closing the window releases its sessions; no invisible owner remains.
    event.preventDefault();
    void beginGracefulHubShutdown('window-close-requested');
  });
  sessionModelCreationConfirmation.attachRenderer(mainWindow.webContents);
  mainWindow.on('closed', () => { mainWindow = null; });
}

var devWorkbench;
var meetingMemberTitleSync;
function sendToRenderer(channel, data) {
  if (meetingMemberTitleSync) data = meetingMemberTitleSync.onEvent(channel, data);
  if (devWorkbench) {
    try { devWorkbench.handleEvent(channel, data); }
    catch (error) { console.warn('[dev-workbench] event failed:', error.message); }
  }
  // 关 Hub 时窗口还在、界面进程已销毁：照样 send 会抛「Object has been destroyed」，打断助理收尾等调用方
  // （2026-11-28 黄区真机日志：退出时 failJob → 提醒总线 → 这里抛出，未处理的 Promise 拒绝）。
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try { mainWindow.webContents.send(channel, data); }
    catch (error) { if (!/destroyed/i.test(error && error.message || '')) throw error; }
  }
}

const sessionModelCreationConfirmation = require('./main/session-model-creation').createModelCreationConfirmation({
  onWait: event => sessionManager.emit('session-model-wait', event),
  sendToRenderer: (channel, payload) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) throw Error('确认界面不可用，未创建会话；请打开 Hub 后重试');
    sendToRenderer(channel, payload);
  },
});
ipcMain.handle('session:model-create-decision', (_event, payload) => sessionModelCreationConfirmation.respond(payload));
sessionManager.on('session-model-reset', ({ sessionId }) => {
  sessionModelCreationConfirmation.cancelSession(sessionId);
  require('./core/group-chat-watcher').cancelPendingModelSubmissions(sessionId);
});

function syncSessionRuntimeModel(sessionId, model) {
  if (!sessionId || !model || typeof model.id !== 'string' || !model.id.trim()) return false;
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  // DeepSeek on Claude Code：状态栏报的是接入方式下的真实模型名，Hub 记显示用的 id。
  if (String(session.kind || '').replace(/-resume$/, '') === 'deepseek-claude') {
    const profile = require('./core/deepseek-claude-profile');
    if (!profile.isKnownModel(model.id)) return false;
    const id = profile.normalizeModel(model.id);
    model = { id, displayName: profile.displayName(id, session.deepseekActiveRoute || session.deepseekRoute) };
  }
  const currentId = session.currentModel && session.currentModel.id;
  if (currentId === model.id) return false;
  sessionManager.updateSessionMeta(sessionId, {
    currentModel: {
      id: model.id.trim(),
      displayName: String(model.displayName || model.id).trim().slice(0, 120),
    },
  });
  return true;
}

let groupChatDispatcher = null;
let sessionAutoSuspendScheduler = null;
let agentLeagueBridge = null;
let studyBridge = null;
const meetingTerminalActivitySentAt = new Map();
const terminalOutputBatcher = new TerminalOutputBatcher({
  emit: ({ sessionId, data, seq }) => {
    sendToRenderer('terminal-data', { sessionId, data, seq });
  },
});

sessionManager.onFocusChanged = (sessionId) => { if (sessionId) terminalOutputBatcher.flush(sessionId); };

// 这个会话就免于闲置休眠（含内存压力档、低开销软上限），卡片显示「WeLink」小标；断开、退出、休眠即清除。
const welinkLinkDetector = require('./core/welink-native/link-detector').createWelinkLinkDetector({
  dataDir: getHubDataDir(),
  // CodeAgent 整屏重绘：输出停下后（至少隔 2 秒）把会话终端输出的最后 64 KB 回放成当前这一屏再判断（只在内存里用，不落盘）。
  readScreen: sessionId => {
    const s = sessionManager.sessions?.get?.(sessionId);
    const text = sessionManager.getSessionBuffer(sessionId);
    if (!s || text == null) return null;
    return require('./core/welink-native/screen').renderScreenLines({ text, cols: Number(s.pty?.cols) || 120, rows: Number(s.pty?.rows) || 30 });
  },
  isEligible: sessionId => {
    const s = sessionManager.sessions?.get?.(sessionId);
    return !!s && isCodeAgentKind(s.info?.kind) && s.info?.codeagentRunMode !== 'serve';
  },
  onChange: ({ sessionId, linked, reason }) => {
    console.log(`[welink-native] ${String(sessionId).slice(0, 8)} ${linked ? 'linked' : 'unlinked'} (${reason})`);
    const s = sessionManager.sessions?.get?.(sessionId);
    // 只推界面、不落盘：这是运行态，重启后以新进程的屏幕为准。
    if (s && s.info) sendToRenderer('session-updated', { session: sessionManager._toPublic(s.info) });
    try { global.__welinkNative?.onLinkChanged?.({ sessionId, linked, reason }); } catch {}
  },
});
global.__welinkLinkDetector = welinkLinkDetector;
sessionManager.welinkLinkedLookup = sessionId => welinkLinkDetector.isLinked(sessionId);
sessionManager.onInput = (sessionId, data) => welinkLinkDetector.noteInput(sessionId, data);
sessionManager.on('session-exited', event => welinkLinkDetector.noteExit(event && event.sessionId, 'exit'));

sessionManager.onData = (sessionId, data, seq) => {
  welinkLinkDetector.noteOutput(sessionId, data);
  // 未聚焦的群聊成员**降频转发，不再丢弃**。旧实现直接 return，让 xterm 在未聚焦
  // 期间收不到任何数据，切过去只能靠回灌一段截断的 ANSI 流重建画面 —— 对 alt-screen
  // TUI 来说基本只剩最后一屏，用户表现为"滚不上去 / 渲染卡住"。
  // 详见 main/terminal-output-policy.js 顶部。
  const delay = getTerminalBatchDelay(sessionManager, sessionId);
  if (isBackgroundMember(sessionManager, sessionId)) {
    // 房间列表的轻量活动指示仍然限流，2 次/秒足够，不受输出节奏影响。
    const now = Date.now();
    if (now - (meetingTerminalActivitySentAt.get(sessionId) || 0) >= 500) {
      meetingTerminalActivitySentAt.set(sessionId, now);
      sendToRenderer('meeting-terminal-activity', { sessionId });
    }
  }
  terminalOutputBatcher.push(sessionId, data, seq, delay);
};

sessionManager.onSessionClosed = (sessionId, meetingId, exitInfo) => {
  sessionModelCreationConfirmation.cancelSession(sessionId);
  require('./core/group-chat-watcher').cancelPendingModelSubmissions(sessionId);
  codexAccountSwitch.forget(sessionId);
  claudeAccountSwitch.forget(sessionId);
  claudeQuotaPrecompact?.forget(sessionId);
  const isWorkspaceMigration = workspaceMigrationSessionIds.has(sessionId);
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  if (!isWorkspaceMigration) groupChatDispatcher?.markProcessExitForSession(sessionId, exitInfo);
  // 让投研等原生 PTY 编排者能在用户关闭窗口或 CLI 异常退出时释放跨 Hub 租约。
  sessionManager.emit('session-exited', { sessionId, meetingId, exitInfo: exitInfo || null });

  try { transcriptTap.unregisterSession(sessionId); } catch {}
  // 会话真的关掉了，等待不该留在盘上等一个再也不会回来的席位。
  // 休眠走 onSessionSuspended，不经过这里，所以休眠会话的等待会保留。
  if (!isWorkspaceMigration) { try { claudeQuotaResume.forget(sessionId); } catch {} }
  // 群聊 cli-ready monotonic guard 清理（独立模块，详见 core/group-chat-cli-ready-detector.js）
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  // 渲染层要靠 requested 分辨“用户删/重启/迁移”和“CLI 自己崩了”；
  // 后者不该把会话连同输入框一起抹掉，而要留一张断开卡片 + 重连入口。
  sendToRenderer('session-closed', {
    sessionId,
    exitInfo: exitInfo || null,
    requested: isWorkspaceMigration || !!(exitInfo && exitInfo.requested),
  });
  if (meetingId && !isWorkspaceMigration) {
    const updated = meetingManager.removeSubSession(meetingId, sessionId);
    if (updated) sendToRenderer('meeting-updated', { meeting: updated });
  }
};

sessionManager.onSessionSuspended = (sessionId, meetingId, session, exitInfo) => {
  welinkLinkDetector.noteExit(sessionId, 'suspended');
  sessionModelCreationConfirmation.cancelSession(sessionId);
  require('./core/group-chat-watcher').cancelPendingModelSubmissions(sessionId);
  if (session?.suspendReason !== 'account-switch' || !codexAccountSwitch.isSwitching(sessionId)) codexAccountSwitch.forget(sessionId);
  if (session?.suspendReason !== 'account-switch' || !claudeAccountSwitch.isSwitching(sessionId)) claudeAccountSwitch.forget(sessionId);
  claudeQuotaPrecompact?.forget(sessionId);
  completionNotifier.noteSessionClosed({ sessionId });
  terminalOutputBatcher.flush(sessionId);
  meetingTerminalActivitySentAt.delete(sessionId);
  if (session?.suspendReason !== 'account-switch') {
    groupChatDispatcher?.markProcessExitForSession(sessionId, { ...(exitInfo || {}), suspended: true });
    sessionManager.emit('session-exited', {
    sessionId,
    meetingId,
    exitInfo: { ...(exitInfo || {}), suspended: true },
    });
  }
  try { transcriptTap.unregisterSession(sessionId); } catch {}
  try { cliReadyDetector.cleanup(sessionId); } catch {}
  // Keep meeting membership and persisted metadata intact. The renderer turns
  // the existing card into a dormant entry that the normal resume path wakes.
  sendToRenderer('session-suspended', { sessionId, session });
};

// Register a freshly-spawned session with the transcript tap so the appropriate
// backend starts watching its CLI-native transcript file. DeepSeek normally
// routes to Codex; transcriptKind keeps pre-migration Claude sessions resumable.
function registerSessionForTap(session) {
  sessionUsageService.bind(session);
  if (['codex-app-server','acp','claude-stream-json'].includes(session?.runtimeBackend)) return;
  if (!session || !session.id) return;
  // 返回值：登记没成时为 { ok: false, step: 'tap', message }，新建流程据此给一行提示（main/session-tap-register.js）。
  const tap = require('./main/session-tap-register').registerTranscriptTap(transcriptTap, session, () => ({
      cwd: session.cwd,
      transcriptPath: session.transcriptPath || undefined,
      sessionsRoot: session.codexSessionsRoot || undefined,
      codexSid: session.codexSid || undefined,
      kimiSid: session.kimiSid || undefined,
      geminiChatId: session.geminiChatId || undefined,
      geminiProjectHash: session.geminiProjectHash || undefined,
      antigravityEventsFile: /^gemini(?:-resume)?$/.test(session.kind) ? require('./core/antigravity-config').eventsFile(getHubDataDir(),session.id) : undefined,
      sessionDir: session.kimiSessionDir || undefined,
      registeredAt: session.createdAt || Date.now(),
      allowMtimeFallback: !!session.codexAllowMtimeFallback,
      requirePromptMatch: !!session.meetingId,
    }));
  if (!tap.ok) return tap;
  if (session.meetingId && session.codexSwitchStatus?.status !== 'switching'
      && groupChatDispatcher && typeof groupChatDispatcher.recoverSession === 'function') {
    const timer = setTimeout(() => {
      groupChatDispatcher.recoverSession(session.id).catch((error) => {
        console.warn('[groupchat] resumed-session recovery failed:', error && error.message);
      });
    }, 1200);
    timer.unref?.();
  }
  return tap;
}

const { isPtyCodexSession, createCodexPtyHookHandler } = require('./main/codex-pty-hook.js');
// 函数声明会提升；handler 在第一次 hook 到达时才创建，届时依赖都已就绪。
let _codexPtyHookHandler = null;
function handleCodexPtyHook(session, event, parsed) {
  if (!_codexPtyHookHandler) {
    _codexPtyHookHandler = createCodexPtyHookHandler({
      sessionManager, transcriptTap, sendToRenderer, maybeAutoTitleSessionFromPrompt, readCodexRolloutMeta,
      isCodexTopLevelRolloutMeta: require('./core/codex-transcript-parser.js').isCodexTopLevelRolloutMeta,
    });
  }
  return _codexPtyHookHandler(session, event, parsed);
}

function codeAgentIdentityRejection(hubSessionId, current, fields) {
  if (!isCodeAgentKind(current?.kind)) return null;
  const identity = require('./core/codeagent-fork-identity');
  const sourceId = identity.forkSourceIdentity({ ...current,
    codeagentForkSourceSessionId: current.codeagentForkSourceSessionId
      || sessionManager.openLeases?.get(hubSessionId)?.forkSource }, {
    getSession: id => sessionManager.getSession(id),
    loadSessionFile: id => require('./core/session-store').loadSessionFile(id, { strict: true }),
  });
  return identity.identityRejection(fields, sourceId);
}

// CodeAgent 换身份（/clear、/new、/resume）时，必须工作目录和记录目录都与会话一致才改绑。
function codeAgentSwitchLocationOk(parsed, session) {
  if (!session?.cwd || !parsed?.cwd || !parsed?.transcriptPath) return false;
  try { return sameWorkDir(parsed.cwd, session.cwd) && transcriptBucketMatches(parsed.transcriptPath, session.cwd); }
  catch { return false; }
}

// R57 诊断：CodeAgent 会话的对话号绑定、改绑被拒、外来 hook 丢弃写进 logs/codeagent-resume.log（一键反馈会按名字带上）。
// 同一会话、同一个来号、同一原因只记一次，免得被拒后每个 hook 都写一行。
const codeAgentIdentityLogSeen = new Set();
function logCodeAgentIdentity(session, event, fields = {}) {
  if (!session || !isCodeAgentKind(session.kind)) return;
  const key = [session.id, event, fields.incoming || '', fields.why || ''].join('|');
  if (codeAgentIdentityLogSeen.has(key)) return;
  if (codeAgentIdentityLogSeen.size > 2000) codeAgentIdentityLogSeen.clear();
  codeAgentIdentityLogSeen.add(key);
  require('./core/transcript-resume-sync').appendResumeLog(getHubDataDir(), event, { session: String(session.id || '').slice(0, 8), ...fields });
}

function updateSessionTranscriptBinding(hubSessionId, fields = {}) {
  if (!hubSessionId) return null;
  const next = {};
  if (fields.ccSessionId) next.ccSessionId = fields.ccSessionId;
  if (fields.transcriptPath) next.transcriptPath = fields.transcriptPath;
  if (Object.keys(next).length === 0) return null;
  const current = sessionManager.getSession(hubSessionId);
  if (!current) return null;
  const identityRejected = codeAgentIdentityRejection(hubSessionId, current, {
    ccSessionId: fields.ccSessionId || current.ccSessionId,
    transcriptPath: fields.transcriptPath,
  });
  if (identityRejected) {
    console.warn(`[codeagent binding] ignored ${identityRejected} for ${String(hubSessionId).slice(0, 8)}`);
    return null;
  }
  // 首次绑定和 pending 的消费同一次提交；租约拒绝时不能遗留半个身份。
  if (isCodeAgentKind(current.kind) && fields.codeagentIdentityPending === false) next.codeagentIdentityPending = false;
  // 子进程劫持防护：在会话里再跑一个 `claude`（跑测试、批处理、脚本探针）时，
  // 子进程会继承 CLAUDE_HUB_SESSION_ID，它的 Stop hook 会把本卡片重绑到子进程的
  // transcript 上；子进程目录一旦被清理，卡片视图就 ENOENT 打不开。
  // hook 上报的 cwd 与会话 cwd 不一致时一律不重绑（卡片仍可用 ccSessionId 回退查找）。
  // 短名与长名写法（C:\Users\X0012~1 与 C:\Users\x00123456）是同一目录，不算嵌套 CLI。
  if (fields.cwd && current.cwd && normalizeWorkspaceKey(fields.cwd) !== normalizeWorkspaceKey(current.cwd)
      && !sameWorkDir(fields.cwd, current.cwd)) {
    console.warn('[hook] ignored transcript rebind from a nested CLI:',
      `session=${String(hubSessionId).slice(0, 8)} reported=${fields.cwd} expected=${current.cwd}`);
    return null;
  }
  const changed = Object.keys(next).some(k => current[k] !== next[k]);
  if (!changed) return current;
  const updated = sessionManager.updateSessionMeta(hubSessionId, next);
  if (updated) {
    sendToRenderer('session-updated', { session: updated });
    sendToRenderer('session-meta-updated', { hubSessionId, ...next });
  }
  return updated || null;
}

const { addMeetingSubInternal } = registerMeetingCreateIpc(ipcMain, {
  requestModelConfirmation: sessionModelCreationConfirmation.request,
  ensureLaunchAuth:async(kind,opts)=>{await launchAuth.ensure(kind,opts);await ensureCodexAccountNamespace(kind,opts);},
  fs,
  getOrchestrationService: () => global.__orchestrationService || null,
  getHookPort: () => hookPort,
  getHubDataDir,
  getMeetingWorkspaceDir,
  getSlotPromptName,
  groupchat,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isCodexSubagentRolloutPath,
  isIsolatedHub,
  kindLabels: KIND_LABELS,
  meetingManager,
  path,
  registerSessionForTap,
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
  workspaceService,
});

// 群聊分支（加入已有会话 / 从会话建群 / 整群分支）。必须排在 registerMeetingCreateIpc
// 之后：它复用那里的 addMeetingSubInternal，成员的 MCP 注入、槽位登记都长在那个函数里。
require('./main/ipc/groupchat-fork-handlers.js').registerGroupChatForkIpc(ipcMain, {
  addMeetingSubInternal,
  getHubDataDir,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedSessions: () => lastPersistedSessions,
  getPersistedSessions: () => lastPersistedSessions,
  groupchat,
  meetingManager,
  sendToRenderer,
  sessionManager,
  sessionStore,
  stateStore,
});

registerMeetingIpc(ipcMain, {
  getTitleService: () => titleService,
  deleteImmersiveByMeeting: (meetingId) => { delete _immersiveByMeeting[meetingId]; },
  getHubDataDir,
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedSessions: () => lastPersistedSessions,
  getHubConfig,
  groupchat,
  meetingManager,
  scenes,
  sendToRenderer,
  sessionManager,
  sessionStore,
  slotIds: SLOT_IDS,
  stateStore,
});

// =====================================================================
// Group Chat Mode dispatch
// =====================================================================
groupChatDispatcher = createGroupChatDispatcher({
  confirmSessionModel: (...args) => sessionOperations.confirmSessionModel(...args),
  recoverLaunchAuth:(session,failure)=>launchAuth.recover(session.kind,{...session,model:session.currentModel?.id},failure),
  cliReadyDetector,
  getHubDataDir,
  groupchat,
  isCodexBaseKind,
  kindLabels: KIND_LABELS,
  maybeAutoTitleMeetingFromPrompt,
  meetingManager,
  onGroupChatComplete: (event) => completionNotifier.handleGroupChatComplete(
    event,
    meetingManager.getMeeting(event && event.meetingId),
  ),
  sendToRenderer,
  sessionManager,
  transcriptTap,
});

// 小队模式（2026-11-19）：群里设一位负责人，成员做完自动交回。没开小队的群照旧走下面的路由。
const routeUserGroupTurn = (meetingId, args) => global.__devFileEngine
  ? global.__devFileEngine.userTurn(meetingId, args)
  : groupChatDispatcher.dispatchGroupChatTurn(meetingId, args);
try {
  global.__squadEngine = require('./main/groupchat/squad-engine').createSquadEngine({
    getHubDataDir, meetingManager, sendToRenderer, logger: console,
    getDispatcher: () => groupChatDispatcher,
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    ensureMemberReady: (meeting, memberId) => global.__loopEngine.ensureMemberReady(meeting, memberId),
    interruptMeetingTurn: (meetingId, options) => groupChatDispatcher.interruptMeetingTurn(meetingId, options),
    getOrchestrator: meetingId => groupchat.getOrchestrator(getHubDataDir(), meetingId),
    // R46：首轮前掉线时原地重拉 CLI；按 CLI 真实状态判断要不要重启（main/groupchat/squad-leader-health.js）。
    // R46: relaunch in place when no native id yet; decide restarts from the real CLI state.
    restartSession: sid => require('./main/groupchat/squad-leader-health').restartLeader(sessionManager, id => sessionOperations.restartSession(id), sid),
    leaderNeedsRestart: (sid, options) => require('./main/groupchat/squad-leader-health').leaderNeedsRestart(sessionManager, sid, options),
  });
  require('./main/groupchat/squad-engine').registerSquadIpc(ipcMain, () => global.__squadEngine);
} catch (e) { console.warn('[squad] engine init failed:', e && e.message); }

const groupTurnControls = {
  dispatchGroupChatTurn: (meetingId, args) => global.__squadEngine
    ? global.__squadEngine.userTurn(meetingId, args, routeUserGroupTurn)
    : routeUserGroupTurn(meetingId, args),
  interruptGroupChatTurn: (meetingId, options) => groupChatDispatcher.interruptMeetingTurn(meetingId, {
    ...options, targetSids: global.__devFileEngine?.interruptSids(meetingId) || [],
  }),
  // 小队先停（不短路），其余引擎照原顺序。
  stopLoop: (meetingId, options) => {
    const squadStopped = !!global.__squadEngine?.stop(meetingId, { quiet: true });
    const other = global.__deliveryEngine?.stop(meetingId) || global.__devFileEngine?.stop(meetingId)
      || (global.__loopEngine ? global.__loopEngine.stopLoop(meetingId, options) : false);
    return squadStopped || other;
  },
};
registerGroupchatTurnIpc(ipcMain, groupTurnControls);
// 群聊「抢救」下拉（强制结束本轮 / 重启成员 / 回退上一轮 / 跳过未交 / 导出诊断），复用上面的中断与停引擎链路。
require('./main/ipc/groupchat-rescue-handlers.js').registerGroupchatRescueIpc(ipcMain, {
  meetingManager, groupchat, getHubDataDir, sessionManager, sendToRenderer,
  getActiveWatchers: () => groupChatDispatcher.getActiveWatchers(),
  interruptMeetingTurn: groupTurnControls.interruptGroupChatTurn,
  stopLoop: groupTurnControls.stopLoop,
  restartSession: (sid) => sessionOperations.restartSession(sid),
  // 四套引擎都要看：小队、交付流程在两棒之间轮次是空闲的，只看循环引擎会放行「回退上一轮」，撤掉引擎正要交回的那轮。
  isWorkflowRunning: (meetingId) => require('./main/ipc/groupchat-rescue-handlers.js').workflowBusy({
    loopEngine: global.__loopEngine, deliveryEngine: global.__deliveryEngine,
    devFileEngine: global.__devFileEngine, squadEngine: global.__squadEngine,
  }, meetingId),
  // 回退上一轮后，小队负责人掉线停下的任务作废（R47 审查 P2）。
  discardSquadRecovery: (meetingId) => !!(global.__squadEngine && global.__squadEngine.discardRecovery(meetingId)),
  appVersion: require('./core/distribution').editionVersion || app.getVersion(),
});

// Phase 2b：main 进程循环引擎（崩溃续跑 + 成员 wake），复用 dispatcher。try 包裹，绝不影响启动。
// 仅测试启用的钩子（任务书 I 层）：隔离数据目录 + 显式 env 两个条件同时成立才加载，
// 否则一律是 null，生产走的还是真 dispatcher 和真 sessionManager。见模块头注释。
let __testHooks = null;
try {
  __testHooks = require('./main/groupchat/test-dispatch-stub.js').loadTestHooks({
    isIsolatedHub: require('./core/data-dir.js').isIsolatedHub,
    getHubDataDir, meetingManager, logger: console,
  });
  if (__testHooks) __testHooks.registerIpc(ipcMain);
} catch (e) { console.warn('[test-hooks] 加载失败（忽略）:', e && e.message); }

try {
  global.__loopEngine = require('./main/groupchat/loop-engine.js').createLoopEngine({
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    ...(__testHooks && __testHooks.stepTextWait ? { stepTextWait: __testHooks.stepTextWait } : {}),
    getOrchestrator: (meetingId) => groupchat.getOrchestrator(getHubDataDir(), meetingId),
    // 阶段交接文档落在 <Hub 数据目录>/task-docs/<meetingId>/；显式注入，隔离实例才隔得开。
    getHubDataDir,
    meetingManager,
    sessionManager: __testHooks ? __testHooks.wrapSessionManager(sessionManager) : sessionManager,
    sendToRenderer,
    // resumeSession is initialized later in this module; the closure is only
    // invoked after startup, when the provider-native resume handler exists.
    resumeSession: (meta) => resumeSession(meta),
    loadSessionMeta: (sid) => stateStore.isMarkedRemovedSession(sid) ? null : sessionStore.loadSessionFile(sid),
    // 循环报告写到产物根（AI_HUB_ARTIFACTS_ROOT，默认 ~/AI-Artifacts），不再落桌面。
    writeReport: (html) => require('./core/loop-report-file.js').writeLoopReport(html),
    logger: console,
  });
  require('./main/ipc/loop-handlers.js').registerLoopIpc(ipcMain, { loopEngine: global.__loopEngine, deliveryEngine:()=>global.__deliveryEngine });
} catch (e) { console.warn('[loop] engine init failed:', e && e.message); }

try {
  global.__deliveryEngine = require('./main/groupchat/delivery-engine').createDeliveryEngine({
    meetingManager, sessionManager, getHubDataDir,
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    ensureMemberReady: (meeting, memberId) => global.__loopEngine.ensureMemberReady(meeting, memberId),
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    getAttemptEvidence: (id,attemptId,expected) => {
      const orch=groupchat.getOrchestrator(getHubDataDir(),id);
      const matches=attemptId ? [orch.getAttempt(attemptId)].filter(Boolean) : Object.values(orch.state.attempts || {}).filter(a=>
        a.memberId===expected.memberId && a.workflowRun?.runId===expected.runId && a.workflowRun?.stepIndex===expected.stepIndex && a.workflowRun?.attempt===expected.attempt);
      if(matches.length!==1)return null;
      const attempt=matches[0];return {attempt,sourceCompletedAt:orch.state.devChatHistory?.receipts?.[attempt.attemptId]?.sourceCompletedAt};
    },
    sendToRenderer,
    onStatus: id => global.__orchestrationService?.onDeliveryStatus(id),
  });
  global.__deliveryEngine.registerIpc(ipcMain);
  global.__deliveryEngine.startWatching();
} catch (error) { console.error('[delivery] initialization failed:', error); }

try {
  global.__devFileEngine = require('./main/groupchat/dev-file-engine').createDevFileEngine({
    meetingManager, sessionManager, getHubDataDir, getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    isWorkflowRunning: id => !!global.__loopEngine?.isRunning(id), deliveryEngine: global.__deliveryEngine,
    stopWorkflow: id => global.__loopEngine.stopLoop(id, {interrupt:false, reason:'workflow_disabled'}),
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    ensureMemberReady: (meeting, memberId) => global.__loopEngine.ensureMemberReady(meeting, memberId),
    sendToRenderer, onChanged: (id) => devWorkbench?.changed?.(id), logger: console,
  });
  global.__devFileEngine.registerIpc(ipcMain, require('electron').shell);
} catch (error) { console.error('[dev-file] initialization failed:', error); }

try {
  devWorkbench = require('./main/groupchat/dev-workbench.js').createDevWorkbench({
    meetingManager, sessionManager, loopEngine: global.__loopEngine, fileEngine: global.__devFileEngine, deliveryEngine: global.__deliveryEngine, getHubDataDir, sendToRenderer, logger: console,
  });
  devWorkbench.registerIpc(ipcMain);
} catch (error) { console.error('[dev-workbench] initialization failed:', error.message); }

// 「进展」视图（2026-10-27）：读各会话自己维护的进展卡顶部白话块，推给会话行、进展条和左侧栏「进展」页。
let progressCards = null;
try {
  progressCards = require('./main/progress-card-service.js').createProgressCardService({
    getSessions: () => sessionManager.getAllSessions(), sendToRenderer, logger: console,
    // 只供端到端测试压低时限（真等 40 分钟不现实）；不设时用默认值。
    ...(Number(process.env.CLAUDE_HUB_PROGRESS_STALE_MS) > 0 ? { staleMs: Number(process.env.CLAUDE_HUB_PROGRESS_STALE_MS) } : {}),
    ...(Number(process.env.CLAUDE_HUB_PROGRESS_POLL_MS) > 0 ? { pollMs: Number(process.env.CLAUDE_HUB_PROGRESS_POLL_MS) } : {}),
  });
  progressCards.registerIpc(ipcMain);
  progressCards.start();
} catch (error) { console.error('[progress-cards] initialization failed:', error.message); }

// 在跑一览（2026-11-20）：侧栏按钮和公司助理 running_overview 工具共用的只读快照，只读现有会话字段、进展卡和组队表。
let runningOverview = null;
try {
  runningOverview = require('./core/running-overview').createRunningOverview({
    getSessions: () => sessionManager.getAllSessions(),
    getCards: () => progressCards?.snapshot() || [],
    getTeams: () => global.__teamService?.listTeams?.() || [],
    isAgentTurnActive: id => sessionManager.isAgentTurnActive(id),
    isReportedRunning: progressCards?.isRunning ? s => progressCards.isRunning(s) : null,
    // 会话条目上实时记的终端输出时间（getAllSessions 的信息里没有它）。
    getLastOutputAt: id => sessionManager.getGroupChatLastActivity(id),
  });
  ipcMain.handle('running-overview:get', () => ({ ok: true, ...runningOverview.get() }));
} catch (error) { console.error('[running-overview] initialization failed:', error.message); }

// 子 Agent 进度一行字（2026-10-29）：只盯卡片视图正在看的会话，读子 Agent 记录，推「2 个子任务进行中 · 最近一步：…」。
try {
  require('./main/subagent-progress-service.js').createSubagentProgressService({
    getSession: id => sessionManager.getSession(id), sendToRenderer, logger: console,
    // R46：CLI 退回系统终端（原生会话不看终端屏幕）、本轮是否还在跑。CLI exited to the shell / turn still running.
    isCliGone: id => !sessionManager.getNativeClaude?.(id) && !sessionManager.getNativeSession?.(id)
      && require('./core/host-shell-detector').detectHostShellTakeover(sessionManager.getSessionBuffer(id) || ''),
    isTurnActive: id => sessionManager.isAgentTurnActive(id),
  }).registerIpc(ipcMain);
} catch (error) { console.error('[subagent-progress] initialization failed:', error.message); }

const devChatHistory = require('./core/dev-chat-history').createHistoryService({
  getOrchestrator: id => groupchat.getOrchestrator(getHubDataDir(),id),
  onChanged: (meetingId,orch) => sendToRenderer('dev-workbench:progress',{meetingId,revision:orch.state.revision}),
});
function watchDevChatHistory(session, sourcePath) {
  if (['codex-app-server','acp','claude-stream-json'].includes(session?.runtimeBackend)) return;
  const meeting=session?.meetingId && meetingManager.getMeeting(session.meetingId);
  if(!require('./core/dev-file-workflow').enabled(meeting) && !require('./core/delivery-workflow').enabled(meeting))return;
  const orch=groupchat.getOrchestrator(getHubDataDir(),meeting.id);
  const paths=new Set([sourcePath || session.transcriptPath || transcriptTap.getCodexRolloutPath(session.id),
    ...Object.values(orch.state.devChatHistory?.receipts || {})
      .filter(r=>r.sid===session.id && r.sourcePath && !r.sourceCompletedAt).map(r=>r.sourcePath)]);
  for(const file of paths) {
    void devChatHistory.watch({sid:session.id,meetingId:meeting.id,kind:session.transcriptKind || session.kind,
      sourcePath:file,speaker:session.title || session.kind})
      .catch(error=>console.error('[dev-chat-history] watch failed:',error));
  }
}
transcriptTap.on('session-bound',event=>watchDevChatHistory(sessionManager.getSession(event.hubSessionId),event.transcriptPath || event.rolloutPath));
const collectGroupConversation=require('./core/group-conversation-history').createGroupConversationCollector();
const nativeGroupContent = createContentUpdateBatcher();
function collectNativeGroupItemsNow(event) {
  const sid = event.sessionId || event.id;
  const session = sessionManager.getSession(sid);
  if (isSessionViewer(session)) return;
  const meeting = session?.meetingId && meetingManager.getMeeting(session.meetingId);
  if (!meeting?.groupChat) return;
  const native = sessionManager.getNativeSession?.(sid) || sessionManager.getNativeCodex?.(sid);
  const claude = sessionManager.getNativeClaude?.(sid);
  if (!native && !claude) return;
  try {
    const orch = groupchat.getOrchestrator(getHubDataDir(), meeting.id);
    if (collectGroupConversation({ native, claude, event, orch, sid })) sendToRenderer('groupchat-history-updated',
      { meetingId: meeting.id, sid, revision: orch.state.revision });
  } catch (error) { console.error('[conversation-history] native item persistence failed:', error); }
}
function collectNativeGroupItems(event) {
  const sid=event.sessionId || event.id;
  const session=sessionManager.getSession(sid);
  if(!session?.meetingId || isSessionViewer(session))return;
  const runtime=session.nativeRuntime;
  if(event.type || ['completed','failed','interrupted','idle'].includes(runtime?.state)) {
    nativeGroupContent.flush(sid);
    collectNativeGroupItemsNow(event);
  } else nativeGroupContent.schedule(sid,event.userMessageId || event.clientSubmissionId || '',()=>collectNativeGroupItemsNow(event));
}
sessionManager.on('codex-content-updated', collectNativeGroupItems);
sessionManager.on('codex-session-updated', collectNativeGroupItems);
sessionManager.on('native-agent-item', collectNativeGroupItems);
sessionManager.on('native-agent-lifecycle', collectNativeGroupItems);
const devChatHistoryTimer=setInterval(()=>{
  for(const {info:session} of sessionManager.sessions.values()) {
    if (!session.meetingId) continue;
    if (isSessionViewer(session)) continue;
    const native=(sessionManager.getNativeSession?.(session.id) || sessionManager.getNativeCodex?.(session.id));
    const meeting=session.meetingId && meetingManager.getMeeting(session.meetingId);
    if(native && meeting?.groupChat) {
      try {
        const orch=groupchat.getOrchestrator(getHubDataDir(),meeting.id);
        if(collectGroupConversation({native,orch,sid:session.id}))sendToRenderer('groupchat-history-updated',
          {meetingId:meeting.id,sid:session.id,revision:orch.state.revision});
      } catch(error) { console.error('[conversation-history] native item persistence failed:',error); }
    } else watchDevChatHistory(session);
  }
},5000);
devChatHistoryTimer.unref?.();

transcriptTap.on('progress-update', event => {
  try {
    const session = event && sessionManager.getSession(event.hubSessionId);
    const meeting = session && session.meetingId && meetingManager.getMeeting(session.meetingId);
    if (!meeting || !meeting.groupChat || meeting.scene !== 'dev') return;
    if (require('./core/dev-file-workflow').enabled(meeting)) return; // collected losslessly by source identity
    const orch = groupchat.getOrchestrator(getHubDataDir(), meeting.id);
    if (orch.recordProgressUpdate(session.id, event.text, event.at, session.title || session.kind, event)) {
      sendToRenderer('dev-workbench:progress', { meetingId: meeting.id, revision: orch.state.revision,
        runId: orch.state.activeRun?.runId, turnNum: orch.state.currentTurn });
    }
  } catch (error) { console.warn('[dev-workbench] progress message could not be saved:', error.message); }
});

sessionAutoSuspendScheduler = createSessionAutoSuspendScheduler({
  sessionManager,
  // 内存紧张提前休眠（2026-11-12）：休眠了哪些会话用提示告诉用户；助理的后台会话不列名字。
  onMemorySuspend: ({ usage, requested }) => {
    const visible = requested.filter(r => !HUB_PET_ASSISTANT_PURPOSES.has(r.purpose)).map(r => r.title || '未命名会话');
    const assistants = requested.length - visible.length;
    const names = [...visible.map(t => `「${t}」`), ...(assistants ? [`${assistants} 个助理后台会话`] : [])].join('、');
    sendToRenderer('session-notice', { level: 'warning', message: `内存占用 ${Math.round(usage * 100)}%，已自动休眠早已答完的 ${names}，点会话即可唤醒、记录都在。` });
  },
  getProtectedSessionIds: () => collectProtectedSessionIds({
    agentLeagueBridge,
    groupChatDispatcher,
    loopEngine: global.__loopEngine,
    meetingManager,
    studyBridge,
    getCompanyMeetings: () => companyAssistantService && companyAssistantService.meetings,
    getWelinkLinkedIds: () => welinkLinkDetector.linkedIds(),
  }),
  // 休眠记录同时写进日志文件（2026-10-16）：以前只打在控制台，公司那边查日志以为 Hub 没有自动休眠。
  logger: (() => {
    const write = require('./core/window-keep-rendering.js').createWindowEventLog(path.join(getHubDataDir(), 'logs', 'session-suspend.log'), { logger: {} });
    return {
      log: (...args) => { console.log(...args); write('auto-suspend', { message: args.join(' ') }); },
      warn: (...args) => { console.warn(...args); write('auto-suspend-warn', { message: args.join(' ') }); },
    };
  })(),
});

// 自动休眠预演。参数与后台巡检完全一致（复用 scheduler 内部的 sweepOptions），
// 所以「预演说会休眠」和「实际会休眠」不会漂移。
registerAutoSuspendIpc(ipcMain, {
  getScheduler: () => sessionAutoSuspendScheduler,
  logger: console,
});

const xresearchBridge = null;

// Group chat cards come from members' Markdown answer files (2026-09-30).
const answerFileMonitor = require('./main/groupchat/answer-file-monitor').createAnswerFileMonitor({
  getHubDataDir, meetingManager, sendToRenderer, logger: console,
  onChanged: (id, orch) => global.__orchestrationService?.onAnswersChanged(id, orch),
  getOrchestrator: id => groupchat.getOrchestrator(getHubDataDir(), id),
});
answerFileMonitor.start();

registerGroupchatQueryIpc(ipcMain, {
  getHubDataDir,
  groupchat,
  transcriptTap,
  reconcileAnswers: id => answerFileMonitor.reconcile(id),
});

registerGroupchatRecoveryIpc(ipcMain, {
  dispatchGroupChatTurn: groupChatDispatcher.dispatchGroupChatTurn,
  getHubDataDir,
  getActiveWatchers: groupChatDispatcher.getActiveWatchers,
  groupchat,
  groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
  isWorkflowRunning: (meetingId) => !!(global.__loopEngine && global.__loopEngine.isRunning(meetingId)),
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
registerGroupchatSupplementIpc(ipcMain, {
  getActiveWatchers: groupChatDispatcher.getActiveWatchers,
  getHubDataDir,
  groupchat,
  groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
  meetingManager,
  sendToRenderer,
  sessionManager,
  transcriptTap,
});
registerCliStatusIpc(ipcMain, {
  cliReadyDetector,
  sessionManager,
});

registerPromptInspectIpc(ipcMain, {
  sessionManager,
});

// 具名保存：手机直接对话（session-chat）读卡片要用与电脑卡片完全相同的解析依赖。
const transcriptIpcDeps = {
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutByCwd,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  // 分支会话补分支前历史时要找祖先；祖先常常已经休眠，只剩落盘记录。
  getPersistedSessions: () => lastPersistedSessions,
  isCodexCliKind,
  isUsableCodexRolloutPath,
  parseClaudeTranscriptToTurns,
  parseClaudeTranscriptToNativeTurns: require('./core/claude-disk-transcript.js').parseClaudeTranscriptToNativeTurns,
  parseCodexRolloutToTurns,
  sessionManager,
  transcriptTap,
  transcriptParserService,
  updateSessionTranscriptBinding,
};
registerTranscriptIpc(ipcMain, transcriptIpcDeps);

// build-injection IPC 历史用于 blackboard 用户输入合成注入子会话(meeting-blackboard.js)。
// Module C 后 blackboard 已删除,该 handler 不再被任何前端代码调用,清理。

// 新建与休眠恢复共用的启动前检查（2026-11-24 复审：恢复路径以前只查登录，部门 API key 会话恢复时不会拉起本机反代）。
// 函数声明会提升；里面用到的 companyProxyService / lanPoolService / claudeAccountBroker 在调用时才读，届时都已初始化。
async function ensureSessionLaunchAuth(kind, opts = {}) {
  const featureGateway = require('./core/assistant-gateway-route').allowedSession(kind, opts || {});
  // 功能固定线路（2026-11-27）：按选型里的来源检查——部门 key 只要反代在跑，公司模型要上游就绪，自有接口 / 账号不经反代。
  const featureSource = featureGateway ? require('./core/assistant-gateway-route').routeOf(opts.featureAgentChoice)?.source : '';
  if (featureSource === 'company') {
    if (lanPoolService.client()?.enabled) {
      const shared = await lanPoolService.snapshot({ force: true });
      if (!shared?.ready) throw new Error(lanPoolService.error || '共享主机模型服务尚未就绪');
    } else {
      const status = await companyProxyService.ensureReady();
      if (status.state === 'failed' || status.state === 'not-ready') throw new Error(status.message || '公司模型反代还没准备好');
    }
  } else if (featureGateway && featureSource !== 'gateway') {
    // 自有接口 / 自有 API 账号：直连，不用拉起反代。
  } else if (featureGateway || require('./core/company-model-proxy').usesGateway(kind, getHubConfig())) {
    // API 网关会话只要本机反代在跑；公司上游（CodeAgent）准备没准备好与它无关。网关自身的问题在对话里用白话报。
    const status = await companyProxyService.ensureRunning();
    if (status.state === 'failed' || status.state === 'stopped') throw new Error(status.message || '本机反代没有启动，API 网关会话暂时开不了');
  } else if (!featureGateway && require('./core/company-model-proxy').usesProxy(kind, getHubConfig())) {
    if (lanPoolService.client()?.enabled) {
      const shared = await lanPoolService.snapshot({ force: true });
      if (!shared?.ready) throw new Error(lanPoolService.error || '共享主机模型服务尚未就绪');
    } else {
      const status = await companyProxyService.ensureReady();
      if (status.state === 'failed' || status.state === 'not-ready') throw new Error(status.message || '公司模型反代还没准备好');
    }
  }
  // Both checks are read-only; run them side by side. A login problem is
  // reported ahead of a config problem, as when they ran one after another.
  const [auth, namespace] = await Promise.allSettled([launchAuth.ensure(kind, opts), ensureCodexAccountNamespace(kind,opts)]);
  if (auth.status === 'rejected') throw auth.reason;
  if (namespace.status === 'rejected') throw namespace.reason;
  // 部门 API key 的功能会话不用 Claude 订阅账号，不查订阅凭据。
  if (!featureGateway && /^claude(?:-resume)?$/.test(kind) && (opts.claudeAccountSwitchable || opts.claudeAutoSwitch)
    && !getHubConfig().companyCli && getHubConfig().claudeBackend !== 'api') {
    const profile = require('./core/claude-subscription-profiles').profileForSession(
      opts.claudeRuntimeHome ? { ...opts, claudeConfigDir: undefined } : opts, getHubConfig());
    // 这台电脑还没有任何 Claude 账号登录过：交给 Claude CLI 自己的登录流程，不在这里拦（2026-10-28：
    // 新装 Claude 的用户点新建会话只看到「Claude 登录或配置文件无法读取」，会话建不出来）。专用账号照旧严格核对。
    if (profile.id === 'default' && require('./core/claude-subscription-profiles').firstLoginExempt(opts, getHubConfig())) return;
    // 刷新已被登录服务拒绝的号：正在跑的会话照常用旧访问令牌到期，新会话不再开到这个号上。
    const blocked = claudeAccountBroker.authBlocked(profile);
    if (blocked?.code === 'CLAUDE_RELOGIN_REQUIRED') throw require('./core/claude-account-credentials').fail(blocked.code, `Claude 账号${blocked.message}`);
    await claudeAccountBroker.getCredentials(profile);
  }
}

const resumeSession = createResumeSessionHandler({
  requestModelConfirmation: sessionModelCreationConfirmation.request,
  ensureLaunchAuth: ensureSessionLaunchAuth,
  async prepareAssistantResume(meta) {
    if (!assistantService) throw new Error('助理服务尚未就绪');
    assistantService.requireAssistantResume(meta);
    await assistantService.connectBridge();
    return assistantService.getLaunchOptions(meta.kind, meta.hubId);
  },
  prepareOrchestratorResume: meta => {
    if (!global.__orchestrationService) throw new Error('AI 编排服务尚未就绪，编排员暂不能恢复');
    return global.__orchestrationService.resumeOptions(meta);
  },
  defaultCodexSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  findCodexRolloutBySid,
  findTranscriptByCCSessionId,
  fs,
  getHookPort: () => hookPort,
  getHubDataDir,
  hookToken: HOOK_TOKEN,
  isClaudeFamily,
  isCodexBaseKind,
  isCodexSubagentRolloutPath,
  meetingManager,
  os,
  path,
  readCodexRolloutMeta,
  readTranscriptTail: (kind, sourcePath, n) => readTranscriptTail(kind, sourcePath, n, {
    parserService: transcriptParserService,
  }),
  registerSessionForTap,
  resolveCodexSessionsRoot: (meta = {}) => {
    // Meeting Codex deliberately shares the ordinary ~/.codex history. A
    // standalone resume follows its persisted subscription profile instead of
    // accidentally looking only in the currently selected account.
    if (meta.meetingId) return DEFAULT_CODEX_SESSIONS_ROOT;
    const config = getHubConfig();
    return resolveCodexUsageScope({
      ...config,
      ...(meta.codexProfile ? { codexSubscriptionProfile: meta.codexProfile } : {}),
    }, {
      hubDataDir: getHubDataDir(),
      homeDir: os.homedir(),
    }).sessionsRoot;
  },
  scenes,
  sendToRenderer,
  sessionManager,
  slotIds: SLOT_IDS,
});

require('./core/codeagent-commands-probe').commandStartup(getHubDataDir(), {
  hubVersion: require('./package.json').version, dataDirOverride: !!process.env.CLAUDE_HUB_DATA_DIR,
});
// 公司模型反代（2026-11-06，5.5.12）：「自有 API」里任一工具选了「公司模型」才启动，随 Hub 起停；
// 新建这类会话前先确认它已就绪。见 main/company-proxy-service.js、core/company-model-proxy.js。
let companyProxyFailureShown = '';
// 有没有会话种类用公司上游（CodeAgent 账号）：全部走 API 网关的用户，不提示「公司上游没准备好」这类与他无关的状态。
const usesCompanyUpstream = () => { const c = getHubConfig();
  return (c.claudeBackend === 'proxy' && c.claudeUpstream !== 'gateway') || (c.codexBackend === 'proxy' && c.codexUpstream !== 'gateway')
    || (c.dshBackend === 'proxy' && c.dshUpstream !== 'gateway') || require('./core/lan-pool').read(getHubDataDir()).host?.enabled === true; };
// 有没有会话种类走 API 网关：网关只走本机反代，共享主机的同事端也要在本机起反代（11-19 审查发现）。
const usesGatewayRoute = () => { const c = getHubConfig();
  return (c.claudeBackend === 'proxy' && c.claudeUpstream === 'gateway') || (c.codexBackend === 'proxy' && c.codexUpstream === 'gateway')
    || (c.dshBackend === 'proxy' && c.dshUpstream === 'gateway'); };
const companyProxyService = new (require('./main/company-proxy-service').CompanyProxyService)({
  dataDir: getHubDataDir(), safeStorage: require('electron').safeStorage,
  // 助理用部门 API key 时（core/assistant-gateway-route.js）也要本机反代常驻：网关上游只在本机反代里。
  isEnabled: () => (getHubConfig().companyCli === true && (usesGatewayRoute() || (!require('./core/lan-pool').read(getHubDataDir()).client?.enabled
    && (getHubConfig().companyProxyEnabled === true || require('./core/lan-pool').read(getHubDataDir()).host?.enabled === true))))
    || require('./core/assistant-gateway-route').inUse(getHubDataDir())
    || require('./core/feature-agent-choice').harnessInUse(getHubDataDir())
    // 员工助手接了 HUB-H 公司模型（core/weclaw-link.js）：代理要常驻，员工助手随时会来调。
    || (getHubConfig().companyCli === true && require('./core/weclaw-link').readState(getHubDataDir()).enabled),
  // 换号、退回个人号、反代起不来：用会话提示条讲给用户听（renderer.js 的 session-notice）。
  // 换号/退回个人号是常驻提示条，用户手动关（只在每类第一次时弹，见 company-proxy-service）。
  // 自动处理好的只进日志，个人账号登录读不出来显式标 blocking（分类见 company-proxy-service 的 noticeKindFor）。
  // 状态失败（failed / 非 INITIALIZING 的 not-ready，例如读不到 CodeAgent 版本）也显式标 blocking，不靠文字猜。
  onNotice: notice => sendToRenderer('session-notice', { message: notice.text, level: 'warning', persistent: notice.persistent === true,
    reasonKey: notice.type ? `company-proxy:${notice.type}:${notice.account || ''}` : undefined,
    noticeKind: require('./main/company-proxy-service').noticeKindFor(notice) }),
  onStatus: status => {
    if (require('./core/lan-pool').read(getHubDataDir()).client?.enabled) {
      if (usesGatewayRoute()) sendToRenderer('company-proxy:status', { ...(lanPoolService.clientProxyStatus() || {}), gateway: status.gateway });
      return;
    }
    sendToRenderer('company-proxy:status', status);
    if (status.state === 'failed' && status.message !== companyProxyFailureShown) {
      companyProxyFailureShown = status.message;
      sendToRenderer('session-notice', { message: status.message, level: 'error', noticeKind: 'blocking' });
    } else if (status.state === 'not-ready' && status.code !== 'INITIALIZING' && status.message && status.message !== companyProxyFailureShown && usesCompanyUpstream()) {
      // INITIALIZING（准备上游、首次签名初始化）是几秒到几十秒的过渡状态，只在设置弹窗里显示，不弹常驻提示条。
      // 上游没就绪（比如签名缓存不在）：原因和处理办法较长，用常驻提示条讲清楚，不让它一闪而过。
      companyProxyFailureShown = status.message;
      sendToRenderer('session-notice', { message: status.message, level: 'error', persistent: true, noticeKind: 'blocking' });
    } else if (status.state === 'running') companyProxyFailureShown = '';
  },
});
const lanPoolService = new (require('./main/lan-pool-service').LanPoolService)({
  dataDir: getHubDataDir(), proxyService: companyProxyService,
  onChanged: () => { sendToRenderer('lan-pool:changed', {}); sendToRenderer('codeagent-usage-changed', {});
    sendToRenderer('company-proxy:status', lanPoolService.clientProxyStatus()
      ? { ...lanPoolService.clientProxyStatus(), gateway: companyProxyService.status().gateway } : companyProxyService.status()); },
  // 共享停摆、地址变化、主机掉线或恢复：用会话提示条告诉用户，不让共享悄悄失效。
  onNotice: notice => sendToRenderer('session-notice', { message: notice.text, level: notice.persistent ? 'warning' : 'info', persistent: notice.persistent === true,
    noticeKind: notice.noticeKind || 'auto' }),
});
// 后台功能选外壳（Claude Code / Codex + 部门 key 或公司模型）：模型卡状态点读反代状态，单次任务用前按来源拉起反代（同 ensureSessionLaunchAuth）。
require('./core/feature-agent-choice').setRuntime({
  proxyStatus: () => lanPoolService.clientProxyStatus() || companyProxyService.status(),
  ensureProxy: async source => {
    if (source === 'gateway') return companyProxyService.ensureRunning();
    if (lanPoolService.client()?.enabled) { const shared = await lanPoolService.snapshot({ force: true }); return shared?.ready ? { state: 'running' } : { state: 'not-ready', message: lanPoolService.error || '共享主机模型服务尚未就绪' }; }
    return companyProxyService.ensureReady();
  },
});
// Windows 分层 Job Object + 低开销模式 EcoQoS（2026-11-23 P2，core/win32-job-qos.js）：CodeAgent 终端、共享 serve、临时 serve、
// 后台 CodeAgent 单次问答各自装进独立的进程盒子，结束时连脱离父进程的孙进程一起收；Hub 被强杀时内核自动清盒。
// Hub 自己不进任何盒子。AI_HUB_WIN32_JOB_OBJECT=0 / AI_HUB_WIN32_ECOQOS=0 可分别关掉。broker 按需启动、空闲 45 秒退出。
const win32JobQos = require('./core/win32-job-qos').initWin32JobQos({ logger: console });
// 后台子进程生命周期登记（2026-11-19，同事反馈后台 Edge 越开越多把内存撑满）：无头 Edge 起来就登记 PID、启动时间、用途；
// 同时最多 1 个、多的排队，超时按 PID 强收整棵树，内存紧张先等或这次不开；Hub 退出时收掉，下次启动只清自己登记过的遗留（core/child-lifecycle.js）。
const childLifecycle = require('./core/child-lifecycle').initChildLifecycle({ dataDir: getHubDataDir(), logger: console });
app.whenReady().then(() => {
  const t = setTimeout(() => {
    void childLifecycle.reclaimOrphans().catch(error => console.warn('[child-lifecycle] 启动清理遗留失败：', error.message));
    try { require('./main/company-edge-browser').sweepStale({ logger: console }); } catch (_) { /* 公开版没有帖子页 */ }
  }, 8000);
  t.unref?.();
});
app.on('will-quit', () => { try { childLifecycle.shutdownSync(); } catch (_) {} });
app.whenReady().then(async () => {
  await companyProxyService.syncWithConfig();
  if (!getHubConfig().companyCli) return;
  await lanPoolService.sync().catch(error => console.warn('[lan-pool] ' + error.message));
  // 启动失败、换网、休眠唤醒后自动重试；同事端掉线后自动重连。
  lanPoolService.startWatchdog();
  powerMonitor.on('resume', () => { setTimeout(() => void lanPoolService.resume(), 5000); });
});
// 反代与 LAN 池在窗口确认退出后统一收尾；will-quit 最后兜底结束反代进程。
app.on('will-quit', () => companyProxyService.killNow());
let titleService;
const sessionOperations = registerSessionIpc(ipcMain, {
  getTitleService: () => titleService,
  requestModelConfirmation: sessionModelCreationConfirmation.request,
  cancelModelConfirmation: sessionModelCreationConfirmation.cancelSession,
  app,
  lanPoolService,
  ensureLaunchAuth: ensureSessionLaunchAuth,
  prepareLaunchAuth:(kind,opts)=>launchAuth.precheck(kind,opts),
  getPersistedSessions: () => lastPersistedSessions,
  getTerminalOutputBatchStats: () => terminalOutputBatcher.snapshotStats(),
  meetingManager,
  registerSessionForTap,
  resumeSession,
  sendToRenderer,
  sessionManager,
  workspaceService,
});

// 普通会话输入框的闭环发送。必须排在 registerSessionIpc 之后：它复用
//   group-chat-watcher 的 sendToPty，而那份 _deps 由群聊 dispatcher 的 init 注入。
let assistantService = null;
let phoneService = null;
const promptOperations = registerPromptSubmitIpc(ipcMain, {
  sessionManager, transcriptTap, sendToRenderer,
  onPromptReceipt: receipt => { assistantService?.observePromptReceipt?.(receipt); phoneService?.observeReceipt(receipt); },
  onUserPrompt: ({ sessionId, text }) => autoTitleManager.maybeAutoTitleSessionFromPrompt({
    hubSessionId: sessionId, text, submittedAt: Date.now(), signalSource: 'hub_composer',
  }),
  preparePrompt(request, session) {
    if(session?.purpose==='hub-photo-assistant'){
      if(!assistantService)throw new Error('拍图助理服务尚未就绪，消息未发送');
      return assistantService.photo.ensureSession().then(()=>assistantService.photo.preparePrompt(request));
    }
    if (session?.purpose !== 'hub-assistant') return request;
    if (!assistantService) throw new Error('助理服务尚未就绪，消息未发送');
    if (session.id !== request.sessionId || !assistantService.isAssistantSession(session.id)) throw new Error('请求不是固定助理会话，消息未发送');
    return assistantService.preparePrompt(request);
  },
});
// 发行目标关掉助理时（公司版：没有 Claude，助理会话会一直显示运行异常）整个服务不起：
if (require('./core/distribution').featureEnabled('assistant')) try {
  assistantService = require('./main/ipc/assistant-handlers').registerAssistantIpc(ipcMain, {
    dataDir: getHubDataDir(),
    historyDatabasePath: (() => {
      const file = process.env.CLAUDE_HUB_ASSISTANT_HISTORY_DB;
      if (!file || process.env.CLAUDE_HUB_E2E !== '1') return undefined;
      const base = path.resolve(getHubDataDir()), target = path.resolve(file);
      if (!process.env.CLAUDE_HUB_DATA_DIR || base === path.resolve(require('node:os').homedir(), '.ai-hub-community')) throw new Error('助理验收必须使用独立数据目录');
      const relative = path.relative(base, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('助理验收历史必须位于隔离数据目录内');
      return target;
    })(),
    createSession: (kind, opts) => sessionOperations.createSession({ kind, opts }),
    sendPrompt: (sessionId, text, clientSubmissionId) => promptOperations.submitPrompt(null, { sessionId, text, clientSubmissionId, waitForCliReady: true }),
    readSessionTurns: (id, opts) => {
      const s = sessionManager.getSession(id) || require('./core/session-store').loadSessionFile(id, { strict: true });
      if (!s) throw new Error('会话已不存在');
      return require('./main/ipc/transcript-handlers').parseSessionTranscript({ hubSessionId: id, ccSessionId: s.ccSessionId || null, transcriptPath: s.transcriptPath || null, kind: s.kind || null, opts }, transcriptIpcDeps);
    },
    sessionKeys: (id, data) => {
      const s = sessionManager.getSession(id);
      if (!s) throw new Error('会话未打开');
      if (sessionManager.getNativeSession?.(id) || sessionManager.getNativeClaude?.(id)) throw new Error('原生会话不支持终端按键');
      sessionManager.writeToSession(id, data);
    },
    interruptSession: async id => {
      const s = sessionManager.getSession(id);
      if (!s) throw new Error('会话未打开');
      const native = sessionManager.getNativeSession?.(id) || sessionManager.getNativeCodex?.(id);
      if (native?.interrupt) { await native.interrupt(); return { via: 'native' }; }
      if (sessionManager.getNativeClaude?.(id)) { sessionManager.writeToSession(id, '\u0003'); return { via: 'claude-native' }; }
      if (require('./core/ai-kinds').isCodeAgentKind(s.kind)) {
        const stopped = await require('./core/group-chat-watcher').codeAgentInputAction(id, 'stop');
        if (!stopped.ok) throw new Error(stopped.message);
        return stopped;
      }
      // 与电脑上的停止键同一规则（renderer/pty-interrupt.js）：Esc；Qwen 草稿里 Esc 无效，用 Ctrl+C。
      sessionManager.writeToSession(id, String(s.kind || '').replace(/-resume$/, '') === 'qwen' ? '\x03' : '\x1b');
      return { via: 'pty' };
    },
    onPhonePrompt: event => sendToRenderer('session:phone-prompt', event),
    readTerminalScreen: id => {
      const entry = sessionManager.sessions?.get?.(id);
      const text = sessionManager.getSessionBuffer(id);
      if (text == null) return null;
      return { text, cols: Number(entry?.pty?.cols) || 120, rows: Number(entry?.pty?.rows) || 30 };
    },
    // 助理 Tab 输入框的快速回答：与手机共用同一套凭据（Token Plan 优先、百炼按量兜底）。
    fastLane: process.env.HUB_ASSISTANT_FAST_LANE === '0' ? null : new (require('./core/hub-assistant/fast-lane').FastLane)({ credentials: () => require('./core/hub-assistant/fast-lane').fastLaneSources({ dataDir: getHubDataDir(), safeStorage: require('electron').safeStorage }) }),
    hasPendingPrompt:sessionId=>promptOperations.isAssistantSubmissionPending(sessionId),
    isAgentTurnActive:sessionId=>sessionManager.isAgentTurnActive(sessionId),
    getSession: id => sessionManager.getSession(id),
    getAllSessions: () => sessionManager.getAllSessions(),
    readNativeTurns: id => {
      const native=sessionManager.getNativeSession(id);
      if(!native?.readTranscript)return null;
      return {identity:native.threadId,turns:native.readTranscript({limit:80})};
    },
    getSessionMetadata: id => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      const live = sessionManager.getSession(id);
      if (live) return live;
      const saved = require('./core/session-store').loadSessionFile(id, { strict: true });
      return saved ? { ...saved, id: saved.hubId || id } : null;
    },
    listKnownSessions: () => lastPersistedSessions.map(meta => ({ ...meta, id: meta.hubId || meta.id })),
    onAssistantNotification: notification => {
      sendToRenderer('assistant:notification', notification); phoneService?.kick?.();
      // 到点提醒在电脑上也弹出通知（用户可能没在看 Hub）。
      // 用 Hub 自绘的桌面通知卡片（项目约定不用 Windows 原生通知）；点击回到助理会话。
      if (notification?.kind === 'reminder') { try { void desktopNotificationController?.show({ sessionId: assistantService?.store?.get('sessionId') || 'hub-assistant', title: 'AI Hub 提醒', body: String(notification.text || ''), kind: 'reminder' }); } catch (error) { console.warn('[assistant] reminder notification', error.message); } }
    },
    onReminderChanged: event => phoneService?.reminder?.(event),
    onMemosChanged: () => { sendToRenderer('assistant:memos-changed', {}); phoneService?.kick?.(); },
    // 资料口播：Opus 写稿（失败退千问）、微软曉臻合成（失败退千问语音），产物在 Hub 数据目录 assistant/podcasts。
    podcast: (() => { const electron = require('electron'), sc = require('./core/hub-assistant/podcast/script'), voice = require('./core/hub-assistant/podcast/voice'), fl = require('./core/hub-assistant/fast-lane');
      return { extract: file => require('./core/hub-assistant/podcast/extract').extract(file, { electron }),
        writers: [sc.claudeWriter({ cwd: getHubDataDir() }), sc.qwenWriter({ source: () => fl.fastLaneSources({ dataDir: getHubDataDir(), safeStorage: electron.safeStorage }).find(s => s.via === 'token-plan') })],
        synthesize: (text, out) => voice.synthesize(text, out, { credentials: () => require('./core/hub-phone/voice').dashscopeCredentials({ dataDir: getHubDataDir(), safeStorage: electron.safeStorage }) }) }; })(),
    onWorkbenchChanged: () => { sendToRenderer('assistant:workbench-changed', {}); phoneService?.kick?.(); },
    onPodcastsChanged: () => { sendToRenderer('assistant:podcasts-changed', {}); phoneService?.kick?.(); },
    openPath: file => shell.openPath(file),
    getMeetings: () => meetingManager.getAllMeetings(),
    getDefaults: kind => require('./core/session-creation-defaults').creationDefaults(kind, getHubConfig()),
    resumeSession: async (id, _launchOptions, overrides) => {
      const meta = require('./core/session-store').loadSessionFile(id, { strict: true });
      // overrides：助理切换模型时，休眠中的助理直接按新模型恢复，避免先按旧模型启动再重启。
      return meta ? resumeSession({ ...meta, ...(overrides ? { launchOverrides: overrides } : {}), hubId: id }) : null;
    },
    restartSession: (id, overrides) => sessionOperations.restartSession(id, overrides),
    retireSession: async id => {
      const session = sessionManager.getSession(id);
      if (!session) return;
      const title = String(session.title || 'AI Hub 助理').replace(/（已换班）$/, '') + '（已换班）';
      const updated = sessionManager.updateSessionMeta(id, { title });
      if (updated) sessionStore.markDirty(id, updated);
      return sessionManager.closeSessionRecoverably(id, { reason: 'assistant-rotated' });
    },
    onAssistantRotated: event => sendToRenderer('assistant:rotated', event),
    onFrontDeskChanged: frontDesk => { sendToRenderer('assistant:front-desk', frontDesk); phoneService?.kick?.(); },
    onDialogEntry: entry => sendToRenderer('assistant:dialog', entry),
    onAssistantTurnComplete: () => { phoneService?.kick?.(); setTimeout(() => phoneService?.kick?.(), 1200); },
  });
  assistantService.startWatching();
  phoneService = require('./main/ipc/phone-handlers').registerPhoneIpc(ipcMain, assistantService, {dataDir:getHubDataDir(),electron:require('electron')});
} catch (error) { console.error('[assistant] service unavailable:', error.message); }
// 助理服务没起（公司版发行目标关掉了助理）时，会话卡片照样会来取「手机发过的原文」：给一个空答复，
// 不让主进程每打开一个会话就报一次「No handler registered」（2026-11-28 黄区真机日志）。
if (!phoneService) {
  try { ipcMain.handle('assistant:phone-session-prompts', () => []); }
  catch (error) { console.warn('[phone] session prompts handler:', error.message); }
}
let appUpdateControllerRef = null;
function companyHubAdmin() { return null; }
// 公司版「助理」（2026-10-16）：每日简报 + 对话 + 6 条提醒，只读 WeLink，数据只留在本机 Hub 数据目录。
let companyAssistantService = null, askAsideService = null;
let avatarService = null;
// 会议正本合并落盘（core/company-assistant/meeting.js）：正常收尾在 close() 里已刷盘；这里兜底没走完正常收尾的退出，把内存里还没写下的会议同步写盘。
app.on('will-quit', () => { try { companyAssistantService?.meetings?.flush({ force: true }); } catch (_) { /* 退出时写不了就算了，下次启动按 .tmp/.bak 恢复 */ } });
const teamAccess = { assert() { throw new Error('该功能未启用'); } };
// 可选功能（2026-10-30，core/optional-features.js）：助理、论坛、桌宠默认关，设置菜单「可选功能」与各自页面里开关。
// 关着时助理、论坛的服务照样建好（页面能显示「未开启」和开关），但不调 start()，后台不取数、不开窗口。
const optionalFeatures = require('./core/optional-features').createOptionalFeatures({
  dataDir: getHubDataDir(),
  defaults: process.env.CLAUDE_HUB_DATA_DIR ? { assistant: process.env.CLAUDE_HUB_COMPANY_ASSISTANT === '1', forum: process.env.CLAUDE_HUB_COMPANY_FORUM === '1', attendance: process.env.CLAUDE_HUB_COMPANY_ATTENDANCE === '1', w3: process.env.CLAUDE_HUB_COMPANY_W3 === '1' } : {},
  // 低开销模式（2026-11-23）：正式实例判定新装 / 升级；隔离测试实例按老行为，测新装路径时设 CLAUDE_HUB_E2E_FRESH_INSTALL=1。
  detectFreshInstall: !isIsolatedHub() || process.env.CLAUDE_HUB_E2E_FRESH_INSTALL === '1',
});
require('./core/optional-features').registerActive(optionalFeatures);
console.log(`[low-overhead] 判定=${optionalFeatures.installKind()} 低开销模式=${optionalFeatures.lowOverhead() ? '开' : '关'}`);
// 关窗口最小化到托盘（2026-11-12）：开关也放「可选功能」，默认关。
var trayController = null;
// 社区统计（2026-11-24，main/community-service.js）：发送端与收件机本机的存储，下面建好后填进来。
var communityServiceRef = null, communityHostRef = null, communityBoardAbort = () => {};
// 界面语言（2026-11-20）：默认中文，设置里选 English 才切英文；对话框/菜单/托盘/通知统一按词典翻译（main/i18n-main.js）。
try {
  require('./main/i18n-main').installMainI18n({
    electron: require('electron'), ipcMain,
    hubConfig: require('./core/hub-config'),
    getWindows: () => BrowserWindow.getAllWindows(),
    onChange: () => { try { trayController && trayController.refresh && trayController.refresh(); } catch (_) {} },
  });
} catch (error) { console.warn('[i18n] setup failed:', error && error.message); }
try {
  trayController = require('./main/tray-controller').createTrayController({
    Tray, Menu,
    getIcon: () => getHubWindowIcon(),
    getMainWindow: () => mainWindow,
    focusWindow: () => focusPrimaryWindow(),
    quit: () => app.quit(),
    isEnabled: () => optionalFeatures.get('tray') && !keepIsolatedE2EWindowHidden(),
    canNotify: () => desktopNoticesAllowed(),
    // 首次点关闭时问「最小化到托盘 / 退出」（2026-11-21）。隔离测试实例默认不问（关窗口要直接走退出），
    // 专测这个选择框时设 CLAUDE_HUB_CLOSE_PROMPT=1。
    closeChoice: {
      pending: () => optionalFeatures.closePromptPending()
        && (process.env.CLAUDE_HUB_CLOSE_PROMPT === '1' || (!process.env.CLAUDE_HUB_E2E_WINDOW_MODE && process.env.CLAUDE_HUB_E2E !== '1')),
      ask: win => {
        const tc = require('./main/tray-controller');
        // 隔离测试实例不弹原生框：按 CLAUDE_HUB_CLOSE_PROMPT_ANSWER（逗号分隔，依次用）作答。
        if (process.env.CLAUDE_HUB_E2E_WINDOW_MODE && process.env.CLAUDE_HUB_CLOSE_PROMPT_ANSWER) {
          const answers = process.env.CLAUDE_HUB_CLOSE_PROMPT_ANSWER.split(',');
          process.env.CLAUDE_HUB_CLOSE_PROMPT_ANSWER = answers.slice(1).join(',');
          return ['tray', 'quit', 'cancel'].includes(answers[0]) ? answers[0] : 'cancel';
        }
        return tc.closeChoiceFromButton(dialog.showMessageBoxSync(win, tc.closeChoiceDialogOptions()));
      },
      remember: tray => optionalFeatures.rememberCloseChoice(tray),
    },
    title: 'AI Hub',
  });
} catch (error) { console.warn('[tray] setup failed:', error && error.message); }
function optionalFeatureList() {
  const { CATALOG } = require('./core/optional-features');
  const out = [];
  if (companyAssistantService) out.push({ id: 'assistant', ...CATALOG.assistant, on: optionalFeatures.get('assistant'), navHidden: optionalFeatures.navHidden('assistant') });
  if (companyForumService) out.push({ id: 'forum', ...CATALOG.forum, on: optionalFeatures.get('forum'), navHidden: optionalFeatures.navHidden('forum') });
  if (companyAttendanceService) out.push({ id: 'attendance', ...CATALOG.attendance, on: optionalFeatures.get('attendance'), navHidden: optionalFeatures.navHidden('attendance') });
  if (companyW3Service) out.push({ id: 'w3', ...CATALOG.w3, on: optionalFeatures.get('w3'), navHidden: optionalFeatures.navHidden('w3') });
  if (companyAssistantService?.rooms) out.push({ id: 'rooms', ...CATALOG.rooms, on: optionalFeatures.get('rooms'), navHidden: optionalFeatures.navHidden('rooms') });
  if (hubPetController && require('./core/distribution').featureEnabled('hubPet')) out.push({ id: 'pet', ...CATALOG.pet, on: !!hubPetController.getSettings().enabled });
  // 低开销模式新纳入开关的三项（2026-11-23）：底栏读数、搜索索引所有版本都有；额度刷新只在有 CodeAgent 的版本出现。
  out.push({ id: 'liveMeter', ...CATALOG.liveMeter, on: optionalFeatures.get('liveMeter') });
  out.push({ id: 'searchIndex', ...CATALOG.searchIndex, on: optionalFeatures.get('searchIndex') });
  if (require('./core/distribution').kindAllowed('codeagent')) out.push({ id: 'quotaRefresh', ...CATALOG.quotaRefresh, on: optionalFeatures.get('quotaRefresh') });
  // 社区统计不在可选功能里列出（2026-11-24）：开关在设置 › 高级 › 隐私 的「纯离线模式」，走 community:set-enabled。
  if (trayController) out.push({ id: 'tray', ...CATALOG.tray, on: optionalFeatures.get('tray') });
  out.push({ id: 'multiOpen', ...CATALOG.multiOpen, on: optionalFeatures.get('multiOpen') });
  const { BACKGROUND_IDS } = require('./core/optional-features');
  for (const item of out) item.background = BACKGROUND_IDS.includes(item.id);
  return out;
}
// enabled 与 on 同值（P1 的界面读 enabled）；keepAlive＝开着时保活几个会话（1–3，默认 2）。
function lowOverheadState() {
  const on = optionalFeatures.lowOverhead();
  return { on, enabled: on, keepAlive: optionalFeatures.lowOverheadKeepAlive(), hintPending: optionalFeatures.lowOverheadHintPending(), installKind: optionalFeatures.installKind() };
}
function broadcastOptionalFeatures() {
  const list = optionalFeatureList();
  sendToRenderer('optional-features:changed', list);
  sendToRenderer('low-overhead:changed', lowOverheadState());
  return list;
}
ipcMain.handle('optional-features:list', () => optionalFeatureList());
// CodeAgent 自己的完成提醒（反馈 1ce04c14；11-20 改三档）：默认 auto＝Hub 回执或桌宠在提醒时关掉 CodeAgent 自己的，可改回。
function codeagentCliNotifyReply() {
  const m = require('./core/codeagent-cli-notify');
  return { ok: true, available: require('./core/distribution').kindAllowed('codeagent'), ...m.state() };
}
ipcMain.handle('codeagent-cli-notify:get', () => { try { return codeagentCliNotifyReply(); } catch (error) { return { ok: false, error: error.message }; } });
ipcMain.handle('codeagent-cli-notify:set', (_event, request = {}) => {
  try { require('./core/codeagent-cli-notify').setMode(String(request.mode || '')); return codeagentCliNotifyReply(); }
  catch (error) { return { ok: false, error: error.message }; }
});
// 开或关一项可选功能 / 后台功能，并让它当场生效。单项开关和低开销模式总开关共用；做不到时抛出原因（界面原样显示）。
async function applyOptionalFeature(id, on) {
    if (id === 'liveMeter' || id === 'quotaRefresh') {
      // 底栏读数下一次心跳（5 秒内）按新开关取数；额度刷新下一轮按新开关决定跑不跑。
      optionalFeatures.set(id, on);
    } else if (id === 'searchIndex') {
      optionalFeatures.set('searchIndex', on);
      if (on) startSessionSearchBackground(); else sessionSearchService.stopMaintenance();
    } else if (id === 'pet') {
      if (!hubPetController) throw new Error('这个版本没有桌宠');
      hubPetController.setSettings({ enabled: on });
    } else if (id === 'assistant' && companyAssistantService) {
      if (!on && !companyAssistantService.canPause()) throw new Error('有会议正在采集，先在助理页结束会议再关');
      optionalFeatures.set('assistant', on);
      if (on) companyAssistantService.start(); else companyAssistantService.pause();
    } else if (id === 'forum' && companyForumService) {
      optionalFeatures.set('forum', on);
      if (on) companyForumService.start(); else companyForumService.close();
    } else if (id === 'attendance' && companyAttendanceService) {
      optionalFeatures.set('attendance', on);
      if (on) companyAttendanceService.start(); else companyAttendanceService.close();
    } else if (id === 'w3' && companyW3Service) {
      optionalFeatures.set('w3', on);
      // 刚开启就取一次，用户不用等到下一个时刻才看到内容。
      if (on) { companyW3Service.start(); void companyW3Service.sync({ reason: 'enable' }).catch(() => {}); } else companyW3Service.close();
    } else if (id === 'rooms' && companyAssistantService?.rooms) {
      const rooms = companyAssistantService.rooms;
      if (!on) { const why = rooms.offBlocker(); if (why) throw new Error(why); }
      if (on) { optionalFeatures.set('rooms', true); rooms.setEnabled(true); rooms.start(); }
      else {
        // 先停轮询、结束组件，成功了才记成关闭；结束失败就恢复原样并告诉用户，不留「显示已关、组件还在」的状态。
        try { await rooms.shutdown(); }
        catch (error) { rooms.setEnabled(true); rooms.start(); throw new Error('会议室组件没能结束，开关保持开启：' + error.message); }
        optionalFeatures.set('rooms', false);
      }
    } else if (id === 'tray' && trayController) {
      optionalFeatures.set('tray', on);
      trayController.sync();
    } else if (id === 'multiOpen') {
      optionalFeatures.set('multiOpen', on);
    } else if (id === 'community' && communityServiceRef) {
      // 关掉立即停发；打开后首次心跳仍随机等 2–6 分钟。
      optionalFeatures.set('community', on);
      communityServiceRef.client.setEnabled(on);
    } else throw new Error('这个版本没有这项功能');
}
ipcMain.handle('optional-features:set', async (_event, request = {}) => {
  try {
    await applyOptionalFeature(String(request.id || ''), request.on === true);
    return { ok: true, list: broadcastOptionalFeatures(), lowOverhead: lowOverheadState() };
  } catch (error) { return { ok: false, error: error.message }; }
});
// 低开销模式总开关（2026-11-23）：开＝逐项关掉所有开着的后台功能（关不掉的如实列出原因）；
// 关＝恢复底栏读数、搜索索引、额度刷新这三项老行为，助理等可选功能保持原样。
ipcMain.handle('low-overhead:state', () => ({ ok: true, ...lowOverheadState() }));
// 请求 { on?, enabled?, keepAlive? }（2026-11-23 P1 v2）：只带 keepAlive 时只改保活数、不动模式；
// 带 on / enabled 时先按原逻辑切模式，再让会话与运行期节能（L1–L6）跟上真值——partial 时模式没变，节能也不变。
ipcMain.handle('low-overhead:set', async (_event, request = {}) => {
  const req = request && typeof request === 'object' ? request : {};
  const wantOn = typeof req.on === 'boolean' ? req.on : typeof req.enabled === 'boolean' ? req.enabled : null;
  try {
    if (req.keepAlive != null) optionalFeatures.setLowOverheadKeepAlive(req.keepAlive);
    if (wantOn === null) {
      lowOverheadController?.sync();
      const state = lowOverheadState();
      sendToRenderer('low-overhead:changed', state);
      return { ok: true, partial: false, failed: [], message: '', ...state, lowOverhead: state };
    }
    // 逐项处理；有一项没处理成（例如会议室组件退不掉、会议正在采集）就不把模式记成已切换（core/optional-features.js）。
    const r = await require('./core/optional-features').switchLowOverhead({ features: optionalFeatures, list: optionalFeatureList(), apply: applyOptionalFeature, on: wantOn });
    console.log(`[low-overhead] ${wantOn ? '开启' : '关闭'}：处理 ${r.handled} 项${r.message ? '；' + r.message : ''}`);
    lowOverheadController?.sync();
    const list = broadcastOptionalFeatures();
    const state = lowOverheadState();
    return { ok: true, partial: r.partial, failed: r.failed, message: r.message, list, ...state, lowOverhead: state };
  } catch (error) {
    const state = lowOverheadState();
    return { ok: false, error: error && error.message ? error.message : String(error), ...state, lowOverhead: state };
  }
});
// 建窗前就按持久化真值初始化（Codex R2）：L4/L6/L3 立即按模式运行，界面任何时刻问 low-overhead:state 都是真值。
lowOverheadController = require('./main/low-overhead-controller.js').createLowOverheadController({
  getMode: () => ({ on: optionalFeatures.lowOverhead(), keepAlive: optionalFeatures.lowOverheadKeepAlive() }),
  sessionManager,
  stateStore,
  getSearchService: () => sessionSearchService,
  getPetController: () => hubPetController,
  getProtectedSessionIds: () => collectProtectedSessionIds({
    agentLeagueBridge, groupChatDispatcher, loopEngine: global.__loopEngine, meetingManager, studyBridge,
    getCompanyMeetings: () => companyAssistantService && companyAssistantService.meetings,
    getWelinkLinkedIds: () => welinkLinkDetector.linkedIds(),
  }),
  // 组队负责人与成员由组队流程自己休眠和唤醒，软上限不碰。
  isExemptSession: sessionId => !!(global.__teamService?.teamOfMember?.(sessionId) || global.__teamService?.teamOfLead?.(sessionId)),
  onSoftCapSuspend: ({ requested, keepAlive }) => {
    const names = requested.filter(r => !HUB_PET_ASSISTANT_PURPOSES.has(r.purpose)).map(r => `「${r.title || '未命名会话'}」`).join('、');
    if (names) sendToRenderer('session-notice', { level: 'info', message: `低开销模式：只保活最近 ${keepAlive} 个会话，已休眠 ${names}，点会话即可恢复、记录都在。` });
  },
  logger: console,
});
try { lowOverheadController.start(); }
catch (error) { console.warn('[low-overhead] start failed:', error && error.message); }
ipcMain.handle('low-overhead:dismiss-hint', () => { optionalFeatures.dismissLowOverheadHint(); sendToRenderer('low-overhead:changed', lowOverheadState()); return { ok: true }; });
// 「资源与后台」页的当前占用：只在页面开着时按需采样（两次采样之间才算得出 CPU），不常驻。
let resourceUsageInspector = null;
ipcMain.handle('resource-usage:snapshot', async (_event, options) => {
  try {
    // 定时刷新不 force（2026-11-25 R40b）：1 秒内的重复请求（两个窗口同时开着）复用同一次采样或搭正在跑的那一趟。
    // 首屏补读、切换开关后、点「刷新」要最新的（第二次采样才算得出 CPU），由页面传 force。
    if (!resourceUsageInspector) resourceUsageInspector = require('./core/process-inspector').createProcessInspector({ logger: console, ttlMs: 1000 });
    const snapshot = await resourceUsageInspector.snapshot({ force: options?.force === true });
    const attribution = require('./core/resource-attribution');
    const byPid = new Map();
    // 各窗口的渲染进程按页面地址归类：桌宠窗口归桌宠，公司网页的隐藏窗口归公司网页取数，其余算 Hub 本体。
    try {
      for (const wc of require('electron').webContents.getAllWebContents()) {
        const pid = wc.getOSProcessId?.();
        if (!pid) continue;
        const url = String(wc.getURL?.() || '');
        if (/hub-pet[\\/]/.test(url)) byPid.set(pid, 'pet');
        else if (/^https?:/i.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url)) byPid.set(pid, 'companyWeb');
      }
    } catch (_) {}
    const searchPid = sessionSearchService?._child?.pid;
    if (searchPid) byPid.set(Number(searchPid), 'searchIndex');
    try { const helper = companyAssistantService?.rooms?.helper?.(); if (helper?.pid) byPid.set(Number(helper.pid), 'rooms'); } catch (_) {}
    const rows = attribution.treeRows(snapshot, process.pid);
    // 会议室组件由 Hub 拉起后脱离了进程树（独立常驻）：登记过就单独补进来。
    for (const [pid, group] of byPid) if (group === 'rooms' && !rows.some(r => r.pid === pid) && snapshot.byPid.get(pid)) rows.push({ ...snapshot.byPid.get(pid), ppid: process.pid });
    const result = attribution.attribute(rows, { rootPid: process.pid, cpuWindowMs: snapshot.cpuWindowMs, cpuCount: snapshot.cpuCount,
      known: { byPid, exeName: path.basename(process.execPath).toLowerCase() } });
    return { ok: true, sampledAt: snapshot.sampledAt, ...result };
  } catch (error) { return { ok: false, error: error.message }; }
});
// 外部工具自动发现与多版本选择（2026-11-07，5.5.24）：CodeAgent 在这里注册，welink-cli / PPT Doctor 由公司助理注册。
let toolDiscovery = null;
try {
  const handlers = require('./main/ipc/tool-discovery-handlers');
  toolDiscovery = handlers.createHubToolDiscovery({ dataDir: getHubDataDir(), onChanged: tool => sendToRenderer('tool-discovery:changed', { tool }) });
  handlers.registerToolDiscoveryIpc(ipcMain, toolDiscovery);
} catch (error) { console.error('[tool-discovery] 自动发现未启动：', error.message); }
// 定位中心（2026-11-20，HUB-H 第一期）：各 CLI 唯一的查找入口。启动时先给上次的结论（peek），1.5 秒后在后台逐个试跑；
// 每 2 分钟只看路径在不在、每 10 分钟重读版本；结论变了推 harness:changed。CodeAgent 手动选的路径两边同步。
try {
  const harness = require('./core/harness-locator');
  const KIND = { dsh: 'deepseek-acp', antigravity: 'gemini' };
  const locator = harness.configure({ dataDir: getHubDataDir(), enabled: id => id === 'node' || require('./core/distribution').kindAllowed(KIND[id] || id) });
  locator.onManual = (id, file) => {
    if (id !== 'codeagent' || !toolDiscovery) return;
    try { toolDiscovery.store.setChoice('codeagent', file); require('./core/codeagent-config').setDiscoveredCommand(file || ''); } catch (_) {}
  };
  require('./main/ipc/harness-locator-handlers').registerHarnessLocatorIpc(ipcMain, { locator, send: sendToRenderer, installTool: harness.installTool, portDiagnosis: () => fallbackMessage(hookBinding) });
  locator.start();
} catch (error) { console.error('[harness-locator] 定位中心未启动：', error.message); }
// CodeAgent 一键安装 / 升级（2026-11-16）：没装或太旧时，界面上的「一键安装 / 一键升级」都走这里。
try { require('./main/ipc/codeagent-install-handlers').registerCodeAgentInstallIpc(ipcMain, { dataDir: getHubDataDir(), toolDiscovery, send: sendToRenderer }); }
catch (error) { console.error('[codeagent-install] 一键安装未启动：', error.message); }
try {
  if (require('./core/company-assistant/gate').companyAssistantEnabled()) {
    const { CompanyAssistant } = require('./core/company-assistant/service');
    const live = new (require('./core/hub-assistant/live-history').LiveHistory)();
    const loadMeta = id => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      const saved = require('./core/session-store').loadSessionFile(id, { strict: true });
      return saved ? { ...saved, id: saved.hubId || id } : null;
    };
    companyAssistantService = new CompanyAssistant({
      getMeetingAskAside: () => askAsideService,
      toolDiscovery,
      // PPT 工作目录跟随 Hub 工作根：只有生产实例注入，测试与隔离实例不读本机真实设置。
      pptHubRoots: () => require('./core/company-assistant/ppt-work-dir').liveHubRoots(),
      assertTeamAccess: () => teamAccess.assert(),
      dataDir: getHubDataDir(),
      noTimer: process.env.CLAUDE_HUB_ASSISTANT_TIMER === '0',
      isPetEnabled: () => hubPetController?.isActive() === true,
      isPetMcpEnabled: () => hubPetController?.getSettings().enabled === true,
      createSession: (kind, opts) => sessionOperations.createSession({ kind, opts }),
      closeSession: id => require('./core/company-ai-tasks').closeOwnedSession(sessionManager, id),
      renameSession: (id, title) => { const updated = sessionManager.updateSessionMeta(id, { title }); if (updated) { sessionStore.markDirty(id, updated); sendToRenderer('session-updated', { session: updated }); } },
      sendPrompt: (sessionId, text, clientSubmissionId) => promptOperations.submitPrompt(null, { sessionId, text, clientSubmissionId, waitForCliReady: true }),
      getSession: id => sessionManager.getSession(id),
      getSessionMetadata: loadMeta,
      resumeSession: async id => { const meta = require('./core/session-store').loadSessionFile(id, { strict: true }); return meta ? resumeSession({ ...meta, hubId: id }) : null; },
      // 「重开助理会话」走 Hub 现有的重启（休眠 → 按原会话恢复），恢复时重新经过 extraMcpProvider 挂会话工具。
      restartSession: id => sessionOperations.restartSession(id),
      // 只给隔离端到端测试：推迟会话工具接口开始监听，复现「会话先于接口建好」。
      ...(process.env.CLAUDE_HUB_E2E === '1' && process.env.CLAUDE_HUB_DATA_DIR && Number(process.env.CLAUDE_HUB_E2E_ASSISTANT_TOOLS_DELAY_MS) > 0
        ? { toolsStartDelayMs: Number(process.env.CLAUDE_HUB_E2E_ASSISTANT_TOOLS_DELAY_MS) } : {}),
      isAgentTurnActive: id => sessionManager.isAgentTurnActive(id),
      // 助理会话的 CodeAgent 进程退出了，这一问立刻报失败（审计 A3-17，以前要空等 12–24 分钟）。
      isSessionProcessAlive: id => sessionProcessAlive(id),
      // CodeAgent 的原生记录是 Claude 格式，按 Claude 读最终回答；会议伴侣也可能开在 Codex 上（2026-11-08），按 Codex 读。
      readFinals: meta => require('./core/feature-agent-finals').read(meta, sessionManager, live),
      // 自动档跟随个人账号明确保存且仍在清单内的默认模型；未配置时沿用会议评测排序。
      meetingDefaultEngine: () => {
        const personalDir = require('./core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
        return require('./core/company-assistant/meeting-engine').accountDefault({ dataDir: getHubDataDir(), personalDir });
      },
      // 会议伴侣能用的终端和模型（core/company-assistant/meeting-engine.js）：装了才列；公司版的 Claude Code / Codex 要设成「公司模型」才算接上。
      meetingTerminals: () => {
        const setup = require('./core/community-setup'), cfg = getHubConfig(), proxy = require('./core/company-model-proxy');
        // 走部门 API key（上游是网关）时列网关模型，不列公司模型（2026-11-26：以前一律列公司模型，选了也不是实际走的线路）。
        // 启动中心选的是自有接口 / 自有 API 账号时也列（2026-11-27：自有 API 用户和 CodeAgent 用户同样能选会议引擎），会话照启动中心的线路起。
        let raw = {};
        try { raw = require('./core/hub-config').readConfigJsonForUpdate(); } catch { raw = {}; }
        const ownList = kind => {
          const p = raw.providers?.[kind] || {};
          if (p.backend !== 'api') return null;
          const profile = p.selected_api_profile && (p.api_profiles || []).find(x => x.id === p.selected_api_profile);
          if (profile) return [{ id: profile.model || '', label: `自有 API · ${profile.label || profile.id} · ${profile.model || '默认模型'}` }];
          return p.base_url ? [{ id: p.model || '', label: `自有接口 · ${p.model || '接口默认模型'}` }] : null;
        };
        const viaConfig = (kind, backend, upstream) => cfg.companyCli === true ? (backend === 'proxy' ? (upstream === 'gateway'
          ? proxy.gatewayModelIds(getHubDataDir()).map(id => ({ id, label: `部门 API key · ${id}` })) : proxy.MODELS.map(m => ({ id: m.id, label: m.label }))) : ownList(kind)) : [{ id: '', label: '' }];
        const has = id => { try { return !!setup.findCommand(id); } catch { return false; } };
        return { codeagent: has('codeagent'), claude: has('claude') ? viaConfig('claude', cfg.claudeBackend, cfg.claudeUpstream) : null, codex: has('codex') ? viaConfig('codex', cfg.codexBackend, cfg.codexUpstream) : null };
      },
      nodeExecutable: process.execPath,
      onChanged: () => { sendToRenderer('company-assistant:changed', {}); avatarService?.onAuthChanged(); },
      // 手机对话（2026-10-18，core/company-assistant/phone.js 与 hub-tools.js）：助理用这些看会话、推进会话、卡住时替用户按键。
      getAllSessions: () => sessionManager.getAllSessions(),
      listKnownSessions: () => lastPersistedSessions.map(meta => ({ ...meta, id: meta.hubId || meta.id })),
      runningOverview: options => runningOverview?.get(options) || null,
      readTerminalScreen: id => {
        const entry = sessionManager.sessions?.get?.(id);
        const text = sessionManager.getSessionBuffer(id);
        if (text == null) return null;
        return { text, cols: Number(entry?.pty?.cols) || 120, rows: Number(entry?.pty?.rows) || 30, outputChars: entry?.outputChars };
      },
      sessionKeys: (id, data) => {
        if (!sessionManager.getSession(id)) throw new Error('会话未打开');
        if (sessionManager.getNativeSession?.(id) || sessionManager.getNativeClaude?.(id)) throw new Error('原生会话不支持终端按键');
        sessionManager.writeToSession(id, data);
      },
      // 与电脑上的停止键同一规则（renderer/pty-interrupt.js）：终端会话按 Esc。
      interruptSession: async id => {
        const session = sessionManager.getSession(id);
        if (!session) throw new Error('会话未打开');
        const native = sessionManager.getNativeSession?.(id) || sessionManager.getNativeCodex?.(id);
        if (native?.interrupt) { await native.interrupt(); return; }
        if (require('./core/ai-kinds').isCodeAgentKind(session.kind)) {
          const stopped = await require('./core/group-chat-watcher').codeAgentInputAction(id, 'stop');
          if (!stopped.ok) throw new Error(stopped.message);
          return stopped;
        }
        sessionManager.writeToSession(id, sessionManager.getNativeClaude?.(id) ? '\u0003' : '\x1b');
      },
      // 电脑前有没有人：键盘鼠标多少秒没动（「其他会话卡住」只在人不在电脑前时推到手机）。
      systemIdleSeconds: () => require('electron').powerMonitor.getSystemIdleTime(),
      // 会议室组件（77MB）第一次用时才下载：走 Electron 的网络栈，系统代理/PAC 才生效
      // （Node 内置 fetch 不读代理，公司网络里直连 GitHub 会 10 秒后失败；2026-09-23 实测）。
      roomFetch: (...args) => net.fetch(...args),
    });
    require('./core/company-assistant/notice-bus').noticeBus().on('notice', notice => {
      sendToRenderer('company-assistant:notice', notice);
      // 点通知打开助理页（页面认这个固定编号），不直接跳进会话。
      try { void desktopNotificationController?.show({ sessionId: 'company-assistant', title: notice.title, body: notice.text, kind: 'assistant', noticeKind: notice.kind,
        ...(notice.kind === 'digest' ? { noticeId: notice.id } : {}) }); } catch (error) { console.warn('[company-assistant] notification', error.message); }
    });
    // WeLink 命令行续期时先请员工助手代办免密登录（auth-keeper.renewViaWeclaw）；没装员工助手不发请求。
    companyAssistantService.weclaw = companyWeclawFetch();
    companyAssistantService.startTools();
    // 会议室可在「可选功能」里关（默认开，2026-11-19）：关着时不轮询、不拉起会议室组件。
    companyAssistantService.rooms.setEnabled(optionalFeatures.get('rooms'));
    companyAssistantService.rooms.start();
    // start 失败（例如磁盘满）不能连带让下面的 IPC 注册落空，否则助理、会议、会议室、PPT 页全部不可用。
    if (optionalFeatures.get('assistant')) { try { companyAssistantService.start(); } catch (error) { console.error('[company-assistant] 启动出错，继续注册接口：', error && error.message); } }
    else companyAssistantService.paused = true; // 关着冷启动：预开、起会话按关着守住（R66 审查 P2-1）
    const bridgeMcpPlan = sessionManager.extraMcpProvider;
    // WeLink 私聊助理：系统睡眠唤醒、锁屏解锁时立即重连（睡过觉的长连接多半已断，不等 5 分钟收包超时）。没绑定或没开时 wake 什么都不做。
    // powerMonitor 要在 app ready 之后才能用；挂监听出错也不能影响后面的助理接口注册。
    app.whenReady().then(() => {
      try { for (const event of ['resume', 'unlock-screen']) powerMonitor.on(event, () => { try { companyAssistantService?.bot?.wake?.(event); } catch (error) { console.warn('[welink-bot] wake:', error && error.message); } }); }
      catch (error) { console.warn('[welink-bot] powerMonitor 监听没挂上：', error && error.message); }
    }).catch(() => {});
    sessionManager.setExtraMcpProvider(request => companyAssistantService.sessionPlan(request)
      || companyAssistantService.tools.petSessionPlan(request, bridgeMcpPlan ? bridgeMcpPlan(request) : null));
    require('./main/ipc/company-assistant-handlers').registerCompanyAssistantIpc(ipcMain, companyAssistantService);
  }
} catch (error) { console.error('[company-assistant] 公司助理未启动：', error.message); }
try {
  const enabled = require('./core/distribution').target === 'company' || !!companyAssistantService;
  const blackboard = enabled ? (companyAssistantService?.blackboard || require('./core/company-assistant/welink-blackboard').sharedBlackboard()) : null;
  const registration = require('./main/ipc/welink-blackboard-handlers').registerWelinkBlackboardIpc(ipcMain, { getService: () => companyAssistantService, blackboard, enabled, sendToRenderer });
  app.on('will-quit', () => registration.dispose());
} catch (error) { console.error('[welink-blackboard] 工作台未启动：', error.message); }
if (require('./core/company-ai-policy').companyOnly()) {
  const live = new (require('./core/hub-assistant/live-history').LiveHistory)();
  companyAiTasks = new (require('./core/company-ai-tasks').CompanyAiTasks)({
    dataDir:getHubDataDir(),
    createSession:(kind,opts)=>sessionOperations.createSession({kind,opts}),
    sendPrompt:(sessionId,text,clientSubmissionId)=>promptOperations.submitPrompt(null,{sessionId,text,clientSubmissionId,waitForCliReady:true}),
    lastFinal:id=>{
      const meta=sessionManager.getSession(id)||require('./core/session-store').loadSessionFile(id,{strict:true});
      return meta ? require('./core/feature-agent-finals').read({...meta,id},sessionManager,live).at(-1) || null : null;
    },
    getSession:id=>sessionManager.getSession(id),
    readTerminalScreen:id=>({text:sessionManager.getSessionBuffer(id)||''}),
    closeSession:id=>require('./core/company-ai-tasks').closeOwnedSession(sessionManager,id),
    onChanged:state=>sendToRenderer('company-ai:changed',state),
  });
  const earlierPlan=sessionManager.extraMcpProvider;
  sessionManager.setExtraMcpProvider(request=>companyAiTasks.sessionPlan(request)||(earlierPlan?earlierPlan(request):null));
}
// AI 网页会话（2026-10-25）：启动中心「AI 网页」打开各家官网，主区原生内嵌，侧栏「网页」分组。设计见 main/web-sessions.js。
let webSessions = null;
try {
  const electron = require('electron');
  webSessions = require('./main/web-sessions').createWebSessions({
    dataDir: getHubDataDir(), getWindow: () => mainWindow,
    WebContentsView: electron.WebContentsView, BrowserWindow, session: electron.session, shell, Menu, clipboard, app,
    getProxy: () => require('./core/hub-browser-routing').policy(getHubConfig().proxy),
    onChanged: state => sendToRenderer('web-sessions:changed', state),
  });
  require('./main/web-sessions').registerWebSessionsIpc(ipcMain, { web: webSessions, getWindow: () => mainWindow });
} catch (error) { console.error('[web-sessions] AI 网页未启动：', error.message); }
// 网页圆桌（2026-10-28）：用「AI 网页」里登录好的网页同题提问、互评、队长汇总。设计见 main/web-page-agent.js。
let webRoundtable = null;
if (webSessions) {
  try {
    webRoundtable = require('./main/web-page-agent').createWebRoundtable({
      dataDir: getHubDataDir(), web: webSessions,
      onChanged: state => sendToRenderer('web-roundtable:changed', state),
    });
    require('./main/web-page-agent').registerWebRoundtableIpc(ipcMain, { roundtable: webRoundtable, getWindow: () => mainWindow });
  } catch (error) { console.error('[web-roundtable] 网页圆桌未启动：', error.message); }
}
let companyWebAi = null;
// 分身 Beta（接替「替身」，2026-11-19 起公开版也带）：每个分身一个常驻 CodeAgent 会话，提醒和起草，本人点了才发；数据只在本机。
try {
  if (companyAssistantService) {
    const avatarIpc = require('./main/ipc/avatar-handlers');
    const avatarHistory = new (require('./core/hub-assistant/live-history').LiveHistory)();
    avatarService = new (require('./core/avatar/fleet').FleetService)({
      dataDir: getHubDataDir(), getAssistant: () => new Proxy(companyAssistantService, { get(target, key) { const value = target[key]; return key === 'welink' ? (args, opts = {}) => target.welink(args, { ...opts, caller: 'avatar' }) : typeof value === 'function' ? value.bind(target) : value; } }), runAi: runCompanyAi,
      createSession: (kind, opts) => sessionOperations.createSession({ kind, opts }),
      sendPrompt: (sessionId, text, clientSubmissionId) => promptOperations.submitPrompt(null, { sessionId, text, clientSubmissionId, waitForCliReady: true }),
      lastFinal: id => { const meta = sessionManager.getSession(id); return meta ? require('./core/feature-agent-finals').read({ ...meta, id }, sessionManager, avatarHistory).at(-1) || null : null; },
      readTerminalScreen: id => ({ text: sessionManager.getSessionBuffer(id) || '' }),
      screenError: id => codeagentScreenErrors.get(id) || null,
      // 被「外部模型管控 / 不在可信仓」拦下时，沿用本人在主页开过 CodeAgent 的公司代码仓库作启动目录（core/avatar/trusted-cwd.js）。
      findTrustedCwd: () => require('./core/avatar/trusted-cwd').findTrustedCwd([...sessionManager.getAllSessions(), ...(() => { try { return lastPersistedSessions; } catch { return []; } })()]),
      getSession: id => sessionManager.getSession(id),
      closeSession: id => require('./core/company-ai-tasks').closeOwnedSession(sessionManager, id),
      listBackends: () => avatarIpc.listAvatarBackends({ dataDir: getHubDataDir(), sessionManager }),
      onChanged: () => sendToRenderer('avatar:changed', {}),
    });
    avatarService.start();
    const earlierAvatarPlan = sessionManager.extraMcpProvider;
    sessionManager.setExtraMcpProvider(request => (request?.opts?.purpose === 'avatar-agent' ? {} : earlierAvatarPlan ? earlierAvatarPlan(request) : null));
  }
  require('./main/ipc/avatar-handlers').registerAvatarIpc(ipcMain, () => avatarService, { dialog: require('electron').dialog, getWindow: () => mainWindow });
} catch (error) { console.error('[avatar] 分身未启动：', error.message); }
// 蒸馏自己（2026-11-28）：分身页一键把本人 WeLink 消息蒸馏成本机画像，本人勾选后供助理、分身、桌宠、社区、PPT 使用。
let selfDistillService = null;
try {
  selfDistillService = require('./main/self-distill-service').createSelfDistillService({ dataDir: getHubDataDir(), getAssistant: () => companyAssistantService, sendToRenderer });
  selfDistillService.registerIpc(ipcMain);
  // 画像保存、开关、删除后桌宠立即换话，不等 5 分钟缓存过期。
  require('./main/self-distill-service').onChanged(() => { try { hubPetController?.selfLikeChanged?.(); } catch { /* 桌宠没开 */ } });
} catch (error) { console.error('[self-distill] 蒸馏自己未启动：', error.message); }
// 员工助手 Beta（2026-11-26）：一键把 HUB-H 公司模型接进员工助手（WeClaw Desktop），端口变了自动重写配置。只在公司版、Windows 上有。
let weclawLinkService = null;
try {
  if (getHubConfig().companyCli === true && process.platform === 'win32') {
    const companyModelProxy = require('./core/company-model-proxy');
    weclawLinkService = new (require('./main/weclaw-link-service').WeclawLinkService)({
      dataDir: getHubDataDir(), proxy: companyProxyService,
      readEndpoint: () => companyModelProxy.readEndpoint(getHubDataDir()),
      listModels: () => companyModelProxy.companyModels(getHubDataDir()),
      onChanged: () => sendToRenderer('weclaw:changed', {}),
      openPath: file => require('electron').shell.openPath(file),
      openExternal: url => require('electron').shell.openExternal(url),
    });
    weclawLinkService.start();
    app.on('will-quit', () => weclawLinkService?.stop());
  }
  require('./main/ipc/weclaw-link-handlers').registerWeclawLinkIpc(ipcMain, () => weclawLinkService);
} catch (error) { console.error('[weclaw-link] 员工助手接入未启动：', error.message); }
// 没装员工助手时一个请求都不发；测试把站点指到本机假站点时不用（除非显式给了 AI_HUB_WECLAW_BASE）；CLAUDE_HUB_WECLAW_FETCH=0 关掉。
function companyWeclawFetch(testEnvKey) {
  if (process.env.CLAUDE_HUB_WECLAW_FETCH === '0' || process.platform !== 'win32') return null;
  if (testEnvKey && process.env[testEnvKey] && !process.env.AI_HUB_WECLAW_BASE) return null;
  // 隔离测试（自带数据目录）默认不碰本机真实的员工助手（免得真去代办 WeLink 登录）；要测就显式给 AI_HUB_WECLAW_BASE 指到替身。
  if (process.env.CLAUDE_HUB_DATA_DIR && !process.env.AI_HUB_WECLAW_BASE) return null;
  try { return require('./core/weclaw-fetch').sharedWeclawFetch(); } catch { return null; }
}
// 公司版「帖子」（原「论坛」，2026-10-18；2026-11-12 加公司发文）：每天同步公司发文、稼先社区、心声社区并附 AI 摘要，数据只留在本机 Hub 数据目录。
// 只在公司版启用（core/company-forum/gate.js）。取数用 Hub 自己的隐藏浏览器窗口（main/company-forum-browser.js）。
let companyForumService = null, companyForumBrowser = null, companyForumEdge = null;
// 论坛、考勤、门户共用的登录体检（R60，2026-11-27）：登好、要登录时各记一行 cookie 个数与剩余有效期（不记名字和值），进一键反馈。
let companyLoginCheckInst = null;
function companyLoginCheck() { return (companyLoginCheckInst ||= require('./core/company-forum/cookie-health').createLoginCheck({ dataDir: getHubDataDir() })); }
try {
  if (require('./core/company-forum/gate').companyForumEnabled()) {
    const { CompanyForum } = require('./core/company-forum/service');
    const live = new (require('./core/hub-assistant/live-history').LiveHistory)();
    const loadMeta = id => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      const saved = require('./core/session-store').loadSessionFile(id, { strict: true });
      return saved ? { ...saved, id: saved.hubId || id } : null;
    };
    companyForumBrowser = require('./main/company-forum-browser').createForumBrowser({ BrowserWindow, BaseWindow, session: require('electron').session, loginCheck: companyLoginCheck() });
    // 取数先借本机 Edge 的登录状态（无头，不弹窗）：公司电脑上三个站点都能免密自动登录，不用再手动登录（2026-11-12）。
    // CLAUDE_HUB_FORUM_EDGE=0 关掉；测试把站点指到本机假站点时默认不用，=1 才用。
    companyForumEdge = process.env.CLAUDE_HUB_FORUM_EDGE === '0' || (process.env.CLAUDE_HUB_FORUM_SITES && process.env.CLAUDE_HUB_FORUM_EDGE !== '1') ? null
      : require('./main/company-edge-browser').createEdgeBrowser({ logger: console });
    // 退出可能被会议页否决（r38a），所以不在 before-quit 里关；真正退出时 will-quit 同步收掉无头 Edge（r38b），正常收尾里还有异步 close 兜底。
    if (companyForumEdge) app.on('will-quit', () => { try { companyForumEdge.closeSync(); } catch (_) {} });
    companyForumService = new CompanyForum({
      dataDir: getHubDataDir(),
      noTimer: process.env.CLAUDE_HUB_FORUM_TIMER === '0',
      browser: companyForumBrowser,
      edgeBrowser: companyForumEdge,
      weclaw: companyWeclawFetch('CLAUDE_HUB_FORUM_SITES'),
      // 公司发文上新交给提醒总线：开着桌宠时桌宠说，没开时右下角通知卡。
      publish: notice => require('./core/company-assistant/notice-bus').noticeBus().publish(notice),
      lookupEmail: () => companyAssistantService?.accountEmail?.() || '',
      // 站点域名默认取本人公司邮箱的域名：助理页已从 WeLink 账号读到并存在它的设置里。
      accountEmail: () => { try { return JSON.parse(require('fs').readFileSync(require('path').join(getHubDataDir(), 'company-assistant', 'settings.json'), 'utf8')).email || ''; } catch { return ''; } },
      createSession: (kind, opts) => sessionOperations.createSession({ kind, opts }),
      sendPrompt: (sessionId, text, clientSubmissionId) => promptOperations.submitPrompt(null, { sessionId, text, clientSubmissionId, waitForCliReady: true }),
      getSession: id => sessionManager.getSession(id),
      getSessionMetadata: loadMeta,
      resumeSession: async id => { const meta = require('./core/session-store').loadSessionFile(id, { strict: true }); return meta ? resumeSession({ ...meta, hubId: id }) : null; },
      isAgentTurnActive: id => sessionManager.isAgentTurnActive(id),
      readFinals: meta => require('./core/feature-agent-finals').read(meta, sessionManager, live),
      onChanged: () => sendToRenderer('company-forum:changed', {}),
      readTerminalScreen: id => ({ text: sessionManager.getSessionBuffer(id) || '' }),
      closeSession: id => require('./core/company-ai-tasks').closeOwnedSession(sessionManager, id),
    });
    if (optionalFeatures.get('forum')) companyForumService.start();
    require('./main/ipc/company-forum-handlers').registerCompanyForumIpc(ipcMain, companyForumService, { shell, browser: companyForumBrowser });
  }
} catch (error) { console.error('[company-forum] 论坛未启动：', error.message); }
// 公司版「考勤」（2026-11-07）：每天后台读一次自己的打卡记录（最近 8 天），按日期拼成完整历史，页面算加班与 80 小时红线。
// 默认关闭（可选功能 attendance），关着时不访问考勤系统。取数先用 Hub 的隐藏窗口（和论坛共用登录分区），拿不到再用无头 Edge。
let companyAttendanceService = null, companyAttendanceBrowser = null;
try {
  if (require('./core/company-attendance/gate').companyAttendanceEnabled()) {
    const { CompanyAttendance } = require('./core/company-attendance/service');
    companyAttendanceBrowser = companyForumBrowser || require('./main/company-forum-browser').createForumBrowser({ BrowserWindow, BaseWindow, session: require('electron').session, loginCheck: companyLoginCheck() });
    companyAttendanceService = new CompanyAttendance({
      dataDir: getHubDataDir(),
      noTimer: process.env.CLAUDE_HUB_ATTENDANCE_TIMER === '0',
      browser: companyAttendanceBrowser,
      weclaw: companyWeclawFetch('CLAUDE_HUB_ATTENDANCE_URL'),
      edgeCapture: process.env.CLAUDE_HUB_ATTENDANCE_EDGE === '0' ? null : opts => require('./main/company-attendance-edge').captureWithEdge(opts),
      // 公司域名自动找：助理设置邮箱 → 论坛设置 → 内置默认域名 → 现场问 WeLink 账号（core/company-domain.js）。
      lookupEmail: () => companyAssistantService?.accountEmail?.() || '',
      accountEmail: () => { try { return JSON.parse(require('fs').readFileSync(require('path').join(getHubDataDir(), 'company-assistant', 'settings.json'), 'utf8')).email || ''; } catch { return ''; } },
      onChanged: () => sendToRenderer('company-attendance:changed', {}),
      // 加班红线提醒交给提醒总线：开着桌宠时桌宠说，没开时右下角通知卡（2026-11-09）。
      publish: notice => require('./core/company-assistant/notice-bus').noticeBus().publish(notice),
    });
    if (optionalFeatures.get('attendance')) companyAttendanceService.start();
  }
} catch (error) { console.error('[company-attendance] 考勤未启动：', error.message); }
require('./main/ipc/company-attendance-handlers').registerCompanyAttendanceIpc(ipcMain, () => (optionalFeatures.get('attendance') ? companyAttendanceService : null));
// 「个人」页（2026-11-12）：名字自动认（WeLink 登录账号优先），等级与成就按使用量算，数据只留本机；升级和解锁成就时桌宠庆祝。
try {
  profileController = require('./main/profile-controller').createProfileController({
    ipcMain, tap: profileTap, dataDir: getHubDataDir(), sendToRenderer, transcriptTap, app,
    getAssistant: () => companyAssistantService,
    getPet: () => hubPetController,
    codeAccount: () => require('./core/codeagent-pool').readCredentials(require('./core/codeagent-config').resolveCodeAgentConfig().configDir).accountId || '',
  });
  if (require('./core/distribution').featureEnabled('hubPet')) profileController.profile.registerFeature('pet');
  profileController.start();
} catch (error) { console.error('[profile] 个人页未启动：', error.message); }
// 公司版「门户待办」（2026-11-12）：每天 3 次在后台用无头 Edge 读公司门户首页上自己的待办、申请和公司文件，
// 新待办和久拖的事交给提醒总线（桌宠或通知卡），助理经 portal_todo 工具查本机快照。默认关闭（可选功能 w3），关着时不访问门户。
let companyW3Service = null, companyW3Browser = null;
// 只给隔离测试用：登录页停留多久判「要登录」（默认 45 秒，压测缩短）；必须是非生产数据目录且在测试窗口模式下，生产实例改不了（审查 #3）。
const W3_TEST_GRACE_MS = HIDDEN_E2E_DATA_DIR_SAFE && process.env.CLAUDE_HUB_E2E_WINDOW_MODE && Number(process.env.CLAUDE_HUB_W3_LOGIN_GRACE_MS) > 0 ? Number(process.env.CLAUDE_HUB_W3_LOGIN_GRACE_MS) : 0;
function companyW3HubBrowser() {
  return companyForumBrowser || companyAttendanceBrowser
    || (companyW3Browser ||= require('./main/company-forum-browser').createForumBrowser({ BrowserWindow, BaseWindow, session: require('electron').session, loginCheck: companyLoginCheck() }));
}
try {
  if (require('./core/company-w3/gate').companyW3Enabled()) {
    const { CompanyW3 } = require('./core/company-w3/service');
    companyW3Service = new CompanyW3({
      dataDir: getHubDataDir(),
      noTimer: process.env.CLAUDE_HUB_W3_TIMER === '0',
      edgeRun: opts => require('./main/company-edge-capture').runInEdge(W3_TEST_GRACE_MS ? { ...opts, loginGraceMs: W3_TEST_GRACE_MS } : opts),
      // 备用路线（原路线停在登录页时用户主动点登录才启用）：Hub 自己的窗口和登录分区，和论坛、考勤共用一个窗口队列与登录窗口，
      // 不拉起浏览器进程；用到时才建（没开论坛、考勤的用户也只在点登录后才建）。
      hubRun: opts => companyW3HubBrowser().evaluate(opts),
      hubLogin: opts => companyW3HubBrowser().login(opts),
      ...(W3_TEST_GRACE_MS ? { hubLoginGraceMs: W3_TEST_GRACE_MS } : {}),
      onChanged: () => sendToRenderer('company-w3:changed', {}),
      publish: notice => require('./core/company-assistant/notice-bus').noticeBus().publish(notice),
    });
    require('./core/company-w3/shared').setPortal(() => (optionalFeatures.get('w3') ? companyW3Service : null));
    if (optionalFeatures.get('w3')) companyW3Service.start();
  }
} catch (error) { console.error('[company-w3] 门户待办未启动：', error.message); }
require('./main/ipc/company-w3-handlers').registerCompanyW3Ipc(ipcMain, () => (optionalFeatures.get('w3') ? companyW3Service : null));
// AI 编排模式（2026-10-04）：编排员通过 hub_orchestrator 工具驱动群聊与交付工作流。
try {
  global.__orchestrationService = require('./main/orchestration/service').createOrchestrationService({
    meetingManager, sessionManager, getHubDataDir, sendToRenderer, logger: console,
    getDispatcher: () => (__testHooks ? __testHooks.dispatcher : groupChatDispatcher),
    getDeliveryEngine: () => global.__deliveryEngine,
    getMembers: meeting => groupChatDispatcher.groupMembersForMeeting(meeting, { includeDormant: true }),
    addMeetingSubInternal,
    ensureMemberReady: (meeting, memberId) => global.__loopEngine?.ensureMemberReady(meeting, memberId),
    // 编排员处理成员故障：重启该成员的 CLI 会话（接着原会话历史）。
    restartSession: id => sessionOperations.restartSession(id),
    // 负责人 interrupt=true：把指示追加进成员正在进行的回合（与群聊插话同一提交闭环）。
    injectPrompt: createRunningInjector({
      sessionManager, transcriptTap, groupChatWatcher: groupChatDispatcher.getGroupChatWatcher(),
    }),
    getDefaults: kind => require('./core/session-creation-defaults').creationDefaults(kind, getHubConfig()),
  });
  require('./main/ipc/orchestration-handlers').registerOrchestrationIpc(ipcMain, () => global.__orchestrationService);
  global.__orchestrationService.start().catch(error => console.error('[orchestration] start failed:', error.message));
} catch (error) { console.error('[orchestration] service unavailable:', error.message); }
// 问一下（2026-11-04）：另起后台 codeagent --print --resume --fork-session 回答插问，不碰运行中的终端、不改原会话记录。
if (require('./core/distribution').featureEnabled('btwAsk')) try {
  const { createAskAsideService, registerAskAsideIpc } = require('./main/ask-aside/service');
  askAsideService = createAskAsideService({ sessionManager, getHubDataDir, sendToRenderer,
    getSessionMetadata: id => require('./core/session-store').loadSessionFile(id, { strict: true }) });
  registerAskAsideIpc(ipcMain, askAsideService);
  app.on('will-quit', () => { void askAsideService.dispose(); });
} catch (error) { console.error('[ask-aside] service unavailable:', error.message); }
// 问问 Hub（2026-11-19）：底栏答疑面板，照随包的《使用说明书》一次性后台问答，只读、不建会话（main/help-ask-service.js）。
try {
  const { createHelpAskService, registerHelpAskIpc } = require('./main/help-ask-service');
  const helpAskService = createHelpAskService({ getHubDataDir });
  registerHelpAskIpc(ipcMain, helpAskService);
  app.on('will-quit', () => { helpAskService.dispose(); });
} catch (error) { console.error('[help-ask] service unavailable:', error.message); }
// 负责人组队：用户在侧栏批准后创建 CodeAgent 成员，命令安装在当前用户数据目录。
if (require('./core/distribution').featureEnabled('leadTeam')) try {
  const teamCommand = path.join(getHubDataDir(), 'team', process.platform === 'win32' ? 'hub-team.cmd' : 'hub-team.sh');
  global.__teamService = require('./main/team/service').createTeamService({
    getHubDataDir, sessionManager, sendToRenderer, logger: console,
    createSession: request => sessionOperations.createSession(request),
    submitPrompt: (sessionId, text, options = {}) => promptOperations.submitPrompt(null, { sessionId, text, ...options, waitForCliReady: true, preserveInput: true }),
    reconcileTurn: require('./main/team/turn-reconcile').createTeamTurnReconciler({ sessionManager, transcriptTap }),
    injectPrompt: createRunningInjector({ sessionManager, transcriptTap, groupChatWatcher: groupChatDispatcher.getGroupChatWatcher() }),
    restartSession: id => sessionOperations.restartSession(id),
    listAccounts: () => require('./main/team/codeagent-accounts').listTeamAccounts({ dataDir: getHubDataDir(), sessionManager }),
    commandPath: () => teamCommand,
    // 2026-11-18：负责人招人默认按规则自动批准；设置里「负责人组队自动批准」（config team.autoApproveLeads=false）可关。
    getConfig: getHubConfig, autoApproveLeadsDefault: true,
    // 真休眠的会话不在运行表里：按侧栏登记区分「休眠可叫醒」与「用户已关闭」（与 wakeSession 同一判断）。
    isResumable: id => require('./main/team/wake').canWakeTeamSession(id, lastPersistedSessions, sessionManager.getSession(id)),
    // 返工匹配也覆盖真休眠：同一份侧栏记录提供目录、账号与上下文占用。
    getSessionMetadata: id => lastPersistedSessions.find(s => s.hubId === id) || null,
    // 收件人休眠时叫醒：只认侧栏登记为休眠的会话（用户关掉的会话不复活）。
    wakeSession: async id => {
      if (!require('./main/team/wake').canWakeTeamSession(id, lastPersistedSessions, sessionManager.getSession(id))) return false;
      const meta = require('./core/session-store').loadSessionFile(id, { strict: true });
      if (!meta) return false;
      await resumeSession({ ...meta, hubId: id });
      return true;
    },
  });
  require('./main/team/command-shim').writeTeamCommand(teamCommand, {
    nodeExecutable: process.versions.electron ? process.execPath : 'node', runAsNode: !!process.versions.electron,
    script: path.join(__dirname, 'scripts', 'hub-team.js'),
  });
  require('./main/ipc/team-handlers').registerTeamIpc(ipcMain, () => global.__teamService);
  global.__teamService.start();
} catch (error) { console.error('[team] service unavailable:', error.message); }
// 原生 Claude 额度看门狗。同样依赖 sendToPty 的 _deps，所以排在这之后。
claudeQuotaResume.start();
claudeAccountSwitch.start();
// 红线（2026-10-26）：专用出口账号的配置目录每分钟核对一次，被任何程序改回共享代理就立刻改回专线并留痕。
// 发行版关掉了多账号（features.accounts:false，公司版）时不起这两个定时器（2026-11-25 开销修复）：
// 那里配不出专用出口账号，核对只是每分钟同步重读全部会话运行目录，出口自查还要每 5 分钟经代理访问外网。
if (require('./core/distribution').featureEnabled('accounts')) {
  const guardLog = path.join(getHubDataDir(), 'claude-egress-guard.jsonl');
  // 2026-11-20：这份日志原来每 5 分钟每个账号记一行、从不切分（本机实测已 19 MB/13 万行）。
  // 现在出口自查只记状态变化；纠正事件照记；超过 4 MB 改名留一份旧的再重新开始。
  const appendGuardLog = (obj) => {
    try {
      try { if (fs.statSync(guardLog).size > 4 * 1024 * 1024) fs.renameSync(guardLog, guardLog + '.1'); } catch { /* 还没有文件 */ }
      fs.appendFileSync(guardLog, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n');
    } catch { /* 写日志失败不影响核对 */ }
  };
  const guard = () => {
    try {
      const tools = require('./core/claude-subscription-profiles'), config = getHubConfig();
      require('./core/claude-account-network').pinDedicatedAccountDirs({
        profiles: tools.normalizeProfiles(config.claudeSubscriptionProfiles).map(p => { try { return tools.resolveProfile(config, p.id); } catch { return p; } }),
        runtimeRoot: path.join(getHubDataDir(), 'claude-account-runtimes'),
        sharedEnv: (() => { try { return tools.sharedNetworkEnv(config); } catch { return null; } })(),
        onDrift: event => {
          console.warn('[claude-egress-guard]', JSON.stringify(event));
          appendGuardLog(event);
        },
      });
    } catch (error) { console.warn('[claude-egress-guard] ' + error.message); }
  };
  guard();
  setInterval(guard, 60_000).unref?.();
  // 专线出口 IP 每 5 分钟经专线自查一次；VPS 发现 IP 不符会直接断开专线，这里负责用系统通知告诉用户原因。
  const lastEgress = new Map();
  let egressRunning = false; // 上一轮还没查完（账号多、专线不通时每个要等 15 秒）就不叠一轮新的
  const egressCheck = async () => {
    if (egressRunning) return;
    egressRunning = true;
    try {
      const tools = require('./core/claude-subscription-profiles'), config = getHubConfig();
      const profiles = tools.normalizeProfiles(config.claudeSubscriptionProfiles).map(p => { try { return tools.resolveProfile(config, p.id); } catch { return p; } });
      const network = require('./core/claude-account-network');
      const results = await network.checkDedicatedEgress(profiles);
      // 共享出口（主账号、第二账号）没有写死的约定 IP：第一次查到的出口记为基准，之后变了就提醒。
      const sharedProxy = network.sharedRouteProxy((() => { try { return tools.sharedNetworkEnv(config).HTTPS_PROXY; } catch { return null; } })());
      if (sharedProxy) {
        const baselineFile = path.join(getHubDataDir(), 'claude-egress-baseline.json');
        let baseline = null; try { baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).shared; } catch {}
        const shared = await network.checkSharedEgress(sharedProxy, baseline);
        if (shared?.state === 'ok' && !baseline && shared.ip) {
          try { fs.writeFileSync(baselineFile, JSON.stringify({ shared: shared.ip, at: new Date().toISOString() }, null, 2)); } catch {}
        }
        if (shared) results.push(shared);
      }
      for (const r of results) {
        const previous = lastEgress.get(r.id); lastEgress.set(r.id, r.state);
        if (previous !== r.state) appendGuardLog({ egress: r });
        if (previous === r.state || (previous === undefined && r.state === 'ok')) continue;
        const body = r.state === 'mismatch' && r.id === 'shared' ? `出口 IP 变成了 ${r.ip}（原为 ${r.expected}）。请核对 Clash 的 17891 入口，确认前不要使用这两个账号。`
          : r.state === 'mismatch' ? `出口 IP 变成了 ${r.ip}（应为 ${r.expected}）。VPS 会自动断开这条专线，请勿继续使用该账号。`
          : r.state === 'unreachable' ? `专线连不上：可能是网络问题，也可能是 VPS 发现出口 IP 不符已断开。该账号会话会失败，不会改走其他线路。`
          : `专线已恢复，出口 IP ${r.ip}。`;
        if (desktopNoticesAllowed({ tone: r.state === 'ok' ? '' : 'bad' })) {
          try { new (require('electron').Notification)({ title: `Claude ${r.label}`, body }).show(); } catch {}
        }
        console.warn('[claude-egress-check]', r.id, r.state, r.ip || '');
      }
    } catch (error) { console.warn('[claude-egress-check] ' + error.message); }
    finally { egressRunning = false; }
  };
  setTimeout(egressCheck, 30_000).unref?.();
  setInterval(egressCheck, 5 * 60_000).unref?.();
}
try {
  tokenPlanFallback = require('./main/token-plan-fallback-controller').createTokenPlanFallbackController({
    sessionManager, getConfig: getHubConfig, dataDir: getHubDataDir(),
    restartSession: (id, overrides, options) => sessionOperations.restartSession(id, overrides, options),
    readUsage: () => refreshTokenPlanUsage(true),
    // DeepSeek on Claude Code 是 PTY 会话，改道 / 等待提示经这里推到界面。
    notify: (sessionId, message, noticeKind) => sendToRenderer('session-notice', { sessionId, message, level: 'warning', noticeKind }),
  });
  // 新建 / 恢复时就改道或等待（额度已知用完）的提示，由 session-manager 发出。
  sessionManager.on('session-notice', event => sendToRenderer('session-notice', event));
  // groupChatWatcher.sendToPty 发送前经它检查：套餐已用完就先把会话改道到 DeepSeek API。
  sessionManager.tokenPlanFallback = tokenPlanFallback;
} catch (error) { console.error('[token-plan-fallback] unavailable:', error.message); }
try {
  softCompact = require('./main/soft-compact-controller').createSoftCompactController({
    sessionManager,
    isBusy: sessionId => sessionManager.isAgentTurnActive?.(sessionId) || promptOperations.isAssistantSubmissionPending(sessionId),
    quotaPlan: sessionId => claudeQuotaPrecompact?.planFor(sessionId) || null,
    afterQuotaCompact: sessionId => claudeQuotaPrecompact?.afterCompact(sessionId),
    quotaSkipped: async sessionId => claudeQuotaPrecompact?.skippedMarker(sessionId) === true,
    notify: (sessionId, message, level, noticeKind) => sendToRenderer('session-notice', { sessionId, message, level, noticeKind }),
    // CodeAgent 的上下文占用只在屏幕右侧 Stats 面板上：PTY 缓冲经无界面 xterm 回放成当前一屏。
    readCodeAgentRows: async sessionId => {
      const entry = sessionManager.sessions?.get?.(sessionId);
      const text = sessionManager.getSessionBuffer(sessionId);
      if (text == null) return null;
      return require('./core/hub-phone/session-chat').renderRows({ text, cols: Number(entry?.pty?.cols) || 120, rows: Number(entry?.pty?.rows) || 30 });
    },
  });
  softCompact.start();
} catch (error) { console.error('[soft-compact] unavailable:', error.message); }
registerClaudeQuotaIpc(ipcMain, claudeQuotaResume);
require('./main/ipc/acp-handlers').registerAcpIpc(ipcMain, {sessionManager});

ipcMain.handle('debug:get-managed-launch-audit', (_event, request = {}) => {
  const sessionId = request && typeof request.sessionId === 'string' ? request.sessionId : null;
  const limit = request && Number.isInteger(Number(request.limit)) ? Number(request.limit) : 100;
  const persisted = inspectManagedLaunchAudit({ sessionId, limit });
  return {
    auditPath: managedLaunchAuditPath(),
    auditHealth: {
      exists: persisted.exists,
      malformedLines: persisted.malformedLines,
      readError: persisted.readError,
    },
    live: sessionManager.getManagedLaunchAudit(sessionId),
    persisted: persisted.records,
  };
});

registerWorkspaceIpc(ipcMain, {
  allowFallbackResume: process.env.HUB_WORKSPACE_E2E_ALLOW_FALLBACK_RESUME === '1',
  dialog,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  sendToRenderer,
  sessionManager,
  shell,
  resumeSession,
  workspaceMigrationSessionIds,
  workspaceService,
});

// --- Dormant session persistence ---
// On boot we read state.json; those entries become dormant (sidebar entries
// with no live PTY). User clicks dormant session → resume-session IPC spawns
// PTY with `claude --resume <ccSessionId>`.
//
// 2026-05-07 maintainer：boot 走 loadAndSelfHeal，扫 sessions/ + meetings/ 目录把孤儿
// 条目（state.json 已丢但 per-id JSON 仍在）合并回来。多 Hub 并发覆盖、
// state.json 损坏、外部清理工具误删这三类灾难都能自我修复。
// Hold the same short transaction as opening a session while boot repairs write.
// Active sessions in other Hubs remain read-only, including title migration.
const bootOwners = sessionManager._openOwners();
const bootState = bootOwners.editSessions([], () => stateStore.loadAndSelfHeal({
  sessionStore, meetingStore,
  canEditSession: session => !bootOwners.owner(session.hubId || session.id),
}));
// loadAndSelfHeal 内部已经把 cleanShutdown 翻成 false（运行中状态），
//   bootWasCleanShutdown 是它额外暴露的"原始盘上值"，告知是否上次优雅退出。
const bootWasClean = !!bootState.bootWasCleanShutdown;
let lastPersistedSessions = Array.isArray(bootState.sessions) ? bootState.sessions : [];
// 2026-07-29 三方审查（Kimi 发现）：healPersistedCwds 自 2026-05 引入以来只被 import、
// 从未调用——药一直在手边没吃。workspace 从 ~/Workspaces 迁到 C:\Workspace 之后，state.json
// 里存的还是旧路径，唤醒这类休眠会话会静默回落 Home（见 session-manager 的 cwdFellBack）。
// transcript 的 jsonl 头里存着 CLI 当时真正用过的 cwd；只有该目录现在仍真实存在时
// 才能用于自愈（归档复制不会改写 jsonl，里面也可能是已经失效的旧 scratch）。
//
// 注意适用范围：它靠 ccSessionId 定位 transcript，所以只覆盖 Claude / DeepSeek。
// Codex 有 rollout 元数据、Kimi 有 session_index 各自对账，回落留痕才是它们的兜底。
// healPersistedCwds 就地改内存对象；修正成功后用完整 boot snapshot 异步落盘，避免用户
// 什么都不操作就退出时修复丢失。不能传历史语义不明的局部 state，这里显式带齐
// meetings / immersiveByMeeting，和正常持久化路径保持同一数据面。
// 只对账「可疑」的那些，不全量扫：实测 920 条会话全量对账要 873 ms，而 Hub 启动链上
// 加一秒同步 IO 是这仓库的头号痛点，不值得。可疑 = ①cwd 已不存在（迁移遗留）
// ②cwd 正好是 Home（回落的落点，最可能是被静默改写的）。实测这两类合计只有个位数。
// healPersistedCwds 是就地改对象，传子集同样会改到 lastPersistedSessions 里的那批引用。
try {
  const homeDir = path.resolve(process.env.USERPROFILE || process.env.HOME || '.').toLowerCase();
  const suspect = lastPersistedSessions.filter(s => {
    if (!s || !s.ccSessionId || !s.cwd) return false;
    if (bootOwners.owner(s.hubId || s.id)) return false;
    if (path.resolve(s.cwd).toLowerCase() === homeDir) return true;
    try { return !fs.statSync(s.cwd).isDirectory(); } catch { return true; }
  });
  const cwdBefore = new Map(suspect.map(s => [s, s.cwd]));
  const healed = suspect.length ? healPersistedCwds(suspect) : 0;
  // R57 诊断：自愈改了 CodeAgent 会话的工作目录时记一行（续接时会按最新副本同步，见 core/transcript-resume-sync.js）。
  for (const s of suspect) {
    if (cwdBefore.get(s) === s.cwd) continue;
    // 恢复时会话存档会合并到恢复参数上（main/ipc/resume-session-handlers.js），只改 state.json 自愈就白做了：存档里的工作目录一并改掉。
    // 改回原目录后续接前会同步最新副本（core/transcript-resume-sync.js），不会接到旧记录。
    try {
      const saved = sessionStore.loadSessionFile(s.hubId || s.id, { strict: true });
      if (saved && saved.cwd !== s.cwd) sessionStore.saveSessionFile(s.hubId || s.id, { ...saved, cwd: s.cwd });
    } catch (error) { console.warn('[群聊] boot cwd 自愈写回会话存档失败：', error.message); }
    if (isCodeAgentKind(s.kind)) require('./core/transcript-resume-sync').appendResumeLog(getHubDataDir(), 'boot-cwd-healed',
      { session: String(s.hubId || s.id || '').slice(0, 8), requested: String(s.ccSessionId || '').slice(0, 8) });
  }
  if (healed > 0) {
    stateStore.save({
      version: 1,
      cleanShutdown: false,
      sessions: lastPersistedSessions,
      meetings: Array.isArray(bootState.meetings) ? bootState.meetings : [],
      immersiveByMeeting: (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
        ? bootState.immersiveByMeeting : {},
    });
    console.log(`[群聊] boot cwd 自愈：${suspect.length} 条可疑中修正 ${healed} 条（已排队持久化）`);
  }
} catch (error) {
  console.warn('[群聊] healPersistedCwds failed:', error && error.message);
}
// Card optimization Task 9（2026-05-01）— 沉浸/调试模式 per-meeting 状态（持久化）
//   key = meetingId，value = boolean（true=沉浸，false=调试）。
//   每个 stateStore.save 调用都把这份 dict 一起写回，避免被覆盖。
let _immersiveByMeeting = (bootState.immersiveByMeeting && typeof bootState.immersiveByMeeting === 'object')
  ? bootState.immersiveByMeeting : {};
const bootMeetings = Array.isArray(bootState.meetings) ? bootState.meetings : [];
const repairedMemberships = require('./core/session-meeting-membership.js')
  .restoreMissingMeetingIds(lastPersistedSessions.filter(s => !bootOwners.owner(s.hubId || s.id)), bootMeetings);
if (repairedMemberships.length) {
  console.info(`[sessions] restored ${repairedMemberships.length} missing meeting membership(s)`);
  for (const id of repairedMemberships) {
    try {
      bootOwners.editClosed(id, () => {
        const latest = sessionStore.loadSessionFile(id, { strict: true });
        const repaired = lastPersistedSessions.find(s => s.hubId === id);
        if (latest && repaired) sessionStore.saveSessionFile(id, { ...latest, meetingId: repaired.meetingId });
      });
    } catch (error) {
      if (error.code !== 'SESSION_OCCUPIED') console.warn('[sessions] membership repair failed:', error.message);
    }
  }
}
let lastPersistedMeetings = bootMeetings;
for (const m of bootMeetings) {
  meetingManager.restoreMeeting(m);
}
// Sidebar classification is presentation metadata, independent of cwd/runtime.
const sidebarFolderStore = require('./core/sidebar-folders').createSidebarFolderStore({ dataDir: getHubDataDir() });
const sidebarFolderEntityExists = key => {
  if (typeof key !== 'string') return false;
  const [type, id] = key.split(':');
  if (type === 'meeting') return !!meetingManager.getMeeting(id);
  return type === 'session' && (!!sessionManager.getSession(id) || lastPersistedSessions.some(s => (s.hubId || s.id) === id));
};
require('./main/ipc/sidebar-folders-handlers').registerSidebarFoldersIpc(ipcMain, {
  store: sidebarFolderStore,
  entityExists: sidebarFolderEntityExists,
  publish: state => sendToRenderer('sidebar-folders:changed', { state }),
});
// Manual archive (2026-11-28): no automatic archiving by default; the first read freezes what the old 1/3-day rule had archived.
const sidebarArchiveStore = require('./core/sidebar-archive').createSidebarArchiveStore({
  dataDir: getHubDataDir(),
  legacyItems: () => [
    ...lastPersistedSessions.map(s => ({ ...s, id: s.hubId || s.id })),
    ...meetingManager.getAllMeetings().map(m => ({ ...m, _isMeeting: true })),
  ],
});
require('./main/ipc/sidebar-archive-handlers').registerSidebarArchiveIpc(ipcMain, {
  store: sidebarArchiveStore,
  publish: state => sendToRenderer('sidebar-archive:changed', { state }),
});
void sidebarArchiveStore.prune(sidebarFolderEntityExists).catch(() => {});   // drop records of deleted sessions/meetings; no write when nothing is stale
// Remembered deleted-folder names of sessions/meetings that were deleted since: prune once at boot.
void sidebarFolderStore.list().then(state => {
  const stale = Object.keys(state.removed || {}).filter(key => !sidebarFolderEntityExists(key));
  if (stale.length) return sidebarFolderStore.forget(stale);
}).catch(() => {});
const { meetingMemberTitlePatch, createMeetingMemberTitleSync } = require('./core/meeting-member-titles');
meetingMemberTitleSync = createMeetingMemberTitleSync({
  getMeeting: id => meetingManager.getMeeting(id),
  readSession: id => sessionManager.getSession(id) || lastPersistedSessions.find(s => (s.hubId || s.id) === id),
  writeSession: id => {
    const live = sessionManager.getSession(id);
    if (live) {
      if (isSessionViewer(live)) return null;
      const current = sessionManager.getSession(id);
      const freshPatch = meetingMemberTitlePatch(current, meetingManager.getMeeting(current?.meetingId));
      if (!freshPatch) return null;
      const updated = sessionManager.updateSessionMeta(id, freshPatch);
      if (updated) sessionStore.markDirty(id, updated);
      return updated;
    }
    return bootOwners.editClosed(id, () => {
      const known = lastPersistedSessions.find(s => (s.hubId || s.id) === id);
      if (!known) return null;
      const stored = sessionStore.loadSessionFile(id, { strict: true }) || known;
      const freshPatch = meetingMemberTitlePatch(stored, meetingManager.getMeeting(stored.meetingId));
      if (!freshPatch) return null;
      sessionStore.saveSessionFile(id, { ...stored, ...freshPatch });
      Object.assign(known, freshPatch);
      return { ...known, id, status: 'dormant' };
    });
  },
  publish: sendToRenderer,
});
// Sidebar derives unopened history labels; only actual title/member changes or
// an opened session write metadata through the ownership-protected sync above.
for (const meeting of meetingManager.getAllMeetings()) meetingMemberTitleSync.rememberMeeting(meeting);
// 2026-09-28: one workflow engine. Idle legacy rooms move to the delivery
// engine once; rooms with a recent unfinished legacy task stay until it ends.
try { require('./core/delivery-migration').migrateAll({ meetingManager, dataDir: getHubDataDir(), logger: console }); }
catch (error) { console.error('[workflow-migration] failed:', error); }

registerMeetingTimelineIpc(ipcMain, {
  meetingManager,
  sendToRenderer,
});

function buildSessionSearchSnapshot() {
  const sessionsById = new Map();
  for (const session of lastPersistedSessions || []) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...session, hubId: String(id), status: 'dormant' });
  }
  for (const session of sessionManager.getAllSessions()) {
    const id = session && (session.hubId || session.id);
    if (id) sessionsById.set(String(id), { ...sessionsById.get(String(id)), ...session, hubId: String(id) });
  }
  return {
    sessions: [...sessionsById.values()],
    meetings: typeof meetingManager.getSearchMetadata === 'function'
      ? meetingManager.getSearchMetadata()
      : [],
  };
}

registerArchiveIpc(ipcMain, {
  searchService: sessionSearchService,
  getSearchSnapshot: buildSessionSearchSnapshot,
});
registerSessionReferenceIpc(ipcMain, {
  searchService: sessionSearchService,
  getSearchSnapshot: buildSessionSearchSnapshot,
  getMeeting: meetingId => meetingManager.getMeeting(meetingId),
  onResolved: (filePath, sessionId) => referenceHandoff.noteResolved(filePath, sessionId),
});
// Let the renderer and hook server finish their latency-sensitive boot path
// before the worker starts walking transcript directories. Querying search
// earlier still starts the same worker on demand and reports visible progress.
//
// 2026-09-19: five seconds landed squarely on the first prompt of a session —
// the walk covers ~17 GB of provider transcripts, and the user feels it as the
// window stalling just as they start typing. Nothing is lost by waiting: the
// title layer answers from renderer memory throughout, and an explicit search
// still starts the worker immediately.
const sessionSearchPrewarmDelayMs = Math.max(
  250,
  Number(process.env.HUB_SESSION_SEARCH_PREWARM_DELAY_MS) || 30_000,
);
// The first full walk is the one heavy piece of work Hub does on its own
// initiative, so it yields to the user rather than competing with them. A
// prompt just sent means the model is answering and the disk is busy; the walk
// waits for a gap. The wait is capped so a continuously busy Hub still gets its
// index built instead of deferring forever.
let lastPromptSubmittedAt = 0;
const SEARCH_IDLE_GAP_MS = Math.max(0, Number(process.env.HUB_SESSION_SEARCH_IDLE_GAP_MS) || 30_000);
const SEARCH_IDLE_MAX_WAIT_MS = Math.max(
  SEARCH_IDLE_GAP_MS,
  Number(process.env.HUB_SESSION_SEARCH_IDLE_MAX_WAIT_MS) || 5 * 60_000,
);
const delayMs = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
async function waitForSearchIdle() {
  const deadline = Date.now() + SEARCH_IDLE_MAX_WAIT_MS;
  for (;;) {
    const quietFor = Date.now() - lastPromptSubmittedAt;
    if (quietFor >= SEARCH_IDLE_GAP_MS || Date.now() >= deadline) return;
    await delayMs(Math.min(SEARCH_IDLE_GAP_MS - quietFor, 5_000, Math.max(0, deadline - Date.now())));
  }
}
// 第一次全量建索引之前先等电脑键鼠闲置（见 core/session-search-first-build.js）；建好过就直接返回。
async function waitForSearchFirstBuildIdle() {
  if (!sessionSearchService.backgroundHeld) return;
  searchEventLog('search-index-wait-idle', { idleSec: searchFirstBuildIdleSec });
  const waited = await searchFirstBuild.waitForUserIdle({
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    idleSec: searchFirstBuildIdleSec,
    delay: delayMs,
    shouldStop: () => !sessionSearchService.backgroundHeld,
  });
  searchEventLog('search-index-first-build-start', { waitedSec: Math.round(waited.waitedMs / 1000), idleSec: waited.idleSec, ...(waited.stopped ? { by: 'user-search' } : {}) });
  sessionSearchService.releaseBackground();
}
// 低开销模式（2026-11-23）：「后台会话搜索索引」关着时不预热、不监听、不跟着会话完成增量更新；
// 用户搜索时 search() 自带的刷新照样建索引。设置页里打开时调 startSessionSearchBackground() 当场接上。
let sessionSearchBackgroundStarting = false;
function startSessionSearchBackground() {
  if (sessionSearchBackgroundStarting) return;
  sessionSearchBackgroundStarting = true;
  void (async () => {
    await waitForSearchFirstBuildIdle();
    await waitForSearchIdle();
    if (!optionalFeatures.get('searchIndex')) return;
    sessionSearchService.startMaintenance(buildSessionSearchSnapshot);
  })().catch(error => {
    console.warn('[session-search] background maintenance failed:', error && error.message);
  }).finally(() => { sessionSearchBackgroundStarting = false; });
}
const sessionSearchPrewarmTimer = setTimeout(() => {
  if (optionalFeatures.get('searchIndex')) startSessionSearchBackground();
  else searchEventLog('search-index-background-off', {});
}, sessionSearchPrewarmDelayMs);
sessionSearchPrewarmTimer.unref?.();
// Persistent source watchers cover external CLI saves too. Semantic events
// coalesce into the same background queue; the engine owns the shared writer lease.
for (const event of ['turn-complete', 'prompt-submitted', 'turn-aborted', 'turn-error', 'session-bound']) {
  transcriptTap.on(event, payload => {
    if (optionalFeatures.get('searchIndex')) sessionSearchService.queueRefresh(buildSessionSearchSnapshot, payload?.hubSessionId || event);
  });
}
transcriptTap.on('prompt-submitted', () => { lastPromptSubmittedAt = Date.now(); });

// 2026-05-07：loadAndSelfHeal 内部已经写过一次 cleanShutdown=false 的快照，
//   这里不再重复写。原本的"flip flag immediately on boot"语义由 selfHeal 承担。

// 跟踪上一次 persist 的 hubId/meetingId 集合，用于 diff 出"用户主动移除"的条目。
//   stateStore.markRemovedSession 把 id 推到 state-store 的 removed set，
//   merge 时显式删除——不依赖"内存里没有 = 删了"，避免多 Hub 启动期间互相把对方
//   未感知到的条目抹掉。
let _lastPersistedSessionIds = new Set(lastPersistedSessions.map(s => s.hubId).filter(Boolean));
let _lastPersistedMeetingIds = new Set(bootMeetings.map(m => m && m.id).filter(Boolean));

registerPersistenceIpc(ipcMain, {
  sessionManager,
  bootWasClean,
  getLiveSession: id => sessionManager.getSession(id),
  getImmersiveByMeeting: () => _immersiveByMeeting,
  getLastPersistedMeetingIds: () => _lastPersistedMeetingIds,
  getLastPersistedMeetings: () => lastPersistedMeetings,
  getLastPersistedSessionIds: () => _lastPersistedSessionIds,
  getLastPersistedSessions: () => lastPersistedSessions,
  meetingManager,
  meetingStore,
  sessionStore,
  setLastPersistedMeetingIds: (ids) => { _lastPersistedMeetingIds = ids; },
  setLastPersistedMeetings: (meetings) => { lastPersistedMeetings = meetings; },
  setLastPersistedSessionIds: (ids) => { _lastPersistedSessionIds = ids; },
  setLastPersistedSessions: (sessions) => { lastPersistedSessions = sessions; },
  stateStore,
});

titleService = require('./main/session-title-service').createTitleService({
  sessionManager, meetingManager, sessionStore, meetingStore, stateStore, sendToRenderer,
  getLastPersistedSessions: () => lastPersistedSessions,
  setLastPersistedSessions: rows => { lastPersistedSessions = rows; _lastPersistedSessionIds = new Set(rows.map(row => row.hubId)); },
  getLastPersistedMeetings: () => lastPersistedMeetings,
  setLastPersistedMeetings: rows => { lastPersistedMeetings = rows; },
});
ipcMain.handle('session:rename-title', (_event, request) => titleService.rename(request));

registerResumeSessionIpc(ipcMain, { resumeSession });

const hubRestart = require('./main/ipc/hub-restart-handlers').registerHubRestartIpc(ipcMain, {
  app, sessionManager, meetingManager, sessionStore, stateStore, getHubDataDir,
  resumeSession, groupChatDispatcher, sendToRenderer, shutdown:beginGracefulHubShutdown, transcriptTap,
  relaunchHub: relaunchHubClean,
  flushState:clean => stateStore.saveForRestart({version:1,cleanShutdown:clean,
    sessions:lastPersistedSessions,meetings:meetingManager.getAllMeetings(),immersiveByMeeting:_immersiveByMeeting}),
});

const imageDir = path.join(getHubDataDir(), 'images');
registerAppUtilityIpc(ipcMain, {
  clipboard,
  crypto,
  fs,
  getHookPort: () => hookPort,
  portDiagnosis: () => fallbackMessage(hookBinding),
  getMainWindow: () => mainWindow,
  getNetworkEgressStatus: options => networkEgressMonitor.getStatus(options),
  acknowledgeNetworkEgressChange: () => networkEgressMonitor.acknowledgeForeignChange(),
  imageDir,
  path,
  app,
  vpnTrafficDir: path.join(getHubDataDir(), 'traffic'),
});

// 全机残留回收。多个 Hub 实例共用同一个数据目录，所以任何一个实例打开这张卡片
// 看到的都是「整台电脑」的情况，而不只是自己名下那点进程。
// v1 只读：出清单 + 生成可审阅的预演脚本，Hub 自己不杀任何进程。
registerProcessReclaimIpc(ipcMain, {
  getSessionManager: () => sessionManager,
  getDataDir: () => getHubDataDir(),
  logger: console,
});

// 底部状态条 CPU/内存/硬盘区点开的「释放内存」面板：按会话认领进程，结束残留或休眠空闲会话。
registerMemoryReleaseIpc(ipcMain, {
  app,
  appVersion: app.getVersion(),
  dataDir: getHubDataDir(),
  getSessionManager: () => sessionManager,
  getChildStatus: () => childLifecycle.status(),
  logger: console,
});
// R59 内存紧张就地提示：每分钟看一次整机内存，紧张时在会话栏和启动中心提示「几个闲着、约占多少」，一键休眠闲着的（main/memory-pressure-watch.js）。
const memoryPressureWatch = require('./main/memory-pressure-watch').createMemoryPressureWatch({
  getSessionManager: () => sessionManager,
  isLowOverheadOn: () => { try { return optionalFeatures.lowOverhead() === true; } catch { return false; } },
  send: payload => sendToRenderer('memory-pressure:changed', payload),
  // 受保护会话（同自动休眠与低开销软上限）+ 组队负责人与成员（组队流程自己休眠和唤醒）。
  getProtectedSessionIds: () => {
    const ids = collectProtectedSessionIds({
      agentLeagueBridge, groupChatDispatcher, loopEngine: global.__loopEngine, meetingManager, studyBridge,
      getCompanyMeetings: () => companyAssistantService && companyAssistantService.meetings,
      getWelinkLinkedIds: () => welinkLinkDetector.linkedIds(),
    });
    for (const [sid, s] of sessionManager?.sessions?.entries?.() || []) {
      if (s?.info?.hubTeamMember || global.__teamService?.teamOfMember?.(sid) || global.__teamService?.teamOfLead?.(sid)) ids.add(sid);
    }
    return ids;
  },
  // 只供隔离 E2E：AI_HUB_E2E_MEMORY_USAGE=0.91 假装整机内存占用 91%（不影响内存压力自动休眠，那边仍读真实值）。
  ...(process.env.CLAUDE_HUB_E2E === '1' && Number(process.env.AI_HUB_E2E_MEMORY_USAGE) > 0
    ? { osApi: { totalmem: () => require('os').totalmem(), freemem: () => require('os').totalmem() * (1 - Number(process.env.AI_HUB_E2E_MEMORY_USAGE)) } } : {}),
});
memoryPressureWatch.start();
ipcMain.handle('memory-pressure:state', async () => {
  try { return { ok: true, ...(await memoryPressureWatch.check({ measure: true })) }; } catch (error) { return { ok: false, error: error && error.message }; }
});
ipcMain.handle('memory-pressure:suspend-idle', async () => {
  try { return await memoryPressureWatch.suspendIdle(); } catch (error) { return { ok: false, error: error && error.message }; }
});
registerDesktopOrganizerIpc(ipcMain, { dataDir: getHubDataDir(), shell });
registerDiskReleaseIpc(ipcMain, {
  app,
  dataDir: getHubDataDir(),
});

// 驾驶舱 UI 删了，但这个服务还留着：工作台「最近文件」卡的 Git 变更来自它的 overview。
const workbenchOperationsService = createWorkbenchOperationsService({
  dataDir: getHubDataDir(),
  getConfig: getHubConfig,
});
registerWorkbenchOperationsIpc(ipcMain, {
  service: workbenchOperationsService,
  logger: console,
});

registerPathIpc(ipcMain);
ipcMain.handle('community:setup', () => require('./core/community-setup').inspectSetupAsync({ packaged: app.isPackaged }));
// 环境体检（5.5.24，main/ipc/env-check-handlers.js）：设置菜单「环境体检」一屏列出各外部工具与本机条件；各服务按需取，没有的项自动不出。
const firstRunEnvCheck = require('./main/ipc/env-check-handlers').registerEnvCheckIpc(ipcMain, {
  dataDir: getHubDataDir,
  send: (channel, state) => sendToRenderer(channel, state),
  version: () => require('./core/distribution').editionVersion || app.getVersion(),
  isCompany: () => require('./core/company-api-config').isCompany(),
  assistant: () => companyAssistantService,
  ...(require('./core/company-api-config').isCompany() ? {
    proxy: () => {
      let enabled = false;
      try { enabled = !!companyProxyService.isEnabled(); } catch { enabled = false; }
      return { enabled, status: lanPoolService.clientProxyStatus() || companyProxyService.status() };
    },
    proxyRestart: () => lanPoolService.client()?.enabled ? lanPoolService.snapshot({ force: true }) : companyProxyService.restart(),
  } : {}),
  ...(require('./core/distribution').updateConfig ? { appUpdate: () => appUpdateControllerRef } : {}),
  getConfig: () => require('./core/hub-config').getConfig(),
  locator: () => require('./core/harness-locator').get(),
  portDiagnosis: () => fallbackMessage(hookBinding),
  openExternal: url => shell.openExternal(url),
  openPath: dir => shell.openPath(dir),
  discoverAttendanceDomain: () => {
    const s = companyAttendanceService?.settings();
    return s?.domain ? { domain: s.domain, from: s.domainFrom } : require('./core/company-domain').knownDomain(getHubDataDir());
  },
  probeAttendancePage: async () => {
    const { probePage, attendanceFetch } = require('./core/app-update/canary-network');
    const domain = companyAttendanceService?.settings()?.domain || require('./core/company-domain').knownDomain(getHubDataDir()).domain;
    const url = require('./core/company-attendance/service').attendanceUrl(domain);
    return probePage(url, { fetchImpl: attendanceFetch(require('electron').session) });
  },
});
// 首次启动准备页（core/first-run-prep.js）：第一次把该查的查完存下，以后打开不用等。
require('./main/ipc/first-run-handlers').registerFirstRunIpc(ipcMain, {
  dataDir: getHubDataDir,
  isCompany: () => require('./core/company-api-config').isCompany(),
  send: (channel, event) => sendToRenderer(channel, event),
  envCheck: () => firstRunEnvCheck.run(),
  toolDiscovery: () => toolDiscovery,
  proxyService: companyProxyService,
  lanPool: () => lanPoolService,
  systemProxy: () => require('electron').session.defaultSession.resolveProxy('https://example.com/'),
  fetchImpl: (...args) => require('electron').net.fetch(...args),
});

// --- Hook HTTP server ---
// Receives POSTs from ~/.claude/scripts/session-hub-hook.py when Claude Code
// fires lifecycle hooks. Forwards compact observations to the renderer's
// RuntimeTruth reducer; the hook request never blocks on transcript parsing
// except for the final Stop preview fallback.
let hubAccountsService = null;
const hookServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // 社区版的 hook 由 PowerShell 原样转发 CLI 的载荷（scripts/session-hub-hook.ps1），
  // 字段提取在这里做（core/hook-payload.js），之后与 Python 版走同一条处理路径。
  const rawHookEvent = req.method === 'POST' && /^\/api\/hook-raw\/[a-z-]+$/.test(req.url)
    ? req.url.slice('/api/hook-raw/'.length) : null;
  if (rawHookEvent) req.url = '/api/hook/' + rawHookEvent;
  const isHook = req.method === 'POST' && req.url.startsWith('/api/hook/');
  const isStatus = req.method === 'POST' && req.url === '/api/status';
  const isTeam = req.method === 'POST' && req.url === '/api/team';
  const isNativeOwnership = req.method === 'POST' && req.url === '/api/native-ownership';
  const isResearchAccount = false;
  // 2026-05-16 maintainer：防卡死 — 外部 HTTP 救援入口，tools/hub-escape.ps1 调
  const isEscapeHome = req.method === 'POST' && req.url === '/api/escape-home';
  // 网页圆桌 MCP（core/web-roundtable）经这里用「AI 网页」的登录提问（2026-10-28）。令牌在 Hub 控制文件里，只有本机同一用户能读。
  const isWebAsk = req.method === 'POST' && ['/api/web-ask', '/api/web-ask-status', '/api/web-ask-collect'].includes(req.url);
  // 多开提示（core/hub-instance-prompt.js，2026-11-20）：后开的 Hub 问「你还在吗」（ping）、请求「切到前台」（focus）。令牌同控制文件。
  const isInstanceFocus = req.method === 'POST' && req.url === '/api/instance-focus';
  const isResearchFetch = false;
  // plan 2026-05-05 阶段 0: 群聊记忆 MCP 回调（loopback）。
  if (!isTeam && !isHook && !isStatus && !isResearchFetch && !isEscapeHome && !isNativeOwnership && !isResearchAccount && !isWebAsk && !isInstanceFocus) {
    res.writeHead(404); res.end('{}'); return;
  }

  // Cap body size at 16KB — statusline payloads are tiny, hooks tinier.
  // Raw hook payloads are untruncated CLI JSON (tool output included), so they
  // get a larger cap and are decoded once, after all chunks arrive.
  if (rawHookEvent && String(req.headers['x-hub-token'] || '') !== HOOK_TOKEN) {
    res.writeHead(403); res.end('{}'); req.resume(); return;
  }
  let body = '';
  const rawChunks = [];
  let rawBytes = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    if (rawHookEvent) {
      rawBytes += c.length;
      if (rawBytes > 8 * 1024 * 1024) { tooBig = true; return; }
      rawChunks.push(c);
      return;
    }
    // 网页提问的问题最长 12 万字，单独放宽到 1MB。
    if (body.length + c.length > (isWebAsk ? 1024 * 1024 : 16384)) { tooBig = true; return; }
    body += c;
  });
  req.on('end', async () => {
    if (tooBig) { res.writeHead(413); res.end('{}'); return; }
    let parsed;
    if (rawHookEvent) {
      parsed = require('./core/hook-payload').normalizeHookPayload(rawHookEvent, Buffer.concat(rawChunks), {
        sessionId: String(req.headers['x-hub-session'] || ''),
        token: String(req.headers['x-hub-token'] || ''),
        codexAccountAttempt: String(req.headers['x-hub-codex-account-attempt'] || ''),
      });
      if (!parsed) { res.writeHead(200); res.end('{}'); return; }
    } else {
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    }
    if (isTeam) {
      const response = await require('./main/team/route').handleTeamRequest({ parsed, hookToken: HOOK_TOKEN, teamTokenFor, service: global.__teamService });
      res.writeHead(response.statusCode); res.end(JSON.stringify(response.body));
      return;
    }
    if (isWebAsk) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      if (!webRoundtable) { res.writeHead(503); res.end(JSON.stringify({ error: 'AI 网页没有启动' })); return; }
      try {
        const result = req.url === '/api/web-ask' ? webRoundtable.askOne({ provider: String(parsed.provider || ''), prompt: parsed.prompt, url: String(parsed.url || ''), member: String(parsed.member || '') })
          : req.url === '/api/web-ask-collect' ? await webRoundtable.askCollect({ id: String(parsed.id || ''), force: parsed.force === true })
          : webRoundtable.askStatus({ id: String(parsed.id || '') });
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(e && e.code === 'WEB_OWNER' ? 409 : 400); res.end(JSON.stringify({ error: String((e && e.message) || e), code: e && e.code })); }
      return;
    }
    if (isNativeOwnership) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      // Main owns these identities. A restore must not wake every other
      // renderer or serialize its full session catalogue and prompt drafts.
      const sessions = [...sessionManager.sessions.values()].map(({info:s,pty}) => ({
        id:s.id, kind:s.kind, codexSid:s.codexSid, ccSessionId:s.ccSessionId, runtimeBackend:s.runtimeBackend,
        sharedRuntime:pty?.sharedRuntime===true,
      }));
      res.writeHead(200); res.end(JSON.stringify({ pid:process.pid, sessions })); return;
    }
    if (isInstanceFocus) {
      if (parsed.token !== HOOK_TOKEN) { res.writeHead(403); res.end('{}'); return; }
      // 正在退出（更新重启、远程重启的老进程还在收尾）不算「在运行」，后开的那个就不提示。
      const shuttingDown = shutdownDrainState !== 'idle' || !!shutdownDrainPromise;
      const startedAt = Math.round(Date.now() - process.uptime() * 1000);
      if (parsed.action === 'focus') {
        if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) {
          res.writeHead(503); res.end(JSON.stringify({ ok: false, shuttingDown, error: shuttingDown ? '这个 Hub 正在退出' : '窗口不在' })); return;
        }
        const focused = focusPrimaryWindow();
        // Windows 不让后台进程直接抢前台：短暂置顶一下再放开，窗口才会真的到最前，而不只是任务栏闪一下。
        try { if (focused && !keepIsolatedE2EWindowHidden()) { mainWindow.setAlwaysOnTop(true); mainWindow.moveTop(); mainWindow.focus(); setTimeout(() => { try { if (!mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); } catch (_) {} }, 300); } }
        catch (error) { console.warn('[multi-open] 置顶切换失败：', error && error.message); }
        console.log('[multi-open] 后开的 Hub 请求切到这里，已拉到前台');
        res.writeHead(200); res.end(JSON.stringify({ ok: !!focused, pid: process.pid, startedAt })); return;
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true, pid: process.pid, shuttingDown, startedAt })); return;
    }
    // 2026-05-16 maintainer：外部 HTTP 救援 — tools/hub-escape.ps1 调这条路由触发 escapeToHome()
    if (isEscapeHome) {
      if (parsed.token !== HOOK_TOKEN) {
        console.warn('[escape-home] 403 wrong token from', req.socket && req.socket.remoteAddress);
        res.writeHead(403); res.end('{}'); return;
      }
      // 检查 renderer 真的可达 — mainWindow.isDestroyed() 不够，renderer 进程 crash 时
      // webContents.send 会静默 drop。这种场景下回 503 让 ps1 提示"需手动重启 Hub"。
      const rendererReachable = mainWindow && !mainWindow.isDestroyed()
        && mainWindow.webContents && !mainWindow.webContents.isCrashed();
      if (!rendererReachable) {
        console.warn('[escape-home] renderer unreachable (destroyed or crashed) — endpoint returns 503');
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, pid: process.pid, error: 'renderer unreachable' }));
        return;
      }
      console.log('[escape-home] HTTP triggered');
      // 2026-05-17 maintainer：主 webContents 可能已被外部 URL navigate 走（renderer 跑的
      //   是远程网页，preload IPC 失效，sendToRenderer('escape-home') 收不到）。
      //   此时直接 loadFile 拉回 index.html — Hub 主进程没死，session 子进程没丢，
      //   只是 renderer 重新初始化从 state.json 恢复。
      const currentUrl = mainWindow.webContents.getURL();
      const navigatedAway = !currentUrl.startsWith('file:') || !currentUrl.includes('/renderer/index.html');
      if (navigatedAway) {
        console.warn('[escape-home] main webContents has been navigated to', currentUrl, '→ loadFile back to index.html');
        hangStackOptIn?.arm();
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, recovered: 'loadFile', from: currentUrl }));
        return;
      }
      sendToRenderer('escape-home');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    if (parsed.token !== HOOK_TOKEN) {
      res.writeHead(403); res.end('{}'); return;
    }
    const hookTargetSession = parsed.sessionId ? sessionManager.getSession(parsed.sessionId) : null;
    // Instruction receipts are observability only, never native turn authority.
    if(isHook && req.url==='/api/hook/instructions-loaded') {
      try {
        const accepted=await sessionManager.memoryService?.nativeEvidence.loaded(hookTargetSession,parsed);
        res.writeHead(accepted?200:202,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:!!accepted}));
      } catch(error) {console.error('[memory] instruction hook failed:',error);res.writeHead(500);res.end('{"error":"instruction-receipt-failed"}');}
      return;
    }
    if (isHook && hookTargetSession && isPtyCodexSession(hookTargetSession)) {
      let outcome;
      try { outcome = await handleCodexPtyHook(hookTargetSession, req.url.slice('/api/hook/'.length), parsed); }
      catch (error) {
        console.error('[codex hook] handling failed:', error);
        res.writeHead(500); res.end('{"error":"codex-hook-failed"}'); return;
      }
      res.writeHead(outcome && outcome.ignored ? 202 : 200); res.end(JSON.stringify(outcome || {})); return;
    }
    if (hookTargetSession && require('./core/codex-native-runtime').isCodexSession(hookTargetSession)) {
      res.writeHead(202); res.end('{"ignored":"codex-native-only"}'); return;
    }
    if (isHook && hookTargetSession?.runtimeBackend === 'claude-stream-json') {
      res.writeHead(202); res.end('{"ignored":"native-protocol-authority"}'); return;
    }
    if (parsed.sessionId && hookTargetSession) {
      if (isHook) {
        const event = req.url.slice('/api/hook/'.length);
        const eventAt = Date.now();
        let boundClaudeSessionId = String(hookTargetSession.ccSessionId || '');
        const incomingClaudeSessionId = String(parsed.claudeSessionId || '');
        if (!parsed.agentId) {
          const identityRejected = codeAgentIdentityRejection(parsed.sessionId, hookTargetSession, {
            ccSessionId: incomingClaudeSessionId, transcriptPath: parsed.transcriptPath,
          });
          if (identityRejected) {
            console.warn(`[codeagent hook] ignored ${identityRejected} for ${parsed.sessionId.slice(0, 8)} (${event})`);
            res.writeHead(202); res.end(JSON.stringify({ ignored: identityRejected })); return;
          }
        }
        let initialCwdMismatch = false;
        let initialTranscriptBucketMismatch = false;
        if (!boundClaudeSessionId && parsed.cwd && hookTargetSession.cwd) {
          try { initialCwdMismatch = !sameWorkDir(parsed.cwd, hookTargetSession.cwd); } catch {}
        }
        if (!boundClaudeSessionId && parsed.transcriptPath && hookTargetSession.cwd) {
          try { initialTranscriptBucketMismatch = !transcriptBucketMatches(parsed.transcriptPath, hookTargetSession.cwd); } catch {}
        }
        // 公司 Code Agent 不认 --session-id，Hub 启动时无法预定身份（core/codeagent-config.js）。
        // 待绑定期间（新建、分支、没有记录可恢复的重启），工作目录与记录所在目录都对得上的第一个
        // 顶层 hook 才能绑定；分支不接受父身份，编号必须与记录文件一致。绑定成功后再撤销 pending。
        // 子代理（agentId）和在会话里另起的 CLI（目录不同）不会被当成本人。
        if (hookTargetSession.codeagentIdentityPending === true && isCodeAgentKind(hookTargetSession.kind)
            && !parsed.agentId && incomingClaudeSessionId && hookTargetSession.cwd) {
          let sameCwd = false;
          let sameBucket = !parsed.transcriptPath;
          try { sameCwd = !parsed.cwd || sameWorkDir(parsed.cwd, hookTargetSession.cwd); } catch {}
          try { if (parsed.transcriptPath) sameBucket = transcriptBucketMatches(parsed.transcriptPath, hookTargetSession.cwd); } catch {}
          if (sameCwd && sameBucket) {
            const bound = updateSessionTranscriptBinding(parsed.sessionId, {
              ccSessionId: incomingClaudeSessionId, transcriptPath: parsed.transcriptPath, cwd: parsed.cwd,
              codeagentIdentityPending: false,
            });
            if (bound && bound.ccSessionId === incomingClaudeSessionId) {
              boundClaudeSessionId = incomingClaudeSessionId;
              console.log(`[codeagent hook] ${parsed.sessionId.slice(0, 8)} bound to CLI identity ${incomingClaudeSessionId.slice(0, 8)} (${event})`);
              logCodeAgentIdentity(hookTargetSession, 'identity-bound', { incoming: incomingClaudeSessionId.slice(0, 8), hook: event });
              if (parsed.transcriptPath) void transcriptTap.watchClaudeTranscript(parsed.sessionId, parsed.transcriptPath, { turnId: null, newTurn: false });
              if (event === 'session-start') { res.writeHead(200); res.end(JSON.stringify({ ok: true, identity: 'bound' })); return; }
            } else {
              sessionManager.updateSessionMeta(parsed.sessionId, { codeagentIdentityPending: true });
            }
          }
        }
        // PTY Claude 的身份生命周期：/clear、/resume、退出后重启都会换 session_id。
        // 只有当前绑定的会话先发出 SessionEnd，随后的新 SessionStart 才允许改绑；
        // 其余不同 id 的事件照旧按嵌套进程/子代理拒收（core/claude-identity-switch.js）。
        // /compact 的提交确认。PreCompact 是周期开始，带 trigger、custom_instructions（/compact 的参数）
        // 和 prompt_id；压缩完成后的 SessionStart(source=compact) 是同一周期（同一 prompt_id）的结束。
        // 谁被确认由 core/claude-local-command-acks 按参数与周期决定（R7）。不转给 renderer。
        const compactSignal = hookTargetSession.agentRuntime === 'pty' && !parsed.agentId
          && (event === 'pre-compact' || (event === 'session-start' && parsed.source === 'compact'))
          && (!boundClaudeSessionId || incomingClaudeSessionId === boundClaudeSessionId);
        if (compactSignal) {
          for (const lane of Object.values(companyAssistantService?.lanes || {})) if (lane.job?.sessionId === parsed.sessionId) lane.job.meterCompacted = true; // 三条队列（5.5.11）各自有在答的任务
          sessionManager.emit('claude-local-command-ack', {
            sessionId: parsed.sessionId, command: 'compact',
            phase: event === 'pre-compact' ? 'start' : 'end',
            cycleId: parsed.promptId || null,
            args: event === 'pre-compact' && typeof parsed.customInstructions === 'string' ? parsed.customInstructions : null,
            trigger: parsed.trigger || null,
          });
        }
        if (event === 'pre-compact') { res.writeHead(200); res.end('{"ok":true}'); return; }
        if ((event === 'session-start' || event === 'session-end') && hookTargetSession.agentRuntime === 'pty') {
          const verdict = claudeIdentitySwitch.observe(parsed.sessionId, {
            event, boundId: boundClaudeSessionId, incomingId: incomingClaudeSessionId,
            source: parsed.source || null, reason: parsed.reason || null, agentId: parsed.agentId || null,
            promptId: parsed.promptId || null,
            endOptional: event === 'session-start' && isCodeAgentKind(hookTargetSession.kind)
              && !!boundClaudeSessionId && codeAgentSwitchLocationOk(parsed, hookTargetSession),
          });
          if (verdict.action === 'rebind') {
            const updated = updateSessionTranscriptBinding(parsed.sessionId, {
              ccSessionId: incomingClaudeSessionId, transcriptPath: parsed.transcriptPath, cwd: parsed.cwd,
            });
            if (updated && updated.ccSessionId === incomingClaudeSessionId) {
              console.log(`[claude hook] ${parsed.sessionId.slice(0, 8)} follows CLI identity `
                + `${boundClaudeSessionId.slice(0, 8)} -> ${incomingClaudeSessionId.slice(0, 8)} (${parsed.source})`);
              sessionManager.emit('claude-identity-switched', { sessionId: parsed.sessionId, to: incomingClaudeSessionId,
                source: parsed.source || null, cycleId: verdict.cycleId || null });
              sendToRenderer('claude-identity-switched', {
                sessionId: parsed.sessionId, from: boundClaudeSessionId, to: incomingClaudeSessionId,
                source: parsed.source || null, transcriptPath: parsed.transcriptPath || null, at: eventAt,
              });
            } else {
              verdict.action = 'ignore';
              verdict.why = 'rebind-rejected';
            }
          } else if (verdict.action === 'ignore' && verdict.why !== 'no-identity') {
            console.warn(`[claude hook] ignored ${event} for ${parsed.sessionId.slice(0, 8)}: ${verdict.why}`);
            if (incomingClaudeSessionId && boundClaudeSessionId && incomingClaudeSessionId !== boundClaudeSessionId) logCodeAgentIdentity(hookTargetSession, 'identity-switch-rejected', {
              bound: boundClaudeSessionId.slice(0, 8), incoming: incomingClaudeSessionId.slice(0, 8), why: verdict.why, source: parsed.source || null,
              note: '续接异常：CLI 换了对话号，Hub 没有跟上，下次恢复可能接回换号前的对话' });
          }
          res.writeHead(200); res.end(JSON.stringify({ ok: true, identity: verdict.action })); return;
        }
        if ((boundClaudeSessionId && incomingClaudeSessionId
              && boundClaudeSessionId !== incomingClaudeSessionId)
            || initialCwdMismatch || initialTranscriptBucketMismatch) {
          // Descendant/parallel Claude processes inherit environment variables.
          // A mismatched native session or first-hook cwd is not evidence for
          // this Hub session, even when it inherited the correct local token.
          console.warn(`[claude hook] ignored foreign ${event} for ${parsed.sessionId.slice(0, 8)}`
            + ` (${initialCwdMismatch ? 'cwd' : initialTranscriptBucketMismatch ? 'transcript-dir' : 'native-id'})`);
          logCodeAgentIdentity(hookTargetSession, 'identity-foreign-hook', { bound: String(boundClaudeSessionId || '').slice(0, 8) || null,
            incoming: String(incomingClaudeSessionId || '').slice(0, 8) || null, why: initialCwdMismatch ? 'cwd' : initialTranscriptBucketMismatch ? 'transcript-dir' : 'native-id' });
          res.writeHead(202); res.end('{"ignored":"foreign-session"}'); return;
        }
        // Prefer the UserPromptSubmit payload's `prompt` field when present —
        // it's the just-submitted text and doesn't depend on CC having flushed
        // the new transcript entry to disk. For Stop events (no `prompt` in
        // payload) fall back to reading the transcript JSONL tail (async —
        // long transcripts used to block the main-process event loop).
        let latestUserMessage = null;
        // Claude Code 在后台任务结束或 Monitor 出事件时自己注入 <task-notification> 续跑，
        // 也会发 UserPromptSubmit。它不是用户发言：不当预览、不起标题、不算已读。
        const injectedContinuation = event === 'prompt' && isTaskNotificationText(parsed.prompt);
        if (!injectedContinuation && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
          latestUserMessage = parsed.prompt;
        } else if (event === 'stop' && parsed.transcriptPath) {
          latestUserMessage = await readLastUserMessage(parsed.transcriptPath);
        }
        // Feed the Claude transcript tap so the Hub timeline (research/general)
        // gets the authoritative final assistant turn. Only fire on Stop events
        // — UserPromptSubmit fires before the assistant has responded, so the
        // transcript tail's last-assistant entry would be the previous turn
        // and immediately trigger a stale update.
        const isSubagentContext = !!parsed.agentId;
        // DeepSeek on Claude Code 选了 Token Plan：记下最近一条消息，撞上套餐额度墙时改走官方 API 并重发一次。
        if (!isSubagentContext && tokenPlanFallback && String(hookTargetSession.kind || '').startsWith('deepseek-claude')) {
          try {
            tokenPlanFallback.onClaudeHook(parsed.sessionId, event, {
              prompt: latestUserMessage, error: parsed.error, message: parsed.message,
              lastAssistantMessage: parsed.lastAssistantMessage, errorDetails: parsed.errorDetails,
              turnId: parsed.turnId, claudeSessionId: parsed.claudeSessionId,
            });
          } catch (error) { console.warn('[token-plan-fallback] claude hook failed:', error && error.message); }
        }
        if (!isSubagentContext && (parsed.claudeSessionId || parsed.transcriptPath)) {
          updateSessionTranscriptBinding(parsed.sessionId, {
            ccSessionId: parsed.claudeSessionId,
            transcriptPath: parsed.transcriptPath,
            cwd: parsed.cwd,
          });
        }
        // Bind the JSONL tail at prompt/tool time rather than waiting for Stop.
        // Claude's terminal stop_reason can then close the turn independently
        // when the Stop hook is delayed or missing.
        if (!isSubagentContext && event !== 'stop' && parsed.transcriptPath) {
          void transcriptTap.watchClaudeTranscript(parsed.sessionId, parsed.transcriptPath, {
            turnId: parsed.turnId || parsed.promptId || null,
            prompt: latestUserMessage,
            at: eventAt,
            newTurn: event === 'prompt',
          });
        }
        if (!isSubagentContext && event === 'stop' && parsed.transcriptPath) {
          claudeAccountSwitch.onCompleted({ sessionId: parsed.sessionId, nativeSessionId: incomingClaudeSessionId,
            promptId: parsed.promptId || null, turnId: parsed.turnId || null, at: eventAt });
          void transcriptTap.notifyClaudeStop(parsed.sessionId, parsed.transcriptPath, { turnId: parsed.turnId || parsed.promptId || null });
          if (require('./core/session-actual-model').transcriptKind(hookTargetSession)) void observeCodeAgentModel(parsed.sessionId, {}, parsed.transcriptPath, 'stop-hook');
          if (softCompact) void softCompact.onStop(parsed.sessionId, { transcriptPath: parsed.transcriptPath, lastAssistantMessage: parsed.lastAssistantMessage })
            .catch(error => console.warn('[soft-compact] stop failed:', error && error.message));
        }
        if (!isSubagentContext && event === 'stop-failure') {
          transcriptTap.notifyClaudeError(parsed.sessionId, {
            message: parsed.error || parsed.message || 'Claude StopFailure',
            errorDetails: parsed.errorDetails || null,
            turnId: parsed.turnId || null,
            completedAt: eventAt,
            signalSource: 'stop_failure',
          });
          void claudeAccountSwitch.onFailure({ sessionId: parsed.sessionId,
            nativeSessionId: incomingClaudeSessionId, promptId: parsed.promptId || null, turnId: parsed.turnId || null,
            error: parsed.error || parsed.message || '', errorDetails: parsed.errorDetails, at: eventAt })
            .catch(error => console.warn('[claude-account-switch]', error.code || 'failed'));
        }
        if (event === 'prompt' && !isSubagentContext) {
          claudeAccountSwitch.onPrompt({ sessionId: parsed.sessionId, nativeSessionId: incomingClaudeSessionId,
            promptId: parsed.promptId || null, turnId: parsed.turnId || null, at: eventAt, prompt: latestUserMessage });
          try {
            sessionManager.noteAgentTurnStarted(parsed.sessionId, {
              startedAt: eventAt,
              signalSource: 'claude-user-prompt-submit',
              prompt: latestUserMessage,
              turnId: parsed.turnId || parsed.promptId || null,
            });
          } catch (error) {
            console.warn('[claude prompt] main-process lifecycle note failed:', error && error.message);
          }
          if (latestUserMessage) {
            maybeAutoTitleSessionFromPrompt({
              hubSessionId: parsed.sessionId,
              text: latestUserMessage,
              submittedAt: eventAt,
              signalSource: 'hook_prompt',
            });
          }
        }
        sendToRenderer('hook-event', {
          event,
          eventAt,
          sessionId: parsed.sessionId,
          claudeSessionId: parsed.claudeSessionId,
          cwd: parsed.cwd,
          latestUserMessage,
          backgroundTasks: Array.isArray(parsed.backgroundTasks) ? parsed.backgroundTasks : [],
          injectedContinuation,
          sessionCrons: Array.isArray(parsed.sessionCrons) ? parsed.sessionCrons : [],
          error: parsed.error || null,
          errorDetails: parsed.errorDetails || null,
          lastAssistantMessage: parsed.lastAssistantMessage || null,
          notificationType: parsed.notificationType || null,
          message: parsed.message || null,
          title: parsed.title || null,
          toolName: parsed.toolName || null,
          toolCallId: parsed.toolCallId || null,
          turnId: parsed.turnId || null,
          toolInput: parsed.toolInput ?? null,
          toolResult: parsed.toolResult ?? null,
          agentId: parsed.agentId || null,
          agentType: parsed.agentType || null,
          taskId: parsed.taskId || null,
          taskSubject: parsed.taskSubject || null,
        });
      } else {
        // DeepSeek on Claude Code 走 API Key，状态栏里没有、也不能混进 Claude 订阅额度。
        const statusSession = parsed.sessionId ? sessionManager.getSession(parsed.sessionId) : null;
        const deepseekStatus = statusSession && !/^claude(?:-resume)?$/.test(statusSession.kind);
        const statusScope = statusSession?.claudeUsageScope || currentClaudeScope(statusSession?.claudeProfile || 'default');
        // Every reply brings the account quota for free (2026-10-29). A process
        // that was already running when its account changed may still hold the
        // old account's figures, so managed sessions only count readings from
        // the current native process and login generation.
        const managedStatus = !!statusSession?.claudeRuntimeHome;
        const staleAccountUsage = managedStatus && !claudeAccountSwitch.acceptsPassiveUsage({
          sessionId: parsed.sessionId, nativeSessionId: parsed.nativeSessionId,
          generation: parsed.claudeAuthGeneration, scope: parsed.claudeScope });
        const filtered = deepseekStatus || staleAccountUsage
          ? { usage5h: null, usage7d: null, anyAccepted: false }
          : claudeFilter(statusScope).filter(parsed.usage5h, parsed.usage7d);
        syncSessionRuntimeModel(parsed.sessionId, parsed.model);
        sendToRenderer('status-event', {
          sessionId: parsed.sessionId,
          claudeScope: statusScope,
          contextPct: parsed.contextPct,
          contextUsed: parsed.contextUsed,
          contextMax: parsed.contextMax,
          usage5h: filtered.usage5h,
          usage7d: filtered.usage7d,
          model: parsed.model,
          sessionName: parsed.sessionName,
          cwd: parsed.cwd,
          apiMs: parsed.apiMs,
          linesAdded: parsed.linesAdded,
          linesRemoved: parsed.linesRemoved,
        });
        if (filtered.anyAccepted) cacheAccountUsage({ usage5h: filtered.usage5h, usage7d: filtered.usage7d }, statusScope);
        if (filtered.anyAccepted && managedStatus) {
          try {
            const tools = require('./core/claude-subscription-profiles');
            const profile = tools.resolveProfile(getHubConfig(), statusSession.claudeProfile || 'default');
            const snapshot = profile && claudeAccountBroker.cached(profile);
            if (snapshot) claudeQuotaPrecompact?.onUsage(profile, snapshot);
          } catch (error) { console.warn('[quota-precompact] passive usage failed:', error.message); }
        }
      }
    }
    res.writeHead(200); res.end('{}');
  });
});

// 原端口段耗尽后在同一个服务上请求系统分配，所有回调地址使用最终绑定值。
async function listenWithFallback() {
  try {
    hookBinding = await listenWithPortFallback(hookServer);
    if (hookBinding.fallback) console.warn(`[hook] ${hookBinding.message}`);
    return hookBinding.port;
  } catch (error) {
    hookBinding = { port: null, failures: error.portFailures || [] };
    console.warn(`[hook] 状态回报端口绑定失败（${error.code || 'UNKNOWN'}）：${error.message}`);
    return null;
  }
}

// --- Account usage cache ---
// Persist the latest Claude account usage so the sidebar renders immediately on
// restart without waiting for the first statusline callback.
const USAGE_CACHE_FILE = path.join(getHubDataDir(), 'usage-cache.json');
const STATUSLINE_CACHE_FILE = path.join(getHubDataDir(), 'statusline-cache.json');
let _usageCacheMemory = null;
let _usageCacheWriteTimer = null;
let _usageCacheWriteQueue = Promise.resolve();

function scheduleUsageCacheWrite() {
  if (_usageCacheWriteTimer) clearTimeout(_usageCacheWriteTimer);
  _usageCacheWriteTimer = setTimeout(() => {
    _usageCacheWriteTimer = null;
    const snapshot = JSON.parse(JSON.stringify(_usageCacheMemory || {}));
    _usageCacheWriteQueue = _usageCacheWriteQueue.then(async () => {
      const merged = await writeMergedUsageCacheFile(USAGE_CACHE_FILE, snapshot);
      // Keep newer in-process updates that arrived while this write waited on
      // another Hub's lock; the next scheduled write will persist them.
      _usageCacheMemory = mergeUsageCacheSnapshots(merged, _usageCacheMemory || {}, Date.now());
    }).catch(error => console.warn('[usage-cache] async write failed:', error && error.message));
  }, 100);
  _usageCacheWriteTimer.unref?.();
}

function flushUsageCacheSync() {
  if (_usageCacheWriteTimer) {
    clearTimeout(_usageCacheWriteTimer);
    _usageCacheWriteTimer = null;
  }
  if (_usageCacheMemory === null) return;
  _usageCacheMemory = writeMergedUsageCacheFileSync(USAGE_CACHE_FILE, _usageCacheMemory);
}

// See core/usage-filter.js for why this filter exists (rate_limits monotonic
// within a window — stale low-pct snapshots from idle sessions must not
// overwrite the true usage from heavy sessions).
const claudeScopeTools = require('./core/claude-usage-scope');
const claudeUsageFilters = new Map();
function currentClaudeScope(id) { return claudeScopeTools.scope(getHubConfig(),id); }
function claudeCache(scope = currentClaudeScope()) { return claudeScopeTools.cached(loadUsageCache(),scope); }
function claudeFilter(scope) {
  if (!claudeUsageFilters.has(scope)) {const filter=createUsageFilter();filter.seed(claudeCache(scope));claudeUsageFilters.set(scope,filter);}
  return claudeUsageFilters.get(scope);
}

function cacheAccountUsage(data, scope = currentClaudeScope()) {
  try {
    const existing = loadUsageCache();
    const key = "claude:" + scope;
    const cur = existing[key] || {};
    existing[key] = {
      claudeScope: scope,
      usage5h: data.usage5h || cur.usage5h || null,
      usage7d: data.usage7d || cur.usage7d || null,
      ts: data.ts || Date.now(),
    };
    if (JSON.stringify(cur) === JSON.stringify(existing[key])) return;
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch (error) { console.warn('[claude-usage] cache update failed:', error && error.message); }
}

function loadStatuslineCache() {
  try { return JSON.parse(fs.readFileSync(STATUSLINE_CACHE_FILE, 'utf8')); } catch { return {}; }
}

// Native Claude sessions answer the account quota over their own control; the
// status line that used to feed this never runs in that transport. Any live
// connection can answer, so take the first one and fall back to the cache when
// none is connected or the engine will not say.
async function refreshClaudeAccountUsageLive(scope = currentClaudeScope()) {
  for (const session of sessionManager.getAllSessions()) {
    if (session.runtimeBackend !== 'claude-stream-json' || !/^claude(?:-resume)?$/.test(session.kind) || (session.claudeUsageScope || currentClaudeScope(session.claudeProfile || 'default')) !== scope) continue;
    const native = sessionManager.getNativeClaude?.(session.id);
    if (!native || native.closed || native.runtime?.connection !== 'connected') continue;
    let snapshot = null;
    try { snapshot = await native.readAccountUsage(); }
    catch (error) { console.warn('[claude-usage] native read failed:', error && error.message); continue; }
    if (!snapshot) continue;
    const before = claudeCache(scope);
    const filtered = claudeFilter(scope).filter(snapshot.usage5h, snapshot.usage7d);
    if (filtered.anyAccepted) {
      cacheAccountUsage({ usage5h: filtered.usage5h, usage7d: filtered.usage7d, ts: snapshot.observedAt }, scope);
    }
    const data = claudeCache(scope);
    return { data, changed: didClaudeSnapshotAdvance(before, { ...data, observedAt: snapshot.observedAt }),
      observedAt: snapshot.observedAt, source: 'claude-native' };
  }
  return null;
}

async function refreshClaudeAccountUsage() {
  return claudeAccountRefresh.refresh();
}

const claudeRefreshers = new Map();
function claudeRefresher(scope = currentClaudeScope()) {
  if (claudeRefreshers.has(scope)) return claudeRefreshers.get(scope);
  let broadcast = '';
  const controller = require('./main/usage/claude-usage-refresh').createClaudeUsageRefresh({
    refresh: async () => (await refreshClaudeAccountUsageLive(scope)) || refreshClaudeAccountUsageFromStatuslineCache(scope),
    getSessions: () => sessionManager.getAllSessions().flatMap(session => {
      if (!/^claude(?:-resume)?$/.test(session.kind) || session.runtimeBackend !== 'claude-stream-json'
        || (session.claudeUsageScope || currentClaudeScope(session.claudeProfile || 'default')) !== scope) return [];
      const native=sessionManager.getNativeClaude?.(session.id);
      return native && !native.closed && native.runtime?.connection === 'connected' ? [{id:session.id,...native.runtime}] : [];
    }),
    getCached: () => claudeCache(scope),
    publish: data => {
      if (scope !== currentClaudeScope()) return;
      const signature=JSON.stringify(data);if(signature===broadcast)return;broadcast=signature;
      sendToRenderer('status-event',{usage5h:data.usage5h,usage7d:data.usage7d,claudeScope:scope,observedAt:data.observedAt||data.ts||0});
    },
  });
  claudeRefreshers.set(scope,controller);return controller;
}
const claudeAccountRefresh = {
  tick: reason => claudeRefresher().tick(reason),
  refresh: () => claudeRefresher().refresh(),
  stop: () => {for(const r of claudeRefreshers.values())r.stop();},
};
app.on('browser-window-focus', () => { void claudeAccountRefresh.tick('focus'); });
app.on('will-quit', () => { claudeAccountRefresh.stop(); });

function refreshClaudeAccountUsageFromStatuslineCache(scope = currentClaudeScope()) {
  const before = claudeCache(scope);
  const snapshot = selectClaudeStatuslineUsage(claudeScopeTools.selectStatusline(loadStatuslineCache(),scope));
  if (!snapshot) {
    return {
      data: before,
      changed: false,
      observedAt: before && (before.observedAt || before.ts) || 0,
      source: 'statusline-cache',
    };
  }
  const filtered = claudeFilter(scope).filter(snapshot.usage5h, snapshot.usage7d);
  if (filtered.anyAccepted) {
    cacheAccountUsage({
      usage5h: filtered.usage5h,
      usage7d: filtered.usage7d,
      ts: snapshot.ts,
    }, scope);
  }
  const data = claudeCache(scope);
  return {
    data,
    changed: didClaudeSnapshotAdvance(before, { ...data, observedAt: snapshot.ts }),
    observedAt: snapshot.ts,
    source: snapshot.source,
  };
}

function cacheAgentUsage(provider, tokenData, scope = null) {
  try {
    const existing = loadUsageCache();
    const scoped = provider === 'codex' && scope
      ? attachCodexUsageScope(tokenData, scope)
      : tokenData;
    const observedAt = tokenData && (tokenData.observedAt || tokenData._ts) || (provider === 'antigravity' ? 0 : Date.now());
    const next = { ...scoped, ts: observedAt };
    if (JSON.stringify(existing[provider]) === JSON.stringify(next)) return;
    existing[provider] = next;
    _usageCacheMemory = existing;
    scheduleUsageCacheWrite();
  } catch {}
}

function readUsageCacheDisk() {
  return readUsageCacheFile(USAGE_CACHE_FILE);
}

function loadUsageCache() {
  const disk = readUsageCacheDisk();
  _usageCacheMemory = _usageCacheMemory === null
    ? disk
    : mergeUsageCacheSnapshots(disk, _usageCacheMemory, Date.now());
  return { ..._usageCacheMemory };
}

function currentCodexUsageScope() {
  return resolveCodexUsageScope(getHubConfig(), {
    hubDataDir: getHubDataDir(),
    homeDir: os.homedir(),
  });
}

let _codexLiveUsage = null;

async function refreshCodexAccountUsageLive() {
  const scope = currentCodexUsageScope();
  if (scope.backend !== 'subscription') {
    throw new Error('Codex API 模式没有订阅配额窗口');
  }
  const config = getHubConfig();
  const raw = await readCodexAccountUsage({
    home: scope.home,
    proxy: config.proxy,
    cwd: os.homedir(),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  if (scope.scopeKey !== currentCodexUsageScope().scopeKey) {
    throw new Error('Codex 账号已切换，请重新刷新');
  }
  _codexLiveUsage = attachCodexUsageScope(payload, scope);
  cacheAgentUsage('codex', payload, scope);
  return _codexLiveUsage;
}

async function refreshKimiAccountUsageLive() {
  const raw = await readKimiAccountUsage({
    home: process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'),
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('kimi', payload);
  return payload;
}

async function refreshDeepSeekAccountBalanceLive() {
  const raw = await readDeepSeekAccountBalance({
    apiKey: getHubConfig().deepseekApiKey,
    timeoutMs: 8000,
  });
  const payload = { ...raw, _ts: raw.observedAt };
  cacheAgentUsage('deepseek', payload);
  return payload;
}

const tokenPlanUsage = createTokenPlanUsageService({
  configDir: isIsolatedHub() ? path.join(getHubDataDir(), 'bailian') : undefined,
  backgroundIntervalMs: Number(process.env.HUB_TOKEN_PLAN_POLL_MS) || 60_000,
});

async function refreshTokenPlanUsage(force = false) {
  try {
    const snapshot = await tokenPlanUsage.refresh(force);
    // 读到 100% 就记下「已用完」，之后新开或发送的套餐会话直接走 DeepSeek API。
    tokenPlanFallback?.observeUsage(snapshot);
    return snapshot;
  }
  finally { sendToRenderer('agent-usage', { tokenPlan: tokenPlanUsage.snapshot() }); }
}

function loadUsageCacheForCurrentConfig() {
  // Source selection checks expiry; display retains the last account-scoped
  // observation with its real age, including across reset/refresh gaps.
  const scope = currentCodexUsageScope();
  const cache = filterUsageCacheForCodexScope(loadUsageCache(), scope);
  const safe = require('./core/codex-jsonl-history-guard').filterManagedCodexHistoryCache(cache,
    {dataDir:getHubDataDir(),sessionsRoot:scope.sessionsRoot});
  // Legacy singleton Antigravity cache has no account identity; never relabel it.
  delete safe.antigravity;
  return { ...safe,
    claude: claudeCache(), tokenPlan: tokenPlanUsage.snapshot() };
}

try {
  const cachedCodex = loadUsageCacheForCurrentConfig().codex;
  if (cachedCodex && cachedCodex.source === 'app-server') _codexLiveUsage = cachedCodex;
} catch {}

// The Codex accounts not in use right now, for the usage popover (on demand, never polled).
const codexOtherUsage = require('./main/usage/codex-other-profiles-usage.js').createCodexOtherProfilesUsage({
  getConfig: getHubConfig,
  currentScope: currentCodexUsageScope,
  resolveScope: config => resolveCodexUsageScope(config, { hubDataDir: getHubDataDir(), homeDir: os.homedir() }),
  readUsage: opts => readCodexAccountUsage({ ...opts, cwd: os.homedir() }),
  file: path.join(getHubDataDir(), 'codex-other-usage.json'),
});
ipcMain.handle('codex-other-usage', () => codexOtherUsage.list());
ipcMain.handle('refresh-codex-other-usage', (_event, opts = {}) => codexOtherUsage.refresh({ force: opts && opts.force === true }));
const antigravityProfilesUsage = require('./main/usage/antigravity-profiles-usage').createAntigravityProfilesUsage({getConfig:getHubConfig});
const accountProfileUsage = require('./main/usage/account-profile-usage').createAccountProfileUsage({
  antigravityProfiles: antigravityProfilesUsage.profiles,
  antigravityScope: antigravityProfilesUsage.scope,
  antigravityCached: antigravityProfilesUsage.cached,
  refreshAntigravity: antigravityProfilesUsage.refresh,
  claudeProfiles: () => require('./core/claude-subscription-profiles').normalizeProfiles(getHubConfig().claudeSubscriptionProfiles),
  claudeScope: currentClaudeScope, claudeCached: claudeCache,
  claudeAccount: id => { const tools = require('./core/claude-subscription-profiles'); return tools.accountInfo(tools.resolveProfile(getHubConfig(), id).home); },
  // 共享出口 IP：账号页「出口一致性」记下的基线（claude-egress-baseline.json），专线号用自己配置的 IP。
  claudeSharedIp: () => { try { return JSON.parse(fs.readFileSync(path.join(getHubDataDir(), 'claude-egress-baseline.json'), 'utf8')).shared || ''; } catch { return ''; } },
  refreshClaude: scope => claudeRefresher(scope).refresh(),
  codexScope: currentCodexUsageScope,
  codexCached: () => loadUsageCacheForCurrentConfig().codex,
  codexOrder: () => ['default', ...(getHubConfig().codexSubscriptionProfiles || []).map(p => p.id).filter(id => id !== 'default')],
  otherCodex: () => codexOtherUsage.list(),
  refreshCodex: force => refreshCodexUsageIfDue(force),
  refreshOtherCodex: options => codexOtherUsage.refresh(options),
});
ipcMain.handle('account-profile-usage', () => accountProfileUsage.list());
// 推荐号跳过登录已失效、刷新未确认的号（core/claude-account-credentials.js authBlocked），不把新会话推到开不起来的号上。
function claudeAccountsWithAuthState(accounts) {
  const profiles = require('./core/claude-subscription-profiles');
  return (accounts || []).map(row => {
    if (row?.error) return row;
    let blocked = null;
    try { blocked = claudeAccountBroker.authBlocked(profiles.resolveProfile(getHubConfig(), row.profileId)); } catch {}
    return blocked ? { ...row, error: blocked.message, errorCode: blocked.code } : row;
  });
}
ipcMain.handle('claude:launch-ranking', () => require('./core/claude-launch-recommend').rankClaudeAccounts({
  accounts: claudeAccountsWithAuthState(accountProfileUsage.list().claude), sessions: sessionManager.getAllSessions(),
  flagged: new Set(accountProfileUsage.list().claude.map(a => a.profileId).filter(id => accountRiskStore.isFlagged('claude', id))) }));
require('./main/ipc/account-risk-handlers').registerAccountRiskIpc(ipcMain, { store: accountRiskStore, sendToRenderer });
ipcMain.handle('refresh-account-profile-usage', (_event, options = {}) => accountProfileUsage.refresh(options));
// 账号看板的出口地点：每个 IP 查一次并缓存（main/usage/ip-location-cache.js）；E2E 用夹具，不发网络请求。
const ipLocationCache = require('./main/usage/ip-location-cache').createIpLocationCache({
  dataDir: getHubDataDir(), getProxy: () => getHubConfig().proxy,
  ...(process.env.CLAUDE_HUB_E2E === '1' && process.env.CLAUDE_HUB_IP_LOCATION_FIXTURE ? { probeFactory: ({ endpoints }) => async () => {
    const ip = endpoints[0].url.split('/').pop(), hit = JSON.parse(process.env.CLAUDE_HUB_IP_LOCATION_FIXTURE)[ip];
    return hit ? { ok: true, ...hit } : { ok: false };
  } } : {}),
});
ipcMain.handle('ip-location:get', (_event, ips) => ipLocationCache.get(ips));

async function refreshAntigravityUsage(force = false) {
  const scope = antigravityProfilesUsage.scope();
  const value = await antigravityProfilesUsage.refresh(scope,force);
  if (value && scope===antigravityProfilesUsage.scope()) {
    sendToRenderer('agent-usage', {antigravity:value,accounts:accountProfileUsage.list()});
  }
  return value ? { ...value, authScope: scope } : value;
}
registerUsageIpc(ipcMain, {
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  loadUsageCacheForCurrentConfig,
  refreshClaudeAccountUsage,
  getCodexUsageScopeKey: () => currentCodexUsageScope().scopeKey,
  refreshCodexAccountUsage: () => refreshCodexUsageIfDue(true),
  refreshDeepSeekAccountBalance: refreshDeepSeekAccountBalanceLive,
  refreshTokenPlanUsage: () => refreshTokenPlanUsage(true),
  refreshAntigravityUsage: () => refreshAntigravityUsage(true),
  refreshKimiAccountUsage: refreshKimiAccountUsageLive,
  scanAgentSessions,
});

// 账号页 · Claude 登录环境（VPS 远程浏览器，2026-10-28 由桌面启动台并入）。
const vpsLogin = require('./main/ipc/vps-login-handlers').registerVpsLoginIpc(ipcMain, { sendToRenderer, clearSessionManagerConfigCache });
// 账号页 · Claude 账号邮箱保管（2026-10-30）：密码 safeStorage 加密，邮箱在该账号的登录环境里打开（同一出口）。
require('./main/ipc/mailbox-handlers').registerMailboxIpc(ipcMain, {
  safeStorage: require('electron').safeStorage, clipboard,
  pickFile: async defaultPath => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: '导入 Claude 账号邮箱资料', defaultPath: defaultPath || undefined, properties: ['openFile'], filters: [{ name: '账号资料', extensions: ['json'] }] });
    return r.canceled ? '' : r.filePaths[0] || '';
  },
  openInLoginEnv: payload => vpsLogin.enabled() ? vpsLogin.open(payload) : Promise.reject(new Error('本机没有接入 VPS 登录环境，无法在账号自己的出口打开邮箱')),
});
registerConfigIpc(ipcMain, {
  lanPoolService,
  companyProxyService,
  prepareNewClaudeAccount: payload => vpsLogin.enabled() ? vpsLogin.prepareNew(payload) : Promise.resolve({}),
  requireClaudeExit: () => vpsLogin.enabled(),
  ensureLaunchAuth:async(kind,opts)=>{await launchAuth.ensure(kind,opts);await ensureCodexAccountNamespace(kind,opts);},
  attachCodexUsageScope,
  clearCodexJsonlCache: () => _codexJsonlCachedByRoot.clear(),
  clearSessionManagerConfigCache,
  currentCodexUsageScope,
  getCompletionNotificationHealth: () => completionNotifier.getHealth(),
  meetingManager,
  scanAgentSessions,
  sendToRenderer,
  sessionManager,
  testCompletionNotification: (payload) => completionNotifier.sendTest(payload),
  listSessionsForAccounts: () => [...sessionManager.getAllSessions(), ...(Array.isArray(lastPersistedSessions) ? lastPersistedSessions : [])],
  prepareClaudeAccountDir: dir => { if (!isIsolatedHub()) alignClaudeProfileDir(dir); },
});

const accountCenterHome = process.env.CLAUDE_HUB_HOME_DIR || os.homedir();
const capabilityService = new (require('./core/capability-service').CapabilityService)({ sessionManager, dataDir: getHubDataDir() });
const accountCenter = new (require('./core/account-center').AccountCenter)({
  dataDir: getHubDataDir(), homeDir: accountCenterHome,
  getConfig: () => require('./core/hub-config').getConfig(),
  adapter: require('./core/account-adapters').createAccountAdapters({ dataDir:getHubDataDir(),homeDir:accountCenterHome,
    terminal:require('./core/account-login-terminal').createAccountLoginTerminal({sessionManager,
      registerSession:registerSessionForTap,send:sendToRenderer}),
    onLoginComplete:result=>sendToRenderer('launch-auth-status',result) }),
});
const launchAuth = new (require('./core/launch-auth').LaunchAuth)({accounts:accountCenter,
  getConfig:()=>require('./core/codex-global-account').currentConfig(),
  notify:result=>sendToRenderer('launch-auth-status',result)});
sessionManager.on('codex-session-updated',session=>{
  const failure=session.nativeActionError || session.nativeRuntime?.reason || session.cliRuntime?.reason;
  if (failure) void launchAuth.recover(session.kind,{...session,model:session.currentModel?.id},failure);
});
require('./main/ipc/account-center-handlers').registerAccountCenterIpc(ipcMain,accountCenter);
const tokenUsage = new (require('./core/token-usage/service').TokenUsageService)({ dataDir: getHubDataDir(), homeDir: accountCenterHome,
  codeAgentDir: () => { try { return require('./core/codeagent-config').resolveCodeAgentConfig({ ...process.env, USERPROFILE: accountCenterHome, HOME: accountCenterHome }).configDir; } catch { return ''; } },
  publish: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('token-usage-changed', state); } });
require('./main/ipc/token-usage-handlers').registerTokenUsageIpc(ipcMain, tokenUsage);
tokenUsage.start();
// The account page: one Hub Chrome holds every web login; CLIs report their own token files.
hubAccountsService = new (require('./core/hub-accounts').HubAccounts)({
  getCliObservation:id=>accountCenter.recentObservation(id.startsWith('codex:')?id.replace('codex:','codex-'):id==='gemini'?'gemini-cli':id),
  getToolCatalog: refresh => capabilityService.catalog(refresh),
  recovery: new (require('./core/web-roundtable/recovery').AccountRecovery)({ dataDir: getHubDataDir() }),
});
require('./main/ipc/hub-accounts-handlers').registerHubAccountsIpc(ipcMain, hubAccountsService);
// About twice a day the logins are confirmed in the background; the sidebar shows how many
// accounts need the person.
hubAccountsService.startAuto({ onAttention: count => sendToRenderer('hub-accounts:attention', count) });

require('./main/ipc/voice-input-handlers').registerVoiceInputIpc(ipcMain, {
  app, safeStorage: require('electron').safeStorage,
  // 语音「动态背景」：当前会话聊天记录 md 的末尾（昨日之我的数据源），只给本地识别模型
  getRecentContext: async hubSessionId => {
    if (!hubSessionId || typeof sessionSearchService?.transcriptFor !== 'function') return '';
    const found = await sessionSearchService.transcriptFor({ hubSessionId: String(hubSessionId) });
    return found?.exists ? require('./core/voice-text').recentFromTranscript(found.path) : '';
  },
});
require('./main/ipc/prompt-polish-handlers').registerPromptPolishIpc(ipcMain, { getConfig: getHubConfig, runCompanyAi });

// --- 梦境系统（Dream Consolidation）+ 记忆面板 ---
// 保留旧 IPC 兼容入口，但不再启动向原生规则写入的旧沉淀调度器。
const { registerMemoryIpc } = require('./main/ipc/memory-handlers.js');
registerMemoryIpc(ipcMain, { workspaceService, logger: console });
// New dreams write independent project memory, never the legacy rule sections.
const { HubMemoryService } = require('./core/hub-memory-service');
const hubMemoryService = new HubMemoryService({
  dataDir:getHubDataDir(), workspaceService, sessionManager, transcriptTap,
  searchService:sessionSearchService, sendToRenderer,
  getPersistedSessions:()=>lastPersistedSessions,
  createSession:async(kind,opts)=>{
    const session=await sessionManager.createSession(kind,opts);
    registerSessionForTap(session);sendToRenderer('session-created',{session});return session;
  },
  sendPrompt:(...args)=>require('./core/group-chat-watcher').sendToPty(...args),
});
require('./main/ipc/hub-memory-handlers').registerHubMemoryIpc(ipcMain,hubMemoryService);
// 「规则」页（2026-10-12）：通用规则 + 我的规则，随会话第一条消息送达；手动检查更新。
try {
  const hubRules=require('./core/hub-rules').createHubRulesStore({dataDir:getHubDataDir(),channel:require('./core/distribution').rulesChannel});
  hubMemoryService.hubRules=hubRules;
  require('./main/ipc/hub-rules-handlers').registerHubRulesIpc(ipcMain,{store:hubRules,memoryService:hubMemoryService,shell});
} catch (e) {
  console.warn('[hub-rules] 规则页初始化失败：', e && e.message);
}
// 会话场景（2026-10-13）：「规则 → 场景」页与输入框的「场景」按钮。
require('./main/ipc/session-scenes-handlers').registerSessionScenesIpc(ipcMain,{dataDir:getHubDataDir(),shell});
// 主题资源只在用户点击时联网；加载和切换不影响任何 CLI 会话。
require('./main/ipc/appearance-handlers').registerAppearanceIpc(ipcMain, { dataDir: getHubDataDir(), sendToRenderer });
// 开场动画（2026-11-22）：默认群星，随包三套，其余按需下载；隔离测试实例默认不播。
require('./main/ipc/boot-splash-handlers').registerBootSplashIpc(ipcMain, { dataDir: getHubDataDir(), sendToRenderer, isolated: isIsolatedHub() });
// 一键更新（2026-10-13，公司版）：只有发行目标写了下载源才开启；主仓库没有这个入口。
{
  const distribution = require('./core/distribution');
  let cliToolsInstallerRef = null;
  if (distribution.updateConfig) {
    try {
      const { createAppUpdateController, registerAppUpdateIpc } = require('./main/app-update-controller');
      // 以前开通过扩展功能的本机记录（core/edition-channel.js，只读本机文件）。
      const editionChannel = require('./core/edition-channel');
      const appUpdate = createAppUpdateController({ app, config: distribution.updateConfig, dataDir: getHubDataDir(),
        currentVersion: distribution.editionVersion || app.getVersion(), prepareLaunch: prepareHubLaunchClean,
        // 值得提醒的新版本（改了 x 或 y）由桌宠说一声；只改末位的照旧静默（2026-11-09）。
        sendToRenderer: (channel, payload) => { sendToRenderer(channel, payload); if (channel === 'app-update:state' && payload && payload.phase === 'available' && payload.latest && payload.latest.notify) { try { hubPetController?.announceUpdate?.(payload.latest.version); } catch (_) {} } },
        restartWait: () => companyHubAdmin()?.restartWaitView?.() || null,
        // 替换脚本先结束而 Hub 没退出（r43）：公司版的等待重启同样放开。
        onApplyCancelled: reason => { try { Promise.resolve(companyHubAdmin()?.quitCancelled?.(reason)).catch(() => {}); } catch (_) {} } });
      registerAppUpdateIpc(ipcMain, appUpdate, { gate: { apply: opts => { const admin = companyHubAdmin(); return admin && typeof admin.localApply === 'function' ? admin.localApply(opts) : null; } } });
      appUpdateControllerRef = appUpdate;
      const unsubOpenxDownloadHook = require('./core/app-update/downloader').onOpenxDownloadSuccess(evt => {
        if (appUpdate.openxRecorder?.isEnabled?.()) {
          void appUpdate.openxRecorder.record({ ...evt, kind: 'component' }).catch(() => {});
        }
      });
      // CLI 一键安装（2026-11-07）：组件从公司内源下载。
      try {
        const { createCliInstaller } = require('./core/cli-tools/installer');
        const cliSources = require('./core/cli-tools/catalog').catalogSources({ config: distribution.updateConfig });
        cliToolsInstallerRef = createCliInstaller({ sources: cliSources,
          getDshEntry: () => getHubConfig().acp?.providers?.['deepseek-acp'] || {},
          onState: state => { sendToRenderer('cli-tools:state', state); try { require('./core/harness-locator').noteInstallState(state); } catch (_) {} } });
        // 定位中心的「一键补齐」经这个安装器装（只装 Hub 自管目录）。
        try { require('./core/harness-locator').setInstaller(async req => { const st = await cliToolsInstallerRef.install(String(req.id || ''), {}); const t = st.tools[req.id] || {}; return { ok: t.phase === 'done', error: t.error || null }; }); } catch (_) {}
        // 启动 40 秒后在后台全局找一遍 Git Bash（隐藏的 PowerShell 读注册表和硬盘列表），新会话能用上别处装的 Git。
        setTimeout(() => { try { cliToolsInstallerRef?.refreshGit?.(); } catch (_) {} }, 40000).unref?.();
      } catch (e) { console.warn('[cli-tools] 一键安装初始化失败：', e && e.message); }
      // 收件地址只建一份（2026-11-19 黑洞复盘）：一键反馈、反馈收件机、一键入群共用同一个取地址实例——同一份缓存、同一次 10 分钟记忆，
      // 「重新取地址」对三处同时生效，修一处三处都好。
      let feedbackReceiverAddressRef = null;
      const sharedFeedbackReceiverAddress = () => feedbackReceiverAddressRef || (feedbackReceiverAddressRef = require('./core/feedback-receiver-address')
        .createReceiverAddress({ dataDir: getHubDataDir(), fetchImpl: (...args) => require('electron').net.fetch(...args) }));
      // 一键反馈（2026-10-29）：设置菜单「一键反馈」→ 脱敏诊断包，发不出就存到「下载」。
      // r42（2026-11-18）：经公司内网发给维护人电脑上的收件机。
      // 内网发不到进待发队列，后台每 10 分钟补发。
      try {
        const { createHubFeedbackService, registerHubFeedbackIpc } = require('./main/hub-feedback-service');
        const feedbackEdition = distribution.target === 'company' ? (distribution.featureEnabled('memberUpgrade') ? 'public' : 'member') : null;
        const feedbackService = createHubFeedbackService({
          edition: feedbackEdition,
          receiverAddress: feedbackEdition ? sharedFeedbackReceiverAddress() : null,
          // 公司版改走 WeLink（2026-11-21）：一键发送用本机 welink-cli（与助理同一份，登录过期会自动续期），没装就复制并打开 WeLink 客户端。
          welink: feedbackEdition ? (() => {
            const W = require('./core/company-assistant/welink');
            const FW = require('./core/hub-feedback-welink');
            const findCli = () => { try { return companyAssistantService?.cli?.() || W.resolveCli({}); } catch { return null; } };
            const writeClipboard = require('./core/verified-clipboard.js').createVerifiedClipboardWriter({ clipboard: require('electron').clipboard });
            return { to: FW.MAINTAINER_WELINK, hasCli: () => !!findCli(), parseJson: W.parseJson, writeClipboard,
              // R32：WeLink 桌面端当前账号 vs welink-cli 的账号（只读本机两个小文件），对不上就不白发。
              accounts: () => (companyAssistantService?.welinkAccounts ? companyAssistantService.welinkAccounts() : require('./core/company-assistant/welink-account').read({})),
              run: (args, opts) => require('./core/company-assistant/welink-gate').withWelinkCaller('feedback', () => companyAssistantService?.welink ? companyAssistantService.welink(args, { ...opts, caller: 'feedback' }) : require('./core/company-assistant/welink-gate').sharedWelinkGate().run(args, () => W.run(args, { ...opts, cli: findCli() }), { ...opts, caller: 'feedback' })),
              openDesktop: async () => {
                const hit = await FW.findWelinkDesktop();
                if (!hit.path) return { ok: false, reason: '没找到 WeLink 桌面客户端' };
                const err = await shell.openPath(hit.path);
                return err ? { ok: false, via: hit.via, reason: err } : { ok: true, via: hit.via };
              } };
          })() : null,
          logsDir: path.join(getHubDataDir(), 'logs'),
          // 隔离实例（E2E）存到自己的数据目录，不写进真实的「下载」文件夹。
          downloadsDir: () => isIsolatedHub() ? path.join(getHubDataDir(), 'downloads') : app.getPath('downloads'),
          // edition 带上「·成员版 / ·公开版」并另带 target（r42 与阿里云侧约定）：阿里云据此拒收新版成员版，旧客户端不受影响。
          collectMcpDiagnostics: sessionId => require('./core/codeagent-mcp-diagnostics').collectSessionMcpDiagnostics({
            session: sessionManager.sessions.get(sessionId), homeDir: process.env.USERPROFILE || process.env.HOME || '',
            personalDir: require('./core/codeagent-config').resolveCodeAgentConfig(process.env).configDir }),
          info: () => ({ productName: distribution.productName, target: distribution.target || '',
            edition: (distribution.editionBadge || distribution.target || '') + (feedbackEdition ? (feedbackEdition === 'member' ? '·成员版' : '·公开版') : ''),
            version: distribution.editionVersion || app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${require('os').release()}`,
            // 运行快照（借鉴同类工具的诊断包）：会话数、各类会话数、主进程内存、系统剩余内存、已运行时长。
            runtime: (() => { try {
              const list = [...(sessionManager?.sessions?.values?.() || [])];
              const kinds = {}; for (const e of list) { const k = e?.info?.kind || e?.kind || '?'; kinds[k] = (kinds[k] || 0) + 1; }
              const os = require('os'), mb = n => Math.round(n / 1048576);
              return `${fallbackMessage(hookBinding)} · 会话 ${list.length} 个（${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join('、') || '无'}）· 主进程内存 ${mb(process.memoryUsage().rss)} MB · 系统剩余 ${mb(os.freemem())}/${mb(os.totalmem())} MB · 已运行 ${Math.round(process.uptime() / 60)} 分钟`
                // R59：低开销模式开没开、各会话进程树合计占多少（缓存 1 分钟，打开反馈窗口时顺手刷新，提交时一般已量好）。
                + ` · ${require('./main/memory-pressure-watch').runtimeText({ lowOverheadOn: optionalFeatures?.lowOverhead?.() === true, allMem: memoryPressureWatch.allMemCached() })}`;
            } catch (e) { return '读取失败：' + e.message; } })() }) });
        registerHubFeedbackIpc(ipcMain, feedbackService);
        // AI_HUB_FEEDBACK_RETRY_MS 只供隔离 E2E 缩短补发间隔；正常每 10 分钟一轮、启动 1 分钟后先试一次。
        const retryMs = Number(process.env.AI_HUB_FEEDBACK_RETRY_MS) || 0;
        feedbackService.startRetry(retryMs > 0 ? { intervalMs: retryMs, firstDelayMs: retryMs } : undefined);
        app.on('will-quit', () => feedbackService.stopRetry());
      } catch (e) { console.warn('[hub-feedback] 一键反馈初始化失败：', e && e.message); }
      // 一键入群的发送端（r47；2026-11-28 起统一包也带）：底栏「用户群」弹层 → 维护人电脑上的收件机；收件地址与一键反馈同一个来源。
      try {
        const { createWelinkJoinClient, registerWelinkJoinIpc } = require('./main/welink-join-client');
        registerWelinkJoinIpc(ipcMain, createWelinkJoinClient({ dataDir: getHubDataDir(),
          receiverAddress: sharedFeedbackReceiverAddress() }));
      } catch (e) { console.warn('[welink-join] 初始化失败：', e && e.message); }
      // 社区统计·发送端（2026-11-24）：公司版每小时匿名报一次几个合计值；收件地址与一键反馈同一个来源，本机是收件机时走本地。
      try {
        const communityEdition = distribution.target === 'company' ? (distribution.featureEnabled('memberUpgrade') ? 'public' : 'member') : null;
        const { createCommunityService } = require('./main/community-service');
        communityServiceRef = createCommunityService({ dataDir: getHubDataDir(), edition: communityEdition,
          version: distribution.editionVersion || app.getVersion(), profileController: () => profileController,
          receiverAddress: communityEdition ? sharedFeedbackReceiverAddress() : null,
          fetchImpl: (...args) => require('electron').net.fetch(...args),
          isEnabled: () => optionalFeatures.get('community'),
          setEnabledFlag: on => applyOptionalFeature('community', on).then(() => broadcastOptionalFeatures()),
          getHost: () => communityHostRef, onHostPaused: paused => { if (paused) communityBoardAbort(); }, sendToRenderer,
          // AI_HUB_COMMUNITY_PULSE_MS 只供隔离 E2E 缩短首次与之后的间隔；正式实例忽略。
          clientOptions: isIsolatedHub() && Number(process.env.AI_HUB_COMMUNITY_PULSE_MS) > 0
            ? { firstDelayMs: Number(process.env.AI_HUB_COMMUNITY_PULSE_MS), periodMs: Number(process.env.AI_HUB_COMMUNITY_PULSE_MS) } : {} });
        communityServiceRef.registerIpc(ipcMain);
        app.whenReady().then(() => communityServiceRef.start()).catch(() => {});
        app.on('will-quit', () => communityServiceRef?.stop());
      } catch (e) { console.warn('[community] 初始化失败：', e && e.message); }
      // 社区·我的团队（2026-11-28）：黄区局域网里按 IP 组队，成员之间的 agent 来信、广播与文件分享（信箱在各自的共享文件夹里，内容团队钥匙加密）。
      if (distribution.target === 'company') try {
        const { createCommunityCrewMain } = require('./main/community-crew-service');
        const crew = createCommunityCrewMain({ dataDir: getHubDataDir(), isEnabled: () => optionalFeatures.get('community'),
          communityService: () => communityServiceRef, sendToRenderer, selfDistill: () => selfDistillService,
          publishNotice: notice => require('./core/company-assistant/notice-bus').noticeBus().publish(notice) });
        crew.registerIpc(ipcMain);
        app.whenReady().then(() => crew.start()).catch(() => {});
        app.on('will-quit', () => crew.stop());
      } catch (e) { console.warn('[community-crew] 初始化失败：', e && e.message); }
      // 扩展功能：界面问「本机是否开通过、是否已解锁」。
      const sealedModules = require('./core/sealed-modules');
      const sealedMode = sealedModules.present();
      ipcMain.handle('edition:state', () => (sealedMode
        ? { enabled: !sealedModules.loaded(), sealed: true, unlocked: !sealedModules.loaded() && editionChannel.wasUnlocked(getHubDataDir()), switched: sealedModules.loaded() || sealedModules.hasCachedKey(getHubDataDir()) }
        : { enabled: false, unlocked: false, switched: false }));
      ipcMain.handle('edition:relaunch', () => { app.relaunch(); app.quit(); return { ok: true }; });
      ipcMain.handle('edition:switch', async (_e, payload = {}) => {
        if (sealedMode) {
          if (sealedModules.loaded()) return { ok: false, message: '这个版本不需要' };
          const r = await sealedModules.unlockWithCode(typeof payload.code === 'string' ? payload.code : '', { dataDir: getHubDataDir() });
          return r.ok ? { ok: true, sealed: true } : { ok: false, reason: r.reason, message: r.message };
        }
        return { ok: false, message: '这个版本不需要' };
      });
      app.whenReady().then(() => {
        appUpdate.startBackgroundChecks();
      });
      app.on('will-quit', () => { try { unsubOpenxDownloadHook?.(); } catch (_) {} try { appUpdate.applyOnQuit(); } catch (error) { console.warn('[app-update] 退出时替换出错：', error && error.message); } appUpdate.dispose(); });
    } catch (e) {
      console.warn('[app-update] 一键更新初始化失败：', e && e.message);
    }
  }
  // 没有下载源的发行版也注册，界面据 available:false 只显示手动安装说明。
  require('./main/cli-tools-ipc').registerCliToolsIpc(ipcMain, { installer: cliToolsInstallerRef });
  // r58：命令行组件的下载源标识，和 installer.js installOne() 下载时查内源的版本名、文件名一致（cli-<id>-<版本>）。
  if (cliToolsInstallerRef) require('./core/app-update/download-points').register('cli:', async point => {
    const cat = await cliToolsInstallerRef.loadCatalog();
    const want = point.slice(4);
    // 配套 Node 只在本机没有可用 Node 时才会下载（installer.js 同口径），那时才一起看内源。
    let needNode = false;
    if (want === 'dsh' || want === 'pi') {
      try { needNode = !(require('./core/cli-tools/registry').managedBin('node', process.env) || require('./core/local-node').findNode({ env: process.env })); } catch (_) { needNode = false; }
    }
    const ids = needNode ? [want, 'node'] : [want];
    const items = ids.map(id => (cat.components || []).find(c => c.id === id)).filter(Boolean)
      .map(c => ({ file: c.files[0].name, release: `cli-${c.id}-${c.version}`, version: c.version }));
    return items.length ? { items } : null;
  });
}
// r58：所有下载点的「下载源：公司内源」标识（download-source:status），各组件在 core/app-update/download-points.js 登记。
require('./main/download-points-register').registerStaticDownloadPoints({});
require('./main/download-source-ipc').registerDownloadSourceIpc(ipcMain, { getOpenxRecorder: () => appUpdateControllerRef?.openxRecorder || null });
require('./main/ipc/capability-handlers').registerCapabilityIpc(ipcMain,
  capabilityService);
// 技能广场（2026-11-27，core/skill-plaza/）：员工助手技能导入 + 本机已装 + AgentCenter 一个入口。不联网。
// 隔离测试（CLAUDE_HUB_HOME_DIR）里给 CLAUDE_HUB_SKILL_PLAZA_WECLAW=1 可在没装员工助手时也扫测试 home 下的三个根目录。
let skillPlazaService = null;
try {
  skillPlazaService = new (require('./core/skill-plaza/service').SkillPlazaService)({
    dataDir: getHubDataDir(), homeDir: capabilityService.homeDir,
    findInstall: () => (process.env.CLAUDE_HUB_HOME_DIR ? process.env.CLAUDE_HUB_SKILL_PLAZA_WECLAW === '1'
      : require('./core/weclaw-link').findInstall()),
    // 默认位置找不到时逐级查卸载登记、协议登记、运行中的进程；隔离测试里不查本机真实登记
    locateInstall: opts => (process.env.CLAUDE_HUB_HOME_DIR ? Promise.resolve({ file: '' }) : require('./core/weclaw-link').locateInstall(opts)),
    catalog: refresh => capabilityService.catalog(refresh),
    // 导入、移除改了技能目录：清掉「资源 → 工具」的能力目录缓存（与 codeagent-market 安装后的做法相同）。
    invalidateCatalog: () => { capabilityService.cache = null; capabilityService.catalogGeneration++; },
    // 导入、移除真正结束时（界面可能早已不等了）通知界面刷新。
    onChanged: info => sendToRenderer('skill-plaza:changed', info),
    market: capabilityService.market,
    codeagentDir: () => capabilityService.codeagentConfigDir(),
    writeClipboard: text => clipboard.writeText(text),
    openExternal: url => shell.openExternal(url),
    openManage: () => sendToRenderer('skill-plaza:open-manage', {}),
  });
} catch (error) { console.error('[skill-plaza] 技能广场未启动：', error.message); }
require('./main/ipc/skill-plaza-handlers').registerSkillPlazaIpc(ipcMain, () => skillPlazaService);

// --- Gemini/Codex/Kimi ring-buffer usage scanner ---
// Periodically scans agent sessions' ring buffers for token/model patterns
// and emits status-event so the renderer can show context/usage badges.
const _agentLastStatus = new Map();
const _agentQuota = { gemini: null };
const _codexCliQuotaBySession = new Map();
const CODEX_CLI_USAGE_FRESH_MS = 2 * 60 * 1000;

// --- Codex JSONL-based usage scanner ---
// Codex CLI writes rate-limit snapshots to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// They are a passive fallback; manual refresh uses app-server for the selected profile.
// Each file contains token_count events with primary (5h) and secondary (7d) windows.
let _codexJsonlLastScan = 0;
let _codexJsonlCached = null;
const _codexJsonlCachedByRoot = new Map();
const CODEX_JSONL_THROTTLE_MS = 5_000;
const CODEX_JSONL_CANDIDATE_LIMIT = 20;

async function scanCodexJsonlUsage(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  try {
    const result = await codexJsonlUsageService.scan(sessionsDir, {
      minObservedAt: opts.minObservedAt || 0,
      candidateLimit: CODEX_JSONL_CANDIDATE_LIMIT,
    });
    return result.data;
  } catch {
    return null;
  }
}

async function scanCodexJsonlUsageThrottled(sessionsDir = DEFAULT_CODEX_SESSIONS_ROOT, opts = {}) {
  // A moved-in conversation can write several accounts' quotas to the original
  // history root. Persistent runtime records survive closing that conversation.
  let mixedHistory = true;
  try {
    mixedHistory = require('./core/codex-jsonl-history-guard').isManagedCodexHistoryRoot({dataDir:getHubDataDir(),sessionsRoot:sessionsDir});
  } catch { /* Unknown provenance cannot label an account quota. */ }
  if (mixedHistory) {
    const prefix = path.resolve(sessionsDir).toLowerCase() + '|';
    for (const cachedKey of _codexJsonlCachedByRoot.keys()) if (cachedKey.startsWith(prefix)) _codexJsonlCachedByRoot.delete(cachedKey);
    _codexJsonlCached = null;
    return null;
  }
  const now = Date.now();
  const key = [
    path.resolve(sessionsDir || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase(),
    Math.floor(Number(opts.minObservedAt) || 0),
  ].join('|');
  const cached = _codexJsonlCachedByRoot.get(key);
  if (!opts.force && cached && now - cached.ts < CODEX_JSONL_THROTTLE_MS) return cached.data;
  const data = await scanCodexJsonlUsage(sessionsDir, opts);
  // A runtime migration can publish its marker while the worker is reading.
  let stillAttributed = false;
  try { stillAttributed = !require('./core/codex-jsonl-history-guard').isManagedCodexHistoryRoot({dataDir:getHubDataDir(),sessionsRoot:sessionsDir}); } catch {}
  if (!stillAttributed) { _codexJsonlCachedByRoot.delete(key); _codexJsonlCached = null; return null; }
  _codexJsonlCachedByRoot.set(key, { ts: now, data });
  _codexJsonlLastScan = now;
  _codexJsonlCached = data;
  return data;
}

// Token-based rolling-window tracker for Gemini/Codex (fallback).
const AGENT_LIMITS = {
  gemini: { tokens5h: 2_000_000, tokens7d: 50_000_000 },
  codex:  { tokens5h: 1_000_000, tokens7d: 10_000_000 },
};
const _agentTokenLog = { gemini: [], codex: [] }; // [{ts, tokens}]

function agentUsageScopeKey(sessionsRoot) {
  return path.resolve(sessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT).toLowerCase();
}

function recordAgentTokens(kind, tokens, scopeKey = null) {
  if (!_agentTokenLog[kind]) return;
  _agentTokenLog[kind].push({ ts: Date.now(), tokens, scopeKey });
}

function calcAgentUsage(kind, scopeOrRoot = null) {
  const log = _agentTokenLog[kind];
  if (!log) return null;
  const now = Date.now();
  const H5 = 5 * 3600 * 1000;
  const D7 = 7 * 86400 * 1000;
  // Prune entries older than 7d
  while (log.length && log[0].ts < now - D7) log.shift();
  const scopeKey = scopeOrRoot ? agentUsageScopeKey(scopeOrRoot) : null;
  const scopedLog = scopeKey ? log.filter(e => e.scopeKey === scopeKey) : log;
  const tok5h = scopedLog.filter(e => e.ts >= now - H5).reduce((s, e) => s + e.tokens, 0);
  const tok7d = scopedLog.reduce((s, e) => s + e.tokens, 0);
  const lim = AGENT_LIMITS[kind];
  if (!lim) return null;
  if (tok5h === 0 && tok7d === 0) return null;
  return {
    usage5h: { pct: Math.min(100, Math.round(tok5h / lim.tokens5h * 100)), resetsAt: now + H5 },
    usage7d: { pct: Math.min(100, Math.round(tok7d / lim.tokens7d * 100)), resetsAt: now + D7 },
  };
}

const _agentBufferRevisions = new Map();
let _agentUsageBroadcastSignature = '';
async function scanAgentSessions(opts = {}) {
  const force = !!opts.force;
  const allSessions = sessionManager.getAllSessions();
  const liveIds = new Set(allSessions.map(s => s.id));
  for (const id of _agentBufferRevisions.keys()) if (!liveIds.has(id)) _agentBufferRevisions.delete(id);
  for (const s of allSessions) {
    if (['codex-app-server','acp'].includes(s.runtimeBackend)) continue;
    const runtimeKind = s.transcriptKind || s.kind;
    // agy reports quota via /usage; retired Gemini footer parsing is not evidence.
    if (/^gemini(?:-resume)?$/.test(runtimeKind) && require('./core/antigravity-config').isAntigravity(s)) continue;
    const isOpenAiCodex = s.kind === 'codex' || s.kind === 'codex-resume';
    if (runtimeKind !== 'gemini' && !isCodexBaseKind(runtimeKind) && !isKimiCliKind(runtimeKind)) continue;
    if (s.status === 'dormant') continue;
    const revision = sessionManager.getSessionOutputRevision?.(s.id);
    const bufferKey = revision == null ? null : `${runtimeKind}:${revision}`;
    if (!force && bufferKey !== null && _agentBufferRevisions.get(s.id) === bufferKey) continue;
    const buf = sessionManager.getSessionBuffer(s.id);
    if (!buf) continue;
    const plain = stripAnsi(buf);
    const parsed = runtimeKind === 'gemini'
      ? parseGeminiUsage(plain)
      : isKimiCliKind(runtimeKind)
        ? parseKimiUsage(plain)
        : parseCodexUsage(plain);
    if (bufferKey !== null) _agentBufferRevisions.set(s.id, bufferKey);
    if (isOpenAiCodex && (parsed.usage5h || parsed.usage7d)) {
      const usageSig = JSON.stringify({ usage5h: parsed.usage5h || null, usage7d: parsed.usage7d || null });
      const usageKey = s.id + ':codex-cli-usage';
      if (_agentLastStatus.get(usageKey) !== usageSig) {
        _agentLastStatus.set(usageKey, usageSig);
        recordCodexCliUsage(
          _codexCliQuotaBySession,
          s,
          parsed,
          Date.now(),
          DEFAULT_CODEX_SESSIONS_ROOT,
        );
      }
    }
    if (parsed.tokensUsed) {
      const prev = _agentLastStatus.get(s.id + ':tok');
      if (prev !== parsed.tokensUsed) {
        const delta = prev ? parsed.tokensUsed - prev : parsed.tokensUsed;
        const scopeKey = isOpenAiCodex
          ? agentUsageScopeKey(s.codexSessionsRoot || DEFAULT_CODEX_SESSIONS_ROOT)
          : null;
        if (delta > 0 && !(isOpenAiCodex && s.codexRuntimeHome)) recordAgentTokens(isOpenAiCodex ? 'codex' : runtimeKind, delta, scopeKey);
        _agentLastStatus.set(s.id + ':tok', parsed.tokensUsed);
      }
    }
    // Gemini quotaPct → direct sidebar usage (real API quota from CLI footer)
    if (parsed.quotaPct != null) {
      const now = Date.now();
      const H5 = 5 * 3600 * 1000;
      const usageObj = { usage5h: { pct: parsed.quotaPct, resetsAt: now + H5 }, _ts: now };
      _agentQuota.gemini = usageObj;
    }
    if (!parsed.model && !parsed.tokensUsed && parsed.contextPct == null && parsed.quotaPct == null) continue;
    const prev = _agentLastStatus.get(s.id);
    const sig = JSON.stringify(parsed);
    if (prev === sig) continue;
    _agentLastStatus.set(s.id, sig);
    const payload = { sessionId: s.id };
    if (parsed.contextPct != null) payload.contextPct = parsed.contextPct;
    if (parsed.contextUsed != null) payload.contextUsed = parsed.contextUsed;
    if (parsed.contextMax != null) payload.contextMax = parsed.contextMax;
    if (parsed.model) {
      syncSessionRuntimeModel(s.id, parsed.model);
      payload.model = parsed.model;
    }
    sendToRenderer('status-event', payload);
  }
  // 额度条、多账号页都关着（公司版）：只有开着 Codex 会话时才汇总 Codex 用量（首页「5h 配额接近耗尽」提醒要用），
  // 否则不再每 5 秒读用量缓存文件、扫 Codex 记录（2026-11-25 开销修复）。
  if (!force && !subscriptionUsageShown() && !allSessions.some(s => (s.kind === 'codex' || s.kind === 'codex-resume') && s.status !== 'dormant')) return {};
  // Expire stale CLI quota entries (no fresh CLI data for >10 min).
  const now = Date.now();
  if (_agentQuota.gemini && _agentQuota.gemini._ts && now - _agentQuota.gemini._ts > 10 * 60 * 1000) {
    _agentQuota.gemini = null;
  }
  pruneCodexCliUsage(_codexCliQuotaBySession, now, 10 * 60 * 1000);
  // Build and broadcast per-provider usage.
  // Manual app-server reads are authoritative for the selected profile. Newer
  // CLI/JSONL snapshots may supersede them only when the weekly reset boundary
  // proves they belong to the same account/window.
  const agentData = {};
  // Codex: visible `/usage` output is the freshest user-triggered source.
  // Fall back to JSONL token_count snapshots, then local token estimates.
  const codexScope = currentCodexUsageScope();
  const freshCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: CODEX_CLI_USAGE_FRESH_MS,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const cachedCodexCliUsage = selectCodexCliUsageForScope(_codexCliQuotaBySession, codexScope, {
    now,
    maxAgeMs: 10 * 60 * 1000,
    defaultSessionsRoot: DEFAULT_CODEX_SESSIONS_ROOT,
  });
  const codexJsonl = freshCodexCliUsage ? null : await scanCodexJsonlUsageThrottled(codexScope.sessionsRoot, {
    force,
    minObservedAt: codexScope.authSinceMs || 0,
  });
  if (freshCodexCliUsage) {
    const payload = { ...freshCodexCliUsage, source: 'cli-usage', observedAt: freshCodexCliUsage._ts, _ts: freshCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (codexJsonl) {
    const payload = { ...codexJsonl, source: 'jsonl', _ts: codexJsonl.observedAt || now };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else if (cachedCodexCliUsage) {
    const payload = { ...cachedCodexCliUsage, source: 'cli', observedAt: cachedCodexCliUsage._ts, _ts: cachedCodexCliUsage._ts };
    agentData.codex = attachCodexUsageScope(payload, codexScope);
    cacheAgentUsage('codex', payload, codexScope);
  } else {
    const usage = calcAgentUsage('codex', codexScope.sessionsRoot);
    if (usage) {
      const payload = { ...usage, source: 'estimate', observedAt: now, _ts: now };
      agentData.codex = attachCodexUsageScope(payload, codexScope);
      cacheAgentUsage('codex', payload, codexScope);
    } else {
      agentData.codex = attachCodexUsageScope({ usage5h: null, usage7d: null, unavailable: true }, codexScope);
    }
  }
  const inMemoryLiveForScope = _codexLiveUsage && _codexLiveUsage.scopeKey === codexScope.scopeKey
    ? expireCodexUsageWindows(_codexLiveUsage, now)
    : null;
  const diskForScope = loadUsageCacheForCurrentConfig().codex;
  const cachedLiveForScope = diskForScope && diskForScope.source === 'app-server'
    ? expireCodexUsageWindows(diskForScope, now)
    : null;
  const liveForScope = mergeCodexEntry(cachedLiveForScope, inMemoryLiveForScope, now);
  if (shouldPreferCodexLiveUsage(liveForScope, agentData.codex, now)) {
    agentData.codex = liveForScope;
    cacheAgentUsage('codex', liveForScope, codexScope);
  }
  agentData.codex = mergeCodexEntry(diskForScope, agentData.codex, now);
  // Gemini: quota from CLI footer > token estimates
  if (_agentQuota.gemini) {
    const gemData = { usage5h: _agentQuota.gemini.usage5h };
    const tokenUsage = calcAgentUsage('gemini');
    if (tokenUsage && tokenUsage.usage7d) gemData.usage7d = tokenUsage.usage7d;
    agentData.gemini = gemData;
    cacheAgentUsage('gemini', gemData);
  } else {
    const usage = calcAgentUsage('gemini');
    if (usage) { agentData.gemini = usage; cacheAgentUsage('gemini', usage); }
  }
  const broadcastSignature = JSON.stringify(agentData);
  if (Object.keys(agentData).length > 0 && (force || broadcastSignature !== _agentUsageBroadcastSignature)) {
    _agentUsageBroadcastSignature = broadcastSignature;
    sendToRenderer('agent-usage', agentData);
  }
  return agentData;
}

let _agentScanInterval = null;
let _agentScanInFlight = null;
let _deepseekBalanceRefreshInFlight = null;
let _deepseekBalanceLastAttempt = 0;
let _kimiUsageRefreshInFlight = null;
let _kimiUsageLastAttempt = 0;
let _codexUsageRefreshInFlight = null;
let _codexUsageLastAttempt = 0;
const DEEPSEEK_BALANCE_REFRESH_MS = 5 * 60 * 1000;
const KIMI_USAGE_REFRESH_MS = 5 * 60 * 1000;
const CODEX_USAGE_REFRESH_MS = 5 * 60 * 1000;

function refreshCodexUsageIfDue(force = false) {
  const now = Date.now();
  if (_codexUsageRefreshInFlight) return _codexUsageRefreshInFlight;
  if (!force && now - _codexUsageLastAttempt < CODEX_USAGE_REFRESH_MS) return null;
  _codexUsageLastAttempt = now;
  _codexUsageRefreshInFlight = refreshCodexAccountUsageLive()
    .then((codex) => {
      sendToRenderer('agent-usage', { codex });
      return codex;
    })
    .finally(() => { _codexUsageRefreshInFlight = null; });
  return _codexUsageRefreshInFlight;
}

function refreshDeepSeekBalanceIfDue(force = false) {
  const now = Date.now();
  if (_deepseekBalanceRefreshInFlight) return _deepseekBalanceRefreshInFlight;
  if (!force && now - _deepseekBalanceLastAttempt < DEEPSEEK_BALANCE_REFRESH_MS) return null;
  _deepseekBalanceLastAttempt = now;
  _deepseekBalanceRefreshInFlight = refreshDeepSeekAccountBalanceLive()
    .then((deepseek) => {
      sendToRenderer('agent-usage', { deepseek });
      return deepseek;
    })
    .catch(() => null)
    .finally(() => { _deepseekBalanceRefreshInFlight = null; });
  return _deepseekBalanceRefreshInFlight;
}

function refreshKimiUsageIfDue(force = false) {
  const now = Date.now();
  if (_kimiUsageRefreshInFlight) return _kimiUsageRefreshInFlight;
  if (!force && now - _kimiUsageLastAttempt < KIMI_USAGE_REFRESH_MS) return null;
  _kimiUsageLastAttempt = now;
  _kimiUsageRefreshInFlight = refreshKimiAccountUsageLive()
    .then((kimi) => {
      sendToRenderer('agent-usage', { kimi });
      return kimi;
    })
    .catch(() => null)
    .finally(() => { _kimiUsageRefreshInFlight = null; });
  return _kimiUsageRefreshInFlight;
}

// 订阅额度条或多账号页开着时才需要后台刷新各家订阅额度（2026-11-25 开销修复）：公司版两者都关，
// 以前这些每 5 秒的刷新照样在跑。上下文环、模型名等会话状态（scanAgentSessions 的逐会话部分）不受影响；
// DeepSeek 余额（首页低余额提醒）和 Token Plan 用量（用完自动改走 DeepSeek API）是功能本身要的，照旧刷新。
const CLAUDE_QUOTA_HINT_REFRESH_MS = 5 * 60_000;
let _claudeQuotaHintInterval = null;
function subscriptionUsageShown() {
  const distribution = require('./core/distribution');
  return distribution.featureEnabled('quotaBar') || distribution.featureEnabled('accounts');
}
function startAgentScanner() {
  if (_agentScanInterval) return;
  const usageShown = subscriptionUsageShown();
  const run = () => {
    if (usageShown && (!process.env.CLAUDE_HUB_HOME_DIR || process.env.AI_HUB_ANTIGRAVITY_COMMAND)) {
      void refreshAntigravityUsage().catch(error => console.warn('[antigravity-usage]', error.message));
    }
    if (_agentScanInFlight) return _agentScanInFlight;
    _agentScanInFlight = scanAgentSessions()
      .catch(error => console.warn('[usage-scan] failed:', error && error.message))
      .finally(() => { _agentScanInFlight = null; });
    return _agentScanInFlight;
  };
  void run();
  if (usageShown) {
    void claudeAccountRefresh.tick();
    void refreshCodexUsageIfDue(true).catch(() => null);
    refreshKimiUsageIfDue(true);
  }
  refreshDeepSeekBalanceIfDue(true);
  void refreshTokenPlanUsage().catch(() => {});
  _agentScanInterval = setInterval(() => {
    void run();
    if (usageShown) {
      void claudeAccountRefresh.tick();
      const codexRefresh = refreshCodexUsageIfDue(false);
      if (codexRefresh) void codexRefresh.catch(() => null);
      refreshKimiUsageIfDue(false);
    }
    refreshDeepSeekBalanceIfDue(false);
    // The service publishes errors in its snapshot and bounds read-only polling.
    void refreshTokenPlanUsage().catch(() => {});
  }, 5000);
  // 额度条和多账号页都关着（公司版）时，首页「Claude 5h 配额接近耗尽」提醒仍要有数：保留每 5 分钟一次的低频后台刷新，
  // 加上窗口获焦时的刷新（browser-window-focus）。单次只读一份用量，开销很小，低开销模式下也保留这一档。
  if (!usageShown && !_claudeQuotaHintInterval) {
    _claudeQuotaHintInterval = setInterval(() => { void claudeAccountRefresh.tick(); }, CLAUDE_QUOTA_HINT_REFRESH_MS);
    _claudeQuotaHintInterval.unref?.();
  }
}

app.whenReady().then(async () => {
  traceStartup('app.whenReady');
  // 继承来的 CODEAGENT3_CONFIG_DIR 采用还是忽略（core/codeagent-config.js loadInheritedDecision）：只在有继承值、且不是默认 ~/.cac 时
  // 读一次注册表（PowerShell，8 秒超时），和下面的启动工作并行；部署 CodeAgent hook 前等它出结果，之后的会话、hook、直查用同一个判定。
  const codeagentInheritedReady = (async () => {
    // 判定看的是继承来的原始环境（core/clean-launch-env.js inheritedEnv，启动自检前的那份）。
    // 判定出来后，确认不该用（落在号池里 / 注册表里没有）就从 Hub 进程环境里去掉（core/clean-launch-env.js），Hub 的终端和之后的再启动都不再带。
    try {
      const launchEnv = require('./core/clean-launch-env');
      const decision = await require('./core/codeagent-config').loadInheritedDecision({ env: launchEnv.inheritedEnv(), dataDir: getHubDataDir() });
      try { launchEnv.applyConfigDirDecision(decision, { dataDir: getHubDataDir() }); } catch (error) { console.warn('[launch-env] 去掉继承的配置目录失败：' + error.message); }
      return decision;
    }
    catch (error) { console.warn('[codeagent-config] 判定继承的配置目录失败（按忽略处理）：' + error.message); return null; }
  })();
  // Source-mode Electron has no installed exe identity of its own. Keep a
  // branded Start Menu shortcut + Jump List relaunch task bound to the Hub
  // AUMID, or Windows can cache a bare electron.exe relaunch command. Isolated
  // E2E Hubs must never touch this production Shell registration.
  if (process.platform === 'win32' && !isIsolatedHub()) {
    // 安装版：图标只能用 exe 自己内嵌的那份。claude-wx.ico 在 app.asar 里，Hub 自己读得到（健康检查照样通过），
    // Windows 资源管理器读不到，开始菜单快捷方式（任务栏按它取图标）就显示成白色文档（2026-10-09 公司真机）。
    // 2026-10-13：图标文件解包到 app.asar.unpacked（package.json asarUnpack），资源管理器读得到，
    // 一键更新也会换掉它；没有（老安装包）才退回 exe 自带的图标。
    const unpackedHubIcon = HUB_IS_PACKAGED ? path.join(process.resourcesPath, 'app.asar.unpacked', 'claude-wx.ico') : null;
    const hubIconPath = HUB_IS_PACKAGED
      ? (unpackedHubIcon && fs.existsSync(unpackedHubIcon) ? unpackedHubIcon : process.execPath)
      : path.join(__dirname, 'claude-wx.ico');
    const hubProductVersion = (() => {
      try { return require('./package.json').version || ''; } catch { return ''; }
    })();
    const brandingOptions = {
      execPath: process.execPath,
      icoPath: hubIconPath,
      productVersion: hubProductVersion,
    };

    const startShellIntegration = (execPath) => {
      const windowsShellOptions = {
        app,
        shell,
        appRoot: __dirname,
        execPath,
        isPackaged: HUB_IS_PACKAGED,
        iconPath: hubIconPath,
      };
      const shellResult = ensureWindowsShellIntegration(windowsShellOptions);
      if (shellResult.legacyBackupPath) {
        console.warn(`[windows-shell] retired broken Electron shortcut: ${shellResult.legacyBackupPath}`);
      }
      if (windowsShellWatchdog) windowsShellWatchdog.stop();
      // The canonical shortcut was observed disappearing hours after a successful
      // repair, leaving an otherwise valid .ico rendered as Windows' white-page
      // placeholder. Re-check the tiny Shell Link every 15s and repair drift.
      windowsShellWatchdog = startWindowsShellIntegrationWatchdog({
        ...windowsShellOptions,
        // 每一拍无条件重贴窗口图标：Explorer 重启丢 HICON 时快捷方式是好的，
        // 健康检查不会失败，onRepair 不会触发（详见 reassertHubWindowIcon 注释）。
        onTick: reassertHubWindowIcon,
        onRepair: reassertHubWindowIcon,
      });
      return windowsShellOptions.execPath;
    };

    // 快捷方式先指向当前可用的启动器：品牌化副本在就用它，不在就回落 electron.exe。
    let hubLaunchExePath = startShellIntegration(HUB_IS_PACKAGED ? process.execPath : resolveHubLaunchExePath(brandingOptions));

    // 安装版：一键更新换了图标、exe 还是旧的 —— 把开始菜单、桌面、任务栏固定项里指向本程序的快捷方式图标改指向新图标。
    if (HUB_IS_PACKAGED && hubIconPath !== process.execPath && !isIsolatedHub()) {   // 隔离测试实例不碰真实快捷方式（复审补点）
      try {
        const { refreshPackagedShortcutIcons, getShortcutPaths } = require('./core/windows-shell-integration');
        const changed = refreshPackagedShortcutIcons({
          shell, execPath: process.execPath, iconPath: hubIconPath,
          shortcutFiles: [getShortcutPaths({ app }).shortcutPath],
          dirs: [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')],
        });
        if (changed.length) {
          console.log(`[windows-shell] 快捷方式换成新图标：${changed.map(f => path.basename(f)).join('、')}`);
          // 让资源管理器刷新图标缓存，任务栏不用等重新登录。
          const ie4uinit = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe');
          if (fs.existsSync(ie4uinit)) spawn(ie4uinit, ['-show'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
      } catch (error) {
        console.warn('[windows-shell] 快捷方式图标更新失败：', error.message);
      }
    }

    // 发行版的免安装包（zip 解压即用）第一次打开时在桌面建快捷方式（core/portable-desktop-shortcut.js）。
    // 隔离的测试实例（发版验收会启动免安装包）不碰真实桌面。
    if (HUB_IS_PACKAGED && require('./core/distribution').community && !isIsolatedHub()) {
      try {
        const r = require('./core/portable-desktop-shortcut').ensurePortableDesktopShortcut({
          shell, execPath: process.execPath, desktopDir: app.getPath('desktop'), dataDir: getHubDataDir(),
          name: require('./core/distribution').productName, iconPath: hubIconPath !== process.execPath ? hubIconPath : '',
        });
        if (r.action !== 'skipped') console.log(`[portable-shortcut] ${r.action}：${r.linkPath}`);
      } catch (error) {
        console.warn('[portable-shortcut] 桌面快捷方式没建成：', error.message);
      }
    }

    // 品牌化副本缺失或过期时后台重建。electron.exe 220MB+，读+改资源+写一整遍
    // 要好几秒，绝不能在主进程同步跑；用 ELECTRON_RUN_AS_NODE 起子进程。
    // 只新增/替换 AIHubCommunity.exe，永不触碰 electron.exe（node_modules 完整性铁律）。
    // 安装版的 exe 在打包时已经换好图标和版本信息，不需要（也做不到：脚本和 resedit 都在 app.asar 里）运行时品牌化。
    const brandingState = HUB_IS_PACKAGED ? { healthy: true } : describeBrandingHealth(brandingOptions);
    if (!brandingState.healthy && brandingState.expected) {
      console.log(`[hub-brand] ${brandingState.message}，后台重建中`);
      const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'brand-hub-exe.js')], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let childLog = '';
      child.stdout.on('data', d => { childLog += d.toString(); });
      child.stderr.on('data', d => { childLog += d.toString(); });
      child.on('error', err => console.warn(`[hub-brand] spawn 失败：${err.message}`));
      child.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[hub-brand] 重建失败 (exit ${code})，快捷方式继续用 electron.exe\n${childLog.trim()}`);
          return;
        }
        const rebuiltExePath = resolveHubLaunchExePath(brandingOptions);
        if (rebuiltExePath === hubLaunchExePath) return;
        // 重建成功：把快捷方式和 Jump List 重指到品牌化 exe。下次从桌面启动，
        // 窗口类图标就是橙色 logo，Explorer 再怎么重建任务栏都摸不到 Electron 原子。
        hubLaunchExePath = startShellIntegration(rebuiltExePath);
        console.log(`[hub-brand] 已重建并重指快捷方式：${rebuiltExePath}`);
      });
      child.unref();
    }
  }
  const _home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  // Isolated E2E must not mutate or poll production ~/.claude settings. Real
  // Claude integration tests provide their own config explicitly; ordinary
  // renderer/PTY tests need no hook deployment at all.
  // 端到端测试可以在完全伪造的 home 里部署 hook（CLAUDE_HUB_HOME_DIR 必须就是当前 home）。
  const e2eFakeHome = process.env.CLAUDE_HUB_E2E_FAKE_HOME === '1' && !!process.env.CLAUDE_HUB_HOME_DIR
    && path.resolve(process.env.CLAUDE_HUB_HOME_DIR).toLowerCase() === path.resolve(_home).toLowerCase();
  const claudeDirs = isIsolatedHub() && !e2eFakeHome
    ? []
    : ['.claude', '.claude-deepseek'].map(dir => path.join(_home, dir))
      .filter((dir, index) => index === 0 || fs.existsSync(dir));
  const hookSourceScriptsDir = HUB_IS_PACKAGED
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');
  traceStartup('deploy hooks start');
  // 2026-05-05 maintainer：所有 Claude family 隔离配置目录都必须部署 Stop hook，否则
  //   该家族 sub session 完成时 CC 不调 hook → notifyClaudeStop 永不触发 →
  //   ClaudeTap.JsonlTail 永不启动 → stop_reason 主路径 + idle 兜底全失效 →
  //   群聊卡片自动同步死，只能等 5min 硬 timeout 或用户手动点提取。
  //   scripts/session-hub-hook.py 也不存在。与 findTranscriptByCCSessionId 的
  //   candidateRoots 列表对齐，单一真理源应在 ai-kinds.js（后续可重构）。
  // 账号对齐（2026-10-24）：独立账号目录先按主账号同步设置/技能/插件/MCP，再装 hook。
  if (!isIsolatedHub()) for (const dir of claudeProfileHookDirs()) alignClaudeProfileDir(dir);
  for (const claudeDir of claudeDirs) ensureHooksDeployed(claudeDir);
  // 会话启动前再补一次：运行中新加的账号目录也能当场装上。隔离 Hub 不碰真实账号目录。
  sessionManager.deployClaudeProfileHooks = (dir, { managed = false } = {}) => {
    if (managed) {
      // Managed runtimes keep their own settings/history; inherit only completed
      // onboarding so new accounts and previously stranded runtimes behave alike.
      const home = process.env.CLAUDE_HUB_HOME_DIR || process.env.USERPROFILE || process.env.HOME || os.homedir();
      require('./core/claude-profile-align').alignClaudeOnboarding({
        primaryStateFile: path.join(home, '.claude.json'), profileDir: dir });
      ensureHooksDeployed(dir);
    }
    else if (!isIsolatedHub()) { alignClaudeProfileDir(dir); ensureHooksDeployed(dir); }
  };
  // 公司 Code Agent（Claude 形态，core/codeagent-config.js）：配置目录已存在才部署，不凭空创建 ~/.cac。
  // 隔离 Hub 只在测试显式指定了它的配置目录时部署，绝不碰真实 home。
  const codeagentHookTargets = [];
  try {
    await codeagentInheritedReady;
    const codeagentConfig = require('./core/codeagent-config').resolveCodeAgentConfig(process.env);
    // 继承来的配置目录采用 / 忽略都在日志里记一笔（不写路径）；放到下一轮事件循环，不占启动时间
    setImmediate(() => {
      try {
        const startEnv = require('./core/clean-launch-env').inheritedEnv();
        const inherited = require('./core/codeagent-config').inheritedConfigDirInfo(startEnv, undefined, { dataDir: getHubDataDir() });
        if (inherited) console.warn(`[codeagent-config] ${inherited.note}（变量 ${inherited.variable}，来源 ${inherited.origin}，${inherited.inPool ? '它落在号池目录里' : '它不在号池目录里'}）；个人账号目录来源：${require('./core/codeagent-config').configDirSource(startEnv)}`);
      } catch (error) { console.warn('[codeagent-config] 核对继承的配置目录失败：' + error.message); }
    });
    const allowed = isIsolatedHub() ? !!process.env.AI_HUB_CODEAGENT_CONFIG_DIR : true;
    require('./core/codeagent-bundled-skills').syncCompanyTeamSkills({
      dataDir: getHubDataDir(), personalDir: allowed ? codeagentConfig.configDir : null,
    });
    if (allowed && fs.existsSync(codeagentConfig.configDir)) {
      // choiceGateMatcher：自动派活会话拒绝提问工具的 hook（core/auto-dispatch-rules.js，可关）。
      const settingsOptions = { events: require('./core/codeagent-config').HOOK_EVENTS,
        manageStatusLine: false, managePermissionMode: false, choiceGateMatcher: require('./core/auto-dispatch-rules').gateMatcher() };
      const result = ensureClaudeHookIntegration({ claudeDir: codeagentConfig.configDir,
        sourceScriptsDir: hookSourceScriptsDir, logger: console, settingsOptions });
      if (result.errors.length) console.warn(`[codeagent-hooks] ${codeagentConfig.configDir}: ${result.errors.join('；')}`);
      codeagentHookTargets.push({ dir: codeagentConfig.configDir, settingsOptions });
      // 个人账号默认模型的留痕（2026-10-19）：settings.json 的 model 每变一次记一行来源，只看不改。
      // 只读文件、只写 Hub 自己的日志，不碰账号配置；AI_HUB_CODEAGENT_SETTINGS_WATCH=0 可关。
      if (process.env.AI_HUB_CODEAGENT_SETTINGS_WATCH !== '0') try { codeagentSettingsWatch = require('./core/codeagent-default-model-guard').watchPersonal({ dataDir: getHubDataDir(), dir: codeagentConfig.configDir }); }
      catch (error) { console.warn('[codeagent-default-model] 看护没启动：' + error.message); }
    }
  } catch (error) { console.warn('[codeagent-hooks] skipped:', error.message); }
  // CodeAgent 号池（core/codeagent-pool.js）：每个号的配置目录在启动会话前按同样方式部署 Hub 的 hook。
  sessionManager.deployCodeAgentHooks = dir => {
    const result = ensureClaudeHookIntegration({ claudeDir: dir, sourceScriptsDir: hookSourceScriptsDir, logger: console,
      settingsOptions: { events: require('./core/codeagent-config').HOOK_EVENTS, manageStatusLine: false, managePermissionMode: false,
        choiceGateMatcher: require('./core/auto-dispatch-rules').gateMatcher() } });
    if (result.errors.length) throw new Error(result.errors.join('；'));
  };
  // settings.json can be rewritten by Claude settings/plugin changes while the
  // Hub keeps running. A one-time boot merge is therefore insufficient: the
  // screenshot incident had UserPromptSubmit=[] and no Hub Stop hook five
  // hours after launch. Periodically repair only Hub-owned entries.
  if (claudeDirs.length || codeagentHookTargets.length) {
    claudeHookWatchdog = startClaudeHookIntegrationWatchdog({
      claudeDirs: [...claudeDirs, ...codeagentHookTargets],
      sourceScriptsDir: hookSourceScriptsDir,
      logger: console,
    });
  }
  traceStartup('deploy hooks done');
  // file-scope-guard hook 被中断/硬杀留下的 file-claims.json.tmp.<pid> 孤儿（只收 1 小时前的）。
  try {
    const tmpCleanup = cleanupFileClaimsTmp(getHubDataDir());
    if (tmpCleanup.removed) console.log(`[群聊] 清理 file-claims 临时文件孤儿 ${tmpCleanup.removed} 个`);
    if (tmpCleanup.errors.length) console.warn(`[群聊] file-claims 临时文件清理部分失败：${tmpCleanup.errors.slice(0, 3).join('；')}`);
  } catch (error) {
    console.warn('[群聊] file-claims 临时文件清理失败:', error && error.message);
  }
  traceStartup('codex config start');
  ensureCodexContextConfig();
  traceStartup('codex config done');
  traceStartup('gemini mcp install start');
  ensureGeminiMcpInstalled();
  traceStartup('gemini mcp install done');
  try {
    hangStackOptIn = require('./core/renderer-crash-recovery.js').installHangStackOptIn({
      protocol, net, indexPath: path.join(__dirname, 'renderer', 'index.html'),
    });
    hangStackOptIn?.arm();
  } catch (error) { console.warn('[window] hang-stack opt-in failed:', error && error.message); }
  traceStartup('createWindow start');
  createWindow();
  traceStartup('createWindow done');
  traceStartup('hook listen start');
  hookPort = await listenWithFallback();
  if (hookPort) {
    console.log(`[群聊] hook server listening on 127.0.0.1:${hookPort}`);
    sessionManager.hookPort = hookPort;
  } else {
    console.warn('[群聊] hook server failed to bind — falling back to silence detection');
  }
  traceStartup(`hook listen done (${hookPort || 'none'})`);
  sendToRenderer('hook-status', { up: hookPort !== null, port: hookPort, message: fallbackMessage(hookBinding) });

  // 2026-05-16 maintainer：写 per-PID 控制文件（含 hookPort + cdpPort + HOOK_TOKEN）。
  //   救援脚本 tools/hub-escape.ps1 通过 <dataDir>/control/<pid>.json 发现 Hub
  //   端口和 token。CDP 端口从 <userData>/DevToolsActivePort 读取（Chromium 写入）。
  try {
    const dataDir = getHubDataDir();
    let cdpPort = null;
    if (process.env.CLAUDE_HUB_NO_CDP !== '1') {
      // Chromium 只在 --remote-debugging-port=0（OS 自动分配）时才写 DevToolsActivePort 文件；
      // 当 CLI 已传明确端口（E2E hub-launcher 场景）时直接从 argv 解析。
      if (_hasCdpSwitch) {
        const m = process.argv.find(a => a.startsWith('--remote-debugging-port='));
        if (m) {
          const p = parseInt(m.split('=')[1], 10);
          if (!isNaN(p) && p > 0) cdpPort = p;
        }
      } else {
        cdpPort = await hubControl.readDevToolsActivePort(app.getPath('userData'));
        if (!cdpPort) console.warn('[hub-control] DevToolsActivePort not ready within 3s — CDP backdoor may be unreachable');
      }
    }
    const removed = hubControl.cleanStale(dataDir);
    if (removed.length) console.log(`[hub-control] cleaned stale entries for pids: ${removed.join(', ')}`);
    hubControl.writeControlFile({
      pid: process.pid,
      hookPort,
      cdpPort,
      token: HOOK_TOKEN,
      dataDir,
      startedAt: Date.now(),
      nativeOwnershipVersion: 1,
      sessionExclusiveVersion: 1,
    });
    console.log(`[hub-control] control file written: pid=${process.pid} hookPort=${hookPort} cdpPort=${cdpPort}`);
  } catch (e) {
    console.warn('[hub-control] init failed:', e.message);
  }
  // 多开提示（体验 7）：已经有一个 Hub 在跑时问「切过去？」。不等它，启动照常往下走；隔离测试实例默认不问。
  if (!isIsolatedHub() || process.env.CLAUDE_HUB_MULTI_OPEN_PROMPT === '1') {
    void require('./core/hub-instance-prompt').promptIfAnotherHubRunning({
      dataDir: getHubDataDir(),
      enabled: () => optionalFeatures.get('multiOpen'),
      setSuppressed: () => { optionalFeatures.set('multiOpen', false); sendToRenderer('optional-features:changed', optionalFeatureList()); },
      showMessageBox: options => {
        // 隔离端到端测试：原生弹窗会真的出现在桌面上，按环境变量自动作答（0=切过去，1=再开一个），只记日志。
        const answer = isIsolatedHub() ? process.env.CLAUDE_HUB_MULTI_OPEN_PROMPT_ANSWER : '';
        if (answer === '0' || answer === '1') {
          console.log(`[multi-open] (测试自动作答 ${answer}) ${options.message} | ${options.detail.replace(/\s+/g, ' ')} | 按钮 ${options.buttons.join('/')}`);
          return Promise.resolve({ response: Number(answer), checkboxChecked: false });
        }
        return mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
      },
      quit: () => app.quit(),
    }).then(result => {
      if (result.action !== 'switch-failed') return;
      const options = { type: 'info', title: 'AI Hub', message: '没能切过去', detail: '已开的那个 Hub 没有响应，这个窗口照常可用。', buttons: ['知道了'], noLink: true };
      return mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
    }).catch(error => console.warn('[multi-open] 提示失败：', error && error.message));
  }

  traceStartup('startAgentScanner');
  startAgentScanner();
  sessionAutoSuspendScheduler.start();
});

let shutdownDrainState = 'idle';
let shutdownDrainPromise = null;
let finalShutdownCleanupDone = false;
let hookServerClosedForShutdown = false;

function closeHookServerForShutdown() {
  if (hookServerClosedForShutdown) return;
  hookServerClosedForShutdown = true;
  try { hookServer.close(); } catch (error) {
    console.warn('[shutdown] hook server close failed:', error && error.message);
  }
}

async function runFinalShutdownCleanup() {
  if (finalShutdownCleanupDone) return { clean: true, errors: [] };
  finalShutdownCleanupDone = true;
  const errors = [];
  const capture = (label, action) => {
    try { action(); }
    catch (error) { errors.push({ label, message: error && error.message ? error.message : String(error) }); }
  };
  const captureAsync = async (label, action) => {
    try { await action(); }
    catch (error) { errors.push({ label, message: error && error.message ? error.message : String(error) }); }
  };
  // These services must remain usable if a renderer cancels app.quit(). Await
  // asynchronous stops here rather than starting a stop/restart race on veto.
  capture('model-creation-confirmation', () => sessionModelCreationConfirmation.cancelAll());
  await captureAsync('lan-pool', () => lanPoolService.stop());
  await captureAsync('company-proxy', () => companyProxyService.stop());
  await captureAsync('company-forum-edge', () => companyForumEdge?.close());
  capture('account-center-pump', () => accountCenter.stopPump());
  capture('account-center-adapter', () => accountCenter.adapter.dispose?.());
  capture('hub-accounts', () => hubAccountsService.stopAuto());
  capture('desktop-notification', () => desktopNotificationController?.dispose());
  desktopNotificationController = null;
  capture('hub-pet', () => hubPetController?.dispose());
  hubPetController = null;
  capture('completion-notifier', () => completionNotifier.dispose());
  capture('session-auto-suspend', () => sessionAutoSuspendScheduler?.stop());
  capture('low-overhead', () => lowOverheadController?.stop());
  capture('claude-hook-watchdog', () => claudeHookWatchdog?.stop());
  capture('codeagent-settings-watch', () => codeagentSettingsWatch?.stop());
  claudeHookWatchdog = null;
  capture('windows-shell-watchdog', () => windowsShellWatchdog?.stop());
  windowsShellWatchdog = null;
  capture('terminal-output-batcher', () => terminalOutputBatcher.dispose({ flush: true }));
  capture('dev-workbench', () => devWorkbench?.dispose());
  capture('progress-cards', () => progressCards?.stop());
  capture('hub-assistant', () => assistantService?.close());
  capture('web-roundtable', () => webRoundtable?.dispose());
  capture('web-sessions', () => webSessions?.dispose());
  capture('company-assistant', () => companyAssistantService?.close());
  capture('company-ai', () => companyAiTasks?.close());
  capture('company-web-ai', () => companyWebAi?.close());
  capture('company-forum', () => { companyForumService?.close(); companyForumBrowser?.close(); });
  capture('company-attendance', () => { companyAttendanceService?.close(); if (companyAttendanceBrowser !== companyForumBrowser) companyAttendanceBrowser?.close(); });
  capture('company-w3', () => { companyW3Service?.close(); companyW3Browser?.close(); require('./main/company-edge-capture').killAll(); require('./main/openx-download-recorder').killAll(); });
  capture('hub-orchestration', () => global.__orchestrationService?.stop());
  capture('hub-team', () => global.__teamService?.stop());
  capture('hub-phone', () => phoneService?.close());
  clearTimeout(sessionSearchPrewarmTimer);
  const workerResults = await Promise.allSettled([
    transcriptParserService.close(),
    sessionSearchService.close(),
    codexJsonlUsageService.close(),
  ]);
  workerResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push({
        label: ['transcript-parser', 'session-search', 'codex-usage'][index],
        message: result.reason && result.reason.message ? result.reason.message : String(result.reason),
      });
    }
  });
  capture('dev-chat-history', () => { clearInterval(devChatHistoryTimer); nativeGroupContent.dispose(); nativeItemNotifications.dispose(); devChatHistory.dispose(); });
  capture('session-token-usage', () => sessionUsageService.dispose());
  capture('token-usage', () => tokenUsage.dispose());
  capture('transcript-tap', () => transcriptTap.dispose());
  // 原生投研 PTY 的全局租约属于 Hub 进程生命周期。退出时同步释放，
  // 让另一台/另一个 Hub 可以立即恢复同一个 native session；崩溃场景
  // 仍由 registry 的过期租约兜底。
  if (xresearchBridge && typeof xresearchBridge.releaseAllOwnership === 'function') {
    capture('xresearch-ownership', () => xresearchBridge.releaseAllOwnership());
  }
  if (agentLeagueBridge && typeof agentLeagueBridge.stopScheduler === 'function') {
    capture('agent-league-scheduler', () => agentLeagueBridge.stopScheduler());
  }
  // 2026-05-07 maintainer：退出时保证三层都同步落盘——state.json（lock + merge）、
  //   per-meeting JSON、per-session JSON。任意一层丢了，下次 boot 的 selfHeal
  //   都能从另一层恢复。
  capture('usage-cache', () => flushUsageCacheSync());
  try {
    meetingStore.flushAll();
    console.log('[群聊] meeting-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'meeting-store', message: err && err.message ? err.message : String(err) });
    console.warn('[群聊] meeting-store flush failed:', err.message);
  }
  try {
    // 先等在途的异步保存结束再写最终快照（core/session-store.js flushAll）。
    await sessionStore.flushAll();
    console.log('[hub] session-store flushed on quit');
  } catch (err) {
    errors.push({ label: 'session-store', message: err && err.message ? err.message : String(err) });
    console.warn('[hub] session-store flush failed:', err.message);
  }

  const clean = errors.length === 0;
  try {
    stateStore.save({ version: 1, cleanShutdown: clean, sessions: lastPersistedSessions, meetings: meetingManager.getAllMeetings(), immersiveByMeeting: _immersiveByMeeting }, { sync: true });
  } catch (error) {
    errors.push({ label: 'state-store', message: error && error.message ? error.message : String(error) });
  }

  // 2026-05-16 maintainer：清理自己的控制文件。unlinkSelf 内部已 try/catch + warn 非 ENOENT 错误，
  // 不外抛，所以这里裸调即可，不再加外层 catch（避免盖住内部 warn）。
  capture('hub-control', () => hubControl.unlinkSelf(getHubDataDir(), process.pid));
  if (errors.length) {
    finalShutdownCleanupDone = false;
    console.error('[shutdown] cleanup completed with errors:', errors);
  }
  return { clean: errors.length === 0, errors };
}

function restoreWindowAfterFailedShutdown(reason = '') {
  trayController?.resetQuitting();
  // 点「立即重启」后退出被取消（r43）：一键更新回到「已下载好」，替换脚本和进度小窗随之结束，不再停在第 1 步干等。
  // 公司版「立即重启」经等待重启的关口（gate）：同时放开它，不然 3 分钟内再点「立即重启」会被当成「已在重启中」悄悄吞掉。
  try { appUpdateControllerRef?.applyCancelled?.(reason); } catch (error) { console.warn('[shutdown] app-update cancel failed:', error && error.message); }
  try { Promise.resolve(companyHubAdmin()?.quitCancelled?.(reason)).catch(error => console.warn('[shutdown] restart gate cancel failed:', error && error.message)); } catch (error) { console.warn('[shutdown] restart gate cancel failed:', error && error.message); }
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (process.env.CLAUDE_HUB_E2E_WINDOW_MODE !== 'hidden') {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (error) {
    console.error('[shutdown] failed to preserve a retryable Hub window:', error && error.message);
  }
}

// The renderer throttles persist-sessions (up to 2 s), so its newest workscene
// may not have reached Main yet. Ask for it and wait for the acknowledgement:
// the renderer sends persist-sessions first and the ack second, and Main
// handles one renderer's messages in order, so the ack proves the workscene
// is in lastPersistedSessions. Without waiting, a close with no live PTY
// drained at once and the final save could beat the reply.
function flushRendererWorkscene(timeoutMs = 1500) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise(resolve => {
    let timer = null;
    const onAck = (_event, ackId) => { if (ackId === requestId) finish(true); };
    const finish = ok => {
      clearTimeout(timer);
      ipcMain.removeListener('hub:flush-workscene:done', onAck);
      resolve(ok);
    };
    timer = setTimeout(() => {
      console.warn('[shutdown] renderer did not confirm the final workscene; saving the last one received');
      finish(false);
    }, timeoutMs);
    ipcMain.on('hub:flush-workscene:done', onAck);
    try { mainWindow.webContents.send('hub:flush-workscene', { requestId }); }
    catch { finish(false); }
  });
}

// A renderer can refuse close while a recording is being saved. Confirm that
// every window has actually closed before terminating sessions or closing the
// databases; otherwise an update retry would read a database already closed by
// the cancelled quit. Leave the main window until last when another window
// refuses, so its workscene remains visible.
async function closeWindowsForShutdown(timeoutMs = 5000) {
  shutdownDrainState = 'closing-windows';
  // Desktop overlays have no unsaved content and are owned by their existing
  // final cleanup. Closing a pet early would leave it started without a window
  // if a content window subsequently refuses to quit.
  const overlays = new Set([...(hubPetController?.getWindows?.() || []), desktopNotificationController?.getWindow?.()]);
  const windows = BrowserWindow.getAllWindows().filter(win => !overlays.has(win))
    .sort((a, b) => Number(a === mainWindow) - Number(b === mainWindow));
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    const contents = win.webContents;
    await new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        win.removeListener('closed', closed);
        contents?.removeListener('will-prevent-unload', prevented);
        error ? reject(error) : resolve();
      };
      const closed = () => finish();
      const prevented = () => finish(new Error('窗口还有未保存的内容，已取消退出；请完成保存后再试'));
      win.once('closed', closed);
      contents?.once('will-prevent-unload', prevented);
      timer = setTimeout(() => finish(new Error('窗口未能关闭，已取消退出；请关闭窗口后再试')), timeoutMs);
      try { win.close(); } catch (error) { finish(error); }
    });
  }
  shutdownDrainState = 'draining';
}

function beginGracefulHubShutdown(reason, { beforeQuit } = {}) {
  if (shutdownDrainPromise) return shutdownDrainPromise;

  shutdownDrainState = 'draining';
  global.__deliveryEngine?.freeze(); global.__squadEngine?.freeze();
  global.__orchestrationService?.freeze(); global.__teamService?.freeze();
  console.log(`[shutdown] draining PTYs before Electron teardown (${reason})`);
  shutdownDrainPromise = flushRendererWorkscene()
    .then(() => closeWindowsForShutdown())
    .then(() => {
      // Do not hand off tasks until windows accept closing. Active tasks remain
      // durable/orphan-recoverable while their PTY exit callbacks settle.
      if (agentLeagueBridge && typeof agentLeagueBridge.beginHandoff === 'function') {
        try { agentLeagueBridge.beginHandoff(reason); }
        catch (error) { console.warn('[shutdown] agent league handoff preparation failed:', error && error.message); }
      }
      return sessionManager.disposeGracefully({ logger: console, warnAfterMs: 5000, drainTimeoutMs: 15_000 });
    })
    .then(async (result) => {
      if (!result || result.safeToQuit !== true) {
        shutdownDrainState = 'idle';
        shutdownDrainPromise = null;
        console.error('[shutdown] PTY drain did not reach a safe state; close was cancelled and may be retried', result);
        restoreWindowAfterFailedShutdown('有会话没能安全收尾');
        global.__deliveryEngine?.startWatching(); global.__orchestrationService?.unfreeze(); global.__teamService?.unfreeze();
        return result;
      }
      closeHookServerForShutdown();
      const cleanup = await runFinalShutdownCleanup();
      global.__deliveryEngine?.dispose();
      if (beforeQuit) {
        if (!cleanup.clean) throw new Error('最终保存或后台进程退出失败，已取消重启');
        await beforeQuit();
      }
      process.__hubShutdownCleanupClean = cleanup.clean === true;
      shutdownDrainState = 'drained';
      console.log(`[shutdown] PTY drain complete: ${result.drainedPtyCount} session(s), ${result.durationMs}ms`);
      if (!cleanup.clean) console.error('[shutdown] exiting with cleanShutdown=false because cleanup reported errors');
      // 2026-10-18：先让 V8 内存池「刚排过归还任务」，并给后台线程一点时间跑完，
      // 免得销毁 isolate 时再排任务、撞上 Node 平台关闭（0x80000003，见 core/v8-exit-guard.js）。
      const v8Prime = primeV8MemoryPoolForExit();
      if (!v8Prime.ok) console.warn('[shutdown] V8 memory-pool prime skipped:', v8Prime.error);
      await new Promise(resolve => setTimeout(resolve, 80));
      // Re-enter app.quit only after every node-pty onExit callback completed
      // while the Node environment was still alive.
      app.quit();
      return { ...result, cleanup };
    })
    .catch((error) => {
      shutdownDrainState = 'idle';
      shutdownDrainPromise = null;
      console.error('[shutdown] PTY drain failed; refusing unsafe Electron teardown:', error && error.stack || error);
      restoreWindowAfterFailedShutdown(error && error.message ? error.message : '');
      global.__deliveryEngine?.startWatching(); global.__orchestrationService?.unfreeze(); global.__teamService?.unfreeze();
      return { safeToQuit: false, error: error && error.message ? error.message : String(error) };
    });
  return shutdownDrainPromise;
}

app.on('before-quit', (event) => {
  trayController?.markQuitting();
  if (shutdownDrainState === 'drained' || shutdownDrainState === 'finalizing') {
    shutdownDrainState = 'finalizing';
    return;
  }
  event.preventDefault();
  void beginGracefulHubShutdown('before-quit');
});

app.on('window-all-closed', () => {
  void beginGracefulHubShutdown('window-all-closed');
});

// 'quit' 是原生收尾前最后一个能跑 JS 的点：再刷新一次 V8 内存池的计时，覆盖「前一次刷新后、
// 原生收尾前恰好过期」的窄窗口（core/v8-exit-guard.js）。
app.on('quit', () => {
  try { primeV8MemoryPoolForExit(); } catch (_) {}
});
// Windows 分层 Job Object 收尾放在全部 will-quit 之后（quit 晚于所有 will-quit，包括 whenReady 里后注册的那些）：
// 共享 serve、临时 serve、子进程登记都收完了，再关 broker、清表并设终态屏障；盒子句柄随 Hub 进程退出由内核关闭。
app.on('quit', () => { try { win32JobQos.shutdownSync(); } catch (_) {} });
