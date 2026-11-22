'use strict';

async function prepareFilePaths(ipcRenderer, paths) {
  const prepared = [];
  for (const path of new Set(paths)) {
    // 非图片路径保持同步旧行为，也避免为普通文档多走一次 IPC。
    prepared.push(/\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i.test(path)
      ? await ipcRenderer.invoke('prepare-image-file', path) : { path, resized: false });
  }
  return prepared;
}

function captureAttachmentTarget(input, { document, window, getTargetId = () => null, onOtherTarget, atEnd = false } = {}) {
  const id = getTargetId(), draft = input.textContent;
  const selection = window?.getSelection?.();
  const range = !atEnd && selection?.rangeCount && input.contains(selection.getRangeAt(0).startContainer)
    && input.contains(selection.getRangeAt(0).endContainer) ? selection.getRangeAt(0).cloneRange() : null;
  return (items, options = {}) => {
    if (getTargetId() !== id || input.isConnected === false) {
      onOtherTarget?.(id, items);
      return false;
    }
    if (input.getAttribute?.('contenteditable') === 'false' || input.hasAttribute?.('readonly')) return false;
    let validRange = range && input.textContent === draft && input.contains(range.startContainer)
      && input.contains(range.endContainer) ? range : null;
    // An intervening edit invalidates the old caret. Append without replacing
    // newly selected text; a switched-away editor keeps its current selection.
    if (!validRange && document?.createRange) {
      validRange = document.createRange(); validRange.selectNodeContents(input); validRange.collapse(false);
    }
    insertAttachments(input, items, { document, window, ...options, range: validRange });
    input.dispatchEvent(new (document.defaultView?.Event || Event)('input', { bubbles: true }));
    return true;
  };
}

function insertAttachments(input, items, { document, window, chips = false, insertText, range = null, prefix = '' }) {
  const write = text => {
    // execCommand acts on the document's focused editor, never on its argument.
    // Use a local Range when the user has moved to another conversation.
    if (!document?.createTextNode) return insertText(text); // callers with their own insertion adapter
    const selection = window?.getSelection?.();
    const focused = document.activeElement === input;
    if (focused && range) { selection.removeAllRanges(); selection.addRange(range); }
    if (focused && selection?.rangeCount && input.contains(selection.getRangeAt(0).startContainer)
        && input.contains(selection.getRangeAt(0).endContainer)) {
      if (document.execCommand('insertText', false, text)) {
        if (range) { range.setStart(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset); range.collapse(true); }
        return;
      }
    }
    const node = document.createTextNode(text);
    if (range) { range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true); }
    else input.appendChild(node);
  };
  if (prefix) write(prefix);
  for (let i = 0; i < items.length; i++) {
    if (i) write('\n');
    const item = items[i];
    if (chips && item.resized) {
      const name = String(item.originalPath || item.path).split(/[\\/]/).pop();
      require('./composer-paste-chips').insertPasteChip(input, item.path, { document, window, range,
        meta: { kind: 'image', label: `${name} · ${require('../core/i18n').translate('已自动缩放')}`, title: '已自动缩放',
          previewText: `${item.from.width}×${item.from.height} → ${item.to.width}×${item.to.height}\n${item.path}` } });
    } else write(item.path);
  }
}

// 拖入与附件选择共用准备和插入回调；不会在失败时悄悄发回超限原图。
function bindFileAttachments({ document, target, button, filePath, onFiles, onError }) {
  const picker = document.createElement('input');
  picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  picker.className = 'composer-attachment-picker';
  target.appendChild(picker);
  const consume = async files => {
    try {
      const paths = Array.from(files || []).map(filePath).filter(Boolean);
      if (paths.length) await onFiles(paths);
    } catch (error) { onError(error); }
  };
  button.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => { const files = Array.from(picker.files || []); picker.value = ''; await consume(files); });
  const carriesFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
  target.addEventListener('dragover', e => {
    if (!carriesFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; target.classList.add('drop-active');
  });
  target.addEventListener('dragleave', e => { if (e.target === target) target.classList.remove('drop-active'); });
  target.addEventListener('drop', async e => {
    target.classList.remove('drop-active');
    if (!carriesFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); await consume(e.dataTransfer.files);
  });
  return picker;
}

module.exports = { prepareFilePaths, insertAttachments, bindFileAttachments, captureAttachmentTarget };
