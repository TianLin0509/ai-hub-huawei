'use strict';
// CodeAgent-Lite（共享 serve）起不来时的冷却账本（2026-11-24）。
// 某个账号的 serve 启动失败或运行中连续断线后记一笔：冷却期内，低开销模式隐式切来的会话、功能会话
// 直接走终端方式（PTY），不再每次白等启动超时再撞墙；用户在启动中心亲手点 CodeAgent-Lite 时仍允许试连一次，
// 连上就清掉这笔记录。只存在内存里：Hub 重启后重新试，旧版本升级、策略放开后自然恢复。
const path = require('node:path');

const COOLDOWN_MS = 30 * 60_000;
const ledger = new Map(); // key → { reason, until, count, at }

function keyOf(configDir) {
  const raw = String(configDir || '').trim();
  return raw ? path.resolve(raw).toLowerCase() : 'default';
}
const nowOf = opts => (typeof opts?.now === 'function' ? opts.now() : Number.isFinite(opts?.now) ? opts.now : Date.now());

function recordFailure(configDir, reason, opts = {}) {
  const key = keyOf(configDir), now = nowOf(opts);
  const cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : COOLDOWN_MS;
  const previous = ledger.get(key);
  const entry = { reason: String(reason || '未知原因').slice(0, 300), until: now + cooldownMs, count: (previous?.count || 0) + 1, at: now };
  ledger.set(key, entry);
  return { ...entry };
}

function isCoolingDown(configDir, opts = {}) {
  const key = keyOf(configDir), entry = ledger.get(key);
  if (!entry) return { cooling: false, reason: '', until: 0, count: 0 };
  if (nowOf(opts) >= entry.until) return { cooling: false, reason: entry.reason, until: entry.until, count: entry.count };
  return { cooling: true, reason: entry.reason, until: entry.until, count: entry.count };
}

function clearCooldown(configDir) { return ledger.delete(keyOf(configDir)); }

function status(opts = {}) {
  const now = nowOf(opts);
  return [...ledger.entries()].map(([key, entry]) => ({ key, ...entry, cooling: now < entry.until }));
}

function resetForTest() { ledger.clear(); }

// 建会话前的冷却短路（core/session-manager.js _createSession 调用，传入选号后最终生效的账号目录）：
// 会走 serve、但这个账号正在冷却时，除了用户在启动中心亲手点的 CodeAgent-Lite（explicitCodeagentLite），一律改走终端方式，
// 免得每次白等启动超时。source 只记录改道来源（日志用）：low-overhead = 低开销模式隐式切来，feature = 功能会话选了 Lite，
// saved = 用户保存的运行方式。返回 { opts, reason, source }：reason 非空表示已改道，opts 是新对象；否则原样返回。
function routeAroundCooldown(opts = {}, configDir, options = {}) {
  if (opts.explicitCodeagentLite === true) return { opts, reason: '', source: 'explicit' };
  const cooling = isCoolingDown(configDir, options);
  if (!cooling.cooling) return { opts, reason: '', source: '' };
  const source = opts.lowOverheadServe === true ? 'low-overhead' : opts.codeagentLiteFeature === true ? 'feature' : 'saved';
  const next = { ...opts, codeagentRunMode: 'pty' };
  delete next.codeagentLiteFeature;
  delete next.lowOverheadServe;
  return { opts: next, reason: cooling.reason || 'CodeAgent 轻享服务近期启动失败', source };
}

module.exports = { COOLDOWN_MS, keyOf, recordFailure, isCoolingDown, clearCooldown, status, resetForTest, routeAroundCooldown };
