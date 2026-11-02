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
const { CompanyAssistant, changedConversationIds, conversationOrderChanges, BACKGROUND_HISTORY_INTERVAL_MS, BACKGROUND_HISTORY_REQUEST_LIMIT, BACKGROUND_RECENT_REQUEST_LIMIT, BACKGROUND_PINNED_REQUEST_LIMIT } = require('../core/company-assistant/service');
const { messageCoverage, queryStatus, queryRows, refreshNotice } = require('../renderer/company-assistant-query-status');
const { collectBundle } = require('../core/hub-feedback');

const NOW = Date.parse('2026-11-02T12:00:00+08:00');
const RANGE = { start: Date.parse('2026-11-02T00:00:00+08:00'), end: Date.parse('2026-11-03T00:00:00+08:00') };
const TABLE = 'Subject Start End Location Status Organizer ItemId\n------- ----- --- -------- ------ --------- ------\nPRIVATE_SUBJECT PRIVATE_ACCOUNT';
const TABLE_UPGRADE = 'welink-cli 返回了无法解析的表格，请升级：npm install -g @welink/welink-cli@latest（1.0.19 已验证正常）';
const reply = stdout => ({ code: 0, stdout, stderr: '' });
const json = value => reply(JSON.stringify(value));

function fixture(t, override = async () => undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-query-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  assert.deepEqual(logs()[0], { at: new Date(NOW).toISOString(), command: 'calendar list', cliVersion: '1.0.14', keys: [], businessCodes: [],
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
  assert.equal(snap.scope.partial, 1);
  assert.equal(snap.scope.conversations.find(c => c.id === 'bad').status, 'failed');
  const error = snap.errors.find(e => e.label.startsWith('消息'));
  assert.equal(error.text, 'fixture query failed');
  assert.deepEqual(queryStatus(messageCoverage(snap.scope), error, 0), { label: '未取全', color: 'warn', detail: '1 个会话未取全' });
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

const rateReply = (code = 1) => ({ code, stdout: '', stderr: 'Error: Query message history failed (status 429)' });
const historyArgs = ['im', 'query-history-message', '--user-account', 'fixture-peer', '--query-count', '100'];
const conversationRows = ids => ids.map(id => ({ target_account: id, native_name: '同事' + id, group_id: '0' }));
const historyRows = (id, count = 1) => Array.from({ length: count }, (_, i) => ({ msgId: String(100 + i), sender: id, content: 'fixture message ' + i, serverSendTime: NOW - 60000 }));

for (const result of [rateReply(), rateReply(0), { code: 0, stdout: rateReply().stderr, stderr: '' }, { code: 429, stdout: '', stderr: '' }, { code: '429', stdout: '', stderr: '' }]) {
  test(`history rate limit exit ${result.code} stdout=${!!result.stdout} stderr=${!!result.stderr} never retries format`, async () => {
    const calls = [];
    await assert.rejects(Q.readJson(async args => { calls.push(args); return result; }, historyArgs), error => error.code === Q.MESSAGE_RATE_LIMITED);
    assert.deepEqual(calls, [historyArgs]);
  });
}

test('a rate limit on an existing format retry propagates without another request', async () => {
  const calls = [];
  await assert.rejects(Q.readJson(async args => { calls.push(args); return calls.length === 1 ? reply('fixture non-json') : rateReply(0); }, historyArgs), error => error.code === Q.MESSAGE_RATE_LIMITED);
  assert.deepEqual(calls, [historyArgs, [...historyArgs, '--format', 'json']]);
});

test('the history rate-limit code does not apply to calendar, meetings, or mail commands', async () => {
  for (const args of [['calendar', 'list'], ['meeting', 'query-list'], ['mail', 'list']]) {
    await assert.rejects(Q.readJson(async () => rateReply(), args), error => error.code !== Q.MESSAGE_RATE_LIMITED && error.message.includes('status 429'));
  }
});

test('rate limiting stops the round, preserves cached messages, and resumes deferred IDs first across restarts', async t => {
  const ids = ['a', 'b', 'c', 'd'], order = [];
  let round = 1;
  const { a, calls, root } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ code: 0, conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; order.push(id);
    return round === 1 && id === 'b' || round === 2 && id === 'd' ? rateReply(0) : json({ code: 0, chatInfo: [] });
  });
  const cache = Object.fromEntries(ids.map(id => {
    const conv = { id, name: '同事' + id, group: false };
    return [id, { version: 3, newest: '100', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages: D.messages({ chatInfo: historyRows(id) }, conv, 'fixture-owner') }];
  }));
  a.write('message-cache.json', { version: 3, identity: 'fixture-owner', conversations: cache });
  const first = await a.collect();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(first.scope.fetched, 2);
  assert.equal(first.scope.completed, 1);
  assert.equal(first.scope.partial, 3);
  assert.deepEqual(first.scope.conversations.map(c => [c.id, c.status, c.reason]), [
    ['a', 'complete', 'exhausted'], ['b', 'partial', 'rate-limited'], ['c', 'partial', 'deferred'], ['d', 'partial', 'deferred'],
  ]);
  for (const id of ids) assert.equal(first.messages[id][0].text, 'fixture message 0');
  assert.deepEqual(a.read('message-cache.json').deferred, ['c', 'd', 'b']);
  assert.equal(a.read('message-cache.json').version, 4);
  assert.deepEqual(first.errors, [{ label: '消息', text: 'WeLink 限流，已取 1 个会话，其余下轮继续' }]);
  assert.deepEqual(queryStatus(messageCoverage(first.scope), first.errors[0], 4), { label: '未取全', color: 'warn', detail: 'WeLink 限流，已取 1 个会话，其余下轮继续' });
  assert.equal(messageCoverage(first.scope).reason, 'rate-limited');
  assert.equal(refreshNotice(first), '有 1 项未取全：消息');
  assert.equal(first.meetingCoverage.status, 'complete');
  assert.equal(first.calendarCoverage.status, 'complete');
  assert.equal(first.mailCoverage.status, 'complete');
  assert.ok(calls.some(args => args[0] === 'mail'), 'mail is still queried after the message circuit opens');

  const restart = () => {
    const service = new CompanyAssistant({ ...a.deps, dataDir: root });
    service.cli = a.cli; service.auth.check = a.auth.check; service.auth.status = a.auth.status;
    return service;
  };
  round = 2; order.length = 0;
  const second = await restart().collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, ['c', 'd']);
  assert.deepEqual(a.read('message-cache.json').deferred, ['b', 'a', 'd']);
  assert.equal(second.scope.conversations.find(c => c.id === 'c').status, 'complete');
  round = 3; order.length = 0;
  const third = await restart().collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, ['b', 'a', 'd', 'c']);
  assert.deepEqual(a.read('message-cache.json').deferred, []);
  assert.equal(third.scope.partial, 0);
  assert.equal(third.scope.rateLimited, false);
  assert.equal(third.errors.length, 0);
  for (const id of ids) assert.equal(third.messages[id][0].text, 'fixture message 0');
});

test('a history page rate limit preserves messages fetched earlier in the same conversation', async t => {
  const { a } = fixture(t);
  let calls = 0;
  const got = await a.conversationHistory({ id: 'peer', name: '同事', group: false }, null, NOW - 3600000, 'fixture-owner', '',
    (label, args) => Q.readJson(async () => ++calls === 1 ? json({ chatInfo: historyRows('peer', 100) }) : rateReply(), args));
  assert.equal(calls, 2);
  assert.equal(got.messages.length, 100);
  assert.equal(got.coverage.status, 'partial');
  assert.equal(got.coverage.reason, 'rate-limited');
  assert.equal(got.coverage.pages, 2);
  assert.equal(got.cache.messages.length, 100);
});

test('background history throttles pages with a fake clock and counts CLI time toward the interval', async t => {
  const starts = [];
  const { a, sleeps, clock, advance } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a', 'b']) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock());
    advance(starts.length === 1 ? 1500 : starts.length === 2 ? 5000 : 0);
    return json({ chatInfo: starts.length === 1 ? historyRows('a', 100) : [] });
  });
  await a.collect();
  assert.equal(BACKGROUND_HISTORY_INTERVAL_MS, 5000);
  assert.deepEqual(starts, [NOW, NOW + 5000, NOW + 10000]);
  assert.deepEqual(sleeps, [3500]);
});

test('background history throttles format retries and the first request of a later refresh', async t => {
  const starts = [];
  const { a, sleeps, clock } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a']) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock());
    return starts.length === 1 ? reply('fixture non-json') : json({ chatInfo: [] });
  });
  await a.collect(); await a.collect();
  assert.deepEqual(starts, [NOW, NOW + 5000, NOW + 10000]);
  assert.deepEqual(sleeps, [5000, 5000]);
});

test('immediate assistant message queries share pagination but add no background throttle', async t => {
  const starts = [];
  const { a, sleeps, clock } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(['a', 'b']) });
    if (args[1] !== 'query-history-message') return undefined;
    starts.push(clock());
    return json({ chatInfo: starts.length === 1 ? historyRows('a', 100) : [] });
  });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(starts, [NOW, NOW, NOW]);
  assert.deepEqual(sleeps, []);
  assert.equal(snap.scope.partial, 0);
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

for (const seeded of [true, false]) {
  test(`background 6+6 request rotation with ${seeded ? 'cached' : 'new'} conversations stays non-warning and reaches the tail`, async t => {
    const ids = Array.from({ length: 50 }, (_, i) => 'peer-' + i), order = [], seen = new Set();
    const { a } = fixture(t, async args => {
      if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
      if (args[1] === 'query-history-message') {
        const id = args[args.indexOf('--user-account') + 1]; order.push(id); seen.add(id);
        return json({ resultCode: '0', respData: { chatInfo: [], maxMsgId: 0, minMsgId: 0, msgTotalCount: 0 } });
      }
      return undefined;
    });
    if (seeded) a.write('message-cache.json', { version: 3, identity: 'fixture-owner', conversations: Object.fromEntries(ids.map(id => [id, {
      version: 3, newest: '100', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages: D.messages({ chatInfo: historyRows(id) }, { id, name: '同事' + id, group: false }, 'fixture-owner'),
    }])) });
    const first = await a.collect();
    assert.equal(BACKGROUND_HISTORY_REQUEST_LIMIT, 12);
    assert.equal(BACKGROUND_RECENT_REQUEST_LIMIT, 6);
    assert.deepEqual(order, ids.slice(0, 12));
    assert.equal(first.scope.requests, 12);
    assert.equal(first.scope.completed, 12);
    assert.equal(first.scope.partial, 0);
    assert.equal(first.scope.neverFetched, seeded ? 0 : 38);
    assert.equal(first.errors.length, 0);
    const status = queryStatus(messageCoverage(first.scope), null, 0);
    assert.equal(status.label, '轮转中');
    assert.equal(status.color, 'ok');
    assert.match(status.detail, /其余定期核对（本轮更新 12\/50 个会话）/);
    assert.equal(status.detail.includes('38 个会话尚未首次取到'), !seeded);
    assert.equal(refreshNotice(first), '');
    assert.deepEqual(a.read('message-cache.json').deferred, ids.slice(12));
    if (seeded) {
      assert.equal(first.messages['peer-49'][0].text, 'fixture message 0');
      assert.equal(a.read('message-cache.json').conversations['peer-49'].coverage.status, 'complete', 'rotation preserves the actual cached coverage for later incremental queries');
    }
    order.length = 0;
    await a.collect();
    assert.deepEqual(order, [ids[0], ...ids.slice(12, 23)]);
    for (let round = 0; round < 6; round += 1) {
      order.length = 0;
      const snap = await a.collect();
      assert.equal(snap.scope.requests, 12);
      assert.equal(order.length, 12);
      assert.equal(order[0], ids[0]);
      assert.equal(snap.errors.length, 0);
    }
    assert.equal(seen.size, 50, 'the deferred tail is not starved by the six recent conversations');
  });
}

test('background request budgets include pagination and reserve six requests for deferred conversations', async t => {
  const order = [];
  let pages = 0;
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(Array.from({ length: 20 }, (_, i) => 'peer-' + i)) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; order.push(id);
    if (id !== 'peer-0') return json({ chatInfo: [] });
    pages += 1;
    return json({ chatInfo: historyRows(id, 100).map((m, i) => ({ ...m, msgId: String(10000 - pages * 100 - i) })) });
  });
  const snap = await a.collect();
  assert.deepEqual(order, [...Array(6).fill('peer-0'), ...Array.from({ length: 6 }, (_, i) => 'peer-' + (i + 1))]);
  assert.equal(snap.scope.requests, 12);
  assert.equal(snap.mails.length, 0);
  assert.equal(snap.messages['peer-0'].length, 600);
  assert.equal(snap.scope.conversations.find(c => c.id === 'peer-0').status, 'rotating');
  assert.equal(snap.errors.length, 0);
  assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).color, 'ok');
});

test('immediate queries have no background request budget and still stop on actual 429', async t => {
  const order = [];
  const { a, sleeps } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(Array.from({ length: 20 }, (_, i) => 'peer-' + i)) });
    if (args[1] !== 'query-history-message') return undefined;
    order.push(args[args.indexOf('--user-account') + 1]);
    return order.length === 15 ? rateReply() : json({ chatInfo: [] });
  });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.equal(order.length, 15);
  assert.equal(snap.scope.completed, 14);
  assert.equal(snap.scope.rateLimited, true);
  assert.equal(snap.errors.length, 1);
  assert.deepEqual(sleeps, []);
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

test('format retries consume the background request budget without producing rotation errors', async t => {
  let calls = 0;
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(Array.from({ length: 20 }, (_, i) => 'peer-' + i)) });
    if (args[1] !== 'query-history-message') return undefined;
    calls += 1;
    return args.includes('--format') ? json({ chatInfo: [] }) : reply('fixture non-json');
  });
  const snap = await a.collect();
  assert.equal(calls, 12);
  assert.equal(snap.scope.requests, 12);
  assert.equal(snap.scope.completed, 6);
  assert.equal(snap.scope.neverFetched, 14);
  assert.equal(snap.errors.length, 0);
  assert.equal(queryStatus(messageCoverage(snap.scope), null, 0).label, '轮转中');
});

test('pagination interrupted by the six-request budget resumes its saved cursor next round', async t => {
  const history = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(Array.from({ length: 20 }, (_, i) => 'peer-' + i)) });
    if (args[1] !== 'query-history-message') return undefined;
    if (!args.includes('peer-0')) return json({ chatInfo: [] });
    history.push(args);
    const before = args.includes('--message-id') ? Number(args[args.indexOf('--message-id') + 1]) : 10000;
    const rows = before > 9300 ? historyRows('peer-0', 100).map((m, i) => ({ ...m, msgId: String(before - i - 1) })) : [];
    return json({ chatInfo: rows });
  });
  const first = await a.collect();
  assert.equal(first.messages['peer-0'].length, 600);
  assert.equal(a.read('message-cache.json').conversations['peer-0'].resume.cursor, '9400');
  const second = await a.collect();
  assert.equal(history[6][history[6].indexOf('--message-id') + 1], '9400');
  assert.equal(history[6][history[6].indexOf('--query-direction') + 1], '0');
  assert.equal(second.messages['peer-0'].length, 700);
  assert.equal(second.scope.conversations.find(c => c.id === 'peer-0').status, 'complete');
  assert.equal(a.read('message-cache.json').conversations['peer-0'].resume, undefined);
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
  assert.deepEqual(starts, [NOW, NOW + 5000]);
  assert.deepEqual(sleeps, [5000]);
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

test('50 directory conversations rotate again within eight rounds despite 200 historical conversations ahead in deferred', async t => {
  const recent = Array.from({ length: 50 }, (_, i) => 'recent-' + i), historical = Array.from({ length: 200 }, (_, i) => 'historical-' + i);
  const order = [], updated = new Map(), counts = new Map();
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(recent) });
    if (args[1] !== 'query-history-message') return undefined;
    order.push(args[args.indexOf('--user-account') + 1]);
    return json({ chatInfo: [] });
  });
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: historical.map(id => ({ id, name: '历史同事' + id, group: false, seenAt: NOW - 86400000 })) });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', deferred: [...historical, ...recent.slice(6), ...recent.slice(0, 6)],
    conversations: Object.fromEntries(historical.map(id => [id, { version: 3, newest: '100', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages: [], hasFetched: true }])) });
  for (let round = 0; round < 16; round += 1) {
    order.length = 0;
    const snap = await a.collect();
    assert.equal(snap.scope.requests, 12);
    assert.equal(order[0], recent[0]);
    assert.ok(order.every(id => recent.includes(id)), 'historical entries wait until all directory conversations have no pending update');
    for (const id of order) { updated.set(id, round); counts.set(id, (counts.get(id) || 0) + 1); }
    if (round === 0) assert.deepEqual(order.slice(6), recent.slice(6, 12), 'deferred order is preserved within the directory group');
    if (round >= 7) for (const id of recent) assert.ok(updated.has(id) && updated.get(id) >= round - 7, `${id} must update in every eight-round window`);
    const stored = a.read('message-cache.json');
    for (const id of historical) {
      assert.ok(stored.deferred.includes(id), 'historical deferred entries are retained');
      assert.equal(stored.conversations[id].coverage.status, 'complete', 'historical caches are retained');
    }
  }
  assert.ok(recent.every(id => counts.get(id) >= 2), 'every directory conversation gets a later update, not just its first fetch');
});

test('historical conversations use spare rotation slots in deferred order after directory conversations are updated', async t => {
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
  assert.deepEqual(order, [...recent, ...deferred]);
  assert.equal(snap.scope.requests, 11);
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

test('unchanged directory prioritizes only its first conversation and transfers five unused requests to rotation', async t => {
  const ids = Array.from({ length: 30 }, (_, i) => 'peer-' + i);
  const { a, order, sleeps } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, conversations: {}, deferred: [...ids.slice(10), ...ids.slice(0, 10)] });
  const snap = await a.collect();
  assert.deepEqual(order, [ids[0], ...ids.slice(10, 21)]);
  assert.equal(snap.scope.requests, 12);
  assert.equal(snap.scope.changed, 1);
  assert.equal(snap.scope.comparedOrder, true);
  assert.equal(snap.scope.pinnedHead, 0);
  assert.equal(snap.scope.pinnedRequests, 0);
  assert.equal(snap.errors.length, 0);
  assert.ok(sleeps.every(ms => ms === 5000));
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
    assert.equal(snap.scope.requests, 12);
    assert.deepEqual(a.read('message-cache.json').directoryOrder, current);
  });
}

test('changed overflow is stored at the deferred front and resumed before newly detected candidates after restart', async t => {
  const before = Array.from({ length: 20 }, (_, i) => 'peer-' + i), current = [...before].reverse();
  const { a, order } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: before });
  const first = await a.collect();
  assert.deepEqual(order.slice(0, 6), current.slice(0, 6));
  assert.equal(first.scope.changed, 20);
  const pending = current.filter(id => !order.includes(id)), saved = a.read('message-cache.json');
  assert.ok(pending.length > 6);
  assert.deepEqual(saved.priorityDeferred, pending);
  assert.deepEqual(saved.deferred.slice(0, pending.length), pending);
  order.length = 0;
  const restarted = new CompanyAssistant(a.deps);
  restarted.cli = a.cli; restarted.auth.check = a.auth.check; restarted.auth.status = a.auth.status;
  const second = await restarted.collect();
  assert.equal(second.scope.changed, 1);
  assert.deepEqual(order.slice(0, 6), pending.slice(0, 6));
  assert.equal(second.scope.requests, 12);
  assert.ok(pending.every(id => order.includes(id)), 'overflow continues through both priority and regular deferred work');
});

for (const version of [undefined, 2, 3, 4]) {
  test(`cache version ${version ?? 'unversioned'} without directory order falls back to the first six and remains readable`, async t => {
    const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
    const { a, order } = orderFixture(t, ids);
    a.write(`raw-${D.dayKey(NOW)}.json`, { login: { uid: 'fixture-owner' } });
    a.write('message-cache.json', version === undefined ? {} : { version, identity: 'fixture-owner', conversations: {}, deferred: [...ids].reverse() });
    const snap = await a.collect();
    assert.deepEqual(order.slice(0, 6), ids.slice(0, 6));
    assert.equal(snap.scope.comparedOrder, false);
    assert.equal(snap.scope.changed, ids.length);
    assert.equal(snap.scope.requests, 12);
    assert.deepEqual(a.read('message-cache.json').directoryOrder, ids);
  });
}

test('directory order and priority candidates from another identity are ignored', async t => {
  const ids = Array.from({ length: 20 }, (_, i) => 'peer-' + i);
  const { a, order } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'PRIVATE_OTHER_OWNER', directoryOrder: [...ids].reverse(), priorityDeferred: [...ids].reverse(), conversations: {}, deferred: [...ids].reverse() });
  const snap = await a.collect();
  assert.equal(snap.scope.comparedOrder, false);
  assert.deepEqual(order, ids.slice(0, 12));
  assert.equal(a.read('message-cache.json').identity, 'fixture-owner');
  assert.ok(!JSON.stringify(a.read('message-cache.json')).includes('PRIVATE_OTHER_OWNER'));
});

test('a dropped directory conversation stays available through catalog rotation without entering the saved directory order', async t => {
  const { a, order } = orderFixture(t, ['a', 'c']);
  a.write('conversation-catalog.json', { identity: 'fixture-owner', conversations: [{ id: 'b', name: '历史同事', group: false, seenAt: NOW - 86400000 }] });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ['a', 'b', 'c'], conversations: {}, deferred: ['b', 'c', 'a'] });
  await a.collect();
  assert.deepEqual(order, ['a', 'c', 'b']);
  const cache = a.read('message-cache.json');
  assert.deepEqual(cache.directoryOrder, ['a', 'c']);
  assert.ok(cache.conversations.b);
});

test('immediate queries keep background directory order intact and do not use changed-priority scheduling', async t => {
  const before = ['a', 'b', 'c', 'd'], current = ['c', 'a', 'b', 'd'];
  const { a, order, root, sleeps } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, conversations: {}, deferred: ['d', 'b', 'a', 'c'] });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, ['d', 'b', 'a', 'c']);
  assert.deepEqual(a.read('message-cache.json').directoryOrder, before);
  assert.equal(snap.scope.changed, undefined);
  assert.deepEqual(sleeps, []);
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
  assert.deepEqual(order, [before[5]]);
  assert.equal(first.scope.rateLimited, true);
  assert.equal(first.scope.requests, 1);
  assert.equal(first.errors.length, 1);
  assert.deepEqual(a.read('message-cache.json').priorityDeferred, [before[5], before[0]]);
  limited = false; order.length = 0;
  const second = await a.collect();
  assert.deepEqual(order.slice(0, 2), [before[5], before[0]]);
  assert.equal(second.scope.requests, 12);
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
  assert.ok(changes.changed.every(id => !pins.includes(id)), 'pinned conversations cannot consume the changed-priority budget');
  assert.deepEqual(conversationOrderChanges(current, current, 10), { moved: [], changed: [ordinary[5]], pinnedHead: 10 });
  const front = [ordinary[5], ...before.filter(id => id !== ordinary[5])];
  assert.equal(conversationOrderChanges(current, front, 10).pinnedHead, 0, 'moving to the true head resets the estimate');
});

test('one stable boundary is added after each separate overtaking block', () => {
  const before = ['p0', 'p1', 'a', 'b', 'c', 'd', 'e', 'f'], current = ['p0', 'p1', 'c', 'a', 'b', 'f', 'd', 'e'];
  assert.deepEqual(conversationOrderChanges(before, current), { moved: ['c', 'f'], changed: ['c', 'a', 'f', 'd'], pinnedHead: 2 });
  assert.deepEqual(conversationOrderChanges(current, current), { moved: [], changed: ['p0'], pinnedHead: 0 }, 'old caches default to no pinned prefix');
});

test('estimated pinned conversations rotate by oldest query time within three requests while ordinary rotation remains active', async t => {
  const pins = Array.from({ length: 10 }, (_, i) => 'pin-' + i), ordinary = Array.from({ length: 40 }, (_, i) => 'peer-' + i);
  const before = [...pins, ...ordinary], current = [...pins, ordinary[5], ...ordinary.filter(id => id !== ordinary[5])];
  const { a, order } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: before, pinnedHead: 0, deferred: before,
    conversations: Object.fromEntries(pins.map((id, i) => [id, { version: 3, newest: '100', since: NOW - 36 * 3600000, coverage: { status: 'complete' }, messages: [], hasFetched: true, lastQueriedAt: NOW - (i + 1) * 3600000 }])) });
  const updated = new Map(), counts = new Map(), ordinarySeen = new Set();
  for (let round = 0; round < 8; round += 1) {
    order.length = 0;
    const snap = await a.collect();
    assert.equal(snap.scope.pinnedHead, 10);
    assert.equal(a.read('message-cache.json').pinnedHead, 10);
    assert.equal(snap.scope.pinnedRequests, 3);
    assert.equal(BACKGROUND_PINNED_REQUEST_LIMIT, 3);
    assert.equal(snap.scope.requests, 12);
    assert.equal(snap.errors.length, 0);
    assert.equal(order.filter(id => pins.includes(id)).length, 3, 'ordinary rotation does not select the pinned group a second time');
    if (round === 0) {
      assert.deepEqual(order.slice(0, 2), [ordinary[5], ordinary[0]]);
      assert.deepEqual(order.slice(2, 5), [pins[9], pins[8], pins[7]], 'oldest queried pinned conversations go first');
    } else assert.equal(order[0], current[10], 'unchanged order checks the non-pinned boundary');
    for (const id of order) if (pins.includes(id)) { updated.set(id, round); counts.set(id, (counts.get(id) || 0) + 1); } else ordinarySeen.add(id);
    if (round >= 3) for (const id of pins) assert.ok(updated.has(id) && updated.get(id) >= round - 3, `${id} is checked within every four-round window`);
  }
  assert.ok(pins.every(id => counts.get(id) >= 2));
  assert.equal(ordinarySeen.size, 40, 'all ordinary conversations retain rotation fallback');
});

test('the pinned request cap counts retries rather than just pinned conversations', async t => {
  const pins = ['p0', 'p1', 'p2', 'p3'], ordinary = Array.from({ length: 20 }, (_, i) => 'peer-' + i), ids = [...pins, ...ordinary];
  const calls = [];
  const { a } = fixture(t, async args => {
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: conversationRows(ids) });
    if (args[1] !== 'query-history-message') return undefined;
    const id = args[args.indexOf('--user-account') + 1]; calls.push(id);
    return pins.includes(id) && !args.includes('--format') ? reply('fixture non-json') : json({ chatInfo: [] });
  });
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 4, conversations: {}, deferred: ids });
  const snap = await a.collect();
  assert.equal(snap.scope.requests, 12);
  assert.equal(snap.scope.pinnedRequests, 3);
  assert.equal(calls.filter(id => pins.includes(id)).length, 3);
  assert.equal(snap.errors.length, 0);
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
  assert.deepEqual(order, ['a', 'p0']);
  assert.equal(snap.scope.rateLimited, true);
  assert.equal(snap.scope.requests, 2);
  assert.equal(snap.scope.pinnedRequests, 1);
  assert.equal(snap.errors.length, 1);
  assert.equal(a.read('message-cache.json').pinnedHead, 2);
});

test('immediate queries preserve pinned estimates and query timestamps without applying pinned scheduling', async t => {
  const ids = ['p0', 'p1', 'a', 'b'];
  const { a, order, sleeps } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 2, deferred: ['b', 'p1', 'a', 'p0'],
    conversations: { p0: { version: 3, coverage: { status: 'complete' }, messages: [], lastQueriedAt: NOW - 3600000 } } });
  const snap = await a.collectQueryUnlocked('messages', RANGE);
  assert.deepEqual(order, ['b', 'p1', 'a', 'p0']);
  assert.deepEqual(sleeps, []);
  assert.equal(snap.scope.pinnedHead, undefined);
  const saved = a.read('message-cache.json');
  assert.equal(saved.pinnedHead, 2);
  assert.equal(saved.conversations.p0.lastQueriedAt, NOW - 3600000);
});

test('pinned query timestamps persist across restart so later pinned conversations get the next slots', async t => {
  const pins = Array.from({ length: 10 }, (_, i) => 'pin-' + i), ids = [...pins, ...Array.from({ length: 20 }, (_, i) => 'peer-' + i)];
  const { a, order } = orderFixture(t, ids);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: ids, pinnedHead: 10, conversations: {}, deferred: ids });
  await a.collect();
  assert.deepEqual(order.filter(id => pins.includes(id)), pins.slice(0, 3));
  const saved = a.read('message-cache.json');
  assert.ok(pins.slice(0, 3).every(id => Number.isFinite(saved.conversations[id].lastQueriedAt)));
  order.length = 0;
  const restarted = new CompanyAssistant(a.deps);
  restarted.cli = a.cli; restarted.auth.check = a.auth.check; restarted.auth.status = a.auth.status;
  await restarted.collect();
  assert.deepEqual(order.filter(id => pins.includes(id)), pins.slice(3, 6));
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
  assert.deepEqual(order, ids.slice(0, 12));
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

test('the verified three-pinned swap prioritizes moved and boundary before the pinned request allowance', async t => {
  const previous = ['1', '2', '3', '4', '5'], current = ['1', '2', '3', '5', '4'];
  const { a, order } = orderFixture(t, current);
  a.write('message-cache.json', { version: 4, identity: 'fixture-owner', directoryOrder: previous, conversations: {}, deferred: previous });
  const snap = await a.collect();
  assert.deepEqual(order.slice(0, 2), ['5', '4']);
  assert.equal(snap.scope.pinnedHead, 3);
  assert.equal(snap.scope.changed, 2);
  assert.deepEqual(a.read('message-cache.json').directoryOrder, current);
});
