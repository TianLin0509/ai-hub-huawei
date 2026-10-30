'use strict';
// 一键反馈的界面（2026-10-29）：设置菜单「💬 一键反馈」→ 写一句遇到了什么 → 看一眼会附带哪些内容 → 发送。
// 附带的是版本、系统和最近的日志尾部，发送前已在主进程脱敏（core/hub-feedback.js）；数据与发送都在 main/hub-feedback-service.js。
// 样式沿用一键更新弹窗（renderer/app-update.js 的 .app-update-dialog / .au-*），只有带更新配置的发行版才出现。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer, shell } = require('electron');
  let dialog = null, sending = false;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `
  .hub-feedback-dialog textarea { width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface, #fff); color: inherit; font: inherit; font-size: 13px; }
  .hub-feedback-dialog input.hf-contact { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6);
    background: var(--surface, #fff); color: inherit; font: inherit; font-size: 13px; }
  .hub-feedback-dialog .hf-items { margin: 0; padding-left: 18px; font-size: 12px; color: var(--fg-muted, #6b7080); max-height: 120px; overflow: auto; }
  .hub-feedback-dialog .hf-path { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; user-select: text; }`;

  function ensureDialog() {
    if (dialog) return dialog;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    dialog = document.createElement('dialog');
    dialog.className = 'app-update-dialog hub-feedback-dialog';
    dialog.innerHTML = `
      <div class="au-head"><div class="au-title"><strong>一键反馈</strong><span>直接发给 AI HUB 维护人，帮你排查问题</span></div>
        <button type="button" class="au-close" data-hf="close" title="关闭">✕</button></div>
      <div class="au-body">
        <div class="au-section">遇到了什么问题</div>
        <textarea data-hf="desc" placeholder="例如：CodeAgent 会话卡片一直不显示回答，后台终端里是有的"></textarea>
        <div class="au-section">联系方式（可不填）</div>
        <input class="hf-contact" data-hf="contact" placeholder="工号或姓名，方便回访">
        <div class="au-section">会一起附带（已自动隐去密钥、口令、邮箱和用户目录）</div>
        <ul class="hf-items" data-hf="items"><li>正在整理…</li></ul>
        <div data-hf="msg"></div>
      </div>
      <div class="au-foot"><button type="button" class="au-btn" data-hf="cancel">取消</button>
        <button type="button" class="au-btn primary" data-hf="send">发送</button></div>`;
    document.body.appendChild(dialog);
    const q = name => dialog.querySelector(`[data-hf="${name}"]`);
    const close = () => { if (!sending) dialog.close(); };
    q('close').addEventListener('click', close);
    q('cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (sending) event.preventDefault(); });
    q('send').addEventListener('click', () => void send());
    return dialog;
  }

  function message(kind, html) {
    const box = dialog.querySelector('[data-hf="msg"]');
    box.innerHTML = html ? `<div class="au-msg ${kind}">${html}</div>` : '';
    const link = box.querySelector('[data-hf-open]');
    if (link) link.addEventListener('click', () => shell.showItemInFolder(link.dataset.hfOpen));
  }

  async function open() {
    ensureDialog();
    dialog.querySelector('[data-hf="send"]').disabled = false;
    dialog.querySelector('[data-hf="send"]').textContent = '发送';
    message('', '');
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('[data-hf="desc"]').focus();
    try {
      const p = await ipcRenderer.invoke('hub-feedback:preview', {});
      const items = (p && p.items) || [];
      dialog.querySelector('[data-hf="items"]').innerHTML = items.map(i => `<li>${esc(i.name)}${i.detail ? ' · ' + esc(i.detail) : ''}</li>`).join('') || '<li>只有问题描述</li>';
    } catch (error) {
      dialog.querySelector('[data-hf="items"]').innerHTML = `<li>整理附带内容失败：${esc(error.message)}</li>`;
    }
  }

  async function send() {
    if (sending) return;
    const desc = dialog.querySelector('[data-hf="desc"]').value;
    if (!desc.trim()) { message('warn', '请先写一句遇到了什么问题'); dialog.querySelector('[data-hf="desc"]').focus(); return; }
    sending = true;
    const btn = dialog.querySelector('[data-hf="send"]');
    btn.disabled = true; btn.textContent = '正在发送…';
    message('info', '正在发送，公司网络需要放行时会自动处理，最多约一分钟');
    let r;
    try { r = await ipcRenderer.invoke('hub-feedback:send', { description: desc, contact: dialog.querySelector('[data-hf="contact"]').value }); }
    catch (error) { r = { ok: false, reason: error.message }; }
    sending = false;
    if (r && r.ok) {
      btn.textContent = '已发送';
      message('ok', `已发送，反馈编号 <b>${esc(r.id)}</b>。维护人会根据附带的日志排查。`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    btn.disabled = false; btn.textContent = '重新发送';
    const saved = r && r.savedTo ? `<br>同样的内容已存到：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a>，可以手动发给维护人。` : '';
    message('bad', `没发出去：${esc((r && r.reason) || '未知原因')}${saved}`);
  }

  function addMenuEntry() {
    const menu = document.getElementById('options-menu');
    if (!menu || document.getElementById('options-feedback')) return;
    const item = document.createElement('div');
    item.className = 'options-item'; item.id = 'options-feedback'; item.textContent = '💬 一键反馈';
    item.addEventListener('click', () => { menu.style.display = 'none'; void open(); });
    const update = document.getElementById('options-check-update');
    if (update) update.after(item); else menu.appendChild(item);
  }

  addMenuEntry();
  window.__hubFeedback = { open };
})();
