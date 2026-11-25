'use strict';
// 纪要卡住写清原因（2026-11-24 m4 走查）：status.understandingStage 区分 等终端就绪 / 未确认 / 等回执 / 转写失败挡住最终纪要 / 出错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

function fixture(t, { sendPrompt, busy = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-stage-')), sessions = new Map(), finals = new Map(), prompts = [];
  const clock = { t: 2_000_000 };
  const deps = { dataDir: root, now: () => clock.t, powerSaveBlocker: false, notReadyRetryMs: 1, meetingModels: () => [], meetingAsr: { status: () => ({ ready: false }), close() {} },
    getSession: id => sessions.get(id), createSession: async (_k, o) => { sessions.set(o.id, o); }, closeSession: async id => { sessions.delete(id); },
    sendPrompt: async (sid, prompt, ...rest) => { prompts.push({ sid, prompt }); return sendPrompt ? sendPrompt(sid, prompt, ...rest) : { ok: true }; } };
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: id => busy(id), lastFinal: id => finals.get(id) }, deps);
  m.tools = { start: async () => {}, bind() {}, close() {} }; m.tick = async () => {};
  t.after(() => { m.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const meeting = m.create({ title: '卡住写清' }); clearInterval(m.timer); m.timer = 1;
  Object.assign(meeting, { primeRequested: false, agent: { state: 'ready', at: clock.t }, autoUnderstand: false, requested: true, engineLabel: 'DeepSeek 快速' });
  sessions.set(meeting.sessionId, { id: meeting.sessionId });
  m.event(meeting, 'transcript', { at: 1000, end: 2000, track: 'system', text: '步长定为 0.4' }); m.save(meeting);
  return { m, id: meeting.id, clock, finals, prompts, stage: () => m.status(meeting.id).understandingStage };
}

test('发 prompt 遇终端没就绪：状态是「等终端就绪」并带已等秒数；送达后变「正在整理」，引擎名取 engineLabel', async t => {
  let release; const fx = fixture(t, { sendPrompt: (() => { let n = 0; return () => (++n === 1 ? { notSent: true, error: 'cli-not-ready' } : new Promise(r => { release = r; })); })() });
  const run = fx.m.runLane(fx.id, 'job');
  while (!release) await new Promise(r => setImmediate(r));
  fx.clock.t += 20000;
  const label = fx.m.load(fx.id).engineLabel; assert.ok(label);
  fx.m.save(Object.assign(fx.m.load(fx.id), { engineLabel: 'DeepSeek 快速' })); // 界面用实际引擎名，不硬写 CodeAgent
  let st = fx.stage(); assert.equal(st.stage, 'waiting-cli-ready'); assert.match(st.text, /等 DeepSeek 快速 终端就绪（已等 20 秒/);
  release({ ok: true }); await run;
  st = fx.stage(); assert.equal(st.stage, 'running'); assert.match(st.text, /DeepSeek 快速 正在整理/);
  assert.equal(fx.m.load(fx.id).job.cliWaitSince, undefined);
});

test('送出未确认：状态是「还没确认收到」', async t => {
  const fx = fixture(t, { sendPrompt: () => ({ unconfirmed: true }) });
  await fx.m.runLane(fx.id, 'job');
  assert.equal(fx.stage().stage, 'unconfirmed');
});

test('会话空闲 15 秒仍没回执：立刻标「等回执」，点更新可放弃这一轮重发，迟到的旧回执不写入', async t => {
  const fx = fixture(t);
  await fx.m.runLane(fx.id, 'job'); const first = fx.m.load(fx.id).job;
  await fx.m.runLane(fx.id, 'job'); assert.equal(fx.stage().stage, 'running', '刚空闲还不算');
  fx.clock.t += 15000;
  const st = fx.stage(); assert.equal(st.stage, 'waiting-receipt'); assert.deepEqual(st.ops, ['understand']); assert.match(st.text, /已空闲 15 秒/);
  fx.m.control(fx.id, 'understand'); assert.equal(fx.m.load(fx.id).job, null);
  await fx.m.runLane(fx.id, 'job'); const second = fx.m.load(fx.id).job;
  assert.notEqual(second.token, first.token); assert.equal(fx.prompts.length, 2);
  fx.finals.set(fx.m.load(fx.id).sessionId, { id: randomUUID(), text: `- [D1] 迟到的旧回答\n[会议回执:${first.token}]` });
  await fx.m.runLane(fx.id, 'job'); assert.equal(fx.m.load(fx.id).revision, 0, '旧回执不算');
  fx.finals.set(fx.m.load(fx.id).sessionId, { id: randomUUID(), text: `- [D1] 步长定为 0.4\n[会议回执:${second.token}]` });
  await fx.m.runLane(fx.id, 'job'); const m = fx.m.load(fx.id);
  assert.equal(m.revision, 1); assert.match(m.summary, /步长定为 0.4/); assert.equal(fx.stage().stage, 'idle');
});

test('会后有转写失败段：状态是「转写失败挡住最终纪要」，给重试转写和跳过两个按钮；跳过后出最终复核并告诉模型哪些时段没转写', async t => {
  const fx = fixture(t);
  const m0 = fx.m.load(fx.id);
  fx.m.event(m0, 'audio', { at: 60000, end: 90000, file: 'system-9.wav', track: 'system', asr: 'error', error: '模型加载失败' });
  Object.assign(m0, { state: 'ended', endedAt: fx.clock.t, finalRequested: true, requested: false, cursor: 1 }); fx.m.save(m0);
  await fx.m.runLane(fx.id, 'job'); assert.equal(fx.prompts.length, 0, '原先这里永远等');
  let st = fx.stage(); assert.equal(st.stage, 'blocked-by-asr'); assert.deepEqual(st.ops, ['retry-asr', 'skip-failed-asr']); assert.match(st.text, /1 段音频转写失败/);
  fx.m.control(fx.id, 'skip-failed-asr'); assert.throws(() => fx.m.control(fx.id, 'skip-failed-asr'), /没有转写失败/);
  assert.equal(fx.m.load(fx.id).events.find(e => e.kind === 'audio').asr, 'skipped');
  assert.ok(fx.m.pending.has(fx.id), '跳过后进入待处理');
  await fx.m.runLane(fx.id, 'job');
  const job = fx.m.load(fx.id).job; assert.equal(job.final, true);
  const input = fs.readFileSync(path.join(fx.m.dir(fx.id), /读取当前目录 (input-[^ ]+\.txt)/.exec(fx.prompts[0].prompt)[1]), 'utf8');
  assert.match(input, /已跳过的音频.*60-90s/); assert.match(input, /待转写音频：0 段/);
});

test('出错：状态是 error 带原因，可点更新', async t => {
  const fx = fixture(t, { sendPrompt: () => ({ ok: false, error: '网关返回 502' }) });
  await fx.m.runLane(fx.id, 'job');
  const st = fx.stage(); assert.equal(st.stage, 'error'); assert.match(st.text, /502/); assert.deepEqual(st.ops, ['understand']);
});
