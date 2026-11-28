'use strict';
// 2026-11-28 黄区：新装后第一次出来的自我介绍是常驻气泡，没人点就一直挂着；这时到点的提醒被直接收进小圆点，只看到角标。
// 现在提醒先说，自我介绍退回队里，提醒说完再接着说。
const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechQueue } = require('../core/hub-pet/state');

const ok = () => ({ ok: true });

test('常驻的自我介绍挂着时到点提醒：提醒马上上气泡，介绍不丢、之后接着说', () => {
  let t = 1000;
  const q = new SpeechQueue({ now: () => t, showMs: 8000 });
  q.push({ id: 'intro', kind: 'chatter', sticky: true, title: '你好，我是桌宠。' });
  q.tick(ok);
  assert.equal(q.current.id, 'intro');
  q.push({ id: 'rem-1', kind: 'reminder', sticky: true, title: '15:00 交周报', chips: [{ id: 'done', label: '完成' }] });
  q.tick(ok);
  assert.equal(q.current.id, 'rem-1', '提醒抢到气泡');
  assert.equal(q.dots.some(d => d.id === 'rem-1'), false, '提醒没被收进小圆点');
  t += 9000; q.tick(ok);
  assert.equal(q.current.id, 'rem-1', '提醒是常驻的，等用户点「完成」');
  q.takeCurrent(); q.tick(ok);
  assert.equal(q.current.id, 'intro', '提醒处理完，自我介绍接着说');
  assert.equal(q.current.sticky, true);
});

test('常驻气泡挂着时来的普通闲聊仍收进小圆点（原行为不变）', () => {
  const q = new SpeechQueue({ now: () => 1000 });
  q.push({ id: 'intro', kind: 'chatter', sticky: true, title: '你好' });
  q.tick(ok);
  q.push({ id: 'chat-1', kind: 'chatter', title: '喝口水吧' });
  q.tick(ok);
  assert.equal(q.current.id, 'intro');
  assert.ok(q.dots.some(d => d.id === 'chat-1'));
});

test('不能开口（安静档等）时提醒照旧进小圆点，介绍不会被弄丢', () => {
  const q = new SpeechQueue({ now: () => 1000 });
  q.push({ id: 'intro', kind: 'chatter', sticky: true, title: '你好' });
  q.tick(ok);
  q.push({ id: 'rem-2', kind: 'reminder', title: '开会' });
  q.tick((spokenAt, item) => (item && item.kind === 'reminder' ? { ok: false, reason: 'quiet' } : { ok: true }));
  assert.ok(q.dots.some(d => d.id === 'rem-2'));
  assert.equal(q.current && q.current.id, 'intro');
});
