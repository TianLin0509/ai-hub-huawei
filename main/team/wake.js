'use strict';

// persistWorkscene 用 hubId 登记侧栏条目，不保存 status。恢复现场时，仍登记但
// 不在运行表里的条目会统一显示为 dormant（包括重启前没有 suspendedAt 的会话）。
function canWakeTeamSession(id, persistedSessions, runtimeSession) {
  const saved = (persistedSessions || []).find(s => s?.hubId === id);
  if (!saved || saved.suspendReason === 'user-close') return false;
  return !runtimeSession || runtimeSession.status === 'dormant';
}

module.exports = { canWakeTeamSession };
