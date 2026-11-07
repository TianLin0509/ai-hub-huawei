'use strict';

// 单个 $ 在正文里常常是美元、变量、PowerShell 变量（$5、$HOME/$USER、$env:PATH），
// 不能直接交给公式渲染器。只把形如 $x$ 的行内公式改写成 \(x\)：
// 开头的 $ 后不是空白/数字，结尾的 $ 前不是空白、后面不紧跟字母数字，$$ 块公式不动。
const INLINE_DOLLAR_RE = /(?<![\\$\w])\$(?![\s$\d])((?:[^$\n\\]|\\.)*?[^\s$\\])\$(?![\w$])/g;

function convertInlineDollars(text) {
  const value = String(text == null ? '' : text);
  if (!value.includes('$')) return value;
  return value.replace(INLINE_DOLLAR_RE, (_all, body) => `\\(${body}\\)`);
}

const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEXTAREA', 'PRE', 'CODE', 'OPTION']);

// 在 root 下逐个文本节点改写；跳过代码与已渲染的公式。
function convertInlineDollarsIn(root, doc = root && root.ownerDocument) {
  if (!root || !doc || typeof doc.createTreeWalker !== 'function') return 0;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  let changed = 0;
  for (const node of nodes) {
    if (!node.nodeValue || !node.nodeValue.includes('$')) continue;
    let skip = false;
    for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
      if (p.nodeType === 1 && (SKIP_TAGS.has(p.tagName) || p.classList?.contains('katex') || p.classList?.contains('katex-display'))) { skip = true; break; }
    }
    if (skip) continue;
    const next = convertInlineDollars(node.nodeValue);
    if (next !== node.nodeValue) { node.nodeValue = next; changed++; }
  }
  return changed;
}

module.exports = { convertInlineDollars, convertInlineDollarsIn };
