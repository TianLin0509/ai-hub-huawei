'use strict';
// 已取消的会议不再被检索和识别（2026-11-18 群反馈）：WeLink 会议接口和日历两条路都过滤，正常会议和拿不准的状态照旧保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/company-assistant/data');
const Q = require('../core/company-assistant/queries');

const START = Date.parse('2026-11-19T02:00:00Z');
const row = (id, extra = {}) => ({ enMeetingId: 'e-' + id, meetingId: id, subject: '例会（占位）', meetingStartTime: START, meetingEndTime: START + 3600000, meetingUsers: [{}], ...extra });

test('会议接口：取消标记、明确的取消状态值滤掉', () => {
  const raw = { code: '200', data: { data: [
    row('keep'),
    row('flag', { isCancelled: true }), row('flag-str', { canceled: 'true' }),
    row('state', { meetingStatus: 'Cancelled' }), row('state-cn', { status: '已取消' }), row('conf', { conferenceState: 'CANCEL' }),
  ] } };
  assert.deepEqual(D.meetings(raw).map(m => m.id), ['keep']);
});

test('会议接口：拿不准的不滤——数字状态码、标题含「取消」或以「已取消:」开头、取消标记为 false、状态只是含 cancel', () => {
  const raw = { code: '200', data: { data: [
    row('num', { meetingStatus: 3 }), row('word', { subject: '讨论取消旧接口的方案（占位）' }), row('false', { isCancelled: false }), row('created', { conferenceState: 'Created' }),
    row('subj', { subject: '已取消: 方案评审（占位）' }), row('subj-en', { subject: 'Canceled: weekly sync' }), row('partial', { state: 'cancel-pending' }),
  ] } };
  assert.deepEqual(D.meetings(raw).map(m => m.id), ['num', 'word', 'false', 'created', 'subj', 'subj-en', 'partial']);
});

test('分页取数：取消的会不算无效记录，接口总数含取消的也不报「少于总数」', async () => {
  const page = { code: '200', data: { total: 3, data: [row('a'), row('b'), row('c', { isCancelled: true })] } };
  const result = await Q.collectMeetings(async () => page, START, { size: 30, range: { start: START - 3600000, end: START + 86400000 } });
  assert.deepEqual(result.meetings.map(m => m.id), ['a', 'b']);
  assert.equal(result.coverage.invalid, 0);
  assert.equal(result.coverage.cancelled, 1);
  assert.equal(result.coverage.status, 'complete');
  assert.match(result.coverage.reasonLabel, /已过滤 1 场已取消会议/);
});

test('日历：只按原有 isCancelled 规则滤，不看标题前缀', () => {
  const ev = (id, extra = {}) => ({ itemId: id, subject: '对齐会（占位）', start: '2026-11-19T10:00:00+08:00', end: '2026-11-19T11:00:00+08:00', ...extra });
  const raw = { events: [ev('keep'), ev('flag', { isCancelled: true }), ev('subj', { subject: '已取消：对齐会（占位）' }), ev('word', { subject: '取消订阅讨论（占位）' })] };
  assert.deepEqual(D.calendarEvents(raw).map(e => e.id), ['keep', 'subj', 'word']);
});

test('同一场取消的会在多页重复出现只算一次：取到的实例少于接口总数时不报完整', async () => {
  const pages = [
    { code: '200', data: { total: 3, data: [row('a'), row('c', { isCancelled: true })] } },
    { code: '200', data: { total: 3, data: [row('c', { isCancelled: true })] } },
  ];
  let n = 0;
  const result = await Q.collectMeetings(async () => pages[n++], START, { size: 2, range: { start: START - 3600000, end: START + 86400000 } });
  assert.deepEqual(result.meetings.map(m => m.id), ['a']);
  assert.equal(result.coverage.cancelled, 1);
  assert.notEqual(result.coverage.status, 'complete');
});

test('后页把同一场标为取消：前页已取到的正常版本一起撤掉', async () => {
  const pages = [
    { code: '200', data: { total: 3, data: [row('a'), row('b')] } },
    { code: '200', data: { total: 3, data: [row('a', { isCancelled: true })] } },
  ];
  let n = 0;
  const result = await Q.collectMeetings(async () => pages[n++], START, { size: 2, range: { start: START - 3600000, end: START + 86400000 } });
  assert.deepEqual(result.meetings.map(m => m.id), ['b']);
  assert.equal(result.coverage.cancelled, 1);
  assert.equal(result.coverage.versionConflicts, 0);
});
