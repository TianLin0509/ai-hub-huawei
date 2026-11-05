'use strict';
const { performance } = require('node:perf_hooks');

// Reconcile only an identified CodeAgent turn. Terminal silence and a public
// idle label are not completion evidence. Keep the private runtime cursors in
// this adapter instead of exposing them in team status or persisted messages.
function createTeamTurnReconciler({ sessionManager, transcriptTap, now = () => performance.now() }) {
  // Runtime-only weak keys follow session lifetimes; a new turn can be checked
  // immediately. Normal long turns and read failures share the same cooldown.
  const attempts = new WeakMap();
  const pending = reason => ({ reconciled: false, reason });
  return async function reconcileTeamTurn(sid) {
    const entry = sessionManager.sessions?.get?.(sid);
    const info = entry?.info;
    if (!entry || !/^codeagent(?:-resume)?$/.test(info?.kind || '')
        || info.agentRuntime !== 'pty' || info.runtimeBackend || !entry.pty
        || ['dormant', 'closed', 'exited'].includes(info.status)) {
      return pending('当前会话不是可核对的 CodeAgent 终端');
    }
    if (!entry.agentTurnActive) return pending('回合已经结束，无需清理');
    // TranscriptTap routes CodeAgent through ClaudeTap. Its bound entry is
    // replaced on restore; generation/user UUID change at a new prompt.
    const backend = transcriptTap._claude;
    const bound = backend?._bound?.get?.(sid);
    if (!bound || typeof transcriptTap.extractLatestTurn !== 'function'
        || !entry.agentTurnId || entry.agentTurnId !== bound.currentTurnId
        || !bound.transcriptPath
        || info.transcriptPath !== bound.transcriptPath
        || !Number.isInteger(entry.agentTurnStartSeq) || entry.agentTurnStartSeq < 1
        || !(entry.agentTurnStartedAt > 0)
        || !Number.isInteger(bound.generation) || bound.generation < 1
        || bound.awaitingPromptHook) {
      return pending('缺少同一回合的身份或记录绑定，等待核对');
    }
    const snapshot = {
      pty: entry.pty, seq: entry.agentTurnStartSeq, startedAt: entry.agentTurnStartedAt,
      turnId: entry.agentTurnId, generation: bound.generation,
      userId: bound.currentUserRecordId, path: bound.transcriptPath,
    };
    const previous = attempts.get(entry);
    const checkedAt = now();
    if (previous && previous.turnId === snapshot.turnId && previous.seq === snapshot.seq
        && previous.startedAt === snapshot.startedAt
        && (previous.inFlight || checkedAt - previous.at < 30000)) {
      return pending('同一回合每 30 秒核对一次完成记录，保持等待');
    }
    const attempt = { turnId: snapshot.turnId, seq: snapshot.seq, startedAt: snapshot.startedAt,
      at: checkedAt, inFlight: true };
    attempts.set(entry, attempt);
    let result;
    try {
      result = await transcriptTap.extractLatestTurn(sid, 0, {
        providerTurnId: snapshot.turnId, userRecordId: snapshot.userId,
      });
    } catch {
      return pending('回合记录读取失败，保持等待');
    } finally {
      attempt.inFlight = false;
    }
    if (sessionManager.sessions?.get?.(sid) !== entry || entry.pty !== snapshot.pty
        || backend._bound.get(sid) !== bound || transcriptTap._claude !== backend
        || entry.agentTurnStartSeq !== snapshot.seq || entry.agentTurnId !== snapshot.turnId
        || entry.agentTurnStartedAt !== snapshot.startedAt || !entry.agentTurnActive
        || bound.generation !== snapshot.generation || bound.currentTurnId !== snapshot.turnId
        // An exact hook-ID lookup may establish the previously missing user
        // UUID. No prompt/time fallback is supplied; any other rebinding loses.
        || (snapshot.userId ? bound.currentUserRecordId !== snapshot.userId
          : (bound.currentUserRecordId || null) !== (result?.userRecordId || null)) || bound.awaitingPromptHook
        || bound.transcriptPath !== snapshot.path || entry.info?.transcriptPath !== snapshot.path
        || entry.info?.agentRuntime !== 'pty' || entry.info?.runtimeBackend
        || ['dormant', 'closed', 'exited'].includes(entry.info?.status)) {
      return pending('核对期间会话或回合已变化，保持等待');
    }
    if (!result?.aligned || result.extractMode !== 'final_answer'
        || result.turnId !== snapshot.turnId || !result.userRecordId
        || (snapshot.userId && result.userRecordId !== snapshot.userId)
        || !result.recordId || !(result.completedAt >= snapshot.startedAt)) {
      return pending(result?.extractMode === 'read_failed'
        ? '回合记录读取失败，保持等待' : '尚未找到同一回合的完成记录，保持等待');
    }
    const reconciled = sessionManager.noteAgentTurnFinished(sid, {
      turnId: snapshot.turnId, completedAt: result.completedAt,
      signalSource: 'team-transcript-reconcile',
    }) === true;
    return { reconciled, reason: reconciled ? '已核对同一回合完成，清除旧运行标记' : '回合状态已变化，保持等待' };
  };
}

module.exports = { createTeamTurnReconciler };
