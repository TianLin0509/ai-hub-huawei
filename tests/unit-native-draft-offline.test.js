'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createNativeDraftController } = require('../renderer/native-draft-controller.js');

function makeMain() {
  const m = { alive: true, store: { revision: 0, text: null } };
  m.invoke = async (channel, req) => {
    if (!m.alive) return { ok: false, error: '当前会话不支持草稿持久化', code: 'session-offline' };
    if (channel === 'native-draft:read') return { ok: true, record: { ...m.store } };
    if (req.revision !== m.store.revision) return { ok: false, error: 'conflict' };
    m.store = { revision: m.store.revision + 1, text: req.text };
    return { ok: true, record: { ...m.store } };
  };
  return m;
}
const tick = () => new Promise(r => setTimeout(r, 5));

test('A2-01 断开期间写的草稿，重新 attach 后保留并落盘', async () => {
  const main = makeMain();
  let restored = null;
  const c = createNativeDraftController({ sessionId: 's', invoke: main.invoke, onRestore: t => { restored = t; } });
  await c.ready;
  c.change('第一条'); await tick();
  c.change(''); await tick();
  main.alive = false;
  c.change('断开期间写的一大段需求'); await tick();
  assert.equal(c.state.failure, null);
  main.alive = true;
  c.attach({ onRestore: t => { restored = t; }, onStatus() {} });
  await tick(); await tick();
  assert.equal(restored, '断开期间写的一大段需求');
  assert.equal(main.store.text, '断开期间写的一大段需求');
});

test('A2-02 断开时按发送不使控制器永久失败，flush 不抛错也不挂起', async () => {
  const main = makeMain();
  const c = createNativeDraftController({ sessionId: 's', invoke: main.invoke });
  await c.ready;
  c.change('没发出去的草稿'); await tick();
  main.alive = false;
  c.change(''); await tick();
  assert.equal(c.state.failure, null);
  await c.flush();
  main.alive = true;
  c.change('重连后继续改'); await tick(); await tick();
  assert.equal(c.state.failure, null);
  assert.equal(main.store.text, '重连后继续改');
});

test('主进程在会话不存在时返回 session-offline 错误码', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), 'utf8');
  assert.match(src, /session \? null : 'session-offline'/);
});

test('closeSessionAsSleep 在草稿 flush 失败时仍然关闭会话', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const i = src.indexOf('async function closeSessionAsSleep');
  const body = src.slice(i, i + 900);
  assert.match(body, /try \{ await nativeDraftControllers\.get\(sessionId\)\?\.flush\(\); \}\s*catch/);
});
