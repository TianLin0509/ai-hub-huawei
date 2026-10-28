/* 「进展」视图（2026-10-27，取代原「开发」看板入口）。
 *
 * 长任务的 Agent 在进展卡第一块写「## 给用户看」白话（状态 / 一句话 / 进度 / 新发现 / 等你拍板），
 * 主进程 main/progress-card-service.js 找卡、读卡、久未更新时代写，推 progress-cards:changed 过来。这里画三处：
 *   ① 左侧栏「进展」页：所有带进展卡的会话按「需要你做什么」分四列；
 *   ② 会话顶部进展条（只在卡片视图）：一行现状，点开看详情；等你拍板时变橙，「按推荐回复」只填输入框、不发送；
 *   ③ 会话列表行的状态点 / 待拍板标签（session-list-renderer.js 调 window.__progressBadgeFor）。
 * 交互原型：D:\AIWork\20261027-hub-progress-card\20261027-Hub进展卡片-原型-claude.html（v2，用户 2026-10-27 确认）。 */
(function () {
  'use strict';
  const { ipcRenderer, shell } = require('electron');
  const cards = new Map();                 // sessionId → 主进程推来的条目
  let root = null, opened = false, strip = null, stripOpen = new Set(), shownFor = null, lastKey = '';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分前` : `${Math.floor(m / 1440)} 天前`;
  }
  const minutes = ms => Math.max(0, Math.round((Date.now() - ms) / 60000));
  function activeId() { try { return typeof activeSessionId !== 'undefined' ? activeSessionId : null; } catch { return null; } }  // renderer.js 的全局
  function statusOf(c) {
    if (c.plain && c.plain.decision) return { cls: 'decide', label: '待拍板' };
    if (c.stale) return { cls: 'stale', label: '久未更新' };
    const s = c.plain && c.plain.status;
    return s ? { cls: { 顺利: 'ok', 有风险: 'risk', 卡住: 'stuck', 已完成: 'done' }[s], label: s } : { cls: 'unknown', label: '未写白话' };
  }
  // 一句话现状：Agent 写的优先；久未更新或没写白话块时用代写，并标出来。
  function lineOf(c) {
    const own = c.plain && c.plain.line;
    if (c.ghost && (c.stale || !own)) return { text: c.ghost.line, ghost: true };
    return { text: own || c.cardTitle || '这张进展卡还没有「给用户看」白话块', ghost: false };
  }
  const countText = c => (c.total ? `${c.done ?? 0}/${c.total}` : '');
  const whenText = c => c.stale ? `已 ${minutes(c.mtimeMs)} 分钟没更新` : `更新于 ${ago(c.mtimeMs)}`;

  // ③ 会话行：标题前一个状态点；待拍板时换成橙色小标签。悬停标题能看到白话现状。
  window.__progressBadgeFor = function (sessionId) {
    const c = cards.get(sessionId);
    if (!c) return null;
    const st = statusOf(c), line = lineOf(c);
    const tip = `进展：${st.label} · ${line.ghost ? '［系统代写］' : ''}${line.text}${c.plain && c.plain.decision ? ` · 等你拍板：${c.plain.decision.question}` : ''} · ${whenText(c)}`;
    const html = st.cls === 'decide'
      ? `<span class="pg-row-ask" title="${esc(tip)}">待拍板</span>`
      : `<span class="pg-row-dot pg-${st.cls}" title="${esc(tip)}"></span>`;
    return { html, tip };
  };

  // ② 顶部进展条
  function ensureStrip() {
    if (strip && strip.isConnected) return strip;
    strip = document.getElementById('session-progress-strip');
    if (!strip) return null;
    strip.addEventListener('click', onStripClick);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => syncStripHeight()).observe(strip);
    }
    return strip;
  }
  function syncStripHeight() {
    const panel = document.getElementById('terminal-panel');
    if (panel && strip) panel.style.setProperty('--progress-strip-h', `${strip.hidden ? 0 : strip.offsetHeight}px`);
  }
  function stripHtml(c) {
    const st = statusOf(c), line = lineOf(c), open = stripOpen.has(c.sessionId), d = c.plain && c.plain.decision;
    const pct = c.total ? Math.round(100 * (c.done || 0) / c.total) : 0;
    const head = `<div class="pg-bar" data-pg-action="toggle" role="button" tabindex="0" aria-expanded="${open}">
        <span class="pg-caret">${open ? '▾' : '▸'}</span>
        ${st.cls === 'decide' ? '<span class="pg-ask">待你拍板</span>' : `<span class="pg-chip"><i class="pg-dot pg-${st.cls}"></i>${esc(st.label)}</span>`}
        <span class="pg-line">${line.ghost ? '<b class="pg-ghost-tag">［系统代写］</b>' : ''}${esc(d ? d.question : line.text)}</span>
        ${c.total ? `<span class="pg-prog"><span class="pg-track"><span class="pg-fill" style="width:${pct}%"></span></span>${esc(countText(c))}</span>` : ''}
        <span class="pg-when${c.stale ? ' pg-late' : ''}">${esc(whenText(c))}</span></div>`;
    if (!open) return head;
    const rows = [['目标', c.goal], ['现状', c.plain && c.plain.line], ['进度', c.plain && c.plain.progress], ['新发现', c.plain && c.plain.finding]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    const ghost = line.ghost ? `<div class="pg-ghost">Agent 已 ${minutes(c.mtimeMs)} 分钟没更新进展卡。上面这句是 Hub 用低档模型读进展卡和最近的对话代写的，可能不准；Agent 下次更新卡后自动换回它写的版本。</div>` : '';
    const decide = d ? `<div class="pg-decide-box"><div class="pg-q">等你拍板：${esc(d.question)}</div>${d.recommendation ? `<div>推荐：${esc(d.recommendation)}</div>` : ''}
        <div class="pg-acts">${d.recommendation ? '<button type="button" class="pg-btn pg-pri" data-pg-action="reply-rec">按推荐回复</button>' : ''}<button type="button" class="pg-btn" data-pg-action="reply-own">我自己回复</button></div></div>` : '';
    return `${head}<div class="pg-detail">${ghost}<dl>${rows || '<dt>现状</dt><dd>这张进展卡还没有「给用户看」白话块。</dd>'}</dl>${decide}
      <div class="pg-links"><button type="button" class="pg-link" data-pg-action="open-card">打开进展卡</button><button type="button" class="pg-link" data-pg-action="open-folder">打开所在文件夹</button><span class="pg-path">${esc(c.cardPath)}</span></div></div>`;
  }
  function renderStrip(force = false) {
    const el = ensureStrip();
    if (!el) return;
    const id = activeId(), c = id && cards.get(id);
    const html = c ? stripHtml(c) : '';
    if (!force && shownFor === id && el._html === html) return;
    shownFor = id; el._html = html;
    el.classList.toggle('pg-asking', Boolean(c && c.plain && c.plain.decision));
    el.innerHTML = html;
    el.hidden = !c;
    syncStripHeight();
  }
  function fillComposer(sessionId, text) {
    const box = document.querySelector(`.floating-input-bar[data-session-id="${CSS.escape(sessionId)}"] .floating-input-box`);
    if (!box) return false;
    box.textContent = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(box); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
    return true;
  }
  function onStripClick(e) {
    const btn = e.target.closest('[data-pg-action]');
    const id = shownFor, c = id && cards.get(id);
    if (!btn || !c) return;
    const a = btn.dataset.pgAction, d = c.plain && c.plain.decision;
    if (a === 'toggle') { stripOpen.has(id) ? stripOpen.delete(id) : stripOpen.add(id); renderStrip(true); }
    else if (a === 'reply-rec' && d) fillComposer(id, `按推荐：${d.recommendation}`);
    else if (a === 'reply-own') fillComposer(id, d ? `关于「${d.question}」：` : '');
    else if (a === 'open-card') void shell.openPath(c.cardPath);
    else if (a === 'open-folder') shell.showItemInFolder(c.cardPath);
  }

  // ① 「进展」页
  const GROUPS = [
    { key: 'decide', title: '待你拍板', cls: 'decide' },
    { key: 'risk', title: '有风险 / 卡住 / 久未更新', cls: 'risk' },
    { key: 'ok', title: '进行中', cls: 'ok' },
    { key: 'done', title: '已完成，待验收', cls: 'done' },
  ];
  const groupOf = c => (c.group === 'unknown' ? 'ok' : c.group);
  function build() {
    if (root) return true;
    root = document.getElementById('progress-panel');
    if (!root) return false;
    root.innerHTML = `<header class="pg-head"><h2>进展</h2><p id="pg-subtitle"></p></header><div class="pg-cols" id="pg-cols"></div>`;
    root.addEventListener('click', e => {
      const card = e.target.closest('[data-pg-session]');
      if (!card) return;
      const id = card.dataset.pgSession;
      stripOpen.add(id);
      setPanelVisible(false);
      if (typeof selectSession === 'function') void Promise.resolve(selectSession(id, { forceScrollBottom: true })).then(() => renderStrip(true));
    });
    return true;
  }
  function boardCard(c) {
    const line = lineOf(c), d = c.plain && c.plain.decision;
    return `<div class="pg-card" data-pg-session="${esc(c.sessionId)}" role="button" tabindex="0">
      <div class="pg-ct">${esc(c.title || c.cardTitle || '未命名会话')}</div>
      <div class="pg-cl">${line.ghost ? '<b class="pg-ghost-tag">［系统代写］</b>' : ''}${esc(line.text)}</div>
      ${d ? `<div class="pg-cq">${esc(d.question)}${d.recommendation ? `<br>推荐：${esc(d.recommendation)}` : ''}</div>` : ''}
      <div class="pg-cm"><span>${esc([countText(c), c.running ? '运行中' : '未运行'].filter(Boolean).join(' · '))}</span><span class="${c.stale ? 'pg-late' : ''}">${esc(c.stale ? whenText(c) : ago(c.mtimeMs))}</span></div></div>`;
  }
  function renderBoard() {
    if (!opened || !build()) return;
    const all = [...cards.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const by = k => all.filter(c => groupOf(c) === k);
    const ask = by('decide').length, risk = by('risk').length;
    root.querySelector('#pg-subtitle').textContent = all.length
      ? `${all.length} 个会话在维护进展卡 · ${ask} 件等你拍板 · ${risk} 个有风险或久未更新。每张卡是 Agent 最近写的白话；点卡片进入会话。`
      : '还没有会话在维护进展卡。连续跑 30 分钟以上的任务，Agent 会在任务目录建一张进展卡，这里就会出现。';
    root.querySelector('#pg-cols').innerHTML = GROUPS.map(g => {
      const xs = by(g.key);
      return `<section class="pg-col" data-pg-group="${g.key}"><h3><i class="pg-dot pg-${g.cls}"></i>${esc(g.title)}（${xs.length}）</h3>${xs.map(boardCard).join('') || '<div class="pg-empty">暂无</div>'}</section>`;
    }).join('');
  }
  function setNavCount() {
    const nav = document.getElementById('btn-progress');
    if (!nav) return;
    const n = [...cards.values()].filter(c => c.plain && c.plain.decision).length;
    let b = nav.querySelector('.pg-nav-count');
    if (!b) { b = document.createElement('b'); b.className = 'pg-nav-count'; nav.appendChild(b); }
    b.textContent = n ? String(n) : ''; b.hidden = !n;
    nav.title = n ? `进展 · ${n} 件等你拍板` : '进展 · 各长任务的白话进展';
  }
  function setPanelVisible(visible) {
    if (!build()) return;
    opened = visible;
    root.style.display = visible ? 'flex' : 'none';
    const nav = document.getElementById('btn-progress');
    nav?.classList.toggle('active', visible);
    if (nav) { if (visible) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
    if (visible) {
      const home = document.getElementById('btn-home'); home?.classList.remove('active'); home?.removeAttribute('aria-current');
      window.__xresearchHide?.(); window.__studyHide?.(); window.__writingHide?.(); window.__rulesHide?.();
      for (const id of ['terminal-panel', 'meeting-room-panel']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
      void refresh();
      renderBoard();
    }
  }

  function accept(list) {
    const next = new Map();
    for (const c of Array.isArray(list) ? list : []) if (c && typeof c.sessionId === 'string') next.set(c.sessionId, c);
    cards.clear(); for (const [k, v] of next) cards.set(k, v);
    const key = JSON.stringify([...cards.values()].map(c => [c.sessionId, c.mtimeMs, c.group, c.stale, c.ghost && c.ghost.at, c.title]));
    if (key !== lastKey) { lastKey = key; if (typeof scheduleSessionListRender === 'function') scheduleSessionListRender(); }
    setNavCount(); renderStrip(); renderBoard();
  }
  async function refresh() {
    try { const r = await ipcRenderer.invoke('progress-cards:get'); if (r && r.ok) accept(r.cards); } catch (e) { console.warn('[progress-view] 读取失败：', e && e.message); }
  }

  ipcRenderer.on('progress-cards:changed', (_e, p) => accept(p && p.cards));
  // 其他页面靠这几个名字互相关闭；「开发」页撤掉后，旧名字指向「进展」页，调用方不用逐个改。
  window.__progressHide = () => { if (opened) setPanelVisible(false); };
  window.__progressShow = () => setPanelVisible(true);
  window.__ranHide = window.__progressHide; window.__devBoardHide = window.__progressHide;
  window.__ranShow = window.__progressShow; window.__devBoardShow = window.__progressShow;

  function init() {
    build(); ensureStrip();
    document.querySelectorAll('#btn-progress,[data-progress-entry]').forEach(b => b.addEventListener('click', () => setPanelVisible(true)));
    void refresh();
    // 把界面上判断为「在跑」的会话报给主进程（代写只对在跑的会话做）。和会话列表绿圈用同一个判断。
    const { getSessionRuntimeTruth } = require('../core/session-runtime-truth.js');
    let lastRunning = '', lastSentAt = 0;
    setInterval(() => {
      let ids = [];
      try { if (typeof sessions !== 'undefined') ids = [...sessions.values()].filter(s => getSessionRuntimeTruth(s, { now: Date.now() }).state === 'running').map(s => s.id).sort(); } catch {}
      const key = ids.join(',');
      if (key !== lastRunning || Date.now() - lastSentAt > 10000) { lastRunning = key; lastSentAt = Date.now(); ipcRenderer.send('progress-cards:running', ids); }
    }, 3000);
    // 切换会话、相对时间刷新：每秒只比较一次当前会话，有变化才重画。
    setInterval(() => { if (activeId() !== shownFor) renderStrip(); }, 500);
    // 「几分钟前」每 30 秒刷新一次；正在进展条里点按、选字时跳过，免得丢焦点和选区。
    setInterval(() => {
      const sel = window.getSelection(), anchor = sel && sel.anchorNode;
      const busy = strip && (strip.contains(document.activeElement) || (anchor && strip.contains(anchor) && !sel.isCollapsed));
      if (!busy) renderStrip(true);
      renderBoard();
    }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
