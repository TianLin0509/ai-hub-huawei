'use strict';

/**
 * 卡片引用（2026-11-20）：卡片上点「引用」，或在卡片里选中一段文字后点浮出的「引用」，
 * 输入框里就多一个引用块。
 *
 * 引用块复用长文本粘贴块（composer-paste-chips.js）：
 *   - 输入框里只显示一个不可编辑的芯片，悬停看原文，退格整块删；
 *   - 发送、草稿、复制都经过 expandPasteMarkers，芯片在原位置展开成下面这段 Markdown 引用：
 *
 *       > 引用自【Claude · 回答 · 11-20 14:32】：
 *       > 原文第一行
 *       > 原文第二行
 *
 * 各家 harness（Claude Code、Codex、CodeAgent、DSH、pi）都没有「回复某条消息」的原生接口，
 * 模型最终只收到文字，所以引用就是一段带来源标注的文字，终端模式和原生模式完全一样。
 * 本文件两个仓库（AI HUB 本地版、AI HUB-H）逐字相同，差异留在各自的 renderer.js 接线里。
 */

const LABEL_SNIPPET_CHARS = 16;
const NBSP_RE = new RegExp(String.fromCharCode(160), 'g');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatQuoteTime(ts) {
  if (ts == null || ts === '') return '';
  const date = new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// 统一换行、去掉不换行空格和首尾空行；段内的缩进与空行保留（代码块、列表要靠它们）。
function normalizeQuoteText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(NBSP_RE, ' ')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
}

function roleLabel(source) {
  if (!source) return '';
  if (source.role === 'user') return '我的提问';
  return source.partial ? '回答片段' : '回答';
}

function roundLabel(source) {
  const n = Number(source && source.round);
  return Number.isFinite(n) && n > 0 ? `第${Math.floor(n)}轮` : '';
}

/** 来源标注：「Claude · 回答片段 · 11-20 14:32」；群聊带轮次：「Codex · 第3轮 · 回答」。缺的部分直接省掉，不写占位词。 */
function quoteSourceLabel(source = {}) {
  const who = String(source.who || '').trim();
  const role = roleLabel(source);
  const time = source.time || formatQuoteTime(source.ts);
  const parts = [];
  if (who && !(source.role === 'user' && /^(我|你|用户|You)$/i.test(who))) parts.push(who);
  if (roundLabel(source)) parts.push(roundLabel(source));
  if (role) parts.push(role);
  if (time) parts.push(time);
  return parts.join(' · ') || '对话';
}

/** 发给模型的正文：Markdown 引用块 + 一个空行，后面接用户自己写的话。 */
function formatQuoteBlock(source, text) {
  const body = normalizeQuoteText(text);
  if (!body) return '';
  const lines = body.split('\n').map(line => (line ? `> ${line}` : '>'));
  return `> 引用自【${quoteSourceLabel(source)}】：\n${lines.join('\n')}\n\n`;
}

function quoteChipLabel(source, text) {
  const body = normalizeQuoteText(text).replace(/\s+/g, ' ');
  const snippet = body.length > LABEL_SNIPPET_CHARS ? body.slice(0, LABEL_SNIPPET_CHARS) + '…' : body;
  const who = String(source?.who || '').trim();
  const time = source?.time || formatQuoteTime(source?.ts);
  const head = ['引用', who && source?.role !== 'user' ? who : (source?.role === 'user' ? '我的提问' : ''), roundLabel(source), time]
    .filter(Boolean).join(' · ');
  return `❝ ${head} ·「${snippet}」`;
}

function quoteChipMeta(source, text) {
  return {
    kind: 'quote',
    label: quoteChipLabel(source, text),
    title: `引用自 ${quoteSourceLabel(source)}`,
    previewText: normalizeQuoteText(text),
  };
}

function selectionInside(inputEl, window) {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1) return false;
    return inputEl.contains(selection.getRangeAt(0).startContainer);
  } catch {
    return false;
  }
}

function caretToEnd(inputEl, { document, window }) {
  try {
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

// 光标之前的原始文字（粘贴块仍是标记）。脱离文档的片段没有排版，innerText 拿不到换行，
// 所以手动把 <br> 和块级元素（Chromium 输入框里回车会生成 <div>）换成换行。
function textBeforeCaret(inputEl, { document, window }) {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1) return '';
    const caret = selection.getRangeAt(0);
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    range.setEnd(caret.startContainer, caret.startOffset);
    let out = '';
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.data; continue; }
        if (child.nodeType !== 1) continue;
        if (child.nodeName === 'BR') { out += '\n'; continue; }
        const isBlock = /^(DIV|P|LI|PRE|BLOCKQUOTE)$/.test(child.nodeName);
        if (isBlock && out && !out.endsWith('\n')) out += '\n';
        walk(child);
      }
    };
    walk(range.cloneContents());
    return out;
  } catch {
    return String(inputEl.textContent || '');
  }
}

/**
 * 把一段引用放进输入框。光标已在输入框里就插在光标处，否则接在末尾另起一行。
 * 返回 { ok, id }；没有可引用的文字时 ok=false，不往输入框塞空块。
 */
function insertQuoteIntoComposer(inputEl, { text, source = {} } = {}, { document, window, pasteChips }) {
  const block = formatQuoteBlock(source, text);
  if (!inputEl || !block) return { ok: false, error: '没有可引用的文字。' };
  // 先看光标原来在不在输入框：focus() 会把光标放到开头，之后再判断就分不清了。
  const caretWasInside = selectionInside(inputEl, window);
  inputEl.focus();
  if (!caretWasInside) caretToEnd(inputEl, { document, window });
  // 引用块必须从行首开始，否则「> 引用自」不再是 Markdown 引用、还会把原句拆开。
  // 按「展开后」的文字判断：前面已是引用块时它自带结尾空行，不再多补一行。
  const before = pasteChips.expandPasteMarkers(textBeforeCaret(inputEl, { document, window }));
  if (/\S/.test(before) && !/\n\s*$/.test(before)) {
    try { document.execCommand('insertLineBreak'); } catch {}
  }
  const id = pasteChips.insertPasteChip(inputEl, block, { document, window, meta: quoteChipMeta(source, text) });
  // 引用块独占一行，接着打的字从下一行开始（展开后的正文本身已以空行结尾，多一个换行无害）。
  try { document.execCommand('insertLineBreak'); } catch {}
  try { inputEl.dispatchEvent(new window.Event('input', { bubbles: true })); } catch {}
  return { ok: true, id };
}

/**
 * 选中卡片里的文字后，在选区右上角浮出「引用」按钮。
 * findCard(node) 返回该节点所在、允许引用的卡片（不允许就返回 null）；
 * readSelection() 可选，返回要引用的文字（HUB-H 用它保留 Markdown 格式），默认取纯文本。
 */
function createSelectionQuoteButton({ document, window, findCard, onQuote, readSelection = null }) {
  let button = null;
  let pending = null;

  function hide() {
    if (button) button.hidden = true;
    pending = null;
  }

  function ensureButton() {
    if (button) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'card-quote-float';
    button.textContent = '❝ 引用';
    button.title = '把选中的这段放进输入框，发送时带上来源';
    button.hidden = true;
    // 按下时别让选区消失，也别抢走输入框里正在进行的输入法组合。
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const current = pending;
      hide();
      if (!current) return;
      try { window.getSelection().removeAllRanges(); } catch {}
      onQuote(current.card, current.text);
    });
    document.body.appendChild(button);
    return button;
  }

  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function evaluate() {
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) { hide(); return; }
    const anchor = nodeElement(selection.anchorNode);
    const focus = nodeElement(selection.focusNode);
    const card = anchor && findCard(anchor);
    if (!card || !focus || findCard(focus) !== card) { hide(); return; }
    let text = '';
    try { text = readSelection ? readSelection(selection, card) : ''; } catch { text = ''; }
    if (!String(text || '').trim()) text = String(selection.toString() || '');
    if (!text.trim()) { hide(); return; }
    let rect = null;
    try { rect = selection.getRangeAt(0).getBoundingClientRect(); } catch {}
    if (!rect || (!rect.width && !rect.height)) { hide(); return; }
    pending = { card, text };
    const el = ensureButton();
    el.hidden = false;
    const width = el.offsetWidth || 64;
    const height = el.offsetHeight || 26;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const above = rect.top - height - 6;
    const top = above >= 8 ? above : Math.min(rect.bottom + 6, window.innerHeight - height - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function init() {
    document.addEventListener('mouseup', event => {
      if (button && event.target && button.contains(event.target)) return;
      // 等浏览器把这次拖选写进 selection 再读。
      window.setTimeout(evaluate, 0);
    });
    document.addEventListener('keyup', event => {
      if (event.shiftKey || event.key === 'Shift') window.setTimeout(evaluate, 0);
    });
    document.addEventListener('mousedown', event => {
      if (button && !button.hidden && !(event.target && button.contains(event.target))) hide();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    document.addEventListener('scroll', () => { if (button && !button.hidden) hide(); }, true);
    return true;
  }

  return { init, hide, evaluate, get pending() { return pending; } };
}

module.exports = {
  createSelectionQuoteButton,
  formatQuoteBlock,
  formatQuoteTime,
  insertQuoteIntoComposer,
  normalizeQuoteText,
  quoteChipLabel,
  quoteChipMeta,
  quoteSourceLabel,
};
