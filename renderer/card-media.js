'use strict';
// 会话卡片里的图片与 mermaid 图（反馈 24156241）。
// - 回答里的 ![说明](路径或网址)：本地图片只认会话工作目录里的图片文件（防任意读盘），
//   data: 内嵌图片直接显示，网络图片点一下才加载（防回答里藏的图片链接把内容带出去）。
// - ```mermaid 代码块：离线打包的 mermaid 画成图，画不出来保留代码块并说明原因。
// 两者都能点开放大；mermaid 保留「复制源码」「看源码」。卡片没经过这里时仍按原来的链接/代码块显示。
const nodePath = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico']);
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_MERMAID_CHARS = 50000;

function isUncLike(value) { return /^(?:\\\\|\/\/)/.test(value); }

// 把回答里的图片地址分成三类：本地文件、data 内嵌、网络；其余一律不显示。
function classifyImageSource(raw) {
  const src = String(raw || '').trim();
  if (!src) return { kind: 'invalid', reason: '图片地址为空' };
  if (DATA_IMAGE_RE.test(src)) return { kind: 'data', src };
  if (/^http:\/\//i.test(src)) return { kind: 'invalid', reason: '只显示 https 网络图片' };
  if (/^https:\/\//i.test(src)) {
    try { const url = new URL(src); return { kind: 'remote', src: url.href, host: url.host }; }
    catch { return { kind: 'invalid', reason: '网址无法解析' }; }
  }
  if (/^file:/i.test(src)) {
    try { return { kind: 'local', path: fileURLToPath(src) }; }
    catch { return { kind: 'invalid', reason: '文件地址无法解析' }; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return { kind: 'invalid', reason: '不支持这种图片地址' };
  return { kind: 'local', path: src };
}

function insideDir(child, parent) {
  const rel = nodePath.relative(parent, child);
  return rel === '' ? false : !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

// 本地图片只放行会话工作目录里的图片文件。先按字面路径挡掉目录外的文件（目录外的路径一次都不去碰），
// 再从工作目录往下逐级 lstat：路径上有任何链接或 junction 就不显示——不去解析链接，免得顺着链接碰到目录外或网络共享。
function resolveLocalImage(rawPath, cwd, fsApi = require('node:fs')) {
  const value = String(rawPath || '').trim();
  if (!value) return { ok: false, reason: '图片路径为空' };
  if (isUncLike(value)) return { ok: false, reason: '不显示网络共享路径上的图片' };
  if (!cwd || isUncLike(String(cwd)) || !nodePath.isAbsolute(String(cwd))) return { ok: false, reason: '这个会话没有工作目录，本地图片不直接显示' };
  const ext = nodePath.extname(value.split(/[?#]/)[0]).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return { ok: false, reason: '不是图片文件' };
  const base = nodePath.resolve(String(cwd));
  const target = nodePath.resolve(base, value);
  if (!insideDir(target, base)) return { ok: false, reason: '图片不在会话工作目录里，为安全起见不直接显示' };
  let realBase;
  try { realBase = fsApi.realpathSync.native ? fsApi.realpathSync.native(base) : fsApi.realpathSync(base); }
  catch { return { ok: false, reason: '会话工作目录不存在' }; }
  if (isUncLike(realBase)) return { ok: false, reason: '工作目录在网络共享上，本地图片不直接显示' };
  let current = base, stat = null;
  for (const part of nodePath.relative(base, target).split(nodePath.sep)) {
    current = nodePath.join(current, part);
    try { stat = fsApi.lstatSync(current); } catch { return { ok: false, reason: '图片文件不存在' }; }
    if (stat.isSymbolicLink()) return { ok: false, reason: '图片路径经过目录链接，为安全起见不直接显示' };
  }
  if (!stat || !stat.isFile()) return { ok: false, reason: '不是图片文件' };
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, reason: '图片超过 30 MB，不直接显示' };
  return { ok: true, path: target, src: pathToFileURL(target).href + '?v=' + Math.round(stat.mtimeMs || 0) };
}

// mermaid 画图时临时元素挂在主页面上，页面允许加载本地文件：源码里引用图片、外部资源或样式 url 的图一律不画，
// 回退成代码块（strict 安全级别只清洗最终结果，挡不住绘制过程中的加载）。
const MERMAID_RISKY_RE = /\bimg\s*:|<\s*(?:img|image|svg|iframe|object|embed|link|style|script)\b|url\s*\(|@import|\bfile:|\bicon\s*:/i;
function mermaidRisk(source) {
  const match = String(source || '').match(MERMAID_RISKY_RE);
  return match ? '图表里引用了图片、链接或外部样式（' + match[0].trim().slice(0, 20) + '），为安全起见不画' : '';
}

// mermaid 出的 SVG 宽度写的是 100%，放进 <img> 会失去尺寸；按 viewBox 写回像素宽高。
function sizeMermaidSvg(svg) {
  const text = String(svg || '');
  const viewBox = text.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
  if (!viewBox) return { svg: text, width: 0, height: 0 };
  const width = Math.ceil(Number(viewBox[1])), height = Math.ceil(Number(viewBox[2]));
  const sized = text.replace(/<svg\b([^>]*)>/, (match, attrs) => {
    const cleaned = attrs.replace(/\s(?:width|height)="[^"]*"/g, '').replace(/\sstyle="[^"]*"/, '');
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });
  return { svg: sized, width, height };
}

function svgDataUrl(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

function createCardMedia({ document: doc, window: win, getCwd = () => null, copyText = null, fs: fsApi,
  fetchRemoteImage = null } = {}) {
  const mermaidCache = new Map();
  const localCache = new Map();
  const remoteCache = new Map();
  const allowedRemote = new Set();
  let mermaidLoad = null, renderSeq = 0;

  function remember(map, key, value, limit = 300) {
    map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value);
    return value;
  }

  function dialog(title) {
    const modal = doc.createElement('dialog');
    modal.className = 'card-detail-dialog card-media-dialog';
    const head = doc.createElement('div'); head.className = 'card-detail-dialog-head';
    const label = doc.createElement('strong'); label.textContent = title;
    const tools = doc.createElement('span'); tools.className = 'card-media-dialog-tools';
    const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    close.addEventListener('click', () => modal.close());
    tools.appendChild(close); head.append(label, tools); modal.appendChild(head); doc.body.appendChild(modal);
    modal.addEventListener('close', () => modal.remove(), { once: true });
    modal.addEventListener('click', event => { if (event.target === modal) modal.close(); });
    return { modal, tools, close };
  }

  function openZoom(src, title, extra = []) {
    const { modal, tools, close } = dialog(title || '查看图片');
    for (const button of extra) tools.insertBefore(button, close);
    const frame = doc.createElement('div'); frame.className = 'card-media-zoom';
    const img = doc.createElement('img'); img.className = 'card-media-zoom-img'; img.alt = title || '';
    // 矢量图（mermaid、SVG）放大到铺满对话框也清晰；位图按原尺寸、超出时缩到可见。
    if (/^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#]|$)/i.test(src)) img.classList.add('card-media-zoom-vector');
    img.src = src; frame.appendChild(img); modal.appendChild(frame);
    img.addEventListener('click', () => img.classList.toggle('card-media-actual'));
    modal.showModal();
    return modal;
  }

  function button(text, action) {
    const b = doc.createElement('button'); b.type = 'button'; b.className = 'card-media-btn'; b.textContent = text;
    if (action) b.dataset.action = action;
    return b;
  }

  async function copy(textValue, b) {
    try {
      if (typeof copyText === 'function') {
        const result = await copyText(textValue, { source: 'card-mermaid', silent: true });
        if (result && result.ok === false) throw new Error(result.reason || '复制失败');
      } else await win.navigator.clipboard.writeText(textValue);
      b.textContent = '已复制源码';
    } catch { b.textContent = '复制失败'; }
  }

  // ── 图片 ──
  function imageNote(holder, text) {
    let note = holder.querySelector('.card-md-image-note');
    if (!note) { note = doc.createElement('span'); note.className = 'card-md-image-note'; holder.appendChild(note); }
    note.textContent = text;
  }

  function showImage(holder, src, caption) {
    const alt = holder.dataset.mdImageAlt || '';
    holder.textContent = '';
    const thumb = doc.createElement('button');
    thumb.type = 'button'; thumb.className = 'card-md-image-thumb'; thumb.dataset.action = 'card-media-zoom';
    thumb.title = '点开放大' + (caption ? '：' + caption : '');
    const img = doc.createElement('img'); img.className = 'card-md-image-img'; img.alt = alt || caption || '图片';
    img.loading = 'lazy'; img.decoding = 'async'; img.src = src;
    img.addEventListener('error', () => {
      holder.textContent = caption || alt || '图片';
      holder.dataset.mdImageState = 'error';
      imageNote(holder, '图片加载失败');
    }, { once: true });
    thumb.appendChild(img);
    const cap = doc.createElement('span'); cap.className = 'card-md-image-caption'; cap.textContent = alt || caption || '';
    holder.append(thumb);
    if (cap.textContent) holder.append(cap);
    holder.dataset.mdImageState = 'shown';
  }

  // 网络图片由主进程取回成 data: 地址；同一网址只取一次。
  function loadRemote(holder, info) {
    holder.dataset.mdImageState = 'loading';
    holder.querySelector('[data-action="card-media-load-remote"]')?.remove();
    imageNote(holder, '正在加载网络图片…');
    let job = remoteCache.get(info.src);
    if (!job) {
      job = Promise.resolve().then(() => fetchRemoteImage(info.src))
        .catch(error => ({ ok: false, reason: String(error?.message || error) }));
      remember(remoteCache, info.src, job, 100);
      job.then(result => { if (!result?.ok) remoteCache.delete(info.src); });
    }
    return job.then(result => {
      if (!holder.isConnected) return;
      if (result?.ok) return showImage(holder, result.dataUrl, info.host);
      holder.dataset.mdImageState = 'remote';
      imageNote(holder, (result?.reason || '图片加载失败') + '，');
      const retry = button('重试', 'card-media-load-remote'); holder.append(retry);
    });
  }

  function processImage(holder, cwd) {
    if (holder.dataset.mdImageState) return;
    const raw = holder.dataset.mdImageSrc || '';
    const info = classifyImageSource(raw);
    if (info.kind === 'data') return showImage(holder, info.src, '内嵌图片');
    if (info.kind === 'remote') {
      if (typeof fetchRemoteImage !== 'function') { holder.dataset.mdImageState = 'blocked'; return; }
      if (allowedRemote.has(info.src)) return loadRemote(holder, info);
      holder.dataset.mdImageState = 'remote';
      const load = button('显示网络图片（' + info.host + '）', 'card-media-load-remote');
      load.title = '这张图片要访问 ' + info.host + '；点一下才加载（每张图单独确认，防回答里藏的链接把内容带出去）';
      holder.append(' ', load);
      return;
    }
    if (info.kind === 'local') {
      // 流式刷新时同一张图几秒内不重复查盘；失败不缓存，图片稍后生成或更新后能显示新版。
      const key = (cwd || '') + '\n' + info.path, now = Date.now(), hit = localCache.get(key);
      let result = hit && now - hit.at < 3000 ? hit.result : null;
      if (!result) {
        result = resolveLocalImage(info.path, cwd, fsApi);
        if (result.ok) remember(localCache, key, { result, at: now }); else localCache.delete(key);
      }
      if (result.ok) return showImage(holder, result.src, nodePath.basename(result.path));
      holder.dataset.mdImageState = 'blocked';
      return imageNote(holder, result.reason);
    }
    holder.dataset.mdImageState = 'blocked';
    imageNote(holder, info.reason);
  }

  // ── mermaid ──
  // mermaid 放进一个隐藏的沙箱小框架里画（sandbox="allow-scripts"，不给同源）：框架是独立的不透明来源，
  // 拿不到主页面的 require、文件和 Cookie，只能通过 postMessage 收源码、回 SVG（框架页面见 card-mermaid-frame.html）；
  // 框架自带安全策略，只许内嵌（data:）图片与字体，源码里漏网的图片、样式 url 也碰不到本地文件和网络（第一道防线是 mermaidRisk）。
  const MERMAID_CONFIG = { startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false,
    fontFamily: '"Microsoft YaHei", "Segoe UI", sans-serif', suppressErrorRendering: true, maxTextSize: MAX_MERMAID_CHARS,
    // secure 里的配置项不许图表源码里的 %%{init}%% 改：安全级别、主题样式、字体、HTML 标签等。
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
      'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'htmlLabels', 'flowchart', 'dompurifyConfig'] };
  const MERMAID_TIMEOUT_MS = 20000;
  let mermaidFrame = null, frameSeq = 0;
  const frameJobs = new Map();

  function onFrameMessage(event) {
    if (!mermaidFrame || event.source !== mermaidFrame.contentWindow) return;
    const data = event.data || {};
    const key = data.type === 'ready' ? 'ready' : data.seq;
    const job = frameJobs.get(key);
    if (!job) return;
    frameJobs.delete(key);
    clearTimeout(job.timer);
    if (data.ok) job.resolve(data); else job.reject(new Error(data.error || '画图失败'));
  }

  function frameCall(key, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { frameJobs.delete(key); reject(new Error('画图超时')); }, MERMAID_TIMEOUT_MS);
      frameJobs.set(key, { resolve, reject, timer });
      if (message) mermaidFrame.contentWindow.postMessage(message, '*');
    });
  }

  function loadMermaid() {
    if (mermaidLoad) return mermaidLoad;
    mermaidLoad = Promise.resolve().then(() => {
      win.addEventListener('message', onFrameMessage);
      const frame = mermaidFrame = doc.createElement('iframe');
      frame.className = 'card-mermaid-sandbox'; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1600px;height:1200px;border:0;visibility:hidden;pointer-events:none';
      // 沙箱框架读不到本地文件（脚本也不行），所以框架页面自带引导脚本，mermaid 代码由这里读出来经 postMessage 发进去。
      const ready = frameCall('ready');
      frame.src = pathToFileURL(nodePath.join(__dirname, 'card-mermaid-frame.html')).href;
      (doc.body || doc.documentElement).appendChild(frame);
      return ready;
    }).then(() => {
      const code = require('node:fs').readFileSync(nodePath.join(__dirname, 'vendor', 'mermaid', 'mermaid.min.js'), 'utf8');
      const seq = ++frameSeq;
      return frameCall(seq, { type: 'load', seq, code, config: MERMAID_CONFIG });
    });
    mermaidLoad.catch(() => {
      mermaidLoad = null; mermaidFrame?.remove(); mermaidFrame = null;
      win.removeEventListener('message', onFrameMessage);
    });
    return mermaidLoad;
  }

  async function drawMermaid(source) {
    await loadMermaid();
    const seq = ++frameSeq;
    const { svg } = await frameCall(seq, { type: 'render', seq, id: 'hub-mermaid-' + (++renderSeq), source });
    return sizeMermaidSvg(svg);
  }

  function renderMermaid(source) {
    if (mermaidCache.has(source)) return mermaidCache.get(source);
    const job = Promise.resolve().then(() => {
      if (source.length > MAX_MERMAID_CHARS) throw new Error('图表源码太长');
      const risk = mermaidRisk(source);
      if (risk) throw new Error(risk);
      return drawMermaid(source);
    });
    const settled = job.then(value => ({ ok: true, ...value }), error => ({ ok: false, error: String(error?.message || error).split('\n')[0].slice(0, 160) }));
    remember(mermaidCache, source, settled, 100);
    return settled;
  }

  function applyMermaid(wrap, result) {
    if (!wrap.isConnected || wrap.dataset.mermaidState === 'shown') return;
    const pre = wrap.querySelector('pre');
    if (!result.ok) {
      wrap.dataset.mermaidState = 'failed';
      let note = wrap.querySelector('.card-mermaid-note');
      if (!note) { note = doc.createElement('div'); note.className = 'card-mermaid-note'; note.dataset.copyExclude = ''; wrap.appendChild(note); }
      note.textContent = '图表没画出来，按源码显示' + (result.error ? '：' + result.error : '');
      return;
    }
    wrap.dataset.mermaidState = 'shown';
    wrap.querySelector('.card-mermaid-note')?.remove();
    const figure = doc.createElement('div'); figure.className = 'card-mermaid-figure'; figure.dataset.copyExclude = '';
    const thumb = doc.createElement('button'); thumb.type = 'button'; thumb.className = 'card-mermaid-thumb';
    thumb.dataset.action = 'card-media-zoom'; thumb.title = '点开放大';
    const img = doc.createElement('img'); img.className = 'card-mermaid-img'; img.alt = 'mermaid 图';
    img.src = svgDataUrl(result.svg);
    if (result.width) img.style.width = Math.min(result.width, 2000) + 'px';
    thumb.appendChild(img);
    const bar = doc.createElement('div'); bar.className = 'card-mermaid-bar';
    bar.append(button('放大', 'card-media-zoom'), button('看源码', 'card-mermaid-source'), button('复制源码', 'card-mermaid-copy'));
    figure.append(thumb, bar);
    wrap.insertBefore(figure, wrap.firstChild);
    // 用行内样式藏源码：复制整条回答时 visible-card-text 会把它放回来，复制的仍是源码。
    if (pre) pre.style.display = 'none';
    wrap.classList.add('card-mermaid-rendered');
  }

  function mermaidSource(wrap) { return (wrap.querySelector('pre code')?.textContent || '').replace(/\s+$/, ''); }

  // 懒渲染：只画进入可视区的图（后台会话、折叠或滚到屏幕外的不画），同一时间最多画 1 张；
  // 进入可视区后等 600 毫秒再排队，流式输出时卡片整张重画、旧的图块已脱离页面，就不白画。
  const visibleWraps = new Set(), observedWraps = new Set(), waitTimers = new Map(), drawQueue = [];
  let observer = null, drawing = false;

  function getObserver() {
    if (observer !== null) return observer;
    const IO = win && win.IntersectionObserver;
    observer = typeof IO === 'function' ? new IO(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) { visibleWraps.add(entry.target); waitThenQueue(entry.target); }
        else visibleWraps.delete(entry.target);
      }
    }, { rootMargin: '300px 0px' }) : false;
    return observer;
  }

  function forget(wrap) {
    if (observer) observer.unobserve(wrap);
    observedWraps.delete(wrap); visibleWraps.delete(wrap);
    clearTimeout(waitTimers.get(wrap)); waitTimers.delete(wrap);
  }

  function waitThenQueue(wrap) {
    if (waitTimers.has(wrap)) return;
    waitTimers.set(wrap, setTimeout(() => {
      waitTimers.delete(wrap);
      if (!wrap.isConnected) return forget(wrap);
      if (!observer || visibleWraps.has(wrap)) { if (!drawQueue.includes(wrap)) drawQueue.push(wrap); pumpMermaid(); }
    }, 600));
  }

  function pumpMermaid() {
    if (drawing) return;
    while (drawQueue.length) {
      const wrap = drawQueue.shift();
      if (!wrap.isConnected || wrap.dataset.mermaidState) { forget(wrap); continue; }
      if (observer && !visibleWraps.has(wrap)) continue; // 排队期间滚出了可视区：等下次进来再排
      const source = mermaidSource(wrap);
      forget(wrap);
      if (!source.trim()) continue;
      wrap.dataset.mermaidState = 'pending';
      drawing = true;
      renderMermaid(source).then(result => applyMermaid(wrap, result)).finally(() => { drawing = false; pumpMermaid(); });
      return;
    }
  }

  function watchMermaid(wrap) {
    if (observedWraps.has(wrap)) return;
    const io = getObserver();
    observedWraps.add(wrap);
    if (io) io.observe(wrap); else waitThenQueue(wrap);
  }

  function pruneDetached() {
    for (const wrap of observedWraps) if (!wrap.isConnected) forget(wrap);
  }

  function processCard(card, { sessionId } = {}) {
    if (!card?.querySelectorAll) return;
    const cwd = getCwd(sessionId, card);
    for (const holder of card.querySelectorAll('.card-md-image[data-md-image-src]')) {
      try { processImage(holder, cwd); } catch (error) { console.warn('[card-media] image:', error?.message); }
    }
    const blocks = card.querySelectorAll('.code-block-wrap[data-lang="mermaid"]:not([data-mermaid-state])');
    if (!blocks.length) return;
    pruneDetached();
    // 已画过的同一份源码立刻贴回（流式刷新整张卡时不闪）；新源码等进入可视区再画。
    for (const wrap of blocks) {
      const cached = mermaidCache.get(mermaidSource(wrap));
      if (cached) { wrap.dataset.mermaidState = 'pending'; cached.then(result => applyMermaid(wrap, result)); }
      else watchMermaid(wrap);
    }
  }

  function onClick(event) {
    const target = event.target?.closest?.('[data-action^="card-media-"],[data-action^="card-mermaid-"]');
    if (!target) return false;
    event.preventDefault(); event.stopPropagation();
    const action = target.dataset.action;
    if (action === 'card-media-load-remote') {
      const holder = target.closest('.card-md-image');
      const info = classifyImageSource(holder?.dataset.mdImageSrc);
      if (info.kind === 'remote' && typeof fetchRemoteImage === 'function') { allowedRemote.add(info.src); void loadRemote(holder, info); }
      return true;
    }
    const wrap = target.closest('.code-block-wrap');
    if (action === 'card-mermaid-copy') { void copy(mermaidSource(wrap), target); return true; }
    if (action === 'card-mermaid-source') {
      const showing = wrap.classList.toggle('card-mermaid-show-source');
      const pre = wrap.querySelector('pre');
      if (pre) pre.style.display = showing ? '' : 'none';
      target.textContent = showing ? '收起源码' : '看源码';
      return true;
    }
    if (action === 'card-media-zoom') {
      const img = (wrap && wrap.classList.contains('card-mermaid-rendered') ? wrap.querySelector('.card-mermaid-img') : null)
        || target.querySelector('img') || target.closest('.card-md-image')?.querySelector('img');
      if (!img) return true;
      if (wrap) {
        const copyBtn = button('复制源码'); copyBtn.addEventListener('click', () => copy(mermaidSource(wrap), copyBtn));
        openZoom(img.src, 'mermaid 图', [copyBtn]);
      } else openZoom(img.src, img.alt || '查看图片');
      return true;
    }
    return false;
  }

  // _drawMermaidUnchecked 只给界面测试用：跳过第一道关键字检查，验证小框架这道防线本身挡得住。
  return { processCard, onClick, openZoom, _drawMermaidUnchecked: drawMermaid,
    _mermaidStats: () => ({ drawing, queued: drawQueue.length, watching: observedWraps.size }) };
}

module.exports = { classifyImageSource, resolveLocalImage, sizeMermaidSvg, mermaidRisk, createCardMedia, IMAGE_EXT };
