'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMeetingModelSync } = require('../renderer/company-meeting-models');
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(invoke) {
  const ipc = new EventEmitter(), calls = [], catalogs = []; let updates = 0;
  ipc.invoke = (channel, args) => { calls.push([channel, args]); return invoke(channel, args); };
  const sync = createMeetingModelSync({ ipcRenderer: ipc, onCatalog: c => catalogs.push(c), onUpdate: () => { updates++; } });
  return { ipc, calls, catalogs, sync, updates: () => updates };
}
test('打开会议后读取个人账号，复用已有模型入口，其他账号事件不混入', async () => {
  const f = setup(async () => ({ catalog: { state: 'ready' } }));
  f.ipc.emit('codeagent-pool:changed', {}, { id: 'personal' }); await turn();
  assert.equal(f.calls.length, 0, '页面没打开不额外启动探测');
  await f.sync.read();
  assert.deepEqual(f.calls, [['codeagent:models', { account: 'personal' }]]);
  f.ipc.emit('codeagent-pool:changed', {}, { id: 'someone-else' }); await turn();
  assert.equal(f.calls.length, 1);
  f.ipc.emit('codeagent-pool:changed', {}, { id: 'personal', ok: true }); await turn();
  assert.equal(f.calls.length, 2); assert.equal(f.updates(), 2);
  f.sync.dispose(); assert.equal(f.ipc.listenerCount('codeagent-pool:changed'), 0);
});
test('读取尚未结束时到达的探测完成事件不会丢失，也不并发启动读取', async () => {
  let resolve; const f = setup(() => new Promise(r => { resolve = r; }));
  const first = f.sync.read(); await turn();
  f.ipc.emit('codeagent-pool:changed', {}, { id: 'personal' });
  f.ipc.emit('codeagent-pool:changed', {}, { id: 'personal' });
  assert.equal(f.calls.length, 1);
  resolve({ catalog: { state: 'loading' } }); await first; await turn();
  assert.equal(f.calls.length, 2);
  resolve({ catalog: { state: 'ready' } }); await turn();
  assert.deepEqual(f.catalogs.map(c => c.state), ['loading', 'ready']); f.sync.dispose();
});
test('失败明确显示，用户重试走已有个人账号探测，默认模型不被改写', async () => {
  let failed = true;
  const f = setup(async channel => {
    if (channel === 'codeagent-pool:probe') { failed = false; return { ok: true }; }
    if (failed) throw new Error('synthetic offline');
    return { catalog: { state: 'ready' } };
  });
  await f.sync.read(); assert.equal(f.catalogs.at(-1).state, 'failed'); assert.match(f.catalogs.at(-1).error, /offline/);
  await f.sync.retry();
  assert.deepEqual(f.calls, [['codeagent:models', { account: 'personal' }], ['codeagent-pool:probe', { id: 'personal' }], ['codeagent:models', { account: 'personal' }]]);
  assert.deepEqual(f.catalogs.map(c => c.state), ['failed', 'loading', 'ready']); f.sync.dispose();
});
test('探测失败不无限重试，关闭页面实例后迟到结果不更新界面', async () => {
  const f = setup(async () => ({ ok: false, error: 'synthetic rejected' }));
  await f.sync.retry(); assert.equal(f.calls.length, 1); assert.equal(f.catalogs.at(-1).state, 'failed');
  f.sync.dispose();
  let resolve; const late = setup(() => new Promise(r => { resolve = r; }));
  const request = late.sync.read(); await turn(); late.sync.dispose();
  resolve({ catalog: { state: 'ready' } }); await request;
  assert.equal(late.updates(), 0); assert.equal(late.catalogs.length, 0);
});
