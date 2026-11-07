'use strict';
// 快捷键一览（Ctrl+/ 或设置菜单）。按键和 renderer/keyboard-shortcuts.js、输入框实际处理的一致；界面上以前没有任何地方写过这些键。
const GROUPS = [
  { title: '会话', items: [
    ['Ctrl + N', '打开启动中心，新建会话'],
    ['Ctrl + 1 … 9', '跳到侧栏第几个会话'],
    ['Ctrl + Tab', '切到下一个会话'],
    ['Ctrl + J', '跳到下一个等你看的会话'],
    ['Ctrl + W', '休眠当前会话'],
    ['Ctrl + Shift + B', '分支当前会话'],
    ['Ctrl + Alt + Home', '回到主页'],
  ] },
  { title: '阅读', items: [
    ['Ctrl + F', '在当前会话里查找'],
    ['Ctrl + Shift + F', '搜索历史'],
    ['Ctrl + ↑ / ↓', '跳到上一个 / 下一个问题'],
    ['Ctrl + Home / End', '跳到最前 / 最后'],
    ['Ctrl + 滚轮、Ctrl + = / -', '放大缩小'],
  ] },
  { title: '输入', items: [
    ['Enter / Shift + Enter', '发送 / 换行（可在设置里对调）'],
    ['↑（输入框为空时）', '翻出之前发过的消息'],
    ['/', '选技能或命令'],
    ['@', '群聊里点名某个成员'],
  ] },
  { title: '工具', items: [
    ['Ctrl + K', '命令面板：什么都能搜'],
    ['Ctrl + O', '打开文件或路径预览'],
    ['Ctrl + B', '收起 / 展开侧栏'],
    ['Ctrl + /', '打开这张快捷键表'],
  ] },
];

function renderHtml(escapeHtml) {
  return GROUPS.map(group => `<section class="sh-group"><h3>${escapeHtml(group.title)}</h3><dl>`
    + group.items.map(([keys, what]) => `<div><dt>${keys.split(/\s*\+\s*/).map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('<i>+</i>')}</dt><dd>${escapeHtml(what)}</dd></div>`).join('')
    + '</dl></section>').join('');
}

function mount({ document: doc, escapeHtml }) {
  let dialog = null;
  function open() {
    if (dialog) { dialog.close(); return; }
    dialog = doc.createElement('dialog');
    dialog.className = 'app-update-dialog shortcut-help-dialog';
    dialog.innerHTML = '<div class="au-head"><div class="au-title"><strong>快捷键</strong><span>记不住也没关系，按 Ctrl + / 随时再看</span></div>'
      + '<button type="button" class="au-close" data-sh="close" aria-label="关闭">×</button></div>'
      + `<div class="au-body sh-body">${renderHtml(escapeHtml)}</div>`;
    dialog.addEventListener('click', event => { if (event.target === dialog || event.target.closest('[data-sh="close"]')) dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); dialog = null; });
    doc.body.appendChild(dialog);
    dialog.showModal();
  }
  doc.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === '/') { event.preventDefault(); event.stopPropagation(); open(); }
  }, true);
  const menu = doc.getElementById('options-menu');
  if (menu && !doc.getElementById('options-shortcuts')) {
    const item = doc.createElement('div');
    item.className = 'options-item'; item.id = 'options-shortcuts'; item.textContent = '⌨️ 快捷键';
    item.addEventListener('click', () => { menu.style.display = 'none'; open(); });
    const after = doc.getElementById('options-feedback') || doc.getElementById('options-whats-new');
    if (after && after.parentElement === menu) after.after(item); else menu.appendChild(item);
  }
  return { open };
}

module.exports = { GROUPS, renderHtml, mount };
