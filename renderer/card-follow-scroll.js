'use strict';

// 打开会话时定位到最新提问（2026-11-27）：把最新一条真实提问顶到可视区上方，
// 用户从回答开头往下读。剩余内容不足一屏时退化为滚到底，照常跟随最新输出。
const LAND_MARGIN = 12, LAND_SETTLE_MS = 1500;
// 等卡片的上限：超过这个时间还没找到提问（空会话、加载出错、根本没有真实提问）就放弃，照常跟随。
const LAND_ARM_MS = 8000;
// 超长提问最多占半屏：只露出提问的后半截，回答仍从屏幕中部开始。
const LAND_QUESTION_MAX_SHARE = 0.5;
function landingPosition({ cardTop, cardHeight, scrollHeight, clientHeight, margin = LAND_MARGIN }) {
  const max = Math.max(0, scrollHeight - clientHeight);
  let top = Math.max(cardTop - margin, cardTop + cardHeight - clientHeight * LAND_QUESTION_MAX_SHARE);
  top = Math.max(0, Math.round(top));
  return top >= max - 3 ? { top: max, bottom: true } : { top, bottom: false };
}

// Following is user intent, not a measurement recomputed after a card grows.
// Only this controller writes automatic scroll positions for ordinary cards.
function createCardFollowScroll({ element, window: win, document: doc, button: suppliedButton = null,
  landingTarget = null, landOnOpen = () => false, armOnSwitch = true }) {
  let sessionId = null, following = true, epoch = 0, frame = 0, pendingTop = null;
  // armed：等卡片挂好后定位到最新提问（armReady 为假时只等调用方 restore() 挂好新卡，不在旧卡上提前定位）；
  // landedUntil：定位到提问后的排版稳定期，期间高度变化会重新对齐；landed：当前位置是程序定位的、用户还没动过。
  // 任何用户滚动、跳转都会清掉这几项。
  let armed = false, armReady = false, armedUntil = 0, landedUntil = 0, landed = false, landMissing = false;
  let userDirection = 0, dragging = false, touchY = null;
  const saved = new Map(), observed = new Set();
  element.tabIndex = 0;
  element.setAttribute('aria-label', '会话消息');
  const button = suppliedButton || doc.createElement('button');
  if (!suppliedButton) button.id = 'card-jump-latest'; button.type = 'button'; button.hidden = true;
  const LATEST = '↓ 回到最新';
  let label = LATEST;
  const setLabel = next => { if (label !== next) { label = next; button.textContent = next; } };
  button.textContent = LATEST; button.setAttribute('aria-label', '回到最新输出并继续跟随');
  const gap = () => Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  const visible = () => element.isConnected && element.clientHeight > 0;
  function paint() {
    if (!suppliedButton && element.parentNode && button.parentNode !== element.parentNode) element.parentNode.appendChild(button);
    button.hidden = !visible() || following || gap() <= 3;
    if (suppliedButton) button.classList.toggle('visible', !button.hidden);
    // Browser anchoring helps preserve a reader's visible paragraph. While
    // following, the explicit bottom pin owns positioning instead.
    element.style.overflowAnchor = following ? 'none' : 'auto';
  }
  const now = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
  const armedLive = () => armed && now() < armedUntil;
  const landingLive = () => (armedLive() && armReady) || (landedUntil > 0 && now() < landedUntil);
  function cancelLanding() { armed = false; armReady = false; armedUntil = 0; landedUntil = 0; landed = false; landMissing = false; }
  function arm(ready) { cancelLanding(); armed = true; armReady = ready; armedUntil = now() + LAND_ARM_MS; following = true; pendingTop = null; }
  function tryLand() {
    const card = typeof landingTarget === 'function' ? landingTarget() : null;
    if (!card || !card.isConnected || !card.getClientRects().length || !visible()) { landMissing = armed; return false; }
    const top = card.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const pos = landingPosition({ cardTop: top, cardHeight: card.offsetHeight,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight });
    // 回答不足一屏、退化成贴底跟随后不再重新定位：流式输出变长也照常跟随，不把人拉回提问处。
    if (pos.bottom) landedUntil = 0;
    else if (armed) landedUntil = now() + LAND_SETTLE_MS;
    armed = false; armReady = false; landMissing = false;
    following = pos.bottom; landed = !pos.bottom; pendingTop = null;
    element.scrollTop = pos.bottom ? element.scrollHeight : pos.top;
    return true;
  }
  function request() {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (!(landingLive() && tryLand()) && following && visible()) element.scrollTop = element.scrollHeight;
      paint();
    });
  }
  function pause() { cancelLanding(); following = false; pendingTop = null; epoch++; paint(); }
  // 打开会话时的「看最新」：开关开着就定位到最新提问，关着照旧滚到底。
  // defer：卡片还要重新加载时只做标记，等 restore() 挂好新卡再定位。
  function openLatest({ defer = false } = {}) {
    if (!landOnOpen()) { follow(); return; }
    arm(!defer); userDirection = 0; epoch++;
    setLabel(LATEST);
    if (!(armReady && tryLand()) && visible()) element.scrollTop = element.scrollHeight;
    request();
  }
  function follow() {
    cancelLanding();
    following = true; pendingTop = null; userDirection = 0; epoch++;
    setLabel(LATEST);
    if (visible()) element.scrollTop = element.scrollHeight;
    request();
  }
  function nestedScroll(target, delta) {
    for (let el = target?.nodeType === 1 ? target : target?.parentElement; el && el !== element; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(win.getComputedStyle(el).overflowY)
          && (delta < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1)) return true;
    }
    return false;
  }
  function wheel(event) {
    if (event.ctrlKey || event.metaKey || !event.deltaY || nestedScroll(event.target, event.deltaY)) return;
    cancelLanding();
    userDirection = Math.sign(event.deltaY);
    epoch++;
    if (userDirection < 0) pause();
    else if (gap() <= 3) follow();
  }
  function scroll() {
    if (!following && (userDirection || dragging)) epoch++;
    if (!following && (userDirection > 0 || dragging) && gap() <= 3) follow();
    paint();
  }
  function pointerDown(event) {
    const rect = element.getBoundingClientRect();
    if (event.clientX >= rect.right - Math.max(14, element.offsetWidth - element.clientWidth)) {
      dragging = true; userDirection = 0; pause();
    }
  }
  function pointerUp() { if (dragging && gap() <= 3) follow(); dragging = false; }
  function key(event) {
    if (event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    if (['ArrowUp','PageUp','Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) { userDirection = -1; pause(); }
    else if (['ArrowDown','PageDown','End',' '].includes(event.key)) { cancelLanding(); userDirection = 1; }
  }
  function disclosure(event) {
    if (event.target.closest?.('summary, .body-expand-btn, [data-action="toggle-body"]')) pause();
  }
  function touchStart(event) { touchY = event.touches[0]?.clientY ?? null; }
  function touchMove(event) {
    const next = event.touches[0]?.clientY;
    if (next == null || touchY == null) return;
    const delta = touchY - next; touchY = next;
    if (nestedScroll(event.target, delta)) return;
    cancelLanding();
    userDirection = Math.sign(delta); if (delta < 0) pause();
  }
  function selection() {
    const selected = win.getSelection();
    if (selected && !selected.isCollapsed && element.contains(selected.anchorNode) && element.contains(selected.focusNode)) pause();
  }
  const resize = new win.ResizeObserver(request);
  resize.observe(element);
  function observeChildren() {
    for (const el of observed) if (el.parentNode !== element) { resize.unobserve(el); observed.delete(el); }
    for (const el of element.children) if (!observed.has(el)) { observed.add(el); resize.observe(el); }
    request();
  }
  const mutations = new win.MutationObserver(observeChildren);
  mutations.observe(element, { childList: true, subtree: true, characterData: true });
  element.addEventListener('wheel', wheel, { passive: true });
  element.addEventListener('scroll', scroll, { passive: true });
  element.addEventListener('pointerdown', pointerDown, { passive: true });
  element.addEventListener('keydown', key);
  element.addEventListener('click', disclosure, true);
  element.addEventListener('touchstart', touchStart, { passive: true });
  element.addEventListener('touchmove', touchMove, { passive: true });
  doc.addEventListener('pointerup', pointerUp);
  doc.addEventListener('selectionchange', selection);
  button.addEventListener('click', follow);
  const api = {
    request, pause, follow, openLatest, isFollowing: () => following,
    // 定位还在等最新提问那张卡（它不在首屏已加载的卡片里），调用方可再加载一页更早的卡片。
    landingMissing: () => armedLive() && landMissing,
    giveUpLanding() { if (armed) { cancelLanding(); request(); } },
    // 停在指定位置、不再跟随（如长回复回来时停在回复开头），底部按钮可换一句说明。
    holdAt(top, text) {
      pause();
      element.scrollTop = top;
      if (text) setLabel(text);
      paint();
    },
    activate(id, { force = false } = {}) {
      if (id !== sessionId) {
        if (sessionId) saved.set(sessionId, { following, top: element.scrollTop, landed: landed || armed });
        const state = saved.get(id);
        sessionId = id; following = state?.following ?? true; pendingTop = state?.top ?? 0;
        setLabel(LATEST);
        userDirection = 0; epoch++;
        cancelLanding();
        // 用户自己翻到的阅读位置原样保留；新打开、或上次停在最新处的会话，按开关定位到最新提问。
        if (!force && armOnSwitch && landOnOpen() && (!state || state.following || state.landed)) arm(false);
      }
      if (force) openLatest();
      paint();
    },
    capture: () => {
      const rect = element.getBoundingClientRect();
      const anchor = following || pendingTop !== null ? null : [...element.children].find(el => el.dataset.turnId && el.getBoundingClientRect().bottom > rect.top);
      return { sessionId, epoch, following, top: pendingTop ?? element.scrollTop,
        anchorId: anchor?.dataset.turnId, anchorOffset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 };
    },
    restore(snapshot) {
      if (!snapshot || snapshot.sessionId !== sessionId) return;
      // 新卡已挂好：等着定位的话现在定位（加载期间又被要求「看最新」时 epoch 会变，但仍是同一次打开）。
      if (armedLive()) armReady = true;
      if (landingLive() && tryLand()) { pendingTop = null; request(); paint(); return; }
      if (snapshot.epoch !== epoch) return;
      if (following) { if (visible()) element.scrollTop = element.scrollHeight; request(); }
      else {
        const anchor = snapshot.anchorId && [...element.children].find(el => el.dataset.turnId === snapshot.anchorId);
        element.scrollTop = anchor ? element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.anchorOffset : snapshot.top;
      }
      pendingTop = null;
      paint();
    },
    dispose() {
      if (frame) win.cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect(); button.remove();
      element.removeEventListener('wheel', wheel); element.removeEventListener('scroll', scroll);
      element.removeEventListener('pointerdown', pointerDown); element.removeEventListener('keydown', key);
      element.removeEventListener('click', disclosure, true);
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove);
      doc.removeEventListener('pointerup', pointerUp); doc.removeEventListener('selectionchange', selection);
      delete element._cardFollowController;
    },
  };
  element._cardFollowController = api; observeChildren();
  return api;
}
module.exports = { createCardFollowScroll, landingPosition };
