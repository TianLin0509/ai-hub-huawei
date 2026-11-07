'use strict';
// 额度读取失败后，用户手动刷新不被「10 分钟内已读过」冷却挡住；成功读过的号仍冷却，自动读取的节奏不变。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodeAgentQuotaPanel } = require('../core/codeagent-quota-panel');

function make() {
  let clock = 1_000_000, fail = true; const calls = [];
  const panel = createCodeAgentQuotaPanel({
    getStatus: () => ({ ok: true, personal: { state: 'ready', present: true }, accounts: [{ id: 'a1', state: 'ready', present: true }, { id: 'a2', state: 'ready', present: true }] }),
    readUsage: () => ({}), serveEnabled: () => true, now: () => clock,
    refreshAccount: async key => { calls.push(key); if (fail) throw new Error('登录过期'); },
  });
  return { panel, calls, tick: ms => { clock += ms; }, ok: () => { fail = false; } };
}

test('失败后一分钟内手动刷新：重新读取，不进冷却', async () => {
  const h = make();
  const first = await h.panel.snapshot({ refresh: true, key: 'a1' });
  assert.equal(first.rows.find(r => r.id === 'a1').refresh.status, 'failed');
  h.tick(60_000); h.ok();
  const second = await h.panel.snapshot({ refresh: true, key: 'a1' });
  assert.equal(second.rows.find(r => r.id === 'a1').refresh.status, 'updated');
  assert.equal(h.calls.length, 2);
});

test('读取成功后手动刷新仍在冷却内（避免重复读）', async () => {
  const h = make(); h.ok();
  await h.panel.snapshot({ refresh: true, key: 'a1' });
  h.tick(60_000);
  const again = await h.panel.snapshot({ refresh: true, key: 'a1' });
  assert.equal(again.rows.find(r => r.id === 'a1').refresh.status, 'cooldown');
  assert.equal(h.calls.length, 1);
});

test('自动读取失败后仍按冷却与退避，不因此变密', async () => {
  const h = make();
  await h.panel.refreshDue();
  const afterFirst = h.calls.length;
  assert.ok(afterFirst >= 1);
  h.tick(60_000);
  await h.panel.refreshDue();
  assert.equal(h.calls.length, afterFirst);
});
