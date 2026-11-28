'use strict';
// 顶部常驻概览条（来源 de959e5e，只借界面）：工具栏里一行数字，切到任何会话、任何页面都在，
// 不用点开就知道几个会话在等你、几个疑似卡住。
// - 数据直接用「在跑一览」那一份（主进程 core/running-overview.js，running-overview:get），不经过模型，和弹窗里的数字一致。
// - 只放数字，不做跳转列表：点任何一段打开「在跑一览」弹窗；逐个看答完的会话仍走侧栏「待你看」与 Ctrl+J，
//   所以这里不放「刚完成」，避免和「待你看」重复计数。「在跑」几乎总不为 0，只写进悬停提示，不占顶栏宽度。
//   0 的分段不画；等你和卡住都是 0 时整条不显示（入口仍是侧栏「在跑一览」）。
// - 可收起成一个带数字的小按钮（记在本机）。取数：启动时一次，之后窗口在前台时每 60 秒一次、窗口重新获得焦点时一次。
const STORE_KEY = 'hub.overviewStrip.collapsed.v1';
const REFRESH_MS = 60 * 1000;

function stripHtml(s, collapsed) {
  const c = (s && s.counts) || {};
  const waiting = c.waiting || 0, suspect = c.suspect || 0, running = c.running || 0;
  const attention = waiting + suspect;
  const tip = `在跑一览 · 在跑 ${running} 个`;
  if (collapsed && attention) {
    const dot = attention ? `<i class="ov-strip-dot${waiting ? ' hot' : ''}">${attention > 99 ? '99+' : attention}</i>` : '';
    return `<button type="button" class="ov-strip-seg ov-strip-main" data-strip-open="1" title="${tip}（概览条已收起）">一览${dot}</button>`
      + '<button type="button" class="ov-strip-fold" data-strip-fold="0" title="展开概览条" aria-label="展开概览条">›</button>';
  }
  const seg = (key, label, n, tip) => n
    ? `<button type="button" class="ov-strip-seg ov-strip-${key}" data-strip-open="1" title="${tip}">${label}<b>${n}</b></button>` : '';
  // 只画有数字的段（工具栏寸土寸金：1440 宽时每多 50px，会话标题就多被挤掉几个字）。
  const segs = seg('waiting', '等你', waiting, `${tip} · 等你：停在确认、答完等你，或进展卡在等你拍板`)
    + seg('suspect', '卡住', suspect, `${tip} · 卡住：运行异常、自报卡住、很久没输出，或进展卡与状态矛盾`);
  if (!segs) return '';
  return segs
    + '<button type="button" class="ov-strip-fold" data-strip-fold="1" title="收起概览条" aria-label="收起概览条">‹</button>';
}

function mountOverviewStrip({ document, window: win, invoke, openOverview, storage = win && win.localStorage, refreshMs = REFRESH_MS }) {
  const toolbar = document.getElementById('app-toolbar');
  if (!toolbar || document.getElementById('ov-strip')) return null;
  const el = document.createElement('div');
  el.id = 'ov-strip'; el.className = 'ov-strip'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', '概览条');
  // 放在动作区前面：工具栏本来就常驻在所有视图上方，不挤输入区。
  toolbar.insertBefore(el, document.getElementById('toolbar-actions') || null);
  let collapsed = false; try { collapsed = storage?.getItem(STORE_KEY) === '1'; } catch {}
  let last = null, html = '', inflight = null;
  function paint() {
    const next = stripHtml(last, collapsed);
    el.classList.toggle('collapsed', collapsed);
    el.classList.toggle('hot', !!(last && last.counts && last.counts.waiting));
    el.classList.toggle('loading', !last);
    el.hidden = !next;
    // 数字没变就不动页面。
    if (next !== html) { html = next; el.innerHTML = next; }
  }
  function load() {
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => invoke('running-overview:get')).then(res => {
      if (res && res.ok) { last = { counts: res.counts || {}, at: res.at }; paint(); }
    }).catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }
  el.addEventListener('click', event => {
    const fold = event.target.closest('[data-strip-fold]');
    if (fold) { collapsed = fold.dataset.stripFold === '1'; try { storage?.setItem(STORE_KEY, collapsed ? '1' : '0'); } catch {} paint(); return; }
    if (event.target.closest('[data-strip-open]')) { try { openOverview(); } catch {} void load(); }
  });
  paint();
  void load();
  const visible = () => !document.visibilityState || document.visibilityState === 'visible';
  const timer = win && typeof win.setInterval === 'function' ? win.setInterval(() => { if (visible()) void load(); }, refreshMs) : null;
  // 切回窗口时取一次，5 秒内反复切窗只取一次。
  let focusAt = 0;
  win?.addEventListener?.('focus', () => { const now = Date.now(); if (now - focusAt < 5000) return; focusAt = now; void load(); });
  return { el, paint, load, isCollapsed: () => collapsed, stop: () => timer && win.clearInterval(timer) };
}

function mountOverviewStripUi(win = typeof window !== 'undefined' ? window : null) {
  if (!win || win.__overviewStrip) return win && win.__overviewStrip;
  const { ipcRenderer } = require('electron');
  const ui = mountOverviewStrip({
    document: win.document, window: win,
    invoke: channel => ipcRenderer.invoke(channel),
    openOverview: () => win.__runningOverview?.open(),
  });
  win.__overviewStrip = ui;
  return ui;
}

module.exports = { stripHtml, mountOverviewStrip, mountOverviewStripUi, STORE_KEY, REFRESH_MS };
