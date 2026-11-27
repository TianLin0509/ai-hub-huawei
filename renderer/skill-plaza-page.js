'use strict';
// 「技能广场」页（v1，2026-11-27）：员工助手、本机五家已装、AgentCenter 三路技能一处找、一处装。
// 版式按商店卡片墙：左边分类与来源，右边卡片按屏分页；点卡片从右侧滑出详情。
// 页面只经 skill-plaza:* 接口读数据、发操作；扫描、转换、写盘都在主进程（core/skill-plaza）。

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORIES = [['all', '全部'], ['office', '办公文档'], ['ppt', 'PPT'], ['welink', '会议与 WeLink'], ['intranet', '内网办事'], ['dev', '研发'], ['other', '其他'], ['mine', '我已装的']];
const SOURCES = { weclaw: '员工助手', local: '本机已装', agentcenter: 'AgentCenter' };
const SOURCE_TAG = { weclaw: '员工助手', local: '本机', agentcenter: 'AgentCenter' };
const USE = { ok: ['g', '直接用'], fix: ['w', '需改写'], delegate: ['b', '交员工助手执行'], installed: ['n', '已装'] };
// 别的整页面板：body 上的类名，以及只改自己显隐的面板节点。
const OTHER_OPEN = /-page-open$|^(rules|hub-workspace|accounts|capabilities|web-session|web-roundtable)-open$/;
const PANEL_IDS = ['writing-panel', 'xresearch-panel', 'study-panel', 'progress-panel', 'cloud-page', 'team-page', 'avatar-page', 'weclaw-page', 'account-page', 'codeagent-accounts-page', 'rules-panel', 'wireless-panel', 'meeting-room-panel'];
// 对照表第一列：头字段名换成中文，界面不出现字段代号。
const FIELD = { name: '名字', description: '描述与触发词', license: '许可', version: '版本', metadata: '其他头字段', files: '文件' };
const CARD_MIN_W = 320, CARD_H = 138, GAP = 12;

/** 卡片上那颗按钮：随档位与来源变（纯函数，单测用）。 */
function cardAction(item) {
  if (item.use === 'installed') return item.source === 'weclaw' ? { op: 'remove', label: '移除' } : { op: 'manage', label: '管理' };
  if (item.use === 'ok') return { op: 'import', label: '导入', primary: true };
  if (item.use === 'fix') return { op: 'detail', label: '预览改写' };
  if (item.use === 'delegate') return { op: 'delegate', label: '委托' };
  return { op: 'detail', label: '详情' };
}
const useLabel = item => (item.use === 'installed' && item.source === 'weclaw' ? '已导入' : USE[item.use]?.[1] || '');

/** 按分类、来源勾选、搜索词筛（纯函数，单测用）。 */
function filterItems(items, { category = 'all', sources = null, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (items || []).filter(it => (!sources || sources.has(it.source))
    && (category === 'all' || (category === 'mine' ? it.use === 'installed' : it.category === category))
    && (!q || [it.displayName, it.name, it.description].some(s => String(s || '').toLowerCase().includes(q))));
}

function createSkillPlazaPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage = () => {} }) {
  let page = null, data = null, loading = false, loadError = '', busy = '';
  let category = 'all', query = '', pageNo = 0, enabled = null;
  let stale = false, panelWatch = null, visibleAtOpen = new Set();
  let pendingRefresh = false; // 扫描或操作进行中收到后台完成通知：记下，结束后补刷一次
  const oneLine = t => String(t).split(/\r?\n/).map(x => x.trim()).filter(Boolean).join('；');
  const earlyDone = new Map(); // 操作进行中先到的完成通知（op:id → info），防它比「仍在后台进行」的回复先到
  const pendingOps = new Map(); // 回过「仍在后台进行」的操作（op:id → 是否从抽屉发起），完成通知只对它们改提示
  const shown = el => !!el && !el.hidden && window.getComputedStyle(el).display !== 'none';
  let detail = null; // { id, preview, error, targets:Set, ack, note:{ok,text} }
  let note = null; // 页首一行提示 { ok, text }
  const isOpen = () => !!page && !page.hidden;
  const $ = sel => page.querySelector(sel);
  const call = async (op, payload) => {
    const r = await ipcRenderer.invoke('skill-plaza:' + op, payload);
    if (!r || r.ok === false) throw new Error(r?.error || '没有成功');
    return r.data;
  };
  const itemById = id => data?.items?.find(it => it.id === id) || null;

  async function load(refresh = false) {
    if (refresh) pendingRefresh = false; // 这次强制重扫已覆盖之前记下的补刷
    loading = true; renderHead(); renderAll();
    try {
      data = await call('list', refresh ? { refresh: true } : {});
      if (!enabled) enabled = new Set(Object.keys(SOURCES));
      loadError = '';
      if (detail && !itemById(detail.id)) detail = null;
    } catch (e) { loadError = e.message; }
    loading = false; renderAll();
    if (detail) void loadPreview(detail.id, true);
    if (pendingRefresh && !busy) { pendingRefresh = false; void load(true); }
  }

  async function loadPreview(id, keep = false) {
    const item = itemById(id); if (!item) return;
    if (!keep || !detail || detail.id !== id) {
      const present = (data.targets || []).filter(t => t.present).map(t => t.id);
      const chosen = item.source === 'agentcenter' ? present.filter(t => t === 'codeagent') : present;
      detail = { id, preview: null, error: '', targets: new Set(chosen), ack: false, note: null };
    }
    renderDrawer();
    if (item.source !== 'weclaw' || item.use === 'delegate') return; // 委托档搬不过来，不做转换预览
    try { const p = await call('preview', { id }); if (detail?.id === id) detail.preview = p; }
    catch (e) { if (detail?.id === id) detail.error = e.message; }
    renderDrawer();
  }

  const lineFor = (op, item, r) => {
    // 主进程等不及就先回「仍在后台进行」，真正完成时发 skill-plaza:changed，页面自己刷新。
    if (r?.pending) return { ok: true, text: r.message || '仍在后台进行，完成后页面会自动刷新' };
    if (op === 'import') {
      const done = (r?.installed || []).map(x => targetLabel(x.target));
      const skipped = (r?.skipped || []).map(x => `${targetLabel(x.target)}（${x.reason}）`);
      return { ok: done.length > 0, text: done.length ? `已导入「${item.displayName || item.name}」到 ${done.join('、')}${skipped.length ? `；跳过 ${skipped.join('、')}` : ''}` : `没有导入：${skipped.join('、') || '没有可装的位置'}` };
    }
    if (op === 'remove') return r?.kept?.length ? { ok: false, text: `没删干净：${(r.reasons || []).join('；') || '有目录没能删除'}` } : { ok: true, text: `已移除「${item.displayName || item.name}」` };
    if (op === 'delegate') return { ok: true, text: r?.opened ? '已复制建议提示词，员工助手里新对话已打开，粘贴即可' : '已复制建议提示词；员工助手没打开，打开后新建对话粘贴即可' };
    return { ok: true, text: '已完成' };
  };
  const targetLabel = id => (data?.targets || []).find(t => t.id === id)?.label || id;

  async function act(op, id, fromDrawer = false) {
    const item = itemById(id); if (!item || busy) return;
    if (op === 'detail') { void loadPreview(id); return; }
    if (op === 'manage') { try { await call('open-manage'); } catch (e) { setNote({ ok: false, text: e.message }, fromDrawer); } return; }
    let payload = { id };
    if (op === 'import') {
      const targets = fromDrawer && detail?.id === id ? [...detail.targets]
        : (data.targets || []).filter(t => t.present && (item.source !== 'agentcenter' || t.id === 'codeagent')).map(t => t.id);
      if (!targets.length) {
        const text = item.source === 'agentcenter' ? '没有可装的位置：AgentCenter 的技能只能装进 CodeAgent，这台电脑上没找到 CodeAgent' : '没有可装的位置：Claude、CodeAgent、Codex 这几家这台电脑上都没找到';
        setNote({ ok: false, text }, fromDrawer); return;
      }
      payload = { id, targets };
      if (item.use === 'fix') {
        if (!(fromDrawer && detail?.ack)) { void loadPreview(id); return; }
        payload.acknowledgeRewrite = true;
      }
    }
    const opKey = op + ':' + id;
    earlyDone.delete(opKey); // 清掉上一次同名操作残留的提前通知
    busy = opKey; renderAll();
    try {
      const r = await call(op, payload);
      const early = earlyDone.get(opKey); earlyDone.delete(opKey);
      if (r?.pending && !early) pendingOps.set(opKey, fromDrawer);
      const settledEarly = !!(r?.pending && early);
      if (settledEarly && early.ok === false) throw new Error(oneLine(early.error || '没有成功'));
      const line = settledEarly ? { ok: true, text: `「${item.displayName || item.name}」已完成` } : lineFor(op, item, r);
      // 成功：抽屉里留一行结果；卡片上的操作只弹提示，不在页首重复。失败：就地留一行真原因。
      if (fromDrawer) setNote(line, true); else if (line.ok) note = null; else setNote(line, false);
      if (line.ok && !fromDrawer) showMessage(line.text);
      busy = '';
      // 「仍在后台进行」时不急着重扫：等主进程完成通知（skill-plaza:changed）再刷新
      if (!r?.pending || settledEarly) await load(true); // 强制重扫：导入/移除后本机已装跟着变，不留旧卡
    } catch (e) { setNote({ ok: false, text: e.message }, fromDrawer); }
    finally {
      earlyDone.delete(opKey);
      busy = ''; renderAll();
      if (pendingRefresh && !loading) { pendingRefresh = false; void load(true); }
    }
  }
  function setNote(line, fromDrawer) {
    if (fromDrawer && detail) detail.note = line; else note = line;
    renderAll();
  }

  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'skill-plaza-page'; page.className = 'skill-plaza-page'; page.hidden = true; page.setAttribute('aria-label', '技能广场');
    page.innerHTML = `<div class="spz-root">
      <header class="spz-head"><h1>技能广场<span class="spz-beta">Beta</span></h1>
        <p>员工助手、AgentCenter、本机五家 AI 的技能，一处找、一处装</p>
        <input type="search" class="spz-search" placeholder="搜技能名、用途…" aria-label="搜索技能">
        <button type="button" class="spz-btn" data-spz="rescan">重新扫描</button></header>
      <div class="spz-tip" hidden></div>
      <div class="spz-body"><nav class="spz-side" aria-label="分类与来源"></nav>
        <div class="spz-main"><div class="spz-note" hidden></div><div class="spz-grid" role="list"></div><div class="spz-pager"></div></div></div>
      <aside class="spz-drawer" hidden aria-label="技能详情"></aside></div>`;
    document.body.append(page);
    $('.spz-search').addEventListener('input', event => { query = event.target.value; pageNo = 0; note = null; renderAll(); });
    page.addEventListener('click', event => {
      const b = event.target.closest('[data-spz]');
      if (b) {
        if (b.disabled) return;
        const op = b.dataset.spz, id = b.dataset.id;
        event.stopPropagation();
        if (op === 'rescan') { note = null; void load(true); }
        else if (op === 'cat') { category = b.dataset.cat; pageNo = 0; note = null; renderAll(); }
        else if (op === 'page') { pageNo += Number(b.dataset.step); renderGrid(); }
        else if (op === 'close-detail') { detail = null; renderDrawer(); }
        else if (op === 'target') { if (detail) { detail.targets.has(b.dataset.target) ? detail.targets.delete(b.dataset.target) : detail.targets.add(b.dataset.target); renderDrawer(); } }
        else void act(op, id, !!b.closest('.spz-drawer'));
        return;
      }
      const card = event.target.closest('.spz-card[data-id]');
      if (card) void loadPreview(card.dataset.id);
    });
    page.addEventListener('change', event => {
      const src = event.target.closest('[data-spz-source]');
      if (src) { src.checked ? enabled.add(src.dataset.spzSource) : enabled.delete(src.dataset.spzSource); pageNo = 0; note = null; renderAll(); return; }
      if (event.target.closest('[data-spz-ack]') && detail) { detail.ack = event.target.checked; renderDrawer(); }
    });
    page.addEventListener('keydown', event => {
      if (event.key === 'Escape' && detail) { detail = null; renderDrawer(); event.stopPropagation(); }
      const card = event.target.closest?.('.spz-card[data-id]');
      if (card && (event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); void loadPreview(card.dataset.id); }
    });
    window.addEventListener('resize', () => { if (isOpen()) { place(); renderGrid(); } });
    // 别的整页面板打开时自己收起：一类在 body 上挂类名，一类只改自己节点的显隐（写作、投研、学习、进展、云端、账号等）。
    if (window.MutationObserver) {
      new window.MutationObserver(() => {
        if (isOpen() && [...document.body.classList].some(c => c !== 'skill-plaza-page-open' && OTHER_OPEN.test(c))) close();
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      panelWatch = new window.MutationObserver(records => {
        if (!isOpen()) return;
        for (const r of records) if (shown(r.target) && !visibleAtOpen.has(r.target.id)) { close(); return; }
      });
    }
    // 点左侧栏（含 Ctrl+K 代点的入口）别的按钮也收起；组展开按钮、固定按钮除外。
    document.addEventListener('click', event => {
      const b = event.target.closest?.('#scene-rail button, .btn-shell-nav');
      if (!b || !isOpen() || b.id === 'btn-skill-plaza' || b.dataset.railGroupTrigger || ['rail-pin', 'rail-edge-trigger', 'nav-edit-done'].includes(b.id)) return;
      close();
    }, true);
  }
  function place() {
    if (!isOpen()) return;
    const rail = document.getElementById('scene-rail'), toolbar = document.getElementById('app-toolbar');
    const left = rail && rail.getBoundingClientRect().width > 0 ? rail.getBoundingClientRect().right : 0;
    const top = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const bodyRect = document.getElementById('app-body')?.getBoundingClientRect();
    const bottom = bodyRect?.height > 0 ? Math.max(0, window.innerHeight - bodyRect.bottom) : 0;
    Object.assign(page.style, { left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`, bottom: `${bottom}px` });
  }

  function renderHead() {
    if (!page) return;
    const b = $('[data-spz="rescan"]');
    const n = data?.items?.length;
    b.disabled = loading || !!busy;
    b.textContent = loading ? '正在扫描…' : `重新扫描${n != null ? `（${n}）` : ''}`;
    b.title = data?.sources?.weclaw?.present ? '重新读一遍员工助手和本机各家 AI 的技能目录' : '重新读一遍本机各家 AI 的技能目录';
    const tip = $('.spz-tip');
    const showTip = !!data && !data.sources?.weclaw?.present;
    tip.hidden = !showTip;
    if (showTip) tip.textContent = '这台电脑上没找到员工助手。装上员工助手（公司软件中心可装）后，这里会多出员工助手里的公司技能，可一键导入给 Claude、CodeAgent 用。';
  }
  function visibleSources() {
    if (!data) return [];
    return Object.keys(SOURCES).filter(k => k !== 'weclaw' || data.sources?.weclaw?.present).filter(k => k !== 'agentcenter' || data.sources?.agentcenter?.present || (data.items || []).some(i => i.source === 'agentcenter'));
  }
  function renderSide() {
    const side = $('.spz-side');
    if (!data) { side.innerHTML = ''; return; }
    const shown = new Set(visibleSources().filter(k => enabled.has(k)));
    const base = filterItems(data.items, { sources: shown, query });
    const cats = CATEGORIES.map(([key, name]) => {
      const n = key === 'all' ? base.length : key === 'mine' ? base.filter(i => i.use === 'installed').length : base.filter(i => i.category === key).length;
      return `<button type="button" class="spz-cat${category === key ? ' on' : ''}" data-spz="cat" data-cat="${key}" aria-pressed="${category === key}"><span>${esc(name)}</span><em>${n}</em></button>`;
    }).join('');
    const srcs = visibleSources().map(k => {
      const n = (data.items || []).filter(i => i.source === k).length;
      return `<label class="spz-src"><input type="checkbox" data-spz-source="${k}"${enabled.has(k) ? ' checked' : ''}><span>${esc(SOURCES[k])}</span><em>${n}</em></label>`;
    }).join('');
    side.innerHTML = `<div class="spz-cats">${cats}</div><div class="spz-sh">来源</div><div class="spz-srcs">${srcs}</div>`;
  }
  function pageSize() {
    const grid = $('.spz-grid');
    const w = grid.clientWidth || 900, h = grid.clientHeight || 500;
    const cols = Math.max(1, Math.floor((w + GAP) / (CARD_MIN_W + GAP)));
    const rows = Math.max(1, Math.floor((h + GAP) / (CARD_H + GAP)));
    return { cols, rows, size: cols * rows };
  }
  function cardHtml(it) {
    const [tone] = USE[it.use] || ['n'];
    const a = cardAction(it);
    const mine = busy === `${a.op}:${it.id}`;
    const btn = `<button type="button" class="spz-btn${a.primary ? ' p' : ''}" data-spz="${a.op}" data-id="${esc(it.id)}"${busy && !mine ? ' disabled' : ''}${mine ? ' disabled' : ''}>${mine ? '请稍候…' : esc(a.label)}</button>`;
    const title = it.displayName || it.name;
    return `<div class="spz-card${detail?.id === it.id ? ' on' : ''}" role="listitem" tabindex="0" data-id="${esc(it.id)}" data-use="${esc(it.use)}" data-source="${esc(it.source)}">`
      + `<div class="spz-ct"><span class="spz-av">${esc(Array.from(title)[0] || '?')}</span><div class="spz-cn"><b title="${esc(title)}">${esc(title)}</b>${it.displayName && it.displayName !== it.name ? `<code>${esc(it.name)}</code>` : ''}</div></div>`
      + `<p class="spz-cd" title="${esc(it.description)}">${esc(it.description || '没有描述')}</p>`
      + `<div class="spz-cf"><span class="spz-tag s-${esc(it.source)}">${esc(SOURCE_TAG[it.source] || it.source)}</span><span class="spz-use ${tone}">${esc(useLabel(it))}</span>${it.companyOnly ? '<span class="spz-co" title="技能里用到公司内网地址、工号或公司邮箱，离开公司网络可能用不了">仅公司</span>' : ''}<i></i>${btn}</div></div>`;
  }
  function renderGrid() {
    const grid = $('.spz-grid'), pager = $('.spz-pager'), noteEl = $('.spz-note');
    noteEl.hidden = !note; noteEl.className = `spz-note${note && !note.ok ? ' bad' : ''}`; noteEl.textContent = note?.text || ''; noteEl.title = note?.text || '';
    if (!data) {
      grid.innerHTML = `<div class="spz-empty">${loadError ? esc('读不到技能清单：' + loadError) : '正在扫描本机技能…'}</div>`;
      pager.innerHTML = ''; return;
    }
    const shown = new Set(visibleSources().filter(k => enabled.has(k)));
    const list = filterItems(data.items, { category, sources: shown, query });
    const { cols, size } = pageSize();
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const pages = Math.max(1, Math.ceil(list.length / size));
    pageNo = Math.min(Math.max(0, pageNo), pages - 1);
    const slice = list.slice(pageNo * size, pageNo * size + size);
    grid.innerHTML = slice.length ? slice.map(cardHtml).join('')
      : `<div class="spz-empty">${query ? `没有找到和「${esc(query)}」有关的技能` : '这一类还没有技能'}</div>`;
    pager.innerHTML = pages > 1 ? `<button type="button" class="spz-btn s" data-spz="page" data-step="-1"${pageNo === 0 ? ' disabled' : ''} aria-label="上一页">‹</button><span>第 ${pageNo + 1} / ${pages} 页 · 共 ${list.length} 个</span><button type="button" class="spz-btn s" data-spz="page" data-step="1"${pageNo >= pages - 1 ? ' disabled' : ''} aria-label="下一页">›</button>`
      : `<span>共 ${list.length} 个</span>`;
  }
  function drawerAction(item) {
    const mine = op => busy === `${op}:${item.id}`;
    const btn = (op, label, cls = '', disabled = false) => `<button type="button" class="spz-btn ${cls}" data-spz="${op}" data-id="${esc(item.id)}"${busy || disabled ? ' disabled' : ''}>${mine(op) ? '请稍候…' : esc(label)}</button>`;
    if (item.use === 'installed') return item.source === 'weclaw' ? btn('remove', '移除', 'd') : btn('manage', '在「资源 → 工具」里管理');
    if (item.use === 'delegate') return btn('delegate', '委托给员工助手', 'p');
    const none = !detail.targets.size;
    if (item.use === 'fix') return `<label class="spz-ack"><input type="checkbox" data-spz-ack${detail.ack ? ' checked' : ''}> 我知道导入后需要改写</label>${btn('import', '导入', 'p', !detail.ack || none)}`;
    return btn('import', '导入', 'p', none);
  }
  function renderDrawer() {
    const dr = $('.spz-drawer');
    const item = detail && itemById(detail.id);
    dr.hidden = !item;
    // 抽屉从标题行下面开始，搜索框和「重新扫描」始终可用。
    const headH = $('.spz-head').offsetHeight + ($('.spz-tip').hidden ? 0 : $('.spz-tip').offsetHeight);
    dr.style.top = `${headH}px`;
    if (page.classList.contains('spz-has-detail') !== !!item) { page.classList.toggle('spz-has-detail', !!item); renderGrid(); }
    page.querySelectorAll('.spz-card').forEach(c => c.classList.toggle('on', c.dataset.id === detail?.id));
    if (!item) { dr.innerHTML = ''; return; }
    const [tone] = USE[item.use] || ['n'];
    const p = detail.preview;
    const meta = [SOURCE_TAG[item.source] === '本机' ? '本机已装' : `来自${SOURCE_TAG[item.source]}`, item.version ? `v${item.version}` : ''].filter(Boolean).join(' · ');
    let body = `<p class="spz-dd">${esc(item.description || '没有描述')}</p>`;
    if (item.use === 'delegate') {
      const why = (item.deps || []).filter(d => d.key === 'inner-browser').map(() => '它要用员工助手内嵌的浏览器脚本办事，HUB-H 里没有同样的浏览器');
      body += `<h3>为什么交给员工助手</h3><ul class="spz-notes">${(why.length ? why : ['它是员工助手内置的办事技能，要用员工助手的登录状态和专属能力，离开员工助手跑不起来']).map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
        + '<h3>点「委托给员工助手」会怎样</h3><ul class="spz-notes"><li>复制一段建议提示词到剪贴板，写明要用这个技能；</li><li>在员工助手里新建一个对话（员工助手没打开会先打开）；</li><li>你把提示词粘贴进去，补上要办的事再发送。</li></ul>';
    } else if (item.source === 'weclaw') {
      if (detail.error) body += `<div class="spz-line bad" title="${esc(detail.error)}">${esc('读不到转换预览：' + detail.error)}</div>`;
      else if (!p) body += '<p class="spz-muted">正在生成转换预览…</p>';
      else {
        body += `<h3>导入前后对照</h3><table class="spz-map"><thead><tr><th>项</th><th>员工助手里</th><th>导入后</th></tr></thead><tbody>${(p.mapping || []).map(m => `<tr><td>${esc(FIELD[m.field] || m.field)}</td><td>${esc(m.before)}</td><td>${esc(m.after)}${m.note ? `<small>${esc(m.note)}</small>` : ''}</td></tr>`).join('')}</tbody></table>`
          + `<p class="spz-muted">导入后的目录名 <b>${esc(p.targetName)}</b> · ${p.fileCount} 个文件 · ${fmtBytes(p.totalBytes)}</p>`;
        // 迁移说明里和对照表同一项的那条（如目录名规范化）不再重复列出。
        const fields = (p.mapping || []).flatMap(m => [m.field, FIELD[m.field]]).filter(Boolean);
        const notes = (p.migrationNotes || []).filter(n => !fields.some(f => n.startsWith(f + '：') || n.startsWith(f + ':')));
        if (notes.length || item.deps?.length) body += `<h3>迁移说明</h3><ul class="spz-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}${(item.deps || []).filter(d => !notes.some(n => n.includes(d.label))).map(d => `<li><b>${esc(d.label)}</b>：${esc(d.why)}</li>`).join('')}</ul>`;
      }
    } else if (item.source === 'local') {
      const where = (item.installedIn || []).map(targetLabel);
      body += `<p class="spz-muted">已装在 ${esc(where.join('、') || '本机')}，这里只读展示；启用、停用、删除在「资源 → 工具」里管理。</p>`;
    } else {
      body += '<p class="spz-muted">来自 AgentCenter 插件市场，装给 CodeAgent 用。</p>';
    }
    if (item.use === 'installed' && item.source !== 'local') {
      const where = (item.installedIn || []).map(targetLabel);
      body += `<h3>已装到</h3><p class="spz-dd">${esc(where.join('、') || '已导入（装在哪几家没读到，点「重新扫描」再看）')}</p>`;
    }
    if (item.companyOnly) body += `<p class="spz-muted">标了「仅公司」：技能里用到公司内网地址、工号或公司邮箱，离开公司网络可能用不了${item.use === 'ok' || item.use === 'fix' ? '，不影响导入' : ''}。</p>`;
    if (item.use === 'ok' || item.use === 'fix') {
      const chips = (data.targets || []).filter(t => item.source !== 'agentcenter' || t.id === 'codeagent').map(t => `<button type="button" class="spz-chip${detail.targets.has(t.id) ? ' on' : ''}" data-spz="target" data-target="${esc(t.id)}" aria-pressed="${detail.targets.has(t.id)}"${t.present ? '' : ` disabled title="这台电脑上没找到 ${esc(t.label)}"`}>${esc(t.label)}</button>`).join('');
      body += `<h3>装到</h3><div class="spz-chips">${chips}</div>`;
    }
    const line = detail.note ? `<div class="spz-line${detail.note.ok ? ' ok' : ' bad'}" title="${esc(detail.note.text)}">${esc(detail.note.text)}</div>` : '';
    dr.innerHTML = `<div class="spz-dh"><div><h2>${esc(item.displayName || item.name)}<span class="spz-use ${tone}">${esc(useLabel(item))}</span>${item.companyOnly ? '<span class="spz-co">仅公司</span>' : ''}</h2><p>${esc(meta)}${item.displayName && item.displayName !== item.name ? ` · <code>${esc(item.name)}</code>` : ''}</p></div>`
      + `<button type="button" class="spz-x" data-spz="close-detail" aria-label="关闭详情">×</button></div><div class="spz-db">${body}</div><div class="spz-da">${line}<div class="spz-dbtn">${drawerAction(item)}</div></div>`;
  }
  const fmtBytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);
  function renderAll() {
    if (!page) return;
    page.classList.toggle('spz-has-detail', !!(detail && itemById(detail.id))); // 先定卡片区宽度，再按宽度分页
    renderHead(); renderSide(); renderGrid(); renderDrawer();
  }

  function open() {
    build(); closeOtherPanels(); page.hidden = false; document.body.classList.add('skill-plaza-page-open');
    if (panelWatch) {
      panelWatch.disconnect();
      const panels = PANEL_IDS.map(id => document.getElementById(id)).filter(Boolean);
      visibleAtOpen = new Set(panels.filter(shown).map(el => el.id));
      for (const el of panels) panelWatch.observe(el, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    }
    window.setShellNavActive?.('skill-plaza'); place(); renderAll();
    if (!loading) void load(stale); // 关着时后台导入/移除完成过，就强制重扫
    stale = false;
    $('.spz-search').focus({ preventScroll: true });
  }
  function close() { if (!page || page.hidden) return; panelWatch?.disconnect(); page.hidden = true; detail = null; document.body.classList.remove('skill-plaza-page-open'); }
  // 主进程在后台真正完成导入/移除时发 skill-plaza:changed：开着就强制重扫；正在操作时操作结束会自己重扫；关着就记下，下次打开强制重扫。
  ipcRenderer.on?.('skill-plaza:changed', (_event, info = {}) => {
    const key = info.op + ':' + info.id;
    if (pendingOps.has(key)) {
      // 之前回过「仍在后台进行」的操作真正结束了：按结果更新那一行提示（失败只留一行原因）
      const fromDrawer = pendingOps.get(key); pendingOps.delete(key);
      const reason = String(info.error || '原因未知').replace(/\s*\n\s*/g, '；');
      const line = info.ok ? null : { ok: false, text: '后台没有完成：' + reason };
      if (fromDrawer && detail && detail.id === info.id) detail.note = line;
      else if (line) note = line;
    } else if (busy === key) {
      earlyDone.set(key, info);
      return; // 本页正在做的同步操作自己的通知：操作收尾时会重扫，这里不重复
    }
    if (!isOpen()) { stale = true; return; }
    if (busy || loading) { pendingRefresh = true; renderAll(); return; }
    void load(true);
  });
  return { open, close, isOpen };
}

module.exports = { createSkillPlazaPage, cardAction, filterItems };
