'use strict';
// 会议页增量拉取（2026-11-25 后台开销）：只追加 → 增量；非追加改动 / 换会议 / 版本不对 → 全量；任意一串更新后页面合并结果 = 全量；老调用回全量。
// 另测：会议列表 15 秒内不重扫目录、建删改名状态变化立即失效；tick 空闲车道不复制会议。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { applyMeetingDelta } = require('../renderer/company-meeting-delta');

const ipc = x => JSON.parse(JSON.stringify(x)); // 过 IPC 等于一次结构化复制
function companion(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-delta-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null },
    { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} }, flushMs: 60000 });
  m.tools = { start: async () => {}, bind() {}, close() {}, unbind() {} }; m.start = () => {}; m.tick = async () => {};
  t.after(() => { if (!m.closed) m.close(); });
  return m;
}
// 模拟页面：手里一份会议和版本，按渲染端同样的规则拉取、合并。
function page(m, id) {
  let state = ipc(m.status(id));
  return {
    pull(force = false) {
      const since = !force && state.meeting?.id === id ? state.meetingRev : null;
      const next = ipc(since ? m.status(id, since) : m.status(id));
      if (next.meetingDelta) { next.meeting = applyMeetingDelta(state.meeting, next.meetingDelta); delete next.meetingDelta; next.wasDelta = true; }
      state = next; return next;
    },
    get state() { return state; },
  };
}
const full = (m, id) => ipc(m.status(id)).meeting;

test('只追加 → 增量里只有新事件；老调用（不带版本）照旧回全量', t => {
  const m = companion(t), meeting = m.create();
  for (let i = 1; i <= 50; i++) m.capture(meeting.id, { kind: 'mark', at: i * 1000, text: '重点' + i });
  const p = page(m, meeting.id);
  m.capture(meeting.id, { kind: 'mark', at: 51000, text: '新的' }); m.capture(meeting.id, { kind: 'heartbeat', at: 52000 });
  const raw = ipc(m.status(meeting.id, p.state.meetingRev));
  assert.equal(raw.meeting, null); assert.equal(raw.meetingDelta.events.length, 1); assert.equal(raw.meetingDelta.events[0].text, '新的');
  assert.equal(raw.meetingDelta.fields.capturedMs, 52000, '心跳进度也在增量里');
  assert.ok(JSON.stringify(raw).length < 20000, '增量小于 20 KB');
  p.pull(); assert.deepEqual(p.state.meeting, full(m, meeting.id));
  const old = ipc(m.status(meeting.id)); assert.equal(old.meeting.events.length, 51); assert.equal(old.meetingDelta, undefined);
});

test('非追加改动（补转写回填、改发言人名、改已有事件）→ 增量带上改过的那几条，合并后与全量一致', t => {
  const m = companion(t), meeting = m.create(), p = page(m, meeting.id);
  for (let i = 1; i <= 5; i++) m.capture(meeting.id, { kind: 'mark', at: i * 1000, text: 'x' + i });
  p.pull();
  const x = m.load(meeting.id); x.events[1].text = '改过的第二条'; x.speakers = { s1: '张三' }; x.summary = '纪要'; m.save(x);
  const r = p.pull(); assert.ok(r.wasDelta); assert.deepEqual(r.meeting, full(m, meeting.id));
  const y = m.load(meeting.id); delete y.speakers; m.save(y);
  const r2 = p.pull(); assert.ok(r2.wasDelta); assert.equal('speakers' in r2.meeting, false, '删掉的字段合并后也没了'); assert.deepEqual(r2.meeting, full(m, meeting.id));
});

test('事件变少 / 换会议 / 版本对不上 / 版本比现在新 / 正本重读过 → 回全量', t => {
  const m = companion(t), a = m.create(); for (let i = 1; i <= 3; i++) m.capture(a.id, { kind: 'mark', at: i * 1000, text: 'a' + i });
  const rev = ipc(m.status(a.id)).meetingRev;
  const x = m.load(a.id); x.events.pop(); m.save(x);
  assert.ok(ipc(m.status(a.id, rev)).meeting, '事件变少回全量');
  const now = ipc(m.status(a.id)).meetingRev;
  assert.ok(ipc(m.status(a.id, { ...now, id: 'other' })).meeting, '版本属于别的会议');
  assert.ok(ipc(m.status(a.id, { ...now, epoch: 'zzzz' })).meeting, 'epoch 不同');
  assert.ok(ipc(m.status(a.id, { ...now, rev: now.rev + 5 })).meeting, '版本比现在新');
  assert.ok(ipc(m.status(a.id, { ...now, rev: 'x' })).meeting, '版本不是数字');
  m.control(a.id, 'stop'); const before = ipc(m.status(a.id)).meetingRev;
  const file = path.join(m.dir(a.id), 'meeting.json'), later = new Date(Date.now() + 10000); fs.utimesSync(file, later, later);
  assert.ok(ipc(m.status(a.id, before)).meeting, '盘上被改过、正本重读：回全量');
  assert.equal(ipc(m.status(a.id, ipc(m.status(a.id)).meetingRev)).meeting, null, '重读后拿新版本又能增量');
});

test('任意一串更新后，页面合并结果 = 全量（随机 300 步）', t => {
  const m = companion(t), meeting = m.create(), p = page(m, meeting.id);
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let at = 0, fulls = 0, deltas = 0;
  for (let step = 0; step < 300; step++) {
    const k = rnd(); at += 500;
    if (k < 0.35) m.capture(meeting.id, { kind: 'mark', at, text: '重点' + step });
    else if (k < 0.45) m.capture(meeting.id, { kind: 'heartbeat', at });
    else if (k < 0.55) { const x = m.load(meeting.id); if (x.events.length) { x.events[Math.floor(rnd() * x.events.length)].text = '改' + step; m.save(x); } }
    else if (k < 0.65) { const x = m.load(meeting.id); x.answers.push({ id: 'q' + step, q: '问' + step, state: 'queued', queuedAt: at }); m.save(x); }
    else if (k < 0.75) { const x = m.load(meeting.id); const q = x.answers[Math.floor(rnd() * x.answers.length)]; if (q) { q.state = rnd() < 0.5 ? 'done' : 'running'; q.answer = '答' + step; m.save(x); } }
    else if (k < 0.82) { const x = m.load(meeting.id); x.summary = '纪要' + step; if (rnd() < 0.5) delete x.lastChange; else x.lastChange = '变' + step; m.save(x); }
    else if (k < 0.85) { const x = m.load(meeting.id); x.events = x.events.slice(0, Math.max(0, x.events.length - 1)); m.save(x); }
    else if (k < 0.88) { const x = m.load(meeting.id); x.answers.shift(); m.save(x); }
    if (rnd() < 0.6) { const r = p.pull(rnd() < 0.05); r.wasDelta ? deltas++ : fulls++; assert.deepEqual(r.meeting, full(m, meeting.id), `第 ${step} 步合并结果与全量不一致`); }
  }
  assert.ok(deltas > fulls, `大多数是增量（增量 ${deltas}、全量 ${fulls}）`);
});

test('会议列表：15 秒内复用、不扫目录；新建、改名、状态变化、删除立即失效', async t => {
  const m = companion(t), a = m.create({ title: '一' });
  m.list(); const readdir = t.mock.method(fs, 'readdirSync');
  m.status(a.id); m.status(a.id); m.list();
  assert.equal(readdir.mock.calls.filter(c => String(c.arguments[0]).endsWith('meetings')).length, 0, '复用期内不扫目录');
  m.rename(a.id, '改名'); assert.equal(m.list().find(x => x.id === a.id).title, '改名');
  m.control(a.id, 'stop'); assert.equal(m.list().find(x => x.id === a.id).state, 'ended');
  const b = m.create({ title: '二' }); assert.ok(m.list().some(x => x.id === b.id));
  m.control(b.id, 'stop'); await m.remove(b.id); assert.ok(!m.list().some(x => x.id === b.id));
});

test('tick：空闲车道只看只读正本，不复制会议', async t => {
  const m = companion(t), meeting = m.create(); const x = m.load(meeting.id); x.primeRequested = false; x.autoUnderstand = false; m.save(x);
  const load = t.mock.method(m, 'load');
  await m.runLane(meeting.id, 'job'); await m.runLane(meeting.id, 'questionJob');
  assert.equal(load.mock.callCount(), 0);
});

const { createStatusPuller } = require('../renderer/company-meeting-delta');
function fakeCall() {
  const calls = [];
  const call = (op, args) => new Promise((resolve, reject) => calls.push({ op, args, resolve, reject }));
  return { calls, call };
}
const fullReply = (id, rev) => ({ ok: true, meeting: { id, events: [], answers: [] }, meetingRev: { id, epoch: 'e', rev } });

test('复审 P2-1：会议页隐藏时任何入口都不发 meeting-status（含问答推送安排的详情刷新），推送照常改本地状态', async () => {
  let hidden = false; const f = fakeCall(), puller = createStatusPuller({ call: f.call, hidden: () => hidden });
  let state = null; const p = puller.pull('m1', () => state); f.calls[0].resolve(fullReply('m1', 1)); state = (await p).next;
  hidden = true;
  state.meeting.answers.push({ id: 'q1', state: 'running' }); // 推送改本地状态
  for (let i = 0; i < 5; i++) assert.equal(await puller.pull('m1', () => state), null);
  assert.equal(f.calls.length, 1, '隐藏期间没有再发请求');
  const src = fs.readFileSync(path.join(__dirname, '../renderer/company-meeting-page.js'), 'utf8');
  assert.match(src, /async function refresh\(\) \{\s*if \(!root\?\.isConnected \|\| root\.hidden\) return;/, 'refresh 入口统一拦住隐藏状态（推送详情刷新、模型清单更新都走 refresh）');
});

test('复审 P2-2：增量请求在途时切走再切回，切回后的那次一定是全量；请求失败时全量标记还回去', async () => {
  const f = fakeCall(), puller = createStatusPuller({ call: f.call, hidden: () => false });
  let state = null;
  let p = puller.pull('m1', () => state); f.calls[0].resolve(fullReply('m1', 1)); state = (await p).next;
  p = puller.pull('m1', () => state); assert.ok(f.calls[1].args.since, '第二次带版本（增量）');
  puller.markFull(); // 在途期间切走再切回
  f.calls[1].resolve({ ok: true, meeting: null, meetingDelta: { id: 'm1', from: 1, fields: { title: 'x' }, unset: [], events: [], answers: [] }, meetingRev: { id: 'm1', epoch: 'e', rev: 2 } });
  state = (await p).next; assert.equal(state.meeting.title, 'x');
  assert.equal(puller.fullPending, true, '旧响应没清掉切回时的全量标记');
  p = puller.pull('m1', () => state); assert.equal(f.calls[2].args.since, undefined, '切回后那次是全量');
  f.calls[2].reject(new Error('断了')); await assert.rejects(p);
  assert.equal(puller.fullPending, true, '全量请求失败：标记还回去');
  p = puller.pull('m1', () => state); assert.equal(f.calls[3].args.since, undefined, '下一次仍是全量');
  f.calls[3].resolve(fullReply('m1', 3)); await p; assert.equal(puller.fullPending, false);
});

// 2026-11-25 复审：会议模型清单的配置目录缓存，继承目录的采用判定一变就重算，不再拿旧目录读 30 秒。
test('配置目录缓存：继承判定变化后立即换用新目录读模型清单', t => {
  const cfg = require('../core/codeagent-config'), models = require('../core/codeagent-models'), ctx = require('../core/company-assistant/meeting-context');
  let provider = {}; try { provider = require('../core/hub-config').getConfig()?.providers?.codeagent || {}; } catch { provider = {}; }
  if (process.env.AI_HUB_CODEAGENT_CONFIG_DIR || provider.configDir) { t.skip('本机显式指定了配置目录，继承判定不起作用'); return; }
  const variable = cfg.configDirEnvName(process.env, provider), before = process.env[variable], decision = cfg.getInheritedDecision(), original = models.modelOptions;
  t.after(() => { if (before === undefined) delete process.env[variable]; else process.env[variable] = before; cfg.setInheritedDecision(decision); models.modelOptions = original; });
  process.env[variable] = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-cfg-'));
  const inherited = cfg.inheritedConfigDir(process.env, provider), seen = [];
  models.modelOptions = (_dataDir, { configDir }) => { seen.push(configDir); return []; };
  cfg.setInheritedDecision({ adopt: false, variable, inherited });
  ctx.modelOptions({ dataDir: os.tmpdir() });
  cfg.setInheritedDecision({ adopt: true, variable, inherited });
  ctx.modelOptions({ dataDir: os.tmpdir() });
  assert.notEqual(seen[0], seen[1], '判定从不采用变成采用：目录要跟着变');
  assert.equal(path.resolve(seen[1]), path.resolve(inherited));
});
