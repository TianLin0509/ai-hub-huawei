'use strict';
// 网页圆桌界面（2026-10-28）：主区一页，选「AI 网页」里已打开的网页当成员 → 同题提问 → 并排看回答 → 互评 / 激发 → 队长汇总。
// 提问和读回答都在主进程（main/web-page-agent.js），这里只负责摆放和按钮。网页本身不在这一页显示，点「原网页」切过去看。
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE = new Set(['queued', 'preparing', 'sending', 'sent', 'streaming', 'unconfirmed']);
const SITE_ORDER = ['deepseek', 'chatgpt', 'gemini', 'kimi', 'qwen', 'doubao'];
const SITE_NAMES = { deepseek: 'DeepSeek', chatgpt: 'ChatGPT', gemini: 'Gemini', kimi: 'Kimi', qwen: '千问', doubao: '豆包' };

let md = null;
function markdown(text) {
  if (!md) { const { marked } = require('marked'); const purify = require('dompurify'); md = t => purify.sanitize(marked.parse(t, { gfm: true, breaks: false })); }
  try { return md(String(text || '')); } catch { return '<pre>' + esc(text) + '</pre>'; }
}
function logoHtml(m) {
  if (m.logo) return `<span class="ai-logo logo-${esc(m.logo)} ws-logo"></span>`;
  return `<span class="ws-logo ws-logo-text">${esc(String(m.siteName || m.name || '?').slice(0, 1))}</span>`;
}

function createWebRoundtableUi({ document, window, ipcRenderer, beforeShow = () => {}, afterShow = () => {}, afterLeave = () => {}, openWebSession = () => {}, showToast = () => {}, copyText = null, listSessions = null, sendToSession = null }) {
  let data = { tables: [], candidates: [] };
  let tableId = null, setup = false, picked = new Set(), captain = '', busyAction = false;
  let style = 'debate', depth = '简要结论', pendingPaint = false;
  try { const saved = JSON.parse(window.localStorage.getItem('hubWebRoundtablePrefs') || '{}'); style = saved.style === 'collab' ? 'collab' : 'debate'; depth = saved.depth === '深入分析' ? '深入分析' : '简要结论'; if (Array.isArray(saved.members)) picked = new Set(saved.members); } catch {}
  const savePrefs = () => { try { window.localStorage.setItem('hubWebRoundtablePrefs', JSON.stringify({ style, depth, members: [...picked] })); } catch {} };

  async function call(channel, payload) {
    const result = await ipcRenderer.invoke(channel, payload);
    if (!result || result.ok === false) throw new Error(result?.error || '没有收到结果，请重试');
    return result;
  }
  const report = e => showToast(e?.message || String(e));

  const panel = document.createElement('section');
  panel.id = 'web-roundtable-panel'; panel.className = 'web-roundtable-panel'; panel.hidden = true; panel.setAttribute('aria-label', '网页圆桌');
  panel.innerHTML = `<header class="wrt-bar"><strong>网页圆桌</strong><select class="wrt-pick" aria-label="切换圆桌"></select>
      <span class="wrt-spacer"></span><button type="button" class="wrt-btn" data-wrt="new">＋ 新圆桌</button><button type="button" class="wrt-icon" data-wrt="close" title="关闭">×</button></header>
    <div class="wrt-body"></div>
    <footer class="wrt-composer" hidden></footer>`;
  document.body.append(panel);
  const body = panel.querySelector('.wrt-body'), composer = panel.querySelector('.wrt-composer'), pick = panel.querySelector('.wrt-pick');

  function place() {
    if (panel.hidden) return;
    const host = document.getElementById('terminal-panel');
    const r = host && host.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) Object.assign(panel.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    else {
      const bar = document.getElementById('app-toolbar'), side = document.getElementById('sidebar');
      const left = side ? side.getBoundingClientRect().right : 0, top = bar ? bar.getBoundingClientRect().bottom : 0;
      Object.assign(panel.style, { left: left + 'px', top: top + 'px', width: (window.innerWidth - left) + 'px', height: (window.innerHeight - top) + 'px' });
    }
  }
  const observer = window.ResizeObserver ? new window.ResizeObserver(() => place()) : null;

  async function open({ members, tableId: wanted } = {}) {
    try { beforeShow(); } catch (e) { console.warn('[web-roundtable] 收起其他视图失败：', e.message); }
    panel.hidden = false;
    document.body.classList.add('web-roundtable-open');
    place();
    const host = document.getElementById('terminal-panel');
    if (observer && host) { observer.disconnect(); observer.observe(host); }
    try { accept(await call('web-roundtable:list')); } catch (e) { report(e); }
    if (Array.isArray(members) && members.length) { picked = new Set(members); setup = true; tableId = null; }
    else if (wanted) { tableId = wanted; setup = false; }
    else if (!tableId) { tableId = data.tables[0]?.id || null; setup = !tableId; }
    paint();
    afterShow();
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove('web-roundtable-open');
    observer?.disconnect();
  }
  function leave() { close(); afterLeave(); }

  function current() { return data.tables.find(t => t.id === tableId) || null; }
  function paint() {
    if (panel.hidden) return;
    pick.innerHTML = `<option value="">${data.tables.length ? '选择圆桌…' : '还没有圆桌'}</option>` + data.tables.map(t => `<option value="${esc(t.id)}"${t.id === tableId && !setup ? ' selected' : ''}>${esc(t.title || '未命名圆桌')}${t.busy ? ' · 进行中' : ''}</option>`).join('');
    const table = current();
    if (setup || !table) { paintSetup(); composer.hidden = true; return; }
    paintTable(table);
    paintComposer(table);
  }

  // ── 选成员 ──
  function paintSetup() {
    const cands = data.candidates.slice().sort((a, b) => SITE_ORDER.indexOf(a.site) - SITE_ORDER.indexOf(b.site) || (a.identity === 'alt') - (b.identity === 'alt'));
    for (const id of [...picked]) if (!cands.some(c => c.id === id)) picked.delete(id);
    const chosen = cands.filter(c => picked.has(c.id));
    if (!chosen.some(c => c.id === captain)) captain = chosen.find(c => c.site === 'deepseek')?.id || chosen[0]?.id || '';
    const openSites = new Set(cands.map(c => c.site));
    const rows = cands.map(c => `<label class="wrt-cand${picked.has(c.id) ? ' on' : ''}"><input type="checkbox" data-wrt-member="${esc(c.id)}"${picked.has(c.id) ? ' checked' : ''}>
        ${logoHtml(c)}<span><strong>${esc(c.siteName)}${c.identity === 'alt' ? '（副）' : ''}</strong><small>${esc(c.title)} · ${c.status === 'dormant' ? '休眠，发问时自动唤醒' : esc({ ready: '就绪', running: '回答中', loading: '加载中', error: '出错' }[c.status] || c.status)}</small></span></label>`).join('');
    const quick = SITE_ORDER.filter(s => !openSites.has(s)).map(s => `<button type="button" class="wrt-chip" data-wrt-open-site="${s}">＋ ${esc(SITE_NAMES[s])}</button>`).join('');
    body.innerHTML = `<div class="wrt-setup">
      <h2>选 2–6 个网页 AI 当成员</h2>
      <p class="wrt-note">用的是「AI 网页」里已经登录的网页，同一个问题会同时发给每位成员。网页不用切到前台，后台就能答。</p>
      <div class="wrt-cands">${rows || '<p class="wrt-empty">还没有可用的网页。先在下面打开几个网站，并在网页里登录一次。</p>'}</div>
      ${quick ? `<div class="wrt-quick"><span>打开新网站：</span>${quick}<small>打开后先去网页里登录一次（侧栏「网页」分组）。</small></div>` : ''}
      <div class="wrt-row"><label>队长 <select data-wrt-captain>${chosen.map(c => `<option value="${esc(c.id)}"${c.id === captain ? ' selected' : ''}>${esc(c.siteName)}${c.identity === 'alt' ? '（副）' : ''}</option>`).join('') || '<option value="">先选成员</option>'}</select></label>
        <small>汇总时由队长写总结，默认 DeepSeek。</small></div>
      <div class="wrt-row"><button type="button" class="wrt-primary" data-wrt="start"${chosen.length < 2 ? ' disabled' : ''}>开始圆桌（${chosen.length} 位）</button>
        ${data.tables.length ? '<button type="button" class="wrt-btn" data-wrt="cancel-setup">返回</button>' : ''}</div>
      <p class="wrt-note">智谱清言、MiniMax 暂不支持自动提问；网页版不接 Claude。</p>
    </div>`;
  }

  // ── 圆桌内容 ──
  function memberOf(table, id) { return table.memberInfo.find(m => m.id === id) || { id, name: '已关闭的网页', exists: false }; }
  function jobCard(table, round, job) {
    const m = memberOf(table, job.member), active = ACTIVE.has(job.status);
    const actions = [];
    const needLogin = /尚未登录|要求登录|人机验证/.test(job.error || '');
    if (m.exists) actions.push(`<button type="button" data-wrt-job="view" title="切到这个网页查看">${needLogin ? '去登录' : '原网页'}</button>`);
    if (job.text) actions.push(`<button type="button" data-wrt-job="copy">复制</button>`);
    if (job.text && sendToSession) actions.push(`<button type="button" data-wrt-job="to-session" title="放进某个会话的输入框，不自动发送">发到会话</button>`);
    if (active) actions.push(`<button type="button" data-wrt-job="stop">停止</button>`);
    if (job.status === 'attention') {
      if (job.text) actions.push(`<button type="button" data-wrt-job="accept" title="核对过网页，这就是完整回答">确认完成</button>`);
      actions.push(`<button type="button" data-wrt-job="reread">重新读取</button>`);
    }
    if (job.status === 'error') actions.push(`<button type="button" data-wrt-job="resend">重发</button>`);
    if (['attention', 'error', 'stopped'].includes(job.status)) actions.push(`<button type="button" data-wrt-job="force" title="不核对提问原文，直接读取网页上最新的一条回答">读最新回答</button>`);
    if (!['done', 'skipped'].includes(job.status)) actions.push(`<button type="button" data-wrt-job="skip" title="本轮不等这位成员">跳过</button>`);
    const captainMark = round.kind === 'summary' ? '<em class="wrt-tag">队长</em>' : '';
    return `<article class="wrt-card s-${esc(job.status)}" data-wrt-job-id="${esc(job.id)}">
      <header>${logoHtml(m)}<strong>${esc(m.name)}</strong>${captainMark}${job.mode ? `<small>${esc(job.mode)}</small>` : ''}<span class="wrt-state">${esc(job.statusText)}</span></header>
      ${job.error ? `<p class="wrt-err">${esc(job.error)}</p>` : ''}
      <div class="wrt-md">${job.text ? markdown(job.text) : `<p class="wrt-wait">${active ? '等待网页回答…' : job.status === 'skipped' ? '本轮已跳过' : ''}</p>`}</div>
      <footer>${actions.join('')}</footer></article>`;
  }
  function paintTable(table) {
    // 用户正在回答里选字（准备复制）时不重画，松开鼠标后再补上。
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && body.contains(sel.anchorNode)) { pendingPaint = true; return; }
    const keepScroll = body.scrollTop, atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const members = table.memberInfo.map(m => `<span class="wrt-member${m.exists ? '' : ' gone'}" title="${esc(m.title || '')}">${logoHtml(m)}${esc(m.name)}${m.id === table.captain ? '<em class="wrt-tag">队长</em>' : ''}</span>`).join('');
    const rounds = table.rounds.map((r, i) => `<section class="wrt-round">
        <div class="wrt-round-head" data-wrt-round-id="${esc(r.id)}"><b>第 ${i + 1} 轮 · ${esc(r.kindName)}</b>${r.prompt ? `<span>${esc(r.prompt.replace(/\s+/g, ' ').slice(0, 160))}</span>` : ''}
          ${sendToSession && r.jobs.filter(j => j.text).length > 1 ? '<button type="button" class="wrt-btn small" data-wrt-round="to-session" title="把这一轮各家的回答一起放进某个会话的输入框">整轮发到会话</button>' : ''}</div>
        <div class="wrt-grid${r.jobs.length === 1 ? ' one' : ''}">${r.jobs.map(j => jobCard(table, r, j)).join('')}</div></section>`).join('');
    body.innerHTML = `<div class="wrt-members">${members}<button type="button" class="wrt-btn small" data-wrt="edit-members">换成员</button>
      <button type="button" class="wrt-btn small" data-wrt="remove" title="删除这个圆桌的记录（网页里的对话不受影响）">删除记录</button></div>
      ${rounds || '<p class="wrt-empty">在下面输入问题，发给全部成员。</p>'}`;
    body.scrollTop = atBottom ? body.scrollHeight : keepScroll;
  }
  function paintComposer(table) {
    const focused = document.activeElement?.closest?.('.wrt-composer');
    const draft = composer.querySelector('textarea')?.value || '';
    const done = (table.rounds.at(-1)?.jobs || []).filter(j => j.status === 'done' && j.text).length;
    const key = [table.id, table.busy, done, table.captain, table.members.join(',')].join('|');
    if (focused && composer.dataset.key === key) return;
    const fresh = !table.rounds.length;
    composer.hidden = false; composer.dataset.key = key;
    composer.innerHTML = `<textarea rows="3" placeholder="${table.rounds.length ? '新问题，或给互评 / 汇总的补充要求（可留空）' : '输入问题，发给全部成员'}"></textarea>
      <div class="wrt-actions">
        <button type="button" class="wrt-primary" data-wrt-kind="ask"${table.busy ? ' disabled' : ''}>发给全部成员</button>
        <label class="wrt-check"><input type="checkbox" data-wrt-fresh${fresh ? ' checked' : ''}>在新对话里问</label>
        <span class="wrt-sep"></span>
        <button type="button" class="wrt-btn" data-wrt-kind="discuss"${table.busy || done < 2 ? ' disabled' : ''} title="每位成员看到其他人的回答后再答一轮">互评一轮</button>
        <select data-wrt-style aria-label="互评方式"><option value="debate"${style === 'debate' ? ' selected' : ''}>互挑错</option><option value="collab"${style === 'collab' ? ' selected' : ''}>取长补短</option></select>
        <button type="button" class="wrt-btn" data-wrt-kind="inspire"${table.busy || done < 2 ? ' disabled' : ''} title="把别人的回答当灵感，各自给出升级版">互相激发</button>
        <span class="wrt-sep"></span>
        <button type="button" class="wrt-btn" data-wrt-kind="summary"${table.busy || done < 1 ? ' disabled' : ''}>队长汇总</button>
        <select data-wrt-lead aria-label="队长">${table.memberInfo.map(m => `<option value="${esc(m.id)}"${m.id === table.captain ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        <select data-wrt-depth aria-label="汇总深度"><option${depth === '简要结论' ? ' selected' : ''}>简要结论</option><option${depth === '深入分析' ? ' selected' : ''}>深入分析</option></select>
        ${table.busy ? '<button type="button" class="wrt-btn" data-wrt="stop-all">全部停止</button>' : ''}
      </div>`;
    composer.querySelector('textarea').value = draft;
    if (focused) composer.querySelector('textarea').focus();
  }

  // 「发到会话」：在按钮下弹出最近的会话列表，选一个把内容放进它的输入框。
  let picker = null;
  function closePicker() { picker?.remove(); picker = null; }
  function openPicker(anchor, text) {
    closePicker();
    const list = listSessions ? listSessions() : [];
    picker = document.createElement('div');
    picker.className = 'wrt-picker'; picker.setAttribute('role', 'menu');
    picker.innerHTML = `<div class="wrt-picker-head">放进哪个会话的输入框？（不会自动发送）</div>` + (list.length
      ? list.map(s => `<button type="button" role="menuitem" data-wrt-session="${esc(s.id)}"><strong>${esc(s.title)}</strong><small>${esc(s.kind)}${s.active ? ' · 当前会话' : ''}</small></button>`).join('')
      : '<p class="wrt-empty">还没有打开的会话。</p>');
    panel.append(picker);
    const a = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const top = Math.min(a.bottom - p.top + 4, p.height - Math.min(picker.offsetHeight, 360) - 8);
    Object.assign(picker.style, { left: Math.max(8, Math.min(a.left - p.left, p.width - 340)) + 'px', top: Math.max(8, top) + 'px' });
    picker.onclick = async e => {
      const id = e.target.closest('[data-wrt-session]')?.dataset.wrtSession;
      if (!id) return;
      closePicker();
      try { leave(); await sendToSession(id, text); showToast('已放进会话输入框，确认后再发送'); } catch (err) { report(err); }
    };
  }
  document.addEventListener('mousedown', e => { if (picker && !picker.contains(e.target) && !e.target.closest('[data-wrt-job="to-session"],[data-wrt-round="to-session"]')) closePicker(); }, true);
  const quote = (table, job) => `【${memberOf(table, job.member).name} 的回答】\n${job.text}`;

  panel.addEventListener('click', async event => {
    const t = event.target;
    const roundBtn = t.closest('[data-wrt-round="to-session"]');
    if (roundBtn) {
      const table = current(), round = table?.rounds.find(r => r.id === roundBtn.closest('[data-wrt-round-id]')?.dataset.wrtRoundId);
      if (!round) return;
      const question = table.rounds.find(r => r.kind === 'ask')?.prompt || '';
      openPicker(roundBtn, `以下是网页圆桌「${table.title || '未命名'}」第 ${table.rounds.indexOf(round) + 1} 轮（${round.kindName}）的回答，供参考。${question ? '\n原始问题：' + question : ''}\n\n` + round.jobs.filter(j => j.text).map(j => quote(table, j)).join('\n\n'));
      return;
    }
    const act = t.closest('[data-wrt]')?.dataset.wrt;
    if (act === 'close') { leave(); return; }
    if (act === 'new' || act === 'edit-members') {
      const table = act === 'edit-members' ? current() : null;
      if (table) { picked = new Set(table.members); captain = table.captain; panel.dataset.editing = table.id; } else delete panel.dataset.editing;
      setup = true; paint(); return;
    }
    if (act === 'cancel-setup') { setup = false; delete panel.dataset.editing; tableId = tableId || data.tables[0]?.id || null; paint(); return; }
    if (act === 'start') {
      const editing = panel.dataset.editing;
      try {
        if (editing) { accept(await call('web-roundtable:update', { tableId: editing, members: [...picked], captain })); tableId = editing; }
        else { const r = await call('web-roundtable:create', { members: [...picked], captain }); accept(r); tableId = r.tableId; }
        delete panel.dataset.editing; setup = false; savePrefs(); paint();
        composer.querySelector('textarea')?.focus();
      } catch (e) { report(e); }
      return;
    }
    if (act === 'remove') {
      const table = current(); if (!table) return;
      if (!window.confirm(`删除圆桌「${table.title || '未命名'}」的记录？网页里的对话不受影响。`)) return;
      try { accept(await call('web-roundtable:remove', { tableId: table.id })); tableId = data.tables[0]?.id || null; setup = !tableId; paint(); } catch (e) { report(e); }
      return;
    }
    if (act === 'stop-all') { try { accept(await call('web-roundtable:stop', { tableId })); } catch (e) { report(e); } return; }
    const site = t.closest('[data-wrt-open-site]')?.dataset.wrtOpenSite;
    if (site) {
      try {
        const created = await call('web-sessions:create', { site, identity: 'main' });
        picked.add(created.id);
        accept(await call('web-roundtable:list'));
        showToast(`已打开 ${SITE_NAMES[site]}。第一次用请到侧栏「网页」分组点开它登录。`);
      } catch (e) { report(e); }
      return;
    }
    const kind = t.closest('[data-wrt-kind]')?.dataset.wrtKind;
    if (kind && !busyAction) {
      const table = current(); if (!table) return;
      const box = composer.querySelector('textarea');
      busyAction = true;
      try {
        const fresh = !!composer.querySelector('[data-wrt-fresh]')?.checked;
        // 先清空再发：发出后的状态推送会重画输入区，重画时会把框里剩下的字当草稿保留下来。
        const text = box.value;
        box.value = '';
        try { accept(await call('web-roundtable:ask', { tableId: table.id, kind, text, style, depth, fresh })); }
        catch (e) { const now = composer.querySelector('textarea'); if (now && !now.value) now.value = text; throw e; }
      } catch (e) { report(e); }
      finally { busyAction = false; }
      return;
    }
    const jobAct = t.closest('[data-wrt-job]')?.dataset.wrtJob, card = t.closest('[data-wrt-job-id]');
    if (jobAct && card) {
      const table = current(), jobId = card.dataset.wrtJobId;
      const job = table?.rounds.flatMap(r => r.jobs).find(j => j.id === jobId);
      if (!job) return;
      try {
        if (jobAct === 'view') { leave(); openWebSession(job.member); return; }
        if (jobAct === 'to-session') { openPicker(t.closest('[data-wrt-job]'), quote(table, job)); return; }
        if (jobAct === 'copy') { if (copyText) await copyText(job.text); else await window.navigator.clipboard.writeText(job.text); showToast('已复制'); return; }
        const channel = { stop: 'web-roundtable:stop', accept: 'web-roundtable:accept', reread: 'web-roundtable:reread', force: 'web-roundtable:reread', resend: 'web-roundtable:resend', skip: 'web-roundtable:skip' }[jobAct];
        if (jobAct === 'force' && !window.confirm('不核对提问原文，直接读取这个网页上最新的一条回答作为本轮结果？请先确认网页里最新的提问就是这一轮的。')) return;
        accept(await call(channel, { tableId: table.id, jobId, force: jobAct === 'force' }));
      } catch (e) { report(e); }
    }
  });
  panel.addEventListener('change', event => {
    const t = event.target;
    if (t.matches('[data-wrt-member]')) { if (t.checked) picked.add(t.dataset.wrtMember); else picked.delete(t.dataset.wrtMember); paintSetup(); return; }
    if (t.matches('[data-wrt-captain]')) { captain = t.value; return; }
    if (t.matches('.wrt-pick')) { if (t.value) { tableId = t.value; setup = false; paint(); } return; }
    if (t.matches('[data-wrt-style]')) { style = t.value === 'collab' ? 'collab' : 'debate'; savePrefs(); return; }
    if (t.matches('[data-wrt-depth]')) { depth = t.value === '深入分析' ? '深入分析' : '简要结论'; savePrefs(); return; }
    if (t.matches('[data-wrt-lead]')) { void call('web-roundtable:update', { tableId, captain: t.value }).then(accept).catch(report); }
  });
  document.addEventListener('mouseup', () => { if (pendingPaint) { pendingPaint = false; setTimeout(() => { const s = window.getSelection?.(); if (s && !s.isCollapsed && body.contains(s.anchorNode)) pendingPaint = true; else paint(); }, 0); } });
  panel.addEventListener('keydown', event => {
    if (event.target.matches('.wrt-composer textarea') && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      composer.querySelector('[data-wrt-kind="ask"]')?.click();
    }
  });

  function accept(next) {
    if (!next || !Array.isArray(next.tables)) return;
    data = next;
    if (tableId && !data.tables.some(t => t.id === tableId)) tableId = null;
    paint();
  }
  ipcRenderer.on('web-roundtable:changed', (_e, next) => accept(next));
  // 网页会话的状态（休眠、加载、关闭）变了，成员列表跟着刷新。
  ipcRenderer.on('web-sessions:changed', () => { if (!panel.hidden) void call('web-roundtable:list').then(accept).catch(() => {}); });
  window.addEventListener('resize', place);

  return { open, close, isOpen: () => !panel.hidden };
}

module.exports = { createWebRoundtableUi };
