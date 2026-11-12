'use strict';
// PPT 页「做页」Tab（2026-11-11）：左边选骨架、写一句话；中间看版式预览；右边看自查提醒、待贴图位和后续操作。
// 一屏不滚动：骨架列表按可用高度分页，提醒和图位只列前几条。开箱即用：第一次打开就用骨架自带的示意内容出一页预览，不依赖素材包和模型。
function createPptMake({ root, ipcRenderer, notice }) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ACTIVE = ['waiting_agent', 'revising'];
  const STEP = { waiting_agent: '正在让助理写页面内容…', revising: '助理正在按自查提醒修改…' };
  const SHOW_MAX = 5;
  let skeletons = [], selected = '', category = '', listPage = 0, listSize = 6, job = null, svg = '', svgKey = '', busy = null, failure = null, editing = false, shown = false, pollTimer = null, clock = null;
  const call = async (action, args) => {
    const r = await ipcRenderer.invoke('company-assistant:' + action, args);
    if (r?.ok === false) throw new Error(r.error || '这一步没有完成');
    return r;
  };

  root.innerHTML = `<aside class="pptk-left" aria-label="骨架与内容">
      <div class="pptk-head"><b class="pptk-title">选一个骨架</b><label class="pptw-sr" for="company-ppt-make-cat">按分类筛选骨架</label><select id="company-ppt-make-cat" class="pptk-cat" data-pptk-cat></select></div><div class="pptk-list" data-pptk-list></div><div class="pptk-pager" data-pptk-pager></div>
      <label class="pptk-title" for="company-ppt-make-brief">这页要讲什么（一句话或贴材料）</label>
      <textarea id="company-ppt-make-brief" data-pptk-brief placeholder="例如：三项措施逐级叠加，指标从基线提升 XX%。也可以直接贴数据、结论和要点"></textarea>
      <div class="pptk-actions"><button type="button" class="pptw-btn pri" data-pptk="start">生成这一页</button><button type="button" class="pptw-btn sec" data-pptk="example">先看骨架样子</button></div>
      <div class="pptk-actions pptk-more"><button type="button" class="pptw-btn ghost sm" data-pptk="paste" title="别的 AI 已经写好页面说明（JSON）时，粘进来直接生成">粘贴页面说明</button><button type="button" class="pptw-btn ghost sm" data-pptk="guide" title="把骨架说明、写法规则和示意 JSON 复制出来，贴给别的 AI">复制写法说明</button><button type="button" class="pptw-btn ghost sm" data-pptk="pack" title="全部骨架的示意页合成一份多页 PPT，用 PowerPoint 打开">下载整套模板</button></div>
    </aside>
    <div class="pptk-main"><div class="pptk-cap" data-pptk-cap></div><div class="pptk-stage" data-pptk-stage></div><p class="pptk-chain" data-pptk-chain></p></div>
    <aside class="pptk-side" data-pptk-side aria-label="自查与操作"></aside>`;
  const $ = sel => root.querySelector(sel);
  const skeleton = () => skeletons.find(s => s.id === selected);
  const seconds = from => Math.max(0, Math.round((Date.now() - from) / 1000));

  // 分类下拉：全部 + 各类（带个数），顺序同骨架列表（主进程已按分类排好）。
  function drawCats() {
    const counts = new Map();
    for (const s of skeletons) counts.set(s.category, (counts.get(s.category) || 0) + 1);
    $('[data-pptk-cat]').innerHTML = [['', skeletons.length], ...counts].map(([name, n]) => `<option value="${esc(name)}"${name === category ? ' selected' : ''}>${esc(name || '全部')} · ${n}</option>`).join('');
  }
  // 一屏分页：按列表可用高度算每页几项，窗口变了重算（同素材 Tab 的做法）。
  function drawList() {
    const list = $('[data-pptk-list]'), visible = skeletons.filter(s => !category || s.category === category);
    if (list.clientHeight) listSize = Math.max(1, Math.floor((list.clientHeight + 4) / 56));
    const pages = Math.max(1, Math.ceil(visible.length / listSize));
    listPage = Math.min(listPage, pages - 1);
    list.innerHTML = visible.slice(listPage * listSize, listPage * listSize + listSize).map(s => `<button type="button" class="pptk-sk${s.id === selected ? ' on' : ''}" data-pptk="pick" data-id="${esc(s.id)}" aria-pressed="${s.id === selected}" title="${esc(s.fit)}"><b>${esc(s.name)}</b><span>${esc(s.fit)}</span></button>`).join('');
    $('[data-pptk-pager]').innerHTML = pages > 1 ? `<button type="button" class="pptw-btn ghost sm" data-pptk="prev"${listPage ? '' : ' disabled'} aria-label="上一页">‹</button><span>${listPage + 1} / ${pages}</span><button type="button" class="pptw-btn ghost sm" data-pptk="next"${listPage < pages - 1 ? '' : ' disabled'} aria-label="下一页">›</button>` : '';
    $('[data-pptk-chain]').textContent = skeleton() ? '论证链：' + skeleton().chain : '';
  }
  function drawStage() {
    const stage = $('[data-pptk-stage]'), running = busy || (job && ACTIVE.includes(job.state) ? { text: STEP[job.state], from: job.startedAt } : null);
    $('[data-pptk-cap]').innerHTML = job?.path ? `<b>${job.kind === 'example' ? '骨架样例' : '生成结果'}</b><span>${esc(job.skeleton)}</span><i title="${esc(job.path)}">${esc(job.path.split(/[\\/]/).pop())}</i>` : '<b>版式预览</b>';
    if (editing) {
      const paste = editing === 'paste';
      stage.innerHTML = `<div class="pptk-edit"><textarea data-pptk-spec spellcheck="false" aria-label="页面说明（JSON）" placeholder="${paste ? '把别的 AI 写好的页面说明（JSON）粘到这里。还没有？点左边「复制写法说明」，贴给它并写上要讲的内容' : ''}"></textarea><p class="pptk-err" data-pptk-err role="alert" hidden></p><div class="pptk-actions"><button type="button" class="pptw-btn pri" data-pptk="${paste ? 'paste-go' : 'rerender'}">${paste ? '生成' : '重新生成'}</button><button type="button" class="pptw-btn sec" data-pptk="edit-cancel">取消</button><span class="pptw-hint">${paste ? '直接生成，不经过助理。' : '直接改文字和数字；结构不熟时只改引号里的内容。'}</span></div></div>`;
      if (!paste) stage.querySelector('[data-pptk-spec]').value = JSON.stringify(job.spec, null, 2);
      return;
    }
    const slide = svg ? `<div class="pptk-slide${running ? ' dim' : ''}">${svg}</div>` : '';
    const wait = running ? `<div class="pptk-busy" role="status"><i class="pptk-spin" aria-hidden="true"></i><b>${esc(running.text)}</b><span data-pptk-clock>已用 ${seconds(running.from)} 秒</span>${job?.state === 'waiting_agent' ? '<small>通常 1–3 分钟，可以先去做别的，回来还在这里。</small>' : ''}</div>` : '';
    const failed = failure ? `<div class="pptk-fail" role="alert"><strong>这一页没有生成出来</strong><p>${esc(failure)}</p><p>下一步：点「重试」再生成一次；想先看版式，点「先看骨架样子」。</p><div class="pptk-actions"><button type="button" class="pptw-btn pri" data-pptk="start">重试</button><button type="button" class="pptw-btn sec" data-pptk="example">先看骨架样子</button></div></div>` : '';
    stage.innerHTML = failed || (slide + wait) || '<p class="pptw-empty">选一个骨架，点「先看骨架样子」。</p>';
    clearInterval(clock); clock = null;
    if (running) clock = setInterval(() => { const el = root.querySelector('[data-pptk-clock]'); if (el) el.textContent = `已用 ${seconds(running.from)} 秒`; }, 1000);
  }
  const more = (items, unit) => items.length > SHOW_MAX ? `<li class="more">另有 ${items.length - SHOW_MAX} ${unit}，打开 PPT 后查看</li>` : '';
  function drawSide() {
    const side = $('[data-pptk-side]'), r = job?.report;
    if (!r) { side.innerHTML = '<p class="pptw-empty">生成后，这里列出自查提醒、待贴图位和后续操作。</p>'; return; }
    const warnings = r.warnings || [], slots = r.imageSlots || [];
    side.innerHTML = `<section><h3>自查提醒${warnings.length ? `<i>${warnings.length}</i>` : ''}</h3>${warnings.length ? `<ul class="pptk-warn">${warnings.slice(0, SHOW_MAX).map(w => `<li title="${esc(w)}">${esc(w)}</li>`).join('')}${more(warnings, '条')}</ul>` : '<p class="pptk-ok">没有发现问题</p>'}</section>
      <section><h3>待贴图位${slots.length ? `<i>${slots.length}</i>` : ''}</h3>${slots.length ? `<ul class="pptk-slots">${slots.slice(0, SHOW_MAX).map(s => `<li title="${esc(s)}">${esc(s)}</li>`).join('')}${more(slots, '处')}</ul>` : '<p class="pptk-none">这一页没有留图位</p>'}</section>
      <section><h3>统计</h3><dl class="pptk-stat"><dt>字数</dt><dd>${Number(r.chars) || 0}</dd><dt>最小字号</dt><dd>${r.minFont ? r.minFont + ' pt' : '—'}</dd></dl></section>
      <div class="pptk-ops"><button type="button" class="pptw-btn pri" data-pptk="open">用 PowerPoint 打开</button><button type="button" class="pptw-btn sec" data-pptk="insert">插入到当前文稿</button><button type="button" class="pptw-btn sec" data-pptk="folder">打开所在文件夹</button><button type="button" class="pptw-btn ghost" data-pptk="edit">改页面说明后重新生成</button></div>`;
  }
  function draw() { drawList(); drawStage(); drawSide(); }

  const editorError = message => { const el = root.querySelector('[data-pptk-err]'); if (el) { el.textContent = message; el.hidden = false; } return null; };
  // 别的 AI 常把 JSON 包在代码块里：取第一个 { 到最后一个 }；解析失败时就地写明第几行有错。
  function readSpec() {
    const text = root.querySelector('[data-pptk-spec]').value, start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < start) return editorError('没有找到页面说明：应是一个以 { 开头、以 } 结尾的 JSON 对象。');
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch (error) {
      const pos = /position (\d+)/.exec(error.message);
      return editorError(pos ? `第 ${text.slice(0, start + Number(pos[1])).split('\n').length} 行附近有错：${error.message}` : `JSON 不完整或有错：${error.message}`);
    }
  }
  // 生成结果换了（新任务或同一任务又生成了一版）才重画预览。
  async function loadPreview() {
    if (!job?.path) return;
    const key = job.id + ':' + job.rev;
    if (key === svgKey) return;
    const r = await call('ppt-make-preview', { jobId: job.id });
    if (key !== job.id + ':' + job.rev) return;
    svg = require('./ppt-slide-svg').sceneSvg(r.scene, { title: '这一页的版式预览' }); svgKey = key;
  }
  async function take(next) {
    job = next; failure = job.state === 'error' ? job.error : null; editing = false;
    await loadPreview();
    draw();
    clearTimeout(pollTimer);
    if (ACTIVE.includes(job.state) && shown) pollTimer = setTimeout(() => { void poll(); }, 1500);
  }
  async function poll() {
    if (!job || !shown) return;
    try { await take((await call('ppt-make-status', { jobId: job.id })).job); }
    catch (error) { failure = error.message; job = null; draw(); }
  }
  // 本页面自己发起、几秒内就回来的步骤：显示「正在生成 PPT…」和已用时间。
  async function generating(work) {
    busy = { text: '正在生成 PPT…', from: Date.now() }; failure = null; editing = false; drawStage();
    try { const r = await work(); busy = null; await take(r.job); }
    catch (error) { busy = null; failure = error.message; drawStage(); }
  }
  async function act(name, b) {
    if (name === 'pick') { selected = b.dataset.id; drawList(); return; }
    if (name === 'prev' || name === 'next') { listPage += name === 'next' ? 1 : -1; drawList(); return; }
    if (name === 'pack') {
      b.disabled = true; notice('正在生成整套模板…');
      try {
        const { job: pack } = await call('ppt-make-pack');
        await call('ppt-make-open', { jobId: pack.id });
        notice(`已生成 ${pack.pages} 页的整套模板并用 PowerPoint 打开：${pack.path}`);
      } finally { b.disabled = false; }
      return;
    }
    if (name === 'example') return generating(() => call('ppt-make-example', { skeletonId: selected }));
    if (name === 'start') {
      if (job && ACTIVE.includes(job.state)) { notice('助理还在写上一页，请等它完成。'); return; }
      const brief = $('[data-pptk-brief]').value.trim();
      if (!brief) { notice('先写一句这页要讲什么，或贴上材料。'); $('[data-pptk-brief]').focus(); return; }
      failure = null; svg = ''; svgKey = ''; notice('');
      try { await take((await call('ppt-make-start', { skeletonId: selected, brief })).job); }
      catch (error) { failure = error.message; drawStage(); }
      return;
    }
    if (name === 'edit') { editing = 'edit'; drawStage(); return; }
    if (name === 'edit-cancel') { editing = false; drawStage(); return; }
    if (name === 'paste') {
      if (job && ACTIVE.includes(job.state)) { notice('助理还在写上一页，请等它完成。'); return; }
      editing = 'paste'; failure = null; drawStage(); root.querySelector('[data-pptk-spec]').focus(); return;
    }
    // 只在用户点这个按钮时写剪贴板。
    if (name === 'guide') {
      const r = await call('ppt-make-guide', { skeletonId: selected });
      require('electron').clipboard.writeText(r.text);
      notice(`已复制「${skeleton().name}」的写法说明：贴给别的 AI 并写上要讲的内容，它回的 JSON 用「粘贴页面说明」生成。`); return;
    }
    // 出错留在编辑框里就地提示，改完再点一次。
    if (name === 'rerender' || name === 'paste-go') {
      const spec = readSpec(); if (!spec) return;
      b.disabled = true;
      try { await take((await call(...(name === 'rerender' ? ['ppt-make-rerender', { jobId: job.id, spec }] : ['ppt-make-render', { spec, skeletonId: selected }]))).job); }
      catch (error) { editorError(error.message); b.disabled = false; }
      return;
    }
    b.disabled = true;
    try {
      if (name === 'open') { await call('ppt-make-open', { jobId: job.id }); notice('已用 PowerPoint 打开，可直接编辑。'); }
      if (name === 'folder') await call('ppt-make-folder', { jobId: job.id });
      if (name === 'insert') { notice('正在插入到当前文稿…'); const r = await call('ppt-make-insert', { jobId: job.id }); notice(`已插入到「${r.target}」第 ${r.page} 页，请在 PowerPoint 里检查并保存。`); }
    } finally { b.disabled = false; }
  }
  $('[data-pptk-cat]').addEventListener('change', e => { category = e.target.value; listPage = 0; drawList(); });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pptk]'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    void act(b.dataset.pptk, b).catch(err => notice(err.message));
  });
  let resizeTimer = null;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (shown) drawList(); }, 120); };
  return {
    async show() {
      shown = true; window.addEventListener('resize', onResize);
      try {
        if (!skeletons.length) { skeletons = (await call('ppt-make-skeletons')).skeletons; selected = skeletons[0]?.id || ''; drawCats(); }
        draw();
        if (job) return void poll();
        if (selected) await generating(() => call('ppt-make-example', { skeletonId: selected }));
      } catch (error) { notice(error.message); }
    },
    hide() { shown = false; clearTimeout(pollTimer); clearInterval(clock); clock = null; window.removeEventListener('resize', onResize); },
  };
}
module.exports = { createPptMake };
