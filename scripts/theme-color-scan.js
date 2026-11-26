'use strict';
// 主题硬编码颜色扫描：找出界面代码里没走主题变量、写死的颜色。
//
// 为什么要它：Hub 有 6 套主题（4 浅 2 深），颜色要从 base.css 的主题变量（--surface-* / --fg-* / --hw-* …）取，
// 换主题才会一起换。写死的 #fff、rgb(0,0,0) 在某一套主题下看着对，换到另一套就成了「浅元素配深底」或反过来。
//
// 分类（css-hard / js-inline / svg-fill / fallback-dead 四类计入回归门槛）：
//   css-hard   业务 CSS 里写死的颜色（color / background / border / fill / shadow …），且不在 [data-theme] 专属规则里
//   js-inline  JS 拼出来的内联样式 / .style.xxx = 写死颜色
//   svg-fill   SVG 标记里 fill/stroke 写死（不是 currentColor / none / var()），图标不会随主题染色
//   fallback-dead  var(--x, #fff) 里 --x 全仓没定义：兜底色永远生效，等同写死（计入门槛）
//   fallback   var(--x, #fff) 的兜底值：变量有定义时不生效，只做参考
//   scoped     写在 [data-theme=...] 专属规则里：本来就是为某套主题定制，合规
//   token      自定义属性（--x: #fff）定义：主题变量层本身，合规
//
// 用法：node scripts/theme-color-scan.js [--json 输出路径] [--top N]
//       模块用法：require('./theme-color-scan').scan(repoRoot) → { entries, byFile }
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DEFAULT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['renderer'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'assets', 'themes', 'fonts', 'lib']);
// 第三方或机器输出面（恒深终端、语法高亮主题）不在扫描范围。
const SKIP_FILES = [/\.min\.(css|js)$/, /prism/i, /xterm/i, /katex/i, /mermaid/i, /highlight/i];
// 这些文件本来就是颜色定义源（主题变量层、终端配色），不算业务硬编码。
const TOKEN_FILES = new Set(['renderer/styles/base.css', 'renderer/styles/hw-tokens.css', 'renderer/theme-controller.js', 'core/theme-config.js']);

const COLOR_PROPS = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color|-webkit-text-fill-color|stop-color|flood-color|lighting-color)$/i;
const NAMED = 'white|black|gray|grey|silver|red|green|blue|yellow|orange|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia|gold|beige|ivory|whitesmoke|gainsboro|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey|snow|ghostwhite|aliceblue';
const LITERAL = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(?:rgba?|hsla?)\\(\\s*-?[\\d.]+%?[\\s,]|(?<![-\\w])(?:${NAMED})(?![-\\w])`, 'g');  // 颜色名前后不能是连字符：--hw-green、btn-red 不是颜色

function walkFiles(root, rel, out) {
  const dir = path.join(root, rel);
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    const r = rel + '/' + d.name;
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walkFiles(root, r, out); continue; }
    if (!/\.(css|js|html)$/.test(d.name)) continue;
    if (SKIP_FILES.some(re => re.test(d.name))) continue;
    out.push(r);
  }
  return out;
}

const lineOf = (text, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const blank = s => s.replace(/[^\n]/g, ' ');

// 去掉 var(--x, fallback) 里的兜底部分（保留长度，便于算行号），返回 [去兜底文本, 兜底片段[]]
function splitFallbacks(value) {
  const fallbacks = [];
  let out = '', i = 0;
  while (i < value.length) {
    const k = value.indexOf('var(', i);
    if (k < 0) { out += value.slice(i); break; }
    out += value.slice(i, k);
    let depth = 0, j = k + 3, comma = -1;
    for (; j < value.length; j++) {
      const ch = value[j];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1 && comma < 0) comma = j;
    }
    if (comma > 0) { const fb = new String(value.slice(comma + 1, j)); fb.varName = value.slice(k + 4, comma).trim(); fallbacks.push(fb); out += value.slice(k, comma) + blank(value.slice(comma, j)) + ')'; }
    else out += value.slice(k, j + 1);
    i = j + 1;
  }
  return [out, fallbacks];
}

// 极简 CSS 解析：逐条声明，带上所在规则的选择器链（含 @media 等外层）。
function scanCss(text, file, entries) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const stack = [];
  let buf = '', bufStart = 0;
  const flushDecl = (decl, at) => {
    const m = /^\s*([-\w]+)\s*:([\s\S]*)$/.exec(decl);
    if (!m) return;
    const prop = m[1], value = m[2];
    const selector = stack.join(' ⟩ ');
    const isToken = prop.startsWith('--');
    if (!isToken && !COLOR_PROPS.test(prop)) return;
    const [main, fallbacks] = splitFallbacks(value);
    const scoped = /\[data-theme|\[data-hw-theme|prefers-color-scheme/.test(selector);
    const valueAt = at + decl.indexOf(':') + 1;
    const push = (kind, lit, offset) => entries.push({ file, line: lineOf(text, valueAt + offset), kind, prop, value: lit, selector: selector.slice(0, 160) });
    LITERAL.lastIndex = 0;
    let mm;
    while ((mm = LITERAL.exec(main))) {
      const lit = mm[0].trim();
      if (/^(transparent|currentcolor|inherit)$/i.test(lit)) continue;
      // 媒体 url(...) 里的十六进制片段不算；渐变里的透明黑白遮罩也是颜色，照计。
      if (/url\(/i.test(main.slice(Math.max(0, mm.index - 200), mm.index)) && !/\)/.test(main.slice(main.lastIndexOf('url(', mm.index), mm.index))) continue;
      push(isToken ? (scoped || /^:root|^html/.test(selector) ? 'token' : 'local-token') : scoped ? 'scoped' : 'css-hard', lit, mm.index);
    }
    for (const fb of fallbacks) { LITERAL.lastIndex = 0; let f; const s2 = String(fb); while ((f = LITERAL.exec(s2))) { push('fallback', f[0].trim(), main.length); entries[entries.length - 1].var = fb.varName; } }
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { stack.push(buf.trim().replace(/\s+/g, ' ')); buf = ''; bufStart = i + 1; }
    else if (ch === '}') { if (buf.trim()) flushDecl(buf, bufStart); stack.pop(); buf = ''; bufStart = i + 1; }
    else if (ch === ';' && stack.length) { flushDecl(buf, bufStart); buf = ''; bufStart = i + 1; }
    else { if (!buf) bufStart = i; buf += ch; }
  }
}

// JS / HTML：内联样式字符串、.style.xxx 赋值、SVG fill/stroke 属性、<style> 块。
const STYLE_DECL = new RegExp(`(?:^|[;"'\`{\\s])((?:color|background(?:-color)?|border(?:-[a-z]+)?-?color|border(?:-(?:top|right|bottom|left))?|outline|box-shadow|fill|stroke|caret-color)\\s*:\\s*)([^;"'\`}<]{1,140})`, 'gi');
const STYLE_PROP_ASSIGN = /\.style\.(color|background|backgroundColor|borderColor|border|fill|stroke|boxShadow|outline)\s*=\s*(['"`])([^'"`]{1,80})\2/g;
const SET_PROP = /\.setProperty\(\s*(['"])([-a-z]+)\1\s*,\s*(['"`])([^'"`]{1,120})\3/g;
const SVG_ATTR = /\b(fill|stroke|stop-color)\s*=\s*(\\?["'])(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^)]*\)|white|black)\2/g;
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
function scanScript(text, file, entries) {
  const isHtml = file.endsWith('.html');
  // 把 HTML 里的 <style> 块交给 CSS 扫描，其余部分按脚本规则扫。
  let rest = text;
  if (isHtml) rest = text.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (all, css) => { const tmp = []; scanCss(css, file, tmp); const base = lineOf(text, text.indexOf(all)) - 1; for (const e of tmp) { e.line += base; entries.push(e); } return blank(all); });
  // 先去掉注释（粗略：行注释与块注释），注释里的 CSS 样例不算。
  rest = stripComments(rest);
  // JS 里注入的整段 CSS（模板字符串里有「选择器 { 属性: 值 }」）按 CSS 规则扫描，再从代码里抹掉避免重复计数。
  rest = rest.replace(/`([^`]*)`/g, (all, body, at) => {
    if (!/[^{}]+\{[^{}]*[a-z-]+\s*:[^{}]*\}/i.test(body) || /<[a-z]/i.test(body)) return all;
    const tmp = []; scanCss(body.replace(/\$\{[^}]*\}/g, blank), file, tmp);
    const base = lineOf(rest, at) - 1;
    for (const e of tmp) { e.line += base; entries.push(e); }
    return blank(all);
  });
  const code = rest;
  let m;
  STYLE_DECL.lastIndex = 0;
  while ((m = STYLE_DECL.exec(code))) {
    const [main] = splitFallbacks(m[2]);
    LITERAL.lastIndex = 0; let lit;
    while ((lit = LITERAL.exec(main))) {
      if (/^(transparent|currentcolor)$/i.test(lit[0])) continue;
      // 只认真正的样式上下文：前面 200 字内出现 style / cssText / css` / <svg / setProperty
      const ctx = code.slice(Math.max(0, m.index - 200), m.index + 2);
      if (!/style|cssText|css`|<svg|setProperty|<path|<circle|<rect/i.test(ctx) && !isHtml) continue;
      entries.push({ file, line: lineOf(code, m.index + m[1].length + 1), kind: 'js-inline', prop: m[1].replace(/\s*:\s*$/, '').trim(), value: lit[0].trim(), selector: '' });
    }
    const [, fb] = splitFallbacks(m[2]);
    for (const f of fb) { LITERAL.lastIndex = 0; let x; const s2 = String(f); while ((x = LITERAL.exec(s2))) entries.push({ file, line: lineOf(code, m.index), kind: 'fallback', var: f.varName, prop: m[1].trim(), value: x[0].trim(), selector: '' }); }
  }
  STYLE_PROP_ASSIGN.lastIndex = 0;
  while ((m = STYLE_PROP_ASSIGN.exec(code))) {
    const [main] = splitFallbacks(m[3]);
    LITERAL.lastIndex = 0; const lit = LITERAL.exec(main);
    if (lit && !/^(transparent|currentcolor)$/i.test(lit[0])) entries.push({ file, line: lineOf(code, m.index), kind: 'js-inline', prop: m[1], value: lit[0].trim(), selector: '' });
    for (const f of splitFallbacks(m[3])[1]) { LITERAL.lastIndex = 0; let x; while ((x = LITERAL.exec(String(f)))) entries.push({ file, line: lineOf(code, m.index), kind: 'fallback', var: f.varName, prop: m[1], value: x[0].trim(), selector: '' }); }
  }
  // el.style.setProperty('color', '#fff')
  SET_PROP.lastIndex = 0;
  while ((m = SET_PROP.exec(code))) {
    if (!COLOR_PROPS.test(m[2])) continue;
    const [main, fbs] = splitFallbacks(m[4]);
    LITERAL.lastIndex = 0; const lit = LITERAL.exec(main);
    if (lit && !/^(transparent|currentcolor)$/i.test(lit[0])) entries.push({ file, line: lineOf(code, m.index), kind: 'js-inline', prop: m[2], value: lit[0].trim(), selector: '' });
    for (const f of fbs) { LITERAL.lastIndex = 0; let x; while ((x = LITERAL.exec(String(f)))) entries.push({ file, line: lineOf(code, m.index), kind: 'fallback', var: f.varName, prop: m[2], value: x[0].trim(), selector: '' }); }
  }
  SVG_ATTR.lastIndex = 0;
  while ((m = SVG_ATTR.exec(code))) entries.push({ file, line: lineOf(code, m.index), kind: 'svg-fill', prop: m[1], value: m[3], selector: '' });
}

function scan(root = ROOT_DEFAULT) {
  const files = [];
  for (const d of SCAN_DIRS) walkFiles(root, d, files);
  const entries = [];
  for (const rel of files.sort()) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const tmp = [];
    if (rel.endsWith('.css')) scanCss(text, rel, tmp); else scanScript(text, rel, tmp);
    if (TOKEN_FILES.has(rel)) for (const e of tmp) if (e.kind === 'css-hard' || e.kind === 'local-token') e.kind = 'token';
    // 行内写 theme-ok（注释里写原因）表示有意恒定的颜色，比如品牌色块上的白字、恒深终端里的文字。
    const lines = text.split(/\r?\n/);
    for (const e of tmp) if (/theme-ok/.test(lines[e.line - 1] || '')) e.kind = 'exempt';
    entries.push(...tmp);
  }
  // 兜底值所属的变量在全仓都没定义 → 兜底色在所有主题下都生效，等同写死（fallback-dead，计入门槛）。
  const defined = new Set();
  for (const rel of files) for (const m of stripComments(fs.readFileSync(path.join(root, rel), 'utf8')).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  for (const e of entries) if (e.kind === 'fallback' && e.var && !defined.has(e.var)) e.kind = 'fallback-dead';
  const GATED = new Set(['css-hard', 'js-inline', 'svg-fill', 'fallback-dead']);
  const byFile = {};
  for (const e of entries) {
    if (!GATED.has(e.kind)) continue;
    byFile[e.file] = (byFile[e.file] || 0) + 1;
  }
  const byKind = entries.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {});
  return { files: files.length, entries, byFile, byKind, gated: Object.values(byFile).reduce((a, b) => a + b, 0) };
}

const BASELINE = path.join(ROOT_DEFAULT, 'tests', 'theme-hardcoded-color-baseline.json');
function writeBaseline(root = ROOT_DEFAULT, file = BASELINE) {
  const r = scan(root);
  const sorted = Object.fromEntries(Object.entries(r.byFile).sort((a, b) => a[0].localeCompare(b[0])));
  fs.writeFileSync(file, JSON.stringify({ note: '每个界面文件允许的硬编码颜色上限（只许减不许增）。修掉颜色后运行 node scripts/theme-color-scan.js --write-baseline 收紧。', total: r.gated, files: sorted }, null, 1) + String.fromCharCode(10));
  return r;
}

module.exports = { scan, scanCss, scanScript, writeBaseline, BASELINE, GATED_KINDS: ['css-hard', 'js-inline', 'svg-fill', 'fallback-dead'] };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { json: null, top: 25 };
  if (args.includes('--write-baseline')) { const r = writeBaseline(); console.log(`已写基线：${r.gated} 处 → ${BASELINE}`); process.exit(0); }
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
  const r = scan();
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(r, null, 1));
  console.log(`扫描 ${r.files} 个界面文件；分类计数 ${JSON.stringify(r.byKind)}；计入门槛 ${r.gated} 处`);
  const top = Object.entries(r.byFile).sort((a, b) => b[1] - a[1]).slice(0, Number(opt.top));
  for (const [f, n] of top) console.log(String(n).padStart(5), f);
}
