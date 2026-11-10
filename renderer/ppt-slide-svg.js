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
// 预置形状轮廓（2026-11-10 素材预览）：按形状自身 w×h（磅）给多边形点，adj 是 avLst 调整值（已换成小数），缺省用 PowerPoint 默认值。
const ARROWS = { rightArrow: 0, leftArrow: 180, downArrow: 90, upArrow: 270 };
function presetPoints(prst, w, h, adj) {
  const ss = Math.min(w, h), a = (i, d) => (adj && Number.isFinite(adj[i]) ? adj[i] : d);
  if (prst === 'hexagon') { const k = Math.min(w / 2, ss * a(0, 0.25)); return [[k, 0], [w - k, 0], [w, h / 2], [w - k, h], [k, h], [0, h / 2]]; }
  if (prst === 'octagon') { const k = ss * a(0, 0.29289); return [[k, 0], [w - k, 0], [w, k], [w, h - k], [w - k, h], [k, h], [0, h - k], [0, k]]; }
  if (prst === 'trapezoid') { const k = Math.min(w / 2, ss * a(0, 0.25)); return [[0, h], [k, 0], [w - k, 0], [w, h]]; }
  if (prst === 'parallelogram') { const k = Math.min(w, ss * a(0, 0.25)); return [[k, 0], [w, 0], [w - k, h], [0, h]]; }
  if (prst === 'diamond') return [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
  if (prst === 'triangle') { const k = w * a(0, 0.5); return [[k, 0], [w, h], [0, h]]; }
  if (prst === 'rtTriangle') return [[0, 0], [w, h], [0, h]];
  if (prst === 'pentagon') return [[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]];
  if (prst === 'homePlate') { const k = Math.min(w, ss * a(0, 0.5)); return [[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h]]; }
  if (prst === 'chevron') { const k = Math.min(w / 2, ss * a(0, 0.5)); return [[0, 0], [w - k, 0], [w, h / 2], [w - k, h], [0, h], [k, h / 2]]; }
  if (prst in ARROWS) {
    const vertical = ARROWS[prst] % 180 !== 0, L = vertical ? h : w, T = vertical ? w : h;
    const shaft = T * a(0, 0.5), head = Math.min(L, ss * a(1, 0.5)), y0 = (T - shaft) / 2;
    let pts = [[0, y0], [L - head, y0], [L - head, 0], [L, T / 2], [L - head, T], [L - head, y0 + shaft], [0, y0 + shaft]];
    if (prst === 'leftArrow' || prst === 'upArrow') pts = pts.map(([x, y]) => [L - x, y]);
    return vertical ? pts.map(([x, y]) => [y, x]) : pts;
  }
  if (prst === 'leftRightArrow') { const shaft = h * a(0, 0.5), head = Math.min(w / 2, ss * a(1, 0.5)), y0 = (h - shaft) / 2; return [[0, h / 2], [head, 0], [head, y0], [w - head, y0], [w - head, 0], [w, h / 2], [w - head, h], [w - head, y0 + shaft], [head, y0 + shaft], [head, h]]; }
  if (prst === 'snip1Rect') { const k = ss * a(0, 0.16667); return [[0, 0], [w - k, 0], [w, k], [w, h], [0, h]]; }
  if (prst === 'snip2SameRect') { const k = ss * a(0, 0.16667); return [[k, 0], [w - k, 0], [w, k], [w, h], [0, h], [0, k]]; }
  return null;
}
function paintOf(it, defs) {
  const g = it.grad;
  if (g && defs && Array.isArray(g.stops)) {
    const id = `g${defs.prefix}${defs.list.length}`;
    const stops = g.stops.map(([pos, color]) => safeColor(color) ? `<stop offset="${Math.max(0, Math.min(1, Number(pos) || 0))}" stop-color="${safeColor(color)}"/>` : '').join('');
    if (g.radial) defs.list.push(`<radialGradient id="${id}">${stops}</radialGradient>`);
    else {
      const r = (Number(g.ang) || 0) * Math.PI / 180, c = Math.cos(r) / 2, s = Math.sin(r) / 2;
      defs.list.push(`<linearGradient id="${id}" x1="${n(0.5 - c)}" y1="${n(0.5 - s)}" x2="${n(0.5 + c)}" y2="${n(0.5 + s)}">${stops}</linearGradient>`);
    }
    return `url(#${id})`;
  }
  return safeColor(it.fill) || 'none';
}
function boxItem(it, defs) {
  const fill = paintOf(it, defs), stroke = safeColor(it.stroke);
  const strokeAttr = stroke ? ` stroke="${stroke}" stroke-width="${n(it.lw || 0.75)}"` : '';
  const paint = `fill="${fill}"${strokeAttr}${rotate(it)}`;
  // 自定义形状与预置多边形：在形状自身坐标里画，再平移到位置；翻转绕自身中心。
  const local = body => {
    const flip = it.flipH || it.flipV ? ` translate(${it.flipH ? n(it.w) : 0} ${it.flipV ? n(it.h) : 0}) scale(${it.flipH ? -1 : 1} ${it.flipV ? -1 : 1})` : '';
    return `<g${rotate(it)}><g transform="translate(${n(it.x)} ${n(it.y)})${flip}">${body}</g></g>`;
  };
  if (Array.isArray(it.path) && it.path.length) {
    const safe = d => /^[MLCQAZ0-9 .\-]+$/.test(String(d || '')) ? d : '';
    return local(it.path.map(p => safe(p.d) ? `<path d="${safe(p.d)}" fill="${p.nofill ? 'none' : fill}"${p.nostroke ? '' : strokeAttr}/>` : '').join(''));
  }
  const pts = it.prst ? presetPoints(it.prst, it.w, it.h, it.adj) : null;
  if (pts) return local(`<polygon points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}"${strokeAttr}/>`);
  if (it.prst === 'arc') {
    const st = (it.adj ? it.adj[0] * 100000 / 60000 : 270) * Math.PI / 180, en = (it.adj ? it.adj[1] * 100000 / 60000 : 0) * Math.PI / 180;
    const rx = it.w / 2, ry = it.h / 2, sweep = ((en - st) * 180 / Math.PI + 360) % 360;
    return local(`<path d="M${n(rx + rx * Math.cos(st))} ${n(ry + ry * Math.sin(st))}A${n(rx)} ${n(ry)} 0 ${sweep > 180 ? 1 : 0} 1 ${n(rx + rx * Math.cos(en))} ${n(ry + ry * Math.sin(en))}" fill="none" stroke="${stroke || '#7F7F7F'}" stroke-width="${n(it.lw || 0.75)}"/>`);
  }
  if (it.shape === 'ellipse' || it.prst === 'flowChartConnector') return `<ellipse cx="${n(it.x + it.w / 2)}" cy="${n(it.y + it.h / 2)}" rx="${n(it.w / 2)}" ry="${n(it.h / 2)}" ${paint}/>`;
  if (it.shape === 'tri') return `<polygon points="${n(it.x + it.w / 2)},${n(it.y)} ${n(it.x + it.w)},${n(it.y + it.h)} ${n(it.x)},${n(it.y + it.h)}" ${paint}/>`;
  if (it.shape === 'arrow') { const tip = Math.min(it.w * 0.3, it.h * 0.6); return `<polygon points="${n(it.x)},${n(it.y)} ${n(it.x + it.w - tip)},${n(it.y)} ${n(it.x + it.w)},${n(it.y + it.h / 2)} ${n(it.x + it.w - tip)},${n(it.y + it.h)} ${n(it.x)},${n(it.y + it.h)}" ${paint}/>`; }
  const rx = it.shape === 'round' ? n(Math.min(it.w, it.h) * (it.prst === 'roundRect' && it.adj ? Math.min(0.5, it.adj[0]) : 0.12)) : 0;
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

// fit：素材预览只看形状本身——视口缩到所有元素的外框（四周留 8%），背景只画这块。
function fitBox(scene) {
  // 只框幻灯片自己的形状（slideItems 个，排在最后），母版和版式上的装饰不算。
  const all = scene.items || [], own = Number.isInteger(scene.slideItems) && scene.slideItems > 0 ? all.slice(all.length - scene.slideItems) : all;
  const items = own.filter(it => it.w > 0 || it.h > 0);
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + Math.max(it.w, 1)); y1 = Math.max(y1, it.y + Math.max(it.h, 1)); }
  const pad = Math.max(6, Math.max(x1 - x0, y1 - y0) * 0.08);
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
let defsSeq = 0;
function sceneSvg(scene, { title = '', fit = false } = {}) {
  if (!scene || !(scene.w > 0) || !(scene.h > 0)) return '';
  const fallbackColor = '#1F2329';
  const vb = (fit && fitBox(scene)) || { x: 0, y: 0, w: scene.w, h: scene.h };
  const bg = scene.bg?.image ? `<image href="${esc(url(scene.bg.image))}" x="0" y="0" width="${n(scene.w)}" height="${n(scene.h)}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${n(vb.x)}" y="${n(vb.y)}" width="${n(vb.w)}" height="${n(vb.h)}" fill="${safeColor(scene.bg?.color) || '#FFFFFF'}"/>`;
  const defs = { prefix: `${(defsSeq = (defsSeq + 1) % 1e6).toString(36)}_`, list: [] };
  const body = (scene.items || []).map(it => it.t === 'text' ? textItem(it, fallbackColor) : it.t === 'img' ? imageItem(it) : it.t === 'box' ? boxItem(it, defs)
    : it.t === 'line' ? lineItem(it) : it.t === 'table' ? tableItem(it, fallbackColor) : it.t === 'ph' ? placeholderItem(it) : '').join('');
  return `<svg class="pptw-slide-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${n(vb.x)} ${n(vb.y)} ${n(vb.w)} ${n(vb.h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title || '幻灯片版式预览')}">${defs.list.length ? `<defs>${defs.list.join('')}</defs>` : ''}<g>${bg}${body}</g></svg>`;
}

module.exports = { sceneSvg, presetPoints };
