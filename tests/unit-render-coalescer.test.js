'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderCoalescer } = require('../renderer/render-coalescer');

test('coalesces a burst into one render and supports deterministic flush', async () => {
  let rendered = 0;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 20 });
  for (let i = 0; i < 50; i += 1) coalescer.schedule();
  assert.deepEqual(coalescer.stats(), { requests: 50, renders: 0, pending: true, delayMs: 20 });
  assert.equal(coalescer.flush(), true);
  assert.equal(rendered, 1);
  assert.deepEqual(coalescer.stats(), { requests: 50, renders: 1, pending: false, delayMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rendered, 1, 'flushed timer must not fire again');
});

test('allows a later burst to schedule a later render', async () => {
  let rendered = 0;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 5 });
  coalescer.schedule();
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 15));
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(rendered, 2);
  assert.equal(coalescer.stats().requests, 3);
});

test('typing priority: defers renders while busy, but never longer than maxDeferMs', async () => {
  let rendered = 0;
  let typing = true;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 5, deferWhile: () => typing, maxDeferMs: 60 });
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(rendered, 0, '打字时先不画');
  assert.ok(coalescer.stats().deferred >= 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(rendered, 1, '一直在打也会在上限内画一次');
  typing = false;
  coalescer.schedule();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rendered, 2, '停手后照常画');
});

test('typing priority: flush renders immediately even while typing', () => {
  let rendered = 0;
  const coalescer = createRenderCoalescer(() => { rendered += 1; }, { delayMs: 50, deferWhile: () => true, maxDeferMs: 1000 });
  coalescer.schedule();
  assert.equal(coalescer.flush(), true);
  assert.equal(rendered, 1);
  assert.equal(coalescer.stats().pending, false);
});
