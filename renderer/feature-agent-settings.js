'use strict';
// 全局设置和功能入口共用行组件与 IPC；即时保存，不改启动中心的默认模型。
(function featureAgentSettings() {
  const { ipcRenderer } = require('electron');
  const choiceValues = require('../core/codeagent-model-choice');
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let state = null, popup = null, group = 'common';
  function modelsFor(f, backend) {
    const models = backend?.models || [];
    if (!['help', 'pptMap', 'progress'].includes(f.id)) return models;
    return [...new Map(models.map(m => [m.id, { id: m.id, label: m.id, unavailable: m.unavailable }])).values()];
  }
  const style = document.createElement('style');
  style.textContent = `
    #cfg-feature-agents { padding:8px 0; }
    .fa-group-tabs { display:flex; gap:8px; margin-bottom:12px; }
    .fa-group-tabs button { padding:5px 14px; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; }
    .fa-group-tabs button[aria-selected=true] { color:var(--brand,#3478f6); background:var(--brand-tint,#eaf2ff); }
    #config-modal:has(#cfg-tab-agents[aria-selected=true]) .config-modal-content { max-width:1000px; width:calc(100vw - 80px); }
    .fa-row { display:grid; grid-template-columns:minmax(155px,1fr) 175px minmax(0,1.6fr) 66px; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-subtle,#dfe3ea); }
    .fa-row label { font-size:13px; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fa-row select { width:100%; min-width:0; height:32px; padding:0 7px; color:var(--text-primary,#242a33); background:var(--bg-input,#fff); border:1px solid var(--border-subtle,#dfe3ea); border-radius:6px; font:12px 'Microsoft YaHei',sans-serif; }
    .fa-reset,.fa-entry { border:0; border-radius:5px; color:var(--brand,#3478f6); background:transparent; padding:5px 6px; cursor:pointer; white-space:nowrap; font:12px 'Microsoft YaHei',sans-serif; }
    .fa-row .fa-warning { grid-column:1/-1; color:var(--hw-amber,#966019); font-size:12px; }
    .fa-inline-warning { display:flex; align-items:center; gap:4px; margin:0 16px 6px; min-width:0; font:12px 'Microsoft YaHei',sans-serif; color:var(--hw-amber,#966019); }
    .fa-inline-warning span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fa-inline-warning button { flex:none; }
    .fa-popup { position:fixed; z-index:10020; width:min(720px,calc(100vw - 32px)); padding:16px; border:1px solid var(--border-subtle,#dfe3ea); border-radius:10px; background:var(--bg-primary,#fff); color:var(--text-primary,#242a33); box-shadow:0 8px 32px #0002; }
    .fa-popup header { display:flex; justify-content:space-between; align-items:center; }
    .fa-popup header button { border:0; background:transparent; color:inherit; cursor:pointer; }
    .fa-popup .fa-row { grid-template-columns:120px 140px minmax(180px,1fr) 66px; }
    #cfg-feature-agents [role=status] { font-size:12px; min-height:18px; }
  `;
  document.head.append(style);
  function rows(host, ids) {
    if (host.id === 'cfg-feature-agents' && !ids) {
      host.innerHTML = `<div class="fa-group-tabs" role="tablist" aria-label="功能分类"><button type="button" data-fa-group="common" aria-selected="${group === 'common'}">日常功能</button><button type="button" data-fa-group="ppt" aria-selected="${group === 'ppt'}">PPT</button></div><div id="fa-settings-page" data-fa-page></div>`;
      rows(host.querySelector('[data-fa-page]'), state.features.filter(f => f.id.startsWith('ppt') === (group === 'ppt')).map(f => f.id));
      return;
    }
    const features = state?.features.filter(f => !ids || ids.includes(f.id)) || [];
    host.innerHTML = features.map(f => {
      const selected = f.choice, backend = state.backends.find(b => b.kind === selected?.kind);
      const models = modelsFor(f, backend);
      const current = selected?.model ? choiceValues.choiceValue({ id: selected.model, ...selected, provider: selected.codeagentModelProvider,
        providerLabel: selected.codeagentModelProviderLabel, menuLabel: selected.codeagentModelMenuLabel }) : '';
      const backendOptions = state.backends.filter(b => f.kinds.includes(b.kind) && (b.available || b.kind === selected?.kind));
      const defaultBackend = f.id === 'meeting' ? '默认·会议所选' : `默认（当前：${f.defaultText.split(' · ')[0]}）`;
      const backendTitle = selected ? backend?.label || selected.kind : `默认（当前：${f.defaultText}）`;
      return `<div class="fa-row" data-fa-row="${f.id}"><label for="fa-backend-${host.id}-${f.id}">${esc(f.label)}</label>
        <select data-fa-backend id="fa-backend-${host.id}-${f.id}" aria-label="${esc(f.label)}后端" title="${esc(backendTitle)}"><option value="" title="${esc(f.defaultText)}">${esc(defaultBackend)}</option>${backendOptions.map(b => `<option value="${esc(b.kind)}"${b.kind === selected?.kind ? ' selected' : ''}${b.available ? '' : ' disabled'}>${esc(b.label)}${b.available ? '' : '（不可用）'}</option>`).join('')}</select>
        <select data-fa-model aria-label="${esc(f.label)}模型"${selected ? '' : ' disabled'}><option value="">默认（当前：${esc(backend?.defaultModel || f.defaultText)}）</option>${selected?.model && !models.some(m => choiceValues.choiceValue(m) === current) ? `<option selected value="${esc(current)}">${esc(selected.model)}（不可用）</option>` : ''}${models.map(m => `<option value="${esc(choiceValues.choiceValue(m))}"${choiceValues.choiceValue(m) === current ? ' selected' : ''}${m.unavailable ? ' disabled' : ''}>${esc(m.label || m.id)}</option>`).join('')}</select>
        ${selected ? '<button class="fa-reset" data-fa-reset type="button">恢复默认</button>' : ''}${f.warning ? `<span class="fa-warning" role="status">${esc(f.warning)}</span>` : ''}</div>`;
    }).join('') + '<div role="status" data-fa-message></div>';
    if (host.id === 'fa-assistant-settings') {
      const overridden = features.filter(f => f.selected).map(f => f.id === 'avatar' ? '分身' : '助理');
      if (overridden.length) {
        const note = document.createElement('p'); note.className = 'fa-legacy-override'; note.setAttribute('role', 'status');
        note.textContent = `${overridden.join('、')}正在使用功能选型，下方供应商默认设置暂不生效。`; host.append(note);
      }
    }
  }
  async function load() {
    const result = await ipcRenderer.invoke('feature-agents:get');
    if (!result?.ok) throw new Error(result?.error || '模型清单读取失败');
    state = result; return result;
  }
  function refresh() {
    const host = document.getElementById('cfg-feature-agents');
    if (host && state) rows(host);
    if (popup && state) rows(popup.querySelector('[data-fa-body]'), popup._ids);
    document.querySelectorAll('[data-feature-agents]').forEach(host => rows(host, host.dataset.featureAgents.split(',')));
    mount();
  }
  async function save(row, choice) {
    const host = row.parentElement, message = host.querySelector('[data-fa-message]');
    row.querySelectorAll('select,button').forEach(el => { el.disabled = true; });
    try {
      const result = await ipcRenderer.invoke('feature-agents:set', { feature: row.dataset.faRow, choice });
      if (!result?.ok) throw new Error(result?.error || '保存失败');
      state = result; refresh();
      (document.getElementById(host.id) || host).querySelector('[data-fa-message]').textContent = '已保存，下次任务生效';
    } catch (error) {
      message.textContent = error.message;
      row.querySelectorAll('select,button').forEach(el => { el.disabled = false; });
    }
  }
  document.addEventListener('change', event => {
    const row = event.target.closest('[data-fa-row]'); if (!row) return;
    if (event.target.matches('[data-fa-backend]')) {
      void save(row, event.target.value ? { kind: event.target.value, model: '' } : null);
    } else if (event.target.matches('[data-fa-model]')) {
      const choice = choiceValues.decodeChoice(event.target.value);
      void save(row, { kind: row.querySelector('[data-fa-backend]').value, model: choice.id, ...choiceValues.routeFields(choice) });
    }
  });
  function close() { popup?.remove(); popup = null; }
  async function open(ids, anchor) {
    close();
    popup = document.createElement('section'); popup.className = 'fa-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', '功能使用的 Agent');
    popup.innerHTML = '<header><strong>功能使用的 Agent</strong><button type="button" data-fa-close aria-label="关闭">✕</button></header><div id="fa-popup-body" data-fa-body role="group">正在读取模型…</div>';
    popup._ids = ids; document.body.append(popup);
    const box = anchor?.getBoundingClientRect();
    popup.style.top = `${Math.min(box?.bottom || 100, window.innerHeight - 310)}px`;
    popup.style.left = `${Math.max(16, Math.min(box?.left || 300, window.innerWidth - 752))}px`;
    popup.querySelector('[data-fa-close]').focus();
    try { await load(); refresh(); } catch (error) { if (popup) popup.querySelector('[data-fa-body]').textContent = error.message; }
  }
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-fa-group]');
    if (tab) { group = tab.dataset.faGroup; refresh(); return; }
    const entry = event.target.closest('[data-feature-agent]');
    if (entry) { void open(entry.dataset.featureAgent.split(','), entry); return; }
    if (event.target.closest('[data-fa-close]')) { close(); return; }
    const reset = event.target.closest('[data-fa-reset]');
    if (reset) { void save(reset.closest('[data-fa-row]'), null); return; }
    if (popup && !popup.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && popup) { event.stopPropagation(); close(); } }, true);
  // 功能页面按需加载、重绘后重挂入口；只监听结构变化，不轮询。
  const entries = [['#help-ask-panel .ha-tools', 'help'], ['.company-ppt-page .pptw-head-right', 'ppt,pptMap,pptMake,pptImgtext'],
    ['#company-assistant-page .ca-head-right', 'assistant'], ['.avx-head .avx-right', 'avatar'], ['.cf-head', 'forum'], ['.pg-head', 'progress'], ['.meeting-topbar .meeting-actions', 'meeting'], ['.prompt-polish-tools', 'text']];
  function mount() {
    const view = document.getElementById('config-main-view');
    if (view && !document.getElementById('cfg-feature-agents')) {
      const host = document.createElement('div'); host.id = 'cfg-feature-agents'; host.setAttribute('aria-label', '功能使用的 Agent'); view.append(host);
      host.textContent = '正在读取模型…';
    }
    for (const [selector, id] of entries) for (const head of document.querySelectorAll(selector)) {
      let b = head.querySelector(`[data-feature-agent="${id}"]`);
      if (!b) {
        b = document.createElement('button'); b.type = 'button'; b.className = 'fa-entry'; b.dataset.featureAgent = id;
        b.title = '选择这个功能使用的 Agent 与模型'; head.append(b);
      }
      const f = state?.features.find(f => f.id === id.split(',')[0]);
      const label = f?.choice ? `⚙ ${state.backends.find(b => b.kind === f.choice.kind)?.label || f.choice.kind}` : '⚙ Agent';
      if (b.textContent !== label) b.textContent = label;
      for (const f of state?.features.filter(f => id.split(',').includes(f.id)) || []) {
        const header = head.closest('header') || head;
        let hint = header.parentElement.querySelector(`[data-fa-unavailable="${f.id}"]`);
        if (!f.warning) { hint?.remove(); continue; }
        if (!hint) {
          hint = document.createElement('div'); hint.dataset.faUnavailable = f.id; hint.className = 'fa-inline-warning'; hint.setAttribute('role', 'status');
          const text = document.createElement('span'); text.textContent = '所选后端或模型不可用，本次沿用默认'; text.title = f.warning; hint.append(text);
          const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'fa-reset'; reset.textContent = '恢复默认';
          reset.onclick = async () => {
            const r = await ipcRenderer.invoke('feature-agents:set', { feature: f.id, choice: null });
            if (r?.ok) { state = r; refresh(); } else text.textContent = r?.error || '保存失败';
          };
          hint.append(reset); header.after(hint);
        }
      }
    }
    for (const host of document.querySelectorAll('[data-feature-agents]')) if (state && !host.querySelector('[data-fa-row]')) rows(host, host.dataset.featureAgents.split(','));
  }
  let scheduled = false;
  new MutationObserver(() => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; mount(); }); } }).observe(document.body, { childList: true, subtree: true });
  const modal = document.getElementById('config-modal');
  if (modal) new MutationObserver(() => {
    if (!modal.classList.contains('hidden')) void load().then(refresh).catch(error => { document.getElementById('cfg-feature-agents').textContent = error.message; });
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  ipcRenderer.on('feature-agents:changed', () => { void load().then(refresh).catch(() => {}); });
  window.__featureAgents = { open, refresh: () => load().then(refresh) };
  mount();
  void load().then(refresh).catch(() => {});
})();
