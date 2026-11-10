'use strict';
// PPT 页「版式预览」（2026-11-08 用户：搜索结果一片「暂无缓存预览」太伤）。
// PPT Doctor 只有用户在它里面看过的页才有截图缓存；Hub 不启动、不驱动 PowerPoint（单实例，碰了会打扰用户正在编辑的稿子），
// 改为直接读 .pptx 压缩包里的 XML，按原稿的位置画出：背景、母版/版式上的图形与图片、标题与正文、表格、图片。
// 输出的是「场景」JSON（单位：磅），界面用 SVG 画（renderer/ppt-slide-svg.js）。这是近似预览，不是截图：
// 图表、SmartArt、EMF 矢量图画成带名字的占位框；字体统一用微软雅黑。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const EMU_PER_PT = 12700;
const MAX_PART_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ITEMS = 400;

// ---------------------------------------------------------------- zip（只读中央目录 + 按需解压单个条目）
const zipCache = new Map();
function openZip(file) {
  const st = fs.statSync(file), key = `${path.resolve(file).toLowerCase()}|${st.mtimeMs}|${st.size}`;
  if (zipCache.has(key)) return zipCache.get(key);
  const zip = { ...readZipDirectory(file), key };
  zipCache.set(key, zip);
  while (zipCache.size > 12) zipCache.delete(zipCache.keys().next().value);
  return zip;
}
function readZipDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557 + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('不是有效的 pptx（找不到 zip 目录）');
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64At = Number(tail.readBigUInt64LE(loc + 8)), z64 = Buffer.alloc(56);
        fs.readSync(fd, z64, 0, 56, z64At);
        if (z64.readUInt32LE(0) === 0x06064b50) { count = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdOffset = Number(z64.readBigUInt64LE(48)); }
      }
    }
    if (cdSize > 64 * 1024 * 1024) throw new Error('pptx 目录过大');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = new Map();
    for (let p = 0, n = 0; p + 46 <= cd.length && n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let comp = cd.readUInt32LE(p + 20), raw = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (comp === 0xffffffff || raw === 0xffffffff || offset === 0xffffffff) {
        for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
          const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
          if (id === 1) {
            let q = e + 4;
            if (raw === 0xffffffff) { raw = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
          }
          e += 4 + len;
        }
      }
      entries.set(name.replace(/\\/g, '/').toLowerCase(), { name, method, comp, raw, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries };
  } finally { fs.closeSync(fd); }
}
function readEntry(zip, name, limit = MAX_PART_BYTES) {
  const entry = zip.entries.get(String(name).replace(/^\/+/, '').toLowerCase());
  if (!entry) return null;
  if (entry.raw > limit || entry.comp > limit) return null;
  const fd = fs.openSync(zip.file, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(entry.comp);
    fs.readSync(fd, data, 0, entry.comp, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.raw || limit) });
    return null;
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- 极简 XML → 树（OOXML 足够：无 DTD、CDATA 少见）
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
  return s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITY[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return ''; }
  });
}
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[2]) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      if (m[3]) for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const node = { name: m[2], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5] != null) top.text += m[5];
    else if (m[6] != null) top.text += decode(m[6]);
  }
  return root;
}
const local = name => String(name || '').replace(/^.*:/, '');
function kid(node, name) { return node && node.children.find(c => c.name === name || local(c.name) === name) || null; }
function kids(node, name) { return node ? node.children.filter(c => c.name === name || local(c.name) === name) : []; }
function at(node, ...names) { let n = node; for (const name of names) { n = kid(n, name); if (!n) return null; } return n; }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------------------------------------------------------------- 包内路径与关系
function resolvePart(base, target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  const parts = path.posix.dirname(base).split('/').filter(Boolean);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}
function relsOf(zip, part) { return cached(zip, 'rels:' + part, () => readRels(zip, part)); }
function readRels(zip, part) {
  const relPath = path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
  const buf = readEntry(zip, relPath);
  const map = new Map();
  if (!buf) return map;
  for (const r of kids(kid(parseXml(buf.toString('utf8')), 'Relationships'), 'Relationship')) {
    if (r.attrs.TargetMode === 'External') continue;
    map.set(r.attrs.Id, { type: String(r.attrs.Type || '').replace(/^.*\//, ''), target: resolvePart(part, r.attrs.Target) });
  }
  return map;
}
// 同一份文稿画多页时，母版、版式、主题、关系表只解析一次（按 路径|修改时间|大小 缓存，文稿改了自动失效）。
const partCache = new Map();
function cached(zip, key, make) {
  if (!zip.key) return make();
  const k = zip.key + '|' + key;
  if (partCache.has(k)) { const v = partCache.get(k); partCache.delete(k); partCache.set(k, v); return v; }
  const v = make();
  partCache.set(k, v);
  while (partCache.size > 120) partCache.delete(partCache.keys().next().value);
  return v;
}
function xmlPart(zip, part, share = true) {
  const load = () => { const buf = part && readEntry(zip, part); return buf ? parseXml(buf.toString('utf8')) : null; };
  return share && !/\/slides\/slide\d+\.xml$/i.test(part || '') ? cached(zip, 'xml:' + part, load) : load();
}

// ---------------------------------------------------------------- 颜色
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500' };
function hexToHsl(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToHex(h, s, l) {
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  let r, g, b;
  if (!s) r = g = b = l;
  else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function applyMods(hex, node) {
  let alpha = 1;
  let [h, s, l] = hexToHsl(hex);
  let touched = false;
  for (const m of node.children) {
    const v = num(m.attrs.val, 100000) / 100000, n = local(m.name);
    if (n === 'lumMod') { l *= v; touched = true; }
    else if (n === 'lumOff') { l += v; touched = true; }
    else if (n === 'tint') { l = l + (1 - l) * (1 - v); touched = true; }
    else if (n === 'shade') { l *= v; touched = true; }
    else if (n === 'alpha') alpha = v;
  }
  return { hex: touched ? hslToHex(h, s, Math.max(0, Math.min(1, l))) : hex, alpha };
}
function colorOf(node, ctx) {
  if (!node) return null;
  const c = node.children.find(x => /^(?:srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(local(x.name)));
  if (!c) return null;
  const n = local(c.name);
  let hex = null;
  if (n === 'srgbClr') hex = String(c.attrs.val || '').toUpperCase();
  else if (n === 'sysClr') hex = String(c.attrs.lastClr || (c.attrs.val === 'window' ? 'FFFFFF' : '000000')).toUpperCase();
  else if (n === 'prstClr') hex = PRESET[c.attrs.val] || '000000';
  else if (n === 'scrgbClr') hex = ['r', 'g', 'b'].map(k => Math.round(num(c.attrs[k]) / 100000 * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  else if (n === 'schemeClr') {
    let key = c.attrs.val;
    if (key === 'phClr') key = ctx.phClr || 'tx1';
    const mapped = ctx.clrMap?.[key] || ({ bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' })[key] || key;
    hex = ctx.scheme?.[mapped] || null;
  }
  if (!/^[0-9A-F]{6}$/.test(hex || '')) return null;
  const { hex: out, alpha } = applyMods(hex, c);
  return alpha < 1 ? `rgba(${parseInt(out.slice(0, 2), 16)},${parseInt(out.slice(2, 4), 16)},${parseInt(out.slice(4, 6), 16)},${alpha.toFixed(2)})` : '#' + out;
}
function readScheme(theme) {
  const scheme = {};
  const cs = at(theme, 'themeElements', 'clrScheme');
  for (const c of cs?.children || []) {
    const v = c.children[0];
    if (!v) continue;
    scheme[local(c.name)] = String(local(v.name) === 'sysClr' ? (v.attrs.lastClr || '') : (v.attrs.val || '')).toUpperCase();
  }
  return scheme;
}
function readFonts(theme) {
  const fs_ = at(theme, 'themeElements', 'fontScheme');
  const pick = n => { const f = kid(fs_, n); return (kid(f, 'ea')?.attrs.typeface) || (kid(f, 'latin')?.attrs.typeface) || ''; };
  return { major: pick('majorFont'), minor: pick('minorFont') };
}

// 形状的填充 / 线条：先看 spPr，自己没写时看 p:style 的 fillRef / lnRef（默认形状常这样配色）。
function fillOf(spPr, style, ctx) {
  if (spPr) {
    if (kid(spPr, 'noFill')) return null;
    const solid = kid(spPr, 'solidFill');
    if (solid) return colorOf(solid, ctx);
    const grad = kid(spPr, 'gradFill');
    if (grad) { const stops = kids(kid(grad, 'gsLst'), 'gs'); return colorOf(stops[Math.floor(stops.length / 2)] || stops[0], ctx); }
    if (kid(spPr, 'pattFill')) return colorOf(kid(kid(spPr, 'pattFill'), 'bgClr'), ctx);
  }
  const ref = kid(style, 'fillRef');
  if (ref && num(ref.attrs.idx) > 0) return colorOf(ref, ctx);
  return null;
}
function lineOf(spPr, style, ctx) {
  const ln = kid(spPr, 'ln');
  if (ln) {
    if (kid(ln, 'noFill')) return null;
    const color = colorOf(kid(ln, 'solidFill'), ctx);
    if (color) return { color, width: Math.max(0.5, num(ln.attrs.w, 9525) / EMU_PER_PT) };
  }
  const ref = kid(style, 'lnRef');
  if (ref && num(ref.attrs.idx) > 0) { const color = colorOf(ref, ctx); if (color) return { color, width: 0.75 }; }
  return null;
}

// 渐变（2026-11-10 素材预览）：fill 仍给中间色（老渲染照旧可用），grad 给完整色标与方向，SVG 用 linearGradient / radialGradient 画。
function gradOf(spPr, ctx) {
  const grad = spPr && !kid(spPr, 'solidFill') && !kid(spPr, 'noFill') ? kid(spPr, 'gradFill') : null;
  if (!grad) return null;
  const stops = kids(kid(grad, 'gsLst'), 'gs').map(gs => [Math.round(num(gs.attrs.pos) / 1000) / 100, colorOf(gs, ctx)]).filter(s => s[1]).sort((a, b) => a[0] - b[0]);
  if (stops.length < 2) return null;
  const lin = kid(grad, 'lin');
  return { stops: stops.slice(0, 10), ...(kid(grad, 'path') ? { radial: true } : { ang: Math.round(num(lin?.attrs.ang) / 60000) }) };
}
// 自定义形状（custGeom）：按路径画轮廓，坐标换算到形状自身的磅坐标（左上角为 0,0）。公式引用（gd 名字）读不出数值时整条放弃，退回矩形。
function custPathOf(spPr, box) {
  const paths = kids(at(spPr, 'custGeom', 'pathLst'), 'path');
  if (!paths.length) return null;
  const out = [];
  const f = v => Math.round(v * 10) / 10;
  for (const p of paths.slice(0, 20)) {
    const pw = num(p.attrs.w), ph = num(p.attrs.h);
    const sx = pw > 0 ? box.w / pw : 1 / EMU_PER_PT, sy = ph > 0 ? box.h / ph : 1 / EMU_PER_PT;
    let d = '', cx = 0, cy = 0, bad = false;
    const pt = n => { const x = Number(n?.attrs.x), y = Number(n?.attrs.y); if (!Number.isFinite(x) || !Number.isFinite(y)) { bad = true; return [0, 0]; } return [x * sx, y * sy]; };
    for (const c of p.children) {
      const k = local(c.name), pts = kids(c, 'pt').map(pt);
      if (k === 'moveTo' || k === 'lnTo') { const [x, y] = pts[0] || [0, 0]; d += `${k === 'moveTo' ? 'M' : 'L'}${f(x)} ${f(y)}`; cx = x; cy = y; }
      else if (k === 'cubicBezTo' && pts.length === 3) { d += 'C' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' '); [cx, cy] = pts[2]; }
      else if (k === 'quadBezTo' && pts.length === 2) { d += 'Q' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' '); [cx, cy] = pts[1]; }
      else if (k === 'arcTo') {
        const wr = Number(c.attrs.wR) * sx, hr = Number(c.attrs.hR) * sy, st = Number(c.attrs.stAng) / 60000 * Math.PI / 180, sw = Number(c.attrs.swAng) / 60000;
        if (![wr, hr, st, sw].every(Number.isFinite)) { bad = true; break; }
        const ox = cx - wr * Math.cos(st), oy = cy - hr * Math.sin(st), en = st + sw * Math.PI / 180;
        const ex = ox + wr * Math.cos(en), ey = oy + hr * Math.sin(en);
        d += `A${f(wr)} ${f(hr)} 0 ${Math.abs(sw) > 180 ? 1 : 0} ${sw > 0 ? 1 : 0} ${f(ex)} ${f(ey)}`; cx = ex; cy = ey;
      } else if (k === 'close') d += 'Z';
      if (bad) break;
    }
    if (bad || !d) return null;
    out.push({ d, ...(p.attrs.fill === 'none' ? { nofill: true } : {}), ...(p.attrs.stroke === '0' ? { nostroke: true } : {}) });
  }
  return out.length ? out : null;
}
// 预置形状的调整值（avLst 里 val N，单位 1/100000），按顺序给渲染用；没写就用默认值。
function adjOf(spPr) {
  const gds = kids(at(spPr, 'prstGeom', 'avLst'), 'gd');
  const vals = gds.map(g => { const m = String(g.attrs.fmla || '').match(/^val\s+(-?\d+)$/); return m ? Number(m[1]) / 100000 : null; });
  return vals.length && vals.every(v => v !== null) ? vals : null;
}

// ---------------------------------------------------------------- 文字
// 字号优先级：run → 段落 defRPr → 形状 lstStyle → 版式/母版占位符 lstStyle → 母版 txStyles → 默认 18 磅。
function levelProps(lst, lvl) { return lst ? kid(lst, `lvl${lvl + 1}pPr`) : null; }
function inheritedRun(chain, lvl) {
  const out = {};
  for (const lst of chain) {
    const p = levelProps(lst, lvl);
    const d = kid(p, 'defRPr');
    if (!d) continue;
    if (out.sz == null && d.attrs.sz) out.sz = num(d.attrs.sz) / 100;
    if (out.b == null && d.attrs.b != null) out.b = d.attrs.b === '1' || d.attrs.b === 'true';
    if (out.color == null && kid(d, 'solidFill')) out.colorNode = out.colorNode || kid(d, 'solidFill');
  }
  return out;
}
function inheritedPara(chain, lvl) {
  for (const lst of chain) { const p = levelProps(lst, lvl); if (p && p.attrs.algn) return p.attrs.algn; }
  return '';
}
function bulletInherited(chain, lvl) {
  for (const lst of chain) {
    const p = levelProps(lst, lvl);
    if (!p) continue;
    if (kid(p, 'buNone')) return false;
    if (kid(p, 'buChar') || kid(p, 'buAutoNum')) return true;
  }
  return false;
}
function textOf(txBody, ctx, chain, defaults = {}) {
  if (!txBody) return null;
  const bodyPr = kid(txBody, 'bodyPr');
  const auto = kid(bodyPr, 'normAutofit');
  const scale = auto ? num(auto.attrs.fontScale, 100000) / 100000 : 1;
  const own = kid(txBody, 'lstStyle');
  const lists = [own, ...chain].filter(Boolean);
  const paras = [];
  let chars = 0;
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = Math.max(0, Math.min(8, num(pPr?.attrs.lvl)));
    const inh = inheritedRun(lists, lvl);
    const runs = [];
    for (const r of p.children) {
      const n = local(r.name);
      if (n === 'br') { runs.push({ text: '\n' }); continue; }
      if (n !== 'r' && n !== 'fld') continue;
      const t = kid(r, 't');
      // 页码域：原文是「‹#›」之类的占位，换成真实页码。
      const text = n === 'fld' && /slidenum/i.test(r.attrs.type || '') ? String(ctx.page || '') : t ? t.text : '';
      if (!text) continue;
      const rPr = kid(r, 'rPr');
      const sz = rPr?.attrs.sz ? num(rPr.attrs.sz) / 100 : (inh.sz ?? defaults.sz ?? 18);
      const b = rPr?.attrs.b != null ? (rPr.attrs.b === '1' || rPr.attrs.b === 'true') : (inh.b ?? defaults.b ?? false);
      const color = colorOf(kid(rPr, 'solidFill'), ctx) || colorOf(inh.colorNode, ctx) || defaults.color || null;
      runs.push({ text, sz: Math.round(sz * scale * 10) / 10, ...(b ? { b: true } : {}), ...(color ? { color } : {}) });
      chars += text.length;
    }
    const empty = !runs.some(r => r.text && r.text !== '\n');
    const endSz = num(kid(p, 'endParaRPr')?.attrs.sz) / 100 || inh.sz || defaults.sz || 18;
    const bullet = !empty && (pPr && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum')) ? true : pPr && kid(pPr, 'buNone') ? false : (defaults.bullets && bulletInherited(lists, lvl)));
    paras.push({ runs, align: pPr?.attrs.algn || inheritedPara(lists, lvl) || defaults.align || 'l', lvl, ...(bullet ? { bullet: true } : {}), ...(empty ? { sz: Math.round(endSz * scale * 10) / 10 } : {}) });
    if (chars > 4000) break;
  }
  if (!paras.some(p => p.runs.length)) return null;
  const ins = k => num(bodyPr?.attrs[k], k[0] === 'l' || k[0] === 'r' ? 91440 : 45720) / EMU_PER_PT;
  return { paras, anchor: bodyPr?.attrs.anchor || defaults.anchor || 't', inset: [ins('tIns'), ins('rIns'), ins('bIns'), ins('lIns')], ...(bodyPr?.attrs.vert && bodyPr.attrs.vert !== 'horz' ? { vert: true } : {}), ...(bodyPr?.attrs.wrap === 'none' ? { nowrap: true } : {}) };
}

// ---------------------------------------------------------------- 几何
function xfrmOf(node) {
  if (!node) return null;
  const off = kid(node, 'off'), ext = kid(node, 'ext');
  if (!off || !ext) return null;
  return { x: num(off.attrs.x), y: num(off.attrs.y), w: num(ext.attrs.cx), h: num(ext.attrs.cy), rot: num(node.attrs.rot) / 60000, flipH: node.attrs.flipH === '1', flipV: node.attrs.flipV === '1',
    chOff: kid(node, 'chOff') ? { x: num(kid(node, 'chOff').attrs.x), y: num(kid(node, 'chOff').attrs.y) } : null,
    chExt: kid(node, 'chExt') ? { w: num(kid(node, 'chExt').attrs.cx), h: num(kid(node, 'chExt').attrs.cy) } : null };
}
function applyGroup(box, tf) {
  if (!tf) return box;
  return { ...box, x: tf.x + (box.x - tf.cx) * tf.sx, y: tf.y + (box.y - tf.cy) * tf.sy, w: box.w * tf.sx, h: box.h * tf.sy };
}
function toPt(box) {
  const r = v => Math.round(v / EMU_PER_PT * 10) / 10;
  return { x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h), ...(box.rot ? { rot: Math.round(box.rot * 10) / 10 } : {}) };
}

// ---------------------------------------------------------------- 占位符继承
function phInfo(node) {
  const ph = at(node, 'nvSpPr', 'nvPr', 'ph') || at(node, 'nvPicPr', 'nvPr', 'ph') || at(node, 'nvGraphicFramePr', 'nvPr', 'ph');
  if (!ph) return null;
  return { type: ph.attrs.type || 'body', idx: ph.attrs.idx != null ? String(ph.attrs.idx) : '' };
}
const phFamily = type => (type === 'title' || type === 'ctrTitle') ? 'title' : (type === 'body' || type === 'subTitle' || type === 'obj' || type === 'tx') ? 'body' : type;
function findPlaceholder(tree, info) {
  if (!tree || !info) return null;
  const shapes = [];
  (function walk(n) { for (const c of n.children) { if (local(c.name) === 'sp') shapes.push(c); else if (local(c.name) === 'grpSp') walk(c); } })(at(tree, 'cSld', 'spTree') || { children: [] });
  const withPh = shapes.map(s => ({ s, ph: phInfo(s) })).filter(x => x.ph);
  return (info.idx && withPh.find(x => x.ph.idx === info.idx && (phFamily(x.ph.type) === phFamily(info.type) || info.type === 'body' || x.ph.type === 'body' || info.type === 'obj')))?.s
    || withPh.find(x => x.ph.type === info.type)?.s
    || withPh.find(x => phFamily(x.ph.type) === phFamily(info.type))?.s
    || null;
}

// ---------------------------------------------------------------- 主流程
class SceneBuilder {
  constructor(zip, opts) {
    this.zip = zip; this.opts = opts; this.items = []; this.imageCache = new Map(); this.notes = new Set();
  }
  image(part) {
    if (this.imageCache.has(part)) return this.imageCache.get(part);
    let out = null;
    const ext = path.posix.extname(part).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      const key = crypto.createHash('sha1').update(this.opts.cacheKey + '\0' + part).digest('hex').slice(0, 20);
      const dir = this.opts.mediaDir;
      if (dir) {
        const existing = ['.jpg', '.png', ext].map(e => path.join(dir, key + e)).find(f => fs.existsSync(f));
        if (existing) out = existing;
        else {
          const buf = readEntry(this.zip, part, MAX_IMAGE_BYTES);
          if (buf) {
            fs.mkdirSync(dir, { recursive: true });
            const shrunk = ext !== '.svg' && typeof this.opts.shrinkImage === 'function' ? this.opts.shrinkImage(buf) : null;
            const target = path.join(dir, key + (shrunk ? shrunk.ext : ext));
            fs.writeFileSync(target, shrunk ? shrunk.data : buf);
            out = target;
          }
        }
      }
    } else this.notes.add('vector-image');
    this.imageCache.set(part, out);
    return out;
  }
  push(item) { if (this.items.length < MAX_ITEMS) this.items.push(item); }
  walk(tree, rels, partName, ctx, layer, tf = null) {
    for (const node of tree.children) {
      const n = local(node.name);
      if (n === 'AlternateContent') {
        const pick = kid(node, 'Fallback') || kid(node, 'Choice');
        if (pick) this.walk(pick, rels, partName, ctx, layer, tf);
        continue;
      }
      if (n === 'grpSp') {
        const x = xfrmOf(at(node, 'grpSpPr', 'xfrm'));
        if (!x) { this.walk(node, rels, partName, ctx, layer, tf); continue; }
        const outer = applyGroup(x, tf);
        const sx = x.chExt && x.chExt.w ? outer.w / x.chExt.w : (tf ? tf.sx : 1), sy = x.chExt && x.chExt.h ? outer.h / x.chExt.h : (tf ? tf.sy : 1);
        this.walk(node, rels, partName, ctx, layer, { x: outer.x, y: outer.y, cx: x.chOff ? x.chOff.x : x.x, cy: x.chOff ? x.chOff.y : x.y, sx, sy });
        continue;
      }
      if (n === 'sp' || n === 'cxnSp') this.shape(node, rels, partName, ctx, layer, tf);
      else if (n === 'pic') this.picture(node, rels, ctx, layer, tf);
      else if (n === 'graphicFrame') this.frame(node, rels, ctx, layer, tf);
    }
  }
  inheritedXfrm(node, layer, ctx) {
    const info = phInfo(node);
    if (!info) return { info: null, xfrm: null, chain: [], phNodes: [] };
    const fromLayout = layer === 'slide' ? findPlaceholder(ctx.layout, info) : null;
    const fromMaster = layer !== 'master' ? findPlaceholder(ctx.master, info) : null;
    const phNodes = [fromLayout, fromMaster].filter(Boolean);
    const xfrm = phNodes.map(s => xfrmOf(at(s, 'spPr', 'xfrm'))).find(Boolean) || null;
    const chain = phNodes.map(s => at(s, 'txBody', 'lstStyle')).filter(Boolean);
    const fam = phFamily(info.type);
    const style = fam === 'title' ? ctx.txStyles.title : fam === 'body' ? ctx.txStyles.body : ctx.txStyles.other;
    if (style) chain.push(style);
    return { info, xfrm, chain, phNodes };
  }
  shape(node, rels, partName, ctx, layer, tf) {
    const spPr = kid(node, 'spPr'), style = kid(node, 'style');
    const inh = this.inheritedXfrm(node, layer, ctx);
    // 版式和母版上的占位符只是给幻灯片继承用的「提示框」，自己不画（里面是「单击此处添加标题」）。
    if (inh.info && layer !== 'slide') return;
    const own = xfrmOf(kid(spPr, 'xfrm'));
    const x = own || inh.xfrm;
    if (!x || x.w <= 0 && x.h <= 0) return;
    const box = toPt(applyGroup(x, tf));
    const prst = kid(spPr, 'prstGeom')?.attrs.prst || (local(node.name) === 'cxnSp' ? 'line' : 'rect');
    const inheritedSpPr = inh.phNodes.map(s => kid(s, 'spPr')).find(s => kid(s, 'solidFill') || kid(s, 'gradFill') || kid(s, 'blipFill')) || null;
    const blip = kid(spPr, 'blipFill') && at(kid(spPr, 'blipFill'), 'blip');
    if (blip) { this.blip(blip, kid(spPr, 'blipFill'), rels, box, ctx); }
    const fill = blip ? null : fillOf(spPr && (kid(spPr, 'solidFill') || kid(spPr, 'gradFill') || kid(spPr, 'noFill') || kid(spPr, 'pattFill')) ? spPr : inheritedSpPr, style, ctx);
    const line = lineOf(spPr, style, ctx);
    const isLine = /^(?:line|lineInv|straightConnector\d*|bentConnector\d*|curvedConnector\d*)$/.test(prst) || local(node.name) === 'cxnSp';
    if (isLine) { if (line || style) this.push({ t: 'line', ...box, color: line?.color || '#7F7F7F', lw: line?.width || 0.75, ...(x.flipH ? { flipH: true } : {}), ...(x.flipV ? { flipV: true } : {}) }); return; }
    if (fill || line) {
      // prst / adj / path / grad / flip 是 2026-11-10 为素材预览加的细节；shape 保留给老的粗略画法。
      const cust = kid(spPr, 'custGeom') ? custPathOf(spPr, box) : null, grad = !blip && gradOf(spPr, ctx), adj = adjOf(spPr);
      this.push({ t: 'box', ...box, shape: /ellipse|oval|circle/i.test(prst) ? 'ellipse' : /round/i.test(prst) ? 'round' : /triangle/i.test(prst) ? 'tri' : /rightArrow|chevron|homePlate/i.test(prst) ? 'arrow' : 'rect',
        ...(kid(spPr, 'prstGeom') ? { prst } : {}), ...(adj ? { adj } : {}), ...(cust ? { path: cust } : {}), ...(grad ? { grad } : {}),
        ...(x.flipH ? { flipH: true } : {}), ...(x.flipV ? { flipV: true } : {}), ...(fill ? { fill } : {}), ...(line ? { stroke: line.color, lw: line.width } : {}) });
    }
    const fontRefColor = colorOf(kid(style, 'fontRef'), ctx);
    const fam = inh.info ? phFamily(inh.info.type) : '';
    const defaults = { sz: fam === 'title' ? 32 : 18, color: fontRefColor || ctx.textColor, bullets: fam === 'body' && inh.info?.type !== 'subTitle', anchor: fam === 'title' ? 'ctr' : 't' };
    const text = textOf(kid(node, 'txBody'), ctx, inh.chain.length ? inh.chain : [ctx.txStyles.other].filter(Boolean), defaults);
    if (text) this.push({ t: 'text', ...box, ...text, ...(fam === 'title' ? { role: 'title' } : {}) });
  }
  blip(blip, blipFill, rels, box, ctx) {
    const rel = rels.get(blip.attrs['r:embed'] || blip.attrs['r:link']);
    const src = rel ? this.image(rel.target) : null;
    const crop = kid(blipFill, 'srcRect');
    const c = crop ? ['l', 't', 'r', 'b'].map(k => num(crop.attrs[k]) / 100000) : null;
    if (src) this.push({ t: 'img', ...box, src, ...(c && c.some(Boolean) ? { crop: c } : {}) });
    else this.push({ t: 'ph', ...box, label: '图片' });
  }
  picture(node, rels, ctx, layer, tf) {
    if (phInfo(node) && layer !== 'slide') return;
    const spPr = kid(node, 'spPr');
    const x = xfrmOf(kid(spPr, 'xfrm')) || this.inheritedXfrm(node, layer, ctx).xfrm;
    if (!x) return;
    const blipFill = kid(node, 'blipFill');
    const blip = kid(blipFill, 'blip');
    if (!blip) return;
    this.blip(blip, blipFill, rels, toPt(applyGroup(x, tf)), ctx);
  }
  frame(node, rels, ctx, layer, tf) {
    if (layer !== 'slide' && phInfo(node)) return;
    const x = xfrmOf(kid(node, 'xfrm'));
    if (!x) return;
    const box = toPt(applyGroup(x, tf));
    const data = at(node, 'graphic', 'graphicData');
    const uri = String(data?.attrs.uri || '');
    const tbl = kid(data, 'tbl');
    if (tbl) {
      const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map(c => num(c.attrs.w) / EMU_PER_PT);
      const rows = kids(tbl, 'tr').slice(0, 30).map(tr => ({ h: num(tr.attrs.h) / EMU_PER_PT, cells: kids(tr, 'tc').map(tc => {
        const tcPr = kid(tc, 'tcPr');
        const text = textOf(kid(tc, 'txBody'), ctx, [ctx.txStyles.other].filter(Boolean), { sz: 14, color: ctx.textColor });
        return { span: num(tc.attrs.gridSpan, 1), ...(tc.attrs.hMerge || tc.attrs.vMerge ? { merged: true } : {}), ...(text ? { paras: text.paras } : {}), ...(fillOf(tcPr, null, ctx) ? { fill: fillOf(tcPr, null, ctx) } : {}) };
      }) }));
      this.push({ t: 'table', ...box, cols, rows });
      return;
    }
    const label = /chart/.test(uri) ? '图表' : /diagram/.test(uri) ? 'SmartArt' : /ole/i.test(uri) ? '嵌入对象' : '对象';
    // 嵌入对象（Visio、公式等）常带一张预览图，能画就画。
    const fallback = node.children.length && (function find(n) { for (const c of n.children) { if (local(c.name) === 'blip') return c; const r = find(c); if (r) return r; } return null; })(data || { children: [] });
    if (fallback && /ole/i.test(uri)) { this.blip(fallback, null, rels, box, ctx); return; }
    this.push({ t: 'ph', ...box, label });
  }
}

function backgroundOf(tree, rels, ctx, builder) {
  const bg = at(tree, 'cSld', 'bg');
  if (!bg) return null;
  const bgPr = kid(bg, 'bgPr');
  if (bgPr) {
    const blipFill = kid(bgPr, 'blipFill');
    if (blipFill && kid(blipFill, 'blip')) {
      const rel = rels.get(kid(blipFill, 'blip').attrs['r:embed']);
      const src = rel ? builder.image(rel.target) : null;
      if (src) return { image: src };
    }
    const fill = fillOf(bgPr, null, ctx);
    if (fill) return { color: fill };
  }
  const ref = kid(bg, 'bgRef');
  if (ref) { const c = colorOf(ref, ctx); if (c) return { color: c }; }
  return null;
}

function slidePartFor(zip, page) {
  const pres = xmlPart(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('pptx 里没有 presentation.xml');
  const presRoot = kid(pres, 'presentation');
  const rels = relsOf(zip, 'ppt/presentation.xml');
  const ids = kids(kid(presRoot, 'sldIdLst'), 'sldId');
  const sz = kid(presRoot, 'sldSz');
  const target = ids[page - 1] && rels.get(ids[page - 1].attrs['r:id']);
  if (!target) throw Object.assign(new Error(`第 ${page} 页不在这份文稿里（共 ${ids.length} 页）`), { code: 'PAGE_OUT_OF_RANGE' });
  return { part: target.target, width: num(sz?.attrs.cx, 12192000), height: num(sz?.attrs.cy, 6858000), pages: ids.length };
}

// file + 1 起的页码 → 场景。opts.mediaDir：图片解出来放哪；opts.shrinkImage(buf) → { data, ext } | null：缩小大图。
function buildSlideScene(file, page, opts = {}) {
  if (!/\.pptx$|\.pptm$|\.potx$/i.test(file)) throw Object.assign(new Error('旧版 .ppt 文稿读不了版式，只能显示文字'), { code: 'UNSUPPORTED_FORMAT' });
  const stat = fs.statSync(file);
  const zip = openZip(file);
  const { part, width, height, pages } = slidePartFor(zip, Number(page));
  const slide = xmlPart(zip, part);
  const slideRoot = kid(slide, 'sld');
  if (!slideRoot) throw new Error('这一页的内容读不出来');
  const slideRels = relsOf(zip, part);
  const layoutRel = [...slideRels.values()].find(r => r.type === 'slideLayout');
  const layoutPart = layoutRel?.target || '';
  const layout = layoutPart ? kid(xmlPart(zip, layoutPart), 'sldLayout') : null;
  const layoutRels = layoutPart ? relsOf(zip, layoutPart) : new Map();
  const masterRel = [...layoutRels.values()].find(r => r.type === 'slideMaster');
  const masterPart = masterRel?.target || '';
  const master = masterPart ? kid(xmlPart(zip, masterPart), 'sldMaster') : null;
  const masterRels = masterPart ? relsOf(zip, masterPart) : new Map();
  const themeRel = [...masterRels.values()].find(r => r.type === 'theme');
  const theme = themeRel ? kid(xmlPart(zip, themeRel.target), 'theme') : null;
  const clrMapNode = kid(master, 'clrMap');
  const override = at(slideRoot, 'clrMapOvr', 'overrideClrMapping') || at(layout, 'clrMapOvr', 'overrideClrMapping');
  const clrMap = { ...(clrMapNode?.attrs || {}), ...(override?.attrs || {}) };
  const ctx = { page: Number(page), scheme: readScheme(theme), clrMap, layout, master, fonts: readFonts(theme),
    txStyles: { title: at(master, 'txStyles', 'titleStyle'), body: at(master, 'txStyles', 'bodyStyle'), other: at(master, 'txStyles', 'otherStyle') } };
  ctx.textColor = colorOf({ children: [{ name: 'a:schemeClr', attrs: { val: 'tx1' }, children: [] }] }, ctx) || '#000000';
  const cacheKey = `${path.resolve(file).toLowerCase()}|${stat.mtimeMs}|${stat.size}`;
  const builder = new SceneBuilder(zip, { ...opts, cacheKey });
  const bg = backgroundOf(slideRoot, slideRels, ctx, builder) || backgroundOf(layout || { children: [] }, layoutRels, ctx, builder)
    || backgroundOf(master || { children: [] }, masterRels, ctx, builder) || { color: colorOf({ children: [{ name: 'a:schemeClr', attrs: { val: 'bg1' }, children: [] }] }, ctx) || '#FFFFFF' };
  const showMaster = node => !node || node.attrs.showMasterSp !== '0';
  if (master && showMaster(slideRoot) && showMaster(layout)) builder.walk(at(master, 'cSld', 'spTree') || { children: [] }, masterRels, masterPart, ctx, 'master');
  if (layout && showMaster(slideRoot)) builder.walk(at(layout, 'cSld', 'spTree') || { children: [] }, layoutRels, layoutPart, ctx, 'layout');
  const before = builder.items.length;
  builder.walk(at(slideRoot, 'cSld', 'spTree') || { children: [] }, slideRels, part, ctx, 'slide');
  const r1 = v => Math.round(v / EMU_PER_PT * 10) / 10;
  return { v: 1, w: r1(width), h: r1(height), page: Number(page), pages, bg, items: builder.items, slideItems: builder.items.length - before,
    ...(builder.notes.size ? { notes: [...builder.notes] } : {}) };
}

// 带缓存的入口：内存 LRU + 磁盘 JSON（按 路径|修改时间|大小|页 作键，文稿改了自动失效）。
function createSlidePreviewer({ cacheDir, shrinkImage = null, limit = 200 } = {}) {
  const memory = new Map();
  const inflight = new Map();
  function keyOf(file, page) {
    const st = fs.statSync(file);
    return crypto.createHash('sha1').update(`${path.resolve(file).toLowerCase()}|${st.mtimeMs}|${st.size}|${page}|v2`).digest('hex').slice(0, 24);
  }
  async function scene(file, page) {
    const key = keyOf(file, page);
    if (memory.has(key)) { const v = memory.get(key); memory.delete(key); memory.set(key, v); return v; }
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const diskFile = cacheDir ? path.join(cacheDir, key + '.json') : '';
      let value = null;
      if (diskFile) {
        try {
          value = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
          const media = [value.bg?.image, ...(value.items || []).map(i => i.src)].filter(Boolean);
          if (media.some(f => !fs.existsSync(f))) value = null;
        } catch { value = null; }
      }
      if (!value) {
        await new Promise(resolve => setImmediate(resolve));
        value = buildSlideScene(file, page, { mediaDir: cacheDir ? path.join(cacheDir, 'media') : '', shrinkImage });
        if (diskFile) { try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(diskFile, JSON.stringify(value)); } catch { /* 缓存写不进去也照常显示 */ } }
      }
      memory.set(key, value);
      while (memory.size > limit) memory.delete(memory.keys().next().value);
      return value;
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  }
  return { scene };
}

// Electron 主进程里用 nativeImage 把大图缩到长边 960 像素再存（JPEG），预览不需要原图分辨率。
function electronShrinker() {
  let nativeImage = null;
  try { ({ nativeImage } = require('electron')); } catch { return null; }
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
  return buf => {
    try {
      if (buf.length < 160 * 1024) return null;
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      const long = Math.max(width, height);
      const out = long > 960 ? img.resize(width >= height ? { width: 960, quality: 'good' } : { height: 960, quality: 'good' }) : img;
      // 带透明的 PNG 转 JPEG 会变黑底：这类图片保留 PNG。
      const isPng = buf.readUInt32BE(0) === 0x89504e47;
      return isPng ? { data: out.toPNG(), ext: '.png' } : { data: out.toJPEG(82), ext: '.jpg' };
    } catch { return null; }
  };
}

module.exports = { buildSlideScene, createSlidePreviewer, electronShrinker, openZip, readEntry, parseXml };
