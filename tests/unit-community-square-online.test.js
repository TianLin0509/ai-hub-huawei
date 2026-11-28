'use strict';
// 社区 › 广场（2026-11-28）：在线绿点与人数取收件机的真实在线标记，不再一律标在线、不再写死人数。
const test = require('node:test');
const assert = require('node:assert/strict');
const { people, headcount } = require('../renderer/community-square');

const entry = (nick, on, extra = {}) => ({ nick, pet: '01-cat', lv: 10, value: 1, ...(on === undefined ? {} : { on }), ...extra });

test('广场：按收件机的 on 标记画在线/离线，在线的排前面', () => {
  const board = { boards: { level: [entry('甲', false), entry('乙', true), entry('丙', false)], streak: [entry('甲', true)] }, me: { nick: '我' } };
  const list = people(board, null);
  assert.equal(list[0].id, 'me');
  const byNick = Object.fromEntries(list.map(p => [p.nick, p.status]));
  assert.equal(byNick['甲'], 'on', '任一张榜说在线就算在线');
  assert.equal(byNick['乙'], 'on');
  assert.equal(byNick['丙'], 'off');
  assert.equal(list[list.length - 1].nick, '丙', '离线的排在后面');
  assert.deepEqual(headcount(list, board), { shown: 4, online: 3, listed: 4, known: true });
});

test('广场：旧收件机没给 on，不冒充在线，人数照实', () => {
  const board = { boards: { level: [entry('甲'), entry('乙')] } };
  const list = people(board, null);
  assert.ok(list.filter(p => !p.me).every(p => p.status === 'unknown'));
  assert.equal(headcount(list, board).known, false);
});

test('广场：超过 15 只只画 15 只，但榜上人数照实统计', () => {
  const level = Array.from({ length: 30 }, (_, i) => entry('u' + i, i >= 25));
  const board = { boards: { level } };
  const list = people(board, null);
  assert.equal(list.length, 15);
  assert.equal(list.filter(p => !p.me && p.status === 'on').length, 5, '5 个在线的都画出来了');
  const hc = headcount(list, board);
  assert.equal(hc.listed, 31); assert.equal(hc.shown, 15); assert.equal(hc.online, 6);
});

test('广场：连不上收件机拿到的是过期榜单，在线状态按不知道处理', () => {
  const board = { stale: true, boards: { level: [entry('甲', true), entry('乙', false)] } };
  const list = people(board, null);
  assert.ok(list.filter(p => !p.me).every(p => p.status === 'unknown'));
  assert.equal(headcount(list, board).known, false);
});
