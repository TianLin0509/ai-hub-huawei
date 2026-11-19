'use strict';
// 首页「连接你的 AI」里的「用 API key 开始」（2026-11-19 定方案 A）：部门 API key 用户不装 CodeAgent 也能开会话。
// 本机没有 CodeAgent、也还没配网关时醒目显示并标推荐；已有 CodeAgent 的用户只看到一行小字入口，默认行为不变。
// 就地完成：网关地址已预填，粘 key →「保存并继续」当场验证（请求一次模型列表）→ 选默认模型。Key 只在主进程加密保存。
(() => {
  const distribution = require('../core/distribution');
  if (distribution.target !== 'company') return;
  const { ipcRenderer } = require('electron');
  const KINDS = ['claude', 'codex', 'deepseek-acp'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // draft：用户在表单里填了还没保存成功的地址和 key，重画（报错、验证中）时原样保留，不让他重填（E2E 实测发现）。
  let state = { gateway: null, codeagent: null, claude: null, expanded: false, editAddr: false, busy: false, error: null, justSaved: false, draft: { baseURL: null, apiKey: '' } };
  let box = null;

  function mount() {
    const section = document.getElementById('community-setup');
    if (!section) return false;
    if (!box) {
      box = document.createElement('div');
      box.id = 'api-gateway-start';
      box.className = 'api-gw';
      section.querySelector('#community-providers')?.after(box);
    }
    return true;
  }
  const recommended = () => state.codeagent === false && !state.gateway?.keySet;

  function modelsHtml() {
    const g = state.gateway;
    return '<div class="api-gw-models" role="radiogroup" aria-label="默认模型">' + (g.choices || []).map(c =>
      `<button type="button" role="radio" data-gw-model="${esc(c.id)}" aria-checked="${c.id === g.model}"><b>${esc(c.id)}</b>${c.note ? `<span>${esc(c.note)}</span>` : ''}</button>`).join('') + '</div>';
  }
  function render() {
    if (!mount()) return;
    const g = state.gateway;
    if (!g) { box.innerHTML = ''; return; }
    if (g.keySet && !state.justSaved && !state.expanded) {
      // 已配好：一行状态，不占地方。
      box.innerHTML = `<p class="api-gw-line"><span class="api-gw-dot" aria-hidden="true"></span>API 网关已连接 · ${g.models.length} 个模型 · 默认 ${esc(g.model)}`
        + ' <button type="button" class="api-gw-link" data-gw="expand">更换 key 或模型</button></p>';
      return bind();
    }
    if (!recommended() && !state.expanded && !state.justSaved) {
      box.innerHTML = '<p class="api-gw-line">有部门的 API key？<button type="button" class="api-gw-link" data-gw="expand">用 API key 开始</button></p>';
      return bind();
    }
    if (state.justSaved) {
      const needCli = state.claude === false ? '<p class="api-gw-note">还差一步：Claude Code 显示「未安装」，点它旁边的「安装」即可（也可以先用 Codex）。</p>' : '';
      box.innerHTML = '<div class="api-gw-card"><h3>已连通，选一个默认模型</h3>'
        + `<p class="api-gw-ok">API 网关已连通 · 找到 ${g.models.length} 个模型${g.unlimited ? ' · 额度不限' : ''} · key 已用 Windows 账户加密保存</p>`
        + modelsHtml() + needCli
        + '<div class="api-gw-actions"><button type="button" class="primary" data-gw="start">开始第一个会话</button><button type="button" data-gw="done">完成</button></div>'
        + '<p class="api-gw-msg" role="status" aria-live="polite"></p></div>';
      return bind();
    }
    const err = state.error;
    box.innerHTML = `<div class="api-gw-card${recommended() ? ' rec' : ''}"><h3>用 API key 开始${recommended() ? ' <span class="api-gw-tag">推荐 · 本机没有 CodeAgent</span>' : ''}</h3>`
      + '<p class="api-gw-note">适合部门发了 API key、没有 CodeAgent 账号的同事。Claude Code、Codex、DSH 会话都会走这个 key。</p>'
      + `<label>网关地址 ${state.editAddr ? '' : '<span class="api-gw-tag gray">已预填</span> <button type="button" class="api-gw-link" data-gw="addr">改地址</button>'}`
      + `<input name="baseURL" value="${esc(state.draft.baseURL ?? g.baseURL)}" ${state.editAddr ? '' : 'readonly'} spellcheck="false" autocomplete="off"></label>`
      + `<label>API key <span class="api-gw-note-inline">只存在本机，用 Windows 账户加密</span>`
      + `<input name="apiKey" type="password" value="${esc(state.draft.apiKey)}" placeholder="${g.keySet ? '已保存；留空保留原 key' : '粘贴 sk- 开头的 key'}" spellcheck="false" autocomplete="off"${err?.code === 'bad_key' ? ' aria-invalid="true"' : ''}></label>`
      + (state.busy ? '<p class="api-gw-msg busy" role="status">正在验证：向网关请求模型列表…（通常 1 秒内）</p>' : '')
      + (err ? `<div class="api-gw-err" role="alert"><span>${esc(err.message)}</span><button type="button" data-gw="save">${err.code === 'unreachable' ? '重试' : '重新验证'}</button>${err.code === 'unreachable' && !state.editAddr ? '<button type="button" data-gw="addr">改地址</button>' : ''}</div>` : '')
      + `<div class="api-gw-actions"><button type="button" class="primary" data-gw="save"${state.busy ? ' disabled' : ''}>保存并继续</button>`
      + (g.keySet || !recommended() ? '<button type="button" data-gw="collapse">收起</button>' : '') + '<span class="api-gw-note-inline">点一下就会验证，不用去设置页</span></div></div>';
    bind();
  }
  function bind() {
    box.querySelectorAll('[data-gw]').forEach(button => { button.onclick = () => void act(button.dataset.gw); });
    box.querySelectorAll('[data-gw-model]').forEach(button => { button.onclick = () => void pickModel(button.dataset.gwModel); });
    const key = box.querySelector('input[name="apiKey"]');
    if (key) key.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void act('save'); } };
    for (const input of box.querySelectorAll('input[name="baseURL"], input[name="apiKey"]')) input.oninput = () => { state.draft[input.name] = input.value; };
  }
  async function act(what) {
    if (what === 'expand') { state.expanded = true; state.justSaved = false; return render(); }
    if (what === 'collapse' || what === 'done') { state.expanded = false; state.justSaved = false; state.error = null; return render(); }
    if (what === 'addr') { state.editAddr = true; return render(); }
    if (what === 'start') { state.justSaved = false; state.expanded = false; render(); document.getElementById('btn-new')?.click(); return; }
    if (what !== 'save' || state.busy) return;
    const baseURL = box.querySelector('input[name="baseURL"]')?.value || state.gateway.baseURL;
    const apiKey = box.querySelector('input[name="apiKey"]')?.value || '';
    if (!apiKey && !state.gateway.keySet) { state.error = { code: 'no_key', message: '请先粘贴 API key。' }; return render(); }
    state.draft = { baseURL, apiKey };
    state.busy = true; state.error = null; render();
    try {
      // 第一次配：三种会话一起切到 API 网关（没有 CodeAgent 时它们本来就用不了公司模型）；之后只换 key 不动线路。
      const useFor = state.gateway.keySet ? [] : KINDS;
      const result = await ipcRenderer.invoke('api-gateway:save', { baseURL, apiKey, useFor });
      if (result?.gateway) state.gateway = result.gateway;
      if (!result?.ok) { state.error = { code: result?.code || 'error', message: result?.error || '保存没成功，请重试。' }; return; }
      state.justSaved = true; state.expanded = false; state.editAddr = false; state.draft = { baseURL: null, apiKey: '' };
    } catch (error) { state.error = { code: 'error', message: '保存没成功：' + error.message }; }
    finally { state.busy = false; render(); }
  }
  async function pickModel(model) {
    const msg = () => box.querySelector('.api-gw-msg');
    try {
      const result = await ipcRenderer.invoke('api-gateway:set-model', { model });
      if (result?.gateway) state.gateway = result.gateway;
      // 已切到网关的会话种类也换成这个默认模型。
      for (const kind of KINDS) {
        const p = result?.providers?.[kind];
        if (p?.backend === 'proxy' && p.upstream === 'gateway') await ipcRenderer.invoke('company-api:save', { kind, backend: 'gateway', model });
      }
      render();
      if (msg()) msg().textContent = `默认模型已改为 ${model}，新建会话生效。`;
    } catch (error) { if (msg()) msg().textContent = '没改成：' + error.message; }
  }
  async function refresh() {
    try {
      const [gw, setup] = await Promise.all([ipcRenderer.invoke('api-gateway:get'), ipcRenderer.invoke('community:setup')]);
      state.gateway = gw?.gateway || state.gateway;
      const find = id => setup?.providers?.find(p => p.id === id);
      state.codeagent = find('codeagent') ? !!find('codeagent').installed : null;
      state.claude = find('claude') ? !!find('claude').installed : null;
    } catch { /* 首页其余部分照常 */ }
    render();
  }
  function init() {
    let tries = 0;
    const wait = () => { if (mount()) { void refresh(); return; } if (++tries < 40) setTimeout(wait, 250); };
    wait();
    document.addEventListener('click', event => { if (event.target?.id === 'community-refresh') setTimeout(() => void refresh(), 300); });
    ipcRenderer.on('company-api:changed', () => { if (!state.busy) void refresh(); });
    window.__apiGatewayStart = () => { state.expanded = true; render(); box?.scrollIntoView({ block: 'center' }); box?.querySelector('input[name="apiKey"]')?.focus(); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
