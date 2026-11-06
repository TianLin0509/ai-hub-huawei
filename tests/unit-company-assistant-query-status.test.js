'use strict';
// 合成 CLI 响应验证取数边界与 UI 状态；以下表格全部为合成样本，未用真实表格行验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../core/company-assistant/queries');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const W = require('../core/company-assistant/welink');
const { runReadOnly } = require('../core/company-assistant/welink-ro');
const { CompanyAssistant, changedConversationIds, conversationOrderChanges, MESSAGE_REFRESH_MAX_MS, MESSAGE_ROTATION_LIMIT, MESSAGE_FULL_CHECK_MS } = require('../core/company-assistant/service');
const { messageCoverage, queryStatus, queryRows, refreshNotice } = require('../renderer/company-assistant-query-status');
const { WelinkGate, WELINK_INTERVAL_MS, WELINK_COOLDOWN_MS, WELINK_RATE_LIMITED, MESSAGE_ROUND_EXPIRED } = require('../core/company-assistant/welink-gate');
const { POLL_MS } = require('../core/company-assistant/phone');
const { collectBundle } = require('../core/hub-feedback');
const { recordMessageRound, MESSAGE_ROUND_LOG_MAX_BYTES } = require('../core/company-assistant/message-round-log');

const NOW = Date.parse('2026-11-02T12:00:00+08:00');
const RANGE = { start: Date.parse('2026-11-02T00:00:00+08:00'), end: Date.parse('2026-11-03T00:00:00+08:00') };
const TABLE = 'Subject Start End Location Status Organizer ItemId\n------- ----- --- -------- ------ --------- ------\nPRIVATE_SUBJECT PRIVATE_ACCOUNT';
const TABLE_UPGRADE = 'welink-cli 返回了无法解析的表格，请升级：npm install -g @welink/welink-cli@latest（1.0.19 已验证正常）';
const reply = stdout => ({ code: 0, stdout, stderr: '' });
const json = value => reply(JSON.stringify(value));

function fixture(t, override = async () => undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-query-status-'));
  t.after(() => { a.welinkGate.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [], sleeps = [], login = { ok: true, uid: 'fixture-owner' };
  let clock = NOW;
  const a = new CompanyAssistant({ dataDir: root, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, noTools: true, bus: { latest: () => [] }, welinkRun: async args => {
    calls.push([...args]);
    const custom = await override(args);
    if (custom !== undefined) return custom;
    const command = args.slice(0, 2).join(' ');
    if (args[0] === '--version') return reply('welink-cli version 1.0.14');
    if (command === 'auth status') return reply('fixture login');
    if (command === 'meeting query-list') return json({ code: 200, data: { total: 0, page: 1, size: 30 } });
    if (command === 'calendar list') return json([]);
    if (command === 'im query-recent-conversation') return json({ code: 0, conversation_info: [] });
    if (command === 'mail list') return json({ code: 0, mails: [] });
    throw new Error('Unexpected fake CLI command: ' + command);
  } });
  a.cli = () => 'fixture-cli';
  a.auth.check = async () => ({ login });
  a.auth.status = () => ({ login });
  a.write('settings.json', { email: 'fixture@example.invalid' });
  const logFile = path.join(root, 'logs', 'company-assistant-query.log');
  return { a, root, calls, sleeps, clock: () => clock, advance: ms => { clock += ms; }, logFile, logs: () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

// Retained fields from the reported type=1 response; identifiers and text are placeholders.
const ESTIMATED_MEETING = {
  meetingId: 'fixture-meeting-id', enMeetingId: 'fixture-en-meeting-id', subject: '占位会议主题', location: '占位会议地点',
  meetingStartTime: '', meetingEndTime: '', estimatedStartTime: 1793847600000, estimatedEndTime: 1793854800000,
  timeZone: '(UTC+08:00)Beijing', timeZoneKey: '',
};

test('upcoming meetings use estimated epoch times despite the unrecognized display timezone', async () => {
  const raw = { code: 200, data: { data: [ESTIMATED_MEETING], total: 1, page: 1, size: 30 } };
  const [meeting] = D.meetings(raw);
  assert.equal(meeting.start, 1793847600000);
  assert.equal(meeting.end, 1793854800000);
  assert.equal(meeting.timeStatus, 'known');
  assert.equal(meeting.timeEvidence.start.sourceTimeZone, 'epoch');
  assert.equal(meeting.timeEvidence.end.sourceTimeZone, 'epoch');
  const result = await Q.collectMeetings(async () => raw, 1793847600000, { type: '1' });
  assert.equal(result.meetings.length, 1);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.reason, 'exhausted');
});

test('actual meeting start and end times still take precedence over estimated times', () => {
  const meetingStartTime = 1793847600000 + 3600000, meetingEndTime = 1793854800000 + 3600000;
  const [meeting] = D.meetings([{ ...ESTIMATED_MEETING, meetingStartTime, meetingEndTime }]);
  assert.equal(meeting.start, meetingStartTime);
  assert.equal(meeting.end, meetingEndTime);
  assert.equal(meeting.timeStatus, 'known');
});

test('calendar table retries the same date/max arguments once with JSON format', async t => {
  const event = { id: 'event-1', subject: 'fixture event', start: '2026-11-02T09:00:00+08:00', end: '2026-11-02T10:00:00+08:00' };
  const { a, calls, logs } = fixture(t, async args => args[0] === 'calendar' ? args.includes('--format') ? json({ events: [event] }) : reply(TABLE) : undefined);
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.status, 'complete');
  assert.equal(snap.calendar.length, 1);
  assert.equal(snap.calendar[0].start, Date.parse(event.start));
  assert.ok(!snap.errors.some(e => e.label === '日程'));
  const calendarCalls = calls.filter(args => args[0] === 'calendar');
  assert.equal(calendarCalls.length, 2);
  assert.deepEqual(calendarCalls[1], [...calendarCalls[0], '--format', 'json']);
  assert.equal(logs().length, 1);
  assert.deepEqual(logs()[0], { at: new Date(NOW + 6000).toISOString(), command: 'calendar list', cliVersion: '1.0.14', keys: [], businessCodes: [],
    tableFormat: { totalRows: 1, parsedRows: 0, invalidRows: 1, separators: ['single-space'], timeFormats: [] } });
});

for (const failure of ['exit', 'throw', 'table']) {
  test(`calendar JSON retry ${failure} preserves safe original coverage and errors`, async t => {
    const { a, calls, logs } = fixture(t, async args => {
      if (args[0] !== 'calendar') return undefined;
      if (!args.includes('--format')) return reply(TABLE);
      if (failure === 'throw') throw new Error('PRIVATE_RETRY_ERROR');
      return failure === 'exit' ? { code: 1, stdout: '', stderr: 'unknown --format PRIVATE_RETRY_ERROR' } : reply(TABLE);
    });
    const snap = await a.collect();
    assert.equal(snap.calendarCoverage.status, 'failed');
    assert.equal(snap.calendarCoverage.reason, 'non-json');
    assert.equal(snap.calendarCoverage.reasonLabel, TABLE_UPGRADE);
    const errors = snap.errors.filter(e => e.label === '日程');
    assert.deepEqual(errors, [{ label: '日程', text: snap.calendarCoverage.reasonLabel }]);
    assert.ok(!JSON.stringify([snap.calendarCoverage, errors, logs()]).includes('PRIVATE_'));
    assert.equal(calls.filter(args => args[0] === 'calendar').length, 2);
    assert.equal(logs().length, 1);
  });
}

test('natural-language meeting query also catches calendar non-JSON failures', async t => {
  const { a } = fixture(t, async args => args[0] === 'calendar' ? reply(TABLE) : undefined);
  const snap = await a.collectQueryUnlocked('meetings', RANGE);
  assert.equal(snap.calendarCoverage.reason, 'non-json');
  assert.deepEqual(snap.errors, [{ label: '日程', text: TABLE_UPGRADE }]);
});

test('verified plain-text empty calendar succeeds without a JSON retry', async t => {
  const { a, calls, logFile } = fixture(t, async args => args[0] === 'calendar' ? reply('No events found.') : undefined);
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.status, 'complete');
  assert.equal(snap.calendar.length, 0);
  assert.equal(calls.filter(args => args[0] === 'calendar').length, 1);
  assert.equal(fs.existsSync(logFile), false);
});

test('calendar cancellation accepts only true and string true, preserving other flags and original anonymous indices', () => {
  const event = { subject: '测试日程', start: '2026-11-02T12:05:00+08:00', end: '2026-11-02T12:35:00+08:00' };
  const flags = [true, 'true', false, 'false', undefined, null, 1, 'TRUE'];
  const events = D.calendarEvents({ events: flags.map(isCancelled => ({ ...event, isCancelled })) });
  assert.deepEqual(events.map(item => item.id), ['2', '3', '4', '5', '6', '7']);
  assert.equal(D.calendarEvents({ events: [event] }).length, 1, 'missing isCancelled means not cancelled');
});

test('calendar coverage counts cancelled rows separately without marking them invalid or time-unknown', async () => {
  const event = { subject: '保留日程', start: '2026-11-02T12:05:00+08:00', end: '2026-11-02T12:35:00+08:00' };
  const raw = { events: [{ isCancelled: true }, { isCancelled: 'true' }, { ...event, itemId: 'keep-false', isCancelled: false }, { ...event, itemId: 'keep-missing' }] };
  const result = await Q.collectCalendar(async () => raw, RANGE);
  assert.equal(result.events.length, 2);
  assert.equal(result.coverage.records, 4);
  assert.equal(result.coverage.cancelled, 2);
  assert.equal(result.coverage.invalid, 0);
  assert.equal(result.coverage.unknownTime, 0);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.reason, 'exhausted');
  assert.equal(result.coverage.reasonLabel, '日程查询完成；已过滤 2 条已取消日程');
});

test('an all-cancelled calendar is an explicit complete filtered result, not an invalid empty calendar', async () => {
  const result = await Q.collectCalendar(async () => ({ events: [{ isCancelled: true }, { isCancelled: 'true' }] }), RANGE);
  assert.deepEqual(result.events, []);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.records, 2);
  assert.equal(result.coverage.cancelled, 2);
  assert.equal(result.coverage.invalid, 0);
  assert.equal(result.coverage.unknownTime, 0);
  assert.match(result.coverage.reasonLabel, /已过滤 2 条已取消日程/);
});

test('cancelled rows never inflate table-invalid counts or hide real pagination warnings', async () => {
  const event = { subject: '保留日程', start: '2026-11-02T12:05:00+08:00', end: '2026-11-02T12:35:00+08:00' };
  const result = await Q.collectCalendar(async () => ({ events: [{ isCancelled: true }, event], tableInvalid: 2, hasMore: true }), RANGE);
  assert.equal(result.events.length, 1);
  assert.equal(result.coverage.records, 4);
  assert.equal(result.coverage.cancelled, 1);
  assert.equal(result.coverage.invalid, 2);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'more-records');
  assert.match(result.coverage.reasonLabel, /接口还有日程/);
  assert.match(result.coverage.reasonLabel, /2 条日程无法解析/);
  assert.match(result.coverage.reasonLabel, /已过滤 1 条已取消日程/);
});

test('a synthetic calendar table without isCancelled keeps its original behavior even when Status says Cancelled', async () => {
  const raw = Q.parseCalendarTable('Subject Start End Location Status Organizer ItemId\n------- ----- --- -------- ------ --------- ------\n测试日程  2026-11-02T12:05:00+08:00  2026-11-02T12:35:00+08:00  room  Cancelled  organizer  test-id');
  const result = await Q.collectCalendar(async () => raw, RANGE);
  assert.equal(result.events.length, 1);
  assert.equal(result.coverage.cancelled, 0);
  assert.equal(result.coverage.invalid, 0);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.coverage.reasonLabel, '日程查询完成');
});

test('cancelled calendar meetings disappear from collected facts, briefs, preparation and overbooking notices', async t => {
  const reminders = require('../core/company-assistant/reminders');
  const active = { itemId: 'keep-id', subject: '保留会议', start: '2026-11-02T12:05:00+08:00', end: '2026-11-02T12:35:00+08:00', isCancelled: false };
  const events = [active,
    { ...active, itemId: 'cancel-bool', subject: '已取消重叠会议', end: '2026-11-02T13:30:00+08:00', isCancelled: true },
    { ...active, itemId: 'cancel-string', subject: '已取消连续会议', start: '2026-11-02T13:30:00+08:00', end: '2026-11-02T15:30:00+08:00', isCancelled: 'true' }];
  const { a } = fixture(t, async args => args[0] === 'calendar' ? json({ events }) : undefined);
  const snapshot = await a.collect();
  assert.deepEqual(snapshot.calendar.map(item => item.subject), ['保留会议']);
  assert.equal(snapshot.calendarCoverage.cancelled, 2);
  assert.equal(snapshot.calendarCoverage.invalid, 0);
  assert.equal(snapshot.errors.some(error => error.label === '日程'), false);
  const day = D.dayKey(NOW), settings = { briefTime: '08:20', prepMinutes: 15 };
  const notices = reminders.dueNotices({ snapshot, settings, now: NOW });
  assert.equal(notices.filter(notice => notice.kind === 'meeting-prep').length, 1);
  assert.ok(notices.some(notice => notice.kind === 'meeting-prep' && notice.title.includes('保留会议')));
  assert.equal(notices.some(notice => notice.kind === 'overbooked'), false);
  assert.equal(reminders.overbooked(D.todaysMeetings(snapshot, day)), null);
  const fallback = B.fallbackBrief(snapshot, { day, now: NOW });
  const prompt = B.briefPrompt(snapshot, { day, now: NOW });
  assert.match(JSON.stringify(fallback), /保留会议/);
  assert.doesNotMatch(JSON.stringify(fallback), /已取消重叠会议|已取消连续会议/);
  assert.doesNotMatch(prompt, /已取消重叠会议|已取消连续会议/);
  assert.deepEqual([...D.sourceIndex(snapshot).values()].filter(item => item.kind === 'calendar').map(item => item.item.subject), ['保留会议']);
  const control = { ...snapshot, calendar: D.calendarEvents({ events: events.map(event => ({ ...event, isCancelled: false })) }) };
  const controlNotices = reminders.dueNotices({ snapshot: control, settings, now: NOW });
  assert.equal(controlNotices.filter(notice => notice.kind === 'meeting-prep').length, 2);
  assert.ok(controlNotices.some(notice => notice.kind === 'overbooked'), 'the cancelled fixtures would otherwise trigger both overlap and a long block');
  const immediate = await a.collectQueryUnlocked('meetings', RANGE);
  assert.deepEqual(immediate.calendar.map(item => item.subject), ['保留会议']);
  assert.equal(immediate.calendarCoverage.cancelled, 2);
});

test('a business failure in calendar JSON remains a query failure', async t => {
  const { a } = fixture(t, async args => args[0] === 'calendar' ? args.includes('--format') ? json({ code: 403, message: 'denied' }) : reply(TABLE) : undefined);
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.reason, 'query-failed');
  assert.match(snap.errors.find(e => e.label === '日程').text, /查询业务码 403：denied/);
});

test('zero-exit Exchange setup text keeps the calendar flag and triggers autodiscover', async t => {
  const setup = 'Exchange server domain not found, run mail autodiscover';
  const { a, calls } = fixture(t, async args => args[0] === 'calendar' || args[0] === 'mail' && args[1] === 'autodiscover' ? reply(setup) : undefined);
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.reason, 'query-failed');
  assert.equal(snap.calendarNeedsSetup, true);
  assert.ok(snap.errors.some(error => error.label === '日程' && error.calendar === true && error.text === setup));
  assert.equal(calls.filter(args => args[0] === 'calendar').length, 1, 'non-table errors do not use a JSON retry');
  assert.equal(calls.filter(args => args[0] === 'mail' && args[1] === 'autodiscover').length, 1);
});

test('only a complete header followed by a separator qualifies as a calendar table', async () => {
  for (const text of ['Subject Start End ItemId\nnot a separator', 'Subject Start End\n------- ----- ---', 'Subject Start End ItemId']) {
    let calls = 0;
    await assert.rejects(Q.readJson(async () => { calls += 1; return reply(text); }, ['calendar', 'list']), error => error.code !== Q.CALENDAR_NON_JSON && error.message === text);
    assert.equal(calls, 1);
  }
});

test('calendar table classification uses the first output even if the retry is another text error', async () => {
  let calls = 0;
  await assert.rejects(Q.readJson(async () => reply(calls++ === 0 ? TABLE : 'Exchange server domain not found, run mail autodiscover'), ['calendar', 'list']),
    error => error.code === Q.CALENDAR_NON_JSON && error.message === TABLE_UPGRADE);
  assert.equal(calls, 2);
});

test('20 unread mails are a complete short page without a mail error', async t => {
  const { a } = fixture(t, async args => args[0] === 'mail' ? json({ mails: Array.from({ length: 20 }, (_, id) => ({ id, subject: 'fixture mail' })) }) : undefined);
  const snap = await a.collect();
  assert.equal(snap.mails.length, 20);
  assert.equal(snap.mailCoverage.status, 'complete');
  const error = snap.errors.find(e => e.label === '未读邮件');
  assert.equal(error, undefined);
  assert.deepEqual(queryStatus(snap.mailCoverage, error, 20), { label: '已取到 20 条', color: 'ok', detail: '' });
});

test('only a known empty message list is complete', async t => {
  const { a, logFile } = fixture(t);
  const conv = { id: 'fixture-peer', name: '测试同事', group: false };
  const got = await a.conversationHistory(conv, null, NOW - 3600000, 'fixture-owner', '', async () => ({ code: 0, chatInfo: [] }));
  assert.equal(got.coverage.status, 'complete');
  assert.deepEqual(got.messages, []);
  assert.equal(fs.existsSync(logFile), false);
});

test('a success envelope without a verified message list stays invalid-shape and logs metadata', async t => {
  const { a, logs } = fixture(t);
  const raw = { code: 0, data: {}, resultCode: '0' };
  const got = await a.conversationHistory({ id: 'PRIVATE_ACCOUNT', name: 'PRIVATE_NAME', group: false }, null, NOW - 3600000, 'fixture-owner', '', async () => raw);
  assert.equal(got.coverage.status, 'failed');
  assert.equal(got.coverage.reason, 'invalid-shape');
  assert.deepEqual(logs(), [{ at: new Date(NOW).toISOString(), command: 'im query-history-message', cliVersion: '1.0.14', keys: [
    { key: 'code', type: 'number' }, { key: 'data', type: 'object' }, { key: 'resultCode', type: 'string' },
  ], businessCodes: [0, '0'] }]);
});

test('malformed message lists preserve cached records and never become an empty success', async t => {
  const { a, logs } = fixture(t);
  const conv = { id: 'fixture-peer', name: '测试同事', group: false };
  const cached = { version: 3, newest: '1', since: NOW - 3600000, coverage: { status: 'partial' }, messages: [{ key: '1', at: NOW, text: 'PRIVATE_BODY' }] };
  for (const raw of [{ code: 0, chatInfo: null }, { code: 0, chatInfo: 'PRIVATE_BODY' }, { code: 0, chatInfo: [null] }, { code: 0, message: 'PRIVATE_ERROR', data: { unexpected: [] } }]) {
    assert.equal(D.messageRecords(raw), null);
    const got = await a.conversationHistory(conv, cached, NOW - 3600000, 'fixture-owner', '', async () => raw);
    assert.equal(got.coverage.status, 'partial');
    assert.equal(got.coverage.reason, 'invalid-shape');
    assert.equal(got.messages[0].text, 'PRIVATE_BODY');
  }
  assert.equal(logs().length, 4);
  assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
});

test('one failed conversation shows the message row summary instead of its first error', async t => {
  const conversations = ['good', 'bad'].map(id => ({ target_account: id, native_name: '测试同事', group_id: '0' }));
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ code: 0, conversation_info: conversations });
    if (args[1] === 'query-history-message') return args.includes('bad') ? { code: 1, stdout: '', stderr: 'fixture query failed' } : json({ code: 0, chatInfo: [] });
    return undefined;
  });
  const snap = await a.collect();
  assert.equal(snap.scope.partial, 0);
  assert.equal(snap.scope.conversations.find(c => c.id === 'bad').status, 'failed');
  const error = snap.errors.find(e => e.label.startsWith('消息'));
  assert.equal(error.text, 'fixture query failed');
  const row = queryStatus(messageCoverage(snap.scope), error, 0);
  assert.equal(row.label, '下轮更新'); assert.equal(row.color, 'ok');
  assert.match(row.detail, /1 个会话查询失败，下轮重试/); assert.doesNotMatch(row.detail, /fixture query failed/);
});

test('coverage decides row status, with errors used only when coverage is absent or failed', () => {
  const error = { text: 'fixture failure' };
  assert.equal(queryStatus(null, error).label, '查询失败');
  assert.equal(queryStatus({ status: 'failed' }, error).label, '查询失败');
  assert.equal(queryStatus({ status: 'complete' }, error, 2).label, '已取到 2 条');
  assert.equal(queryStatus(null, null).detail, '尚未确认');
  assert.match(messageCoverage({ partial: 2, conversations: [] }).reasonLabel, /2 个会话未取全/);
});

test('refresh notice separates failed queries from incomplete mail and message coverage', () => {
  const data = { meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'failed' }, mailCoverage: { status: 'partial' },
    scope: { partial: 2, conversations: [] }, errors: [{ label: '会议', text: 'old error' }, { label: '日程', text: 'failed' },
      { label: '未读邮件', text: 'preview limit' }, { label: '消息（甲）', text: 'failed' }, { label: '消息（乙）', text: 'failed' }] };
  assert.equal(refreshNotice(data), '有 1 项没取到：日程；有 2 项未取全：消息、未读邮件');
  assert.deepEqual(queryRows(data).map(row => [row.name, row.label]), [['会议', '已取到 0 条'], ['日程', '查询失败'], ['消息', '未取全'], ['未读邮件', '未取全']]);
});

test('refresh notice calls a 20-mail preview incomplete and groups conversation-directory errors', () => {
  assert.equal(refreshNotice({ mailCoverage: { status: 'partial' }, errors: [{ label: '未读邮件', text: 'preview limit' }] }), '有 1 项未取全：未读邮件');
  assert.equal(refreshNotice({ scope: { stale: true, partial: 1 }, errors: [{ label: '最近会话', text: 'failed' }] }), '有 1 项未取全：消息');
  assert.equal(refreshNotice({ errors: [{ label: '日程', text: 'legacy failure' }, { label: 'WeLink', text: 'login failed' }] }), '有 2 项没取到：日程、WeLink');
  assert.equal(refreshNotice({ meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'complete' }, mailCoverage: { status: 'complete' }, scope: { partial: 0 }, errors: [] }), '');
});

test('query diagnostics are collected by feedback and contain no field values or raw output', async t => {
  const { a, root, calls, logs } = fixture(t);
  const raw = { code: 'IM.0000', subject: 'PRIVATE_SUBJECT', content: 'PRIVATE_BODY', account: 'PRIVATE_ACCOUNT', error: { error_code: 0, error_msg: 'PRIVATE_ERROR' },
    data: [{ content: 'PRIVATE_BODY' }], empty: null, count: 2, active: false, 'PRIVATE_ACCOUNT@example.invalid': 'PRIVATE_BODY' };
  await a.diagnoseQuery('im query-history-message', raw);
  await a.diagnoseQuery('calendar list', null);
  assert.equal(calls.filter(args => args[0] === '--version').length, 1, 'version is cached for this CLI');
  assert.deepEqual(logs()[0].businessCodes, ['IM.0000', 0]);
  assert.ok(logs()[0].keys.some(k => k.key === 'data' && k.type === 'array'));
  assert.ok(logs()[0].keys.some(k => k.key === 'empty' && k.type === 'null'));
  const bundle = collectBundle({ logsDir: path.join(root, 'logs') });
  assert.ok(bundle.items.some(item => item.name === '日志 company-assistant-query.log'));
  assert.match(bundle.text, /im query-history-message/);
  assert.ok(!bundle.text.includes('PRIVATE_'));
});

test('version probe failure or unsafe output still produces a structure log', async t => {
  for (const mode of ['throw', 'unsafe']) {
    const { a, logs } = fixture(t, async args => {
      if (args[0] !== '--version') return undefined;
      if (mode === 'throw') throw new Error('PRIVATE_VERSION_ERROR');
      return reply('1.0.14 PRIVATE_ACCOUNT');
    });
    await a.diagnoseQuery('im query-history-message', { code: 0 });
    assert.equal(logs()[0].cliVersion, 'unknown');
    assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
  }
});

test('diagnostics deduplicate matching structure and codes across concurrent calls and service instances', async t => {
  const { a, logs } = fixture(t);
  const other = new CompanyAssistant(a.deps);
  other.cli = a.cli;
  await Promise.all([
    a.diagnoseQuery('im query-history-message', { code: 0, data: {}, message: 'PRIVATE_FIRST' }),
    a.diagnoseQuery('im query-history-message', { message: 'PRIVATE_SECOND', data: { changed: true }, code: 0 }),
    other.diagnoseQuery('im query-history-message', { data: {}, code: 0, message: 'PRIVATE_THIRD' }),
  ]);
  assert.equal(logs().length, 1, 'key order and field values do not produce repeated log lines');
  assert.equal(logs()[0].at, new Date(NOW).toISOString());
  await a.diagnoseQuery('im query-history-message', { code: 200, data: {}, message: 'PRIVATE_OTHER_CODE' });
  await a.diagnoseQuery('im query-history-message', { code: 0, data: [], message: 'PRIVATE_OTHER_TYPE' });
  await a.diagnoseQuery('calendar list', { code: 0, data: {}, message: 'PRIVATE_OTHER_COMMAND' });
  assert.equal(logs().length, 4, 'changed command, key type, or business code still logs');
  assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
});

const mailRows = count => Array.from({ length: count }, (_, id) => ({ id, subject: 'fixture mail ' + id }));

for (const [count, offsets] of [[25, [0]], [100, [0, 100]], [230, [0, 100, 200]]]) {
  test(`${count} unread mails paginate with actual offsets and finish on a short page`, async () => {
    const rows = mailRows(count), calls = [];
    const result = await Q.collectMails(async (label, args) => {
      assert.equal(label, '未读邮件');
      calls.push(args);
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return { code: 0, data: { mails: rows.slice(offset, offset + 100) } };
    });
    assert.deepEqual(calls, offsets.map(offset => ['mail', 'list', '--is-read', '0', '--max', '100', '--offset', String(offset)]));
    assert.equal(result.coverage.status, 'complete');
    assert.equal(result.coverage.reason, 'exhausted');
    assert.equal(result.coverage.reasonLabel, `取到 ${count} 封未读邮件`);
    assert.equal(result.coverage.rawCount, count);
    assert.equal(result.mails.length, count);
    assert.equal(new Set(result.mails.map(mail => mail.id)).size, count);
  });
}

test('500 unread mails stop at the collection cap and explicitly remain partial', async () => {
  const rows = mailRows(650), offsets = [];
  const result = await Q.collectMails(async (label, args) => {
    const offset = Number(args[args.indexOf('--offset') + 1]); offsets.push(offset);
    return { mails: rows.slice(offset, offset + 100) };
  });
  assert.deepEqual(offsets, [0, 100, 200, 300, 400]);
  assert.equal(result.mails.length, 500);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'result-limit');
  assert.match(result.coverage.reasonLabel, /已取 500 封.*500 封取数上限/);
});

test('a CLI ignoring offset stops on the first page with no new mail IDs', async () => {
  let calls = 0;
  const result = await Q.collectMails(async () => { calls += 1; return { mails: mailRows(100) }; });
  assert.equal(calls, 2);
  assert.equal(result.mails.length, 100);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.reason, 'repeated-page');
  assert.match(result.coverage.reasonLabel, /重复返回/);
});

test('overlapping pages deduplicate IDs while offsets advance by raw row count', async () => {
  const rows = mailRows(192), offsets = [];
  const result = await Q.collectMails(async (label, args) => {
    const offset = Number(args[args.indexOf('--offset') + 1]); offsets.push(offset);
    return { mails: offset === 0 ? rows.slice(0, 100) : offset === 100 ? rows.slice(90, 190) : rows.slice(189) };
  });
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(result.coverage.rawCount, 203);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.mails.length, 192);
  assert.deepEqual(result.mails.map(mail => mail.id), rows.map(row => String(row.id)));
});

for (const failedOffset of [0, 100]) {
  test(`mail failure at offset ${failedOffset} keeps fetched rows and does not duplicate runJson errors`, async t => {
    const { a, calls } = fixture(t, async args => {
      if (args[0] !== 'mail') return undefined;
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return offset === failedOffset ? { code: 1, stdout: '', stderr: 'fixture mail page failed' } : json({ mails: mailRows(100) });
    });
    const snap = await a.collect();
    assert.equal(snap.mailCoverage.status, failedOffset === 0 ? 'failed' : 'partial');
    assert.equal(snap.mailCoverage.reason, 'query-failed');
    assert.equal(snap.mails.length, failedOffset);
    assert.equal(snap.errors.filter(error => error.label === '未读邮件').length, 1);
    assert.equal(snap.errors.find(error => error.label === '未读邮件').text, 'fixture mail page failed');
    assert.equal(calls.filter(args => args[0] === 'mail').length, failedOffset === 0 ? 1 : 2);
    if (failedOffset) assert.match(snap.mailCoverage.reasonLabel, /已取 100 封；第 2 页查询失败/);
  });
}

for (const invalidOffset of [0, 100]) {
  test(`invalid mail shape at offset ${invalidOffset} keeps prior rows and writes safe diagnostics`, async t => {
    const { a, logs } = fixture(t, async args => {
      if (args[0] !== 'mail') return undefined;
      const offset = Number(args[args.indexOf('--offset') + 1]);
      return json(offset === invalidOffset ? { code: 0, unexpected: { subject: 'PRIVATE_SUBJECT' } } : { mails: mailRows(100) });
    });
    const snap = await a.collect();
    assert.equal(snap.mailCoverage.status, invalidOffset === 0 ? 'failed' : 'partial');
    assert.equal(snap.mailCoverage.reason, 'invalid-shape');
    assert.equal(snap.mails.length, invalidOffset);
    assert.equal(snap.errors.filter(error => error.label === '未读邮件').length, 1);
    assert.equal(logs().length, 1);
    assert.equal(logs()[0].command, 'mail list');
    assert.ok(!JSON.stringify(logs()).includes('PRIVATE_SUBJECT'));
  });
}

test('mail results sort newest first, keep timestamp ties stable, and leave unknown times last in original order', async () => {
  const rows = [{ id: 'missing-a' }, { id: 'older', receivedTime: '2026-11-01T09:00:00+08:00' },
    { id: 'unknown-zone', receivedTime: '2026-11-02T12:00:00' }, { id: 'newer-a', receivedTime: '2026-11-02T11:00:00+08:00' },
    { id: 'missing-b' }, { id: 'newer-b', receivedTime: '2026-11-02T11:00:00+08:00' }, { id: 'epoch', receivedTime: 0 }];
  const result = await Q.collectMails(async () => ({ mails: rows }));
  assert.deepEqual(result.mails.map(mail => mail.id), ['newer-a', 'newer-b', 'older', 'epoch', 'missing-a', 'unknown-zone', 'missing-b']);
  assert.ok(result.mails.slice(-3).every(mail => mail.at === null));
});

test('service saves all 230 paginated mails for briefing instead of only the first 20', async t => {
  const rows = mailRows(230);
  const { a, calls } = fixture(t, async args => {
    if (args[0] !== 'mail') return undefined;
    const offset = Number(args[args.indexOf('--offset') + 1]);
    return json({ mails: rows.slice(offset, offset + 100) });
  });
  const snap = await a.collect();
  assert.equal(snap.mails.length, 230);
  assert.equal(snap.mailCoverage.status, 'complete');
  assert.equal(snap.errors.some(error => error.label === '未读邮件'), false);
  assert.equal(a.snapshot(snap.day).mails.length, 230);
  assert.deepEqual(calls.filter(args => args[0] === 'mail').map(args => args[args.indexOf('--offset') + 1]), ['0', '100', '200']);
});

test('500 mails keep the brief mail preview within budget and the fallback mail section at five entries', async () => {
  const raw = mailRows(500).map((mail, i) => ({ ...mail, subject: '主题 ' + '字'.repeat(100), preview: '摘要'.repeat(100),
    importance: i === 499 ? 'high' : 'normal', receivedTime: NOW - i * 1000 }));
  const result = await Q.collectMails(async (label, args) => {
    const offset = Number(args[args.indexOf('--offset') + 1]);
    return { mails: raw.slice(offset, offset + 100) };
  });
  const snapshot = { meetings: [], calendar: [], conversations: [], messages: {}, mails: result.mails, errors: [] };
  const prompt = B.briefPrompt(snapshot, { day: D.dayKey(NOW), now: NOW });
  const lines = prompt.split('\n').filter(line => /^\[mail:/.test(line));
  assert.ok(lines.length > 0 && lines.length < 500);
  assert.ok(lines.reduce((length, line) => length + line.length + 1, 0) <= 1000);
  assert.match(prompt, new RegExp(`邮件省略 ${500 - lines.length} 条`));
  const brief = B.fallbackBrief(snapshot, { day: D.dayKey(NOW), now: NOW });
  const mails = brief.sections.find(section => section.key === 'mail').items;
  assert.equal(mails.length, 5);
  assert.equal(mails[0].source, 'mail:499', 'important mail from later pages is eligible for the brief');
  assert.ok(brief.sections.flatMap(section => section.items).filter(item => item.top).length <= B.FIRST_SCREEN);
});

function gatedJson(run, args) {
  let clock = NOW;
  const gate = new WelinkGate({ now: () => clock, sleep: async ms => { clock += ms; } });
  return Q.readJson(a => gate.run(a, () => run(a)), args).finally(() => gate.flush());
}
const rateReply = (code = 1) => ({ code, stdout: '', stderr: 'Error: Query message history failed (status 429)' });
const historyArgs = ['im', 'query-history-message', '--user-account', 'fixture-peer', '--query-count', '100'];
const conversationRows = ids => ids.map(id => ({ target_account: id, native_name: '同事' + id, group_id: '0' }));
const historyRows = (id, count = 1) => Array.from({ length: count }, (_, i) => ({ msgId: String(100 + i), sender: id, content: 'fixture message ' + i, serverSendTime: NOW - 60000 }));

for (const result of [rateReply(), { code: 1, stdout: rateReply().stderr, stderr: '' }, { code: 429, stdout: '', stderr: '' }, { code: '429', stdout: '', stderr: '' }]) {
  test(`history rate limit exit ${result.code} stdout=${!!result.stdout} stderr=${!!result.stderr} never retries format`, async () => {
    const calls = [];
    await assert.rejects(gatedJson(async args => { calls.push(args); return result; }, historyArgs), error => error.code === WELINK_RATE_LIMITED);
    assert.deepEqual(calls, [historyArgs, historyArgs, historyArgs]);
  });
}

test('rate limiting an existing format retry uses only its two gate retries', async () => {
  const calls = [];
  await assert.rejects(gatedJson(async args => { calls.push(args); return calls.length === 1 ? reply('fixture non-json') : rateReply(); }, historyArgs), error => error.code === WELINK_RATE_LIMITED);
  assert.deepEqual(calls, [historyArgs, ...Array(3).fill([...historyArgs, '--format', 'json'])]);
});

test('the unified rate-limit code applies to calendar, meetings, and mail commands', async () => {
  for (const args of [['calendar', 'list'], ['meeting', 'query-list'], ['mail', 'list']]) {
    await assert.rejects(gatedJson(async () => rateReply(), args), error => error.code === WELINK_RATE_LIMITED);
  }
});

test('a history page rate limit preserves messages fetched earlier in the same conversation', async t => {
  const { a } = fixture(t);
  let calls = 0;
  const got = await a.conversationHistory({ id: 'peer', name: '同事', group: false }, null, NOW - 3600000, 'fixture-owner', '',
    (label, args) => gatedJson(async () => ++calls === 1 ? json({ chatInfo: historyRows('peer', 100) }) : rateReply(), args));
  assert.equal(calls, 4);
  assert.equal(got.messages.length, 100);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'rate-limited');
  assert.equal(got.coverage.pages, 2);
  assert.equal(got.cache.messages.length, 100);
});

for (const version of [undefined, 2, 3]) {
  test(`old message-cache version ${version ?? 'unversioned'} remains readable when deferred storage upgrades to v4`, async t => {
    const { a, calls } = fixture(t, async args => {
      if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a']) });
      if (args[1] === 'query-history-message') return json({ chatInfo: [] });
      return undefined;
    });
    const messages = D.messages({ chatInfo: historyRows('a') }, { id: 'a', name: '同事a', group: false }, 'fixture-owner');
    const conversations = { a: { version: version === undefined ? 2 : 3, newest: '100', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages } };
    a.write(`raw-${D.dayKey(NOW)}.json`, { login: { uid: 'fixture-owner' } });
    a.write('message-cache.json', version === undefined ? conversations : { version, identity: 'fixture-owner', conversations });
    const snap = await a.collect();
    assert.equal(snap.messages.a[0].text, 'fixture message 0');
    assert.equal(a.read('message-cache.json').version, 4);
    assert.deepEqual(a.read('message-cache.json').deferred, []);
    assert.equal(snap.scope.migrated, true);
    assert.equal(calls.find(args => args[1] === 'query-history-message').includes('--message-id'), version !== undefined);
    if (version === undefined) assert.equal(snap.messages.a[0].contentComplete, false);
  });
}

test('deferred queues and messages from another account are never reused', async t => {
  const order = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a', 'b']) });
    if (args[1] === 'query-history-message') { order.push(args[args.indexOf('--user-account') + 1]); return json({ chatInfo: [] }); }
    return undefined;
  });
  a.write('message-cache.json', { version: 4, identity: 'other-owner', deferred: ['b'], conversations: { b: { version: 3, messages: [{ key: '100', at: NOW, text: 'PRIVATE_OTHER_ACCOUNT' }] } } });
  const snap = await a.collect();
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(snap.messages, {});
  assert.ok(!JSON.stringify(a.read('message-cache.json')).includes('PRIVATE_OTHER_ACCOUNT'));
});

test('a directory failure clears last-round rate-limit and rotation flags without losing the deferred cache', async t => {
  let round = 1;
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return round === 1 ? json({ conversation_info: conversationRows(['a', 'b']) }) : { code: 1, stdout: '', stderr: 'fixture directory failed' };
    if (args[1] === 'query-history-message') return rateReply();
    return undefined;
  });
  await a.collect();
  const cached = a.read('message-cache.json');
  round = 2;
  const snap = await a.collect();
  assert.equal(snap.scope.rateLimited, false);
  assert.equal(snap.scope.rotating, false);
  assert.equal(snap.scope.stale, true);
  assert.ok(!messageCoverage(snap.scope).reasonLabel.includes('WeLink 限流'));
  assert.deepEqual(a.read('message-cache.json'), cached);
});

test('verified respData zero-total incremental empty pages stay complete across consecutive rounds without losing cache', async t => {
  const empty = { resultCode: '0', resultContext: '', sno: null, respData: { maxMsgId: 0, minMsgId: 0, msgTotalCount: 0 } };
  const { a, calls, logFile } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a']) });
    if (args[1] === 'query-history-message') return json(empty);
    return undefined;
  });
  const messages = D.messages({ chatInfo: historyRows('a').map(m => ({ ...m, msgId: '12345678901234567' })) }, { id: 'a', name: '同事a', group: false }, 'fixture-owner');
  a.write('message-cache.json', { version: 3, identity: 'fixture-owner', conversations: { a: { version: 3, newest: '12345678901234567', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages } } });
  assert.deepEqual(D.messageRecords(empty), []);
  assert.deepEqual(D.messageRecords({ ...empty, resultCode: 0 }), []);
  for (let round = 0; round < 2; round += 1) {
    const snap = await a.collect();
    assert.equal(snap.scope.conversations[0].status, 'complete');
    assert.equal(snap.scope.conversations[0].reason, 'exhausted');
    assert.equal(snap.messages.a[0].key, '12345678901234567');
    assert.equal(snap.errors.length, 0);
  }
  for (const args of calls.filter(args => args[1] === 'query-history-message')) {
    assert.equal(args[args.indexOf('--query-direction') + 1], '1');
    assert.equal(args[args.indexOf('--message-id') + 1], '12345678901234567');
  }
  assert.equal(fs.existsSync(logFile), false);
});

test('unverified respData envelopes remain invalid-shape and diagnostics expose only numeric msgTotalCount', async t => {
  const { a, logs } = fixture(t);
  const valid = { resultCode: '0', respData: { maxMsgId: 0, minMsgId: 0, msgTotalCount: 0 } };
  const invalid = [
    { ...valid, respData: { ...valid.respData, chatInfo: null } },
    { ...valid, respData: { ...valid.respData, chatInfo: {} } },
    { ...valid, respData: { ...valid.respData, msgTotalCount: 1 } },
    { ...valid, respData: { ...valid.respData, msgTotalCount: '0' } },
    { ...valid, respData: { ...valid.respData, maxMsgId: 1 } },
    { ...valid, respData: { ...valid.respData, maxMsgId: '0' } },
    { ...valid, respData: { minMsgId: 0, msgTotalCount: 0 } },
    { ...valid, respData: { maxMsgId: 0, minMsgId: 0 } },
    { resultCode: '0' }, { ...valid, resultCode: '1' },
  ];
  for (const raw of invalid) {
    assert.equal(D.messageRecords(raw), null);
    const got = await a.conversationHistory({ id: 'a', name: '同事a', group: false }, null, NOW - 3600000, 'fixture-owner', '', async () => raw);
    assert.equal(got.coverage.reason, 'invalid-shape');
  }
  assert.ok(logs().some(entry => entry.msgTotalCount === 0));
  assert.ok(logs().every(entry => entry.msgTotalCount === undefined || typeof entry.msgTotalCount === 'number'));
  const other = fixture(t);
  await other.a.diagnoseQuery('im query-history-message', { resultCode: '0', respData: { msgTotalCount: 7, subject: 'PRIVATE_SUBJECT' } });
  assert.equal(other.logs()[0].msgTotalCount, 7);
  assert.ok(!JSON.stringify(other.logs()).includes('PRIVATE_SUBJECT'));
});

test('real mail field casing uses dateTimeReceived and itemId across pages without ID collisions', async t => {
  const rows = Array.from({ length: 125 }, (_, i) => ({ itemId: 'fixture-item-' + i, subject: '脱敏主题', from: '测试发件人', fromEmail: 'sender@example.invalid', importance: 'Normal',
    dateTimeReceived: i === 0 ? '2026-08-22T17:32:26+08:00' : new Date(Date.parse('2026-08-22T17:32:26+08:00') + i * 60000).toISOString() }));
  const { a, calls } = fixture(t, async args => {
    if (args[0] !== 'mail') return undefined;
    const offset = Number(args[args.indexOf('--offset') + 1]);
    return json({ mails: rows.slice(offset, offset + 100) });
  });
  const snap = await a.collect();
  assert.equal(snap.mailCoverage.status, 'complete');
  assert.equal(snap.mails.length, 125);
  assert.equal(new Set(snap.mails.map(m => m.id)).size, 125);
  assert.deepEqual(snap.mails.map(m => m.id), [...rows].reverse().map(m => m.itemId));
  assert.equal(snap.mails[124].at, Date.parse('2026-08-22T17:32:26+08:00'));
  assert.equal(snap.mails[0].at, Date.parse(rows[124].dateTimeReceived));
  assert.deepEqual(calls.filter(args => args[0] === 'mail').map(args => args[args.indexOf('--offset') + 1]), ['0', '100']);
});

test('background auth replays count as actual requests and obey the same interval', async t => {
  const starts = [];
  const { a, clock, sleeps } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a']) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock());
    return starts.length === 1 ? { code: 1, stdout: '', stderr: 'token expired' } : json({ chatInfo: [] });
  });
  const snap = await a.collect();
  assert.equal(starts[1] - starts[0], WELINK_INTERVAL_MS);
  assert.ok(sleeps.every(ms => ms === WELINK_INTERVAL_MS));
  assert.equal(snap.scope.requests, 2);
  assert.equal(snap.scope.completed, 1);
});

test('expanding the history window drops a saved continuation cursor and performs a full query', async t => {
  const { a } = fixture(t);
  const cached = { version: 3, newest: '200', since: NOW - 3600000, messages: [], coverage: { status: 'rotating' },
    resume: { cursor: '100', incremental: false, since: NOW - 3600000 } };
  const calls = [];
  const got = await a.conversationHistory({ id: 'a', name: '同事a', group: false }, cached, NOW - 2 * 3600000, 'fixture-owner', '', async (label, args) => { calls.push(args); return { chatInfo: [] }; });
  assert.equal(calls[0].includes('--message-id'), false);
  assert.equal(got.coverage.status, 'complete');
  assert.equal(got.cache.resume, undefined);
});

test('historical conversations are retained without queries or deferred work', async t => {
  const recent = Array.from({ length: 6 }, (_, i) => 'recent-' + i), historical = Array.from({ length: 5 }, (_, i) => 'historical-' + i);
  const deferred = [historical[3], historical[1], historical[4], historical[0], historical[2]], order = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(recent) });
    if (args[1] === 'query-history-message') { order.push(args[args.indexOf('--user-account') + 1]); return json({ chatInfo: [] }); }
    return undefined;
  });
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: historical.map(id => ({ id, name: '历史同事' + id, group: false, seenAt: NOW - 86400000 })) });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', conversations: {}, deferred });
  const snap = await a.collect();
  assert.deepEqual(order, recent);
  assert.equal(snap.scope.requests, 6); assert.equal(snap.scope.retained, 5);
  assert.deepEqual(a.read('message-cache.json').deferred, []);
});

// 仅表头来自已知现象；下面所有数据行均为合成样本，不代表真机列格式。
const calendarTable = rows => ['Subject Start End Location Status Organizer ItemId', '------- ----- --- -------- ------ --------- ------', ...rows].join('\n');
function calendarTableFixture(t, text, failure = 'exit') {
  return fixture(t, async args => {
    if (args[0] !== 'calendar') return undefined;
    if (!args.includes('--format')) return reply(text);
    if (failure === 'throw') throw new Error('PRIVATE_RETRY_ERROR');
    if (failure === 'text') return reply('Exchange server domain not found, run mail autodiscover');
    return { code: 1, stdout: '', stderr: 'The following argument was not expected: --format' };
  });
}

test('synthetic multi-space table uses the last two timestamps and preserves a dated Chinese subject without relying on widths', () => {
  const parsed = Q.parseCalendarTable(calendarTable(['  2026-10-01 计划与中文标题  2026-11-02 09:00:00.123+08:00  2026-11-02T10:30:00+08:00  会议室 A  Busy  测试组织者  fixture-id  ']));
  assert.deepEqual(parsed.events, [{ subject: '2026-10-01 计划与中文标题', start: '2026-11-02 09:00:00.123+08:00', end: '2026-11-02T10:30:00+08:00', location: '会议室 A', itemId: 'fixture-id' }]);
  assert.equal(parsed.tableInvalid, 0);
  assert.deepEqual(parsed.tableFormat, { totalRows: 1, parsedRows: 1, invalidRows: 0, separators: ['multi-space'], timeFormats: [
    '####-##-##', '####-##-## ##:##:##.###+##:##', '####-##-##T##:##:##+##:##',
  ] });
});

test('synthetic single-space table keeps the Chinese subject but leaves ambiguous location blank', () => {
  const parsed = Q.parseCalendarTable(calendarTable(['中文 主题 2026-11-02T09:00+08:00 2026-11-02T10:00+08:00 会议室 Busy 组织者 fixture-id']));
  assert.deepEqual(parsed.events, [{ subject: '中文 主题', start: '2026-11-02T09:00+08:00', end: '2026-11-02T10:00+08:00', location: '', itemId: 'fixture-id' }]);
  assert.deepEqual(parsed.tableFormat.separators, ['single-space']);
});

for (const failure of ['exit', 'throw', 'text']) {
  test(`synthetic first calendar table parses after JSON retry ${failure} and stays complete without an error`, async t => {
    const text = calendarTable(['测试日程  2026-11-02T09:00:00+08:00  2026-11-02T10:00:00+08:00  会议室  Busy  测试组织者  fixture-id']);
    const { a, calls } = calendarTableFixture(t, text, failure);
    const snap = await a.collect();
    assert.equal(snap.calendarCoverage.status, 'complete');
    assert.equal(snap.calendarCoverage.records, 1);
    assert.equal(snap.calendarCoverage.invalid, 0);
    assert.equal(snap.calendar[0].sourceBaseId, 'cal:fixture-id');
    assert.equal(snap.calendar[0].subject, '测试日程');
    assert.equal(snap.calendar[0].start, Date.parse('2026-11-02T09:00:00+08:00'));
    assert.equal(snap.calendar[0].location, '会议室');
    assert.ok(!snap.errors.some(e => e.label === '日程'));
    const calendarCalls = calls.filter(args => args[0] === 'calendar');
    assert.equal(calendarCalls.length, 2);
    assert.deepEqual(calendarCalls[1], [...calendarCalls[0], '--format', 'json']);
    assert.ok(!calls.some(args => args[0] === 'mail' && args[1] === 'autodiscover'), 'retry setup text cannot replace the original table');
  });
}

test('synthetic Z timestamps flow through D.calendarEvents and the same parser also works for immediate queries', async t => {
  const text = calendarTable(['UTC日程  2026-11-02T01:00:00Z  2026-11-02T02:00:00Z  room  Busy  organizer  utc-id']);
  const { a } = calendarTableFixture(t, text);
  const snap = await a.collectQueryUnlocked('meetings', RANGE);
  assert.equal(snap.calendarCoverage.status, 'complete');
  assert.equal(snap.calendar[0].start, Date.parse('2026-11-02T09:00:00+08:00'));
  assert.equal(snap.calendar[0].timeEvidence.start.sourceTimeZone, 'Z');
  assert.ok(!snap.errors.some(e => e.label === '日程'));
});

test('synthetic timestamps without a timezone stay visible with unknown time and partial coverage', async t => {
  const text = calendarTable(['时区未知  2026-11-02 09:00:00  2026-11-02 10:00:00  room  Busy  organizer  unknown-zone-id']);
  const { a } = calendarTableFixture(t, text);
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.status, 'partial');
  assert.equal(snap.calendarCoverage.unknownTime, 1);
  assert.equal(snap.calendarCoverage.reasonLabel, '1 条日程时间待核对');
  assert.equal(snap.calendar.length, 1, 'eventInRange must not silently discard the unknown-time record');
  assert.equal(snap.calendar[0].start, null);
  assert.equal(snap.calendar[0].end, null);
  assert.equal(snap.calendar[0].timeEvidence.start.reason, 'missing-time-zone');
});

for (const end of ['2026-11-02', '2026-11-03']) {
  test(`synthetic all-day dates ending ${end} preserve calendar dates without inventing a timezone`, async t => {
    const { a } = calendarTableFixture(t, calendarTable([`全天日程  2026-11-02  ${end}  room  Busy  organizer  all-day-id`]));
    const snap = await a.collect();
    assert.equal(snap.calendar.length, 1);
    assert.equal(snap.calendar[0].allDay, true);
    assert.equal(snap.calendar[0].timeStatus, 'date-only');
    assert.equal(snap.calendar[0].startDate, '2026-11-02');
    assert.equal(snap.calendar[0].start, null);
    assert.equal(snap.calendar[0].displayTimeZone, null);
    assert.equal(snap.calendarCoverage.status, end === '2026-11-02' ? 'complete' : 'partial');
    if (end !== '2026-11-02') assert.equal(snap.calendarCoverage.reasonLabel, '1 条日程时间待核对');
  });
}

for (const id of ['fixture-id...', 'fixture-id…']) {
  test(`synthetic truncated ItemId ${id} uses existing anonymous hashes instead of a stable ID`, async t => {
    const row = `截断编号  2026-11-02T09:00+08:00  2026-11-02T10:00+08:00  room  Busy  organizer  ${id}`;
    const parsed = Q.parseCalendarTable(calendarTable([row, row]));
    assert.equal(parsed.events[0].itemId, '');
    const { a } = calendarTableFixture(t, calendarTable([row, row]));
    const snap = await a.collect();
    assert.equal(snap.calendarCoverage.status, 'complete');
    assert.equal(snap.calendar.length, 2);
    assert.ok(snap.calendar.every(e => e.sourceBaseId.startsWith('cal:anon:')));
    assert.notEqual(snap.calendar[0].sourceBaseId, snap.calendar[1].sourceBaseId);
  });
}

test('synthetic folded lines count as invalid records while parsed unknown-time records remain visible', async t => {
  const rows = ['可读但时区待核对  2026-11-02T09:00  2026-11-02T10:00  room  Busy  organizer  id', '折行标题', '2026-11-02T11:00+08:00 room Busy organizer wrapped-id'];
  const { a, logs } = calendarTableFixture(t, calendarTable(rows));
  const snap = await a.collect();
  assert.equal(snap.calendar.length, 1);
  assert.equal(snap.calendarCoverage.status, 'partial');
  assert.equal(snap.calendarCoverage.records, 3);
  assert.equal(snap.calendarCoverage.invalid, 2);
  assert.equal(snap.calendarCoverage.unknownTime, 1);
  assert.equal(snap.calendarCoverage.reasonLabel, '2 条日程无法解析；1 条日程时间待核对');
  assert.deepEqual(logs()[0].tableFormat, { totalRows: 3, parsedRows: 1, invalidRows: 2, separators: ['multi-space', 'single-space'], timeFormats: ['####-##-##T##:##', '####-##-##T##:##+##:##'] });
});

test('synthetic entirely unreadable tables fail with the exact upgrade instruction and invalid row counts', async t => {
  const { a } = calendarTableFixture(t, calendarTable(['无法解析行一', '无法解析行二']));
  const snap = await a.collect();
  assert.equal(snap.calendarCoverage.status, 'failed');
  assert.equal(snap.calendarCoverage.reasonLabel, TABLE_UPGRADE);
  assert.equal(snap.calendarCoverage.records, 2);
  assert.equal(snap.calendarCoverage.invalid, 2);
  assert.equal(snap.calendar.length, 0);
});

test('calendar table format diagnostics contain counts, separator kinds and masked timestamps without private values', async t => {
  const text = calendarTable([
    'PRIVATE_TITLE  2026-11-02T09:00:00+08:00  2026-11-02T10:00:00+08:00  PRIVATE_ROOM  Busy  PRIVATE_PERSON  PRIVATE_ITEMID',
    'PRIVATE_TITLE 2026-11-02T01:00Z 2026-11-02T02:00Z PRIVATE_ROOM Busy PRIVATE_PERSON PRIVATE_ITEMID',
    'PRIVATE_TITLE 2026-11-02 2026-11-02 PRIVATE_ROOM | Busy | PRIVATE_PERSON PRIVATE_ITEMID',
  ]);
  const { a, logs, root } = calendarTableFixture(t, text);
  await a.collect();
  assert.deepEqual(logs()[0].tableFormat, { totalRows: 3, parsedRows: 3, invalidRows: 0, separators: ['multi-space', 'pipe', 'single-space'], timeFormats: ['####-##-##', '####-##-##T##:##:##+##:##', '####-##-##T##:##Z'] });
  const bundle = collectBundle({ logsDir: path.join(root, 'logs') });
  assert.match(bundle.text, /tableFormat/);
  assert.ok(!bundle.text.includes('PRIVATE_'));
  assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(logs()[0].tableFormat).includes('2026-11-02'));
});

test('table-format logging rejects extra fields, private strings and unmasked times', async t => {
  const { a, logs } = fixture(t);
  await a.diagnoseQuery('calendar list', null, { tableFormat: { totalRows: 1, parsedRows: 1, invalidRows: 0, subject: 'PRIVATE_TITLE', location: 'PRIVATE_ROOM',
    separators: ['pipe', 'PRIVATE_PERSON'], timeFormats: ['####-##-##T##:##Z', '2026-11-02T01:00Z', 'PRIVATE_ITEMID'] } });
  assert.deepEqual(logs()[0].tableFormat, { totalRows: 1, parsedRows: 1, invalidRows: 0, separators: ['pipe'], timeFormats: ['####-##-##T##:##Z'] });
  assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
});

test('diagnostics deduplicate the same table format but retain a different masked format', async t => {
  const { a, logs } = fixture(t);
  for (const [title, zone] of [['PRIVATE_A', '+08:00'], ['PRIVATE_B', '+08:00'], ['PRIVATE_C', 'Z']]) {
    const text = calendarTable([`${title} 2026-11-02T09:00${zone} 2026-11-02T10:00${zone} room Busy organizer id`]);
    await Q.readJson(async args => args.includes('--format') ? { code: 1, stdout: '', stderr: 'not expected' } : reply(text), ['calendar', 'list'],
      { diagnose: (command, raw, metadata) => a.diagnoseQuery(command, raw, metadata) });
  }
  assert.equal(logs().length, 2);
  assert.ok(!JSON.stringify(logs()).includes('PRIVATE_'));
});

test('the pure calendar table parser rejects Exchange setup text and unverified headers', () => {
  assert.equal(Q.parseCalendarTable('Exchange server domain not found, run mail autodiscover'), null);
  assert.equal(Q.parseCalendarTable('Subject Start End ItemId\nnot a separator\ninvalid row'), null);
});

test('verified --version is accepted as one read-only argument and cannot open other commands', async () => {
  assert.deepEqual(W.checkArgs(['--version']), ['--version']);
  const calls = [];
  const result = await runReadOnly(['--version'], { cli: 'fixture-cli', run: async (args, options) => { calls.push({ args, allowSetup: options.allowSetup }); return reply('1.0.19'); } });
  assert.equal(result.stdout, '1.0.19');
  assert.deepEqual(calls, [{ args: ['--version'], allowSetup: false }]);
  for (const args of [['--version', 'mail', 'send'], ['--version', '--help'], ['--version', ''], ['--version', '--version'], ['im', 'send'], ['mail', 'send'], ['auth', 'login']]) {
    await assert.rejects(runReadOnly(args, { cli: 'fixture-cli', run: async () => { throw new Error('must not run'); } }), error => error.code === 'WELINK_NOT_ALLOWED');
  }
});

test('diagnostic version probing uses verified --version and accepts bare semver strictly', async t => {
  const { a, calls, logs } = fixture(t, async args => args[0] === '--version' ? reply('1.0.19') : undefined);
  await a.diagnoseQuery('calendar list', null);
  await a.diagnoseQuery('mail list', { code: 0 });
  assert.equal(logs()[0].cliVersion, '1.0.19');
  assert.deepEqual(calls.filter(args => args[0] === '--version'), [['--version']]);
  assert.ok(!calls.some(args => args[0] === 'version'));
});

for (const [name, previous, current, expected] of [
  ['unchanged', ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], ['a']],
  ['middle moved to front', ['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd'], ['c', 'a']],
  ['multiple moved upward', ['a', 'b', 'c', 'd'], ['d', 'b', 'a', 'c'], ['d', 'b', 'a']],
  ['new at front', ['a', 'b', 'c'], ['x', 'a', 'b', 'c'], ['x', 'a']],
  ['new at tail', ['a', 'b', 'c'], ['a', 'b', 'c', 'x'], ['x']],
  ['conversation dropped', ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], ['a']],
  ['first dropped', ['a', 'b', 'c'], ['b', 'c'], ['b']],
  ['reversed', ['a', 'b', 'c'], ['c', 'b', 'a'], ['c', 'b', 'a']],
  ['empty current', ['a'], [], []],
  ['empty previous', [], ['a', 'b'], ['a', 'b']],
]) {
  test(`changed conversation order: ${name}`, () => {
    const before = [...previous], after = [...current];
    assert.deepEqual(changedConversationIds(previous, current), expected);
    assert.deepEqual(previous, before); assert.deepEqual(current, after);
  });
}

function orderFixture(t, ids) {
  let directory = [...ids];
  const order = [];
  const result = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(directory) });
    if (args[1] === 'query-history-message') { order.push(args[args.indexOf('--user-account') + 1]); return json({ chatInfo: [] }); }
    return undefined;
  });
  return { ...result, order, setDirectory: ids => { directory = [...ids]; } };
}

test('unchanged incremental directory queries three ordinary heads plus five deferred rotation conversations', async t => {
  const ids = Array.from({ length: 30 }, (_, i) => 'peer-' + i);
  const { a, order, sleeps } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, lastFullCheckAt: NOW - 60000, conversations: Object.fromEntries(ids.map(id => [id, { version: 3, hasFetched: true, coverage: { status: 'complete' }, messages: [] }])), deferred: [...ids.slice(10), ...ids.slice(0, 10)] });
  const snap = await a.collect();
  assert.deepEqual(order, [...ids.slice(0, 3), ...ids.slice(10, 15)]);
  assert.equal(snap.scope.requests, order.length);
  assert.equal(snap.scope.changed, 1);
  assert.equal(snap.scope.comparedOrder, true);
  assert.equal(snap.scope.pinnedHead, 0);
  assert.equal(snap.scope.pinnedRequests, 0);
  assert.equal(snap.errors.length, 0);
  assert.ok(sleeps.every(ms => ms === WELINK_INTERVAL_MS));
  assert.deepEqual(a.read('message-cache.json').directoryOrder, ids);
});

for (const kind of ['middle', 'multiple', 'new', 'dropped']) {
  test(`${kind} directory change is queried in changed-list order before deferred rotation`, async t => {
    const before = Array.from({ length: 25 }, (_, i) => 'peer-' + i);
    const current = kind === 'middle' ? [before[5], ...before.filter(id => id !== before[5])]
      : kind === 'multiple' ? [before[7], before[4], ...before.filter(id => ![before[7], before[4]].includes(id))]
        : kind === 'new' ? ['new-peer', ...before] : before.filter(id => id !== before[3]);
    const expected = kind === 'middle' ? [before[5], before[0]] : kind === 'multiple' ? [before[7], before[4], before[0]]
      : kind === 'new' ? ['new-peer', before[0]] : [before[0]];
    const { a, order } = orderFixture(t, current);
    a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: [...before].reverse() });
    const snap = await a.collect();
    assert.deepEqual(order.slice(0, expected.length), expected);
    assert.equal(snap.scope.changed, expected.length);
    assert.equal(snap.scope.requests, order.length);
    assert.deepEqual(a.read('message-cache.json').directoryOrder, current);
  });
}

for (const version of [undefined, 2, 3, 4]) {
  test(`cache version ${version ?? 'unversioned'} without directory order queries the full directory and remains readable`, async t => {
    const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
    const { a, order } = orderFixture(t, ids);
    a.write(`raw-${D.dayKey(NOW)}.json`, { login: { uid: 'fixture-owner' } });
    a.write('message-cache.json', version === undefined ? {} : { version, identity: 'fixture-owner', conversations: {}, deferred: [...ids].reverse() });
    const snap = await a.collect();
    assert.deepEqual(order, ids);
    assert.equal(snap.scope.comparedOrder, false);
    assert.equal(snap.scope.changed, ids.length);
    assert.equal(snap.scope.requests, order.length);
    assert.deepEqual(a.read('message-cache.json').directoryOrder, ids);
  });
}

test('directory order and priority candidates from another identity are ignored', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
  const { a, order } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'PRIVATE_OTHER_OWNER', directoryOrder: [...ids].reverse(), priorityDeferred: [...ids].reverse(), conversations: {}, deferred: [...ids].reverse() });
  const snap = await a.collect();
  assert.equal(snap.scope.comparedOrder, false);
  assert.deepEqual(order, ids);
  assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  assert.ok(!JSON.stringify(a.read('message-cache.json')).includes('PRIVATE_OTHER_OWNER'));
});

test('a dropped directory conversation stays in retained cache without entering queries or the saved directory order', async t => {
  const { a, order } = orderFixture(t, ['a', 'c']);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: [{ id: 'b', name: '历史同事', group: false, seenAt: NOW - 86400000 }] });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ['a', 'b', 'c'], conversations: {}, deferred: ['b', 'c', 'a'] });
  await a.collect();
  assert.deepEqual(order, ['a', 'c']);
  const cache = a.read('message-cache.json');
  assert.deepEqual(cache.directoryOrder, ['a', 'c']);
  assert.ok(cache.conversations.b);
});

test('empty-cache immediate queries fetch all directory conversations without modifying background order', async t => {
  const before = ['a', 'b', 'c', 'd'], current = ['c', 'a', 'b', 'd'];
  const { a, order, root, sleeps } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: ['d', 'b', 'a', 'c'] });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, current);
  assert.deepEqual(a.read('message-cache.json').directoryOrder, before);
  assert.equal(snap.scope.changed, undefined);
  assert.ok(sleeps.length > 0 && sleeps.every(ms => ms === WELINK_INTERVAL_MS));
  assert.equal(fs.existsSync(path.join(root, 'logs', 'company-assistant-message-refresh.log')), false);
});

test('every background round logs only changedCount and time, including repeated counts, and feedback collects it', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'PRIVATE_PEER_' + i);
  const { a, root } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, conversations: {}, deferred: ids });
  await a.collect(); await a.collect();
  const lines = fs.readFileSync(path.join(root, 'logs', 'company-assistant-message-refresh.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.changedCount), [1, 1]);
  assert.ok(lines.every(line => Object.keys(line).sort().join(',') === 'at,changedCount' && !Number.isNaN(Date.parse(line.at))));
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_'));
  const bundle = collectBundle({ logsDir: path.join(root, 'logs') });
  assert.ok(bundle.items.some(item => item.name.includes('company-assistant-message-refresh.log')));
  assert.ok(!bundle.text.includes('PRIVATE_'));
});

test('rate limiting a moved conversation stops the warm round and retains priority work for the next round', async t => {
  const before = Array.from({ length: 20 }, (_, i) => 'peer-' + i), current = [before[5], ...before.filter(id => id !== before[5])];
  let limited = true;
  const order = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(current) });
    if (args[1] !== 'query-history-message') return undefined;
    order.push(args[args.indexOf('--user-account') + 1]);
    return limited ? rateReply() : json({ chatInfo: [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: [...before].reverse() });
  const first = await a.collect();
  assert.deepEqual(order, Array(3).fill(before[5]));
  assert.equal(first.scope.rateLimited, true);
  assert.equal(first.scope.requests, 3);
  assert.equal(first.errors.length, 1);
  assert.deepEqual(a.read('message-cache.json').priorityDeferred, [before[5], before[0]]);
  limited = false; order.length = 0;
  const second = await a.collect();
  assert.deepEqual(order.slice(0, 2), [before[5], before[0]]);
  assert.equal(second.scope.requests, order.length);
  assert.equal(second.errors.length, 0);
});

test('changed-count logging refuses nonnumeric values instead of storing conversation information', t => {
  const { a, root } = fixture(t);
  for (const value of ['PRIVATE_PEER', {}, -1, NaN, Infinity]) a.logMessageChanges(value);
  assert.equal(fs.existsSync(path.join(root, 'logs', 'company-assistant-message-refresh.log')), false);
});

test('a ten-conversation pinned prefix stays stable when a middle conversation overtakes others', () => {
  const pins = Array.from({ length: 10 }, (_, i) => 'pin-' + i), ordinary = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
  const before = [...pins, ...ordinary], current = [...pins, ordinary[5], ...ordinary.filter(id => id !== ordinary[5])];
  const changes = conversationOrderChanges(before, current);
  assert.deepEqual(changes.moved, [ordinary[5]]);
  assert.deepEqual(changes.changed, [ordinary[5], ordinary[0]]);
  assert.equal(changes.pinnedHead, 10);
  assert.ok(changes.changed.every(id => !pins.includes(id)), 'pinned conversations remain outside the changed-priority group');
  assert.deepEqual(conversationOrderChanges(current, current, 10), { moved: [], changed: [ordinary[5]], pinnedHead: 10 });
  const front = [ordinary[5], ...before.filter(id => id !== ordinary[5])];
  assert.equal(conversationOrderChanges(current, front, 10).pinnedHead, 10, 'moving to the true head alone cannot invalidate a known pinned estimate');
});

test('one stable boundary is added after each separate overtaking block', () => {
  const before = ['p0', 'p1', 'a', 'b', 'c', 'd', 'e', 'f'], current = ['p0', 'p1', 'c', 'a', 'b', 'f', 'd', 'e'];
  assert.deepEqual(conversationOrderChanges(before, current), { moved: ['c', 'f'], changed: ['c', 'a', 'f', 'd'], pinnedHead: 2 });
  assert.deepEqual(conversationOrderChanges(current, current), { moved: [], changed: ['p0'], pinnedHead: 0 }, 'old caches default to no pinned prefix');
});

test('429 during the pinned phase stops ordinary rotation and preserves the estimate', async t => {
  const ids = ['p0', 'p1', 'a', 'b', 'c'], order = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; order.push(id);
    return id === 'p0' ? rateReply() : json({ chatInfo: [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 2, conversations: {}, deferred: ids });
  const snap = await a.collect();
  assert.deepEqual(order, ['a', 'p0', 'p0', 'p0']);
  assert.equal(snap.scope.rateLimited, true);
  assert.equal(snap.scope.requests, 4);
  assert.equal(snap.scope.pinnedRequests, 3);
  assert.equal(snap.errors.length, 1);
  assert.equal(a.read('message-cache.json').pinnedHead, 2);
});

test('immediate queries fetch changed and pinned peers while preserving background timestamps', async t => {
  const ids = ['p0', 'p1', 'a', 'b'];
  const { a, order, sleeps } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 2, deferred: ['b', 'p1', 'a', 'p0'],
    conversations: { p0: { version: 3, coverage: { status: 'complete' }, messages: [], lastQueriedAt: NOW - 3600000 } } });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, ['a', 'p0', 'p1']);
  assert.ok(sleeps.length > 0 && sleeps.every(ms => ms === WELINK_INTERVAL_MS));
  assert.equal(snap.scope.pinnedHead, undefined);
  const saved = a.read('message-cache.json');
  assert.equal(saved.pinnedHead, 2);
  assert.equal(saved.conversations.p0.lastQueriedAt, NOW - 3600000);
});

test('another account cannot contribute its pinned estimate or oldest-query timestamps', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
  const { a, order } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'PRIVATE_OTHER_OWNER', directoryOrder: ids, pinnedHead: 10, deferred: [...ids].reverse(),
    conversations: { 'peer-19': { version: 3, messages: [], coverage: { status: 'complete' }, lastQueriedAt: NOW - 86400000 } } });
  const snap = await a.collect();
  assert.equal(snap.scope.comparedOrder, false);
  assert.equal(snap.scope.pinnedHead, 0);
  assert.equal(snap.scope.pinnedRequests, 0);
  assert.deepEqual(order, ids);
});

test('verified rank sequence 1,2,3,5,4 identifies the fifth conversation and its fourth-position boundary', () => {
  const previous = ['1', '2', '3', '4', '5'], current = ['1', '2', '3', '5', '4'];
  assert.deepEqual(conversationOrderChanges(previous, current), { moved: ['5'], changed: ['5', '4'], pinnedHead: 3 });
});

test('D and E moving upward are both candidates followed by their unchanged boundary', () => {
  assert.deepEqual(conversationOrderChanges(['A', 'B', 'C', 'D', 'E', 'F'], ['D', 'E', 'A', 'B', 'C', 'F']),
    { moved: ['D', 'E'], changed: ['D', 'E', 'A'], pinnedHead: 0 });
  assert.deepEqual(conversationOrderChanges(['A', 'B', 'C'], ['B', 'C', 'A']),
    { moved: ['B', 'C'], changed: ['B', 'C', 'A'], pinnedHead: 0 }, 'both conversations that overtook A moved upward');
});

test('a one-step swap and a large upward jump identify only the conversation that overtook others', () => {
  assert.deepEqual(conversationOrderChanges(['A', 'B', 'C', 'D'], ['A', 'B', 'D', 'C']),
    { moved: ['D'], changed: ['D', 'C'], pinnedHead: 2 });
  const previous = Array.from({ length: 50 }, (_, i) => 'peer-' + i), current = [...previous.slice(0, 3), previous[45], ...previous.slice(3).filter(id => id !== previous[45])];
  assert.deepEqual(conversationOrderChanges(previous, current), { moved: [previous[45]], changed: [previous[45], previous[3]], pinnedHead: 3 });
});

test('the verified three-pinned swap prioritizes moved and boundary before the entire pinned group', async t => {
  const previous = ['1', '2', '3', '4', '5'], current = ['1', '2', '3', '5', '4'];
  const { a, order } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: previous, conversations: {}, deferred: previous });
  const snap = await a.collect();
  assert.deepEqual(order.slice(0, 2), ['5', '4']);
  assert.equal(snap.scope.pinnedHead, 3);
  assert.equal(snap.scope.changed, 2);
  assert.deepEqual(a.read('message-cache.json').directoryOrder, current);
});

const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
function manualGate() {
  let clock = 0;
  const waits = [];
  const gate = new WelinkGate({ now: () => clock, sleep: ms => new Promise(resolve => waits.push({ at: clock + ms, resolve })) });
  return { gate, now: () => clock, advance: async ms => {
    clock += ms;
    for (const wait of waits.splice(0)) { if (wait.at <= clock) wait.resolve(); else waits.push(wait); }
    await settle();
  } };
}

test('queued request families share the 3-second start interval and CLI time counts toward it', async () => {
  let clock = 0;
  const starts = [], sleeps = [];
  const gate = new WelinkGate({ now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  for (const [i, args] of [['meeting', 'query-list'], ['im', 'query-history-message'], ['contact', 'detail'], ['onebox', 'user-info'], ['auth', 'status']].entries()) {
    await gate.run(args, async () => { starts.push(clock); clock += i === 0 ? 1500 : i === 1 ? 5000 : 0; return reply('{}'); });
  }
  assert.equal(WELINK_INTERVAL_MS, 3000);
  assert.ok(starts.slice(1).every((start, i) => start - starts[i] >= 3000));
  assert.equal(sleeps[0], 1500);
  gate.flush();
});

test('phone beats immediate queries, immediate queries beat background, and equal priority is FIFO', async () => {
  const { gate, now, advance } = manualGate(), starts = [];
  const request = (name, priority) => gate.run(['im', 'query-history-message'], async () => { starts.push([name, now()]); return reply('{}'); }, { priority });
  const first = request('first', 'background'); await settle();
  const jobs = [request('bg1', 'background'), request('user1', 'user'), request('phone1', 'phone'), request('user2', 'user'), request('phone2', 'phone'), request('bg2', 'background')];
  for (let i = 0; i < jobs.length; i += 1) await advance(3000);
  await Promise.all([first, ...jobs]);
  assert.deepEqual(starts.map(([name]) => name), ['first', 'phone1', 'phone2', 'user1', 'user2', 'bg1', 'bg2']);
  assert.deepEqual(starts.map(([, at]) => at), [0, 3000, 6000, 9000, 12000, 15000, 18000]);
  gate.flush();
});

test('429 pauses every queue priority for 30 seconds and retries the same request before continuing', async () => {
  const { gate, now, advance } = manualGate(), starts = [];
  let attempts = 0;
  const background = gate.run(['meeting', 'query-list'], async () => { starts.push(['meeting', now()]); return ++attempts === 1 ? rateReply() : json({}); });
  await settle();
  const phone = gate.run(['im', 'query-history-message'], async () => { starts.push(['phone', now()]); return json({}); }, { priority: 'phone' });
  await advance(29999); assert.deepEqual(starts, [['meeting', 0]]);
  await advance(1); assert.deepEqual(starts, [['meeting', 0], ['meeting', 30000]]);
  await advance(3000); await Promise.all([background, phone]);
  assert.equal(WELINK_COOLDOWN_MS, 30000);
  assert.deepEqual(starts[2], ['phone', 33000]);
  gate.flush();
});

test('version, help and interactive auth login bypass a paused queue without consuming queue starts', async () => {
  const { gate, advance } = manualGate();
  let attempts = 0;
  const running = gate.run(['mail', 'list'], async () => ++attempts === 1 ? rateReply() : json({}));
  await settle();
  const exempt = [['--version'], ['im', 'query-history-message', '--help'], ['auth', 'login']];
  const calls = [];
  await Promise.all(exempt.map(args => gate.run(args, async () => { calls.push(args); return reply('ok'); })));
  assert.deepEqual(calls, exempt); assert.equal(attempts, 1);
  await advance(30000); await running; gate.flush();
});

test('a final 429 retries exactly twice, returns the dedicated code, and never appends format', async () => {
  let clock = 0;
  const calls = [], starts = [];
  const gate = new WelinkGate({ now: () => clock, sleep: async ms => { clock += ms; } });
  await assert.rejects(Q.readJson(args => gate.run(args, async () => { calls.push(args); starts.push(clock); return rateReply(); }), ['meeting', 'query-list']), { code: WELINK_RATE_LIMITED });
  assert.deepEqual(calls, Array(3).fill(['meeting', 'query-list']));
  assert.deepEqual(starts, [0, 30000, 60000]);
  await gate.run(['mail', 'list'], async () => { starts.push(clock); return json({}); });
  assert.equal(starts[3], 90000, 'final exhaustion also pauses the next request'); gate.flush();
});

test('status text at exit zero is not a rate-limit result without a nonzero exit code', async () => {
  let calls = 0, clock = 0;
  const gate = new WelinkGate({ now: () => clock, sleep: async ms => { clock += ms; } });
  const result = await gate.run(['calendar', 'list'], async () => { calls += 1; return rateReply(0); });
  assert.equal(result.code, 0); assert.equal(calls, 1); gate.flush();
});

test('meeting type2 retries through the common queue and reports complete after recovery', async t => {
  const types = [];
  let type2 = 0;
  const { a } = fixture(t, async args => {
    if (args[0] !== 'meeting') return undefined;
    const type = args[args.indexOf('--type') + 1]; types.push(type);
    return type === '2' && ++type2 === 1 ? rateReply() : json({ code: 200, data: { total: 0, page: 1, size: 30 } });
  });
  const snap = await a.collect();
  assert.deepEqual(types, ['1', '2', '2']); assert.equal(snap.meetingCoverage.status, 'complete');
  assert.ok(!snap.errors.some(error => error.label.includes('会议')));
});

test('final meeting rate limit retains same-account prior records and uses a green next-round status', async t => {
  const { a, calls } = fixture(t, async args => args[0] === 'meeting' && args.includes('2') ? rateReply() : undefined);
  const meeting = { id: 'fixture-meeting', sourceId: 'meeting:fixture-meeting', title: '合成会议', start: NOW, end: NOW + 3600000 };
  a.write(`raw-${D.dayKey(NOW)}.json`, { at: NOW - 60000, login: { uid: 'fixture-owner' }, meetings: [meeting] });
  const snap = await a.collect();
  assert.deepEqual(snap.meetings, [meeting]); assert.equal(snap.meetingCoverage.reason, 'rate-limited');
  assert.equal(snap.meetingCoverage.status, 'deferred');
  assert.deepEqual(queryStatus(snap.meetingCoverage, null, 1), { label: '下轮更新', color: 'ok', detail: 'WeLink 限流，已保留上次结果' });
  assert.equal(refreshNotice(snap), '');
  assert.equal(calls.filter(args => args[0] === 'meeting' && args.includes('2')).length, 3);
  assert.ok(calls.some(args => args[0] === 'mail'), 'other families continue via the paused gate');
});

test('a full check queries all 50 directory conversations but never catalog-only conversations', async t => {
  const pins = ['p0', 'p1', 'p2'], peers = Array.from({ length: 47 }, (_, i) => 'peer-' + i), before = [...pins, ...peers];
  const changed = [...peers.slice(0, 12)].reverse(), current = [...pins, ...changed, ...peers.slice(12)];
  const { a, order, calls } = orderFixture(t, current);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: [{ id: 'historical', name: '历史合成同事', seenAt: NOW, group: false }] });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: ['historical'] });
  const snap = await a.collect();
  const priority = conversationOrderChanges(before, current).changed;
  assert.ok(priority.length > 6); assert.deepEqual(order, [...priority, ...pins, ...current.filter(id => !priority.includes(id) && !pins.includes(id))]);
  assert.equal(snap.scope.completed, 50); assert.equal(snap.scope.requests, 50); assert.equal(snap.scope.retained, 1); assert.equal(snap.scope.listFull, true);
  assert.equal(messageCoverage(snap.scope).status, 'complete'); assert.equal(refreshNotice(snap), '');
  assert.ok(calls.findIndex(args => args[0] === 'mail') < calls.findIndex(args => args[1] === 'query-history-message'));
  assert.deepEqual(a.read('message-cache.json').deferred, []);
});

test('six-minute deadline stores unfinished changed IDs and resumes them first after restart', async t => {
  const before = Array.from({ length: 50 }, (_, i) => 'peer-' + i), current = [...before].reverse();
  let slow = true;
  const order = [], starts = [];
  const { a, advance, clock } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(current) });
    if (args[1] !== 'query-history-message') return undefined;
    order.push(args[args.indexOf('--user-account') + 1]); starts.push(clock()); if (slow) advance(30000);
    return json({ chatInfo: [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {} });
  const first = await a.collect(), stored = a.read('message-cache.json'), pending = current.filter(id => !order.includes(id));
  assert.equal(MESSAGE_REFRESH_MAX_MS, 360000); assert.equal(first.scope.timedOut, true);
  assert.ok(pending.length > 0); assert.ok(starts.every(at => at - (starts[0] - 3000) < MESSAGE_REFRESH_MAX_MS));
  assert.deepEqual(stored.priorityDeferred, pending); assert.deepEqual(stored.deferred.slice(0, pending.length), pending);
  assert.equal(queryStatus(messageCoverage(first.scope), null, 0).color, 'warn');
  slow = false; order.length = 0;
  const restart = new CompanyAssistant(a.deps); t.after(() => restart.welinkGate.flush());
  restart.cli = a.cli; restart.auth.check = a.auth.check; restart.auth.status = a.auth.status;
  const second = await restart.collect();
  assert.deepEqual(order.slice(0, pending.length), pending); assert.equal(second.scope.completed, order.length);
  assert.equal(second.scope.fullCheckPending, 0);
  assert.ok(second.scope.lastFullCheckAt > NOW);
  assert.deepEqual(restart.read('message-cache.json').deferred, []);
});

test('deadline interruption during pagination preserves the last cursor and fetched messages', async t => {
  let slow = true;
  const pages = [];
  const { a, advance } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['peer']) });
    if (args[1] !== 'query-history-message') return undefined;
    pages.push(args);
    const cursor = args.includes('--message-id') ? Number(args[args.indexOf('--message-id') + 1]) : 10000;
    if (slow) advance(180000);
    return json({ chatInfo: slow ? historyRows('peer', 100).map((row, i) => ({ ...row, msgId: String(cursor - i - 1) })) : [] });
  });
  const first = await a.collect(); assert.equal(first.messages.peer.length, 200);
  assert.equal(a.read('message-cache.json').conversations.peer.resume.cursor, '9800');
  slow = false; const second = await a.collect();
  assert.equal(pages[2][pages[2].indexOf('--message-id') + 1], '9800');
  assert.equal(pages[2][pages[2].indexOf('--query-direction') + 1], '0');
  assert.equal(second.messages.peer.length, 200); assert.equal(second.scope.completed, 1);
  assert.equal(a.read('message-cache.json').conversations.peer.resume, undefined);
});

for (const cached of [false, true]) {
  test(`final rate limit on an unchanged conversation with cached=${cached} has the correct warning and retains records`, async t => {
    const ids = ['a', 'b', 'c'], order = [];
    const { a } = fixture(t, async args => {
      if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
      if (args[1] !== 'query-history-message') return undefined;
      const id = args[args.indexOf('--user-account') + 1]; order.push(id); return id === 'b' ? rateReply() : json({ chatInfo: [] });
    });
    const conversations = cached ? Object.fromEntries(ids.map(id => [id, { version: 3, since: NOW - 36 * 3600000, coverage: { status: 'complete' }, hasFetched: true,
      messages: D.messages({ chatInfo: historyRows(id) }, { id, name: id, group: false }, 'fixture-owner') }])) : {};
    a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, conversations });
    const snap = await a.collect();
    assert.deepEqual(order, ['a', 'b', 'b', 'b']); assert.equal(snap.scope.rateLimited, true);
    assert.equal(snap.errors.filter(error => error.label === '消息').length, 1);
    assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, cached ? 'ok' : 'warn');
    if (cached) for (const id of ids) assert.equal(snap.messages[id][0].text, 'fixture message 0');
    assert.ok(a.read('message-cache.json').deferred.includes('c'));
  });
}

test('a changed conversation still warns when its cached update cannot be fetched', async t => {
  const before = ['a', 'b', 'c'], current = ['c', 'a', 'b'];
  const { a } = fixture(t, async args => args[1] === 'query-recent-conversation' ? json({ conversation_info: conversationRows(current) })
    : args[1] === 'query-history-message' ? rateReply() : undefined);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before,
    conversations: Object.fromEntries(before.map(id => [id, { version: 3, coverage: { status: 'complete' }, hasFetched: true, messages: [] }])) });
  const snap = await a.collect();
  assert.equal(snap.scope.neverFetched, 0); assert.ok(snap.scope.priorityPending > 0);
  assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, 'warn');
});

test('phone polling is six seconds and phone requests carry the highest priority', async t => {
  const { a } = fixture(t), calls = [];
  a.write('settings.json', { phone: { enabled: true, groupId: 'fixture-group' } });
  a.phone.me = async () => 'fixture-owner';
  a.welink = async (args, opts) => { calls.push({ args, opts }); return json({ chatInfo: [] }); };
  await a.phone.poll();
  assert.equal(POLL_MS, 6000); assert.equal(calls[0].opts.priority, 'phone');
});

test('minute diagnostics contain only numeric counts and command names and are included in feedback logs', async t => {
  const { a, root, advance } = fixture(t, async args => args[0] === 'contact' ? rateReply() : undefined);
  await assert.rejects(a.rawWelink(['contact', 'detail', 'PRIVATE_ACCOUNT']), { code: WELINK_RATE_LIMITED });
  advance(60000); await a.welink(['mail', 'list', '--subject', 'PRIVATE_SUBJECT']); a.welinkGate.flush();
  const lines = fs.readFileSync(path.join(root, 'logs', 'company-assistant-welink.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.every(line => Number.isInteger(line.minute) && Object.keys(line).sort().join(',') === 'commands,minute'));
  const commands = lines.flatMap(line => line.commands);
  assert.equal(commands.reduce((sum, row) => sum + row.requests, 0), 4);
  assert.equal(commands.reduce((sum, row) => sum + row.rateLimited, 0), 3);
  assert.ok(commands.every(row => Object.keys(row).sort().join(',') === 'command,rateLimited,requests' && typeof row.command === 'string' && Number.isInteger(row.requests) && Number.isInteger(row.rateLimited)));
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_'));
  assert.ok(collectBundle({ logsDir: path.join(root, 'logs') }).items.some(item => item.name.includes('company-assistant-welink.log')));
});

test('immediate collectQuery can enqueue above a running background collection without changing its cache', async t => {
  const { a } = fixture(t), { gate, advance } = manualGate(), order = [];
  a.welinkGate = gate;
  a.collectUnlocked = async () => { await a.welink(['im', 'query-history-message']); await a.welink(['im', 'query-history-message']); };
  a.collectQueryUnlocked = async () => a.welink(['meeting', 'query-list']);
  a.deps.welinkRun = async args => { order.push(args.slice(0, 2).join(' ')); return json({}); };
  const background = a.withCollection(() => a.collect()); await settle();
  const immediate = a.collectQuery('meetings', RANGE); await settle();
  await advance(3000); await immediate;
  assert.deepEqual(order, ['im query-history-message', 'meeting query-list']);
  await advance(3000); await background;
  assert.deepEqual(order, ['im query-history-message', 'meeting query-list', 'im query-history-message']); gate.flush();
});

test('the message deadline also expires during global cooldown without starting a late retry', async () => {
  let clock = 0, calls = 0;
  const gate = new WelinkGate({ now: () => clock, sleep: async ms => { clock += ms; } });
  await assert.rejects(gate.run(['im', 'query-history-message'], async () => { calls += 1; return rateReply(); }, { deadline: 10000 }), { code: MESSAGE_ROUND_EXPIRED });
  assert.equal(clock, 10000); assert.equal(calls, 1); gate.flush();
});

test('format retries and auth replays use the same gate without a fixed per-round request cap', async t => {
  const starts = [];
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
  const { a, clock } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock());
    return args.includes('--format') ? json({ chatInfo: [] }) : reply('synthetic non-json');
  });
  const snap = await a.collect();
  assert.equal(starts.length, 40); assert.equal(snap.scope.requests, 40); assert.equal(snap.scope.completed, 20);
  assert.ok(starts.slice(1).every((at, i) => at - starts[i] >= 3000));
  assert.equal(snap.scope.partial, 0); assert.deepEqual(a.read('message-cache.json').deferred, []);
});

test('large historical catalogs retain cached entries without querying or deferring them', async t => {
  const recent = Array.from({ length: 50 }, (_, i) => 'recent-' + i), historical = Array.from({ length: 200 }, (_, i) => 'old-' + i);
  const { a, order } = orderFixture(t, recent);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: historical.map(id => ({ id, name: '合成历史联系人', seenAt: NOW, group: false })) });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: recent, deferred: [...historical, ...recent.slice(1)], conversations:
    Object.fromEntries(historical.map(id => [id, { version: 3, coverage: { status: 'complete' }, hasFetched: true, messages: [] }])) });
  const first = await a.collect();
  assert.deepEqual(order.slice(0, 50), recent); assert.ok(order.slice(50).every(id => historical.includes(id)));
  assert.equal(first.scope.timedOut, false);
  assert.equal(order.length, 50); assert.equal(first.scope.retained, 200);
  const cache = a.read('message-cache.json');
  assert.deepEqual(cache.deferred, []);
  for (const id of historical) assert.equal(cache.conversations[id].hasFetched, true);
  assert.equal(queryStatus(messageCoverage(first.scope), null, 0).color, 'ok');
});

test('the entire pinned group is queried between changed and ordinary peers, including format retries', async t => {
  const ids = ['p0', 'p1', 'p2', 'p3', 'a', 'b', 'c'], order = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; order.push(id);
    return id.startsWith('p') && !args.includes('--format') ? reply('synthetic non-json') : json({ chatInfo: [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 4, conversations: {} });
  const snap = await a.collect();
  assert.deepEqual(order, ['a', 'p0', 'p0', 'p1', 'p1', 'p2', 'p2', 'p3', 'p3', 'b', 'c']);
  assert.equal(snap.scope.pinnedRequests, 8); assert.equal(snap.scope.completed, 7);
  const saved = a.read('message-cache.json'); assert.equal(saved.pinnedHead, 4);
  assert.ok(ids.slice(0, 4).every(id => Number.isFinite(saved.conversations[id].lastQueriedAt)));
});

test('one ordinary failed query is informational with or without cached results', async t => {
  for (const cached of [false, true]) {
    const { a } = fixture(t, async args => args[1] === 'query-recent-conversation' ? json({ conversation_info: conversationRows(['a', 'b']) })
      : args[1] === 'query-history-message' ? args.includes('b') ? { code: 1, stdout: '', stderr: 'synthetic failed request' } : json({ chatInfo: [] }) : undefined);
    a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ['a', 'b'], conversations: cached ? { b: { version: 3, hasFetched: true, coverage: { status: 'complete' }, messages: [] } } : {} });
    const snap = await a.collect();
    assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, 'ok');
  }
});

test('directory rate limits retain cached data and still warn about never-fetched cached scope', async t => {
  for (const neverFetched of [0, 1]) {
    const { a } = fixture(t, async args => args[1] === 'query-recent-conversation' ? rateReply() : undefined);
    a.write(`raw-${D.dayKey(NOW)}.json`, { at: NOW - 1000, login: { uid: 'fixture-owner' }, conversations: [{ id: 'a' }], messages: { a: [{ key: '1', text: 'synthetic saved record' }] }, scope: { neverFetched } });
    const snap = await a.collect();
    assert.equal(snap.messages.a[0].text, 'synthetic saved record');
    assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, neverFetched ? 'warn' : 'ok');
  }
});

test('calendar format retry rate limits use the dedicated error instead of parsing a stale table', async () => {
  let calls = 0;
  await assert.rejects(gatedJson(async () => ++calls === 1 ? reply(TABLE) : rateReply(), ['calendar', 'list']), { code: WELINK_RATE_LIMITED });
  assert.equal(calls, 4);
});

test('immediate message queries also pass through the three-second gate while leaving background cache untouched', async t => {
  const starts = [];
  const { a, clock } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a', 'b']) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock()); return json({ chatInfo: starts.length === 1 ? historyRows('a', 100) : [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ['b', 'a'], conversations: {}, deferred: [] });
  const before = a.read('message-cache.json');
  const result = await a.collectQuery('messages', RANGE);
  assert.equal(starts.length, 3); assert.ok(starts.slice(1).every((at, i) => at - starts[i] >= 3000));
  assert.equal(result.scope.completed, 2); assert.deepEqual(a.read('message-cache.json'), before);
});

test('expiring queued work cannot let other requests bypass the shared interval', async () => {
  const { gate, now, advance } = manualGate(), starts = [];
  await gate.run(['contact', 'detail'], async () => { starts.push(now()); return json({}); });
  const expired = assert.rejects(gate.run(['im', 'query-history-message'], async () => { throw new Error('expired request must not start'); }, { deadline: 1000 }), { code: MESSAGE_ROUND_EXPIRED });
  const phone = gate.run(['im', 'query-history-message'], async () => { starts.push(now()); return json({}); }, { priority: 'phone' });
  await settle(); await advance(1000); await expired;
  assert.deepEqual(starts, [0]);
  await advance(2000); await phone; assert.deepEqual(starts, [0, 3000]); gate.flush();
});

test('a settings conversation cap retains deferred caches outside the selected list', async t => {
  const { a } = orderFixture(t, ['a', 'b']);
  a.write('settings.json', { email: 'fixture@example.invalid', maxConversations: 1 });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', conversations: { b: { version: 3, hasFetched: true, messages: [], coverage: { status: 'complete' } } }, deferred: ['b'] });
  await a.collect(); const stored = a.read('message-cache.json');
  assert.equal(stored.conversations.b.hasFetched, true); assert.ok(stored.deferred.includes('b'));
});

function warmCache(a, ids, patch = {}) {
  const conversations = Object.fromEntries(ids.map((id, i) => [id, {
    version: 3, newest: '100', since: NOW - 36 * 3600000, hasFetched: true, coverage: { status: 'complete' },
    lastQueriedAt: NOW - (i + 1) * 60000, capturedAt: NOW - (i + 1) * 60000,
    messages: D.messages({ chatInfo: historyRows(id) }, { id, name: '合成同事' + id, group: false }, 'fixture-owner'),
  }]));
  const cache = { version: 4, identity: 'fixture-owner', directoryOrder: ids, lastFullCheckAt: NOW - 60000, conversations, ...patch };
  a.write('message-cache.json', cache); return cache;
}
const speedScenario = () => {
  const pins = ['p0', 'p1', 'p2'], peers = Array.from({ length: 47 }, (_, i) => 'peer-' + i);
  const before = [...pins, ...peers], current = [...pins, ...peers.slice(0, 3).reverse(), ...peers.slice(3)];
  return { pins, before, current, changed: peers.slice(0, 3).reverse() };
};

test('incremental refresh queries three changed, three pinned and five oldest directory peers only', async t => {
  const { pins, before, current, changed } = speedScenario();
  const { a, order, calls, clock } = orderFixture(t, current);
  warmCache(a, before);
  const started = clock(), snap = await a.collect();
  assert.equal(MESSAGE_ROTATION_LIMIT, 5);
  assert.deepEqual(order, [...changed, ...pins, ...before.slice(-5).reverse()]);
  assert.equal(snap.scope.mode, 'incremental'); assert.equal(snap.scope.requests, 11);
  assert.equal(snap.scope.fromCache, 39); assert.equal(snap.scope.neverFetched, 0);
  assert.equal(calls.length, 17); assert.equal(clock() - started, 42000);
  assert.equal(a.read('message-cache.json').lastFullCheckAt, NOW - 60000);
  assert.match(messageCoverage(snap.scope).reasonLabel, /增量更新；最近完整核对：/);
  assert.equal(refreshNotice(snap), '');
});

test('oldest rotation ignores catalog-only peers even when their timestamps are older', async t => {
  const ids = Array.from({ length: 8 }, (_, i) => 'peer-' + i), historical = ['h0', 'h1', 'h2', 'h3'];
  const { a, order } = orderFixture(t, ids);
  const cache = warmCache(a, ids);
  for (const [i, id] of historical.entries()) cache.conversations[id] = { version: 3, hasFetched: true, coverage: { status: 'complete' }, messages: [], lastQueriedAt: NOW - (100 + i) * 60000 };
  a.write('message-cache.json', cache);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: historical.map(id => ({ id, name: '合成历史联系人', seenAt: NOW, group: false })) });
  const snap = await a.collect();
  assert.deepEqual(order, [...ids.slice(0, 3), ...ids.slice(3).reverse()]);
  assert.equal(snap.scope.requests, 8); assert.ok(snap.scope.conversations.find(conv => conv.id === 'h0').dataSource === 'cache');
});

test('thirty-minute complete checks persist their completion time across restart without being reset by incremental rounds', async t => {
  const ids = Array.from({ length: 50 }, (_, i) => 'peer-' + i), { a, order, advance, clock } = orderFixture(t, ids);
  warmCache(a, ids);
  await a.collect(); assert.equal(order.length, 8);
  const old = a.read('message-cache.json').lastFullCheckAt;
  advance(MESSAGE_FULL_CHECK_MS - (clock() - old)); order.length = 0;
  const full = await a.collect();
  assert.equal(MESSAGE_FULL_CHECK_MS, 1800000); assert.equal(full.scope.mode, 'full-check'); assert.equal(order.length, 50);
  const completed = a.read('message-cache.json').lastFullCheckAt; assert.ok(completed >= old + MESSAGE_FULL_CHECK_MS);
  assert.deepEqual(a.read('message-cache.json').fullCheckPending, []);
  const restart = new CompanyAssistant(a.deps); restart.cli = a.cli; restart.auth.check = a.auth.check; restart.auth.status = a.auth.status;
  order.length = 0; const incremental = await restart.collect(); restart.welinkGate.flush();
  assert.equal(incremental.scope.mode, 'incremental'); assert.equal(order.length, 8);
  assert.equal(restart.read('message-cache.json').lastFullCheckAt, completed);
});

test('first directory and a changed identity both force a full check and never inherit another account audit time', async t => {
  for (const previousOwner of [null, 'other-owner']) {
    const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
    if (previousOwner) warmCache(a, ids, { identity: previousOwner, pinnedHead: 5, fullCheckPending: ['private-other-id'] });
    const snap = await a.collect();
    assert.equal(snap.scope.mode, 'full-check'); assert.deepEqual(order, ids);
    const stored = a.read('message-cache.json'); assert.equal(stored.identity, 'fixture-owner');
    assert.ok(stored.lastFullCheckAt >= NOW); assert.ok(!JSON.stringify(stored).includes('private-other-id'));
  }
});

test('assistant message queries fetch only changed and pinned peers, mark cache provenance and never trigger an overdue full check', async t => {
  const { pins, before, current, changed } = speedScenario(), { a, order, calls, clock } = orderFixture(t, current);
  const cache = warmCache(a, before, { lastFullCheckAt: NOW - 2 * MESSAGE_FULL_CHECK_MS });
  const started = clock(), snap = await a.collectQuery('messages', RANGE);
  assert.deepEqual(order, [...changed, ...pins]); assert.equal(calls.length, 8); assert.equal(clock() - started, 21000);
  assert.equal(snap.scope.mode, 'query'); assert.equal(snap.scope.queryFallback, false);
  assert.equal(snap.scope.realtime, 6); assert.equal(snap.scope.fromCache, 44);
  const reused = snap.scope.conversations.find(conv => conv.id === before[49]);
  assert.equal(reused.dataSource, 'cache'); assert.equal(reused.cachedAt, cache.conversations[before[49]].capturedAt);
  assert.equal(reused.capturedAt, reused.cachedAt);
  for (const id of [...changed, ...pins]) assert.equal(snap.scope.conversations.find(conv => conv.id === id).dataSource, 'realtime');
  assert.deepEqual(a.read('message-cache.json'), cache);
});

test('an empty assistant cache fetches the full directory with an explicit fallback and real-time source labels', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  const result = await a.query.inbox({ scope: ['私聊'] });
  assert.deepEqual(order, ids); assert.match(result.text, /后台缓存为空，本次改为查询全部可发现会话/);
  // 5.5.11：返回里不再附整份会话清单（每页省 1–2 万字），实时取到的消息行也不再逐条标注。
  assert.equal(result.conversations, undefined); assert.doesNotMatch(result.text, /缓存；采集时间/);
  assert.equal(a.read('message-cache.json', null), null);
});

test('inbox result text and per-message records expose cache time while preserving the background cache', async t => {
  const { a } = orderFixture(t, ['a', 'b', 'c']);
  const cache = warmCache(a, ['a', 'b', 'c']);
  const page = await a.query.execute({ kind: 'messages', scope: 'all', period: 'custom', start: new Date(RANGE.start).toISOString(), end: new Date(RANGE.end).toISOString() });
  assert.equal(page.items.find(item => item.conv === 'b').dataSource, 'cache');
  assert.equal(page.items.find(item => item.conv === 'b').capturedAt, cache.conversations.b.capturedAt);
  const inbox = await a.query.inbox({ scope: ['私聊'] });
  assert.match(inbox.text, /缓存；采集时间/); assert.doesNotMatch(inbox.text, /实时取数；采集时间/);
  assert.match(inbox.text, /缓存部分本次未实时核对/);
  assert.deepEqual(a.read('message-cache.json'), cache);
});

test('cached records outside their original collection window explicitly remain incomplete', async t => {
  const { a } = orderFixture(t, ['a', 'b']);
  const cache = warmCache(a, ['a', 'b']); cache.conversations.b.since = NOW - 3600000;
  a.write('message-cache.json', cache);
  const snap = await a.collectQuery('messages', { start: NOW - 24 * 3600000, end: NOW });
  assert.equal(snap.scope.conversations.find(conv => conv.id === 'b').cacheWindowIncomplete, true);
  assert.ok(snap.scope.partial > 0);
});

test('the real refresh IPC passes user priority while automatic refresh uses background priority', async t => {
  const { a } = fixture(t), handlers = new Map(), options = [];
  require('../main/ipc/company-assistant-handlers').registerCompanyAssistantIpc({ handle: (name, handler) => handlers.set(name, handler) }, a);
  const refresh = a.refresh.bind(a);
  a.refresh = async request => { options.push(request); return refresh(request); };
  const { gate, advance } = manualGate(); a.welinkGate = gate; a.deps.noTimer = true;
  a.collectUnlocked = async () => a.welink(historyArgs);
  a.deps.welinkRun = async () => json({});
  a.generateBrief = async () => {}; a.remind = () => []; a.pump = async () => {};
  const manual = handlers.get('company-assistant:refresh')({}, {}); await settle();
  await manual; assert.deepEqual(options[0], { force: true, priority: 'user', trigger: 'manual' });
  const automatic = a.tick(); await settle();
  assert.equal(gate.queue[0].priority, 2); assert.equal(options[1], undefined);
  await advance(3000); await automatic; gate.flush();
});

test('manual refresh queues above an automatic background peer at the same gate', async t => {
  const { a } = fixture(t), { gate, advance } = manualGate(), order = [];
  a.welinkGate = gate; a.deps.welinkRun = async args => { order.push(args[1]); return json({}); };
  await a.welink(['contact', 'detail']);
  const background = gate.run(['im', 'query-history-message'], async () => { order.push('background'); return json({}); }, { priority: 'background' });
  a.collectUnlocked = async () => a.welink(['meeting', 'query-list']);
  const manual = a.refresh({ force: true, priority: 'user' }); await settle();
  await advance(3000); await manual; assert.deepEqual(order, ['detail', 'query-list']);
  await advance(3000); await background; gate.flush();
});

test('Exchange whitelist requests bypass spacing and an occupied queue without changing queued start times', async () => {
  const { gate, now, advance } = manualGate(), starts = [];
  await gate.run(['contact', 'detail'], async () => { starts.push(['contact', now()]); return json({}); });
  const queued = gate.run(['meeting', 'query-list'], async () => { starts.push(['meeting', now()]); return json({}); });
  for (const args of [['mail', 'list'], ['mail', 'get'], ['mail', 'autodiscover'], ['calendar', 'list']])
    await gate.run(args, async () => { starts.push([args.join(' '), now()]); return json({}); });
  assert.ok(starts.slice(1).every(([, at]) => at === 0));
  await advance(3000); await queued; assert.deepEqual(starts.at(-1), ['meeting', 3000]); gate.flush();
});

for (const command of ['mail', 'calendar']) {
  test(`${command} 429 pauses both Exchange and queued WeLink work before a successful retry`, async () => {
    const { gate, now, advance } = manualGate(), starts = [];
    await gate.run(['contact', 'detail'], async () => json({}));
    const queued = gate.run(['meeting', 'query-list'], async () => { starts.push(['meeting', now()]); return json({}); });
    let attempts = 0;
    const exchange = gate.run([command, 'list'], async () => { starts.push([command, now()]); return ++attempts === 1 ? rateReply() : json({}); });
    await settle(); await advance(3000); assert.deepEqual(starts, [[command, 0]]);
    await advance(27000); await Promise.all([exchange, queued]);
    assert.equal(attempts, 2); assert.ok(starts.slice(1).every(([, at]) => at >= 30000)); gate.flush();
  });
}

test('staged meeting, calendar and mail snapshots update the UI without becoming briefing or reminder inputs', async t => {
  let releaseMail;
  const heldMail = new Promise(resolve => { releaseMail = resolve; });
  const event = { subject: '合成待开会日程', itemId: 'fixture-upcoming', start: new Date(NOW + 5 * 60000).toISOString(), end: new Date(NOW + 35 * 60000).toISOString() };
  const { a } = fixture(t, async args => {
    if (args[0] === 'calendar') return json({ events: [event] });
    if (args[0] === 'mail') { await heldMail; return json({ mails: [{ id: 'fixture-mail', subject: '合成邮件' }] }); }
    return undefined;
  });
  const completed = { at: NOW - 60000, day: D.dayKey(NOW), login: { ok: true, uid: 'fixture-owner' }, meetings: [], calendar: [], mails: [], conversations: [], messages: {}, errors: [] };
  a.write(`raw-${D.dayKey(NOW)}.json`, completed);
  const observations = []; a.deps.onChanged = () => { if (a.visibleSnapshot) observations.push(a.status()); };
  a.enqueue = () => {};
  const refresh = a.refresh({ force: true });
  for (let i = 0; i < 4; i += 1) await settle();
  const visible = a.status(); assert.equal(visible.counts.calendar, 1);
  assert.deepEqual(visible.updating, ['mails', 'messages']);
  assert.equal(queryRows(visible).find(row => row.name === '消息').label, '正在更新');
  assert.equal(refreshNotice(visible), ''); assert.deepEqual(a.snapshot(), completed); assert.deepEqual(a.remind(), []);
  const brief = a.generateBrief({ force: true }); await settle();
  assert.equal(a.brief(), null, 'briefing waits for the complete collection promise');
  releaseMail(); await Promise.all([refresh, brief]);
  assert.equal(a.visibleSnapshot, null); assert.equal(a.snapshot().calendar.length, 1); assert.equal(a.snapshot().mails.length, 1);
  assert.ok(observations.some(view => view.updating.length === 3));
  assert.ok(observations.some(view => view.updating.length === 1 && view.counts.mails === 1));
  assert.ok(observations.every(view => refreshNotice(view) === ''));
});

test('a failed collection discards transient UI data and leaves the last completed snapshot intact', async t => {
  const { a } = fixture(t, async args => { if (args[0] === 'calendar') throw Object.assign(new Error('fixture stopped'), { code: 'FIXTURE_STOP' }); return undefined; });
  const old = { at: NOW - 60000, day: D.dayKey(NOW), login: { ok: true, uid: 'fixture-owner' }, messages: {} };
  a.write(`raw-${D.dayKey(NOW)}.json`, old);
  const query = a.queryWithCache.bind(a);
  a.queryWithCache = (snap, key, run) => { if (key === 'calendar') throw new Error('fixture interrupted collection'); return query(snap, key, run); };
  await assert.rejects(a.refresh({ force: true }), /interrupted collection/);
  assert.equal(a.visibleSnapshot, null); assert.deepEqual(a.snapshot(), old);
});

test('a full check of fifty conversations uses fifty history requests and preserves the measured three-second cadence', async t => {
  const { before, current } = speedScenario(), { a, order, calls, clock } = orderFixture(t, current);
  warmCache(a, before, { lastFullCheckAt: NOW - 2 * MESSAGE_FULL_CHECK_MS });
  const started = clock(), snap = await a.collect();
  assert.equal(snap.scope.mode, 'full-check'); assert.equal(order.length, 50);
  assert.equal(calls.length, 56); assert.equal(clock() - started, 159000);
});

test('the actual query-row HTML shows completed batches and updating messages without a false warning', () => {
  const code = fs.readFileSync(path.join(__dirname, '../renderer/company-assistant-page.js'), 'utf8');
  const source = code.slice(code.indexOf('  function querySnapshotRows('), code.indexOf('  function welinkTab('));
  const renderRows = require('node:vm').runInNewContext(source + '\nquerySnapshotRows', { queryRows, esc: value => String(value).replace(/</g, '&lt;') });
  const data = { updating: ['messages'], counts: { meetings: 2, calendar: 1, mails: 3 }, errors: [],
    meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'complete' }, mailCoverage: { status: 'complete' }, scope: { partial: 50 } };
  const html = renderRows(data);
  assert.match(html, /已取到 2 条/); assert.match(html, /已取到 1 条/); assert.match(html, /已取到 3 条/);
  assert.match(html, /正在更新/); assert.ok(!html.includes('未取全') && !html.includes('查询失败'));
  assert.match(code, /if \(querySlot\) querySlot.innerHTML = querySnapshotRows\(data\)/, 'an open settings panel patches only its query rows');
});

test('an incremental round interrupted at six minutes retains rotation work without advancing the complete-check time', async t => {
  const { before, current } = speedScenario(), order = [];
  let slow = true;
  const { a, advance } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(current) });
    if (args[1] !== 'query-history-message') return undefined;
    order.push(args[args.indexOf('--user-account') + 1]); if (slow) advance(40000);
    return json({ chatInfo: [] });
  });
  const cache = warmCache(a, before), first = await a.collect(), pending = a.read('message-cache.json').deferred;
  assert.equal(first.scope.mode, 'incremental'); assert.equal(first.scope.timedOut, true); assert.ok(pending.length > 0);
  assert.equal(a.read('message-cache.json').lastFullCheckAt, cache.lastFullCheckAt);
  slow = false; order.length = 0;
  const next = await a.collect();
  assert.equal(next.scope.mode, 'incremental'); assert.ok(pending.every(id => order.includes(id)));
  assert.deepEqual(a.read('message-cache.json').deferred, []);
  assert.equal(a.read('message-cache.json').lastFullCheckAt, cache.lastFullCheckAt);
});

test('the actual brief card describes an updating batch without calling it missing data', () => {
  // 5.5.11 起简报在右栏「今天」：标题下的状态句与空列表说明由 todayStatus 给出。
  const { todayStatus } = require('../renderer/company-assistant-page');
  const status = todayStatus({ updating: ['messages'], brief: { sections: [], total: 0, by: 'list', generatedAt: NOW }, errors: [{ label: '消息', text: '部分会话未取全' }] }, String);
  const text = status.up + '\n' + status.empty;
  assert.match(status.up, /数据正在更新，暂显示上次完成的简报/); assert.match(status.empty, /数据正在更新，暂显示上次完成的简报/);
  assert.ok(!text.includes('本次数据尚未取全'));
  assert.match(todayStatus({ brief: { sections: [], by: 'list' }, errors: [{}] }).empty, /本次数据尚未取全/, 'a finished round with errors still says so');
});

test('cached message source details retain their original collection time after an incremental refresh', async t => {
  const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a } = orderFixture(t, ids);
  const cache = warmCache(a, ids), snap = await a.collect();
  const message = snap.messages[ids[3]][0], source = a.sourceContext(message.sourceId);
  assert.equal(source.coverage.status, 'cached');
  assert.equal(source.capturedAt, cache.conversations[ids[3]].capturedAt);
  assert.ok(source.capturedAt < snap.at);
});

test('a missing account number reuses identity and keeps the following identified round incremental', async t => {
  const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a, order, root } = orderFixture(t, ids);
  const old = warmCache(a, ids);
  a.auth.check = async () => ({ login: { ok: true } });
  const missing = await a.collect();
  assert.equal(missing.scope.mode, 'incremental'); assert.equal(missing.scope.identityMissing, true);
  assert.equal(order.length, 8); assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  assert.equal(a.read('message-cache.json').lastFullCheckAt, old.lastFullCheckAt);
  a.auth.check = async () => ({ login: { ok: true, uid: 'fixture-owner' } });
  order.length = 0;
  const recovered = await a.collect(); assert.equal(recovered.scope.comparedOrder, true); assert.equal(order.length, 8);
  const rounds = fs.readFileSync(path.join(root, 'logs/company-assistant-message-round.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rounds[0].fullCheckReason, 'identity-missing'); assert.equal(rounds[0].cacheReused, true);
  assert.equal(rounds[1].identityMissing, false);
});

test('missing identity keeps overdue audits incremental, and an unowned cache is left untouched', async t => {
  const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  const old = warmCache(a, ids, { lastFullCheckAt: NOW - 2 * MESSAGE_FULL_CHECK_MS });
  a.auth.check = async () => ({ login: { ok: true } });
  const snap = await a.collect();
  assert.equal(snap.scope.mode, 'incremental'); assert.equal(order.length, 8);
  assert.equal(a.read('message-cache.json').lastFullCheckAt, old.lastFullCheckAt);
  assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  const unknown = { ...old, identity: null }; a.write('message-cache.json', unknown); order.length = 0;
  const skipped = await a.collect();
  assert.equal(order.length, 0); assert.equal(skipped.scope.identityMissing, true);
  assert.deepEqual(a.read('message-cache.json'), unknown);
});

test('missing identity and a failed directory retain the identified snapshot without changing cache identity', async t => {
  let fail = false;
  const ids = ['a', 'b', 'c'], { a, root } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return fail ? { code: 1, stdout: '', stderr: 'synthetic directory failure' } : json({ conversation_info: conversationRows(ids) });
    if (args[1] === 'query-history-message') return json({ chatInfo: historyRows(args[args.indexOf('--user-account') + 1]) });
    return undefined;
  });
  warmCache(a, ids); const first = await a.collect(); fail = true;
  a.auth.check = async () => ({ login: { ok: true } });
  const snap = await a.collect();
  assert.deepEqual(snap.messages, first.messages); assert.equal(snap.scope.identityMissing, true);
  assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  const logs = fs.readFileSync(path.join(root, 'logs/company-assistant-message-round.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs[1].identityMissing, true); assert.equal(logs[1].fullCheckReason, 'identity-missing');
});

test('unchanged order still fetches new messages at both partition heads', async t => {
  const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i);
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] === 'query-history-message') {
      const id = args[args.indexOf('--user-account') + 1];
      return json({ chatInfo: [{ msgId: '101', sender: id, serverSendTime: NOW, content: 'new synthetic head message' }] });
    }
    return undefined;
  });
  warmCache(a, ids, { pinnedHead: 15 });
  const snap = await a.collect();
  for (const id of [...ids.slice(0, 3), ...ids.slice(15, 18)]) {
    assert.ok(snap.messages[id].some(m => m.key === '101' && m.text === 'new synthetic head message'));
  }
});

test('version-4 null-identity caches are claimed only by the latest known snapshot owner without a catalog conflict', async t => {
  for (const historicalOwner of ['fixture-owner', 'other-owner', null]) {
    const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
    warmCache(a, ids, { identity: null });
    if (historicalOwner) a.write(`raw-${D.dayKey(NOW)}.json`, { at: NOW - 1000, login: { ok: true, uid: historicalOwner } });
    const snap = await a.collect();
    assert.equal(order.length, historicalOwner === 'fixture-owner' ? 8 : 25);
    assert.equal(snap.scope.comparedOrder, historicalOwner === 'fixture-owner');
    assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  }
  const ids = Array.from({ length: 25 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  warmCache(a, ids, { identity: null });
  a.write(`raw-${D.dayKey(NOW)}.json`, { login: { uid: 'fixture-owner' } });
  a.write('conversation-catalog.json', { identity: 'other-owner', conversations: [] });
  await a.collect(); assert.equal(order.length, 25);
});

for (const boundary of [0, 3, 15]) test(`stable partition heads and five oldest peers update at boundary ${boundary}`, async t => {
  const ids = Array.from({ length: 50 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  warmCache(a, ids, { pinnedHead: boundary });
  const snap = await a.collect();
  const expected = boundary ? [ids[boundary], ...ids.slice(0, 3), ...ids.slice(boundary + 1, boundary + 3), ...ids.slice(-5).reverse()]
    : [...ids.slice(0, 3), ...ids.slice(-5).reverse()];
  assert.deepEqual(order, expected); assert.equal(snap.scope.pinnedHead, boundary);
  assert.equal(snap.scope.partial, 0); assert.ok(snap.scope.requests <= 16);
  assert.ok(expected.every(id => snap.scope.conversations.find(c => c.id === id).dataSource === 'realtime'));
});

test('pinned reordering at positions zero or one preserves the boundary; ordinary evidence shrinks and grows it', () => {
  const initial = ['p0', 'p1', 'p2', 'a', 'b', 'c'];
  assert.equal(conversationOrderChanges(initial, ['p2', 'p0', 'p1', 'a', 'b', 'c'], 3).pinnedHead, 3);
  assert.equal(conversationOrderChanges(initial, ['p0', 'p2', 'p1', 'a', 'b', 'c'], 3).pinnedHead, 3);
  const staleLarge = ['p0', 'p1', 'p2', ...Array.from({ length: 12 }, (_, i) => 'unpinned-' + i), 'a', 'b'];
  const afterMessage = ['p0', 'p1', 'p2', 'b', ...staleLarge.slice(3).filter(id => id !== 'b')];
  assert.equal(conversationOrderChanges(staleLarge, afterMessage, 15).pinnedHead, 3);
  const ordinary = ['p0', 'p1', 'p2', 'new-pin', 'a', 'b'];
  assert.equal(conversationOrderChanges(ordinary, ['p0', 'p1', 'p2', 'new-pin', 'b', 'a'], 3).pinnedHead, 4);
  const addedPin = ['new-pin', ...initial];
  assert.equal(conversationOrderChanges(initial, addedPin, 3).pinnedHead, 3, 'a new ID at zero is ambiguous');
  assert.equal(conversationOrderChanges(addedPin, ['new-pin', 'p0', 'p1', 'p2', 'c', 'a', 'b'], 3).pinnedHead, 4);
});

test('after twelve pins are cancelled, a later ordinary arrival shrinks the remembered boundary to three', async t => {
  const pins = Array.from({ length: 15 }, (_, i) => 'p' + i), peers = Array.from({ length: 35 }, (_, i) => 'peer-' + i);
  const before = [...pins, ...peers], { a, order, setDirectory } = orderFixture(t, before);
  warmCache(a, before, { pinnedHead: 15 });
  setDirectory([pins[1], pins[0], ...pins.slice(2), ...peers]);
  await a.collect(); assert.equal(a.read('message-cache.json').pinnedHead, 15);
  const current = [pins[1], pins[0], pins[2], peers[20], ...pins.slice(3), ...peers.filter(id => id !== peers[20])];
  setDirectory(current); order.length = 0;
  const snap = await a.collect();
  assert.equal(snap.scope.pinnedHead, 3); assert.ok(order.includes(peers[20]));
  assert.ok(order.includes(current[4]) && order.includes(current[5]));
});

test('catalog-only records stay cached until the lookback cutoff and never contribute missing coverage', async t => {
  const ids = Array.from({ length: 10 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  const cache = warmCache(a, ids);
  const cutoff = NOW - 36 * 3600000;
  cache.conversations.gone = { version: 3, failureCount: 9, lastError: 'query-failed', messages: [
    { key: 'recent', at: NOW - 60000, text: 'retained synthetic text' }, { key: 'expired', at: cutoff - 1, text: 'expired synthetic text' }], coverage: { status: 'failed' } };
  a.write('message-cache.json', cache);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: [{ id: 'gone', name: 'synthetic gone peer', group: false, seenAt: NOW }] });
  const snap = await a.collect();
  assert.ok(!order.includes('gone')); assert.equal(snap.scope.retained, 1);
  assert.equal(snap.scope.partial, 0); assert.equal(snap.scope.neverFetched, 0);
  assert.deepEqual(snap.messages.gone.map(m => m.key), ['recent']);
  assert.deepEqual(a.read('message-cache.json').conversations.gone.messages.map(m => m.key), ['recent']);
  assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, 'ok');
});

for (const invalid of [false, true]) test(`consecutive ${invalid ? 'invalid-shape' : 'query-failed'} attempts retry first, warn on three, and reset on success`, async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i), target = ids[18], order = [];
  let fail = true;
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; order.push(id);
    return fail && id === target ? invalid ? json({ PRIVATE_BODY: 'must not enter cache errors' }) : { code: 1, stdout: '', stderr: 'PRIVATE_MESSAGE_BODY' } : json({ chatInfo: [] });
  });
  warmCache(a, ids);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    order.length = 0;
    const snap = await a.collect();
    const saved = a.read('message-cache.json').conversations[target];
    assert.equal(saved.failureCount, attempt); assert.equal(saved.lastError, invalid ? 'invalid-shape' : 'query-failed');
    assert.doesNotMatch(JSON.stringify({ failureCount: saved.failureCount, lastError: saved.lastError }), /PRIVATE/);
    if (attempt > 1) assert.equal(order[0], target);
    const row = queryStatus(messageCoverage(snap.scope), null, 0);
    assert.equal(row.color, attempt < 3 ? 'ok' : 'warn');
    if (attempt < 3) { assert.equal(snap.scope.partial, 0); assert.match(row.detail, /1 个会话查询失败，下轮重试/); }
    else { assert.equal(snap.scope.partial, 1); assert.match(row.detail, new RegExp('同事' + target)); assert.match(row.detail, /query-failed|invalid-shape/); }
  }
  fail = false; order.length = 0;
  const final = await a.collect(); assert.equal(order[0], target);
  assert.equal(a.read('message-cache.json').conversations[target].failureCount, 0);
  assert.equal(a.read('message-cache.json').conversations[target].lastError, '');
  assert.equal(final.scope.partial, 0); assert.equal(final.scope.retrying, 0);
});

test('manual refresh stays incremental when due; a timer then audits only the current directory', async t => {
  const ids = Array.from({ length: 50 }, (_, i) => 'peer-' + i), { a, order, root } = orderFixture(t, ids);
  const old = warmCache(a, ids, { lastFullCheckAt: NOW - 2 * MESSAGE_FULL_CHECK_MS });
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: [{ id: 'gone', name: 'synthetic gone', seenAt: NOW }] });
  const manual = await a.refresh({ force: true, priority: 'user', trigger: 'manual' });
  assert.equal(manual.scope.mode, 'incremental'); assert.equal(order.length, 8);
  assert.equal(a.read('message-cache.json').lastFullCheckAt, old.lastFullCheckAt);
  order.length = 0;
  const timed = await a.refresh({ force: true });
  assert.equal(timed.scope.mode, 'full-check'); assert.equal(order.length, 50); assert.ok(!order.includes('gone'));
  const logs = fs.readFileSync(path.join(root, 'logs/company-assistant-message-round.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs[0].trigger, 'manual'); assert.equal(logs[0].fullCheckReason, 'manual');
  assert.equal(logs[1].trigger, 'timer'); assert.equal(logs[1].fullCheckReason, 'due');
});

test('round diagnostics include only bounded counts and flags, rotate and enter feedback logs', async t => {
  const ids = ['PRIVATE_ID', 'b', 'c'], { a, root } = orderFixture(t, ids);
  warmCache(a, ids); await a.collect(); await a.collectQuery('messages', RANGE);
  const file = path.join(root, 'logs/company-assistant-message-round.log');
  const text = fs.readFileSync(file, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[1].trigger, 'query');
  for (const row of rows) {
    assert.ok(Date.parse(row.startedAt) <= Date.parse(row.endedAt)); assert.ok(row.durationMs >= 0);
    assert.deepEqual(Object.keys(row.requests), ['changed', 'pinnedTop', 'ordinaryTop', 'rotation', 'retry', 'full']);
    assert.equal(typeof row.failed, 'number'); assert.equal(typeof row.rateLimited, 'boolean'); assert.equal(typeof row.timedOut, 'boolean');
  }
  assert.doesNotMatch(text, /PRIVATE_ID|合成同事|synthetic saved record|synthetic text/);
  assert.equal(MESSAGE_ROUND_LOG_MAX_BYTES, 256 * 1024);
  recordMessageRound(root, { startedAt: NOW, endedAt: NOW, trigger: 'timer', requests: {}, PRIVATE_ID: 'PRIVATE_BODY' }, 1);
  assert.ok(fs.existsSync(file + '.1')); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE/);
  const bundle = collectBundle({ logsDir: path.join(root, 'logs') });
  assert.match(bundle.text, /company-assistant-message-round.log/);
});

test('自己存的常用标签可悬停删除，内置标签不能删', () => {
  const code = fs.readFileSync(path.join(__dirname, '../renderer/company-assistant-page.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/company-assistant-page.css'), 'utf8');
  assert.match(code, /c\.custom \? `<span class="ca-chip-wrap">\$\{chip\}<button[^`]*data-ca="del-chip:\$\{i - customChipStart\}"/);
  assert.match(code, /verb === 'del-chip'[\s\S]{0,200}call\('set-settings', \{ chips: data\.settings\.chips\.filter/);
  assert.match(css, /\.ca-chip-del\{[^}]*opacity:0;pointer-events:none/);
  assert.match(css, /\.ca-chip-wrap:hover \.ca-chip-del[^{]*\{opacity:1;pointer-events:auto\}/);
});

test('用户点刷新时后台定时这一轮在会话之间让路：没轮到的会话留到下一轮，不丢', async t => {
  const ids = Array.from({ length: 30 }, (_, i) => 'peer-' + i), { a, order } = orderFixture(t, ids);
  a.yieldToUser = true;
  await a.collect();
  assert.equal(order.length, 0);
  const cache = a.read('message-cache.json');
  assert.ok(ids.every(id => cache.deferred.includes(id)));
  a.yieldToUser = false;
  await a.refresh({ force: true, priority: 'user', trigger: 'manual' });
  assert.ok(order.length > 0);
});
