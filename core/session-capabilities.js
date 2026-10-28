'use strict';

const {
  isClaudeFamily,
  isCodexCliKind,
  isKimiCliKind,
} = require('./ai-kinds.js');
const { isStableSessionTitle } = require('./session-title-guards.js');
const {
  normalizeCodexSessionModel,
  normalizeDeepSeekModel,
} = require('./model-options.js');

function baseKind(kind) {
  return String(kind || '').replace(/-resume$/, '');
}

// Public DeepSeek sessions keep kind="deepseek" across the 2026-08 Codex
// migration.  Persisted pre-migration sessions are distinguished by their
// native id so every caller reaches the correct provider runtime without
// inventing another UI kind.
function runtimeKindForSession(session) {
  if (!session || typeof session !== 'object') return '';
  if (session.transcriptKind) return String(session.transcriptKind);
  const kind = String(session.kind || '');
  if (baseKind(kind) === 'deepseek' && session.ccSessionId && !session.codexSid) {
    return kind.endsWith('-resume') ? 'deepseek-legacy-resume' : 'deepseek-legacy';
  }
  return kind;
}

function sessionProviderFamily(session) {
  if (session?.agentRuntime === 'pty' && require('./acp-profiles').isAcpKind(session.kind)) return 'acp';
  if (session?.runtimeBackend === 'acp') return 'acp';
  const runtimeKind = runtimeKindForSession(session);
  if (isClaudeFamily(runtimeKind)) return 'claude';
  if (isCodexCliKind(runtimeKind)) return 'codex';
  const kind = baseKind(session && session.kind);
  if (kind === 'gemini') return 'gemini';
  if (isKimiCliKind(session && session.kind) || kind === 'kimi') return 'kimi';
  if (kind === 'powershell') return 'shell';
  return 'unknown';
}

function nativeSessionIdentity(session) {
  if (!session || typeof session !== 'object') return null;
  if (sessionProviderFamily(session) === 'acp') return session.acpSid ? {family:'acp',field:'acpSid',value:session.acpSid} : null;
  const family = sessionProviderFamily(session);
  const field = family === 'claude'
    ? 'ccSessionId'
    : family === 'codex'
      ? 'codexSid'
      : family === 'gemini'
        ? 'geminiChatId'
        : family === 'kimi'
          ? 'kimiSid'
          : null;
  if (!field) return null;
  const value = typeof session[field] === 'string' ? session[field].trim() : '';
  return value ? { family, field, value } : null;
}

function supportsRecoverableSession(session) {
  if (!session) return false;
  if (session.agentRuntime === 'pty' && sessionProviderFamily(session) === 'acp') return true;
  if (session.runtimeBackend === 'acp') return !!(session.acpCapabilities?.loadSession || session.acpCapabilities?.sessionCapabilities?.resume);
  return ['claude', 'codex', 'gemini', 'kimi'].includes(sessionProviderFamily(session));
}

function supportsForkSession(session) {
  if (!session || session.purpose === 'xresearch-research') return false;
  if (session.agentRuntime === 'pty' && sessionProviderFamily(session) === 'acp') return ['qwen', 'deepseek-acp'].includes(session.kind.replace(/-resume$/, ''));
  if (session.runtimeBackend === 'acp') return session.kind === 'qwen' || !!session.acpCapabilities?.sessionCapabilities?.fork;
  // Antigravity clones its native conversation (core/antigravity-fork.js); old
  // Gemini CLI history has no conversation store to clone.
  if (sessionProviderFamily(session) === 'gemini') return require('./antigravity-config').isAntigravity(session);
  return ['claude', 'codex'].includes(sessionProviderFamily(session));
}

function sessionModelId(session) {
  if (!session) return null;
  let candidate = null;
  if (session.currentModel && typeof session.currentModel === 'object') {
    candidate = session.currentModel.id || null;
  } else if (session.model && typeof session.model === 'object') {
    candidate = session.model.id || null;
  } else if (typeof session.model === 'string') {
    candidate = session.model;
  }
  if (!candidate) return null;
  const kind = baseKind(session.kind);
  if (kind === 'codex') return normalizeCodexSessionModel(candidate);
  if (kind === 'deepseek' && sessionProviderFamily(session) === 'codex') {
    return normalizeDeepSeekModel(candidate);
  }
  if (kind === 'deepseek-claude') return require('./deepseek-claude-profile').normalizeModel(candidate);
  return candidate;
}

// One authority for every operation that stops a PTY and recreates it against
// the same provider-native thread: dormant wake, user Restart and workspace
// archive/move.  Keeping this list shared is what prevents Codex-only metadata
// (profile, MCP policy, rollout root) from disappearing on one of those paths.
// Account identity and conversation storage are separate for hot-switched
// Claude sessions. Missing legacy fields stay missing; false and generation 0
// are meaningful values and must survive every persistence/resume boundary.
function claudeSessionAccountMeta(session = {}) {
  const meta = {};
  for (const key of ['claudeProfile', 'claudeProfileLabel', 'claudeConfigDir', 'claudeUsageScope',
    'claudeContextProfile', 'claudeRuntimeHome']) {
    if (typeof session[key] === 'string' && session[key]) meta[key] = session[key];
  }
  if (Number.isSafeInteger(session.claudeAuthGeneration) && session.claudeAuthGeneration >= 0) {
    meta.claudeAuthGeneration = session.claudeAuthGeneration;
  }
  if (typeof session.claudeAutoSwitch === 'boolean') meta.claudeAutoSwitch = session.claudeAutoSwitch;
  return meta;
}

function codexSessionAccountMeta(session = {}) {
  const meta = {};
  for (const key of ['codexHistoryStorageHome', 'codexContextProfile', 'codexRuntimeHome', 'codexHistorySqliteHome']) {
    if (typeof session[key] === 'string' && session[key]) meta[key] = session[key];
  }
  for (const key of ['codexAccountPinned', 'codexAutoSwitch']) {
    if (typeof session[key] === 'boolean') meta[key] = session[key];
  }
  if (Number.isSafeInteger(session.codexAuthGeneration) && session.codexAuthGeneration >= 0) {
    meta.codexAuthGeneration = session.codexAuthGeneration;
  }
  const status = session.codexSwitchStatus;
  const messages = {
    switching:'上次账号切换需要核对',refreshing:'上次登录更新需要核对',refreshed:'登录已更新',
    sending:'上次继续消息需要核对',attention:'请核对上次任务后手动继续',
    queued:'上次待切换请求已结束，请重新选择账号',switched:'已切换账号',continued:'已提交继续',
    completed:'当前回合已完成',waiting:'等待可用账号',cancelled:'已取消账号切换',
  };
  if (status && Object.hasOwn(messages,status.status)) {
    // Persist recovery/deduplication facts without upstream error text.
    meta.codexSwitchStatus = {status:status.status,message:messages[status.status]};
    if (Number.isFinite(status.at)) meta.codexSwitchStatus.at = status.at;
    if (typeof status.eventKey === 'string' && status.eventKey.length < 300) meta.codexSwitchStatus.eventKey = status.eventKey;
    if (Array.isArray(status.attempted)) meta.codexSwitchStatus.attempted = status.attempted.filter(id=>typeof id === 'string' && /^[\w.-]{1,128}$/.test(id));
    if (Number.isSafeInteger(status.generation) && status.generation >= 0) meta.codexSwitchStatus.generation = status.generation;
  }
  return meta;
}

function buildSessionResumeMeta(session, overrides = {}) {
  if (!session || typeof session !== 'object') return null;
  const hubId = session.hubId || session.id;
  const meta = {
    hubId,
    kind: session.kind || 'claude',
    title: session.title || null,
    cwd: session.cwd || null,
    cwdFellBackFrom: session.cwdFellBackFrom || null,
    workspaceLabel: session.workspaceLabel || null,
    pinned: !!session.pinned,
    bottomed: !!session.bottomed && !session.pinned,
    ccSessionId: session.ccSessionId || null,
    ...(session.runtimeBackend === 'claude-stream-json' ? {
      nativeConfig: session.nativeConfig || null,
    } : {}),
    transcriptPath: session.transcriptPath || null,
    meetingId: session.meetingId || null,
    completionNotificationEnabled: session.completionNotificationEnabled === true,
    lastMessageTime: session.lastMessageTime,
    lastOutputPreview: session.lastOutputPreview || '',
    model: sessionModelId(session),
    ...(/^codeagent(?:-resume)?$/.test(session.kind) ? { codeagentModelPick: session.codeagentModelPick === true } : {}),
    ...(session.codeagentForkSourceSessionId ? { codeagentForkSourceSessionId: session.codeagentForkSourceSessionId } : {}),
    ...(session.codeagentPoolAccount ? { codeagentPoolAccount: session.codeagentPoolAccount, codeagentPoolLabel: session.codeagentPoolLabel || '' } : {}),
    effort: session.effort || null,
    codexSid: session.codexSid || null,
    acpSid: session.acpSid || null,
    acpProfileId: session.acpProfileId || null,
    acpCapabilities: session.acpCapabilities || null,
    runtimeBackend: session.runtimeBackend || null,
    nativeRuntime: session.nativeRuntime || null,
    codexApprovalPolicy: session.codexApprovalPolicy || null,
    codexSandbox: session.codexSandbox || null,
    codexSessionsRoot: session.codexSessionsRoot || null,
    codexAllowMtimeFallback: !!session.codexAllowMtimeFallback,
    codexProfile: session.codexProfile || null,
    codexProfileLabel: session.codexProfileLabel || null,
    ...claudeSessionAccountMeta(session),
    ...codexSessionAccountMeta(session),
    deepseekRoute: session.deepseekRoute || null,
    mcpProfile: session.mcpProfile || null,
    codexSpeedTier: session.codexSpeedTier || null,
    fastMode: session.fastMode === false ? false : null,
    antigravityProfile: session.antigravityProfile || null,
    antigravityProfileLabel: session.antigravityProfileLabel || null,
    antigravityProfileHome: session.antigravityProfileHome || null,
    geminiChatId: session.geminiChatId || null,
    geminiProjectHash: session.geminiProjectHash || null,
    geminiProjectRoot: session.geminiProjectRoot || null,
    kimiSid: session.kimiSid || null,
    kimiSessionDir: session.kimiSessionDir || null,
    userRenamed: !!session.userRenamed,
    // A meaningful persisted title must remain authoritative across every
    // stop/recreate path.  Pending fork placeholders are the one exception:
    // they still need the normal auto-title pass after resume.
    autoTitleGenerated: !session.branchAutoTitlePending
      && (!!session.autoTitleGenerated || isStableSessionTitle(session.title, session.kind)),
    branchSourceSessionId: session.branchSourceSessionId || null,
    branchIndex: Number.isInteger(Number(session.branchIndex)) && Number(session.branchIndex) > 0
      ? Number(session.branchIndex)
      : null,
    branchAutoTitlePending: !!session.branchAutoTitlePending,
    contextPct: typeof session.contextPct === 'number' ? session.contextPct : null,
    contextUsed: typeof session.contextUsed === 'number' ? session.contextUsed : null,
    sessionUsage: session.sessionUsage || null,
    contextMax: typeof session.contextMax === 'number' ? session.contextMax : null,
    contextEffectiveMax: typeof session.contextEffectiveMax === 'number' ? session.contextEffectiveMax : null,
    contextEffectiveObservedAt: typeof session.contextEffectiveObservedAt === 'number'
      ? session.contextEffectiveObservedAt
      : null,
    purpose: session.purpose || null,
    researchSessionId: session.researchSessionId || null,
    hiddenFromSidebar: !!session.hiddenFromSidebar,
  };
  return { ...meta, ...(overrides || {}) };
}

module.exports = {
  baseKind,
  runtimeKindForSession,
  sessionProviderFamily,
  nativeSessionIdentity,
  supportsRecoverableSession,
  supportsForkSession,
  sessionModelId,
  buildSessionResumeMeta,
  claudeSessionAccountMeta,
  codexSessionAccountMeta,
};
