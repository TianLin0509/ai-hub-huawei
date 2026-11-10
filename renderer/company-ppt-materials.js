'use strict';
// PPT 页「素材」Tab（2026-11-10）：按分类挑 PPT Doctor 素材库 / 团队素材包里的原生形状，一键插入到当前 PPT。
// 一屏不滚动：左分类、中网格（按可用高度算每页张数并翻页）、右详情。预览优先用 Doctor 存的 PNG，没有就读 pptx 画 SVG（只看形状本身）。
function createPptMaterials({ root, ipcRenderer, notice, doctorState = () => '' }) {
  const { pathToFileURL } = require('node:url');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fileUrl = file => { try { return file ? pathToFileURL(file).href : ''; } catch { return ''; } };
  let category = '', query = '', pageNo = 0, pageSize = 12, selectedId = '', data = null, loading = null, emptyTimer = null, shown = false;
  const previews = new Map(), queue = [];
  let running = 0;
  const call = async (action, args) => {
    const r = await ipcRenderer.invoke('company-assistant:' + action, args);
    if (r?.ok === false) throw new Error(r.error || '这一步没有完成');
    return r;
  };

  root.innerHTML = `<nav class="pptm-cats" data-pptm-cats aria-label="素材分类"></nav>
    <div class="pptm-main"><div class="pptm-bar"><div class="pptw-bar pptm-search"><svg class="pptw-bar-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label class="pptw-sr" for="company-ppt-material-query">按名称筛选素材</label><input id="company-ppt-material-query" data-pptm-query autocomplete="off" placeholder="按名称筛选，例如：栏头、箭头、光带"></div><span class="pptm-count" data-pptm-count></span><button type="button" class="pptw-btn ghost sm" data-pptm="pack" title="直接打开团队素材包（.pptx），不导入 Doctor 也能用">打开素材包…</button><button type="button" class="pptw-btn ghost sm" data-pptm="refresh">刷新</button></div>
    <div class="pptm-grid" data-pptm-grid></div><div class="pptm-pager" data-pptm-pager></div></div>
    <aside class="pptm-detail" data-pptm-detail aria-label="选中素材"></aside>`;
  const $ = sel => root.querySelector(sel);

  // ---- 预览：Doctor 的 PNG > pptx 读出来画的 SVG（fit 到形状外框）
  function thumbHtml(item) {
    if (item.preview) return `<img src="${esc(fileUrl(item.preview))}" alt="" loading="lazy">`;
    const p = previews.get(item.id);
    if (p?.svg) return p.svg;
    if (p?.state === 'error') return '<span class="pptm-pv-err">画不出预览</span>';
    if (!p) { previews.set(item.id, { state: 'queued' }); queue.push(item.id); pump(); }
    return '<span class="pptw-pv-loading" aria-label="正在画预览"></span>';
  }
  function pump() {
    while (running < 3 && queue.length) {
      const id = queue.shift(); running++;
      Promise.resolve().then(() => ipcRenderer.invoke('company-assistant:ppt-material-preview', { id })).then(r => {
        previews.set(id, r?.ok && r.scene ? { state: 'ok', svg: require('./ppt-slide-svg').sceneSvg(r.scene, { fit: true, title: '素材预览' }) } : { state: 'error' });
      }).catch(() => previews.set(id, { state: 'error' })).finally(() => {
        running--;
        for (const el of root.querySelectorAll('[data-pptm-thumb]')) if (el.dataset.pptmThumb === id) { const it = itemOf(id); if (it) el.innerHTML = thumbHtml(it); }
        pump();
      });
    }
  }
  const itemOf = id => data?.items.find(i => i.id === id);

  // ---- 一屏分页：网格可用高宽决定每页几张，窗口变了重算
  function measure() {
    const grid = $('[data-pptm-grid]');
    const w = grid.clientWidth, h = grid.clientHeight;
    if (!w || !h) return pageSize;
    const cols = Math.max(1, Math.floor((w + 12) / (168 + 12))), rows = Math.max(1, Math.floor((h + 12) / (128 + 12)));
    return cols * rows;
  }
  function drawCats() {
    const cats = data?.categories || [], total = data?.library?.total || 0;
    $('[data-pptm-cats]').innerHTML = cats.length ? `<b class="pptm-cats-title">分类</b>` + [{ name: '', count: total }, ...cats].map(c => `<button type="button" class="pptm-cat${c.name === category ? ' on' : ''}" data-pptm="cat" data-cat="${esc(c.name)}" aria-pressed="${c.name === category}"><span>${esc(c.name || '全部')}</span><i>${c.count}</i></button>`).join('') : '';
  }
  function emptyHtml() {
    const lib = data?.library || {}, state = doctorState();
    const errors = (lib.errors || []).length ? `<p class="pptm-err">${esc(lib.errors.join('；'))}</p>` : '';
    if (query || category) return `<p class="pptw-empty">没有符合条件的素材，换个词或点「全部」。</p>`;
    const doctorBtn = ['missing', 'upgrade'].includes(state)
      ? `<button type="button" class="pptw-btn pri" data-ppt="doctor-install">${state === 'upgrade' ? '一键升级 PPT Doctor' : '一键安装 PPT Doctor'}</button>`
      : '<button type="button" class="pptw-btn pri" data-pptm="open-doctor">打开 PPT Doctor 下载团队素材包</button>';
    return `<div class="pptm-guide"><span class="pptw-guide-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="3.5"/><path d="M3 15h8l-2 5H5z"/><path d="M13 14h8v6h-8z"/></svg></span><div class="pptw-guide-copy"><strong>还没有团队素材</strong><p>团队素材包是整理好的常用原生形状：栏头、光带、箭头、编号、卡片等。在 PPT Doctor 的组件里下载并导入后，这里会自动出现，按分类挑选、一键插入到当前 PPT。</p>${errors}</div><div class="pptw-guide-actions">${doctorBtn}<button type="button" class="pptw-btn sec" data-pptm="pack">已有素材包文件，直接打开…</button></div></div>`;
  }
  function draw() {
    if (!data) return;
    drawCats();
    const lib = data.library || {}, hasAny = lib.total > 0;
    root.dataset.empty = hasAny ? '0' : '1';
    $('[data-pptm-count]').textContent = hasAny ? `${data.total} 个${category || query ? '符合' : ''}素材${lib.packs?.length ? ` · 含 ${lib.packs.length} 个素材包` : ''}` : '';
    pageSize = measure();
    const pages = Math.max(1, Math.ceil(data.total / pageSize));
    pageNo = Math.min(pageNo, pages - 1);
    const items = data.items.slice(pageNo * pageSize, pageNo * pageSize + pageSize);
    $('[data-pptm-grid]').innerHTML = items.length ? items.map(it => `<button type="button" class="pptm-card${it.id === selectedId ? ' on' : ''}" data-pptm="pick" data-id="${esc(it.id)}" title="${esc(it.name)} · ${esc(it.category)}"><span class="pptm-thumb" data-pptm-thumb="${esc(it.id)}">${thumbHtml(it)}</span><span class="pptm-name">${esc(it.name)}</span></button>`).join('') : emptyHtml();
    $('[data-pptm-pager]').innerHTML = data.total > pageSize ? `<button type="button" class="pptw-btn ghost sm" data-pptm="prev"${pageNo ? '' : ' disabled'} aria-label="上一页">‹ 上一页</button><span>${pageNo + 1} / ${pages}</span><button type="button" class="pptw-btn ghost sm" data-pptm="next"${pageNo < pages - 1 ? '' : ' disabled'} aria-label="下一页">下一页 ›</button>` : '';
    detail();
    clearTimeout(emptyTimer);
    // 空库时每 5 秒看一眼：用户在 Doctor 里导入完，回到这里不用手动刷新。
    if (!hasAny && shown) emptyTimer = setTimeout(() => { if (shown) void load({ force: true }); }, 5000);
  }
  function detail() {
    const panel = $('[data-pptm-detail]'), it = itemOf(selectedId);
    if (!it) { panel.innerHTML = `<p class="pptw-empty">${data?.library?.total ? '选中一个素材，查看大图并插入到当前 PPT。' : '装好素材后，选中即可预览和插入。'}</p>`; return; }
    const source = it.source === 'doctor' ? 'PPT Doctor 素材库' : '素材包 · ' + (String(it.pptx).split(/[\\/]/).pop());
    panel.innerHTML = `<div class="pptm-big" data-pptm-thumb="${esc(it.id)}">${thumbHtml(it)}</div><div class="pptw-dt-body"><div class="pptw-tags"><span class="pptw-tag">${esc(it.category)}</span></div><h2>${esc(it.name)}</h2><dl><dt>来源</dt><dd>${esc(source)}</dd></dl><p class="pptw-hint">插入会贴到 PowerPoint 当前打开文稿的当前页，形状保持可编辑；同时留在剪贴板，可再按 Ctrl+V。不会自动保存。</p></div><div class="pptw-detail-actions"><button type="button" class="pptw-btn pri" data-pptm="insert" data-id="${esc(it.id)}">插入到当前 PPT</button><button type="button" class="pptw-btn sec" data-pptm="copy" data-id="${esc(it.id)}">复制形状（到别处粘贴）</button></div>`;
  }
  async function load({ force = false } = {}) {
    const job = (async () => {
      const r = await call('ppt-materials', { query, category, limit: 2000, force });
      data = r;
      if (category && !r.categories.some(c => c.name === category)) { category = ''; return load(); }
      if (!selectedId || !itemOf(selectedId)) selectedId = r.items[0]?.id || '';
      draw();
    })();
    loading = job;
    try { await job; } finally { if (loading === job) loading = null; }
  }
  let filterTimer = null;
  $('[data-pptm-query]').addEventListener('input', e => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { query = e.target.value.trim(); pageNo = 0; void load().catch(err => notice(err.message)); }, 150); });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pptm]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    void act(b.dataset.pptm, b).catch(err => notice(err.message));
  });
  async function act(name, b) {
    if (name === 'cat') { category = b.dataset.cat || ''; pageNo = 0; selectedId = ''; return load(); }
    if (name === 'pick') { selectedId = b.dataset.id; for (const c of root.querySelectorAll('.pptm-card')) c.classList.toggle('on', c.dataset.id === selectedId); detail(); return; }
    if (name === 'prev' || name === 'next') { pageNo += name === 'next' ? 1 : -1; draw(); return; }
    if (name === 'refresh') { previews.clear(); await load({ force: true }); notice('素材库已刷新。'); return; }
    if (name === 'pack') { const r = await call('ppt-material-pick-pack'); if (r.canceled) return; notice(`已打开素材包，读到 ${r.added} 个素材。`); category = ''; pageNo = 0; return load({ force: true }); }
    if (name === 'open-doctor') { b.disabled = true; try { await call('ppt-open-doctor'); notice('已打开 PPT Doctor：在「组件」里下载团队素材包，导入完成后这里会自动出现。'); } finally { b.disabled = false; } return; }
    if (name === 'insert' || name === 'copy') {
      const it = itemOf(b.dataset.id); b.disabled = true;
      notice(name === 'insert' ? `正在把「${it?.name || '素材'}」插入到当前 PPT…` : `正在复制「${it?.name || '素材'}」…`);
      try {
        const r = await call(name === 'insert' ? 'ppt-material-insert' : 'ppt-material-copy', { id: b.dataset.id });
        notice(name === 'insert' ? `已插入到「${r.target}」第 ${r.page} 页（${r.count} 个形状），请在 PowerPoint 里调整位置并保存。` : '已复制为 PowerPoint 原生形状，到目标页按 Ctrl+V 粘贴。');
      } finally { b.disabled = false; }
    }
  }
  // 把素材包 pptx 拖进来也能打开。
  root.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); root.dataset.drag = 'over'; } });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) delete root.dataset.drag; });
  root.addEventListener('drop', e => {
    const file = e.dataTransfer?.files?.[0]; delete root.dataset.drag;
    if (!file) return; e.preventDefault();
    let filePath = '';
    try { filePath = require('electron').webUtils?.getPathForFile(file) || file.path; } catch { filePath = file.path || ''; }
    if (!/\.pptx$/i.test(filePath)) { notice('请拖入团队素材包（.pptx）'); return; }
    void call('ppt-material-pick-pack', { file: filePath }).then(r => { notice(`已打开素材包，读到 ${r.added} 个素材。`); category = ''; pageNo = 0; return load({ force: true }); }).catch(err => notice(err.message));
  });
  let resizeTimer = null;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (shown && data && measure() !== pageSize) draw(); }, 120); };
  return {
    async show() { shown = true; window.addEventListener('resize', onResize); try { await load({ force: !data }); } catch (error) { notice(error.message); } },
    hide() { shown = false; clearTimeout(emptyTimer); window.removeEventListener('resize', onResize); },
  };
}
module.exports = { createPptMaterials };
