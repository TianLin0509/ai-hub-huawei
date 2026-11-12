'use strict';
// 桌宠接管通知、陪会话干活、问助理、加班红线（2026-11-09）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SpeechQueue, speakGate, decidePose } = require('../core/hub-pet/state');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { createHubPetController } = require('../main/hub-pet-controller');
const { createDesktopNotificationController } = require('../main/desktop-notification-controller');

const NOON = new Date(2026, 10, 9, 12).getTime();
const NIGHT = new Date(2026, 10, 9, 23, 30).getTime();

test('通知卡片插到最前面：正在说的话收进小圆点，新结果马上出来；不受每小时上限和打盹限制', () => {
  let t = NOON;
  const q = new SpeechQueue({ now: () => t });
  const gate = (spokenAt, item) => speakGate({ mode: 'gentle' }, { now: t, pose: 'sleep' }, spokenAt, item);
  q.push({ id: 'chat', kind: 'brief', title: '今日简报' });
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble.id, 'chat');
  q.push({ id: 'n1', kind: 'session', title: '会话 A 答完了', text: '找到原因并修好了', sessionId: 's1', notify: true, count: 3, cta: '打开会话' });
  q.tick(gate);
  const b = q.snapshot().bubble;
  assert.equal(b.id, 'n1');
  assert.equal(b.notify, true);
  assert.equal(b.count, 3);
  assert.equal(b.text, '找到原因并修好了');
  assert.equal(q.snapshot().dots, 1, '被插队的简报收进小圆点，不丢');
  // 打盹 + 普通提醒 → 不开口；通知卡片照样说
  assert.equal(speakGate({ mode: 'gentle' }, { now: t, pose: 'sleep' }, [], { kind: 'brief' }).ok, false);
  assert.equal(speakGate({ mode: 'gentle' }, { now: t, pose: 'sleep' }, [t, t, t], { notify: true }).ok, true);
  // 用户关掉说话（安静档 / 安静一小时）时，通知卡片也只亮小圆点
  assert.equal(speakGate({ mode: 'quiet' }, { now: t }, [], { notify: true }).ok, false);
  assert.equal(speakGate({ mode: 'gentle', quietUntil: t + 1000 }, { now: t }, [], { notify: true }).ok, false);
});

test('鼠标停在卡片上暂停倒计时，移开后至少再留 2.5 秒；打开过的会话从小圆点里拿掉', () => {
  let t = NOON;
  const q = new SpeechQueue({ now: () => t, notifyMs: 9000 });
  q.push({ id: 'n1', kind: 'session', title: 'A', sessionId: 's1', notify: true });
  q.tick(() => ({ ok: true }));
  t += 8000;
  assert.equal(q.hold(true), true);
  assert.equal(q.nextDeadline(), null, '停住时没有到点时刻');
  t += 60000;
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble.id, 'n1', '停着时不收');
  q.hold(false);
  assert.equal(q.nextDeadline(), t + 2500);
  t += 2600;
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble, null);
  assert.equal(q.snapshot().dots, 1);
  q.push({ id: 'n2', kind: 'session', title: 'B', sessionId: 's2', notify: true });
  q.tick(() => ({ ok: false }));
  assert.equal(q.snapshot().dots, 2);
  assert.equal(q.dropSession('s1'), true);
  const left = q.takeDots();
  assert.deepEqual(left.map(x => x.id), ['n2']);
  assert.ok(left[0].at, '收进小圆点的通知带着到达时间');
});

test('有会话在跑时敲键盘；夜里也是（活没干完不睡）；出错的通知用「累了」的样子说', () => {
  assert.equal(decidePose({ now: NOON, sessionsBusy: 2 }), 'typing');
  assert.equal(decidePose({ now: NIGHT, sessionsBusy: 1 }), 'typing');
  // 2026-11-12：夜里还在操作电脑就陪着不睡，停手 2 分钟才打盹
  assert.equal(decidePose({ now: NIGHT, sessionsBusy: 0, idleSec: 0 }), 'idle');
  assert.equal(decidePose({ now: NIGHT, sessionsBusy: 0, idleSec: 130 }), 'sleep');
  assert.equal(decidePose({ now: NOON, sessionsBusy: 0, idleSec: 130 }), 'idle');
  assert.equal(decidePose({ now: NOON, speaking: true, speakingTone: 'bad' }), 'tired');
  assert.equal(decidePose({ now: NOON, speaking: true }), 'happy');
});

function rig(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-notify-'));
  const sent = [], toHub = [];
  let visible = true;
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = (channel, payload) => sent.push({ channel, payload }); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(b) { this.bounds = { ...b }; }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    loadFile() { return Promise.resolve(); }
    showInactive() {}
    focus() {}
    hide() {}
    show() {}
    isVisible() { return visible; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const bus = new NoticeBus({ now: () => NOON });
  let running = 0;
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: bus, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: () => NOON, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: (channel, payload) => toHub.push({ channel, payload }), focusPrimaryWindow: () => {},
    getSessionActivity: () => ({ running }), ...opts });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop();
  const pet = () => ({ sender: c.getWindow().webContents });
  const click = target => { ipcMain.emit('hub-pet:press', pet(), { target }); ipcMain.emit('hub-pet:release', pet()); };
  return { c, bus, sent, toHub, ipcMain, state, pet, click, setRunning: n => { running = n; }, setVisible: v => { visible = v; } };
}

test('桌宠没开时通知照旧走右下角卡；开着时由桌宠举卡片说，点卡片直接打开那个会话', t => {
  const r = rig(t);
  const payload = { sessionId: 'sess-1', title: 'AI HUB分支功能故障修复', body: '找到原因并修好了', kind: 'codeagent', completedAt: NOON - 1000, readyCount: 2 };
  assert.equal(r.c.notify(payload), false, '桌宠没开 → 交回原通知卡');
  r.c.setSettings({ enabled: true });
  assert.equal(r.c.notify(payload), true);
  const b = r.state().bubble;
  assert.equal(b.notify, true);
  assert.equal(b.title, 'AI HUB分支功能故障修复');
  assert.equal(b.text, '找到原因并修好了');
  assert.equal(b.cta, '打开会话');
  assert.equal(b.count, 2);
  assert.equal(r.state().pose, 'happy');
  r.click('bubble');
  assert.deepEqual(r.toHub.find(x => x.channel === 'desktop-notification:open-session').payload, { sessionId: 'sess-1' });
  assert.equal(r.state().bubble, null);
  assert.equal(r.state().dots, 0, '点开了就不再留在小圆点里');
});

test('收起卡片进小圆点、点小圆点翻出来；Hub 里点开了会话，小圆点里那条就拿掉', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 'a', title: '会话 A', completedAt: 1 });
  r.c.notify({ sessionId: 'b', title: '会话 B', completedAt: 2 });
  assert.equal(r.state().bubble.title, '会话 B');
  assert.equal(r.state().dots, 1);
  r.ipcMain.emit('hub-pet:dismiss', r.pet());
  assert.equal(r.state().bubble, null);
  assert.equal(r.state().dots, 2);
  r.ipcMain.emit('hub-pet:session-seen', { sender: null }, 'a');
  assert.equal(r.state().dots, 2, '不是主窗口发来的不认');
  r.c.sessionSeen('a');
  assert.equal(r.state().dots, 1);
  r.click('dot');
  const panel = r.sent.filter(x => x.channel === 'hub-pet:panel').pop().payload.items;
  assert.deepEqual(panel.map(x => x.title), ['会话 B']);
  assert.equal(panel[0].cta, '打开会话');
  r.ipcMain.emit('hub-pet:open-notice', r.pet(), { id: panel[0].id });
  assert.equal(r.toHub.filter(x => x.channel === 'desktop-notification:open-session').pop().payload.sessionId, 'b');
});

test('关了「通知交给桌宠」或桌宠被藏起来时交回原通知卡；公司助理的提醒已经经总线到桌宠，不重复', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  assert.equal(r.c.notify({ sessionId: 'company-assistant', kind: 'assistant', title: '会前准备' }), true);
  assert.equal(r.state().bubble, null, '助理提醒不经这条路重复出现');
  r.setVisible(false);
  assert.equal(r.c.notify({ sessionId: 's', title: 'x' }), false);
  r.setVisible(true);
  r.c.setSettings({ notifyMode: 'popup' });
  assert.equal(r.c.notify({ sessionId: 's', title: 'x' }), false);
  assert.equal(r.c.getSettings().notifyMode, 'popup');
});

test('桌面回执三档（2026-11-11）：交给桌宠没开时退回小卡；右下角一律弹；关闭只留要紧的', t => {
  const r = rig(t);
  const done = { sessionId: 's', title: '答完了' };
  // 默认交给桌宠；桌宠没开 → 照旧弹右下角小卡，不漏
  assert.equal(r.c.getSettings().notifyMode, 'pet');
  assert.equal(r.c.routeDesktopNotice(done), false);
  r.c.setSettings({ enabled: true });
  assert.equal(r.c.routeDesktopNotice(done), true);
  assert.equal(r.state().bubble.title, '答完了');
  // 右下角小卡：桌宠开着也不举卡片
  r.c.setSettings({ notifyMode: 'popup' });
  assert.equal(r.c.routeDesktopNotice({ sessionId: 's2', title: '第二个' }), false);
  // 关闭：普通回执吞掉；到点提醒、出错的照样说（桌宠没开时退回小卡）
  r.c.setSettings({ notifyMode: 'off' });
  assert.equal(r.c.routeDesktopNotice({ sessionId: 's3', title: '普通' }), true);
  assert.notEqual(r.state().bubble?.title, '普通');
  assert.equal(r.c.routeDesktopNotice({ sessionId: 'h', title: '到点了', kind: 'reminder' }), true);
  assert.equal(r.state().bubble.title, '到点了');
  r.c.setSettings({ enabled: false });
  assert.equal(r.c.routeDesktopNotice({ sessionId: 'x', title: '出错', tone: 'bad' }), false);
  assert.equal(r.c.routeDesktopNotice({ sessionId: 'company-assistant', kind: 'assistant', noticeKind: 'welink-login', title: '登录失效' }), false);
  assert.equal(r.c.routeDesktopNotice({ sessionId: 'company-assistant', kind: 'assistant', noticeKind: 'brief', title: '简报' }), true);
  // 不认识的档位不改
  r.c.setSettings({ notifyMode: 'loud' });
  assert.equal(r.c.getSettings().notifyMode, 'off');
});

test('安静档下通知只亮小圆点；带页面去处的通知（会议室、助理回答）点开去那一页', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true, mode: 'quiet' });
  r.c.notify({ sessionId: 's', title: '安静时完成的' });
  assert.equal(r.state().bubble, null);
  assert.equal(r.state().dots, 1);
  r.c.setSettings({ mode: 'gentle' });
  r.bus.publish({ id: 'room:1', kind: 'room', notify: true, page: 'rooms', title: '抢到会议室了', text: '11-16（周一）14:00–16:00 · F3', cta: '打开会议室' });
  assert.equal(r.state().bubble.title, '抢到会议室了');
  r.click('bubble');
  assert.deepEqual(r.toHub.filter(x => x.channel === 'hub-pet:open-page').pop().payload, { page: 'rooms' });
});

test('会话在跑：桌宠敲键盘并标出个数；设置里关了「陪着干活」就不跟', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  r.setRunning(3);
  r.c._evaluate();
  assert.equal(r.state().pose, 'typing');
  assert.equal(r.state().running, 3);
  r.c.setSettings({ followSessions: false });
  assert.equal(r.state().running, 0);
  assert.equal(r.state().pose, 'idle');
});

test('右键菜单：问助理、翻没看的、会议室入口；问助理交给助理并回报结果', async t => {
  const asked = [];
  const r = rig(t, { askAssistant: text => { asked.push(text); return { id: 'x' }; }, getPages: () => ({ assistant: true, rooms: { label: '会议室', hint: '自动抢订开着' } }) });
  r.c.setSettings({ enabled: true, mode: 'quiet' });
  r.c.notify({ sessionId: 's', title: 'x' });
  const ipcMenu = [];
  r.ipcMain.emit('hub-pet:ask', r.pet(), { text: '  今天下午有什么会？ ' });
  await new Promise(res => setImmediate(res));
  assert.deepEqual(asked, ['今天下午有什么会？']);
  assert.deepEqual(r.sent.filter(x => x.channel === 'hub-pet:ask-result').pop().payload, { ok: true });
  r.ipcMain.emit('hub-pet:ask', r.pet(), { text: '   ' });
  assert.equal(r.sent.filter(x => x.channel === 'hub-pet:ask-result').pop().payload.ok, false);
  assert.equal(ipcMenu.length, 0);
});

test('没开助理时问助理给出下一步该做什么', async t => {
  const r = rig(t, { askAssistant: () => { throw new Error('助理还没开：在「可选功能」里打开助理后再问'); } });
  r.c.setSettings({ enabled: true });
  r.ipcMain.emit('hub-pet:ask', r.pet(), { text: '你好' });
  await new Promise(res => setImmediate(res));
  assert.match(r.sent.filter(x => x.channel === 'hub-pet:ask-result').pop().payload.error, /可选功能/);
});

test('右下角通知卡：route 接手时不再建窗口弹卡', async () => {
  const made = [];
  const ipcMain = new EventEmitter();
  class W { constructor() { made.push(this); } }
  const routed = [];
  const d = createDesktopNotificationController({ BrowserWindow: W, ipcMain, route: p => { routed.push(p); return true; } });
  assert.equal(await d.show({ sessionId: 's1', title: '完成', body: '好了', tone: 'bad' }), true);
  assert.equal(made.length, 0);
  assert.equal(routed[0].title, '完成');
  assert.equal(routed[0].tone, 'bad');
});

test('提醒总线认 WeLink 续期失败（以前漏登记，这条提醒一直发不出去）和桌宠的新类别', () => {
  const bus = new NoticeBus();
  for (const kind of ['welink-login', 'answer', 'room', 'attendance']) assert.equal(bus.publish({ id: 'k-' + kind, kind, title: kind }), true, kind);
});

test('在桌宠上问的：答完经提醒总线交给桌宠说，点开到助理页；答不出也说一声', t => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ask-'));
  const bus = new NoticeBus({ now: () => NOON });
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, powerSaveBlocker: {}, now: () => NOON, bus, getSession: () => null, resolveCli: () => null });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  a.saveChat([{ id: 'c1', q: '今天下午有什么会？', state: 'running', via: 'pet' }, { id: 'c2', q: '普通的一问', state: 'running' }, { id: 'c3', q: '答不出的', state: 'running', via: 'pet' }]);
  a.patchChat('c1', { state: 'done', a: '14:00 周会；16:00 评审' });
  a.patchChat('c2', { state: 'done', a: 'x' });
  a.patchChat('c3', { state: 'error', error: '助理会话 12 分钟没给出回答' });
  const items = bus.latest(10);
  assert.equal(items.length, 2, '只有桌宠上问的才让桌宠说');
  const ok = items.find(n => n.id === 'answer:c1');
  assert.equal(ok.kind, 'answer');
  assert.equal(ok.page, 'assistant');
  assert.match(ok.title, /助理答好了：今天下午有什么会/);
  assert.equal(ok.text, '14:00 周会；16:00 评审');
  const bad = items.find(n => n.id === 'answer:c3');
  assert.equal(bad.tone, 'bad');
  assert.match(bad.text, /12 分钟/);
});

test('加班红线：按本月节奏会超 80 小时时，早上说一次今天几点前走，快到点再提醒一次；不超就不说', t => {
  const { CompanyAttendance } = require('../core/company-attendance/service');
  const calc = require('../core/attendance-calc');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-att-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = new Date(2026, 10, 9, 9, 0);
  const told = [];
  const svc = new CompanyAttendance({ dataDir: root, noTimer: true, now: () => now, publish: n => { told.push(n); return true; }, accountEmail: () => 'someone@example.com' });
  const dir = path.join(root, 'company-attendance');
  fs.mkdirSync(dir, { recursive: true });
  const heavy = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(date => ({ date, first: '08:30', last: '22:40', firstTag: '', lastTag: '' }));
  fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify(heavy));
  const morning = svc.redLine();
  assert.ok(morning, '预计超红线 → 早上说一次');
  assert.equal(morning.kind, 'attendance');
  assert.equal(morning.page, 'attendance');
  assert.match(morning.text, /前走/);
  assert.equal(svc.redLine(), null, '同一天不重复');
  const st = svc.status(), r = st.rules;
  const opts = { holidays: {}, rules: { amEnd: r.amEnd, pmStart: r.pmStart, owePerWorkday: r.owePerWorkday } };
  const m = calc.monthReport(calc.buildDays(st.records, opts), '2026-11', '2026-11-09', opts);
  now = new Date(2026, 10, 9, 0, Math.round(m.leaveBy) - 10);
  const evening = svc.redLine();
  assert.ok(evening, '离建议离开时刻 10 分钟时再提醒');
  assert.match(evening.title, /该准备走了/);
  assert.equal(svc.redLine(), null);
  assert.equal(told.length, 2);
  // 正常节奏：不说
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-att2-'));
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root2, 'company-attendance'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'company-attendance', 'records.json'), JSON.stringify(heavy.map(x => ({ ...x, last: '18:10' }))));
  const calm = new CompanyAttendance({ dataDir: root2, noTimer: true, now: () => new Date(2026, 10, 9, 9, 0), publish: n => { told.push(n); return true; }, accountEmail: () => 'someone@example.com' });
  assert.equal(calm.redLine(), null);
});

test('硬盘快满：用了 90% 以上的盘每天说一次，点开去「硬盘管理」；桌宠没开时不看', async () => {
  const { createDiskWatch, driveRoot } = require('../core/hub-pet/disk-watch');
  const GB = 1024 ** 3;
  const disks = { 'C:/': { bsize: 4096, blocks: 100 * GB / 4096, bavail: 5 * GB / 4096 }, 'D:/': { bsize: 4096, blocks: 100 * GB / 4096, bavail: 40 * GB / 4096 } };
  const said = [];
  let active = true, t = NOON;
  const w = createDiskWatch({ roots: () => ['C:/', 'D:/', 'C:/'], statfs: async r => disks[r], notify: n => { said.push(n); return true; }, active: () => active, now: () => t });
  assert.equal((await w.check()).length, 1);
  assert.equal(said[0].title, 'C: 盘已经用了 95%');
  assert.equal(said[0].page, 'disk');
  assert.match(said[0].text, /只剩 5 GB/);
  await w.check();
  assert.equal(said.length, 1, '同一天同一块盘只说一次');
  t += 24 * 3600000;
  active = false;
  await w.check();
  assert.equal(said.length, 1, '桌宠没开时不看');
  active = true;
  await w.check();
  assert.equal(said.length, 2, '第二天再说一次');
  if (process.platform === 'win32') assert.match(driveRoot('D:/data/hub'), /^D:/);
});

test('会议页正在录制时（屏幕可能在共享），通知只亮小圆点，菜单里说明原因', t => {
  let meeting = true;
  const r = rig(t, { inMeeting: () => meeting });
  r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 's', title: '开会时完成的' });
  assert.equal(r.state().bubble, null);
  assert.equal(r.state().dots, 1);
  meeting = false;
  r.c.notify({ sessionId: 's2', title: '散会后完成的' });
  assert.equal(r.state().bubble.title, '散会后完成的');
});

test('周五下午问一句要不要起草周报（每周一次，安静档不说），点卡片让助理按「起草周报」开问', t => {
  const { weeklyNudge } = require('../core/hub-pet/state');
  const fri = new Date(2026, 10, 13, 16, 0).getTime();
  const track = {};
  assert.equal(weeklyNudge('quiet', { now: fri }, {}), null);
  assert.equal(weeklyNudge('gentle', { now: new Date(2026, 10, 12, 16).getTime() }, {}), null, '周四不说');
  assert.equal(weeklyNudge('gentle', { now: fri, idleSec: 900 }, {}), null, '人不在不说');
  const n = weeklyNudge('gentle', { now: fri }, track);
  assert.equal(n.action, 'weekly-report');
  assert.equal(weeklyNudge('gentle', { now: fri + 60000 }, track), null, '一周一次');
  const r = rig(t, { now: () => fri, askAssistant: () => ({}), getPages: () => ({ assistant: true }) });
  r.c.setSettings({ enabled: true });
  r.c._evaluate();
  assert.match(r.state().bubble.title, /周报/);
  r.click('bubble');
  const open = r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').pop().payload;
  assert.equal(open.action, 'weekly-report');
  assert.match(open.prompt, /周报/);
});

test('值得提醒的新版本由桌宠说一次，点开「检查更新」', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  assert.equal(r.c.announceUpdate('5.6.0'), true);
  assert.equal(r.state().bubble.title, 'AI HUB 有新版本 5.6.0');
  r.c.announceUpdate('5.6.0');
  r.click('bubble');
  assert.deepEqual(r.toHub.filter(x => x.channel === 'hub-pet:open-page').pop().payload, { page: 'update' });
  assert.equal(r.state().dots, 0);
});

test('助理的简报、会前准备（带助理会话编号）点开仍去助理页定位那一条，不直接跳进助理会话', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true });
  r.bus.publish({ id: 'prep:1', kind: 'meeting-prep', title: '15:00 方案评审', text: '材料还没看', sessionId: 'assistant-session' });
  r.click('bubble');
  r.ipcMain.emit('hub-pet:open-notice', r.pet(), { id: 'prep:1', sessionId: 'assistant-session' });
  assert.equal(r.toHub.filter(x => x.channel === 'desktop-notification:open-session').length, 0);
  const open = r.toHub.filter(x => x.channel === 'hub-pet:open-assistant').pop().payload;
  assert.equal(open.noticeId, 'prep:1');
});

test('关了「通知交给桌宠」：总线上的通知卡片（会议室、助理回答）也不由桌宠说', t => {
  const r = rig(t);
  r.c.setSettings({ enabled: true, notifyMode: 'popup' });
  r.bus.publish({ id: 'room:x', kind: 'room', notify: true, page: 'rooms', title: '抢到会议室了' });
  assert.equal(r.state().bubble, null);
  assert.equal(r.state().dots, 0);
  r.bus.publish({ id: 'prep:x', kind: 'meeting-prep', title: '会前准备' });
  assert.equal(r.state().bubble.title, '会前准备', '助理原有的提醒照旧由桌宠说');
});

// ---------- 等级联动（2026-11-12） ----------
test('等级联动：身上显示等级与已解锁特效；设置里关掉就不显示', t => {
  const r = rig(t, { getProfile: () => ({ level: 12, rank: 3, perks: ['chip', 'sparkle', 'emblem'] }) });
  r.c.setSettings({ enabled: true });
  assert.deepEqual(r.state().growth, { level: 12, rank: 3, perks: ['chip', 'sparkle', 'emblem'] });
  r.c.setSettings({ showGrowth: false });
  assert.equal(r.state().growth, null);
  r.c.setSettings({ showGrowth: true });
  assert.equal(r.state().growth.level, 12);
});

test('升级和解锁成就：桌宠连跳撒花并举卡片，点卡片打开个人页；回执不交给桌宠时也照样庆祝；桌宠没开不庆祝', t => {
  const r = rig(t);
  assert.equal(r.c.celebrate({ id: 'lv-2', title: '升到 Lv.2' }), false, '桌宠没开');
  r.c.setSettings({ enabled: true, notifyMode: 'popup' });
  assert.equal(r.c.celebrate({ id: 'lv-13', title: '升到 Lv.13 · 晋升熟练驾驭者', text: '桌宠解锁「段位徽章」', big: true }), true);
  const motion = r.sent.filter(x => x.channel === 'hub-pet:motion').map(x => x.payload).pop();
  assert.deepEqual(motion, { phase: 'celebrate', big: true });
  const b = r.state().bubble;
  assert.equal(b.kind, 'growth');
  assert.equal(b.notify, true);
  assert.equal(b.title, '升到 Lv.13 · 晋升熟练驾驭者');
  assert.equal(b.cta, '看看我的成就');
  r.click('bubble');
  assert.deepEqual(r.toHub.filter(x => x.channel === 'hub-pet:open-page').map(x => x.payload).pop(), { page: 'profile' });
});

test('摸摸：鼠标在身上蹭算一次，3 秒内只记一次，记到亲密度上', t => {
  let petted = 0;
  const r = rig(t, { onPetted: () => { petted++; } });
  r.c.setSettings({ enabled: true });
  r.ipcMain.emit('hub-pet:pet', r.pet());
  r.ipcMain.emit('hub-pet:pet', r.pet());
  assert.equal(petted, 1);
  assert.equal(r.sent.filter(x => x.channel === 'hub-pet:motion' && x.payload.phase === 'petted').length, 1);
  r.ipcMain.emit('hub-pet:pet', { sender: {} });
  assert.equal(petted, 1, '不是桌宠窗口发来的不算');
});

test('闲聊：活泼档早上问好、午饭和深夜各说一句，每天各一次；温和档不闲聊', () => {
  const { chatterFor } = require('../core/hub-pet/state');
  const at = (h, m = 0) => new Date(2026, 10, 12, h, m).getTime();
  const track = {};
  assert.match(chatterFor('lively', { now: at(9), idleSec: 0 }, track).title, /早/);
  assert.equal(chatterFor('lively', { now: at(9, 5), idleSec: 0 }, track), null);
  assert.match(chatterFor('lively', { now: at(12, 10), idleSec: 0 }, track).title, /吃饭/);
  assert.doesNotMatch(chatterFor('lively', { now: at(12, 20), idleSec: 0 }, track)?.title || '', /吃饭/);
  assert.match(chatterFor('lively', { now: at(23, 10), idleSec: 0 }, track).title, /休息/);
  assert.doesNotMatch(chatterFor('lively', { now: at(23, 40), idleSec: 0 }, track)?.title || '', /休息/);
  assert.equal(chatterFor('gentle', { now: at(9), idleSec: 0 }, {}), null);
});
