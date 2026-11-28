'use strict';
// R66（2026-11-27 同事反馈）：
// 1. 「资源与后台」取消勾选助理后只是表面关了：正在答的问题、预开会话、答完留着的会话都还在后台跑，再开时又补出结果和提醒。
// （「没答上后补收」已由 R61 合入主干，这里只验 pause 会一并清掉它的等待。）
// 全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');

const NOW = Date.parse('2026-11-05T15:20:00+08:00');
const DAY = '2026-11-05';

function fixture(t, { prewarm = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-r66-'));
  const sessions = new Map(), prompts = [], closed = [], finals = new Map(), interrupted = [], busy = new Set();
  let clock = NOW;
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: !prewarm, bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle', transcriptPath: 'x.jsonl' }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    closeSession: async id => { closed.push(id); sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); return { ok: true }; },
    interruptSession: async id => { interrupted.push(id); },
    readFinals: meta => finals.get(meta.id) || [],
    isAgentTurnActive: id => busy.has(id),
  };
  const a = new CompanyAssistant(deps);
  const meterWrites = [], finishMetering = a.metering.finish.bind(a.metering);
  a.metering.finish = (...args) => { const pending = finishMetering(...args); if (pending) meterWrites.push(pending); return pending; };
  t.after(async () => {
    a.close();
    for (let i = 0; i < meterWrites.length; i++) await meterWrites[i];
    a.welinkGate.flush?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  a.cli = () => 'fixture-cli';
  a.auth.status = () => ({ state: 'online', login: { ok: true, uid: 'owner' } });
  a.write(`raw-${DAY}.json`, { at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' }, conversations: [], messages: {}, meetings: [], calendar: [], mails: [], errors: [] });
  const markOf = id => ([...prompts].reverse().find(p => p.id === id)?.text.match(/\[助理回执:[^\]]+\]/) || [''])[0];
  const answer = (id, text, { mark = true } = {}) => { const list = finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text: mark ? text + '\n' + markOf(id) : text }); finals.set(id, list); };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)); };
  return { a, sessions, prompts, closed, interrupted, busy, answer, settle, advance: ms => { clock += ms; } };
}
const item = (f, id) => f.a.chat().find(c => c.id === id);

test('关助理（pause）＝真关：正在答的、排队的提问停下并写明原因，会话与预开会话关掉，之后答出来也不补收', async t => {
  const f = fixture(t, { prewarm: true });
  f.a.started = true;
  const q1 = f.a.ask('第一问'); const q2 = f.a.ask('第二问'); await f.settle();
  const sid = f.a.lanes.chat.job.sessionId; f.busy.add(sid);
  await f.settle();
  const warm = f.a.warm.desk; assert.ok(warm, '发出后预开了下一个会话');
  f.a.pause(); await f.settle();
  for (const id of [q1.id, q2.id]) {
    const c = item(f, id);
    assert.equal(c.state, 'error'); assert.equal(c.stopped, true); assert.match(c.error, /助理已关闭/);
  }
  assert.ok(f.interrupted.includes(sid), '正在答的会话让它停下');
  assert.ok(f.closed.includes(sid), '答这一问的会话关掉');
  assert.ok(f.closed.includes(warm), '预开会话关掉');
  assert.equal(f.a.lanes.chat.job, null); assert.equal(f.a.lanes.chat.queue.length, 0);
  assert.equal(f.a.lateAnswers.size, 0); assert.deepEqual(f.a.warm, {}); assert.deepEqual(f.a.lastSessions, {});
  assert.equal(f.prompts.length, 1, '第二问没有再起会话发出去');
});

test('关助理时已在补收的会话一并关掉；关着时排进来的简报不起会话', async t => {
  const f = fixture(t);
  f.a.started = true;
  const q = f.a.ask('今天有哪些会'); await f.settle();
  const sid = f.prompts[0].id;
  f.advance(13 * 60000); await f.a.collectJob('chat'); await f.settle();
  assert.ok(f.a.lateAnswers.has(q.id));
  f.a.pause(); await f.settle();
  assert.equal(f.a.lateAnswers.size, 0); assert.ok(f.closed.includes(sid));
  const before = f.sessions.size;
  f.a.enqueue({ type: 'brief', day: DAY, prompt: '简报' }); await f.settle();
  assert.equal(f.sessions.size, before); assert.equal(f.a.lanes.brief.job, null);
});

test('PPT 页的提问不归助理开关管：关助理时照常答', async t => {
  const f = fixture(t);
  f.a.started = true;
  f.a.ask('找一页 SRS 的图', { entry: 'ppt' }); await f.settle();
  const job = f.a.lanes.ppt.job; assert.ok(job);
  f.a.pause(); await f.settle();
  assert.equal(f.a.lanes.ppt.job, job); assert.ok(!f.closed.includes(job.sessionId));
});
