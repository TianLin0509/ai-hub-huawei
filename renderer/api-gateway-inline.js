'use strict';
// 启动中心里就地配 API 网关（2026-11-19 同事反馈「找不到配置入口」）：模型卡里点「用部门 API key」，
// 卡片下面直接展开——先列出在别的工具里检测到的 key（一键用），没有就粘贴；地址已预填。
// 保存成功后三种会话一起切到网关，启动中心马上出现网关模型卡并选中默认模型，直接点「创建」即可。
const KINDS = ['claude', 'codex', 'deepseek-acp'];

function createGatewayInline({ document, ipcRenderer, escapeHtml, onSaved = () => {} }) {
  let host = null, state = null;
  const reset = () => ({ open: false, busy: false, error: '', found: null, editAddr: false, draft: { baseURL: null, apiKey: '' }, gateway: null });
  state = reset();

  function render() {
    if (!host) return;
    if (!state.open) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const g = state.gateway || {};
    const found = (state.found || []).slice(0, 3);
    host.innerHTML = '<div class="gw-inline-head"><b>用部门 API key</b><span>没有 CodeAgent 账号也能用 Claude Code、Codex、DSH，key 只存在本机并用 Windows 账户加密。</span></div>'
      + (found.length ? '<div class="gw-inline-found">' + found.map(f =>
        `<div class="gw-inline-hit"><span>检测到你在「${escapeHtml(f.source)}」里用过 API 网关 key <code>${escapeHtml(f.masked)}</code></span>`
        + `<button type="button" class="primary" data-gwi="adopt" data-id="${escapeHtml(f.id)}"${state.busy ? ' disabled' : ''}>用这个 key</button></div>`).join('') + '</div>' : '')
      + '<div class="gw-inline-form">'
      + `<label><span class="gw-inline-lab">网关地址${state.editAddr ? '' : ' <button type="button" class="gw-inline-link" data-gwi="addr">改地址</button>'}</span>`
      + `<input name="gwBaseURL" value="${escapeHtml(state.draft.baseURL ?? g.baseURL ?? '')}" ${state.editAddr ? '' : 'readonly'} spellcheck="false" autocomplete="off"></label>`
      + `<label><span class="gw-inline-lab">${found.length ? '或粘贴别的 key' : 'API key'}</span><input name="gwApiKey" type="password" value="${escapeHtml(state.draft.apiKey)}" placeholder="粘贴 sk- 开头的 key" spellcheck="false" autocomplete="off"></label>`
      + `<button type="button" class="primary" data-gwi="save"${state.busy ? ' disabled' : ''}>保存并继续</button></div>`
      + `<p class="gw-inline-msg" role="status" aria-live="polite" data-state="${state.error ? 'error' : state.busy ? 'busy' : ''}">${escapeHtml(state.error || (state.busy ? '正在验证：向网关请求模型列表…' : ''))}</p>`;
    host.querySelectorAll('[data-gwi]').forEach(b => { b.onclick = () => void act(b.dataset.gwi, b.dataset.id); });
    for (const input of host.querySelectorAll('input')) input.oninput = () => { state.draft[input.name === 'gwBaseURL' ? 'baseURL' : 'apiKey'] = input.value; };
    const key = host.querySelector('input[name="gwApiKey"]');
    if (key) key.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void act('save'); } };
  }

  async function act(what, id) {
    if (what === 'addr') { state.editAddr = true; return render(); }
    if (state.busy) return;
    const useFor = state.gateway?.keySet ? [] : KINDS;
    let request;
    if (what === 'adopt') request = ipcRenderer.invoke('api-gateway:adopt', { id, useFor });
    else {
      const apiKey = state.draft.apiKey.trim();
      if (!apiKey) { state.error = '请先粘贴 API key。'; return render(); }
      request = ipcRenderer.invoke('api-gateway:save', { baseURL: state.draft.baseURL ?? state.gateway?.baseURL, apiKey, useFor });
    }
    state.busy = true; state.error = ''; render();
    try {
      const result = await request;
      if (result?.gateway) state.gateway = result.gateway;
      if (!result?.ok) { state.error = result?.error || '保存没成功，请重试。'; return; }
      state.open = false; state.draft = { baseURL: null, apiKey: '' };
      onSaved(result.gateway);
    } catch (error) { state.error = '保存没成功：' + error.message; }
    finally { state.busy = false; render(); }
  }

  return {
    get isOpen() { return state.open; },
    attach(element) { host = element; render(); },
    async open() {
      state.open = true; state.error = ''; render();
      const [gw, det] = await Promise.all([ipcRenderer.invoke('api-gateway:get').catch(() => null), ipcRenderer.invoke('api-gateway:detect').catch(() => null)]);
      state.gateway = gw?.gateway || state.gateway; state.found = det?.found || [];
      render();
      host?.querySelector(state.found.length ? '[data-gwi="adopt"]' : 'input[name="gwApiKey"]')?.focus();
    },
    close() { state = { ...reset(), gateway: state.gateway }; render(); },
  };
}

module.exports = { createGatewayInline };
