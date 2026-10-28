'use strict';
// AI 网页会话的界面（2026-10-25）：启动中心「AI 网页」页、侧栏「网页」分组、主区网页面板。
// 网页本身是主进程放在窗口上的原生视图（main/web-sessions.js），这里只摆一个占位框告诉主进程放在哪；
// 占位框被 Hub 的弹窗或别的页面盖住时，把原生视图收起来，免得网页压在弹窗上面。
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_TEXT = { dormant: '休眠', loading: '加载中', ready: '就绪', running: '回答中', error: '出错' };
const ICON = {
  back: '<path d="m15 18-6-6 6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function logoHtml(item) {
  if (item.logo) return `<span class="ai-logo logo-${esc(item.logo)} ws-logo"></span>`;
  return `<span class="ws-logo ws-logo-text">${esc(String(item.siteName || item.name || '?').slice(0, 1))}</span>`;
}

function relTime(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return Math.floor(d / 86400e3) + ' 天前';
}

function createWebSessionsUi({ document, window, ipcRenderer, beforeShow = () => {}, openLaunchCenter = () => {}, closeLaunchCenter = () => {}, showToast = () => {} }) {
  let data = { items: [], sites: [], identities: { main: '主', alt: '副' }, shownId: null };
  let panelError = '';
  let shownId = null, identity = 'main', occluded = false, occludeStreak = 0, watch = null, editingId = null;
  const listEl = document.getElementById('web-session-list');
  const launchHost = document.getElementById('launch-center-web-host');
  const rangeButton = document.querySelector('[data-session-days="web"]');
  try { identity = window.localStorage.getItem('hubWebSessionIdentity') === 'alt' ? 'alt' : 'main'; } catch {}

  async function call(channel, payload) {
    const result = await ipcRenderer.invoke(channel, payload);
    if (!result || result.ok === false) throw new Error(result?.error || '没有收到结果，请重试');
    return result;
  }
  const report = e => showToast(e?.message || String(e));

  // ── 主区面板 ──
  const panel = document.createElement('section');
  panel.id = 'web-session-panel'; panel.className = 'web-session-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'AI 网页');
  panel.innerHTML = `<header class="ws-bar"><div class="ws-who"></div><div class="ws-tools">
      <button type="button" data-ws-nav="back" title="后退">${svg('back')}</button>
      <button type="button" data-ws-nav="reload" title="刷新">${svg('reload')}</button>
      <button type="button" data-ws-nav="home" title="回到首页（新对话）">${svg('home')}</button>
      <button type="button" data-ws-nav="external" title="在系统浏览器中打开当前页">${svg('external')}</button>
      <button type="button" data-ws-act="suspend" title="休眠：释放内存，登录保留，点侧栏可唤醒">${svg('sleep')}</button>
      <button type="button" data-ws-act="close" title="关闭这个网页会话">${svg('close')}</button>
    </div></header>
    <div class="ws-status" role="status" hidden></div>
    <div class="ws-slot"></div>`;
  document.body.append(panel);
  const slot = panel.querySelector('.ws-slot');
  const statusEl = panel.querySelector('.ws-status');

  function rect() {
    const r = slot.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function place() {
    if (panel.hidden) return;
    const host = document.getElementById('terminal-panel');
    const r = host && host.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) Object.assign(panel.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    else {
      const bar = document.getElementById('app-toolbar'), side = document.getElementById('sidebar');
      const left = side ? side.getBoundingClientRect().right : 0, top = bar ? bar.getBoundingClientRect().bottom : 0;
      Object.assign(panel.style, { left: left + 'px', top: top + 'px', width: (window.innerWidth - left) + 'px', height: (window.innerHeight - top) + 'px' });
    }
  }
  function syncBounds() {
    if (panel.hidden || !shownId) return;
    place();
    const b = rect();
    if (b) void call('web-sessions:bounds', { bounds: b }).catch(() => {});
  }
  // 占位框中心点不是自己 = 被 Hub 的弹窗、菜单或其他页面盖住了：收起原生网页，露出上面的东西。
  function checkOcclusion() {
    if (panel.hidden || !shownId) return;
    const b = slot.getBoundingClientRect();
    const points = [[b.left + b.width / 2, b.top + b.height / 2], [b.left + 24, b.top + 24], [b.right - 24, b.top + 24]];
    const covered = document.hidden || points.some(([x, y]) => { const el = document.elementFromPoint(x, y); return !el || !slot.contains(el); });
    occludeStreak = covered ? occludeStreak + 1 : 0;
    const next = covered && (occluded || occludeStreak >= 1);
    if (next !== occluded) { occluded = next; void call('web-sessions:visible', { visible: !occluded }).catch(() => {}); if (!occluded) syncBounds(); }
  }
  const observer = window.ResizeObserver ? new window.ResizeObserver(() => syncBounds()) : null;

  async function open(id) {
    const item = data.items.find(i => i.id === id);
    if (!item) { report(new Error('这个网页会话已不存在')); return; }
    try { beforeShow(); } catch (e) { console.warn('[web-sessions] 关闭其他视图失败：', e.message); }
    shownId = id; occluded = false; occludeStreak = 0; panelError = '';
    panel.hidden = false;
    document.body.classList.add('web-session-open');
    place(); paintPanel(); paintList();
    window.__webSessionAfterShow?.();
    const host = document.getElementById('terminal-panel');
    if (observer && host) { observer.disconnect(); observer.observe(host); observer.observe(slot); }
    clearInterval(watch); watch = setInterval(checkOcclusion, 300);
    // 等布局落定再取占位框位置。
    await new Promise(r => window.requestAnimationFrame(() => window.requestAnimationFrame(r)));
    place();
    try { accept(await call('web-sessions:show', { id, bounds: rect() || { x: 0, y: 0, width: 1, height: 1 } })); }
    catch (e) { panelError = e.message; paintPanel(); return; }
    panelError = '';
    syncBounds();
  }
  function hidePanel({ notify = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true; shownId = null; occluded = false;
    document.body.classList.remove('web-session-open');
    clearInterval(watch); watch = null; observer?.disconnect();
    if (notify) void call('web-sessions:hide').catch(() => {});
    paintList();
  }
  function paintPanel() {
    const item = data.items.find(i => i.id === shownId);
    if (!item) return;
    panel.querySelector('.ws-who').innerHTML = `${logoHtml(item)}<strong>${esc(item.displayTitle)}</strong><span>${esc(item.siteName)} · ${esc(item.identityLabel)}</span>`;
    const msg = panelError || (item.status === 'error' ? item.error : item.status === 'loading' ? '网页加载中…' : '');
    statusEl.hidden = !msg; statusEl.textContent = msg; statusEl.classList.toggle('bad', !!panelError || item.status === 'error');
    syncBounds();
  }
  panel.addEventListener('click', event => {
    const nav = event.target.closest('[data-ws-nav]'), act = event.target.closest('[data-ws-act]');
    if (!shownId) return;
    if (nav) void call('web-sessions:navigate', { id: shownId, action: nav.dataset.wsNav }).then(accept).catch(report);
    if (act?.dataset.wsAct === 'suspend') { const id = shownId; hidePanel({ notify: false }); void call('web-sessions:suspend', { id }).then(accept).catch(report); window.__webSessionAfterLeave?.(); }
    if (act?.dataset.wsAct === 'close') { const id = shownId; hidePanel({ notify: false }); void call('web-sessions:close', { id }).then(accept).catch(report); window.__webSessionAfterLeave?.(); }
  });

  // ── 侧栏 ──
  function paintList() {
    if (rangeButton) {
      const unread = data.items.filter(i => i.unread).length, running = data.items.some(i => i.status === 'running');
      rangeButton.innerHTML = '网页' + (unread ? `<span class="ws-tab-count" title="${unread} 个网页会话有新回答">${unread}</span>` : running ? '<span class="ws-tab-run" title="有网页正在回答"></span>' : '');
    }
    if (!listEl) return;
    // 正在重命名时不重画列表，免得主进程的状态推送把输入框连同已输入的字一起换掉。
    if (editingId && listEl.querySelector('.ws-rename')) return;
    const rows = data.items.map(item => {
      const sub = [item.siteName + ' · ' + item.identityLabel, STATUS_TEXT[item.status] || '', relTime(item.lastCompletedAt || item.lastActiveAt)].filter(Boolean).join(' · ');
      const title = editingId === item.id
        ? `<input class="ws-rename" value="${esc(item.customTitle || item.displayTitle)}" maxlength="80" aria-label="重命名">`
        : `<span class="ws-title">${esc(item.displayTitle)}</span>`;
      return `<div class="ws-item${item.id === shownId ? ' active' : ''}${item.status === 'dormant' ? ' dormant' : ''}" data-ws-id="${esc(item.id)}" tabindex="0" role="button" title="${esc(item.displayTitle)}&#10;${esc(sub)}${item.status === 'dormant' ? '&#10;点击唤醒' : ''}">
        ${logoHtml(item)}<span class="ws-text">${title}<span class="ws-sub">${esc(sub)}</span></span>
        <span class="ws-mark ${item.unread ? 'unread' : item.status}" aria-label="${item.unread ? '有新回答' : esc(STATUS_TEXT[item.status] || '')}"></span>
        <span class="ws-row-actions"><button type="button" data-ws-row="rename" title="重命名">✎</button><button type="button" data-ws-row="suspend" title="休眠">${svg('sleep')}</button><button type="button" data-ws-row="close" title="关闭">${svg('close')}</button></span>
      </div>`;
    }).join('');
    const ownerNote = data.owner && !data.owner.self && data.owner.otherPid
      ? `<p class="ws-owner-note">这些网页正在另一个 Hub 窗口（PID ${esc(data.owner.otherPid)}）里使用。登录信息同一时间只能由一个窗口读写，请到那个窗口打开。</p>` : '';
    listEl.innerHTML = `${ownerNote}<button type="button" class="ws-new" data-ws-new>＋ 打开 AI 网页</button>${rows || '<p class="ws-empty">还没有网页会话。点上面的按钮，选一个网站打开；第一次需要在网页里登录。</p>'}`;
    const input = listEl.querySelector('.ws-rename');
    if (input) { input.focus(); input.select(); }
  }
  function finishRename(input, save) {
    const id = editingId; editingId = null;
    if (save && id) void call('web-sessions:rename', { id, title: input.value }).then(accept).catch(report);
    else paintList();
  }
  listEl?.addEventListener('click', event => {
    if (event.target.closest('[data-ws-new]')) { openLaunchCenter('web'); return; }
    const row = event.target.closest('[data-ws-id]');
    if (!row || event.target.closest('.ws-rename')) return;
    const id = row.dataset.wsId, action = event.target.closest('[data-ws-row]')?.dataset.wsRow;
    if (action === 'rename') { editingId = id; paintList(); return; }
    if (action === 'suspend') { if (id === shownId) { hidePanel({ notify: false }); window.__webSessionAfterLeave?.(); } void call('web-sessions:suspend', { id }).then(accept).catch(report); return; }
    if (action === 'close') { if (id === shownId) { hidePanel({ notify: false }); window.__webSessionAfterLeave?.(); } void call('web-sessions:close', { id }).then(accept).catch(report); return; }
    if (id === shownId && !panel.hidden) return;
    void open(id);
  });
  listEl?.addEventListener('dblclick', event => {
    const row = event.target.closest('[data-ws-id]');
    if (row && !event.target.closest('[data-ws-row]')) { editingId = row.dataset.wsId; paintList(); }
  });
  listEl?.addEventListener('keydown', event => {
    const input = event.target.closest('.ws-rename');
    if (input) { if (event.key === 'Enter') finishRename(input, true); else if (event.key === 'Escape') finishRename(input, false); return; }
    const row = event.target.closest('[data-ws-id]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void open(row.dataset.wsId); }
  });
  listEl?.addEventListener('focusout', event => { const input = event.target.closest?.('.ws-rename'); if (input && editingId) finishRename(input, true); });

  // ── 启动中心「AI 网页」页 ──
  function paintLaunch() {
    if (!launchHost) return;
    const ids = Object.entries(data.identities || {});
    launchHost.innerHTML = `<div class="ws-identity" role="radiogroup" aria-label="登录身份"><span>身份</span>${ids.map(([k, label]) =>
      `<button type="button" role="radio" data-ws-identity="${k}" aria-checked="${k === identity}">${esc(label)}</button>`).join('')}
      <small>每个网站的「主」「副」各存一份登录，同一网站可以同时登两个号。</small></div>
      <div class="ws-site-grid">${data.sites.map(s => {
        const count = data.items.filter(i => i.site === s.key && i.identity === identity).length;
        return `<button type="button" class="ws-site" data-ws-site="${esc(s.key)}">${logoHtml({ logo: s.logo, siteName: s.name })}<span><strong>${esc(s.name)}</strong><small>${esc(new URL(s.url).hostname)}${s.account ? ' · 对应' + esc(s.account) : ''}</small></span>${count ? `<em>已开 ${count}</em>` : ''}</button>`;
      }).join('')}</div>
      <p class="ws-launch-note">首次打开需要在网页里登录一次，之后一直记住。打开后在侧栏「网页」分组里找到它；闲置 5 小时自动休眠，点一下即可唤醒。</p>`;
  }
  launchHost?.addEventListener('click', async event => {
    const idBtn = event.target.closest('[data-ws-identity]');
    if (idBtn) { identity = idBtn.dataset.wsIdentity === 'alt' ? 'alt' : 'main'; try { window.localStorage.setItem('hubWebSessionIdentity', identity); } catch {} paintLaunch(); return; }
    const site = event.target.closest('[data-ws-site]');
    if (!site || site.disabled) return;
    site.disabled = true;
    try {
      const result = await call('web-sessions:create', { site: site.dataset.wsSite, identity });
      closeLaunchCenter();
      const list = await call('web-sessions:list');
      accept(list);
      selectWebRange();
      await open(result.id);
    } catch (e) { report(e); }
    finally { site.disabled = false; }
  });
  function selectWebRange() { if (rangeButton && rangeButton.getAttribute('aria-pressed') !== 'true') rangeButton.click(); }

  // ── 主进程推送 ──
  function accept(next) {
    if (!next || !Array.isArray(next.items)) return;
    data = next;
    if (shownId && !data.items.some(i => i.id === shownId && i.status !== 'dormant')) {
      // 被关闭或休眠（包括另一处操作）：面板跟着收起。
      if (!data.items.some(i => i.id === shownId)) { hidePanel({ notify: false }); window.__webSessionAfterLeave?.(); }
    }
    paintList(); paintPanel(); paintLaunch();
  }
  ipcRenderer.on('web-sessions:changed', (_e, next) => {
    accept(next);
    const done = next?.completed;
    if (done?.notify) ipcRenderer.send('desktop-notification:show', { sessionId: 'web:' + done.id, title: done.title, body: `${done.siteName} 的回答已完成，点击查看。`, kind: '' });
  });
  ipcRenderer.on('desktop-notification:open-session', (_e, payload = {}) => {
    const id = String(payload.sessionId || '');
    if (id.startsWith('web:')) { selectWebRange(); void open(id.slice(4)); }
  });
  window.addEventListener('resize', syncBounds);
  // 界面重载（Ctrl+R 等）后主进程可能还挂着上次显示的网页：先收起，等用户再点开。
  void call('web-sessions:hide').catch(() => {});
  void call('web-sessions:list').then(accept).catch(e => console.warn('[web-sessions] 列表读取失败：', e.message));

  return { open, hidePanel, isOpen: () => !panel.hidden, state: () => data };
}

module.exports = { createWebSessionsUi };
