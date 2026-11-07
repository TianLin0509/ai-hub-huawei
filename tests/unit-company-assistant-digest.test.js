'use strict';
// Synthetic snapshots/PTY-free UI fixtures only; no real WeLink data or account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const D = require('../core/company-assistant/data');
const R = require('../core/company-assistant/reminders');
const { CompanyAssistant, DEFAULT_SETTINGS } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const G = require('../core/company-assistant/digest');
const { SpeechQueue, speakGate, localDateKey } = require('../core/hub-pet/state');
const { digestList } = require('../renderer/company-assistant-digest');
const NOW = Date.parse('2026-11-02T10:00:00+08:00');
// 默认关（11-07 接手时定，与「等你回复」提醒重复）；这里按用户打开「每 2 小时」来测。
const settings = { ...DEFAULT_SETTINGS, digestHours: 2 };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const message = (key, extra = {}) => ({ sourceId: 'msg:p:' + key, key, conv: 'p', convName: '联系人', group: false,
  text: '需要处理的正文', sender: '联系人', at: NOW - 31 * 60000, mine: false, ...extra });
function snapshot(extra = {}) { return { day: D.dayKey(NOW), at: NOW, login: { ok: true, uid: 'fixture-owner' },
  meetings: [], calendar: [], mails: [], conversations: [{ id: 'p', name: '联系人', group: false }], messages: { p: [message('one')] }, ...extra }; }
const plan = (extra = {}) => G.digestPlan({ snapshot: snapshot(), settings, now: NOW, ...extra });

function fixture(t, extraDeps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-digest-'));
  const instances = [];
  let time = NOW, gateCalls = 0;
  const create = () => {
    const bus = new NoticeBus({ now: () => time });
    const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, now: () => time, bus,
      getSession: () => null, resolveCli: () => null,
      welinkGate: { run: async () => { gateCalls += 1; throw new Error('digest must not query WeLink'); } }, ...extraDeps });
    a.cli = () => null;
    instances.push(a);
    return a;
  };
  const a = create(); a.setSettings({ digestHours: 2 }); a.write('raw-' + D.dayKey(time) + '.json', snapshot());
  t.after(() => { for (const item of instances) item.digest.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'assistant-digest-'))); fs.rmSync(root, { recursive: true, force: true }); });
  return { a, root, create, setTime: value => { time = value; }, gateCalls: () => gateCalls,
    put: data => a.write('raw-' + D.dayKey(time) + '.json', data) };
}

for (const [date, eligible] of [
  ['2026-11-02T08:59:59+08:00', false], ['2026-11-02T09:00:00+08:00', true],
  ['2026-11-02T19:59:59+08:00', true], ['2026-11-02T20:00:00+08:00', false],
  ['2026-11-07T10:00:00+08:00', false],
]) test(`digest Shanghai workday window: ${date}`, () => {
  assert.equal(!!plan({ now: Date.parse(date) }), eligible);
});

test('digest interval is based on persisted last check; disabled and incomplete intervals do not check', () => {
  assert.equal(plan({ state: { lastCheckedAt: NOW - 2 * 3600000 + 1 } }), null);
  assert.ok(plan({ state: { lastCheckedAt: NOW - 2 * 3600000 } }));
  assert.equal(plan({ settings: { ...settings, digestHours: 0 } }), null);
});

test('private reply threshold is strictly more than 30 minutes; a later own reply and missing times exclude it', () => {
  for (const [at, count] of [[NOW - 30 * 60000, 0], [NOW - 30 * 60000 - 1, 1], [null, 0]]) {
    assert.equal(G.digestItems(snapshot({ messages: { p: [message('one', { at })] } }), { settings, now: NOW }).length, count);
  }
  assert.equal(G.digestItems(snapshot({ messages: { p: [message('one'), message('reply', { mine: true, at: NOW - 1000 })] } }), { settings, now: NOW }).length, 0);
});

test('@you is removed only in digest when a later own group message exists; the original awaiting rule is untouched', () => {
  const hit = message('at', { sourceId: 'msg:g:at', conv: 'g', group: true, atMe: true });
  const group = snapshot({ conversations: [{ id: 'g', group: true }], messages: { g: [hit] } });
  assert.equal(G.digestItems(group, { settings, now: NOW })[0].kind, 'mention');
  group.messages.g.push(message('own', { conv: 'g', group: true, mine: true, at: NOW - 1000 }));
  assert.equal(G.digestItems(group, { settings, now: NOW }).length, 0);
  assert.equal(D.awaiting(group, settings).length, 1);
  group.messages.g = [message('earlier', { mine: true }), hit, hit];
  assert.equal(G.digestItems(group, { settings, now: NOW }).length, 1, 'stable ID deduplicates repeated source records');
});

test('today/tomorrow commitments and normalized important unread mail are included, with no owner/source restriction on commitments', () => {
  const mails = D.mails({ mails: [{ id: 'high', subject: 'Important', importance: 'high' }, { id: 'normal', subject: 'Normal', importance: 'normal' }] });
  const items = G.digestItems(snapshot({ messages: {}, mails }), { settings, now: NOW, commitments: [
    { source: 'old-source', text: 'today', due: '2026-11-02' }, { source: 'tomorrow', text: 'tomorrow', due: '2026-11-03' },
    { source: 'later', text: 'later', due: '2026-11-04' }, { source: 'overdue', text: 'overdue', due: '2026-11-01' },
  ] });
  assert.deepEqual(items.map(item => item.source), ['old-source', 'tomorrow', 'mail:high']);
});

test('new versus previously notified IDs and prior commitment-due notices produce accurate counts', () => {
  const result = plan({ snapshot: snapshot({ mails: [{ sourceId: 'mail:old', subject: 'Old important', important: true }] }),
    state: { seen: ['mail:mail:old'] }, commitments: [{ source: 'promise', due: D.dayKey(NOW), text: 'Promised work' }],
    sent: { 'commit:promise:2026-11-02:day': NOW - 1000 } });
  assert.match(result.notice.text, /^本次新增：1 条私聊未回；另有 2 件仍待处理$/);
  assert.equal(result.items.find(item => item.kind === 'commitment').isNew, false);
  assert.equal(plan({ commitments: [{ source: 'promise', due: D.dayKey(NOW), text: 'Promised work' }], snapshot: snapshot({ messages: {} }), sent: { 'commit:promise:2026-11-02:day': NOW - 1000 } }).notice, null);
  const distinct = plan({ commitments: [{ source: 'promise', due: D.dayKey(NOW), text: 'Promised work' }], snapshot: snapshot({ messages: {} }), sent: { 'commit:promise:other:2026-11-02:day': NOW - 1000 } });
  assert.equal(distinct.items[0].isNew, true, 'another source sharing a prefix is a different promise');
});

test('empty and old-only checks advance only lastCheckedAt and never notify', t => {
  const f = fixture(t), previous = { lastCheckedAt: NOW - 3 * 3600000, lastSentAt: NOW - 4 * 3600000, seen: ['private:msg:p:one'] };
  f.a.write('digest.json', previous); const before = f.a.state();
  assert.deepEqual(f.a.remind(), []);
  assert.deepEqual(f.a.digest.state(), { ...previous, lastCheckedAt: NOW });
  assert.deepEqual(f.a.state(), before); assert.equal(f.a.bus.latest().length, 0);
  f.setTime(NOW + 2 * 3600000); f.put(snapshot({ messages: {} }));
  assert.deepEqual(f.a.remind(), []); assert.equal(f.a.digest.state().lastSentAt, previous.lastSentAt);
});

test('published digest survives restart without repeating and a later new item includes still pending items', t => {
  const f = fixture(t); f.put(snapshot({ mails: [{ sourceId: 'mail:old', subject: 'Important mail', important: true }] }));
  assert.equal(f.a.remind().filter(item => item.kind === 'digest').length, 1);
  assert.deepEqual(f.create().remind(), []);
  f.setTime(NOW + 2 * 3600000);
  f.put(snapshot({ messages: { p: [message('new', { at: NOW + 60 * 60000 })] }, mails: [{ sourceId: 'mail:old', subject: 'Important mail', important: true }] }));
  const next = f.a.remind().find(item => item.kind === 'digest');
  assert.match(next.text, /本次新增：1 条私聊未回；另有 1 件仍待处理/);
  assert.equal(f.a.digest.state().lastSentAt, NOW + 2 * 3600000); assert.equal(f.a.bus.latest().filter(item => item.kind === 'digest').length, 2);
});

test('digest does not consume the service quota, and reentrant checks emit at most one digest', t => {
  const f = fixture(t); f.a.saveState({ sentTimes: [NOW, NOW, NOW] });
  f.a.bus.on('notice', item => { if (item.kind === 'digest') f.a.remind(); });
  assert.equal(f.a.remind().filter(item => item.kind === 'digest').length, 1);
  assert.deepEqual(f.a.state().sentTimes, [NOW, NOW, NOW]);
  assert.equal(f.a.publish({ id: 'ordinary', kind: 'keyword', title: 'ordinary', text: '' }), false);
  assert.deepEqual(f.a.remind(), []); assert.equal(f.a.bus.latest().length, 1);
});

test('digest=0 restores old awaiting notices; enabling digest changes no other reminder rules', t => {
  const f = fixture(t), old = snapshot({ messages: { p: [message('old', { at: NOW - 5 * 3600000 })] } });
  f.put(old); f.a.setSettings({ digestHours: 0 });
  assert.equal(f.a.remind()[0].kind, 'awaiting-reply');
  const evening = Date.parse('2026-11-02T18:00:00+08:00');
  const options = { snapshot: { ...old, meetings: [{ sourceId: 'm:one', subject: 'one', start: evening + 5 * 60000, end: evening + 2 * 3600000 }, { sourceId: 'm:two', subject: 'two', start: evening + 10 * 60000, end: evening + 3 * 3600000 }] }, now: evening, commitments: [{ source: 'promise', due: D.dayKey(NOW), text: 'promise' }], settings: { ...settings, keywords: ['正文'], keywordSince: NOW - 10 * 3600000, digestHours: 0 } };
  const baseline = R.dueNotices(options), enabled = R.dueNotices({ ...options, settings: { ...options.settings, digestHours: 2 } });
  assert.ok(baseline.some(item => item.kind === 'awaiting-reply'));
  assert.deepEqual(enabled, baseline.filter(item => item.kind !== 'awaiting-reply'));
  assert.ok(enabled.some(item => item.kind === 'commitment-due')); assert.ok(enabled.some(item => item.kind === 'keyword'));
  for (const kind of ['meeting-prep', 'overbooked', 'day-summary']) assert.ok(enabled.some(item => item.kind === kind));
});

test('already-sent commitment-due in the same reminder pass makes the commitment old in a new digest', t => {
  const f = fixture(t); f.a.saveState({ commitments: [{ source: 'promise', due: D.dayKey(NOW), text: 'promise' }] });
  const notices = f.a.remind(); assert.ok(notices.some(item => item.kind === 'commitment-due'));
  assert.equal(notices.find(item => item.kind === 'digest').detail.items.find(item => item.kind === 'commitment').isNew, false);
});

test('processed sources disappear from both future digest candidates and the saved visible checklist', t => {
  const f = fixture(t), notice = f.a.remind()[0]; f.a.markDone('msg:p:one');
  assert.equal(f.a.digestNotice(notice.id).notice.detail.items.length, 0);
  assert.match(f.a.digestNotice(notice.id).notice.title, /已全部处理/);
  assert.equal(G.digestItems(snapshot(), { settings, now: NOW, done: f.a.doneSet() }).length, 0);
  f.setTime(NOW + 2 * 3600000); assert.deepEqual(f.a.remind(), []);
});

test('digest settings default, allowed values, persistence and rejection range', t => {
  const f = fixture(t); assert.equal(DEFAULT_SETTINGS.digestHours, 0, '默认关（与现有「等你回复」提醒重复，想用的人自己打开）');
  for (const value of [0, 1, 2, 4]) { f.a.setSettings({ digestHours: value }); assert.equal(f.create().settings().digestHours, value); }
  for (const value of [-1, 3, 5, 1.5, '2', null, true, NaN]) assert.throws(() => f.a.setSettings({ digestHours: value }), /定时汇总/);
  assert.equal(f.a.settings().digestHours, 4);
});

test('digest calculations, source retention, actions and notification reads add zero WeLink gate requests', t => {
  const f = fixture(t), before = f.gateCalls();
  const notice = f.a.remind()[0]; f.a.remind(); f.a.digestNotice(notice.id); f.a.sourceContext('msg:p:one'); f.a.markDone('msg:p:one');
  assert.equal(f.gateCalls(), before);
});

test('referenced full local source remains accessible after the current snapshot drops it', t => {
  const f = fixture(t), full = 'local full source '.repeat(100);
  f.put(snapshot({ messages: { p: [message('one', { text: full })] }, scope: { conversations: [{ id: 'p', status: 'partial', capturedAt: NOW - 3600000, reasonLabel: 'cached partial' }] } })); f.a.remind();
  f.put(snapshot({ messages: {} }));
  const source = f.a.sourceContext('msg:p:one');
  assert.equal(source.entry.item.text, full); assert.equal(source.context[0].text, full); assert.equal(source.historical, true);
  assert.equal(source.capturedAt, NOW - 3600000); assert.equal(source.coverage.status, 'partial');
  assert.equal(f.a.digest.source('msg:p:one', 'another-owner'), null);
});

test('source retention is limited to referenced records, 500 total, and at most seven days', t => {
  const f = fixture(t), records = Array.from({ length: G.SOURCE_LIMIT + 2 }, (_, i) => message('source-' + i));
  const data = snapshot({ messages: { p: records } });
  f.a.saveState({ notices: [{ id: 'digest:cap', kind: 'digest', at: NOW, detail: { items: records.map(row => ({ source: row.sourceId })) } }] });
  f.a.digest.retainSources(data);
  assert.equal(f.a.read('digest-sources.json', {}).records.length, G.SOURCE_LIMIT);
  f.a.write('digest-sources.json', { records: [...f.a.read('digest-sources.json', {}).records, { source: 'not-referenced', noticeAt: NOW }] });
  f.a.digest.pruneSources();
  assert.equal(f.a.read('digest-sources.json', {}).records.some(record => record.source === 'not-referenced'), false);
  f.setTime(NOW + G.SOURCE_KEEP_MS); f.a.digest.pruneSources();
  assert.equal(f.a.read('digest-sources.json', {}).records.length, G.SOURCE_LIMIT);
  f.setTime(NOW + G.SOURCE_KEEP_MS + 1); f.a.digest.pruneSources();
  assert.equal(f.a.read('digest-sources.json', {}).records.length, 0);
});

test('source expiry cleanup runs with assistant disabled and makes no WeLink calls', t => {
  const timers = new Map(); let sequence = 0;
  const f = fixture(t, { digestSetTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, digestClearTimeout: id => timers.delete(id) });
  f.a.remind(); f.a.setSettings({ enabled: false });
  assert.equal(timers.size, 1); const timer = [...timers.values()][0];
  assert.ok(timer.delay <= G.SOURCE_KEEP_MS); f.setTime(NOW + G.SOURCE_KEEP_MS + 1); timer.fn();
  assert.equal(f.a.read('digest-sources.json', {}).records.length, 0); assert.equal(f.gateCalls(), 0);
});

test('background source-cleanup errors cannot crash Hub or log record contents', t => {
  let callback; const warnings = [];
  const f = fixture(t, { logger: { warn: value => warnings.push(value) }, digestSetTimeout: fn => { callback = fn; return 1; }, digestClearTimeout() {} });
  f.a.remind(); f.setTime(NOW + G.SOURCE_KEEP_MS + 1);
  const write = f.a.write.bind(f.a); f.a.write = (file, data) => { if (file === 'digest-sources.json') throw new Error('PRIVATE_BODY'); return write(file, data); };
  assert.doesNotThrow(callback); assert.equal(warnings.length, 1); assert.doesNotMatch(warnings[0], /PRIVATE_BODY/);
});

test('digest pet speech bypasses and does not consume hourly slots, but keeps quiet, silent, fullscreen and sleep gates', () => {
  const item = { id: 'digest:pet', kind: 'digest', title: '定时汇总', text: 'summary' };
  const spoken = [NOW, NOW, NOW];
  assert.equal(speakGate({ mode: 'gentle' }, { now: NOW, pose: 'idle' }, spoken, item).ok, true);
  const queue = new SpeechQueue({ now: () => NOW }); queue.spokenAt = [...spoken]; queue.push(item);
  queue.tick((at, next) => speakGate({ mode: 'gentle' }, { now: NOW, pose: 'idle' }, at, next));
  assert.equal(queue.current.kind, 'digest'); assert.deepEqual(queue.spokenAt, spoken); assert.equal(queue.current.sticky, false);
  for (const [settings, ctx, reason] of [
    [{ mode: 'quiet' }, {}, 'quiet-mode'], [{ silentDate: localDateKey(NOW) }, {}, 'silent-today'],
    [{ quietUntil: NOW + 1000 }, {}, 'quiet-hour'], [{}, { fullscreen: true }, 'fullscreen'], [{}, { pose: 'sleep' }, 'sleeping'],
  ]) {
    const q = new SpeechQueue({ now: () => NOW }); q.push(item);
    q.tick((at, next) => { const verdict = speakGate(settings, { now: NOW, ...ctx }, at, next); assert.equal(verdict.reason, reason); return verdict; });
    assert.equal(q.current, null); assert.equal(q.dots[0].id, item.id); assert.equal(q.spokenAt.length, 0);
  }
});

test('checklist renders sources and done actions safely as escaped text', () => {
  const html = digestList({ kind: 'digest', detail: { items: [{ source: 'msg:p:test', kind: 'private', text: '<script>no</script>', sourceLabel: 'source', day: '2026-11-02', isNew: true }] } }, esc);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-ca="source:msg:p:test"/); assert.match(html, /data-ca="done:msg:p:test"/);
});

test('desktop notification controller and preload preserve the digest notice ID on click only for assistant notifications', async t => {
  const { createDesktopNotificationController, normalizeDesktopNotificationPayload } = require('../main/desktop-notification-controller');
  const ipc = new EventEmitter(), sends = [], opened = [], main = { webContents: {}, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) };
  class FakeWindow extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = (channel, payload) => sends.push([channel, payload]); }
    isDestroyed() { return !!this.destroyed; } setAlwaysOnTop() {} setBounds() {} showInactive() {} hide() {}
    loadFile() { queueMicrotask(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const controller = createDesktopNotificationController({ BrowserWindow: FakeWindow, ipcMain: ipc, getMainWindow: () => main, sendToRenderer: (...args) => opened.push(args), waitForPaint: async () => {}, setTimeoutFn: () => 1, clearTimeoutFn() {} });
  t.after(() => controller.dispose());
  await controller.show({ sessionId: 'company-assistant', title: 'digest', noticeId: 'digest:123' });
  assert.equal(sends[0][1].noticeId, 'digest:123');
  ipc.emit('desktop-notification:open', { sender: controller.getWindow().webContents }, { sessionId: 'company-assistant', noticeId: 'digest:123' });
  assert.deepEqual(opened[0], ['desktop-notification:open-session', { sessionId: 'company-assistant', noticeId: 'digest:123' }]);
  assert.equal(normalizeDesktopNotificationPayload({ sessionId: 'ordinary', noticeId: 'digest:123' }).noticeId, undefined);
  const listeners = {}, handlers = {}, writes = [], card = { dataset: {}, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const file = path.join(__dirname, '..', 'renderer', 'desktop-notification-preload.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: () => ({ ipcRenderer: { on: (name, fn) => { listeners[name] = fn; }, send: (...args) => writes.push(args) } }), window: { addEventListener: (_name, fn) => fn() }, document: { getElementById: id => id === 'notification-card' ? card : null } });
  listeners['desktop-notification:payload'](null, { sessionId: 'company-assistant', noticeId: 'digest:123' }); handlers.click();
  assert.equal(writes[0][1].noticeId, 'digest:123');
  listeners['desktop-notification:payload'](null, { sessionId: 'ordinary' }); handlers.click(); assert.equal(writes[1][1].noticeId, undefined);
});

test('real assistant page notice entry reloads an older saved digest and expands its checklist', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  const body = code.match(/^  async function fromPet\(detail = \{\}\) \{[\s\S]*?^  \}/m)[0];
  const data = { notices: [], chips: [] }, calls = [], box = { open: false }, row = { dataset: { noticeId: 'digest:123' }, classList: { add() {}, remove() {} }, scrollIntoView: () => calls.push('scrolled') };
  const context = vm.createContext({ data, open: async () => calls.push('open'), render: () => calls.push('render'),
    call: async (channel, request) => { calls.push([channel, request.id]); return { notice: { id: request.id } }; },
    page: { querySelector: selector => selector === '.ca-notices' ? box : { value: '' }, querySelectorAll: () => data.notices.length ? [row] : [] },
    setTimeout: fn => fn(), showMessage() {}, isFolded: () => false, gate: null,
  });
  await vm.runInContext(`(${body})`, context)({ noticeId: 'digest:123' });
  // 5.5.11 起提醒在「今天」栏里逐行显示，没有可展开的提醒条了：重新拉回汇总后直接定位到那一行。
  assert.equal(box.open, false); assert.deepEqual(calls, ['open', ['digest-notice', 'digest:123'], 'render', 'scrolled']);
  assert.match(code, /digestHours: Number\(v\('digestHours'\)\)/);
  assert.match(code, /data-f="digestHours"/);
});
