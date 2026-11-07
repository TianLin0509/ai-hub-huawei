'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recentSessions, relativeTime, folderName, rowView, greeting } = require('../renderer/home-recent');
const shortcuts = require('../renderer/shortcut-help');

const NOW = Date.parse('2026-11-07T08:00:00+08:00');
const hoursAgo = h => NOW - h * 3600 * 1000;
const session = (id, h, extra = {}) => ({ id, title: id, kind: 'codeagent', cwd: 'D:\\work\\' + id, lastMessageTime: hoursAgo(h), ...extra });

test('接着做按最近活动排序，最多 4 条', () => {
  const list = [session('a', 30), session('b', 1), session('c', 5), session('d', 50), session('e', 2)];
  assert.deepEqual(recentSessions(list, NOW).map(s => s.id), ['b', 'e', 'c', 'a']);
});

test('后台用途的会话、隐藏的、终端和太久以前的不进主页', () => {
  const list = [
    session('assistant', 1, { purpose: 'company-assistant' }),
    session('hidden', 1, { hiddenFromSidebar: true }),
    session('shell', 1, { kind: 'powershell' }),
    session('old', 24 * 20),
    session('ok', 2),
  ];
  assert.deepEqual(recentSessions(list, NOW).map(s => s.id), ['ok']);
});

test('相对时间说人话', () => {
  assert.equal(relativeTime(NOW - 10 * 1000, NOW), '刚刚');
  assert.equal(relativeTime(NOW - 5 * 60000, NOW), '5 分钟前');
  assert.equal(relativeTime(hoursAgo(3), NOW), '3 小时前');
  assert.equal(relativeTime(hoursAgo(26), NOW), '昨天');
  assert.equal(relativeTime(hoursAgo(72), NOW), '3 天前');
});

test('文件夹名取最后一段，Windows 和 Unix 路径都认', () => {
  assert.equal(folderName('D:\\AIWork\\demo\\'), 'demo');
  assert.equal(folderName('/home/x/demo'), 'demo');
  assert.equal(folderName(''), '');
});

test('休眠和等你回复写在行上', () => {
  assert.equal(rowView(session('a', 1, { status: 'dormant' }), NOW).statusText, '已休眠，点开接着做');
  assert.equal(rowView(session('a', 1, { waitingText: '等你选一个方案' }), NOW).statusKey, 'waiting');
  assert.equal(rowView(session('a', 1), NOW).statusText, '');
});

test('日期问候', () => {
  assert.equal(greeting(new Date(2026, 10, 7, 9)), '11 月 7 日 周六 · 上午好');
  assert.equal(greeting(new Date(2026, 10, 7, 21)), '11 月 7 日 周六 · 晚上好');
});

test('快捷键表每组都有内容，转义后不含原始标签', () => {
  assert.ok(shortcuts.GROUPS.length >= 3);
  for (const group of shortcuts.GROUPS) assert.ok(group.items.length > 0, group.title);
  const html = shortcuts.renderHtml(s => String(s).replace(/</g, '&lt;'));
  assert.ok(html.includes('<kbd>Ctrl</kbd>'));
});
