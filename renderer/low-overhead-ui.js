'use strict';
// 低开销模式的界面侧（2026-11-23 P1 v2，与主干「资源与后台」同一个总开关）：
//   - 一个共享状态（内存面板顶部、状态条「省」徽章、终端、后台刷新、启动中心都读它），
//     真值来自主进程 low-overhead:state / low-overhead:changed（optional-features.json）；
//   - 内存面板顶部横条的 HTML；「资源与后台」页顶行的保活下拉复用 keepAliveSelectHtml；
//   - L5 终端回滚/光标、L6 后台刷新放慢的渲染端落地。
// 默认关闭；关闭且从没开过时，这里的函数都不碰终端和定时器（零回归）。

const policy = require('../core/low-overhead-policy');
const { iconHintHtml } = require('./launch-field-hint');

function createLowOverheadStore({ invoke, subscribe } = {}) {
  let state = policy.normalizeState(null);
  let hint = policy.strategyHint();
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn({ ...state }); } catch (error) { console.warn('[low-overhead] listener failed:', error && error.message); } } };
  function accept(next) {
    if (!next || typeof next !== 'object') return false;
    const normalized = policy.normalizeState(next);
    if (typeof next.hint === 'string' && next.hint) hint = next.hint;
    const changed = normalized.on !== state.on || normalized.keepAlive !== state.keepAlive;
    state = normalized;
    if (changed) emit();
    return changed;
  }
  subscribe?.(payload => accept(payload));
  return {
    get: () => ({ ...state }),
    hint: () => hint,
    isEnabled: () => state.on === true,
    async refresh() {
      try { const r = await invoke('low-overhead:state'); if (r && r.ok !== false) accept(r); } catch { /* 读不到保持当前值；主进程页面加载完会再推一次 */ }
      return { ...state };
    },
    // patch：{ on } 切模式（含后台可选功能批量开关）或 { keepAlive } 只改保活数。
    // 返回 { ok, partial, message }：partial 时模式没切成，界面按真值回滚并如实显示原因。
    async set(patch) {
      const result = await invoke('low-overhead:set', patch);
      if (result && (result.lowOverhead || result.ok)) accept(result.lowOverhead || result);
      return result;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _accept: accept,
  };
}

// ── 内存面板顶部横条 ──────────────────────────────────────────────────
function keepAliveSelectHtml(state, attr) {
  const keep = policy.normalizeState(state).keepAlive;
  return `<select class="lo-keepalive" ${attr} aria-label="保活会话数">${policy.KEEP_ALIVE_CHOICES
    .map(n => `<option value="${n}"${n === keep ? ' selected' : ''}>${n} 个</option>`).join('')}</select>`;
}

function panelRowHtml(state) {
  const on = policy.normalizeState(state).on;
  return `<div class="mr-lowoverhead${on ? ' on' : ''}" data-mr-lowoverhead="true">`
    + `<label class="lo-switch"><input type="checkbox" data-mr-lo-toggle="true"${on ? ' checked' : ''}><span class="lo-track" aria-hidden="true"></span><span class="lo-label">低开销模式</span></label>`
    + iconHintHtml(policy.strategyHint())
    + (on ? `<span class="lo-keep"><span>保活会话数</span>${keepAliveSelectHtml(state, 'data-mr-lo-keep="true"')}</span>` : '')
    + '</div>';
}

// ── 状态条「省」徽章：只在开启时出现 ─────────────────────────────────
function stripBadgeHtml(state) {
  if (!policy.normalizeState(state).on) return '';
  return '<span class="strip-low-overhead" role="button" tabindex="0" title="低开销模式已开启，点击管理" aria-label="低开销模式已开启，点击管理">省</span>';
}

// ── L5：终端回滚与光标 ───────────────────────────────────────────────
// 新建终端的初值：关闭时就是原来的 { scrollback: 10000, cursorBlink: true }。
const initialTerminalOptions = state => policy.terminalOptions(state, { active: true });

// entries：[[sessionId, { terminal }]]；isActive(sessionId) → 当前可见的终端。
// 关闭且从没开过：什么都不改。开过之后关掉：恢复 10000 行与光标闪烁。
function createTerminalTuner() {
  let touched = false;
  function apply(entries, state, isActive = () => true) {
    const on = policy.normalizeState(state).on;
    if (!on && !touched) return 0;
    touched = true;
    let changed = 0;
    for (const [sessionId, entry] of entries) {
      const terminal = entry && entry.terminal;
      if (!terminal || !terminal.options) continue;
      const want = policy.terminalOptions(state, { active: !!isActive(sessionId) });
      if (terminal.options.scrollback !== want.scrollback) { terminal.options.scrollback = want.scrollback; changed++; }
      if (terminal.options.cursorBlink !== want.cursorBlink) { terminal.options.cursorBlink = want.cursorBlink; changed++; }
    }
    if (!on) touched = false;
    return changed;
  }
  return { apply, touched: () => touched };
}

// ── L6：可按模式放慢的周期刷新 ───────────────────────────────────────
// 正常模式下就是 setInterval(fn, baseMs)；切换模式时 reset() 用新间隔重排。
function createAdaptiveInterval(fn, baseMs, getState, { setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let timer = null;
  let currentMs = 0;
  function start() {
    const ms = policy.backgroundIntervalMs(baseMs, getState());
    if (timer && ms === currentMs) return currentMs;
    if (timer) clearIntervalFn(timer);
    currentMs = ms;
    timer = setIntervalFn(fn, ms);
    return currentMs;
  }
  return { start, reset: start, stop: () => { if (timer) clearIntervalFn(timer); timer = null; }, intervalMs: () => currentMs };
}

module.exports = {
  createLowOverheadStore,
  keepAliveSelectHtml,
  panelRowHtml,
  stripBadgeHtml,
  createTerminalTuner,
  initialTerminalOptions,
  createAdaptiveInterval,
};
