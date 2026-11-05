'use strict';

// Long conversations are expensive because Chromium lays out every mounted card,
// not because of the DOM itself. Cards far from the viewport skip layout and paint
// (content-visibility) while their full content stays in the page, so ordering,
// in-page find, selection and every card selector keep working.
//
// A skipped card needs its real height: without it the scroll range and jump targets
// are wrong by tens of thousands of pixels. contain-intrinsic-size describes the
// content box, so padding and border are subtracted, and the value stays fractional
// because rounding adds up over a long page.
//
// content-visibility also implies paint containment, which snaps a card's text to the
// card's own pixel grid: up to a pixel off from normal flow, enough to change what a
// clipped line shows. Cards near the viewport therefore drop it entirely and render
// exactly as they would without this module.
//
// Heights are stored by this module rather than through `auto`: Chromium's remembered
// size survives width changes. A card is re-measured whenever it leaves the viewport,
// which keeps expanded details, and all cards are re-measured on width or font changes.
// The newest cards never skip: they are the ones being streamed into and followed.
const KEEP_NEWEST = 8;
const REMEASURE_DELAY_MS = 200;
const MEASURED = 'contentSkipMeasured';

function createCardContentSkip({ overlay, window: win, keepNewest = KEEP_NEWEST }) {
  let measuredWidth = 0, timer = null, widthObserver = null, proximity = null;
  const near = new Set();
  const watched = new WeakSet();

  function cardsOf() { return Array.from(overlay.querySelectorAll(':scope > .turn-card[data-turn-id]')); }
  function contentHeight(card) {
    const height = card.getBoundingClientRect().height;
    if (!height) return null;
    const style = win.getComputedStyle(card);
    return Math.max(0, height - ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0));
  }
  function usable() { return !!overlay && overlay.isConnected && overlay.clientHeight > 0; }
  function settledState(card) { return near.has(card) ? 'visible' : 'auto'; }
  function storeHeight(card, height) { if (height !== null) card.style.containIntrinsicSize = `${height}px`; }
  function onProximity(entries) {
    const leaving = [];
    for (const { target, isIntersecting } of entries) {
      if (!target.isConnected) { proximity.unobserve(target); watched.delete(target); near.delete(target); continue; }
      if (isIntersecting) { near.add(target); if (target.dataset[MEASURED]) target.style.contentVisibility = 'visible'; }
      else { near.delete(target); if (target.dataset[MEASURED]) leaving.push(target); }
    }
    // Read every height first, then write. A card which was never near was measured
    // when it mounted and has not rendered since, so its stored height is still right.
    const rendered = leaving.filter(card => card.style.contentVisibility === 'visible');
    const heights = rendered.map(contentHeight);
    rendered.forEach((card, index) => storeHeight(card, heights[index]));
    for (const card of leaving) card.style.contentVisibility = 'auto';
  }
  function watchProximity(card) {
    if (typeof win.IntersectionObserver !== 'function') return;
    if (!proximity) proximity = new win.IntersectionObserver(onProximity, { root: overlay, rootMargin: '100% 0px' });
    if (!watched.has(card)) { watched.add(card); proximity.observe(card); }
  }
  function watchWidth() {
    if (widthObserver || typeof win.ResizeObserver !== 'function') return;
    widthObserver = new win.ResizeObserver(() => {
      if (overlay.clientWidth === measuredWidth) return;
      win.clearTimeout(timer);
      timer = win.setTimeout(sweep, REMEASURE_DELAY_MS);
    });
    widthObserver.observe(overlay);
  }
  // Width and font size change every card's height, including cards which are not
  // rendered, so their stored heights must be replaced or jumps land off target.
  function remeasure() {
    if (!usable()) return 0;
    const cards = cardsOf().filter(card => card.dataset[MEASURED]);
    if (!cards.length) { measuredWidth = overlay.clientWidth; return 0; }
    const follow = overlay._cardFollowController;
    const reading = follow?.capture?.();
    for (const card of cards) card.style.contentVisibility = 'visible';
    const heights = cards.map(contentHeight);
    cards.forEach((card, index) => {
      storeHeight(card, heights[index]);
      card.style.contentVisibility = settledState(card);
    });
    measuredWidth = overlay.clientWidth;
    follow?.restore?.(reading);
    return cards.length;
  }
  function sweep() {
    if (!usable()) return 0;
    watchWidth();
    if (measuredWidth && overlay.clientWidth !== measuredWidth) remeasure();
    measuredWidth = overlay.clientWidth;
    const cards = cardsOf();
    const pending = cards.slice(0, Math.max(0, cards.length - keepNewest)).filter(card => !card.dataset[MEASURED]);
    // Read every height first, then write, so the batch costs one forced layout.
    const measured = pending.map(card => ({ card, content: contentHeight(card) })).filter(item => item.content !== null);
    for (const { card, content } of measured) {
      storeHeight(card, content);
      card.style.contentVisibility = settledState(card);
      card.dataset[MEASURED] = '1';
    }
    // Includes cards returning with a cached session view, which keep their measurement.
    for (const card of cards) if (card.dataset[MEASURED]) watchProximity(card);
    return measured.length;
  }
  // Layout-dependent reads inside a skipped card return nothing: innerText is empty,
  // and computed style reads are far slower. Reads which touch a card's rendered
  // text or style go through here. fn must be synchronous.
  function withCardsRendered(cards, fn) {
    const skipped = Array.from(cards).filter(card => card && card.style && card.style.contentVisibility === 'auto');
    for (const card of skipped) card.style.contentVisibility = 'visible';
    try { return fn(); }
    finally { for (const card of skipped) card.style.contentVisibility = 'auto'; }
  }
  return { sweep, remeasure, withCardsRendered };
}

module.exports = { createCardContentSkip, KEEP_NEWEST };
