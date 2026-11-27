'use strict';
// 自动刷新保留正在输入的内容，以及失焦后尚未提交的修改。
function hasPendingEdits(root) {
  const active = root.ownerDocument.activeElement;
  if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
  return [...root.querySelectorAll('input, textarea')].some(el =>
    el.value !== el.defaultValue || (el.dataset.slot === 'draft' && el.value.trim()));
}
module.exports = { hasPendingEdits };
