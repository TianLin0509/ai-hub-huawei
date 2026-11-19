'use strict';
// 侧栏「用量与系统状态」里的 API 网关一行（2026-11-19）：已用量、是否不限额、有几个会话在网关排队。
// 网关（New API）没有「每分钟还能调几次」这类限速信息，所以只显示用量。只在网关配好 key 后出现；点一下打开设置。
(() => {
  if (require('../core/distribution').target !== 'company') return;
  const { ipcRenderer } = require('electron');
  const REFRESH_MS = 10 * 60_000;
  let gateway = null, usage = null, waiting = 0, timer = null;
  const fmt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '—');
  const el = () => document.getElementById('rail-gateway-usage');
  function paint() {
    const root = el();
    if (!root) return;
    if (!gateway?.keySet) { root.hidden = true; root.innerHTML = ''; return; }
    root.hidden = false;
    const used = usage?.ok ? `已用 ${fmt(usage.used)}${usage.unlimited ? ' · 不限额' : Number.isFinite(usage.available) ? ` · 剩 ${fmt(usage.available)}` : ''}` : (usage ? '用量暂时读不到' : '读取用量…');
    const queue = waiting ? ` · ${waiting} 个会话排队中` : '';
    root.innerHTML = `<button type="button" class="api-gw-usage" title="API 网关（部门 API key）。用量来自网关，单位为网关的计量单位；网关不提供限速信息。点击打开设置。">`
      + `<span class="api-gw-usage-dot${waiting ? ' wait' : ''}" aria-hidden="true"></span><b>API 网关</b><span>${used}${queue}</span></button>`;
    root.querySelector('button').onclick = () => window.__companyApiOpen?.();
  }
  async function refresh({ usageToo = true } = {}) {
    try { gateway = (await ipcRenderer.invoke('api-gateway:get'))?.gateway || null; } catch { gateway = null; }
    if (gateway?.keySet && usageToo) { try { usage = await ipcRenderer.invoke('api-gateway:usage'); } catch { usage = { ok: false }; } }
    paint();
  }
  function init() {
    const anchor = document.getElementById('rail-codeagent-quota');
    if (anchor && !el()) {
      const root = Object.assign(document.createElement('div'), { id: 'rail-gateway-usage', className: 'sidebar-account-usage' });
      root.setAttribute('aria-label', 'API 网关用量'); root.hidden = true;
      anchor.after(root);
    }
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
    ipcRenderer.on('company-api:changed', () => void refresh());
    ipcRenderer.on('company-proxy:status', (_event, status) => {
      const next = Object.keys(status?.gateway?.waiting || {}).length;
      if (next !== waiting) { waiting = next; paint(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
