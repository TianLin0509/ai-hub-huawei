'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sidebarRelativeTime } = require('../renderer/sidebar-relative-time');

const now = 10 * 86400000;
test('default labels stay compact and unchanged outside the company shell', () => {
  assert.equal(sidebarRelativeTime(now - 10000, now, { chinese: false }), 'NOW');
  assert.equal(sidebarRelativeTime(now - 5 * 60000, now, { chinese: false }), '5M');
  assert.equal(sidebarRelativeTime(now - 3 * 3600000, now, { chinese: false }), '3H');
  assert.equal(sidebarRelativeTime(now - 2 * 86400000, now, { chinese: false }), '2D');
  assert.equal(sidebarRelativeTime(0, now), '—');
});

test('company shell labels read as Chinese words', () => {
  assert.equal(sidebarRelativeTime(now - 10000, now, { chinese: true }), '刚刚');
  assert.equal(sidebarRelativeTime(now - 5 * 60000, now, { chinese: true }), '5 分钟');
  assert.equal(sidebarRelativeTime(now - 3 * 3600000, now, { chinese: true }), '3 小时');
  assert.equal(sidebarRelativeTime(now - 2 * 86400000, now, { chinese: true }), '2 天');
});

test('without a document the helper falls back to the compact labels', () => {
  assert.equal(sidebarRelativeTime(now - 10000, now), 'NOW');
});
