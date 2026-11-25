'use strict';
// 小队负责人掉线后「重启负责人并继续」用到的两件事（R46）：是否真的需要重启、以及怎么重启。
// Two helpers for the squad "restart leader and continue" button (R46): whether a restart is really needed, and how to restart.
const { detectHostShellTakeover } = require('../../core/host-shell-detector');

// 按 CLI 真实状态判断（R46 审查 P1-4）：原生连接断了、终端退回系统 shell 才重启；停下之后才启动的进程说明用户已手动重启过。
// Real CLI state (R46 review P1-4): restart only if the native link is down or the terminal is back at the shell;
// a process started after the halt means the user already restarted it.
function leaderNeedsRestart(sessionManager, sid, { haltedAt = 0, detect = detectHostShellTakeover } = {}) {
  const s = sessionManager.getSession(sid);
  if (!s) return false;   // 休眠的交给 ensureMemberReady 唤醒 / dormant ones are woken by ensureMemberReady
  const native = sessionManager.getNativeClaude?.(sid) || sessionManager.getNativeSession?.(sid);
  if (native) return !!(native.closed || native.runtime?.state === 'failed'
    || (native.runtime?.connection && native.runtime.connection !== 'connected'));
  if (detect(sessionManager.getSessionBuffer(sid) || '')) return true;
  const startedAt = Number(s.spawnedAt ?? s.createdAt) || 0;
  if (haltedAt && startedAt > haltedAt) return false;
  return !sessionManager.getGroupChatReady(sid);
}

// 还没绑定原生会话 ID（首轮前就掉线）的终端会话：恢复不了历史，就在原终端重新拉起 CLI（R46 审查 P2-2）。
// No native id yet (dropped before the first turn): history cannot be resumed, so relaunch the CLI in the same terminal.
async function restartLeader(sessionManager, restartSession, sid, { detect = detectHostShellTakeover } = {}) {
  const res = await restartSession(sid);
  if (res?.error === 'native-session-id-missing'
    && detect(sessionManager.getSessionBuffer(sid) || '')
    && sessionManager.relaunchCli(sid, { trigger: 'squad-leader-recover' })) {
    return sessionManager.getSession(sid) || { ok: true, id: sid };
  }
  return res;
}

module.exports = { leaderNeedsRestart, restartLeader };
