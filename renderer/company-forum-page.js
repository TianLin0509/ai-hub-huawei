'use strict';
// 公司版「帖子」页（原「论坛」，2026-10-18；2026-11-12 改版）：公司发文 + 心声社区 + 稼先社区今天的内容与 AI 摘要（core/company-forum/）。
// 布局（一个页签一屏，不靠滚动条）：页头（同步状态、刷新、设置）→ 来源页签「发文 / 心声 / 稼先 / AI 看点」→ 当前来源的几个榜并排成列：
//   发文三列（政策讲话 / 公司文件 / 公告），心声两列（24小时点击 / 24小时回复），稼先一个榜拆成两列。
//   每列按可用高度算一页放几条，放不下的翻页；每条：名次、标题（点开用系统浏览器打开原文）、文号或阅读回复 · 时间、一句话摘要。
//   新出现的发文带「新」标，页签上显示新发文条数。
// 某个站没能自动登录时，在它那一页显示「登录」按钮（弹出 Hub 自己的浏览器窗口，登录一次以后自动同步）。
// 写法同助理页：盖在主区域上的一层，点左侧其他按钮自动关闭。左侧按钮只在公司版（gate.js）插入。
function createCompanyForumPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  let page = null, data = null, timer = null, panelOpen = false, gate = null;
  let source = 'w3';     // 当前来源页签：站点 id 或 'overview'
  let perPage = 10;      // 一列一页放几条（按高度算）
  const pageNo = {};     // 每个榜翻到第几页：'站点|榜' → 0 起
  const ORDER = ['w3', 'xinsheng', 'jx'];
  const NEW_MS = 24 * 3600000;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const when = at => {
    if (!at) return '—';
    const d = new Date(at), t = new Date();
    if (d.toDateString() === t.toDateString()) return '今天 ' + clock(at);
    const y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1), m = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + clock(at);
    if (d.toDateString() === m.toDateString()) return '明天 ' + clock(at);
    return `${d.getMonth() + 1}-${d.getDate()} ${clock(at)}`;
  };
  const num = n => n == null ? '' : n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万' : String(n);
  const call = async (channel, payload) => { const r = await ipcRenderer.invoke('company-forum:' + channel, payload); if (r && r.ok === false) throw new Error(r.error || '操作未完成'); return r; };

  function nav() {
    let btn = document.getElementById('btn-company-forum');
    if (btn) return btn;
    const rules = document.getElementById('btn-rules');
    const anchor = document.getElementById('btn-company-meeting') || document.getElementById('btn-company-assistant') || rules?.closest('.rail-group') || rules || document.getElementById('btn-home');
    if (!anchor) return null;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-shell-nav'; btn.id = 'btn-company-forum';
    btn.title = '帖子 · 公司发文和心声、稼先今天的热帖与摘要（数据只留本机）'; btn.setAttribute('aria-label', '帖子');
    btn.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5z"/><path d="M19.5 9h.5A1.5 1.5 0 0 1 21.5 10.5v5A1.5 1.5 0 0 1 20 17h-1v2.5L16 17h-3.5"/><path d="M6.5 9.5h6M6.5 11.5h4"/></svg></span><span class="btn-label">帖子</span>';
    anchor.after(btn);
    btn.addEventListener('click', () => { void open(); });
    return btn;
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.className = 'company-forum-page'; page.id = 'company-forum-page'; page.hidden = true; page.setAttribute('aria-label', '帖子');
    page.innerHTML = `<header class="cf-head">
        <div class="cf-title"><h1>帖子</h1><span class="cf-sub">公司发文 · 心声 · 稼先</span></div>
        <div class="cf-status" data-slot="status"></div>
        <button type="button" class="cf-btn" data-cf="sync" title="现在重新打开几个站点取一次">刷新</button>
        <button type="button" class="cf-btn" data-cf="settings">设置</button>
      </header>
      <div class="cf-panel" data-slot="panel" hidden></div>
      <div class="cf-sheet">
        <div class="cf-sources" role="tablist" data-slot="sources"></div>
        <div class="cf-pane" data-slot="pane"></div>
        <p class="cf-foot">数据只留在这台电脑 · 点标题用系统浏览器打开原文 · 摘要由 CodeAgent 依据标题和正文摘录写成，每条都对过出处</p>
      </div>`;
    document.body.append(page);
    // 可选功能（默认关，renderer/optional-feature-gate.js）：关着时整页提示开启，开着时标题栏有「已开启 · 关闭」。
    gate = require('./optional-feature-gate').createFeatureGate({ document, window, id: 'forum', page, showMessage,
      badgeSlot: badge => page.querySelector('[data-cf="sync"]').before(badge), onEnabled: () => { void startData(); } });
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-cf]');
      if (b) { event.preventDefault(); void action(b.dataset.cf, b).catch(e => showMessage?.(e.message)); }
    });
  }
  function place() {
    if (!page || page.hidden) return;
    // 底边按底栏高度算（同云端页）：以前按会话区算，从「规则」切过来时会话区被规则页藏着，量出来高度是 0，页面被压成一条、和规则页叠在一起（2026-10-19 用户）。
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    const left = rail && rail.offsetParent !== null ? rail.getBoundingClientRect().right : 0;
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const bottom = footer ? footer.getBoundingClientRect().height : 0;
    Object.assign(page.style, { left: left + 'px', top: top + 'px', bottom: Math.max(0, bottom) + 'px' });
  }

  function statusHtml() {
    const d = data, snap = d.snapshot, chips = [];
    if (d.syncing) chips.push(`<span class="cf-chip run">${esc(d.progress || '正在同步…')}</span>`);
    else if (snap) chips.push(`<span class="cf-chip">${d.today ? '同步于 ' : '上次同步 '}${when(snap.at)}</span>`);
    else chips.push('<span class="cf-chip">还没同步过</span>');
    if (snap?.summarizing || d.job) chips.push('<span class="cf-chip run">AI 正在写摘要</span>');
    chips.push('<span class="cf-sp"></span>');
    chips.push(`<span class="cf-chip">下一次同步：${d.settings.enabled ? when(d.nextSyncAt) : '已关闭自动同步'}</span>`);
    return chips.join('');
  }
  const postKey = (site, title) => site + '|' + title;
  const sites = () => [...data.sites].sort((a, b) => (ORDER.indexOf(a.id) + 99) % 99 - (ORDER.indexOf(b.id) + 99) % 99);
  const entryOf = id => data.snapshot?.sites?.find(x => x.id === id) || null;
  const isNew = p => !!p.firstSeen && data.now - p.firstSeen < NEW_MS;
  function sourcesHtml() {
    const tabs = sites().map(s => {
      const entry = entryOf(s.id), fresh = (entry?.lists || []).flatMap(l => l.posts).filter(isNew).length;
      const mark = entry?.needsLogin ? '<i class="cf-dot warn" title="没能自动登录"></i>' : entry && !entry.ok ? '<i class="cf-dot warn" title="没取到"></i>' : fresh ? `<i class="cf-new-n" title="24 小时内新出现的发文">${fresh} 新</i>` : '';
      return `<button type="button" role="tab" class="cf-source${source === s.id ? ' on' : ''}" data-cf="source" data-source="${s.id}" title="${esc(s.name)}">${esc(s.short)}${mark}</button>`;
    });
    const n = (data.snapshot?.overview || []).length;
    tabs.push(`<button type="button" role="tab" class="cf-source${source === 'overview' ? ' on' : ''}" data-cf="source" data-source="overview">AI 看点${n ? `<i class="cf-n">${n}</i>` : ''}</button>`);
    const cur = entryOf(source);
    const via = cur?.via === 'edge' ? '经 Edge 登录状态' : cur?.via === 'hub' ? '经 Hub 窗口' : '';
    const right = cur ? `<span class="cf-time">${esc([data.sites.find(s => s.id === source)?.name, cur.at ? when(cur.at) + ' 取到' : '', via].filter(Boolean).join(' · '))}</span>` : '';
    return tabs.join('') + '<span class="cf-sp"></span>' + right;
  }
  function emptyHtml() {
    const notice = data.syncError ? `<p class="cf-note bad" role="alert">${esc(data.syncError)}</p>` : '';
    return notice + `<article class="cf-overview empty">${data.syncing ? '正在打开公司发文、心声、稼先取今天的内容，第一次大约需要一两分钟。' : data.domain ? '今天还没同步。点右上角「刷新」开始。' : '先在「设置」里填一次公司站点的域名（一般就是公司邮箱 @ 后面那段）。'}${!data.syncing && !data.domain ? '<button type="button" class="cf-btn primary" data-cf="settings">填写域名</button>' : ''}</article>`;
  }
  function overviewHtml() {
    const snap = data.snapshot;
    const notice = (data.syncError ? `<p class="cf-note bad" role="alert">${esc(data.syncError)}</p>` : '')
      + (data.needsRefresh && !data.settings.enabled ? '<p class="cf-note bad" role="status">这是旧版本抓的，点刷新更新</p>' : '');
    if (!snap) return emptyHtml();
    const items = (snap.overview || []).map(o => `<li>${esc(o.text)}${(o.refs || []).map(r => `<button type="button" class="cf-ref" data-cf="jump" data-key="${esc(postKey(r.site, r.title))}" title="${esc(r.title)}">${esc(refLabel(r))}</button>`).join('')}</li>`).join('');
    const note = snap.summaryNote && !snap.summarizing ? `<p class="cf-note">${esc(snap.summaryNote)}</p>` : '';
    const redo = !snap.summarizing && !data.job && (snap.picked || []).length ? '<button type="button" class="cf-link" data-cf="summarize">重新整理</button>' : '';
    return notice + `<article class="cf-overview"><div class="cf-ov-head"><b>今日看点</b>${snap.summaryAt ? `<span class="cf-time">AI 整理于 ${when(snap.summaryAt)}</span>` : ''}<span class="cf-sp"></span>${redo}</div>
      ${items ? `<ol>${items}</ol>` : snap.summarizing ? '<p class="cf-note run">AI 正在读帖子、写看点…</p>' : '<p class="cf-note">还没有 AI 看点。</p>'}${note}</article>`;
  }
  function siteShort(id) { return (data.sites.find(s => s.id === id) || {}).short || id; }
  // 出处标签：「稼先 1」= 稼先热点第 1 名；心声在回复榜的写「心声回复 3」；发文写栏目名「政策讲话 2」。
  function refLabel(r) {
    const lists = entryOf(r.site)?.lists || [];
    const i = lists.findIndex(l => l.posts.some(p => p.title === r.title));
    const post = i >= 0 ? lists[i].posts.find(p => p.title === r.title) : null;
    const name = r.site === 'w3' && i >= 0 ? lists[i].label : siteShort(r.site) + (i > 0 ? lists[i].label.replace(/^24小时/, '') : '');
    return name + (post ? ' ' + post.rank : '');
  }
  // 当前来源的各列：多个榜一榜一列；只有一个榜时拆成两列（第二列接着第一列往下排）。
  function columnsOf(siteId) {
    const lists = entryOf(siteId)?.lists || [];
    if (lists.length !== 1) return lists.map(l => ({ key: l.key, label: l.label, posts: l.posts, step: perPage, offset: 0 }));
    const l = lists[0];
    return [{ key: l.key, label: l.label, posts: l.posts, step: perPage * 2, offset: 0 }, { key: l.key, label: '', posts: l.posts, step: perPage * 2, offset: perPage, twin: true }];
  }
  function siteHtml(site) {
    const entry = entryOf(site.id);
    if (!data.snapshot) return emptyHtml();
    const notice = data.syncError ? `<p class="cf-note bad" role="alert">${esc(data.syncError)}</p>` : '';
    if (!entry) return notice + `<p class="cf-note pad">${data.syncing ? '正在取…' : `${esc(site.name)}还没同步，点右上角「刷新」。`}</p>`;
    if (entry.needsLogin) {
      const waiting = site.login === 'waiting';
      return notice + `<div class="cf-login"><p>${esc(site.loginError || entry.error)}</p><button type="button" class="cf-btn primary" data-cf="login" data-site="${site.id}"${waiting ? ' disabled' : ''}>${waiting ? '登录窗口已打开…' : '登录' + esc(site.name)}</button></div>`;
    }
    if (!entry.ok) return notice + `<p class="cf-note bad pad">${esc(entry.error || '没取到')}</p>`;
    const cols = columnsOf(site.id);
    return notice + `<div class="cf-cols" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">${cols.map(c => columnHtml(site, c)).join('')}</div>`;
  }
  function columnHtml(site, col) {
    const k = site.id + '|' + col.key, pages = Math.max(1, Math.ceil(col.posts.length / col.step));
    const at = Math.min(pageNo[k] || 0, pages - 1), from = at * col.step + col.offset;
    const rows = col.posts.slice(from, from + perPage);
    const pager = !col.twin && pages > 1 ? `<span class="cf-pager"><button type="button" class="cf-pg" data-cf="page" data-key="${esc(k)}" data-to="${at - 1}"${at ? '' : ' disabled'} aria-label="上一页">‹</button><span>${at + 1} / ${pages}</span><button type="button" class="cf-pg" data-cf="page" data-key="${esc(k)}" data-to="${at + 1}"${at < pages - 1 ? '' : ' disabled'} aria-label="下一页">›</button></span>` : '';
    const head = col.twin ? '<div class="cf-col-head"></div>' : `<div class="cf-col-head"><b>${esc(col.label)}</b><span class="cf-n">${col.posts.length || ''}</span><span class="cf-sp"></span>${pager}</div>`;
    return `<section class="cf-col">${head}<ol class="cf-posts">${rows.map(p => postHtml(site, p)).join('') || (col.twin ? '' : '<li class="cf-note pad">这一栏今天没有内容。</li>')}</ol></section>`;
  }
  function postHtml(site, p) {
    const meta = [p.code, p.board, p.views != null ? '阅读 ' + num(p.views) : '', p.replies != null ? '回复 ' + num(p.replies) : '', p.likes != null ? '赞 ' + num(p.likes) : '', p.author, p.time ? when(p.time) : ''].filter(Boolean).map(esc).join(' · ');
    const badge = isNew(p) ? '<i class="cf-new">新</i>' : '';
    const title = p.url ? `<a href="#" class="cf-post-title" data-cf="open" data-url="${esc(p.url)}" title="${esc(p.title)}（点开用系统浏览器打开原文）">${badge}${esc(p.title)}</a>` : `<span class="cf-post-title plain" title="没取到链接">${badge}${esc(p.title)}</span>`;
    const sum = p.summary || p.abstract || '';
    return `<li class="cf-post" data-key="${esc(postKey(site.id, p.title))}"><span class="cf-rank${p.rank <= 3 ? ' top' : ''}">${p.rank}</span><div class="cf-post-main">${title}<div class="cf-meta" title="${esc(sum)}">${meta}${sum ? `<span class="cf-sum">${meta ? ' — ' : ''}${esc(sum)}</span>` : ''}</div></div></li>`;
  }
  function panelHtml() {
    const s = data.settings;
    const from = !data.domain ? '还不知道' : { settings: '设置里填的', email: '取自你的公司邮箱', 'assistant-email': '取自你的公司邮箱', welink: '取自你的公司邮箱', 'forum-settings': '设置里填的' }[data.domainFrom] || '自动找到的';
    return `<div class="cf-set"><b>帖子设置</b>
      <label>公司站点域名 <input data-f="domain" value="${esc(s.domain || data.domain || '')}" placeholder="例如 corp.example.com"><span class="cf-note">当前：${esc(data.domain || '—')}（${from}）。三个站点是 w3.域名、xinsheng.域名 和 jx.域名。</span></label>
      <label><input type="checkbox" data-f="enabled"${s.enabled ? ' checked' : ''}> 工作日自动同步，时间 <input type="time" data-f="syncTime" value="${esc(s.syncTime)}"></label>
      <label>公司发文每 <input type="number" min="0" max="240" data-f="docsEveryMin" value="${s.docsEveryMin}"> 分钟再看一次（0 为只在早上看）<input type="checkbox" data-f="docsNotify"${s.docsNotify ? ' checked' : ''}> 有新发文时提醒我</label>
      <label>每个榜取 <input type="number" min="5" max="30" data-f="perList" value="${s.perList}"> 条，AI 摘要写前 <input type="number" min="0" max="20" data-f="summarize" value="${s.summarize}"> 条</label>
      <div class="cf-row"><button type="button" class="cf-btn primary" data-cf="save">保存</button><button type="button" class="cf-btn" data-cf="close-panel">取消</button><span class="cf-sp"></span><button type="button" class="cf-link" data-cf="open-session">打开整理会话</button><button type="button" class="cf-link" data-cf="clear-login" title="清掉 Hub 自己浏览器窗口里的登录状态（不影响 Edge）">退出登录</button></div></div>`;
  }
  // 一列一页能放几条：量出内容区高度，减去列头，除以一条的高度。
  function measure() {
    const pane = page.querySelector('[data-slot="pane"]');
    const h = pane.clientHeight - 44;
    return Math.max(4, Math.min(20, Math.floor(h / 58)));
  }
  function render() {
    if (!page || !data) return;
    if (source !== 'overview' && !data.sites.some(s => s.id === source)) source = sites()[0]?.id || 'overview';
    page.querySelector('[data-slot="status"]').innerHTML = statusHtml();
    const panel = page.querySelector('[data-slot="panel"]');
    if (panelOpen && !panel.dataset.open) { panel.innerHTML = panelHtml(); panel.dataset.open = '1'; }
    panel.hidden = !panelOpen;
    if (!panelOpen) { panel.innerHTML = ''; panel.dataset.open = ''; }
    page.querySelector('[data-slot="sources"]').innerHTML = sourcesHtml();
    perPage = measure();
    page.querySelector('[data-slot="pane"]').innerHTML = source === 'overview' ? overviewHtml() : siteHtml(data.sites.find(s => s.id === source));
    page.querySelector('[data-cf="sync"]').disabled = !!data.syncing;
  }
  async function load() { data = await call('status'); render(); return data; }

  async function action(name, el) {
    if (name === 'sync') { el.disabled = true; data = { ...data, syncing: true, progress: '正在同步…' }; render(); await call('sync'); await load(); return; }
    if (name === 'settings') { panelOpen = !panelOpen; render(); return; }
    if (name === 'close-panel') { panelOpen = false; render(); return; }
    if (name === 'save') {
      const panel = page.querySelector('[data-slot="panel"]'), v = k => panel.querySelector(`[data-f="${k}"]`);
      await call('set-settings', { domain: v('domain').value, enabled: v('enabled').checked, syncTime: v('syncTime').value, perList: Number(v('perList').value), summarize: Number(v('summarize').value), docsEveryMin: Number(v('docsEveryMin').value), docsNotify: v('docsNotify').checked });
      panelOpen = false; await load(); showMessage?.('帖子设置已保存');
      if (data.domain && !data.today && !data.syncing) void call('ensure-today').then(load).catch(() => {});
      return;
    }
    if (name === 'source') { source = el.dataset.source; render(); return; }
    if (name === 'page') { pageNo[el.dataset.key] = Math.max(0, Number(el.dataset.to) || 0); render(); return; }
    if (name === 'open') { await call('open-url', { url: el.dataset.url }); return; }
    if (name === 'login') { el.disabled = true; await call('login', { site: el.dataset.site }); await load(); return; }
    if (name === 'summarize') { await call('summarize'); await load(); return; }
    if (name === 'jump') {
      // 切到帖子所在的来源页签，翻到它那一页，再闪一下。
      const [site] = el.dataset.key.split('|');
      const list = entryOf(site)?.lists.find(l => l.posts.some(p => postKey(site, p.title) === el.dataset.key));
      if (!list) return;
      source = site; render();
      const single = entryOf(site).lists.length === 1, index = list.posts.findIndex(p => postKey(site, p.title) === el.dataset.key);
      pageNo[site + '|' + list.key] = Math.floor(index / (single ? perPage * 2 : perPage)); render();
      const target = [...page.querySelectorAll('.cf-post')].find(x => x.dataset.key === el.dataset.key);
      if (target) { target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1600); }
      return;
    }
    if (name === 'open-session') { const r = await call('open-session'); window.__hubOpenSession?.(r.sessionId); close(); return; }
    if (name === 'clear-login') { await call('clear-login'); showMessage?.('已退出 Hub 窗口里的登录；平时经 Edge 的登录状态取数，不受影响'); }
  }

  const onResize = () => { place(); render(); };
  async function open() {
    build(); closeOtherPanels();
    window.__companyRoomsHide?.();
    window.__companyMeetingHide?.(); window.__assistantHide?.(); window.__wirelessHide?.(); window.__companyAssistantHide?.(); window.__companyAttendanceHide?.();
    // 规则、写作、研究等整页面板也关掉（同云端页），不然从这些页切过来会叠在一起。
    for (const name of ['__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.(); window.setShellNavActive?.('company-forum');
    page.hidden = false; document.body.classList.add('company-forum-page-open'); place();
    nav()?.classList.add('active');
    window.addEventListener('resize', onResize);
    clearInterval(timer); timer = null;
    if (await gate.check()) await startData();
  }
  async function startData() {
    if (!page || page.hidden) return;
    clearInterval(timer); timer = setInterval(() => { void load().catch(() => {}); }, 15000);
    try { data = await call('ensure-today'); render(); } catch (error) { showMessage?.('帖子状态读取失败：' + error.message); }
  }
  function close() {
    if (!page || page.hidden) return;
    page.hidden = true; document.body.classList.remove('company-forum-page-open');
    document.getElementById('btn-company-forum')?.classList.remove('active');
    clearInterval(timer); timer = null; window.removeEventListener('resize', onResize);
  }
  nav();
  document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-forum)')) close(); });
  ipcRenderer.on('company-forum:changed', () => { if (page && !page.hidden) void load().catch(() => {}); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createCompanyForumPage };
