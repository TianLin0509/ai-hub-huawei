'use strict';

(() => {
  const distribution = require('../core/distribution');
  if (distribution.target !== 'company') return;
  const { ipcRenderer, shell } = require('electron');
  const { KINDS, LABELS } = require('../core/company-api-config');
  const cliView = require('./cli-install-view');
  let cliState = null;
  let snapshot = null;
  let setup = null;
  let dialog = null;
  // 每个工具在弹窗里当前看的接入方式：proxy（公司模型，经本机反代）或 own（自有接口 / 沿用本机配置）。
  const viewMode = Object.create(null);
  const viewProfile = Object.create(null);
  const PROXY_STATE = { running: '运行中', starting: '正在启动', 'not-ready': '已启动，公司上游未就绪', draining: '等在途请求结束后停下', failed: '启动失败', stopped: '未启动' };
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function close() { dialog?.close(); }
  function makeDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'company-api-dialog';
    dialog.className = 'company-api-dialog';
    dialog.setAttribute('aria-label', '自有 API');
    // 从设置里点进来的：关掉自有 API 后回到设置，不把人甩回主页（以前关完设置也没了，像「设置自己退出」）。
    const settings = document.getElementById('config-modal');
    const backToSettings = !!settings && !settings.classList.contains('hidden');
    dialog.addEventListener('close', () => {
      dialog.remove(); dialog = null;
      if (backToSettings) settings.classList.remove('hidden');
    });
    // 点框外才关，且按下也得在框外：在 Key 输入框里拖选、拖出框外松开不算点框外。
    const self = dialog;
    require('./backdrop-dismiss.js').bindBackdropDismiss(self, {
      isBackdrop: event => {
        const box = self.getBoundingClientRect();
        return event.target === self && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
      },
      onDismiss: close,
    });
    document.body.append(dialog);
    if (backToSettings) settings.classList.add('hidden');
    dialog.showModal();
    return dialog;
  }
  function heading(title, hint, hover = false) {
    return `<header><div><h2>${esc(title)}${hover ? require('./launch-field-hint').iconHintHtml(hint) : ''}</h2>${!hover && hint ? `<p>${esc(hint)}</p>` : ''}</div><button type="button" class="company-api-close" aria-label="关闭">×</button></header>`;
  }
  function bindClose(target) { target.querySelector('.company-api-close').onclick = close; }
  // 启动中心徽标（2026-11-20，HUB-H 第一期）：先画定位中心的缓存结论（harness:peek-all，不起进程，1 秒内出），
  // 再用 harness:locate-all 刷新；五种结论各有说法（能用不出徽标），收到 harness:changed 就地改一个按钮。
  // CodeAgent 的徽标由启动中心自己画（renderer/workspace-controller.js），这里不重复。
  // 主进程还没有定位中心（旧主进程）时，按原来的 community:setup / company-api:get 判断。
  const hxView = require('./harness-view');
  const harness = require('./harness-client').createHarnessClient(ipcRenderer);
  const BADGE_KINDS = ['claude', 'codex', 'deepseek', 'pi', 'kimi', 'gemini'];
  const located = Object.create(null);
  function badgeOf(button) {
    let badge = button.querySelector('.company-cli-status');
    if (!badge) { badge = document.createElement('small'); badge.className = 'company-cli-status'; button.append(badge); }
    return badge;
  }
  function paintLocated(kind) {
    const button = document.querySelector(`.new-session-option[data-kind="${kind}"]`);
    const result = located[hxView.KIND_TO_ID[kind]];
    if (!button || !result?.verdict) return false;
    const b = hxView.badge(result);
    // 能用、暂时不可用（沿用上次能用的那份）都照常新建会话；其余点卡片时先说明怎么处理。
    button.dataset.installed = result.verdict === 'ok' || result.verdict === 'unavailable' ? '1' : '0';
    button.dataset.harness = result.verdict;
    const badge = badgeOf(button);
    badge.textContent = b.text; badge.hidden = !b.text; badge.title = b.title;
    badge.dataset.verdict = result.verdict;
    if (!document.getElementById('harness-badge-style')) document.head.append(Object.assign(document.createElement('link'), { id: 'harness-badge-style', rel: 'stylesheet', href: 'styles/harness-badge.css' }));
    return true;
  }
  function acceptLocated(all) {
    if (!all || typeof all !== 'object') return 0;
    let n = 0;
    for (const [id, result] of Object.entries(all)) if (result?.verdict) { located[id] = result; n++; }
    return n;
  }
  async function refreshLocated({ fresh = false } = {}) {
    const peek = await harness.peekAll().catch(() => ({ missing: true }));
    if (peek.missing) return false;
    acceptLocated(peek.value);
    for (const kind of BADGE_KINDS) paintLocated(kind);
    const run = harness.locateAll({ fresh }).then(r => { if (!r.missing) acceptLocated(r.value); }).catch(error => console.warn('[launch] 定位中心刷新失败：', error.message))
      .then(() => { for (const kind of BADGE_KINDS) paintLocated(kind); });
    // fresh（装完、点「重新检测」）：等试跑结果出来再返回，调用方据此判断装好没有。
    if (fresh) await run;
    return true;
  }
  // fresh：装完、点「重新检测」时不用定位中心的 2 分钟缓存；启动和打开启动中心时走缓存。
  async function refreshInstall({ fresh = false } = {}) {
    const harnessReady = refreshLocated({ fresh });
    setup = await ipcRenderer.invoke('community:setup');
    if (await harnessReady) {
      for (const kind of BADGE_KINDS) paintLocated(kind);
      return setup;
    }
    for (const kind of ['claude', 'codex']) {
      const button = document.querySelector(`.new-session-option[data-kind="${kind}"]`);
      const provider = setup.providers?.find(p => p.id === kind);
      if (!button || !provider) continue;
      button.dataset.installed = provider.installed ? '1' : '0';
      const badge = badgeOf(button);
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
    slot.innerHTML = cliView.installBlockHtml(kind, cliState);
    void require('./download-source-view').fill(slot, { ipcRenderer });
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
        await refreshInstall({ fresh: true });
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
        await refreshInstall({ fresh: true });
        if (setup.providers?.find(p => p.id === kind)?.installed) { await open(kind); return; }
        target.querySelector('[role="status"]').textContent = '还未检测到 CLI。请完成安装后重试，或检查安装目录是否已加入 PATH。';
      } catch { target.querySelector('[role="status"]').textContent = '检测失败，请稍后重试。'; }
      finally { target.querySelector('[data-api-action="refresh"]')?.removeAttribute('disabled'); }
    };
    renderCliBlock(target, kind);
    // 读到安装器状态后再画一次。有一键安装时，手动步骤降为次要（「重新检测」不再是主按钮）；
    // 没有一键安装的版本这里保持空白，弹窗和以前一样。
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
      + `<button type="button" role="radio" data-api-mode="proxy" aria-checked="${mode === 'proxy'}"><strong>公司模型</strong><small>${snapshot?.proxy?.shared ? '经共享主机，使用团队号池' : '通过本机公司模型通道，使用 CodeAgent 账号'}</small></button>`
      + `<button type="button" role="radio" data-api-mode="gateway" aria-checked="${mode === 'gateway'}"><strong>API 网关 <em class="company-api-new">新</em></strong><small>用部门发的 API key，不需要 CodeAgent</small></button>`
      + `<button type="button" role="radio" data-api-mode="own" aria-checked="${mode === 'own'}"><strong>自有接口</strong><small>填写接口地址，或沿用 CLI 本机配置</small></button></div>`;
  }
  // API 网关（2026-11-19 接入，11-20 加一键体检）：地址、Key、模型表各工具共用一份（core/api-gateway.js）；这里选这个工具用网关和它的默认模型。
  // 左边表单，右边分组说明 + 能力表 + 上手说明（renderer/api-gateway-health.js），1440 宽一屏放下。
  // 打开时刷新网关公开目录（不用 key）；key 已存但还没体检过就自动体检一次（开箱即用）。
  const gwHealth = require('./api-gateway-health');
  let gwExtra = { health: null, catalog: null, loaded: false, running: false };
  let gwProgressBound = false;
  function renderGateway(target, kind, value) {
    gwHealth.ensureStyle();
    if (gwExtra.for !== dialog) gwExtra = { ...gwExtra, loaded: false, for: dialog }; // 每次打开设置都刷新一次目录
    const g = snapshot?.gateway || { baseURL: '', keySet: false, choices: [], model: '' };
    const current = value.backend === 'proxy' && value.upstream === 'gateway' ? value.model : g.model;
    const others = KINDS.filter(k => k !== kind && !(snapshot?.providers?.[k]?.backend === 'proxy' && snapshot.providers[k].upstream === 'gateway'));
    const optionsHtml = (gw, chosen) => {
      const choices = gw.choices?.length ? gw.choices : [{ id: gw.model, label: gw.model, note: '' }];
      return choices.map(c => `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(c.id)}${c.note ? ' — ' + esc(c.note) : ''}</option>`).join('')
        + (gw.keySet ? '<option value="__custom__">手填模型名…</option>' : '');
    };
    const gwHost = (() => { try { return new URL(g.baseURL).host; } catch { return ''; } })();
    target.insertAdjacentHTML('beforeend', '<div class="api-gw-layout"><form data-gateway-form>'
      // 界面不写平台名（公开版用词合规，2026-11-21 负责人定）：标题旁显示预填的网关地址，同事靠它认出是哪个网关。
      + `<p class="company-api-note api-gw-intro">API 网关${gwHost ? ` <code class="api-gw-host" data-api-gw-host>${esc(gwHost)}</code>` : ''}：只填部门发的 key，地址已预填。Claude Code、Codex、DSH 都能用。</p>`
      + `<label>网关地址<input name="baseURL" value="${esc(g.baseURL)}" spellcheck="false" autocomplete="off"></label>`
      + `<label><span>API key${require('./launch-field-hint').iconHintHtml(require('./credential-hints').gatewayKey())}</span><input name="apiKey" type="password" placeholder="${g.keySet ? '已加密保存；留空保留原 key' : '粘贴部门发的 key（通常以 sk- 开头）'}" spellcheck="false" autocomplete="off"></label>`
      + `<label>默认模型<select name="model">${optionsHtml(g, current)}</select></label>`
      // 手填模型（R45）：表里没有、网关实际能用的模型（如带日期后缀的版本），先试跑一句测通再加进表。
      + '<div class="api-gw-custom" data-gw-custom hidden><input data-gw-custom-input maxlength="128" placeholder="模型名，例如 deepseek-v4.1-flash-1017" aria-label="手填模型名" spellcheck="false" autocomplete="off"><button type="button" data-api-action="gw-custom-check">检测并加入</button></div>'
      + (others.length ? `<label class="company-api-check"><input type="checkbox" name="alsoOthers"${g.keySet ? '' : ' checked'}> ${others.map(k => esc(LABELS[k])).join('、')} 也用网关</label>` : '')
      + `<div class="company-proxy-state" data-proxy-state="${g.keySet ? 'running' : 'stopped'}"><div><span class="company-proxy-dot" aria-hidden="true"></span><strong>${g.keySet ? `网关：key 已保存 · ${(g.models || []).length} 个对话模型${g.group ? ` · ${esc(g.group)} 分组` : ''}` : '网关：还没保存 key'}</strong></div>`
      + '<p>Key 只存在本机，用 Windows 账户加密。保存时先请求一次模型列表验证，再自动体检一次（每个模型发一句极短的话，free 分组几乎不耗额度）。</p></div>'
      + '<p class="company-api-message" role="status" aria-live="polite"></p><footer>'
      + `<button type="button" data-api-action="gw-health"${g.keySet ? '' : ' disabled'}>一键体检</button>`
      + (g.keySet ? '<button type="button" data-api-action="gw-clear">删除 key</button>' : '')
      + '<button type="button" data-api-action="close">取消</button><button type="submit" class="primary">保存配置</button></footer></form>'
      + `<div data-api-gw-slot>${gwHealth.asideHtml({ gateway: g, ...gwExtra }, gwExtra.running)}</div></div>`);
    target.querySelector('[data-api-action="close"]').onclick = close;
    const form = target.querySelector('form[data-gateway-form]');
    const status = () => target.querySelector('form [role="status"]');
    const hooks = {
      shell,
      focusKey: () => { form.elements.apiKey.focus(); status().textContent = '把 key 重新粘贴到「API key」里，点「保存配置」。'; },
      rerun: () => void runHealth(),
      // 关闭 / 恢复某个模型的思考：存进设置、热更新给反代；表里这一行就地改成「已关闭」，下次体检按新设置试跑。
      setThinking: async (id, enabled) => {
        if (!id) return;
        const r = await ipcRenderer.invoke('api-gateway:set-thinking', { model: id, enabled }).catch(error => ({ ok: false, error: error.message }));
        if (!r?.ok) { status().textContent = '没改成：' + (r?.error || '未知原因'); return; }
        adopt(r);
        if (gwExtra.health?.rows) gwExtra.health = { ...gwExtra.health, rows: gwExtra.health.rows.map(x => (x.id === id ? { ...x, noThinking: !enabled } : x)) };
        paintAside();
        status().textContent = enabled ? `已恢复 ${id} 的思考。` : `已对 ${id} 关闭思考：之后的新请求直接回答，不再先想。点「一键体检」可以看关掉后的首字时间。`;
      },
      pickModel: (id, from) => {
        if (!id) { status().textContent = '体检里还没有能用的模型，先点「一键体检」看看各模型的情况。'; return; }
        form.elements.model.value = id;
        status().textContent = `已把默认模型换成 ${id}${from ? `（${from} 暂不可用）` : ''}，点「保存配置」生效。`;
      },
    };
    const paintAside = () => {
      const slot = target.querySelector('[data-api-gw-slot]');
      if (!slot) return;
      slot.innerHTML = gwHealth.asideHtml({ gateway: snapshot?.gateway || g, ...gwExtra }, gwExtra.running);
      gwHealth.bind(slot, { gateway: snapshot?.gateway || g, ...gwExtra }, hooks);
    };
    const adopt = r => {
      if (!r) return;
      if (r.gateway) snapshot = { ...snapshot, gateway: r.gateway, providers: r.providers || snapshot?.providers };
      if ('health' in r) gwExtra.health = r.health;
      if ('catalog' in r) gwExtra.catalog = r.catalog;
      gwExtra.loaded = true;
      const select = form.isConnected ? form.elements.model : null;
      if (select && r.gateway) { const keep = select.value; select.innerHTML = optionsHtml(r.gateway, r.gateway.choices?.some(c => c.id === keep) ? keep : r.gateway.model); }
    };
    async function runHealth() {
      const button = target.querySelector('[data-api-action="gw-health"]');
      if (button) button.disabled = true;
      gwExtra.running = true; paintAside();
      status().textContent = '正在体检：每个模型发一句极短的话，测首字时间、工具调用和思考，约 10–60 秒…';
      try {
        const r = await ipcRenderer.invoke('api-gateway:healthcheck');
        gwExtra.running = false; adopt(r); paintAside();
        if (!r?.ok) { status().textContent = '体检没完成：' + (r?.message || r?.error || '未知原因'); return; }
        const rows = gwExtra.health?.rows || [];
        const ok = rows.filter(x => x.ok), tools = ok.filter(x => x.tools === true);
        status().textContent = `体检完成：${rows.length} 个对话模型里 ${ok.length} 个能用${tools.length ? `，${tools.length} 个会调用工具` : ''}${ok.length < rows.length ? '；不能用的看右边原因和按钮' : ''}。`;
      } catch (error) { gwExtra.running = false; paintAside(); status().textContent = '体检没完成：' + error.message; }
      finally { const b = target.querySelector('[data-api-action="gw-health"]'); if (b && snapshot?.gateway?.keySet) b.disabled = false; }
    }
    if (!gwProgressBound) {
      gwProgressBound = true;
      ipcRenderer.on('api-gateway:health-progress', (_event, row) => {
        const slot = dialog?.querySelector('[data-api-gw-slot]');
        if (!slot || !row?.id) return;
        gwHealth.updateRow(slot, row);
      });
    }
    paintAside();
    target.querySelector('[data-api-action="gw-health"]').onclick = () => void runHealth();
    // 默认模型下拉选「手填模型名…」：展开输入框；检测通过就加进下拉并选中，不通在状态行写原因。
    const customBox = form.querySelector('[data-gw-custom]');
    let lastPick = form.elements.model.value;
    form.elements.model.addEventListener('change', () => {
      const picking = form.elements.model.value === '__custom__';
      if (customBox) customBox.hidden = !picking;
      if (picking) { form.elements.model.value = lastPick; form.querySelector('[data-gw-custom-input]')?.focus(); status().textContent = '填模型名后点「检测并加入」：先发一句极短的话测通，再加进模型表。'; }
      else lastPick = form.elements.model.value;
    });
    const customCheck = form.querySelector('[data-api-action="gw-custom-check"]');
    // 手填框里按回车 =「检测并加入」，不提交外层表单（R45-3 审查 P2-4）。
    form.querySelector('[data-gw-custom-input]')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); customCheck?.click();
    });
    if (customCheck) customCheck.onclick = async () => {
      const input = form.querySelector('[data-gw-custom-input]'), name = input.value.trim();
      if (!name) { status().textContent = '先填模型名。'; input.focus(); return; }
      customCheck.disabled = true; status().textContent = `正在检测 ${name}：发一句极短的话，网关排队时可能要等十几秒…`;
      try {
        const r = await ipcRenderer.invoke('api-gateway:add-model', { model: name });
        if (r?.gateway) snapshot = { ...snapshot, gateway: r.gateway, providers: r.providers || snapshot?.providers };
        if (!r?.ok) { status().textContent = `没加上：${r?.error || '未知原因'}`; return; }
        form.elements.model.innerHTML = optionsHtml(snapshot.gateway, r.model);
        form.elements.model.value = r.model; lastPick = r.model;
        customBox.hidden = true; input.value = '';
        status().textContent = `${r.already ? '模型表里已经有' : '已测通并加入'} ${r.model}，已选为默认模型；点「保存配置」生效。`;
      } catch (error) { status().textContent = '没加上：' + error.message; }
      finally { customCheck.disabled = false; }
    };
    // 打开时：刷新公开目录；已存 key 但还没体检过 → 自动体检一次。
    if (!gwExtra.loaded) {
      void ipcRenderer.invoke('api-gateway:catalog').then(r => {
        if (!form.isConnected) return;
        adopt(r); paintAside();
        if (snapshot?.gateway?.keySet && !gwExtra.health && !gwExtra.running) void runHealth();
      }).catch(() => {});
    }
    const clearButton = target.querySelector('[data-api-action="gw-clear"]');
    if (clearButton) clearButton.onclick = async () => {
      try {
        const r = await ipcRenderer.invoke('api-gateway:clear');
        snapshot = { ...snapshot, gateway: r.gateway, providers: r.providers || snapshot.providers };
        render(kind);
        dialog.querySelector('form [role="status"]').textContent = '已删除本机保存的 key。用网关的会话之后发消息会提示重新粘贴 key。';
      } catch (error) { status().textContent = '没删成：' + error.message; }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const save = form.querySelector('[type="submit"]');
      const typedKey = form.elements.apiKey.value.trim();
      save.disabled = true;
      status().textContent = '正在验证并保存…（请求一次模型列表，通常 1 秒内）';
      try {
        const kinds = [kind, ...(form.elements.alsoOthers?.checked ? others : [])];
        const r = await ipcRenderer.invoke('api-gateway:save', { baseURL: form.elements.baseURL.value, apiKey: form.elements.apiKey.value, model: form.elements.model.value, useFor: kinds });
        if (r?.gateway) snapshot = { ...snapshot, gateway: r.gateway, providers: r.providers || snapshot.providers };
        if (!r?.ok) { status().textContent = r?.error || '保存没成功'; return; }
        const fresh = await ipcRenderer.invoke('company-api:get');
        if (fresh?.ok) snapshot = fresh;
        gwExtra = { health: r.health ?? gwExtra.health, catalog: r.catalog ?? gwExtra.catalog, loaded: true, running: false, for: dialog };
        render(kind);
        dialog.querySelector('form [role="status"]').textContent = `已保存。新建 ${kinds.map(k => LABELS[k]).join('、')} 会话走网关（${snapshot?.gateway?.model || form.elements.model.value}）；进行中的会话保持原线路。`;
        // 新填的 key：主进程已在后台开始体检，这里接上它显示进度（同一轮，不会重复发请求）。
        if (typedKey || r.healthRunning) dialog.querySelector('[data-api-action="gw-health"]')?.click();
        void refreshInstall().catch(() => {});
      } catch (error) { status().textContent = '保存没成功：' + error.message; }
      finally { save.disabled = false; }
    };
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
      + `<strong>公司模型通道：${esc(PROXY_STATE[proxy.state] || '状态待确认')}</strong></div>`
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
    // 本机没有 CodeAgent 时区域永远读不出来，别一直显示「正在识别…」。
    const noCodeAgent = Array.isArray(proxy?.missing) && proxy.missing.includes('codeagentVersion');
    const text = proxy?.mock ? '模拟上游（测试用）不按区域路由。' : proxy?.zone?.text || (noCodeAgent ? '这台电脑上没找到 CodeAgent，没法自动识别区域。装好 CodeAgent 并登录后会自动识别；也可以先在上面直接选。没有 CodeAgent 账号时，改用「API 网关」或「自有接口」。' : unknown ? '还没识别出你所在的区域（蓝区 / 绿区 / 黄区），请在下面选择。选错了，公司模型的请求会全部失败。'
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
      status.textContent = zone ? `已改为${ZONE_NAMES[zone]}，正在重新启动模型通道…` : '已改为自动识别，正在重新启动模型通道…';
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
    const current = value.backend === 'proxy' && value.upstream !== 'gateway' ? value.model : models[0].id;
    target.insertAdjacentHTML('beforeend', '<form data-proxy-form><label>默认模型<select name="model">'
      + models.map(m => `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.label)}</option>`).join('') + '</select></label>'
      + `<div data-proxy-zone>${zoneHtml()}</div>`
      + `<div data-proxy-status>${proxyStatusHtml(kind)}</div>`
      + '<p class="company-api-note">只用 CodeAgent 已登录的账号，不会替你登录或刷新登录；公司模型只收文字，不支持联网搜索。新建会话时也可在模型菜单里换另一个模型。</p>'
      + `<p class="company-api-message" role="status" aria-live="polite"></p><footer><button type="button" data-api-action="proxy-restart">${snapshot?.proxy?.shared ? '重新连接主机' : '重新启动模型通道'}</button><button type="button" data-api-action="close">取消</button><button type="submit" class="primary">保存配置</button></footer></form>`);
    target.querySelector('[data-api-action="close"]').onclick = close;
    bindZone(target);
    target.querySelector('[data-api-action="proxy-restart"]').onclick = async event => {
      const button = event.currentTarget, status = target.querySelector('[role="status"]');
      button.disabled = true;
      status.textContent = snapshot?.proxy?.shared ? '正在重新连接共享主机…' : '正在重新启动模型通道…';
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
  // 自有接口「测试连接」（2026-11-20）：请求一次模型列表，结果就地写清；模型名给下拉候选，地址缺 /v1 时自动补。
  // Claude Code 只认 Anthropic 格式：能列出模型的多半是 OpenAI 兼容接口，就地给「改用 API 网关接入」（Hub 本机转格式）。
  const BASE_NOTE = { 'added-v1': '，地址已自动补上 /v1', 'removed-v1': '，地址已去掉末尾的 /v1（Claude Code 会自己拼 /v1/messages）' };
  function bindOwnTest(target, kind, profileId) {
    const button = target.querySelector('[data-api-action="own-test"]');
    if (!button) return;
    button.onclick = async () => {
      const form = target.querySelector('form[data-api-form]'), status = form.querySelector('[role="status"]'), hint = form.querySelector('[data-own-hint]');
      const baseURL = form.elements.baseURL.value.trim(), apiKey = form.elements.apiKey.value.trim();
      hint.hidden = true; hint.innerHTML = '';
      form.querySelectorAll('footer [data-own-fix]').forEach(item => item.remove());
      if (!baseURL) { status.textContent = '先填接口地址再测试（例如 http://xxx/v1）。'; form.elements.baseURL.focus(); return; }
      button.disabled = true; status.textContent = '正在测试连接…（先读模型列表，再按会话实际走的协议发一句极短的话）';
      try {
        const typedModel = form.elements.model.value.trim();
        const r = await ipcRenderer.invoke('company-api:probe', { kind, baseURL, apiKey, profileId, model: typedModel, wireApi: form.elements.wireApi?.value || 'responses' });
        if (!r?.ok) { status.textContent = '测试没通过：' + (r?.error || '未知原因'); return; }
        if (r.baseURL) form.elements.baseURL.value = r.baseURL;
        const model = form.elements.model;
        // 主进程总会给出这次测对话用的模型（留空时自动填推荐模型；旧接口的模型在新接口测不通时改选新接口的）。
        model.value = r.model || model.value;
        // 用普通下拉框列出接口上的模型（不用 datalist：Electron 里弹 datalist 候选框有崩溃风险），选了就填进模型框。
        const pick = form.querySelector('[data-own-model-pick]'), select = form.querySelector('[data-own-model-select]');
        if (pick && select) {
          select.innerHTML = r.models.map(id => `<option value="${esc(id)}"${id === model.value ? ' selected' : ''}>${esc(id)}</option>`).join('');
          select.onchange = () => { model.value = select.value; };
          pick.hidden = false;
        }
        // 一键把接口上的模型都加进「可选模型」（R45），不用一个个抄。
        const all = form.querySelector('[data-own-models-all]');
        if (all && form.elements.models && r.models.length > 1) {
          all.hidden = false;
          all.textContent = `全部加入（${r.models.length} 个）`;
          all.onclick = () => {
            form.elements.models.value = [model.value.trim(), ...r.models].filter((id, i, list) => id && list.indexOf(id) === i).join(', ');
            status.textContent = `已把接口上的 ${r.models.length} 个模型加进「可选模型」，默认用「${model.value.trim()}」。点「${editing() ? '保存修改' : '保存配置'}」生效。`;
          };
        }
        // 对话测试（R45）：和会话同一个地址 / Key / 模型 / 协议。没通过时在这里一行说清原因，按钮就在旁边。
        const chat = r.chat || null;
        const chatLine = chat ? (chat.ok ? chat.message : '') : '';
        // 对话没通过：原因直接写在状态行（一处说清），下面只放按钮，省高度、一屏放下。
        status.textContent = chat && !chat.ok && !chat.skipped
          ? `模型列表能读到（${r.models.length} 个），但对话测试没通过：${chat.message}`
          : `连接正常：接口上有 ${r.models.length} 个模型${BASE_NOTE[r.baseChange] || ''}；模型已填「${model.value}」${r.replacedModel ? `（原来的「${r.replacedModel}」在这个接口上测不通，已改选）` : ''}，可在「接口上的模型」里换。${chatLine ? chatLine + ' ' : chat?.skipped ? chat.message + ' ' : ''}点「${editing() ? '保存修改' : '保存配置'}」生效。`
            + (r.keyUsed === 'none' ? '（没填 Key 也连上了；如果发消息报 key 无效，请补上 Key）' : '');
        // 原因已写在状态行时，修复按钮放进底栏左侧（不另占一行，1440×900 一屏放下）。
        const toFooter = () => {
          const fix = hint.querySelector('button'), footer = form.querySelector('footer');
          if (!fix || !footer || hint.querySelector('p')) return;
          fix.dataset.ownFix = '1'; footer.prepend(fix); hint.hidden = true;
        };
        if (chat && !chat.ok && !chat.skipped && chat.fix !== 'gateway') {
          hint.innerHTML = `<span data-own-chat-error hidden>${esc(chat.message)}</span>` + (chat.fix === 'chat' ? '<button type="button" data-api-action="own-to-chat">改用 chat 协议</button>' : '');
          hint.hidden = true;
          const toChat = hint.querySelector('[data-api-action="own-to-chat"]');
          if (toChat) toChat.onclick = () => { if (form.elements.wireApi) form.elements.wireApi.value = 'chat'; button.click(); };
          toFooter();
        }
        // Claude Code：对话测试确认是 OpenAI 格式（或没能测到对话）时，给「改用 API 网关接入」；对话测试通过就不打扰。
        if (kind === 'claude' && (!chat || chat.fix === 'gateway' || chat.skipped)) {
          hint.hidden = false;
          hint.innerHTML = (chat?.fix === 'gateway' ? `<span data-own-chat-error hidden>${esc(chat.message)}</span>`
            : '<p>这个地址能列出模型，多半是 <strong>OpenAI 兼容接口</strong>。Claude Code 只认 Anthropic 格式，直接填进来发消息常会报 404 或格式错误。'
              + '想用 Claude Code 就改用「API 网关」接入：Hub 在本机把请求转成 OpenAI 格式，地址、Key、模型照用这一份。</p>')
            + '<button type="button" data-api-action="own-to-gateway">改用 API 网关接入</button>';
          toFooter();
          form.querySelector('[data-api-action="own-to-gateway"]').onclick = async event => {
            const key = form.elements.apiKey.value.trim(), go = event.currentTarget;
            if (!key) { status.textContent = '请在「API Key」里再粘贴一次 key，然后点「改用 API 网关接入」（已保存的 Key 不会转给网关）。'; form.elements.apiKey.focus(); return; }
            // 网关是各工具共用的一份（Codex 审查 P1）：已配了别的网关地址时，先说清会影响谁，再点一次才替换。
            const g0 = snapshot?.gateway, wanted = form.elements.baseURL.value.trim().replace(/\/+$/, '');
            const users = KINDS.filter(k => k !== kind && snapshot?.providers?.[k]?.backend === 'proxy' && snapshot.providers[k].upstream === 'gateway').map(k => LABELS[k]);
            if (g0?.keySet && String(g0.baseURL || '').replace(/\/+$/, '') !== wanted && go.dataset.confirm !== '1') {
              go.dataset.confirm = '1'; go.textContent = '确认替换 API 网关';
              status.textContent = `这台电脑已经配了 API 网关（${g0.baseURL}）${users.length ? `，${users.join('、')} 正在用它` : ''}。改用这个地址后，${users.length ? '它们之后发的消息也会转到新地址' : '原来的网关配置会被替换'}。确定就再点一次「确认替换 API 网关」。`;
              return;
            }
            go.disabled = true; status.textContent = '正在改用 API 网关接入…';
            try {
              const g = await ipcRenderer.invoke('api-gateway:save', { baseURL: form.elements.baseURL.value.trim(), apiKey: key, model: form.elements.model.value.trim(), useFor: [kind] });
              if (!g?.ok) { status.textContent = '没改成：' + (g?.error || '未知原因'); go.disabled = false; return; }
              const fresh = await ipcRenderer.invoke('company-api:get');
              if (fresh?.ok) snapshot = fresh;
              viewMode[kind] = 'gateway';
              const chosen = form.elements.model.value.trim();
              render(kind);
              dialog.querySelector('form [role="status"]').textContent = `已改用 API 网关接入。新建 Claude Code 会话经本机转给这个接口（${chosen}）。`;
            } catch (error) { status.textContent = '没改成：' + error.message; go.disabled = false; }
          };
        }
      } catch (error) { status.textContent = '测试没通过：' + error.message; }
      finally { button.disabled = false; }
    };
    const editing = () => !!target.querySelector('[data-api-action="profile-delete"]');
  }
  // 可选模型输入框的初值：模型表有两个以上才写（只有默认模型时留空，看占位提示）。
  const ownListText = list => (Array.isArray(list) && list.length > 1 ? list.join(', ') : '');
  function render(kind) {
    const target = makeDialog();
    const value = snapshot?.providers?.[kind] || {};
    const mode = viewMode[kind] || (value.backend === 'proxy' ? (value.upstream === 'gateway' ? 'gateway' : 'proxy') : 'own');
    const profiles = kind === 'deepseek-acp' ? [] : value.apiProfiles || [];
    const profileId = viewProfile[kind] ?? value.selectedProfileId ?? '';
    const editing = profiles.find(profile => profile.id === profileId);
    const own = editing || (profileId === 'new' ? {} : value.backend === 'proxy' ? value.ownConnection || {} : value);
    const needsKey = !!own.apiKeyNeedsInput;
    target.innerHTML = heading('自有 API', '每个工具可用公司模型、部门 API 网关，或填写自己的接口；留空沿用 CLI 本机登录与配置。', true)
      + `<nav aria-label="API 工具">${KINDS.map(id => `<button type="button" data-api-kind="${id}" aria-pressed="${id === kind}">${LABELS[id]}</button>`).join('')}</nav>`
      + modeSwitch(mode);
    bindClose(target);
    target.classList.toggle('api-gw-wide', mode === 'gateway'); // 网关页左右两栏，一屏放下
    target.querySelectorAll('[data-api-kind]').forEach(button => { button.onclick = () => render(button.dataset.apiKind); });
    target.querySelectorAll('[data-api-mode]').forEach(button => { button.onclick = () => { viewMode[kind] = button.dataset.apiMode; render(kind); }; });
    if (mode === 'proxy') { renderProxy(target, kind, value); return; }
    if (mode === 'gateway') { renderGateway(target, kind, value); return; }
    target.insertAdjacentHTML('beforeend', `<form data-api-form>${kind !== 'deepseek-acp' ? `<label>API 账号<select data-api-profile><option value="">当前接口 / 本机配置</option>${profiles.map(profile => `<option value="${esc(profile.id)}"${profileId === profile.id ? ' selected' : ''}>${esc(profile.label)}</option>`).join('')}<option value="new"${profileId === 'new' ? ' selected' : ''}>＋ 添加 API 账号</option></select></label>` : ''}`
      + (profileId ? `<label>账号名称<input name="label" value="${esc(editing?.label)}" maxlength="80" required placeholder="例如：供应商 A · 账号 1"></label>` : '')
      + `<label class="own-api-wide">接口地址<input name="baseURL" type="url" value="${esc(own.baseURL)}" placeholder="留空沿用本机配置" autocomplete="off" spellcheck="false"></label>`
      + `<label class="own-api-wide"><span>API Key${require('./launch-field-hint').iconHintHtml(require('./credential-hints').ownApiKey())}</span><input name="apiKey" type="password" ${needsKey ? 'required' : ''} placeholder="${needsKey ? '请重新粘贴此接口的 Key' : own.apiKeySet ? '已保存；留空保留原 Key' : '可选；留空沿用本机登录'}" autocomplete="off" spellcheck="false"></label>`
      + `<label>默认模型<input name="model" value="${esc(own.model)}" placeholder="${kind === 'deepseek-acp' ? '必填；点「测试连接」从列表里选' : '留空沿用 CLI 配置的模型'}" autocomplete="off" spellcheck="false"></label><label data-own-model-pick hidden>接口上的模型<select data-own-model-select></select></label>`
      // 可选模型（R45）：一个接口配多个模型，启动中心每个模型一张卡；「测试连接」后可一键把接口上的模型都加进来。
      + `<label data-own-models><span>可选模型<button type="button" class="company-api-inline-link" data-own-models-all hidden></button></span><input name="models" value="${esc(ownListText(editing ? editing.models : profileId === 'new' ? null : value.backend === 'proxy' ? value.ownConnection?.ownModels : value.ownModels))}" placeholder="可填多个，逗号分隔；新建会话时都能选。点「测试连接」可一键全部加入" autocomplete="off" spellcheck="false"></label>`
      + (kind === 'codex' ? `<label>接口协议<select name="wireApi"><option value="responses"${own.wireApi === 'chat' ? '' : ' selected'}>responses（默认）</option><option value="chat"${own.wireApi === 'chat' ? ' selected' : ''}>chat</option></select></label>` : '')
      + `<p class="company-api-message" role="status" aria-live="polite">${needsKey ? 'Key 无法解密，请补填后保存并继续。' : ''}</p><div class="company-api-own-hint" data-own-hint hidden></div><footer>`
      + '<button type="button" data-api-action="own-test">测试连接</button>'
      + (editing ? '<button type="button" data-api-action="profile-delete">删除此账号</button>' : '')
      + `<button type="button" data-api-action="local">${kind === 'deepseek-acp' ? '清空自有接口' : '沿用本机配置'}</button><button type="button" data-api-action="close">取消</button><button type="submit" class="primary">${needsKey ? '保存并继续' : editing ? '保存修改' : '保存配置'}</button></footer></form>`);
    target.querySelector('[data-api-action="close"]').onclick = close;
    const profileSelect = target.querySelector('[data-api-profile]');
    if (profileSelect) profileSelect.onchange = () => { viewProfile[kind] = profileSelect.value; render(kind); };
    bindOwnTest(target, kind, profileId && profileId !== 'new' ? profileId : '');
    const deleteButton = target.querySelector('[data-api-action="profile-delete"]');
    if (deleteButton) deleteButton.onclick = async () => {
      const status = target.querySelector('[role="status"]');
      if (deleteButton.dataset.confirm !== '1') {
        deleteButton.dataset.confirm = '1'; deleteButton.textContent = '确认删除';
        status.textContent = `再点一次「确认删除」删掉「${editing.label}」。已开的会话不受影响，新建会话不再能选它。`;
        return;
      }
      deleteButton.disabled = true;
      try {
        const result = await ipcRenderer.invoke('company-api:save', { kind, profileAction: 'delete', profileId: editing.id });
        if (!result?.ok) throw new Error(result?.error || '删除失败');
        snapshot = result;
        delete viewProfile[kind];
        render(kind);
        dialog.querySelector('form [role="status"]').textContent = `已删除「${editing.label}」。`;
      } catch (error) { status.textContent = '没删成：' + error.message; deleteButton.disabled = false; }
    };
    target.querySelector('[data-api-action="local"]').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await ipcRenderer.invoke('company-api:save', { kind, useLocal: true });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = { ...snapshot, ...result };
        delete viewProfile[kind];
        delete viewMode[kind];
        render(kind);
        dialog.querySelector('[role="status"]').textContent = kind === 'deepseek-acp' ? '已清空 DSH 自有接口。DSH 会话请选「API 网关」或「公司模型」。' : '已清除 Hub 的接口覆盖；新建会话沿用本机配置。';
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
        const result = await ipcRenderer.invoke('company-api:save', { kind, ...request,
          ...(profileId ? { profileAction: 'save', ...(profileId !== 'new' ? { profileId } : {}) } : {}) });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        snapshot = result;
        if (profileId) {
          viewProfile[kind] = result.providers[kind].selectedProfileId;
          render(kind);
          dialog.querySelector('form [role="status"]').textContent = '已保存。新建会话使用此 API 账号。';
          return;
        }
        render(kind);
        dialog.querySelector('form [role="status"]').textContent = kind === 'deepseek-acp' ? (result.providers?.[kind]?.backend === 'api' ? `已保存。新建 DSH 会话直连这个接口（${result.providers[kind].model || '未填模型'}）。` : '已清空 DSH 自有接口。')
          : '已保存。新建会话使用这些设置。';
      } catch (error) { status.textContent = '保存失败：' + error.message; }
      finally { save.disabled = false; }
    };
  }
  // options.mode：直接停在某张来源卡上（如「功能使用的 Agent」的「去配置部门 API key」传 'gateway'）。
  async function open(kind = 'claude', profileId, options = {}) {
    if (profileId !== undefined) { viewProfile[kind] = profileId; viewMode[kind] = 'own'; }
    if (options?.mode === 'gateway') viewMode[kind] = 'gateway';
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
      // 找到了但跑不起来 / 版本太低：打开体检里这一项的结论卡（原因、修复按钮、查过的位置），不弹「未安装」说明。
      if (button && BADGE_KINDS.includes(button.dataset.kind) && ['broken', 'too-old'].includes(button.dataset.harness) && window.__envCheck?.open) {
        event.preventDefault(); event.stopImmediatePropagation();
        void window.__envCheck.open({ focus: hxView.KIND_TO_ID[button.dataset.kind] });
        return;
      }
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
    ipcRenderer.on('cli-tools:state', (_event, state) => {
      if (!state) return;
      cliState = state;
      const slot = dialog?.querySelector('[data-cli-install]');
      if (slot) renderCliBlock(dialog, slot.dataset.cliInstall);
    });
    window.__companyApiOpen = open;
    void refreshInstall().catch(() => {});
    // 定位中心的结论变了（轮询、自愈、装完）：只改对应的那个按钮。
    harness.onChange((id, result) => {
      if (!result?.verdict) return;
      located[id] = result;
      for (const kind of BADGE_KINDS) if (hxView.KIND_TO_ID[kind] === id) paintLocated(kind);
    });
    // 打开启动中心时刷新一次（定位中心 2 分钟内走缓存，不重复试跑）。
    const menu = document.getElementById('new-session-menu');
    if (menu && typeof MutationObserver === 'function') {
      let shown = false;
      new MutationObserver(() => {
        const now = menu.getClientRects().length > 0;
        if (now && !shown) void refreshLocated().catch(() => {});
        shown = now;
      }).observe(menu, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    document.getElementById('community-refresh')?.addEventListener('click', () => void refreshInstall({ fresh: true }).catch(() => {}));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
