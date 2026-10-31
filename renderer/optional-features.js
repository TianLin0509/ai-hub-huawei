'use strict';
// 设置菜单「🧩 可选功能」（2026-10-30 用户）：助理、论坛、桌宠默认关，在这里逐项打开或关掉，每项写明用途和开着的开销。
// 主进程给清单（main.js 的 optional-features:list / set，开关存在 core/optional-features.js 与桌宠自己的设置里）；
// 样式沿用一键更新弹窗（renderer/app-update.js 的 .app-update-dialog / .au-*）。
(() => {
  const { ipcRenderer } = require('electron');
  let dialog = null, list = [];

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `
  .optional-features-dialog .of-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border-subtle, #e4e6ec); }
  .optional-features-dialog .of-item:last-child { border-bottom: 0; }
  .optional-features-dialog .of-text { flex: 1; min-width: 0; }
  .optional-features-dialog .of-name { font-weight: 600; font-size: 14px; }
  .optional-features-dialog .of-state { margin-left: 8px; font-size: 12px; color: var(--fg-muted, #6b7080); font-weight: 400; }
  .optional-features-dialog .of-state.on { color: #3478f6; }
  .optional-features-dialog .of-desc { font-size: 12.5px; margin-top: 3px; }
  .optional-features-dialog .of-cost { font-size: 12px; margin-top: 3px; color: var(--fg-muted, #6b7080); }
  .optional-features-dialog .of-err { color: #c0392b; font-size: 12px; margin-top: 8px; }
  .optional-features-dialog .of-note { font-size: 12px; color: var(--fg-muted, #6b7080); margin: 0 0 4px; }`;

  function emit() { window.dispatchEvent(new CustomEvent('hub-optional-features', { detail: list })); }
  async function refresh() {
    try { list = (await ipcRenderer.invoke('optional-features:list')) || []; } catch (_) { list = []; }
    emit(); return list;
  }
  async function set(id, on) {
    const r = await ipcRenderer.invoke('optional-features:set', { id, on: !!on });
    if (!r || r.ok === false) throw new Error((r && r.error) || '没改成');
    list = r.list || list; emit(); return list;
  }
  const get = id => list.find(x => x.id === id) || null;

  function ensureDialog() {
    if (dialog) return dialog;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    dialog = document.createElement('dialog');
    dialog.className = 'app-update-dialog optional-features-dialog';
    dialog.innerHTML = `
      <div class="au-head"><div class="au-title"><strong>可选功能</strong><span>默认都关着，用到哪个开哪个；关掉后后台不再为它花时间</span></div>
        <button type="button" class="au-close" data-of="close" title="关闭">✕</button></div>
      <div class="au-body"><div data-of="items"></div><div class="of-err" data-of="err" hidden></div></div>
      <div class="au-foot"><button type="button" class="au-btn primary" data-of="close">完成</button></div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-of="close"]')) { dialog.close(); return; }
      if (event.target.closest('[data-of="pet-settings"]')) { event.preventDefault(); dialog.close(); window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: { settingsTab: 'pet' } })); }
    });
    dialog.addEventListener('change', async event => {
      const box = event.target.closest('input[data-of-id]');
      if (!box) return;
      const err = dialog.querySelector('[data-of="err"]');
      box.disabled = true; err.hidden = true;
      try { await set(box.dataset.ofId, box.checked); }
      catch (error) { box.checked = !box.checked; err.textContent = error.message; err.hidden = false; }
      render();
    });
    return dialog;
  }
  function render() {
    if (!dialog) return;
    dialog.querySelector('[data-of="items"]').innerHTML = list.map(f => `
      <label class="of-item"><input type="checkbox" data-of-id="${esc(f.id)}"${f.on ? ' checked' : ''}>
        <div class="of-text"><div class="of-name">${esc(f.name)}<span class="of-state${f.on ? ' on' : ''}">${f.on ? '已开启' : '未开启'}</span></div>
          <div class="of-desc">${esc(f.desc)}</div><div class="of-cost">${esc(f.cost)}</div></div>${f.id === 'pet' ? '<button type="button" class="au-btn" data-of="pet-settings" title="形象、大小、提醒档位">桌宠设置…</button>' : ''}</label>`).join('')
      || '<p class="of-note">这个版本没有可选功能。</p>';
  }
  async function open() {
    ensureDialog(); await refresh(); render();
    dialog.querySelector('[data-of="err"]').hidden = true;
    if (!dialog.open) dialog.showModal();
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-optional-features')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-optional-features'; item.textContent = '🧩 可选功能';
    item.addEventListener('click', () => { menu.style.display = 'none'; void open(); });
    const anchor = document.getElementById('options-feedback') || document.getElementById('options-check-update');
    if (anchor) anchor.after(item); else menu.appendChild(item);
  }

  ipcRenderer.on('optional-features:changed', (_event, next) => { if (Array.isArray(next)) { list = next; emit(); render(); } });
  window.__optionalFeatures = { refresh, set, get, open, list: () => list.slice() };
  void refresh().then(items => { if (items.length) addMenuEntry(); });
})();
