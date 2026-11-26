'use strict';
// 桌宠待办卡片（2026-11-26）：一行输入识别时间、待办存进桌宠提醒（旧版本照样能读）、不定时的永不触发、
// 气泡上的「完成 / 10 分钟后」、右键菜单两项、双击打开卡片、卡片贴着桌宠所在屏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { parseTodo, whenText } = require('../core/hub-pet/todo-parse');
const { createHubPetController } = require('../main/hub-pet-controller');
const { createTodoCard, CARD_W } = require('../main/hub-pet-todo-card');

// 2026-11-26（周四）14:00 北京时间
const NOW = Date.UTC(2026, 10, 26, 6, 0);
const bj = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-todo-'));
  const timers = new Map(), instances = [], cleanups = [];
  let time = NOW, serial = 0, petEnabled = false;
  function create() {
    const bus = new NoticeBus({ now: () => time });
    const a = new CompanyAssistant({ dataDir: root, noTools: true, now: () => time, bus, isPetEnabled: () => petEnabled,
      getSession: () => null, resolveCli: () => null, logger: { warn() {} },
      reminderSetTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; }, reminderClearTimeout: id => timers.delete(id) });
    a.saveState({ sessionId: 'assistant-session' });
    instances.push(a);
    return a;
  }
  const a = create();
  a.petReminders.start();
  t.after(() => { for (const fn of cleanups) fn(); for (const i of instances) i.petReminders.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a, create, timers, cleanups, now: () => time, advance: ms => { time += ms; }, setPet: v => { petEnabled = v; },
    fire: () => { const [id, timer] = [...timers.entries()].sort((x, y) => x[1].ms - y[1].ms)[0]; timers.delete(id); timer.fn(); },
    file: () => JSON.parse(fs.readFileSync(a.file('pet-reminders.json'), 'utf8')) };
}

class FakeWindow extends EventEmitter {
  constructor(opts) {
    super(); this.opts = opts; this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }; this.destroyed = false; this.visible = false; this.focused = 0;
    this.webContents = new EventEmitter(); this.sent = []; this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
    this.webContents.once = (ev, fn) => EventEmitter.prototype.once.call(this.webContents, ev, fn);
    FakeWindow.all.push(this);
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
  setBounds(b) { this.bounds = { ...b }; }
  setIgnoreMouseEvents() {} setAlwaysOnTop() {} setMenuBarVisibility() {}
  loadFile() { return Promise.resolve(); }
  show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
  focus() { this.focused += 1; }
  isVisible() { return this.visible; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
FakeWindow.all = [];
function fakeIpc() {
  const ipc = new EventEmitter(), invokes = new Map();
  ipc.handle = (ch, fn) => { invokes.set(ch, fn); };
  ipc.removeHandler = ch => { invokes.delete(ch); };
  ipc.invoke = (ch, event, arg) => invokes.get(ch)(event, arg);
  return ipc;
}

test('one-line input: clock times, relative times, weekdays and "later" are recognised in Beijing time', () => {
  const cases = [
    ['3点 交周报', '交周报', '2026-11-26 15:00'],
    ['下午3点半 回评审意见', '回评审意见', '2026-11-26 15:30'],
    ['15:00 开会', '开会', '2026-11-26 15:00'],
    ['明天 订会议室', '订会议室', '2026-11-27 09:00'],
    ['明晚8点 打电话', '打电话', '2026-11-27 20:00'],
    ['30分钟后 回电话', '回电话', '2026-11-26 14:30'],
    ['半小时后 喝水', '喝水', '2026-11-26 14:30'],
    ['周五 10点 整理材料', '整理材料', '2026-11-27 10:00'],
    ['下周一 写周报', '写周报', '2026-11-30 09:00'],
    ['9点 晨会', '晨会', '2026-11-27 09:00'],
    ['交周报 明天3点', '交周报', '2026-11-27 15:00'],
  ];
  for (const [text, title, at] of cases) {
    const r = parseTodo(text, NOW);
    assert.equal(r.title, title, text);
    assert.equal(bj(r.at), at, text);
    assert.equal(r.later, false, text);
  }
  // 句子中间的时间词不动：订的是周四的会议室，不是周四提醒。
  for (const text of ['整理接口文档', '评审3个问题', '5G 方案 review', '订周四会议室', '看Q3点评', '3点建议']) assert.deepEqual(parseTodo(text, NOW), { title: text, at: null, later: false });
  assert.deepEqual(parseTodo('以后 学英语', NOW), { title: '学英语', at: null, later: true });
  // 带「下午」、冒号或日期时不要求空格；无效或已过去的时间保留原文并提示，不悄悄改成别的时间。
  assert.equal(bj(parseTodo('下午3点开会', NOW).at), '2026-11-26 15:00');
  assert.equal(bj(parseTodo('明天3点交周报', NOW).at), '2026-11-27 15:00');
  assert.deepEqual(parseTodo('明天25点 开会', NOW), { title: '明天25点 开会', at: null, later: false, warn: '时间没看懂，先按不定时记下' });
  for (const text of ['半分钟后 回电话', '0分钟后 回电话', '999小时后 回电话']) assert.deepEqual(parseTodo(text, NOW), { title: text, at: null, later: false, warn: '相对时间要在 1 分钟到 7 天之间，先按不定时记下' }, text);
  // 分隔符里的 \s 是空白，不是字母 s。
  assert.equal(parseTodo('写tests3点', NOW).title, '写tests');
  assert.deepEqual(parseTodo('今天9点 开会', NOW), { title: '今天9点 开会', at: null, later: false, warn: '这个时间已经过了，先按不定时记下' });
  assert.equal(whenText(NOW + 3600000, NOW), '15:00');
  assert.equal(whenText(NOW + 86400000, NOW), '明天 14:00');
});

test('untimed todos never fire, stay readable by the old file validator, and group into today / later', t => {
  const f = fixture(t), r = f.a.petReminders;
  f.timers.clear();
  r.addTodo({ title: '订会议室' });
  r.addTodo({ title: '学英语', later: true });
  assert.equal(f.timers.size, 0, 'no timer for untimed todos');
  assert.deepEqual(f.a.bus.reminders(), [], 'untimed todos are not pet notices');
  // 旧版本的读取校验：每条 at 都是数字、state 合法、deliveredAt 为数字或空。
  for (const item of f.file().items) {
    assert.ok(Number.isFinite(item.at));
    assert.ok(['pending', 'acknowledged', 'cancelled', 'delivered'].includes(item.state));
    assert.ok(item.deliveredAt == null || Number.isFinite(item.deliveredAt));
  }
  f.advance(3 * 86400000);
  r.tick();
  assert.deepEqual(f.a.bus.reminders(), [], 'still silent days later');
  const v = r.todos();
  assert.deepEqual(v.today.map(x => x.title), ['订会议室']);
  assert.deepEqual(v.later.map(x => x.title), ['学英语']);
  assert.equal(v.today[0].when, '');
  // MCP 的 list 也看得到（会话能读到用户的待办）。
  assert.equal(r.list().find(x => x.title === '订会议室').atDisplay, '不定时');
});

test('timed todo fires once with done / snooze chips; snooze reschedules and done completes it', t => {
  const f = fixture(t), r = f.a.petReminders;
  f.setPet(true);
  r.addTodo({ title: '交周报', at: NOW + 3600000 });
  assert.equal(r.todos().today[0].when, '15:00');
  f.advance(3600000); f.fire();
  const [notice] = f.a.bus.reminders();
  assert.equal(notice.title, '交周报');
  assert.deepEqual(notice.chips.map(c => c.id), ['done', 'snooze10']);
  assert.equal(f.a.bus.snoozeReminder(notice.id, 10 * 60000), true);
  assert.deepEqual(f.a.bus.reminders(), [], 'snoozed reminder leaves the pet until it is due again');
  assert.equal(r.todos().today[0].when, '15:10');
  f.advance(10 * 60000); f.fire();
  assert.equal(f.a.bus.reminders().length, 1);
  assert.equal(f.a.bus.todoAction({ op: 'done', id: notice.id }), true);
  const v = r.todos();
  assert.equal(v.today.length, 0);
  assert.deepEqual(v.done.map(x => x.title), ['交周报']);
  assert.equal(f.a.bus.snoozeReminder(notice.id, 10 * 60000), false, 'completed items cannot be snoozed');
});

test('reopen, remove and reorder keep one source of truth; new todos go on top of a reordered group', t => {
  const f = fixture(t), r = f.a.petReminders;
  const a = r.addTodo({ title: 'A' }), b = r.addTodo({ title: 'B' }), c = r.addTodo({ title: 'C' });
  assert.deepEqual(r.todos().today.map(x => x.title), ['A', 'B', 'C']);
  assert.equal(r.todoAction({ op: 'reorder', ids: [c.id, a.id, b.id] }), true);
  assert.deepEqual(r.todos().today.map(x => x.title), ['C', 'A', 'B']);
  r.addTodo({ title: 'D' });
  assert.deepEqual(r.todos().today.map(x => x.title), ['D', 'C', 'A', 'B']);
  assert.equal(r.todoAction({ op: 'done', id: a.id }), true);
  assert.equal(r.todoAction({ op: 'reopen', id: a.id }), true);
  assert.ok(r.todos().today.some(x => x.id === a.id));
  assert.equal(r.todoAction({ op: 'remove', id: b.id }), true);
  assert.ok(!r.todos().today.some(x => x.id === b.id));
  assert.equal(f.file().items.find(x => x.id === b.id).state, 'cancelled');
  assert.equal(r.todoAction({ op: 'bogus', id: a.id }), false);
  // 一个新的实例（重启后）读到同样的东西。
  const again = f.create();
  assert.deepEqual(again.petReminders.todos().today.map(x => x.title), ['D', 'C', 'A']);
});

test('reopening an already fired reminder turns it into an untimed todo so the pet does not repeat it', t => {
  const f = fixture(t), r = f.a.petReminders;
  f.setPet(true);
  const item = r.addTodo({ title: '回电话', at: NOW + 60000 });
  f.advance(60000); f.fire();
  assert.equal(f.a.bus.reminders().length, 1);
  r.acknowledge([item.id]);
  assert.equal(r.todoAction({ op: 'reopen', id: item.id }), true);
  assert.deepEqual(f.a.bus.reminders(), []);
  assert.equal(r.todos().today.find(x => x.id === item.id).when, '');
});

test('input validation: empty, over-long, past times and the 50 open item cap', t => {
  const f = fixture(t), r = f.a.petReminders;
  assert.throws(() => r.addTodo({ title: '  ' }), /不能为空/);
  assert.throws(() => r.addTodo({ title: '字'.repeat(81) }), /最多 80 字/);
  assert.throws(() => r.addTodo({ title: '过去', at: NOW - 1 }), /现在之后/);
  const first = r.addTodo({ title: 'T0' });
  for (let i = 1; i < 50; i += 1) r.addTodo({ title: 'T' + i });
  assert.throws(() => r.addTodo({ title: '第 51 条' }), /50 条/);
  // 恢复一条已完成的也受上限约束。
  r.todoAction({ op: 'done', id: first.id });
  r.addTodo({ title: '补满' });
  assert.throws(() => r.todoAction({ op: 'reopen', id: first.id }), /50 条/);
});

test('todo card window: opens beside the pet body on its display, adds through the shared store, hides on blur', async t => {
  const f = fixture(t), ipc = fakeIpc(), opened = [];
  FakeWindow.all = [];
  const display = { workArea: { x: 1920, y: 0, width: 1600, height: 900 } };
  const card = createTodoCard({ BrowserWindow: FakeWindow, ipcMain: ipc, rendererDir: path.join(__dirname, '../renderer/hub-pet'), noticeBus: f.a.bus,
    displayFor: () => display, petBody: () => ({ x: 3300, y: 700, width: 150, height: 150 }), openAssistant: p => opened.push(p), now: f.now });
  t.after(() => card.dispose());
  assert.equal(card.available(), true);
  assert.equal(card.open(), true);
  const win = FakeWindow.all[0];
  assert.equal(win.opts.focusable, true);
  assert.equal(win.visible, false, 'waits for the page to be ready');
  ipc.emit('hub-pet-todo:ready', { sender: win.webContents });
  assert.equal(win.visible, true);
  assert.ok(win.focused > 0);
  const b = win.getBounds();
  assert.equal(b.width, CARD_W);
  assert.ok(b.x + b.width <= 3300 + 14, 'left of the pet');
  assert.ok(b.x >= 1920 && b.y >= 0 && b.y + b.height <= 900, 'inside the pet display work area');
  assert.equal(win.sent.find(m => m.channel === 'hub-pet-todo:open').payload.focus, 'add');
  const ev = { sender: win.webContents };
  const res = await ipc.invoke('hub-pet-todo:add', ev, '3点 交周报');
  assert.equal(res.ok, true);
  assert.equal(res.state.today[0].title, '交周报');
  assert.equal(res.state.today[0].when, '15:00');
  assert.deepEqual(await ipc.invoke('hub-pet-todo:preview', ev, '明天 订会议室'), { title: '订会议室', when: '明天 9:00', later: false, warn: '' });
  assert.equal(await ipc.invoke('hub-pet-todo:add', { sender: {} }, '外人'), null, 'other windows cannot write');
  const done = await ipc.invoke('hub-pet-todo:act', ev, { type: 'done', id: res.state.today[0].id });
  assert.equal(done.state.done.length, 1);
  win.emit('blur');
  assert.equal(win.visible, false);
  await ipc.invoke('hub-pet-todo:act', ev, { type: 'assistant' });
  assert.equal(opened.length, 1);
  // 卡片关着时数据变化不推送（不常驻刷新）。
  const before = win.sent.length;
  f.a.petReminders.addTodo({ title: '关着时记的' });
  assert.equal(win.sent.length, before);
});

test('card flips to the right of the pet when there is no room on the left', t => {
  const f = fixture(t), ipc = fakeIpc();
  FakeWindow.all = [];
  const card = createTodoCard({ BrowserWindow: FakeWindow, ipcMain: ipc, rendererDir: '.', noticeBus: f.a.bus,
    displayFor: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), petBody: () => ({ x: 20, y: 100, width: 150, height: 150 }) });
  t.after(() => card.dispose());
  const { bounds, side } = card.bounds();
  assert.equal(side, 'right');
  assert.ok(bounds.x >= 150 && bounds.y >= 0);
});

test('without a reminder source (non-company build) the card stays unavailable and double-click keeps opening the assistant', t => {
  const ipc = fakeIpc();
  const card = createTodoCard({ BrowserWindow: FakeWindow, ipcMain: ipc, rendererDir: '.', noticeBus: new NoticeBus(), displayFor: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) });
  t.after(() => card.dispose());
  assert.equal(card.available(), false);
  assert.equal(card.open(), false);
});

function controller(f, overrides = {}) {
  const ipcMain = fakeIpc();
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const opened = [];
  FakeWindow.all = [];
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: f.a.bus, dataDir: f.root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: path.join(__dirname, '../renderer/hub-pet/pet.html'), preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: f.now, watchFullscreen: false, logger: { warn() {} },
    sendToRenderer: (ch, p) => { if (ch === 'hub-pet:open-assistant') opened.push(p); }, ...overrides });
  f.a.deps.isPetEnabled = () => c.isActive();
  f.cleanups.push(() => c.dispose());
  const ev = () => ({ sender: c.getWindow().webContents });
  const click = target => { ipcMain.emit('hub-pet:press', ev(), { target }); ipcMain.emit('hub-pet:release', ev()); };
  return { c, ipcMain, click, ev, opened };
}

test('double-click opens the todo card by default; the setting switches it back to the assistant', t => {
  const f = fixture(t), { c, click, opened } = controller(f);
  c.setSettings({ enabled: true });
  c.setSettings({ clickHinted: true });
  click('body'); click('body');
  const card = c._todoCard;
  assert.equal(card.debug().alive, true, 'card window created on double-click');
  assert.equal(opened.length, 0, 'assistant not opened');
  // 卡片开着时再双击：收起卡片，不误开助理页。
  const win = FakeWindow.all.find(w => w.opts.title === 'AI Hub 桌宠待办');
  win.visible = true;
  f.advance(1000); click('body'); click('body');
  assert.equal(win.visible, false);
  assert.equal(opened.length, 0, 'closing the card does not open the assistant');
  card.close();
  c.setSettings({ dblTodo: false });
  click('body'); click('body');
  assert.equal(opened.length, 1, 'assistant opened when double-click is set back');
});

test('right-click menu lists add / open todo on top with today count, and both open the card', t => {
  const f = fixture(t), { c, ipcMain } = controller(f);
  c.setSettings({ enabled: true });
  f.a.petReminders.addTodo({ title: '订会议室' });
  ipcMain.emit('hub-pet:menu', { sender: c.getWindow().webContents });
  const menu = FakeWindow.all.find(w => w.opts.title === 'AI Hub 桌宠菜单');
  ipcMain.emit('hub-pet-menu:ready', { sender: menu.webContents });
  const state = menu.sent.filter(m => m.channel === 'hub-pet-menu:state').at(-1).payload;
  assert.deepEqual(state.quick.slice(0, 2).map(q => q.type), ['todo-add', 'todo']);
  assert.equal(state.quick[1].hint, '今天 1');
  ipcMain.emit('hub-pet-menu:act', { sender: menu.webContents }, { type: 'todo-add' });
  assert.equal(c._todoCard.debug().alive, true);
});

test('bubble chips on a due reminder: done acknowledges, snooze pushes it back 10 minutes', t => {
  const f = fixture(t), { c, ipcMain, ev } = controller(f);
  c.setSettings({ enabled: true });
  const item = f.a.petReminders.addTodo({ title: '交周报', at: NOW + 60000 });
  f.advance(60000); f.fire();
  assert.equal(c._speech.current && c._speech.current.id, item.id);
  assert.deepEqual(c._speech.current.chips.map(x => x.id), ['done', 'snooze10']);
  ipcMain.emit('hub-pet:reply', ev(), { id: item.id, choice: 'snooze10' });
  assert.equal(f.file().items.find(x => x.id === item.id).at, NOW + 60000 + 10 * 60000);
  assert.notEqual(c._speech.current && c._speech.current.id, item.id);
  f.advance(10 * 60000); f.fire();
  assert.equal(c._speech.current && c._speech.current.id, item.id);
  ipcMain.emit('hub-pet:reply', ev(), { id: item.id, choice: 'done' });
  assert.equal(f.file().items.find(x => x.id === item.id).state, 'acknowledged');
});

test('rollback safety: the 5.6.116 reminder module neither shows nor loses open untimed todos, and they come back after upgrading', t => {
  const f = fixture(t), r = f.a.petReminders;
  f.setPet(true);
  r.addTodo({ title: '不定时待办' });
  r.addTodo({ title: '稍后的', later: true });
  const timed = r.addTodo({ title: '定时待办', at: NOW + 60000 });
  const reopened = r.addTodo({ title: '提醒过又恢复', at: NOW + 30000 });
  // 模拟回退：换成 5.6.116 原样的模块读同一个文件。
  r.close();
  const { PetReminders: Legacy } = require('./fixtures/pet-reminders-v5.6.116');
  f.advance(30000);
  const legacy = new Legacy(f.a); legacy.start();
  assert.doesNotThrow(() => legacy.read(), 'old validator accepts the file');
  // 未完成的不定时待办：旧版不列出、不当提醒说。
  assert.deepEqual(legacy.list().map(x => x.title).sort(), ['定时待办', '提醒过又恢复'].sort());
  assert.ok(!f.a.bus.reminders().some(x => /不定时|稍后/.test(x.title)), 'old notices never include untimed todos');
  f.advance(3 * 86400000); legacy.tick();
  assert.ok(!f.a.bus.reminders().some(x => /不定时|稍后/.test(x.title)));
  // 旧版照常写文件（加一条、确认一条）也不会丢掉它们。
  legacy.execute({ op: 'add', title: '旧版加的' });
  legacy.acknowledge([timed.id, reopened.id]);
  legacy.close();
  const back = f.create().petReminders;
  const v = back.todos();
  assert.ok(v.today.some(x => x.title === '不定时待办'));
  assert.ok(v.later.some(x => x.title === '稍后的'));
});
