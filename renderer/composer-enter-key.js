'use strict';
// 输入框回车键的行为（用户反馈：输入时应该支持回车换行）。默认仍是回车发送、Shift+回车换行；
// 设置里可以换成回车换行、Ctrl+回车发送。占位文字写明当前规则，不用猜。存在本机，选择后立即生效。
const STORAGE_KEY = 'hub.composerEnterKey';
const MODES = ['send', 'newline'];

function readMode(storage) {
  try { const value = storage?.getItem(STORAGE_KEY); return MODES.includes(value) ? value : 'send'; } catch { return 'send'; }
}
function writeMode(storage, mode) {
  if (!MODES.includes(mode)) return readMode(storage);
  try { storage?.setItem(STORAGE_KEY, mode); } catch { /* 存不了只影响重启后的选择 */ }
  return mode;
}
function isSendKey(event, mode) {
  if (event.key !== 'Enter') return false;
  return mode === 'newline' ? !!(event.ctrlKey || event.metaKey) : !event.shiftKey;
}
function isNewlineKey(event, mode) {
  return event.key === 'Enter' && mode === 'newline' && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
function placeholderFor(mode, base = '输入消息…') {
  return `${base}（${mode === 'newline' ? 'Enter 换行，Ctrl+Enter 发送' : 'Enter 发送，Shift+Enter 换行'}）`;
}
// 设置页的下拉：选了立刻生效，已经打开的输入框也换占位文字。
function bindSetting({ document: doc, storage }) {
  const select = doc.getElementById('cfg-composer-enter');
  if (!select) return;
  select.value = readMode(storage);
  select.addEventListener('change', () => {
    const mode = writeMode(storage, select.value);
    doc.querySelectorAll('.floating-input-box, #mr-input-box').forEach(box => box.setAttribute('data-placeholder', placeholderFor(mode)));
  });
}
module.exports = { STORAGE_KEY, readMode, writeMode, isSendKey, isNewlineKey, placeholderFor, bindSetting };
