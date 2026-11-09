'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MeetingCapture } = require('../renderer/meeting-capture');

function capture() {
  const clock = { now: 0 };
  const c = new MeetingCapture({ document: {}, window: { performance: { now: () => clock.now } }, save: async () => {}, status: () => {} });
  c.started = 0; c.running = true; c.paused = false; c.enqueue = () => {};
  return { c, clock };
}

test('界面时钟在暂停期间停住，录像时间轴继续走', () => {
  const { c, clock } = capture();
  clock.now = 6000; assert.equal(c.displayMs(), 6000);
  c.paused = true; c.openGap('用户暂停');
  clock.now = 9500;
  assert.equal(c.displayMs(), 6000);
  assert.equal(c.elapsed(), 9500);
});

test('继续后界面时钟恢复走动', () => {
  const { c, clock } = capture();
  clock.now = 6000; c.paused = true; c.openGap('用户暂停');
  clock.now = 9500; c.paused = false; c.gapAt = null;
  clock.now = 12000;
  assert.equal(c.displayMs(), 12000);
});
