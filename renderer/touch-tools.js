'use strict';

const { readSelectedText } = require('./clipboard-controller');

// 标题栏三个触屏工具：点一下即执行，不再经过下拉菜单。
// 按下时先记住原来的焦点和选区（按钮本身不抢焦点），复制和粘贴都作用在那个位置。
function initTouchTools({ document, window, copyText, expandText, ipcRenderer, getTerminal, pasteTerminal }) {
  const root = document.getElementById('touch-tools');
  const toast = root.querySelector('.touch-tools-toast');
  let saved = null;
  let busy = false;
  let toastTimer = null;
  function remember(target = document.activeElement) {
    if (root.contains(target)) return;
    const selection = window.getSelection();
    const terminal = target?.closest?.('.xterm') ? getTerminal(target) : null;
    saved = { target, terminal, text: terminal ? terminal.getSelection() : readSelectedText(target, window),
      start: target?.selectionStart, end: target?.selectionEnd,
      range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null };
  }
  function restore() {
    if (!saved?.target?.isConnected) throw new Error('请先点一下要粘贴的位置');
    saved.target.focus({ preventScroll: true });
    if (Number.isInteger(saved.start)) saved.target.setSelectionRange(saved.start, saved.end);
    else if (saved.range && saved.range.startContainer.isConnected) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(saved.range);
    }
  }
  function show(button, text, state) {
    clearTimeout(toastTimer);
    const box = button.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    toast.textContent = text;
    toast.dataset.state = state;
    toast.style.setProperty('--anchor', (box.left + box.width / 2 - host.left) + 'px');
    toast.hidden = false;
    button.dataset.state = state;
    toastTimer = setTimeout(() => { toast.hidden = true; delete button.dataset.state; }, state === 'error' ? 2600 : 1600);
  }
  root.addEventListener('pointerdown', event => { remember(); event.preventDefault(); });
  document.addEventListener('focusout', event => {
    if (!root.contains(event.target) && root.contains(event.relatedTarget)) remember(event.target);
  });
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-touch-action]');
    if (!button || busy) return;
    busy = true;
    for (const other of root.querySelectorAll('[data-state]')) delete other.dataset.state;
    button.dataset.state = 'busy';
    try {
      const action = button.dataset.touchAction;
      if (action === 'copy') {
        const text = expandText(saved?.text || '');
        if (!text) throw new Error('先选中文字，再点复制');
        const result = await copyText(text, { source: 'touch-tools' });
        if (result.reason === 'superseded') { show(button, '已有更新的复制，保留新的', 'ok'); return; }
        if (!result.ok) throw new Error('复制没成功，请再点一次');
        show(button, `已复制 ${result.length} 字`, 'ok');
      } else if (action === 'screenshot') {
        toast.hidden = true;
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        const result = await ipcRenderer.invoke('touch-tools:screenshot');
        if (!result.ok) throw new Error(result.error);
        show(button, '截图已复制，可直接粘贴', 'ok');
      } else if (action === 'paste') {
        restore();
        if (!saved.terminal && !saved.target.matches('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]')) throw new Error('先点一下要粘贴的输入框');
        if (saved.terminal) await pasteTerminal(saved.terminal);
        else await ipcRenderer.invoke('touch-tools:paste');
        show(button, '已粘贴', 'ok');
      }
    } catch (error) { show(button, error.message, 'error'); }
    finally { busy = false; }
  });
}
module.exports = { initTouchTools };
