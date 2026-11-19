/* 在跑一览（2026-11-20）：侧栏「在跑一览」按钮弹出的只读表。
 * 数据来自主进程 core/running-overview.js（running-overview:get），和公司助理的 running_overview 工具同一份，不经过模型，
 * 没有 CodeAgent 的 API 用户也能看。四列按「需要你做什么」排：在等你回复 / 卡住嫌疑 / 运行中 / 刚完成；
 * 每列按窗口高度分页，整个弹窗不出现纵向滚动；点一行跳到该会话。只在打开和点「刷新」时读一次，不加定时器（Codex 审查 P2）。 */
(function () {
  'use strict';
  const { ipcRenderer } = require('electron');
  const GROUPS = [
    ['waiting', '在等你回复', '停在确认、答完等你，或进展卡在等你拍板'],
    ['suspect', '卡住嫌疑', '运行异常、自报卡住、很久没输出，或进展卡与状态矛盾'],
    ['running', '运行中', '这一刻在跑'],
    ['done', '刚完成', '最近 3 小时答完'],
  ];
  const ROW_H = 94;
  let overlay = null, data = null, pages = {}, lastFocus = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  function rowHtml(r) {
    const team = r.team ? `<span class="ro-team ro-team-${esc(r.team.role)}">${esc(r.team.text)}</span>` : '';
    const silent = r.silent === '没有输出记录' ? r.silent : r.silent + '有输出';
    const third = r.decision
      ? `<div class="ro-decision">拍板：${esc(r.decision.question)}${r.decision.recommendation ? `<span>推荐 ${esc(r.decision.recommendation)}</span>` : ''}</div>`
      : r.line ? `<div class="ro-line">${esc(r.line)}</div>` : '<div class="ro-line ro-none">没有进展卡</div>';
    const warn = (r.warnings || []).length ? `<div class="ro-warn" title="程序发现的矛盾，照带不解释">⚠ ${esc(r.warnings.join('；'))}</div>` : '';
    return `<button type="button" class="ro-row" data-session-id="${esc(r.id)}" title="跳到这个会话">
      <div class="ro-head"><strong>${esc(r.title)}</strong>${team}</div>
      <div class="ro-meta"><span>${esc(r.kind || 'AI')}</span><span>${esc(r.state)}</span><span>${esc(silent)}</span></div>
      ${third}${warn}</button>`;
  }

  function columnHtml([key, name, hint], cap) {
    const rows = (data.rows || []).filter(r => r.group === key);
    const total = Math.max(1, Math.ceil(rows.length / cap));
    const page = Math.min(pages[key] || 0, total - 1); pages[key] = page;
    const shown = rows.slice(page * cap, page * cap + cap);
    const pager = rows.length > cap
      ? `<div class="ro-pager"><button type="button" data-page="${key}:-1" ${page ? '' : 'disabled'} aria-label="上一页">‹</button><span>${page + 1} / ${total}</span><button type="button" data-page="${key}:1" ${page < total - 1 ? '' : 'disabled'} aria-label="下一页">›</button></div>` : '';
    return `<section class="ro-col ro-col-${key}" aria-label="${esc(name)}">
      <header title="${esc(hint)}"><i aria-hidden="true"></i><span>${esc(name)}</span><b>${rows.length}</b>${pager}</header>
      <div class="ro-list">${shown.length ? shown.map(rowHtml).join('') : '<div class="ro-empty">没有</div>'}</div></section>`;
  }

  function render() {
    if (!overlay || !data) return;
    const body = overlay.querySelector('.ro-body');
    // 每列放几行按窗口能给的最大高度算（弹窗最高 760 或窗口 88%，减去标题栏、列头和底栏），弹窗高度再随内容收缩。
    const room = Math.min(760, window.innerHeight * 0.88) - 56 - 38 - 44 - 10;
    const cap = Math.max(1, Math.floor(room / ROW_H));
    body.innerHTML = GROUPS.map(g => columnHtml(g, cap)).join('');
    const c = data.counts || {};
    overlay.querySelector('.ro-sub').textContent = `更新于 ${hhmm(data.at || Date.now())} · 按会话状态和进展卡生成，不经过模型`;
    overlay.querySelector('.ro-foot-text').textContent = `其余 ${c.rest || 0} 个会话（空闲更久、休眠、群聊成员、内部会话）没列出 · 点一行跳到该会话 · ⚠ 是程序发现的矛盾`;
  }

  async function load() {
    try {
      const res = await ipcRenderer.invoke('running-overview:get');
      if (!res || !res.ok) throw new Error((res && res.error) || '主进程没返回数据');
      data = res; render();
    } catch (e) {
      if (!overlay) return;
      overlay.querySelector('.ro-body').innerHTML = `<div class="ro-error">在跑一览没取到：${esc(e.message || e)}。<button type="button" data-action="refresh">重试</button></div>`;
    }
  }

  function close() {
    if (!overlay) return;
    overlay.remove(); overlay = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', render);
    document.getElementById('btn-running-overview')?.setAttribute('aria-expanded', 'false');
    try { lastFocus?.focus(); } catch {}
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  function open() {
    if (overlay) { void load(); return; }
    lastFocus = document.activeElement; pages = {};
    overlay = document.createElement('div');
    overlay.className = 'ro-overlay';
    overlay.innerHTML = `<div class="ro-dialog" role="dialog" aria-modal="true" aria-labelledby="ro-title">
      <header class="ro-top"><div><strong id="ro-title">在跑一览</strong><span class="ro-sub">正在读取…</span></div>
        <button type="button" class="ro-btn" data-action="refresh">刷新</button>
        <button type="button" class="ro-close" data-action="close" aria-label="关闭在跑一览">×</button></header>
      <div class="ro-body"><div class="ro-empty">正在读取…</div></div>
      <footer class="ro-foot"><span class="ro-foot-text"></span></footer></div>`;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) return close();
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.dataset.action === 'close') return close();
      if (btn.dataset.action === 'refresh') return void load();
      if (btn.dataset.page) { const [k, d] = btn.dataset.page.split(':'); pages[k] = (pages[k] || 0) + Number(d); return render(); }
      const id = btn.dataset.sessionId;
      if (id) { close(); if (typeof selectSession === 'function') void Promise.resolve(selectSession(id, { forceScrollBottom: true })).catch(() => {}); }
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', render);
    document.getElementById('btn-running-overview')?.setAttribute('aria-expanded', 'true');
    overlay.querySelector('.ro-close').focus();
    void load();
  }

  function init() {
    const btn = document.getElementById('btn-running-overview');
    if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', open); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.__runningOverview = { open, close };
})();
