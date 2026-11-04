'use strict';
// Functional skeleton. Final visual refinements follow the approved m5 layout.
function createCompanyPptPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  const { pathToFileURL } = require('node:url');
  let page, status, timer, conversionId, chatId, md, searching = false, converting = false, candidates = [], selectedId = '', searched = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    const b = document.createElement('button'); b.type = 'button'; b.id = 'btn-company-ppt'; b.className = 'btn-shell-nav'; b.setAttribute('aria-label', 'PPT'); b.title = 'PPT · 搜索素材与图片转可编辑';
    b.innerHTML = '<span class="btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M12 17v4m-4 0h8M7 13V8h3a2 2 0 0 1 0 4H7"/></svg></span><span class="btn-label">PPT</span>';
    anchor.after(b); b.addEventListener('click', () => { void open(); }); return b;
  }
  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'company-ppt-page'; page.className = 'company-ppt-page'; page.dataset.view = 'home'; page.hidden = true; page.setAttribute('aria-label', 'PPT 素材工作台');
    // 版式按定稿 CDCCBCC · PPT C（2026-11-04 换皮）：首屏居中检索，有结果后左结果右详情，转字三步。
    // 全部 data-ppt* 钩子与原逻辑不变；data-view / data-step 只给样式用。
    page.innerHTML = `<header class="pptw-head"><h1>PPT</h1><span class="pptw-sub">查原稿，把图片变成可编辑页</span><div class="pptw-head-right" data-ppt-head-slot><details class="pptw-settings"><summary>素材库设置</summary><div class="pptw-settings-pop"><b>素材文件夹</b><div data-ppt-roots></div><p class="pptw-hint">旧的 Hub 索引保留可查；新增素材文件夹后，请点「更新索引」。</p><div class="pptw-actions"><button type="button" data-ppt="folders">选择素材文件夹…</button><button type="button" data-ppt="index">更新索引</button><button type="button" data-ppt="refresh">重新检查</button><button type="button" data-ppt="doctor">选择 Doctor 程序…</button><button type="button" data-ppt="pick-index">选择已有索引…</button><button type="button" data-ppt="download">镜像下载 / 升级 Doctor</button><button type="button" data-ppt="download-backup">GitHub 备用</button></div></div></details><div class="pptw-status" data-ppt-status role="status"></div></div></header>
      <div class="pptw-scroll"><div class="pptw-body">
      <div class="pptw-guide-slot" data-ppt-guide-slot></div>
      <p data-ppt-notice class="pptw-notice" role="status" aria-live="polite"></p>
      <section class="pptw-workspace" data-ppt-search-panel><div class="pptw-main">
        <div class="pptw-hero"><h2>找一页讲过的 PPT</h2><p>搜标题、正文，或者直接描述“这页要讲清什么”</p></div>
        <form data-ppt-form class="pptw-search"><label for="company-ppt-query" class="pptw-sr">查找素材</label><div class="pptw-bar"><svg class="pptw-bar-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input id="company-ppt-query" data-ppt-query autocomplete="off" placeholder="搜索标题、正文关键词，或描述这页要讲什么"><label class="pptw-folder-label" for="company-ppt-folder"><span class="pptw-sr">素材范围</span><select id="company-ppt-folder" data-ppt-folder><option value="">全部素材文件夹</option></select></label><button type="submit" data-ppt-search class="pptw-btn pri">检索</button></div>
          <div class="pptw-modes"><button type="button" data-ppt="lookup">用图片找</button><button type="button" data-ppt="ask">让助理按用途找</button><button type="button" data-ppt="convert-mode">图片转可编辑</button></div></form>
        <details data-ppt-report class="pptw-report" hidden><summary>查看核验报告与引用</summary><div class="pptw-report-body"></div></details>
        <div class="pptw-results" data-ppt-results><p class="pptw-empty">输入关键词，查看素材原页。</p></div>
      </div><aside class="pptw-detail" data-ppt-detail aria-label="选中页详情"><p class="pptw-empty">选中一页，查看出处与可用操作。</p></aside></section>
      <section class="pptw-convert" data-ppt-convert-panel data-step="1" hidden><div class="pptw-conv-card">
        <div class="pptw-section-head"><h2>图片转可编辑</h2><button type="button" class="pptw-btn ghost sm" data-ppt="search-mode">返回素材</button></div>
        <ol class="pptw-stepper" aria-label="转换步骤"><li data-n="1"><span>1</span>上传图片</li><li class="pptw-stp-line" aria-hidden="true"></li><li data-n="2"><span>2</span>识别文字和图案</li><li class="pptw-stp-line" aria-hidden="true"></li><li data-n="3"><span>3</span>预览与复核</li></ol>
        <div class="pptw-drop" data-ppt-drop tabindex="0" role="button" aria-label="选择或拖入PPT图片"><span class="pptw-drop-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V5M7 9.5l5-5 5 5M5 19h14"/></svg></span><span class="pptw-drop-title">把一张 PPT 截图拖到这里，或</span><button type="button" class="pptw-btn pri" data-ppt="image">选择图片</button><small>先识别文字，再由 CodeAgent 看图修正；保留预览与复核项。</small></div>
        <div class="pptw-conversion" data-ppt-conversion></div>
      </div><aside class="pptw-conv-side" data-ppt-conv-side><h3>转换说明</h3><p>文字转成可改的文本框，图案切成可拖动的贴图。拿不准的文字和位置会列进复核项，在 PowerPoint 里对照原图检查。</p></aside></section>
      </div></div>`;
    document.body.append(page);
    page.querySelector('[data-ppt-form]').addEventListener('submit', e => { e.preventDefault(); void search(false); });
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
    const statusEl = page.querySelector('[data-ppt-status]');
    statusEl.dataset.state = busy ? 'indexing' : p.state || (p.available ? 'ready' : 'missing');
    // 正常时是页头右侧的状态胶囊；Doctor 缺失 / 需升级 / 出错时移到正文顶部，变成引导卡（同一个节点，检索区照常可用）。
    page.querySelector(p.error ? '[data-ppt-guide-slot]' : '[data-ppt-head-slot]').append(statusEl);
    statusEl.classList.toggle('pptw-guide', !!p.error);
    if (p.error) statusEl.removeAttribute('title');
    const download = ['missing', 'upgrade'].includes(p.state);
    statusEl.innerHTML = p.error ? `<span class="pptw-guide-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l9 5v8l-9 5-9-5V8z"/><path d="M12 8v8M8 10v4M16 10v4" class="cut"/></svg></span><div class="pptw-guide-copy"><strong>${esc(p.error)}</strong><p>PPT 检索和图片转可编辑都靠 PPT Doctor 在本机运行。</p></div>${download ? '<div class="pptw-guide-actions"><button type="button" class="pptw-btn pri" data-ppt="download">镜像下载 / 升级 Doctor</button><button type="button" class="pptw-btn sec" data-ppt="download-backup">GitHub 备用</button><button type="button" class="pptw-btn ghost" data-ppt="doctor">已有程序，手动指定</button></div>' : ''}` : `<i class="pptw-dot" aria-hidden="true"></i><span>${p.doctorVersion ? 'PPT Doctor ' + esc(p.doctorVersion) : 'PPT Doctor'} · ${p.available ? `${p.files || 0}份文稿 / ${p.pages || 0}页 · 索引更新 ${esc(at)}` : '请选择素材文件夹并更新索引'}${busy ? `<br>${esc(p.indexing.message || '正在更新索引…')}` : ''}</span>`;
    page.querySelector('[data-ppt-roots]').textContent = (p.roots || []).join('；') || '尚未指定素材文件夹';
    page.querySelector('[data-ppt="index"]').disabled = busy || !p.roots?.length;
    page.querySelector('[data-ppt="folders"]').disabled = busy;
    const select = page.querySelector('[data-ppt-folder]'), previous = select.value, folders = [...new Set([...(p.folders || p.roots || []), ...(previous ? [previous] : [])])];
    select.innerHTML = '<option value="">全部素材文件夹</option>' + folders.map(folder => `<option value="${esc(folder)}">${esc(folder)}</option>`).join(''); select.value = previous;
    if (!p.error) statusEl.title = statusEl.textContent.trim();
  }
  const folder = () => page.querySelector('[data-ppt-folder]').value;
  function inFolder(c) {
    if (!folder()) return true;
    const path = require('node:path'), relative = path.relative(folder(), (c.ref || c).path || '');
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  function mode(convert) {
    page.querySelector('[data-ppt-convert-panel]').hidden = !convert; page.querySelector('[data-ppt-search-panel]').hidden = convert; page.querySelector('[data-ppt-form]').hidden = convert;
    view(convert);
    const report = page.querySelector('[data-ppt-report]'); report.hidden = convert || !report.querySelector('.pptw-report-body').textContent.trim();
  }
  // 样式用：还没出过结果时是居中检索首屏，出过一次结果（含零命中）后是左结果右详情。
  function view(convert) { page.dataset.view = convert ? 'convert' : searched ? 'results' : 'home'; }
  function results(items) { candidates = items; searched = true; mode(false); drawResults(); }
  function drawResults() {
    const items = candidates.filter(inFolder); if (!items.some(c => c.id === selectedId)) selectedId = items[0]?.id || '';
    page.querySelector('[data-ppt-results]').innerHTML = items.length ? items.map(c => {
      const ref = c.ref || c, image = fileUrl(c.thumbnail);
      return `<article class="pptw-result${c.id === selectedId ? ' selected' : ''}" data-ppt-result><button type="button" class="pptw-select" data-ppt="select" data-id="${esc(c.id)}" aria-pressed="${c.id === selectedId}"><span class="pptw-preview">${image ? `<img src="${esc(image)}" alt="第${esc(ref.page)}页缩略图" loading="lazy">` : '<span>暂无缓存预览</span>'}</span><span class="pptw-result-copy"><strong>${esc(c.title || ref.name || c.name)}</strong><span>${esc(ref.name || c.name)} · 第 ${esc(ref.page)} 页</span></span></button></article>`;
    }).join('') : '<p class="pptw-empty">本轮没有命中，可改用更短的关键词，或让助理按用途扩展查询。</p>';
    detail(items.find(c => c.id === selectedId));
  }
  function detail(c) {
    const panel = page.querySelector('[data-ppt-detail]');
    if (!c) { panel.innerHTML = '<p class="pptw-empty">选中一页，查看出处与可用操作。</p>'; return; }
    const ref = c.ref || c, image = fileUrl(c.thumbnail), dir = require('node:path').dirname(ref.path || '');
    panel.innerHTML = `<div class="pptw-preview">${image ? `<img src="${esc(image)}" alt="选中的第${esc(ref.page)}页">` : '<span>暂无缓存预览</span>'}</div><div class="pptw-dt-body"><div class="pptw-tags"><span class="pptw-tag">第 ${esc(ref.page)} 页</span></div><h2>${esc(c.title || ref.name || c.name)}</h2><dl><dt>文件</dt><dd>${esc(ref.name || c.name)}</dd><dt>位置</dt><dd>第 ${esc(ref.page)} 页</dd><dt>目录</dt><dd>${esc(dir)}</dd></dl>${c.reason || c.snippet ? `<p class="pptw-snippet">${esc(c.reason || c.snippet)}</p>` : ''}${image ? '' : '<p class="pptw-hint">这页暂无缓存图片，可打开原稿截图后转字。</p>'}</div><div class="pptw-detail-actions"><button type="button" class="pptw-btn pri" data-ppt="open" data-id="${esc(c.id)}">打开到第 ${esc(ref.page)} 页</button><div class="pptw-row"><button type="button" class="pptw-btn sec" data-ppt="show-folder" data-id="${esc(c.id)}">所在文件夹</button><button type="button" class="pptw-btn sec" data-ppt="convert-page" data-id="${esc(c.id)}" ${image ? '' : 'disabled'}>这页图片转可编辑</button></div><button type="button" class="pptw-btn sec" data-ppt="copy" hidden data-id="${esc(c.id)}">复制到当前 PPT</button></div>`;
  }
  async function search(withAgent) {
    if (searching) return; const query = page.querySelector('[data-ppt-query]').value.trim(); if (!query) { notice('先输入关键词或描述要讲清的内容。'); return; }
    searching = true; page.querySelector('[data-ppt-search]').disabled = true;
    page.querySelector('[data-ppt-report]').hidden = true;
    notice(withAgent ? '已交给 CodeAgent 按用途检索，通常1–3分钟。' : '正在检索，单个索引最多等待30秒。');
    try {
      if (withAgent) { const r = await call('ppt-ask', { question: folder() ? `${query}\n本次只找素材目录「${folder()}」中的页面。` : query }); chatId = r.item.id; poll(); }
      else { chatId = null; const r = await call('ppt-search', { query, folder: folder() }); results(r.candidates || []); notice(`${r.candidates?.length || 0}页候选；只检索已提取文字，图表与版式尚未核查。${r.errors?.length ? ' 部分查询失败：' + r.errors.map(e => e.message).join('；') : ''}${r.truncated ? ' 结果有截断，可缩小关键词范围。' : ''}`); }
    } catch (error) { notice(error.message); }
    finally { searching = false; page.querySelector('[data-ppt-search]').disabled = false; }
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
        if (chatId) { const r = await call('ppt-page-state', { chatId }); renderStatus(r.ppt); if (r.chat?.state === 'done') { const items = r.chat.pptResults || []; results(items); showReport(r.chat.a, !items.length); notice(items.length ? `助理核验完成 · ${items.length}页候选。适用条件与原文引用见核验报告。` : '本轮未给出已核验候选，原因见下方报告。'); chatId = null; } else if (r.chat?.state === 'error') { notice(r.chat.error || '助理检索未完成，请重试'); chatId = null; } }
        if (status?.indexing?.state === 'indexing') renderStatus((await call('ppt-page-state')).ppt);
      } catch (error) { notice(error.message); }
      if (conversionId || chatId || status?.indexing?.state === 'indexing') poll();
    }, 1500);
  }
  async function action(name, button) {
    if (name === 'select') { selectedId = button.dataset.id; drawResults(); return; }
    if (name === 'search-mode' || name === 'convert-mode') { mode(name === 'convert-mode'); return; }
    if (name === 'lookup') {
      const picked = await call('ppt-pick-image'); if (picked.canceled) return;
      button.disabled = true; notice('正在识别截图文字并查找原稿，通常数十秒。');
      try { const r = await call('ppt-lookup-frame', { imagePath: picked.imagePath, limit: 10 }); results(r.candidates || []); notice(r.coverage + (r.errors?.length ? '；部分索引未完成：' + r.errors.map(e => e.message).join('；') : '')); }
      finally { button.disabled = false; } return;
    }
    if (name === 'refresh') return renderStatus((await call('ppt-status')).ppt);
    if (name === 'ask') return search(true);
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
    for (const name of ['__companyAssistantHide', '__companyMeetingHide', '__companyForumHide', '__assistantHide', '__cloudHide', '__wirelessHide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[name]?.();
    page.hidden = false; document.body.classList.add('company-ppt-page-open'); nav()?.classList.add('active'); window.setShellNavActive?.('company-ppt'); place(); window.addEventListener('resize', place);
    try { renderStatus((await call('ppt-status')).ppt); poll(); } catch (error) { notice(error.message); }
  }
  function close() { if (!page) return; page.hidden = true; document.body.classList.remove('company-ppt-page-open'); nav()?.classList.remove('active'); clearTimeout(timer); window.removeEventListener('resize', place); }
  nav(); document.addEventListener('click', e => { if (page && !page.hidden && e.target.closest('#scene-rail button:not(#btn-company-ppt)')) close(); });
  return { open, close, isOpen: () => !!page && !page.hidden };
}
module.exports = { createCompanyPptPage };
