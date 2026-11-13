'use strict';
// 公司版「门户」页（2026-11-13，选定版式 A「大数字 + 久拖榜」）：读公司门户首页上自己的待办、提的申请和公司要闻（core/company-w3/）。
// 每个页签一屏：上面三个大数字，下面按「拖得最久」排的清单；点一行从右侧滑出详情，「打开处理页」在浏览器里办。
// 写法同考勤页：盖在主区域上的一层，点左侧其他按钮自动关闭；默认关闭，由可选功能开关（optional-feature-gate）开启。
const TABS = [['todo', '待办'], ['apply', '申请'], ['news', '公司要闻']];
const NEWS_COLS = [['policy', '政策与讲话'], ['corporate', '公司文件'], ['bulletins', '公告']];

function createCompanyW3Page({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page = null, status = null, timer = null, gate = null, tab = 'todo', detail = null;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const two = n => String(n).padStart(2, '0');
  const when = at => { if (!at) return '—'; const d = new Date(at), t = new Date(); const c = `${two(d.getHours())}:${two(d.getMinutes())}`; return d.toDateString() === t.toDateString() ? '今天 ' + c : `${d.getMonth() + 1}/${d.getDate()} ${c}`; };
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-w3:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };
  const ageCls = a => (a == null ? '' : a >= 30 ? 'bad' : a >= 7 ? 'warn' : '');
  const ageText = a => (a == null ? '—' : a === 0 ? '今天' : a + ' 天');
  const byAge = list => [...(list || [])].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));

  function nav() {
    let btn = document.getElementById('btn-company-w3');
    if (btn) return btn;
    const anchor = document.getElementById('btn-company-attendance') || document.getElementById('btn-company-rooms') || document.getElementById('btn-company-forum') || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-w3';
    btn.title = '门户 · 自己的待办、申请和公司要闻（数据只留本机）'; btn.setAttribute('aria-label', '门户');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9.5l1.6 1.6L12.5 8M8 15.5h8M14.5 10h1.5"/></svg></span><span class="btn-label">门户</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-w3-page'; page.id = 'company-w3-page'; page.hidden = true; page.setAttribute('aria-label', '门户');
    page.innerHTML = `<header class="w3p-head">
        <div class="w3p-title"><h1>门户</h1></div>
        <div class="w3p-tabs" role="tablist" data-slot="tabs"></div>
        <div class="w3p-status" data-slot="status"></div>
        <button type="button" class="w3p-btn" data-w3="sync" title="现在打开门户首页读一次">刷新</button>
      </header>
      <div class="w3p-body" data-slot="body"></div>
      <div class="w3p-drawer" data-slot="drawer" hidden></div>`;
    document.body.append(page);
    gate = require('./optional-feature-gate').createFeatureGate({ document, window, id: 'w3', page, showMessage,
      badgeSlot: b => page.querySelector('[data-w3="sync"]').before(b), onEnabled: () => { void startData(); } });
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-w3]');
      if (b) { event.preventDefault(); void action(b.dataset.w3, b).catch(e => showMessage?.(e.message)); return; }
      if (detail && !event.target.closest('.w3p-panel')) { detail = null; renderDrawer(); }
    });
    page.addEventListener('keydown', e => { if (e.key === 'Escape' && detail) { detail = null; renderDrawer(); } });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function statusHtml() {
    const s = status;
    if (s.syncing) return '<span class="w3p-chip run">正在读取门户…</span>';
    if (s.lastResult && !s.lastResult.ok) return `<span class="w3p-chip bad" title="${esc(s.lastResult.error)}">${s.lastResult.needsLogin ? '门户需要登录' : '上次读取失败'} · ${when(s.lastResult.at)}</span>`;
    if (s.lastSuccessAt) return `<span class="w3p-chip ok">${when(s.lastSuccessAt)} 读取</span>`;
    return '<span class="w3p-chip">还没读取过</span>';
  }
  function tabsHtml() {
    const n = { todo: status?.todo?.length, apply: status?.apply?.length };
    return TABS.map(([id, name]) => `<button type="button" role="tab" data-w3="tab" data-tab="${id}" aria-selected="${tab === id}">${name}${n[id] != null && status?.lastSuccessAt ? ` <b>${n[id]}</b>` : ''}</button>`).join('');
  }
  function hero(cells) {
    return `<div class="w3p-hero">${cells.map(([v, unit, line1, line2, cls]) => `<div><div class="v ${cls || ''}">${esc(v)}${unit ? `<small>${unit}</small>` : ''}</div><div class="l">${line1}${line2 ? '<br>' + line2 : ''}</div></div>`).join('')}</div>`;
  }
  function rows(list, kind) {
    if (!list.length) return `<div class="w3p-empty">${kind === 'todo' ? '没有待办，门户上已经清空了。' : '没有在途的申请。'}</div>`;
    const max = Math.log(Math.max(30, ...list.map(x => x.ageDays || 0)) + 1);
    return `<div class="w3p-list">${list.map((x, i) => `<div class="w3p-row" data-w3="detail" data-kind="${kind}" data-i="${i}" role="button" tabindex="0">
        <span class="w3p-age ${ageCls(x.ageDays)}">${ageText(x.ageDays)}</span>
        <span class="w3p-bar"><i class="${ageCls(x.ageDays)}" style="width:${Math.max(3, Math.round(Math.log((x.ageDays || 0) + 1) / max * 100))}%"></i></span>
        <b class="w3p-app" title="${esc(x.app)}">${esc(x.app)}</b>
        <span class="w3p-t" title="${esc(x.title)}">${esc(x.title)}</span>
        <span class="w3p-m">${kind === 'todo' ? esc(x.from || '') : x.handler ? '在 ' + esc(x.handler) + ' 手上' : ''}</span>
        ${x.url ? `<button type="button" class="w3p-btn sm" data-w3="open" data-url="${esc(x.url)}">打开</button>` : '<span></span>'}
      </div>`).join('')}</div>`;
  }
  function todoHtml() {
    const list = byAge(status.todo), apply = byAge(status.apply), oldest = list[0];
    const over30 = list.filter(x => (x.ageDays ?? 0) >= 30).length, fresh = (status.added?.todo || []).length;
    const stuck = apply.filter(x => (x.ageDays ?? 0) >= 5);
    return hero([
      [list.length, '', '条待办', fresh ? `这次新来 ${fresh} 条` : '这次没有新来的'],
      [oldest ? oldest.ageDays ?? '—' : 0, '天', '最久的一条已挂', over30 ? `${over30} 条超过 30 天` : (oldest ? esc(oldest.app) : '没有待办'), ageCls(oldest?.ageDays)],
      [stuck.length, '', '条申请卡了 5 天以上', stuck[0] ? `${esc(stuck[0].app)} · ${stuck[0].ageDays} 天` : '申请都在正常流转', stuck.length ? 'warn' : ''],
    ]) + '<div class="w3p-cap">久拖榜 · 按挂的天数排</div>' + rows(list, 'todo');
  }
  function applyHtml() {
    const list = byAge(status.apply), top = list[0];
    return hero([
      [list.length, '', '条在途申请', `来自 ${new Set(list.map(x => x.app)).size} 个系统`],
      [top ? top.ageDays ?? '—' : 0, '天', '卡得最久', top ? esc(top.app) + (top.handler ? ' · 在 ' + esc(top.handler) + ' 手上' : '') : '没有在途申请', (top?.ageDays ?? 0) >= 5 ? 'warn' : ''],
      [list.filter(x => (x.ageDays ?? 0) >= 5).length, '', '条超过 5 天', '第 5 天、第 14 天各提醒一次'],
    ]) + '<div class="w3p-cap">按卡住时长排</div>' + rows(list, 'apply');
  }
  function newsHtml() {
    const cols = NEWS_COLS.map(([key, name]) => {
      const docs = (status.docs?.[key] || []).slice(0, 9);
      return `<div class="w3p-ncol"><h2>${name}<small>${(status.docs?.[key] || []).length} 篇</small></h2>${docs.length ? docs.map(d => `<a href="#" class="w3p-doc" data-w3="open" data-url="${esc(d.url)}" title="${esc(d.title)}"><span>${esc(String(d.date).slice(5, 10))}</span><em>${esc(d.title)}</em></a>`).join('') : '<div class="w3p-empty">没有读到</div>'}</div>`;
    }).join('');
    return `<div class="w3p-news">${cols}</div>`;
  }
  function emptyState() {
    const r = status.lastResult;
    if (status.syncing || !r) return '<div class="w3p-blank"><b>正在打开门户读取…</b><p>后台用无头浏览器打开门户首页，一般 10 秒左右，不会弹窗。</p></div>';
    return `<div class="w3p-blank"><b>${r.needsLogin ? '门户需要登录' : '这次没读到'}</b><p>${esc(r.error || '')}</p><p>${r.needsLogin ? '公司电脑一般会自动登录；若一直停在登录页，先在 Edge 里打开一次门户并登录，再点刷新。' : '可能是公司网络暂时打不开门户，过一会儿点刷新再试。'}</p><button type="button" class="w3p-btn primary" data-w3="sync">刷新</button></div>`;
  }
  function render() {
    if (!page || !status) return;
    page.querySelector('[data-slot="status"]').innerHTML = statusHtml();
    page.querySelector('[data-slot="tabs"]').innerHTML = tabsHtml();
    const btn = page.querySelector('[data-w3="sync"]'); if (btn) btn.disabled = !!status.syncing;
    page.querySelector('[data-slot="body"]').innerHTML = !status.lastSuccessAt ? emptyState() : tab === 'apply' ? applyHtml() : tab === 'news' ? newsHtml() : todoHtml();
    renderDrawer();
  }
  function renderDrawer() {
    const box = page?.querySelector('[data-slot="drawer"]');
    if (!box) return;
    const x = detail && (byAge(status?.[detail.kind]) || [])[detail.i];
    if (!x) { box.hidden = true; box.innerHTML = ''; return; }
    const todo = detail.kind === 'todo';
    box.hidden = false;
    box.innerHTML = `<div class="w3p-panel" role="dialog" aria-label="详情"><button type="button" class="w3p-x" data-w3="close" aria-label="关闭">×</button>
      <span class="w3p-tag ${ageCls(x.ageDays)}">${todo ? '待办' : '申请'} · ${esc(x.app)}</span>
      <h2>${esc(x.title)}</h2>
      <dl class="w3p-kv">
        <dt>${todo ? '发起' : '当前处理'}</dt><dd>${esc((todo ? x.from : x.handler) || '—')}</dd>
        <dt>${todo ? '收到' : '提交'}</dt><dd>${esc(x.time || '—')}（${x.ageDays == null ? '—' : x.ageDays === 0 ? '今天' : '已 ' + x.ageDays + ' 天'}）</dd>
        <dt>处理页</dt><dd>${esc(x.host || '—')}</dd>
        <dt>提醒</dt><dd>${todo ? '挂到第 7 天、第 30 天各提醒一次' : '卡到第 5 天、第 14 天各提醒一次'}；办完后会自动从这里消失</dd>
      </dl>
      ${x.url ? `<button type="button" class="w3p-btn primary" data-w3="open" data-url="${esc(x.url)}">在浏览器打开处理页</button>` : ''}
      <p class="w3p-note">Hub 只读门户，不替你审批；处理请在打开的页面里完成。</p></div>`;
  }

  async function load() { status = await call('status'); render(); }
  async function action(name, el) {
    if (name === 'tab') { tab = el.dataset.tab; detail = null; render(); return; }
    if (name === 'detail') { detail = { kind: el.dataset.kind, i: Number(el.dataset.i) }; renderDrawer(); return; }
    if (name === 'close') { detail = null; renderDrawer(); return; }
    if (name === 'open') { const url = el.dataset.url; if (url) await ipcRenderer.invoke('open-external-url', url); return; }
    if (name === 'sync') {
      status = { ...(status || {}), syncing: true }; render();
      try { status = await call('sync'); } finally { await load().catch(() => {}); }
      if (status.lastResult && !status.lastResult.ok) showMessage?.('门户读取失败：' + status.lastResult.error);
    }
  }

  const onResize = () => place();
  async function open() {
    build(); closeOtherPanels();
    for (const name of ['__companyRoomsHide', '__companyMeetingHide', '__assistantHide', '__wirelessHide', '__companyAssistantHide', '__companyForumHide', '__companyPptHide', '__companyAttendanceHide', '__profileHide', '__avatarHide',
      '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    window.setShellNavActive?.('company-w3');
    page.hidden = false; document.body.classList.add('company-w3-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = null;
    if (await gate.check()) await startData();
  }
  async function startData() {
    if (!page || page.hidden) return;
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 30000);
    try { status = await call('ensure-fresh'); render(); } catch (error) { showMessage?.('门户状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-w3-page-open');
    document.getElementById('btn-company-w3')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
    detail = null; renderDrawer();
  }
  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-w3)')) close(); });
  ipcRenderer.on('company-w3:changed', () => { if (page && !page.hidden && status) void load().catch(() => {}); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}

module.exports = { createCompanyW3Page };
