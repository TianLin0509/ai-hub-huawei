'use strict';

// 不能每隔几秒原样再撞一次。2026-11-11 曾有一个任务泵每 15 秒新建一次 Claude 会话、连撞 24 次同一个错误，
// 日志里连原因都没留。规则：同一种会话连续自动失败 3 次就暂停，暂停 1 分钟起、每轮翻倍、最长 15 分钟；
// 到期后放行一次试探，再失败就进下一轮；整段连续失败只提示一次；任何一次成功（含用户手动新建成功）立即解除。用户手动新建不受暂停影响。
const LIMIT = 3;
const BASE_MS = 60_000;
const MAX_MS = 15 * 60_000;

function kindKey(kind) { return String(kind || 'powershell').replace(/-resume$/, ''); }
function reasonOf(error) {
  const text = String(error?.message || error || '未知原因').replace(/Error invoking remote method '[^']+': (?:Error: )?/, '');
  return text.split(/\r?\n/)[0].slice(0, 160);
}

function createSessionStartBackoff({ now = Date.now, limit = LIMIT, baseMs = BASE_MS, maxMs = MAX_MS, onPause = () => {} } = {}) {
  const state = new Map(); // kind → { fails, rounds, until, reason, code }

  // 自动调用方在真正建会话前调用：处于暂停期就直接抛出，不再碰 CLI、登录和数据库。
  function assertAllowed(kind) {
    const row = state.get(kindKey(kind));
    if (!row || !(row.until > now())) return;
    const seconds = Math.max(1, Math.ceil((row.until - now()) / 1000));
    throw Object.assign(new Error(`自动新建会话已暂停 ${seconds} 秒：连续 ${limit} 次失败（${row.reason}）`),
      { code: 'SESSION_START_BACKOFF', cause: row.code || undefined, retryAfterMs: row.until - now() });
  }
  function succeeded(kind) { state.delete(kindKey(kind)); }
  function failed(kind, error) {
    // 暂停本身、用户在确认框里点了取消，都不算一次启动失败。
    if (error?.code === 'SESSION_START_BACKOFF' || error?.code === 'SESSION_CREATION_CANCELLED') return null;
    const key = kindKey(kind);
    const row = state.get(key) || { fails: 0, rounds: 0, until: 0 };
    row.fails += 1;
    row.reason = reasonOf(error);
    row.code = error?.code || null;
    // 暂停过一轮后，到期那一次试探再失败就直接进下一轮（等待翻倍），不再重新攒 3 次。
    if (row.fails >= limit || row.rounds > 0) {
      const wait = Math.min(baseMs * 2 ** row.rounds, maxMs);
      row.rounds += 1;
      row.fails = 0;
      row.until = now() + wait;
      state.set(key, row);
      // 同一段连续失败只提示一次（第一轮暂停时）；后续轮次只进日志。
      if (row.rounds === 1) { try { onPause({ kind: key, reason: row.reason, code: row.code, waitMs: wait }); } catch {} }
      return row;
    }
    state.set(key, row);
    return row;
  }
  return { assertAllowed, succeeded, failed, snapshot: () => new Map(state) };
}

module.exports = { createSessionStartBackoff, reasonOf, LIMIT, BASE_MS, MAX_MS };
