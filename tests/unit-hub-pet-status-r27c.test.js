'use strict';
// r27c 桌宠「状态一眼分清」：事件道具分类、小圆点分色计数、会话状态灯（2026-11-17）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SpeechQueue, dotTone, finishedSessions, quotaIsLow, failureNotice } = require('../core/hub-pet/state');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { createHubPetController } = require('../main/hub-pet-controller');
const { prop, stateProp, label } = require('../renderer/hub-pet/pet-notices');
const { layout, diskInfo } = require('../renderer/hub-pet/pet-props');

const NOON = new Date(2026, 10, 17, 12).getTime();

test('事件道具：7 类各有专属道具；出错只认 err:true，警示色不算出错', () => {
  assert.equal(prop({ kind: 'session' }), 'done');
  assert.equal(prop({ kind: 'web' }), 'done');
  assert.equal(prop({ kind: 'answer' }), 'done');
  assert.equal(prop({ kind: 'awaiting-reply' }), 'wait');
  assert.equal(prop({ kind: 'update' }), 'gift');
  assert.equal(prop({ kind: 'disk', tone: 'bad' }), 'disk', '磁盘快满是硬盘道具，不是出错');
  assert.equal(prop({ kind: 'answer', tone: 'bad', err: true }), 'err');
  assert.equal(prop({ kind: 'session', err: true }), 'err');
  for (const item of [{ kind: 'answer', tone: 'bad' }, { kind: 'answer', tone: 'bad', err: 'true' }, { kind: 'attendance', tone: 'bad' }, { kind: 'room', tone: 'bad' }]) {
    assert.notEqual(prop(item), 'err', JSON.stringify(item));
    assert.notEqual(label(item), '出错了', JSON.stringify(item));
  }
  assert.equal(prop({ kind: 'answer', tone: 'bad' }), '', '警示色的回答不举绿牌');
  for (const kind of ['reminder', 'chatter', 'brief', 'bridge', 'growth']) assert.equal(prop({ kind }), '', kind);
  // 常驻：没在说时开会戴耳机、额度低亮低电量；说话的道具优先；躲边时什么都不挂。
  assert.equal(stateProp({ meeting: true }), 'meeting');
  assert.equal(stateProp({ quotaLow: true }), 'battery');
  assert.equal(stateProp({ meeting: true, quotaLow: true }), 'meeting');
  assert.equal(stateProp({ quotaLow: true, bubble: { kind: 'update' } }), 'gift');
  assert.equal(stateProp({ meeting: true, peeking: true }), '');
  assert.equal(stateProp({}), '');
});

test('道具位置跟着透明度轮廓走：头顶类对准头顶中线并让开头饰，手边类挂在轮廓右侧', () => {
  const g = { left: 0.2, right: 0.8, top: 0.1, bottom: 0.95, cx: 0.48, head: 0.14, width: 0.6, height: 0.85 };
  for (const kind of ['done', 'wait', 'err', 'meeting', 'gift', 'disk', 'battery']) {
    const parts = layout(kind, g);
    assert.ok(parts.length >= 1, kind);
    for (const p of parts) {
      assert.ok(/^<svg /.test(p.svg) && !/style=|<script/i.test(p.svg), kind + ' 只用矢量图，不带内联样式（窗口 CSP 不许）');
      assert.ok(p.x > -0.1 && p.x < 1.1 && p.y > -0.2 && p.y < 1.05, kind + ' 锚点在身体附近');
    }
  }
  assert.ok(layout('err', g)[0].x < g.cx && layout('err', g)[0].x > g.left - 0.05, '感叹号在头的左上侧（头顶正上方常被卡片下沿盖住）');
  assert.ok(layout('err', g)[0].y < g.head + g.height * 0.1, '感叹号在头部高度');
  assert.ok(layout('err', g)[1].x > g.cx, '汗珠在另一侧');
  assert.ok(layout('wait', g)[0].x < g.cx, '「…」朝左上冒，不和右上角的小圆点重叠');
  assert.equal(layout('battery', g)[0].x, g.cx, '低电量对准头顶中线');
  assert.ok(layout('battery', g, { crown: 0.2 })[0].y < layout('battery', g)[0].y - 0.19, '戴着头饰时低电量往上让开');
  assert.equal(layout('meeting', g)[0].x, g.cx, '耳机戴在头上');
  assert.ok(layout('done', g)[0].x > g.cx, '对勾牌举在身体一侧');
  assert.ok(Math.abs(layout('gift', g)[0].y - g.bottom) < 1e-9, '礼盒在脚边');
  assert.deepEqual(layout('', g), []);
  assert.deepEqual(layout('done', null), []);
  // 硬盘容量条读标题里的盘名和百分比
  assert.deepEqual(diskInfo('C 盘已经用了 94%'), { label: 'C 盘 94%', pct: 94 });
  assert.equal(diskInfo('乱写').label, '硬盘快满了');
  assert.ok(layout('disk', g, { bubble: { title: 'D 盘已经用了 91%' } })[0].svg.includes('D 盘 91%'));
  assert.ok(!layout('disk', g, { bubble: { title: 'C 盘<script> 已经用了 91%' } })[0].svg.includes('<script>'), '标题转义');
});

test('小圆点分色计数：答完绿、出错或警示橙、其余蓝；收起的卡片按类别落到对应颜色', () => {
  assert.equal(dotTone({ kind: 'session', notify: true }), 'ok');
  assert.equal(dotTone({ kind: 'answer', err: true }), 'bad');
  assert.equal(dotTone({ kind: 'disk', tone: 'bad' }), 'bad');
  assert.equal(dotTone({ kind: 'reminder' }), 'info');
  let t = NOON;
  const q = new SpeechQueue({ now: () => t });
  q.push({ id: 'a', kind: 'session', title: 'A 答完了', sessionId: 's1', notify: true });
  q.push({ id: 'b', kind: 'answer', title: '助理没答完', notify: true, tone: 'bad', err: true });
  q.push({ id: 'c', kind: 'disk', title: 'C 盘已经用了 94%', notify: true, tone: 'bad' });
  q.push({ id: 'd', kind: 'brief', title: '今日简报' });
  q.tick(() => ({ ok: false }));   // 开会或安静档：全部只进小圆点
  assert.equal(q.snapshot().dots, 4);
  assert.deepEqual(q.snapshot().dotTones, { ok: 1, bad: 2, info: 1 });
  q.takeDots();
  assert.deepEqual(q.snapshot().dotTones, { ok: 0, bad: 0, info: 0 });
});

test('答完、出错的会话按最新一条成灯；同一会话只留一盏，看过就熄', () => {
  const items = [
    { id: 'n1', kind: 'session', notify: true, sessionId: 's1', title: '登录页改版' },
    { id: 'n2', kind: 'session', notify: true, sessionId: 's2', title: '回归测试', err: true },
    { id: 'n3', kind: 'session', notify: true, sessionId: 's1', title: '登录页改版 第二轮' },
    { id: 'n4', kind: 'hub-reminder', notify: true, sessionId: 's9', title: '到点提醒' },
    { id: 'n5', kind: 'session', sessionId: 's8', title: '不是通知卡' },
  ];
  assert.deepEqual(finishedSessions(items), [
    { id: 's1', title: '登录页改版 第二轮', st: 'done', at: 0 },
    { id: 's2', title: '回归测试', st: 'err', at: 0 },
  ]);
});

function rig(t, sessions, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-r27c-'));
  const sent = [], toHub = [];
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
    isVisible() { return true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const bus = new NoticeBus({ now: () => NOON });
  let meeting = false;
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, noticeBus: bus, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: () => NOON, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: (channel, payload) => toHub.push({ channel, payload }), focusPrimaryWindow: () => {},
    getSessionActivity: () => ({ running: sessions.length, sessions, ...(opts.known ? { known: opts.known } : {}) }), inMeeting: () => meeting,
    ...(opts.quota ? { isQuotaLow: () => opts.quota.low } : {}) });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop();
  const pet = () => ({ sender: c.getWindow().webContents });
  return { c, bus, sent, toHub, ipcMain, state, pet, setMeeting: v => { meeting = v; } };
}

test('会话状态灯：在跑的排前面，答完和出错的各亮一盏；点灯直达会话并熄掉；关了「跟着会话」就不亮', t => {
  const sessions = [{ id: 'r1', title: '跑着的 A' }, { id: 'r2', title: '跑着的 B' }];
  const r = rig(t, sessions);
  r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 'd1', title: '答完的 C' });
  r.c.notify({ sessionId: 'r2', title: '又跑起来的 B' });
  r.c.notify({ sessionId: 'e1', title: '出错的 D', err: true });
  r.c.notify({ sessionId: 'w1', title: '只是警示色', tone: 'bad' });
  const lamps = r.state().lamps;
  assert.deepEqual(lamps.map(l => [l.id, l.st]), [['r1', 'run'], ['r2', 'run'], ['w1', 'done'], ['e1', 'err'], ['d1', 'done']]);
  assert.equal(r.state().bubble.err, undefined, '警示色的会话卡片不写出错');
  // 点灯：切到那个会话，答完的灯熄掉
  r.ipcMain.emit('hub-pet:open-session', r.pet(), 'd1');
  assert.deepEqual(r.toHub.at(-1), { channel: 'desktop-notification:open-session', payload: { sessionId: 'd1' } });
  assert.ok(!r.state().lamps.some(l => l.id === 'd1'));
  // 不是桌宠窗口发来的不认
  const before = r.toHub.length;
  r.ipcMain.emit('hub-pet:open-session', { sender: {} }, 'e1');
  assert.equal(r.toHub.length, before);
  r.c.setSettings({ followSessions: false });
  assert.deepEqual(r.state().lamps, []);
});

test('开会：状态里带 meeting，卡片只进小圆点并分色计数；额度低时带 quotaLow', t => {
  const r = rig(t, []);
  r.c.setSettings({ enabled: true });
  r.setMeeting(true);
  r.c._evaluate();
  assert.equal(r.state().meeting, true);
  r.c.notify({ sessionId: 's1', title: '会上答完的' });
  r.c.announceUpdate('9.9.9');
  assert.equal(r.state().bubble, null, '开会时不举卡片（规则不变）');
  assert.deepEqual(r.state().dotTones, { ok: 1, bad: 0, info: 1 });
  r.setMeeting(false);
  r.c.setSignal({ quotaLow: true });
  assert.equal(r.state().meeting, false);
  assert.equal(r.state().quotaLow, true);
});

// ---------- r27d 审查返工回归（2026-11-17，m69 审查 7 项中可在主进程/纯函数层验证的 1–5 项；6、7 在 CDP） ----------
test('r27d-1：卡片正在展示时点它的灯，卡片、灯一起收掉，超时后也不回到未读', t => {
  const r = rig(t, []); r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 'active-card', title: '刚答完' });
  assert.equal(r.state().bubble.sessionId, 'active-card');
  assert.ok(r.state().lamps.some(l => l.id === 'active-card'));
  r.ipcMain.emit('hub-pet:open-session', r.pet(), 'active-card');
  assert.deepEqual(r.toHub.at(-1), { channel: 'desktop-notification:open-session', payload: { sessionId: 'active-card' } });
  assert.equal(r.state().bubble, null, '卡片收掉');
  assert.deepEqual(r.state().lamps, [], '灯熄掉');
  assert.equal(r.state().dots, 0, '不进未读小圆点');
});

test('r27d-1：在主界面打开会话（session-seen）同样清掉正在展示的卡片和排队中的同会话通知', t => {
  const q = new SpeechQueue({ now: () => NOON });
  q.push({ id: 'a1', kind: 'session', title: 'A', sessionId: 'sA', notify: true });
  q.tick(() => ({ ok: true }));
  q.push({ id: 'b1', kind: 'session', title: 'B', sessionId: 'sB', notify: true });   // A 被挤进小圆点，B 在排队
  q.push({ id: 'a2', kind: 'session', title: 'A 又一条', sessionId: 'sA', notify: true });
  assert.equal(q.seenSession('sA'), true);
  assert.equal(q.snapshot().dots, 0);
  assert.equal(q.snapshot().pending, 1, '只剩 B');
  q.tick(() => ({ ok: true }));
  assert.equal(q.snapshot().bubble.sessionId, 'sB');
  q.hold(true);
  assert.equal(q.seenSession('sB'), true);
  assert.equal(q.snapshot().bubble, null);
  assert.equal(q.held, null, '释放悬停');
  assert.equal(q.seenSession('sZ'), false);

  const r = rig(t, []); r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 'seen-card', title: '刚答完' });
  r.c.sessionSeen('seen-card');
  assert.equal(r.state().bubble, null);
  assert.deepEqual(r.state().lamps, []);
});

test('r27d-2：灯跟着会话事实走——改名刷新标题、关闭即熄、新一轮开始后上一轮的结果不再亮', t => {
  const sessions = [], known = [{ id: 's1', title: '旧标题', startedAt: NOON - 60000 }, { id: 's2', title: '会关掉的', startedAt: NOON - 60000 }];
  const r = rig(t, sessions, { known }); r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 's1', title: '旧标题' });
  r.c.notify({ sessionId: 's2', title: '会关掉的' });
  assert.deepEqual(r.state().lamps.map(l => [l.id, l.st]), [['s2', 'done'], ['s1', 'done']]);
  known[0].title = '新标题'; r.c._evaluate();
  assert.equal(r.state().lamps.find(l => l.id === 's1').title, '新标题', '改名后标题取当前名字');
  known.splice(1, 1); r.c._evaluate();
  assert.ok(!r.state().lamps.some(l => l.id === 's2'), '关闭/休眠的会话不留灯');
  // m69 复现场景：新一轮开始（在跑）→ 活动列表清空（失败/休眠且没有新完成通知）→ 旧绿灯不能重现
  known[0].startedAt = NOON + 1000; sessions.push({ id: 's1', title: '新标题' }); r.c._evaluate();
  assert.deepEqual(r.state().lamps, [{ id: 's1', title: '新标题', st: 'run' }]);
  sessions.length = 0; r.c._evaluate();
  assert.deepEqual(r.state().lamps, [], '上一轮的完成灯不再亮');
});

test('r27d-2：没有会话事实（旧主进程、调试覆盖不带 known）时保持原行为', t => {
  const r = rig(t, []); r.c.setSettings({ enabled: true });
  r.c.notify({ sessionId: 'x1', title: '答完' });
  assert.deepEqual(r.state().lamps.map(l => [l.id, l.st]), [['x1', 'done']]);
});

test('r27d-3：真实失败事件 → err:true 通知 → 橙灯与「出错了」卡；助理、隐藏、群聊会话和中止不算', t => {
  const purposes = new Set(['company-assistant', 'hub-assistant']);
  const n = failureNotice({ title: '回归测试' }, 'f1', NOON, 'Codex turn failed', purposes);
  assert.deepEqual(n, { sessionId: 'f1', title: '回归测试 出错了', body: 'Codex turn failed', completedAt: NOON, tone: 'bad', err: true });
  assert.equal(failureNotice({ title: 'x', purpose: 'hub-assistant' }, 'f2', NOON, '', purposes), null);
  assert.equal(failureNotice({ title: 'x', hiddenFromSidebar: true }, 'f3', NOON, '', purposes), null);
  assert.equal(failureNotice({ title: 'x', meetingId: 'm1' }, 'f4', NOON, '', purposes), null);
  assert.equal(failureNotice(undefined, 'f5', NOON, '', purposes), null, '会话已不存在');
  const r = rig(t, [], { known: [{ id: 'f1', title: '回归测试', startedAt: NOON - 5000 }] }); r.c.setSettings({ enabled: true });
  assert.equal(r.c.routeDesktopNotice(n), true);
  assert.equal(r.c.routeDesktopNotice(n), true);   // 同一次失败重复上报
  assert.equal(r.state().bubble.err, true);
  assert.deepEqual(r.state().lamps, [{ id: 'f1', title: '回归测试', st: 'err' }]);
  assert.equal(r.state().dots, 0, '重复上报按 id 去重，不另起一张');
  // main.js 两条权威失败路径都接上了，中止路径没有
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.equal((main.match(/petTurnFailed\(/g) || []).length, 3, '定义 + Codex 失败 + CLI 退回终端');
  const aborted = main.slice(main.indexOf("transcriptTap.on('turn-aborted'"), main.indexOf("transcriptTap.on('turn-error'"));
  assert.ok(aborted.length > 0 && !aborted.includes('petTurnFailed'), '中止不亮橙灯');
});

test('r27d-4：额度快用完按当前账号读数判断，过了重置时间、读数过旧都算恢复；控制器每次轮询跟随', t => {
  const H = 3600000;
  assert.equal(quotaIsLow({ usage5h: { pct: 92, resetsAt: NOON + H }, ts: NOON }, NOON), true);
  assert.equal(quotaIsLow({ usage5h: { pct: 40, resetsAt: NOON + H }, usage7d: { pct: 95, resetsAt: NOON + 48 * H }, ts: NOON }, NOON), true);
  assert.equal(quotaIsLow({ usage5h: { pct: 89.9, resetsAt: NOON + H }, ts: NOON }, NOON), false);
  assert.equal(quotaIsLow({ usage5h: { pct: 99, resetsAt: NOON - 1 }, ts: NOON - 2 * H }, NOON), false, '已过重置时间');
  assert.equal(quotaIsLow({ usage5h: { pct: 99, resetsAt: 0 }, ts: NOON - 2 * H }, NOON), false, '不知重置时间且读数过旧');
  assert.equal(quotaIsLow({ usage5h: { pct: 99, resetsAt: 0 }, ts: NOON - 60000 }, NOON), true);
  assert.equal(quotaIsLow({ usage5h: null, usage7d: null, ts: 0 }, NOON), false, '切到没有读数的新账号');
  assert.equal(quotaIsLow(null, NOON), false);
  const quota = { low: true };
  const r = rig(t, [], { quota }); r.c.setSettings({ enabled: true });
  r.c._evaluate();
  assert.equal(r.state().quotaLow, true);
  assert.equal(stateProp(r.state()), 'battery');
  quota.low = false; r.c._evaluate();
  assert.equal(r.state().quotaLow, false, '恢复/切号后熄');
  r.c.setSignal({ quotaLow: true }); assert.equal(r.state().quotaLow, true, '调试可强制');
  r.c.setSignal({ quotaLow: null }); assert.equal(r.state().quotaLow, false, 'null 回到跟随真实额度');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /isQuotaLow:[\s\S]{0,500}quotaIsLow\(claudeCache\(\), t\)/, '生产入口读当前账号用量');
});

test('r27d-5：安静档不挂道具和低电量、不亮会话灯；开会耳机保留（quiet×meeting×quotaLow×running 组合）', t => {
  const quota = { low: true };
  const r = rig(t, [{ id: 'q1', title: '在跑' }], { quota }); r.c.setSettings({ enabled: true, mode: 'quiet' });
  for (const meeting of [false, true]) {
    r.setMeeting(meeting); r.c._evaluate();
    const s = r.state();
    assert.equal(s.mode, 'quiet');
    assert.equal(stateProp(s), meeting ? 'meeting' : '', `quiet meeting=${meeting}`);
    assert.equal(stateProp({ ...s, bubble: { kind: 'session', notify: true } }), meeting ? 'meeting' : '', '安静档事件道具也不挂');
  }
  // 灯的屏蔽在渲染端：安静档传空列表（CDP 另有实测）
  const petJs = fs.readFileSync(path.join(__dirname, '../renderer/hub-pet/pet.js'), 'utf8');
  assert.match(petJs, /showLamps\(state\.peeking \|\| state\.mode === 'quiet' \? \[\] : state\.lamps\)/);
  // 温和档同样组合：低电量、耳机、灯都在
  r.c.setSettings({ mode: 'gentle' }); r.setMeeting(false); r.c._evaluate();
  assert.equal(stateProp(r.state()), 'battery');
  assert.deepEqual(r.state().lamps.map(l => l.st), ['run']);
  r.setMeeting(true); r.c._evaluate();
  assert.equal(stateProp(r.state()), 'meeting');
});

// ---------- r27e 复审返工（m71）：安静档不退回「N 个在跑」；桌宠只认本回合的失败 ----------
function petShowBusy(state, lampList) {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/hub-pet/pet.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function showBusy(');
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  const busyEl = { hidden: true }, text = { textContent: '' };
  const showBusy = require('node:vm').runInNewContext(`(${body})`, { state, lampList, busyEl, $: () => text });
  return n => { showBusy(n); return { hidden: busyEl.hidden, text: text.textContent }; };
}

test('r27e-1：安静档灯藏起来后也不显示旋转的「N 个在跑」，只留小圆点；温和档无灯时照旧显示', () => {
  assert.equal(petShowBusy({ mode: 'quiet' }, [])(2).hidden, true, '安静档 lampList 为空也不能退回旋转提示');
  assert.equal(petShowBusy({ mode: 'quiet', peeking: false }, [])(1).hidden, true);
  const gentle = petShowBusy({ mode: 'gentle' }, [])(2);
  assert.deepEqual(gentle, { hidden: false, text: '2 个在跑' }, '拿不到会话列表的温和档仍有兜底提示');
  assert.equal(petShowBusy({ mode: 'gentle' }, [{ id: 'a' }])(2).hidden, true, '有灯时由灯代替');
  assert.equal(petShowBusy({ mode: 'gentle', peeking: true }, [])(2).hidden, true, '躲边不显示');
  assert.equal(petShowBusy({ mode: 'gentle' }, [])(0).hidden, true);
});

function realFailureHandler(r, turn) {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const helper = main.slice(main.indexOf('function petTurnFailed('), main.indexOf('// Stop 到了但最后一条没有正文'));
  const handler = main.slice(main.indexOf("transcriptTap.on('turn-error'"), main.indexOf("transcriptTap.on('prompt-submitted'"));
  assert.ok(helper.length > 0 && handler.length > 0, 'main.js 里找得到失败处理器');
  const { SessionManager } = require('../core/session-manager');
  const manager = Object.create(SessionManager.prototype); EventEmitter.call(manager);
  manager.sessions = new Map([[turn.id, { info: { id: turn.id, title: '当前会话', kind: 'codeagent' }, ...turn.entry }]]);
  const real = SessionManager.prototype.noteAgentTurnFinished;
  manager.noteAgentTurnFinished = (...args) => (r.accepted = real.apply(manager, args));
  let listener;
  require('node:vm').runInNewContext(helper + handler, {
    require: name => name === './core/hub-pet/state' ? require('../core/hub-pet/state') : require(name),
    sessionManager: manager,
    completionNotifier: { noteTurnFailed() {} }, codexAccountSwitch: { onFailure: async () => {} },
    codexAccountTurnEvent: x => x, sendToRenderer() {}, hubPetController: r.c,
    HUB_PET_ASSISTANT_PURPOSES: new Set(), transcriptTap: { on: (name, fn) => { if (name === 'turn-error') listener = fn; } }, console,
  });
  return { fire: listener, manager };
}

test('r27e-2：上一轮迟到的失败（旧回合标识 / 早于本回合开始）不弹出错卡、不亮橙灯，新回合运行中和结束后都一样', t => {
  const cases = [
    { name: '旧回合标识', ev: { turnId: 'previous-turn', failedAt: NOON } },
    { name: '早于本回合开始', ev: { failedAt: NOON - 1000 } },
    { name: '旧标识且更早', ev: { turnId: 'previous-turn', failedAt: NOON - 1000 } },
  ];
  for (const { name, ev } of cases) {
    const id = 'late-' + name;
    const sessions = [{ id, title: '当前会话' }];
    const r = rig(t, sessions, { known: [{ id, title: '当前会话', startedAt: NOON - 500 }] });
    r.c.setSettings({ enabled: true });
    const { fire, manager } = realFailureHandler(r, { id, entry: { agentTurnActive: true, agentTurnId: 'current-turn', agentTurnStartedAt: NOON - 500 } });
    assert.equal(manager.isCurrentAgentTurnEvent(id, ev), false, name);
    fire({ hubSessionId: id, message: '上一轮迟到的失败', ...ev });
    assert.equal(r.accepted, false, name + '：会话管理器拒绝');
    assert.notEqual(r.state().bubble && r.state().bubble.err, true, name + '：新回合运行中不弹上一轮的出错卡');
    assert.ok(!r.state().lamps.some(l => l.st === 'err'), name + '：运行中没有橙灯');
    sessions.length = 0; r.c._evaluate();
    assert.ok(!r.state().lamps.some(l => l.st === 'err'), name + '：新回合结束后也不留橙灯');
  }
});

test('r27e-3：本回合合法失败照旧弹出错卡、亮橙灯——运行中失败、Stop 先到失败后到都算', t => {
  for (const stopFirst of [false, true]) {
    const id = stopFirst ? 'stop-first' : 'running-fail';
    const r = rig(t, [], { known: [{ id, title: '当前会话', startedAt: NOON - 1000 }] });
    r.c.setSettings({ enabled: true });
    const { fire, manager } = realFailureHandler(r, { id, entry: { agentTurnActive: !stopFirst, agentTurnId: 'current-turn', agentTurnStartedAt: NOON - 1000 } });
    const ev = { turnId: 'current-turn', failedAt: NOON };
    assert.equal(manager.isCurrentAgentTurnEvent(id, ev), true);
    fire({ hubSessionId: id, message: '网络中断', ...ev });
    assert.equal(r.accepted, !stopFirst, stopFirst ? 'Stop 先到时管理器已不在跑' : '运行中失败被管理器接受');
    assert.equal(r.state().bubble.err, true, `stopFirst=${stopFirst}：弹出错卡`);
    assert.deepEqual(r.state().lamps, [{ id, title: '当前会话', st: 'err' }], `stopFirst=${stopFirst}：保留本回合橙灯`);
  }
});
