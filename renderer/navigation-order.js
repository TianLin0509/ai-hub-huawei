'use strict';
const STORAGE_KEY = 'hub.navigationOrder.v1';

// 用户保存过的顺序优先；后来新增的按钮（如 2026-10-12 的「规则」）插到它在默认顺序里
// 的后一个按钮前面，默认排在最后的新按钮仍然接在末尾。
// 改过名的入口：旧顺序里的旧 id 换成新 id，留在原位置（2026-10-27「开发」换成「进展」）。
const RENAMED = { 'btn-ran': 'btn-progress' };
function normalizeNavigationOrder(saved, available) {
  const allowed = new Set(available), seen = new Set();
  const order = (Array.isArray(saved) ? saved : []).map(id => RENAMED[id] || id).filter(id => {
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const missing = available.filter(id => !seen.has(id));
  for (const id of missing.reverse()) {
    const next = available.slice(available.indexOf(id) + 1).find(other => order.includes(other));
    order.splice(next ? order.indexOf(next) : order.length, 0, id);
  }
  return order;
}

function installNavigationOrder(doc = globalThis.document) {
  const list = doc?.querySelector('#scene-rail .rail-navigation');
  if (!list || list.dataset.orderInstalled) return;
  list.dataset.orderInstalled = 'true';
  const win = doc.defaultView, rail = doc.getElementById('scene-rail');
  // 2026-10-24：只排 rail 的一级入口（普通按钮或 .rail-group 分组容器）。分组里的成员
  // 是展开条的一部分，不能参与拖动 —— 否则 list.append 会把它们从 dock 里拽出来。
  const entryOf = el => (el && (el.classList.contains('btn-shell-nav') || el.classList.contains('rail-group')) ? el : null);
  const titleNode = el => (el && el.classList.contains('rail-group') ? el.querySelector('.rail-group-trigger') : el);
  const entryId = el => (el && el.classList.contains('rail-group') ? titleNode(el)?.id : el?.id) || '';
  const buttons = [...list.children].map(entryOf).filter(e => e && !e.hidden);
  const ids = buttons.map(entryId), byId = new Map(buttons.map(e => [entryId(e), e]));
  let storage, saved;
  try { storage = win.localStorage; saved = JSON.parse(storage.getItem(STORAGE_KEY)); } catch {}
  for (const id of normalizeNavigationOrder(saved, ids)) list.append(byId.get(id));
  for (const button of buttons) {
    // 分组的标题由 rail-groups.js 动态生成（会带上「当前：xxx」），这里只登记后缀，
    // 由它拼进 title；普通入口照旧直接追加。
    const node = titleNode(button);
    if (!node) continue;
    node.dataset.orderHint = node.title;
    node.dataset.titleSuffix = ' · 长按调整顺序';
    if (!node.classList.contains('rail-group-trigger')) node.title += ' · 长按调整顺序';
    node.setAttribute('aria-keyshortcuts', 'F2');
    node.querySelectorAll('img').forEach(e => e.draggable = false);
  }
  const done = doc.createElement('button');
  done.type = 'button'; done.id = 'nav-edit-done'; done.textContent = '完成'; done.hidden = true;
  done.title = '保存顺序并结束编辑 (Escape)';
  rail.querySelector('.rail-drawer-head').append(done);
  let editing = false, pending = null, dragging = null, timer = null, suppressUntil = 0;
  const persist = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify([...list.children].map(entryOf).filter(e => e && ids.includes(entryId(e))).map(entryId))); } catch {}
  };
  const cancelTimer = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const setEditing = value => {
    editing = value; rail.classList.toggle('rail-editing', value); done.hidden = !value;
    if (!value) { cancelTimer(); dragging?.classList.remove('nav-dragging'); dragging = null; pending = null; persist(); suppressUntil = Date.now() + 350; }
  };
  const beginDrag = button => { dragging = button; button.classList.add('nav-dragging'); };
  const buttonAt = target => {
    const hit = target?.closest?.('.rail-group-trigger, .btn-shell-nav');
    if (!hit) return null;
    const entry = entryOf(hit.classList.contains('rail-group-trigger') ? hit.closest('.rail-group') : hit);
    return entry && byId.has(entryId(entry)) && list.contains(entry) ? entry : null;
  };
  list.addEventListener('pointerdown', e => {
    const button = buttonAt(e.target);
    if (!button || e.button !== 0) return;
    pending = { button, x:e.clientX, y:e.clientY, pointerId:e.pointerId };
    if (editing) { e.preventDefault(); button.setPointerCapture(e.pointerId); beginDrag(button); return; }
    cancelTimer();
    timer = win.setTimeout(() => {
      timer = null;
      if (!pending) return;
      setEditing(true); suppressUntil = Date.now() + 350;
      button.setPointerCapture(pending.pointerId); beginDrag(button);
    }, 550);
  });
  doc.addEventListener('pointermove', e => {
    if (!pending) return;
    if (!editing) {
      if (Math.hypot(e.clientX-pending.x,e.clientY-pending.y)>7) { cancelTimer(); pending=null; }
      return;
    }
    if (!dragging) return;
    e.preventDefault();
    const bounds=list.getBoundingClientRect();
    if(e.clientY<bounds.top+22) list.scrollTop-=12;
    if(e.clientY>bounds.bottom-22) list.scrollTop+=12;
    const target=buttonAt(doc.elementFromPoint(e.clientX,e.clientY));
    if (!target || target===dragging) return;
    const box=target.getBoundingClientRect();
    list.insertBefore(dragging, e.clientY < box.top+box.height/2 ? target : target.nextSibling);
  }, {passive:false});
  const endDrag = () => { cancelTimer(); pending=null; dragging?.classList.remove('nav-dragging'); if(dragging) persist(); dragging=null; };
  doc.addEventListener('pointerup',endDrag);
  doc.addEventListener('pointercancel',endDrag);
  win.addEventListener('blur',endDrag);
  doc.addEventListener('click', e => {
    if (buttonAt(e.target) && (editing || Date.now()<suppressUntil)) { e.preventDefault(); e.stopImmediatePropagation(); }
  },true);
  doc.addEventListener('pointerdown', e => { if(editing&&!rail.contains(e.target))setEditing(false); },true);
  list.addEventListener('contextmenu',e=>{ if(editing) e.preventDefault(); });
  doc.addEventListener('keydown', e => {
    const button=buttonAt(e.target);
    if(button&&e.key==='F2'){e.preventDefault();setEditing(true);return;}
    if(!editing)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();setEditing(false);return;}
    if(!button||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();
    const order=[...list.children].map(entryOf).filter(el=>el&&ids.includes(entryId(el))),i=order.indexOf(button);
    if(e.key==='ArrowUp'&&i>0)list.insertBefore(button,order[i-1]);
    if(e.key==='ArrowDown'&&i>=0&&i<order.length-1)list.insertBefore(button,order[i+1].nextSibling);
    titleNode(button)?.focus();persist();
  },true);
  done.addEventListener('click',()=>setEditing(false));
  doc.addEventListener('hub:navigation-layout',()=>{if(editing)setEditing(false);});
  return { finish:()=>setEditing(false) };
}

module.exports = { STORAGE_KEY, normalizeNavigationOrder, installNavigationOrder };
