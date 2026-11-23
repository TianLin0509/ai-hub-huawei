'use strict';
// PPT 页「库地图」Tab（r28g，2026-11-17 选定树形目录）：左树（主题 → 材料类型 → 文件，可切按页面类型），中间选中节点的页，右侧原页预览。
// 一屏不滚动：树和页列表都按可用高度算每页条数并翻页。首次进入自动在后台增量分类；进度、耗时、模型次数用人话显示，随时可取消。
// 节点可改名、文件可拖到别的节点（右侧也有「移到」下拉，不会拖也能改）；改动单独存，下次分类不覆盖。「抽查 50 页」逐页判对错得准确率。
function createPptMap({ root, ipcRenderer, notice, openPage, doctorState = () => '' }) {
  const { pathToFileURL } = require('node:url');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fileUrl = file => { try { return file ? pathToFileURL(file).href : ''; } catch { return ''; } };
  const call = async (action, args) => {
    const r = await ipcRenderer.invoke('company-assistant:' + action, args);
    if (r?.ok === false) throw new Error(r.error || '这一步没有完成');
    return r;
  };
  let shown = false, state = null, tree = null, group = 'topic', query = '', deckFilter = '', selected = '', expanded = new Set(), treePage = 0;
  let list = null, listPage = 0, listSize = 8, pickedPage = '', pollTimer = null, autoStarted = false, mode = 'map', review = null, reviewAt = 0, renaming = '';
  const previews = new Map(), queue = [];
  let running = 0;
  const ROW = 32, ITEM = 68;

  root.innerHTML = `<div class="pptg-top"><div class="pptw-bar pptg-search"><svg class="pptw-bar-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><label class="pptw-sr" for="company-ppt-map-query">搜索节点名</label><input id="company-ppt-map-query" data-pptg-query autocomplete="off" placeholder="搜主题、材料类型或文件名"></div>
    <label class="pptw-sr" for="company-ppt-map-deck">按材料类型筛选</label><select id="company-ppt-map-deck" class="pptg-select" data-pptg-deck></select>
    <div class="pptg-seg" role="group" aria-label="分组方式"><button type="button" data-pptg="group" data-group="topic" aria-pressed="true">按主题</button><button type="button" data-pptg="group" data-group="pageType" aria-pressed="false">按页面类型</button></div>
    <span class="pptg-status" data-pptg-status role="status" aria-live="polite"></span>
    <div class="pptg-acts"><button type="button" class="pptw-btn ghost sm" data-pptg="cancel" hidden>取消</button><button type="button" class="pptw-btn sec sm" data-pptg="update">更新库地图</button><button type="button" class="pptw-btn ghost sm" data-pptg="review">抽查 50 页</button></div></div>
    <p class="pptg-warn" data-pptg-warn role="status" hidden></p>
    <div class="pptg-body" data-pptg-body>
      <nav class="pptg-tree" aria-label="库地图目录"><div class="pptg-tree-list" data-pptg-tree role="tree"></div><div class="pptm-pager" data-pptg-tree-pager></div></nav>
      <section class="pptg-main"><header class="pptg-main-head" data-pptg-head></header><div class="pptg-list" data-pptg-list></div><div class="pptm-pager" data-pptg-pager></div></section>
      <aside class="pptg-detail" data-pptg-detail aria-label="选中页"></aside>
    </div>
    <div class="pptg-review" data-pptg-review hidden></div>
    <div class="pptg-guide" data-pptg-guide hidden></div>`;
  const $ = sel => root.querySelector(sel);

  // ---- 预览：Doctor 的截图 > 主进程读 pptx 画版式（同找页）
  function thumbHtml(p) {
    if (p.thumbnail) return `<img src="${esc(fileUrl(p.thumbnail))}" alt="" loading="lazy">`;
    const v = previews.get(p.id);
    if (v?.svg) return v.svg;
    if (v?.state === 'error') return `<span class="pptm-pv-err">${esc(v.short)}</span>`;
    if (!v) { previews.set(p.id, { state: 'queued' }); queue.push(p.id); pump(); }
    return '<span class="pptw-pv-loading" aria-label="正在画预览"></span>';
  }
  function pump() {
    while (running < 2 && queue.length) {
      const id = queue.shift(); running++;
      Promise.resolve().then(() => ipcRenderer.invoke('company-assistant:ppt-map-preview', { id })).then(r => {
        previews.set(id, r?.ok && r.scene ? { state: 'ok', svg: require('./ppt-slide-svg').sceneSvg(r.scene) } : { state: 'error', short: r?.code === 'UNSUPPORTED_FORMAT' ? '旧版 .ppt' : '画不出版式' });
      }).catch(() => previews.set(id, { state: 'error', short: '画不出版式' })).finally(() => {
        running--;
        for (const el of root.querySelectorAll('[data-pptg-thumb]')) if (el.dataset.pptgThumb === id) { const p = pageOf(id); if (p) el.innerHTML = thumbHtml(p); }
        pump();
      });
    }
  }
  const pageOf = id => list?.items.find(p => p.id === id) || review?.items.find(p => p.id === id);

  // ---- 人话状态
  const dur = ms => { const s = Math.max(0, Math.round((ms || 0) / 1000)); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分`; };
  const when = t => t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  function statusText() {
    const s = state, j = s?.job || {};
    if (!s) return '';
    const model = j.modelCalls ? `用模型 ${j.modelCalls} 次（${j.modelBatches && j.modelCalls > j.modelBatches ? `${j.modelBatches} 批，含换模型重试；` : ''}累计送了 ${j.modelPages} 页）` : '没用模型';
    const ruleOnly = j.ruleOnly ? ' · 只用规则' : '';
    if (j.state === 'running' || j.state === 'canceling') {
      const eta = j.filesDone >= 3 && j.elapsedMs > 10000 && j.filesTodo > j.filesDone ? `，预计还要约 ${dur(j.elapsedMs / j.filesDone * (j.filesTodo - j.filesDone))}` : '';
      const files = j.filesTodo ? `第 ${Math.min(j.filesDone + 1, j.filesTodo)}/${j.filesTodo} 份${j.filesUnchanged ? `（另 ${j.filesUnchanged} 份没变，跳过）` : ''}` : '';
      return `${j.state === 'canceling' ? '正在停下' : '正在更新库地图'}：${j.phase || ''}${files ? ' · ' + files : ''} · 已${model} · 用时 ${dur(j.elapsedMs)}${eta}${ruleOnly}`;
    }
    if (j.state === 'canceled') return `已取消：本次处理了 ${j.filesDone}/${j.filesTodo} 份，判完的已保存，再点「更新库地图」接着做 · ${model}`;
    if (j.state === 'error') return `这次没更新完：${j.error}`;
    if (!s.built) return s.needsIndex ? '' : '还没生成库地图';
    const c = s.counts, last = j.state === 'done' ? ` · 本次处理 ${j.filesTodo} 份、用时 ${dur(j.elapsedMs)}、${model}` : '';
    const how = [c.model && `模型判 ${c.model} 页`, c.rule && `规则判 ${c.rule} 页`, c.user && `你改过 ${c.user} 页`, c.uncertain && `拿不准 ${c.uncertain} 页`].filter(Boolean).join('、');
    return `${when(s.updatedAt)} 更新：${s.files} 份、${s.pages} 页（${how}）${last}${ruleOnly}`;
  }
  // 只用规则 / 有批次没判成：单独一行说清原因和下一步（状态行放不下，会被截断）
  function warnText() {
    const j = state?.job || {};
    if (j.ruleOnly) return `这次只用规则分类：${j.reason}。拿不准的页先按规则放着（标「拿不准」），CodeAgent 能用后点「更新库地图」会补判。`;
    if (j.modelFailedBatches) return `有 ${j.modelFailedBatches} 批页模型没判成（${j.modelError}），先按规则放着，下次点「更新库地图」只重送这些页。`;
    return '';
  }
  function drawStatus() {
    const j = state?.job || {}, busy = j.state === 'running' || j.state === 'canceling';
    const w = $('[data-pptg-warn]'), wt = state?.needsIndex ? '' : warnText(), flip = w.hidden === !!wt; w.textContent = wt; w.title = wt; w.hidden = !wt;
    if (flip) onResize(); // 提示行出现 / 消失会改变列表高度：按新高度重新分页
    const el = $('[data-pptg-status]'); el.textContent = statusText(); el.title = el.textContent;
    el.dataset.state = busy ? 'busy' : j.state === 'error' ? 'error' : j.ruleOnly || j.modelFailedBatches ? 'warn' : '';
    $('[data-pptg="cancel"]').hidden = !busy; $('[data-pptg="cancel"]').disabled = j.state === 'canceling';
    $('[data-pptg="update"]').disabled = busy || !!state?.needsIndex;
    $('[data-pptg="review"]').disabled = busy || !state?.pages;
  }
  // 没有索引 / 正在建索引：就地引导，按钮就在说明旁边
  function drawGuide() {
    const g = $('[data-pptg-guide]'), s = state;
    const need = !!s?.needsIndex, empty = !need && !s?.built && !['running', 'canceling'].includes(s?.job?.state);
    g.hidden = !(need || (empty && s?.job?.state === 'error'));
    $('[data-pptg-body]').hidden = !g.hidden || mode !== 'map'; $('[data-pptg-review]').hidden = mode !== 'review';
    root.dataset.empty = g.hidden ? '0' : '1';
    if (g.hidden) return;
    const indexing = s.index?.indexing;
    g.innerHTML = need ? `<span class="pptw-guide-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"/></svg></span><div class="pptw-guide-copy"><strong>${indexing ? '正在建立素材索引' : '库地图要先有素材索引'}</strong><p>${indexing ? esc(s.index.message || '建好后库地图会自动开始分类，请稍等。') : '库地图按索引里每页的文字分类。选好存放 PPT 的文件夹、建好索引后，这里会自动开始。'}</p></div><div class="pptw-guide-actions"><button type="button" class="pptw-btn pri" data-pptg="build-index"${indexing ? ' disabled' : ''}>${indexing ? '正在建索引…' : '先建索引'}</button></div>`
      : `<div class="pptw-guide-copy"><strong>这次没更新完</strong><p>${esc(s.job.error)}</p></div><div class="pptw-guide-actions"><button type="button" class="pptw-btn pri" data-pptg="update">再试一次</button></div>`;
  }

  // ---- 树
  // 筛选：材料类型下拉 + 搜索节点名。节点自己或祖先命中就保留（连同子树）；只有后代命中时保留到命中处并自动展开。
  function filtered(nodes) {
    const q = query.toLowerCase(), hit = n => !q || String(n.label).toLowerCase().includes(q);
    const pass = n => !(deckFilter && ((n.kind === 'deckType' && n.key !== deckFilter) || (n.kind === 'file' && group === 'pageType' && n.deckType !== deckFilter)));
    const keep = (n, above) => {
      if (!pass(n)) return null;
      const self = above || hit(n);
      if (!n.children) return self ? n : null;
      const kids = n.children.map(c => keep(c, self)).filter(Boolean);
      return kids.length ? { ...n, children: kids, open: !!q && !hit(n) } : null;
    };
    return nodes.map(n => keep(n, false)).filter(Boolean);
  }
  function rows() {
    const out = [];
    const walk = (nodes, depth) => { for (const n of nodes) { out.push({ n, depth }); if (n.children?.length && (expanded.has(n.id) || n.open)) walk(n.children, depth + 1); } };
    walk(filtered(tree?.nodes || []), 0);
    return out;
  }
  function treeSize() { const h = $('[data-pptg-tree]').clientHeight; return Math.max(5, Math.floor((h || 600) / ROW)); }
  function drawTree() {
    const all = rows(), size = treeSize(), pages = Math.max(1, Math.ceil(all.length / size));
    if (treePage >= pages) treePage = pages - 1;
    const slice = all.slice(treePage * size, treePage * size + size);
    const pencil = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
    $('[data-pptg-tree]').innerHTML = slice.length ? slice.map(({ n, depth }) => {
      const open = expanded.has(n.id) || n.open, hasKids = !!n.children?.length;
      const count = n.kind === 'file' ? `${n.pages} 页` : n.kind === 'topic' ? `${n.files ?? n.children.length} 份` : n.kind === 'deckType' ? `${n.children.length} 份` : `${n.pages} 页`;
      const dim = n.kind === 'topic' ? 'topic' : n.kind === 'deckType' ? 'deckType' : n.kind === 'pageType' ? 'pageType' : '';
      if (renaming === n.id) return `<div class="pptg-node renaming" style="--d:${depth}"><input class="pptg-rename" data-pptg-rename data-dim="${dim}" data-key="${esc(n.key)}" value="${esc(n.label)}" maxlength="30" aria-label="新名字（回车保存，Esc 取消）"></div>`;
      return `<div class="pptg-node${n.id === selected ? ' on' : ''}${n.kind === 'file' ? ' file' : ''}" role="treeitem" aria-selected="${n.id === selected}"${hasKids ? ` aria-expanded="${open}"` : ''} style="--d:${depth}" data-pptg="node" data-id="${esc(n.id)}"${n.kind === 'file' && group === 'topic' ? ` draggable="true" data-path="${esc(n.path)}"` : ''}${n.kind === 'topic' || n.kind === 'deckType' ? ` data-drop="${n.kind}" data-topic="${esc(n.kind === 'topic' ? n.key : n.topic)}" data-key="${esc(n.key)}"` : ''} title="${esc(n.label)}">`
        + `<span class="pptg-caret${hasKids ? '' : ' none'}" data-pptg="toggle" data-id="${esc(n.id)}" aria-hidden="true">${hasKids ? (open ? '▾' : '▸') : ''}</span>`
        + `<span class="pptg-label">${n.kind === 'file' ? '<i class="pptg-file-ico" aria-hidden="true"></i>' : ''}<span class="pptg-name">${esc(n.label)}</span></span>${n.moved ? '<em class="pptg-moved" title="你调整过位置，下次分类不覆盖">已调整</em>' : ''}`
        + (dim ? `<button type="button" class="pptg-edit" data-pptg="rename" data-id="${esc(n.id)}" title="改名（对所有同名节点生效）" aria-label="给「${esc(n.label)}」改名">${pencil}</button>` : '')
        + `<i class="pptg-count">${count}</i></div>`;
    }).join('') : `<p class="pptw-empty">${query || deckFilter ? '没有匹配的节点，换个词或清空筛选。' : state?.built ? '库里还没有文件。' : '正在生成库地图…'}</p>`;
    $('[data-pptg-tree-pager]').innerHTML = pages > 1 ? `<button type="button" class="pptw-btn ghost sm" data-pptg="tree-prev"${treePage ? '' : ' disabled'} aria-label="目录上一页">‹</button><span>${treePage + 1} / ${pages}</span><button type="button" class="pptw-btn ghost sm" data-pptg="tree-next"${treePage < pages - 1 ? '' : ' disabled'} aria-label="目录下一页">›</button>` : '';
    const input = $('[data-pptg-rename]'); if (input) { input.focus(); input.select(); }
  }
  function findNode(id, nodes = tree?.nodes || []) { for (const n of nodes) { if (n.id === id) return n; const c = n.children && findNode(id, n.children); if (c) return c; } return null; }
  function parentsOf(id, nodes = tree?.nodes || [], trail = []) { for (const n of nodes) { if (n.id === id) return trail; const r = n.children && parentsOf(id, n.children, [...trail, n]); if (r) return r; } return null; }

  // ---- 中间：选中节点的页
  function listSizeNow() { const h = $('[data-pptg-list]').clientHeight; return Math.max(3, Math.floor((h || 560) / ITEM)); }
  async function loadPages() {
    if (!selected) { list = null; drawList(); return; }
    listSize = listSizeNow();
    const want = selected, r = await call('ppt-map-pages', { node: selected, offset: listPage * listSize, limit: listSize, deckType: selected.startsWith('f:') ? '' : deckFilter });
    if (want !== selected) return;
    list = r;
    if (!list.items.some(p => p.id === pickedPage)) pickedPage = list.items[0]?.id || '';
    drawList();
  }
  const SOURCE = { rule: '规则', model: '模型', user: '你改的', 'model-rejected': '待人工' };
  function drawList() {
    const node = findNode(selected), head = $('[data-pptg-head]');
    const trail = (parentsOf(selected) || []).map(n => n.label);
    head.innerHTML = node ? `<div class="pptg-crumb">${trail.map(t => `<span>${esc(t)}</span>`).join('<i>›</i>')}${trail.length ? '<i>›</i>' : ''}<b title="${esc(node.label)}">${esc(node.label)}</b></div><small>${list ? `${list.total} 页${node.kind === 'file' ? '' : '（不含封面目录页）'}` : ''}${node.kind === 'file' ? ' · 双击一页直接打开原稿' : ''}</small>` : '<div class="pptg-crumb"><b>库地图</b></div><small>左侧选一个主题、材料类型或文件</small>';
    const items = list?.items || [];
    $('[data-pptg-list]').innerHTML = items.length ? items.map(p => `<button type="button" class="pptg-item${p.id === pickedPage ? ' on' : ''}" data-pptg="pick" data-id="${esc(p.id)}" title="${esc(p.name)} 第 ${p.page} 页">`
      + `<span class="pptg-no">P${p.page}</span><span class="pptg-thumb" data-pptg-thumb="${esc(p.id)}">${thumbHtml(p)}</span>`
      + `<span class="pptg-copy"><strong>${esc(p.title || '（这页没有标题）')}</strong><small>${node?.kind === 'file' ? esc(p.topicLabels.join('、') || '没有主题') : esc(p.name)}</small></span>`
      + `<span class="pptg-type${p.uncertain || p.needsHuman ? ' warn' : ''}">${esc(p.pageTypeLabel)}</span><span class="pptg-src">${esc(SOURCE[p.by] || p.by)}${p.uncertain ? ' · 拿不准' : p.needsHuman ? ' · 待人工' : ''}</span></button>`).join('')
      : `<p class="pptw-empty">${selected ? '这个节点下没有页。' : '选一个节点，看它下面的页。'}</p>`;
    const pages = list ? Math.max(1, Math.ceil(list.total / listSize)) : 1;
    $('[data-pptg-pager]').innerHTML = list && list.total > listSize ? `<button type="button" class="pptw-btn ghost sm" data-pptg="prev"${listPage ? '' : ' disabled'} aria-label="上一页">‹ 上一页</button><span>${listPage + 1} / ${pages}</span><button type="button" class="pptw-btn ghost sm" data-pptg="next"${listPage < pages - 1 ? '' : ' disabled'} aria-label="下一页">下一页 ›</button>` : '';
    drawDetail();
  }
  // ---- 右侧：选中页的大图与操作；文件节点另给「移到」
  function drawDetail() {
    const panel = $('[data-pptg-detail]'), p = pageOf(pickedPage), node = findNode(selected);
    const opts = tree?.options || { topic: [], deckType: [] };
    const fileMove = node?.kind === 'file' && group === 'topic' ? (() => {
      const place = parentsOf(selected) || [], topic = place.find(n => n.kind === 'topic')?.key ?? '', deck = place.find(n => n.kind === 'deckType')?.key ?? '';
      return `<div class="pptg-move"><b>这份稿放在</b><label><span>主题</span><select data-pptg-move="topic">${opts.topic.map(o => `<option value="${esc(o.key)}"${o.key === topic ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label><label><span>材料类型</span><select data-pptg-move="deckType">${opts.deckType.map(o => `<option value="${esc(o.key)}"${o.key === deck ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label><small>也可以把左侧文件拖到别的节点。你的调整会记住，下次分类不覆盖。</small></div>`;
    })() : '';
    if (!p) { panel.innerHTML = `${fileMove}<p class="pptw-empty">选中一页，看大图并打开原稿。</p>`; return; }
    panel.innerHTML = `<div class="pptm-big pptg-big" data-pptg-thumb="${esc(p.id)}">${thumbHtml(p)}</div><div class="pptw-dt-body"><div class="pptw-tags"><span class="pptw-tag">第 ${esc(p.page)} 页</span><span class="pptw-tag">${esc(p.pageTypeLabel)}</span>${p.topicLabels.map(t => `<span class="pptw-tag">${esc(t)}</span>`).join('')}</div><h2 title="${esc(p.name)}">${esc(p.name)}</h2><p class="pptw-hint">${esc(p.deckType)} · ${esc(SOURCE[p.by] || p.by)}判的${p.uncertain ? '，规则拿不准、模型还没判' : ''}</p></div><div class="pptw-detail-actions"><button type="button" class="pptw-btn pri" data-pptg="open" data-id="${esc(p.id)}">打开原页</button><button type="button" class="pptw-btn sec" data-pptg="folder" data-id="${esc(p.id)}">所在文件夹</button></div>${fileMove}`;
  }

  // ---- 抽查 50 页
  function drawReview() {
    const box = $('[data-pptg-review]');
    if (!review) { box.innerHTML = ''; return; }
    const items = review.items, n = items.length;
    const done = items.filter(i => i.verdict.pageType && i.verdict.topics).length;
    const score = (dim, by = '全部') => review.scores.find(s => s.dimension === dim && s.by === by);
    const pct = v => Math.round(v * 100);
    const line = (dim, name) => { const s = score(dim); if (!s) return `<li><b>${name}</b>还没判</li>`; const lo = Math.round(s.ci[0] * s.n), hi = Math.round(s.ci[1] * s.n); return `<li><b>${name}</b>${s.text}<small>按这 ${s.n} 个推算，准确率大致在 ${pct(s.ci[0])}%–${pct(s.ci[1])}%（${s.n} 个里 ${lo}–${hi} 个）</small></li>`; };
    const bySrc = ['rule', 'model', 'user'].map(by => { const t = score('pageType', by); return t ? `${SOURCE[by]}：${t.text}` : ''; }).filter(Boolean).join('；');
    if (reviewAt >= n) {
      box.innerHTML = `<div class="pptg-rv-done"><h2>抽查完成：${n} 页</h2><ul>${line('pageType', '页面类型')}${line('topics', '主题')}</ul><p>分来源（页面类型）：${esc(bySrc || '—')}</p><div class="pptw-guide-actions"><button type="button" class="pptw-btn sec" data-pptg="rv-back">回到第 1 页复核</button><button type="button" class="pptw-btn ghost" data-pptg="rv-new">再抽 50 页</button><button type="button" class="pptw-btn pri" data-pptg="rv-exit">回到库地图</button></div></div>`;
      return;
    }
    const it = items[reviewAt], v = it.verdict;
    const btn = (dim, val, key, label) => `<button type="button" class="pptg-vd${v[dim] === val ? ' on ' + val : ''}" data-pptg="vd" data-dim="${dim}" data-val="${val}" aria-pressed="${v[dim] === val}"><kbd>${key}</kbd>${label}</button>`;
    box.innerHTML = `<div class="pptg-rv-head"><b>抽查第 ${reviewAt + 1} / ${n} 页</b><span class="pptg-rv-bar"><i style="width:${Math.round(done / n * 100)}%"></i></span><small>已判 ${done} 页 · ${esc(review.scores.find(s => s.dimension === 'pageType' && s.by === '全部')?.text || '页面类型还没判')}</small><button type="button" class="pptw-btn ghost sm" data-pptg="rv-exit">退出抽查（进度会保存）</button></div>
      <div class="pptg-rv-body"><div class="pptm-big pptg-rv-big" data-pptg-thumb="${esc(it.id)}">${thumbHtml(it)}</div>
      <div class="pptg-rv-side"><h2 title="${esc(it.name)}">${esc(it.name)} · 第 ${esc(it.page)} 页</h2><p class="pptw-hint">${esc(it.title || '（这页没有标题）')} · ${esc(SOURCE[it.by] || it.by)}判的</p>
        <div class="pptg-rv-q"><span>页面类型：<b>${esc(it.pageTypeLabel)}</b></span><div>${btn('pageType', 'right', 1, '对')}${btn('pageType', 'wrong', 2, '错')}</div></div>
        <div class="pptg-rv-q"><span>主题：<b>${esc(it.topicLabels.join('、') || '（没有主题）')}</b></span><div>${btn('topics', 'right', 3, '对')}${btn('topics', 'wrong', 4, '错')}</div></div>
        <div class="pptg-rv-nav"><button type="button" class="pptw-btn ghost sm" data-pptg="rv-prev"${reviewAt ? '' : ' disabled'}>‹ 上一页</button><button type="button" class="pptw-btn ghost sm" data-pptg="rv-skip"><kbd>0</kbd>这页跳过</button><button type="button" class="pptw-btn ghost sm" data-pptg="open" data-id="${esc(it.id)}">打开原页</button><button type="button" class="pptw-btn ghost sm" data-pptg="rv-next">下一页 ›</button></div>
        <p class="pptw-hint">键盘：1/2 判页面类型对错，3/4 判主题对错，两项都判完自动到下一页。</p></div></div>`;
  }
  async function verdict(dim, val) {
    const it = review?.items[reviewAt]; if (!it) return;
    const r = await call('ppt-map-verdict', { id: it.id, [dim]: val });
    review = r.review;
    const v = review.items[reviewAt].verdict;
    if (dim === 'skip' || (v.pageType && v.topics)) reviewAt++;
    drawReview();
  }

  // ---- 加载与轮询
  async function loadState() { state = await call('ppt-map-state'); drawStatus(); drawGuide(); return state; }
  async function loadTree() {
    tree = await call('ppt-map-tree', { group });
    const deck = $('[data-pptg-deck]'), html = '<option value="">全部材料类型</option>' + (tree.options?.deckType || []).map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
    if (deck.dataset.options !== html) { deck.innerHTML = html; deck.dataset.options = html; deck.value = deckFilter; }
    if (!selected || !findNode(selected)) {
      const first = tree.nodes[0];
      selected = first?.id || ''; if (first) expanded.add(first.id); listPage = 0;
    }
    drawTree(); await loadPages();
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!shown) return;
    const busy = ['running', 'canceling'].includes(state?.job?.state) || state?.index?.indexing;
    pollTimer = setTimeout(() => void tick(), busy ? 1000 : 15000);
  }
  let lastSeen = '';
  async function tick() {
    try {
      const s = await loadState();
      // 首次进入：有索引、还没生成过、也没在跑 → 自动开始（建完索引回来也一样）
      if (!s.needsIndex && !s.built && s.job.state === 'idle' && !autoStarted) { autoStarted = true; notice(''); await call('ppt-map-start'); await loadState(); }
      // 分类每判完一组就落盘：文件数、更新时间或任务状态变了才重画树（改名输入中不打断）
      const seen = `${s.files}|${s.pages}|${s.updatedAt}|${s.job.state}`;
      if (seen !== lastSeen && mode === 'map' && !renaming && !s.needsIndex) { lastSeen = seen; await loadTree(); }
    } catch (error) { notice(error.message); }
    schedule();
  }

  // ---- 交互
  let filterTimer = null;
  $('[data-pptg-query]').addEventListener('input', e => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { query = e.target.value.trim(); treePage = 0; drawTree(); }, 120); });
  $('[data-pptg-deck]').addEventListener('change', e => { deckFilter = e.target.value; treePage = 0; listPage = 0; drawTree(); void loadPages().catch(err => notice(err.message)); });
  root.addEventListener('change', e => {
    const sel = e.target.closest('[data-pptg-move]'); if (!sel) return;
    const node = findNode(selected); if (!node || node.kind !== 'file') return;
    void move(node.path, { [sel.dataset.pptgMove]: sel.value }).catch(err => notice(err.message));
  });
  async function move(file, patch) {
    await call('ppt-map-move', { path: file, ...patch });
    const name = Object.values(tree.nodes).flatMap(function all(n) { return [n, ...(n.children || []).flatMap(all)]; }).find(n => n.path === file)?.label || '文件';
    await loadTree();
    // 跟着文件走：选中它的新位置并展开
    const nodeId = 'f:' + file; selected = nodeId; for (const p of parentsOf(nodeId) || []) expanded.add(p.id);
    treePage = Math.max(0, Math.floor(rows().findIndex(r => r.n.id === nodeId) / treeSize())); drawTree(); await loadPages();
    notice(`已把「${name}」移到新位置；下次更新库地图也会保留这个调整。`);
  }
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pptg]'); if (!b || b.disabled) return;
    e.preventDefault();
    void act(b.dataset.pptg, b, e).catch(err => notice(err.message));
  });
  root.addEventListener('dblclick', e => { const b = e.target.closest('[data-pptg="pick"]'); if (b) void act('open', b).catch(err => notice(err.message)); });
  root.addEventListener('keydown', e => {
    const input = e.target.closest('[data-pptg-rename]');
    if (input) { if (e.key === 'Enter') { e.preventDefault(); void saveRename(input).catch(err => notice(err.message)); } else if (e.key === 'Escape') { e.preventDefault(); renaming = ''; drawTree(); } return; }
  });
  root.addEventListener('focusout', e => { const input = e.target.closest?.('[data-pptg-rename]'); if (input && renaming) void saveRename(input).catch(err => notice(err.message)); });
  // 抽查的键盘操作（只在抽查模式、焦点不在输入框时）
  const onKey = e => {
    if (!shown || mode !== 'review' || e.target.closest?.('input,select,textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
    const map = { 1: ['pageType', 'right'], 2: ['pageType', 'wrong'], 3: ['topics', 'right'], 4: ['topics', 'wrong'] };
    if (map[e.key]) { e.preventDefault(); void verdict(...map[e.key]).catch(err => notice(err.message)); }
    else if (e.key === '0') { e.preventDefault(); void act('rv-skip').catch(err => notice(err.message)); }
  };
  async function saveRename(input) {
    if (!renaming) return;
    renaming = '';
    const to = input.value.trim(), old = input.defaultValue;
    if (to === old) { drawTree(); return; }
    try { await call('ppt-map-rename', { dim: input.dataset.dim, key: input.dataset.key, to }); notice(to ? `已改名为「${to}」，下次更新库地图也会保留。` : '已恢复默认名字。'); }
    finally { await loadTree(); }
  }
  async function act(name, b, e) {
    if (name === 'toggle') { e?.stopPropagation(); const id = b.dataset.id; if (expanded.has(id) || findNode(id)?.open) expanded.delete(id); else expanded.add(id); drawTree(); return; }
    if (name === 'node') {
      if (e?.target.closest('[data-pptg="toggle"]')) return act('toggle', e.target.closest('[data-pptg="toggle"]'), e);
      selected = b.dataset.id; listPage = 0; pickedPage = '';
      if (findNode(selected)?.children?.length) expanded.add(selected);
      drawTree(); return loadPages();
    }
    if (name === 'rename') { e?.stopPropagation(); renaming = b.dataset.id; drawTree(); return; }
    if (name === 'pick') { pickedPage = b.dataset.id; for (const el of root.querySelectorAll('.pptg-item')) el.classList.toggle('on', el.dataset.id === pickedPage); drawDetail(); return; }
    if (name === 'prev' || name === 'next') { listPage += name === 'next' ? 1 : -1; return loadPages(); }
    if (name === 'tree-prev' || name === 'tree-next') { treePage += name === 'tree-next' ? 1 : -1; drawTree(); return; }
    if (name === 'group') { group = b.dataset.group; for (const x of root.querySelectorAll('[data-pptg="group"]')) x.setAttribute('aria-pressed', String(x.dataset.group === group)); selected = ''; treePage = 0; expanded = new Set(); return loadTree(); }
    if (name === 'update') { await call('ppt-map-start'); await loadState(); notice('已开始更新库地图：只处理新增或改过的文件，可以继续用别的功能。'); schedule(); return; }
    if (name === 'cancel') { await call('ppt-map-cancel'); await loadState(); schedule(); return; }
    if (name === 'build-index') {
      b.disabled = true;
      const st = await call('ppt-status');
      if (st.ppt?.roots?.length) await call('ppt-index'); else { const r = await call('ppt-pick-folders'); if (r.canceled) { b.disabled = false; return; } }
      autoStarted = false; notice(''); await loadState(); schedule(); return;
    }
    if (name === 'open') {
      const id = b.dataset.id; b.disabled = true;
      try { const r = await openPage(id); notice(r?.pageFocused === false ? `已打开文件，请手动查看第 ${r.page} 页；当前环境未能自动跳页。` : `已打开到第 ${r?.page ?? ''} 页。`); }
      finally { b.disabled = false; }
      return;
    }
    if (name === 'folder') { await call('ppt-show-folder', { id: b.dataset.id }); return; }
    if (name === 'review') {
      const r = await call('ppt-map-review');
      review = r.review && r.review.items.some(i => !(i.verdict.pageType && i.verdict.topics)) ? r.review : (await call('ppt-map-review-start', { n: 50 })).review;
      reviewAt = Math.max(0, review.items.findIndex(i => !(i.verdict.pageType && i.verdict.topics))); if (reviewAt < 0) reviewAt = review.items.length;
      mode = 'review'; drawGuide(); drawReview(); return;
    }
    if (name === 'vd') return verdict(b.dataset.dim, b.dataset.val);
    if (name === 'rv-skip') { const it = review?.items[reviewAt]; if (!it) return; review = (await call('ppt-map-verdict', { id: it.id, pageType: 'skip', topics: 'skip' })).review; reviewAt++; drawReview(); return; }
    if (name === 'rv-prev') { reviewAt = Math.max(0, reviewAt - 1); drawReview(); return; }
    if (name === 'rv-next') { reviewAt = Math.min(review.items.length, reviewAt + 1); drawReview(); return; }
    if (name === 'rv-back') { reviewAt = 0; drawReview(); return; }
    if (name === 'rv-new') { review = (await call('ppt-map-review-start', { n: 50 })).review; reviewAt = 0; drawReview(); return; }
    if (name === 'rv-exit') { mode = 'map'; drawGuide(); await loadTree(); return; }
  }
  // 拖文件到主题 / 材料类型节点
  root.addEventListener('dragstart', e => { const f = e.target.closest?.('[data-path]'); if (!f) return; e.dataTransfer.setData('text/x-ppt-map-file', f.dataset.path); e.dataTransfer.effectAllowed = 'move'; root.dataset.dragging = '1'; });
  root.addEventListener('dragend', () => { delete root.dataset.dragging; for (const el of root.querySelectorAll('.drop-over')) el.classList.remove('drop-over'); });
  root.addEventListener('dragover', e => { const t = e.target.closest?.('[data-drop]'); if (!t || !e.dataTransfer?.types?.includes('text/x-ppt-map-file')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; for (const el of root.querySelectorAll('.drop-over')) if (el !== t) el.classList.remove('drop-over'); t.classList.add('drop-over'); });
  root.addEventListener('drop', e => {
    const t = e.target.closest?.('[data-drop]'), file = e.dataTransfer?.getData('text/x-ppt-map-file'); delete root.dataset.dragging;
    for (const el of root.querySelectorAll('.drop-over')) el.classList.remove('drop-over');
    if (!t || !file) return; e.preventDefault();
    void move(file, t.dataset.drop === 'topic' ? { topic: t.dataset.topic } : { topic: t.dataset.topic, deckType: t.dataset.key }).catch(err => notice(err.message));
  });
  let resizeTimer = null;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!shown || mode !== 'map') return; drawTree(); if (listSizeNow() !== listSize) { listPage = 0; void loadPages().catch(() => {}); } }, 120); };
  return {
    async show() {
      const upgrade = doctorState() === 'upgrade';
      root.dataset.doctorUpgrade = String(upgrade);
      if (upgrade) {
        // 页头已提供升级按钮，旧版不再自动扫描和展开重复的技术错误。
        shown = false; clearTimeout(pollTimer);
        window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey);
        root.dataset.empty = '1';
        $('[data-pptg-body]').hidden = true; $('[data-pptg-review]').hidden = true;
        $('[data-pptg-warn]').hidden = true; $('[data-pptg-status]').textContent = '';
        const guide = $('[data-pptg-guide]'); guide.hidden = false;
        guide.innerHTML = '<p class="pptw-empty">库地图暂不可用</p>';
        return;
      }
      shown = true; window.addEventListener('resize', onResize); document.addEventListener('keydown', onKey);
      void tick();
    },
    hide() { shown = false; clearTimeout(pollTimer); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); },
  };
}
module.exports = { createPptMap };
