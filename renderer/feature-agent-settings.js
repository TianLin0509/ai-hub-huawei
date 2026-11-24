'use strict';
// 全局设置和功能入口共用行组件与 IPC；即时保存，不改启动中心的默认模型。
(function featureAgentSettings() {
  const { ipcRenderer } = require('electron');
  const choiceValues = require('../core/codeagent-model-choice');
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let state = null, popup = null, group = 'common', presetNote = '';
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
    .fa-group-tabs .fa-presets { margin-left:auto; display:flex; gap:4px; align-items:center; }
    .fa-group-tabs .fa-presets button { color:var(--brand,#3478f6); font:12px 'Microsoft YaHei',sans-serif; padding:5px 8px; }
    .fa-group-tabs .fa-presets button:disabled { color:var(--text-secondary,#5b6573); opacity:.6; cursor:default; }
    #config-modal:has(#cfg-tab-agents[aria-selected=true]) .config-modal-content { max-width:1000px; width:calc(100vw - 80px); }
    .fa-row { display:grid; grid-template-columns:minmax(155px,1fr) 192px minmax(0,1.6fr) 66px; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-subtle,#dfe3ea); }
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
    .fa-popup .fa-row { grid-template-columns:120px 192px minmax(180px,1fr) 66px; }
    #cfg-feature-agents [role=status] { font-size:12px; min-height:18px; }
    .fa-foot { display:flex; align-items:center; gap:12px; min-height:18px; min-width:0; padding-top:6px; font-size:12px; }
    .fa-foot .fa-gw { flex:0 1 auto; min-width:0; display:flex; align-items:center; gap:4px; color:var(--text-secondary,#5b6573); }
    .fa-foot .fa-gw span { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fa-foot .fa-gw i { flex:0 0 auto; font-style:normal; cursor:help; color:var(--brand,#3478f6); }
    .fa-foot [role=status] { flex:1 1 40%; min-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .fa-row .fa-hint { grid-column:1/-1; font-size:12px; color:var(--text-secondary,#5b6573); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .fa-row .fa-hint i { font-style:normal; cursor:help; color:var(--brand,#3478f6); margin-left:4px; }
    .fa-row .fa-custom { grid-column:1/-1; display:flex; align-items:center; gap:6px; min-width:0; }
    .fa-row .fa-custom[hidden] { display:none; }
    .fa-row .fa-custom input { width:260px; height:30px; padding:0 8px; border:1px solid var(--border-subtle,#dfe3ea); border-radius:6px; font:12px 'Microsoft YaHei',sans-serif; color:var(--text-primary,#242a33); background:var(--bg-input,#fff); }
    .fa-row .fa-custom [role=status] { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  `;
  document.head.append(style);
  function rows(host, ids) {
    if (host.id === 'cfg-feature-agents' && !ids) {
      host.innerHTML = `<div class="fa-group-tabs" role="tablist" aria-label="功能分类"><button type="button" data-fa-group="common" aria-selected="${group === 'common'}">日常功能</button><button type="button" data-fa-group="ppt" aria-selected="${group === 'ppt'}">PPT</button>${presetButtons()}</div><div id="fa-settings-page" data-fa-page></div>`;
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
        <select data-fa-backend id="fa-backend-${host.id}-${f.id}" aria-label="${esc(f.label)}后端" title="${esc(backendTitle)}"><option value="" title="${esc(f.defaultText)}">${esc(defaultBackend)}</option>${backendOptions.map(b => `<option value="${esc(b.kind)}"${b.kind === selected?.kind ? ' selected' : ''}${b.available ? '' : ' disabled'}>${esc(b.label)}${b.available ? '' : `（${esc(b.reason || '不可用')}）`}</option>`).join('')}</select>
        <select data-fa-model aria-label="${esc(f.label)}模型"${selected ? '' : ' disabled'}><option value="">默认（当前：${esc(backend?.defaultModel || f.defaultText)}）</option>${selected?.model && !models.some(m => choiceValues.choiceValue(m) === current) ? `<option selected value="${esc(current)}">${esc(selected.model)}（不可用）</option>` : ''}${models.map(m => `<option value="${esc(choiceValues.choiceValue(m))}"${choiceValues.choiceValue(m) === current ? ' selected' : ''}${m.unavailable ? ' disabled' : ''}>${esc(m.label || m.id)}</option>`).join('')}${backend?.allowCustom ? '<option value="__custom__">手填模型名…</option>' : ''}</select>
        ${selected ? '<button class="fa-reset" data-fa-reset type="button">恢复默认</button>' : ''}${f.warning ? `<span class="fa-warning" role="status">${esc(f.warning)}</span>` : ''}${gatewayExtras(f, backend, features.length)}</div>`;
    }).join('') + footer(features, host);
    if (host.id === 'fa-assistant-settings') {
      const overridden = features.filter(f => f.selected).map(f => f.id === 'avatar' ? '分身' : '助理');
      if (overridden.length) {
        const note = document.createElement('p'); note.className = 'fa-legacy-override'; note.setAttribute('role', 'status');
        note.textContent = `${overridden.join('、')}正在使用功能选型，下方供应商默认设置暂不生效。`; host.append(note);
      }
    }
  }
  // 一键预设：和分类标签同一行靠右，不占额外高度（一个 Tab 一屏）。
  const LITE_PRESET_INFO = '把「默认」或选了 CodeAgent 的互动功能切到 CodeAgent-Lite：多个功能共用一个后台进程，省内存；'
    + '原来选好的模型保留，已选部门 API key 等其他后端的项不改；Lite 启动失败会自动退回终端方式。';
  function presetSummary() {
    const lite = state?.backends.find(b => b.kind === 'codeagent-lite');
    const eligible = (state?.features || []).filter(f => f.kinds.includes('codeagent-lite'));
    const convertible = eligible.filter(f => !f.choice || f.choice.kind === 'codeagent');
    const liteCount = eligible.filter(f => f.choice?.kind === 'codeagent-lite').length;
    return { available: !!lite?.available, convertible: convertible.length, liteCount };
  }
  function presetButtons() {
    const s = presetSummary();
    const why = !s.available ? '本机 CodeAgent-Lite 暂不可用（未检测到可用的 CodeAgent）' : !s.convertible ? '可切换的功能都已是 CodeAgent-Lite' : LITE_PRESET_INFO;
    const toLite = `<button type="button" data-fa-preset="codeagent-lite" title="${esc(why)}"${s.available && s.convertible ? '' : ' disabled'}>一键全切 Lite（省内存）</button>`;
    const reset = s.liteCount ? `<button type="button" data-fa-preset="reset-lite" title="${esc(`把 ${s.liteCount} 项 CodeAgent-Lite 恢复默认（这些项原先单独指定的模型也一并恢复为默认），其他已选后端不动`)}">还原 Lite</button>` : '';
    return `<span class="fa-presets">${toLite}${reset}</span>`;
  }
  async function applyPreset(button) {
    const preset = button.dataset.faPreset;
    const host = document.getElementById('cfg-feature-agents');
    host?.querySelectorAll('[data-fa-preset]').forEach(el => { el.disabled = true; });
    let text;
    try {
      const r = await ipcRenderer.invoke('feature-agents:preset', { preset });
      if (!r?.ok) throw new Error(r?.error || '保存失败');
      state = r; refresh();
      const changed = r.changed?.length || 0, skipped = r.skipped?.length || 0;
      text = preset === 'reset-lite'
        ? (changed ? `已将 ${changed} 项从 CodeAgent-Lite 还原为默认，下次任务生效` : '没有需要还原的 CodeAgent-Lite 项')
        : !changed ? '没有可切换的功能（已是 Lite 或选了其他后端）'
          : skipped ? `已将 ${changed} 项切换为 CodeAgent-Lite，保留已选其他后端的 ${skipped} 项，下次任务生效`
            : `已将 ${changed} 项互动功能切换为 CodeAgent-Lite（省内存），下次任务生效`;
    } catch (error) { text = error.message; }
    // 回执记在模块里：随后到达的 feature-agents:changed 会重绘列表，不能把这句冲掉。
    presetNote = text; refresh();
  }
  // 部门 API key（网关）：8 项会话功能都能选（2026-11-24）。说明统一放在底部一行（细节放 ⓘ），和保存结果同一行，不每行挂提示，
  // 设置页「日常功能」不因此变长（一个 Tab 一屏）；ⓘ 在截断文字之外，永不被裁。行内只在「只有助理一项、本机又没有 CodeAgent」时
  // 提示可改用部门 key。手填模型框默认收起，下拉选「手填模型名…」才展开。
  const GATEWAY_INFO = '选「部门 API key（网关）」的功能改由本机 Claude Code 经 Hub 的本机反代连部门网关作答，不经 CodeAgent；'
    + 'key 用设置里「API 网关」已保存的那把（Windows 账户加密，不落明文），会话只挂该功能自己的工具。没装 CodeAgent、又保存过部门 key 时，助理默认就用它，其他功能要在这里选。'
    + '模型表来自网关；表里没有但网关能用的模型可以手填，先试跑一句测通再用。报错会写清原因并给出重填 key / 换模型按钮。';
  const GATEWAY_LINE = '「部门 API key（网关）」由本机 Claude Code 经反代作答';
  function footer(features, host) {
    const note = features.some(f => f.kinds.includes('api-gateway'))
      ? `<span class="fa-gw"><span title="${esc(GATEWAY_LINE)}">${esc(GATEWAY_LINE)}</span><i title="${esc(GATEWAY_INFO)}" aria-label="${esc(GATEWAY_INFO)}">ⓘ</i></span>` : '';
    const status = host?.id === 'fa-settings-page' ? presetNote : '';
    return `<div class="fa-foot">${note}<span role="status" data-fa-message${status ? ` title="${esc(status)}"` : ''}>${esc(status)}</span></div>`;
  }
  function gatewayExtras(f, backend, count) {
    if (!f.kinds.includes('api-gateway')) return '';
    // 底部已有网关说明：行内只留「只有助理一项、本机没有 CodeAgent」时的引导，不重复「正在用」。
    const noCodeagent = state?.backends.find(b => b.kind === 'codeagent')?.available === false;
    const line = count === 1 && f.id === 'assistant' && noCodeagent && f.selected?.kind !== 'api-gateway' ? '没有 CodeAgent 也能用：后端选「部门 API key（网关）」' : '';
    const hint = line ? `<span class="fa-hint">${line}</span>` : '';
    const custom = backend?.allowCustom ? `<div class="fa-custom" data-fa-custom hidden><input data-fa-custom-input maxlength="128" placeholder="模型名，例如 deepseek-v4.1-flash-1017" aria-label="手填模型名"><button type="button" class="fa-reset" data-fa-custom-check>检测并使用</button><span role="status" data-fa-custom-msg></span></div>` : '';
    return hint + custom;
  }
  async function checkCustom(row) {
    const input = row.querySelector('[data-fa-custom-input]'), msg = row.querySelector('[data-fa-custom-msg]'), btn = row.querySelector('[data-fa-custom-check]');
    const model = input.value.trim();
    presetNote = '';
    if (!model) { msg.textContent = '先填模型名'; input.focus(); return; }
    btn.disabled = true; msg.textContent = '正在试跑一句检测连通…';
    try {
      const r = await ipcRenderer.invoke('feature-agents:custom-model', { feature: row.dataset.faRow, model });
      if (!r?.ok) { msg.textContent = r?.error || '没有连通'; msg.title = r?.error || ''; return; }
      // 刷新会重画各处的行：按发起检测的那个容器（设置页或 ⚙ Agent 弹窗）找回状态栏，不落到别处同名行上。
      const host = row.parentElement, hostId = host?.id;
      state = r; refresh();
      const note = (hostId ? document.getElementById(hostId) : host)?.querySelector('[data-fa-message]');
      const text = r.warning || `已连通${r.checked?.firstMs ? `（首字 ${(r.checked.firstMs / 1000).toFixed(1)} 秒）` : ''}，下次提问起用 ${model}`;
      if (note) { note.textContent = text; note.title = text; }
    } catch (error) { msg.textContent = error.message; }
    finally { btn.disabled = false; }
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
    presetNote = '';
    const host = row.parentElement, message = host.querySelector('[data-fa-message]');
    row.querySelectorAll('select,button').forEach(el => { el.disabled = true; });
    try {
      const result = await ipcRenderer.invoke('feature-agents:set', { feature: row.dataset.faRow, choice });
      if (!result?.ok) throw new Error(result?.error || '保存失败');
      state = result; refresh();
      (document.getElementById(host.id) || host).querySelector('[data-fa-message]').textContent = '已保存，下次任务生效';
    } catch (error) {
      message.textContent = error.message; message.title = error.message;
      row.querySelectorAll('select,button').forEach(el => { el.disabled = false; });
    }
  }
  document.addEventListener('change', event => {
    const row = event.target.closest('[data-fa-row]'); if (!row) return;
    if (event.target.matches('[data-fa-backend]')) {
      void save(row, event.target.value ? { kind: event.target.value, model: '' } : null);
    } else if (event.target.matches('[data-fa-model]') && event.target.value === '__custom__') {
      const box = row.querySelector('[data-fa-custom]');
      if (box) { box.hidden = false; box.querySelector('input')?.focus(); }
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
    if (tab) { group = tab.dataset.faGroup; presetNote = ''; refresh(); return; }
    const preset = event.target.closest('[data-fa-preset]');
    if (preset) { if (!preset.disabled) void applyPreset(preset); return; }
    const entry = event.target.closest('[data-feature-agent]');
    if (entry) { void open(entry.dataset.featureAgent.split(','), entry); return; }
    if (event.target.closest('[data-fa-close]')) { close(); return; }
    const check = event.target.closest('[data-fa-custom-check]');
    if (check) { void checkCustom(check.closest('[data-fa-row]')); return; }
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
  // 只在弹窗由隐藏变为打开的那一下清回执；打开期间其他 class 抖动不清。
  let modalWasHidden = modal ? modal.classList.contains('hidden') : true;
  if (modal) new MutationObserver(() => {
    const hidden = modal.classList.contains('hidden');
    const opened = modalWasHidden && !hidden;
    modalWasHidden = hidden;
    if (opened) presetNote = '';
    if (!hidden) void load().then(refresh).catch(error => { document.getElementById('cfg-feature-agents').textContent = error.message; });
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  // 一键预设自己触发的变更保留回执；别处（单项修改、其他窗口）改了选型就清掉，免得旧回执误导。
  ipcRenderer.on('feature-agents:changed', (_event, detail = {}) => { if (!detail?.preset) presetNote = ''; void load().then(refresh).catch(() => {}); });
  window.__featureAgents = { open, refresh: () => load().then(refresh) };
  mount();
  void load().then(refresh).catch(() => {});
})();
