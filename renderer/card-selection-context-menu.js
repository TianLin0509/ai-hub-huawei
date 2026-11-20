'use strict';

const { readSelectedText } = require('./clipboard-controller.js');

function createCardSelectionContextMenuController({
  document,
  window,
  menuEl,
  clipboard,
  copyText,
  expandText = text => text,
  pushToChatgpt,
  markdown = null,
  quoteText = null,
  requestAnimationFrameFn = requestAnimationFrame,
}) {
  let selectedText = '';
  let selectedCard = null;
  let selectedMarkdown = '';
  function syncMarkdownToggle() {
    const item = menuEl.querySelector?.('[data-action="toggle-md"]');
    if (!item) return;
    const on = !!markdown?.markdownPreferred?.();
    item.setAttribute('aria-checked', String(on));
    item.textContent = (on ? '✓ ' : '') + 'Ctrl+C 和复制按钮都给 Markdown';
  }

  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function readCardSelection() {
    const selection = window.getSelection && window.getSelection();
    const overlay = document.getElementById('msg-overlay');
    if (!selection || !overlay || selection.rangeCount < 1 || selection.isCollapsed) return '';
    const anchor = nodeElement(selection.anchorNode);
    const focus = nodeElement(selection.focusNode);
    if (!anchor || !focus || !overlay.contains(anchor) || !overlay.contains(focus)) return '';
    const value = String(selection.toString() || '');
    return value.trim() ? value : '';
  }

  function open(text, x, y, card = null) {
    if (!text || !String(text).trim()) return false;
    selectedText = String(text);
    selectedCard = card || null;
    // 「引用到输入框」只在消息卡片上有意义：输入框、文件预览里选中的文字不给这一项。
    const quoteItem = menuEl.querySelector?.('[data-action="quote"]');
    if (quoteItem) quoteItem.hidden = !(selectedCard && typeof quoteText === 'function');
    // 菜单一开就把选区转好：点菜单项时选区可能已经变了。
    try { selectedMarkdown = markdown?.selectionToMarkdown ? markdown.selectionToMarkdown(window) : ''; } catch { selectedMarkdown = ''; }
    const mdItem = menuEl.querySelector?.('[data-action="copy-md"]');
    if (mdItem) mdItem.hidden = !markdown;
    syncMarkdownToggle();
    menuEl.style.display = 'block';
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    requestAnimationFrameFn(() => {
      const rect = menuEl.getBoundingClientRect();
      if (rect.right > window.innerWidth) menuEl.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) menuEl.style.top = `${y - rect.height}px`;
    });
    return true;
  }

  function close() {
    menuEl.style.display = 'none';
    selectedText = '';
    selectedMarkdown = '';
    selectedCard = null;
  }

  async function runAction(action, text = selectedText, md = selectedMarkdown, card = selectedCard) {
    if (action === 'quote') {
      if (typeof quoteText !== 'function' || !card) return { ok: false, error: '这里的文字不能引用。' };
      return quoteText(String(md || text || ''), card);
    }
    if (action === 'toggle-md') {
      const on = !markdown?.markdownPreferred?.();
      markdown?.setMarkdownPreferred?.(on);
      syncMarkdownToggle();
      return { ok: true, markdown: on };
    }
    if (action === 'copy-md') {
      const value = String(md || '').trim() ? String(md) : expandText(String(text || ''));
      if (!value.trim()) return { ok: false, error: '没有选中文字。' };
      const result = await copyText(value, { source: 'card-context-menu-md' });
      return { ...result, copied: result?.ok === true };
    }
    const value = expandText(String(text || ''));
    if (!value.trim()) return { ok: false, error: '没有选中文字。' };
    if (action === 'copy') {
      if (typeof copyText === 'function') {
        const result = await copyText(value, { source: 'card-context-menu' });
        return { ...result, copied: result?.ok === true };
      }
      await Promise.resolve(clipboard.writeText(value));
      const ok = typeof clipboard.readText === 'function' && clipboard.readText() === value;
      return { ok, copied: ok };
    }
    if (action === 'sync-chatgpt' && typeof pushToChatgpt === 'function') {
      return pushToChatgpt(value, '卡片选中文字');
    }
    return { ok: false, error: '未知操作。' };
  }

  function init() {
    document.addEventListener('contextmenu', (event) => {
      if (!event.target?.closest || event.target.closest('.xterm')) return;
      if (!event.target.closest('.turn-card, #preview-body, input, textarea, [contenteditable="true"]')) return;
      const value = readSelectedText(event.target, window);
      const card = event.target.closest('.msg-overlay .turn-card');
      if (!value || !open(value, event.clientX, event.clientY, card)) return;
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      else event.stopPropagation();
    }, true);

    document.addEventListener('mousedown', (event) => {
      if (menuEl.style.display === 'block' && !menuEl.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menuEl.style.display === 'block') close();
    });
    document.addEventListener('scroll', () => {
      if (menuEl.style.display === 'block') close();
    }, true);

    for (const button of menuEl.querySelectorAll('.context-menu-item')) {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        const value = selectedText, md = selectedMarkdown, card = selectedCard;
        close();
        await runAction(action, value, md, card);
      });
    }
    return true;
  }

  return { init, open, close, readCardSelection, runAction };
}

module.exports = { createCardSelectionContextMenuController };
