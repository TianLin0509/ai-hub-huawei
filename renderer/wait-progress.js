'use strict';
// 等 CodeAgent 时的统一进度写法（2026-11-06 用户：各功能都要看到「在哪一步 · 已等多少秒 · 通常多久」，
// 不靠预开会话提速）。界面里放 data-wait-since 的数字，再由 startWaitTicker 每秒只改数字、不重画。

const secondsText = ms => {
  const s = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
};

const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const toMs = at => {
  if (at == null || at === '') return NaN;
  if (typeof at === 'number') return at;
  const n = Number(at);
  return Number.isFinite(n) ? n : Date.parse(at);
};

// phase: { label, verb = '已等', from, hint }。from 缺失或非法时只显示阶段名。
function waitHtml(phase, now = Date.now()) {
  if (!phase || !phase.label) return '';
  const from = toMs(phase.from);
  const timer = Number.isFinite(from)
    ? ` · ${escapeHtml(phase.verb || '已等')} <span data-wait-since="${from}">${secondsText(now - from)}</span>` : '';
  const hint = phase.hint ? `<span class="wait-progress-hint">（${escapeHtml(phase.hint)}）</span>` : '';
  return `<span class="wait-progress">${escapeHtml(phase.label)}${timer}${hint}</span>`;
}

function waitText(phase, now = Date.now()) {
  if (!phase || !phase.label) return '';
  const from = toMs(phase.from);
  return `${phase.label}${Number.isFinite(from) ? ` · ${phase.verb || '已等'} ${secondsText(now - from)}` : ''}${phase.hint ? `（${phase.hint}）` : ''}`;
}

function tickWait(root, now = Date.now()) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let n = 0;
  root.querySelectorAll('[data-wait-since]').forEach(el => {
    const text = secondsText(now - Number(el.dataset.waitSince));
    if (el.textContent !== text) el.textContent = text;
    n += 1;
  });
  return n;
}

// 每秒刷新 getRoot() 里的计时；isActive 返回 false 时（页面隐藏、弹窗关了）跳过。返回停止函数。
function startWaitTicker(getRoot, { isActive = () => true, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const timer = setIntervalFn(() => {
    try { if (isActive()) tickWait(getRoot()); } catch { /* 界面已拆掉 */ }
  }, 1000);
  return () => clearIntervalFn(timer);
}

// 助理一问（助理页、PPT 按用途检索都走它）：排队 → CodeAgent 准备中（开会话、送入问题）→ 正在查。
function assistantChatPhase(c) {
  if (!c) return null;
  if (c.state === 'queued') return { label: '排队中', verb: '已等', from: c.askedAt, hint: '' };
  if (c.state === 'running' && !c.answeringAt) return { label: 'CodeAgent 准备中…', verb: '已等', from: c.startedAt || c.askedAt, hint: '开会话并送入问题，通常 10–20 秒' };
  if (c.state !== 'running') return null;
  return { label: '正在查…', verb: '已用', from: c.answeringAt || c.startedAt || c.askedAt,
    hint: c.startedAt && c.answeringAt ? `准备用了 ${secondsText(c.answeringAt - c.startedAt)}` : '' };
}

module.exports = { secondsText, waitHtml, waitText, tickWait, startWaitTicker, toMs, assistantChatPhase };
