'use strict';
// 「以后再说」3 天内不再弹。没开通过、已经改过、或不是公司公开版，都不出现。
(() => {
  const { ipcRenderer } = require('electron');
  const SNOOZE_KEY = 'hub:editionSwitchSnooze';
  const SNOOZE_MS = 3 * 24 * 3600 * 1000;
  const DELAY_MS = 15000;
  const css = `
  .edn-dialog { position: fixed; inset: 0; margin: auto; height: fit-content; width: min(480px, calc(100vw - 48px)); padding: 0; border: 1px solid var(--border-subtle, #e3e1ea); border-radius: 14px;
    background: var(--surface-raised, #fff); color: var(--fg-default, #1f2330); box-shadow: 0 24px 60px rgba(30, 24, 60, .22); font: inherit; }
  .edn-dialog::backdrop { background: rgba(24, 20, 40, .38); }
  .edn-head { padding: 18px 20px 6px; font-size: 15px; font-weight: 600; }
  .edn-body { padding: 0 20px 4px; font-size: 13px; line-height: 1.65; }
  .edn-body p { margin: 6px 0; }
  .edn-input { width: 100%; box-sizing: border-box; margin: 8px 0 4px; padding: 8px 10px; border: 1px solid var(--border-subtle, #dcd9e6); border-radius: 8px; font: inherit; background: var(--surface-sunken, #f6f5fa); color: inherit; }
  .edn-msg { min-height: 20px; margin-top: 4px; color: var(--fg-muted, #6b7080); }
  .edn-msg.err { color: #c2410c; }
  .edn-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
  .edn-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-raised, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  .edn-btn.primary { background: var(--brand, #8b5cf6); border-color: var(--brand, #8b5cf6); color: #fff; font-weight: 600; }
  .edn-btn[disabled] { opacity: .6; cursor: default; }
  `;
  const snoozed = () => { try { return Date.now() < Number(localStorage.getItem(SNOOZE_KEY) || 0); } catch { return false; } };

  function show() {
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const dialog = document.createElement('dialog');
    dialog.className = 'edn-dialog'; dialog.id = 'edition-switch-notice';
    dialog.innerHTML = '<div class="edn-head">升级到完整版</div><div class="edn-body">'
      + '<p>这台电脑以前开通过扩展功能。输入一次口令，就会升级到完整版，以后也从完整版的地址自动更新。</p>'
      + '<input class="edn-input" type="password" autocomplete="off" spellcheck="false" placeholder="口令" data-edn="code">'
      + '<div class="edn-msg" data-edn="msg"></div></div>'
      + '<div class="edn-foot"><button class="edn-btn" data-edn="later">以后再说</button><button class="edn-btn primary" data-edn="go">升级</button></div>';
    dialog.addEventListener('close', () => dialog.remove());
    const msg = () => dialog.querySelector('[data-edn="msg"]');
    const go = async () => {
      const input = dialog.querySelector('[data-edn="code"]');
      const button = dialog.querySelector('[data-edn="go"]');
      button.disabled = true; msg().className = 'edn-msg'; msg().textContent = '正在核对…';
      const r = await ipcRenderer.invoke('edition:switch', { code: input.value }).catch(error => ({ ok: false, message: error.message }));
      button.disabled = false;
      if (!r || !r.ok) { msg().className = 'edn-msg err'; msg().textContent = (r && r.message) || '没能核对口令'; input.select(); return; }
      msg().textContent = `口令正确，完整版 v${r.version} 可以下载了。`;
      setTimeout(() => { dialog.close(); window.__appUpdate?.open?.(); }, 900);
    };
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-edn]')?.dataset.edn;
      if (action === 'later') { try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch {} dialog.close(); }
      else if (action === 'go') void go();
    });
    dialog.querySelector('[data-edn="code"]').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void go(); } });
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('[data-edn="code"]').focus();
  }

  window.__editionNotice = { show };
  setTimeout(async () => {
    const s = await ipcRenderer.invoke('edition:state').catch(() => null);
    if (!s || !s.enabled || !s.unlocked || s.switched || snoozed()) return;
    if (document.querySelector('dialog[open]')) { setTimeout(() => { if (!document.querySelector('dialog[open]')) show(); }, 30000); return; }
    show();
  }, DELAY_MS);
})();
