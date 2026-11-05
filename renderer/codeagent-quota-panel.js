'use strict';

const { quotaView, renderQuota, readTime } = require('./codeagent-quota-panel-view');
const STORAGE_KEY = 'hubClaudeQuotaPanel';

function createCodeAgentQuotaPanel({ document, root, window = document.defaultView, ipcRenderer,
  storage = null, getCurrentAccountId = () => '', openAccounts = () => {}, now = Date.now,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!document || !root || !ipcRenderer) throw new Error('CodeAgent quota panel needs its document, root and IPC');
  let saved = { collapsed: false };
  try { saved = { ...saved, ...JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') }; } catch {}
  let narrow = window.innerWidth <= 1360, collapsed = narrow || !!saved.collapsed;
  let snapshot = null, message = '正在读取账号状态…', lastHtml = '', revision = 0, disposed = false;
  let cachePending = null, refreshPending = null, refreshBusy = false, needsCache = false, tip = null;
  let loadingKeys = new Set();
  let messageUntil = 0, messageTimer;
  const placeholder = document.createElement('div');
  placeholder.className = 'qp-ph'; placeholder.hidden = true; root.before(placeholder);
  root.classList.add('qp'); root.setAttribute('aria-label', '号池额度');
  const save = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch {} };
  const clearTip = () => { tip?.remove(); tip = null; };
  const view = () => quotaView(snapshot, { now: now(), currentAccountId: getCurrentAccountId(), loadingKeys });

  function render() {
    if (disposed) return;
    root.hidden = false;
    root.classList.toggle('is-collapsed', collapsed);
    root.classList.toggle('is-overlay', narrow && !collapsed);
    root.classList.toggle('is-refreshing', refreshBusy);
    placeholder.hidden = !(narrow && !collapsed);
    const html = renderQuota(view(), { now: now(), refreshing: refreshBusy, loadingCount: loadingKeys.size, message });
    if (html !== lastHtml) {
      const list = root.querySelector('.qp-list'), scroll = list?.scrollTop || 0;
      const focused = root.contains(document.activeElement) ? document.activeElement : null;
      const account = focused?.dataset?.qpAccount, action = focused?.dataset?.qpAction;
      clearTip(); root.innerHTML = html; lastHtml = html;
      const updated = root.querySelector('.qp-list'); if (updated) updated.scrollTop = scroll;
      if (account || action) [...root.querySelectorAll('[data-qp-account], [data-qp-action]')]
        .find(el => account ? el.dataset.qpAccount === account && el.offsetHeight : el.dataset.qpAction === action && el.offsetHeight)?.focus({ preventScroll: true });
    }
  }
  function fold(value, focus = false) {
    collapsed = value; clearTip();
    if (!narrow) { saved.collapsed = value; save(); }
    render();
    if (focus) root.querySelector(`[data-qp-action="${value ? 'expand' : 'collapse'}"]`)?.focus({ preventScroll: true });
  }

  function load() {
    if (disposed) return Promise.resolve();
    if (refreshBusy) { needsCache = true; return refreshPending || Promise.resolve(); }
    if (cachePending) return cachePending;
    const generation = ++revision;
    const operation = Promise.resolve().then(() => ipcRenderer.invoke('codeagent:quota-panel')).then(result => {
      if (disposed || generation !== revision) return;
      if (!result?.ok) throw new Error(result?.error || '账号额度暂时无法读取');
      snapshot = result; if (now() >= messageUntil) message = ''; render();
    }).catch(error => {
      if (!disposed && generation === revision) { message = snapshot ? '读取失败，显示上次读数' : error.message; render(); }
    }).finally(() => { if (cachePending === operation) cachePending = null; });
    cachePending = operation;
    return operation;
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (refreshPending) return refreshPending;
    ++revision; refreshBusy = true; message = '';
    loadingKeys = new Set((snapshot?.rows || []).filter(row => row.state === 'ready' && !(row.nextRefreshAt > now())).map(row => row.id));
    render();
    const operation = Promise.resolve().then(() => ipcRenderer.invoke('codeagent:quota-panel', { refresh: true })).then(result => {
      if (disposed) return;
      if (!result?.ok) throw new Error(result?.error || '额度读取失败');
      snapshot = result;
      const failures = result.rows.filter(row => row.refresh?.status === 'failed');
      const updated = result.rows.filter(row => row.refresh?.status === 'updated');
      const cooling = result.rows.filter(row => row.refresh?.status === 'cooldown');
      message = !result.serveEnabled ? '暂未开启额度读取，保留已有读数'
        : failures.length ? `${failures.length} 个号读取失败，保留已有读数`
          : updated.length ? `已更新 ${updated.length} 个号${cooling.length ? `，${cooling.length} 个号冷却中` : ''}`
            : cooling.length ? '10 分钟内已读过，稍后可再刷新' : '没有可读取的账号';
    }).catch(() => { if (!disposed) message = '读取失败，保留已有读数'; }).finally(() => {
      messageUntil = now() + 4000;
      clearTimeout(messageTimer);
      if (!disposed) messageTimer = setTimeout(() => { message = ''; render(); }, 4000);
      refreshBusy = false; refreshPending = null; loadingKeys = new Set(); render();
      if (needsCache && !disposed) { needsCache = false; void load(); }
    });
    refreshPending = operation;
    return operation;
  }

  function activate(event) {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const target = event.target.closest('[data-qp-action], [data-qp-account]');
    if (!target || !root.contains(target) || target.disabled) return;
    event.preventDefault();
    const action = target.dataset.qpAction;
    if (action === 'refresh') { void refresh(); return; }
    if (action === 'expand' || action === 'collapse') { fold(action === 'collapse', true); return; }
    clearTip(); if (narrow) fold(true);
    void openAccounts(target.dataset.qpAccount || undefined);
  }
  function outside(event) { if (narrow && !collapsed && !root.contains(event.target)) fold(true); }
  function resize() {
    const next = window.innerWidth <= 1360;
    if (next !== narrow) { narrow = next; collapsed = narrow || !!saved.collapsed; }
    clearTip(); render();
  }
  function showTip(event) {
    const ring = event.target.closest('.qp-ring');
    if (!collapsed || !ring || !root.contains(ring)) return;
    clearTip();
    const row = view().rows.find(item => item.id === ring.dataset.qpAccount);
    if (!row) return;
    tip = document.createElement('div'); tip.className = 'qp-tip'; tip.setAttribute('role', 'tooltip');
    const name = document.createElement('b'); name.textContent = row.name + (row.current ? ' · 本会话' : ''); tip.append(name);
    const ratio = value => value ? `${Math.round(value.pct)}%` : '未读取';
    const quantity = row.busy || row.month;
    const amount = quantity?.remaining != null ? `剩 ${quantity.remaining.toLocaleString('en-US', { maximumFractionDigits: 1 })}${quantity.total != null ? ' / ' + quantity.total.toLocaleString('en-US', { maximumFractionDigits: 1 }) : ''} · ` : '';
    const read = quantity?.at ? `${readTime(quantity.at, now())} 读取` : '读取时间未记录';
    for (const text of [`今日忙时 ${ratio(row.busy)} · 月度 ${ratio(row.month)}`, quantity ? amount + read : '会话运行后显示', row.warning ? row.detail : '点头像打开账号页']) {
      const line = document.createElement('div'); line.textContent = text; tip.append(line);
    }
    document.body.append(tip);
    const rect = ring.getBoundingClientRect();
    Object.assign(tip.style, { position: 'fixed', right: 'auto', left: Math.max(8, rect.left - 230) + 'px',
      top: Math.max(8, Math.min(rect.top, window.innerHeight - tip.offsetHeight - 8)) + 'px' });
  }
  function leaveTip(event) { if (!event.relatedTarget || !event.target.closest('.qp-ring')?.contains(event.relatedTarget)) clearTip(); }
  const changed = () => { void load(); };
  root.addEventListener('click', activate); root.addEventListener('keydown', activate);
  root.addEventListener('pointerover', showTip); root.addEventListener('pointerout', leaveTip);
  root.addEventListener('focusin', showTip); root.addEventListener('focusout', clearTip);
  document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
  for (const name of ['codeagent-usage-changed', 'codeagent-pool:changed']) ipcRenderer.on(name, changed);
  const tick = setIntervalFn(() => { render(); void load(); }, 60000); tick?.unref?.();
  render(); void load();
  return { render, refresh, reload: load, whenIdle: () => refreshPending || cachePending || Promise.resolve(),
    getState: () => ({ collapsed, narrow, refreshing: refreshBusy }), destroy() {
      disposed = true; ++revision; clearIntervalFn(tick); clearTimeout(messageTimer); clearTip(); placeholder.remove(); root.hidden = true;
      root.classList.remove('qp', 'is-overlay', 'is-refreshing');
      root.removeEventListener('click', activate); root.removeEventListener('keydown', activate);
      root.removeEventListener('pointerover', showTip); root.removeEventListener('pointerout', leaveTip);
      root.removeEventListener('focusin', showTip); root.removeEventListener('focusout', clearTip);
      document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize);
      for (const name of ['codeagent-usage-changed', 'codeagent-pool:changed']) ipcRenderer.removeListener(name, changed);
    } };
}

module.exports = { createCodeAgentQuotaPanel };
