'use strict';

// 会话与群聊共用长消息编辑器；应用只回填草稿，发送仍由原输入栏处理。
function openLongInputEditor({ document, text, onApply, onSend, onClose = () => {} }) {
  document.getElementById('mr-input-editor-overlay')?._closeEditor?.();
  const overlay = document.createElement('div');
  overlay.id = 'mr-input-editor-overlay';
  overlay.className = 'mr-input-editor-overlay';
  overlay.innerHTML = `
    <div class="mr-input-editor" role="dialog" aria-modal="true" aria-label="展开编辑">
      <div class="mr-input-editor-head"><strong>展开编辑</strong><span id="mr-input-editor-count">0 字</span></div>
      <textarea id="mr-input-editor-textarea" class="mr-input-editor-textarea" spellcheck="false"></textarea>
      <div class="mr-input-editor-actions">
        <button type="button" class="mr-input-editor-btn" data-action="cancel">取消</button>
        <button type="button" class="mr-input-editor-btn primary" data-action="apply">应用</button>
        <button type="button" class="mr-input-editor-btn send" data-action="send">发送</button>
      </div>
    </div>`;
  const previousFocus = document.activeElement;
  document.body.appendChild(overlay);
  const textarea = overlay.querySelector('textarea');
  const count = overlay.querySelector('#mr-input-editor-count');
  textarea.value = text;
  const updateCount = () => { count.textContent = `${textarea.value.length} 字`; };
  updateCount();
  textarea.addEventListener('input', updateCount);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    onClose();
  };
  const onKeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [textarea, ...overlay.querySelectorAll('button')];
      const next = controls[(controls.indexOf(document.activeElement) + (event.shiftKey ? controls.length - 1 : 1)) % controls.length];
      event.preventDefault(); next.focus();
    }
  };
  overlay._closeEditor = close;
  overlay.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action !== 'cancel') onApply(textarea.value);
    close();
    if (action === 'send') onSend();
  }));
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', onKeydown);
  textarea.focus();
  return { close };
}

module.exports = { openLongInputEditor };
