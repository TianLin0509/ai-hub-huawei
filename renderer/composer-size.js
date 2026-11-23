'use strict';

const HEIGHT_KEY = 'hub.composer.inputHeight';

function clampHeight(value, panelHeight) {
  return Math.round(Math.max(52, Math.min(Number(value) || 52, 480, panelHeight * 0.55 - 112)));
}

// 只在用户拖动或已有偏好时改尺寸，默认两行布局沿用现有样式。
function mountComposerSize({ document, window, storage, host, input, before, readText, writeText, onSend }) {
  const panel = host.closest('.terminal-panel');
  const handle = document.createElement('div');
  handle.className = 'composer-resize-handle';
  handle.title = '拖动上边沿调整输入框高度';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', '调整输入框高度');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.tabIndex = 0;
  host.prepend(handle);
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'composer-expand-editor composer-chip composer-chip-icon';
  expand.title = '展开大输入框';
  expand.setAttribute('aria-label', '展开大输入框');
  expand.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></svg>';
  before.parentNode.insertBefore(expand, before);
  let editor, wanted = 0, drag;
  try { wanted = Number(storage.getItem(HEIGHT_KEY)) || 0; } catch { /* 存储不可用时仍可拖动。 */ }
  function apply() {
    if (!wanted || !panel?.clientHeight || !input.getClientRects().length || host.classList.contains('composer-is-collapsed')) return;
    const oldInput = input.getBoundingClientRect().height;
    const chrome = host.getBoundingClientRect().height - oldInput;
    const height = clampHeight(wanted, panel.clientHeight);
    for (const name of ['height', 'min-height', 'max-height']) input.style.setProperty(name, `${height}px`, 'important');
    for (const name of ['height', 'min-height', 'max-height', 'flex-basis']) host.style.setProperty(name, `${chrome + height}px`);
    host.style.setProperty('--fi-layout-h', `${chrome + height}px`);
    handle.setAttribute('aria-valuenow', String(height));
  }
  function save() { try { storage.setItem(HEIGHT_KEY, String(wanted)); } catch { /* 不影响编辑。 */ } }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    drag = { y: event.clientY, height: input.getBoundingClientRect().height };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    wanted = clampHeight(drag.height + drag.y - event.clientY, panel.clientHeight);
    apply();
  });
  const finish = () => { if (drag) { drag = null; if (wanted) save(); } };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    wanted = clampHeight(input.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 20 : -20), panel.clientHeight);
    apply(); save();
  });
  expand.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    editor = require('./long-input-editor').openLongInputEditor({ document, text: readText(),
      onApply: writeText, onSend, onClose: () => { editor = null; } });
  });
  const observer = new window.ResizeObserver(apply);
  observer.observe(panel);
  observer.observe(host);
  apply();
  return { dispose() { observer.disconnect(); editor?.close(); } };
}

module.exports = { mountComposerSize, clampHeight, HEIGHT_KEY };
