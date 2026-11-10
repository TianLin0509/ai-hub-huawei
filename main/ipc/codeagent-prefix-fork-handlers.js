'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getHubDataDir } = require('../../core/data-dir');
const { getSessionRuntimeTruth } = require('../../core/session-runtime-truth');
const { planSessionFork } = require('../../core/session-fork-plan');
const { findNativeClaudeHistory } = require('../../core/claude-native-history');
const { sessionConfigDir } = require('../../core/codeagent-default-model-guard');
const { sameWorkDir } = require('../../core/hook-cwd-match');
const { forkClaudePrefix, readStableTranscript, listTranscriptTurns, reasonText, resolveAfterReply, diagnosticStats, transcriptStats, inspectSiblingDirectory } = require('../../core/claude-prefix-fork');
const { isNativeRecordId, isNativeSessionId } = require('../../core/codeagent-record-id');

function registerPrefixForkIpc(ipcMain, deps) {
  const { sessionManager, registerSessionForTap = () => {}, sendToRenderer, forkSiblingPool = () => [] } = deps;
  const dataDir = deps.dataDir || getHubDataDir();
  const prefixFs = deps.prefixFs || fs;
  const enabled = () => (deps.prefixEnabled ? deps.prefixEnabled() : require('../../core/hub-config').getConfig()?.codeagentPrefixBranch) !== false;
  const lookupSource = id => {
    if (typeof id !== 'string') return null;
    const live = sessionManager.getSession(id);
    if (live) return live;
    const saved = deps.getPersistedSessions?.()?.find(item => item.hubId === id);
    return saved ? { ...saved, id, status: 'dormant' } : null;
  };
  const dormantAvailability = source => {
    try {
      // A stale dormant label cannot prove that this Hub has stopped its CLI.
      if (sessionManager.sessions?.has(source.id)) return { ok: false, reason: 'session-busy', message: '本 Hub 仍有会话进程或启动任务' };
      const owners = sessionManager._openOwners?.();
      if (!owners) return { ok: false, reason: 'state-unknown', message: '无法确认会话占用状态' };
      if (owners.owner(source.id, true)) return { ok: false, reason: 'session-occupied', message: '会话已被 Hub 打开或占用，请关闭占用后重试' };
      return { ok: true };
    } catch { return { ok: false, reason: 'state-unknown', message: '无法确认会话占用状态' }; }
  };
  const sourceHistory = source => {
    if (!isNativeSessionId(source.ccSessionId) || !source.cwd) return { ok: false, reason: 'native-identity-missing', message: '会话尚未绑定有效的原生记录' };
    const runtime = sessionManager.sessions?.get(source.id)?.info || source;
    const configDir = runtime.codeagentPrefixFork?.configDir || sessionConfigDir(runtime, { dataDir });
    if (!configDir) return { ok: false, reason: 'account-directory-missing', message: '未找到该会话的账号目录' };
    const file = findNativeClaudeHistory(source.ccSessionId, { cwd: source.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
    if (!file || !source.transcriptPath || !sameWorkDir(file, source.transcriptPath)) {
      return { ok: false, reason: 'source-history-missing', message: '源会话记录不在该账号的原生历史目录中' };
    }
    const read = readStableTranscript(file, { fsModule: prefixFs });
    return read.ok ? { ok: true, file, configDir, read } : { ...read, message: reasonText(read.reason) };
  };
  const holdDormantSource = (source, configDir) => {
    const owners = sessionManager._openOwners();
    const keys = require('../../core/session-open-ownership').nativeKeys('codeagent',
      { resumeCCSessionId: source.ccSessionId }, { CLAUDE_CONFIG_DIR: configDir });
    // Reserve only the ownership keys, never SessionManager or the saved state.
    // This also catches the same native transcript opened under another Hub ID.
    const lease = owners.claim(source.id, keys);
    return () => owners.release(lease);
  };
  ipcMain.handle('session:prefix-fork-status', (_event, request = {}) => {
    if (!enabled()) return { ok: false, reason: 'experiment-disabled', message: '历史分支实验未开启' };
    try {
      const source = lookupSource(request?.sourceSessionId);
      if (!source || !/^codeagent(?:-resume)?$/.test(source.kind) || source.meetingId) {
        return { ok: false, reason: 'unsupported-session', message: '无法确认可分支的单聊会话' };
      }
      if (getSessionRuntimeTruth(source).state !== 'dormant') return { ok: false, reason: 'state-changed', message: '会话状态已变化，请重新打开历史' };
      const availability = dormantAvailability(source);
      if (!availability.ok) return availability;
      const history = sourceHistory(source);
      if (!history.ok) return { ok: false, reason: history.reason, message: history.message };
      const again = dormantAvailability(source);
      if (!again.ok) return again;
      const release = holdDormantSource(source, history.configDir);
      release();
      return { ok: true };
    } catch (error) { return { ok: false, reason: error.code === 'SESSION_OCCUPIED' ? 'session-occupied' : 'state-unknown',
      message: error.code === 'SESSION_OCCUPIED' ? '会话已被 Hub 打开或占用，请关闭占用后重试' : '无法确认会话或记录状态' }; }
  });
  const diagnostic = data => {
    try {
      fs.mkdirSync(path.join(dataDir, 'diagnostics'), { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'diagnostics/codeagent-prefix-fork.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
    } catch { console.warn('[prefix-fork] diagnostic write failed'); }
  };
  ipcMain.handle('session:prefix-fork-client-failed', (_event, request = {}) => {
    const source = lookupSource(request?.sourceSessionId);
    const rejection = !enabled() ? 'experiment-disabled' : !/^codeagent(?:-resume)?$/.test(source?.kind || '')
      ? 'unsupported-kind' : !['idle', 'completed', 'interrupted'].includes(getSessionRuntimeTruth(source).state) ? 'session-busy' : null;
    if (rejection) {
      diagnostic({ result: 'rejected', reason: rejection, readSkipped: rejection });
      return { ok: false, reason: rejection };
    }
    let rows = null;
    if (source?.transcriptPath) {
      const read = readStableTranscript(source.transcriptPath, { fsModule: prefixFs });
      if (read.ok) rows = read.rows;
    }
    diagnostic({ reason: 'client-request-or-selection-failed', result: 'unknown',
      sourceFile: source?.transcriptPath || null, ...diagnosticStats(source?.transcriptPath, rows),
      sidecar: source?.transcriptPath ? inspectSiblingDirectory(source.transcriptPath) : null });
    return { ok: true };
  });
  const createBranch = async (request = {}, ordinary = false) => {
    request = request && typeof request === 'object' ? request : {};
    const source = lookupSource(request.sourceSessionId);
    const log = { source: source?.id?.slice(0, 8) || null, cutUserUuid: isNativeRecordId(request.cutUserUuid) ? request.cutUserUuid : null,
      newSessionId: null, keptLines: 0, droppedLines: 0, result: 'rejected', reason: null };
    let rows = null, sourceFile = null, sidecar = null, readEvidence = false;
    let preparedFile = null, sessionCreated = false, failure = null, releaseSource = null;
    const fail = (reason, message) => { log.reason = reason; failure = { ok: false, reason, message }; return failure; };
    try {
      if (!enabled()) return fail('experiment-disabled', '历史分支实验未开启');
      if (!source) return fail('session-not-found', '会话不存在或已关闭');
      if (!/^codeagent(?:-resume)?$/.test(source.kind)) return fail('unsupported-kind', '仅 CodeAgent 支持从这一轮前分支');
      if (source.meetingId) return fail('group-session', '群聊成员不支持此操作');
      if (!ordinary && (typeof request.replyId !== 'string' || request.replyId.length > 200)) return fail('invalid-cut', '无法精确定位所选回复');
      const state = getSessionRuntimeTruth(source).state;
      if (state === 'dormant') {
        const availability = dormantAvailability(source);
        if (!availability.ok) return fail(availability.reason, availability.message);
      } else if (!['idle', 'completed', 'interrupted'].includes(state)) {
        return fail('session-busy', ['running', 'starting', 'waiting'].includes(state) ? '回答进行中，请等会话空闲后分支' : '无法确认会话空闲，请先查看终端');
      }
      readEvidence = true;
      const history = sourceHistory(source);
      if (!history.ok) return fail(history.reason, history.message);
      const { file, configDir, read } = history;
      sourceFile = file;
      rows = read.rows;
      if (state === 'dormant') {
        const availability = dormantAvailability(source);
        if (!availability.ok) return fail(availability.reason, availability.message);
        releaseSource = holdDormantSource(source, configDir);
      }
      // An explicit full-history fallback has no cut. Never infer this choice
      // from a failed/ambiguous reply lookup on the prefix operation.
      const boundary = ordinary ? {} : resolveAfterReply(rows, request.replyId);
      log.cutLineType = boundary.cutLineType || null;
      if (boundary.reason) return fail(boundary.reason, boundary.reason === 'reply-not-found'
        ? '无法在完整原生记录中定位所选正文回复' : '后续消息或所选回复无法唯一定位，不能安全分支');
      log.cutUserUuid = boundary.cutUserUuid || null;
      if (read.rows.some(row => ['user', 'assistant'].includes(row.type) && !row.isSidechain && row.sessionId !== source.ccSessionId)) {
        return fail('source-identity-mismatch', '源记录的原生会话身份不一致');
      }
      if (ordinary) {
        if (!deps.forkSession) return fail('ordinary-fork-unavailable', '普通分支暂不可用，请新开会话');
        const result = await deps.forkSession({ sourceSessionId: source.id, sourceTitle: source.title }, source);
        if (!result?.ok) return fail(result?.error || 'ordinary-fork-failed', result?.message || '普通分支失败');
        log.result = 'created'; log.reason = 'ordinary-fork';
        return result;
      }
      const prefixStats = transcriptStats(rows.slice(0, boundary.index ?? rows.length));
      log.prefixHasSubtasks = prefixStats.hasSubtasks;
      log.prefixHasSidechain = prefixStats.hasSidechain;
      log.prefixHasTaskToolUse = prefixStats.hasTaskToolUse;
      sidecar = inspectSiblingDirectory(file, { fsModule: prefixFs });
      if (!sidecar.ok) {
        const message = sidecar.reason === 'sidecar-unreadable' ? '无法完整读取同名目录或其条目' : '同名目录含未知条目或不支持的目录结构';
        return fail(sidecar.reason, message + '，无法安全截断；可尝试普通分支或新开会话');
      }
      if (log.prefixHasSidechain) return fail('unsupported-sidechain', '要保留的前缀含旁链记录（isSidechain=true），无法安全截断；可尝试普通分支或新开会话');
      const plan = planSessionFork({ source, siblingPool: forkSiblingPool(), rendererTitle: source.title });
      if (!plan.ok) return fail(plan.error, plan.message);
      // Card branches preserve the full immediate parent's title, including
      // earlier branch prefixes. The ordinary tools fork keeps its own policy.
      plan.opts.title = `分支${plan.branchIndex}: ${String(source.title || '').trim() || '会话'}`;
      plan.opts.branchAutoTitlePending = false;
      plan.opts.autoTitleGenerated = true;
      if (require('../../core/session-scenes').isScenePurpose(source.purpose)) plan.opts.purpose = source.purpose;
      const copied = forkClaudePrefix({ sourceFile: file, configDir, cwd: source.cwd, cutUserUuid: boundary.cutUserUuid,
        replyId: request.replyId, expectedStat: read.stat }, { fsModule: prefixFs });
      Object.assign(log, { newSessionId: copied.newSessionId, keptLines: copied.keptLines, droppedLines: copied.droppedLines });
      if (!copied.ok) {
        log.preparedFileState = copied.reason === 'cleanup-failed' ? 'retained' : 'not-created';
        return fail(copied.reason, reasonText(copied.reason));
      }
      preparedFile = copied.file; log.preparedFileState = 'prepared';
      const seed = readStableTranscript(copied.file, { fsModule: prefixFs });
      if (!seed.ok) return fail(seed.reason, reasonText(seed.reason));
      const metadata = { version: 1, sourceSessionId: source.id, sourceNativeSessionId: source.ccSessionId,
        cutUserUuid: boundary.cutUserUuid, newSessionId: copied.newSessionId, configDir, empty: false,
        prefixUserUuids: listTranscriptTurns(seed.rows).map(turn => turn.uuid) };
      const opts = { ...plan.opts, codeagentPrefixFork: metadata, codeagentForkSourceSessionId: source.ccSessionId,
        codeagentModelPick: false, resumeCCSessionId: copied.newSessionId, resumeTranscriptPath: copied.file };
      delete opts.forkCCSessionId;
      const session = sessionManager.createSession('codeagent', opts);
      sessionCreated = true; log.preparedFileState = 'session-owned';
      registerSessionForTap(session);
      sendToRenderer('session-created', { session });
      log.result = 'created'; log.reason = null;
      return { ok: true, session };
    } catch (error) {
      if (error.code === 'SESSION_OCCUPIED') return fail('session-occupied', '会话已被 Hub 打开或占用，请关闭占用后重试');
      return fail('prefix-fork-failed', '分支创建失败，未启动源会话，请查看 Hub diagnostics 分支诊断');
    } finally {
      if (releaseSource) { try { releaseSource(); } catch { log.ownershipReleaseFailed = true; } }
      if (preparedFile && !sessionCreated) {
        try { prefixFs.unlinkSync(preparedFile); log.preparedFileState = 'removed'; }
        catch (error) {
          log.preparedFileState = error.code === 'ENOENT' ? 'removed' : 'retained';
          if (log.preparedFileState === 'retained' && failure) {
            log.cleanupReason = 'cleanup-failed'; failure.reason = 'cleanup-failed';
            failure.message = `分支失败且新记录未能删除（${log.newSessionId}），请检查 Hub diagnostics；勿恢复该记录`;
          }
        }
      }
      // Off/busy/invalid-kind requests never inspect records or directories.
      // Evidence paths come from Main's session, never from the request.
      if (readEvidence && !rows && source?.transcriptPath) {
        sourceFile = source.transcriptPath;
        const read = readStableTranscript(sourceFile, { fsModule: prefixFs });
        if (read.ok) rows = read.rows;
      }
      diagnostic({ ...log, sourceFile, ...(readEvidence ? diagnosticStats(sourceFile, rows)
        : { ...transcriptStats(null), readSkipped: log.reason }),
        sidecar: sidecar || (readEvidence && sourceFile ? inspectSiblingDirectory(sourceFile, { fsModule: prefixFs }) : null) });
    }
  };
  ipcMain.handle('session:fork-before-turn', (_event, request) => createBranch(request));
  ipcMain.handle('session:prefix-fork-ordinary', (_event, request) => createBranch(request, true));
}
module.exports = { registerPrefixForkIpc };
