'use strict';
// 设置「资源与后台」页（2026-11-23 低开销模式）：低开销模式总开关 + 每项后台功能的开关与当前占用，一屏放下。
// 开关状态来自主进程 optional-features:list（renderer/optional-features.js 的 window.__optionalFeatures 缓存），
// 模式总开关走 low-overhead:set；占用走 resource-usage:snapshot，只在本页显示着时每 20 秒取一次，离开就停。
// 说明文字（用途、开销）收进每行名称旁的 ⓘ，不常驻占版面。
// 另管两处入口：底栏「网速 关 / GPU 关」点一下到这页；老用户升级后右下角提示一次「可以开启低开销模式」。

const CSS = /* i18n-ignore：样式表 */ `
#cfg-background-section .bg-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px; padding: 8px 14px; border: 1px solid var(--border-subtle, #e4e6ec); border-radius: 10px; background: var(--surface, #fff); }
#cfg-background-section .bg-head .bg-mode { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; cursor: pointer; white-space: nowrap; }
#cfg-background-section .bg-head .bg-mode-state { font-weight: 400; font-size: 12px; color: var(--fg-muted, #6b7080); }
#cfg-background-section .bg-head .bg-total { order: 3; flex-basis: 100%; font-size: 12px; color: var(--fg-muted, #6b7080); white-space: nowrap; }
#cfg-background-section .bg-head .bg-refresh { margin-left: auto; }
#cfg-background-section .bg-head .bg-keep { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; color: var(--fg-muted, #6b7080); white-space: nowrap; }
#cfg-background-section .bg-head .bg-keep + .bg-refresh { margin-left: 0; }
#cfg-background-section .bg-head .bg-keep select { height: 24px; padding: 0 6px; border: 1px solid var(--border-subtle, #d6d9e0); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
#cfg-background-section .bg-parts { margin-left: 4px; }
#cfg-background-section .bg-head .bg-total b { color: var(--fg, #1f2329); font-weight: 600; }
#cfg-background-section .bg-refresh { border: 1px solid var(--border-subtle, #d6d9e0); background: transparent; border-radius: 6px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; color: inherit; }
#cfg-background-section table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
#cfg-background-section th { text-align: left; font-weight: 500; font-size: 12px; color: var(--fg-muted, #6b7080); padding: 4px 8px; border-bottom: 1px solid var(--border-subtle, #e4e6ec); }
#cfg-background-section td { padding: 0 8px; height: 30px; border-bottom: 1px solid var(--border-subtle, #eef0f4); }
#cfg-background-section td.bg-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; width: 92px; }
#cfg-background-section td.bg-switch { width: 70px; text-align: right; }
#cfg-background-section tr.bg-core td { color: var(--fg-muted, #6b7080); }
#cfg-background-section tr.bg-flash td { background: rgba(52, 120, 246, .10); transition: background .6s; }
#cfg-background-section .bg-off { color: var(--fg-muted, #9aa0ad); }
#cfg-background-section .bg-name .field-hint-icon { margin-left: 4px; vertical-align: middle; }
#cfg-background-section .bg-err { color: #c0392b; font-size: 12px; margin-top: 6px; }
#cfg-background-section .bg-switch input { width: 16px; height: 16px; cursor: pointer; }
.strip-meter-off { cursor: pointer; opacity: .75; }
.strip-meter-off:hover { opacity: 1; text-decoration: underline; }
.bg-hint-bar { position: fixed; right: 18px; bottom: 44px; z-index: 900; display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 6px 8px 6px 14px; border-radius: 8px; background: var(--surface, #fff); border: 1px solid var(--border-subtle, #e4e6ec); box-shadow: 0 4px 16px rgba(0,0,0,.10); font-size: 13px; line-height: 1.4; font-family: "Microsoft YaHei", sans-serif; }
.bg-hint-bar button { padding: 3px 12px; border-radius: 6px; border: 1px solid #3478f6; background: #3478f6; color: #fff; font: inherit; font-size: 12.5px; cursor: pointer; }
.bg-hint-bar button.bg-quiet { background: transparent; color: var(--fg-muted, #6b7080); border-color: transparent; }
:root[data-hw-shell] #cfg-background-section .bg-head, :root[data-hw-shell] .bg-hint-bar { background: var(--hw-surface); border-color: var(--hw-line); color: var(--hw-text-1); }
:root[data-hw-shell] #cfg-background-section .bg-total, :root[data-hw-shell] #cfg-background-section .bg-mode-state, :root[data-hw-shell] #cfg-background-section th, :root[data-hw-shell] #cfg-background-section tr.bg-core td, :root[data-hw-shell] #cfg-background-section .bg-off { color: var(--hw-text-2); }
:root[data-hw-shell] #cfg-background-section .bg-total b { color: var(--hw-text-1); }
:root[data-hw-shell] #cfg-background-section .bg-keep { color: var(--hw-text-2); }
:root[data-hw-shell] #cfg-background-section .bg-keep select { border-color: var(--hw-line); color: var(--hw-text-1); }
:root[data-hw-shell] #cfg-background-section th, :root[data-hw-shell] #cfg-background-section td { border-color: var(--hw-line); }
:root[data-hw-shell] .bg-hint-bar button { border-color: var(--hw-brand); background: var(--hw-brand); color: var(--hw-text-on); }
:root[data-hw-shell] .bg-hint-bar button.bg-quiet { background: transparent; border-color: transparent; color: var(--hw-text-2); }`;

// 每项开关对应占用表里的哪一组（core/resource-attribution.js 的 GROUPS）；没有独立进程的给一句说明。
const USAGE_GROUP = { forum: 'companyWeb', attendance: 'companyWeb', w3: 'companyWeb', rooms: 'rooms', pet: 'pet', liveMeter: 'liveMeter', searchIndex: 'searchIndex' };
const USAGE_NOTE = {
  assistant: '计入会话',
  quotaRefresh: '读额度时临时出现',
};

function mountBackgroundFeatures({ document, window, ipcRenderer, openConfigModal, showMessage = () => {} }) {
  const { iconHintHtml } = require('./launch-field-hint');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!document.getElementById('bg-features-style')) {
    const style = document.createElement('style'); style.id = 'bg-features-style'; style.textContent = CSS; document.head.appendChild(style);
  }
  const lowOverheadPolicy = require('../core/low-overhead-policy');
  let mode = { on: false, keepAlive: lowOverheadPolicy.DEFAULT_KEEP_ALIVE, hintPending: false };
  let usage = null, usageError = '', lastError = '', busy = false, timer = null, section = null, flashId = '';

  const features = () => (window.__optionalFeatures?.list?.() || []).filter(f => f.background);

  function usageCell(f, groups) {
    if (USAGE_NOTE[f.id]) return `<span class="bg-off">${esc(USAGE_NOTE[f.id])}</span>`;
    const g = groups && groups[USAGE_GROUP[f.id]];
    if (!g || !g.procs) return `<span class="bg-off">${f.on ? '暂无进程' : '已关'}</span>`;
    return `${g.memMB} MB · ${g.procs} 个`;
  }
  function cpuCell(f, groups) {
    const g = groups && groups[USAGE_GROUP[f.id]];
    return g && g.procs && g.cpuPct != null ? `${g.cpuPct}%` : '';
  }

  function render() {
    if (!section) return;
    const list = features();
    const groups = usage ? Object.fromEntries(usage.groups.map(g => [g.id, g])) : null;
    const onCount = list.filter(f => f.on).length;
    const modeState = mode.on ? (onCount ? `已开 · 按需开了 ${onCount} 项` : '已开 · 后台功能全关，只留会话') : `已关 · ${onCount} 项后台功能开着`;
    const total = usage ? `Hub 合计 内存 <b>${usage.total.memMB} MB</b> · CPU <b>${usage.total.cpuPct == null ? '…' : usage.total.cpuPct + '%'}</b> · 进程 <b>${usage.total.procs}</b> 个`
      : usageError ? esc('占用读不到：' + usageError) : '正在读取占用…';
    // 会话核心（Hub 本体、会话）常开，不占表格行，放在合计后面对照看。
    const part = id => { const g = groups && groups[id]; return g ? `${id === 'core' ? '本体' : '会话'} ${g.memMB} MB` : ''; };
    const parts = [part('core'), part('sessions')].filter(Boolean).join(' · ');
    section.querySelector('[data-bg="body"]').innerHTML = `
      <div class="bg-head">
        <label class="bg-mode"><input type="checkbox" data-bg="mode"${mode.on ? ' checked' : ''}${busy ? ' disabled' : ''}>低开销模式${iconHintHtml(lowOverheadPolicy.strategyHint())}<span class="bg-mode-state">${esc(modeState)}</span></label>
        ${mode.on ? `<span class="bg-keep" title="低开销模式开着时，最近用过的这几个会话保持运行，其余闲置 10 分钟以上的自动休眠（点开即恢复）">保活会话数${require('./low-overhead-ui').keepAliveSelectHtml(mode, `data-bg="keep"${busy ? ' disabled' : ''}`)}</span>` : ''}
        <span class="bg-total">${total}${parts ? `<span class="bg-parts">（其中 ${esc(parts)}，常开）</span>` : ''}${iconHintHtml('占用是这一刻的读数（工作集内存、两次读数之间的 CPU，按整机换算）；只在本页开着时每 10 秒刷新一次，关掉页面就停。\n本体＝Hub 的窗口与界面；会话＝终端里的 Claude、Codex、CodeAgent 等进程，助理的预热会话也算在这里')}</span>
        <button type="button" class="bg-refresh" data-bg="refresh">刷新</button>
      </div>
      <table><thead><tr><th>后台功能</th><th style="text-align:right">内存 · 进程</th><th style="text-align:right">CPU</th><th style="text-align:right">开关</th></tr></thead><tbody>
        ${list.map(f => `<tr data-bg-row="${esc(f.id)}"${flashId === f.id ? ' class="bg-flash"' : ''}><td class="bg-name">${esc(f.name)}${iconHintHtml(`${f.name}\n用途：${f.desc}\n开销：${f.cost}`)}</td>
          <td class="bg-num">${usageCell(f, groups)}</td><td class="bg-num">${cpuCell(f, groups)}</td>
          <td class="bg-switch"><input type="checkbox" data-bg-id="${esc(f.id)}" aria-label="${esc(f.name)}"${f.on ? ' checked' : ''}${busy ? ' disabled' : ''}></td></tr>`).join('')}
      </tbody></table>
      <div class="bg-err" data-bg="err"${lastError ? '' : ' hidden'}>${esc(lastError)}</div>`;
  }

  // force：要最新采样（首屏补读、开关切换后、点刷新）；定时刷新不传，可复用 1 秒内的采样。
  async function refreshUsage(force = false) {
    try {
      const r = await ipcRenderer.invoke('resource-usage:snapshot', { force: force === true });
      if (r && r.ok) { usage = r; usageError = ''; } else usageError = (r && r.error) || '没读到';
    } catch (error) { usageError = error.message; }
    render();
  }
  async function refreshMode() {
    try { const r = await ipcRenderer.invoke('low-overhead:state'); if (r && r.ok) mode = r; } catch (_) {}
  }
  const visible = () => !!section && section.offsetParent !== null && !document.hidden;
  function startPolling() {
    if (timer) return;
    // 页面开着时每 20 秒刷新一次占用（2026-11-25 R40b：原 10 秒；每次要枚举全机进程）。
    timer = window.setInterval(() => { if (visible()) void refreshUsage(); else stopPolling(); }, 20000);
  }
  function stopPolling() { if (timer) window.clearInterval(timer); timer = null; }
  async function onShown() {
    await Promise.all([window.__optionalFeatures?.refresh?.(), refreshMode()]);
    render();
    // 第一次读只有一份采样、算不出 CPU：1.5 秒后再读一次补上。
    await refreshUsage();
    window.setTimeout(() => { if (visible()) void refreshUsage(true); }, 1500);
    startPolling();
  }

  function mount() {
    const host = document.getElementById('config-main-view');
    if (!host || document.getElementById('cfg-background-section')) return;
    section = document.createElement('div');
    section.id = 'cfg-background-section';
    section.innerHTML = '<div class="config-section-label"><span>资源与后台功能</span><span>立即生效</span></div><div data-bg="body"></div>';
    host.appendChild(section);
    section.addEventListener('change', async event => {
      const keep = event.target.closest('select[data-bg="keep"]');
      if (keep) {
        // 只改保活数：不动模式和后台功能（main.js low-overhead:set 只带 keepAlive）。
        busy = true; lastError = ''; render();
        try {
          const r = await ipcRenderer.invoke('low-overhead:set', { keepAlive: Number(keep.value) });
          if (r && r.lowOverhead) mode = r.lowOverhead;
          if (!r || !r.ok) lastError = '保活会话数没保存：' + ((r && r.error) || '未知错误');
        } catch (error) { lastError = error.message; }
        busy = false; render();
        return;
      }
      const box = event.target.closest('input[data-bg-id], input[data-bg="mode"]');
      if (!box) return;
      busy = true; lastError = ''; render();
      try {
        if (box.dataset.bg === 'mode') {
          const r = await ipcRenderer.invoke('low-overhead:set', { on: box.checked });
          if (r && r.lowOverhead) mode = r.lowOverhead;
          if (r && r.partial) lastError = r.message || '有几项没处理成，低开销模式没有切换';
          await window.__optionalFeatures?.refresh?.();
        } else {
          await window.__optionalFeatures.set(box.dataset.bgId, box.checked);
        }
      } catch (error) { lastError = error.message; }
      busy = false; render();
      window.setTimeout(() => { if (visible()) void refreshUsage(true); }, 1200);
    });
    section.addEventListener('click', event => { if (event.target.closest('[data-bg="refresh"]')) void refreshUsage(true); });
    // 切到本页签、或弹窗打开时正停在本页签：开始读占用。
    new window.MutationObserver(() => { if (visible()) { if (!timer) void onShown(); } else stopPolling(); })
      .observe(section, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    const modal = document.getElementById('config-modal');
    if (modal) new window.MutationObserver(() => { if (visible()) { if (!timer) void onShown(); } else stopPolling(); })
      .observe(modal, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('hub-optional-features', () => render());
    render();
  }

  // 打开设置并停在本页；focusId 给出时把那一行闪一下（从底栏、可选功能入口进来）。
  async function open(focusId = '') {
    try { await openConfigModal(); }
    catch (error) { showMessage(`设置没打开：${error && error.message || error}。请从左下角「设置 → ⚙️ 设置 → 资源与后台」进入`); return; }
    mount();
    if (!section || document.getElementById('config-modal')?.classList.contains('hidden')) {
      showMessage('设置没打开，请从左下角「设置 → ⚙️ 设置 → 资源与后台」进入');
      return;
    }
    flashId = String(focusId || '');
    window.__hubSettingsTabs?.reveal(section);
    render();
    if (flashId) window.setTimeout(() => { flashId = ''; render(); }, 1600);
  }

  // 底栏「网速 关 / GPU 关」：点一下（或回车）到本页并标出那一行。
  const fromStrip = event => {
    const el = event.target.closest?.('[data-open-resources]');
    if (!el) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); event.stopPropagation();
    void open(el.dataset.openResources);
  };
  document.addEventListener('click', fromStrip, true);
  document.addEventListener('keydown', fromStrip, true);

  // 老用户升级后提示一次（不改任何开关）：「去看看」打开本页，两个按钮都算看过、不再提示。
  async function maybeHint() {
    await refreshMode();
    if (!mode.hintPending || document.querySelector('.bg-hint-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'bg-hint-bar'; bar.setAttribute('role', 'status');
    // 一行短提示；做什么、开销多少在设置页和 ⓘ 里，这里不常驻长说明。
    bar.innerHTML = `<span><b>低开销模式</b>：风扇响、内存紧时可开</span>${iconHintHtml('低开销模式\n后台功能先全关，只留会话；用到哪项在它的页面上一键开\n你现在的开关都没动')}`
      + '<button type="button" data-bg-hint="go">去看看</button><button type="button" class="bg-quiet" data-bg-hint="no">不用了</button>';
    document.body.appendChild(bar);
    bar.addEventListener('click', event => {
      const btn = event.target.closest('[data-bg-hint]');
      if (!btn) return;
      bar.remove();
      void ipcRenderer.invoke('low-overhead:dismiss-hint').catch(() => {});
      if (btn.dataset.bgHint === 'go') void open();
    });
  }
  ipcRenderer.on('low-overhead:changed', (_event, next) => { if (next) { mode = next; render(); } });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  // 启动后先让界面忙完首屏，再弹提示。
  window.setTimeout(() => { void maybeHint(); }, 8000);
  const api = { open, refreshUsage, render };
  window.__hubBackgroundFeatures = api;
  return api;
}

module.exports = { mountBackgroundFeatures, USAGE_GROUP };
