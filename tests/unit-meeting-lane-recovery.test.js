'use strict';
// 理解会话不死（2026-11-24 用户截图「理解至 06:22」）：轮换关旧会话失败不挡路、旧会话退避重试关闭、理解失败自动重试 3 次。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { closeOwnedSession } = require('../core/company-ai-tasks');

function fixture(t, { closeFails = () => true, createFails = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-lane-')), sessions = new Map(), finals = new Map(), prompts = [], closes = [], creates = [];
  const clock = { t: 1_000_000 };
  const deps = { dataDir: root, now: () => clock.t, powerSaveBlocker: false, meetingModels: () => [], meetingAsr: { status: () => ({ ready: false }), close() {} },
    getSession: id => sessions.get(id),
    createSession: async (_kind, opts) => { creates.push(opts.id); if (createFails()) throw new Error('CodeAgent 会话创建失败'); sessions.set(opts.id, opts); },
    closeSession: async id => { closes.push(id); if (closeFails(id)) throw new Error('CodeAgent 任务会话尚未关闭'); sessions.delete(id); },
    sendPrompt: async (sid, prompt) => { prompts.push({ sid, prompt }); return { ok: true }; } };
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: id => finals.get(id) }, deps);
  m.tools = { start: async () => {}, bind() {}, close() {} }; m.tick = async () => {}; // 由测试逐步驱动 runLane
  t.after(() => { m.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const meeting = m.create({ title: '理解不死' }); clearInterval(m.timer); m.timer = 1;
  // 已经理解过 3 轮、预热完成的会话：下一轮必然轮换。
  Object.assign(meeting, { primeRequested: false, agent: { state: 'ready', at: clock.t }, understandingTurns: 3, autoUnderstand: false, requested: true });
  sessions.set(meeting.sessionId, { id: meeting.sessionId });
  m.event(meeting, 'transcript', { at: 1000, end: 2000, track: 'system', text: '步长定为 0.4' }); m.save(meeting);
  const reply = (sid, text) => { const job = m.load(meeting.id).job; finals.set(sid, { id: randomUUID(), text: `${text}\n[会议回执:${job.token}]` }); };
  return { m, id: meeting.id, oldId: meeting.sessionId, sessions, finals, prompts, closes, creates, clock, reply };
}

test('轮换时关旧会话失败不挡路：新会话照常发出理解，纪要继续出新版本', async t => {
  const fx = fixture(t);
  await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  let m = fx.m.load(fx.id);
  assert.notEqual(m.sessionId, fx.oldId, '换了新会话');
  assert.equal(m.job?.state, 'running', '理解没有停在 error');
  assert.equal(m.job.sessionId, m.sessionId);
  assert.equal(m.agent.state, 'starting');
  assert.match(fx.prompts.at(-1).prompt, /先读取 skills\/meeting-companion\/SKILL.md/, '读技能并进第一轮');
  assert.equal(m.pendingClose.length, 1); assert.equal(m.pendingClose[0].id, fx.oldId);
  assert.equal(m.pendingClose[0].count, 1); assert.equal(m.pendingClose[0].nextAt, fx.clock.t + 30000);
  assert.match(m.pendingClose[0].lastError, /尚未关闭/);
  // 新会话答完：纪要出第 1 版，记下换会话代价。
  fx.clock.t += 40000; fx.reply(m.sessionId, '- [D1] 步长定为 0.4 [事件 1]\n本轮小结：定了步长'); await fx.m.runLane(fx.id, 'job');
  m = fx.m.load(fx.id);
  assert.equal(m.revision, 1); assert.match(m.summary, /步长定为 0.4/); assert.equal(m.agent.state, 'ready');
  assert.equal(m.lastRotation.totalMs, 40000); assert.ok(m.lastRotation.startMs >= 0);
  const st = fx.m.status(fx.id);
  assert.equal(st.pendingClose.count, 1); assert.equal(st.pendingClose.attempts, 2, '30 秒后又试了一次'); assert.equal(st.understandingRetry, undefined);
});

test('旧会话按 30 秒、2 分钟…退避重试关闭，关掉就移除；一直关不掉满 6 次停手并写清', async t => {
  let fail = true; const fx = fixture(t, { closeFails: () => fail });
  await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  fx.clock.t += 29999; await fx.m.closePending(fx.id); assert.equal(fx.closes.length, 1, '没到点不重试');
  fx.clock.t += 1; await fx.m.closePending(fx.id); assert.equal(fx.closes.length, 2);
  let p = fx.m.load(fx.id).pendingClose[0]; assert.equal(p.count, 2); assert.equal(p.nextAt, fx.clock.t + 120000);
  fail = false; fx.clock.t += 120000; await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  assert.equal(fx.closes.length, 3); assert.equal(fx.m.load(fx.id).pendingClose, undefined); assert.equal(fx.sessions.has(fx.oldId), false);
  assert.equal(fx.m.status(fx.id).pendingClose, undefined);

  const fy = fixture(t);
  await fy.m.runLane(fy.id, 'job'); await fy.m.closing?.get(fy.id);
  for (let i = 0; i < 10; i++) { fy.clock.t += 600000; await fy.m.closePending(fy.id); }
  p = fy.m.load(fy.id).pendingClose[0];
  assert.equal(fy.closes.length, 6); assert.equal(p.count, 6); assert.equal(p.gaveUp, true); assert.equal(p.nextAt, undefined);
  assert.equal(fy.m.status(fy.id).pendingClose.gaveUp, true);
  // 会后：关不掉的旧会话停手后不再让会议常驻轮询。
  const ended = fy.m.load(fy.id); ended.state = 'ended'; ended.finalRequested = false; ended.job = null; ended.requested = false; fy.m.save(ended);
  assert.equal(fy.m.pending.has(fy.id), false);
});

test('理解失败按 30 秒、2 分钟、5 分钟自动重试 3 次，次数与下次时刻写进状态；3 次后保持 error 并写清原因', async t => {
  const fx = fixture(t, { createFails: () => true });
  const m0 = fx.m.load(fx.id); m0.understandingTurns = 0; fx.sessions.delete(m0.sessionId); fx.m.save(m0); // 会话没了，重建也失败
  await fx.m.runLane(fx.id, 'job');
  let m = fx.m.load(fx.id); assert.equal(m.job.state, 'error'); assert.equal(fx.creates.length, 1);
  await fx.m.runLane(fx.id, 'job'); m = fx.m.load(fx.id);
  assert.deepEqual({ count: m.understandingRetry.count, nextAt: m.understandingRetry.nextAt, kind: m.understandingRetry.lastError.kind }, { count: 0, nextAt: fx.clock.t + 30000, kind: 'start' });
  let st = fx.m.status(fx.id).understandingRetry;
  assert.equal(st.nextInMs, 30000); assert.equal(st.max, 3); assert.equal(st.lastError.label, '启动失败');
  assert.ok(fx.m.pending.has(fx.id));
  const backoff = [30000, 120000, 300000];
  for (let i = 0; i < 3; i++) {
    fx.clock.t += backoff[i] - 1; await fx.m.runLane(fx.id, 'job'); assert.equal(fx.creates.length, 1 + i, '没到点不重试');
    fx.clock.t += 1; await fx.m.runLane(fx.id, 'job'); assert.equal(fx.creates.length, 2 + i, `第 ${i + 1} 次重试`);
    await fx.m.runLane(fx.id, 'job'); // 记下这次失败
    m = fx.m.load(fx.id); assert.equal(m.understandingRetry.count, i + 1);
  }
  assert.equal(m.understandingRetry.nextAt, undefined); assert.match(m.understandingRetry.stopped, /已自动重试 3 次仍失败/);
  assert.equal(m.job.state, 'error'); assert.match(m.error, /创建失败/);
  fx.clock.t += 3600000; await fx.m.runLane(fx.id, 'job'); assert.equal(fx.creates.length, 4, '3 次后不再自动重试');
  st = fx.m.status(fx.id).understandingRetry; assert.equal(st.count, 3); assert.equal(st.nextAt, null); assert.match(st.stopped, /3 次/);
});

test('用户点「更新」清零重试计数并立刻重来；理解成功后计数也清零', async t => {
  let createFail = true; const fx = fixture(t, { createFails: () => createFail });
  const m0 = fx.m.load(fx.id); m0.understandingTurns = 0; fx.sessions.delete(m0.sessionId); fx.m.save(m0);
  await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job');
  fx.clock.t += 30000; await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job');
  assert.equal(fx.m.load(fx.id).understandingRetry.count, 1);
  createFail = false;
  fx.m.control(fx.id, 'understand');
  let m = fx.m.load(fx.id); assert.equal(m.understandingRetry, undefined); assert.equal(m.requested, true);
  await fx.m.runLane(fx.id, 'job'); m = fx.m.load(fx.id);
  assert.equal(m.job.kind, 'prime', '启动失败过的会话先预热');
  fx.reply(m.sessionId, '已就绪'); await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job');
  m = fx.m.load(fx.id); assert.equal(m.job.kind, 'understand');
  // 让这一轮超时失败，再成功一次，计数清零。
  fx.clock.t += 12 * 60000 + 1; await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job');
  m = fx.m.load(fx.id); assert.equal(m.understandingRetry.lastError.kind, 'timeout'); assert.equal(m.understandingRetry.lastError.label, '模型无回执超时');
  fx.clock.t += 30000; await fx.m.runLane(fx.id, 'job'); m = fx.m.load(fx.id); assert.equal(m.job.kind, 'understand'); assert.equal(m.understandingRetry.count, 1);
  fx.reply(m.sessionId, '- [D1] 步长定为 0.4 [事件 1]'); await fx.m.runLane(fx.id, 'job');
  m = fx.m.load(fx.id); assert.equal(m.revision, 1); assert.equal(m.understandingRetry, undefined);
});

test('会后不空转：已结束且没有待做的最终复核时不自动重试；最终复核失败才重试', async t => {
  const fx = fixture(t, { createFails: () => true });
  const m0 = fx.m.load(fx.id); Object.assign(m0, { state: 'ended', endedAt: fx.clock.t, finalRequested: false, requested: false, understandingTurns: 0, job: { kind: 'start', state: 'error' }, error: 'CodeAgent 会话创建失败' });
  fx.sessions.delete(m0.sessionId); fx.m.save(m0);
  assert.equal(fx.m.pending.has(fx.id), false, '历史失败会议不常驻轮询');
  await fx.m.runLane(fx.id, 'job'); fx.clock.t += 3600000; await fx.m.runLane(fx.id, 'job');
  assert.equal(fx.creates.length, 0); assert.equal(fx.m.load(fx.id).understandingRetry, undefined, '不写盘、不改历史会议');

  const fy = fixture(t, { createFails: () => true });
  const m1 = fy.m.load(fy.id); Object.assign(m1, { state: 'ended', endedAt: fy.clock.t, finalRequested: true, requested: false, understandingTurns: 0, job: { kind: 'start', state: 'error' }, error: 'CodeAgent 会话创建失败' });
  fy.sessions.delete(m1.sessionId); fy.m.save(m1);
  assert.ok(fy.m.pending.has(fy.id));
  await fy.m.runLane(fy.id, 'job'); fy.clock.t += 30000; await fy.m.runLane(fy.id, 'job');
  assert.equal(fy.creates.length, 1, '最终复核会重试');
  // 结束超过 6 小时的不再重试。
  const m2 = fy.m.load(fy.id); m2.understandingRetry = undefined; m2.endedAt = fy.clock.t - 7 * 3600000; fy.m.save(m2);
  await fy.m.runLane(fy.id, 'job'); fy.clock.t += 600000; await fy.m.runLane(fy.id, 'job');
  assert.equal(fy.creates.length, 1); assert.equal(fy.m.load(fy.id).understandingRetry, undefined);
});

test('与问答线互不干扰：问答排队时理解线重试不改问答状态', async t => {
  const fx = fixture(t, { createFails: () => true });
  const m0 = fx.m.load(fx.id), qid = randomUUID(), qjob = { kind: 'question', engine: 'ask-aside', state: 'queued', token: randomUUID(), questionId: qid, requestId: 'r1', sentAt: fx.clock.t };
  Object.assign(m0, { understandingTurns: 0, answers: [{ id: qid, q: '步长定了吗', state: 'queued', queuedAt: fx.clock.t }], questionJob: qjob, questionError: '' });
  fx.sessions.delete(m0.sessionId); fx.m.save(m0);
  const before = JSON.stringify({ a: m0.answers, j: m0.questionJob, e: m0.questionError });
  await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job'); fx.clock.t += 30000; await fx.m.runLane(fx.id, 'job'); await fx.m.runLane(fx.id, 'job');
  const m = fx.m.load(fx.id);
  assert.equal(m.understandingRetry.count, 1);
  assert.equal(JSON.stringify({ a: m.answers, j: m.questionJob, e: m.questionError }), before);
});

test('closeOwnedSession 等会话真正退出再判定：退出慢的不再误报「尚未关闭」，一直不退才报', async () => {
  let polls = 0; const alive = new Set(['a', 'b']);
  const manager = { closeSessionRecoverably: async () => ({ ok: true }), closeSession() {},
    getSession: id => { if (id === 'a' && alive.has('a') && ++polls > 3) alive.delete('a'); return alive.has(id) ? {} : null; } };
  await closeOwnedSession(manager, 'a', { prepareSweep: async () => null, exitWaitMs: 2000, pollMs: 5 });
  assert.equal(alive.has('a'), false);
  await assert.rejects(closeOwnedSession(manager, 'b', { prepareSweep: async () => null, exitWaitMs: 40, pollMs: 5 }), /尚未关闭/);
});

// —— a079c0dda 独立审查（2026-11-24）补的几条 ——
test('问答线正在用的来源会话先不关、不计次数；问答结束后再关', async t => {
  let fail = true; const fx = fixture(t, { closeFails: () => fail });
  await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  const m = fx.m.load(fx.id); m.questionJob = { kind: 'question', engine: 'ask-aside', state: 'queued', token: randomUUID(), sourceSessionId: fx.oldId }; fx.m.save(m);
  fail = false; fx.clock.t += 600000; await fx.m.closePending(fx.id);
  assert.equal(fx.closes.length, 1, '问答在用，不关'); assert.equal(fx.m.load(fx.id).pendingClose[0].count, 1, '不计次数');
  const done = fx.m.load(fx.id); done.questionJob = null; fx.m.save(done);
  await fx.m.closePending(fx.id); assert.equal(fx.closes.length, 2); assert.equal(fx.m.load(fx.id).pendingClose, undefined);
});

test('后台关旧会话与理解收取交错写盘，双方字段都不丢', async t => {
  let release; const fx = fixture(t);
  await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  fx.m.deps.closeSession = id => { fx.closes.push(id); return new Promise((_, reject) => { release = () => reject(new Error('CodeAgent 任务会话尚未关闭')); }); };
  fx.clock.t += 30000;
  const closing = fx.m.closePending(fx.id); // 关闭挂起中
  fx.reply(fx.m.load(fx.id).sessionId, '- [D1] 步长定为 0.4 [事件 1]'); await fx.m.runLane(fx.id, 'job'); // 期间纪要写盘
  release(); await closing;
  const m = fx.m.load(fx.id);
  assert.equal(m.revision, 1, '纪要版本没被旧值覆盖'); assert.equal(m.pendingClose[0].count, 2, '关闭次数没被旧值覆盖');
});

test('删会议时几个会话并发关闭；删除期间 status 带 lifecycle.removing', async t => {
  const fx = fixture(t, { closeFails: () => false });
  const m = fx.m.load(fx.id); m.state = 'ended'; m.job = null; m.requested = false; m.questionSessionId = randomUUID(); m.pendingClose = [{ id: randomUUID(), firstAt: 0, count: 6, gaveUp: true }];
  for (const sid of [m.questionSessionId, m.pendingClose[0].id]) fx.sessions.set(sid, { id: sid }); fx.m.save(m);
  const started = [], waits = [];
  fx.m.deps.closeSession = id => { started.push(id); return new Promise(r => waits.push(() => { fx.sessions.delete(id); r(); })); };
  const removing = fx.m.remove(fx.id);
  while (started.length < 3) await new Promise(r => setImmediate(r));
  assert.equal(started.length, 3, '三个会话同时在关'); assert.deepEqual(fx.m.status(fx.id).lifecycle, { removing: true, closingOldSessions: false });
  waits.forEach(w => w()); await removing;
});

test('重启后翻到很久以前的会议：到点前补查，不再重试', async t => {
  const fx = fixture(t, { createFails: () => true });
  const m = fx.m.load(fx.id); Object.assign(m, { state: 'ended', endedAt: fx.clock.t - 7 * 3600000, finalRequested: true, job: { kind: 'start', state: 'error' }, understandingRetry: { count: 1, nextAt: fx.clock.t - 1, inFlight: false } });
  fx.sessions.delete(m.sessionId); fx.m.save(m);
  await fx.m.runLane(fx.id, 'job');
  assert.equal(fx.creates.length, 0); assert.match(fx.m.load(fx.id).understandingRetry.stopped, /会议已结束/);
  assert.equal(fx.m.pending.has(fx.id), false);
});

test('旧会话停手后用户点「再关一次」(close-old-sessions)：只再试一次，失败又停手，成功就移除', async t => {
  let fail = true; const fx = fixture(t, { closeFails: () => fail });
  await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
  for (let i = 0; i < 6; i++) { fx.clock.t += 600000; await fx.m.closePending(fx.id); }
  assert.equal(fx.m.load(fx.id).pendingClose[0].gaveUp, true);
  fx.m.control(fx.id, 'close-old-sessions'); await fx.m.closing?.get(fx.id);
  assert.equal(fx.closes.length, 7); assert.equal(fx.m.load(fx.id).pendingClose[0].gaveUp, true, '再失败就再停手');
  fail = false; fx.m.control(fx.id, 'close-old-sessions'); await fx.m.closing?.get(fx.id);
  assert.equal(fx.m.load(fx.id).pendingClose, undefined);
  assert.throws(() => fx.m.control(fx.id, 'close-old-sessions'), /没有待关闭/);
});

test('旧会话一直关不掉：连续 8 次该轮换，活会话不超过上限+1，暂停换新会话并写进状态；换引擎明确报错', async t => {
  const fx = fixture(t);
  for (let i = 0; i < 8; i++) {
    const m = fx.m.load(fx.id); m.understandingTurns = 3; m.requested = true; m.job = null;
    fx.m.event(m, 'transcript', { at: 5000 + i * 1000, end: 5500 + i * 1000, track: 'system', text: '第 ' + i + ' 段' }); fx.m.save(m);
    await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
    const job = fx.m.load(fx.id).job; assert.ok(job && job.state !== 'error', `第 ${i + 1} 轮理解照常发出`);
    fx.reply(fx.m.load(fx.id).sessionId, `- [D${i + 1}] 第 ${i + 1} 条`); await fx.m.runLane(fx.id, 'job');
  }
  assert.ok(fx.sessions.size <= 3, `活会话 ${fx.sessions.size} 个`);
  const m = fx.m.load(fx.id); assert.equal(m.revision, 8, '纪要照常出到第 8 版'); assert.ok(m.pendingClose.length <= 2);
  const st = fx.m.status(fx.id).pendingClose; assert.equal(st.rotationPaused, true); assert.equal(st.limit, 2); assert.match(st.text, /暂停换新会话/);
  // 换引擎（模型变）也受上限约束：明确报错，不新建会话。
  const before = fx.creates.length, cur = fx.m.load(fx.id); cur.understandingModel = 'another-engine'; cur.requested = true; cur.job = null; fx.m.save(cur);
  await fx.m.runLane(fx.id, 'job');
  const after = fx.m.load(fx.id); assert.equal(after.job.state, 'error'); assert.match(after.error, /关不掉.*换引擎/); assert.equal(fx.creates.length, before);
  await fx.m.runLane(fx.id, 'job'); assert.equal(fx.m.load(fx.id).understandingRetry.lastError.kind, 'close');
});

// —— 后 4 个提交独立审查的非阻塞项（2026-11-24）——
test('旧会话关掉、低于上限后解除暂停并恢复正常轮换；换引擎被挡时状态写明自动重试会用完', async t => {
  let fail = true; const fx = fixture(t, { closeFails: () => fail });
  const turn = async i => {
    const m = fx.m.load(fx.id); m.understandingTurns = 3; m.requested = true; m.job = null;
    fx.m.event(m, 'transcript', { at: 9000 + i * 1000, end: 9500 + i * 1000, track: 'system', text: '段 ' + i }); fx.m.save(m);
    await fx.m.runLane(fx.id, 'job'); await fx.m.closing?.get(fx.id);
    fx.reply(fx.m.load(fx.id).sessionId, `- [D${i}] 条 ${i}`); await fx.m.runLane(fx.id, 'job');
  };
  for (let i = 1; i <= 3; i++) await turn(i);
  assert.ok(fx.m.load(fx.id).rotationPaused, '到上限暂停');
  const pausedSid = fx.m.load(fx.id).sessionId;
  // 换引擎被挡：错误状态给「再关一次」并写明自动重试会用完。
  const cur = fx.m.load(fx.id); cur.understandingModel = 'another'; cur.requested = true; cur.job = null; fx.m.save(cur);
  await fx.m.runLane(fx.id, 'job');
  const st = fx.m.status(fx.id).understandingStage; assert.equal(st.stage, 'error'); assert.match(st.text, /自动重试最多 3 次.*「更新」/); assert.deepEqual(st.ops, ['close-old-sessions', 'understand']);
  const back = fx.m.load(fx.id); back.understandingModel = undefined; back.job = null; delete back.understandingRetry; fx.m.save(back);
  // 旧会话终于关掉：暂停解除，下一轮正常换新会话。
  fail = false; fx.m.control(fx.id, 'close-old-sessions'); await fx.m.closing?.get(fx.id);
  assert.equal(fx.m.load(fx.id).rotationPaused, undefined); assert.equal(fx.m.status(fx.id).pendingClose, undefined);
  await turn(4); assert.notEqual(fx.m.load(fx.id).sessionId, pausedSid, '恢复轮换');
});

test('录制中不允许跳过转写失败段（会自动重试）；会后可以', async t => {
  const fx = fixture(t);
  const m = fx.m.load(fx.id); fx.m.event(m, 'audio', { at: 1000, end: 2000, file: 'system-9.wav', track: 'system', asr: 'error' }); fx.m.save(m);
  assert.throws(() => fx.m.control(fx.id, 'skip-failed-asr'), /会议还在进行，失败段会自动重试/);
  fx.m.control(fx.id, 'stop'); fx.m.control(fx.id, 'skip-failed-asr');
  assert.equal(fx.m.load(fx.id).events.find(e => e.kind === 'audio').asr, 'skipped');
});
