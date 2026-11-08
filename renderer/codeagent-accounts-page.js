'use strict';
const { renderAccounts } = require('./codeagent-accounts-view');
const { canStartAccount } = require('./codeagent-account-state');
const { tokenPageHtml } = require('./account-token-view');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// All operations use the existing account IPC and registry format.
async function accountCommand(ipcRenderer, action, { id, note, dir, hours } = {}) {
  const names = { refresh: 'list', add: 'add', import: 'import', probe: 'probe', pause: 'pause', resume: 'resume', remove: 'remove', note: 'note', login: id === 'personal' ? 'personal-login' : 'login' };
  if (!names[action]) throw new Error('未知账号操作');
  const payload = action === 'add' ? { note } : action === 'import' ? { dir } : action === 'pause' ? { id, hours: hours ? Number(hours) : null } : action === 'note' ? { id, note } : { id };
  const result = await ipcRenderer.invoke('codeagent-pool:' + names[action], payload);
  if (!result || result.ok === false) throw new Error(result?.error || '账号操作没有完成');
  return result;
}
function createCodeagentAccountsPage({ document, window = document.defaultView, ipcRenderer, configModal, closeOtherPanels = () => {}, openSession = () => {}, notify = () => {} }) {
  const setup = require('./codeagent-setup').createCodeAgentSetup({ document, ipcRenderer });
  // 本机装了多个版本的 CodeAgent（2026-11-07）：页头下方一行提示，点开是版本选择器（renderer/tool-version-picker.js）。
  const toolPicker = require('./tool-version-picker').createToolVersionPicker({ document, ipcRenderer });
  document.addEventListener('tool-version-changed', e => { if (e.detail?.tool === 'codeagent') { state.toolChoice = e.detail.summary; void setup.refresh().then(() => refresh()); } });
  let page, pool = null, timer, revision = 0, disposed = false, pending = null, scanDue = false;
  let locateId = '', locateUntil = 0, locateTimer;
  const state = { view: 'accounts', metric: 'total', tokens: null, tokenFirstSyncAsked: false, local: [], probing: new Set(), queue: [], drawer: false, note: '', menu: '', sub: false, filter: 'all', loading: false, busy: false, message: '' };
  function render() {
    if (!page || page.hidden || disposed) return;
    const next = document.createElement('template');
    next.innerHTML = renderAccounts(pool, { ...state, installed: setup.current?.installed,
      tokenFor: account => require('./codeagent-quota-panel-view').tokenMetric({ usage: globalThis.codeagentQuotaBar?.usageFor?.(account.id), defaultModel: account.defaultModel }) });
    const main = page.querySelector('.caa-main'), content = next.content.querySelector('.caa-main');
    if (state.view === 'token') content.innerHTML = tokenViewHtml();
    if (main) {
      const scroll = main.scrollTop;
      main.innerHTML = content.innerHTML;
      main.scrollTop = scroll;
    } else page.append(content);
    const drawer = page.querySelector('.caa-drawer');
    if (!state.drawer) {
      drawer?.remove(); page.querySelector('.caa-scrim')?.remove();
    } else if (!drawer) {
      page.append(next.content.querySelector('.caa-scrim'), next.content.querySelector('.caa-drawer'));
    } else {
      // Keep the same input node, focus, selection and active IME composition.
      // Polling only refreshes the account list and import candidates.
      const local = drawer.querySelector('.caa-local'), updated = next.content.querySelector('.caa-local');
      if (local.innerHTML !== updated.innerHTML) local.innerHTML = updated.innerHTML;
      drawer.querySelector('[data-ca="add"]').disabled = !!state.busy;
    }
    const hint = toolPicker.hintHtml(state.toolChoice);
    page.querySelector('[data-tvp-slot]')?.remove();
    if (hint && state.view === 'accounts') page.querySelector('.caa-page-head')?.insertAdjacentHTML('afterend', `<div data-tvp-slot>${hint}</div>`);
    if (Date.now() < locateUntil) locatedRow()?.classList.add('is-located');
    // 号池内网共享卡片（renderer/lan-pool-settings.js）：主机看同事用量，同事看共享号额度。
    if (state.view === 'accounts') window.__lanPoolMountAccount?.(page.querySelector('.caa-page'));
    page.querySelector('.caa-page-head')?.insertAdjacentHTML('afterend', viewTabsHtml());
  }
  function viewTabsHtml() {
    const tab = (view, label) => `<button type="button" role="tab" data-ca="view" data-view="${view}" aria-selected="${state.view === view}">${label}</button>`;
    return `<div class="caa-view-tabs" role="tablist" aria-label="账号页内容">${tab('accounts', '账号')}${tab('token', 'Token 开销')}</div>`;
  }
  function accountName(provider, id) {
    if (provider !== 'codeagent') return id === 'default' ? '默认账号' : id;
    if (id === 'personal') return '我的账号';
    const account = pool?.accounts?.find(a => a.id === id);
    return account?.note || account?.accountLabel || '已移出号池的账号';
  }
  function tokenViewHtml() {
    return `<div class="caa-page"><header class="caa-page-head"><div><h1 class="caa-page-title">账号</h1><p class="caa-page-sub">各工具的 token 用量，只在本机统计。</p></div></header><div class="atk-wrap">${tokenPageHtml(state.tokens, { metric: state.metric, accountName }, escapeHtml)}</div></div>`;
  }
  // 第一次切到这页就自动统计，不要求用户先点按钮。
  async function loadTokens() {
    try {
      state.tokens = await ipcRenderer.invoke('token-usage:state');
      if (state.tokens && !state.tokens.syncedAt && !state.tokens.running && !state.tokenFirstSyncAsked) {
        state.tokenFirstSyncAsked = true;
        state.tokens = await ipcRenderer.invoke('token-usage:sync');
      }
    } catch (error) { state.tokens = { days: {}, syncedAt: 0, error: error.message }; }
    render();
  }
  function tokensChanged(_event, next) { state.tokens = next; if (state.view === 'token') render(); }
  function locatedRow() {
    return [...(page?.querySelectorAll('[data-ca-account]') || [])].find(row => row.dataset.caAccount === locateId);
  }
  function locateAccount() {
    if (!locateId || page?.hidden || disposed) return;
    const row = locatedRow();
    if (!row) return;
    clearTimeout(locateTimer); locateUntil = Date.now() + 1500;
    row.classList.add('is-located'); row.setAttribute('tabindex', '-1');
    row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true });
    locateTimer = setTimeout(() => { locatedRow()?.classList.remove('is-located'); locateId = ''; locateUntil = 0; }, 1500);
  }
  function message(text) { state.message = text; render(); notify(text); }
  function place() {
    if (!page || page.hidden) return;
    Object.assign(page.style, { left: (document.getElementById('scene-rail')?.getBoundingClientRect().right || 0) + 'px', top: (document.getElementById('app-toolbar')?.getBoundingClientRect().bottom || 0) + 'px', bottom: (document.getElementById('hub-system-footer')?.getBoundingClientRect().height || 0) + 'px' });
  }
  function poll() {
    clearTimeout(timer);
    if (!page?.hidden && !disposed && ((pool?.accounts || []).some(a => a.state === 'login-required') || state.waitingPersonal)) timer = setTimeout(() => void refresh(), 3000);
  }
  // The local-candidate scan reads every .cac* directory and is only needed for
  // the import prompts. It runs on page entry, manual refresh, mutations that
  // change candidates, and while the drawer is open; status polling and change
  // notifications skip it. scanDue survives a superseded request, so a scan that
  // was asked for still happens. importLocal re-validates in the main process.
  async function refresh({ scan = false } = {}) {
    if (disposed || page?.hidden) return;
    if (scan || state.drawer) scanDue = true;
    const request = ++revision;
    state.loading = true; render();
    const operation = (async () => {
      try {
        const [status, local, choice] = await Promise.all([accountCommand(ipcRenderer, 'refresh'), scanDue ? ipcRenderer.invoke('codeagent-pool:local').catch(error => ({ ok: false, error: error.message })) : null,
          ipcRenderer.invoke('tool-discovery:list', { tool: 'codeagent' }).catch(() => null)]);
        if (choice && choice.ok !== false) state.toolChoice = choice;
        if (request !== revision || disposed) return;
        pool = status;
        if (local) scanDue = false;
        if (local?.ok) state.local = local.candidates || [];
        else if (local) state.message = '本机账号扫描失败：' + (local?.error || '稍后点刷新重试');
        if (pool.personal?.state === 'ready') state.waitingPersonal = false;
      } catch (error) { if (request === revision) { pool = { ok: false, error: error.message }; state.message = error.message; } }
      finally { if (request === revision) { state.loading = false; render(); poll(); } }
    })();
    pending = operation;
    await operation;
    if (pending === operation) pending = null;
  }
  async function probe(ids) {
    if (state.probing.size || state.queue.length) return;
    state.queue = [...ids]; state.total = ids.length; state.completed = 0; state.message = ''; state.menu = '';
    render();
    const errors = [];
    while (state.queue.length && !disposed) {
      const id = state.queue.shift(); state.probing.add(id); render();
      try { pool = await accountCommand(ipcRenderer, 'probe', { id }); }
      catch (error) { errors.push(`${id === 'personal' ? '个人账号' : pool?.accounts?.find(a => a.id === id)?.note || '号池账号'}：${error.message}`); }
      finally { state.probing.delete(id); state.completed++; render(); }
    }
    if (!disposed) message(errors.length ? '部分模型权限未获取：' + errors.join('；') : ids.length ? '模型权限已更新' : '先登录账号，再获取模型权限');
  }
  async function act(action, element) {
    const id = element?.dataset?.id;
    if (action === 'view') {
      state.view = element.dataset.view === 'token' ? 'token' : 'accounts'; state.menu = ''; render();
      if (state.view === 'token') await loadTokens();
      return;
    }
    if (action === 'token-metric') { state.metric = element.dataset.v === 'net' ? 'net' : 'total'; render(); return; }
    if (action === 'token-sync') { state.tokens = await ipcRenderer.invoke('token-usage:sync'); render(); return; }
    if (action === 'install-guide') { setup.showGuide(); return; }
    if (action === 'check-install') { await setup.refresh(); await refresh({ scan: true }); return; }
    if (['login', 'add', 'probe', 'probe-all', 'session', 'drawer'].includes(action)) {
      await setup.refresh();
      if (setup.current?.installed === false) { setup.showGuide(); return; }
    }
    if (action === 'filter') {
      const filter = element?.dataset?.filter;
      if (!['all', 'usable', 'needs'].includes(filter)) return;
      state.filter = filter; state.menu = ''; render();
      page.querySelector(`.caa-counts [data-filter="${filter}"]`)?.focus();
      return;
    }
    if (action === 'menu') { state.menu = state.menu === id ? '' : id; state.sub = false; render(); return; }
    if (action === 'pause-menu') { state.sub = !state.sub; render(); return; }
    if (action === 'drawer' || action === 'close-drawer') { state.drawer = action === 'drawer'; state.menu = ''; render(); if (state.drawer) { page.querySelector('#ca-note')?.focus(); void refresh({ scan: true }); } return; }
    if (action === 'session') {
      const account = id === 'personal' ? pool?.personal : pool?.accounts?.find(a => a.id === id);
      if (!canStartAccount(account, { personal: id === 'personal' })) { message('这个账号暂时不可用，请先恢复使用或重新登录'); return; }
      close(); openSession(id); return;
    }
    if (action === 'refresh') { state.message = ''; await refresh({ scan: true }); return; }
    if (action === 'probe' || action === 'probe-all') {
      const personal = pool?.personal || {};
      const ids = action === 'probe' ? [id] : [...((personal.state === 'ready' || (!personal.state && personal.present)) ? ['personal'] : []), ...(pool?.accounts || []).filter(a => a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf).map(a => a.id)];
      await probe(ids); return;
    }
    if (action === 'rules') { const error = await ipcRenderer.invoke('open-path', pool?.quotaRules?.file); if (error) throw new Error(String(error)); return; }
    if (state.busy) return;
    if (action === 'remove' && !window.confirm('把这个号移出号池？会删除本机这份登录凭证，不会退出账号，账号主人不受影响。')) return;
    state.busy = true; state.menu = ''; state.message = ''; state.note = page.querySelector('#ca-note')?.value || state.note; render();
    try {
      ++revision; // Any older list request cannot overwrite this mutation.
      pool = await accountCommand(ipcRenderer, action, { id, note: state.note, dir: element?.dataset?.dir, hours: element?.dataset?.hours });
      if (action === 'add') { state.drawer = false; state.note = ''; }
      if (action === 'login' && id === 'personal') state.waitingPersonal = true;
      const notes = { add: '已打开登录窗口，请账号主人完成登录', login: '已打开登录窗口，请完成登录', import: '已导入号池', pause: '已暂停使用，进行中的会话不受影响', resume: '已恢复使用', remove: '已移出号池' };
      message(notes[action] || '账号已更新');
      await refresh({ scan: action === 'import' || action === 'remove' });
    } finally { state.busy = false; render(); poll(); }
  }
  function build() {
    if (page) return;
    page = document.createElement('section'); page.id = 'codeagent-accounts-page'; page.className = 'codeagent-accounts-page'; page.hidden = true; page.setAttribute('aria-label', 'CodeAgent 账号'); document.body.append(page);
    page.addEventListener('click', event => {
      const button = event.target.closest('[data-ca]');
      if (!button || button.disabled) return;
      event.preventDefault();
      void act(button.dataset.ca, button).catch(error => message(error.message));
    });
    page.addEventListener('input', event => { if (event.target.id === 'ca-note') state.note = event.target.value; });
    page.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (state.drawer || state.menu)) { event.stopPropagation(); state.drawer = false; state.menu = ''; render(); }
      if (event.key === 'Tab' && state.drawer) {
        const controls = [...page.querySelectorAll('.caa-drawer button:not(:disabled), .caa-drawer input')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
  }
  async function open(accountId) {
    if (disposed) return;
    clearTimeout(locateTimer); locatedRow()?.classList.remove('is-located');
    locateId = typeof accountId === 'string' ? accountId : ''; locateUntil = 0;
    if (locateId) { state.filter = 'all'; state.view = 'accounts'; }
    build(); configModal?.close(); closeOtherPanels();
    for (const hook of ['__companyAssistantHide', '__companyMeetingHide', '__companyRoomsHide', '__companyPptHide', '__assistantHide', '__cloudHide', '__wirelessHide', '__rulesHide', '__writingHide', '__xresearchHide', '__studyHide', '__ranHide']) window[hook]?.();
    page.hidden = false; document.body.classList.add('codeagent-accounts-page-open');
    document.getElementById('btn-rail-accounts')?.classList.add('active'); document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'true'); window.setShellNavActive?.('btn-rail-accounts');
    window.addEventListener('resize', place); place(); render();
    await setup.refresh().catch(error => { state.message = '安装检测失败：' + error.message; });
    if (state.view === 'token') void loadTokens();
    await refresh({ scan: true });
    locateAccount();
  }
  function close() {
    if (!page) return;
    page.hidden = true; state.drawer = false; state.menu = ''; clearTimeout(timer); ++revision;
    clearTimeout(locateTimer); locateId = ''; locateUntil = 0;
    state.loading = false; document.body.classList.remove('codeagent-accounts-page-open'); document.getElementById('btn-rail-accounts')?.classList.remove('active'); document.getElementById('btn-rail-accounts')?.setAttribute('aria-expanded', 'false'); window.removeEventListener('resize', place);
  }
  function onNav(event) {
    if (event.target.closest('#btn-rail-accounts, #btn-config-accounts')) { void open(); return; }
    if (event.target.closest('#scene-rail button')) close();
    else if (state.menu && !event.target.closest('.caa-actions')) { state.menu = ''; render(); }
  }
  const changed = () => { if (page && !page.hidden) void refresh(); };
  const unsubscribeSetup = setup.subscribe(status => { if (!status.installed) { state.drawer = false; state.menu = ''; } render(); });
  document.addEventListener('click', onNav); ipcRenderer.on('codeagent-pool:changed', changed); ipcRenderer.on('token-usage-changed', tokensChanged);
  document.getElementById('btn-rail-accounts')?.setAttribute('aria-controls', 'codeagent-accounts-page');
  window.__codeagentAccountsOpen = open; window.__codeagentAccountsHide = close;
  return { open, close, isOpen: () => !!page && !page.hidden, refresh, destroy() {
    disposed = true; close(); unsubscribeSetup(); state.queue = []; ipcRenderer.removeListener('codeagent-pool:changed', changed); ipcRenderer.removeListener('token-usage-changed', tokensChanged);
    document.removeEventListener('click', onNav); page?.remove();
  }, whenIdle: () => pending || Promise.resolve() };
}
module.exports = { createCodeagentAccountsPage, accountCommand };
