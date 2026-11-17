'use strict';
// 复制为 Markdown（2026-11-17 同事反馈：想把回答直接粘进 Obsidian）。
// 把渲染后的回答 DOM 转回 Markdown：标题、列表、表格、代码块、粗斜体、链接都还原成 Markdown 记号；
// KaTeX 公式取它自带的 TeX 原文，行内写成 $…$，独占一行的写成 $$…$$。整张卡片和选中的一部分都能转。
// 默认关闭（复制仍是看到的纯文本，老用户不受影响）：卡片选中文字右键「复制为 Markdown」，
// 或在同一菜单里打开「Ctrl+C 也复制为 Markdown」，之后 Ctrl+C、卡片上的复制按钮都给 Markdown。

const PREF_KEY = 'hub-copy-markdown';
// 和 visible-card-text 一致：这些是界面按钮和提示，不是回答内容。
const UI_CHROME = [
  'button', '.code-copy', '.code-toggle', '.body-fold-toggle', '.mr-gc-code-copy', '.mr-ft-cursor',
  '.mr-truncated-hint', '.conversation-entry-head', '.conversation-long-preview', '[data-copy-exclude]', 'script', 'style',
].join(',');
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'DETAILS', 'SUMMARY', 'FIGURE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'HR', 'DL', 'DT', 'DD']);

function markdownPreferred(storage) {
  try { return (storage || (typeof localStorage !== 'undefined' ? localStorage : null))?.getItem(PREF_KEY) === '1'; } catch { return false; }
}
function setMarkdownPreferred(on, storage) {
  try { (storage || localStorage).setItem(PREF_KEY, on ? '1' : '0'); } catch { /* 存不了就只在本次生效 */ }
}

const texOf = (el) => {
  const ann = el.querySelector?.('annotation[encoding="application/x-tex"]');
  return ann ? String(ann.textContent || '').trim() : '';
};
const isKatexDisplay = (el) => el.classList?.contains('katex-display');
const isKatex = (el) => el.classList?.contains('katex');
const isBlockEl = (el) => el.nodeType === 1 && (BLOCK.has(el.tagName) || isKatexDisplay(el));
const collapse = (s) => String(s).replace(/[ \t\r\n\u00a0]+/g, ' ');
// \u9009\u533a\u843d\u5728\u91cc\u9762\u65f6\u8981\u8865\u56de\u5916\u58f3\u7684\u683c\u5f0f\u5143\u7d20\uff08\u884c\u5185\u683c\u5f0f\u3001\u94fe\u63a5\u3001\u6807\u9898\uff09\u3002
const FORMAT = new Set(['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE', 'A', 'CODE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// 选区祖先里可以穿过的行内包装：本身不产生 Markdown 格式，只是样式或语义标记。
const PASS_INLINE = new Set(['SPAN', 'FONT', 'MARK', 'U', 'SMALL', 'ABBR', 'CITE', 'Q', 'TIME', 'DATA', 'BDI', 'BDO', 'INS']);

// \u4ee3\u7801\u5757\u6b63\u6587\u8981\u9010\u5b57\u4fdd\u7559\uff082026-11-18 \u5ba1\u67e5\u8fd4\u5de5\uff1a\u6574\u7406\u7a7a\u884c\u65f6\u628a\u4e09\u5f15\u53f7\u5b57\u7b26\u4e32\u91cc\u7684\u8fde\u7eed\u7a7a\u884c\u538b\u6389\u4e86\uff09\u3002
// \u8f6c\u6362\u65f6\u5148\u7528\u5360\u4f4d\u7b26\u4ee3\u66ff\u4ee3\u7801\u6b63\u6587\uff0c\u5757\u95f4\u6392\u7248\u6574\u7406\u5b8c\u518d\u6362\u56de\u539f\u6587\uff1b\u4ee3\u7801\u5757\u5728\u5217\u8868\u3001\u5f15\u7528\u91cc\u65f6\u6309\u6240\u5728\u884c\u7684\u524d\u7f00\u7eed\u884c\u3002
let codeStash = null;
const CODE_TOKEN = /\u0000C(\d+)\u0000/;
function stashCode(text) {
  if (!codeStash) return text;
  codeStash.push(text);
  return `\u0000C${codeStash.length - 1}\u0000`;
}
function withCodeStash(fn) {
  const saved = codeStash;
  const stash = [];
  codeStash = stash;
  try {
    const md = tidy(fn());
    return md.split('\n').map((line) => {
      const m = CODE_TOKEN.exec(line);
      if (!m) return line;
      const prefix = line.slice(0, m.index);
      const cont = prefix.replace(/[^>\s]/g, ' ');
      return stash[Number(m[1])].split('\n').map((l, i) => (i === 0 ? prefix + l : (l ? cont + l : cont.replace(/\s+$/, '')))).join('\n');
    }).join('\n');
  } finally { codeStash = saved; }
}

function inline(node) {
  if (node.nodeType === 3) return collapse(node.nodeValue);
  if (node.nodeType !== 1) return node.nodeType === 11 ? children(node, inline) : '';
  const el = node;
  // 独立公式即使夹在段落里也单独成块，Obsidian 才按行间公式渲染。
  if (isKatexDisplay(el)) { const t = texOf(el); return t ? `\n$$\n${t}\n$$\n` : collapse(el.textContent); }
  if (isKatex(el)) { const t = texOf(el); return t ? `$${t}$` : collapse(el.textContent); }
  const tag = el.tagName;
  const inner = () => children(el, inline);
  const wrap = (mark) => { const t = inner(); const m = /^(\s*)(.*?)(\s*)$/s.exec(t); return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : t; };
  switch (tag) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': return wrap('**');
    case 'EM': case 'I': return wrap('*');
    case 'DEL': case 'S': case 'STRIKE': return wrap('~~');
    case 'CODE': { const t = el.textContent || ''; const fence = t.includes('`') ? '``' : '`'; return t ? `${fence}${t}${fence}` : ''; }
    case 'A': {
      const t = inner(), href = el.getAttribute('href') || '';
      if (!/^(?:https?:|mailto:)/i.test(href) || !t.trim() || t.trim() === href) return t || href;
      return `[${t}](${href})`;
    }
    case 'IMG': { const src = el.getAttribute('src') || ''; return /^https?:/i.test(src) ? `![${el.getAttribute('alt') || ''}](${src})` : (el.getAttribute('alt') || ''); }
    default: return isBlockEl(el) ? block(el) : inner();
  }
}
function children(el, fn) { let out = ''; for (const c of el.childNodes) out += fn(c); return out; }

// 块级：返回若干 Markdown 块，块之间空一行。
function blocks(el) {
  const out = [];
  let run = '';
  const flush = () => { const t = run.replace(/[ \t]*\n[ \t]*/g, '\n').trim(); if (t) out.push(t); run = ''; };
  for (const c of el.childNodes) {
    if (c.nodeType === 1 && isBlockEl(c)) { flush(); const b = block(c); if (b.trim()) out.push(b); }
    else run += inline(c);
  }
  flush();
  return out.join('\n\n');
}

function listBlock(el, depth = 0) {
  const ordered = el.tagName === 'OL';
  let n = Number(el.getAttribute?.('start')) || 1;
  const lines = [];
  for (const li of el.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    const parts = [];
    let text = '';
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { if (text.trim()) parts.push(text.trim()); text = ''; parts.push({ nested: listBlock(c, depth + 1) }); }
      else if (c.nodeType === 1 && isBlockEl(c)) { if (text.trim()) parts.push(text.trim()); text = ''; const b = block(c); if (b.trim()) parts.push(b); }
      else text += inline(c);
    }
    if (text.trim()) parts.push(text.trim());
    let first = true;
    for (const p of parts) {
      const body = typeof p === 'string' ? p : p.nested;
      const indented = body.split('\n').map((line, i) => (first && i === 0 ? marker : pad) + line).join('\n');
      lines.push(typeof p === 'string' ? indented : body.split('\n').map((line) => pad + line).join('\n'));
      first = false;
    }
    if (first) lines.push(marker.trimEnd());
  }
  return lines.join('\n');
}

function tableBlock(el) {
  const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    // 表格一格只能一行：格内的代码块直接换回原文再压成一行。
    .map((c) => children(c, inline).replace(new RegExp(CODE_TOKEN.source, 'g'), (_, n) => codeStash?.[Number(n)] ?? '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function block(el) {
  if (isKatexDisplay(el)) { const t = texOf(el); return t ? `$$\n${t}\n$$` : collapse(el.textContent).trim(); }
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${children(el, inline).replace(/\s+/g, ' ').trim()}`;
  switch (tag) {
    case 'UL': case 'OL': return listBlock(el);
    case 'LI': return '- ' + blocks(el).replace(/\n/g, '\n  ');
    case 'PRE': {
      const code = el.querySelector('code');
      const lang = (el.getAttribute('data-lang') || (/(?:^|\s)language-([\w+#.-]+)/.exec(code?.className || '') || [])[1] || '').trim();
      const text = String((code || el).textContent || '').replace(/\n$/, '');
      const fence = /```/.test(text) ? '````' : '```';
      return `${fence}${lang}\n${stashCode(text)}\n${fence}`;
    }
    case 'BLOCKQUOTE': return blocks(el).split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
    case 'TABLE': return tableBlock(el);
    case 'THEAD': case 'TBODY': case 'TFOOT': case 'TR': return children(el, (c) => (c.nodeType === 1 ? inline(c) + ' ' : '')).trim();
    case 'HR': return '---';
    default: return blocks(el);
  }
}

function prepare(clone) {
  clone.querySelectorAll?.(UI_CHROME).forEach((n) => n.remove());
  // 折叠的长消息、活动记录：内容照样要，折叠标题不要（和纯文本复制一致）。
  clone.querySelectorAll?.('.conversation-long-message > summary, .conversation-activity > summary, .teh-raw > summary').forEach((n) => n.remove());
  return clone;
}

// 整张卡片 / 一段渲染好的 DOM → Markdown。
function elementToMarkdown(root) {
  if (!root || typeof root.cloneNode !== 'function') return '';
  const clone = prepare(root.cloneNode(true));
  const holder = (root.ownerDocument || document).createElement('div');
  holder.appendChild(clone);
  return withCodeStash(() => blocks(holder));
}

// 当前选区 → Markdown。选区只框住公式的一部分时，扩到整个公式（不然只拿到半截字形）。
// 选区在输入框、终端里，或根本没选中，返回 ''，调用方照旧用纯文本。
function selectionToMarkdown(win) {
  const sel = win?.getSelection?.();
  if (!sel || sel.rangeCount < 1 || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0).cloneRange();
  const elOf = (n) => (n && n.nodeType === 1 ? n : n?.parentElement) || null;
  const anc = elOf(range.commonAncestorContainer);
  if (!anc || anc.closest?.('input, textarea, .xterm, [contenteditable="true"]')) return '';
  const startMath = elOf(range.startContainer)?.closest?.('.katex-display, .katex');
  const endMath = elOf(range.endContainer)?.closest?.('.katex-display, .katex');
  if (startMath) range.setStartBefore(startMath.closest('.katex-display') || startMath);
  if (endMath) range.setEndAfter(endMath.closest('.katex-display') || endMath);
  const doc = anc.ownerDocument || document;
  const holder = doc.createElement('div');
  holder.appendChild(range.cloneContents());
  // 选区整个落在代码块里：保持代码原样，不加围栏。
  if (anc.closest('pre')) return String(holder.textContent || '');
  // 选区整个落在粗体、链接、标题等元素里面时，cloneContents 不带这个元素本身：
  // 从里到外补回这些格式外壳（只复制外壳，文字仍是选中的那一段），遇到段落等普通块就停。
  // span 这类不带格式含义的行内包装直接穿过去，不然 <strong><span>…</span></strong> 会在 span 处提前停下、丢掉粗体。
  for (let el = elOf(range.commonAncestorContainer); el && el.nodeType === 1 && (FORMAT.has(el.tagName) || PASS_INLINE.has(el.tagName)); el = el.parentElement) {
    if (!FORMAT.has(el.tagName)) continue;
    const shell = el.cloneNode(false);
    while (holder.firstChild) shell.appendChild(holder.firstChild);
    holder.appendChild(shell);
    if (/^H[1-6]$/.test(el.tagName)) break;
  }
  // 选区落在某个列表里：cloneContents 只带回 <li>，补上外层列表才能编号。
  const list = anc.closest('ul, ol');
  let root = holder;
  if (list && holder.querySelector(':scope > li')) {
    root = doc.createElement('div');
    const wrapper = root.appendChild(doc.createElement(list.tagName));
    if (list.tagName === 'OL') { const first = elOf(range.startContainer)?.closest?.('li'); const idx = first ? [...list.children].indexOf(first) : -1; wrapper.setAttribute('start', String((Number(list.getAttribute('start')) || 1) + Math.max(0, idx))); }
    while (holder.firstChild) wrapper.appendChild(holder.firstChild);
  }
  prepare(root);
  return withCodeStash(() => blocks(root));
}

function tidy(md) {
  return String(md || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { PREF_KEY, markdownPreferred, setMarkdownPreferred, elementToMarkdown, selectionToMarkdown };
