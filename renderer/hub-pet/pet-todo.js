'use strict';
// 桌宠待办卡片的渲染端（2026-11-26）。数据由主进程推来（hub-pet-todo:state），增删改都经 invoke 交给主进程，回来的就是最新状态。
(function () {
  const api = window.hubPetTodo;
  const $ = id => document.getElementById(id);
  const card = $('card'), input = $('input'), hint = $('hint');
  let state = { today: [], later: [], done: [] }, open = { later: false, done: false }, busy = false, previewSeq = 0, previewTimer = null;

  function row(item, list) {
    const li = document.createElement('li');
    li.className = 'trow' + (item.done ? ' done' : '');
    li.dataset.id = item.id;
    li.dataset.list = list;
    if (!item.done) li.draggable = true;
    const grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = '⋮⋮'; grip.setAttribute('aria-hidden', 'true');
    const chk = document.createElement('button'); chk.type = 'button'; chk.className = 'chk';
    chk.setAttribute('aria-label', item.done ? '改回未完成：' + item.title : '完成：' + item.title);
    chk.addEventListener('click', () => act({ type: item.done ? 'reopen' : 'done', id: item.id }));
    const tx = document.createElement('span'); tx.className = 'tx'; tx.title = item.title + (item.fromSession ? '（会话建的提醒）' : '');
    if (item.fromSession) { const s = document.createElement('span'); s.className = 'src'; s.textContent = '会话'; tx.appendChild(s); }
    tx.appendChild(document.createTextNode(item.title));
    li.append(grip, chk, tx);
    if (item.when) { const tm = document.createElement('span'); tm.className = 'tm' + (item.due && !item.done ? ' due' : ''); tm.textContent = item.when; li.appendChild(tm); }
    if (!item.done) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '×'; del.title = '删掉这条';
      del.setAttribute('aria-label', '删掉：' + item.title);
      del.addEventListener('click', () => act({ type: 'remove', id: item.id }));
      li.appendChild(del);
    }
    return li;
  }
  function fill(id, items, list) { const el = $(id); el.replaceChildren(...items.map(item => row(item, list))); }

  function render(s) {
    if (s) state = s;
    const today = state.today || [], later = state.later || [], done = state.done || [];
    $('title').textContent = `今天 · ${today.length} 件`;
    fill('today', today, 'today');
    fill('later', later, 'later');
    fill('done', done, 'done');
    $('empty').hidden = today.length > 0;
    $('tog-later').textContent = `${open.later ? '▾' : '▸'} 稍后 ${later.length}`;
    $('tog-done').textContent = `${open.done ? '▾' : '▸'} 已完成 ${done.length}`;
    $('tog-later').setAttribute('aria-expanded', String(open.later));
    $('tog-done').setAttribute('aria-expanded', String(open.done));
    $('later').hidden = !open.later || !later.length;
    $('done').hidden = !open.done || !done.length;
    if (state.error) showHint(state.error, true);
    resize();
  }
  function resize() { requestAnimationFrame(() => api.size({ width: Math.ceil(document.body.scrollWidth), height: Math.ceil(card.getBoundingClientRect().bottom + 18) })); }
  function showHint(text, err, warn) { hint.textContent = text || ''; hint.hidden = !text; hint.classList.toggle('err', !!err); hint.classList.toggle('warn', !!warn); resize(); }

  async function act(payload) {
    const r = await api.act(payload);
    if (r && r.state) render(r.state);
    if (r && r.error) showHint(r.error, true);
  }
  async function add() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    try {
      const r = await api.add(text);
      if (r && r.ok) { input.value = ''; showHint(r.warn ? r.warn.replace('先按', '已按') : '', false, !!r.warn); render(r.state); }
      else showHint((r && r.error) || '没记上，请再试一次', true);
    } finally { busy = false; }
  }
  // 边打字边说「几点提醒」：让人当场看到认出的时间，认错了可以改。
  function preview() {
    clearTimeout(previewTimer);
    const text = input.value.trim(), seq = ++previewSeq;
    if (!text) { showHint('', false); return; }
    previewTimer = setTimeout(async () => {
      const r = await api.preview(text);
      if (seq !== previewSeq || !r) return;
      showHint(r.warn || (r.when ? `${r.when} 提醒` : r.later ? '放进「稍后」' : ''), false, !!r.warn);
    }, 120);
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); }
  });
  input.addEventListener('input', preview);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') api.act({ type: 'close' }); });
  $('open-assistant').addEventListener('click', () => api.act({ type: 'assistant' }));
  // 稍后、已完成一次只展开一个，卡片不会长出屏幕。
  $('tog-later').addEventListener('click', () => { open.later = !open.later; if (open.later) open.done = false; render(); });
  $('tog-done').addEventListener('click', () => { open.done = !open.done; if (open.done) open.later = false; render(); });

  // 拖动排序：只在同一组里挪；松手后把这组的新顺序交给主进程记下。
  let dragId = null;
  card.addEventListener('dragstart', e => {
    const li = e.target.closest && e.target.closest('.trow[draggable="true"]');
    if (!li) return;
    dragId = li.dataset.id; li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', ''); } catch (_) {}
  });
  card.addEventListener('dragover', e => {
    const li = e.target.closest && e.target.closest('.trow');
    const from = dragId && card.querySelector(`.trow[data-id="${CSS.escape(dragId)}"]`);
    if (!li || !from || li.dataset.list !== from.dataset.list) return;
    e.preventDefault();
    card.querySelectorAll('.trow.over').forEach(el => el.classList.remove('over'));
    if (li !== from) li.classList.add('over');
  });
  card.addEventListener('drop', e => {
    const li = e.target.closest && e.target.closest('.trow');
    const from = dragId && card.querySelector(`.trow[data-id="${CSS.escape(dragId)}"]`);
    if (!li || !from || li === from || li.dataset.list !== from.dataset.list) return;
    e.preventDefault();
    li.parentNode.insertBefore(from, li);
    const ids = [...li.parentNode.querySelectorAll('.trow')].map(el => el.dataset.id);
    act({ type: 'reorder', ids });
  });
  card.addEventListener('dragend', () => { dragId = null; card.querySelectorAll('.dragging,.over').forEach(el => el.classList.remove('dragging', 'over')); });

  api.onState(s => render(s));
  api.onOpen(o => {
    card.style.setProperty('--ox', o && o.side === 'right' ? '0' : '100%');
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    input.focus();
    if (input.value) input.select();
  });
  window.__hubPetTodoDebug = () => ({ state, open, hint: hint.hidden ? '' : hint.textContent, rows: card.querySelectorAll('.trow').length, height: card.getBoundingClientRect().height });
  render();
  api.ready();
})();
