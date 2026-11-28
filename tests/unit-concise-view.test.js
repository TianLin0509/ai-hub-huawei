'use strict';
// 「简洁」开关（来源 5e462a33 的 concise-view 部分）：HUB-H 默认关，按会话记住打开的那些；只在用得上的会话里出现。
const test = require('node:test'), assert = require('node:assert/strict');
const { createConciseView, STORAGE_KEY } = require('../renderer/concise-view');

function fakeDoc(styles = []) {
  const el = tag => ({ tagName: tag.toUpperCase(), attrs: {}, hidden: false, textContent: '', isConnected: false,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; } });
  const events = [];
  return { head: { appendChild(n) { n.isConnected = true; styles.push(n); } }, createElement: el, events,
    defaultView: { CustomEvent: class { constructor(type) { this.type = type; } } }, dispatchEvent(e) { events.push(e.type); } };
}
function fakeArea() {
  const kids = [];
  return { kids, get firstChild() { return kids[0] || null; }, querySelector: () => null,
    insertBefore(n, ref) { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); const at = ref ? kids.indexOf(ref) : kids.length; kids.splice(at < 0 ? kids.length : at, 0, n); } };
}
const memory = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('off by default: nothing hidden, button placed in the session toolbar', () => {
  const styles = [];
  const ui = createConciseView({ document: fakeDoc(styles), storage: memory(), getSession: () => ({ id: 's1' }) });
  const area = fakeArea();
  ui.sync(true, area);
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.getAttribute('aria-pressed'), 'false');
  assert.equal(area.firstChild, ui.button);
  assert.equal(ui.isOn('s1'), false);
  assert.match(styles[0].textContent, /^\.turn-card\.concise-view-none\{display:none\}/, '没开的会话一张卡都不藏');
});

test('turning it on is remembered per session and re-groups cards', () => {
  const doc = fakeDoc(); const store = memory();
  const ui = createConciseView({ document: doc, storage: store, getSession: () => ({ id: 's"1' }) });
  ui.button.onclick();
  assert.equal(ui.button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(JSON.parse(store.m.get(STORAGE_KEY)), ['s"1']);
  assert.deepEqual(doc.events, ['hub:concise-changed']);
  const again = createConciseView({ document: fakeDoc(), storage: store, getSession: () => null });
  assert.equal(again.isOn('s"1'), true);
  assert.equal(again.isOn('other'), false);
  ui.button.onclick();
  assert.deepEqual(JSON.parse(store.m.get(STORAGE_KEY)), [], '再点一次关掉也记住');
});

test('hidden where it would do nothing: no session, or no team messages in it', () => {
  const ui = createConciseView({ document: fakeDoc(), storage: memory(), getSession: () => ({ id: 'solo' }), isRelevant: () => false });
  ui.sync(true, fakeArea());
  assert.equal(ui.button.hidden, true);
  const none = createConciseView({ document: fakeDoc(), storage: memory(), getSession: () => null });
  none.sync(true, fakeArea());
  assert.equal(none.button.hidden, true);
});

test('generated rule hides team notices and no-update cards only in sessions turned on', () => {
  const styles = [];
  createConciseView({ document: fakeDoc(styles), storage: memory({ [STORAGE_KEY]: JSON.stringify(['on-1']) }), getSession: () => null });
  assert.match(styles[0].textContent, /^\.turn-card\[data-session-id="on-1"\]\.team-notice,\.turn-card\[data-session-id="on-1"\]\.no-update\{display:none\}/);
});
