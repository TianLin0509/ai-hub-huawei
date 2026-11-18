'use strict';
// 一键反馈的界面（2026-10-29）：设置菜单「💬 一键反馈」→ 写一句遇到了什么 → 看一眼会附带哪些内容 → 发送。
// 附带的是版本、系统和最近的日志尾部，发送前已在主进程脱敏（core/hub-feedback.js）；数据与发送都在 main/hub-feedback-service.js。
// 样式沿用一键更新弹窗（renderer/app-update.js 的 .app-update-dialog / .au-*），只有带更新配置的发行版才出现。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.updateConfig) return;
  const { ipcRenderer, shell } = require('electron');
  let dialog = null, sending = false, contactEdited = false, via = '', lastText = '';
  const TO_INTRANET = '发给维护人（公司内网），帮你排查问题';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = `
  .hub-feedback-dialog textarea { width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border-subtle, #dcd9e6); background: var(--surface-sunken, #f6f5fa); color: var(--fg-default, #1f2330); font: inherit; font-size: 13px; }
  .hub-feedback-dialog input.hf-contact { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-subtle, #dcd9e6);
    background: var(--surface-sunken, #f6f5fa); color: var(--fg-default, #1f2330); font: inherit; font-size: 13px; }
  .hub-feedback-dialog :is(textarea, input.hf-contact)::placeholder { color: var(--fg-muted, #6b7080); opacity: 1; }
  .hub-feedback-dialog .hf-items { margin: 0; padding-left: 18px; font-size: 12px; color: var(--fg-muted, #6b7080); max-height: 120px; overflow: auto; }
  .hub-feedback-dialog .hf-path { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; user-select: text; }`;

  function ensureDialog() {
    if (dialog) return dialog;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    dialog = document.createElement('dialog');
    dialog.className = 'app-update-dialog hub-feedback-dialog';
    dialog.innerHTML = `
      <div class="au-head"><div class="au-title"><strong>一键反馈</strong><span data-hf="to">发给 AI HUB 维护人，帮你排查问题</span></div>
        <button type="button" class="au-close" data-hf="close" title="关闭">✕</button></div>
      <div class="au-body">
        <div class="au-section">遇到了什么问题</div>
        <textarea data-hf="desc" placeholder="例如：CodeAgent 会话卡片一直不显示回答，后台终端里是有的"></textarea>
        <div class="au-section">联系方式（可不填）</div>
        <input class="hf-contact" data-hf="contact" maxlength="160" placeholder="工号或姓名，方便回访">
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
    q('contact').addEventListener('input', () => {
      contactEdited = true;
      void ipcRenderer.invoke('hub-feedback:save-contact', { contact: q('contact').value }).catch(() => {});
    });
    return dialog;
  }

  function message(kind, html) {
    const box = dialog.querySelector('[data-hf="msg"]');
    box.innerHTML = html ? `<div class="au-msg ${kind}">${html}</div>` : '';
    const link = box.querySelector('[data-hf-open]');
    if (link) link.addEventListener('click', () => shell.showItemInFolder(link.dataset.hfOpen));
    const copyBtn = box.querySelector('[data-hf-copy]');
    if (copyBtn) copyBtn.addEventListener('click', event => {
      event.preventDefault();
      try { require('electron').clipboard.writeText(lastText); copyBtn.textContent = '已复制，可以贴到 WeLink 发给维护人'; }
      catch { copyBtn.textContent = '复制失败，请打开上面的文件手动复制'; }
    });
    const unblock = box.querySelector('[data-hf-unblock]');
    if (unblock) unblock.addEventListener('click', event => { event.preventDefault(); void ipcRenderer.invoke('net-pass:open-window', unblock.dataset.hfUnblock, { method: 'POST' }).catch(() => {}); });
  }

  // prefill.description：从错误卡「一键反馈」进来时预填现象、功能区和原始报错（5.5.24），用户可以改了再发。
  // 正在发送时不覆盖；用户已经写了内容且没发出去时也不覆盖，只把新的报错接在后面。
  async function open(prefill) {
    ensureDialog();
    if (!sending) {
      dialog.querySelector('[data-hf="send"]').disabled = false;
      dialog.querySelector('[data-hf="send"]').textContent = '发送';
      message('', '');
    }
    const desc = dialog.querySelector('[data-hf="desc"]');
    const text = prefill && typeof prefill.description === 'string' ? prefill.description.trim() : '';
    if (text && !sending) desc.value = desc.value.trim() && !desc.value.includes(text) ? desc.value.trimEnd() + '\n\n' + text : text;
    if (!dialog.open) dialog.showModal();
    desc.focus();
    if (text) { const at = desc.value.indexOf('（可以在这里补一句'); if (at >= 0) desc.setSelectionRange(at, desc.value.indexOf('）', at) + 1); }
    try {
      const p = await ipcRenderer.invoke('hub-feedback:preview', {});
      if (!contactEdited && !sending && p && typeof p.contact === 'string') dialog.querySelector('[data-hf="contact"]').value = p.contact;
      const items = (p && p.items) || [];
      dialog.querySelector('[data-hf="items"]').innerHTML = (items.map(i => `<li>${esc(i.name)}${i.detail ? ' · ' + esc(i.detail) : ''}</li>`).join('') || '<li>只有问题描述</li>')
        + (p && p.pending ? `<li data-hf="pending">另有 ${Number(p.pending)} 条反馈等维护人电脑上线后自动补发</li>` : '');
    } catch (error) {
      dialog.querySelector('[data-hf="items"]').innerHTML = `<li>整理附带内容失败：${esc(error.message)}</li>`;
    }
    // 发到哪儿（r42）：公司内网的维护人电脑，还是公司外用户的阿里云。公开版要探一次内源，最多约 3 秒。
    try {
      const r = await ipcRenderer.invoke('hub-feedback:route');
      via = (r && r.via) || '';
      if (via === 'intranet') dialog.querySelector('[data-hf="to"]').textContent = TO_INTRANET;
    } catch { /* 沿用默认文案 */ }
  }

  async function send() {
    if (sending) return;
    const desc = dialog.querySelector('[data-hf="desc"]').value;
    if (!desc.trim()) { message('warn', '请先写一句遇到了什么问题'); dialog.querySelector('[data-hf="desc"]').focus(); return; }
    sending = true;
    const btn = dialog.querySelector('[data-hf="send"]');
    btn.disabled = true; btn.textContent = '正在发送…';
    message('info', via === 'intranet' ? '正在发给维护人（公司内网）…' : '正在发送，公司网络需要放行时会自动处理，最多约两分钟');
    const onProgress = (_e, p) => { if (p && p.phase === 'intranet') message('info', '正在发给维护人（公司内网）…'); else if (p && p.click)message('info', p.phase === 'unblocking' ? `公司网络要求放行，正在后台自动放行（第 ${p.click}/${p.maxClicks} 次）…` : p.phase === 'window' ? `改用后台窗口直接提交（第 ${p.click} 次）…` : `已点放行，正在重发（第 ${p.click}/${p.maxClicks} 轮）…`); };
    ipcRenderer.on('hub-feedback:progress', onProgress);
    let r;
    try { r = await ipcRenderer.invoke('hub-feedback:send', { description: desc, contact: dialog.querySelector('[data-hf="contact"]').value }); }
    catch (error) { r = { ok: false, reason: error.message }; }
    finally { ipcRenderer.removeListener('hub-feedback:progress', onProgress); }
    sending = false;
    if (r && r.ok) {
      btn.textContent = '已发送';
      message('ok', `${r.via === 'intranet' ? '已发给维护人（公司内网）' : '已发送'}，反馈编号 <b>${esc(r.id)}</b>。维护人会根据附带的日志排查。`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    lastText = (r && r.text) || '';
    const copy = lastText ? ` <a href="#" data-hf-copy>复制内容</a>` : '';
    // 内网没送到（维护人电脑不在线等）：已进待发队列，后台自动补发；这条不算失败，不让用户反复点。
    if (r && r.queued) {
      btn.textContent = '已存好';
      const where = r.savedTo ? `<br>同样的内容也存到了：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a>` : '';
      message('warn', `维护人电脑暂时不在线，已存好，会自动补发（每 10 分钟试一次，最多 7 天）。${where}<br>着急的话可以${copy || '把上面的文件'}贴到 WeLink 发给维护人。<br><small>原因：${esc(r.reason || '未知')}</small>`);
      dialog.querySelector('[data-hf="desc"]').value = '';
      return;
    }
    btn.disabled = false; btn.textContent = '重新发送';
    const saved = r && r.savedTo ? `<br>同样的内容已存到：<span class="hf-path">${esc(r.savedTo)}</span> <a href="#" data-hf-open="${esc(r.savedTo)}">打开所在文件夹</a>${copy}，可以手动发给维护人。` : '';
    // 被公司网络放行页拦着（公开版不在后台自动点）：给按钮在 Hub 里打开放行页，点完回来点「重新发送」。
    const gate = r && r.blocked ? `<br>公司网络要求放行：<a href="#" data-hf-unblock="${esc(r.url || '')}">打开放行页</a>，在页面上点「接受风险并访问」（或左边那个放行按钮），再回来点「重新发送」。` : '';
    message('bad', `没发出去：${esc((r && r.reason) || '未知原因')}${gate}${saved}`);
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
