'use strict';
// 账号下拉里的「自动换号」（2026-10-31）：换号有风控风险，默认关闭，只由用户在这里逐个会话开启。
function autoSwitchItem({ document: doc, enabled, disabled, onToggle }) {
  const item = doc.createElement('button');
  item.type = 'button';
  item.className = 'model-picker-item claude-account-option composer-account-auto';
  item.setAttribute('role', 'menuitemcheckbox');
  item.setAttribute('aria-checked', String(enabled));
  item.disabled = disabled;
  item.textContent = `${enabled ? '☑' : '☐'} 自动换号（额度用完时）`;
  item.title = '开启后，这个会话额度用完时 Hub 会自动换到其他账号。换号有被判定滥用的风险，默认关闭，建议只在需要时开启。';
  item.addEventListener('click', onToggle);
  return item;
}

module.exports = { autoSwitchItem };
