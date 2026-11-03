'use strict';
// Functional skeleton. Final visual refinements follow the approved m5 layout.
function createCompanyPptPage({ document, window, ipcRenderer, closeOtherPanels = () => {}, showMessage }) {
  const { pathToFileURL } = require('node:url');
  let page, status, timer, conversionId, chatId, md, searching = false, converting = false, candidates = [], selectedId = '';
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
    page = document.createElement('section'); page.id = 'company-ppt-page'; page.className = 'company-ppt-page'; page.hidden = true; page.setAttribute('aria-label', 'PPT 素材工作台');
    page.innerHTML = `<header class="pptw-head"><h1>PPT</h1><span>查找原稿，把图片变成可编辑页</span><button type="button" data-ppt="lookup">用图片找</button><button type="button" data-ppt="convert-mode">图片转可编辑</button></header>
      <div class="pptw-scroll"><div class="pptw-body">
      <div class="pptw-status" data-ppt-status role="status"></div>
      <details class="pptw-settings"><summary>素材库设置</summary><div data-ppt-roots></div><p class="pptw-hint">旧的 Hub 索引保留可查；新增素材文件夹后，请点「更新索引」。</p><div class="pptw-actions"><button type="button" data-ppt="folders">选择素材文件夹…</button><button type="button" data-ppt="index">更新索引</button><button type="button" data-ppt="refresh">重新检查</button><button type="button" data-ppt="doctor">选择 Doctor 程序…</button><button type="button" data-ppt="pick-index">选择已有索引…</button><button type="button" data-ppt="download">镜像下载 / 升级 Doctor</button><button type="button" data-ppt="download-backup">GitHub 备用</button></div></details>
      <form data-ppt-form class="pptw-search"><label for="company-ppt-query">查找素材</label><div><input id="company-ppt-query" data-ppt-query autocomplete="off" placeholder="搜索标题、正文关键词，或描述这页要讲什么"><button type="submit" data-ppt-search class="primary">检索</button><button type="button" data-ppt="ask">让助理按用途找</button></div><label class="pptw-folder-label" for="company-ppt-folder">素材范围 <select id="company-ppt-folder" data-ppt-folder><option value="">全部素材文件夹</option></select></label></form>
      <p data-ppt-notice class="pptw-notice" role="status" aria-live="polite"></p>
      <details data-ppt-report class="pptw-report" hidden><summary>查看核验报告与引用</summary><div class="pptw-report-body"></div></details>
      <section class="pptw-workspace" data-ppt-search-panel><div class="pptw-results" data-ppt-results><p class="pptw-empty">输入关键词，查看素材原页。</p></div><aside class="pptw-detail" data-ppt-detail aria-label="选中页详情"><p class="pptw-empty">选中一页，查看出处与可用操作。</p></aside></section>
      <section class="pptw-convert" data-ppt-convert-panel hidden><div class="pptw-section-head"><h2>图片转可编辑</h2><button type="button" data-ppt="search-mode">返回素材</button></div><div class="pptw-drop" data-ppt-drop tabindex="0" role="button" aria-label="选择或拖入PPT图片">把一张 PPT 截图拖到这里，或<button type="button" data-ppt="image">选择图片</button><small>先识别文字，再由 CodeAgent 看图修正；保留预览与复核项。</small></div><div data-ppt-conversion></div></section>
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
    page.querySelector('[data-ppt-status]').dataset.state = busy ? 'indexing' : p.state || (p.available ? 'ready' : 'missing');
    page.querySelector('[data-ppt-status]').innerHTML = p.error ? `<strong>${esc(p.error)}</strong>${['missing', 'upgrade'].includes(p.state) ? ' <button type="button" data-ppt="download">镜像下载 / 升级 Doctor</button> <button type="button" data-ppt="download-backup">GitHub 备用</button>' : ''}` : `${p.doctorVersion ? 'PPT Doctor ' + esc(p.doctorVersion) : 'PPT Doctor'} · ${p.available ? `${p.files || 0}份文稿 / ${p.pages || 0}页 · 索引更新 ${esc(at)}` : '请选择素材文件夹并更新索引'}${busy ? `<br>${esc(p.indexing.message || '正在更新索引…')}` : ''}`;
    page.querySelector('[data-ppt-roots]').textContent = (p.roots || []).join('；') || '尚未指定素材文件夹';
    page.querySelector('[data-ppt="index"]').disabled = busy || !p.roots?.length;
    page.querySelector('[data-ppt="folders"]').disabled = busy;
    const select = page.querySelector('[data-ppt-folder]'), previous = select.value, folders = [...new Set([...(p.folders || p.roots || []), ...(previous ? [previous] : [])])];
    select.innerHTML = '<option value="">全部素材文件夹</option>' + folders.map(folder => `<option value="${esc(folder)}">${esc(folder)}</option>`).join(''); select.value = previous;
  }
  const folder = () => page.querySelector('[data-ppt-folder]').value;
  function inFolder(c) {
    if (!folder()) return true;
    const path = require('node:path'), relative = path.relative(folder(), (c.ref || c).path || '');
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  function mode(convert) {
    page.querySelector('[data-ppt-convert-panel]').hidden = !convert; page.querySelector('[data-ppt-search-panel]').hidden = convert; page.querySelector('[data-ppt-form]').hidden = convert;
    const report = page.querySelector('[data-ppt-report]'); report.hidden = convert || !report.querySelector('.pptw-report-body').textContent.trim();
  }
  function results(items) { candidates = items; mode(false); drawResults(); }
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
    panel.innerHTML = `<div class="pptw-preview">${image ? `<img src="${esc(image)}" alt="选中的第${esc(ref.page)}页">` : '<span>暂无缓存预览</span>'}</div><h2>${esc(c.title || ref.name || c.name)}</h2><dl><dt>文件</dt><dd>${esc(ref.name || c.name)}</dd><dt>位置</dt><dd>第 ${esc(ref.page)} 页</dd><dt>目录</dt><dd>${esc(dir)}</dd></dl><p class="pptw-snippet">${esc(c.reason || c.snippet || '')}</p><div class="pptw-detail-actions"><button type="button" class="primary" data-ppt="open" data-id="${esc(c.id)}">打开到第 ${esc(ref.page)} 页</button><button type="button" data-ppt="show-folder" data-id="${esc(c.id)}">所在文件夹</button><button type="button" data-ppt="copy" hidden data-id="${esc(c.id)}">复制到当前 PPT</button><button type="button" data-ppt="convert-page" data-id="${esc(c.id)}" ${image ? '' : 'disabled'}>这页图片转可编辑</button></div>${image ? '' : '<p class="pptw-hint">这页暂无缓存图片，可打开原稿截图后转字。</p>'}`;
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
  function renderConversion(job) {
    page.querySelector('[data-ppt-conversion]').dataset.jobId = job.id;
    conversionId = job.id; const r = job.result, preview = fileUrl(r?.preview || job.seed?.preview), reviews = r?.reviewItems || job.seed?.reviewItems || [];
    const recovery = job.needsOutputCheck ? '<p>本次可能已有部分产物。请先检查目录，再决定是否重试。</p><button type="button" data-ppt="conversion-workdir">打开产物目录</button>' : '';
    const retryLabel = job.needsOutputCheck ? '已检查产物，让 CodeAgent 重试' : '让 CodeAgent 重试';
    page.querySelector('[data-ppt-conversion]').innerHTML = `<div data-conversion-state="${esc(job.state)}"><p>${esc(job.error || job.step || job.state)}</p>${preview ? `<img class="pptw-conversion-preview" src="${esc(preview)}" alt="图片转字近似预览">` : ''}${r ? `<p>已生成可编辑PPT · ${esc(r.mode === 'image_fallback' ? 'OCR与图像算法处理，尚未经Agent看图核对' : 'Agent已提交差异')} · 预览为近似效果，需在PowerPoint中复核。</p>${r.pixel_gate?.passed === false ? '<p>质量检查尚未通过，请核对下列问题。</p>' : ''}<button type="button" data-ppt="conversion-open">打开 PPT</button>` : ''}${reviews.length ? `<ul>${reviews.map(item => `<li>${esc(typeof item === 'string' ? item : item.message || item.reason || '请对照原图检查本页文字和位置')}</li>`).join('')}</ul>` : ''}${recovery}${job.state === 'error' && job.seed ? `<div class="pptw-actions"><button type="button" data-ppt="conversion-retry">${retryLabel}</button><button type="button" data-ppt="conversion-fallback">${job.needsOutputCheck ? '已检查产物，用 OCR 初稿装配' : '先用 OCR 初稿装配'}</button></div>` : ''}</div>`;
  }
  async function convert(imagePath) {
    if (!imagePath) throw new Error('图片路径无法读取，请点「选择图片」');
    return startConversion('ppt-imgtext-start', { imagePath });
  }
  async function startConversion(channel, args) {
    if (converting || conversionId) throw new Error('当前图片仍在处理，请等本轮完成');
    converting = true; mode(true); page.querySelector('[data-ppt-conversion]').textContent = '正在生成 OCR 初稿，通常数十秒…';
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
