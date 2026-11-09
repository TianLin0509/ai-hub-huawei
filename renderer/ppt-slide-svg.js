'use strict';
// 把 core/company-assistant/ppt-slide-preview.js 产出的「场景」画成一张 SVG（单位：磅，viewBox 即幻灯片尺寸，随容器缩放）。
// 文字用 foreignObject 里的 HTML 排版（能自动换行）；图片用 file:// 地址（index.html 的 CSP 允许 img-src file:）。
const { pathToFileURL } = require('node:url');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => Math.round(Number(v) * 10) / 10 || 0;
const safeColor = c => /^(#[0-9A-Fa-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0|1|0?\.\d+)\))$/.test(String(c || '')) ? c : '';
const url = file => { try { return pathToFileURL(file).href; } catch { return ''; } };
const FONT = "'Microsoft YaHei','微软雅黑','PingFang SC',sans-serif";

function rotate(it) { return it.rot ? ` transform="rotate(${n(it.rot)} ${n(it.x + it.w / 2)} ${n(it.y + it.h / 2)})"` : ''; }
function parasHtml(paras, fallbackColor) {
  return (paras || []).map(p => {
    const align = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[p.align] || 'left';
    const indent = p.lvl ? `padding-left:${p.lvl * 1.2}em;` : '';
    const runs = p.runs.length ? p.runs.map(r => r.text === '\n' ? '<br>' : `<span style="font-size:${n(r.sz || 18)}px;${r.b ? 'font-weight:700;' : ''}${safeColor(r.color) ? 'color:' + safeColor(r.color) + ';' : ''}">${esc(r.text)}</span>`).join('') : `<span style="font-size:${n(p.sz || 18)}px">&#8203;</span>`;
    return `<div style="text-align:${align};${indent}">${p.bullet ? '<span style="padding-right:.35em">•</span>' : ''}${runs}</div>`;
  }).join('');
}
function textItem(it, fallbackColor) {
  const [t, r, b, l] = it.inset || [3.6, 7.2, 3.6, 7.2];
  const justify = { ctr: 'center', b: 'flex-end' }[it.anchor] || 'flex-start';
  return `<foreignObject x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(1, n(it.w))}" height="${Math.max(1, n(it.h))}"${it.nowrap ? ' overflow="visible"' : ''}${rotate(it)}><div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;justify-content:${justify};padding:${n(t)}px ${n(r)}px ${n(b)}px ${n(l)}px;font-family:${FONT};line-height:1.18;color:${safeColor(fallbackColor) || '#000'};${it.nowrap ? 'white-space:nowrap;overflow:visible;' : 'overflow:hidden;word-break:break-word;'}${it.vert ? 'writing-mode:vertical-rl;' : ''}">${parasHtml(it.paras, fallbackColor)}</div></foreignObject>`;
}
function tableItem(it, fallbackColor) {
  const total = (it.cols || []).reduce((a, b) => a + b, 0) || 1;
  const cols = (it.cols || []).map(w => `<col style="width:${(w / total * 100).toFixed(2)}%">`).join('');
  const rows = (it.rows || []).map(row => `<tr>${row.cells.filter(c => !c.merged).map(c => `<td colspan="${Math.max(1, c.span | 0)}" style="border:.75px solid #BFBFBF;padding:2px 4px;vertical-align:top;${safeColor(c.fill) ? 'background:' + safeColor(c.fill) + ';' : ''}">${parasHtml(c.paras || [], fallbackColor)}</td>`).join('')}</tr>`).join('');
  return `<foreignObject x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(1, n(it.w))}" height="${Math.max(1, n(it.h))}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden;font-family:${FONT};line-height:1.15;color:${safeColor(fallbackColor) || '#000'}"><table style="width:100%;border-collapse:collapse;table-layout:fixed">${cols}${rows}</table></div></foreignObject>`;
}
function imageItem(it) {
  const href = url(it.src);
  if (!href) return '';
  if (it.crop) {
    const [l, t, r, b] = it.crop;
    const fw = it.w / Math.max(0.05, 1 - l - r), fh = it.h / Math.max(0.05, 1 - t - b);
    return `<svg x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(1, n(it.w))}" height="${Math.max(1, n(it.h))}" overflow="hidden"${rotate(it)}><image href="${esc(href)}" x="${n(-l * fw)}" y="${n(-t * fh)}" width="${n(fw)}" height="${n(fh)}" preserveAspectRatio="none"/></svg>`;
  }
  return `<image href="${esc(href)}" x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(1, n(it.w))}" height="${Math.max(1, n(it.h))}" preserveAspectRatio="none"${rotate(it)}/>`;
}
function boxItem(it) {
  const fill = safeColor(it.fill) || 'none', stroke = safeColor(it.stroke);
  const paint = `fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${n(it.lw || 0.75)}"` : ''}${rotate(it)}`;
  if (it.shape === 'ellipse') return `<ellipse cx="${n(it.x + it.w / 2)}" cy="${n(it.y + it.h / 2)}" rx="${n(it.w / 2)}" ry="${n(it.h / 2)}" ${paint}/>`;
  if (it.shape === 'tri') return `<polygon points="${n(it.x + it.w / 2)},${n(it.y)} ${n(it.x + it.w)},${n(it.y + it.h)} ${n(it.x)},${n(it.y + it.h)}" ${paint}/>`;
  if (it.shape === 'arrow') { const tip = Math.min(it.w * 0.3, it.h * 0.6); return `<polygon points="${n(it.x)},${n(it.y)} ${n(it.x + it.w - tip)},${n(it.y)} ${n(it.x + it.w)},${n(it.y + it.h / 2)} ${n(it.x + it.w - tip)},${n(it.y + it.h)} ${n(it.x)},${n(it.y + it.h)}" ${paint}/>`; }
  const rx = it.shape === 'round' ? n(Math.min(it.w, it.h) * 0.12) : 0;
  return `<rect x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(0.5, n(it.w))}" height="${Math.max(0.5, n(it.h))}"${rx ? ` rx="${rx}"` : ''} ${paint}/>`;
}
function lineItem(it) {
  const x1 = it.flipH ? it.x + it.w : it.x, x2 = it.flipH ? it.x : it.x + it.w;
  const y1 = it.flipV ? it.y + it.h : it.y, y2 = it.flipV ? it.y : it.y + it.h;
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${safeColor(it.color) || '#7F7F7F'}" stroke-width="${n(it.lw || 0.75)}"${rotate(it)}/>`;
}
function placeholderItem(it) {
  const size = Math.max(8, Math.min(it.h * 0.18, 18));
  return `<g${rotate(it)}><rect x="${n(it.x)}" y="${n(it.y)}" width="${Math.max(1, n(it.w))}" height="${Math.max(1, n(it.h))}" fill="#F2F4F7" stroke="#C9D1DC" stroke-dasharray="4 3" stroke-width=".75"/><text x="${n(it.x + it.w / 2)}" y="${n(it.y + it.h / 2)}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT)}" font-size="${n(size)}" fill="#7A8594">${esc(it.label || '对象')}</text></g>`;
}

function sceneSvg(scene, { title = '' } = {}) {
  if (!scene || !(scene.w > 0) || !(scene.h > 0)) return '';
  const fallbackColor = '#1F2329';
  const bg = scene.bg?.image ? `<image href="${esc(url(scene.bg.image))}" x="0" y="0" width="${n(scene.w)}" height="${n(scene.h)}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="${n(scene.w)}" height="${n(scene.h)}" fill="${safeColor(scene.bg?.color) || '#FFFFFF'}"/>`;
  const body = (scene.items || []).map(it => it.t === 'text' ? textItem(it, fallbackColor) : it.t === 'img' ? imageItem(it) : it.t === 'box' ? boxItem(it)
    : it.t === 'line' ? lineItem(it) : it.t === 'table' ? tableItem(it, fallbackColor) : it.t === 'ph' ? placeholderItem(it) : '').join('');
  return `<svg class="pptw-slide-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(scene.w)} ${n(scene.h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title || '幻灯片版式预览')}"><g>${bg}${body}</g></svg>`;
}

module.exports = { sceneSvg };
