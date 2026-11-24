'use strict';
// 统一下载进度条（r59，2026-11-19）：所有「一键安装 / 下载组件 / 更新」用同一个样式——
// 标题 + 百分比、进度条、「已下 / 总量 · 速度 · 还要多久」、来源标签（公司内源 / 本机已下好 …）。
// 数据来自 core/app-update/downloader.js 的 onProgress（received、total、speed、etaSec、sourceId、sourceName），
// 各下载模块原样透传到界面状态即可。只做纯函数 + 一次性注入样式，拼 HTML 字符串的页面直接调用 html()。
// 中性：「公司内源」只在 sourceId === 'openx' 时出现，公开版下载器不会产生这个来源。
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.dlp { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--fg-muted, #6b7080); min-width: 0; }
.dlp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.dlp-title { color: var(--fg-default, #1f2330); font-weight: 600; font-size: 12.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dlp-pct { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--brand, #3478f6); flex: none; }
.dlp-bar { position: relative; height: 8px; border-radius: 99px; background: var(--surface-sunken, #eceef3); overflow: hidden; }
.dlp-bar > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 99px; background: var(--brand, #3478f6); transition: width .25s ease; }
.dlp[data-indeterminate] .dlp-bar > i { width: 32% !important; animation: dlp-slide 1.3s ease-in-out infinite; opacity: .75; }
@keyframes dlp-slide { 0% { left: -32%; } 100% { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .dlp[data-indeterminate] .dlp-bar > i { animation: none; left: 0; width: 100% !important; opacity: .3; } }
.dlp[data-phase="done"] .dlp-bar > i { background: #2f8a57; }
.dlp[data-phase="error"] .dlp-bar > i, .dlp[data-phase="cancelled"] .dlp-bar > i { background: #c25b12; opacity: .55; }
.dlp-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 5px; flex-wrap: wrap; }
.dlp-nums { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dlp-src { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dlp-src b { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; font-weight: 600; font-size: 11.5px;
  border: 1px solid var(--border-mid, #d6d9e0); color: var(--fg-default, #3a3f4c); background: var(--surface-raised, #fff); white-space: nowrap; }
.dlp-src[data-kind="internal"] b { border-color: rgba(47, 138, 87, .5); color: #23774a; background: rgba(47, 138, 87, .1); }
.dlp-note { margin-top: 4px; overflow-wrap: anywhere; }
.dlp[data-phase="error"] .dlp-note { color: #a24d10; }
`;

let cssDone = false;
function ensureCss(doc = typeof document === 'undefined' ? null : document) {
  if (cssDone || !doc || !doc.head) return;
  const style = doc.createElement('style'); style.dataset.dlp = '1'; style.textContent = CSS; doc.head.appendChild(style); cssDone = true;
}

function fmtBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return Math.round(v) + ' B';
}
function fmtEta(sec) {
  if (sec == null || sec === '') return '';
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 1) return '马上好';
  if (s < 60) return `还要 ${Math.ceil(s)} 秒`;
  if (s < 3600) return `还要 ${Math.ceil(s / 60)} 分钟`;
  return `还要 ${Math.floor(s / 3600)} 小时 ${Math.ceil((s % 3600) / 60)} 分`;
}

// 来源名：下载器给的是 { id, name }；有的模块拿主机名当 name，这里翻成人话。
function sourceLabel(id, name) {
  if (id === 'openx') return { text: '公司内源', kind: 'internal' };
  if (id === 'local') return { text: '本机已下好', kind: 'local' };
  const raw = String(name || id || '').trim();
  if (!raw) return null;
  // 只走内源（R29/R35）后只剩本机测试注入的源会走到这里：照原名显示。
  return { text: raw, kind: 'external' };
}

const ACTIVE_TEXT = {
  connecting: '正在连接…', checking: '正在读取组件目录…', verifying: '正在校验文件…', extracting: '正在解压并校验…',
  installing: '正在安装…', probing: '正在试运行，确认能启动…', 'npm-fallback': '正在用 npm 安装…', applying: '正在换上新版本…',
};
const BUSY = new Set(['connecting', 'checking', 'downloading', 'verifying', 'extracting', 'installing', 'probing', 'npm-fallback', 'applying']);
const isBusy = p => !!p && BUSY.has(p.phase || (p.total ? 'downloading' : ''));

// 计算要显示的数字（给测试和需要自己排版的页面用）。
function view(p = {}) {
  const phase = p.phase || (p.total > 0 ? 'downloading' : 'connecting');
  const total = Number(p.total) || 0, received = Math.max(0, Number(p.received) || 0);
  const known = total > 0 && (phase === 'downloading' || received > 0);
  let percent = known ? Math.min(100, received / total * 100) : null;
  if (phase === 'done') percent = 100;
  const downloading = phase === 'downloading' && total > 0;
  const nums = downloading
    ? [`${fmtBytes(received)} / ${fmtBytes(total)}`, p.speed > 0 ? `${fmtBytes(p.speed)}/s` : '测速中', fmtEta(p.etaSec != null ? p.etaSec : (p.speed > 0 ? (total - received) / p.speed : null))].filter(Boolean).join(' · ')
    : phase === 'downloading' && received > 0 ? [`已下 ${fmtBytes(received)}`, p.speed > 0 ? `${fmtBytes(p.speed)}/s` : ''].filter(Boolean).join(' · ')   // 总量未知
    : (p.message || ACTIVE_TEXT[phase] || '');
  const step = p.step && p.step.count > 1 ? `第 ${p.step.index}/${p.step.count} 项` + (p.step.name ? `：${p.step.name}` : '') : '';
  const src = sourceLabel(p.sourceId, p.sourceName);
  return { phase, percent, indeterminate: percent == null && BUSY.has(phase), nums, step, source: src };
}

// p：进度对象；opts.title 标题（如「下载 PPT Doctor」）；opts.note 额外一行（错误原因、提示）；opts.attrs 附加属性串。
function html(p = {}, opts = {}) {
  ensureCss();
  const v = view(p);
  const title = [opts.title || '', v.step].filter(Boolean).join(' · ');
  const pct = v.percent == null ? '' : `${v.percent >= 99.5 || v.percent === 0 ? Math.round(v.percent) : v.percent < 10 ? v.percent.toFixed(1) : Math.floor(v.percent)}%`;
  const width = v.percent == null ? 0 : v.percent.toFixed(1);
  const src = v.source ? `<span class="dlp-src" data-kind="${v.source.kind}">来源 <b>${esc(v.source.text)}</b></span>` : '';
  const note = opts.note || (v.phase === 'error' ? p.error || p.message : '');
  return `<div class="dlp" data-dlp data-phase="${esc(v.phase)}"${v.indeterminate ? ' data-indeterminate' : ''}${opts.attrs ? ' ' + opts.attrs : ''}>`
    + `${title || pct ? `<div class="dlp-head"><span class="dlp-title">${esc(title)}</span><span class="dlp-pct">${pct}</span></div>` : ''}`
    + `<div class="dlp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"${v.percent == null ? '' : ` aria-valuenow="${Math.round(v.percent)}"`}><i style="width:${width}%"></i></div>`
    + `<div class="dlp-meta"><span class="dlp-nums">${esc(v.nums)}</span>${src}</div>`
    + `${note ? `<div class="dlp-note">${esc(note)}</div>` : ''}</div>`;
}

// 认领进度总线上某个下载点的进度（core/app-update/progress-bus.js → download-progress:update）。
// 同一次下载的多条消息合并（完成时还记得来源）；「connecting」表示新一次下载，清掉旧的。返回取消订阅函数。
const merged = new Map();
function subscribe(point, fn, ipcRenderer = require('electron').ipcRenderer) {
  const handler = (_event, p) => {
    if (!p || p.point !== point) return;
    const prev = p.phase === 'connecting' || p.phase === 'checking' ? {} : merged.get(point) || {};
    const next = { ...prev, ...p };
    if (p.phase !== 'downloading') { if (p.phase === 'connecting') next.received = 0; next.message = p.message || ''; }
    merged.set(point, next);
    try { fn(next); } catch (_) {}
  };
  ipcRenderer.on('download-progress:update', handler);
  return () => ipcRenderer.removeListener('download-progress:update', handler);
}
const lastOf = point => merged.get(point) || null;

// 把某个下载点的进度条挂到 host 上（没有自己界面状态的入口用：新建会话装 pi、首启准备、错误卡里的一键安装…）。
// 完成后 doneMs 毫秒收起；出错收起（错误由调用方照常提示）。返回取消订阅函数。
function mount(host, point, { title = '', doneMs = 6000, ipcRenderer } = {}) {
  if (!host) return () => {};
  let timer = null;
  const paint = state => {
    if (!host.isConnected) return;
    clearTimeout(timer);
    host.hidden = false;
    if (state.phase === 'error' || state.phase === 'cancelled' || state.phase === 'idle') { host.innerHTML = ''; return; }
    const message = state.phase === 'downloading' ? '' : state.message || '';
    host.innerHTML = html({ ...state, message }, { title });
    if (state.phase === 'done') timer = setTimeout(() => { host.innerHTML = ''; }, doneMs);
  };
  return subscribe(point, paint, ipcRenderer || require('electron').ipcRenderer);
}

module.exports = { CSS, ensureCss, html, view, fmtBytes, fmtEta, sourceLabel, isBusy, subscribe, lastOf, mount };
