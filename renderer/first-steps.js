'use strict';
// 新同事首次引导（2026-11-19 体验 8，判断逻辑见 core/first-steps.js）：首页「连接你的 AI」变成三步清单——
//   ① 检测已装工具 ② 选一个能用的模型 ③ 发第一句话。没过的那一步展开，就地给修复按钮；过了的收成一行。
// 不另起一套：第一步展开时把现成的「安装情况」那一行（community-welcome.js）挪进来，第二步把「用 API key 开始」
// （api-gateway-welcome.js）挪进来，按钮也是点它们现成的；引导结束或点「不再显示」就原样放回去。
// 只给新用户；老用户（已有会话）第一次判断就记完成，首页和以前一模一样。
(() => {
  const distribution = require('../core/distribution');
  if (!distribution.community) return;
  const { ipcRenderer } = require('electron');
  const logic = require('../core/first-steps');
  const isCompany = distribution.target === 'company';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MARK = { ok: '✓', bad: '!', run: '…', wait: '', todo: '' };

  let box = null, section = null, active = false, firstPrompt = logic.FIRST_PROMPT;
  let data = { providers: [], personal: null, gateway: null, pick: null, firstPromptAt: null, checking: true };
  let opened = null;      // 用户手动点开的那一步（默认展开当前步）
  let note = '';          // 第二步点选后的一句反馈
  let prefillUntil = 0;   // 点了「开始第一个会话」后，新建的会话输入框预填第一句
  let refreshing = null, lastHtml = '', loginNote = '', knownIds = new Set();
  const homes = new Map(); // 挪进来的现成元素 → 它原来的位置（占位注释）

  function borrow(el, into) {
    if (!el || el.parentElement === into) return;
    if (!homes.has(el)) { const mark = document.createComment('first-steps:' + el.id); el.before(mark); homes.set(el, mark); }
    into.append(el);
  }
  function giveBack() {
    for (const [el, mark] of homes) { if (mark.isConnected) mark.replaceWith(el); }
    homes.clear();
  }

  function view() {
    const v = logic.computeSteps({ ...data, isCompany });
    const model = v.steps[1];
    if (loginNote && model.status !== 'ok' && model.fixes.some(f => f.act === 'codeagent-login')) model.detail += ' ' + loginNote;
    return v;
  }

  function render() {
    if (!active || !box) return;
    const { steps, current, done } = view();
    const openId = opened || current;
    const count = steps.filter(s => s.status === 'ok').length;
    // 先拿住挪进来的现成块：下面重写 innerHTML 会把它们摘下来。
    const providers = section.querySelector('#community-providers');
    const gateway = section.querySelector('#api-gateway-start');
    box.dataset.done = done ? '1' : '0';
    const html = '<div class="fs-head"><b>新同事三步上手</b>'
      + `<span class="fs-prog">${done ? '三步都完成了' : `已完成 ${count} / 3`}</span>`
      + `<button type="button" class="fs-skip" data-fs-act="${done ? 'finish' : 'dismiss'}">${done ? '收起引导' : '不再显示'}</button></div>`
      + '<ol class="fs-list">' + steps.map((s, i) => {
        const fixes = s.fixes.map((f, j) => `<button type="button" class="fs-fix${j === 0 && s.status !== 'ok' ? ' primary' : ''}" data-fs-act="${esc(f.act)}"${f.tool ? ` data-tool="${esc(f.tool)}"` : ''}>${esc(f.label)}</button>`).join('');
        return `<li class="fs-step${s.id === openId ? ' open' : ''}" data-fs-step="${s.id}" data-status="${s.status}">`
          + `<div class="fs-row"><button type="button" class="fs-toggle" data-fs-act="toggle" data-step="${s.id}" aria-expanded="${s.id === openId}">`
          + `<span class="fs-num" aria-hidden="true">${MARK[s.status] || i + 1}</span><span class="fs-title">${esc(s.title)}</span></button>`
          + `<span class="fs-detail" role="status">${esc(s.detail)}</span><span class="fs-fixes">${fixes}</span></div>`
          + `<div class="fs-body" data-fs-body="${s.id}"${s.id === openId ? '' : ' hidden'}>${s.id === 'model' ? modelsHtml(s) : ''}</div></li>`;
      }).join('') + '</ol>'
      + (done ? '<p class="fs-done">以后从左上角「启动」新建会话；遇到问题点右下角「问问 Hub」。</p>' : '');
    // 内容没变就不重画：回到窗口、后台刷新时不打断正在点的按钮和键盘焦点。
    if (html === lastHtml && box.querySelector('[data-fs-body="tool"]')?.contains(providers)) return;
    lastHtml = html;
    box.innerHTML = html;
    // 现成的块挪进对应步骤；没展开的步骤里它们跟着收起。
    borrow(providers, box.querySelector('[data-fs-body="tool"]'));
    if (gateway) borrow(gateway, box.querySelector('[data-fs-body="model"]'));
    for (const button of box.querySelectorAll('[data-fs-act]')) button.onclick = () => void act(button.dataset.fsAct, button);
    for (const button of box.querySelectorAll('[data-fs-pick]')) button.onclick = () => void pick(Number(button.dataset.fsPick));
  }
  function modelsHtml(step) {
    if (!step.options?.length) return '';
    return '<div class="fs-models" role="radiogroup" aria-label="第一个会话用的模型">' + step.options.map((o, i) =>
      `<button type="button" role="radio" data-fs-pick="${i}" aria-checked="${step.chosen === o || (step.chosen && o.kind === step.chosen.kind && o.model === step.chosen.model)}"><b>${esc(o.label)}</b><span>${esc(o.via)}</span></button>`).join('')
      + '</div>' + `<p class="fs-note" role="status">${esc(note || '点一个设为默认；启动中心里也随时能换。')}</p>`;
  }

  async function pick(index) {
    const option = view().steps[1].options[index];
    if (!option) return;
    note = '正在设为默认…'; lastHtml = ''; render();
    try {
      if (option.kind === 'codeagent' && option.model) {
        const result = await ipcRenderer.invoke('session:set-default-model', { kind: 'codeagent', model: option.model, available: view().steps[1].options.filter(o => o.kind === 'codeagent').map(o => o.model) });
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        data.hubDefault = option.model;
      } else if (option.kind !== 'codeagent' && option.model) {
        // 网关模型：设成网关默认，并把这个工具的线路明确切到 API 网关（不然它可能还走公司模型或别的接口）。
        const gw = await ipcRenderer.invoke('api-gateway:set-model', { model: option.model });
        if (!gw?.ok) throw new Error(gw?.error || '网关默认模型没保存成');
        const route = await ipcRenderer.invoke('company-api:save', { kind: option.kind, backend: 'gateway', model: option.model });
        if (!route?.ok) throw new Error(route?.error || '线路没切成');
        if (gw.gateway) data.gateway = gw.gateway;
      }
      data.pick = { kind: option.kind, model: option.model };
      await ipcRenderer.invoke('first-steps:update', { pick: data.pick });
      note = `已设为默认：${option.label}，新建会话会预选它。`;
    } catch (error) { note = `没设成默认（${error.message}），启动中心里可以手动选。`; }
    lastHtml = ''; render();
  }

  function openStep(id) { opened = id; render(); }
  async function act(what, button) {
    if (what === 'toggle') { const id = button.dataset.step; opened = (opened || view().current) === id ? '__none' : id; return render(); }
    if (what === 'dismiss' || what === 'finish') {
      await ipcRenderer.invoke('first-steps:update', what === 'dismiss' ? { dismiss: true } : { complete: true }).catch(() => {});
      return stop();
    }
    if (what === 'recheck') { section.querySelector('#community-refresh')?.click(); return refresh({ checking: true }); }
    if (what === 'env-check') return window.__envCheck?.open?.();
    if (what === 'install') {
      // 点「安装情况」那一行里现成的「安装」按钮：进度条、失败提示都是它原来的。
      openStep('tool');
      const target = section.querySelector(`#community-providers [data-provider="${CSS.escape(button.dataset.tool || '')}"] button`);
      if (target) target.click(); else window.__envCheck?.open?.();
      return;
    }
    if (what === 'codeagent-login') {
      button.disabled = true; button.textContent = '正在打开登录窗口…';
      let result;
      try { result = await ipcRenderer.invoke('codeagent-pool:personal-login'); } catch (error) { result = { ok: false, error: error.message }; }
      loginNote = result?.ok === false ? `登录窗口没打开：${result.error || '未知原因'}。可再点一次，或到「功能体检」里看 CodeAgent 那一行。`
        : '登录窗口已打开：登录完成后这里会自动打勾；关掉了可以再点一次。';
      lastHtml = ''; render(); // 重画后按钮恢复可点，能直接重试
      return; // 登录完成后主进程推 codeagent-pool:changed，这里自动刷新
    }
    if (what === 'api-key') { openStep('model'); window.__apiGatewayStart?.(); return; }
    if (what === 'start') {
      // 只预填这之后新建的会话：先记下现有会话（含休眠的），唤醒旧会话不算。
      knownIds = new Set();
      try {
        const [live, dormant] = await Promise.all([ipcRenderer.invoke('get-sessions').catch(() => []), ipcRenderer.invoke('get-dormant-sessions').catch(() => null)]);
        for (const s of [...(Array.isArray(live) ? live : []), ...(Array.isArray(dormant?.sessions) ? dormant.sessions : [])]) if (s?.id) knownIds.add(s.id);
      } catch { /* 拿不到就只靠时间窗 */ }
      prefillUntil = Date.now() + 10 * 60 * 1000;
      const chosen = view().steps[1].chosen;
      if (window.LaunchCenter?.open) window.LaunchCenter.open('session', chosen ? { kind: chosen.kind } : {});
      else document.getElementById('btn-new')?.click();
    }
  }

  // 「开始第一个会话」后新建的那个会话：输入框里预填第一句，不替用户发送。
  ipcRenderer.on('session-created', (_event, payload) => {
    const id = payload?.session?.id;
    if (!active || !id || Date.now() > prefillUntil || knownIds.has(id)) return;
    prefillUntil = 0;
    let tries = 0;
    const fill = () => {
      const input = document.querySelector(`.floating-input-bar[data-session-id="${CSS.escape(id)}"] .floating-input-box`);
      if (!input) { if (++tries < 40) setTimeout(fill, 250); return; }
      if (input.textContent.trim()) return;
      input.textContent = firstPrompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill();
  });

  async function refresh({ checking = false } = {}) {
    if (!active) return;
    if (checking) { data.checking = true; render(); }
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const [setup, pool, gw, st, config] = await Promise.all([
        ipcRenderer.invoke('community:setup').catch(() => null),
        ipcRenderer.invoke('codeagent-pool:list').catch(() => null),
        isCompany ? ipcRenderer.invoke('api-gateway:get').catch(() => null) : null,
        ipcRenderer.invoke('first-steps:update', {}).catch(() => null),
        ipcRenderer.invoke('get-hub-config').catch(() => null),
      ]);
      data = { ...data, checking: false, providers: setup?.providers || data.providers,
        personal: pool?.ok ? pool.personal || null : data.personal, gateway: gw?.gateway || data.gateway,
        pick: st?.state?.pick || data.pick, firstPromptAt: st?.state?.firstPromptAt || data.firstPromptAt,
        hubDefault: config?.defaultModels?.codeagent ?? data.hubDefault };
      if (data.firstPromptAt) opened = null;
    })().finally(() => { refreshing = null; render(); });
    return refreshing;
  }

  function stop() {
    active = false;
    section?.classList.remove('fs-on');
    giveBack();
    box?.remove(); box = null;
  }
  async function start() {
    section = document.getElementById('community-setup');
    if (!section) return false;
    let count = 0;
    try {
      const [live, dormant] = await Promise.all([ipcRenderer.invoke('get-sessions').catch(() => []), ipcRenderer.invoke('get-dormant-sessions').catch(() => null)]);
      count = (Array.isArray(live) ? live.length : 0) + (Array.isArray(dormant?.sessions) ? dormant.sessions.length : 0);
    } catch { count = 0; }
    let decision;
    try { decision = await ipcRenderer.invoke('first-steps:state', { sessionsCount: count }); } catch { return true; }
    if (!decision?.show) return true;
    firstPrompt = decision.firstPrompt || firstPrompt;
    data.pick = decision.state?.pick || null;
    data.firstPromptAt = decision.state?.firstPromptAt || null;
    active = true;
    box = document.createElement('div');
    box.id = 'first-steps';
    box.className = 'fs';
    box.setAttribute('aria-label', '新同事三步上手');
    section.classList.add('fs-on');
    (section.querySelector('.community-setup-text') || section.firstElementChild)?.after(box);
    // 引导在时，顶部那条「第一次使用：可以先体检一下」就重复了（体检入口在第一步里）。
    document.getElementById('env-check-hint')?.remove();
    render();
    // 「用 API key 开始」那块是 api-gateway-welcome.js 稍后才建的：建出来就挪进第二步。
    new MutationObserver(() => {
      const gateway = active && section.querySelector('#api-gateway-start'), body = box?.querySelector('[data-fs-body="model"]');
      if (gateway && body && gateway.parentElement !== body) borrow(gateway, body);
    }).observe(section, { childList: true, subtree: true });
    void refresh({ checking: true });
    for (const channel of ['company-api:changed', 'codeagent-pool:changed', 'first-steps:changed']) ipcRenderer.on(channel, () => void refresh());
    ipcRenderer.on('first-run:event', (_event, event) => { if (event?.type === 'done') void refresh(); });
    document.addEventListener('click', event => { if (event.target?.id === 'community-refresh' && !event.target.closest('#first-steps')) setTimeout(() => void refresh(), 400); });
    window.addEventListener('focus', () => void refresh());
    return true;
  }
  window.__firstSteps = { active: () => active, refresh: () => refresh(), view };
  function init() {
    let tries = 0;
    const wait = () => { if (document.getElementById('community-setup')) { void start(); return; } if (++tries < 40) setTimeout(wait, 250); };
    wait();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
