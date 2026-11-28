'use strict';
// 手动归档（2026-11-28）：默认不自动归档；一键归档按时长和准则；老用户升级时冻结原归档；再有来往自动回侧栏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('../core/sidebar-archive');
const { buildSidebarView, partitionSidebarSessions } = require('../core/session-sidebar-state');

const H = 3600000, NOW = Date.UTC(2026, 10, 28, 4);
const ago = hours => NOW - hours * H;
const item = (id, hours, extra = {}) => ({ id, title: id, createdAt: ago(hours), lastMessageTime: ago(hours), ...extra });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sidebar-archive-'));

test('默认不自动归档：闲置 30 天、没点过归档的会话仍留在侧栏', () => {
  const archive = rules.emptyState();
  assert.equal(archive.auto.enabled, false);
  assert.equal(rules.isItemArchived(item('a', 24 * 30), { state: 'idle', now: NOW, archive }), false);
});

test('手动归档：记录之后没有新来往就在归档；再发消息自动回侧栏', () => {
  const s = item('a', 10);
  const archive = { ...rules.emptyState(), records: { 'session:a': ago(1) } };
  assert.equal(rules.isItemArchived(s, { state: 'idle', now: NOW, archive }), true);
  assert.equal(rules.isItemArchived({ ...s, lastMessageTime: NOW }, { state: 'idle', now: NOW, archive }), false);
});

test('运行中、等回复、出错、未读、置顶任何时候都不归档', () => {
  const archive = { ...rules.emptyState(), auto: { enabled: true, ...rules.DEFAULT_RULE }, records: { 'session:a': NOW } };
  const s = item('a', 100);
  for (const state of ['run', 'wait', 'error']) assert.equal(rules.isItemArchived(s, { state, now: NOW, archive }), false, state);
  assert.equal(rules.isItemArchived(s, { state: 'idle', unread: true, now: NOW, archive }), false);
  assert.equal(rules.isItemArchived({ ...s, pinned: true }, { state: 'idle', now: NOW, archive }), false);
});

test('时长与准则：24 小时 / 3 天 / 7 天边界；保留群聊；保留已放进目录的', () => {
  const rule = hours => ({ ...rules.DEFAULT_RULE, hours });
  assert.equal(rules.matchesRule(item('a', 23.9), { now: NOW, rule: rule(24) }), false);
  assert.equal(rules.matchesRule(item('a', 24), { now: NOW, rule: rule(24) }), true);
  assert.equal(rules.matchesRule(item('a', 71), { now: NOW, rule: rule(72) }), false);
  assert.equal(rules.matchesRule(item('a', 169), { now: NOW, rule: rule(168) }), true);
  const meeting = item('m', 200, { _isMeeting: true });
  assert.equal(rules.matchesRule(meeting, { now: NOW, rule: { ...rule(24), keepGroups: true } }), false);
  assert.equal(rules.matchesRule(meeting, { now: NOW, rule: rule(24) }), true);
  assert.equal(rules.matchesRule(item('a', 200), { now: NOW, rule: { ...rule(24), keepFoldered: true }, folder: 'folder-x' }), false);
  assert.equal(rules.matchesRule(item('a', 200), { now: NOW, rule: { ...rule(24), keepFoldered: true }, folder: null }), true);
});

test('自定义时长校验：1 小时到 365 天', () => {
  assert.throws(() => rules.cleanRule({ hours: 0 }), /1 小时到 365 天/);
  assert.throws(() => rules.cleanRule({ hours: 24 * 366 }), /1 小时到 365 天/);
  assert.throws(() => rules.cleanRule({ hours: 'x' }), /1 小时到 365 天/);
  assert.deepEqual(rules.cleanRule({ hours: 48.2, keepGroups: true }), { hours: 48, keepGroups: true, keepFoldered: false });
});

test('自动归档开启后按所选规则归，关闭后恢复显示（没有手动记录的）', () => {
  const s = item('a', 80);
  const on = { ...rules.emptyState(), auto: { enabled: true, hours: 72, keepGroups: false, keepFoldered: false } };
  assert.equal(rules.isItemArchived(s, { state: 'idle', now: NOW, archive: on }), true);
  assert.equal(rules.isItemArchived(s, { state: 'idle', now: NOW, archive: { ...on, auto: { ...on.auto, enabled: false } } }), false);
});

test('侧栏视图：给了归档判断就按它分，不再按 1 天切', () => {
  const items = [item('old', 24 * 10), item('kept', 24 * 10), item('fresh', 1)];
  const parts = partitionSidebarSessions(items, { now: NOW });
  const archive = { ...rules.emptyState(), records: { 'session:old': ago(2) } };
  const view = buildSidebarView(parts, { now: NOW, excludePinned: true,
    isArchived: (it, state, unread) => rules.isItemArchived(it, { state, unread, now: NOW, archive }) });
  assert.deepEqual(view.archive.map(x => x.id), ['old']);
  assert.deepEqual(view.today.map(x => x.id).sort(), ['fresh', 'kept']);
  // 不给判断时沿用旧规则（旧调用方）：10 天前的都进归档。
  const legacy = buildSidebarView(parts, { now: NOW, days: 1, excludePinned: true });
  assert.deepEqual(legacy.archive.map(x => x.id).sort(), ['kept', 'old']);
});

test('老用户迁移：第一次读取把原来已在归档里的冻结；按原来所选的 3 天算；只迁一次', async () => {
  const dir = tmp();
  let items = [item('a', 30), item('b', 80), item('p', 200, { pinned: true }), item('m', 100, { _isMeeting: true }), item('new', 2)];
  const store = rules.createSidebarArchiveStore({ dataDir: dir, legacyItems: () => items, now: () => NOW });
  const state = await store.list({ legacyDays: 3 });
  assert.deepEqual(Object.keys(state.records).sort(), ['meeting:m', 'session:b']);
  assert.ok(state.migratedAt > 0);
  assert.equal(state.auto.enabled, false);
  items = [...items, item('c', 500)];
  const again = await store.list({ legacyDays: 1 });
  assert.deepEqual(Object.keys(again.records).sort(), ['meeting:m', 'session:b'], '迁移只做一次，之后不再自动归');
});

test('老用户迁移（原来选「今天」）：闲置超过 24 小时的冻结；新用户没有会话时什么都不归', async () => {
  const store = rules.createSidebarArchiveStore({ dataDir: tmp(), legacyItems: () => [item('a', 30), item('b', 5)], now: () => NOW });
  assert.deepEqual(Object.keys((await store.list({ legacyDays: 1 })).records), ['session:a']);
  const fresh = rules.createSidebarArchiveStore({ dataDir: tmp(), legacyItems: () => [], now: () => NOW });
  const s = await fresh.list();
  assert.deepEqual(s.records, {}); assert.ok(s.migratedAt > 0);
});

test('存储：归档、恢复、自动归档设置、清掉已删会话的记录；坏文件不覆盖', async () => {
  const dir = tmp();
  const store = rules.createSidebarArchiveStore({ dataDir: dir, now: () => NOW });
  await store.list();
  let state = await store.archive(['session:a', 'meeting:m', 'bad key', 42]);
  assert.deepEqual(Object.keys(state.records).sort(), ['meeting:m', 'session:a']);
  state = await store.restore(['session:a']);
  assert.deepEqual(Object.keys(state.records), ['meeting:m']);
  state = await store.setAuto(true, { hours: 168, keepGroups: true });
  assert.deepEqual(state.auto, { enabled: true, hours: 168, keepGroups: true, keepFoldered: false });
  await assert.rejects(store.setAuto(true, { hours: 0 }), /1 小时到 365 天/);
  state = await store.prune(key => key !== 'meeting:m');
  assert.deepEqual(state.records, {});
  const file = path.join(dir, 'sidebar-archive.json');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(store.archive(['session:x']), /原文件已保留/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('没有归档文件时清理不写文件（启动时不为新用户落一个空文件，也不提前做迁移）', async () => {
  const dir = tmp();
  const store = rules.createSidebarArchiveStore({ dataDir: dir, legacyItems: () => [item('a', 99)], now: () => NOW });
  await store.prune(() => false);
  assert.equal(fs.existsSync(path.join(dir, 'sidebar-archive.json')), false);
});

test('团队负责人：group 标明团队时「保留群聊和团队」生效；成员的最近活动晚于归档时刻就回侧栏', () => {
  const lead = item('lead', 100);
  const rule = { ...rules.DEFAULT_RULE, hours: 24, keepGroups: true };
  assert.equal(rules.matchesRule(lead, { now: NOW, rule, group: true }), false);
  assert.equal(rules.matchesRule(lead, { now: NOW, rule, group: false }), true);
  const archive = { ...rules.emptyState(), records: { 'session:lead': ago(50) } };
  assert.equal(rules.isItemArchived(lead, { state: 'idle', now: NOW, archive }), true);
  assert.equal(rules.isItemArchived(lead, { state: 'idle', now: NOW, archive, activity: ago(1) }), false, '成员 1 小时前有来往');
  assert.equal(rules.isItemArchived(lead, { state: 'run', now: NOW, archive }), false, '成员在跑（调用方并入 state）');
});
