'use strict';
// 号池视图（成员版专属）：主机端的全屏监控弹窗。公开版裁掉本文件，入口按钮随之不出现。
(() => {
  if (require('../core/distribution').target !== 'company') return;
  const { ipcRenderer } = require('electron');
  const view = require('./lan-pool-dashboard-view');
  let dialog = null, data = null, timer = null, open = '', showRevoked = false, loading = false;
  async function load() {
    const r = await ipcRenderer.invoke('lan-pool:dashboard');
    if (!r?.ok) throw new Error(r?.error || '号池视图读取失败');
    data = r; return r;
  }
  function render() {
    if (!dialog) return;
    const body = dialog.querySelector('.pd-body'), scroll = body?.scrollTop || 0;
    dialog.innerHTML = `<header class="lp-head pd-head"><div><h2>号池视图</h2><p>谁在用、用了多少、有没有出问题</p></div><button type="button" class="lp-quiet lp-sm" data-pd-manage>管理共享</button><button type="button" class="company-api-close" aria-label="关闭">×</button></header>
      <div class="pd-body">${data ? view.dashboard(data, { open, showRevoked }) : '<p class="lp-muted">正在读取…</p>'}</div>`;
    dialog.querySelector('.pd-body').scrollTop = scroll;
    dialog.querySelector('.company-api-close').onclick = () => dialog.close();
    dialog.querySelector('[data-pd-manage]').onclick = () => { dialog.close(); window.__lanPoolOpen?.('host'); };
    dialog.querySelector('[data-pd-settings]')?.addEventListener('click', () => { dialog.close(); window.__lanPoolOpen?.('host'); });
    dialog.querySelector('[data-pd-revoked]')?.addEventListener('click', () => { showRevoked = !showRevoked; render(); });
    for (const row of dialog.querySelectorAll('[data-pd-member]')) {
      const toggle = () => { open = open === row.dataset.pdMember ? '' : row.dataset.pdMember; render(); };
      row.onclick = toggle; row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    }
  }
  async function tick() {
    if (!dialog || loading) return; loading = true;
    try { await load(); render(); } catch (error) { console.warn('[lan-pool] dashboard: ' + error.message); }
    finally { loading = false; }
  }
  async function show() {
    if (dialog) { void tick(); return; }
    dialog = document.createElement('dialog'); dialog.id = 'lan-pool-dashboard'; dialog.className = 'company-api-dialog lan-pool-dialog pd-dialog';
    dialog.setAttribute('aria-label', '号池视图');
    dialog.addEventListener('close', () => { clearInterval(timer); timer = null; dialog.remove(); dialog = null; open = ''; showRevoked = false; });
    document.body.append(dialog); render(); dialog.showModal();
    await tick();
    timer = setInterval(() => void tick(), 5000);
  }
  function init() {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'styles/lan-pool-dashboard.css'; document.head.append(css);
    window.__lanPoolDashboardOpen = () => void show();
    // 主机端的变化（同事上线、撤销）推过来时，打开着就立刻刷新一次。
    ipcRenderer.on('lan-pool:changed', () => { if (dialog) void tick(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
