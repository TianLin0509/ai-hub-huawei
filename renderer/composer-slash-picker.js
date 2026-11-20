'use strict';
// 输入框「/」命令与技能选择框（2026-11-20，同事需求，一次做五家）：
//   Claude Code、Codex、DSH、pi 会话在输入框开头输入 / 时弹出；CodeAgent 继续用 composer-codeagent-skills.js 那一套。
//   选中只插入、不发送。中文输入法组字期间不弹、不拦键；中文标点模式下按 / 打出的「、」，
//   只在整个输入框就是这一个字时唤起，Esc 关闭后原样保留。清单由主进程按会话读（core/composer-slash-catalog.js）。
const { slashFamily } = require('../core/composer-slash-family');

const RENDER_LIMIT = 200;
const RECENT_LIMIT = 5;
const RECENT_KEY = 'hub.slash-recent.v1:';
const GROUPS = [['command', '命令'], ['skill', '技能'], ['other', '其他']];
const ICONS = {
  command: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10.5 2.5l-5 11"/></svg>',
  skill: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z"/></svg>',
  other: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M6 8h4M6 10.5h3"/></svg>',
};

// 只认输入框开头的第一个词；光标离开它（或打了空格）就不算。
function slashQuery(text, caret, { composing = false } = {}) {
  if (composing || !Number.isInteger(caret) || caret < 1) return null;
  if (text === '、') return { query: '', trigger: '、' };
  if (!text.startsWith('/')) return null;
  const end = text.search(/\s/);
  if (caret > (end < 0 ? text.length : end)) return null;
  return { query: text.slice(1, end < 0 ? undefined : end).toLowerCase(), trigger: '/' };
}
const body = item => item.insert.slice(1).toLowerCase();
function score(item, query) {
  if (!query) return 0;
  const names = [body(item), item.name.toLowerCase()];
  if (names.some(n => n.startsWith(query))) return 0;
  if (names.some(n => n.includes(query))) return 1;
  return String(item.description || '').toLowerCase().includes(query) ? 2 : -1;
}
// 分组排序：命令 → 技能 → 其他；有过滤词时开头命中排前；没有过滤词时技能里最近用过的置顶。
function rankItems(items, query, recent = []) {
  const order = new Map(recent.map((insert, i) => [insert, i]));
  const out = [];
  for (const [group] of GROUPS) {
    const rows = items.map((item, i) => ({ item, i, s: score(item, query) })).filter(row => row.item.group === group && row.s >= 0);
    rows.sort((a, b) => a.s - b.s
      || (!query && group === 'skill' ? (order.has(a.item.insert) ? order.get(a.item.insert) : 99) - (order.has(b.item.insert) ? order.get(b.item.insert) : 99) : 0)
      || a.i - b.i);
    out.push(...rows.map(row => row.item));
  }
  return out;
}
function insertInto(text, trigger, insert) {
  if (trigger === '、') return insert + ' ';
  return text.replace(/^\/\S*\s?/, insert + ' ');
}
function readRecent(storage, fam) {
  try { const rows = JSON.parse(storage?.getItem(RECENT_KEY + fam) || '[]'); return Array.isArray(rows) ? rows.filter(v => typeof v === 'string').slice(0, RECENT_LIMIT) : []; }
  catch { return []; }
}
function recordRecent(storage, fam, insert) {
  try { storage?.setItem(RECENT_KEY + fam, JSON.stringify([insert, ...readRecent(storage, fam).filter(v => v !== insert)].slice(0, RECENT_LIMIT))); }
  catch { /* 最近使用只影响排序 */ }
}

const CSS = `
.hub-slash-pop, .hub-slash-pop * { -webkit-app-region:no-drag; box-sizing:border-box; }
.hub-slash-pop { position:fixed; z-index:10020; display:flex; flex-direction:column; overflow:hidden; background:var(--surface-raised,#fff); color:var(--fg-default,#303b4b);
  border:1px solid var(--border-mid,#d8dfe8); border-radius:12px; box-shadow:0 14px 36px rgba(24,39,75,.13),0 2px 6px rgba(24,39,75,.06); font-size:13px; animation:hub-slash-in .12s ease-out; }
:root[data-theme='dark'] .hub-slash-pop { box-shadow:0 16px 40px rgba(0,0,0,.5); }
.hub-slash-pop[hidden] { display:none; }
@keyframes hub-slash-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
.hub-slash-head { display:flex; align-items:center; gap:8px; padding:9px 14px 7px; font-size:12px; color:var(--fg-muted,#637084); border-bottom:1px solid var(--border-subtle,#e5e9ee); }
.hub-slash-title { font-weight:600; color:var(--fg-default,#303b4b); }
.hub-slash-kind { padding:1px 7px; border-radius:5px; background:var(--surface-sunken,#f1f4f7); font-size:11.5px; }
.hub-slash-count { margin-left:auto; font-variant-numeric:tabular-nums; }
.hub-slash-list { max-height:296px; overflow-y:auto; padding:4px 6px 6px; scrollbar-width:thin; }
.hub-slash-group { position:sticky; top:-4px; z-index:1; display:flex; gap:6px; padding:8px 8px 4px; background:var(--surface-raised,#fff); color:var(--fg-faint,#778395); font-size:11.5px; }
.hub-slash-group b { font-weight:400; color:var(--fg-muted,#637084); }
.hub-slash-row { position:relative; display:grid; grid-template-columns:20px minmax(110px,max-content) minmax(0,1fr) auto; align-items:center; gap:10px; height:34px; padding:0 10px 0 8px; border-radius:7px; cursor:pointer; }
.hub-slash-row:hover { background:var(--surface-hover,#edf1f6); }
.hub-slash-row[aria-selected=true] { background:var(--brand-tint,#e7eefb); }
.hub-slash-row[aria-selected=true]::before { content:""; position:absolute; left:0; top:8px; bottom:8px; width:2px; border-radius:2px; background:var(--brand,#3065bd); }
.hub-slash-ic { width:20px; height:20px; display:grid; place-items:center; border-radius:5px; color:var(--fg-muted,#637084); background:var(--surface-sunken,#f1f4f7); }
.hub-slash-row[aria-selected=true] .hub-slash-ic { color:var(--brand-text,#3065bd); }
.hub-slash-name { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono,"Cascadia Mono",Consolas,monospace); font-size:13px; color:var(--fg-strong,#222a36); }
.hub-slash-name mark { background:none; color:var(--brand-text,#3065bd); font-weight:700; }
.hub-slash-name i { margin-left:6px; font-style:normal; font-size:12px; color:var(--fg-faint,#778395); }
.hub-slash-desc { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; color:var(--fg-muted,#637084); }
.hub-slash-tags { display:flex; gap:4px; }
.hub-slash-tag { padding:0 6px; line-height:18px; white-space:nowrap; border:1px solid var(--border-subtle,#e5e9ee); border-radius:5px; font-size:11px; color:var(--fg-muted,#637084); }
.hub-slash-tag.term { color:var(--brand-text,#3065bd); border-color:var(--brand-tint-border,#cbd9ef); }
.hub-slash-empty { padding:22px 14px; text-align:center; font-size:13px; color:var(--fg-muted,#637084); }
.hub-slash-foot { display:flex; justify-content:space-between; gap:10px; padding:7px 14px; border-top:1px solid var(--border-subtle,#e5e9ee); font-size:11.5px; color:var(--fg-faint,#778395); }
.hub-slash-foot kbd { margin-right:2px; padding:0 4px; font-family:inherit; font-size:11.5px; color:var(--fg-muted,#637084); background:var(--surface-canvas,#fbfcfd); border:1px solid var(--border-mid,#d8dfe8); border-bottom-width:2px; border-radius:4px; }
`;

function mountSlashPicker({ document, window, input, anchor, sessionId, getSession, ipcRenderer, readText, replaceText, saveDraft = () => {}, storage }) {
  if (!slashFamily(getSession())) return null;
  if (!document.getElementById('hub-slash-style')) {
    const style = document.createElement('style'); style.id = 'hub-slash-style'; style.textContent = CSS; document.head.appendChild(style);
  }
  const pop = document.createElement('div'); pop.className = 'hub-slash-pop'; pop.hidden = true;
  pop.innerHTML = '<div class="hub-slash-head"><span class="hub-slash-title">命令与技能</span><span class="hub-slash-kind"></span><span class="hub-slash-count"></span></div>'
    + '<div class="hub-slash-list" role="listbox" aria-label="命令与技能"></div>'
    + '<div class="hub-slash-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择　<kbd>Enter</kbd>/<kbd>Tab</kbd> 插入　<kbd>Esc</kbd> 关闭</span><span class="hub-slash-src"></span></div>';
  document.body.appendChild(pop);
  const list = pop.querySelector('.hub-slash-list');
  let catalog = null, loading = false, error = '', opened = false, composing = false, query = '', trigger = '/', index = 0, choices = [], request = 0, disposed = false;
  const fam = () => slashFamily(getSession());
  const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

  function caretOffset() {
    try {
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.rangeCount) return null;
      const caret = selection.getRangeAt(0);
      if (!input.contains(caret.startContainer)) return null;
      const range = document.createRange(); range.selectNodeContents(input); range.setEnd(caret.startContainer, caret.startOffset);
      return range.toString().length;
    } catch { return null; }
  }
  function position() {
    const rect = (anchor || input).getBoundingClientRect();
    const width = Math.min(600, Math.max(320, rect.width), window.innerWidth - 16);
    pop.style.width = width + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
    pop.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
  }
  function paint() {
    if (!opened) return;
    const items = catalog?.items || [];
    const ranked = rankItems(items, query, readRecent(storage, fam()));
    choices = ranked.slice(0, RENDER_LIMIT);
    index = Math.max(0, Math.min(index, choices.length - 1));
    pop.querySelector('.hub-slash-kind').textContent = catalog?.label || '';
    pop.querySelector('.hub-slash-count').textContent = catalog ? (query ? `匹配 ${ranked.length} 项` : `${ranked.length} 项`) : '';
    pop.querySelector('.hub-slash-src').textContent = catalog?.sourceNote || '';
    let html = '', group = null;
    choices.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        html += '<div class="hub-slash-group">' + GROUPS.find(g => g[0] === group)[1] + '<b>' + choices.filter(row => row.group === group).length + '</b></div>';
      }
      const shown = item.insert, at = query ? shown.toLowerCase().indexOf(query, 1) : -1;
      const name = at >= 0 ? esc(shown.slice(0, at)) + '<mark>' + esc(shown.slice(at, at + query.length)) + '</mark>' + esc(shown.slice(at + query.length)) : esc(shown);
      html += '<div class="hub-slash-row" role="option" data-i="' + i + '" data-group="' + item.group + '" data-insert="' + esc(item.insert) + '" aria-selected="' + (i === index) + '" title="' + esc(item.description) + '">'
        + '<span class="hub-slash-ic">' + ICONS[item.group] + '</span>'
        + '<span class="hub-slash-name">' + name + (item.argumentHint ? '<i>' + esc(item.argumentHint) + '</i>' : '') + '</span>'
        + '<span class="hub-slash-desc">' + esc(item.description) + '</span>'
        + '<span class="hub-slash-tags">' + (item.terminal ? '<span class="hub-slash-tag term" title="会在终端里打开菜单或面板">终端</span>' : '')
        + (item.source && item.source !== '内置' ? '<span class="hub-slash-tag">' + esc(item.source) + '</span>' : '') + '</span></div>';
    });
    if (!choices.length) html = '<div class="hub-slash-empty">' + (loading && !catalog ? '正在读取命令与技能…'
      : error ? esc(error) : query ? `没有匹配「${esc(query)}」的命令或技能 · 按 Enter 原样发送` : '没有可列出的命令或技能') + '</div>';
    list.innerHTML = html;
    list.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
    position();
  }
  async function refresh() {
    const generation = ++request; loading = true;
    try {
      const result = await ipcRenderer.invoke('composer:slash-catalog', { sessionId });
      if (disposed || generation !== request) return;
      if (result?.ok) { catalog = result; error = ''; }
      else if (!catalog) error = result?.error || (result?.reason === 'no-session' ? '会话未在运行，重连后可查看命令和技能' : '这个会话暂不支持命令列表');
    } catch (reason) { if (!catalog) error = `读取命令与技能失败：${reason.message}`; }
    loading = false; paint();
  }
  function open(next) {
    opened = true; query = next.query; trigger = next.trigger; index = 0; pop.hidden = false;
    paint(); void refresh();
  }
  function close() { if (!opened) return; opened = false; pop.hidden = true; request += 1; loading = false; }
  function choose(item) {
    if (!item) return;
    const next = insertInto(readText(), trigger, item.insert);
    close();
    replaceText(next);
    recordRecent(storage, fam(), item.insert);
    saveDraft();
    input.focus();
  }
  function onInput() {
    if (disposed) return;
    const next = slashQuery(readText(), caretOffset(), { composing });
    if (!next) { close(); return; }
    if (!opened) open(next);
    else { query = next.query; trigger = next.trigger; index = 0; paint(); }
  }
  // 返回 true 表示按键已被选择框处理，调用方不要再当发送或换行。
  function onKeyDown(event) {
    if (!opened || composing || event.isComposing || event.keyCode === 229) return false;
    // 光标可能已被 Home、鼠标点击挪出命令词：先按当前光标重验，不在命令词里就关掉、按键照常处理。
    if (!slashQuery(readText(), caretOffset(), { composing })) { close(); return false; }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'Escape') close();
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && plain && !event.shiftKey) {
      if (!choices.length) return false;
      index = (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
      for (const row of list.querySelectorAll('.hub-slash-row')) row.setAttribute('aria-selected', String(Number(row.dataset.i) === index));
      list.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
    } else if ((event.key === 'Enter' && plain && !event.shiftKey) || (event.key === 'Tab' && plain && !event.shiftKey)) {
      // 清单还没读回来时先吞掉这次按键（等几十毫秒），免得把半截命令发出去；读完仍没有匹配，Enter 原样发送。
      if (!choices.length && loading && !catalog) { /* wait for the list */ }
      else if (!choices.length) { close(); if (event.key === 'Enter') return false; }
      else choose(choices[index]);
    } else return false;
    event.preventDefault();
    return true;
  }
  const onCompositionStart = () => { composing = true; close(); };
  const onCompositionEnd = () => { composing = false; setTimeout(onInput, 0); };
  const outside = event => { if (opened && !pop.contains(event.target) && !input.contains(event.target)) close(); };
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('input', onInput);
  // 光标移动（方向键、Home/End、鼠标点击）也要重验是否还在命令词里。
  const onCaretMove = event => { if (opened && (event.type === 'mouseup' || ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) onInput(); };
  input.addEventListener('keyup', onCaretMove);
  input.addEventListener('mouseup', onCaretMove);
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => { const row = event.target.closest('.hub-slash-row'); if (row) choose(choices[Number(row.dataset.i)]); });
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('resize', position);
  return {
    onKeyDown, close, refresh, isOpen: () => opened, element: pop,
    dispose() {
      disposed = true; close();
      input.removeEventListener('compositionstart', onCompositionStart); input.removeEventListener('compositionend', onCompositionEnd);
      input.removeEventListener('input', onInput); input.removeEventListener('keyup', onCaretMove); input.removeEventListener('mouseup', onCaretMove); document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', position);
      pop.remove();
    },
  };
}

module.exports = { mountSlashPicker, slashQuery, rankItems, insertInto, score, readRecent, recordRecent, RENDER_LIMIT };
