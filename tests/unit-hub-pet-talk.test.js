'use strict';
// 桌宠话术扩充、起名、一键回应（2026-11-17 r27g）。由 unit-hub-pet-notify.test.js 引入一起跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SpeechQueue, chatterFor, speakGate } = require('../core/hub-pet/state');
const talk = require('../core/hub-pet/talk');
const { LINES } = require('../core/hub-pet/talk-lines');
const { createSettingsStore } = require('../core/hub-pet/settings');

// 2026-11-18 周三；11-16 周一；11-20 周五；11-21 周六。
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
// 固定种子的随机数，分布测试可复现。
const lcg = (seed = 7) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

test('话术：100 句以上、每个情境至少 3 句、单句不超过三行气泡、整体小于 20 KB、不写人名', () => {
  assert.ok(talk.lineCount() >= 100, '共 ' + talk.lineCount() + ' 句');
  for (const [ctx, list] of Object.entries(LINES)) {
    assert.ok(list.length >= 3, ctx);
    for (const l of list) {
      assert.ok(talk.TYPES.includes(l.t), ctx + ' 类型 ' + l.t);
      assert.ok(Array.from(l.s.replace('{name}', '一二三四五六七八')).length <= 36, '太长：' + l.s);
      assert.doesNotMatch(l.s, new RegExp(['\u7530\u54e5', '老板', '亲爱的', '宝贝', '主人'].join('|')), '措辞要中性：' + l.s);
    }
    const ids = list.map(l => talk.lineId(ctx, l.s));
    assert.equal(new Set(ids).size, ids.length, ctx + ' 有重复句');
  }
  const bytes = fs.statSync(path.join(__dirname, '../core/hub-pet/talk-lines.js')).size;
  assert.ok(bytes < 20 * 1024, 'talk-lines.js ' + bytes + ' 字节');
});

test('同一情境短期内不重复：通用早安 13 句轮完才重来；周一、周末的句子只在当天出现', () => {
  let recent = [];
  const seen = new Set();
  const rng = lcg(3);
  const wed = LINES.greet.filter(l => !l.d).length;
  for (let i = 0; i < wed; i++) {
    const line = talk.pickLine('greet', { now: at(18, 9), recent, rng });
    assert.ok(!seen.has(line.id), '第 ' + (i + 1) + ' 句重复了：' + line.text);
    seen.add(line.id); recent = talk.noteSpoken(recent, line.id);
  }
  assert.ok(talk.pickLine('greet', { now: at(18, 9), recent, rng }), '轮完后照样能说');
  const monText = new Set(LINES.greet.filter(l => l.d === 'mon').map(l => l.s));
  const weekendText = new Set(LINES.greet.filter(l => l.d === 'weekend').map(l => l.s));
  for (let i = 0; i < 60; i++) {
    const wedLine = talk.pickLine('greet', { now: at(18, 9), rng });
    assert.ok(!monText.has(wedLine.text) && !weekendText.has(wedLine.text), '周三说了别的日子的话：' + wedLine.text);
  }
  let monHits = 0;
  for (let i = 0; i < 200; i++) if (/周一/.test(talk.pickLine('greet', { now: at(16, 9), rng }).text)) monHits++;
  assert.ok(monHits > 30, '周一的话在周一常出现：200 次里 ' + monHits);
  const sat = talk.pickLine('offwork', { now: at(21, 18, 10), rng });
  assert.ok(sat && !/周五/.test(sat.text));
  assert.equal(talk.noteSpoken(Array.from({ length: 80 }, (_, i) => 'greet-' + i), 'x-1').length, talk.RECENT_MAX);
});

test('起名：带 {name} 的句子用名字，没起名就读成「我」；名字去掉尖括号与花括号，最多 8 个字', () => {
  const rng = () => 0;
  const named = LINES.back.findIndex(l => l.s.includes('{name}'));
  assert.ok(named >= 0);
  const recent = LINES.back.slice(0, named).map(l => talk.lineId('back', l.s));
  const a = talk.pickLine('back', { now: at(18, 10), name: '团子', recent, rng });
  assert.match(a.text, /团子/); assert.equal(a.named, true);
  const b = talk.pickLine('back', { now: at(18, 10), name: '', recent, rng });
  assert.doesNotMatch(b.text, /\{name\}|团子/); assert.match(b.text, /我/); assert.equal(b.named, false);
  assert.equal(talk.cleanName('  <b>{小}橘子</b>超长的名字啊啊 '), 'b小橘子/b超长');
  assert.equal(talk.cleanName('\u0000\n'), '');
});

test('回应：点「少说」的那类说得少，净少说两次基本不说；点「喜欢」抵掉一次少说；久坐的「再等 20 分钟」', () => {
  let prefs = talk.normalizePrefs(null);
  const share = (p, n = 400) => { const rng = lcg(11); let chat = 0, total = 0; for (let i = 0; i < n; i++) { const l = talk.pickLine('back', { now: at(18, 10), prefs: p, rng }); if (!l) continue; total++; if (l.type === 'chat') chat++; } return { chat, total }; };
  const before = share(prefs);
  let r = talk.applyReply(prefs, { type: 'chat', choice: 'down' });
  prefs = r.prefs; assert.match(r.ack, /少闲聊/);
  const after = share(prefs);
  assert.ok(after.chat / after.total < before.chat / before.total - 0.15, `闲聊占比 ${before.chat}/${before.total} → ${after.chat}/${after.total}`);
  // 全是「关心」的久坐提醒：少说一次照样说（概率 0.5），少说两次基本不说。
  prefs = talk.applyReply(prefs, { type: 'care', choice: 'down' }).prefs;
  assert.equal(talk.pickLine('sit', { now: at(18, 10), prefs, rng: () => 0.9 }), null);
  assert.ok(talk.pickLine('sit', { now: at(18, 10), prefs, rng: () => 0.3 }));
  prefs = talk.applyReply(prefs, { type: 'care', choice: 'down' }).prefs;
  let said = 0; const rng = lcg(5);
  for (let i = 0; i < 100; i++) if (talk.pickLine('sit', { now: at(18, 10), prefs, rng })) said++;
  assert.ok(said < 20, '净少说两次后 100 次里只说了 ' + said + ' 次');
  prefs = talk.applyReply(prefs, { type: 'care', choice: 'up', name: '团子' }).prefs;
  assert.deepEqual(prefs.care, { up: 1, down: 1 });
  assert.match(talk.applyReply(prefs, { type: 'care', ctx: 'sit', choice: 'up', name: '团子' }).ack, /团子/, '久坐提醒点「这就起来」按情境回');
  assert.equal(talk.applyReply(prefs, { type: 'care', ctx: 'back', choice: 'up' }).ack, '嗯，照顾好自己。');
  assert.equal(talk.applyReply(prefs, { choice: 'snooze' }).ack, '行，20 分钟后再叫你。');
  assert.deepEqual(talk.pickLine('sit', { now: at(18, 10) }).chips.map(c => c.id), ['up', 'snooze']);
  assert.deepEqual(talk.pickLine('back', { now: at(18, 10), rng: () => 0 }).chips.map(c => c.id), ['up', 'down']);
  assert.deepEqual(talk.normalizePrefs({ care: { up: 99, down: -3 } }).care, { up: 20, down: 0 });
});

test('情境：下午、工作日下班、深夜跨零点算同一晚、散会、连着答完 3 个、久坐与再等 20 分钟', () => {
  const T = {};
  const say = (now, extra = {}) => chatterFor('lively', { now, idleSec: 0, ...extra }, T);
  T.greetedDate = '2026-11-18'; T.lunchDate = '2026-11-18';
  T.activeSince = at(18, 15, 0); T.sitRemindedAt = at(18, 15, 0);
  assert.match(say(at(18, 15, 20)).id, /^chatter-afternoon-/);
  assert.equal(say(at(18, 15, 40)), null, '下午一天一次');
  T.activeSince = at(18, 17, 50); T.sitRemindedAt = at(18, 17, 50);
  assert.match(say(at(18, 18, 5)).id, /^chatter-offwork-/);
  const sat = {}; sat.greetedDate = '2026-11-21'; sat.activeSince = at(21, 18); sat.sitRemindedAt = at(21, 18);
  assert.equal(chatterFor('lively', { now: at(21, 18, 5), idleSec: 0 }, sat), null, '周末不说下班');
  T.activeSince = at(18, 23, 0); T.sitRemindedAt = at(18, 23, 0);
  assert.match(say(at(18, 23, 5)).id, /^chatter-late-/);
  T.activeSince = at(19, 0, 30);
  assert.equal(say(at(19, 0, 40)), null, '过了零点还是同一晚，不再说深夜');
  // 散会：开会时不说，录制一停、人在电脑前就说一句
  T.activeSince = at(19, 10); T.sitRemindedAt = at(19, 10); T.greetedDate = '2026-11-19';
  assert.equal(say(at(19, 10, 5), { meeting: true }), null);
  assert.match(say(at(19, 10, 40), { meeting: false }).id, /^chatter-meetingAfter-/);
  assert.equal(say(at(19, 10, 41)), null);
  // 连着答完 3 个
  const doneAt = [at(19, 10, 42), at(19, 10, 50), at(19, 10, 55)];
  assert.equal(say(at(19, 10, 56), { doneAt: doneAt.slice(0, 2) }), null);
  assert.match(say(at(19, 10, 56), { doneAt }).id, /^chatter-done-/);
  assert.equal(say(at(19, 10, 57), { doneAt }), null, '两小时内只说一次');
  // 久坐 90 分钟 → 点了「再等 20 分钟」→ 20 分钟后换一组话再提醒
  const sit = say(at(19, 12, 30));
  assert.match(sit.id, /^chatter-sit-/);
  assert.deepEqual(sit.chips.map(c => c.id), ['up', 'snooze']);
  T.sitSnoozeUntil = at(19, 12, 50);
  assert.equal(say(at(19, 12, 49)), null);
  assert.match(say(at(19, 12, 50)).id, /^chatter-sitAgain-/);
  // 温和档照样不闲聊，但开会状态照记
  const g = { inMeeting: true };
  assert.equal(chatterFor('gentle', { now: at(19, 14), idleSec: 0 }, g), null);
  assert.equal(g.inMeeting, false); assert.ok(g.meetingEndedAt);
});

test('回应后的那一句：不计入每小时开口次数，不进小圆点，开会时直接丢掉', () => {
  let t = at(18, 10);
  const q = new SpeechQueue({ now: () => t });
  const gate = (spokenAt, item) => speakGate({ mode: 'lively' }, { now: t }, spokenAt, item);
  q.push({ id: 'c1', kind: 'chatter', title: '回来啦。', chips: [{ id: 'up', label: '挺好' }, { id: 'bad', label: 'x' }, { id: 'down', label: '少闲聊' }], talk: { line: 'back-1', type: 'chat', ctx: 'back' } });
  q.tick(gate);
  assert.deepEqual(q.snapshot().bubble.chips, [{ id: 'up', label: '挺好' }, { id: 'down', label: '少闲聊' }]);
  assert.equal(q.spokenAt.length, 1);
  q.takeCurrent();
  q.push({ id: 'ack-1', kind: 'chatter', title: '那我以后多聊两句。', ack: true, ms: 2600 });
  q.tick(gate);
  assert.equal(q.snapshot().bubble.id, 'ack-1');
  assert.equal(q.spokenAt.length, 1, '回应那句不计数');
  assert.equal(q.nextDeadline(), t + 2600);
  t += 2700; q.tick(gate);
  assert.equal(q.snapshot().bubble, null);
  assert.equal(q.snapshot().dots, 0, '回应那句不进小圆点');
  q.push({ id: 'ack-2', kind: 'chatter', title: '好。', ack: true });
  q.tick((spokenAt, item) => speakGate({ mode: 'lively' }, { now: t, meeting: true }, spokenAt, item));
  assert.equal(q.snapshot().bubble, null); assert.equal(q.snapshot().dots, 0);
});

function rig(t, now, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-talk-'));
  const sent = [];
  class FakeWindow extends EventEmitter {
    constructor(o) { super(); this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = (channel, payload) => sent.push({ channel, payload }); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(b) { this.bounds = { ...b }; }
    setIgnoreMouseEvents() {} setAlwaysOnTop() {} showInactive() {} focus() {} hide() {} show() {}
    loadFile() { return Promise.resolve(); }
    isVisible() { return true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const display = { workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
  const { createHubPetController } = require('../main/hub-pet-controller');
  const c = createHubPetController({ BrowserWindow: FakeWindow, ipcMain, dataDir: root,
    assetsDir: path.join(__dirname, '../renderer/assets/hub-pet'), htmlPath: 'fixture.html', preloadPath: 'fixture-preload.js',
    screen: { getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    powerMonitor: { getSystemIdleTime: () => 0 }, now: () => now.t, watchFullscreen: false, logger: { warn() {}, info() {} },
    sendToRenderer: () => {}, focusPrimaryWindow: () => {}, ...extra });
  t.after(() => { c.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const state = () => sent.filter(x => x.channel === 'hub-pet:state').map(x => x.payload).pop();
  const pet = () => ({ sender: c.getWindow().webContents });
  return { c, root, sent, state, ipcMain, pet };
}

test('真实控制器：起名后气泡带名字；回应按钮记进 hub-pet.json，重启后还记得；说过的句子也记着', t => {
  const now = { t: at(18, 9, 30) };
  const r = rig(t, now);
  r.c.setSettings({ enabled: true });
  r.c.setSettings({ petName: ' 团子 ' });
  assert.equal(r.c.getSettings().petName, '团子');
  assert.equal(r.state().bubble.title, '好，以后我就叫「团子」了。');
  assert.equal(r.c._speech.spokenAt.length, 0, '起名后的那句不计入开口次数');
  r.c._speech.takeCurrent();
  r.c.setSettings({ mode: 'lively' });
  // 早上第一次评估就会说早安：句子来自话术库，带回应按钮，记进说过的句子
  const greet = r.c._speech.snapshot().bubble || r.state().bubble;
  assert.ok(greet && greet.kind === 'chatter', JSON.stringify(greet));
  assert.equal(greet.chips.length, 2);
  if (!greet.named) assert.equal(r.state().bubble.name, '团子', '没带名字的句子，气泡小标签写名字');
  assert.equal(r.c.getSettings().talkRecent.length, 1);
  // 渲染端点「少说」：只认当前这句和它自己的按钮
  r.ipcMain.emit('hub-pet:reply', r.pet(), { id: 'not-current', choice: 'down' });
  assert.ok(r.state().bubble && r.state().bubble.id === greet.id, '对不上的回应不处理');
  const type = r.c._speech.current.talk.type;
  r.ipcMain.emit('hub-pet:reply', r.pet(), { id: greet.id, choice: 'down' });
  assert.equal(r.c.getSettings().talkPrefs[type].down, 1);
  assert.match(r.state().bubble.title, /知道了/);
  assert.equal(r.state().bubble.chips, undefined, '回应那句没有按钮');
  const saved = JSON.parse(fs.readFileSync(path.join(r.root, 'hub-pet.json'), 'utf8'));
  assert.equal(saved.petName, '团子'); assert.equal(saved.talkPrefs[type].down, 1); assert.equal(saved.talkRecent.length, 1);
  const again = createSettingsStore({ dataDir: r.root });
  assert.equal(again.get().petName, '团子'); assert.equal(again.get().talkPrefs[type].down, 1);
  // 久坐提醒点「再等 20 分钟」：20 分钟后再提醒
  now.t = at(18, 11, 30);
  r.c._speech.takeCurrent();
  const sitLine = talk.pickLine('sit', { now: now.t });
  r.c._speech.push({ id: 'chatter-sit-x', kind: 'chatter', title: sitLine.text, chips: sitLine.chips, talk: { line: sitLine.id, type: 'care', ctx: 'sit' } });
  r.c._evaluate();
  assert.equal(r.c._reply('chatter-sit-x', 'snooze'), true);
  assert.equal(r.c._chatterTrack.sitSnoozeUntil, at(18, 11, 50));
  assert.equal(r.state().bubble.title, '行，20 分钟后再叫你。');
  // 「忘掉我的回应」与清掉名字
  r.c.setSettings({ resetTalk: true, petName: '' });
  assert.deepEqual(r.c.getSettings().talkPrefs.care, { up: 0, down: 0 });
  assert.deepEqual(r.c.getSettings().talkRecent, []);
  assert.equal(r.c.getSettings().petName, '');
});

// ---------- r27g 审查返工（2026-11-17）：以下 4 项撤掉修复后都会失败 ----------

test('审查第 1 项：鼠标悬停暂停的闲聊，切到安静档或开会时立刻撤下，不一直挂着', t => {
  const now = { t: at(18, 10) };
  let meeting = false;
  const r = rig(t, now, { inMeeting: () => meeting });
  r.c.setSettings({ enabled: true, mode: 'lively', introduced: true });
  const greet = r.c._speech.snapshot().bubble;
  assert.ok(greet && greet.kind === 'chatter', '先说早安');
  assert.equal(r.c._speech.hold(true), true);
  r.c.setSettings({ mode: 'quiet' });
  now.t += 60000; r.c._evaluate();
  assert.equal(r.c._speech.snapshot().bubble, null, '安静档后悬停中的闲聊撤下');
  assert.equal(r.c._speech.held, null, '撤下时清掉悬停记录');
  assert.equal(r.state().bubble, null, '渲染端也收到撤下');
  // 开会：再来一句闲聊、悬停，再进会议
  r.c.setSettings({ mode: 'lively' });
  r.c._speech.push({ id: 'chatter-x', kind: 'chatter', title: '回来啦。' });
  r.c._evaluate();
  assert.equal(r.c._speech.snapshot().bubble.id, 'chatter-x');
  r.c._speech.hold(true);
  meeting = true; now.t += 60000; r.c._evaluate();
  assert.equal(r.c._speech.snapshot().bubble, null, '开会后悬停中的闲聊撤下');
  assert.ok(r.c._speech.dots.some(d => d.id === 'chatter-x'), '撤下的闲聊收进小圆点');
});

test('审查第 1 项：每小时上限、打盹不撤已在说的话（只有安静、静音、开会、全屏这类硬门禁才撤）', () => {
  let t = at(18, 10);
  const q = new SpeechQueue({ now: () => t });
  let ctx = { now: t };
  const gate = (spokenAt, item) => speakGate({ mode: 'lively' }, { ...ctx, now: t }, spokenAt, item);
  q.push({ id: 'c1', kind: 'chatter', title: '在呢。' });
  q.tick(gate);
  q.hold(true);
  q.spokenAt = [t, t, t, t, t];   // 已到每小时上限
  ctx = { pose: 'sleep' };
  t += 30000; q.tick(gate);
  assert.equal(q.snapshot().bubble && q.snapshot().bubble.id, 'c1', '上限、打盹不撤悬停中的气泡');
  ctx = { fullscreen: true };
  q.tick(gate);
  assert.equal(q.snapshot().bubble, null, '全屏撤下');
});

test('审查第 2 项：中文输入法确认候选字的 Enter 不保存名字，输入法结束后再按 Enter 才保存', async () => {
  const { mountPetSettingsTab } = require('../renderer/hub-pet/pet-settings-tab');
  const listeners = {}, writes = [];
  const nameEl = { value: 'tuan', selectionStart: 4, selectionEnd: 4, focus() {}, setSelectionRange() {}, closest: s => s.includes('data-pet-name') ? nameEl : null };
  const container = { classList: { add() {} }, isConnected: true, addEventListener: (k, f) => { listeners[k] = f; }, querySelector: () => nameEl };
  const data = { available: true, settings: { enabled: true, mode: 'gentle', petName: '', talkPrefs: talk.normalizePrefs(null) }, roles: [], modes: [] };
  const ipc = { on() {}, invoke: async (channel, patch) => { if (channel === 'hub-pet:set-settings') { writes.push(patch); return data; } return channel === 'hub-pet:get-settings' ? data : { roles: [], state: {} }; } };
  mountPetSettingsTab(container, { ipcRenderer: ipc, window: {}, document: { activeElement: nameEl } });
  const flush = () => new Promise(r => setTimeout(r, 5));
  await flush();
  const enter = extra => { let prevented = false; listeners.keydown({ target: nameEl, key: 'Enter', keyCode: 13, isComposing: false, ...extra, preventDefault() { prevented = true; } }); return prevented; };
  assert.equal(enter({ isComposing: true, keyCode: 229 }), false, '组合中不拦截，让输入法确认候选字');
  await flush();
  assert.deepEqual(writes, [], '组合中的 Enter 不保存');
  assert.equal(enter({ keyCode: 229 }), false, '只有 keyCode 229 也算输入法');
  await flush();
  assert.deepEqual(writes, []);
  // compositionend 后紧跟的那一下 Enter 也不算
  listeners.compositionstart({ target: nameEl });
  nameEl.value = '团子';
  listeners.compositionend({ target: nameEl });
  assert.equal(enter({}), false, 'compositionend 同一拍的 Enter 不保存');
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(enter({}), true, '输入法结束后的 Enter 保存');
  await flush();
  assert.deepEqual(writes, [{ petName: '团子' }]);
});

test('审查第 3 项：名字里的 $& $\' $` 按字面插入，不被当成替换模式', () => {
  const firstNamed = LINES.back.findIndex(l => l.s.includes('{name}'));
  assert.ok(firstNamed >= 0);
  const recent = LINES.back.slice(0, firstNamed).map(l => talk.lineId('back', l.s));
  const tpl = LINES.back[firstNamed].s;
  for (const name of ['$&', "$'", '$`', '$$']) {
    const line = talk.pickLine('back', { now: at(18, 10), name, recent, rng: () => 0 });
    assert.equal(line.text, tpl.split('{name}').join(name), '气泡：' + name);
    const ack = talk.applyReply(null, { type: 'care', choice: 'up', ctx: 'sit', name }).ack;
    assert.ok(ack.includes(name) && !ack.includes('{name}'), '回话：' + ack);
  }
});

test('审查第 4 项：点了「再等 20 分钟」后离开休息过，回来不再补发延后的久坐催促', () => {
  const tr = { greetedDate: '2026-11-18', activeSince: at(18, 10), sitRemindedAt: at(18, 10), sitSnoozeUntil: at(18, 10, 20) };
  chatterFor('lively', { now: at(18, 10, 5), idleSec: 301 }, tr);
  assert.equal(tr.sitSnoozeUntil, 0, '休息时作废本轮延后提醒');
  assert.equal(chatterFor('lively', { now: at(18, 10, 30), idleSec: 0 }, tr), null, '回来不立即催');
  // 没休息、一直在用：到点照常再提醒
  const busy = { greetedDate: '2026-11-18', activeSince: at(18, 10), sitRemindedAt: at(18, 10), sitSnoozeUntil: at(18, 10, 20) };
  chatterFor('lively', { now: at(18, 10, 5), idleSec: 10 }, busy);
  const again = chatterFor('lively', { now: at(18, 10, 21), idleSec: 10 }, busy);
  assert.ok(again && again.talk.ctx === 'sitAgain', JSON.stringify(again));
});
