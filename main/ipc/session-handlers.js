'use strict';

const { planSessionFork } = require('../../core/session-fork-plan.js');
const {
  buildSessionResumeMeta,
  nativeSessionIdentity,
  runtimeKindForSession,
  sessionModelId,
  supportsRecoverableSession,
} = require('../../core/session-capabilities.js');
const {
  isClaudeModelSelection,
  isCodexConversationModelId,
} = require('../../core/model-options.js');
const {
  captureClaudeModelPreference,
  restoreClaudeModelPreference,
} = require('../../core/claude-model-preference-guard.js');

const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function isSafeNativeSessionId(value) {
  return typeof value === 'string' && NATIVE_SESSION_ID_RE.test(value);
}

// 旧 PTY 的退出回调把会话从 SessionManager 里删掉，才算收尾完成（归属已释放）。
function waitForSessionGone(sessionManager, sessionId, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    // 过渡中的会话（CodeAgent-Lite 改回终端）getSession 仍有值，这里只看真实的会话对象是否已退出。
    const live = () => (typeof sessionManager.hasLiveSession === 'function' ? sessionManager.hasLiveSession(sessionId) : !!sessionManager.getSession(sessionId));
    const check = () => {
      if (!live()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function registerSessionIpc(ipcMain, deps) {
  const {
    app = null,
    registerSessionForTap = () => {},
    sendToRenderer,
    sessionManager,
    meetingManager,
    workspaceService,
    resumeSession,
    getTerminalOutputBatchStats = () => null,
    getPersistedSessions = () => [],
    ensureLaunchAuth,
    prepareLaunchAuth,
    requestModelConfirmation,
    cancelModelConfirmation,
    // 登录窗口打开后多久看一次凭证（单测可缩短）；获取模型权限的实现（单测可替换）。
    codeagentLoginPollMs = 3000,
    codeagentProbeModels = null,
    codeagentCommandVersionProbe = null,
    // 经 CodeAgent serve 读模型清单与额度的实现（单测可替换，core/codeagent-serve.js readAccount）
    codeagentServeRead = null,
    codeagentQuotaNow = Date.now,
    // 开 Hub 后多久在后台补读模型清单（单测可缩短）
    codeagentStartupProbeMs = 20000,
  } = deps;
  require('./codex-backstage-handlers').registerCodexBackstageIpc(ipcMain, { sessionManager });
  require('./session-export-handlers').registerSessionExportIpc(ipcMain);
  require('../../core/codex-fast-command').registerCodexSpeedIpc(ipcMain,{sessionManager,sendToRenderer});
  ipcMain.on('hub:ui-theme', (_event, theme) => sessionManager.setPresentationTheme?.(theme));

  const lastResizeBySid = new Map();
  ipcMain.handle('hub:feedback-ping', () => ({ok:true}));
  ipcMain.handle('session:open-status', (_event, sessionId, options = {}) => {
    const owner = sessionManager._openOwners?.()?.owner(sessionId, true);
    // 本 Hub 的预约允许普通重复选择；显式重试另由 resume-session:status 判断。
    if (!owner || owner.pid === process.pid) {
      // 重选时核对运行表：进程已启动但原回包尚未完成时，直接接回已有会话。
      const live = options.reconcile ? sessionManager.getSession(sessionId) : null;
      if (live) sendToRenderer('session-created', { session: live });
      return {available:true};
    }
    return {available:false, message:require('../../core/session-open-ownership').occupied(owner).message};
  });
  const claudeModelPreferenceGuards = new Map();
  let claudeFastQueue = Promise.resolve();

  ipcMain.handle('session:set-fast', (_event, payload = {}) => {
    const task = async () => {
      const {sessionId,enabled} = payload;
      const session = sessionManager.getSession(sessionId);
      if (typeof enabled !== 'boolean' || !session) return {ok:false,message:'会话或速度设置无效'};
      const {claudeSupportsFast,pendingSpeedSwitches} = require('../../core/session-speed');
      // A connected native engine already said whether it serves Fast. Trusting
      // only the model table would refuse to turn Fast back off on a model the
      // table does not know yet.
      const engineServesFast = session.nativeRuntime?.fastMode === true;
      if (String(session.kind).replace(/-resume$/, '') !== 'claude'
          || !(claudeSupportsFast(session.currentModel?.id) || engineServesFast)) {
        return {ok:false,message:'当前 Claude 型号未确认支持 Fast，请先选择明确的受支持型号'};
      }
      if (require('../../core/session-runtime-truth').sessionRuntimeIsActive(session) || session.status === 'running' || session.autonomous || process.env.CLAUDE_HUB_NO_FAST === '1') {
        return {ok:false,message:'请在会话空闲且允许 Fast 时切换'};
      }
      // Native sessions carry a protocol control for this. They have no
      // terminal to type `/fast` into, and apply_flag_settings never touches
      // the user's settings files, so the restore dance below is not needed.
      const nativeClaude = sessionManager.getNativeClaude?.(sessionId);
      if (nativeClaude) {
        pendingSpeedSwitches.add(sessionId);
        try {
          const result = await nativeClaude.setFastMode(enabled);
          const updated = sessionManager.updateSessionMeta(sessionId,{fastMode:enabled});
          if (!updated) return {ok:false,message:'Claude 已切换，但会话信息保存失败'};
          sendToRenderer('session-updated',{session:updated});
          return {ok:true,result:{fastMode:enabled},...(result?.warning ? {warning:result.warning} : {})};
        } catch (error) {
          return {ok:false,message:error.message};
        } finally { pendingSpeedSwitches.delete(sessionId); }
      }
      const {claudeSettingsPath,readJsonObject,writeJsonAtomic} = require('../../core/claude-model-preference-guard');
      const file = claudeSettingsPath();
      const previous = readJsonObject(file);
      const observer = require('../../core/claude-fast-command').observeClaudeFastCommand(sessionManager,sessionId,enabled);
      pendingSpeedSwitches.add(sessionId);
      try {
        const result = await require('../../core/group-chat-watcher').sendToPty(sessionId,`/fast ${enabled ? 'on' : 'off'}`,session.kind,
          {requireReady:false,localCommandObserver:observer});
        if (!result?.ok) return {ok:false,message:result?.message || 'Claude 未确认速度切换'};
        const updated = sessionManager.updateSessionMeta(sessionId,{fastMode:enabled});
        if (!updated) return {ok:false,message:'Claude 已切换，但会话信息保存失败'};
        sendToRenderer('session-updated',{session:updated});
        return {ok:true,result:{fastMode:enabled}};
      } finally {
        pendingSpeedSwitches.delete(sessionId);
        observer.dispose();
        // /fast persists a user default. Restore only our field, preserving
        // unrelated concurrent edits, just like the existing model guard.
        const current = readJsonObject(file);
        if (current.fastMode === enabled && previous.fastMode !== enabled) {
          if (Object.hasOwn(previous,'fastMode')) current.fastMode = previous.fastMode;
          else delete current.fastMode;
          writeJsonAtomic(file,current);
        }
      }
    };
    const pending = claudeFastQueue.then(task).catch(error=>({ok:false,message:error.message}));
    claudeFastQueue = pending;
    return pending;
  });

  const web = require('../../core/chatgpt-web-integration');
  ipcMain.handle('chatgpt-web:status', () => web.webStatus());
  ipcMain.handle('chatgpt-web:settings', () => web.openWebSettings());
  // 用户在界面上手动新建（IPC create-session）不受暂停影响，成功一次即解除（core/session-start-backoff.js）。
  const autoStartBackoff = require('../../core/session-start-backoff').createSessionStartBackoff({
    onPause: ({ kind, reason, waitMs }) => {
      console.warn(`[create-session] 自动新建 ${kind} 会话连续失败，暂停 ${Math.round(waitMs / 1000)} 秒：${reason}`);
      try { sendToRenderer('session-notice', { level: 'error', noticeKind: 'blocking',
        message: `后台自动新建 ${kind} 会话连续 3 次失败，已暂停重试：${reason}` }); } catch {}
    },
  });
  const createAutoSession = (arg) => {
    const kind = typeof arg === 'string' ? arg : arg?.kind;
    // 同步/异步形态与 createSession 保持一致：同步抛出的照旧同步抛出，返回 Promise 的照旧返回 Promise。
    let result;
    // 正式环境（有启动前检查）建会话本来就返回 Promise，暂停和启动前的同步检查失败也一律用 Promise 拒绝，调用方 .catch 能接住。
    try { autoStartBackoff.assertAllowed(kind); }
    catch (error) { if (ensureLaunchAuth) return Promise.reject(error); throw error; }
    try { result = createSession(arg, 'auto'); }
    catch (error) { autoStartBackoff.failed(kind, error); if (ensureLaunchAuth) return Promise.reject(error); throw error; }
    if (result && typeof result.then === 'function') {
      return result.then(session => { autoStartBackoff.succeeded(kind); return session; },
        error => { autoStartBackoff.failed(kind, error); throw error; });
    }
    autoStartBackoff.succeeded(kind);
    return result;
  };
  const createSession = (arg, source = 'user') => {
    const started = Date.now();
    try { return createSessionChecked(arg, source, started); }
    catch (error) {
      const kind = (typeof arg === 'string' ? arg : arg?.kind) || 'powershell';
      recordLaunchTiming({ kind, source, checksMs: Date.now() - started, ok: false, ...launchFailureFields(error) });
      throw error;
    }
  };
  const createSessionChecked = (arg, source, started) => {
    // Back-compat: legacy callers pass just a kind string; newer callers pass { kind, opts }.
    let kind;
    let opts;
    if (typeof arg === 'string') {
      kind = arg;
      opts = {};
    } else if (arg && typeof arg === 'object') {
      kind = arg.kind;
      opts = { ...(arg.opts || {}) };
    } else {
      kind = 'powershell';
      opts = {};
    }
    require('../../core/company-ai-policy').assertKind(kind || 'powershell');
    if (require('../../core/company-ai-policy').companyOnly() && require('../../core/chatgpt-web-models').isChatgptWebModel(opts.model)) throw new Error('公司版只使用 CodeAgent');
    if (kind === 'chatgpt') {
      if (!require('../../core/chatgpt-web-models').isChatgptWebModel(opts.model)) throw new Error('请选择可用的 ChatGPT 模型');
      kind = 'codex';
    }
    if (require('../../core/chatgpt-web-models').isChatgptWebModel(opts.model)) {
      web.requireWebTools(opts.model);
      return require('../../core/chatgpt-web-startup').ensureWebReady(opts.model).then(() => {
        return createResolvedSession(kind, opts);
      });
    }
    // 社区版：缺少 CLI 先说清楚，再查登录（2026-10-28：没装 Claude 时，账号凭据检查先报「Claude 登录或配置文件无法读取」，
    // 盖过了「未找到 Claude Code CLI」，用户以为是登录问题）。session-manager 创建前同样检查一次。
    require('../../core/community-provider').assertProviderAvailable(kind || 'powershell');
    require('../../core/company-api-config').assertLaunchConfigured(kind || 'powershell', require('../../core/hub-config').getConfig(), opts || {});
    if (ensureLaunchAuth) {
      let checked = started;
      return ensureLaunchAuth(kind,opts).then(()=>require('../../core/codeagent-capabilities').prepareForKind(kind)).then(()=>{ checked = Date.now(); return createResolvedSession(kind,opts); })
        .then(session => { if (source === 'user') autoStartBackoff.succeeded(kind); recordLaunchTiming({kind, source, checksMs:checked-started, createMs:Date.now()-checked, ok:true, sessionId:session?.id || null}); return session; },
          error => { recordLaunchTiming({kind, source, checksMs:Date.now()-started, ok:false, ...launchFailureFields(error)}); throw error; });
    }
    return createResolvedSession(kind, opts);
  };
  // 失败行一定带原因：没有错误码的普通 Error 也记下第一行原文（截 200 字）；SQLite 错误另记 errcode，
  // 才分得清是锁忙（5）、损坏（11）还是别的。2026-11-11 的 24 次失败只记了 code:null，事后查不到原因。
  function launchFailureFields(error) {
    const message = String(error?.message || error || '').split(/\r?\n/)[0].slice(0, 200);
    return { code: error?.code || null, message: message || null,
      ...(Number.isInteger(error?.errcode) ? { errcode: error.errcode } : {}),
      ...(error?.cause && typeof error.cause !== 'object' ? { cause: String(error.cause) } : {}) };
  }
  // Where a launch spends its time: pre-launch checks versus building the session.
  function recordLaunchTiming(entry) {
    try {
      const file = require('node:path').join(require('../../core/data-dir.js').getHubDataDir(), 'diagnostics', 'launch-timings.jsonl');
      const fs = require('node:fs');
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch {}
      fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', () => {});
    } catch {}
  }
  ipcMain.handle('session:prepare-launch-auth', async (_event, request = {}) => {
    void require('../../core/codeagent-capabilities').prepareForKind(request.kind);
    await prepareLaunchAuth?.(request.kind, { launchProfile: request.launchProfile });
    return { ok: true };
  });
  ipcMain.handle('create-session', (_e, arg) => createSession(arg));

  function createResolvedSession(kind, opts) {
    const isResumePicker = typeof kind === 'string' && kind.endsWith('-resume');
    // Native resume pickers must start in their historical/default scope when
    // the caller has no known cwd. Creating a fresh scratch here makes the CLI
    // picker unable to see the sessions it is supposed to resume.
    if (workspaceService && !opts.meetingId && (!isResumePicker || opts.cwd)) {
      const workspaceMeta = { label: opts.workspaceLabel, select: false };
      if (typeof opts.workspaceDraft === 'boolean') workspaceMeta.draft = opts.workspaceDraft;
      const workspace = workspaceService.resolveForSession(opts.cwd, workspaceMeta);
      opts.cwd = workspace.path;
    }
    return require('../session-model-creation').createSessionWithModelPolicy({ kind, opts,
      contextLabel: opts.modelCreationContext || (opts.title ? `新建会话 ${opts.title}` : '新建会话'),
      requestConfirmation: requestModelConfirmation, sendToRenderer,
      create: (runtimeKind, launchOpts) => {
        // 会话进程已建好后的登记步骤没成，不能让整次创建报「创建失败」（会话已在侧栏、用户会重复点）：
        // 照常通知界面，并把没成的一步带回，由界面给一行提示（renderer/session-create-outcome.js）。
        // createRequestId 是新建弹窗这次请求的标识，不交给会话本身，只随 session-created 事件带回，界面据此认出「这次建的那个」。
        const { createRequestId, ...sessionOpts } = launchOpts;
        const created = session => {
          let createWarning = null;
          try {
            const tap = registerSessionForTap(session);
            if (tap && tap.ok === false) createWarning = { step: tap.step || 'tap', message: tap.message || '未知原因' };
          } catch (error) {
            createWarning = { step: 'tap', message: error?.message || String(error) };
            console.warn('[create-session] tap register failed:', error);
          }
          sendToRenderer('session-created', { session, ...(createRequestId ? { createRequestId } : {}) });
          return createWarning ? { ...session, createWarning } : session;
        };
        const result = require('../../core/session-open-ownership').retryWhenOwnershipBusy(() => sessionManager.createSession(runtimeKind, sessionOpts));
        return result?.then ? result.then(created) : created(result);
      },
    });
  }

  // 分支编号要看「现存 + 已持久化」两边，否则重启后分支序号会从头再来一遍。
  function forkSiblingPool() {
    const persistedSessions = getPersistedSessions();
    return [
      ...(typeof sessionManager.getAllSessions === 'function' ? sessionManager.getAllSessions() : []),
      ...(Array.isArray(persistedSessions) ? persistedSessions : []),
    ];
  }

  const forkSession = (request, verifiedSource = null) => {
    const sourceSessionId = request && typeof request === 'object'
      ? request.sourceSessionId
      : request;
    const rendererTitle = request && typeof request === 'object'
      ? request.sourceTitle
      : null;
    // Only internal callers can pass an already verified persisted source.
    // The public IPC below still accepts just its original request argument.
    const source = verifiedSource || (typeof sourceSessionId === 'string'
      ? sessionManager.getSession(sourceSessionId)
      : null);
    const plan = planSessionFork({
      source,
      siblingPool: forkSiblingPool(),
      meeting: source && source.meetingId && meetingManager && typeof meetingManager.getMeeting === 'function'
        ? meetingManager.getMeeting(source.meetingId)
        : null,
      rendererTitle,
      runtimeKind: source ? runtimeKindForSession(source) : '',
    });
    if (!plan.ok) return plan;
    // 分支沿用源会话的场景（core/session-scenes.js）：同一份系统提示，接着同一段对话
    if (source && require('../../core/session-scenes').isScenePurpose(source.purpose)) plan.opts.purpose = source.purpose;

    const { kind, opts } = plan;
    const createFork = (preparedOpts = opts) => {
      const created = session => {
        registerSessionForTap(session);
        sendToRenderer('session-created', { session });
        return { ok: true, session };
      };
      // 模型不可用时和新建会话同一套处理（main/session-model-creation.js）：默认模型下线自动换推荐模型，指定的模型照旧确认。
      const cancelled = error => {
        if (error?.code === 'SESSION_CREATION_CANCELLED') return { ok: false, error: 'fork-cancelled', message: error.message };
        throw error;
      };
      let result;
      try {
        result = require('../session-model-creation').createSessionWithModelPolicy({ kind, opts: preparedOpts,
          contextLabel: preparedOpts.title ? `分支会话 ${preparedOpts.title}` : '分支会话', modelLabel: '原会话的模型',
          requestConfirmation: requestModelConfirmation, sendToRenderer, dataDir: deps.dataDir || null,
          create: (runtimeKind, launchOpts) => require('../../core/session-open-ownership').retryWhenOwnershipBusy(() => sessionManager.createSession(runtimeKind, launchOpts)) });
      } catch (error) { return cancelled(error); }
      return result?.then ? result.then(created, cancelled) : created(result);
    };
    if (plan.needsAcpFork) {
      return sessionManager.getNativeSession(source.id).fork()
        .then(fork => { opts.acpFork = fork; return createFork(); })
        .catch(error => ({ ok: false, error: 'acp-fork-failed', message: error.message }));
    }
    if (kind === 'codex' && opts.codexForkSid && sessionManager.prepareCodexFork) {
      return sessionManager.prepareCodexFork(opts).then(createFork)
        .catch(error => ({ ok: false, error: 'codex-fork-failed', message: error.message }));
    }
    return createFork();
  };
  ipcMain.handle('fork-session', (_e, request) => forkSession(request));

  require('./codeagent-prefix-fork-handlers').registerPrefixForkIpc(ipcMain, { ...deps, forkSiblingPool, forkSession });

  ipcMain.handle('close-session', async (_e, sessionId) => {
    cancelModelConfirmation?.(sessionId);
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = await sessionManager.closeSessionRecoverably(sessionId, { reason: 'user-close' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  // “关闭”在用户语义上等同于可恢复休眠。真正移除卡片/历史入口必须走
  // 明确命名的永久删除，内部 restart/workspace 迁移仍可直接调用 closeSession。
  ipcMain.handle('delete-session', (_e, sessionId) => {
    cancelModelConfirmation?.(sessionId);
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    try {
      const edit = () => {
        lastResizeBySid.delete(sessionId);
        sessionManager.closeSession(sessionId);
        return { ok: true, sessionId, action: 'deleted' };
      };
      const owners = sessionManager._openOwners?.();
      return owners ? owners.editSessions([sessionId], edit, { allowOwn: true }) : edit();
    } catch (error) {
      return { ok: false, error: error.code || 'session-edit-failed', message: error.message };
    }
  });

  ipcMain.handle('suspend-session', (_e, arg) => {
    const sessionId = arg && typeof arg === 'object' ? arg.sessionId : arg;
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'invalid-session-id', message: '缺少会话 ID' };
    }
    const result = sessionManager.suspendSession(sessionId, { reason: 'user-suspend' });
    if (result && result.ok) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.handle('suspend-idle-sessions', (_e, arg = {}) => {
    const idleMs = arg && typeof arg === 'object' ? arg.idleMs : undefined;
    const result = sessionManager.suspendIdleSessions({ idleMs });
    for (const sessionId of (result && result.requested) || []) lastResizeBySid.delete(sessionId);
    return result;
  });

  ipcMain.on('terminal-input', (_e, { sessionId, data }) => {
    const native = sessionManager.getNativeClaude?.(sessionId);
    if (native) {
      native.emit('action-error', '原生 Claude 会话请通过 Hub 输入框发送消息或停止按钮操作');
      return;
    }
    sessionManager.writeToSession(sessionId, data);
  });

  ipcMain.handle('codeagent-serve:terminal', async (_event, { sessionId, action, cols, rows } = {}) => {
    const driver = sessionManager.getNativeSession?.(sessionId);
    if (!driver?.attachTerminal) return { ok: false, message: '这个会话没有可接的后台终端（只有 CodeAgent-Lite 与卡片会话支持）' };
    try {
      if (action === 'attach') return await driver.attachTerminal({ cols, rows });
      driver.detachTerminal();
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; }
  });

  // 卡片视图里直接回答终端选择菜单（core/pty-choice-menu.js）：读屏认菜单、核对后按键，认不出就不按。
  const ptyChoice = require('../../core/pty-choice-menu').createPtyChoiceMenu(sessionManager);
  ipcMain.handle('pty-choice:read', async (_event, { sessionId } = {}) => {
    try { return await ptyChoice.read(sessionId); }
    catch (error) { return { ok: false, reason: 'error', message: error.message }; }
  });
  ipcMain.handle('pty-choice:answer', async (_event, { sessionId, signature, key } = {}) => {
    try { return await ptyChoice.answer(sessionId, { signature, key }); }
    catch (error) { return { ok: false, reason: 'error', message: error.message }; }
  });

  const cardRelay = new (require('../../core/card-relay').CardRelay)({
    sessions: { getRaw: id => sessionManager.sessions?.get(id), updateMeta: (id, fields) => sessionManager.updateSessionMeta(id, fields) },
    restart: id => restartAuthorizedSession(id, null, { relaunch: true, cardSwitch: true }),
    notify: (sessionId, level, message) => sendToRenderer('session-notice', { sessionId, level, persistent: level === 'error', message }),
    onSwitch: (sessionId, phase, terminal) => sendToRenderer('card-relay-switch', { sessionId, phase, terminal }),
    ...(Number(process.env.AI_HUB_CARD_TERMINAL_KEEP_MS) > 0 ? { keepMs: Number(process.env.AI_HUB_CARD_TERMINAL_KEEP_MS) } : {}),
  });
  ipcMain.handle('card-relay:terminal', async (_event, { sessionId, action } = {}) => {
    try { return action === 'attach' ? await cardRelay.attach(sessionId) : cardRelay.detach(sessionId); }
    catch (error) { return { ok: false, message: error.message }; }
  });
  sessionManager.on?.('card-run-fallback', ({ sessionId, reason }) => {
    console.warn('[card-relay] 改回 PTY：', sessionId, reason);
    cardRelay.forget(sessionId);
    sessionManager.updateSessionMeta(sessionId, { cardRunMode: 'pty', cardTerminal: false });
    Promise.resolve(restartAuthorizedSession(sessionId, null, { relaunch: true, serveFallback: true, cardSwitch: true })).then(result => {
      const ok = result && result.ok !== false;
      sendToRenderer('session-notice', { sessionId: result?.id || sessionId, level: ok ? 'warning' : 'error', persistent: true,
        message: ok ? '结构化通道多次中断，这个会话已自动改回终端方式，历史和上下文都在。' : `自动改回终端失败：${result?.message || '未知错误'}，可从侧栏休眠后恢复。` });
    }).catch(error => console.warn('[card-relay] 改回 PTY 失败：', error.message));
  });

  // CodeAgent-Lite（serve）起不来或连续断线：无感改回独立 PTY。
  // 已有原生会话 ID 的按原历史恢复；首轮就没连上（还没有 ID）的用同一会话 ID、原启动参数原地改建终端会话。
  // （core/group-chat-watcher.js sendToPty），这里不另行补发，避免规则回执错位或重复。
  // 提示按提示闸门口径（core/notice-gate.js）：自动改道成功的不打扰（只进日志），用户亲手点 Lite 的给一行；改道失败才算真失败。
  const SERVE_FALLBACK_NOTICE = 'CodeAgent 轻享服务暂不可用，已自动改用终端方式继续';
  const serveFallbackNoticeKey = 'codeagent-serve-fallback';
  sessionManager.on?.('codeagent-serve-fallback', (event = {}) => {
    const { sessionId, reason } = event;
    console.warn('[codeagent-serve] 改回 PTY：', sessionId, event.phase || 'runtime', reason);
    const launchOpts = sessionManager.getServeLaunchOptions?.(sessionId) || null;
    const explicit = launchOpts?.explicitCodeagentLite === true;
    sessionManager.updateSessionMeta(sessionId, { codeagentRunMode: 'pty', codeagentLiteFeature: false, codeagentServeFallbackReason: String(reason || '').slice(0, 300) });
    // 留在 serve 待发队列里、等你确认的消息不自动重发，回执里如实报数。
    const pending = Array.isArray(event.pendingPrompts) ? event.pendingPrompts.length : 0;
    let ok = false;
    Promise.resolve().then(() => restartAuthorizedSession(sessionId, null, { relaunch: true, serveFallback: true, launchOpts })).then(result => {
      ok = !!result && result.ok !== false;
      const left = ok && pending > 0 ? `；有 ${pending} 条待发消息未自动发送，请重新发送` : '';
      sendToRenderer('session-notice', { sessionId: result?.id || sessionId, level: ok ? 'info' : 'error', persistent: !ok, reasonKey: serveFallbackNoticeKey,
        noticeKind: ok ? (explicit || left ? 'user-action' : 'auto') : 'blocking',
        message: ok ? SERVE_FALLBACK_NOTICE + left : `CodeAgent 轻享服务暂不可用，自动改用终端方式失败：${result?.message || '未知错误'}，可新建会话重试` });
    }).catch(error => console.warn('[codeagent-serve] 改回 PTY 失败：', error.message))
      .finally(() => sessionManager.endServeFallback?.(sessionId, ok));
  });

  // 首轮就没连上的 Lite 会话：按原启动参数、同一会话 ID 原地改建终端会话（session-manager replaceServeWithPty：
  // 旧对象按休眠收尾，界面不收到「会话被删除」，草稿与侧栏位置保留、不抢焦点）。
  function relaunchServeAsPty(old, options = {}) {
    const base = options.launchOpts || {
      cwd: old.cwd, title: old.title, model: sessionModelId(old), permissionMode: old.permissionMode, workspaceGuard: old.workspaceGuard === true, purpose: old.purpose,
      featureAgent: old.featureAgent, featureAgentChoice: old.featureAgentChoice, autonomous: old.autonomous, noInheritCursor: old.noInheritCursor,
      openInBackground: old.openInBackground, addDirs: old.addDirs, workspaceLabel: old.workspaceLabel, pinned: old.pinned, codeagentPoolAccount: old.codeagentPoolAccount,
      ...require('../../core/codeagent-model-choice').routeFields(old),
    };
    const opts = { ...base, codeagentRunMode: 'pty' };
    for (const key of ['codeagentLiteFeature', 'explicitCodeagentLite', 'lowOverheadServe', 'resumeCCSessionId', 'acpSid', 'nativeRuntime', '_openLeaseNonce', 'id']) delete opts[key];
    for (const key of Object.keys(opts)) if (opts[key] === undefined) delete opts[key];
    // 号池会话回到原来那个号，不重新挑号。
    if (old.codeagentPoolAccount && !opts.codeagentPoolAccount) opts.codeagentPoolAccount = old.codeagentPoolAccount;
    if (old.title) opts.title = old.title;
    // 改建出来的会话在后台接上：用户正看着它时照常显示终端，切去别处的不被拉回来。
    opts.openInBackground = true;
    const kind = String(old.kind || 'codeagent').replace(/-resume$/, '');
    lastResizeBySid.delete(old.id);
    return Promise.resolve(sessionManager.replaceServeWithPty(old.id, kind, opts)).then(session => {
      registerSessionForTap(session);
      sendToRenderer('session-created', { session });
      return session;
    });
  }

  ipcMain.handle('codex:native-action', async (_event, payload = {}) => {
    const native = sessionManager.getNativeSession?.(payload.sessionId) || sessionManager.getNativeCodex?.(payload.sessionId);
    if (!native) return {ok:false,message:'该 Codex 会话尚未接管'};
    try {
      let result;
      if (payload.action === 'reply') result = await native.reply(payload.requestId,payload.result,payload.epoch);
      else if (payload.action === 'choose-thread') result = await native.chooseThread(payload.threadId);
      else if (payload.action === 'reconnect') result = await native.reconnect();
      else if (payload.action === 'restart-empty') result = await native.restartEmpty(payload);
      else if (payload.action === 'interrupt') result = await native.interrupt();
      else if (payload.action === 'configure') result = await native.configure(payload);
      else if (payload.action === 'collaboration-mode') result = await native.configureMode(payload.mode, payload.epoch);
      else if (payload.action === 'snapshot') result = native.runtime;
      else if (payload.action === 'review-submission') result = await Promise.resolve(native.reviewUnknownSubmission(payload.submissionId,payload.epoch));
      else return {ok:false,message:'不支持的 Codex 操作'};
      if (payload.action === 'configure' && result?.modelId) {
        const updated = sessionManager.updateSessionMeta(payload.sessionId, { fixedModel: result.modelId, modelPinSource: 'user', modelChange: null });
        if (updated) sendToRenderer('session-updated', { session: updated });
      }
      return {ok:true,result};
    } catch (error) {
      return {ok:false,message:error.message};
    }
  });

  ipcMain.on('terminal-resize', (_e, { sessionId, cols, rows, force }) => {
    if (typeof sessionId !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    if (cols <= 0 || rows <= 0) return;
    const last = lastResizeBySid.get(sessionId);
    // Normal ResizeObserver chatter remains deduplicated. Snapshot hydration is
    // the one intentional exception: a same-size ConPTY resize asks a live TUI
    // to repaint a complete authoritative frame after historical ANSI replay.
    if (!force && last && last.cols === cols && last.rows === rows) return;
    lastResizeBySid.set(sessionId, { cols, rows });
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  ipcMain.on('focus-session', (_e, { sessionId }) => {
    sessionManager.setFocusedSession(sessionId);
    sessionManager.markRead(sessionId);
  });

  // 侧栏「全部已读」。刻意不复用 focus-session：那条会顺带改 focusedSessionId，
  // 而批量标已读不该把焦点挪到列表里最后一个会话上（焦点还决定谁不被批量休眠）。
  ipcMain.on('mark-sessions-read', (_e, payload = {}) => {
    const ids = Array.isArray(payload && payload.sessionIds) ? payload.sessionIds : [];
    for (const sessionId of ids) {
      if (typeof sessionId === 'string' && sessionId) sessionManager.markRead(sessionId);
    }
  });

  // 经本机反代的会话可切的模型：API 网关会话按网关模型表（2026-11-19），公司模型会话按公司模型表。
  const proxyModelIds = session => session?.companyUpstream === 'gateway'
    ? require('../../core/company-model-proxy').gatewayModelIds(require('../../core/data-dir').getHubDataDir())
    : require('../../core/company-model-proxy').MODEL_IDS;

  ipcMain.handle('prepare-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const targetModel = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    const kind = String(session && session.kind || '').replace(/-resume$/, '').toLowerCase();
    const companyProxy = session?.companyRoute === 'proxy';
    const validModel = companyProxy ? proxyModelIds(session).includes(targetModel) : isClaudeModelSelection(targetModel);
    if (!session || kind !== 'claude' || !validModel) {
      return { ok: false, error: 'invalid-claude-switch', message: '无法为当前会话准备 Claude 模型切换' };
    }
    try {
      if (claudeModelPreferenceGuards.has(sessionId)) {
        await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false });
      }
      const snapshot = captureClaudeModelPreference(targetModel, companyProxy
        ? { configDir: session.claudeConfigDir || session.claudeRuntimeHome } : undefined);
      const timer = setTimeout(() => {
        void restoreClaudePreferenceGuard(sessionId).then(restored => {
          if (restored && restored.status === 'restore-failed') {
            console.warn('[model-switch] timed Claude default restoration failed:', restored.error);
          }
        });
      }, 20_000);
      timer.unref?.();
      claudeModelPreferenceGuards.set(sessionId, { snapshot, timer });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'preference-snapshot-failed', message: `无法保护 Claude 默认模型：${error.message}` };
    }
  });

  async function restoreClaudePreferenceGuard(sessionId, options = {}) {
    const entry = claudeModelPreferenceGuards.get(sessionId);
    if (!entry) return { restored: false, status: 'missing-snapshot' };
    if (entry.timer) clearTimeout(entry.timer);
    const waitForWrite = options.waitForWrite !== false;
    const deadline = Date.now() + (waitForWrite ? 2500 : 0);
    while (true) {
      let result;
      try { result = restoreClaudeModelPreference(entry.snapshot); }
      catch (error) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: false, status: 'restore-failed', error: error.message };
      }
      if (result.restored || result.status !== 'changed-externally') {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      const original = entry.snapshot.hadModel ? entry.snapshot.previousModel : undefined;
      if (result.currentModel !== original) {
        claudeModelPreferenceGuards.delete(sessionId);
        return result;
      }
      if (!waitForWrite || Date.now() >= deadline) {
        claudeModelPreferenceGuards.delete(sessionId);
        return { restored: true, status: 'unchanged' };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  ipcMain.handle('cancel-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    return { ok: true, preference: await restoreClaudePreferenceGuard(sessionId, { waitForWrite: false }) };
  });

  function localCliModels(session) {
    const kind = String(session?.kind || '').replace(/-resume$/, '');
    if ((session?.companyRoute !== 'local' && !session?.cliApiProfileId) || !['codex', 'claude'].includes(kind)) throw new Error('这个会话没有选择沿用本机 CLI 配置');
    if (session.cliApiProfileId) {
      const profiles = require('../../core/cli-api-profiles');
      const profile = profiles.readConnection(kind, session, require('../../core/data-dir').getHubDataDir());
      // 这个 API 账号配了多个模型：会话内模型菜单列全部（同一个接口地址才列，R45-3 审查 P2-1）。
      let current = null;
      try { current = profiles.profiles(require('../../core/hub-config').readConfigJsonForUpdate(), kind).find(p => p.id === profile.id); } catch { current = null; }
      const ids = [...new Set([profile.model, ...(current && current.baseURL === profile.baseURL && Array.isArray(current.modelList) ? current.modelList : [])].filter(Boolean))];
      return { ok: true, models: ids.map(id => ({ id, label: id })), defaultModel: profile.model };
    }
    const configDir = kind === 'codex' ? session.codexRuntimeHome || (session.codexSessionsRoot ? require('path').dirname(session.codexSessionsRoot) : undefined)
      : session.claudeConfigDir || session.claudeRuntimeHome;
    return require('../../core/local-cli-models').readLocalCliModels(kind, { configDir });
  }
  ipcMain.handle('session:local-models', (_event, payload = {}) => {
    try {
      const session = sessionManager.getSession(payload.sessionId);
      if (!session) throw new Error('会话不存在或已经休眠');
      return localCliModels(session);
    } catch (error) { return { ok: false, models: [], error: error.message }; }
  });
  // Renderer calls this only after the provider-owned TUI confirms the switch.
  // Keeping metadata confirmation separate from terminal-input prevents a
  // failed picker interaction from making Hub claim a model that never became active.
  ipcMain.handle('confirm-session-model-switch', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    let modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    if (['codex-app-server','acp'].includes(session.runtimeBackend)
      || session.agentRuntime === 'pty' && /^deepseek-acp(?:-resume)?$/.test(session.kind)) {
      const current = session.currentModel || {};
      if (current.id !== modelId || (payload.effort && payload.effort !== session.effort)) {
        return {ok:false,message:'原生会话尚未确认该模型或思考档'};
      }
      return {ok:true,model:current,effort:session.effort};
    }
    const kind = String(session.kind || '').replace(/-resume$/, '').toLowerCase();
    const local = (session.companyRoute === 'local' || session.cliApiProfileId) && ['codex', 'claude'].includes(kind);
    const companyProxy = session.companyRoute === 'proxy' && ['codex', 'claude'].includes(kind);
    let localOptions;
    if (local) {
      try { localOptions = localCliModels(session).models; }
      catch (error) { return { ok: false, message: error.message }; }
    }
    const valid = companyProxy ? proxyModelIds(session).includes(modelId)
      : local ? localOptions.some(model => model.id === modelId) : kind === 'codex'
      ? isCodexConversationModelId(modelId)
      : kind === 'claude'
        ? isClaudeModelSelection(modelId)
        : kind==='deepseek'&&!session.deepseekLegacyClaude
          ? require('../../core/deepseek-codex-profile').DEEPSEEK_CODEX_MODELS.includes(modelId)
        : kind === 'deepseek-claude'
          ? require('../../core/deepseek-claude-profile').isKnownModel(modelId)
        // agy slugs; the CLI itself already accepted it with "Model set to".
        : kind === 'gemini'
          ? /^(?:gemini|claude|gpt-oss)[\w.-]+$/.test(modelId)
        : false;
    if (!valid) return { ok: false, error: 'invalid-model', message: '该模型不属于当前 CLI 的会话模型目录' };
    if (kind === 'codex' && !local && !companyProxy) modelId = require('../../core/model-options').normalizeCodexSessionModel(modelId);
    // DeepSeek on Claude Code：终端里切的是接入方式对应的真实模型名，Hub 记显示用的 id。
    if (kind === 'deepseek-claude') {
      const profile = require('../../core/deepseek-claude-profile');
      modelId = profile.normalizeModel(modelId);
      payload = { ...payload, displayName: profile.displayName(modelId, session.deepseekActiveRoute || session.deepseekRoute) };
    }

    const displayName = String(payload.displayName || modelId)
      .replace(/[\0\r\n]+/g, ' ')
      .trim()
      .slice(0, 120) || modelId;
    const fields = { currentModel: { id: modelId, displayName }, fixedModel: modelId, modelPinSource: 'user', modelChange: null };
    const effort = String(payload.effort || '').toLowerCase();
    if (['codex','deepseek'].includes(kind) && CODEX_MODEL_EFFORTS.has(effort)) fields.effort = effort;
    const updated = sessionManager.updateSessionMeta(sessionId, fields);
    if (!updated) {
      if (kind === 'claude') await restoreClaudePreferenceGuard(sessionId);
      return { ok: false, error: 'update-failed', message: '模型已切换，但 Hub 元数据更新失败' };
    }
    sendToRenderer('session-updated', { session: updated });
    const preference = kind === 'claude' ? await restoreClaudePreferenceGuard(sessionId) : null;
    return {
      ok: true,
      model: fields.currentModel,
      effort: fields.effort || updated.effort || null,
      ...(preference ? { preference } : {}),
    };
  });

  // Sidebar placement lives in renderer state for dormant cards, but a live
  // SessionManager must learn it immediately too. Restart and the bulk-idle
  // guard read this authority before the debounced state.json write completes.
  ipcMain.on('update-session-placement', (_e, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId || typeof sessionManager.updateSessionMeta !== 'function') return;
    const pinned = payload.pinned === true;
    sessionManager.updateSessionMeta(sessionId, {
      pinned,
      bottomed: payload.bottomed === true && !pinned,
    });
  });

  ipcMain.handle('rename-session', (_e, { sessionId, title, userRenamed }) => {
    if (userRenamed && deps.getTitleService?.()) return deps.getTitleService().rename({ type: 'session', id: sessionId, title });
    const codexNative = sessionManager.getNativeCodex?.(sessionId) || sessionManager.getNativeClaude?.(sessionId);
    if (codexNative?.control?.shared && codexNative.control.role !== 'controller') return null;
    if (!userRenamed && sessionManager.getSession(sessionId)?.userRenamed) return sessionManager.getSession(sessionId);
    const session = sessionManager.renameSession(sessionId, title, { userRenamed: !!userRenamed });
    const claudeNative = sessionManager.getNativeClaude?.(sessionId);
    const finish = () => {
      if (session) sendToRenderer('session-updated', { session });
      return session;
    };
    if (claudeNative && userRenamed && session) {
      return (async () => {
        try { session.nativeRename = await claudeNative.rename(title); }
        catch (error) {
          claudeNative.emit('action-error', 'Hub 名称已保存；Claude 历史同步失败：' + error.message);
          session.nativeRename = { status: 'failed', message: error.message };
        }
        return finish();
      })();
    }
    return finish();
  });

  // Only explicit history navigation calls this. Previewing search results
  // must not manufacture activity or a completed model response.
  ipcMain.handle('session:record-history-open', (_e, { sessionId } = {}) => {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, message: '会话不存在或未成功恢复' };
    const at = Math.max(Date.now(), Number(session.lastMessageTime) || 0);
    const updated = sessionManager.updateSessionMeta(sessionId, { lastMessageTime: at, hiddenFromSidebar: false });
    if (!updated) return { ok: false, message: '侧栏活动时间更新失败' };
    return { ok: true, at };
  });

  ipcMain.handle('get-sessions', () => {
    return sessionManager.getAllSessions();
  });

  // 公司电脑上装了 CodeAgent 时，新建会话 / 群聊默认用它（只查文件是否存在，不代表已登录）。
  // CodeAgent 模型菜单：已知模型 + 本机回答里实际出现过的模型（core/codeagent-models.js）。
  ipcMain.handle('codeagent:models', (_event, payload) => codeagentModelList(payload));
  ipcMain.handle('codeagent:skills', async (_event, payload = {}) => {
    try {
      const session = sessionManager.getSession(payload.sessionId);
      if (!session || !require('../../core/ai-kinds').isCodeAgentKind(session.kind)) throw new Error('当前会话不是可用的 CodeAgent 会话');
      if (payload.probeCommands === true) void commandsProbeScheduler.request(session, { force: payload.retryCommands === true });
      const dataDir = require('../../core/data-dir').getHubDataDir();
      const configDir = require('../../core/codeagent-default-model-guard').sessionConfigDir(session, { dataDir });
      const inventory = await new Promise((resolve, reject) => setImmediate(() => {
        try {
          const scan = require('../../core/capability-catalog').scanCodeAgentSkills;
          const inventory = scan(configDir);
          if (session.cwd) {
            const project = scan(require('node:path').join(session.cwd, '.cac'));
            inventory.skills = [...new Map([...inventory.skills, ...project.skills].map(skill => [skill.name, skill])).values()];
            inventory.warnings.push(...project.warnings);
          }
          resolve(inventory);
        } catch (error) { reject(error); }
      }));
      return { ok: true, ...inventory, commands: require('../../core/codeagent-command-cache').readCommands(dataDir, session), commandsProbe: commandsProbeScheduler.state(session) };
    } catch (error) { return { ok: false, error: '读取技能失败：' + error.message, skills: [] }; }
  });
  const slashCatalogCache = new Map();
  // 输入框「/」选择框（2026-11-20）：Claude Code、Codex、DSH、pi 的命令与技能清单；CodeAgent 仍走 codeagent:skills。
  ipcMain.handle('composer:slash-catalog', async (_event, payload = {}) => {
    try {
      const session = sessionManager.getSession(payload.sessionId);
      if (!session) return { ok: false, reason: 'no-session' };
      const acpCommands = sessionManager.sessions?.get?.(payload.sessionId)?.pty?.commands || null;
      // 同一会话 15 秒内重复打开直接用上次的清单（读目录约 20 ms，打开一次读一次没必要）；新装的技能最多晚 15 秒出现。
      const hit = slashCatalogCache.get(payload.sessionId);
      if (hit && Date.now() - hit.at < 15000 && hit.acpCommands === acpCommands) return hit.result;
      const result = await new Promise((resolve, reject) => setImmediate(() => {
        try { resolve(require('../../core/composer-slash-catalog').catalogFor(session, { dataDir: require('../../core/data-dir').getHubDataDir(), acpCommands })); }
        catch (error) { reject(error); }
      }));
      if (result.ok) slashCatalogCache.set(payload.sessionId, { at: Date.now(), acpCommands, result });
      if (slashCatalogCache.size > 50) slashCatalogCache.delete(slashCatalogCache.keys().next().value);
      return result;
    } catch (error) { return { ok: false, error: '读取命令与技能失败：' + error.message }; }
  });
  const skillInstaller = require('../../core/codeagent-skill-install').createSkillInstaller({
    getSession: id => sessionManager.getSession(id), dataDir: require('../../core/data-dir').getHubDataDir(),
    openExternal: url => require('electron').shell.openExternal(url),
  });
  ipcMain.handle('codeagent:skill-install', (_event, payload) => skillInstaller(payload));
  ipcMain.handle('codeagent:commands-open', async (_event, payload = {}) => {
    try { return await require('../../core/group-chat-watcher').openCodeAgentCommands(payload.sessionId); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // /model 菜单用量快照（core/codeagent-usage-menu.js）：界面取全部；界面每轮结束读屏读到菜单时交回来记。
  const CODEAGENT_QUOTA_DEFAULT_CACHE_MS = 30000;
  let quotaDefaults = {}, quotaDefaultsAt = 0;
  const quotaDefaultModels = keys => {
    if (Date.now() - quotaDefaultsAt >= CODEAGENT_QUOTA_DEFAULT_CACHE_MS || keys.some(key => !Object.hasOwn(quotaDefaults, key))) {
      quotaDefaults = Object.fromEntries(keys.map(key => [key, codeagentModelList(key === 'personal' ? { account: 'personal' } : { account: 'pool', poolAccount: key }, { refresh: false }).defaultModel || '']));
      quotaDefaultsAt = Date.now();
    }
    return quotaDefaults;
  };
  ipcMain.handle('codeagent:usage', () => {
    try {
      const accounts = require('../../core/codeagent-usage-menu').readUsage(require('../../core/data-dir').getHubDataDir());
      return { ok: true, accounts, defaultModels: quotaDefaultModels(Object.keys(accounts)) };
    }
    catch (error) { return { ok: false, accounts: {}, error: error.message }; }
  });
  ipcMain.handle('codeagent:usage-record', (_event, payload = {}) => {
    const key = typeof payload.key === 'string' && /^[\w.-]{1,80}$/.test(payload.key) ? payload.key : '';
    if (!key || !payload.usage || typeof payload.usage !== 'object') return { ok: false };
    if (!require('../../core/codeagent-usage-menu').hasModelTokens(payload.usage)) {
      const diagnostic = require('../../core/codeagent-usage-menu').appendUsageDiagnostic(require('../../core/data-dir').getHubDataDir(), payload.menuLines, { source: 'screen' });
      payload.usage.modelsRead = { status: 'unrecognized', diagnostic };
    }
    recordCodeAgentUsage(key, payload.usage, { label: typeof payload.label === 'string' ? payload.label.slice(0, 80) : '', source: 'screen' });
    return { ok: true };
  });
  // 运行中会话的模型菜单（2026-10-28）：只列这个会话所在的号能用的模型——个人号会话列个人号的清单（例如 GLM-5.2 和 DeepSeek），
  // 号池会话列那个号的。以前菜单用所有 CodeAgent 会话共用的一份列表，取决于启动中心最后选的是哪个号。
  // automatic：无人值守的自动会话不在中途切模型（runCodeAgentPick 同一份名单），菜单只显示、不让点。
  ipcMain.handle('codeagent:session-models', (_event, payload = {}) => {
    const session = typeof payload.sessionId === 'string' ? sessionManager.getSession(payload.sessionId) : null;
    if (!session) return { options: [], error: 'session-not-found' };
    const automatic = isAutomaticCodeAgent(session) && !session.modelConfirmationRequired;
    const list = session.codeagentPoolAccount
      ? codeagentModelList({ account: 'pool', poolAccount: session.codeagentPoolAccount })
      : codeagentModelList({ account: 'personal' });
    return { ...list, automatic, account: session.codeagentPoolAccount ? 'pool' : 'personal' };
  });
  function codeagentModelList(payload, { refresh = true } = {}) {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      const asOptions = (key, dir) => {
        const models = require('../../core/codeagent-models');
        return models.modelOptions(getHubDataDir(), { accountKey: key, configDir: dir, includeUnavailable: true });
      };
      const catalogFor = (key, dir) => {
        const catalog = require('../../core/codeagent-models').readModelCatalog(getHubDataDir(), { accountKey: key, configDir: dir });
        const error = codeagentProbeFailures.get(key) || '';
        const state = codeagentProbing.has(key) ? 'loading' : error ? 'failed' : catalog ? 'ready' : 'loading';
        const updated = catalog?.at ? `更新于 ${new Date(catalog.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
        return { state, at: catalog?.at || null, source: catalog?.source || null, error,
          message: [updated, error ? `本次读取失败：${error}` : state === 'loading' ? '正在读取 CodeAgent 模型清单…' : ''].filter(Boolean).join(' · ') };
      };
      // defaultModel：不选具体模型时这个号启动会用的模型（启动中心把「沿用」那一项标成它，2026-10-19 用户：选了号就默认选中该号的默认模型）。
      const sameCase = (list, id) => (list || []).find(m => String(m).toLowerCase() === String(id || '').toLowerCase()) || '';
      if (payload && payload.account === 'pool' && payload.poolAccount) {
        const account = codeagentPoolAccounts().find(a => a.id === payload.poolAccount);
        if (!account) return { options: [] };
        if (refresh && account.state === 'ready' && !account.sameAsPersonal && !account.duplicateOf && codeagentProbeStale(account.modelsProbedAt, account.modelsSource, { opening: true, parserVersion: account.modelsParserVersion })) {
          try { autoProbeCodeAgentAccount(account.id); } catch { /* 只影响下次 */ }
        }
        const options = asOptions(account.id, account.dir);
        return { options, catalog: catalogFor(account.id, account.dir), defaultModel: sameCase(options.map(option => option.id), pool.plannedModel(account.dir, { idle: !account.activeSessions })) };
      }
      if (payload && payload.account === 'pool') {
        // 自动挑号：各个可用号的默认模型都一样时才能说定
        const usable = codeagentPoolAccounts().filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf);
        const defaults = [...new Set(usable.map(a => sameCase(a.models, pool.plannedModel(a.dir, { idle: !a.activeSessions }))))];
        const options = [];
        for (const account of usable) for (const option of asOptions(account.id, account.dir)) {
          const at = options.findIndex(item => item.id.toLowerCase() === option.id.toLowerCase());
          // 同名模型：只要有一个号能用就算能用（自动挑号会挑能用的号），可用项替换先到的置灰项（Codex 审查 P2-3）。
          if (at < 0) options.push(option);
          else if (options[at].unavailable && !option.unavailable) options[at] = option;
        }
        const catalogs = usable.map(account => catalogFor(account.id, account.dir));
        const error = [...new Set(catalogs.map(catalog => catalog.error).filter(Boolean))].join('；');
        const catalog = usable.length === 1 ? catalogs[0] : {
          state: catalogs.some(item => item.state === 'loading') ? 'loading' : error ? 'failed' : options.length ? 'ready' : 'loading',
          error, message: [...new Set(catalogs.map(item => item.message).filter(Boolean))].join('；') || '正在读取 CodeAgent 模型清单…',
        };
        return { options, catalog, defaultModel: defaults.length === 1 ? defaults[0] : '' };
      }
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      let defaultModel = '';
      // single：权限清单权威且只有一个模型时，不选具体模型启动就走它（core/codeagent-pool.js personalDefaultModel 的例外）。
      // 2026-10-22 起手动新建的会话也按这个模型启动（session-manager 的启动核对），所以这里和启动口径一致地把「默认」那一项写成它，
      // 用户开之前就能看到会用什么模型；清单有多个或未知时仍为空，界面照旧写「沿用 CodeAgent 当前模型」。
      try { defaultModel = require('../../core/codeagent-model-route').personalModels({ dataDir: getHubDataDir(), personalDir, single: true }).defaultModel || ''; } catch { defaultModel = ''; }
      // 多个模型时（2026-10-29）：和新建会话的启动判断（core/codeagent-launch-model.js）同一口径算出不选模型时会用哪个——
      // CodeAgent 记着的、或这个号上次选的；只能「选菜单第一个」时说不出名字，留空。
      if (!defaultModel) {
        try {
          const launchModel = require('../../core/codeagent-launch-model');
          const known = pool.accountModels(personalDir, undefined, pool.personalModelsFile(getHubDataDir()));
          const last = launchModel.lastEntry(getHubDataDir(), 'personal');
          let settingsAt = 0;
          try { settingsAt = require('fs').statSync(require('path').join(personalDir, 'settings.json')).mtimeMs; } catch { settingsAt = 0; }
          // 这里只计算“沿用”的显示名，不据此跳过新会话的菜单检查。
          const choice = launchModel.chooseLaunchModel({ models: known.models, authoritative: known.authoritative, singleModelReliable: true, current: pool.readSettingsModel(personalDir),
            currentNewer: settingsAt > last.at, last: last.model, first: require('../../core/codeagent-model-picker').FIRST_MENU_MODEL });
          if (choice.model && !require('../../core/codeagent-model-picker').isFirstMenuModel(choice.model)) defaultModel = choice.model;
        } catch { /* 说不定就留空，界面写「自动」 */ }
      }
      // 个人账号：一键获取过模型权限就用读到的菜单，否则沿用原来的清单
      const probed = require('../../core/codeagent-model-probe').readProbed(pool.personalModelsFile(getHubDataDir()));
      // 清单过期时后台补读；旧解析版本不参与下拉过滤，等新结果替换。
      if (refresh && codeagentProbeStale(probed?.at, probed?.source, { opening: true, parserVersion: probed?.parserVersion })) { try { autoProbeCodeAgentAccount('personal'); } catch { /* 只影响下次 */ } }
      const options = asOptions('personal', personalDir);
      return { options, catalog: catalogFor('personal', personalDir), defaultModel: sameCase(options.map(o => o.id), defaultModel) };
    } catch (error) { return { options: [], error: error.message }; }
  }
  // CodeAgent 号池（core/codeagent-pool.js）：列表、添加（开登录窗口）、重新登录、备注、移出。
  function codeagentPoolAccounts() {
    const { getHubDataDir } = require('../../core/data-dir');
    const pool = require('../../core/codeagent-pool');
    const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
    return pool.listAccounts(getHubDataDir(), { activeCounts: sessionManager.codeagentPoolActiveCounts(),
      personalAccountId: pool.readCredentials(personalDir).accountId });
  }
  // 同一次快照里，共享的模型菜单和暂停状态文件只读一次（core/read-scope.js）。
  function codeagentPoolStatus() { return require('../../core/read-scope').withReadScope(buildCodeagentPoolStatus); }
  function buildCodeagentPoolStatus() {
    const { getHubDataDir } = require('../../core/data-dir');
    const pool = require('../../core/codeagent-pool');
    const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
    const personal = pool.readCredentials(personalDir);
    const personalModels = pool.accountModels(personalDir, undefined, pool.personalModelsFile(getHubDataDir()));
    const accounts = codeagentPoolAccounts().map(({ dir, ...rest }) => ({ ...rest,
      modelOptions: require('../../core/codeagent-models').modelOptions(getHubDataDir(), { configDir: dir, accountKey: rest.id }) }));
    // 本机各账号进行中的 CodeAgent 会话数（休眠的不算）：个人账号 = 没有号池标记的 CodeAgent 会话
    const personalActive = sessionManager.getAllSessions().filter(s => /^codeagent(?:-resume)?$/.test(String(s.kind || ''))
      && !s.codeagentPoolAccount && s.status !== 'dormant' && s.status !== 'closed').length;
    // 额度感知（2026-10-18，core/codeagent-quota.js）：每个号的避让状态（原因、预计恢复）与最近的 Credit 读数，页签上显示并可手动暂停 / 恢复。
    const quota = require('../../core/codeagent-quota');
    let avoid = {}, credit = {}, rules = null;
    try { avoid = quota.activeAvoid(getHubDataDir()); credit = quota.creditReadings(getHubDataDir()); } catch { /* 读不到就都按可用显示 */ }
    // 默认模型和权限不符（个人账号）：只显示，不改 settings.json
    let personalCheck = null;
    try { personalCheck = require('../../core/codeagent-model-route').personalModels({ dataDir: getHubDataDir(), personalDir }); } catch { personalCheck = null; }
    // 模型配置避让（2026-10-19）：整号没在避让时，显示和这个号此刻会请求的模型对得上的那条（含已到试探时间的）；
    // 配置已改成别的模型、或只是某个会话里临时换过的不显示（审核 2026-10-19）
    try {
      const all = quota.modelAvoidAll(getHubDataDir());
      const configModelOf = key => {
        if (key === 'personal') return personalCheck ? (personalCheck.written || personalCheck.defaultModel || '') : '';
        const a = codeagentPoolAccounts().find(x => x.id === key);
        // 账号即模型（切号开关关着）：号此刻会请求的就是它自己写的值，不推断
        return a ? (require('../../core/codeagent-model-route').routeSwitchEnabled() ? pool.effectiveModel(a.dir) : pool.readSettingsModel(a.dir)) : null;
      };
      for (const key of Object.keys(all)) {
        if (avoid[key]) continue;
        const cm = configModelOf(key);
        if (cm == null) continue;
        const e = quota.modelAvoidEntry(all, key, cm);
        if (e) avoid[key] = e;
      }
    } catch { /* 读不到就按可用显示 */ }
    try { const loaded = quota.loadRules(getHubDataDir()); rules = { count: loaded.rules.length, file: loaded.file, errors: loaded.errors }; } catch { rules = null; }
    const quotaOf = key => ({ avoid: avoid[key] ? { ...avoid[key], label: quota.describeAvoid(avoid[key]) } : null, credit: credit[key] || null });
    return { ok: true, accounts: accounts.map(a => ({ ...a, ...quotaOf(a.id) })), checkedAt: new Date().toISOString(),
      usable: accounts.filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf).length, quotaRules: rules,
      personal: { accountLabel: pool.maskAccountId(personal.accountId), method: personal.method || null, present: !!personal.present,
        modelOptions: require('../../core/codeagent-models').modelOptions(getHubDataDir(), { configDir: personalDir }),
        // 登录状态（2026-10-19）：ready / expired / login-required / unreadable；启动中心据此提示「个人账号要重新登录」
        state: pool.accountState(personal), expiresAt: personal.expiresAt || null, ...(personal.detail ? { credentialsNote: personal.detail } : {}),
        activeSessions: personalActive, models: personalModels.models, modelsProbedAt: personalModels.probedAt || null, modelsSource: personalModels.probedSource || null, modelsParserVersion: personalModels.probedParserVersion, ...quotaOf('personal'),
        ...(personalCheck && personalCheck.configMismatch ? { configNote: require('../../core/codeagent-model-route').describeMismatch(personalCheck.configMismatch) } : {}) } };
  }
  // 一键获取模型权限：后台起这个账号的 CodeAgent 读 /model 菜单（core/codeagent-model-probe.js），一次只跑一个。
  // v2.1.6（2026-10-16 用户「按计划推进」）：新添加的号登录完成、导入本机已登录的号、以及从没获取过的号（含个人账号），
  // Hub 自动在后台获取一次，不用手动点；每个号每次运行 Hub 只自动试一次，失败了仍可手动点「获取」。
  let codeagentProbeChain = Promise.resolve();
  let codeagentProbeJobs = 0;
  const codeagentProbing = new Set();
  // CodeAgent /model 菜单里读到的用量：记快照后通知界面刷新额度条（失败只影响显示）。
  function recordCodeAgentUsage(key, usage, options = {}) {
    try {
      const entry = require('../../core/codeagent-usage-menu').recordUsage(require('../../core/data-dir').getHubDataDir(), key, usage, options);
      if (entry) sendToRenderer('codeagent-usage-changed', { key });
    } catch { /* 只影响用量显示 */ }
  }
  const codeagentAutoTried = new Map(); // 号 → { at: 上次自动获取的时间, serveOk: 那次是否经 serve 读成功 }
  const codeagentLastSource = new Map(); // 号 → 上次获取成功走的路（serve / menu）
  const codeagentProbeFailures = new Map();
  const codeagentServeEnabled = dataDir => require('../../core/codeagent-serve').serveEnabled(dataDir);
  const codeagentProbePending = new Map();
  const codeagentServePending = new Map();
  function queueCodeAgentProbe(run) {
    codeagentProbeJobs += 1;
    const next = codeagentProbeChain.then(run, run);
    codeagentProbeChain = next.catch(() => {});
    return next.finally(() => { codeagentProbeJobs -= 1; });
  }
  // The timer, sidebar and usage/model popup share a queued account read and
  // publish it once. Only the model probe may subsequently fall back to PTY.
  function readCodeAgentServeAccount(key, options, label, reason = 'models') {
    if (codeagentServePending.has(key)) return codeagentServePending.get(key);
    const task = queueCodeAgentProbe(async () => {
      const menu = require('../../core/codeagent-usage-menu');
      const serve = require('../../core/codeagent-serve');
      const cleanVersion = menu.readUsage(options.dataDir)[key]?.dirtyVersion || 0;
      usageRefresher.noteAttempt(key);
      let served;
      try { served = await (codeagentServeRead || serve.readAccount)({ ...options, readyTimeoutMs: 20000 }); }
      catch (error) { served = { ok: false, error: error.message }; }
      require('../../core/codeagent-models').appendModelLog(options.dataDir, {
        event: 'serve-read', account: key, ok: !!served?.ok, ms: served?.readyMs, reason,
        ...(served?.ok ? { models: (served.models || []).join('+') } : { error: served?.error || '未知' }),
        ...(served?.skipped?.length ? { skippedProviders: served.skipped.map(p => `${p.id}:${p.status}:${p.models}`).join('+') } : {}),
      });
      if (served?.ok) {
        if (served.models?.length) {
          const pool = require('../../core/codeagent-pool');
          const probe = require('../../core/codeagent-model-probe');
          const current = pool.readSettingsModel(options.configDir);
          const file = key === 'personal' ? pool.personalModelsFile(options.dataDir) : require('path').join(options.configDir, probe.MODELS_FILE);
          probe.writeProbed(file, { ...served, source: 'serve',
            defaultModel: served.models.find(model => model.toLowerCase() === String(current || '').toLowerCase()) || '' });
          codeagentLastSource.set(key, 'serve');
          codeagentProbeFailures.delete(key);
        }
        const entry = menu.recordUsage(options.dataDir, key, serve.toUsageSnapshot(served), { label, source: 'serve', cleanVersion });
        if (entry) sendToRenderer('codeagent-usage-changed', { key });
      }
      return served;
    }).finally(() => { codeagentServePending.delete(key); });
    codeagentServePending.set(key, task);
    return task;
  }
  const quotaPanel = require('../../core/codeagent-quota-panel').createCodeAgentQuotaPanel({
    now: codeagentQuotaNow,
    getStatus: codeagentPoolStatus,
    readUsage: () => require('../../core/codeagent-usage-menu').readUsage(require('../../core/data-dir').getHubDataDir()),
    serveEnabled: () => require('../../core/codeagent-serve').quotaReadEnabled(),
    getDefaultModels: quotaDefaultModels,
    describeError: error => require('../../core/codeagent-quota').redactSnippet(error?.message || String(error)),
    refreshAccount: async key => {
      const dataDir = require('../../core/data-dir').getHubDataDir();
      if (!require('../../core/codeagent-serve').quotaReadEnabled()) throw new Error('当前未启用 CodeAgent serve 读取');
      const pool = require('../../core/codeagent-pool');
      const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
      const account = key === 'personal' ? null : codeagentPoolAccounts().find(row => row.id === key);
      if (key !== 'personal' && !account) throw new Error('号池里没有这个账号');
      const configDir = account ? account.dir : config.configDir;
      const state = account ? account.state : pool.accountState(pool.readCredentials(configDir));
      if (state !== 'ready') throw new Error('这个账号需要先登录才能刷新额度');
      const serve = require('../../core/codeagent-serve');
      const served = await readCodeAgentServeAccount(key, { command: config.command,
        configDirEnv: config.configDirEnv, configDir, dataDir, cwd: pool.probeCwd(dataDir) }, account ? pool.label(account) : '个人账号', 'quota');
      if (!served?.ok) throw new Error(served?.error || 'CodeAgent serve 读取失败');
      const usage = serve.toUsageSnapshot(served);
      if (!usage?.credit && !require('../../core/codeagent-usage-menu').hasModelTokens(usage)) throw new Error('本次未读到额度，保留上次读数');
      const entry = require('../../core/codeagent-usage-menu').readUsage(dataDir)[key];
      if (!entry) throw new Error('本次未读到有效额度，保留上次读数');
    },
  });
  // 额度低频自动读取（2026-11-05 用户定）。隔离实例和单测默认不跑，免得多起 CLI；要测时设 CLAUDE_HUB_CODEAGENT_QUOTA_AUTO_MS。
  const quotaAutoMs = Number(process.env.CLAUDE_HUB_CODEAGENT_QUOTA_AUTO_MS) || 0;
  let quotaAutoRefresh = null;
  if (require('../../core/distribution').kindAllowed('codeagent') && (quotaAutoMs > 0
    || (!process.env.CLAUDE_HUB_DATA_DIR && process.env.CLAUDE_HUB_E2E !== '1' && !process.env.NODE_TEST_CONTEXT))) {
    quotaAutoRefresh = require('../../core/codeagent-quota-auto-refresh').createQuotaAutoRefresh({
      // 低开销模式（2026-11-23）：设置页「资源与后台」关了这项就跳过这一轮，不起临时 serve；手动刷新不受影响。
      run: async () => (require('../../core/optional-features').backgroundOn('quotaRefresh') ? quotaPanel.refreshDue() : { skipped: 'off' }),
      log: entry => { try { require('../../core/codeagent-models').appendModelLog(require('../../core/data-dir').getHubDataDir(), entry); } catch { /* 日志写不了不影响读取 */ } },
      ...(quotaAutoMs > 0 ? { intervalMs: quotaAutoMs, firstDelayMs: quotaAutoMs } : {}),
    });
    quotaAutoRefresh.start();
  }
  // 真正退出时停掉自动读取，并结束正在跑的临时 serve（手动刷新、读模型清单起的也算），否则它会留在后台。
  require('../../core/codeagent-quota-auto-refresh').installQuotaQuitCleanup({ app,
    stopAutoRefresh: () => quotaAutoRefresh?.stop(), shutdownServes: () => { require('../../core/dsh-card-host').shutdownDshCardHosts(); require('../../core/codeagent-serve-host').shutdownHosts(); return require('../../core/codeagent-serve').shutdownTempServes(); } });
  if (deps.lanPoolService) deps.lanPoolService.quotaReader = () => quotaPanel.snapshot();
  ipcMain.handle('codeagent:quota-panel', async (_event, payload = {}) => {
    try {
      if (!require('../../core/distribution').kindAllowed('codeagent')) throw new Error('当前发行版未开放 CodeAgent');
      const shared = await deps.lanPoolService?.snapshot({ force: payload.refresh === true });
      return shared || await quotaPanel.snapshot(payload);
    } catch (error) {
      return { ok: false, rows: [], usage: {}, creditReadings: {},
        error: require('../../core/codeagent-quota').redactSnippet(error.message) };
    }
  });
  const { createUsageRefresher, CODEAGENT_SERVE_MAX_AGE_MS } = require('../../core/codeagent-usage-menu');
  const commandsProbeScheduler = require('../../core/codeagent-commands-probe').createCommandsProbeScheduler({
    dataDir: require('../../core/data-dir').getHubDataDir(),
    getVersion: () => {
      const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
      return (codeagentCommandVersionProbe || require('../../core/codeagent-version-probe').codeagentVersion)(config.command);
    },
    probe: (session, version, { trace, force }) => {
      const run = async () => {
        const dataDir = require('../../core/data-dir').getHubDataDir();
        const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
        const configDir = require('../../core/codeagent-default-model-guard').sessionConfigDir(session, { dataDir });
        const result = await (codeagentProbeModels || require('../../core/codeagent-model-probe').probeModels)({
          ...config, configDir, dataDir, accountKey: session.codeagentPoolAccount || 'personal', cliVersion: version,
          cwd: require('../../core/codeagent-pool').probeCwd(dataDir), commandsOnly: true, probeTrace: trace, forceCommands: force,
        });
        return result.commandsProbe || { ok: false, reason: 'commands-unavailable' };
      };
      const previous = codeagentProbeChain;
      const task = require('../../core/codeagent-commands-probe').queueCommandsProbe(previous, run, { trace, pending: codeagentProbeJobs > 0 });
      codeagentProbeJobs += 1;
      // A timed-out job never starts later. Keep the prior PTY barrier so a
      // still-running probe cannot overlap the next account's hidden process.
      codeagentProbeChain = Promise.all([previous.catch(() => {}), task.catch(() => {})]).then(() => {});
      return task.finally(() => { codeagentProbeJobs -= 1; });
    },
    onResult: result => require('../../core/codeagent-models').appendModelLog(require('../../core/data-dir').getHubDataDir(), {
      event: 'commands-probe', result: result.skipped ? 'skipped' : result.ok ? 'read' : 'failed', reason: result.reason || '',
    }),
  });
  const usageRefresher = createUsageRefresher({
    read: key => require('../../core/codeagent-usage-menu').readUsage(require('../../core/data-dir').getHubDataDir())[key],
    probe: key => probeCodeAgentAccount(key),
  });
  ipcMain.handle('codeagent:usage-refresh', async (_event, payload = {}) => {
    let result;
    try {
      const pool = require('../../core/codeagent-pool');
      const accounts = codeagentPoolAccounts();
      const key = typeof payload.key === 'string' && payload.key ? payload.key
        : payload.label === '个人账号' ? 'personal'
          : accounts.find(account => pool.label(account) === payload.label)?.id;
      if (key !== 'personal' && !accounts.some(account => account.id === key)) throw new Error('找不到这个 CodeAgent 账号');
      const dir = key === 'personal' ? require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir : accounts.find(account => account.id === key).dir;
      const models = require('../../core/codeagent-models').readModelCatalog(require('../../core/data-dir').getHubDataDir(), { configDir: dir, accountKey: key })?.models || [];
      result = { ...await (payload.open || payload.force ? usageRefresher.open(key, { models, force: payload.force === true }) : usageRefresher.refresh(key)), key };
    } catch (error) { result = { ok: false, outcome: 'failed', reason: error.message, error: error.message }; }
    require('../../core/codeagent-models').appendModelLog(require('../../core/data-dir').getHubDataDir(), {
      event: 'usage-refresh', result: result.outcome || (result.ok ? 'read' : 'failed'), reason: result.reason || '',
    });
    return result;
  });
  function probeCodeAgentAccount(id) {
    if (codeagentProbePending.has(id)) return codeagentProbePending.get(id);
    const run = async () => {
      usageRefresher.noteAttempt(id);
      codeagentProbing.add(id);
      try {
        const { getHubDataDir } = require('../../core/data-dir');
        const pool = require('../../core/codeagent-pool');
        const probe = require('../../core/codeagent-model-probe');
        const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
        const dataDir = getHubDataDir();
        let configDir, file, label = '个人账号';
        if (id === 'personal') { configDir = config.configDir; file = pool.personalModelsFile(dataDir); }
        else {
          const account = codeagentPoolAccounts().find(a => a.id === id);
          if (!account) throw new Error('号池里没有这个账号');
          if (account.state !== 'ready') throw new Error('这个号需要先重新登录');
          configDir = account.dir; file = require('path').join(account.dir, probe.MODELS_FILE);
          label = pool.label(account);
        }
        const probeOptions = { command: config.command, configDirEnv: config.configDirEnv, configDir, dataDir, accountKey: id, cwd: pool.probeCwd(dataDir) };
        const cleanVersion = require('../../core/codeagent-usage-menu').readUsage(dataDir)[id]?.dirtyVersion || 0;
        // 2026-10-30 用户：先用 CodeAgent 自带的 serve 接口读（约 3 秒，还带额度和每个模型的配额），读不到再开 CodeAgent 读 /model 屏幕。
        // 默认先读本机临时 serve，失败再用同账号读屏；始终用完即关。
        // AI_HUB_CODEAGENT_SERVE=1 强制打开、=0 强制关掉。
        let result = null;
        let serveError = '';
        if (codeagentServeEnabled(dataDir)) {
          const served = await readCodeAgentServeAccount(id, probeOptions, label);
          if (served && served.ok) {
            const current = pool.readSettingsModel(configDir);
            // 用量换成 /model 菜单用量快照的格式（core/codeagent-usage-menu.js），额度条和模型下拉照原样显示
            result = { ok: true, models: served.models, source: 'serve',
              defaultModel: served.models.find(m => m.toLowerCase() === String(current || '').toLowerCase()) || '',
              usage: require('../../core/codeagent-serve').toUsageSnapshot(served) };
          } else {
            serveError = served?.error || 'serve 读取失败';
          }
        }
        if (!result) result = await queueCodeAgentProbe(() => (codeagentProbeModels || probe.probeModels)(probeOptions));
        if (!result.ok) throw new Error(probe.describeModelReadFailure(serveError, result.error));
        if (result.source !== 'serve') probe.writeProbed(file, result);
        if (result.menuComplete) require('../../core/codeagent-models').recordMenu(dataDir, result.models, { key: id, complete: true });
        codeagentLastSource.set(id, result.source === 'serve' ? 'serve' : 'menu');
        if (result.usage && result.source !== 'serve') recordCodeAgentUsage(id, result.usage, { label, source: 'probe', cleanVersion });
        codeagentProbeFailures.delete(id);
        return result.models;
      } catch (error) {
        codeagentProbeFailures.set(id, require('../../core/codeagent-quota').redactSnippet(error.message).slice(0, 200));
        throw error;
      } finally { codeagentProbing.delete(id); }
    };
    const tracked = Promise.resolve().then(run).finally(() => { codeagentProbePending.delete(id); });
    codeagentProbePending.set(id, tracked);
    return tracked;
  }
  // 清单 3 天一过就后台补读。经 serve 读到的（约 3 秒、读完即关）在打开模型下拉时 10 分钟就再读一次，让用量接近实时；
  // 不常驻、不定时轮询（2026-10-30 用户：常驻 serve 不划算）。
  const CODEAGENT_PROBE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
  function codeagentProbeStale(at, source, { opening = false, parserVersion } = {}) {
    if (opening && source !== 'serve' && codeagentServeEnabled(require('../../core/data-dir').getHubDataDir())) return true;
    if (source === 'menu' && parserVersion !== require('../../core/codeagent-models').MODEL_MENU_PARSER_VERSION) return true;
    const time = at ? Date.parse(at) : NaN;
    return !Number.isFinite(time) || Date.now() - time > (opening && source === 'serve' ? CODEAGENT_SERVE_MAX_AGE_MS : CODEAGENT_PROBE_MAX_AGE_MS);
  }
  // 自动获取：上次经 serve 读成功的号隔 10 分钟才再读；失败过（或走了读屏）的号本次运行 Hub 不再自动试，免得反复开 CodeAgent 读屏。
  function autoProbeCodeAgentAccount(id) {
    const last = codeagentAutoTried.get(id);
    if (usageRefresher.nextRefreshAt(id) > Date.now()) return;
    if ((last && !(last.serveOk && Date.now() - last.at >= CODEAGENT_SERVE_MAX_AGE_MS)) || codeagentProbing.has(id)) return;
    const tried = { at: Date.now(), serveOk: false };
    codeagentAutoTried.set(id, tried);
    codeagentProbing.add(id);
    sendToRenderer('codeagent-pool:changed', { id, probing: true });
    probeCodeAgentAccount(id)
      .then(models => { tried.serveOk = codeagentLastSource.get(id) === 'serve'; sendToRenderer('codeagent-pool:changed', { id, ok: true, models, auto: true }); })
      .catch(error => sendToRenderer('codeagent-pool:changed', { id, ok: false, error: error.message, auto: true }));
  }
  // 号主在登录窗口里登录完成前凭证文件还不存在：每 3 秒看一次，最多 10 分钟，出现了就自动获取模型权限。
  // id = 'personal' 时看个人账号的配置目录（个人账号重新登录，2026-10-19）。
  function autoProbeAfterLogin(id) {
    codeagentAutoTried.delete(id);
    const deadline = Date.now() + 10 * 60 * 1000;
    const stateOf = () => {
      if (id !== 'personal') { const account = codeagentPoolAccounts().find(a => a.id === id); return account ? account.state : null; }
      const pool = require('../../core/codeagent-pool');
      return pool.accountState(pool.readCredentials(require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir));
    };
    const tick = () => {
      let state = null;
      try { state = stateOf(); } catch { return; }
      if (!state) return;
      if (state === 'ready') { sendToRenderer('codeagent-pool:changed', { id, loggedIn: true }); autoProbeCodeAgentAccount(id); return; }
      if (Date.now() < deadline) setTimeout(tick, codeagentLoginPollMs).unref?.();
    };
    setTimeout(tick, codeagentLoginPollMs).unref?.();
  }
  // 列表里从没获取过、或获取已超过 3 天的号（含个人账号）自动补一次（每次运行 Hub 每个号最多一次）。
  // 2026-10-29 公司真机（Q-1029-12）：个人账号 10-16 获取的清单只有 GLM，后来账号加了 DeepSeek，模型下拉一直只列 GLM。
  // 装上就能看到 serve 真跑了；读到的是 CodeAgent 自己的模型名，启动时只传 --model 就够，见 session-manager 的 cli-flag）。
  function autoProbeMissing(status, { startup = false } = {}) {
    if (!status || status.ok === false) return;
    const serveOn = startup && codeagentServeEnabled(require('../../core/data-dir').getHubDataDir());
    const due = (at, source, parserVersion) => codeagentProbeStale(at, source, { parserVersion }) || (serveOn && source !== 'serve');
    if (status.personal && status.personal.present && due(status.personal.modelsProbedAt, status.personal.modelsSource, status.personal.modelsParserVersion)) autoProbeCodeAgentAccount('personal');
    for (const a of status.accounts || []) {
      if (a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf && due(a.modelsProbedAt, a.modelsSource, a.modelsParserVersion)) autoProbeCodeAgentAccount(a.id);
    }
  }
  ipcMain.handle('codeagent-pool:probe', (_event, payload) => {
    const id = payload?.id;
    return probeCodeAgentAccount(id)
      .then(models => ({ ...codeagentPoolStatus(), probed: { id, models } }))
      .catch(error => ({ ok: false, error: error.message }));
  });
  // 开 Hub 后 20 秒在后台补一次（2026-10-29 用户：装好点启动，启动中心就能直接选到账号的全部模型，不用先去点「获取」）。
  // 只对从没获取过或超过 3 天的号，规则同上；本机没登录 CodeAgent 时什么也不做。
  // 隔离实例（设了 CLAUDE_HUB_DATA_DIR）和单测里不做，免得测试里多起一个 CLI；要测它时设 CLAUDE_HUB_CODEAGENT_STARTUP_PROBE=1。
  if (process.env.CLAUDE_HUB_CODEAGENT_STARTUP_PROBE === '1'
    || (!process.env.CLAUDE_HUB_DATA_DIR && process.env.CLAUDE_HUB_E2E !== '1' && !process.env.NODE_TEST_CONTEXT)) {
    setTimeout(() => { try { autoProbeMissing(codeagentPoolStatus(), { startup: true }); } catch { /* 下次打开启动中心或号池页再补 */ } }, codeagentStartupProbeMs).unref?.();
  }
  ipcMain.handle('codeagent-pool:list', () => {
    try { const status = codeagentPoolStatus(); autoProbeMissing(status); return { ...status, probing: [...codeagentProbing] }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // 会话栏的账号字母与代称（core/codeagent-account-badge.js）：只读凭证元数据，不触发获取模型权限。
  ipcMain.handle('codeagent-pool:badges', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      return { ok: true, ...require('../../core/codeagent-account-badge').accountBadges({ dataDir: getHubDataDir(), personalDir }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:add', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
      const id = pool.addAccount(getHubDataDir(), { note: payload && payload.note, personalDir: config.configDir });
      pool.openLoginWindow(getHubDataDir(), id, config);
      autoProbeAfterLogin(id);
      sendToRenderer('codeagent-pool:changed', {});
      return { ...codeagentPoolStatus(), added: id };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:local', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      return { ok: true, candidates: require('../../core/codeagent-pool').localCandidates(getHubDataDir(), { personalDir }) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:import', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env).configDir;
      const id = require('../../core/codeagent-pool').importLocal(getHubDataDir(), payload?.dir, { note: payload?.note, personalDir });
      autoProbeCodeAgentAccount(id);
      sendToRenderer('codeagent-pool:changed', {});
      return { ...codeagentPoolStatus(), added: id, probing: [...codeagentProbing] };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:login', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const pool = require('../../core/codeagent-pool');
      if (!pool.readRegistry(getHubDataDir()).accounts.some(a => a.id === payload?.id)) throw new Error('号池里没有这个账号');
      pool.openLoginWindow(getHubDataDir(), payload.id, require('../../core/codeagent-config').resolveCodeAgentConfig(process.env));
      autoProbeAfterLogin(payload.id);
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // 个人账号重新登录（2026-10-19）：登录过期、凭证读不懂时，开同样的登录窗口，目录是个人账号的配置目录。
  ipcMain.handle('codeagent-pool:personal-login', () => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-pool').openLoginWindow(getHubDataDir(), 'personal', require('../../core/codeagent-config').resolveCodeAgentConfig(process.env), { personal: true });
      // 凭证出现后推送 codeagent-pool:changed（账号与号池、启动中心据此刷新），并重新获取模型权限
      autoProbeAfterLogin('personal');
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:note', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-pool').setNote(getHubDataDir(), payload?.id, payload?.note);
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // 手动暂停 / 恢复使用给一个号（额度感知，2026-10-18）：暂停 = 标「避让中」（hours 小时后自动恢复，不填 = 直到手动恢复）；
  ipcMain.handle('codeagent-pool:pause', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const id = String(payload?.id || '');
      if (id !== 'personal' && !require('../../core/codeagent-pool').readRegistry(getHubDataDir()).accounts.some(a => a.id === id)) throw new Error('没有这个账号');
      const hours = payload?.hours == null || payload.hours === '' ? null : Number(payload.hours);
      if (hours != null && !(hours >= 0.25 && hours <= 72)) throw new Error('暂停时长只能是 0.25–72 小时');
      require('../../core/codeagent-quota').markAvoid(getHubDataDir(), id, { source: 'manual', reason: '在这台电脑上手动暂停', until: hours ? Date.now() + hours * 3600000 : null });
      sendToRenderer('bridge:changed', {});
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:resume', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      require('../../core/codeagent-quota').clearAvoid(getHubDataDir(), String(payload?.id || ''), { by: 'local' });
      sendToRenderer('bridge:changed', {});
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('codeagent-pool:remove', (_event, payload) => {
    try {
      const { getHubDataDir } = require('../../core/data-dir');
      const active = sessionManager.codeagentPoolActiveCounts()[payload?.id] || 0;
      if (active) throw new Error(`还有 ${active} 个会话在用这个号，先关掉或让它们休眠再移出`);
      require('../../core/codeagent-pool').removeAccount(getHubDataDir(), payload?.id);
      sendToRenderer('codeagent-pool:changed', {});
      return codeagentPoolStatus();
    } catch (error) { return { ok: false, error: error.message }; }
  });
  // CodeAgent 换模型：在它自己的 /model 菜单里选（core/codeagent-model-picker.js）。交互模式不认 --model，
  // 以前「带 --model 重开」在公司真机上不生效（2026-10-14 同事反馈选了 MiniMax 仍是 GLM）。
  const codeagentPicker = require('../../core/codeagent-model-picker');
  const codeagentModels = require('../../core/codeagent-models');
  // 同一份名单。以前这里漏了 company-ai（AI 自己建的文字任务会话）：中途可以被切模型，启动选模型没成时也不走
  // 「能发就发」的兜底，第一条消息可能被挡住（2026-10-28 对照补上）。
  const AUTOMATIC_CODEAGENT_PURPOSES = require('../../core/auto-dispatch-rules').AUTO_PURPOSES;
  const isAutomaticCodeAgent = session => !!session && AUTOMATIC_CODEAGENT_PURPOSES.includes(session.purpose);
  async function runCodeAgentPick(sessionId, modelId, reason, selection = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, message: '会话已经关闭' };
    const selectedProvider = Object.hasOwn(selection, 'provider') ? selection.provider : session.codeagentModelProvider || '';
    const { getHubDataDir } = require('../../core/data-dir');
    const dataDir = getHubDataDir();
    const guard = require('../../core/codeagent-default-model-guard');
    // 当场在同一个会话里用 /model 切到清单里的模型再把这一轮重发一次。
    if (isAutomaticCodeAgent(session)
      && !(reason === 'switch' && (session.codeagentModelPick === true || selection.recovery === true))
      && reason !== 'launch' && reason !== 'relaunch' && reason !== 'model-config-fix') {
      codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), reason, model: modelId, ok: false, error: 'automatic-session' });
      return { ok: false, inputReady: true, message: '自动会话用账号自己的默认模型，不切换模型' };
    }
    // 菜单回车会写这个会话的 CodeAgent 实际用的配置目录：启动时记下的那个，规范化后快照、改回、核对都用它。
    const configDir = codeagentPicker.normalizeConfigDir(guard.sessionConfigDir(session, { dataDir }));
    const account = guard.accountOf(session, dataDir).alias;
    let before = '';
    try { before = String(JSON.parse(require('fs').readFileSync(require('path').join(configDir, 'settings.json'), 'utf8')).model || ''); } catch { before = ''; }
    // 菜单回车（CodeAgent 写）和改回原值（Hub 写）都是这次选择引起的：先登记，看护看到时认得出来源，这里自己记日志。
    guard.noteHubWrite(configDir, before, `picker-restore:${reason}`, { logged: true, session: String(sessionId).slice(0, 8) });
    // 打开真实菜单选中 want，不按旧清单拒绝或改选。
    // 手动会话（启动、原地重拉、界面上切换）选中的模型留作这个号的默认模型，下次新建直接用（2026-10-28 用户）；
    const keepDefault = !isAutomaticCodeAgent(session) && ['launch', 'relaunch', 'switch'].includes(reason);
    const driveMenu = async want => {
      guard.noteHubWrite(configDir, want, `codeagent-menu-enter:${reason}`, { logged: true, session: String(sessionId).slice(0, 8) });
      try {
        return await codeagentPicker.pickModel({ manager: sessionManager, sid: sessionId, kind: session.kind, modelId: want,
          provider: Object.hasOwn(selection, 'provider') ? selection.provider : session.codeagentModelProvider || '', providerLabel: Object.hasOwn(selection, 'providerLabel') ? selection.providerLabel : session.codeagentModelProviderLabel || '', menuLabel: Object.hasOwn(selection, 'menuLabel') ? selection.menuLabel : session.codeagentModelMenuLabel || '',
          configDir, dataDir,
          // 启动和原地重拉：等 CLI 画出普通输入框再敲 /model（太早敲回车会丢，见 pickModel 的 readyFirstMs）
          readyFirstMs: reason === 'launch' || reason === 'relaunch' ? 45000 : 0,
          keepDefault,
          onDefaultChange: change => guard.recordChange(dataDir, { account, session: String(sessionId).slice(0, 8), before: change.restoredTo || '', after: change.written || '',
            source: `codeagent-menu-enter:${reason}`, extra: { file: change.file, restoredTo: change.restoredTo || '(空)', restoreOk: change.ok, ...(change.error ? { restoreError: change.error } : {}) } }, { persist: false }),
          sendToPty: require('../../core/group-chat-watcher').sendToPty });
      } catch (error) { return { ok: false, technicalReason: error && error.message ? error.message : String(error), message: `这个账号在 CodeAgent 模型菜单里选不了 ${want}` }; }
    };
    let result = await driveMenu(modelId);
    if (result.loginRequired) return result;
    // 选菜单第一个（手动新建、没明确选模型，2026-10-25）：实际选中的是菜单第 1 行那个模型。
    const pickFirst = codeagentPicker.isFirstMenuModel(modelId);
    let picked = pickFirst ? (result.ok && result.picked) || '' : modelId;
    // 菜单里没有这个模型、按相近度改选了同家族的一个（core/model-name-match.js）：记成实际选中的那个，并在会话里说一行。
    if (result.ok && result.substituted && !pickFirst) {
      picked = result.substituted.id || result.substituted.to || modelId;
      sendToRenderer('session-notice', { sessionId, level: 'warning',
        message: require('../../core/model-name-match').substitutionNote(modelId, result.substituted.to) });
    }
    const automatic = isAutomaticCodeAgent(session);
    // 自动选模型的熔断计数（core/codeagent-auto-pick.js）：自动会话启动时菜单没选成记一次失败；这个号上任何一次选成就清零。
    const breakerAccount = session.codeagentPoolAccount || 'personal';
    let breaker = null;
    // 菜单打开了、也读到了，只是 Hub 自己没在里面对上这一行（名字或分组对不上）：这是匹配问题，不是菜单操作失败，
    // 不计入熔断——否则一次误判连续三问就把这个号的自动会话卡 4 小时（2026-11-25 同事反馈：助理更新后用不了）。
    // A menu that opened and was read but where Hub could not match the row is a matching issue, not a menu failure: it does not count.
    // menuMiss 只在菜单里有同名（或截断名像它）、却因分组消歧没选时才有；菜单里确实没有这个模型名照常计入熔断（3 次后跳过开菜单，省时间）。
    const matchFailure = !result.ok && !!(result.menuMiss || result.requiresGroupSelection);
    if ((result.ok || automatic || pickFirst) && !matchFailure) {
      try { breaker = require('../../core/codeagent-auto-pick').record(dataDir, breakerAccount, !!result.ok, { error: result.message || '' }); } catch { /* 计数失败不影响这一轮 */ }
    }
    if (breaker && breaker.opened) {
      codeagentModels.appendModelLog(dataDir, { event: 'pick-breaker-open', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''),
        failures: breaker.failures, until: new Date(breaker.until).toISOString(), note: '连续自动选模型没成功，4 小时内这个号的自动会话不开模型菜单、直接发问题，手动新建也不再选菜单第一个' });
    }
    // 自动会话没人守着：菜单没选上，但菜单已关、输入行可以用（认得出普通输入框，或旧版画面认不出、但已没有菜单和「/model」残留），
    // 就按 CLI 当前模型照常把问题发出去，失败只记在 pick 日志里，不卡住这一轮；回执里的模型按实际作答的模型（company.js 读原生记录）。
    // 选菜单第一个也是 Hub 自己替用户做的：没选上但输入框能用时同样照常发，第一条消息不被退回（会话里提示一句，见下面的 codeagent-model-pick 监听）。
    // 启动和原地重拉时选具体模型也一样（2026-11-08 公司实测：菜单把 deepseek-v4.1-flash-1017 显示成截断名、没选上，
    // 「问问 Agent」新建的会话首句被退回、会话页空着）：输入框能用就先用 CLI 当前模型把首句发出去，提示一句没切到哪个模型。
    const startupPick = reason === 'launch' || reason === 'relaunch';
    // 指定了供应商的自动会话（助理、分身）启动时选不上也照常用 CLI 当前模型发出去：没人守着，宁可按当前线路作答，也不让每一问都失败（鲁棒优先）。
    // 只限启动这一步（含选菜单第一个）：从错误卡片恢复、切换模型或线路（reason=switch）、按清单修复（model-config-fix）选不上时
    // 不能当成功，否则会话还是原模型却报切换成功、没确认的模型被记成用户的选择。
    // Fallback is limited to launch/relaunch and first-row picks; a failed switch, recovery or config fix is never reported as success.
    let fallback = (automatic && startupPick || !selectedProvider && !result.requiresGroupSelection) && !result.ok && (startupPick || pickFirst) && (result.inputReady || result.inputUsable);
    let fallbackNoticed = false;
    if (fallback && session.fixedModel) {
      const pin = require('../../core/session-model-pin');
      const known = guard.permittedModels(session, configDir, { dataDir });
      const actual = session.codeagentActualModel || before;
      if (session.modelConfirmationRequired || codeagentModels.modelFamily(actual) !== codeagentModels.modelFamily(session.fixedModel)
          || (!codeagentModels.modelFamily(session.fixedModel) && String(actual).toLowerCase() !== String(session.fixedModel).toLowerCase())
          || pin.unavailablePolicy(require('../../core/hub-config').getConfig().sessionModelUnavailablePolicy) === 'stop-and-ask'
          || !codeagentModels.isSafeModelId(actual) || known.authoritative && !known.models.some(id => id.toLowerCase() === actual.toLowerCase())) {
        if (automatic) {
          // 无人值守的自动会话（助理、分身等）：不停下来等人确认，照常按 CLI 当前模型发；记下已回退，
          // 之后发消息前不再核固定模型、不再触发选模型（core/session-manager.js ensureSessionModelReady）。2026-11-25 审查 P0。
          // Automatic sessions keep the fallback instead of waiting for a human, and later sends skip the model re-check.
          sessionManager.updateSessionMeta(sessionId, { codeagentModelPick: false, codeagentPickFallback: true });
          codeagentModels.appendModelLog(dataDir, { event: 'pick-fallback-kept', session: String(sessionId).slice(0, 8), want: session.fixedModel, actual: actual || '(空)' });
        } else {
          fallback = false;
          sessionManager.updateSessionMeta(sessionId, { codeagentModelPick: true, modelConfirmationRequired: true, modelUnavailableReason: '启动模型菜单未能选择原模型' });
          result = { ...result, message: `原模型 ${session.fixedModel} 不可用，请手动选择可用模型后继续。` };
          sendToRenderer('session-notice', { sessionId, level: 'error', persistent: true, modelUnavailable: true,
            originalModel: session.fixedModel, suggestedModel: known.models.find(id => id.toLowerCase() === String(actual).toLowerCase()) || known.models[0] || '',
            availableModels: known.models, message: result.message });
        }
      } else {
        const change = { from: session.fixedModel, to: actual, reason: '启动时的模型菜单未能选中原模型，改用账号当前模型', at: Date.now() };
        const file = require('path').join(dataDir, 'codeagent-launch', `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
        if (require('fs').existsSync(file)) require('../../core/session-manager')._private.writeCodeAgentLaunchSettings(dataDir, sessionId, actual);
        sessionManager.updateSessionMeta(sessionId, { fixedModel: actual, modelPinSource: 'auto-switch', modelChange: change,
          currentModel: { id: actual, displayName: codeagentModels.modelLabel(actual) }, codeagentModelPick: false });
        codeagentModels.appendModelLog(dataDir, { event: 'model-auto-switch', session: sessionId, ...change });
        sendToRenderer('session-notice', { sessionId, level: 'warning', persistent: true, message: pin.modelChangeMessage(change) });
        fallbackNoticed = true;
      }
    }
    // 回退的一行提示统一由启动选模型的调用方发（见下面 codeagent-model-pick 的处理）；这里已就固定模型改动发过提示时带回 fallbackNoticed，调用方不再重复。
    if (!result.ok && automatic && !fallback) {
      result = { ...result, message: `自动选模型没成功，模型菜单也没能关掉，为了不把问题打进菜单，这一轮没有发出去（原因：${result.message || '未知'}）` };
    }
    if (result.defaults) {
      guard.recordChange(dataDir, { account, session: String(sessionId).slice(0, 8), before: result.defaults.before || '', after: result.defaults.after || '',
        source: `picker:${reason}`, extra: { verified: result.defaults.verified, changes: result.defaults.changes.length } }, { persist: account === '个人' && result.defaults.changes.length > 0 });
      // 看守结束仍没改回：单独记一行，直查和排查一眼能看到这个号的默认模型停在了菜单改后的值
      if (!result.defaults.verified) codeagentModels.appendModelLog(dataDir, { event: 'default-model-restore-failed', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''),
        want: result.defaults.before || '(空)', now: result.defaults.after || '(空)', reason });
    }
    codeagentModels.appendModelLog(dataDir, { event: 'pick', session: String(sessionId).slice(0, 8), account: account.replace(/\s+/g, ''), reason, model: picked || modelId,
      ok: result.ok, mode: result.mode, confirmed: result.confirmed, restored: (result.restored || []).join('+'), menu: (result.menu || []).join('+'), error: result.ok ? '' : result.technicalReason || result.message, ...(selectedProvider ? { provider: selectedProvider } : {}), ...(matchFailure ? { breaker: 'not-counted' } : {}),
      fallback: fallback ? 'send-with-cli-model' : '', failures: breaker && !result.ok ? breaker.failures : '' });
    // 菜单上方的用量表（Credit 三档 + 每个模型的 Token 用量）：按会话用的号记快照，额度条和模型下拉显示（core/codeagent-usage-menu.js）。
    if (result.usage) recordCodeAgentUsage(session.codeagentPoolAccount || 'personal', result.usage, { label: session.codeagentPoolAccount ? (session.codeagentPoolLabel || '') : '个人账号', source: `picker:${reason}` });
    if (!result.ok && Array.isArray(result.screen)) {
      try {
        const file = require('path').join(getHubDataDir(), 'logs', 'codeagent-model-picker-last.txt');
        require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
        require('fs').writeFileSync(file, `${new Date().toISOString()} ${reason} ${modelId}：${result.technicalReason || result.message}\n\n${result.screen.join('\n')}\n`, 'utf8');
      } catch { /* 只是排查用的附件 */ }
    }
    // 自动会话没人守着：菜单没选上但普通输入框已恢复时，照旧按 CLI 当前模型把活发出去（和改动前一样），失败只记在上面的 pick 日志里，不卡住这一轮。
    if (fallback) {
      return { ...result, ok: true, fallback: 'cli-default-model', ...(fallbackNoticed ? { fallbackNoticed: true } : {}) };
    }
    // 留作默认的这次选择同时记成这个号的「上次」（带时间），下次新建和 CodeAgent 配置文件比先后（core/codeagent-launch-model.js）。
    if (result.ok && result.keptDefault && picked && !codeagentPicker.isFirstMenuModel(picked)) {
      try { require('../../core/codeagent-launch-model').rememberModel(dataDir, session.codeagentPoolAccount || 'personal', picked); }
      catch (error) { console.warn('[codeagent] 记住这次选的模型失败：' + error.message); }
    }
    if (result.ok) {
      // 真选上了模型：熔断期留下的暂缓线路、启动回退标记都作废（core/codeagent-assistant-route.js matchesSession）。
      const updated = sessionManager.updateSessionMeta(sessionId, { ...(result.provider ? { codeagentModelProvider: result.provider } : {}), currentModel: { id: picked, displayName: codeagentModels.modelLabel(picked) }, codeagentRequestedModel: undefined, codeagentRouteDeferred: undefined, codeagentPickFallback: undefined, codeagentModelPick: false,
        // 用户明确选中过的模型：CLI 自己退出、Hub 原地重拉时据此再选一次（core/session-manager.js 的 relaunch）。
        codeagentUserModel: picked, fixedModel: picked, ...(reason === 'switch' ? { modelConfirmationRequired: false, modelUnavailableReason: '' } : {}), modelPinSource: reason === 'switch' ? 'user' : session.modelPinSource || 'created',
        ...(reason === 'switch' ? { modelChange: null } : {}) });
      if (updated) sendToRenderer('session-updated', { session: updated });
    }
    return { ...result, model: result.ok ? picked : result.model };
  }
  // 目标是清单里第一个不是刚报错那个的模型；清单以 Hub 探测到的为准（guard.permittedModels），不按配置里写的猜。
  async function fixCodeAgentModel(sessionId, { avoidModel = '' } = {}) {
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, error: 'session-closed', message: '会话已经关闭' };
    const previousModel = session.fixedModel;
    if (codeagentPicker.isPicking(sessionId)) return { ok: false, error: 'busy', message: '正在切换模型，请稍候' };
    const { getHubDataDir } = require('../../core/data-dir');
    const dataDir = getHubDataDir();
    const guard = require('../../core/codeagent-default-model-guard');
    const configDir = codeagentPicker.normalizeConfigDir(guard.sessionConfigDir(session, { dataDir }));
    const permitted = guard.permittedModels(session, configDir, { dataDir });
    const list = permitted.authoritative ? permitted.models : [];
    const pin = require('../../core/session-model-pin');
    const family = codeagentModels.modelFamily(session.fixedModel || avoidModel);
    const target = list.find(m => String(m).toLowerCase() !== String(avoidModel).toLowerCase() && family && codeagentModels.modelFamily(m) === family) || '';
    if (session.fixedModel && (session.modelConfirmationRequired || !target || pin.unavailablePolicy(require('../../core/hub-config').getConfig().sessionModelUnavailablePolicy) === 'stop-and-ask')) {
      const error = pin.unavailableError(session.fixedModel, '模型请求已被拒绝', list.filter(m => String(m).toLowerCase() !== String(avoidModel).toLowerCase()), target);
      const paused = sessionManager.updateSessionMeta(sessionId, { codeagentModelPick: true, modelConfirmationRequired: true, modelUnavailableReason: error.reason || error.message });
      require('../../core/session-store').saveSessionFile(sessionId, paused || session);
      if (typeof requestModelConfirmation === 'function') {
        try {
          const selected = await confirmSessionModel(sessionId, error);
          return { ok: true, model: selected.model?.id || selected.model, mode: 'user-confirmed', confirmed: true };
        } catch (failure) { return { ok: false, stopped: true, notSent: true, error: failure.code, message: failure.message }; }
      }
      sendToRenderer('session-notice', { sessionId, level: 'error', persistent: true, modelUnavailable: true, originalModel: error.model, suggestedModel: error.suggestedModel, availableModels: error.availableModels, message: error.message });
      return { ok: false, error: error.code, message: error.message };
    }
    if (!target) {
      const message = list.length ? `这个号的权限清单里只有刚报错的 ${avoidModel || '（未知）'}，没有可换的模型` : '读不到这个号的权限清单';
      return { ok: false, error: 'no-model', message };
    }
    const activeSettings = sessionManager.sessions?.get(sessionId)?.codeagentSettingsActive;
    const settingsChange = activeSettings ? updateCodeAgentModelSettings(sessionId, session, target) : null;
    if (activeSettings && !settingsChange) return { ok: false, error: 'settings-update-failed', message: '无法更新这个会话正在使用的模型设置，本轮未重发' };
    // Lite（serve）会话没有终端菜单：按 serve 模型清单直接切，不走 /model 读屏。
    const serveFix = !settingsChange && session.codeagentRunMode === 'serve' && sessionManager.getNativeSession?.(sessionId)
      ? await switchCodeAgentServeModel(sessionId, session, target, '') : null;
    const result = settingsChange ? { ok: true, model: target, mode: 'settings-only', confirmed: false }
      : serveFix ? { ...serveFix, model: serveFix.model?.id || target }
      : await codeagentPicker.schedulePick(sessionId, () => runCodeAgentPick(sessionId, target, 'model-config-fix'));
    // result.fallback：菜单没选上、只是没把问题挡住（自动会话「能发就发」的老兜底）。这一条路不能算切成了——
    if (!result || !result.ok || result.fallback) {
      const why = (result && result.message) || '没能在 CodeAgent 里切到清单里的模型';
      return { ok: false, error: 'pick-failed', model: target,
        message: result && result.fallback ? `${why}；模型菜单没能用上，会话还是当前模型` : why };
    }
    if (session.fixedModel) {
      const change = { from: previousModel, to: result.model || target, reason: '原模型请求被拒绝，已按可用模型清单修复', at: Date.now() };
      sessionManager.updateSessionMeta(sessionId, { fixedModel: change.to, modelPinSource: 'auto-switch', modelChange: change, codeagentRouteDeferred: undefined,
        currentModel: { id: change.to, displayName: codeagentModels.modelLabel(change.to) }, codeagentModelPick: false });
      codeagentModels.appendModelLog(dataDir, { event: 'model-auto-switch', session: sessionId, ...change });
      sendToRenderer('session-notice', { sessionId, level: 'warning', persistent: true, message: pin.modelChangeMessage(change) });
    }
    return { ok: true, model: result.model || target, mode: result.mode, confirmed: !!result.confirmed };
  }
  // 首次会话（2026-11-07 用户：第一次会话要丝滑）：启动时清单未知，先经 serve 读一次清单（约 3 秒，和 CodeAgent 启动并行），
  // 读到后按启动时同一口径再判断；能定下来就不往终端里敲 /model。读不到或超时照旧开菜单。
  const CODEAGENT_FIRST_LAUNCH_READ_MS = 15000;
  // 首次准备进度（2026-11-07 用户：后台在点信任、选模型时前台像卡住）：每个会话记两步的状态，拼成一句话推给卡片底部的「启动中」指示条。
  const codeagentLaunchPhases = new Map();
  function sendLaunchPhase(sessionId, patch) {
    if (!sessionId) return;
    const state = { ...(codeagentLaunchPhases.get(sessionId) || {}), ...patch };
    codeagentLaunchPhases.set(sessionId, state);
    const parts = [];
    if (state.trust) parts.push(state.trust === 'done' ? '确认目录信任 ✓' : state.trust === 'stuck' ? '确认目录信任（需要你在「后台」点一下 Yes）' : '确认目录信任…');
    if (state.model) parts.push(state.model === 'done' ? '选好模型 ✓' : state.model === 'reading' ? '读取可用模型…' : '选择模型…');
    const finished = (!state.trust || state.trust === 'done') && (!state.model || state.model === 'done');
    if (finished) codeagentLaunchPhases.delete(sessionId);
    const hint = state.trust === 'stuck' ? '' : state.model === 'reading' ? '首次约 5 秒' : state.model === 'picking' ? '通常 10–30 秒' : '';
    sendToRenderer('codeagent-launch-phase', { sessionId, clear: finished, label: parts.length ? `准备 CodeAgent：${parts.join(' → ')} → 发送你的消息` : '', hint });
  }
  if (typeof sessionManager.on === 'function') sessionManager.on('codeagent-launch-phase', ({ sessionId, phase } = {}) => {
    if (phase === 'trust-detected') sendLaunchPhase(sessionId, { trust: 'detected' });
    else if (phase === 'trust-done') sendLaunchPhase(sessionId, { trust: 'done' });
    else if (phase === 'trust-stuck') {
      sendLaunchPhase(sessionId, { trust: 'stuck' });
      sendToRenderer('session-notice', { sessionId, level: 'warning', persistent: true, action: 'open-backstage',
        message: 'CodeAgent 第一次进入这个工作目录，弹出了「是否信任此目录」的确认，Hub 没能自动点掉。请打开这个会话的「后台」终端，选 Yes, I trust this folder 后回车；你的消息会在确认后自动发出。' });
    }
  });
  async function recheckFirstLaunchModel(sessionId, { accountKey, configDir, first }) {
    const dataDir = require('../../core/data-dir').getHubDataDir();
    if (!accountKey || !configDir || !codeagentServeEnabled(dataDir)) return null;
    const pool = require('../../core/codeagent-pool');
    const config = require('../../core/codeagent-config').resolveCodeAgentConfig(process.env);
    const account = accountKey === 'personal' ? null : codeagentPoolAccounts().find(row => row.id === accountKey);
    const started = Date.now();
    const read = readCodeAgentServeAccount(accountKey, { command: config.command, configDirEnv: config.configDirEnv, configDir, dataDir,
      cwd: pool.probeCwd(dataDir) }, account ? pool.label(account) : '个人账号', 'first-launch').catch(error => ({ ok: false, error: error.message }));
    let timer = null;
    const served = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), CODEAGENT_FIRST_LAUNCH_READ_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    let choice = null;
    try { choice = require('../../core/codeagent-launch-model').recheckLaunchChoice({ dataDir, configDir, accountKey, first }); } catch { choice = null; }
    codeagentModels.appendModelLog(dataDir, { event: 'first-launch-recheck', session: String(sessionId).slice(0, 8), account: accountKey === 'personal' ? '个人' : '号池',
      ok: !!served?.ok, ms: Date.now() - started, ...(served?.ok ? {} : { error: served?.error || '未知' }), open: choice ? choice.open : true, reason: choice?.reason || '', model: choice?.model || '' });
    return choice;
  }
  if (typeof sessionManager.on === 'function') sessionManager.on('codeagent-model-pick', ({ sessionId, modelId, reason, listUnknown, accountKey, configDir } = {}) => {
    if (!sessionId || !modelId) return;
    // 同步登记：随后到达的第一条消息会等这一步做完（group-chat-watcher 的 sendToPty）。
    codeagentPicker.schedulePick(sessionId, async () => {
      const showPhase = reason === 'launch' || reason === 'relaunch';
      if (reason === 'launch' && listUnknown) {
        if (codeagentServeEnabled(require('../../core/data-dir').getHubDataDir())) sendLaunchPhase(sessionId, { model: 'reading' });
        let choice = null;
        try { choice = await recheckFirstLaunchModel(sessionId, { accountKey, configDir, first: modelId }); }
        catch (error) { console.warn('[codeagent] 首次会话读模型清单出错，照旧开菜单：' + error.message); }
        if (choice && !choice.open) {
          codeagentModels.appendModelLog(require('../../core/data-dir').getHubDataDir(), { event: 'pick-skipped', session: String(sessionId).slice(0, 8),
            model: choice.model, reason: choice.reason, note: '首次会话：后台读到模型清单后判断不用开模型菜单' });
          sendLaunchPhase(sessionId, { model: 'done' });
          return { ok: true, skipped: true, model: choice.model, inputReady: true };
        }
        if (choice && choice.open && choice.model) modelId = choice.model;
      }
      if (showPhase) sendLaunchPhase(sessionId, { model: 'picking' });
      let result;
      try { result = await runCodeAgentPick(sessionId, modelId, reason); }
      finally { if (showPhase) sendLaunchPhase(sessionId, { model: 'done' }); }
      const session = sessionManager.getSession(sessionId);
      if (result.loginRequired) return result;
      if (result.fallback && codeagentPicker.isFirstMenuModel(modelId)) {
        sendToRenderer('session-notice', { sessionId, level: 'warning',
          message: `没能自动选中 CodeAgent 模型菜单里的第一个模型（${result.message || '原因未知'}），这个会话沿用 CodeAgent 当前的模型；需要换的话在终端里 /model 选一次。` });
      } else if (result.fallback) {
        // 自动会话没人看，回退只记日志（runCodeAgentPick 的 pick 日志 fallback=send-with-cli-model）；用户会话提示一句。
        // 同一次回退只发一条：菜单里没有可替代的同版本模型时用统一对照的说明（core/model-name-match.js fallbackNote）。
        // 指定了供应商的自动会话（助理、分身）没切到也说一行：用户在助理里选过线路，需要知道这次不是按它作答。
        if ((!session || !isAutomaticCodeAgent(session) || session.codeagentModelProvider) && !result.fallbackNoticed) {
          sendToRenderer('session-notice', { sessionId, level: 'warning',
            message: result.nameFallback ? `${result.nameFallback}，第一条消息已照常发出。`
              : `没切到 ${modelId}，先用 CodeAgent 当前模型继续，第一条消息已照常发出（原因：${result.technicalReason || result.message || '未知'}）；需要换的话在终端里 /model 选一次。` });
        }
      } else if (!result.ok) {
        // 真失败（菜单没关掉、输入框不能用）：第一条消息被退回，常驻提示讲清原因和下一步，不用一闪而过的提示。
        const why = result.technicalReason && result.technicalReason !== result.message ? `（${result.technicalReason}）` : '';
        sendToRenderer('session-notice', { sessionId, level: 'warning', persistent: true,
          message: `${result.message || `没能选中 ${modelId}`}${why}。第一条消息还没发出；请到会话的终端里按 Esc 关掉模型菜单，或用 /model 手动选一次，再重新发送。` });
      }
      return result;
    });
  });
  function updateCodeAgentModelSettings(sessionId, session, modelId) {
    const models = require('../../core/codeagent-models');
    let launchChange = null;
    try {
      const dataDir = require('../../core/data-dir').getHubDataDir();
      const file = require('path').join(dataDir, 'codeagent-launch', `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
      if (require('fs').existsSync(file)) {
        const poolId = (session.info && session.info.codeagentPoolAccount) || session.codeagentPoolAccount || '';
        const account = poolId ? require('../../core/codeagent-pool').listAccounts(dataDir).find(a => a.id === poolId) : null;
        const configDir = require('../../core/codeagent-default-model-guard').sessionConfigDir(session, { dataDir });
        const catalog = models.readModelCatalog(dataDir, { configDir, accountKey: poolId || 'personal' });
        const spelled = (catalog?.source === 'serve' && catalog.models.find(id => id.toLowerCase() === modelId.toLowerCase()))
          || require('../../core/session-manager')._private.codeagentLaunchModel(modelId, { dataDir, pool: account ? { account } : null });
        if (spelled) {
          require('../../core/session-manager')._private.writeCodeAgentLaunchSettings(dataDir, sessionId, spelled);
          launchChange = { file };
        }
      }
    } catch (error) { console.warn('[codeagent] 切换模型时改会话设置文件失败，只用菜单：' + error.message); }
    return launchChange;
  }
  // 菜单已经选中了新模型、但换不成 CodeAgent 自己的写法（自配供应商的模型、清单不是 serve 读的）时，
  // 把会话设置文件里的旧模型去掉（2026-11-20 反馈「切了 GLM5.3 还是 DS4.1」）：它优先级最高、每次请求都重读，
  // 留着旧模型会把菜单刚选的压回去。去掉后这个会话按菜单的选择走，和不用 --settings 启动的会话一样。
  function releaseCodeAgentLaunchModel(sessionId, why) {
    try {
      const fs = require('fs');
      const dataDir = require('../../core/data-dir').getHubDataDir();
      const file = require('path').join(dataDir, 'codeagent-launch', `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
      if (!fs.existsSync(file)) return false;
      let current = null;
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = null; }
      if (current && typeof current === 'object' && !current.model) return false;
      fs.writeFileSync(file + '.tmp', '{}', 'utf8');
      fs.renameSync(file + '.tmp', file);
      codeagentModels.appendModelLog(dataDir, { event: 'launch-settings-released', session: String(sessionId).slice(0, 8), from: current?.model || '', reason: why });
      return true;
    } catch (error) { console.warn('[codeagent] 去掉会话设置文件里的旧模型失败：' + error.message); return false; }
  }

  async function switchCodeAgentServeModel(sessionId, session, modelId, provider) {
    const models = require('../../core/codeagent-models');
    const dataDir = require('../../core/data-dir').getHubDataDir();
    const native = sessionManager.getNativeSession(sessionId);
    let result;
    try { result = await native.configure({ model: modelId, provider }); }
    catch (error) {
      models.appendModelLog(dataDir, { event: 'serve-switch', session: String(sessionId).slice(0, 8), model: modelId, ok: false, code: error.code || '', error: error.message });
      return { ok: false, error: error.code || 'serve-switch-failed', message: error.message };
    }
    const chosen = result.modelId || modelId;
    // 会话因「原模型不可用」暂停时，这次切换就是给原模型选的替代：与 PTY 路径一样记下（core/codeagent-model-replacements.js）。
    const pausedFrom = session.modelConfirmationRequired && session.fixedModel ? session.fixedModel : '';
    models.appendModelLog(dataDir, { event: 'serve-switch', session: String(sessionId).slice(0, 8), model: modelId, ok: true, to: chosen, kind: result.matchKind || '' });
    if (result.matchKind === 'similar') {
      sendToRenderer('session-notice', { sessionId, level: 'warning', message: require('../../core/model-name-match').substitutionNote(modelId, result.displayName || chosen) });
    }
    const updated = sessionManager.updateSessionMeta(sessionId, { currentModel: { id: chosen, displayName: result.displayName || models.modelLabel(chosen) },
      fixedModel: chosen, codeagentUserModel: chosen, modelPinSource: 'user', modelChange: null, modelConfirmationRequired: false, modelUnavailableReason: '',
      codeagentModelProvider: result.provider || '', codeagentModelProviderLabel: result.providerLabel || '', codeagentModelMenuLabel: '' });
    if (updated) sendToRenderer('session-updated', { session: updated });
    try { require('../../core/codeagent-launch-model').rememberModel(dataDir, (session.info && session.info.codeagentPoolAccount) || session.codeagentPoolAccount || 'personal', chosen); }
    catch (error) { console.warn('[codeagent] 记住上次选的模型失败：' + error.message); }
    if (pausedFrom && pausedFrom !== chosen) {
      try { require('../../core/codeagent-model-replacements').recordReplacement(dataDir, pausedFrom, chosen); }
      catch (error) { console.warn('[codeagent] 记住替代模型失败：' + error.message); }
    }
    const saved = sessionManager.getSession(sessionId);
    if (saved) require('../../core/session-store').saveSessionFile(sessionId, saved);
    return { ok: true, model: { id: chosen, displayName: result.displayName || models.modelLabel(chosen) }, mode: 'session', confirmed: true };
  }

  const pendingModelSelections = new Map();
  async function switchCodeAgentModel(payload = {}, options = {}) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) {
      const saved = sessionId && require('../../core/session-store').loadSessionFile(sessionId, { strict: true });
      const model = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
      if (!saved || !/^codeagent(?:-resume)?$/.test(saved.kind) || typeof resumeSession !== 'function') {
        return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠，先打开它再切换' };
      }
      if (!require('../../core/codeagent-models').isSafeModelId(model)) return { ok: false, error: 'invalid-model', message: '请选择有效模型' };
      try {
        const route = require('../../core/codeagent-model-choice').routeFields(payload);
        const fresh = await resumeSession({ ...saved, hubId: sessionId, launchOverrides: { model, ...route } });
        if (!fresh || fresh.ok === false) return { ok: false, message: fresh?.message || '会话恢复失败' };
        const selected = fresh.fixedModel || model;
        return { ok: true, model: { id: selected, displayName: require('../../core/codeagent-models').modelLabel(selected) }, mode: 'resumed', confirmed: false };
      } catch (error) { return { ok: false, error: error.code, message: error.message }; }
    }
    if (!/^codeagent(?:-resume)?$/.test(String(session.kind || ''))) return { ok: false, error: 'not-codeagent', message: '只有 CodeAgent 会话走这条切换' };
    const models = require('../../core/codeagent-models');
    const requested = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';
    // Lite（serve）会话的候选来自 serve 自己的清单，qwen、kimi 等也是 CodeAgent 线路上的真模型：不套「别的 CLI 模型」归一，
    // 只拦空值、控制字符和超长，名字交给 serve 清单去认（switchCodeAgentServeModel）。
    const serveRuntime = session.codeagentRunMode === 'serve' && !!sessionManager.getNativeSession?.(sessionId);
    const modelId = serveRuntime ? requested : models.normalizeModel(requested);
    if (serveRuntime ? !requested || requested.length > 164 || /[\x00-\x1f\x7f]/.test(requested)
      : !requested || modelId.toLowerCase() !== requested.toLowerCase()) return { ok: false, error: 'invalid-model', message: `模型名不能用：${requested}` };
    const recovery = payload.recovery === true && sessionManager.isAgentTurnActive?.(sessionId) === false;
    if (payload.recovery === true && !recovery) return { ok: false, error: 'busy', message: '当前回答仍在运行，请结束后再切换' };
    if (session.status === 'running' && !recovery && !(session.modelConfirmationRequired && sessionManager.isAgentTurnActive?.(sessionId) === false) && !(options.pendingConfirmation && pendingModelSelections.has(sessionId)
        && !sessionManager.isAgentTurnActive?.(sessionId))) return { ok: false, error: 'busy', message: '当前回答仍在运行，请结束后再切换' };
    if (codeagentPicker.isPicking(sessionId)) return { ok: false, error: 'busy', message: '正在切换模型，请稍候' };
    // CodeAgent-Lite（共享 serve）会话没有可读的 TUI 菜单：以前也走 /model 读屏，「/model」被卡片当本地命令吃掉，
    // 菜单永远不出现，日志报 pick-menu-failed「布局无法自动识别」（2026-11-24 WeLink 2 人反馈）。改为直接按 serve 的模型清单切。
    if (serveRuntime) {
      return switchCodeAgentServeModel(sessionId, session, modelId, typeof payload.provider === 'string' ? payload.provider.trim() : '');
    }
    // 用 --settings 文件启动的会话（2026-10-30 5.3.12）：先把它自己的设置文件改成新模型，再照常在菜单里选。
    // 会话每次请求都重读配置；--settings 优先级最高，不改它的话菜单选的可能被它压回去。只在能换成 CodeAgent 自己的写法时改。
    // 会话因「原模型不可用」暂停时，这次切换就是用户给原模型选的替代：切成后记下，之后由默认模型推出的新会话直接用它。
    const pausedFrom = session.modelConfirmationRequired && session.fixedModel ? session.fixedModel : '';
    const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
    const providerLabel = typeof payload.providerLabel === 'string' ? payload.providerLabel.trim() : '';
    const menuLabel = typeof payload.menuLabel === 'string' ? payload.menuLabel.trim() : '';
    if (provider && (provider.length > 150 || /[\x00-\x1f\x7f]/.test(provider))) return { ok: false, error: 'invalid-provider', message: '请选择有效模型分组' };
    const selection = { provider, providerLabel, menuLabel, recovery };
    // A model-only settings file cannot select a provider. Grouped choices must
    // be confirmed in the native menu, without a settings-only success fallback.
    const launchChange = provider ? null : updateCodeAgentModelSettings(sessionId, session, modelId);
    const settingsOnly = failure => {
      const message = failure?.message || 'CodeAgent 没能切换模型';
      models.appendModelLog(require('../../core/data-dir').getHubDataDir(), { event: 'switch-settings-only',
        session: sessionId.slice(0, 8), model: modelId, reason: message });
      const updated = sessionManager.updateSessionMeta(sessionId, { currentModel: { id: modelId, displayName: models.modelLabel(modelId) },
        codeagentRequestedModel: undefined, codeagentModelPick: false, codeagentUserModel: modelId, fixedModel: modelId, modelConfirmationRequired: false, modelUnavailableReason: '', modelPinSource: 'user', modelChange: null });
      if (updated) sendToRenderer('session-updated', { session: updated });
      return { ...failure, ok: true, mode: 'settings-only', confirmed: false, message };
    };
    let result;
    try {
      result = await codeagentPicker.schedulePick(sessionId, async () => {
        const picked = await runCodeAgentPick(sessionId, modelId, 'switch', selection);
        // 菜单里没有可替代的同版本模型时不把这个名字写进设置文件冒充成功：照实回报，会话沿用当前模型。
        return launchChange && !picked?.ok && !picked?.nameFallback ? settingsOnly(picked) : picked;
      });
    } catch (error) {
      if (!launchChange) throw error;
      result = settingsOnly({ message: error.message });
      codeagentPicker.resetFailure(sessionId);
    }
    // result.fallback：菜单没选上、只是按当前模型照常可用——不算切成了（同 fixCodeAgentModel）。
    if (!result || !result.ok || result.fallback) {
      return { ok: false, error: 'pick-failed', message: (result && result.message) || 'CodeAgent 没能切换模型' };
    }
    // 菜单里没有所选模型、按统一对照改选了同版本的一个（core/model-name-match.js）：之后都按实际选中的记。
    const chosen = result.substituted && typeof result.model === 'string' && result.model ? result.model : modelId;
    // After the native menu confirmed the provider, update only this session's
    // model overlay so its former model cannot override the next request.
    const overlayUpdated = provider || chosen !== modelId ? updateCodeAgentModelSettings(sessionId, session, chosen) : launchChange;
    // 菜单选中了、设置文件却没能改成新模型：去掉文件里的旧模型，免得下一问又按它发。
    if (!overlayUpdated && result.mode !== 'settings-only') releaseCodeAgentLaunchModel(sessionId, `菜单已选 ${chosen}，换不成 CodeAgent 自己的写法`);
    // 记住这个号上次手动切到的模型，下次新建会话默认用它（core/codeagent-launch-model.js）。
    try { if (result.mode !== 'settings-only') require('../../core/codeagent-launch-model').rememberModel(require('../../core/data-dir').getHubDataDir(), (session.info && session.info.codeagentPoolAccount) || session.codeagentPoolAccount || 'personal', chosen); }
    catch (error) { console.warn('[codeagent] 记住上次选的模型失败：' + error.message); }
    models.expectModelSwitch(sessionId, chosen, { settingsOnly: result.mode === 'settings-only' });
    if (pausedFrom) {
      try { require('../../core/codeagent-model-replacements').recordReplacement(require('../../core/data-dir').getHubDataDir(), pausedFrom, chosen); }
      catch (error) { console.warn('[codeagent] 记住替代模型失败：' + error.message); }
    }
    sessionManager.updateSessionMeta(sessionId, { codeagentModelProvider: provider, codeagentModelProviderLabel: providerLabel, codeagentModelMenuLabel: menuLabel });
    const selectedSession = sessionManager.getSession(sessionId);
    if (!selectedSession) return { ok: false, error: 'session-closed', message: '会话已关闭，本次选择未保存' };
    require('../../core/session-store').saveSessionFile(sessionId, selectedSession);
    // 回执：菜单关掉了；看到「Set model to …」时 confirmed=true。下一条回答再核对实际模型。
    return { ok: true, model: { id: chosen, displayName: provider ? `${models.modelLabel(chosen)} · ${providerLabel || provider}` : models.modelLabel(chosen), ...(provider ? { provider, providerLabel } : {}) }, mode: result.mode, confirmed: !!result.confirmed,
      ...(result.mode === 'settings-only' ? { message: result.message } : {}) };
  }
  ipcMain.handle('codeagent:switch-model', (_event, payload) => switchCodeAgentModel(payload));

  function confirmSessionModel(sessionId, error, options = {}) {
    const stopped = message => Object.assign(new Error(message || '已取消模型确认，本条消息未发送，保持暂停。'), {
      code: 'SESSION_MODEL_CONFIRMATION_CANCELLED', stopped: true, notSent: true,
    });
    const pins = require('../../core/session-model-pin');
    const execution = pins.captureSessionExecution(sessionManager, sessionId);
    const valid = () => !options.signal?.aborted && (!options.shouldSubmit || options.shouldSubmit())
      && pins.sameSessionExecution(execution, sessionManager, sessionId);
    const session = sessionManager.getSession(sessionId);
    if (!session || !valid()) return Promise.reject(stopped('会话或任务已变化，本条消息未发送。'));
    let group = pendingModelSelections.get(sessionId);
    if (group && !pins.sameSessionExecution(group.execution, sessionManager, sessionId)) {
      pendingModelSelections.delete(sessionId); group.controller.abort(); group = null;
    }
    const key = options.clientSubmissionId || Symbol('model-submission');
    if (group?.subscribers.has(key)) return group.subscribers.get(key).promise;
    const choices = [...new Set([...(error.availableModels || []), error.suggestedModel])].filter(codeagentModels.isSafeModelId);
    if (!group && !choices.length && !options.modelListRetried && error.canChooseAlternative !== false) {
      // 每次被拦的提交只重拉一次；并发提交复用账号探测，不更改模型固定规则。
      return probeCodeAgentAccount(session.codeagentPoolAccount || 'personal').catch(() => []).then(models => {
        if (!valid()) throw stopped('会话或任务已变化，本条消息未发送。');
        const available = (error.modelRevoked || error.reason === '模型请求已被拒绝') ? models.filter(id => id.toLowerCase() !== String(error.model).toLowerCase()) : models;
        return confirmSessionModel(sessionId, { ...error, message: error.message, availableModels: available, suggestedModel: available[0] || '' },
          { ...options, modelListRetried: true });
      });
    }
    if (!group && (error.canChooseAlternative === false || !choices.length || typeof requestModelConfirmation !== 'function')) {
      sendToRenderer('session-notice', { sessionId, persistent: true, level: 'error', message: `${error.message} 本条消息未发送。${!choices.length
        ? `${options.modelListRetried ? '已重新读取模型清单，仍无可用模型。' : '暂无可用模型。'}请到「账号」页确认登录，再在会话下方点击模型重新获取清单；恢复后重新发送。`
        : '请先修复模型或 CLI 配置后重新发送。'}` });
      return Promise.reject(stopped(error.message));
    }
    if (!group) {
      group = { subscribers: new Map(), submissionIds: [], workflowMessageIds: [], execution, controller: new AbortController() };
      pendingModelSelections.set(sessionId, group);
      const meeting = session.meetingId && meetingManager?.getMeeting?.(session.meetingId);
      const contextLabel = meeting ? `群聊 ${meeting.title || session.meetingId} / ${session.title || '成员'}` : `会话 ${session.title || 'CodeAgent'}`;
      group.task = Promise.resolve().then(async () => {
        const selected = await requestModelConfirmation({ sessionId, creation: false,
          originalModel: error.model || session.fixedModel, reason: error.reason || '', suggestedModel: error.suggestedModel, availableModels: choices, clientSubmissionIds: group.submissionIds, workflowMessageIds: group.workflowMessageIds,
          contextLabel, message: `${contextLabel}：${error.message} 确认后继续仍有效的原消息，取消则保持停止。` }, { signal: group.controller.signal, onWaitRegistered: refresh => { group.refreshWait = refresh; } });
        if (!selected) throw stopped();
        const anyValid = () => [...group.subscribers.values()].some(item => item.valid());
        if (!anyValid()) throw stopped('会话或任务已变化，本条消息未发送。');
        if (!choices.includes(selected)) throw stopped('所选型号不在本次可用清单中，本条消息未发送。');
        if (sessionManager.isAgentTurnActive?.(sessionId)) throw stopped('当前回答仍在运行，本条消息未发送。');
        const result = await switchCodeAgentModel({ sessionId, modelId: selected }, { pendingConfirmation: true });
        if (!result?.ok) throw stopped(result?.message || '模型未确认切换，本条消息未发送。');
        return result;
      });
      const settle = (failure, result) => {
        if (pendingModelSelections.get(sessionId) === group) pendingModelSelections.delete(sessionId);
        for (const item of [...group.subscribers.values()]) {
          item.finish(failure || !item.valid() ? failure || stopped('会话或任务已变化，本条消息未发送。') : null, result);
        }
        // 模型确认后切换失败：本条消息没发出，是这一轮的最终结果，显式 blocking。
        if (failure) sendToRenderer('session-notice', { sessionId, persistent: true, level: 'warning', noticeKind: 'blocking', message: failure.message });
      };
      group.task.then(result => settle(null, result), failure => settle(Object.assign(failure, { stopped: true, notSent: true })));
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { promise, valid, finish(failure, result) {
      if (!group.subscribers.delete(key)) return;
      if (typeof key === 'string') { const index = group.submissionIds.indexOf(key); if (index >= 0) group.submissionIds.splice(index, 1); }
      if (options.workflowMessageId) { const index = group.workflowMessageIds.indexOf(options.workflowMessageId); if (index >= 0) group.workflowMessageIds.splice(index, 1); }
      group.refreshWait?.();
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else resolve(result);
    } };
    const abort = () => {
      item.finish(stopped());
      if (!group.subscribers.size) {
        if (pendingModelSelections.get(sessionId) === group) pendingModelSelections.delete(sessionId);
        group.controller.abort();
      }
    };
    group.subscribers.set(key, item);
    if (typeof key === 'string') group.submissionIds.push(key);
    if (options.workflowMessageId) group.workflowMessageIds.push(options.workflowMessageId);
    group.refreshWait?.();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return promise;
  }
  ipcMain.handle('codeagent:available', () => {
    try { return { installed: require('../../core/codeagent-config').isCodeAgentInstalled() }; }
    catch (error) { return { installed: false, error: error.message }; }
  });
  // CodeAgent 版本过旧提醒（core/codeagent-version-check.js）：查版本。
  ipcMain.handle('codeagent:version-check', () => {
    const config = require('../../core/codeagent-config');
    let command = null;
    try { ({ command } = config.resolveCodeAgentConfig()); } catch { /* 命令不合法时按没装处理 */ }
    const installed = !!command && config.isCodeAgentInstalled();
    return Promise.resolve(require('../../core/codeagent-version-check').check({
      installed,
      probe: () => require('../../core/codeagent-version-probe').codeagentVersion(command),
    })).finally(() => { if (installed) void require('../../core/codeagent-capabilities').prepare(command); });
  });
  // 「一键升级」2026-11-16 起改由 main/ipc/codeagent-install-handlers.js 后台隐藏运行（codeagent-install:start），不再开可见 PowerShell 窗口。

  ipcMain.handle('debug:get-session-buffer', (_e, sessionId) => {
    return sessionManager.getSessionBuffer(sessionId);
  });

  ipcMain.handle('get-session-buffer-snapshot', (_e, sessionId) => {
    if (typeof sessionManager.getSessionBufferSnapshot === 'function') {
      return sessionManager.getSessionBufferSnapshot(sessionId);
    }
    return { text: sessionManager.getSessionBuffer(sessionId) || '', seq: 0 };
  });

  ipcMain.handle('debug:get-last-session-write', () => {
    return typeof sessionManager.getLastWrite === 'function' ? sessionManager.getLastWrite() : null;
  });

  ipcMain.handle('debug:get-terminal-output-batch-stats', () => getTerminalOutputBatchStats());

  ipcMain.handle('restart-session', (_e, sessionId) => restartSession(sessionId));

  // overrides 只用于 PTY 原生会话的「按新模型/深度重启并接着原会话历史」（助理切换模型）。
  // options.relaunch：ACP 会话不原地重连，而是休眠后按原会话重新启动，让启动参数重新计算
  //   （Token Plan 额度用完时改走 DeepSeek API 靠这个，见 main/token-plan-fallback-controller.js）。
  function restartSession(sessionId, overrides = null, options = {}) {
    if (ensureLaunchAuth && options.reason !== 'account-switch') {
      const old=sessionManager.getSession(sessionId);
      if (old) return ensureLaunchAuth(old.kind,{...old,...overrides,model:sessionModelId(old)})
        .then(()=>restartAuthorizedSession(sessionId,overrides,options))
        .catch(error=>({ok:false,error:error.code || 'restart-failed',message:error.message}));
    }
    return restartAuthorizedSession(sessionId,overrides,options);
  }
  function restartAuthorizedSession(sessionId, overrides = null, options = {}) {
    const old = sessionManager.getSession(sessionId);
    if (!old) {
      return { ok: false, error: 'session-not-found', message: '会话不存在或已经休眠' };
    }
    const nativeCodex = sessionManager.getNativeSession?.(sessionId) || sessionManager.getNativeCodex?.(sessionId);
    // PTY 跑的 Codex 与 Claude 一样按原生会话 id 恢复；只有 App Server 会话在这里重连。
    if (overrides && (old.runtimeBackend === 'codex-app-server' || old.runtimeBackend === 'claude-stream-json' || (nativeCodex && !nativeCodex.isCliProvider) || sessionManager.getNativeClaude?.(sessionId))) {
      return { ok: false, error: 'restart-overrides-unsupported', message: '原生后端会话不支持按新模型重启' };
    }
    const relaunchAcp = options.relaunch === true && old.runtimeBackend === 'acp';
    if (old.purpose !== 'xresearch-research' && !relaunchAcp && (old.runtimeBackend === 'codex-app-server' || (nativeCodex && !nativeCodex.isCliProvider))) {
      const native = nativeCodex;
      if (!native) return {ok:false,error:'unmanaged-codex',message:'旧 Codex 进程尚未接管；请先在原会话结束工作并关闭，再恢复'};
      return native.reconnect({useLaunchAccount:true}).then(()=>sessionManager.getSession(sessionId))
        .catch(error=>({ok:false,message:error.message}));
    }
    if (old.purpose === 'xresearch-research') {
      return { ok: false, error: 'protected-session', message: '扩展投研任务不能从这里重启' };
    }
    const native = options.cardSwitch ? null : sessionManager.getNativeClaude?.(sessionId);
    if (native) {
      return native.reconnect({ stopActive: true }).then(() => sessionManager.getSession(sessionId))
        .catch(error => ({ ok: false, error: 'native-reconnect-failed', message: error.message }));
    }

    // CodeAgent-Lite 首轮就没连上：还没有原生会话可恢复（也还没拿到恢复能力），按原参数改建终端会话（同一会话 ID），
    // 不再报「未绑定原生会话 ID」。已绑定的照旧走下面按原历史恢复。
    if (options.serveFallback === true && /^codeagent(?:-resume)?$/.test(String(old.kind || ''))
        && !nativeSessionIdentity(old) && !old.ccSessionId && !old.acpSid) {
      return relaunchServeAsPty(old, options).catch(error => ({ ok: false, error: 'serve-fallback-failed', message: error?.message || String(error) }));
    }
    if (supportsRecoverableSession(old)) {
      const identity = nativeSessionIdentity(old);
      if (!identity) {
        return {
          ok: false,
          error: 'native-session-id-missing',
          message: '当前会话尚未绑定原生会话 ID，不能安全重启；请等待本轮回答完成后重试',
        };
      }
      if (typeof resumeSession !== 'function') {
        return { ok: false, error: 'resume-handler-unavailable', message: '会话恢复服务尚未就绪' };
      }

      const resumeMeta = buildSessionResumeMeta(old, overrides ? { launchOverrides: overrides } : {});
      lastResizeBySid.delete(sessionId);
      // 2026-09-26：kill 只是发信号，旧 PTY 的收尾（保存记录、停 writer、释放归属）在
      // 退出回调里。以前 close 后立刻 resume，撞上「该会话已在本 Hub 打开」而失败；
      // 随后旧进程退出又按「用户关闭」发出 session-closed，会话连卡片带记录一起被抹掉。
      // 改走休眠：群聊成员身份与卡片都保留，等收尾完成再按原会话恢复。
      if (options.guard && !options.guard()) return {ok:false,notSwitched:true,message:'会话状态已改变，未切换账号'};
      // CodeAgent-Lite 改回终端也标 serve-fallback：界面对正看着的会话原地保持、显示「正在切换到终端方式」，和首轮改建一致。
      const suspendReason = options.reason === 'account-switch' ? 'account-switch' : options.serveFallback === true && /^codeagent(?:-resume)?$/.test(String(old.kind || '')) ? 'serve-fallback' : 'restart';
      const suspended = sessionManager.suspendSession(sessionId, { reason: suspendReason, serveFallback: options.serveFallback === true });
      if (!suspended || !suspended.ok) {
        return { ok: false, error: suspended?.error || 'restart-suspend-failed',
          message: `会话重启失败：${suspended?.message || '无法停止旧进程'}` };
      }
      return waitForSessionGone(sessionManager, sessionId).then((gone) => {
        if (!gone) return { ok: false, error: 'restart-exit-timeout', message: '会话重启失败：旧进程迟迟未退出，稍后可从休眠恢复' };
        if (options.guard && !options.guard({allowSuspended:true})) return {ok:false,message:'账号切换已取消，会话已保留为休眠状态'};
        return Promise.resolve(resumeSession(resumeMeta, {skipLaunchAuth:options.reason === 'account-switch'})).then((fresh) => (
          fresh || { ok: false, error: 'resume-failed', message: '原生会话恢复失败' }
        ));
      }).catch((error) => ({
        ok: false,
        error: 'resume-failed',
        message: `会话重启失败：${error && error.message ? error.message : String(error)}`,
      }));
    }

    if (overrides) return { ok: false, error: 'restart-overrides-unsupported', message: '该会话没有可恢复的原生历史，不能按新模型重启' };
    // PowerShell has no provider-native thread.  Restarting it intentionally
    // creates a fresh shell while retaining the Hub card's UX metadata.
    sessionManager.closeSession(sessionId);
    const fresh = sessionManager.createSession(old.kind, {
      id: old.id,
      ...(old.title ? { title: old.title } : {}),
      cwd: old.cwd,
      meetingId: old.meetingId || undefined,
      ...(old.workspaceLabel ? { workspaceLabel: old.workspaceLabel } : {}),
      ...(old.pinned ? { pinned: true } : {}),
      ...(old.bottomed ? { bottomed: true } : {}),
      ...(typeof old.lastMessageTime === 'number' ? { lastMessageTime: old.lastMessageTime } : {}),
      ...(typeof old.lastOutputPreview === 'string' ? { lastOutputPreview: old.lastOutputPreview } : {}),
      ...(sessionModelId(old) ? { model: sessionModelId(old) } : {}),
      ...(old.effort ? { effort: old.effort } : {}),
      ...(old.codexProfile ? { codexProfile: old.codexProfile } : {}),
      ...(old.claudeProfile ? {claudeProfile:old.claudeProfile,claudeConfigDir:old.claudeConfigDir} : {}),
      ...(old.mcpProfile ? { mcpProfile: old.mcpProfile } : {}),
      ...(old.permissionMode ? { permissionMode: old.permissionMode } : {}),
      ...(old.workspaceGuard === true ? { workspaceGuard: true } : {}),
      ...(old.fastMode === false ? { fastMode: false } : {}),
      ...(old.codexSpeedTier ? { codexSpeedTier: old.codexSpeedTier } : {}),
      ...(typeof old.contextMax === 'number' ? { contextMax: old.contextMax } : {}),
      completionNotificationEnabled: old.completionNotificationEnabled === true,
    });
    registerSessionForTap(fresh);
    sendToRenderer('session-created', { session: fresh });
    return fresh;
  }

  return { lastResizeBySid, createSession: createAutoSession, restartSession, fixCodeAgentModel, confirmSessionModel };
}

module.exports = {
  isSafeNativeSessionId,
  waitForSessionGone,
  registerSessionIpc,
};
