'use strict';
// 会议页「被整块顶走、翻不回去」的兜底（2026-11-24 用户截图：整页被往上顶约 200px）。
// 根因是代码滚动（scrollIntoView、focus）把本该不滚的外层容器滚走了；CSS 已改成 overflow:clip，
// 这里每次渲染再查一遍：会议页内几个外层容器 + 会议页根到 body 之间的祖先，scrollTop/scrollLeft 不为 0 就复位。

// 会议页里本身不该滚动的外层容器（时间流、纪要、聊天列表这些自己滚的不在其中）。
const FIXED_SELECTORS = ['.meeting-columns', '.meeting-evidence-pane', '.meeting-understanding', '.meeting-aside-panel'];

function stuckScrollTargets(root) {
  if (!root) return [];
  const list = [];
  for (const selector of FIXED_SELECTORS) for (const node of root.querySelectorAll(selector)) list.push(node);
  // 根到 body（含 body，不含 html：html 的滚动由 Hub 自己管）。
  for (let node = root; node && node.tagName !== 'HTML'; node = node.parentElement) list.push(node);
  return list;
}

// 复位并返回被复位的节点说明；没有就返回空数组。
function resetStuckScroll(nodes) {
  const fixed = [];
  for (const node of nodes || []) {
    if (!node) continue;
    const top = Number(node.scrollTop) || 0, left = Number(node.scrollLeft) || 0;
    if (!top && !left) continue;
    fixed.push({ node: describe(node), top, left });
    node.scrollTop = 0; node.scrollLeft = 0;
  }
  return fixed;
}

function describe(node) {
  const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\s+/).join('.') : '';
  return String(node.tagName || 'node').toLowerCase() + (node.id ? '#' + node.id : '') + cls;
}

// 只记一次日志：同一页反复复位时不刷屏。
function createScrollGuard({ log = () => {} } = {}) {
  let logged = false, count = 0;
  return {
    check(root) {
      const fixed = resetStuckScroll(stuckScrollTargets(root));
      if (fixed.length) { count += fixed.length; if (!logged) { logged = true; log(fixed); } }
      return fixed;
    },
    get count() { return count; },
  };
}

// 只滚动列表自己：把 node 放进 list 的可视区（不动任何祖先，替代 scrollIntoView）。
function scrollWithin(list, node, block = 'nearest') {
  if (!list || !node || !node.isConnected) return;
  const box = list.getBoundingClientRect(), rect = node.getBoundingClientRect();
  if (block === 'center') { list.scrollTop += (rect.top + rect.height / 2) - (box.top + box.height / 2); return; }
  if (block === 'start') { list.scrollTop += rect.top - box.top; return; }
  if (block === 'end') { list.scrollTop += rect.bottom - box.bottom; return; }
  if (rect.top < box.top) list.scrollTop += rect.top - box.top;
  else if (rect.bottom > box.bottom) list.scrollTop += Math.min(rect.bottom - box.bottom, rect.top - box.top);
}

// 「贴底」判定：离底部不超过可视高度的 15%（夹在 48–160px 之间）就算在看最新，新内容到了跟着滚。
function nearBottom(list) {
  if (!list) return true;
  const slack = Math.max(48, Math.min(160, (list.clientHeight || 0) * 0.15));
  return list.scrollHeight - list.clientHeight - list.scrollTop <= slack;
}

module.exports = { stuckScrollTargets, resetStuckScroll, createScrollGuard, scrollWithin, nearBottom, FIXED_SELECTORS };
