'use strict';
// 功能/设置搜索（2026-11-20 体验 1、2）：设置弹窗顶部的搜索框和 Ctrl+K 命令面板共用这一份。
// 索引是 core/help-ask/feature-index.json，由 tools/help-manual/build-help-manual.js 从界面代码生成（与说明书同源），
// 每条带「点哪里、高亮哪里」的步骤；这里负责：匹配（中文子串、拼音首字母、多词）、过滤当前版本没有的入口、执行步骤并高亮。
// 依据：群里考勤地址、OD 考勤页都找不到，「这些设置我也不知道在哪」。

let cachedIndex = null;
function loadFeatureIndex() {
  if (cachedIndex) return cachedIndex;
  try { cachedIndex = require('../core/help-ask/feature-index.json').items || []; }
  catch (error) { console.warn('[feature-search] 功能索引读取失败：', error && error.message); cachedIndex = []; }
  return cachedIndex;
}

// 拼音首字母：靠中文排序规则找每个字落在哪个声母区间（Electron/Node 自带完整 ICU），不带拼音库。多音字按常用读音。
const PINYIN_BOUNDS = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀';
const PINYIN_LETTERS = 'abcdefghjklmnopqrstwxyz';
let collator = null;
function initialOf(ch) {
  if (!/[一-龥]/.test(ch)) return /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : '';
  collator = collator || new Intl.Collator('zh-Hans-CN');
  let letter = '';
  for (let i = 0; i < PINYIN_BOUNDS.length; i++) {
    if (collator.compare(ch, PINYIN_BOUNDS[i]) >= 0) letter = PINYIN_LETTERS[i]; else break;
  }
  return letter;
}
const initialsCache = new Map();
function initials(text) {
  const key = String(text || '');
  if (!initialsCache.has(key)) initialsCache.set(key, [...key].map(initialOf).join(''));
  return initialsCache.get(key);
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// 单个词的得分：名字命中最高，其次位置（「考勤 → 设置」）和说明；纯字母的词再试拼音首字母。0 = 没命中。
function tokenScore(token, item) {
  const name = norm(item.name), where = norm(item.where), desc = norm(item.desc);
  if (name === token) return 100;
  if (name.startsWith(token)) return 80;
  // 字母词在名字里也要从词头开始命中（搜「OD」不能命中「CodeAgent」）。
  const ascii = /^[a-z0-9]+$/.test(token);
  if (ascii ? new RegExp(`(^|[^a-z0-9])${token}`).test(name) : name.includes(token)) return 60;
  if (/^[a-z]+$/.test(token) && token.length >= 2) {
    const ini = initials(String(item.name || '').replace(/[A-Za-z0-9]+/g, ''));   // 只取中文字的拼音首字母，英文词本身不参与（否则「OD」会命中 CodeAgent）
    if (ini.startsWith(token)) return 55;
    if (ini.includes(token)) return 45;
  }
  // 字母词在位置和说明里要从词头开始命中：搜「OD」命中「OD 考勤页」，不命中「Codex」。
  const hit = /^[a-z0-9]+$/.test(token)
    ? text => new RegExp(`(^|[^a-z0-9])${token}`).test(text)
    : text => text.includes(token);
  if (hit(where)) return 30;
  if (hit(desc)) return 20;
  return 0;
}

// 多个词（空格隔开）都要命中；分数相加，同分时页面和设置项排在可选功能说明前面（索引里本来的顺序）。
function searchFeatures(query, items = loadFeatureIndex(), { limit = 8 } = {}) {
  const tokens = norm(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const scored = [];
  items.forEach((item, order) => {
    let total = 0;
    for (const t of tokens) { const s = tokenScore(t, item); if (!s) return; total += s; }
    scored.push({ item, score: total, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(x => x.item);
}

// ---------- 界面：判断能不能用、执行步骤、高亮 ----------

function findTarget(document, spec) {
  if (!spec) return null;
  if (typeof spec === 'string') return document.querySelector(spec);
  const want = norm(spec.text);
  return [...document.querySelectorAll(spec.selector)].find(el => norm(el.textContent).includes(want)) || null;
}

function shown(el) {
  return !!el && !el.hidden && el.style.display !== 'none';
}

function optionalOff(window, item) {
  if (!item.optional) return false;
  const entry = window && window.__optionalFeatures && window.__optionalFeatures.get(item.optional);
  return !!(entry && entry.on === false);
}

// 这一条在当前界面里怎么走：'go' 直达；'enable' 是可选功能没开、先去可选功能里打开；null 是这个版本没有这项（不显示）。
// 可选功能没开但左侧按钮还在时，页面本身会盖一层「还没开启 · 开启」，直接去页面就行；页面里的设置项则先去开功能。
function availability(document, window, item) {
  const first = item.steps && item.steps[0];
  const firstShown = !first || !first.click || shown(document.querySelector(first.click));
  if (optionalOff(window, item) && !(item.kind === 'page' && firstShown)) return item.fallback ? 'enable' : null;
  if (!firstShown) return item.fallback ? 'enable' : null;
  return 'go';
}

function availableResults(document, window, results) {
  return results.map(item => ({ item, mode: availability(document, window, item) })).filter(r => r.mode);
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      const el = fn();
      if (el) return resolve(el);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 60);
    };
    tick();
  });
}

const FLASH_CSS = `
.hub-search-flash { outline: 2px solid rgb(var(--rgb-info, 52, 120, 246)); outline-offset: 3px; border-radius: 6px; background-color: rgba(var(--rgb-info, 52, 120, 246), .08); animation: hub-search-flash 0.9s ease-in-out 3; }
:root[data-hw-shell] .hub-search-flash { outline-color: var(--hw-brand, #3478f6); }
@keyframes hub-search-flash { 50% { outline-color: transparent; } }`;

function highlight(document, el) {
  if (!document.getElementById('hub-search-flash-style')) {
    const style = document.createElement('style'); style.id = 'hub-search-flash-style'; style.textContent = FLASH_CSS; document.head.appendChild(style);
  }
  const box = el.closest('.config-field, .config-toggle-row, .config-section-label, .company-api-settings-entry, .att-field, .att-check, .of-item') || el;
  try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { try { box.scrollIntoView(); } catch (__) {} }
  box.classList.remove('hub-search-flash');
  void box.offsetWidth;
  box.classList.add('hub-search-flash');
  setTimeout(() => box.classList.remove('hub-search-flash'), 3200);
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (_) {} }
  return box;
}

async function runSteps(document, steps) {
  for (const step of steps || []) {
    if (step.click) {
      if (step.unless && document.querySelector(step.unless)) continue;
      const el = await waitFor(() => { const e = document.querySelector(step.click); return shown(e) || step.unless ? e : null; });
      if (!el) return { ok: false, missing: step.click };
      el.click();
    } else if (step.highlight) {
      // 等它真正显示出来（配置弹窗读完配置才打开、可选功能弹窗是异步画的），否则滚动和高亮都落空。
      // 设置弹窗分了页签（renderer/config-settings-tabs.js）：目标在别的页签时先切过去。
      const el = await waitFor(() => { const e = findTarget(document, step.highlight); if (e) document.defaultView?.__hubSettingsTabs?.reveal(e); return e && e.getClientRects().length ? e : null; });
      if (!el) return { ok: false, missing: typeof step.highlight === 'string' ? step.highlight : step.highlight.text };
      highlight(document, el);
    }
  }
  return { ok: true };
}

function closeConfigModal(document) {
  const modal = document.getElementById('config-modal');
  if (modal && !modal.classList.contains('hidden')) document.getElementById('config-close')?.click();
}

// 执行一条：不在配置弹窗里的目标先关掉弹窗；可选功能没开时改去「可选功能」停在那一项并说明。
async function runFeature(item, { document, window, showMessage } = {}) {
  const mode = availability(document, window, item);
  const inConfig = (item.steps || []).some(s => s.click === '#options-settings');
  if (!inConfig) closeConfigModal(document);
  if (mode === 'enable') {
    showMessage?.(`「${item.where.split(' → ')[0] === '左侧导航' ? item.name : item.where.split(' → ')[0]}」是可选功能，还没开启：在这里打开后再用`);
    return runSteps(document, item.fallback);
  }
  const result = await runSteps(document, item.steps);
  if (!result.ok) showMessage?.(`没找到「${item.name}」的入口（${item.where}），界面可能刚改过，请一键反馈告诉我们`);
  return result;
}

const SEARCH_CSS = `
.hub-feature-search { position: relative; margin: 0 0 12px; }
.hub-feature-search input { box-sizing: border-box; width: 100%; padding: 8px 12px; font: inherit; font-size: 13px; border-radius: 8px; border: 1px solid var(--border-mid, #d6d9e0); background: var(--surface, #fff); color: var(--fg-strong, #1f2329); outline: none; }
.hub-feature-search input:focus { border-color: rgb(var(--rgb-info, 52, 120, 246)); }
.hub-feature-search-list { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30; max-height: 320px; overflow-y: auto; padding: 4px; border-radius: 8px; background: var(--surface-overlay, #fff); border: 1px solid var(--border-mid, #d6d9e0); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,.12)); }
.hub-feature-search-list[hidden] { display: none; }
.hub-feature-search-item { display: flex; gap: 10px; align-items: baseline; padding: 7px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--fg-strong, #1f2329); }
.hub-feature-search-item.sel { background: rgba(var(--rgb-info, 52, 120, 246), .14); }
.hub-feature-search-item .where { margin-left: auto; font-size: 11.5px; color: var(--fg-muted, #6b7080); white-space: nowrap; }
.hub-feature-search-item .desc { font-size: 11.5px; color: var(--fg-muted, #6b7080); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.hub-feature-search-empty { padding: 10px; font-size: 12.5px; color: var(--fg-muted, #6b7080); }
:root[data-hw-shell] .hub-feature-search input { background: var(--hw-surface); border-color: var(--hw-line); color: var(--hw-text-1); }
:root[data-hw-shell] .hub-feature-search input:focus { border-color: var(--hw-brand); }
:root[data-hw-shell] .hub-feature-search-list { background: var(--hw-surface); border-color: var(--hw-line); }
:root[data-hw-shell] .hub-feature-search-item { color: var(--hw-text-1); }
:root[data-hw-shell] .hub-feature-search-item .where, :root[data-hw-shell] .hub-feature-search-item .desc, :root[data-hw-shell] .hub-feature-search-empty { color: var(--hw-text-2); }`;

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 设置弹窗顶部的搜索框：输入即列出匹配项，↑↓ 选、回车跳过去并高亮；弹窗里的项就地滚到并闪一下。
function mountSettingsSearch({ document, window, showMessage }) {
  const view = document.getElementById('config-main-view');
  // renderer.js 在配置弹窗的 HTML 之前执行：页面还没解析完就等 DOMContentLoaded 再挂。
  if (!view && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountSettingsSearch({ document, window, showMessage }), { once: true });
    return null;
  }
  if (!view || document.getElementById('hub-feature-search-input')) return null;
  if (!document.getElementById('hub-feature-search-style')) {
    const style = document.createElement('style'); style.id = 'hub-feature-search-style'; style.textContent = SEARCH_CSS; document.head.appendChild(style);
  }
  const wrap = document.createElement('div');
  wrap.className = 'hub-feature-search';
  wrap.innerHTML = '<input type="search" id="hub-feature-search-input" placeholder="搜设置和功能：考勤、回车、工作目录、OD…（任意界面 Ctrl+K 也能搜）" spellcheck="false" autocomplete="off" aria-label="搜索设置和功能"><div class="hub-feature-search-list" role="listbox" hidden></div>';
  view.prepend(wrap);
  const input = wrap.querySelector('input'), list = wrap.querySelector('.hub-feature-search-list');
  let results = [], sel = 0;
  const paint = () => list.querySelectorAll('.hub-feature-search-item').forEach((el, i) => { el.classList.toggle('sel', i === sel); if (i === sel) el.scrollIntoView({ block: 'nearest' }); });
  const render = () => {
    const q = input.value.trim();
    if (!q) { list.hidden = true; results = []; return; }
    results = availableResults(document, window, searchFeatures(q, loadFeatureIndex(), { limit: 10 }));
    sel = 0;
    list.innerHTML = results.length
      ? results.map((r, i) => `<div class="hub-feature-search-item${i === 0 ? ' sel' : ''}" role="option" data-idx="${i}"><span>${esc(r.item.name)}</span><span class="desc">${esc(r.mode === 'enable' ? '可选功能，未开启' : r.item.desc)}</span><span class="where">${esc(r.item.where)}</span></div>`).join('')
      : '<div class="hub-feature-search-empty">没找到。换个说法试试，或者点底栏「问问 Hub」直接问。</div>';
    list.hidden = false;
  };
  const go = idx => {
    const r = results[idx];
    if (!r) return;
    list.hidden = true;
    void runFeature(r.item, { document, window, showMessage });
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); list.hidden = true; }
  });
  list.addEventListener('mousedown', e => { const it = e.target.closest('.hub-feature-search-item'); if (it) { e.preventDefault(); go(Number(it.dataset.idx)); } });
  list.addEventListener('mousemove', e => { const it = e.target.closest('.hub-feature-search-item'); if (it && Number(it.dataset.idx) !== sel) { sel = Number(it.dataset.idx); paint(); } });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  return { input, render };
}

module.exports = { loadFeatureIndex, initials, searchFeatures, availability, availableResults, runFeature, mountSettingsSearch };
