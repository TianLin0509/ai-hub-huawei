'use strict';

const { quotaView, renderQuota, renderQuotaFooter, tipHtml } = require('./codeagent-quota-panel-view');
const STORAGE_KEY = 'hubClaudeQuotaPanel';
const HIDDEN_STORAGE_KEY = 'hubCodeAgentQuotaHidden';

function createCodeAgentQuotaPanel({ document, root, window = document.defaultView, ipcRenderer,
  storage = null, getCurrentAccountId = () => '', getCurrentModel = () => '', openAccounts = () => {}, now = Date.now,
  getPlacement = () => 'right', setPlacement = () => {}, footerRoot = null,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!document || !root || !ipcRenderer) throw new Error('CodeAgent quota panel needs its document, root and IPC');
  const setup = require('./codeagent-setup').createCodeAgentSetup({ document, ipcRenderer });
  // 宽屏默认：用户手动选过就听他的；没选过时，在第一次读到任何额度之前收成细栏，读到后自动展开一次。
  let saved = {};
  try { const raw = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}'); if (raw && typeof raw === 'object') saved = raw; } catch {}
  let hidden = [];
  try { const raw = JSON.parse(storage?.getItem(HIDDEN_STORAGE_KEY) || '[]'); if (Array.isArray(raw)) hidden = raw.filter(id => typeof id === 'string'); } catch {}
  let chosen = typeof saved.collapsed === 'boolean';
  const wideDefault = () => chosen ? saved.collapsed : !saved.seenReading;
  let narrow = window.innerWidth <= 1360, collapsed = narrow || wideDefault();
  let snapshot = null, message = '正在读取账号状态…', lastHtml = '', lastFooterHtml = '', revision = 0, disposed = false;
  let cachePending = null, refreshPending = null, refreshBusy = false, needsCache = false, tip = null;
  let loadingKeys = new Set();
  let messageUntil = 0, messageTimer;
  const placeholder = document.createElement('div');
  placeholder.className = 'qp-ph'; placeholder.hidden = true; root.before(placeholder);
  root.classList.add('qp'); root.setAttribute('aria-label', '号池额度');
  const save = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch {} };
  const clearTip = () => { tip?.remove(); tip = null; };
  const fullView = () => quotaView(snapshot, { now: now(), currentAccountId: getCurrentAccountId(), currentModel: getCurrentModel(), loadingKeys, installed: setup.current?.installed });
  const view = () => {
    const current = fullView(), rows = current.rows.filter(row => !hidden.includes(row.id));
    // 可见性仍按实际账号数决定，全隐藏也保留标题和恢复入口。
    return { ...current, rows, total: rows.length, usable: rows.filter(row => row.usable).length, hiddenCount: current.rows.length - rows.length };
  };

  function updateHtml(html) {
    if (!lastHtml) { root.innerHTML = html; return; }
    const template = document.createElement('template');
    template.innerHTML = html;
    if (!template.content) { root.innerHTML = html; return; }
    const wanted = [];
    // 只保留有滚动条的两层，其余区域照常更新；提示行增减也不重建滚动容器。
    for (const next of template.content.children) {
      const selector = next.classList.contains('qp-list') ? '.qp-list' : next.classList.contains('qp-rail') ? '.qp-rail' : null;
      const existing = selector && root.querySelector(selector);
      if (existing) {
        const top = existing.scrollTop;
        if (existing.innerHTML !== next.innerHTML) existing.innerHTML = next.innerHTML;
        existing.scrollTop = top;
        wanted.push(existing);
      } else wanted.push(next);
    }
    for (const child of [...root.childNodes]) if (!wanted.includes(child)) child.remove();
    let previous = null;
    for (const child of wanted) {
      const following = previous ? previous.nextSibling : root.firstChild;
      if (following !== child) root.insertBefore(child, following);
      previous = child;
    }
  }

  function render() {
    if (disposed) return;
    const current = view(), all = fullView();
    // 去重后多于一个号才有右侧额度栏（含收起态）；放在底栏时右侧不显示。安装说明的入口在账号页和主页。
    // 只有 1 个号时没有右侧栏，底栏照样显示它的三档额度（2026-11-07），否则单号用户哪里都看不到额度。
    const placement = getPlacement();
    const single = !all.visible && all.rows.length === 1 && all.installed !== false;
    const inFooter = !!footerRoot && (single || (current.visible && placement === 'bottom'));
    if (footerRoot) {
      footerRoot.hidden = !inFooter;
      const footerHtml = inFooter ? renderQuotaFooter(all, { now: now() }) : '';
      if (footerHtml !== lastFooterHtml) { footerRoot.innerHTML = footerHtml; lastFooterHtml = footerHtml; }
    }
    const shown = current.visible && placement === 'right';
    root.hidden = !shown;
    placeholder.hidden = !(shown && narrow && !collapsed);
    root.classList.toggle('is-collapsed', collapsed);
    root.classList.toggle('is-overlay', narrow && !collapsed);
    root.classList.toggle('is-refreshing', refreshBusy);
    if (!shown) { clearTip(); if (lastHtml) { root.innerHTML = ''; lastHtml = ''; } return; }
    const html = renderQuota(current, { now: now(), refreshing: refreshBusy, loadingCount: loadingKeys.size, message });
    if (html !== lastHtml) {
      const list = root.querySelector('.qp-list'), scroll = list?.scrollTop || 0;
      const focused = root.contains(document.activeElement) ? document.activeElement : null;
      const account = focused?.dataset?.qpAccount, action = focused?.dataset?.qpAction;
      clearTip(); updateHtml(html); lastHtml = html;
      const updated = root.querySelector('.qp-list'); if (updated) updated.scrollTop = scroll;
      if (account || action) [...root.querySelectorAll('[data-qp-account], [data-qp-action]')]
        .find(el => account ? el.dataset.qpAccount === account && el.offsetHeight : el.dataset.qpAction === action && el.offsetHeight)?.focus({ preventScroll: true });
    }
  }
  function fold(value, focus = false) {
    collapsed = value; clearTip();
    if (!narrow) { saved.collapsed = value; chosen = true; save(); }
    render();
    if (focus) root.querySelector(`[data-qp-action="${value ? 'expand' : 'collapse'}"]`)?.focus({ preventScroll: true });
  }

  function noteReading() {
    if (saved.seenReading || !view().rows.some(row => row.token || row.busy || row.month)) return;
    saved.seenReading = true; save();
    if (!chosen && !narrow) { collapsed = false; clearTip(); }
  }

  function load() {
    if (disposed) return Promise.resolve();
    if (refreshBusy) { needsCache = true; return refreshPending || Promise.resolve(); }
    if (cachePending) return cachePending;
    const generation = ++revision;
    const operation = Promise.resolve().then(() => ipcRenderer.invoke('codeagent:quota-panel')).then(result => {
      if (disposed || generation !== revision) return;
      if (!result?.ok) throw new Error(result?.error || '账号额度暂时无法读取');
      snapshot = result; noteReading(); if (now() >= messageUntil) message = ''; render();
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
      snapshot = result; noteReading();
      if (result.shared) { message = result.message || '已同步主机额度'; return; }
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
    if (!target || !(root.contains(target) || footerRoot?.contains(target)) || target.disabled) return;
    event.preventDefault();
    const action = target.dataset.qpAction;
    if (action === 'install-guide') { setup.showGuide(); return; }
    if (action === 'refresh') { void refresh(); return; }
    if (action === 'expand' || action === 'collapse') { fold(action === 'collapse', true); return; }
    // 「移到底栏 / 移回右侧」和设置页的下拉是同一个开关（codeagent-quota-placement）。
    if (action === 'to-bottom' || action === 'to-right') { clearTip(); setPlacement(action === 'to-bottom' ? 'bottom' : 'right'); render(); return; }
    clearTip(); if (narrow) fold(true);
    void openAccounts(snapshot?.shared ? undefined : target.dataset.qpAccount || undefined);
  }
  function outside(event) { if (narrow && !collapsed && !root.contains(event.target)) fold(true); }
  function resize() {
    const next = window.innerWidth <= 1360;
    if (next !== narrow) { narrow = next; collapsed = narrow || wideDefault(); }
    clearTip(); render();
  }
  // 展开时悬停一行、收起时悬停圆环，都是同一张卡，放在额度栏左边。
  function showTip(event) {
    const target = event.target.closest('.qp-ring, .qp-row');
    if (!target || !root.contains(target)) return;
    clearTip();
    const row = view().rows.find(item => item.id === target.dataset.qpAccount);
    if (!row) return;
    tip = document.createElement('div'); tip.className = 'qp-tip'; tip.setAttribute('role', 'tooltip');
    tip.innerHTML = tipHtml(row, now());
    document.body.append(tip);
    const rect = target.getBoundingClientRect(), panel = root.getBoundingClientRect();
    Object.assign(tip.style, { position: 'fixed', right: 'auto', left: Math.max(8, panel.left - tip.offsetWidth - 8) + 'px',
      top: Math.max(8, Math.min(rect.top, window.innerHeight - tip.offsetHeight - 8)) + 'px' });
  }
  function leaveTip(event) { if (!event.relatedTarget || !event.target.closest('.qp-ring, .qp-row')?.contains(event.relatedTarget)) clearTip(); }
  function contextMenu(event) {
    const account = event.target.closest('.qp-row, .qp-ring');
    if (account && root.contains(account)) {
      const id = account.dataset.qpAccount;
      if (!id || !fullView().rows.some(row => row.id === id)) return;
      hidden = [...new Set([...hidden, id])];
    } else if (event.target.closest('.qp-h h3, .qp-info, .qp-rail > [data-qp-action="expand"]') && hidden.length) hidden = [];
    else return;
    event.preventDefault();
    try { storage?.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden)); } catch {}
    clearTip(); render();
  }
  const changed = () => { void load(); };
  const unsubscribeSetup = setup.subscribe(() => render());
  root.addEventListener('click', activate); root.addEventListener('keydown', activate);
  root.addEventListener('contextmenu', contextMenu);
  footerRoot?.addEventListener('click', activate);
  root.addEventListener('pointerover', showTip); root.addEventListener('pointerout', leaveTip);
  root.addEventListener('focusin', showTip); root.addEventListener('focusout', clearTip);
  document.addEventListener('pointerdown', outside); window.addEventListener('resize', resize);
  for (const name of ['codeagent-usage-changed', 'codeagent-pool:changed']) ipcRenderer.on(name, changed);
  const tick = setIntervalFn(() => { render(); void load(); }, 60000); tick?.unref?.();
  render(); void load(); void setup.refresh().catch(() => {});
  return { render, refresh, reload: load, view, whenIdle: () => refreshPending || cachePending || Promise.resolve(),
    getState: () => ({ collapsed, narrow, refreshing: refreshBusy, hidden: [...hidden] }), destroy() {
      disposed = true; unsubscribeSetup(); ++revision; clearIntervalFn(tick); clearTimeout(messageTimer); clearTip(); placeholder.remove(); root.hidden = true;
      root.classList.remove('qp', 'is-overlay', 'is-refreshing');
      root.removeEventListener('click', activate); root.removeEventListener('keydown', activate);
      root.removeEventListener('contextmenu', contextMenu);
      footerRoot?.removeEventListener('click', activate); if (footerRoot) { footerRoot.hidden = true; footerRoot.innerHTML = ''; }
      root.removeEventListener('pointerover', showTip); root.removeEventListener('pointerout', leaveTip);
      root.removeEventListener('focusin', showTip); root.removeEventListener('focusout', clearTip);
      document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize);
      for (const name of ['codeagent-usage-changed', 'codeagent-pool:changed']) ipcRenderer.removeListener(name, changed);
    } };
}

module.exports = { createCodeAgentQuotaPanel };
