'use strict';
// 内存紧张就地提示（R59 方案 A，2026-11-27）的纯判定。
// 用户反馈「多个会话一起跑内存 95%」：Hub 已有内存压力休眠（main/session-auto-suspend.js）和低开销模式，
// 但升级用户不知道、也看不到「是谁占的、能腾多少」。这里只回答三件事：现在算不算紧张、几个会话闲着、几个在跑。
// 「闲着」与「释放内存」面板同一口径（session-manager.describeSessionsForMemory 的 suspendable，
// 即 MEMORY_RELEASE_SUSPEND_OPTIONS：答完闲置满 10 分钟、不是当前会话、不在群聊），一键休眠走同一道闸门。

const GB = 1024 ** 3;
// 进入紧张：整机占用 ≥85%，或可用不足 4 GB（再开一个带插件的 CodeAgent 会话约要 1.5–2 GB）。
// 退出要再松一点（<80% 且 ≥5 GB），免得在门槛上来回闪。
const TIGHT_USAGE = 0.85;
const CLEAR_USAGE = 0.80;
const TIGHT_FREE_BYTES = 4 * GB;
const CLEAR_FREE_BYTES = 5 * GB;

function isTight({ usage, freeBytes } = {}, wasTight = false) {
  const u = Number(usage) || 0;
  const f = Number(freeBytes);
  const hasFree = Number.isFinite(f) && f >= 0;
  if (wasTight) return u >= CLEAR_USAGE || (hasFree && f < CLEAR_FREE_BYTES);
  return u >= TIGHT_USAGE || (hasFree && f < TIGHT_FREE_BYTES);
}

// rows：session-manager.describeSessionsForMemory() 的结果。
function summarize({ rows = [], usage = 0, freeBytes = null, totalBytes = null, wasTight = false, lowOverheadOn = false, idleBytes = null } = {}) {
  const live = (rows || []).filter(r => r && r.id && !/^(dormant|closed)$/.test(String(r.status || '')));
  const idle = live.filter(r => r.suspendable === true);
  const busy = live.filter(r => r.suspendable !== true && r.running === true);
  return {
    tight: isTight({ usage, freeBytes }, wasTight),
    usage: Number(usage) || 0,
    freeBytes: Number.isFinite(Number(freeBytes)) ? Number(freeBytes) : null,
    totalBytes: Number.isFinite(Number(totalBytes)) ? Number(totalBytes) : null,
    liveCount: live.length,
    idleIds: idle.map(r => r.id),
    idleCount: idle.length,
    busyCount: busy.length,
    idleBytes: Number(idleBytes) > 0 ? Number(idleBytes) : null,
    lowOverheadOn: lowOverheadOn === true,
  };
}

// 推给界面前比一下：只有用户看得到的东西变了才推（占用按整数百分比）。
function signature(s) {
  if (!s) return '';
  return [s.tight ? 1 : 0, Math.round((s.usage || 0) * 100), s.idleCount, s.busyCount, s.liveCount,
    s.idleBytes ? Math.round(s.idleBytes / (GB / 10)) : 0, s.lowOverheadOn ? 1 : 0].join('|');
}

module.exports = { GB, TIGHT_USAGE, CLEAR_USAGE, TIGHT_FREE_BYTES, CLEAR_FREE_BYTES, isTight, summarize, signature };
