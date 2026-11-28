'use strict';
// 社区榜单·内源只读黑板（2026-11-28）：黄区收件机每小时把全员公开榜单原地写入 OpenX 固定版本 community-board 的描述，
// 绿区等与收件机隔离的客户端连不上收件机时，按 by_id 匿名读取这份描述看榜（与版本索引 hub-index 同机制）。
const openxConfig = require('../app-update/openx-config');

const BOARD_RELEASE_NAME = 'community-board';
const BOARD_MARK = '#community-board v1';
const BOARD_HEAD = 'AI HUB 社区榜单（Hub 自动读取，请勿手改）';
const BOARD_KEYS = ['level', 'wxp', 'wtok', 'streak', 'ach'];
const MAX_BOARD_DESC_BYTES = 48 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

function cleanBoardReleaseId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 1e9 ? n : 0;
}

function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((e, idx) => {
    if (!e || typeof e !== 'object') return null;
    return {
      rank: Number(e.rank) > 0 ? Math.floor(Number(e.rank)) : idx + 1,
      nick: typeof e.nick === 'string' ? e.nick : '',
      pet: typeof e.pet === 'string' ? e.pet : '',
      lv: Number.isFinite(Number(e.lv)) ? Math.floor(Number(e.lv)) : 1,
      value: Number.isFinite(Number(e.value)) ? Number(e.value) : 0,
      wxp: Number.isFinite(Number(e.wxp)) ? Number(e.wxp) : 0,
      ...(typeof e.on === 'boolean' ? { on: e.on } : {}),
      me: false,
    };
  }).filter(Boolean);
}

// 抽出公开可展示的榜单字段（去掉 me、30 天趋势 daily、收件机状态 host、diag）。
function sanitizeBoardSnapshot(board) {
  if (!board || typeof board !== 'object' || !board.boards || typeof board.boards !== 'object') return null;
  const boards = {};
  for (const k of BOARD_KEYS) boards[k] = cleanEntries(board.boards[k]);
  const versions = Array.isArray(board.versions)
    ? board.versions.slice(0, 8).map(x => ({ v: String(x && x.v || ''), n: Number(x && x.n) || 0 })).filter(x => x.v)
    : [];
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    v: 1,
    at: num(board.at),
    online: num(board.online),
    activeNow: num(board.activeNow),
    today: num(board.today),
    week: num(board.week),
    total: num(board.total || board.participants),
    todayDelta: num(board.todayDelta),
    weekDelta: num(board.weekDelta),
    versions,
    boards,
    minK: num(board.minK, 5) || 5,
  };
}

// 不含时间戳 at 的摘要，用来判断榜单有没有实质变化（没变化就不起无头浏览器）。
function boardSignature(board) {
  const snap = sanitizeBoardSnapshot(board);
  if (!snap) return '';
  const { at: _at, ...rest } = snap;
  return JSON.stringify(rest);
}

function serializeBoard(board, maxBytes = MAX_BOARD_DESC_BYTES) {
  const base = sanitizeBoardSnapshot(board);
  if (!base) return '';
  for (const limit of [20, 15, 10, 5, 0]) {
    const trimmed = {
      ...base,
      boards: Object.fromEntries(BOARD_KEYS.map(k => [k, base.boards[k].slice(0, limit)])),
    };
    const text = `${BOARD_HEAD}\n${BOARD_MARK}\n${JSON.stringify(trimmed)}`;
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  }
  return '';
}

function parseBoardDescription(description) {
  const text = String(description || '');
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex(l => l.trim() === BOARD_MARK);
  if (idx < 0) return { ok: false, error: '黑板缺少版本标记' };
  const payload = lines.slice(idx + 1).join('\n').trim();
  if (!payload) return { ok: false, error: '黑板内容为空' };
  let raw;
  try { raw = JSON.parse(payload); } catch { return { ok: false, error: '黑板内容不是有效 JSON' }; }
  if (!raw || raw.v !== 1) return { ok: false, error: '黑板格式版本不支持' };
  const snap = sanitizeBoardSnapshot(raw);
  if (!snap) return { ok: false, error: '黑板榜单结构不完整' };
  return { ok: true, board: { ...snap, ok: true, state: 'ok', isHost: false, me: null } };
}

async function readBlackboard({ releaseId, config = openxConfig, fetchImpl, readViaLogin = null, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = cleanBoardReleaseId(releaseId) || cleanBoardReleaseId(config && config.boardReleaseId);
  if (!id) return { ok: false, error: '未配置黑板发布编号' };
  if (!config || !config.api || typeof fetchImpl !== 'function') return { ok: false, error: '缺少内源配置' };
  if (signal && signal.aborted) return { ok: false, error: '已取消' };
  const url = `${config.api}by_id?id=${encodeURIComponent(id)}`;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let needLogin = false;
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctl.signal, redirect: 'error', cache: 'no-store' });
    if (res && (res.status === 401 || res.status === 403)) {
      needLogin = true;
    } else if (!res || !res.ok) {
      return { ok: false, error: `内源返回 HTTP ${res && res.status}` };
    } else {
      const rawText = String(await res.text());
      if (rawText.length > 256 * 1024) return { ok: false, error: '黑板响应过大' };
      let json;
      try { json = JSON.parse(rawText); } catch { return { ok: false, error: '黑板响应不是 JSON' }; }
      const code = json && String(json.code);
      if (code === '401' || code === '403') {
        needLogin = true;
      } else {
        const data = json && json.data;
        if (code !== '0' || !data) return { ok: false, error: '黑板发布不可用' };
        if (String(data.version || '').trim() !== BOARD_RELEASE_NAME) return { ok: false, error: '黑板发布名称不匹配' };
        return parseBoardDescription(data.description);
      }
    }
  } catch (e) {
    return { ok: false, error: ctl.signal.aborted ? '读取内源黑板超时或已取消' : `读取内源黑板失败：${e && e.message ? e.message : e}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (needLogin && typeof readViaLogin === 'function' && !(signal && signal.aborted)) {
    const loginRes = await readViaLogin({ releaseId: id, signal });
    if (!loginRes || !loginRes.ok) return { ok: false, error: (loginRes && loginRes.error) || '内源要求登录' };
    return parseBoardDescription(loginRes.description);
  }
  return { ok: false, error: '内源要求登录' };
}

module.exports = {
  BOARD_RELEASE_NAME,
  BOARD_MARK,
  BOARD_HEAD,
  MAX_BOARD_DESC_BYTES,
  cleanBoardReleaseId,
  sanitizeBoardSnapshot,
  boardSignature,
  serializeBoard,
  parseBoardDescription,
  readBlackboard,
};
