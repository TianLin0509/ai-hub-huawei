'use strict';
(() => {
  if (require('../core/distribution').target !== 'company') return;
  const { ipcRenderer } = require('electron');
  const view = require('./lan-pool-view');
  const { esc } = view;
  let dialog, current, snapshot = null, tab = null, oneTime = null, invite = '', confirmRevoke = '', busy = false, message = '', messageTone = '';
  async function invoke(action, payload) { const r = await ipcRenderer.invoke('lan-pool:' + action, payload); if (!r?.ok) throw new Error(r?.error || '共享操作失败'); return r; }
  const notice = (text, level = 'info') => ipcRenderer.emit('session-notice', {}, { message: text, level });
  async function load() {
    current = await invoke('settings');
    snapshot = current.client?.connected ? await invoke('snapshot').catch(() => null) : null;
    return current;
  }
  function copy(text) {
    try { require('electron').clipboard.writeText(String(text)); setMessage('已复制，可以直接发给同事。', 'ok'); }
    catch { setMessage('复制失败，请手动选中复制。', 'bad'); }
  }
  function setMessage(text, tone = '') {
    message = text; messageTone = tone;
    const el = dialog?.querySelector('[role=status].lp-msg'); if (el) { el.textContent = text; el.dataset.tone = tone; el.hidden = !text; }
  }
  function headerPill() {
    if (current.client?.connected) { const v = view.clientSummary(snapshot); return `<span class="lp-pill lp-${v.state.tone}">同事端 · ${esc(v.state.label)}</span>`; }
    if (current.host?.enabled) { const v = view.hostSummary(current); return `<span class="lp-pill lp-${v.state.tone}">主机 · ${esc(v.state.label)}</span>`; }
    return '<span class="lp-pill lp-mute">未启用</span>';
  }
  function render() {
    if (!dialog) return;
    tab ||= current.host?.enabled ? 'host' : 'client';
    const body = tab === 'client' ? view.clientPanel(current, snapshot) : view.hostPanel(current, { oneTime, invite, confirmRevoke });
    dialog.innerHTML = `<header class="lp-head"><div><h2>号池内网共享</h2><p>同事用自己电脑上的工具，共用主机的号池额度。</p></div>${headerPill()}<button type="button" class="company-api-close" aria-label="关闭">×</button></header>
      <nav class="lp-tabs" aria-label="共享方式"><button type="button" data-lan-tab="client" aria-pressed="${tab === 'client'}"><b>连接共享主机</b><small>我用别人的号池</small></button><button type="button" data-lan-tab="host" aria-pressed="${tab === 'host'}"><b>本机提供共享</b><small>把我的号池给同事用</small></button></nav>
      <div role="status" class="lp-msg company-api-message" data-tone="${esc(messageTone)}" ${message ? '' : 'hidden'}>${esc(message)}</div>
      <div class="lp-body">${body}</div>`;
    bind();
  }
  function bind() {
    dialog.querySelector('.company-api-close').onclick = () => dialog.close();
    for (const b of dialog.querySelectorAll('[data-lan-tab]')) b.onclick = () => { tab = b.dataset.lanTab; oneTime = null; confirmRevoke = ''; message = ''; render(); };
    for (const b of dialog.querySelectorAll('[data-lan-copy]')) b.onclick = () => copy(b.dataset.lanCopy);
    for (const f of dialog.querySelectorAll('[data-lan-connect]')) f.addEventListener('submit', event => {
      event.preventDefault(); const el = event.currentTarget.elements; void act('connect', { address: el.address.value, key: el.key.value });
    });
    const address = dialog.querySelector('[data-lan-connect] input[name=address]:not([type=hidden])');
    address?.addEventListener('input', () => {
      const parsed = require('../core/lan-pool').parseInvite(address.value, '');
      const key = address.form.elements.key;
      if (/^[a-f0-9]{48}$/.test(parsed.key) && parsed.address.startsWith('http')) { address.value = parsed.address; key.value = parsed.key; setMessage('已识别地址和口令，点「验证并连接」。', 'ok'); }
    });
    dialog.querySelector('[data-lan-disconnect]')?.addEventListener('click', () => void act('disconnect'));
    dialog.querySelector('[data-lan-refresh]')?.addEventListener('click', () => void act('refresh'));
    dialog.querySelector('[data-lan-host]')?.addEventListener('submit', event => {
      event.preventDefault(); const el = event.currentTarget.elements;
      void act('host', { enabled: !current.host.enabled, port: Number(el.port.value), bindAddress: el.bindAddress.value });
    });
    dialog.querySelector('[data-lan-member]')?.addEventListener('submit', event => {
      event.preventDefault(); const el = event.currentTarget.elements;
      void act('add-member', { name: el.name.value, maxConcurrent: Number(el.maxConcurrent.value), rpm: Number(el.rpm.value) });
    });
    for (const b of dialog.querySelectorAll('[data-lan-revoke]')) b.onclick = () => {
      // 撤销会立刻掐断对方在途请求：先确认一次，防误点。
      if (!b.dataset.confirmed) { confirmRevoke = b.dataset.lanRevoke; render(); return; }
      confirmRevoke = ''; void act('revoke-member', { id: b.dataset.lanRevoke });
    };
    dialog.querySelector('[data-lan-revoke-cancel]')?.addEventListener('click', () => { confirmRevoke = ''; render(); });
  }
  const DONE = {
    connect: '已连接。新建 Claude Code、Codex、DSH 会话会走共享号池。',
    disconnect: '已断开，工具配置已恢复到连接前。',
    refresh: '已同步主机最新读数。',
    'revoke-member': '已撤销，对方的在途请求已断开。',
  };
  async function act(action, payload) {
    if (busy || !dialog) return; busy = true;
    for (const b of dialog.querySelectorAll('button')) b.disabled = true;
    setMessage(action === 'connect' ? '正在验证主机连接，约 5 秒…' : action === 'host' && payload.enabled ? '正在开启共享…' : '正在处理…');
    try {
      const result = await invoke(action, payload);
      if (action === 'add-member') { oneTime = result.secret || null; invite = result.invite || ''; }
      else if (action !== 'refresh') { oneTime = null; invite = ''; }
      await load();
      message = action === 'add-member' ? '' : action === 'host' ? (current.host.enabled ? (current.host.localOnly ? '共享已开启（仅本机验证）。' : '共享已开启。下一步：在下方给同事生成口令。连不上时先检查入站防火墙。') : '共享已关闭。') : DONE[action] || '已更新';
      messageTone = 'ok'; render();
      await refreshSummary();
    } catch (error) { setMessage(error.message, 'bad'); }
    finally { busy = false; for (const b of dialog?.querySelectorAll('button') || []) b.disabled = false; }
  }
  async function open(which) {
    try {
      await load();
      if (which) tab = which;
      if (dialog) { render(); return; }
      dialog = document.createElement('dialog'); dialog.id = 'lan-pool-dialog'; dialog.className = 'company-api-dialog lan-pool-dialog';
      dialog.setAttribute('aria-label', '号池内网共享');
      dialog.addEventListener('close', () => { dialog.remove(); dialog = null; oneTime = null; invite = ''; confirmRevoke = ''; message = ''; tab = null; });
      document.getElementById('config-modal')?.classList.add('hidden'); document.body.append(dialog); render(); dialog.showModal();
    } catch (error) {
      console.warn('[lan-pool] ' + error.message);
      notice('号池共享设置打不开：' + error.message, 'error');
    }
  }
  async function refreshSummary() {
    const target = document.getElementById('lan-pool-launch-summary');
    try {
      const settings = await invoke('settings');
      const shared = settings.client?.connected ? await invoke('snapshot') : null;
      window.__lanPoolConnected = !!shared?.shared;
      if (target) {
        target.innerHTML = view.launchStrip(settings, shared); target.hidden = !shared?.shared;
        target.querySelector('[data-lan-open]')?.addEventListener('click', () => void open('client'));
      }
      const typing = dialog?.contains(document.activeElement) && document.activeElement.matches('input:not([readonly]),select');
      if (dialog && !busy && !typing) { current = settings; snapshot = shared; render(); }
      renderAccountCards(settings, shared);
    } catch { if (target) { target.hidden = false; target.textContent = '共享状态暂时无法读取，请在设置中检查连接'; } }
  }
  // 账号页顶部的共享卡片：账号页每次重绘后调用，数据由本模块维护。
  let cardData = null, cardFetchedAt = 0;
  function renderAccountCards(settings, shared) {
    cardData = { settings, shared };
    for (const slot of document.querySelectorAll('[data-lan-account-slot]')) fillSlot(slot);
  }
  function fillSlot(slot) {
    if (!cardData) return;
    const html = view.accountCard(cardData.settings, cardData.shared);
    if (slot.dataset.html === html) return;
    slot.dataset.html = html; slot.innerHTML = html;
    for (const b of slot.querySelectorAll('[data-lan-copy]')) b.onclick = () => { try { require('electron').clipboard.writeText(b.dataset.lanCopy); notice('地址已复制，可以发给同事'); } catch { notice('复制失败，请手动选中复制', 'error'); } };
    slot.querySelector('[data-lan-card="open"]')?.addEventListener('click', () => void open());
    slot.querySelector('[data-lan-card="refresh"]')?.addEventListener('click', async () => {
      try { await invoke('refresh'); } catch (error) { notice(error.message, 'error'); } await refreshSummary();
    });
  }
  function mountAccountSlot(container) {
    if (!container) return;
    let slot = container.querySelector(':scope > [data-lan-account-slot]');
    if (!slot) {
      slot = document.createElement('div'); slot.dataset.lanAccountSlot = '1'; slot.className = 'lp-slot';
      const head = container.querySelector(':scope > .caa-page-head');
      if (head) head.after(slot); else container.prepend(slot);
    }
    if (cardData) fillSlot(slot);
    // 同事用量随请求变化、不发变更事件：账号页每次重绘时顺带取一次，最多 5 秒一次。
    if (!cardData || Date.now() - cardFetchedAt > 5000) { cardFetchedAt = Date.now(); void refreshSummary(); }
  }
  function init() {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'styles/lan-pool.css'; document.head.append(css);
    const settings = document.getElementById('config-main-view');
    if (settings) { const row = document.createElement('div'); row.className = 'company-api-settings-entry'; row.innerHTML = '<div><strong>号池内网共享</strong><p>连接团队主机，或向同事共享本机号池</p></div><button id="lan-pool-settings-open">管理共享</button>'; settings.prepend(row); row.querySelector('button').onclick = () => void open(); }
    const panel = document.getElementById('launch-center-session-panel');
    if (panel) { const el = document.createElement('div'); el.id = 'lan-pool-launch-summary'; el.className = 'lan-pool-launch'; el.hidden = true; panel.prepend(el); }
    ipcRenderer.on('lan-pool:changed', () => { void refreshSummary(); });
    document.getElementById('btn-new')?.addEventListener('click', () => void refreshSummary());
    document.getElementById('btn-new-more')?.addEventListener('click', () => void refreshSummary());
    window.__lanPoolOpen = open; window.__lanPoolMountAccount = mountAccountSlot; void refreshSummary();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
