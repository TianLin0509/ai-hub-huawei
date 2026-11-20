'use strict';
// 界面语言（2026-11-20 拍板：所有用户默认中文，只有在设置里手动选 English 才切到英文；不读系统语言）。
//
// 词典按「中文原文 → 英文」组织（gettext 式：原文即键），放在 core/i18n/locales/en/*.json：
//   "启动中心": "Launch Center"
//   "已恢复 {0}/{1} 个会话": "Restored {0}/{1} sessions"   ← 带 {n} 的是句式，运行时按正则匹配，
//                                                              占位处若本身是词典里的原文也会一并翻译
// 中文模式下 translate / t 原样返回，界面与改造前逐字相同。
// 同一份模块在主进程和界面进程都能 require（界面开着 nodeIntegration）。

const fs = require('fs');
const path = require('path');

const DEFAULT_LANGUAGE = 'zh-CN';
const SUPPORTED = ['zh-CN', 'en'];
const CJK = /[㐀-鿿豈-﫿]/;
const PLACEHOLDER = /\{(\d+)\}/g;
const LOCALE_DIR = path.join(__dirname, 'locales');

let language = DEFAULT_LANGUAGE;
let exact = null;      // Map 原文 → 英文
let patterns = null;   // 句式列表，按字面长度从长到短
let missHook = null;
const listeners = new Set();

function normalizeLanguage(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'en' || v.startsWith('en-') ? 'en' : DEFAULT_LANGUAGE;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compilePattern(source, target) {
  const pieces = source.split(/\{(\d+)\}/);
  let re = '^';
  const order = [];
  let anchor = '';
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 0) {
      re += escapeRegExp(pieces[i]);
      if (pieces[i].length > anchor.length) anchor = pieces[i];
    } else {
      order.push(Number(pieces[i]));
      re += '([\\s\\S]+?)';
    }
  }
  re += '$';
  return { source, target, re: new RegExp(re), order, anchor, weight: source.replace(PLACEHOLDER, '').length };
}

function loadDictionaries(dir = path.join(LOCALE_DIR, 'en')) {
  const nextExact = new Map();
  const nextPatterns = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { files = []; }
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (error) {
      console.warn('[i18n] 词典读取失败', file, error && error.message);
      continue;
    }
    for (const [src, dst] of Object.entries(data || {})) {
      if (typeof dst !== 'string' || !dst || src.startsWith('//')) continue;
      if (/\{\d+\}/.test(src)) nextPatterns.push(compilePattern(src, dst));
      else nextExact.set(src, dst);
    }
  }
  nextPatterns.sort((a, b) => b.weight - a.weight);
  exact = nextExact;
  patterns = nextPatterns;
  return { exact: exact.size, patterns: patterns.length, files: files.length };
}

function ensureLoaded() { if (!exact) loadDictionaries(); }

function fill(template, values) {
  return template.replace(PLACEHOLDER, (m, i) => (values[Number(i)] !== undefined ? values[Number(i)] : m));
}

function lookupCore(core, depth) {
  const hit = exact.get(core);
  if (hit !== undefined) return hit;
  const multiline = core.includes('\n');
  for (const p of patterns) {
    if (p.anchor && !core.includes(p.anchor)) continue;
    // 多行文字只套本身写了换行的句式，否则「{0}：{1}」这类单行句式会把整段跨行吞掉；其余交给 translate 逐行翻
    if (multiline && !p.source.includes('\n')) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    const values = [];
    p.order.forEach((slot, k) => {
      const part = m[k + 1];
      const nested = depth < 2 && CJK.test(part) ? translateWith(part, depth + 1) : undefined;
      values[slot] = nested === undefined ? part : nested;
    });
    return fill(p.target, values);
  }
  return undefined;
}

function translateWith(text, depth) {
  const lead = text.match(/^\s*/)[0];
  const trail = text.slice(lead.length).match(/\s*$/)[0];
  const core = text.slice(lead.length, text.length - trail.length);
  const out = lookupCore(core, depth);
  return out === undefined ? undefined : lead + out + trail;
}

// 把一段界面文字翻成当前语言；中文模式或查不到时原样返回。
function translate(text) {
  if (language !== 'en' || typeof text !== 'string' || !CJK.test(text)) return text;
  ensureLoaded();
  const out = translateWith(text, 0);
  if (out !== undefined) return out;
  // 多行提示（title 用 \n 拼多段）整段查不到时逐行翻：每行各自是词条或句式，行数随状态变化，没法整段写句式
  if (text.includes('\n')) {
    let changed = false;
    const lines = text.split('\n').map(line => {
      if (!CJK.test(line)) return line;
      const hit = translateWith(line, 0);
      if (hit === undefined) { if (missHook) missHook(line); return line; }
      changed = true;
      return hit;
    });
    return changed ? lines.join('\n') : text; // 没翻到的行已逐行报给漏翻回调
  }
  if (missHook) missHook(text);
  return text;
}

// 代码里显式取词：t('已恢复 {0}/{1} 个会话', a, b)。中文模式只做占位替换。
function t(source, ...args) {
  let template = source;
  if (language === 'en') {
    ensureLoaded();
    const hit = exact.get(source);
    if (hit !== undefined) template = hit;
    else {
      const p = patterns.find(x => x.source === source);
      if (p) template = p.target;
      else if (missHook && CJK.test(source)) missHook(source);
    }
  }
  return args.length ? fill(template, args.map(a => (typeof a === 'string' ? translate(a) : a))) : template;
}

function getLanguage() { return language; }
function isEnglish() { return language === 'en'; }
function setLanguage(value) {
  const next = normalizeLanguage(value);
  if (next === language) return language;
  language = next;
  if (language === 'en') ensureLoaded();
  for (const fn of listeners) { try { fn(language); } catch (error) { console.warn('[i18n] 监听出错', error && error.message); } }
  return language;
}
function onLanguageChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setMissHook(fn) { missHook = typeof fn === 'function' ? fn : null; }
function hasCjk(text) { return CJK.test(String(text || '')); }

module.exports = {
  DEFAULT_LANGUAGE, SUPPORTED,
  normalizeLanguage, loadDictionaries, translate, t,
  getLanguage, isEnglish, setLanguage, onLanguageChange, setMissHook, hasCjk,
  _compilePattern: compilePattern,
};
