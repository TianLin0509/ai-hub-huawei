'use strict';

(() => {
  const distribution = require('../core/distribution');
  if (distribution.target !== 'company') return;
  const { ipcRenderer, shell } = require('electron');
  const { KINDS, LABELS } = require('../core/company-api-config');
  const cliView = require('./cli-install-view');
  // 一键安装前先提醒放行下载服务器（2026-11-07，renderer/net-pass-view.js）：只在还没放行时显示。
  const netPassView = require('./net-pass-view');
  let netPass = null, netPassLast = null;
  let cliState = null;
  let snapshot = null;
  let setup = null;
  let dialog = null;
  // 每个工具在弹窗里当前看的接入方式：proxy（公司模型，经本机反代）或 own（自有接口 / 沿用本机配置）。
  const viewMode = Object.create(null);
  const PROXY_STATE = { running: '运行中', starting: '正在启动', 'not-ready': '已启动，公司上游未就绪', draining: '等在途请求结束后停下', failed: '启动失败', stopped: '未启动' };
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
      // DSH 终端运行环境装好就能新建会话：启动中心的模型卡选公司模型时会顺手把 DSH 设成公司模型（DSH 在公司版只走公司模型）。
      const ready = !!response?.dshCliReady;
      dsh.dataset.installed = ready ? '1' : '0';
      let badge = dsh.querySelector('.company-cli-status');
      if (!badge) { badge = document.createElement('small'); badge.className = 'company-cli-status'; dsh.append(badge); }
      badge.textContent = ready ? '' : response?.dshRuntimeInstalled || response?.dshCliReady ? '待接入' : '未安装';
      badge.hidden = ready;
    }
    return setup;
  }
  // 一键安装（2026-11-07）：安装器状态来自主进程（core/cli-tools/installer.js），文字见 renderer/cli-install-view.js。
  async function loadCliState() {
    try { cliState = await ipcRenderer.invoke('cli-tools:state'); } catch { cliState = null; }
    return cliState;
  }
  function renderCliBlock(target, kind) {
    const slot = target?.querySelector(`[data-cli-install="${kind}"]`);
    if (!slot) return;
    const block = cliView.installBlockHtml(kind, cliState);
    const needPass = block && netPass && (netPass.needed || (netPassLast?.results || []).some(r => r.result === 'blocked'));
    netPassView.ensureCss();
    slot.innerHTML = (needPass ? netPassView.boxHtml(netPass, { last: netPassLast }) : '') + block;
    netPassView.bind(slot, { ipcRenderer, onUpdate: (next, last) => { if (next) netPass = next; netPassLast = last; renderCliBlock(target, kind); } });
    slot.querySelector('[data-cli-action="install"]')?.addEventListener('click', () => void runInstall(target, kind));
    slot.querySelector('[data-cli-action="install-git"]')?.addEventListener('click', () => void runGitInstall(target, kind));
    for (const b of slot.querySelectorAll('[data-cli-action="cancel"]')) b.addEventListener('click', () => void ipcRenderer.invoke('cli-tools:cancel').catch(() => {}));
  }
  // Git for Windows（2026-11-07）：挂在 Claude Code 区块下面；主进程先全局找本机的 Git，没有才下载。
  async function runGitInstall(target, kind) {
    cliState = { ...cliState, busy: 'git', tools: { ...cliState?.tools, git: { phase: 'checking' } } };
    renderCliBlock(target, kind);
    let result;
    try { result = await ipcRenderer.invoke('cli-tools:install', { id: 'git' }); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (result?.state) cliState = result.state;
    else cliState = { ...cliState, busy: null, tools: { ...cliState?.tools, git: { phase: 'error', error: result?.error || '未知原因' } } };
    if (dialog === target) renderCliBlock(target, kind);
  }
  async function runInstall(target, kind) {
    const id = cliView.TOOL_FOR_KIND[kind];
    cliState = { ...cliState, busy: id, tools: { ...cliState?.tools, [id]: { phase: 'checking' } } };
    renderCliBlock(target, kind);
    let result;
    try { result = await ipcRenderer.invoke('cli-tools:install', { id }); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (result?.state) cliState = result.state;
    else cliState = { ...cliState, busy: null, tools: { ...cliState?.tools, [id]: { phase: 'error', error: result?.error || '未知原因' } } };
    // 装好后马上重新检测：启动中心的卡片不用重启 Hub 就能用。
    let ready = false;
    if (result?.ok) {
      try {
        await refreshInstall();
        ready = kind === 'deepseek-acp' ? document.querySelector('.new-session-option[data-kind="deepseek"]')?.dataset.installed === '1'
          : !!setup?.providers?.find(p => p.id === kind)?.installed;
      } catch { ready = false; }
    }
    if (dialog !== target) return;
    renderCliBlock(target, kind);
    if (!result?.ok) return;
    const status = target.querySelector('.company-api-message');
    target.querySelector('.company-api-install')?.setAttribute('hidden', '');
    if (status) status.textContent = ready ? `${LABELS[kind]} 已装好，回到启动中心直接新建会话即可；要用公司模型或自有接口时点「配置接口」。`
      : '已安装，但 Hub 还没检测到它，请点「重新检测」，或重启 Hub 后再试。';
    const footer = target.querySelector('footer');
    if (footer && ready) {
      footer.innerHTML = '<button type="button" data-api-action="configure">配置接口</button><button type="button" class="primary" data-api-action="finish">完成</button>';
      footer.querySelector('[data-api-action="configure"]').onclick = () => void open(kind);
      footer.querySelector('[data-api-action="finish"]').onclick = close;
    }
  }
  function showInstall(kind) {
    const target = makeDialog();
    const provider = setup?.providers?.find(p => p.id === kind);
    if (kind === 'deepseek-acp') {
      target.innerHTML = heading('安装 DSH 运行环境', 'DSH 运行环境尚未就绪，当前可先配置接口。')
        + `<div data-cli-install="${kind}"></div>`
        + '<div class="company-api-install"><ol><li>安装组织提供的 DSH 终端运行环境（Node 和 DSH 终端界面）。</li><li>在「自有 API」的 DSH 页选择「公司模型」并保存。</li><li>回到启动中心新建 DSH 会话；在此之前可先使用 Claude Code 或 Codex。</li></ol></div>'
        + '<p class="company-api-message" role="status"></p><footer><button type="button" data-api-action="configure">配置接口</button></footer>';
      bindClose(target);
      target.querySelector('[data-api-action="configure"]').onclick = () => void open(kind);
      renderCliBlock(target, kind);
      void loadCliState().then(() => { if (dialog === target) renderCliBlock(target, kind); });
      void ipcRenderer.invoke('net-pass:status', { refresh: true }).then(v => { netPass = v; if (dialog === target) renderCliBlock(target, kind); }).catch(() => {});
      return;
    }
    target.innerHTML = heading(`安装 ${LABELS[kind]}`, '安装完成后可沿用本机配置，或填写自己的 API 接口。')
      + `<div data-cli-install="${kind}"></div>`
      + `<div class="company-api-install"><span class="company-api-tag">未安装</span><ol><li>按官方说明安装 ${esc(LABELS[kind])} CLI${kind === 'claude' ? '，Windows 建议同时安装 Git for Windows（没有时 Claude 改用 PowerShell 执行命令）' : ''}。</li><li>完成安装后点击「重新检测」。</li><li>需要自有接口时，到「自有 API」填写配置。</li></ol></div>`
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
    renderCliBlock(target, kind);
    void ipcRenderer.invoke('net-pass:status', { refresh: true }).then(v => { netPass = v; if (dialog === target) renderCliBlock(target, kind); }).catch(() => {});
    // 读到安装器状态后再画一次。有一键安装时，手动步骤降为次要（「重新检测」不再是主按钮）；
    // 没有下载源的版本这里保持空白，弹窗和以前一样。
    void loadCliState().then(() => {
      if (dialog !== target) return;
      renderCliBlock(target, kind);
      if (!cliState?.available) return;
      target.querySelector('.company-api-install .company-api-tag')?.replaceWith(Object.assign(document.createElement('p'), { className: 'company-api-note', textContent: '也可以自己按官方说明安装：' }));
      target.querySelector('[data-api-action="refresh"]')?.classList.remove('primary');
    });
  }
  function modeSwitch(mode) {
    return '<div class="company-api-mode" role="radiogroup" aria-label="接入方式">'
      + `<button type="button" role="radio" data-api-mode="proxy" aria-checked="${mode === 'proxy'}"><strong>公司模型</strong><small>${snapshot?.proxy?.shared ? '经共享主机，使用团队号池' : '经本机反代，用 CodeAgent 账号'}</small></button>`
      + `<button type="button" role="radio" data-api-mode="own" aria-checked="${mode !== 'proxy'}"><strong>自有接口</strong><small>填写接口地址，或沿用 CLI 本机配置</small></button></div>`;
  }
  function proxyStatusHtml(kind) {
    const proxy = snapshot?.proxy;
    const dshHint = kind === 'deepseek-acp' && !snapshot?.dshCliReady ? '<p class="company-api-note company-proxy-warn">DSH 终端运行环境还没装好，装好后才能新建 DSH 会话。可在启动中心点 DSH 卡片「一键安装」，或在命令行执行 <code>npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui</code>，装完重新打开设置即可。</p>' : '';
    if (!proxy) return '<div class="company-proxy-state" data-proxy-state="unknown"><p>保存后由 Hub 在后台启动反代。</p></div>' + dshHint;
    if (proxy.shared) return `<div class="company-proxy-state" data-proxy-state="${esc(proxy.state)}"><strong>共享主机${proxy.state === 'running' ? '已连接' : '暂不可用'}</strong><p>${esc(proxy.message)}</p><p>主机各号的可用模型和额度见右侧「共享号池额度」。</p></div>` + dshHint;
    const all = proxy.accounts || [];
    const pool = all.filter(a => a.kind !== 'personal');
    const cooling = all.filter(a => a.coolingUntil && a.coolingUntil > Date.now()).length;
    const accounts = all.length ? `个人账号${pool.length ? ` + 号池 ${pool.length} 个号` : ''}${cooling ? `（${cooling} 个冷却中）` : ''}` : '个人账号与号池（启动后显示）';
    return `<div class="company-proxy-state" data-proxy-state="${esc(proxy.state)}"><div><span class="company-proxy-dot" aria-hidden="true"></span>`
      + `<strong>反代${esc(PROXY_STATE[proxy.state] || proxy.state)}</strong></div>`
      + `<p>${esc(proxy.message || (proxy.state === 'stopped' ? '保存后自动启动，随 Hub 一起退出。' : ''))}</p>`
      + (proxy.firstInit?.ran && proxy.state === 'running' ? `<p>首次签名初始化已完成（用时约 ${Math.max(1, Math.round((proxy.firstInit.ms || 0) / 1000))} 秒），之后启动直接复用，CodeAgent 升级后会自动重做一次。</p>` : '')
      + `<p>可用账号：${esc(accounts)}。每个会话固定用一个号，号被限流时自动换号，号池都不可用时改用个人账号。</p></div>` + dshHint;
  }
  // 所在区域：显示现在用的是哪个区、从哪里得来；识别不出来时提示选择。下拉框选了就写进上游配置并重启反代。
  const ZONE_NAMES = { blue: '蓝区', green: '绿区', yellow: '黄区' };
  function zoneHtml() {
    const proxy = snapshot?.proxy;
    if (proxy?.shared) return '<p class="company-api-note">账号登录、区域和号池调度由共享主机管理，同事端无需设置。</p>';
    const chosen = proxy?.chosenZone?.zone || '';
    const unknown = proxy?.code === 'ZONE_UNKNOWN';
    const text = proxy?.mock ? '模拟上游（测试用）不按区域路由。' : proxy?.zone?.text || (unknown ? '还没识别出你所在的区域（蓝区 / 绿区 / 黄区），请在下面选择。选错了，公司模型的请求会全部失败。'
      : proxy?.state === 'running' || proxy?.state === 'not-ready' ? '正在识别…' : '反代启动后显示识别结果。');
    const options = [['', '自动识别（读 CodeAgent 的配置）'], ...Object.entries(ZONE_NAMES)];
    return `<div class="company-proxy-zone${unknown ? ' company-proxy-warn' : ''}" data-zone-state="${unknown ? 'unknown' : proxy?.zone?.zone ? 'known' : 'pending'}">`
      + `<label>所在区域<select name="zone" data-proxy-zone-select>`
      + options.map(([id, label]) => `<option value="${id}"${id === chosen ? ' selected' : ''}>${esc(label)}</option>`).join('')
      + `</select></label><p data-proxy-zone-text>${esc(text)}</p></div>`;
  }
  function bindZone(target) {
    const select = target.querySelector('[data-proxy-zone-select]');
    if (!select) return;
    select.onchange = async () => {
      const status = target.querySelector('[role="status"]'), zone = select.value;
      select.disabled = true;
      status.textContent = zone ? `已改为${ZONE_NAMES[zone]}，正在重启反代…` : '已改为自动识别，正在重启反代…';
      try {
        const result = await ipcRenderer.invoke('company-proxy:set-zone', { zone });
        snapshot = { ...snapshot, proxy: result?.proxy || snapshot?.proxy };
        refreshProxyBlocks(target);
        status.textContent = result?.ok ? '区域已保存，反代已按新区域重启。' : '区域没保存：' + (result?.error || '未知原因');
      } catch (error) { status.textContent = '区域没保存：' + error.message; }
      finally { select.disabled = false; }
    };
  }
  function refreshProxyBlocks(target) {
    const kind = target.closest('dialog')?.querySelector('[data-api-kind][aria-pressed="true"]')?.dataset.apiKind;
    const block = target.querySelector('[data-proxy-status]');
    if (block && kind) block.innerHTML = proxyStatusHtml(kind);
    const zone = target.querySelector('[data-proxy-zone]');
    if (zone && !zone.querySelector('select:focus')) { zone.innerHTML = zoneHtml(); bindZone(target); }
  }
  function renderProxy(target, kind, value) {
    const models = value.models?.length ? value.models : [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }];
    const current = value.backend === 'proxy' ? value.model : models[0].id;
    target.insertAdjacentHTML('beforeend', '<form data-proxy-form><label>默认模型<select name="model">'
      + models.map(m => `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.label)}</option>`).join('') + '</select></label>'
      + `<div data-proxy-zone>${zoneHtml()}</div>`
      + `<div data-proxy-status>${proxyStatusHtml(kind)}</div>`
      + '<p class="company-api-note">只用 CodeAgent 已登录的账号，不会替你登录或刷新登录；公司模型只收文字，不支持联网搜索。新建会话时也可在模型菜单里换另一个模型。</p>'
      + `<p class="company-api-message" role="status" aria-live="polite"></p><footer><button type="button" data-api-action="proxy-restart">${snapshot?.proxy?.shared ? '重新连接主机' : '重新启动反代'}</button><button type="button" data-api-action="close">取消</button><button type="submit" class="primary">保存配置</button></footer></form>`);
    target.querySelector('[data-api-action="close"]').onclick = close;
    bindZone(target);
    target.querySelector('[data-api-action="proxy-restart"]').onclick = async event => {
      const button = event.currentTarget, status = target.querySelector('[role="status"]');
      button.disabled = true;
      status.textContent = snapshot?.proxy?.shared ? '正在重新连接共享主机…' : '正在重新启动反代…';
      try {
        const result = await ipcRenderer.invoke('company-proxy:restart');
        snapshot = { ...snapshot, proxy: result?.proxy || snapshot?.proxy };
        refreshProxyBlocks(target);
        status.textContent = result?.ok ? '反代已重新启动。' : '重新启动失败：' + (result?.error || '未知原因');
      } catch (error) { status.textContent = '重新启动失败：' + error.message; }
      finally { button.disabled = false; }
    };
    target.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget, save = form.querySelector('[type="submit"]'), status = form.querySelector('[role="status"]');
      save.disabled = true;
      status.textContent = '正在保存…';
      try {
        const result = await ipcRenderer.invoke('company-api:save', { kind, backend: 'proxy', model: form.elements.model.value });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = { ...snapshot, ...result };
        form.querySelector('[data-proxy-status]').innerHTML = proxyStatusHtml(kind);
        status.textContent = `已保存。新建 ${LABELS[kind]} 会话使用公司模型（${result.providers?.[kind]?.model || form.elements.model.value}）。`;
        void refreshInstall().catch(() => {});
      } catch (error) { status.textContent = '保存失败：' + error.message; }
      finally { save.disabled = false; }
    };
  }
  function render(kind) {
    const target = makeDialog();
    const value = snapshot?.providers?.[kind] || {};
    const mode = viewMode[kind] || (value.backend === 'proxy' ? 'proxy' : 'own');
    const own = value.backend === 'proxy' ? {} : value;
    target.innerHTML = heading('自有 API', '每个工具可用公司模型，或填写自己的接口；留空沿用 CLI 本机登录与配置。')
      + `<nav aria-label="API 工具">${KINDS.map(id => `<button type="button" data-api-kind="${id}" aria-pressed="${id === kind}">${LABELS[id]}</button>`).join('')}</nav>`
      + modeSwitch(mode);
    bindClose(target);
    target.querySelectorAll('[data-api-kind]').forEach(button => { button.onclick = () => render(button.dataset.apiKind); });
    target.querySelectorAll('[data-api-mode]').forEach(button => { button.onclick = () => { viewMode[kind] = button.dataset.apiMode; render(kind); }; });
    if (mode === 'proxy') { renderProxy(target, kind, value); return; }
    target.insertAdjacentHTML('beforeend', `<form data-api-form><label>接口地址<input name="baseURL" type="url" value="${esc(own.baseURL)}" placeholder="留空沿用本机配置" autocomplete="off" spellcheck="false"></label>`
      + `<label>API Key<input name="apiKey" type="password" placeholder="${own.apiKeySet ? '已保存；留空保留原 Key' : '可选；留空沿用本机登录'}" autocomplete="off" spellcheck="false"></label>`
      + `<label>模型<input name="model" value="${esc(own.model)}" placeholder="留空沿用 CLI 配置的模型" autocomplete="off" spellcheck="false"></label>`
      + (kind === 'codex' ? `<label>接口协议<select name="wireApi"><option value="responses"${own.wireApi === 'chat' ? '' : ' selected'}>responses（默认）</option><option value="chat"${own.wireApi === 'chat' ? ' selected' : ''}>chat</option></select></label>` : '')
      + (kind === 'deepseek-acp' ? '<p class="company-api-note">可先保存接口。DSH 自有接口的运行接入尚未就绪，DSH 会话请选「公司模型」，或先使用 Claude Code、Codex。</p>' : '<p class="company-api-note">Key 仅保存在本机配置中，重新打开时不会显示。进行中的会话保持原配置。</p>')
      + '<p class="company-api-message" role="status" aria-live="polite"></p><footer><button type="button" data-api-action="local">沿用本机配置</button><button type="button" data-api-action="close">取消</button><button type="submit" class="primary">保存配置</button></footer></form>');
    target.querySelector('[data-api-action="close"]').onclick = close;
    target.querySelector('[data-api-action="local"]').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await ipcRenderer.invoke('company-api:save', { kind, useLocal: true });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = { ...snapshot, ...result };
        delete viewMode[kind];
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
    // 反代状态变了（启动完成、自动重启、失败）：弹窗开着就就地刷新状态块。
    ipcRenderer.on('company-proxy:status', (_event, proxy) => {
      if (snapshot?.proxy?.shared && !proxy?.shared) return;
      if (!snapshot || !proxy) return;
      snapshot = { ...snapshot, proxy };
      const form = dialog?.querySelector('[data-proxy-form]');
      if (form) refreshProxyBlocks(form);
    });
    // 安装进度推送：弹窗开着就就地刷新一键安装区块。
    ipcRenderer.on('net-pass:state', (_event, state) => {
      netPass = state;
      const slot = dialog?.querySelector('[data-cli-install]');
      if (slot) renderCliBlock(dialog, slot.dataset.cliInstall);
    });
    ipcRenderer.on('cli-tools:state', (_event, state) => {
      if (!state) return;
      cliState = state;
      const slot = dialog?.querySelector('[data-cli-install]');
      if (slot) renderCliBlock(dialog, slot.dataset.cliInstall);
    });
    window.__companyApiOpen = open;
    void refreshInstall().catch(() => {});
    document.getElementById('community-refresh')?.addEventListener('click', () => void refreshInstall().catch(() => {}));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
