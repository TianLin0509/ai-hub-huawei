'use strict';
// 汇报页引擎：页面说明(JSON) -> 可编辑 pptx。纯 Node，无外部依赖。
// 画布按 1280x720 px 计（1 px = 9525 EMU），字体全部微软雅黑，字号走阶梯。
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const EMU = 9525, W = 1280, H = 720;
const FONT = '微软雅黑';
const LADDER = [28, 24, 20, 18, 16, 14, 12, 11, 10];
const C = { red: 'C00000', blue: '0000FF', dblue: '1F4E79', text: '262626', gray: '7F7F7F', line: 'BFBFBF', soft: 'F7F7F7', head: 'F2F2F2', yellow: 'FFFF00', green: '00B050', white: 'FFFFFF', lblue: 'DEEBF7', mblue: 'BDD7EE', cream: 'FFF2CC', orange: 'ED7D31' };

// ---------- 文字 ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function chW(ch) {
  const c = ch.codePointAt(0);
  if (c > 0x2E7F) return 1;
  if (ch === ' ') return 0.3;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[a-z]/.test(ch)) return 0.55;
  if (/[.,:;'!|]/.test(ch)) return 0.3;
  if (c > 0x2000) return 1;
  return 0.6;
}
const pt2px = pt => pt * 4 / 3;
const textW = (s, pt, bold) => { let w = 0; for (const ch of String(s)) w += chW(ch); return w * pt2px(pt) * (bold ? 1.04 : 1); };

// 行内标记：**粗**  {r:红} {b:蓝} {g:绿} {y:黄底红字} {k:灰}
function parseRuns(s, base) {
  const out = []; s = String(s == null ? '' : s);
  const re = /\*\*(.+?)\*\*|\{([rbgyk]):((?:[^{}]|\{[^{}]*\})*?)\}/g; let i = 0, m;
  const push = (t, o) => { if (t) out.push(Object.assign({ t }, base, o)); };
  while ((m = re.exec(s))) {
    push(s.slice(i, m.index));
    if (m[1] != null) push(m[1], { b: true });
    else {
      const k = m[2], t = m[3].replace(/\*\*/g, '');
      if (k === 'r') push(t, { color: C.red, b: true });
      else if (k === 'b') push(t, { color: C.blue, b: true });
      else if (k === 'g') push(t, { color: C.green, b: true });
      else if (k === 'y') push(t, { color: C.red, b: true, hl: C.yellow });
      else push(t, { color: C.gray });
    }
    i = m.index + m[0].length;
  }
  push(s.slice(i));
  return out.length ? out : [Object.assign({ t: '' }, base)];
}
const plain = s => String(s == null ? '' : s).replace(/\*\*/g, '').replace(/\{[rbgyk]:((?:[^{}])*)\}/g, '$1');

function linesOf(str, pt, widthPx, bold) {
  const max = Math.max(widthPx, pt2px(pt)); let n = 0;
  for (const seg of plain(str).split('\n')) {
    let w = 0, ln = 1;
    for (const ch of seg) { const cw = chW(ch) * pt2px(pt) * (bold ? 1.04 : 1); if (w + cw > max + 0.5) { ln++; w = cw; } else w += cw; }
    n += ln;
  }
  return n;
}
const LH = 1.22;
// paras: [{t, lvl}]；返回能放进 (w,h) 的最大阶梯字号
function fitSize(paras, w, h, want, opt) {
  opt = opt || {}; const min = opt.min || 10;
  for (const sz of LADDER) {
    if (sz > want) continue;
    if (sz < min) break;
    if (parasH(paras, w, sz, opt) <= h + 1) return sz;
  }
  return min;
}
function parasH(paras, w, sz, opt) {
  opt = opt || {}; let hh = 0;
  paras.forEach((p, i) => {
    const s = p.lvl ? Math.max(10, sz - 2) : sz;
    const ind = (opt.bullet === 'none' && !p.lvl ? 0 : pt2px(s) * 1.25) + (p.lvl ? pt2px(s) * 1.1 : 0);
    hh += linesOf(p.t, s, w - ind, p.b) * pt2px(s) * LH + (i ? pt2px(opt.gapPt == null ? 3 : opt.gapPt) : 0);
  });
  return hh;
}

// ---------- 形状 XML ----------
const e = px => Math.round(px * EMU);
function fillXml(f) {
  if (!f || f === 'none') return '<a:noFill/>';
  if (typeof f === 'string') return `<a:solidFill><a:srgbClr val="${f}"/></a:solidFill>`;
  if (f.alpha != null && f.color) return `<a:solidFill><a:srgbClr val="${f.color}"><a:alpha val="${Math.round(f.alpha * 1000)}"/></a:srgbClr></a:solidFill>`;
  const gs = f.stops.map(s => `<a:gs pos="${Math.round(s[0] * 1000)}"><a:srgbClr val="${s[1]}">${s[2] != null ? `<a:alpha val="${Math.round(s[2] * 1000)}"/>` : ''}</a:srgbClr></a:gs>`).join('');
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="${Math.round((f.ang == null ? 90 : f.ang) * 60000)}" scaled="0"/></a:gradFill>`;
}
function lineXml(l) {
  if (!l || l === 'none') return '<a:ln><a:noFill/></a:ln>';
  if (typeof l === 'string') l = { color: l };
  return `<a:ln w="${Math.round((l.w || 0.75) * 12700)}"${l.cap ? ` cap="${l.cap}"` : ''}><a:solidFill><a:srgbClr val="${l.color}"/></a:solidFill>${l.dash ? `<a:prstDash val="${l.dash}"/>` : ''}${l.join === 'round' ? '<a:round/>' : ''}${l.head ? `<a:headEnd type="${l.head}"/>` : ''}${l.tail ? `<a:tailEnd type="${l.tail}" w="med" len="med"/>` : ''}</a:ln>`;
}
const SHADOW = '<a:effectLst><a:outerShdw blurRad="101600" dist="25400" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="16000"/></a:srgbClr></a:outerShdw></a:effectLst>';
function rPr(r, sz) {
  const s = Math.round((r.sz || sz) * 100);
  return `<a:rPr lang="zh-CN" altLang="en-US" sz="${s}" b="${r.b ? 1 : 0}"${r.i ? ' i="1"' : ''}${r.sup ? ' baseline="30000"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${r.color || C.text}"/></a:solidFill>${r.hl ? `<a:highlight><a:srgbClr val="${r.hl}"/></a:highlight>` : ''}<a:latin typeface="${r.font || FONT}"/><a:ea typeface="${r.font || FONT}"/><a:cs typeface="${r.font || FONT}"/></a:rPr>`;
}
const BUL = { '■': ['Wingdings', 'n'], '●': ['Wingdings', 'l'], '✓': ['Wingdings', 'ü'], '➢': ['Wingdings', 'Ø'], '◆': ['Wingdings', 'u'], '•': ['Arial', '•'], '–': ['Arial', '–'] };
function paraXml(p, sz) {
  const s = p.sz || sz; let pp = `<a:pPr algn="${p.align || 'l'}"`;
  let inner = '';
  if (p.lnPct) inner += `<a:lnSpc><a:spcPct val="${p.lnPct * 1000}"/></a:lnSpc>`;
  if (p.before) inner += `<a:spcBef><a:spcPts val="${Math.round(p.before * 100)}"/></a:spcBef>`;
  if (p.bullet && BUL[p.bullet]) {
    const ind = e(pt2px(s) * 1.25), ml = ind + (p.lvl ? e(pt2px(s) * 1.1) : 0);
    pp += ` marL="${ml}" indent="-${ind}"`;
    inner += `<a:buClr><a:srgbClr val="${p.bulletColor || C.text}"/></a:buClr><a:buSzPct val="${p.bullet === '■' ? 70 : 85}000"/><a:buFont typeface="${BUL[p.bullet][0]}"/><a:buChar char="${esc(BUL[p.bullet][1])}"/>`;
  } else if (p.auto) {
    const ind = e(pt2px(s) * 1.4); pp += ` marL="${ind}" indent="-${ind}"`;
    inner += `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="${p.auto}"/>`;
  } else inner += '<a:buNone/>';
  pp += `>${inner}</a:pPr>`;
  const runs = (p.runs || []).map(r => {
    const parts = String(r.t).split('\n');
    return parts.map((t, i) => (i ? '<a:br/>' : '') + (t === '' && parts.length > 1 ? '' : `<a:r>${rPr(r, s)}<a:t>${esc(t)}</a:t></a:r>`)).join('');
  }).join('');
  return `<a:p>${pp}${runs}</a:p>`;
}
// o: {x,y,w,h, geom, adj, path, fill, line, shadow, rot, flipH, flipV, paras, sz, anchor, ins, wrap, name}
function sp(ctx, o) {
  const id = ctx.id++;
  let g;
  if (o.path) g = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${o.path.w}" h="${o.path.h}"${o.path.nofill ? ' fill="none"' : ''}>${o.path.d}</a:path></a:pathLst></a:custGeom>`;
  else g = `<a:prstGeom prst="${o.geom || 'rect'}"><a:avLst>${(o.adj || []).map((v, i) => `<a:gd name="adj${o.adj.length > 1 ? i + 1 : ''}" fmla="val ${v}"/>`).join('')}</a:avLst></a:prstGeom>`;
  const xf = `<a:xfrm${o.rot ? ` rot="${Math.round(o.rot * 60000)}"` : ''}${o.flipH ? ' flipH="1"' : ''}${o.flipV ? ' flipV="1"' : ''}><a:off x="${e(o.x)}" y="${e(o.y)}"/><a:ext cx="${Math.max(0, e(o.w))}" cy="${Math.max(0, e(o.h))}"/></a:xfrm>`;
  let tx = '';
  if (o.paras) {
    const ins = o.ins || [0, 0, 0, 0];
    tx = `<p:txBody><a:bodyPr wrap="${o.wrap || 'square'}" lIns="${e(ins[0])}" tIns="${e(ins[1])}" rIns="${e(ins[2])}" bIns="${e(ins[3])}" anchor="${o.anchor || 't'}"${o.vert ? ` vert="${o.vert}"` : ''}><a:noAutofit/></a:bodyPr><a:lstStyle/>${o.paras.map(p => paraXml(p, o.sz || 14)).join('')}</p:txBody>`;
  }
  ctx.out.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(o.name || 'shape')} ${id}"/><p:cNvSpPr${o.paras && !o.fill && !o.line ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr>${xf}${g}${fillXml(o.fill)}${lineXml(o.line)}${o.shadow ? SHADOW : ''}</p:spPr>${tx}</p:sp>`);
  return id;
}
// 简易文本框
function txt(ctx, x, y, w, h, str, o) {
  o = o || {};
  const base = { color: o.color, b: o.b, font: o.font, i: o.i };
  const strs = Array.isArray(str) ? str : [str];
  const paras = strs.map(s => ({ runs: parseRuns(s, base), align: o.align || 'l', lnPct: o.lnPct }));
  let sz = o.sz || 14;
  if (o.fit !== false) sz = fitSize(strs.map(s => ({ t: s, b: o.b })), w - (o.ins ? o.ins[0] + o.ins[2] : 0), h, sz, { bullet: 'none', min: o.min });
  return sp(ctx, Object.assign({ x, y, w, h, paras, sz, anchor: o.anchor || 'ctr', name: o.name || '文字' }, o.box || {}, { ins: o.ins }));
}
function lineSeg(ctx, x1, y1, x2, y2, l) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  const id = ctx.id++;
  ctx.out.push(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="线 ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${x2 < x1 ? ' flipH="1"' : ''}${y2 < y1 ? ' flipV="1"' : ''}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>${lineXml(l)}</p:spPr></p:cxnSp>`);
}
const GRAD = {
  blue: { stops: [[0, '9DC3E6'], [100, '2E75B6']], ang: 90 }, gray: { stops: [[0, 'E7E6E6'], [100, 'AFABAB']], ang: 90 },
  red: { stops: [[0, 'E97C7C'], [100, 'C00000']], ang: 90 }, orange: { stops: [[0, 'F8CBAD'], [100, 'ED7D31']], ang: 90 },
  roof: { stops: [[0, 'D0D0D0'], [100, 'FFFFFF']], ang: 90 }, panel: { stops: [[0, 'F2F2F2'], [100, 'FFFFFF']], ang: 90 },
  fadeRed: { stops: [[0, 'FFFFFF', 0], [12, 'F4B6B6'], [35, 'A50021'], [65, 'A50021'], [88, 'F4B6B6'], [100, 'FFFFFF', 0]], ang: 0 },
  fadeBlue: { stops: [[0, 'FFFFFF', 0], [12, 'BDD7EE'], [35, '1F4E79'], [65, '1F4E79'], [88, 'BDD7EE'], [100, 'FFFFFF', 0]], ang: 0 },
  fadeGray: { stops: [[0, 'FFFFFF', 0], [12, 'D9D9D9'], [35, '595959'], [65, '595959'], [88, 'D9D9D9'], [100, 'FFFFFF', 0]], ang: 0 },
  band: { stops: [[0, 'DEEBF7', 0], [30, 'BDD7EE', 70], [50, '9DC3E6', 85], [70, 'BDD7EE', 70], [100, 'DEEBF7', 0]], ang: 0 },
  bandGray: { stops: [[0, 'F2F2F2', 0], [30, 'D9D9D9', 70], [50, 'BFBFBF', 85], [70, 'D9D9D9', 70], [100, 'F2F2F2', 0]], ang: 0 },
  chevB: { stops: [[0, 'DEEBF7'], [100, 'BDD7EE']], ang: 90 }, chevG: { stops: [[0, 'F2F2F2'], [100, 'D9D9D9']], ang: 90 }, chevY: { stops: [[0, 'FFF2CC'], [100, 'FFE699']], ang: 90 },
  pillB: { stops: [[0, '2E75B6'], [100, '1F4E79']], ang: 90 }, pillG: { stops: [[0, 'BF9000'], [100, '7F6000']], ang: 90 }, pillT: { stops: [[0, '2E9CA6'], [100, '1B6B73']], ang: 90 }, pillR: { stops: [[0, 'D64545'], [100, 'A50021']], ang: 90 },
  arrow: { stops: [[0, 'D9D9D9'], [100, 'F2F2F2', 30]], ang: 90 },
};

// ---------- 版面 ----------
const FIXED = { bar: 34, band: 30, chevrons: 38, arrow: 26, heading: 28, metric: 26, tabs: 26, rule: 6, note: 20, gap: 8 };
function mainSize(n, horiz) { if (n.size != null) return n.size; if (!horiz && FIXED[n.type] != null && n.w == null) return FIXED[n.type]; if (horiz && n.type === 'arrow' && n.w == null) return 34; return null; }
function layout(ctx, n, b) {
  if (!n) return;
  if (n.row || n.col) {
    const horiz = !!n.row, kids = (n.row || n.col).filter(Boolean), gap = n.gap == null ? (horiz ? 14 : 10) : n.gap;
    const pad = n.pad || 0; b = { x: b.x + pad, y: b.y + pad, w: b.w - 2 * pad, h: b.h - 2 * pad };
    const total = (horiz ? b.w : b.h) - gap * (kids.length - 1);
    let fixed = 0, wsum = 0;
    kids.forEach(k => { const s = mainSize(k, horiz); if (s != null) fixed += s; else wsum += (k.w || 1); });
    let pos = horiz ? b.x : b.y;
    kids.forEach(k => {
      const s = mainSize(k, horiz); const len = s != null ? s : Math.max(0, (total - fixed) * (k.w || 1) / (wsum || 1));
      layout(ctx, k, horiz ? { x: pos, y: b.y, w: len, h: b.h } : { x: b.x, y: pos, w: b.w, h: len });
      pos += len + gap;
    });
    return;
  }
  const fn = COMP[n.type];
  if (!fn) { ctx.warn.push(`未知组件 type=${n.type}`); return; }
  fn(ctx, n, b);
}

const COMP = {};

// 面板：栏头 + 边框 + 内容
COMP.panel = (ctx, n, b) => {
  const head = n.head ? (typeof n.head === 'string' ? { text: n.head } : n.head) : null;
  const hs = head ? (head.style || 'line') : null; const frame = n.frame || (hs === 'line' ? 'line' : hs === 'roof' ? 'soft' : 'line');
  let top = b.y, bodyTop = b.y;
  const hh = head ? (head.h || 28) : 0;
  if (hs === 'line') { top = b.y + hh / 2; bodyTop = b.y + hh + 2; }
  else if (hs === 'roof') { top = b.y + hh; bodyTop = top + 6; }
  else if (hs) { top = b.y; bodyTop = b.y + hh + 6; }
  const fb = { x: b.x, y: top, w: b.w, h: b.y + b.h - top };
  if (frame === 'line') sp(ctx, Object.assign({ name: '面板框', fill: n.fill || 'none', line: { color: n.lineColor || C.line, w: 1 } }, fb));
  else if (frame === 'dash') sp(ctx, Object.assign({ name: '虚线框', fill: n.fill || 'none', line: { color: n.lineColor || C.red, w: 1.25, dash: 'dash' }, geom: 'roundRect', adj: [4000] }, fb));
  else if (frame === 'soft') sp(ctx, Object.assign({ name: '面板底', fill: n.fill || GRAD.panel, line: 'none' }, fb));
  else if (frame === 'shadow') sp(ctx, Object.assign({ name: '面板底', fill: n.fill || C.white, line: { color: 'E7E6E6', w: 0.5 }, shadow: true }, fb));
  else if (frame === 'fill') sp(ctx, Object.assign({ name: '面板底', fill: n.fill || C.soft, line: 'none' }, fb));
  if (head) drawHead(ctx, head, hs, b, hh);
  const pad = n.pad == null ? 10 : n.pad;
  const inner = { x: b.x + pad, y: bodyTop + (hs === 'line' ? 2 : pad * 0.4), w: b.w - 2 * pad, h: b.y + b.h - bodyTop - pad * (hs === 'line' ? 0.8 : 1.2) };
  if (n.body) layout(ctx, n.body, inner);
};
function drawHead(ctx, head, hs, b, hh) {
  const t = head.text, sz = head.sz || 16, tw = textW(plain(t), sz, true) + (head.num != null ? 30 : 0);
  ctx.motifs.add(hs);
  if (hs === 'line') {
    const w = Math.min(b.w - 20, tw + 24), x = head.align === 'left' ? b.x + 16 : b.x + (b.w - w) / 2;
    sp(ctx, { name: '栏名', x, y: b.y, w, h: hh, fill: C.white, line: 'none', paras: [{ runs: headRuns(head, C.red), align: 'ctr' }], sz, anchor: 'ctr', wrap: 'none' });
  } else if (hs === 'roof') {
    const w = Math.min(b.w, Math.max(tw + 90, b.w * 0.62)), x = b.x + (b.w - w) / 2;
    sp(ctx, { name: '屋顶栏头', x, y: b.y, w, h: hh, geom: 'trapezoid', adj: [Math.round(hh / w * 100000 * 0.9)], fill: GRAD.roof, line: 'none', paras: [{ runs: headRuns(head, head.color === 'black' ? C.text : C.red), align: 'ctr' }], sz, anchor: 'ctr', wrap: 'none' });
  } else if (hs === 'fade-red' || hs === 'fade-blue' || hs === 'fade-gray') {
    const g = hs === 'fade-red' ? GRAD.fadeRed : hs === 'fade-blue' ? GRAD.fadeBlue : GRAD.fadeGray;
    sp(ctx, { name: '两端渐隐色条', x: b.x, y: b.y, w: b.w, h: hh, fill: g, line: 'none', paras: [{ runs: headRuns(head, C.white), align: 'ctr' }], sz, anchor: 'ctr', wrap: 'none' });
  } else if (hs === 'solid-red' || hs === 'solid-blue' || hs === 'gray') {
    const f = hs === 'solid-red' ? C.red : hs === 'solid-blue' ? C.dblue : 'D9D9D9';
    sp(ctx, { name: '栏头条', x: b.x, y: b.y, w: b.w, h: hh, fill: f, line: 'none', paras: [{ runs: headRuns(head, hs === 'gray' ? C.text : C.white), align: head.align === 'left' ? 'l' : 'ctr' }], sz, anchor: 'ctr', ins: [8, 0, 8, 0] });
  } else if (hs === 'pill' || hs === 'pill-gold' || hs === 'pill-teal' || hs === 'pill-red') {
    const w = Math.min(b.w, Math.max(tw + 50, b.w * 0.7)), x = b.x + (b.w - w) / 2;
    const g = hs === 'pill' ? GRAD.pillB : hs === 'pill-gold' ? GRAD.pillG : hs === 'pill-teal' ? GRAD.pillT : GRAD.pillR;
    sp(ctx, { name: '胶囊栏头', x, y: b.y, w, h: hh, geom: 'roundRect', adj: [50000], fill: g, line: 'none', shadow: true, paras: [{ runs: headRuns(head, C.white), align: 'ctr' }], sz, anchor: 'ctr', wrap: 'none' });
  } else if (hs === 'left') {
    sp(ctx, { name: '栏名', x: b.x, y: b.y, w: b.w, h: hh - 3, paras: [{ runs: headRuns(head, C.red), align: 'l' }], sz, anchor: 'ctr', ins: [2, 0, 0, 0] });
    lineSeg(ctx, b.x, b.y + hh - 1, b.x + b.w, b.y + hh - 1, { color: C.red, w: 1 });
  }
}
function headRuns(head, color) {
  const pre = head.num != null ? [{ t: circled(head.num) + ' ', color, b: true }] : [];
  return pre.concat(parseRuns(head.text, { color, b: true }).map(r => (r.hl ? r : Object.assign(r, { color: r.color === C.red || r.color === C.blue ? (color === C.white ? C.white : r.color) : color }))));
}
const circled = n => (n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n));

// 文字块：items 为字符串数组；"- " 开头是二级；bullet: ■ ● ✓ ➢ ◆ • none num
COMP.text = (ctx, n, b) => {
  const items = (n.items || (n.t != null ? [n.t] : [])).map(s => (typeof s === 'string' ? s : s.t));
  const bullet = n.bullet || '■';
  const paras = items.map(s => { const lvl = /^- /.test(s) ? 1 : 0; return { t: lvl ? s.slice(2) : s, lvl }; });
  const opt = { bullet, gapPt: n.gapPt == null ? 4 : n.gapPt, min: n.min || 10 };
  const roomy = parasH(paras, b.w, 16, opt) <= b.h * 0.6;
  const want = n.sz || Math.min(roomy ? 16 : 14, ctx.bodyCap || 16);
  const sz = fitSize(paras, b.w, b.h, want, opt);
  if (!n.sz) ctx.bodyFits.push(sz);
  if (parasH(paras, b.w, sz, opt) > b.h + 6) ctx.warn.push(`文字放不下（已缩到 ${sz}pt）：「${plain(paras[0].t).slice(0, 14)}…」`);
  ctx.sizes.push(sz); ctx.chars += paras.reduce((a, p) => a + plain(p.t).length, 0);
  paras.forEach(p => checkEnd(ctx, p.t));
  const used = parasH(paras, b.w, sz, opt);
  const extra = n.spread === false || paras.length < 2 || used > b.h * 0.85 ? 0 : Math.min(20, (b.h - used) / paras.length * 0.7);
  const ps = paras.map((p, i) => {
    const s = p.lvl ? Math.max(10, sz - 2) : sz;
    const o = { runs: parseRuns(p.t, { color: n.color, b: n.b }), align: n.align || 'l', before: i ? opt.gapPt + extra : 0, sz: s, lvl: p.lvl };
    if (bullet === 'num' && !p.lvl) o.auto = 'arabicPeriod'; else if (bullet !== 'none' || p.lvl) { o.bullet = p.lvl ? '–' : bullet; o.bulletColor = n.bulletColor || (bullet === '✓' ? C.red : C.text); }
    return o;
  });
  sp(ctx, { name: '要点', x: b.x, y: b.y, w: b.w, h: b.h, paras: ps, sz, anchor: n.anchor || 't' });
};
function checkEnd(ctx, s) { if (/[。；;]\s*$/.test(plain(s))) ctx.warn.push(`句末有句号或分号：「…${plain(s).slice(-10)}」`); }

// 小标题（可带编号圆标）
COMP.heading = (ctx, n, b) => {
  let x = b.x; const sz = n.sz || 16;
  if (n.num != null) { numCircle(ctx, x, b.y + (b.h - 22) / 2, 22, n.num, n.numColor); x += 28; }
  txt(ctx, x, b.y, b.w - (x - b.x), b.h, n.t, { sz, b: true, color: n.color === 'black' ? C.text : n.color === 'blue' ? C.dblue : C.red, align: n.align || 'l', anchor: 'ctr' });
};
function numCircle(ctx, x, y, d, num, color) {
  ctx.motifs.add('num');
  const f = color === 'blue' ? C.dblue : color === 'teal' ? '1B8A94' : color === 'orange' ? C.orange : C.red;
  sp(ctx, { name: '编号圆标', x, y, w: d, h: d, geom: 'ellipse', fill: f, line: 'none', paras: [{ runs: [{ t: String(num), color: C.white, b: true }], align: 'ctr' }], sz: d >= 26 ? 14 : 12, anchor: 'ctr', wrap: 'none' });
}

// 编号卡：编号 + 红标题 + 要点 + 可选图位 + 可选指标条
COMP.card = (ctx, n, b) => {
  const frame = n.frame || 'line';
  if (frame === 'line') sp(ctx, { name: '卡片框', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'none', line: { color: C.line, w: 1 } });
  else if (frame === 'soft') sp(ctx, { name: '卡片底', x: b.x, y: b.y, w: b.w, h: b.h, fill: GRAD.panel, line: 'none' });
  else if (frame === 'shadow') sp(ctx, { name: '卡片底', x: b.x, y: b.y, w: b.w, h: b.h, fill: C.white, line: { color: 'E7E6E6', w: 0.5 }, shadow: true });
  else if (frame === 'dash') sp(ctx, { name: '卡片虚线框', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'none', line: { color: C.red, w: 1.25, dash: 'dash' }, geom: 'roundRect', adj: [4000] });
  else if (frame === 'fill') sp(ctx, { name: '卡片底', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'F5F5F5', line: 'none' });
  const pad = 10; let y = b.y + 8; const x = b.x + pad, w = b.w - 2 * pad;
  if (n.title) { COMP.heading(ctx, { t: n.title, num: n.num, numColor: n.numColor, color: n.titleColor, sz: n.titleSz || 16 }, { x, y, w, h: 26 }); y += 30; }
  let bottom = b.y + b.h - 8;
  if (n.metric) { COMP.metric(ctx, { t: n.metric }, { x, y: bottom - 24, w, h: 24 }); bottom -= 30; }
  const kids = [];
  if (n.items) kids.push({ type: 'text', items: n.items, bullet: n.bullet, sz: n.sz, w: n.textW || 1 });
  if (n.image) kids.push(Object.assign({ type: 'image', w: n.imageW || 0.8 }, n.image));
  if (n.body) kids.push(n.body);
  const order = n.imageFirst ? kids.reverse() : kids;
  layout(ctx, n.stack === 'col' ? { col: order, gap: 8 } : { row: order, gap: 10 }, { x, y, w, h: bottom - y });
};

// 指标条：黄底红字
COMP.metric = (ctx, n, b) => {
  ctx.hl++;
  sp(ctx, { name: '指标条', x: b.x, y: b.y, w: b.w, h: b.h, fill: C.cream, line: 'none', paras: [{ runs: parseRuns(n.t, { color: C.red, b: true }), align: 'ctr' }], sz: fitSize([{ t: n.t, b: true }], b.w - 8, b.h, n.sz || 13, { bullet: 'none' }), anchor: 'ctr' });
};

// 结论条：深红通栏白字
// 深色底的结论条上，{r:…} 这类标色会和底色撞（红字落在红底上看不见）：只留文字，统一白字
COMP.bar = (ctx, n, b) => {
  let barSz;
  checkEnd(ctx, n.t); ctx.motifs.add('bar');
  const st = n.style || 'red';
  const fill = st === 'red' ? C.red : st === 'fade' ? GRAD.fadeRed : st === 'gray' ? 'E7E6E6' : C.dblue;
  sp(ctx, { name: '结论条', x: b.x, y: b.y, w: b.w, h: b.h, fill, line: 'none', paras: [{ runs: parseRuns(st === 'gray' ? n.t : plain(n.t), { color: st === 'gray' ? C.red : C.white, b: true }), align: 'ctr' }], sz: (barSz = fitSize([{ t: n.t, b: true }], b.w - 20, b.h, n.sz || 16, { bullet: 'none' })), anchor: 'ctr' });
  // 结论条只有一行高：缩到最小字号仍超宽时文字会被截断，提醒缩短
  if (textW(plain(n.t), barSz, true) > b.w - 20) ctx.warn.push(`结论条一行放不下（${plain(n.t).length} 字），请缩短`);
};

// 扇形投影光带：上窄下宽（收敛到下方用 flip）
COMP.band = (ctx, n, b) => {
  ctx.motifs.add('band');
  const d = '<a:moveTo><a:pt x="380" y="0"/></a:moveTo><a:lnTo><a:pt x="620" y="0"/></a:lnTo><a:lnTo><a:pt x="1000" y="100"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:close/>';
  sp(ctx, { name: '扇形投影光带', x: b.x, y: b.y, w: b.w, h: b.h, path: { w: 1000, h: 100, d }, fill: n.color === 'gray' ? GRAD.bandGray : GRAD.band, line: 'none', flipV: !!n.flip });
};

// 过渡箭头：down 粗下箭头 / right 双尖角
COMP.arrow = (ctx, n, b) => {
  const dir = n.dir || (b.w > b.h * 1.5 ? 'down' : 'right');
  const fill = n.color === 'red' ? { stops: [[0, 'F4B6B6'], [100, 'C00000']], ang: dir === 'down' ? 90 : 0 } : { stops: [[0, 'E7E6E6'], [100, 'A6A6A6']], ang: dir === 'down' ? 90 : 0 };
  if (dir === 'down') { const w = Math.min(b.w, n.wide ? b.w * 0.5 : 70), h = Math.min(b.h, 30); sp(ctx, { name: '下箭头', x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h, geom: 'downArrow', adj: [60000, 55000], fill, line: 'none' }); }
  else { const w = Math.min(b.w, 34), h = Math.min(b.h, 120); const y = b.y + (b.h - h) / 2, x = b.x + (b.w - w) / 2; sp(ctx, { name: '尖角', x, y, w: w * 0.62, h, geom: 'chevron', adj: [70000], fill, line: 'none' }); sp(ctx, { name: '尖角', x: x + w * 0.38, y, w: w * 0.62, h, geom: 'chevron', adj: [70000], fill, line: 'none' }); }
};

// 燕尾进程条
COMP.chevrons = (ctx, n, b) => {
  ctx.motifs.add('chevrons');
  const it = n.items || [], k = it.length, ov = 10, w = (b.w + ov * (k - 1)) / k;
  it.forEach((s, i) => {
    const o = typeof s === 'string' ? { t: s } : s; const now = n.now === i;
    const fill = now ? C.red : n.color === 'gray' ? GRAD.chevG : n.color === 'yellow' ? GRAD.chevY : GRAD.chevB;
    sp(ctx, { name: '燕尾进程条', x: b.x + i * (w - ov), y: b.y, w, h: b.h, geom: i === 0 ? 'homePlate' : 'chevron', adj: [Math.round(b.h / w * 100000 * 0.45)], fill, line: now ? 'none' : { color: n.color === 'gray' ? 'A6A6A6' : C.dblue, w: 1 }, paras: [{ runs: parseRuns(o.t, { color: now ? C.white : n.color === 'gray' ? C.text : C.dblue, b: true }), align: 'ctr' }], sz: fitSize([{ t: o.t, b: true }], w - 44, b.h, n.sz || 14, { bullet: 'none' }), anchor: 'ctr', ins: [i ? 14 : 4, 0, 10, 0] });
  });
};

// 阶梯柱图（形状画的，可编辑）：series [{label, value, text, color}]，deltas 自动或给定，target 虚线目标框
COMP.bars = (ctx, n, b) => {
  const S = n.series || [], k = S.length; if (!k) return;
  const titleH = n.title ? 22 : 0; if (n.title) txt(ctx, b.x, b.y, b.w, 20, n.title, { sz: 12, b: true, align: 'ctr' });
  const labH = 34, topPad = 46, axL = n.ylabel ? 22 : 6;
  const x0 = b.x + axL, y0 = b.y + b.h - labH, cw = (b.w - axL - 6) / k, ph = b.h - labH - topPad - titleH;
  const vmax = Math.max.apply(null, S.map(s => s.value)) || 1, base = n.base || 0;
  const hOf = v => Math.max(4, (v - base) / (vmax - base) * ph);
  const bw = Math.min(cw * 0.46, 84);
  if (n.ylabel) txt(ctx, b.x, b.y + titleH, 20, b.h - labH - titleH, n.ylabel, { sz: 10, color: C.gray, align: 'ctr', box: { vert: 'eaVert' }, fit: false });
  lineSeg(ctx, x0, y0, x0 + cw * k, y0, { color: '7F7F7F', w: 1 });
  const tops = [];
  S.forEach((s, i) => {
    const h = hOf(s.value), cx = x0 + cw * (i + 0.5), col = s.color || (i === 0 ? 'gray' : i === k - 1 && n.lastRed ? 'red' : 'blue');
    sp(ctx, { name: '柱', x: cx - bw / 2, y: y0 - h, w: bw, h, fill: GRAD[col] || col, line: 'none' });
    txt(ctx, cx - cw / 2, y0 - h - 22, cw, 20, s.text != null ? s.text : String(s.value), { sz: 14, b: true, align: 'ctr', color: col === 'red' ? C.red : C.text });
    txt(ctx, cx - cw / 2 + 2, y0 + 3, cw - 4, labH - 4, s.label, { sz: 12, align: 'ctr', anchor: 't' });
    tops.push({ cx, y: y0 - h });
  });
  const deltas = n.deltas === false ? [] : (n.deltas || S.slice(1).map((s, i) => { const d = (s.value / S[i].value - 1) * 100; return (d >= 0 ? '+' : '') + Math.round(d) + '%'; }));
  deltas.forEach((d, i) => {
    if (!d || !tops[i + 1]) return; ctx.motifs.add('curveArrow');
    const a = tops[i], c = tops[i + 1]; const x1 = a.cx + bw / 2 + 3, x2 = c.cx - 4, y1 = a.y - 26, y2 = c.y - 26;
    arc(ctx, x1, Math.min(y1, y0 - 30), x2, y2, { color: C.red, w: 1.75 });
    txt(ctx, (x1 + x2) / 2 - 36, (y1 + y2) / 2 + 8, 72, 20, d, { sz: 13, b: true, color: C.red, align: 'ctr' });
  });
  if (n.target) {
    const i = n.target.at == null ? k - 1 : n.target.at, t = tops[i]; ctx.motifs.add('target');
    sp(ctx, { name: '目标虚线框', x: t.cx - bw / 2 - 10, y: t.y - 28, w: bw + 20, h: y0 - t.y + 30, geom: 'roundRect', adj: [6000], fill: 'none', line: { color: C.red, w: 1.25, dash: 'dash' } });
    if (n.target.label) txt(ctx, t.cx - cw / 2, t.y - 50, cw, 20, n.target.label, { sz: 12, b: true, color: C.red, align: 'ctr' });
  }
};
// 上扬弧线箭头（二次贝塞尔）
function arc(ctx, x1, y1, x2, y2, l) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2) - 14, w = Math.abs(x2 - x1) || 1, h = Math.abs(y2 - y1) + 14;
  const P = (px, py) => `<a:pt x="${Math.round((px - x) / w * 1000)}" y="${Math.round((py - y) / h * 1000)}"/>`;
  const d = `<a:moveTo>${P(x1, y1)}</a:moveTo><a:quadBezTo>${P((x1 + x2) / 2 - (x2 - x1) * 0.1, y)}${P(x2, y2)}</a:quadBezTo>`;
  sp(ctx, { name: '弯箭头', x, y, w, h, path: { w: 1000, h: 1000, d, nofill: true }, fill: 'none', line: Object.assign({ tail: 'triangle' }, l) });
}

// 流程链：nodes [{t, hl:'red'|'yellow'|'blue', sub}]，dir h|v
COMP.flow = (ctx, n, b) => {
  const N = (n.nodes || []).map(s => (typeof s === 'string' ? { t: s } : s)), k = N.length; if (!k) return;
  const v = n.dir === 'v', gap = v ? 18 : 26, len = ((v ? b.h : b.w) - gap * (k - 1)) / k;
  const thick = v ? b.w : Math.min(b.h, n.h || 64), off = v ? 0 : (b.h - thick) / 2;
  N.forEach((o, i) => {
    const x = v ? b.x : b.x + i * (len + gap), y = v ? b.y + i * (len + gap) : b.y + off, w = v ? thick : len, h = v ? len : thick;
    const st = o.hl === 'red' ? { fill: 'FDECEC', line: { color: C.red, w: 1.25 }, color: C.red } : o.hl === 'yellow' ? { fill: C.cream, line: { color: 'BF9000', w: 1 }, color: C.text } : o.hl === 'blue' ? { fill: GRAD.pillB, line: 'none', color: C.white } : o.hl === 'dash' ? { fill: 'none', line: { color: C.red, w: 1.25, dash: 'dash' }, color: C.red } : { fill: n.fill || C.head, line: { color: 'A6A6A6', w: 0.75 }, color: C.text };
    const strs = o.sub ? [o.t, o.sub] : [o.t];
    const sz = fitSize(strs.map(t => ({ t, b: true })), w - 8, h - 4, n.sz || 13, { bullet: 'none' });
    sp(ctx, { name: '流程块', x, y, w, h, geom: n.round ? 'roundRect' : 'rect', adj: n.round ? [12000] : [], fill: st.fill, line: st.line, paras: strs.map((t, j) => ({ runs: parseRuns(t, { color: j ? C.gray : st.color, b: !j }), align: 'ctr', sz: j ? Math.max(10, sz - 2) : sz })), sz, anchor: 'ctr', ins: [4, 2, 4, 2] });
    if (i < k - 1) { if (v) lineSeg(ctx, x + w / 2, y + h + 2, x + w / 2, y + h + gap - 2, { color: '7F7F7F', w: 1.5, tail: 'triangle' }); else lineSeg(ctx, x + w + 3, y + h / 2, x + w + gap - 3, y + h / 2, { color: '7F7F7F', w: 1.5, tail: 'triangle' }); }
  });
};

// 表格（原生表格，可编辑）
COMP.table = (ctx, n, b) => {
  const head = n.head || null, rows = n.rows || [], cols = (head || rows[0] || []).length; if (!cols) return;
  const all = (head ? [head] : []).concat(rows);
  const cw = n.colw || Array.from({ length: cols }, (_, j) => Math.min(12, Math.max(3, Math.max.apply(null, all.map(r => plain(r[j] || '').split('\n').reduce((a, t) => Math.max(a, textW(t, 12, true) / 16), 0)))) * (j === 0 ? 1.35 : 1)) + 1.5), sum = cw.reduce((a, c) => a + c, 0), widths = cw.map(c => b.w * c / sum);
  const nr = rows.length + (head ? 1 : 0), hh = head ? Math.min(30, b.h / nr) : 0, rh = (b.h - hh) / (rows.length || 1);
  let sz = n.sz || 12;
  rows.forEach(r => r.forEach((c, j) => { sz = Math.min(sz, fitSize([{ t: c, b: j === 0 }], widths[j] * 0.78 - 12, rh - 7, sz, { bullet: 'none' })); }));
  if (head) head.forEach((c, j) => { sz = Math.min(sz, fitSize([{ t: c, b: true }], widths[j] - 14, hh - 7, sz, { bullet: 'none' })); });
  ctx.sizes.push(sz);
  if (rh < pt2px(sz) * LH + 5) ctx.warn.push(`表格放不下（${rows.length} 行挤在 ${Math.round(b.h)}px 高度里），请减行或给表格更多位置`);
  const bd = `<a:solidFill><a:srgbClr val="${C.line}"/></a:solidFill>`, ln = t => `<a:${t} w="9525">${bd}</a:${t}>`;
  const cell = (s, o) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${String(s).split('\n').map(t => paraXml({ runs: parseRuns(t, { b: o.b, color: o.color }), align: o.align }, sz)).join('')}</a:txBody><a:tcPr marL="${e(5)}" marR="${e(5)}" marT="${e(2)}" marB="${e(2)}" anchor="ctr">${ln('lnL')}${ln('lnR')}${ln('lnT')}${ln('lnB')}${fillXml(o.fill)}</a:tcPr></a:tc>`;
  const hs = n.headStyle || 'gray';
  let tr = '';
  if (head) tr += `<a:tr h="${e(hh)}">${head.map(s => cell(s, { b: true, align: 'ctr', fill: hs === 'red' ? C.red : 'E7E6E6', color: hs === 'red' ? C.white : C.text })).join('')}</a:tr>`;
  rows.forEach(r => { tr += `<a:tr h="${e(rh)}">${r.map((s, j) => cell(s, j === 0 && n.first !== 'plain' ? { b: true, align: 'ctr', fill: 'F2F2F2', color: n.first === 'red' ? C.red : C.text } : { align: n.align || (textW(plain(s), sz) < widths[j] * 0.6 ? 'ctr' : 'l'), fill: C.white })).join('')}</a:tr>`; rows.length && r.forEach(c => checkEnd(ctx, c)); });
  const id = ctx.id++;
  ctx.out.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="表格 ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${e(b.x)}" y="${e(b.y)}"/><a:ext cx="${e(b.w)}" cy="${e(b.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${widths.map(w => `<a:gridCol w="${e(w)}"/>`).join('')}</a:tblGrid>${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`);
};

// 公式行：parts 为字符串或 {t, n, label}；带编号的项套红框、上方写含义
COMP.formula = (ctx, n, b) => {
  const parts = (n.parts || []).map(p => (typeof p === 'string' ? { t: p } : p)); const sz = n.sz || 22, f = 'Cambria Math';
  const pw = (p, s) => textW(p.t, s) * 0.82 + (p.n != null ? 16 : 0);
  const tot = parts.reduce((a, p) => a + pw(p, sz), 0), s2 = Math.max(12, Math.floor(sz * Math.min(1, (b.w - 20) / tot)));
  const w2 = parts.map(p => pw(p, s2)), t2 = w2.reduce((a, c) => a + c, 0);
  const labs = parts.filter(p => p.label).length, top = labs ? 18 : 0, bot = labs > 1 ? 18 : 0, noteH = n.note ? 16 : 0;
  const rowH = Math.min(b.h - top - bot - noteH - 6, pt2px(s2) * 1.6);
  let x = b.x + (b.w - t2) / 2; const y = b.y + top + 3 + (b.h - top - bot - noteH - 6 - rowH) / 2;
  if (n.frame !== false) sp(ctx, { name: '公式框', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'none', line: { color: C.line, w: 0.75 } });
  let q = 0;
  parts.forEach((p, i) => {
    if (p.n != null) {
      ctx.motifs.add('formulaBox');
      sp(ctx, { name: '公式红框', x: x + 3, y: y, w: w2[i] - 6, h: rowH, fill: 'none', line: { color: C.red, w: 1.25 } });
      if (p.label) { const up = q % 2 === 0; q++; txt(ctx, x + w2[i] / 2 - 100, up ? y - 19 : y + rowH + 1, 200, 18, `${circled(p.n)} ${p.label}`, { sz: 11, b: true, color: C.red, align: 'ctr', fit: false }); }
    }
    sp(ctx, { name: '公式', x, y, w: w2[i], h: rowH, paras: [{ runs: [{ t: p.t, font: f, i: true, color: C.text }], align: 'ctr' }], sz: s2, anchor: 'ctr', wrap: 'none' });
    x += w2[i];
  });
  if (n.note) txt(ctx, b.x + 6, b.y + b.h - 18, b.w - 12, 16, n.note, { sz: 10, color: C.gray, align: 'r', fit: false });
};

// 图位：给了 path 就贴图（等比放进格子），否则画一个待贴图的虚线框
COMP.image = (ctx, n, b) => {
  const capH = n.caption ? 18 : 0; const box = { x: b.x, y: b.y, w: b.w, h: b.h - capH };
  let ok = false;
  if (n.path) {
    try {
      const buf = fs.readFileSync(n.path), dim = imgSize(buf);
      if (dim) {
        const sc = Math.min(box.w / dim.w, box.h / dim.h), w = dim.w * sc, h = dim.h * sc, x = box.x + (box.w - w) / 2, y = box.y + (box.h - h) / 2;
        const rid = addMedia(ctx, buf, dim.ext), id = ctx.id++;
        ctx.out.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片 ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${n.border ? lineXml({ color: C.line, w: 0.75 }) : ''}</p:spPr></p:pic>`);
        ok = true; ctx.images++;
      }
    } catch (err) { ctx.warn.push(`图片读不到：${n.path}`); }
  }
  if (!ok) {
    ctx.slots.push(n.placeholder || n.desc || '贴图');
    sp(ctx, { name: '图位（待贴图）', x: box.x, y: box.y, w: box.w, h: box.h, fill: 'FAFAFA', line: { color: 'A6A6A6', w: 0.75, dash: 'dash' }, paras: [{ runs: [{ t: '贴图：' + (n.placeholder || n.desc || '示意图 / 仿真曲线 / 截图'), color: '8C8C8C' }], align: 'ctr' }], sz: 11, anchor: 'ctr', ins: [6, 4, 6, 4] });
  }
  if (n.caption) txt(ctx, b.x, b.y + b.h - capH, b.w, capH, n.caption, { sz: 11, color: C.gray, align: 'ctr', fit: false });
};
function imgSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' };
  if (buf[0] === 0xFF && buf[1] === 0xD8) { let i = 2; while (i < buf.length) { if (buf[i] !== 0xFF) { i++; continue; } const m = buf[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), ext: 'jpeg' }; i += 2 + buf.readUInt16BE(i + 2); } }
  return null;
}
function addMedia(ctx, buf, ext) { const k = ctx.media.length + 1; ctx.media.push({ name: `image${k}.${ext === 'jpeg' ? 'jpg' : ext}`, buf, ext }); return 'rIdM' + k; }

// 素材库形状：按名称取，等比放进格子；text 依次替换形状里的文字
COMP.material = (ctx, n, b) => {
  const m = ctx.materials && ctx.materials(n.name);
  if (!m) { ctx.warn.push(`素材库里没有「${n.name}」`); ctx.slots.push('素材：' + n.name); sp(ctx, { name: '素材位', x: b.x, y: b.y, w: b.w, h: b.h, fill: 'FAFAFA', line: { color: 'A6A6A6', w: 0.75, dash: 'dash' }, paras: [{ runs: [{ t: '素材：' + n.name, color: '8C8C8C' }], align: 'ctr' }], sz: 11, anchor: 'ctr' }); return; }
  let w = b.w, h = b.h; const mw = +m.w, mh = +m.h;
  if (n.fit !== 'stretch') { const sc = Math.min(b.w * EMU / mw, b.h * EMU / mh); w = mw * sc / EMU; h = mh * sc / EMU; }
  const x = b.x + (b.w - w) / 2, y = b.y + (b.h - h) / 2;
  // 只去掉页面根节点已声明的 a/p/r；其余前缀（a14、ns2 等扩展）的声明必须留着，否则文件打不开
  let xml = m.xml.replace(/ xmlns:(?:a|p|r)="[^"]+"/g, '');
  let first = true;
  xml = xml.replace(/<a:xfrm([^>]*)>\s*<a:off[^>]*\/>\s*<a:ext[^>]*\/>/, (s, at) => { if (!first) return s; first = false; return `<a:xfrm${at}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/>`; });
  xml = xml.replace(/(<p:cNvPr[^>]*\bid=")\d+(")/g, (s, a, c) => a + (ctx.id++) + c);
  if (n.text) { const rep = [].concat(n.text); let i = 0; xml = xml.replace(/<a:t>[^<]*<\/a:t>/g, s => (i < rep.length ? `<a:t>${esc(rep[i++])}</a:t>` : s)); }
  const media = m.media || {};
  for (const rid of Object.keys(media)) { const [fname, b64] = media[rid]; const ext = (fname.split('.').pop() || 'png').toLowerCase(); const nr = addMedia(ctx, Buffer.from(b64, 'base64'), ext === 'jpg' ? 'jpeg' : ext); xml = xml.split(`"${rid}"`).join(`"${nr}"`); }
  // 素材带出来的超链接、内嵌图表等指向原文稿里的部件，这里没有，留着文件会打不开：超链接去掉，图表框去掉，仍有悬空引用就不放这个素材
  xml = xml.replace(/<a:hlink(?:Click|Hover|MouseOver)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:hlink(?:Click|Hover|MouseOver)>)/g, '');
  xml = xml.replace(/<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g, s => (/\br:\w+="(?!rIdM)/.test(s) ? '' : s));
  if (/\br:\w+="(?!rIdM)[^"]*"/.test(xml)) { ctx.warn.push(`素材「${n.name}」带有无法搬运的外部引用，已跳过，换一个素材`); return; }
  ctx.out.push(xml); ctx.usedMaterials.push(n.name);
};

// 大数字
COMP.bignum = (ctx, n, b) => {
  const vh = b.h * (n.label ? 0.6 : 1);
  txt(ctx, b.x, b.y, b.w, vh, n.value, { sz: n.sz || 28, b: true, color: n.color === 'blue' ? C.dblue : n.color === 'green' ? C.green : C.red, align: 'ctr', anchor: 'b', min: 16 });
  if (n.label) txt(ctx, b.x, b.y + vh, b.w, b.h - vh, n.label, { sz: 12, align: 'ctr', anchor: 't' });
};

// 胶囊标签
COMP.tag = (ctx, n, b) => {
  ctx.motifs.add('pill'); const h = Math.min(b.h, 28), w = Math.min(b.w, textW(plain(n.t), 14, true) + 40);
  const g = n.color === 'gold' ? GRAD.pillG : n.color === 'teal' ? GRAD.pillT : n.color === 'red' ? GRAD.pillR : GRAD.pillB;
  sp(ctx, { name: '胶囊标签', x: b.x + (n.align === 'left' ? 0 : (b.w - w) / 2), y: b.y + (b.h - h) / 2, w, h, geom: 'roundRect', adj: [50000], fill: g, line: 'none', shadow: true, paras: [{ runs: parseRuns(n.t, { color: C.white, b: true }), align: 'ctr' }], sz: 14, anchor: 'ctr', wrap: 'none' });
};

// 时间轴：nodes [{label, t}]
COMP.timeline = (ctx, n, b) => {
  const N = n.nodes || [], k = N.length; if (!k) return; ctx.motifs.add('timeline');
  const ay = b.y + Math.min(48, b.h * 0.42), cw = b.w / k;
  sp(ctx, { name: '时间轴', x: b.x, y: ay - 5, w: b.w, h: 10, geom: 'rightArrow', adj: [60000, 120000], fill: { stops: [[0, 'F2F2F2'], [100, 'A6A6A6']], ang: 0 }, line: 'none' });
  N.forEach((o, i) => {
    const cx = b.x + cw * (i + 0.5); const now = n.now === i;
    sp(ctx, { name: '节点标签', x: cx - 34, y: ay - 40, w: 68, h: 24, geom: 'roundRect', adj: [50000], fill: now ? GRAD.pillR : GRAD.pillB, line: 'none', paras: [{ runs: [{ t: o.label, color: C.white, b: true }], align: 'ctr' }], sz: 13, anchor: 'ctr', wrap: 'none' });
    lineSeg(ctx, cx, ay - 16, cx, ay - 4, { color: now ? C.red : C.dblue, w: 1 });
    sp(ctx, { name: '节点', x: cx - 6, y: ay - 6, w: 12, h: 12, geom: 'ellipse', fill: C.red, line: { color: C.white, w: 1.5 } });
    if (o.t) txt(ctx, cx - cw / 2 + 6, ay + 12, cw - 12, b.y + b.h - ay - 12, o.t, { sz: 12, align: 'ctr', anchor: 't' });
  });
};

// 路线格：cols 阶段名；rows [{head, cells[]}]；now 高亮列；cells 可写 "**标题**\n说明"，以 ★ 开头标重点
COMP.grid = (ctx, n, b) => {
  const cols = n.cols || [], rows = n.rows || [], hw = n.headW || 86, gap = 6;
  const cx0 = b.x + hw + gap, cwAll = b.w - hw - gap;
  COMP.chevrons(ctx, { items: cols, now: n.nowHead ? n.now : undefined, color: n.color }, { x: cx0, y: b.y, w: cwAll, h: 34 });
  let y = b.y + 34 + gap;
  if (n.sub) { const cw = cwAll / cols.length; n.sub.forEach((s, i) => txt(ctx, cx0 + i * cw, y, cw, 26, s, { sz: 16, b: true, color: C.red, align: 'ctr' })); y += 30; }
  const rh = (b.y + b.h - y - gap * (rows.length - 1)) / (rows.length || 1), cw = (cwAll - gap * (cols.length - 1)) / cols.length;
  rows.forEach((r, i) => {
    const ry = y + i * (rh + gap);
    sp(ctx, { name: '行标题', x: b.x, y: ry, w: hw, h: rh, fill: C.head, line: 'none', paras: [{ runs: [{ t: r.head, color: C.red, b: true }], align: 'ctr' }], sz: 16, anchor: 'ctr' });
    (r.cells || []).forEach((c, j) => {
      const x = cx0 + j * (cw + gap), star = /^★/.test(c), s = star ? c.slice(1).trim() : c; checkEnd(ctx, s);
      sp(ctx, { name: '格', x, y: ry, w: cw, h: rh, fill: j === n.now ? C.lblue : C.soft, line: j === n.now ? { color: C.mblue, w: 0.75 } : 'none' });
      const segs = s.split('\n'), paras = segs.map((t, q) => ({ t, b: q === 0 && segs.length > 1 }));
      const sz = fitSize(paras, cw - 24, rh - 8, 14, { bullet: 'none', gapPt: 3 }); ctx.sizes.push(sz); ctx.chars += plain(s).length;

      sp(ctx, { name: '格内文字', x: x + 12, y: ry + 4, w: cw - 24, h: rh - 8, paras: segs.map((t, q) => ({ runs: (q === 0 && star ? [{ t: '★ ', color: C.red, b: true }] : []).concat(parseRuns(t, q === 0 && segs.length > 1 ? { b: true } : { color: segs.length > 1 ? '595959' : C.text })), sz: q === 0 ? sz : Math.max(10, sz - 2), before: q ? 4 : 0 })), sz, anchor: 'ctr' });
    });
  });
};

// 折线图（形状画的）：series [{name, color, points[]}]，xlabels[]
COMP.curve = (ctx, n, b) => {
  const S = n.series || [], xl = n.xlabels || []; if (!S.length) return;
  const titleH = n.title ? 20 : 0; if (n.title) txt(ctx, b.x, b.y, b.w, 18, n.title, { sz: 12, b: true, align: 'ctr' });
  const L = 38, B = 22, T = 8 + titleH, R = 10, px = b.x + L, py = b.y + T, pw = b.w - L - R, ph = b.h - T - B;
  const all = [].concat.apply([], S.map(s => s.points)); let lo = n.min != null ? n.min : Math.min.apply(null, all), hi = n.max != null ? n.max : Math.max.apply(null, all);
  if (hi === lo) hi = lo + 1; const pad = (hi - lo) * 0.08; if (n.min == null) lo -= pad; if (n.max == null) hi += pad;
  const ticks = 4;
  const span = hi - lo, dec = span >= 20 ? 0 : span >= 2 ? 1 : 2;
  for (let i = 0; i <= ticks; i++) { const yy = py + ph - ph * i / ticks; lineSeg(ctx, px, yy, px + pw, yy, { color: i ? 'E7E6E6' : '7F7F7F', w: i ? 0.5 : 1 }); const v = lo + span * i / ticks; txt(ctx, b.x - 6, yy - 8, L - 2, 16, v.toFixed(dec) + (n.unit || ''), { sz: 10, color: C.gray, align: 'r', fit: false, box: { wrap: 'none' } }); }
  lineSeg(ctx, px, py, px, py + ph, { color: '7F7F7F', w: 1 });
  const np = Math.max.apply(null, S.map(s => s.points.length)); const X = i => px + (np > 1 ? pw * i / (np - 1) : pw / 2), Y = v => py + ph - (v - lo) / (hi - lo) * ph;
  xl.forEach((s, i) => txt(ctx, X(i) - 40, py + ph + 3, 80, 16, s, { sz: 10, color: C.gray, align: 'ctr', fit: false }));
  const pal = { red: C.red, blue: '2E75B6', gray: '7F7F7F', orange: C.orange, green: C.green };
  S.forEach((s, si) => {
    const col = pal[s.color] || s.color || ['2E75B6', C.red, '7F7F7F'][si % 3];
    const d = s.points.map((v, i) => `<a:${i ? 'lnTo' : 'moveTo'}><a:pt x="${Math.round((X(i) - px) / pw * 10000)}" y="${Math.round((Y(v) - py) / ph * 10000)}"/></a:${i ? 'lnTo' : 'moveTo'}>`).join('');
    sp(ctx, { name: '曲线 ' + (s.name || ''), x: px, y: py, w: pw, h: ph, path: { w: 10000, h: 10000, d, nofill: true }, fill: 'none', line: { color: col, w: s.w || 2, join: 'round', dash: s.dash } });
    if (s.dots !== false && s.points.length <= 12) s.points.forEach((v, i) => sp(ctx, { name: '点', x: X(i) - 3.5, y: Y(v) - 3.5, w: 7, h: 7, geom: 'ellipse', fill: col, line: { color: C.white, w: 0.75 } }));
    if (s.name) txt(ctx, px + pw - 150, Y(s.points[s.points.length - 1]) - 22, 150, 18, s.name, { sz: 11, b: true, color: col, align: 'r', fit: false });
    if (s.labels) s.points.forEach((v, i) => s.labels[i] && txt(ctx, X(i) - 40, Y(v) - 22, 80, 16, s.labels[i], { sz: 10, b: true, color: col, align: 'ctr', fit: false }));
  });
};

// 空白占位
COMP.gap = () => {};

// ---------- 整页 ----------
function buildSlide(spec, opts, cap) {
  const ctx = { bodyCap: cap, bodyFits: [], id: 2, out: [], media: [], warn: [], sizes: [], motifs: new Set(), hl: 0, chars: 0, images: 0, slots: [], usedMaterials: [], materials: opts.materials };
  const M = 30; let y = 14;
  const title = spec.title || '';
  if (!title) ctx.warn.push('缺标题');
  if (/[。；;，,、！!]\s*$/.test(title)) ctx.warn.push('标题末尾有标点');
  const tabsW = spec.tabs ? Math.min(420, spec.tabs.items.length * 92) : 0;
  const tw = W - 2 * M - tabsW - (tabsW ? 12 : 0);
  let tsz = 28; while (tsz > 20 && textW(title, tsz, true) > tw) tsz -= 2;
  if (textW(title, tsz, true) > tw) ctx.warn.push(`标题一行放不下（${title.length} 字），请缩短`);
  // 标题：有冒号时「黑色定位语：红色结论」，titleStyle:'red' 时全红
  const ci = title.search(/[:：]/);
  const runs = (spec.titleStyle || 'split') === 'split' && ci > 0 && ci < title.length - 1
    ? [{ t: title.slice(0, ci + 1), color: C.text, b: true }, { t: title.slice(ci + 1), color: C.red, b: true }]
    : [{ t: title, color: C.red, b: true }];
  sp(ctx, { name: '标题', x: M, y, w: tw, h: 50, paras: [{ runs, align: 'l' }], sz: tsz, anchor: 'ctr', wrap: 'none' });
  if (spec.tabs) {
    const it = spec.tabs.items, w = tabsW / it.length;
    it.forEach((s, i) => { const cur = i === spec.tabs.cur; sp(ctx, { name: '章节页签', x: W - M - tabsW + i * w, y: y + 12, w: w - 4, h: 24, fill: cur ? C.red : C.head, line: 'none', paras: [{ runs: [{ t: s, color: cur ? C.white : C.gray, b: cur }], align: 'ctr' }], sz: 11, anchor: 'ctr', wrap: 'none' }); });
  }
  y += 54;
  if (spec.rule !== false) { lineSeg(ctx, M, y, W - M, y, { color: C.red, w: 1.5 }); }
  y += 10;
  let bottom = H - 14;
  if (spec.footer) {
    const f = spec.footer === true ? {} : spec.footer;
    txt(ctx, M, H - 24, 500, 16, `${f.page != null ? f.page + '    ' : ''}${f.text || ''}`, { sz: 10, color: C.gray, fit: false, name: '页脚' });
    bottom = H - 30;
  }
  if (spec.note) { txt(ctx, M, bottom - 16, W - 2 * M, 16, spec.note, { sz: 10, color: C.gray, fit: false, name: '脚注' }); bottom -= 20; }
  const body = spec.body || (spec.col ? { col: spec.col } : spec.row ? { row: spec.row } : null);
  if (body) layout(ctx, body, { x: M, y, w: W - 2 * M, h: bottom - y });
  // 第一遍只为量字号：正文统一到「放得下的最小字号」（不低于 12），再正式画一遍
  if (cap == null && ctx.bodyFits.length > 1) { const m = Math.max(12, Math.min.apply(null, ctx.bodyFits)); if (m < 16) return buildSlide(spec, opts, m); }
  // 自查
  const small = ctx.sizes.filter(s => s <= 10).length;
  if (small > 2) ctx.warn.push(`有 ${small} 处文字被缩到 10pt，内容偏多，建议删字或拆页`);
  if (ctx.hl > 4) ctx.warn.push(`黄底指标条 ${ctx.hl} 处，建议不超过 3–4 处`);
  const mot = [...new Set([...ctx.motifs].filter(m => !['num', 'bar', 'line', 'left', 'gray', 'curveArrow', 'target', 'formulaBox'].includes(m)).map(m => m.replace(/-.*/, '')))];
  if (mot.length > 3) ctx.warn.push(`一页用了 ${mot.length} 种装饰母题（${mot.join('、')}），建议 1–2 种`);
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${ctx.out.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  return { xml, media: ctx.media, report: { warnings: ctx.warn, chars: ctx.chars, minFont: ctx.sizes.length ? Math.min.apply(null, ctx.sizes) : null, motifs: [...ctx.motifs], imageSlots: ctx.slots, images: ctx.images, materials: ctx.usedMaterials } };
}

// ---------- pptx 打包 ----------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(files) {
  const parts = [], cen = []; let off = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'), name = Buffer.from(f.name, 'utf8');
    const store = /\.(png|jpg|jpeg|gif)$/i.test(f.name), comp = store ? data : zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, comp); cen.push(c, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cen), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat(parts.concat([cd, end]));
}
const XH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const THEME = `${XH}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="汇报页"><a:themeElements><a:clrScheme name="汇报页"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="C00000"/></a:accent1><a:accent2><a:srgbClr val="2E75B6"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="1F4E79"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="汇报页"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const EMPTY_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

// specs: 一页或多页说明；opts.materials(name) -> {xml,w,h,media}
function build(specs, opts) {
  opts = opts || {}; specs = Array.isArray(specs) ? specs : (specs.pages || [specs]);
  const files = [], reports = []; let mediaN = 0; const exts = new Set();
  let ct = '', prs = '', prels = '';
  specs.forEach((spec, i) => {
    const r = buildSlide(spec, opts); const k = i + 1; let rels = `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    let xml = r.xml;
    r.media.forEach((m, j) => { mediaN++; const fn = `image${mediaN}.${m.name.split('.').pop()}`; exts.add(fn.split('.').pop()); files.push({ name: `ppt/media/${fn}`, data: m.buf }); rels += `<Relationship Id="rIdM${j + 1}" Type="${REL}/image" Target="../media/${fn}"/>`; });
    files.push({ name: `ppt/slides/slide${k}.xml`, data: xml }, { name: `ppt/slides/_rels/slide${k}.xml.rels`, data: `${XH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` });
    ct += `<Override PartName="/ppt/slides/slide${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    prs += `<p:sldId id="${255 + k}" r:id="rId${k + 2}"/>`; prels += `<Relationship Id="rId${k + 2}" Type="${REL}/slide" Target="slides/slide${k}.xml"/>`;
    reports.push(r.report);
  });
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', emf: 'image/x-emf', wmf: 'image/x-wmf', svg: 'image/svg+xml' };
  files.unshift(
    { name: '[Content_Types].xml', data: `${XH}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map(x => `<Default Extension="${x}" ContentType="${mime[x] || 'application/octet-stream'}"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${ct}</Types>` },
    { name: '_rels/.rels', data: `${XH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { name: 'ppt/presentation.xml', data: `${XH}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${prs}</p:sldIdLst><p:sldSz cx="${W * EMU}" cy="${H * EMU}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `${XH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>${prels}</Relationships>` },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: `${XH}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${EMPTY_TREE}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>` },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: `${XH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: `${XH}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="空白">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: `${XH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: 'ppt/theme/theme1.xml', data: THEME }
  );
  return { buffer: zip(files), reports };
}

// 从素材清单(JSON: {name:{xml,w,h,media}}) 得到查找函数
function materialsFromJson(file) { let db = null; return name => { if (!db) { try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { db = {}; } } return db[name] || null; }; }

module.exports = { VERSION, build, buildSlide, materialsFromJson, COMPONENTS: Object.keys(COMP), zip };

if (require.main === module) {
  const [, , specFile, outFile] = process.argv;
  if (!specFile || !outFile) { console.error('用法: node pagegen.js <页面说明.json> <输出.pptx> [素材清单.json]'); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8').replace(/^﻿/, ''));
  const matFile = process.argv[4] || path.join(__dirname, 'materials.json');
  const r = build(spec, { materials: materialsFromJson(matFile) });
  fs.writeFileSync(outFile, r.buffer);
  console.log(JSON.stringify({ out: path.resolve(outFile), pages: r.reports.length, reports: r.reports }, null, 1));
}
