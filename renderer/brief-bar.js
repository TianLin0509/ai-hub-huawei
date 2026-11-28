'use strict';
// 交卷 / 请拍板简述条（来源 b7819bfc、4651d056 的界面部分）：长任务在进展卡里写「等你拍板」或把状态改成「已完成」时，
// 窗口顶部居中出一张两行小卡（哪个页面都看得到），「打开会话」直接跳过去，你在那里回话。
// 数据：主进程进展卡快照（main/progress-card-service.js，progress-cards:get / progress-cards:changed），不经过模型。
// 和其他提醒的分工（不重复提醒）：
//   - 右下角回执 / 桌宠：每轮答完都提醒、几秒后消失。同一会话已有简述卡时，这一轮的回执不再弹（session-ready-notifier 问 covers）。
//   - 侧栏「待拍板」标签、会话顶部进展条、进展页、在跑一览、顶部概览条的「等你」数：照旧，是「去哪看」；简述条是「来了一件要你处理的事」。
//   - 组队成员的进展卡不出简述卡：成员向负责人交付，负责人汇总后在自己的卡上交卷或请拍板。
// 静音：「设置 › 桌宠与回执」里提醒选了「关」时，简述条也不显示（条目照常计算，改回后还在等的会出现）。
// 收起：点「打开会话」或 ×、你自己切到了那个会话、拍板已回复或在进展条点了「已处理」、卡又更新了，就收起；收起记录存本机。
// 「交卷」只认这次打开 Hub 之后看到的状态变化（启动时已是「已完成」的旧卡不补弹）；还在等你拍板的，启动时照样出卡。
const SHOW = 1; // 默认只展开最新一张，其余收成「还有 N 条」，少挡页面
const MAX_AGE_MS = 24 * 3600_000;
const STORE_KEY = 'hub.briefBar.dismissed.v1';
const PROGRESS_DISMISS_KEY = 'hub.progress.dismiss.v1';

const clip = (text, n) => { const chars = [...String(text || '').replace(/\s+/g, ' ').trim()]; return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join(''); };

// 一张进展卡此刻该出哪种简述卡：'decide' / 'handoff' / null。progressDismiss 是进展条「已处理」记录（按卡路径 + 修改时间）。
function kindOf(card, progressDismiss = {}) {
  if (!card || !card.plain) return null;
  const handled = progressDismiss[card.cardPath];
  if (card.plain.decision && !card.decisionAnsweredAt && !(handled && handled.decision && handled.mtimeMs === card.mtimeMs)) return 'decide';
  if (card.plain.status === '已完成') return 'handoff';
  return null;
}

// 去重键按「这件事」定，不按卡的修改时间：Agent 更新卡上别的段落不算新事，你收起后不会再弹。
// 请拍板 = 会话 + 问题 + 推荐（问题或推荐变了才算新的一件）；交卷 = 会话 + 卡 + 变成「已完成」的那一刻（离开再回来才算新的一次）。
function itemOf(card, kind, handoffAt = 0) {
  const d = card.plain.decision;
  const lines = kind === 'decide'
    ? [clip(d.question, 60), d.recommendation ? '推荐：' + clip(d.recommendation, 50) : '到会话里回复']
    : [clip(card.plain.line || card.cardTitle || '任务已完成', 60)];
  const id = kind === 'decide'
    ? `decide:${card.sessionId}:${clean(d.question)}|${clean(d.recommendation)}`
    : `handoff:${card.sessionId}:${card.cardPath}:${handoffAt}`;
  return { id, kind, sessionId: card.sessionId, title: card.title || '会话', lines, at: kind === 'decide' ? (Number(card.mtimeMs) || 0) : handoffAt };
}
const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

// 纯函数：根据新快照算出该显示的条目。prev 是上一份快照里每个会话的状态 { kind, handoffAt }：
// handoffAt = 这张卡变成「已完成」的那一刻；一直是已完成就沿用，离开后再回来才记新的一刻。
// 交卷只认这次打开 Hub 之后发生的变化（handoffAt 晚于打开时间 since）：启动时已完成的旧卡、启动后才读到的旧卡都不补弹。
function planItems({ cards = [], prev = null, dismissed = new Set(), progressDismiss = {}, isMember = () => false, now = Date.now(), since = 0 } = {}) {
  const items = [], kinds = new Map();
  for (const card of cards) {
    if (!card || !card.sessionId) continue;
    const kind = kindOf(card, progressDismiss);
    const before = prev ? prev.get(card.sessionId) : undefined;
    let handoffAt = 0;
    if (card.plain && card.plain.status === '已完成') {
      handoffAt = !prev ? 0 : before && before.handoffAt !== undefined ? before.handoffAt : (Number(card.mtimeMs) || 0);
    }
    kinds.set(card.sessionId, { kind, ...(card.plain && card.plain.status === '已完成' ? { handoffAt } : {}) });
    if (!kind || isMember(card.sessionId)) continue;
    if (kind === 'handoff' && !(handoffAt > since)) continue;
    const item = itemOf(card, kind, handoffAt);
    if (dismissed.has(item.id) || now - item.at > MAX_AGE_MS) continue;
    items.push(item);
  }
  items.sort((a, b) => b.at - a.at);
  return { items, kinds };
}

function briefHtml(item, esc) {
  const decide = item.kind === 'decide';
  const [a = '', b = ''] = item.lines;
  return `<div class="brief-card" data-brief-id="${esc(item.id)}" data-kind="${esc(item.kind)}">`
    + `<div class="brief-body"><p class="brief-head"><span class="brief-tag">${decide ? '请拍板' : '交卷'}</span><span class="brief-title" data-i18n-skip>${esc(item.title)}</span></p>`
    + `<p class="brief-line" data-i18n-skip title="${esc(a)}">${esc(a)}</p>${b ? `<p class="brief-line sub" data-i18n-skip title="${esc(b)}">${esc(b)}</p>` : ''}</div>`
    + `<div class="brief-acts"><button type="button" class="brief-open" data-brief-open="${esc(item.sessionId)}">打开会话</button>`
    + `<button type="button" class="brief-x" data-brief-close="${esc(item.id)}" aria-label="收起" title="收起">×</button></div></div>`;
}

function createBriefBar({ document, storage, openSession = async () => {}, getActiveSessionId = () => null, getVisibleSessionIds = null, isMember = () => false, isMuted = () => false, now = () => Date.now() }) {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let dismissed = new Set();
  try { dismissed = new Set(JSON.parse(storage?.getItem(STORE_KEY) || '[]')); } catch {}
  let items = [], prev = null, bar = null, expanded = false, html = '', lastCards = [];
  const since = now();
  const progressDismiss = () => { try { return JSON.parse(storage?.getItem(PROGRESS_DISMISS_KEY) || '{}') || {}; } catch { return {}; } };
  function dismiss(ids) {
    for (const id of ids) dismissed.add(id);
    const list = [...dismissed].slice(-300); dismissed = new Set(list);
    try { storage?.setItem(STORE_KEY, JSON.stringify(list)); } catch {}
    items = items.filter(x => !ids.includes(x.id)); paint();
  }
  function accept(cards) {
    lastCards = Array.isArray(cards) ? cards : [];
    const plan = planItems({ cards: lastCards, prev, dismissed, progressDismiss: progressDismiss(), isMember, now: now(), since });
    // 交卷留到你处理（卡一直是已完成，handoffAt 不变，条目就一直在）；拍板跟着卡走，回复或标了已处理就消失。
    items = plan.items;
    prev = plan.kinds;
    syncActive();
    paint();
  }
  function paint() {
    if (!items.length || isMuted()) { if (bar) { bar.remove(); bar = null; html = ''; } return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'brief-bar'; bar.id = 'brief-bar'; bar.setAttribute('role', 'status'); bar.addEventListener('click', onClick); document.body.append(bar); }
    const shown = expanded ? items : items.slice(0, SHOW), more = items.length - shown.length;
    const next = shown.map(x => briefHtml(x, esc)).join('')
      + (items.length > 1 ? `<div class="brief-foot">${more ? `<button type="button" data-brief-more>还有 ${more} 条</button>` : ''}<button type="button" data-brief-all>全部收起</button></div>` : '');
    if (next !== html) { html = next; bar.innerHTML = next; }
  }
  async function onClick(event) {
    const open = event.target.closest('[data-brief-open]');
    if (open) {
      const sid = open.dataset.briefOpen;
      try { await openSession(sid); } catch {}
      dismiss(items.filter(x => x.sessionId === sid).map(x => x.id));
      return;
    }
    const x = event.target.closest('[data-brief-close]');
    if (x) { dismiss([x.dataset.briefClose]); return; }
    if (event.target.closest('[data-brief-more]')) { expanded = true; paint(); return; }
    if (event.target.closest('[data-brief-all]')) { expanded = false; dismiss(items.map(i => i.id)); }
  }
  // 你自己切到了那个会话：对应简述已经看到了，收起。
  function syncActive() {
    const seen = new Set(typeof getVisibleSessionIds === 'function' ? getVisibleSessionIds() : [getActiveSessionId()].filter(Boolean));
    const hit = items.filter(x => seen.has(x.sessionId)).map(x => x.id);
    if (hit.length) dismiss(hit);
  }
  // 静音时不算「已有简述卡」：回执那边同样按用户的提醒设置处理，不会因为这里而少提醒。
  return { accept, syncActive, paint, covers: sid => !isMuted() && items.some(x => x.sessionId === sid), items: () => items.slice(), el: () => bar };
}

function mountBriefBar(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__briefBar) return win && win.__briefBar;
  const { ipcRenderer } = require('electron');
  /* global selectSession, activeSessionId, sessions, meetings */
  // 用户的提醒设置（hub-pet:get-settings 的 notifyMode）：启动时读一次，之后窗口重新获得焦点、或有新卡要显示且距上次读超过 10 秒时再读。
  let muted = false, mutedAt = 0, ui = null;
  const readMute = () => {
    mutedAt = Date.now();
    return ipcRenderer.invoke('hub-pet:get-settings').then(r => {
      const next = r?.settings?.notifyMode === 'off';
      if (next !== muted) { muted = next; ui?.paint(); }
    }).catch(() => {});
  };
  ui = createBriefBar({
    document: win.document, storage: win.localStorage, isMuted: () => muted,
    // 从进展页点「打开会话」时先收起进展页，和进展页自己跳会话的做法一致。
    openSession: id => { try { win.__progressHide?.(); } catch {} return typeof selectSession === 'function' ? selectSession(id, { forceScrollBottom: true }) : null; },
    // 你正在看的会话：停在主页、PPT、进展、WeLink 等应用页时不算在看任何会话（activeSessionId 不会清空）；分屏时左右两屏都算。
    getActiveSessionId: () => {
      try {
        if (win.__hubPageOpen?.() || (typeof currentAppToolbarView === 'function' && currentAppToolbarView())) return null;
        return activeSessionId || null;
      } catch { return null; }
    },
    getVisibleSessionIds: () => {
      try {
        if (win.__hubPageOpen?.() || (typeof currentAppToolbarView === 'function' && currentAppToolbarView())) return [];
        const ids = new Set([activeSessionId]);
        try { const f = sessionSplit?.focusedId?.(); if (f) ids.add(f); } catch {}
        return [...ids].filter(Boolean);
      } catch { return []; }
    },
    isMember: id => { try { return sessions.get(id)?.hubTeamMember === true || !!(win.__teamUi?.memberInfo?.(id) || win.__teamUi?.leadOf?.(id, sessions, typeof meetings !== 'undefined' ? meetings : {})); } catch { return false; } },
  });
  win.__briefBar = ui;
  ipcRenderer.on('progress-cards:changed', (_e, p) => { if (Date.now() - mutedAt > 10_000) void readMute(); ui.accept(p && p.cards); });
  void readMute();
  win.addEventListener?.('focus', () => { void readMute(); });
  void ipcRenderer.invoke('progress-cards:get').then(r => { if (r && r.ok) ui.accept(r.cards); }).catch(() => {});
  // 切会话时顶栏面包屑会重画：借它知道你切到了哪个会话。
  const crumb = win.document.getElementById('toolbar-crumb');
  if (crumb && typeof win.MutationObserver === 'function') new win.MutationObserver(() => ui.syncActive()).observe(crumb, { childList: true });
  return ui;
}

module.exports = { createBriefBar, mountBriefBar, planItems, kindOf, briefHtml, STORE_KEY };
