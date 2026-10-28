'use strict';

function createBackstageMenu({ document: doc, isSplit, onSingle, onSplit, onError }) {
  const root = doc.getElementById('backstage-control');
  const button = doc.getElementById('btn-backstage');
  const trigger = doc.getElementById('btn-backstage-menu');
  const menu = doc.getElementById('backstage-menu');
  const items = [...menu.querySelectorAll('[data-backstage-layout]')];
  let busy = false;
  function close() { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
  function sync(visible) {
    root.hidden = !visible;
    const split = isSplit();
    root.dataset.layout = split ? 'split' : 'single';
    if (split) { button.setAttribute('aria-pressed', 'true'); button.title = '收起后台，返回单屏卡片'; }
    items.forEach(item => item.setAttribute('aria-checked', String((item.dataset.backstageLayout === 'split') === split)));
    if (!visible) close();
  }
  function open(focus = false) {
    sync(!root.hidden); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    if (focus) items.find(item => item.getAttribute('aria-checked') === 'true')?.focus();
  }
  trigger.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(true); }
  });
  menu.addEventListener('keydown', event => {
    const index = items.indexOf(doc.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });
  for (const item of items) item.addEventListener('click', async () => {
    if (busy) return;
    busy = true; close(); trigger.disabled = true;
    try { await (item.dataset.backstageLayout === 'split' ? onSplit() : onSingle()); }
    catch (error) { onError(error); }
    finally { busy = false; trigger.disabled = false; sync(!root.hidden); trigger.focus(); }
  });
  doc.addEventListener('click', event => { if (!root.contains(event.target) || button.contains(event.target)) close(); });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); }
    if (event.key === 'Tab') close();
  }, true);
  return { sync };
}
module.exports = { createBackstageMenu };
