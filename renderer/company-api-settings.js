'use strict';

(() => {
  const distribution = require('../core/distribution');
  if (distribution.target !== 'company') return;
  const { ipcRenderer, shell } = require('electron');
  const { KINDS, LABELS } = require('../core/company-api-config');
  let snapshot = null;
  let setup = null;
  let dialog = null;
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function close() { dialog?.close(); }
  function makeDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'company-api-dialog';
    dialog.className = 'company-api-dialog';
    dialog.setAttribute('aria-label', '自有 API');
    dialog.addEventListener('close', () => { dialog.remove(); dialog = null; });
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
    });
    document.body.append(dialog);
    document.getElementById('config-modal')?.classList.add('hidden');
    dialog.showModal();
    return dialog;
  }
  function heading(title, hint) {
    return `<header><div><h2>${esc(title)}</h2><p>${esc(hint)}</p></div><button type="button" class="company-api-close" aria-label="关闭">×</button></header>`;
  }
  function bindClose(target) { target.querySelector('.company-api-close').onclick = close; }
  async function refreshInstall() {
    setup = await ipcRenderer.invoke('community:setup');
    for (const kind of ['claude', 'codex']) {
      const button = document.querySelector(`.new-session-option[data-kind="${kind}"]`);
      const provider = setup.providers?.find(p => p.id === kind);
      if (!button || !provider) continue;
      button.dataset.installed = provider.installed ? '1' : '0';
      let badge = button.querySelector('.company-cli-status');
      if (!badge) { badge = document.createElement('small'); badge.className = 'company-cli-status'; button.append(badge); }
      badge.textContent = provider.installed ? '' : '未安装';
      badge.hidden = provider.installed;
    }
    const dsh = document.querySelector('.new-session-option[data-kind="deepseek"]');
    if (dsh) {
      const response = await ipcRenderer.invoke('company-api:get');
      dsh.dataset.installed = '0';
      let badge = dsh.querySelector('.company-cli-status');
      if (!badge) { badge = document.createElement('small'); badge.className = 'company-cli-status'; dsh.append(badge); }
      badge.textContent = response?.dshRuntimeInstalled ? '待接入' : '未安装';
    }
    return setup;
  }
  function showInstall(kind) {
    const target = makeDialog();
    const provider = setup?.providers?.find(p => p.id === kind);
    if (kind === 'deepseek-acp') {
      target.innerHTML = heading('安装 DSH 运行环境', '自有接口运行接入尚未就绪，当前可先保存配置。')
        + '<div class="company-api-install"><ol><li>安装组织提供的 DSH 运行环境（Node 和 DSH 入口脚本）。</li><li>完成 Hub 与运行环境的接线后，再使用自有 API 配置创建会话。</li><li>目前可先使用已安装的 Claude Code 或 Codex。</li></ol></div><footer><button type="button" data-api-action="configure">配置接口</button></footer>';
      bindClose(target);
      target.querySelector('[data-api-action="configure"]').onclick = () => void open(kind);
      return;
    }
    target.innerHTML = heading(`安装 ${LABELS[kind]}`, '安装完成后可沿用本机配置，或填写自己的 API 接口。')
      + `<div class="company-api-install"><span class="company-api-tag">未安装</span><ol><li>按官方说明安装 ${esc(LABELS[kind])} CLI${kind === 'claude' ? '，Windows 同时需要 Git for Windows' : ''}。</li><li>完成安装后点击「重新检测」。</li><li>需要自有接口时，到「自有 API」填写配置。</li></ol></div>`
      + '<p class="company-api-message" role="status"></p><footer><button type="button" data-api-action="docs">查看安装说明</button><button type="button" class="primary" data-api-action="refresh">重新检测</button></footer>';
    bindClose(target);
    target.querySelector('[data-api-action="docs"]').onclick = () => { if (provider?.docs) void shell.openExternal(provider.docs); };
    target.querySelector('[data-api-action="refresh"]').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        await refreshInstall();
        if (setup.providers?.find(p => p.id === kind)?.installed) { await open(kind); return; }
        target.querySelector('[role="status"]').textContent = '还未检测到 CLI。请完成安装后重试，或检查安装目录是否已加入 PATH。';
      } catch { target.querySelector('[role="status"]').textContent = '检测失败，请稍后重试。'; }
      finally { target.querySelector('[data-api-action="refresh"]')?.removeAttribute('disabled'); }
    };
  }
  function render(kind) {
    const target = makeDialog();
    const value = snapshot?.providers?.[kind] || {};
    target.innerHTML = heading('自有 API', '选填覆盖项；留空沿用 CLI 本机登录与配置。')
      + `<nav aria-label="API 工具">${KINDS.map(id => `<button type="button" data-api-kind="${id}" aria-pressed="${id === kind}">${LABELS[id]}</button>`).join('')}</nav>`
      + `<form data-api-form><label>接口地址<input name="baseURL" type="url" value="${esc(value.baseURL)}" placeholder="留空沿用本机配置" autocomplete="off" spellcheck="false"></label>`
      + `<label>API Key<input name="apiKey" type="password" placeholder="${value.apiKeySet ? '已保存；留空保留原 Key' : '可选；留空沿用本机登录'}" autocomplete="off" spellcheck="false"></label>`
      + `<label>模型<input name="model" value="${esc(value.model)}" placeholder="留空沿用 CLI 配置的模型" autocomplete="off" spellcheck="false"></label>`
      + (kind === 'codex' ? `<label>接口协议<select name="wireApi"><option value="responses"${value.wireApi === 'chat' ? '' : ' selected'}>responses（默认）</option><option value="chat"${value.wireApi === 'chat' ? ' selected' : ''}>chat</option></select></label>` : '')
      + (kind === 'deepseek-acp' ? '<p class="company-api-note">可先保存接口。DSH 公司接口的运行接入尚未就绪，当前可使用 Claude Code 或 Codex。</p>' : '<p class="company-api-note">Key 仅保存在本机配置中，重新打开时不会显示。进行中的会话保持原配置。</p>')
      + '<p class="company-api-message" role="status" aria-live="polite"></p><footer><button type="button" data-api-action="local">沿用本机配置</button><button type="button" data-api-action="close">取消</button><button type="submit" class="primary">保存配置</button></footer></form>';
    bindClose(target);
    target.querySelectorAll('[data-api-kind]').forEach(button => { button.onclick = () => render(button.dataset.apiKind); });
    target.querySelector('[data-api-action="close"]').onclick = close;
    target.querySelector('[data-api-action="local"]').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await ipcRenderer.invoke('company-api:save', { kind, useLocal: true });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = result;
        render(kind);
        dialog.querySelector('[role="status"]').textContent = '已清除 Hub 的接口覆盖；新建会话沿用本机配置。';
      } catch (error) { target.querySelector('[role="status"]').textContent = error.message; }
      finally { event.currentTarget?.removeAttribute('disabled'); }
    };
    target.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const save = form.querySelector('[type="submit"]');
      const status = form.querySelector('[role="status"]');
      save.disabled = true;
      status.textContent = '正在保存…';
      try {
        const request = Object.fromEntries(new FormData(form));
        const result = await ipcRenderer.invoke('company-api:save', { kind, ...request });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = result;
        form.elements.apiKey.value = '';
        form.elements.apiKey.required = false;
        form.elements.apiKey.placeholder = result.providers?.[kind]?.apiKeySet ? '已保存；留空保留原 Key' : '可选；留空沿用本机登录';
        status.textContent = kind === 'deepseek-acp' ? '配置已保存，运行接入尚未就绪。' : '已保存。新建会话使用这些设置。';
      } catch (error) { status.textContent = '保存失败：' + error.message; }
      finally { save.disabled = false; }
    };
  }
  async function open(kind = 'claude') {
    const target = makeDialog();
    target.innerHTML = heading('自有 API', '正在读取配置…');
    bindClose(target);
    try {
      snapshot = await ipcRenderer.invoke('company-api:get');
      if (!snapshot?.ok) throw new Error('配置无法读取');
      if (target === dialog) render(KINDS.includes(kind) ? kind : 'claude');
    } catch { if (target === dialog) { target.innerHTML = heading('无法读取 API 配置', '现有配置未改动，请稍后重试。'); bindClose(target); } }
  }
  function init() {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'styles/company-api-settings.css' });
    document.head.append(link);
    const settings = document.querySelector('#config-main-view');
    if (settings) {
      settings.querySelector('#cfg-proxy')?.closest('.config-field')?.setAttribute('hidden', '');
      const hint = settings.querySelector('.config-hint');
      if (hint) hint.textContent = '管理自有 API、通知与显示。CodeAgent 号池在左侧「账号」页管理。';
      const row = document.createElement('div');
      row.className = 'company-api-settings-entry';
      row.innerHTML = '<div><strong>自有 API</strong><p>Claude Code · Codex · DSH</p></div><button type="button" id="company-api-settings-open">配置接口</button>';
      settings.prepend(row);
      row.querySelector('button').onclick = () => void open();
    }
    document.getElementById('account-editor')?.setAttribute('hidden', '');
    // Capture precedes the launch controller: selecting a missing CLI explains
    // installation immediately and cannot accidentally submit a session.
    document.getElementById('new-session-menu')?.addEventListener('click', event => {
      const button = event.target.closest('.new-session-option[data-kind]');
      if (button && ['claude', 'codex', 'deepseek'].includes(button.dataset.kind) && button.dataset.installed === '0') {
        event.preventDefault(); event.stopImmediatePropagation(); showInstall(button.dataset.kind === 'deepseek' ? 'deepseek-acp' : button.dataset.kind);
      }
    }, true);
    window.__companyApiOpen = open;
    void refreshInstall().catch(() => {});
    document.getElementById('community-refresh')?.addEventListener('click', () => void refreshInstall().catch(() => {}));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
