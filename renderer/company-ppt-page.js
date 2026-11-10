'use strict';
// Functional skeleton. Final visual refinements follow the approved m5 layout.
function createCompanyPptPage({ document, window, ipcRenderer, openSession, hasSession = () => true, closeOtherPanels = () => {}, showMessage }) {
  const { pathToFileURL } = require('node:url');
  let page, status, timer, conversionId, chatId, md, searching = false, converting = false, candidates = [], selectedId = '', searched = false;
  // AI 找页（2026-11-08 用户：Hub 的 PPT 主打 Agent 搜索）：ai = 本轮 AI 检索状态；aiItems = AI 推荐；keywordState = 关键词即时检索状态。
  let materials = null;
  let ai = null, aiItems = [], keywordState = '', keywordError = '', lastQuery = '', userPicked = false, aiSignature = '', missingPolls = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 装了多个版本的 PPT Doctor（2026-11-07）：页头下方一行提示，点开是版本选择器（renderer/tool-version-picker.js）。
  const toolPicker = require('./tool-version-picker').createToolVersionPicker({ document, ipcRenderer });
  async function toolHint() {
    const slot = page?.querySelector('[data-ppt-tool-hint]');
    if (!slot) return;
    try { const s = await ipcRenderer.invoke('tool-discovery:list', { tool: 'ppt-doctor' }); slot.innerHTML = s?.ok === false ? '' : toolPicker.hintHtml(s); }
    catch { slot.innerHTML = ''; }
  }
  document.addEventListener('tool-version-changed', e => { if (e.detail?.tool === 'ppt-doctor' && page && !page.hidden) void call('ppt-status').then(r => renderStatus(r.ppt)).catch(error => notice(error.message)); });
  const fileUrl = file => file && require('node:path').isAbsolute(file) ? pathToFileURL(file).href : '';
  const call = async (action, data) => {
    const r = await ipcRenderer.invoke('company-assistant:' + action, data);
    if (r?.ok === false) throw new Error(r.error || '这一步没有完成');
    return r;
  };
  const notice = message => { if (page) page.querySelector('[data-ppt-notice]').textContent = message || ''; };
  function showReport(text, empty) {
    const report = page.querySelector('[data-ppt-report]'); report.hidden = false; report.open = !!empty;
    const body = report.querySelector('.pptw-report-body');
    try { if (!md) md = { marked: require('marked').marked, purify: require('dompurify') }; body.innerHTML = md.purify.sanitize(md.marked.parse(String(text || ''), { breaks: true, gfm: true })); }
    catch (error) { console.warn('[ppt-page] 报告排版失败，显示完整原文', error.message); body.textContent = text || ''; }
  }
  function nav() {
    const existing = document.getElementById('btn-company-ppt'); if (existing) return existing;
    const anchor = document.getElementById('btn-company-meeting') || document.getElementById('btn-company-assistant'); if (!anchor) return null;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'btn-company-ppt'; b.className = 'btn-shell-nav'; b.setAttribute('aria-label', 'PPT'); b.title = 'PPT · AI 找页与图片转可编辑';
    b.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M12 17v4m-4 0h8M7 13V8h3a2 2 0 0 1 0 4H7"/></svg></span><span class="btn-label">PPT</span>';
    anchor.after(b); b.addEventListener('click', () => { void open(); }); return b;
  }
  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'company-ppt-page'; page.className = 'company-ppt-page'; page.dataset.view = 'home'; page.hidden = true; page.setAttribute('aria-label', 'PPT 素材工作台');
    // 版式按定稿 CDCCBCC · PPT C（2026-11-04 换皮）：首屏居中检索，有结果后左结果右详情，转字三步。
    // 全部 data-ppt* 钩子与原逻辑不变；data-view / data-step 只给样式用。
    page.innerHTML = `<header class="pptw-head"><h1>PPT</h1><div class="pptw-tabs" role="tablist" aria-label="PPT 功能"><button type="button" role="tab" class="pptw-tab on" data-ppt-tab="find" aria-selected="true">找页</button><button type="button" role="tab" class="pptw-tab" data-ppt-tab="materials" aria-selected="false">素材</button></div><span class="pptw-sub" data-ppt-sub>AI 帮你找讲过的原页，把图片变成可编辑页</span><div class="pptw-head-right" data-ppt-head-slot><details class="pptw-settings"><summary>素材库设置</summary><div class="pptw-settings-pop"><b>素材文件夹</b><div data-ppt-roots></div><p class="pptw-hint">旧的 Hub 索引保留可查；新增素材文件夹后，请点「更新索引」。</p><div class="pptw-actions"><button type="button" data-ppt="folders">选择素材文件夹…</button><button type="button" data-ppt="index">更新索引</button><button type="button" data-ppt="refresh">重新检查</button><button type="button" data-ppt="doctor">选择 Doctor 程序…</button><button type="button" data-ppt="pick-index">选择已有索引…</button><button type="button" data-ppt="download">镜像下载 / 升级 Doctor</button><button type="button" data-ppt="download-backup">GitHub 备用</button></div></div></details><div class="pptw-status" data-ppt-status role="status"></div></div></header>
      <div class="pptw-scroll"><div class="pptw-body">
      <div class="pptw-guide-slot" data-ppt-guide-slot></div>
      <div class="pptw-tool-hint" data-ppt-tool-hint></div>
      <p data-ppt-notice class="pptw-notice" role="status" aria-live="polite"></p>
      <section class="pptw-workspace" data-ppt-search-panel><div class="pptw-main">
        <div class="pptw-hero"><span class="pptw-hero-kicker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z"/></svg>AI 找页</span><h2>说清这页要讲什么，AI 帮你翻遍素材库</h2><p>AI 会换几种说法检索、逐页读原文核对，再告诉你推荐哪几页、为什么；关键词命中同时即时显示</p></div>
        <form data-ppt-form class="pptw-search"><label for="company-ppt-query" class="pptw-sr">描述要找的页面</label><div class="pptw-bar"><svg class="pptw-bar-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input id="company-ppt-query" data-ppt-query autocomplete="off" placeholder="描述这页要讲什么，例如：证明 MU 配对增益的外场对比页"><label class="pptw-folder-label" for="company-ppt-folder"><span class="pptw-sr">素材范围</span><select id="company-ppt-folder" data-ppt-folder><option value="">全部素材文件夹</option></select></label><button type="submit" data-ppt-search class="pptw-btn pri pptw-ai-go" title="AI 检索 + 关键词即时命中（回车）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z"/></svg>AI 找页</button></div>
          <div class="pptw-modes"><button type="button" data-ppt="keyword" title="只按文字匹配，几秒出结果，不调用 AI">只搜关键词</button><button type="button" data-ppt="lookup">用图片找</button><button type="button" data-ppt="convert-mode">图片转可编辑</button></div>
          <div class="pptw-examples" aria-label="试试这样问"><small>试试这样问</small><button type="button" data-ppt="example" data-q="讲清 SRS 信道估计原理的那一页">讲清 SRS 信道估计原理的那一页</button><button type="button" data-ppt="example" data-q="有外场数据证明调度增益的对比页">有外场数据证明调度增益的对比页</button><button type="button" data-ppt="example" data-q="技术路线逐年演进的路标图">技术路线逐年演进的路标图</button></div></form>
        <details data-ppt-report class="pptw-report" hidden><summary>查看核验报告与引用</summary><div class="pptw-report-body"></div></details>
        <div class="pptw-results" data-ppt-results><p class="pptw-empty">描述要找的页面，AI 会读页核对后推荐。</p></div>
      </div><aside class="pptw-detail" data-ppt-detail aria-label="选中页详情"><p class="pptw-empty">选中一页，查看出处与可用操作。</p></aside></section>
      <section class="pptw-convert" data-ppt-convert-panel data-step="1" hidden><div class="pptw-conv-card">
        <div class="pptw-section-head"><h2>图片转可编辑</h2><button type="button" class="pptw-btn ghost sm" data-ppt="search-mode">返回素材</button></div>
        <ol class="pptw-stepper" aria-label="转换步骤"><li data-n="1"><span>1</span>上传图片</li><li class="pptw-stp-line" aria-hidden="true"></li><li data-n="2"><span>2</span>识别文字和图案</li><li class="pptw-stp-line" aria-hidden="true"></li><li data-n="3"><span>3</span>预览与复核</li></ol>
        <div class="pptw-drop" data-ppt-drop tabindex="0" role="button" aria-label="选择或拖入PPT图片"><span class="pptw-drop-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V5M7 9.5l5-5 5 5M5 19h14"/></svg></span><span class="pptw-drop-title">把一张 PPT 截图拖到这里，或</span><button type="button" class="pptw-btn pri" data-ppt="image">选择图片</button><small>先识别文字，再由 CodeAgent 看图修正；保留预览与复核项。</small></div>
        <div class="pptw-conversion" data-ppt-conversion></div>
      </div><aside class="pptw-conv-side" data-ppt-conv-side><h3>转换说明</h3><p>文字转成可改的文本框，图案切成可拖动的贴图。拿不准的文字和位置会列进复核项，在 PowerPoint 里对照原图检查。</p></aside></section>
      <section class="pptm" data-ppt-materials-panel hidden></section>
      </div></div>`;
    document.body.append(page);
    materials = require('./company-ppt-materials').createPptMaterials({ root: page.querySelector('[data-ppt-materials-panel]'), ipcRenderer, notice, doctorState: () => status?.state || '' });
    page.querySelector('.pptw-tabs').addEventListener('click', e => { const t = e.target.closest('[data-ppt-tab]'); if (t) tab(t.dataset.pptTab); });
    page.querySelector('[data-ppt-form]').addEventListener('submit', e => { e.preventDefault(); void search(true); }); // 回车与「AI 找页」：AI 检索 + 关键词即时命中
    page.querySelector('[data-ppt-folder]').addEventListener('change', () => { drawResults(); if (page.querySelector('[data-ppt-query]').value.trim()) void search(false); });
    page.addEventListener('click', e => { const b = e.target.closest('[data-ppt]'); if (b) { e.preventDefault(); void action(b.dataset.ppt, b).catch(err => notice(err.message)); } });
    const drop = page.querySelector('[data-ppt-drop]');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.dataset.drag = 'over'; });
    drop.addEventListener('dragleave', () => { delete drop.dataset.drag; });
    drop.addEventListener('drop', e => {
      e.preventDefault(); delete drop.dataset.drag; const file = e.dataTransfer?.files?.[0]; if (!file) return;
      try { const imagePath = require('electron').webUtils?.getPathForFile(file) || file.path; void convert(imagePath).catch(err => notice(err.message)); }
      catch (error) { notice('图片路径无法读取，请点「选择图片」：' + error.message); }
    });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === drop) { e.preventDefault(); void action('image').catch(err => notice(err.message)); } });
  }
  function place() {
    if (!page || page.hidden) return;
    const rail = document.getElementById('scene-rail'), bar = document.getElementById('app-toolbar'), footer = document.getElementById('hub-system-footer');
    Object.assign(page.style, { left: (rail?.getBoundingClientRect().right || 0) + 'px', top: (bar?.getBoundingClientRect().bottom || 0) + 'px', bottom: (footer?.getBoundingClientRect().height || 0) + 'px' });
  }
  function renderStatus(p) {
    status = p; const at = p.indexUpdatedAt ? new Date(p.indexUpdatedAt < 1e12 ? p.indexUpdatedAt * 1000 : p.indexUpdatedAt).toLocaleString('zh-CN') : '尚未更新';
    const busy = p.indexing?.state === 'indexing';
    const noIndex = !p.available || !p.pages;
    const guide = !!p.error || noIndex;
    const statusEl = page.querySelector('[data-ppt-status]');
    statusEl.dataset.state = busy ? 'indexing' : p.state || (p.available ? 'ready' : 'missing');
    // 正常时是页头右侧的状态胶囊；Doctor 缺失 / 需升级 / 出错时移到正文顶部，变成引导卡（同一个节点，检索区照常可用）。
    page.querySelector(guide ? '[data-ppt-guide-slot]' : '[data-ppt-head-slot]').append(statusEl);
    statusEl.classList.toggle('pptw-guide', guide);
    if (p.error) statusEl.removeAttribute('title');
    const download = ['missing', 'upgrade'].includes(p.state);
    statusEl.innerHTML = p.error ? `<span class="pptw-guide-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 8v8M8 10v4M16 10v4" class="cut"/></svg></span><div class="pptw-guide-copy"><strong>${esc(p.error)}</strong><p>PPT 检索和图片转可编辑都靠 PPT Doctor 在本机运行。</p></div>${window.HubErrorCard ? window.HubErrorCard.knownHtml({ area: 'ppt-doctor', title: p.error, details: p.detail || p.error }) + window.HubErrorCard.assistHtml({ area: 'ppt-doctor', title: p.error, details: p.detail || p.error }) : ''}${download ? '<div class="pptw-guide-actions"><button type="button" class="pptw-btn pri" data-ppt="doctor-install">' + (p.state === 'upgrade' ? '一键升级 Doctor' : '一键安装 Doctor') + '</button><button type="button" class="pptw-btn sec" data-ppt="download">镜像下载</button><button type="button" class="pptw-btn sec" data-ppt="download-backup">GitHub 备用</button><button type="button" class="pptw-btn ghost" data-ppt="doctor">已有程序，手动指定</button></div>' : ''}` : `<i class="pptw-dot" aria-hidden="true"></i><span>${p.doctorVersion ? 'PPT Doctor ' + esc(p.doctorVersion) : 'PPT Doctor'} · ${p.available ? `${p.files || 0}份文稿 / ${p.pages || 0}页 · 索引更新 ${esc(at)}` : '请选择素材文件夹并更新索引'}${busy ? `<br>${esc(p.indexing.message || '正在更新索引…')}` : ''}</span>`;
    if (!p.error && noIndex) statusEl.innerHTML = `<span class="pptw-guide-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 8v8M8 10v4M16 10v4" class="cut"/></svg></span><div class="pptw-guide-copy"><strong>${busy ? '正在建立素材索引' : '还没有可检索的素材索引'}</strong><p>${busy ? esc(p.indexing.message || '建好后就能找页，请稍等。') : '先选择存放 PPT 的素材文件夹，选完会自动建立索引。'}</p></div><div class="pptw-guide-actions"><button type="button" class="pptw-btn pri" data-ppt="folders"${busy ? ' disabled' : ''}>选择素材文件夹…</button></div>`;
    page.querySelector('[data-ppt-roots]').textContent = (p.roots || []).join('；') || '尚未指定素材文件夹';
    page.querySelector('[data-ppt="index"]').disabled = busy || !p.roots?.length;
    page.querySelector('[data-ppt="folders"]').disabled = busy;
    const select = page.querySelector('[data-ppt-folder]'), previous = select.value, folders = [...new Set([...(p.folders || p.roots || []), ...(previous ? [previous] : [])])];
    const optionsHtml = '<option value="">全部素材文件夹</option>' + folders.map(folder => `<option value="${esc(folder)}">${esc(folder)}</option>`).join('');
    if (select.dataset.options !== optionsHtml) { select.innerHTML = optionsHtml; select.dataset.options = optionsHtml; select.value = previous; } // 轮询时列表没变就不重建，展开的下拉框不会被收起
    if (!p.error) statusEl.title = statusEl.textContent.trim();
    void toolHint();
  }
  const folder = () => page.querySelector('[data-ppt-folder]').value;
  function inFolder(c) {
    if (!folder()) return true;
    const path = require('node:path'), relative = path.relative(folder(), (c.ref || c).path || '');
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  // 一类信息一个 Tab（2026-11-10）：找页（含图片转可编辑）/ 素材。
  function tab(name) {
    const materialsTab = name === 'materials';
    page.dataset.tab = materialsTab ? 'materials' : 'find';
    for (const b of page.querySelectorAll('[data-ppt-tab]')) { const on = b.dataset.pptTab === page.dataset.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    page.querySelector('[data-ppt-sub]').textContent = materialsTab ? '团队素材：按分类挑形状，一键插入到当前 PPT' : 'AI 帮你找讲过的原页，把图片变成可编辑页';
    page.querySelector('[data-ppt-materials-panel]').hidden = !materialsTab;
    notice('');
    if (materialsTab) { page.querySelector('[data-ppt-search-panel]').hidden = true; page.querySelector('[data-ppt-convert-panel]').hidden = true; void materials.show(); }
    else { materials.hide(); mode(page.dataset.view === 'convert'); }
  }
  function mode(convert) {
    const away = page.dataset.tab === 'materials'; // 在素材 Tab 时后台检索结果回来也不把找页面板翻出来
    page.querySelector('[data-ppt-convert-panel]').hidden = away || !convert; page.querySelector('[data-ppt-search-panel]').hidden = away || convert; page.querySelector('[data-ppt-form]').hidden = convert;
    view(convert);
    const report = page.querySelector('[data-ppt-report]'); report.hidden = convert || !report.querySelector('.pptw-report-body').textContent.trim() || !report.open;
  }
  // 样式用：还没出过结果时是居中检索首屏，出过一次结果（含零命中、AI 在找）后是左结果右详情。
  function view(convert) { page.dataset.view = convert ? 'convert' : searched ? 'results' : 'home'; }
  function results(items) { candidates = items; keywordState = 'done'; searched = true; mode(false); drawResults(); }

  // ---------------- 版式预览（2026-11-08）：Doctor 有截图缓存就用截图，否则主进程直接读 pptx 画版式（core/company-assistant/ppt-slide-preview.js）
  const previews = new Map(), previewQueue = [];
  let previewRunning = 0;
  const thumbOf = c => c?.thumbnail || null;
  function previewHtml(c, alt) {
    const image = fileUrl(thumbOf(c));
    if (image) return `<img src="${esc(image)}" alt="${esc(alt)}" loading="lazy">`;
    const p = previews.get(c?.id);
    if (p?.svg) return p.svg;
    if (p?.state === 'error') return `<span class="pptw-pv-text"><b>${esc(p.short || '没能画出版式')}</b>${c.snippet ? `<i>${esc(String(c.snippet).slice(0, 80))}</i>` : ''}</span>`;
    if (c?.id) queuePreview(c.id);
    return '<span class="pptw-pv-loading" aria-label="正在画版式预览"></span>';
  }
  // 新一轮检索：没开始画的排队项作废（新结果不用排在旧结果后面），画失败的页下次重试（例如当时文稿正在保存）。
  function resetPreviews() {
    for (const id of previewQueue.splice(0)) previews.delete(id);
    for (const [id, p] of previews) if (p.state === 'error') previews.delete(id);
  }
  function queuePreview(id) {
    if (!id || previews.has(id)) return;
    previews.set(id, { state: 'queued' }); previewQueue.push(id); pumpPreviews();
  }
  function pumpPreviews() {
    while (previewRunning < 2 && previewQueue.length) {
      const id = previewQueue.shift(); previewRunning++;
      Promise.resolve().then(() => ipcRenderer.invoke('company-assistant:ppt-preview', { id })).then(r => {
        if (r?.ok && r.scene) previews.set(id, { state: 'ok', svg: require('./ppt-slide-svg').sceneSvg(r.scene) });
        else previews.set(id, { state: 'error', short: r?.code === 'UNSUPPORTED_FORMAT' ? '旧版 .ppt，只显示文字' : r?.code === 'UNKNOWN_PAGE' ? '请重新检索' : '暂时画不出版式' });
      }).catch(() => previews.set(id, { state: 'error', short: '暂时画不出版式' })).finally(() => {
        previewRunning--; paintPreview(id); pumpPreviews();
      });
    }
  }
  function paintPreview(id) {
    if (!page) return;
    const c = allItems().find(x => x.id === id) || traceItems().find(x => x.id === id) || { id };
    for (const el of page.querySelectorAll('[data-ppt-thumb]')) if (el.dataset.pptThumb === id) el.innerHTML = previewHtml(c, '预览');
  }

  // ---------------- 结果：AI 推荐（主）+ 关键词命中（即时）
  const allItems = () => [...aiItems, ...candidates.filter(c => !aiItems.some(a => a.id === c.id))];
  const traceItems = () => (ai?.trace?.events || []).flatMap(e => e.pages || e.top || []);
  function terms(c) {
    const words = new Set([...(c.matched_queries || []).map(q => q.query), ...String(lastQuery || '').split(/\s+/)].map(w => String(w || '').trim()).filter(w => w.length >= 2 || /[一-鿿]/.test(w)));
    return [...words].sort((a, b) => b.length - a.length).slice(0, 8);
  }
  function marked(text, c) {
    let html = esc(text);
    for (const w of terms(c)) { const e = esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); html = html.replace(new RegExp(`(${e})(?![^<]*>)`, 'gi'), '<mark>$1</mark>'); }
    return html;
  }
  function card(c, isAi) {
    const ref = c.ref || c, name = ref.name || c.name || '', pageNo = ref.page ?? c.page;
    const body = isAi ? (c.reason ? `<span class="pptw-reason">${esc(c.reason)}</span>` : '') : (c.snippet ? `<span class="pptw-hit">${marked(c.snippet, c)}</span>` : '');
    return `<article class="pptw-result${c.id === selectedId ? ' selected' : ''}${isAi ? ' is-ai' : ''}" data-ppt-result><button type="button" class="pptw-select" data-ppt="select" data-id="${esc(c.id)}" aria-pressed="${c.id === selectedId}"><span class="pptw-preview" data-ppt-thumb="${esc(c.id)}">${previewHtml(c, `第${pageNo}页预览`)}</span><span class="pptw-result-copy"><strong title="${esc(name)}">${isAi ? '<i class="pptw-ai-badge">AI 推荐</i>' : ''}${esc(name)}</strong><span class="pptw-meta">第 ${esc(pageNo)} 页</span>${body}</span></button></article>`;
  }
  function drawResults() {
    const items = candidates.filter(inFolder), picks = aiItems.filter(inFolder);
    const all = [...picks, ...items.filter(c => !picks.some(p => p.id === c.id))];
    if (!all.some(c => c.id === selectedId)) selectedId = all[0]?.id || '';
    const kw = items.filter(c => !picks.some(p => p.id === c.id));
    const kwHead = `<header class="pptw-sec-head"><h3>关键词命中<span>${kw.length} 页</span></h3><small>按文字直接匹配，即时出结果；没经 AI 读页核对</small></header>`;
    const kwBody = kw.length ? `<div class="pptw-grid">${kw.map(c => card(c, false)).join('')}</div>`
      : `<p class="pptw-empty">${keywordState === 'loading' ? '正在按关键词检索…' : keywordState === 'error' ? esc(keywordError) : items.length ? '关键词命中的页都已在上面的 AI 推荐里。' : ai?.state === 'running' ? '关键词没有直接命中；AI 正在换说法继续找。' : ai ? '关键词没有直接命中。' : '本轮没有命中，可改用更短的关键词，或点「AI 找页」让 AI 换说法找。'}</p>`;
    page.querySelector('[data-ppt-results]').innerHTML = (ai ? `<section class="pptw-ai" data-ppt-ai data-state="${esc(ai.state)}">${aiHtml(picks)}</section>` : '')
      + (keywordState || candidates.length ? `<section class="pptw-kw">${kwHead}${kwBody}</section>` : '');
    detail(all.find(c => c.id === selectedId));
  }
  function seconds(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; }
  // AI 面板：步骤和数字全部来自真实调用轨迹（ppt_find / ppt_read / 报告核对），没有的就不写。
  function aiHtml(picks) {
    const ev = ai.trace?.events || [], finds = ev.filter(e => e.kind === 'find'), reads = ev.filter(e => e.kind === 'read'), report = ev.find(e => e.kind === 'report');
    const queries = [...new Set(finds.flatMap(e => e.queries || []))], hits = finds.reduce((n, e) => n + (Number(e.total) || 0), 0);
    const readPages = []; for (const e of reads) for (const p of e.pages || []) if (!readPages.some(x => x.id === p.id)) readPages.push(p);
    const chat = ai.chat || {}, running = ai.state === 'running';
    const started = chat.state === 'running' && !!chat.answeringAt;
    const stage = ai.state === 'done' ? 4 : report ? 3 : reads.length ? 2 : finds.length || started ? 1 : 0;
    const steps = [
      ['唤起 CodeAgent', stage > 0 ? '已就绪' : ai.phase ? require('./wait-progress').waitText(ai.phase) : '开会话并送入你的需求，通常 10–20 秒'],
      ['换说法多路检索', queries.length ? `试了 ${queries.length} 种说法 · 初筛 ${hits} 页` : '把需求改写成同义词、中英文、缩写'],
      ['逐页读原文', readPages.length ? `已读 ${readPages.length} 页，核对用途、数值和年份` : '读排在前面的页，确认真的讲了这件事'],
      ['核验并推荐', report ? `核对 ${report.checked} 页引用 · 推荐 ${report.recommended} 页` : '只推荐读过且原文对得上的页'],
    ];
    const elapsed = seconds((ai.endedAt || Date.now()) - ai.startedAt);
    const mark = '<span class="pptw-ai-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z"/></svg></span>';
    const head = running
      ? `<header class="pptw-ai-head">${mark}<div><h3>AI 正在帮你找<span class="pptw-dots" aria-hidden="true"><i></i><i></i><i></i></span></h3><small>「${esc(ai.query)}」 · 已用 <b data-ppt-elapsed>${elapsed}</b>，整体通常 1–3 分钟；下面的关键词命中可以先看</small></div></header>`
      : ai.state === 'error'
        ? `<header class="pptw-ai-head">${mark}<div><h3>AI 这次没找完</h3><small>${esc(ai.error || '助理检索未完成')}</small></div><button type="button" class="pptw-btn sec sm" data-ppt="ai-retry">再让 AI 找一次</button></header>`
        : `<header class="pptw-ai-head">${mark}<div><h3>AI 推荐 ${picks.length} 页<span class="pptw-ai-ok">已逐页读原文核对</span></h3><small>「${esc(ai.query)}」 · 用时 ${elapsed}${queries.length ? ` · 试了 ${queries.length} 种说法、读了 ${readPages.length} 页` : ''}</small></div>${ai.report ? '<button type="button" class="pptw-btn ghost sm" data-ppt="open-report">核验报告与原文引用</button>' : ''}</header>`;
    const flow = `<ol class="pptw-ai-steps">${steps.map(([t, d], k) => `<li class="${k < stage || ai.state === 'done' ? 'done' : k === stage && running ? 'now' : ''}"><b>${t}</b><small>${esc(d)}</small></li>`).join('')}</ol>`;
    const chips = queries.length ? `<div class="pptw-ai-queries" aria-label="AI 用过的检索说法"><small>AI 换的说法</small>${queries.slice(0, 12).map(q => `<span>${esc(q)}</span>`).join('')}</div>` : '';
    const peek = running && readPages.length ? `<div class="pptw-ai-peek"><small>AI 刚读过的页</small><div>${readPages.slice(-6).map(p => `<span class="pptw-preview" data-ppt-thumb="${esc(p.id)}" title="${esc(p.name)} · 第 ${esc(p.page)} 页">${previewHtml(p, '')}</span>`).join('')}</div></div>` : '';
    const sessionLink = ai.chat?.sessionId ? '<div class="pptw-ai-session"><button type="button" class="pptw-btn sec sm" data-ppt="ai-session">查看会话</button></div>' : '';
    if (ai.state === 'done') {
      const grid = picks.length ? `<div class="pptw-grid">${picks.map(c => card(c, true)).join('')}</div>` : '<p class="pptw-empty">读过的页里没有原文对得上的，原因见核验报告；可以换个说法再找，或先看下面的关键词命中。</p>';
      return head + sessionLink + grid + `<details class="pptw-ai-how"><summary>AI 是怎么找的</summary>${flow}${chips}</details>`;
    }
    return head + sessionLink + (ai.state === 'error' ? flow : `<div class="pptw-ai-live${running ? ' pptw-thinking' : ''}">${flow}${chips}${peek}</div>`);
  }
  function detail(c) {
    const panel = page.querySelector('[data-ppt-detail]');
    if (!c) { panel.innerHTML = `<p class="pptw-empty">${ai?.state === 'running' ? 'AI 找到后会在这里显示推荐理由；也可以先点左边的关键词命中。' : '选中一页，查看出处与可用操作。'}</p>`; return; }
    const ref = c.ref || c, pageNo = ref.page ?? c.page, dir = require('node:path').dirname(ref.path || c.path || ''), image = fileUrl(thumbOf(c));
    const isAi = aiItems.some(a => a.id === c.id), kw = candidates.find(k => k.id === c.id) || c;
    panel.innerHTML = `<div class="pptw-preview" data-ppt-thumb="${esc(c.id)}">${previewHtml(c, `选中的第${pageNo}页`)}</div><div class="pptw-dt-body"><div class="pptw-tags"><span class="pptw-tag">第 ${esc(pageNo)} 页</span>${isAi ? '<span class="pptw-tag ai">AI 推荐 · 已读原文</span>' : '<span class="pptw-tag">关键词命中</span>'}</div><h2>${esc(ref.name || c.name)}</h2>${isAi && c.reason ? `<div class="pptw-why"><b>为什么推荐</b><p>${esc(c.reason)}</p></div>` : ''}${kw.snippet ? `<div class="pptw-why plain"><b>命中原文</b><p>${marked(kw.snippet, kw)}</p></div>` : ''}<dl><dt>文件</dt><dd>${esc(ref.name || c.name)}</dd><dt>目录</dt><dd>${esc(dir)}</dd></dl>${image ? '' : '<p class="pptw-hint">预览按原稿版式绘制（不是截图），图表与特殊字体可能有出入，以打开原稿为准。</p>'}</div><div class="pptw-detail-actions"><button type="button" class="pptw-btn pri" data-ppt="open" data-id="${esc(c.id)}">打开到第 ${esc(pageNo)} 页</button><div class="pptw-row"><button type="button" class="pptw-btn sec" data-ppt="show-folder" data-id="${esc(c.id)}">所在文件夹</button><button type="button" class="pptw-btn sec" data-ppt="convert-page" data-id="${esc(c.id)}" ${image ? '' : 'disabled title="需要 PPT Doctor 里的页面截图；可打开原稿截图后用「图片转可编辑」"'}>这页图片转可编辑</button></div><button type="button" class="pptw-btn sec" data-ppt="copy" hidden data-id="${esc(c.id)}">复制到当前 PPT</button></div>`;
  }
  async function keywordSearch(query) {
    keywordState = 'loading'; keywordError = ''; candidates = []; drawResults();
    try {
      const r = await call('ppt-search', { query, folder: folder() });
      candidates = r.candidates || []; keywordState = 'done';
      if (!ai) notice(`${candidates.length} 页关键词命中，只按文字匹配。想让 AI 读页核对，点「AI 找页」。${r.errors?.length ? ' 部分查询失败：' + r.errors.map(e => e.message).join('；') : ''}${r.truncated ? ' 结果有截断，可缩小关键词范围。' : ''}`);
    } catch (error) { keywordState = 'error'; keywordError = error.message; if (!ai) notice(error.message); }
    drawResults();
  }
  // 默认（回车 /「AI 找页」）：AI 检索 + 关键词即时命中同时跑；「只搜关键词」只跑后者。
  async function search(withAgent) {
    if (!status?.available || !status.pages) { notice(status?.indexing?.state === 'indexing' ? '素材索引正在建立，请完成后再检索。' : '还没有素材索引，请先点「选择素材文件夹…」，选完会自动建立索引。'); return; }
    if (searching) return; const query = page.querySelector('[data-ppt-query]').value.trim(); if (!query) { notice('先输入要找的内容，例如“讲清 SRS 信道估计原理的那页”。'); return; }
    if (withAgent && ai?.state === 'running') { notice('上一轮 AI 还在找，完成后再发起新的；关键词检索不受影响，可点「只搜关键词」。'); return; }
    searching = true; page.querySelector('[data-ppt-search]').disabled = true; lastQuery = query; searched = true;
    const report = page.querySelector('[data-ppt-report]'); report.hidden = true; report.open = false; report.querySelector('.pptw-report-body').textContent = '';
    aiItems = []; selectedId = ''; userPicked = false; resetPreviews();
    if (!withAgent && ai?.state !== 'running') ai = null;
    mode(false); notice('');
    try {
      if (withAgent) {
        ai = { query, state: 'running', startedAt: Date.now(), chat: { state: 'queued' }, trace: null };
        drawResults();
        const asking = call('ppt-ask', { question: folder() ? `${query}\n本次只找素材目录「${folder()}」中的页面。` : query })
          .then(r => { chatId = r.item.id; ai.chatId = chatId; poll(); })
          .catch(error => { ai.state = 'error'; ai.error = error.message; ai.endedAt = Date.now(); drawResults(); });
        await Promise.all([keywordSearch(query), asking]);
      } else await keywordSearch(query);
    } finally { searching = false; page.querySelector('[data-ppt-search]').disabled = false; }
  }
  const PHASES = [['识别文字', '找出文字框与位置'], ['CodeAgent 看图修正', '核对文字、位置与公式'], ['生成可编辑 PPT', '装配文本框与贴图'], ['完成', '在 PowerPoint 中对照原图复核']];
  const PHASE_OF = { seeding: 0, running: 0, waiting_agent: 1, building: 2, done: 3 };
  function step(n, failed = false) { const panel = page.querySelector('[data-ppt-convert-panel]'); panel.dataset.step = String(n); panel.toggleAttribute('data-failed', failed); }
  function renderConversion(job) {
    page.querySelector('[data-ppt-conversion]').dataset.jobId = job.id;
    conversionId = job.id; const r = job.result, preview = fileUrl(r?.preview || job.seed?.preview), reviews = r?.reviewItems || job.seed?.reviewItems || [];
    const running = !['done', 'error'].includes(job.state), phase = PHASE_OF[job.state] ?? 0;
    step(job.state === 'done' ? 3 : 2, job.state === 'error');
    const recovery = job.needsOutputCheck ? '<p class="pptw-conv-note">本次可能已有部分产物。请先检查目录，再决定是否重试。</p><button type="button" class="pptw-btn sec" data-ppt="conversion-workdir">打开产物目录</button>' : '';
    const retryLabel = job.needsOutputCheck ? '已检查产物，让 CodeAgent 重试' : '让 CodeAgent 重试';
    // 主区：画面 + 当前状态 + 可用操作。AI 处理中画面底部才有流光（只用于 AI 思考中）。
    page.querySelector('[data-ppt-conversion]').innerHTML = `<div class="pptw-conv-main" data-conversion-state="${esc(job.state)}"><div class="pptw-conv-stage${running ? ' pptw-thinking' : ''}">${preview ? `<img class="pptw-conversion-preview" src="${esc(preview)}" alt="图片转字近似预览">` : '<span class="pptw-empty">识别完成后在这里显示预览</span>'}</div><div class="pptw-conv-status"><b class="${job.state === 'error' ? 'is-error' : ''}">${esc(job.error || job.step || job.state)}</b>${r ? `<span>已生成可编辑PPT · ${esc(r.mode === 'image_fallback' ? 'OCR与图像算法处理，尚未经Agent看图核对' : 'Agent已提交差异')} · 预览为近似效果，需在PowerPoint中复核。</span>${r.pixel_gate?.passed === false ? '<span class="is-warn">质量检查尚未通过，请核对右侧复核项。</span>' : ''}` : ''}</div><div class="pptw-conv-actions">${r ? '<button type="button" class="pptw-btn pri" data-ppt="conversion-open">打开 PPT</button>' : ''}${recovery}${job.state === 'error' && job.seed ? `<button type="button" class="pptw-btn ${job.needsOutputCheck ? 'sec' : 'pri'}" data-ppt="conversion-retry">${retryLabel}</button><button type="button" class="pptw-btn sec" data-ppt="conversion-fallback">${job.needsOutputCheck ? '已检查产物，用 OCR 初稿装配' : '先用 OCR 初稿装配'}</button>` : ''}</div></div>`;
    // 右栏：有复核项时列复核项，否则按真实状态画处理进展（不编造时间和百分比）。
    const items = reviews.map(item => esc(typeof item === 'string' ? item : item.message || item.reason || '请对照原图检查本页文字和位置'));
    page.querySelector('[data-ppt-conv-side]').innerHTML = items.length
      ? `<h3>复核项<span class="pptw-tag amber">${items.length} 项待看</span></h3><ul class="pptw-reviews">${items.map(t => `<li><i aria-hidden="true">!</i><span>${t}</span></li>`).join('')}</ul>`
      : job.state === 'error'
        ? `<h3>没有完成</h3><p>${esc(job.error || '这一步没有完成')}</p>`
        : `<h3>处理进展${running ? '<span class="pptw-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</h3><ol class="pptw-phases">${PHASES.map(([t, d], k) => `<li class="${k < phase || job.state === 'done' ? 'done' : k === phase ? 'now' : ''}"><b>${t}</b><small>${k === phase && running ? esc(job.step || d) : d}</small></li>`).join('')}</ol>`;
  }
  async function convert(imagePath) {
    if (!imagePath) throw new Error('图片路径无法读取，请点「选择图片」');
    return startConversion('ppt-imgtext-start', { imagePath });
  }
  async function startConversion(channel, args) {
    if (converting || conversionId) throw new Error('当前图片仍在处理，请等本轮完成');
    converting = true; mode(true); step(2); page.querySelector('[data-ppt-conversion]').textContent = '正在生成 OCR 初稿，通常数十秒…';
    try { const job = await call(channel, args); renderConversion(job); if (['done', 'error'].includes(job.state)) conversionId = null; poll(); }
    catch (error) { page.querySelector('[data-ppt-conversion]').textContent = error.message; throw error; }
    finally { converting = false; }
  }
  function poll() {
    clearTimeout(timer); if (!page || page.hidden) return;
    timer = setTimeout(async () => {
      try {
        if (conversionId) { const r = await call('ppt-imgtext-status', { jobId: conversionId }); renderConversion(r.job); if (['done', 'error'].includes(r.job.state)) conversionId = null; }
        if (chatId) {
          const r = await call('ppt-page-state', { chatId }); renderStatus(r.ppt);
          if (ai && ai.chatId === chatId) { ai.chat = r.chat || ai.chat; ai.trace = r.trace || ai.trace; ai.phase = require('./wait-progress').assistantChatPhase(r.chat); } // 排队 / 准备中用公共等待文案（renderer/wait-progress.js）
          if (r.chat?.state === 'done') {
            aiItems = (r.chat.pptResults || []).map(x => ({ ...x, ref: { name: x.name, path: x.path, page: x.page } })); if (!userPicked) selectedId = aiItems[0]?.id || selectedId;
            if (ai) { ai.state = 'done'; ai.endedAt = Date.now(); ai.report = !!r.chat.a; }
            showReport(r.chat.a, false); page.querySelector('[data-ppt-report]').hidden = true;
            chatId = null;
          } else if (r.chat?.state === 'error') { if (ai) { ai.state = 'error'; ai.error = r.chat.error || '助理检索未完成，请重试'; ai.endedAt = Date.now(); } chatId = null; }
          else if (!r.chat && ++missingPolls >= 4) { if (ai) { ai.state = 'error'; ai.error = '找不到这次 AI 检索的记录（可能已被清理），请再找一次'; ai.endedAt = Date.now(); } chatId = null; }
          if (r.chat) missingPolls = 0;
          // 每 1.5 秒轮询一次，但只有 AI 真的有新进展才重画结果区（避免整列重建打断点选、收起下拉框）；用时数字原地更新。
          const sig = ai ? JSON.stringify([ai.state, r.chat?.state, r.chat?.sessionId, !!r.chat?.answeringAt, ai.phase?.label, ai.trace?.events?.length || 0]) : '';
          if (sig !== aiSignature) { aiSignature = sig; drawResults(); }
          else if (ai) { const el = page.querySelector('[data-ppt-elapsed]'); if (el) el.textContent = seconds(Date.now() - ai.startedAt); }
        }
        if (status?.indexing?.state === 'indexing') renderStatus((await call('ppt-page-state')).ppt);
      } catch (error) { notice(error.message); }
      if (conversionId || chatId || status?.indexing?.state === 'indexing') poll();
    }, 1500);
  }
  async function action(name, button) {
    if (name === 'select') { selectedId = button.dataset.id; userPicked = true; drawResults(); return; }
    if (name === 'search-mode' || name === 'convert-mode') { mode(name === 'convert-mode'); return; }
    if (name === 'lookup') {
      const picked = await call('ppt-pick-image'); if (picked.canceled) return;
      button.disabled = true; notice('正在识别截图文字并查找原稿，通常数十秒。');
      try { const r = await call('ppt-lookup-frame', { imagePath: picked.imagePath, limit: 10 }); if (ai?.state !== 'running') ai = null; aiItems = []; lastQuery = ''; results(r.candidates || []); notice(r.coverage + (r.errors?.length ? '；部分索引未完成：' + r.errors.map(e => e.message).join('；') : '')); }
      finally { button.disabled = false; } return;
    }
    if (name === 'refresh') return renderStatus((await call('ppt-status')).ppt);
    if (name === 'ask' || name === 'ai-retry') return search(true);
    if (name === 'ai-session') { const id = ai?.chat?.sessionId; if (!id) return; if (!hasSession(id)) { notice('这次的会话已经关闭，没有可回看的记录；再找一次会开新的会话。'); return; } close(); return openSession?.(id); }
    if (name === 'keyword') return search(false);
    if (name === 'example') { const q = page.querySelector('[data-ppt-query]'); q.value = button.dataset.q || ''; q.focus(); return search(true); }
    if (name === 'open-report') { const report = page.querySelector('[data-ppt-report]'); report.hidden = false; report.open = true; report.scrollIntoView({ block: 'nearest' }); return; }
    if (name === 'show-folder') return call('ppt-show-folder', { id: button.dataset.id });
    if (name === 'convert-page') return startConversion('ppt-convert-page', { id: button.dataset.id });
    if (name === 'copy') {
      button.disabled = true; notice('正在复制到当前 PPT 的当前页后，通常数秒；不会自动保存。');
      try { const r = await call('ppt-copy', { id: button.dataset.id }); notice(`已复制到「${r.target}」第${r.page}页，请在目标 PPT 中检查并保存。`); }
      finally { button.disabled = false; } return;
    }
    if (name === 'open') {
      button.disabled = true; notice('正在打开原稿并定位页码，首次启动 PowerPoint 可能需要约一分钟。');
      try { const r = await call('ppt-open', { id: button.dataset.id }); notice(r.pageFocused === false ? `已打开文件，请手动查看第${r.page}页；当前环境未能自动跳页。` : `已打开到第${r.page}页。`); }
      finally { button.disabled = false; }
      return;
    }
    if (name === 'image') { const r = await call('ppt-pick-image'); if (!r.canceled) await convert(r.imagePath); return; }
    if (name === 'conversion-open') return call('ppt-imgtext-open', { jobId: lastConversionId() });
    if (name === 'conversion-workdir') return call('ppt-imgtext-workdir', { jobId: lastConversionId() });
    if (name === 'doctor-install') {
      button.disabled = true; notice('正在下载并安装 PPT Doctor，可能需要几分钟，不会动原来的安装。');
      const progress = (_event, state) => { if (state?.message) notice(state.message + (state.phase === 'downloading' && state.total > 0 && state.received > 0 ? ` ${Math.min(99, Math.floor(state.received / state.total * 100))}%` : '')); };
      ipcRenderer.on('components:doctor-state', progress);
      try {
        const r = await ipcRenderer.invoke('components:doctor-install');
        if (!r?.ok) { notice(r?.error || '安装未完成，可以重试或用镜像下载'); return; }
        notice(r.state?.message || 'PPT Doctor 已安装');
        const status = await call('ppt-status'); if (status?.ppt) renderStatus(status.ppt);
      } finally { ipcRenderer.removeListener('components:doctor-state', progress); button.disabled = false; }
      return;
    }
    if (name === 'download' || name === 'download-backup') {
      button.disabled = true; notice(name === 'download' ? '正在检查镜像安装包…' : '正在打开 GitHub 备用页面…');
      try { await call('ppt-download-doctor', { source: name === 'download' ? 'mirror' : 'github' }); notice('已打开下载入口。安装或升级后，点「重新检查」。'); }
      finally { button.disabled = false; } return;
    }
    if (name === 'conversion-retry' || name === 'conversion-fallback') { const r = await call(name === 'conversion-retry' ? 'ppt-imgtext-retry' : 'ppt-imgtext-fallback', { jobId: lastConversionId() }); renderConversion(r); poll(); return; }
    const channels = { folders: 'ppt-pick-folders', index: 'ppt-index', doctor: 'ppt-pick-doctor', 'pick-index': 'ppt-pick-index' };
    if (channels[name]) { const r = await call(channels[name]); if (r?.ppt) renderStatus(r.ppt); poll(); }
  }
  function lastConversionId() { return page.querySelector('[data-ppt-conversion]').dataset.jobId; }
  async function open() {
    build(); closeOtherPanels();
    for (const name of ['__companyAssistantHide', '__companyMeetingHide', '__companyForumHide', '__companyAttendanceHide', '__assistantHide', '__cloudHide', '__wirelessHide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    if (page.dataset.tab === 'materials') void materials.show();
    page.hidden = false; document.body.classList.add('company-ppt-page-open'); nav()?.classList.add('active'); window.setShellNavActive?.('company-ppt'); place(); window.addEventListener('resize', place);
    try { renderStatus((await call('ppt-status')).ppt); poll(); } catch (error) { notice(error.message); }
  }
  function close() { if (!page) return; materials?.hide(); page.hidden = true; document.body.classList.remove('company-ppt-page-open'); nav()?.classList.remove('active'); clearTimeout(timer); window.removeEventListener('resize', place); }
  nav(); document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-ppt)')) close(); });
  return { open, close, isOpen: () => !!page && !page.hidden, tab: name => { build(); tab(name); } };
}
module.exports = { createCompanyPptPage };
