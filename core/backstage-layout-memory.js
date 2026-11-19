'use strict';

// 按会话记住「后台显示方式」（2026-11-18 反馈：切到别的会话再回来就恢复默认）。
// 只记用户亲手点的：顶栏「后台」按钮（卡片 ↔ 后台）和「后台显示方式」菜单（卡片/后台切换 ↔ 左右并排）。
//   'split' = 左右并排（左卡片、右同一会话的后台）
//   'pty'   = 单屏停在后台
//   没记录   = 卡片（默认，和以前一样）
// 存 localStorage，最多 300 个会话，超出丢最早的。

const STORAGE_KEY = 'hub.backstageLayoutBySession';
const LIMIT = 300;
const LAYOUTS = new Set(['split', 'pty']);

function readBackstageLayouts(store, key = STORAGE_KEY) {
  const map = new Map();
  if (!store || typeof store.getItem !== 'function') return map;
  try {
    const raw = JSON.parse(store.getItem(key) || '[]');
    if (Array.isArray(raw)) for (const pair of raw) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0] && LAYOUTS.has(pair[1])) map.set(pair[0], pair[1]);
    }
  } catch { /* 坏数据当没记过 */ }
  return map;
}

function writeBackstageLayouts(store, map, key = STORAGE_KEY) {
  if (!store || typeof store.setItem !== 'function') return false;
  try { store.setItem(key, JSON.stringify([...map].slice(-LIMIT))); return true; } catch { return false; }
}

// 返回是否有变化。'card' 或其他值 = 回到默认，删掉记录。重新记一次会挪到最新。
function rememberBackstageLayout(map, sessionId, layout) {
  if (!map || !sessionId) return false;
  const before = map.get(sessionId);
  map.delete(sessionId);
  if (LAYOUTS.has(layout)) map.set(sessionId, layout);
  return map.get(sessionId) !== before || LAYOUTS.has(layout);
}

function backstageLayoutFor(map, sessionId) {
  return (map && sessionId && map.get(sessionId)) || 'card';
}

module.exports = { STORAGE_KEY, LIMIT, readBackstageLayouts, writeBackstageLayouts, rememberBackstageLayout, backstageLayoutFor };
