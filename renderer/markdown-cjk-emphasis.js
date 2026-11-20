'use strict';

// 2026-11-20 卡片里「**权限：**实测」这类加粗原样露出星号。根因是 CommonMark 的
// 定界符规则：收尾的 ** 前面是标点（：。）」）、后面紧跟汉字时，不算「右侧定界符」，
// 关不上；中文没有空格，AI 回复里几乎每条「**小标题：**正文」都会踩中。
// 用 marked-cjk-friendly 放宽汉字旁的判定，但只接管 ** 加粗：单个 * 和 _ 留给原规则，
// 否则 *ST 股票名、正则里的 .*、snake_case 会被误判成斜体；~ 删除线同理不启用。
// 真实语料对照（400 份会话、19533 段带星号）：修好 299 段，其余变化只出现在本身就
// 嵌套错乱的加粗里（2 段）。
const markedCjkFriendly = require('./vendor/marked-cjk-friendly.js');

const installed = new WeakSet();

function cjkStrongExtension() {
  const { emStrong } = markedCjkFriendly().tokenizer;
  return {
    tokenizer: {
      emStrong(src, maskedSrc, prevChar) {
        if (!src.startsWith('**') || src[2] === '*') return false;
        return emStrong.call(this, src, maskedSrc, prevChar);
      },
    },
  };
}

function installCjkEmphasis(marked) {
  if (typeof marked?.use !== 'function' || installed.has(marked)) return marked;
  marked.use(cjkStrongExtension());
  installed.add(marked);
  return marked;
}

module.exports = { installCjkEmphasis, cjkStrongExtension };
