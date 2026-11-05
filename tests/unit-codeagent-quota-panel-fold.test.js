'use strict';

// Wide-screen default fold of the CodeAgent quota rail: collapsed until any reading exists,
// opens once on the first reading, and a manual choice survives reloads. Fake DOM, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodeAgentQuotaPanel } = require('../renderer/codeagent-quota-panel');

function fakeEl() {
  const classes = new Set();
  return { hidden: false, innerHTML: '', dataset: {}, style: {},
    classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c) },
    setAttribute() {}, before() {}, remove() {}, append() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], contains: () => false };
}
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: key => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
}
const blank = { id: 'a1', state: 'ready', label: '号一' };
const read = { ...blank, credit: { busyDay: { pct: 30, used: 30, total: 100 } }, creditAt: 5000 };
function mount({ storage, rows, width = 1440, placement = 'right', footerRoot = null }) {
  let current = rows;
  const root = fakeEl();
  const document = { createElement: fakeEl, addEventListener() {}, removeEventListener() {}, activeElement: null, body: fakeEl() };
  const window = { innerWidth: width, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  const ipcRenderer = { invoke: async () => ({ ok: true, serveEnabled: true, rows: current }), on() {}, removeListener() {} };
  const panel = createCodeAgentQuotaPanel({ document, root, window, ipcRenderer, storage, now: () => 9000,
    setIntervalFn: () => 0, clearIntervalFn() {}, getPlacement: () => placement, footerRoot });
  return { panel, root, setRows: next => { current = next; } };
}

test('wide rail stays collapsed while every account is unread', async () => {
  const storage = memoryStorage();
  const { panel, root } = mount({ storage, rows: [blank, { ...blank, id: 'a2' }] });
  await panel.whenIdle();
  assert.equal(panel.getState().collapsed, true);
  assert.equal(root.classList.contains('is-collapsed'), true);
  panel.destroy();
});

test('first reading opens the rail once and later starts open', async () => {
  const storage = memoryStorage();
  const first = mount({ storage, rows: [blank] });
  await first.panel.whenIdle();
  assert.equal(first.panel.getState().collapsed, true);
  first.setRows([read]); await first.panel.reload();
  assert.equal(first.panel.getState().collapsed, false);
  first.panel.destroy();
  const again = mount({ storage, rows: [blank] });
  assert.equal(again.panel.getState().collapsed, false, 'after a reading was seen the wide default is open');
  again.panel.destroy();
});

test('a manual collapse survives reload even when readings exist', async () => {
  const storage = memoryStorage({ hubClaudeQuotaPanel: JSON.stringify({ collapsed: true, seenReading: true }) });
  const { panel } = mount({ storage, rows: [read] });
  await panel.whenIdle();
  assert.equal(panel.getState().collapsed, true);
  panel.destroy();
});

test('a manual expand from an older build is still honoured with no readings', async () => {
  const storage = memoryStorage({ hubClaudeQuotaPanel: JSON.stringify({ collapsed: false }) });
  const { panel } = mount({ storage, rows: [blank] });
  await panel.whenIdle();
  assert.equal(panel.getState().collapsed, false);
  panel.destroy();
});

test('narrow windows never auto-open the overlay on the first reading', async () => {
  const storage = memoryStorage();
  const { panel, setRows } = mount({ storage, rows: [blank], width: 1280 });
  await panel.whenIdle();
  setRows([read]); await panel.reload();
  assert.equal(panel.getState().collapsed, true);
  assert.equal(JSON.parse(storage.data.hubClaudeQuotaPanel).seenReading, true);
  panel.destroy();
});

test('the panel only shows with more than one distinct account and in the chosen place', async () => {
  const footerRoot = fakeEl();
  const single = mount({ storage: memoryStorage(), rows: [read, { ...blank, id: 'a2', sameAsPersonal: true }], footerRoot });
  await single.panel.whenIdle();
  assert.equal(single.root.hidden, true);
  assert.equal(footerRoot.hidden, true);
  single.setRows([read, { ...blank, id: 'a2' }]);
  await single.panel.reload();
  assert.equal(single.root.hidden, false);
  assert.notEqual(single.root.innerHTML, '');
  single.setRows([read]);
  await single.panel.reload();
  assert.equal(single.root.hidden, true);
  assert.equal(single.root.innerHTML, '', 'a hidden panel keeps no stale content');
  single.setRows([read, { ...blank, id: 'a2' }]);
  await single.panel.reload();
  assert.equal(footerRoot.hidden, true, 'right placement leaves the footer empty');
  single.panel.destroy();
  const bottom = mount({ storage: memoryStorage(), rows: [read, { ...blank, id: 'a2' }], placement: 'bottom', footerRoot });
  await bottom.panel.whenIdle();
  assert.equal(bottom.root.hidden, true, 'bottom placement hides the right panel');
  assert.equal(footerRoot.hidden, false); assert.match(footerRoot.innerHTML, /qp-foot-item/);
  bottom.panel.destroy();
});

test('placement defaults to right, survives reloads, ignores unknown values and notifies', () => {
  const { createQuotaPlacement, STORAGE_KEY } = require('../renderer/codeagent-quota-placement');
  const storage = memoryStorage();
  const placement = createQuotaPlacement({ storage });
  assert.equal(placement.get(), 'right');
  const seen = [];
  placement.subscribe(value => seen.push(value));
  placement.set('elsewhere'); placement.set('right');
  assert.deepEqual(seen, []);
  placement.set('bottom');
  assert.deepEqual(seen, ['bottom']);
  assert.equal(createQuotaPlacement({ storage }).get(), 'bottom');
  assert.equal(createQuotaPlacement({ storage: memoryStorage({ [STORAGE_KEY]: 'junk' }) }).get(), 'right');
});
