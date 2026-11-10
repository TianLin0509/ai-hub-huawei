'use strict';

function validateName(value, maxLength = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\r\n\x00-\x1f]/.test(value)) throw new Error(`名称须为 1–${maxLength} 个字符，不能换行`);
  return value.trim();
}

// Put the same element back so its click/dblclick handlers survive every edit.
function bindInlineNameEditor({ element, document, getName, save, event = 'click', onError = () => {}, notify = () => {} }) {
  let editing = false;
  element.addEventListener(event, () => {
    if (editing) return;
    editing = true;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'terminal-title-input'; input.value = getName(); input.maxLength = 120;
    input.setAttribute('aria-label', '重命名');
    let saving = false, cancelled = false, active = true;
    const restore = () => { if (!active) return; active = false; element.textContent = getName(); input.replaceWith(element); editing = false; };
    const finish = async () => {
      if (saving || !active) return;
      if (cancelled) { restore(); return; }
      saving = true; input.readOnly = true;
      try { await save(validateName(input.value)); if (active) restore(); else { element.textContent = getName(); notify('名称已保存：' + getName()); } }
      catch (error) { onError(error.message); if (active) { input.readOnly = false; input.focus(); } }
      finally { saving = false; }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); return finish(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelled = true; restore(); }
    });
    element.replaceWith(input); input.focus(); input.select();
  });
}

function openNameEditor({ document, title = '重命名', value = '', maxLength = 120, choices = null, save, notify = () => {} }) {
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div'); overlay.className = 'hub-name-overlay';
  const form = document.createElement('form'); form.className = 'hub-name-dialog'; form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-label', title);
  const label = document.createElement('label'); label.textContent = title;
  const input = document.createElement(choices ? 'select' : 'input');
  if (choices) for (const choice of choices) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; input.appendChild(option); }
  else { input.type = 'text'; input.maxLength = maxLength; }
  input.value = value; input.setAttribute('aria-label', title); label.appendChild(input);
  const error = document.createElement('p'); error.className = 'hub-name-error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'hub-name-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = '保存';
  actions.appendChild(cancel); actions.appendChild(submit); form.appendChild(label); form.appendChild(error); form.appendChild(actions); overlay.appendChild(form); document.body.appendChild(overlay);
  return new Promise(resolve => {
    let busy = false, closed = false;
    const close = result => { if (closed) return; closed = true; overlay.remove(); previousFocus?.focus?.(); resolve(result); };
    cancel.addEventListener('click', () => close(false));
    overlay.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
      if (event.key === 'Tab') {
        const focusable = [input, cancel, submit].filter(el => !el.disabled), index = focusable.indexOf(document.activeElement);
        event.preventDefault(); focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      busy = true; submit.disabled = true; submit.textContent = '保存中…'; input.readOnly = true; error.textContent = ''; if (choices) cancel.focus();
      try { const submitted = validateName(input.value, maxLength); await save(submitted); if (closed) notify('名称已保存：' + submitted); else close(true); }
      catch (failure) { if (closed) notify('名称保存失败：' + failure.message); else { error.textContent = failure.message; input.readOnly = false; input.focus(); } }
      finally { busy = false; submit.disabled = false; submit.textContent = '保存'; }
    });
    input.focus(); input.select?.();
  });
}

module.exports = { validateName, bindInlineNameEditor, openNameEditor };
