'use strict';
// 已取消的会议不再被检索和识别（2026-11-18 群反馈）：WeLink 会议接口和日历两条路都过滤，正常会议和拿不准的状态照旧保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/company-assistant/data');
const Q = require('../core/company-assistant/queries');
const B = require('../core/company-assistant/brief');
const R = require('../core/company-assistant/reminders');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { AssistantQuery } = require('../core/company-assistant/query-tool');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('日历：与会议共用明确的取消字段规则，不看标题前缀', () => {
  const ev = (id, extra = {}) => ({ itemId: id, subject: '对齐会（占位）', start: '2026-11-19T10:00:00+08:00', end: '2026-11-19T11:00:00+08:00', ...extra });
  const raw = { events: [ev('keep'), ev('flag', { isCancelled: true }), ev('subj', { subject: '已取消：对齐会（占位）' }), ev('word', { subject: '取消订阅讨论（占位）' })] };
  assert.deepEqual(D.calendarEvents(raw).map(e => e.id), ['keep', 'subj', 'word']);
});

test('两源兼容取消字段：合成样例覆盖英美拼写、Exchange 大写、状态与蛇形字段', () => {
  const markers = [
    { cancelled: true }, { canceled: 'true' }, { isCanceled: true }, { isCancel: true },
    { IsCancelled: true }, { IsCanceled: 'true' }, { is_cancelled: true }, { is_canceled: 'true' },
    { status: 'CANCELLED' }, { Status: 'Canceled' }, { State: 'cancel' },
    { eventStatus: ' 已取消 ' }, { calendarStatus: 'cancelled' }, { meetingState: 'Canceled' },
  ];
  for (const marker of markers) {
    assert.equal(D.meetings([row('cancelled', marker)]).length, 0, JSON.stringify(marker));
    assert.equal(D.calendarEvents([{ id: 'cancelled', ...marker }]).length, 0, JSON.stringify(marker));
  }
  const unknown = [null, {}, { cancelled: false }, { status: 3 }, { status: 'not-cancelled' }, { status: 'cancel-pending' }];
  for (const marker of unknown) assert.equal(D.isCancelledCalendarEvent(marker), false, JSON.stringify(marker));
});

test('日历覆盖统计：其他取消字段不算无效记录或未知时间，正常日程保留', async () => {
  const result = await Q.collectCalendar(async () => ({ events: [
    { id: 'a', status: 'CANCELLED' }, { id: 'b', canceled: true }, { id: 'c', IsCancelled: true },
    { id: 'keep', subject: '保留', start: START, end: START + 3600000 },
  ] }), { start: START - 3600000, end: START + 86400000 });
  assert.deepEqual(result.events.map(e => e.id), ['keep']);
  assert.equal(result.coverage.cancelled, 3);
  assert.equal(result.coverage.invalid, 0);
  assert.equal(result.coverage.unknownTime, 0);
  assert.equal(result.coverage.status, 'complete');
});

test('CLI 表格：读取明确的状态/取消列，不把地点或标题中的 Cancelled 当状态', () => {
  const table = (columns, tail, subject = '日程') => Q.parseCalendarTable(`Subject Start End ${columns} ItemId\n------- ----- --- ------\n${subject}  2026-11-19T10:00+08:00  2026-11-19T11:00+08:00  ${tail}  fixture-id`);
  for (const [columns, tail] of [
    ['Location Status Organizer', 'room  Cancelled  organizer'],
    ['Location Status Organizer', 'room | Canceled | organizer'],
    ['Status Location', '已取消  room'], ['IsCancelled', 'true'], ['is_canceled', 'true'],
  ]) assert.equal(D.calendarEvents(table(columns, tail)).length, 0, tail);
  for (const [columns, tail, subject] of [
    ['Location Status Organizer', 'Cancelled  Busy  organizer'],
    ['Location Status Organizer', 'room  Busy  organizer', 'Cancelled: 正常议题'],
    ['Location Status Organizer', 'room  cancel-pending  organizer'],
    ['Location Status Organizer', 'room Cancelled organizer'],
    ['Location Organizer', 'room  Cancelled'],
  ]) assert.equal(D.calendarEvents(table(columns, tail, subject)).length, 1, tail);
});

const snapshotRows = () => ({ day: D.dayKey(START), login: { ok: true, uid: 'fixture' }, meetings: [
  { sourceId: 'meeting:keep', subject: '正常会议', start: START, end: START + 3600000 },
  { sourceId: 'meeting:cancel', subject: '撤销会议', start: START, end: START + 3600000, cancelled: true },
], calendar: [
  { sourceId: 'cal:cancel', subject: '撤销日程', start: START, end: START + 3600000, status: 'Cancelled' },
  { sourceId: 'cal:unknown', subject: '撤销待核对', start: null, isCanceled: true },
], messages: {}, mails: [] });

test('快照消费：出处、今日会、未知时间、合并显示与模型材料都排除取消项', () => {
  const snap = snapshotRows();
  assert.deepEqual([...D.sourceIndex(snap).keys()], ['meeting:keep']);
  assert.deepEqual(D.todaysMeetings(snap, snap.day).map(m => m.sourceId), ['meeting:keep']);
  assert.deepEqual(D.unresolvedMeetings(snap), []);
  assert.deepEqual(D.mergeMeetings([...snap.meetings, ...snap.calendar]).map(m => m.sourceId), ['meeting:keep']);
  const display = CompanyAssistant.prototype.agentSnapshot.call({}, snap);
  assert.equal(display.meetings.length, 1);
  assert.deepEqual(display.calendar, []);
  assert.equal(snap.meetings.length, 2, '只读过滤不修改原快照');
  const brief = B.fallbackBrief(snap, { day: snap.day, now: START - 600000 });
  assert.deepEqual(brief.sections.find(s => s.key === 'meetings').items.map(m => m.source), ['meeting:keep']);
});

test('提醒：取消会议不触发会前通知或日程冲突，正常会议仍通知，下班总结不计取消项', () => {
  const snap = snapshotRows(), settings = { workdays: [0, 1, 2, 3, 4, 5, 6] };
  const due = R.dueNotices({ snapshot: snap, now: START - 600000, settings });
  assert.deepEqual(due.filter(n => n.kind === 'meeting-prep').map(n => n.detail.source), ['meeting:keep']);
  assert.equal(due.some(n => n.kind === 'overbooked'), false);
  const summary = R.dueNotices({ snapshot: snap, now: START + 10 * 3600000, settings }).find(n => n.kind === 'day-summary');
  assert.match(summary.text, /今天 1 条会议\/日程记录/);
});

test('查询入口：新查询和已有查询缓存的分页、单条读取都不暴露取消项', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancelled-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snap = snapshotRows();
  const a = { dir, now: () => START, snapshot: () => snap, collectQuery: async () => snap };
  const query = new AssistantQuery(a);
  const page = await query.execute({ kind: 'meetings' });
  assert.deepEqual(page.items.map(m => m.sourceId), ['meeting:keep']);
  assert.equal(page.counts.meetings, 1);
  assert.equal(page.counts.calendar, 0);
  const cached = JSON.parse(fs.readFileSync(query.file(page.queryId), 'utf8'));
  cached.items = [...snap.meetings, ...snap.calendar];
  query.save(cached);
  const next = await query.execute({ cursor: page.queryId + ':0' });
  assert.deepEqual(next.items.map(m => m.sourceId), ['meeting:keep']);
  assert.equal(next.counts.calendar, 0);
  await assert.rejects(query.execute({ op: 'read', queryId: page.queryId, sourceId: 'cal:cancel' }), /出处不存在/);
  await assert.rejects(query.execute({ op: 'read', sourceId: 'meeting:cancel' }), /出处不存在/);
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
