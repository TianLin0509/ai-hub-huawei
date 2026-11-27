'use strict';
//   原生没启用 → 群照旧每 6 秒查（安静久了放慢到 15/30 秒，phone.js 原有规则）；
//   原生在线   → 群轮询停下（推送照常走群）；
//   原生启用但离线 → 群轮询改 60 秒一次兜底。
// 切换时往手机群推一行（只在配了群时）。

const FALLBACK_POLL_MS = 60000;
const OFFLINE_TEXT = '手机助手离线，已切回群轮询';
const RECOVERED_TEXT = '手机助手已恢复';

// 原有的安静放慢规则（phone.js 2026-11-20）：10 分钟没动静 15 秒、30 分钟 30 秒，否则不额外等（6 秒节拍）。
function quietGapMs(quietMs) {
  return quietMs > 30 * 60000 ? 30000 : quietMs > 10 * 60000 ? 15000 : 0;
}

// native: 'off' | 'online' | 'offline'。返回两次轮询之间至少隔多久；Infinity 表示不轮询。
function pollGapMs({ native = 'off', quietMs = 0 } = {}) {
  if (native === 'online') return Infinity;
  if (native === 'offline') return FALLBACK_POLL_MS;
  return quietGapMs(quietMs);
}

// 状态变化时要推给手机群的一行；没变化返回空串。
function transitionText(prev, next) {
  if (prev === next) return '';
  if (next === 'offline' && prev === 'online') return OFFLINE_TEXT;
  if (next === 'online' && prev === 'offline') return RECOVERED_TEXT;
  return '';
}

module.exports = { FALLBACK_POLL_MS, OFFLINE_TEXT, RECOVERED_TEXT, quietGapMs, pollGapMs, transitionText };
