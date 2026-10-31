'use strict';
// 可选功能在各自页面里的开关（2026-10-30 用户：设置菜单之外，每个页面里也看得到开没开）。
// 关着：整页盖一层「还没开启」，写明用途和开销，一个「开启」按钮；开着：页面里放一个小标记「可选功能 · 已开启」，旁边可关。
// 状态和开关都走 renderer/optional-features.js（window.__optionalFeatures）。
const CSS = `
.of-gate { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: var(--bg, #f5f6f8); }
.of-gate[hidden] { display: none; }
.of-gate-box { max-width: 460px; padding: 28px 32px; border-radius: 12px; background: var(--surface, #fff); border: 1px solid var(--border-subtle, #e4e6ec); font-family: "Microsoft YaHei", sans-serif; }
.of-gate-box h2 { margin: 0 0 4px; font-size: 18px; }
.of-gate-box .of-gate-state { font-size: 12px; color: var(--fg-muted, #6b7080); margin-bottom: 14px; }
.of-gate-box p { margin: 6px 0; font-size: 13px; line-height: 1.6; }
.of-gate-box .of-gate-cost { color: var(--fg-muted, #6b7080); font-size: 12.5px; }
.of-gate-box .of-gate-row { display: flex; gap: 10px; align-items: center; margin-top: 18px; }
.of-gate-box button { padding: 6px 18px; border-radius: 8px; border: 1px solid #3478f6; background: #3478f6; color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
.of-gate-box button:disabled { opacity: .6; cursor: default; }
.of-gate-box .of-gate-err { color: #c0392b; font-size: 12px; }
.of-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-muted, #6b7080); white-space: nowrap; }
.of-badge b { color: #3478f6; font-weight: 500; }
.of-badge button { border: 0; background: none; padding: 0; color: var(--fg-muted, #6b7080); text-decoration: underline; cursor: pointer; font: inherit; font-size: 12px; }`;

function createFeatureGate({ document, window, id, page, badgeSlot, onEnabled = () => {}, showMessage }) {
  if (!document.getElementById('of-gate-style')) {
    const style = document.createElement('style'); style.id = 'of-gate-style'; style.textContent = CSS; document.head.appendChild(style);
  }
  const api = () => window.__optionalFeatures;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gate = document.createElement('div'); gate.className = 'of-gate'; gate.hidden = true; gate.dataset.feature = id;
  page.append(gate);
  const badge = document.createElement('span'); badge.className = 'of-badge'; badge.hidden = true; badge.dataset.feature = id;
  badgeSlot?.(badge);

  let entry = null;
  function render() {
    entry = api()?.get(id) || null;
    const on = !entry || entry.on; // 清单里没有这项（版本里不受开关管）：照常可用
    gate.hidden = on;
    badge.hidden = !entry || !entry.on;
    if (entry && !entry.on) {
      gate.innerHTML = `<div class="of-gate-box"><h2>${esc(entry.name)}</h2><div class="of-gate-state">可选功能 · 未开启</div>
        <p>${esc(entry.desc)}</p><p class="of-gate-cost">${esc(entry.cost)}。关着时后台不为它花时间。</p>
        <div class="of-gate-row"><button type="button" data-of-gate="on">开启${esc(entry.name)}</button><span class="of-gate-err" hidden></span></div>
        <p class="of-gate-cost">以后可在设置菜单「🧩 可选功能」里关掉。</p></div>`;
    }
    if (entry && entry.on) badge.innerHTML = `可选功能 · <b>已开启</b><button type="button" data-of-gate="off" title="关掉后后台不再为它取数">关闭</button>`;
    return on;
  }
  gate.addEventListener('click', async event => {
    const btn = event.target.closest('[data-of-gate="on"]');
    if (!btn) return;
    btn.disabled = true;
    try { await api().set(id, true); render(); onEnabled(); }
    catch (error) { const err = gate.querySelector('.of-gate-err'); err.textContent = error.message; err.hidden = false; btn.disabled = false; }
  });
  badge.addEventListener('click', async event => {
    if (!event.target.closest('[data-of-gate="off"]')) return;
    try { await api().set(id, false); render(); showMessage?.(`${entry?.name || ''}已关闭，后台不再为它取数`); }
    catch (error) { showMessage?.(error.message); }
  });
  window.addEventListener('hub-optional-features', () => render());
  // 打开页面时调用：先拿最新状态，返回开没开（关着就别去读数据、别开定时刷新）。
  async function check() { try { await api()?.refresh(); } catch (_) {} return render(); }
  // 助理关着时也要能进「设置 → 桌宠」（桌宠的形象、大小都在那里）：临时揭开这一层，下次打开页面再按开关盖回。
  function peek() { gate.hidden = true; }
  return { check, render, peek, isOn: () => !entry || entry.on };
}

module.exports = { createFeatureGate };
