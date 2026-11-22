'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountQuotaPanel } = require('../renderer/account-quota-panel');

function mount(storage = { getItem: () => null, setItem() {} }) {
  let time = Date.parse('2026-11-23T01:00:00Z'), writes = 0, tick;
  const events = {}, box = { innerHTML: '', scrollTop: 120 };
  const root = { classList: { toggle() {} }, addEventListener: (type, fn) => { events[type] = fn; },
    querySelector: () => box, set innerHTML(value) { writes++; box.innerHTML = value; } };
  const snapshot = { accounts: Object.fromEntries(['claude', 'codex', 'antigravity'].map(provider => [provider,
    ['a', 'b'].map(profileId => ({ profileId, usage5h: { utilization: 20, resetsAt: '2026-11-23T04:00:00Z' },
      usage7d: { utilization: 40, resetsAt: '2026-11-26T01:00:00Z' } }))])) };
  let refreshes = 0;
  const panel = createAccountQuotaPanel({ document: {}, root, storage, getSnapshot: () => snapshot,
    getActiveSessionCount: () => 0, refresh: async () => { refreshes++; }, nowFn: () => time,
    setIntervalFn: fn => { tick = fn; } });
  panel.render();
  const event = targets => {
    let prevented = false;
    events.contextmenu({ target: { closest: selector => targets[selector] || null }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const hide = (provider, profileId) => event({ '[data-cq-profile]': { dataset: { cqProvider: provider, cqProfile: profileId } } });
  const restore = provider => event({ 'h3, .cq-logo': {}, '[data-cq-group]': { dataset: { cqGroup: provider } } });
  return { panel, box, snapshot, hide, restore, event, get writes() { return writes; }, get refreshes() { return refreshes; },
    tick: () => { time += 60000; tick(); }, collapse: () => events.click({ target: { closest: () => ({ dataset: { cqAction: 'collapse' } }) } }) };
}

test('分钟刷新及额度变化保留滚动容器、位置，表头只出现一次', () => {
  const m = mount(), box = m.box;
  const before = box.innerHTML;
  m.tick();
  assert.equal(m.writes, 1);
  assert.equal(m.box, box);
  assert.equal(box.scrollTop, 120);
  assert.notEqual(box.innerHTML, before);
  assert.equal((box.innerHTML.match(/class="cq-columns"/g) || []).length, 1);
  m.snapshot.accounts.codex[0].usage7d.utilization = 60;
  m.panel.render();
  assert.equal(m.writes, 1);
  assert.equal(box.scrollTop, 120);
});

test('隐藏偏好只影响指定账号的显示和汇总，全组隐藏仍有恢复标题', () => {
  const values = {};
  const storage = { getItem: key => values[key], setItem: (key, value) => { values[key] = value; } };
  const m = mount(storage);
  assert.deepEqual(m.panel.getState().hidden, []);
  assert.equal(m.hide('claude', 'a'), true);
  assert.equal(m.hide('claude', 'b'), true);
  assert.match(m.box.innerHTML, /data-cq-group="claude"/);
  assert.doesNotMatch(m.box.innerHTML, /data-cq-provider="claude"/);
  assert.match(m.box.innerHTML, /0<\/b> \/ 0 可用/);
  assert.equal(m.snapshot.accounts.claude.length, 2);
  assert.equal(m.refreshes, 0);
  assert.deepEqual(mount(storage).panel.getState().hidden, ['claude:a', 'claude:b']);
  assert.equal(m.hide('codex', 'a'), true);
  assert.equal(m.restore('claude'), true);
  assert.deepEqual(m.panel.getState().hidden, ['codex:a']);
  assert.equal(m.writes, 1, '隐藏和恢复不重建外壳');
  assert.equal(m.box.scrollTop, 120);
});

test('空白区不恢复、Gemini 不新增隐藏能力，顶部和细栏都有全部恢复入口', () => {
  const m = mount();
  m.hide('codex', 'a');
  assert.equal(m.event({ '[data-cq-group]': { dataset: { cqGroup: 'codex' } } }), false);
  assert.equal(m.hide('antigravity', 'a'), false);
  assert.deepEqual(m.panel.getState().hidden, ['codex:a']);
  assert.equal(m.event({ '.cq-head, .cq-expand': {} }), true);
  assert.deepEqual(m.panel.getState().hidden, []);
  m.hide('claude', 'a'); m.hide('claude', 'b'); m.collapse();
  assert.match(m.box.innerHTML, /cq-rail-group" data-cq-group="claude"/);
  assert.equal(m.restore('claude'), true);
  m.hide('codex', 'a');
  assert.equal(m.event({ '.cq-head, .cq-expand': {} }), true);
  assert.deepEqual(m.panel.getState().hidden, []);
});
