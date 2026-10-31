'use strict';

// Launch-center ranking from what the Hub already knows: the last quota reading
// and its own session list. No request goes out, so opening stays instant.
// Spare quota is the tighter of the 5h and 7d windows; a running session keeps
// spending it, an idle one only might.
const RUNNING_SESSION_COST = 10;
const IDLE_SESSION_COST = 3;

function spare(window, now) {
  if (!window || !Number.isFinite(window.pct)) return null;
  if (Number(window.resetsAt) > 0 && Number(window.resetsAt) <= now) return 100;
  return Math.max(0, Math.min(100, 100 - window.pct));
}

function liveSessionsByProfile(sessions) {
  const counts = new Map();
  for (const session of sessions || []) {
    if (!session?.claudeProfile || ['dormant', 'closed'].includes(session.status)) continue;
    const row = counts.get(session.claudeProfile) || { running: 0, idle: 0 };
    row[session.status === 'running' ? 'running' : 'idle']++;
    counts.set(session.claudeProfile, row);
  }
  return counts;
}

function rankClaudeAccounts({ accounts, sessions, now = Date.now() }) {
  const live = liveSessionsByProfile(sessions);
  const rows = (accounts || []).map(account => {
    const spare5h = spare(account.usage5h, now), spare7d = spare(account.usage7d, now);
    const { running = 0, idle = 0 } = live.get(account.profileId) || {};
    const known = spare5h !== null && spare7d !== null;
    const usable = known && !account.error && Math.min(spare5h, spare7d) > 0;
    return { id: account.profileId, spare5h, spare7d, running, idle, usable,
      score: usable ? Math.min(spare5h, spare7d) - running * RUNNING_SESSION_COST - idle * IDLE_SESSION_COST : null };
  });
  const tier = row => row.usable ? 0 : row.spare5h === null || row.spare7d === null ? 1 : 2;
  rows.sort((a, b) => tier(a) - tier(b) || (b.score ?? 0) - (a.score ?? 0) || a.running + a.idle - b.running - b.idle);
  return { recommendedId: rows[0]?.usable ? rows[0].id : null, rows };
}

function accountHint(row) {
  const quota = row.spare5h === null || row.spare7d === null ? '额度待读取' : `5h 余 ${row.spare5h}% · 7d 余 ${row.spare7d}%`;
  const count = row.running + row.idle;
  return `${quota} · ${count ? `${count} 个会话${row.running ? `（${row.running} 个在跑）` : ''}` : '无会话'}`;
}

module.exports = { IDLE_SESSION_COST, RUNNING_SESSION_COST, accountHint, liveSessionsByProfile, rankClaudeAccounts };
