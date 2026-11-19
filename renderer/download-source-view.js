'use strict';
// 下载源标识（r58，2026-11-19）：每个会从阿里云下载的按钮旁边，先显示「公司内源」能不能给这个包。
// 状态由主进程 download-source:status 算（core/app-update/source-status.js）；这里只负责画一行字和刷新。
// 用法：在按钮附近放 <p data-dl-source="<下载点编号>"></p>，然后 DownloadSourceView.fill(容器)。
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.dl-src { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; line-height: 1.5; color: var(--fg-muted, #6b7080); flex-wrap: wrap; }
.dl-src .dl-src-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; font-weight: 600; font-size: 11.5px;
  border: 1px solid rgba(52, 120, 246, .45); color: #2a64d6; background: rgba(52, 120, 246, .08); white-space: nowrap; }
.dl-src[data-status="ok"] .dl-src-tag, .dl-src[data-status="internal"] .dl-src-tag { border-color: rgba(47, 138, 87, .5); color: #23774a; background: rgba(47, 138, 87, .1); }
.dl-src[data-status="missing"] .dl-src-tag, .dl-src[data-status="partial"] .dl-src-tag, .dl-src[data-status="down"] .dl-src-tag { border-color: rgba(194, 91, 18, .45); color: #a24d10; background: rgba(194, 91, 18, .08); }
.dl-src .dl-src-text { overflow-wrap: anywhere; }
`;

let cssDone = false;
// 最近一次查到的状态（按下载点编号）：界面重画时先显示上次的结果，不会每次闪回「检查中」。
const known = new Map();
function ensureCss(doc = typeof document === 'undefined' ? null : document) {
  if (cssDone || !doc || !doc.head) return;
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style); cssDone = true;
}

const TAG = { ok: '内源 · 可用', partial: '内源 · 部分', missing: '内源 · 缺包', down: '内源 · 连不上', checking: '内源 · 检查中', off: '内源 · 已关闭', internal: '内源 · 公司官方' };

// status：source-status.js 的 view()；没有时显示「检查中」。point 写进 data 属性，方便验收脚本逐个核对。
function html(status, point = '', label = '') {
  const s = status && status.status ? status : { status: 'checking', text: '公司内源 · 正在检查…' };
  const order = s.order ? `<span class="dl-src-order">顺序：${esc(s.order)}</span>` : '';
  return `<span class="dl-src-tag">${esc(TAG[s.status] || TAG.checking)}</span><span class="dl-src-text">${label ? esc(label) + ' ' : ''}下载源：${esc(s.text)}</span>${order}`;
}

// 把容器里所有 [data-dl-source] 填上状态；fresh 为 true 时主进程不用缓存重查。
async function fill(root, { ipcRenderer = require('electron').ipcRenderer, fresh = false } = {}) {
  ensureCss();
  if (!root) return [];
  const slots = [...(root.matches && root.matches('[data-dl-source]') ? [root] : []), ...root.querySelectorAll('[data-dl-source]')];
  return Promise.all(slots.map(async slot => {
    const point = slot.dataset.dlSource;
    slot.classList.add('dl-src');
    if (!slot.dataset.status) { slot.dataset.status = 'checking'; slot.innerHTML = html(known.get(point), point, slot.dataset.dlLabel || ''); }
    let status = null;
    try { status = await ipcRenderer.invoke('download-source:status', { point, fresh }); } catch (_) { status = null; }
    if (!status || !status.status) status = { status: 'down', text: '公司内源 · 没查到状态，本次走阿里云' };
    known.set(point, status);
    if (!slot.isConnected && typeof document !== 'undefined') return status;
    slot.dataset.status = status.status;
    slot.innerHTML = html(status, point, slot.dataset.dlLabel || '');
    slot.title = status.reason ? `内源：${status.reason}` : '先从公司内源下载；内源没有或连不上时自动改用阿里云，下载后都核对 SHA-256';
    return status;
  }));
}

// 一行占位（给拼 HTML 字符串的页面用）：tag 可以是 p / div / span。
function slotHtml(point, tag = 'p', label = '') {
  const last = known.get(point);
  return `<${tag} class="dl-src" data-dl-source="${esc(point)}"${label ? ` data-dl-label="${esc(label)}"` : ''} data-status="${esc(last ? last.status : 'checking')}">${html(last, point, label)}</${tag}>`;
}

module.exports = { CSS, TAG, html, fill, slotHtml, ensureCss, _known: known };
