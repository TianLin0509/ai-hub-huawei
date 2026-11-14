'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { recordPtySpawn, ptyProcessOwner } = require('../core/pty-process-owner');
function fixture(pid = 0) {
  const p = new EventEmitter();
  p.pid = pid;
  for (const [method, event] of [['onData', 'data'], ['onExit', 'exit']]) p[method] = callback => {
    p.on(event, callback); return { dispose: () => p.removeListener(event, callback) };
  };
  return p;
}
test('deferred PID is captured on connection readiness before any output; subscriptions are released', () => {
  const p = fixture(); let calls = 0;
  recordPtySpawn(p, () => calls++); recordPtySpawn(p);
  assert.equal(ptyProcessOwner(p), undefined);
  assert.equal(p.listenerCount('data'), 1);
  p.pid = 123; p.emit('ready_datapipe');
  const owner = ptyProcessOwner(p);
  assert.equal(owner.pid, 123); assert.equal(owner.pty, p); assert.equal(calls, 1);
  assert.equal(p.eventNames().length, 0);
  p.pid = 456; recordPtySpawn(p); p.emit('data', 'later');
  assert.equal(ptyProcessOwner(p), owner); assert.equal(owner.pid, 123);
});
test('public data fallback captures the ready PID and CLI wrappers expose the same owner', () => {
  const p = fixture(); recordPtySpawn(p);
  p.emit('data', 'premature'); assert.equal(ptyProcessOwner(p), undefined);
  p.pid = 789; p.emit('data', 'ready');
  assert.equal(ptyProcessOwner({ isCliProvider: true, pty: p }), ptyProcessOwner(p));
  assert.equal(ptyProcessOwner(p).pid, 789); assert.equal(p.eventNames().length, 0);
});
test('exit before connection cannot acquire ownership from a late/recycled PID', () => {
  const p = fixture(); recordPtySpawn(p);
  p.emit('exit'); p.pid = 999; p.emit('ready_datapipe'); p.emit('data', 'late');
  assert.equal(ptyProcessOwner(p), undefined); assert.equal(p.eventNames().length, 0);
});
test('synchronous PID keeps the original spawn observation without listeners', () => {
  const p = fixture(42); let called;
  recordPtySpawn(p, owner => { called = owner; });
  assert.equal(ptyProcessOwner(p), called); assert.equal(called.pid, 42);
  assert.equal(p.eventNames().length, 0); assert.ok(Object.isFrozen(called));
});
