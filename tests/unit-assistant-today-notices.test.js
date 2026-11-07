'use strict';
// 「今天」栏提醒区：显示最新的两条，不是最老的两条；简报提醒不重复列。
const test = require('node:test');
const assert = require('node:assert/strict');
const { latestNotices } = require('../renderer/company-assistant-page');

test('服务端给新到旧时取最新两条', () => {
  const notices = [5, 4, 3, 2, 1].map(i => ({ id: 'n' + i, at: i * 1000, kind: 'reminder' }));
  assert.deepEqual(latestNotices(notices).map(n => n.id), ['n5', 'n4']);
});

test('顺序反过来或乱序也取最新两条，并过滤简报提醒', () => {
  const notices = [{ id: 'old', at: 1 }, { id: 'brief', at: 99, kind: 'brief' }, { id: 'new', at: 50 }, { id: 'mid', at: 20 }];
  assert.deepEqual(latestNotices(notices).map(n => n.id), ['new', 'mid']);
  assert.deepEqual(latestNotices(undefined), []);
});
