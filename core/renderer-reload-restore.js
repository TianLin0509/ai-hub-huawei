'use strict';
// 界面重新载入（卡死自救、崩溃恢复）后，把侧栏状态接回来（2026-11-21）。
//
// 2026-11-20 生产实测：界面被强制重载两次，每次约 2 分钟后状态审计都记到 4 个会话「transcript 里工具还在跑、
// 侧栏却显示空闲」（来源 legacy-idle），11-12 那次重载也一样。原因：Claude 终端会话的运行状态、未读、
// 等你回复这些标记只存在界面进程里；主进程只保留了「这一轮是否还在进行」（agentTurnActive，闲置巡检和
// 组队心跳都靠它），get-sessions 却没把它带给界面。界面上次落盘的 state.json 里有未读与等待标记，
// 但启动时对主进程里还活着的会话直接跳过了落盘记录。
//
// 做法：
//   1. 主进程在 get-sessions 里给仍在进行的终端回合附上 liveTurn（开始时间、回合号），界面据此把会话
//      重新标成运行中；之后的 Stop / transcript 终态照常收尾，10 分钟有效期与提交确认那条路一致。
//   2. 活着的会话也读 state.json 里的未读数和等待/已回复标记，界面里没有更新的标记时才补上。
const RESTORE_SOURCE = 'hub-reload-turn-active';
const RESTORE_TTL_MS = 10 * 60 * 1000;
const ATTENTION_FIELDS = ['attentionState', 'needsUserInput', 'replyReady', 'replyReadyText', 'waitingReason', 'waitingText'];

// 主进程侧：终端会话这一轮还在进行时的快照字段；其他情况返回 null。
function liveTurnSnapshot(entry) {
  const info = entry && entry.info;
  if (!entry || !entry.agentTurnActive || !info || info.agentRuntime !== 'pty' || info.runtimeBackend) return null;
  return {
    startedAt: Number(entry.agentTurnStartedAt) || 0,
    turnId: entry.agentTurnId || null,
    source: entry.agentTurnStartSource || null,
  };
}

function hasAttention(session) {
  if (!session) return false;
  const state = session.attentionState;
  return (!!state && state !== 'none') || session.needsUserInput === true || session.replyReady === true;
}

// 落盘的标记是不是还属于当前这一轮（Codex 复审 2026-11-21：上一轮的「等你输入」不能压过主进程记下的新一轮运行）。
//   等你输入：只有主进程说这一轮还在进行、且落盘晚于这一轮开始时才算数；回合已结束就不再等。
//   已回复：主进程记下的新一轮开始晚于那次回复（用户已经接着发了），不再补回。
function attentionStillCurrent(session, meta) {
  const live = session && session.liveTurn;
  const liveStart = live ? Number(live.startedAt) || 0 : 0;
  const waiting = meta.attentionState === 'needs-input' || (meta.needsUserInput === true && meta.attentionState !== 'reply-ready');
  if (waiting) return !!live && (Number(meta.updatedAt) || 0) >= liveStart;
  if (live && liveStart > (Number(meta.lastCompletedAt) || 0)) return false;
  return true;
}

// 界面侧：用落盘记录补回未读与等待标记。返回是否改动。
function restorePersistedAttention(session, meta) {
  if (!session || !meta || typeof meta !== 'object') return false;
  let changed = false;
  const unread = Math.max(0, Number(meta.unreadCount) || 0);
  if (unread > (Number(session.unreadCount) || 0)) { session.unreadCount = unread; changed = true; }
  if (!hasAttention(session) && hasAttention(meta) && attentionStillCurrent(session, meta)) {
    for (const key of ATTENTION_FIELDS) if (meta[key] !== undefined) session[key] = meta[key];
    changed = true;
  }
  const completedAt = Number(meta.lastCompletedAt) || 0;
  if (completedAt > (Number(session.lastCompletedAt) || 0)) { session.lastCompletedAt = completedAt; changed = true; }
  return changed;
}

// 界面侧：liveTurn 对应的运行观察；不需要恢复时返回 null（没有进行中的回合、或已有更新的运行状态）。
function liveTurnObservation(session, now = Date.now()) {
  const live = session && session.liveTurn;
  if (!live || typeof live !== 'object') return null;
  const truth = session.runtimeTruth;
  if (truth && (truth.state === 'running' || truth.state === 'starting' || truth.state === 'waiting')) return null;
  const startedAt = Number(live.startedAt) || now;
  return {
    state: 'running',
    source: RESTORE_SOURCE,
    confidence: 'semantic',
    observedAt: now,
    startedAt,
    expiresAt: now + RESTORE_TTL_MS,
    turnId: live.turnId || null,
    evidence: '界面重新载入前这一轮还在进行（主进程记录）',
  };
}

module.exports = { liveTurnSnapshot, restorePersistedAttention, liveTurnObservation, RESTORE_SOURCE, RESTORE_TTL_MS, ATTENTION_FIELDS };
