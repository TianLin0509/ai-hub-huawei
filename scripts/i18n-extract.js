'use strict';
// 词条抽取（2026-11-20）：从界面源码里列出要翻译的中文文字，供写英文词典和覆盖率单测使用。
//   node scripts/i18n-extract.js renderer/foo.js renderer/index.html …        → 打印 JSON 数组
//   node scripts/i18n-extract.js --missing renderer/foo.js …                   → 只列英文词典里还没有的
//   node scripts/i18n-extract.js --scope shell --missing                       → 用 core/i18n/scope.json 里的一组文件
// 规则：
// - 注释不算；console/log 行不算；core/i18n/ignore.json 里登记的（给 AI 的提示词、匹配用正则等）不算。
// - 模板串里的 ${…} 变成 {0}{1}…；HTML 片段按标签切开，标签之间的文字、title/placeholder 等属性各算一条。
// - ${…} 里面嵌套的字符串也会递归抽出来。
// - 拼接（'共 ' + n + ' 条'）抽成两条独立文字；运行时整体对不上的，靠英文模式下的漏翻日志补成句式。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CJK = /[㐀-鿿豈-﫿]/;
const ATTR_RE = /\b(?:title|placeholder|aria-label|alt|data-hub-tip|data-tooltip|data-tip)\s*=\s*"([^"]*)"|\b(?:title|placeholder|aria-label|alt|data-hub-tip|data-tooltip|data-tip)\s*=\s*'([^']*)'/g;

function skipLineComment(src, i) { while (i < src.length && src[i] !== '\n') i++; return i; }

// 读一个 JS 源，返回 [{ text, line, kind: 'str'|'tpl' , parts }]；模板串的 parts 交替为文字和 {n}
function tokenize(src, baseLine = 1) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prevSignificant = '';
  const lineAt = idx => baseLine + (src.slice(0, idx).match(/\n/g) || []).length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { i = skipLineComment(src, i); continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    // 正则字面量：前一个有效字符是运算符或括号时，/ 开头的是正则
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|^$|return$|typeof$/.test(prevSignificant)) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++;
      prevSignificant = 'regex';
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { s += unescape(src[j + 1]); j += 2; continue; }
        s += src[j]; j++;
      }
      out.push({ kind: 'str', text: s, line: lineAt(i) });
      i = j + 1; prevSignificant = 'str';
      continue;
    }
    if (c === '`') {
      const parts = [];
      let j = i + 1, buf = '', slot = 0;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { buf += unescape(src[j + 1]); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1, k = j + 2;
          // 找到配对的 }，期间跳过嵌套字符串/模板
          while (k < n && depth > 0) {
            const ch = src[k];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            else if (ch === '"' || ch === "'" || ch === '`') { k = skipString(src, k); continue; }
            if (depth === 0) break;
            k++;
          }
          const expr = src.slice(j + 2, k);
          parts.push(buf); buf = '';
          parts.push({ slot: slot++, expr });
          for (const inner of tokenize(expr, lineAt(j))) out.push(inner);
          j = k + 1;
          continue;
        }
        buf += src[j]; j++;
      }
      parts.push(buf);
      out.push({ kind: 'tpl', parts, line: lineAt(i) });
      i = j + 1; prevSignificant = 'str';
      continue;
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prevSignificant = src.slice(i, j); i = j; continue;
      }
      prevSignificant = c;
    }
    i++;
  }
  return out;
}

function unescape(ch) { return ({ n: '\n', t: '\t', r: '', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$' })[ch] ?? ch; }

function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') { j += 2; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      let depth = 1; j += 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++; else if (src[j] === '}') depth--;
        else if (src[j] === '"' || src[j] === "'" || src[j] === '`') { j = skipString(src, j); continue; }
        j++;
      }
      continue;
    }
    j++;
  }
  return j + 1;
}

// 把一段（可能含 HTML 的）文字切成界面上会独立出现的文字段
function segmentsOf(text) {
  const segs = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text))) segs.push(m[1] !== undefined ? m[1] : m[2]);
  const noTags = text.replace(/<[^<>]*>/g, '\u0000');
  for (const piece of noTags.split('\u0000')) segs.push(piece);
  return segs
    .map(s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"))
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => CJK.test(s));
}

// 模板串 → 带 {n} 的句子：先把 ${…} 换成占位，再切 HTML，最后把每段里的占位重新编号
function templateSegments(parts) {
  const MARK = i => `\u0001${i}\u0002`;
  let joined = '';
  for (const p of parts) joined += typeof p === 'string' ? p : MARK(p.slot);
  const segs = [];
  for (const seg of segmentsOf(joined)) {
    let k = 0;
    const map = new Map();
    const renum = seg.replace(/\u0001(\d+)\u0002/g, (_m, i) => { if (!map.has(i)) map.set(i, k++); return `{${map.get(i)}}`; });
    // 只有占位和标点、没有实质中文的段不算
    if (!CJK.test(renum.replace(/\{\d+\}/g, ''))) continue;
    segs.push(renum);
  }
  return segs;
}

function extractJs(src, file) {
  const lines = src.split('\n');
  const out = [];
  for (const tok of tokenize(src)) {
    const lineText = lines[tok.line - 1] || '';
    if (/console\.(log|warn|error|info|debug)|logger\.|\bdebugLog\(|appendLog\(|i18n-ignore/.test(lineText)) continue;
    const texts = tok.kind === 'tpl' ? templateSegments(tok.parts) : segmentsOf(tok.text);
    for (const text of texts) out.push({ text, file, line: tok.line });
  }
  return out;
}

function extractHtml(src, file) {
  const out = [];
  const blank = s => s.replace(/[^\n]/g, ' ');
  const body = src.replace(/<script[\s\S]*?<\/script>/gi, blank).replace(/<style[\s\S]*?<\/style>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank);
  const lineAt = idx => 1 + (body.slice(0, idx).match(/\n/g) || []).length;
  let m;
  const textRe = />([^<]+)</g;
  while ((m = textRe.exec(body))) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (CJK.test(t)) out.push({ text: segmentsOf(t)[0] || t, file, line: lineAt(m.index) });
  }
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(body))) {
    const t = (m[1] !== undefined ? m[1] : m[2]).trim();
    if (CJK.test(t)) out.push({ text: t, file, line: lineAt(m.index) });
  }
  // 内联脚本
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(src))) {
    const base = 1 + (src.slice(0, m.index).match(/\n/g) || []).length;
    for (const tok of extractJs(m[1], file)) out.push({ ...tok, line: tok.line + base - 1 });
  }
  return out;
}

function extractFile(rel) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  return rel.endsWith('.html') ? extractHtml(src, rel) : extractJs(src, rel);
}

function loadScope() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'core/i18n/scope.json'), 'utf8')); }
function loadIgnore() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'core/i18n/ignore.json'), 'utf8')); } catch { return {}; }
}

// 哪些条目在英文模式下仍翻不出来
function missingEntries(entries) {
  const i18n = require('../core/i18n');
  i18n.loadDictionaries();
  const prev = i18n.getLanguage();
  i18n.setLanguage('en');
  const ignore = loadIgnore();
  const ignored = new Set(Object.keys(ignore.texts || {}));
  const res = entries.filter(e => !ignored.has(e.text) && !isCovered(i18n, e.text));
  i18n.setLanguage(prev);
  return res;
}

function isCovered(i18n, text) {
  // 带 {n} 的句式：把占位填成样例值，看能不能整句翻出来（不能只查键名，否则漏掉句式写错的情况）
  const sample = text.replace(/\{(\d+)\}/g, (_m, i) => `@@${i}@@`);
  const out = i18n.translate(sample);
  return out !== sample && !i18n.hasCjk(out.replace(/@@\d+@@/g, ''));
}

function filesOfScope(scope, groupName) {
  const groups = groupName ? { [groupName]: scope.groups[groupName] } : scope.groups;
  if (groupName && !scope.groups[groupName]) throw new Error('scope.json 里没有分组 ' + groupName);
  return [...new Set(Object.values(groups).flat())];
}

function main(argv) {
  const args = argv.slice(2);
  const onlyMissing = args.includes('--missing');
  const unique = args.includes('--unique');
  let files = args.filter(a => !a.startsWith('--'));
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx >= 0) {
    const group = args[scopeIdx + 1] && !args[scopeIdx + 1].startsWith('--') ? args[scopeIdx + 1] : null;
    files = files.filter(f => f !== group).concat(filesOfScope(loadScope(), group));
  }
  let entries = files.flatMap(extractFile);
  if (onlyMissing) entries = missingEntries(entries);
  if (unique) {
    const seen = new Map();
    for (const e of entries) if (!seen.has(e.text)) seen.set(e.text, e);
    entries = [...seen.values()];
  }
  process.stdout.write(JSON.stringify(entries, null, 1) + '\n');
}

if (require.main === module) main(process.argv);

module.exports = { extractFile, extractJs, extractHtml, missingEntries, isCovered, loadScope, filesOfScope, templateSegments, segmentsOf };
