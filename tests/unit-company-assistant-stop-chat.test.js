'use strict';
// 审计 A3-17：助理会话没了（关掉、CodeAgent 进程退出）这一问立刻以明确原因失败，不再空等 12–24 分钟；
// 等待中的问题有「停止这一问」，只结束这一问、不影响其他队列。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');

const NOW = Date.parse('2026-11-05T15:20:00+08:00');
const DAY = '2026-11-05';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-stop-'));
  const sessions = new Map(), saved = new Map(), prompts = [], finals = new Map(), interrupted = [], alive = new Map();
  let clock = NOW, busy = new Set();
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: true, bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle' }); saved.set(opts.id, { id: opts.id, kind }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    // 关掉的会话还能从落盘的会话记录读到原生记录（同 main.js loadMeta）
    getSessionMetadata: id => saved.get(id) || null,
    closeSession: async id => { sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); busy.add(id); return { ok: true }; },
    readFinals: meta => finals.get(meta.id) || [],
    isAgentTurnActive: id => busy.has(id),
    isSessionProcessAlive: id => alive.has(id) ? alive.get(id) : true,
    interruptSession: async id => { interrupted.push(id); busy.delete(id); },
  };
  const a = new CompanyAssistant(deps);
  t.after(() => { a.closed = true; a.welinkGate.flush?.(); fs.rmSync(root, { recursive: true, force: true }); });
  a.cli = () => 'fixture-cli';
  a.auth.status = () => ({ state: 'online', login: { ok: true, uid: 'owner' } });
  a.write(`raw-${DAY}.json`, { at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' }, conversations: [], messages: {}, meetings: [], calendar: [], mails: [], scope: { fetched: 0, known: 0 }, errors: [] });
  const answer = (id, text) => { const list = finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text }); finals.set(id, list); };
  const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 5)); };
  const item = id => a.chat().find(c => c.id === id);
  return { a, sessions, prompts, interrupted, alive, busy, answer, settle, item, advance: ms => { clock += ms; } };
}

test('CodeAgent 进程退出：会话还标着在忙，这一问也立刻报失败并写明原因', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const sid = f.prompts[0].id;
  f.sessions.get(sid).status = 'running';
  f.alive.set(sid, false);
  await f.a.collectJob('chat');
  assert.equal(f.item(q.id).state, 'error');
  assert.match(f.item(q.id).error, /CodeAgent 进程已退出/);
});

test('会话被关掉：没有回答就立刻报失败；已经写出没带标记的回答照原判定收下', async t => {
  const f = fixture(t);
  const q1 = f.a.ask('今天有哪些会');
  await f.settle();
  f.sessions.delete(f.prompts[0].id);
  await f.a.collectJob('chat');
  assert.equal(f.item(q1.id).state, 'error');
  assert.match(f.item(q1.id).error, /会话已经关掉/);
  await f.settle();
  const q2 = f.a.ask('还有别的吗');
  await f.settle();
  const sid = f.prompts[1].id;
  f.answer(sid, '没有别的会了。');
  f.sessions.delete(sid);
  await f.a.collectJob('chat');
  assert.equal(f.item(q2.id).state, 'done', '会话没了不必再等 30 秒兜底');
  assert.equal(f.item(q2.id).a, '没有别的会了。');
});

test('停止正在答的一问：让会话停下，这一问显示已停止，同队列的下一问接着派', async t => {
  const f = fixture(t);
  const q1 = f.a.ask('今天有哪些会');
  await f.settle();
  const q2 = f.a.ask('明天呢');
  await f.settle();
  assert.equal(f.prompts.length, 1, '第二问在排队');
  const stopped = await f.a.stopChat(q1.id);
  assert.equal(stopped.state, 'error');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.error, '已停止这一问');
  assert.deepEqual(f.interrupted, [f.prompts[0].id]);
  await f.settle();
  assert.equal(f.prompts.length, 2, '下一问已派出');
  assert.equal(f.item(q2.id).state, 'running');
  // 已停止的回答后来才写出来，也不会被收进这一问
  f.answer(f.prompts[0].id, '迟到的回答');
  await f.a.collectJob('chat');
  assert.equal(f.item(q1.id).state, 'error');
});

test('停止排队中的一问：直接撤下，不影响正在答的和其他队列', async t => {
  const f = fixture(t);
  const q1 = f.a.ask('今天有哪些会');
  await f.settle();
  const q2 = f.a.ask('明天呢');
  const ppt = f.a.ask('找一页 SRS 的 PPT', { entry: 'ppt' });
  await f.settle();
  await f.a.stopChat(q2.id);
  assert.equal(f.item(q2.id).stopped, true);
  assert.deepEqual(f.interrupted, [], '排队中的不碰任何会话');
  assert.equal(f.item(q1.id).state, 'running');
  assert.equal(f.a.lanes.chat.queue.length, 0);
  assert.notEqual(f.item(ppt.id).state, 'error', 'PPT 队列照常');
  // 已答完的点停止不改
  f.busy.clear();
  f.answer(f.prompts[0].id, `一场会。\n${f.prompts[0].text.match(/\[助理回执:[^\]]+\]/)[0]}`);
  await f.a.collectJob('chat');
  await f.a.stopChat(q1.id);
  assert.equal(f.item(q1.id).state, 'done');
});

test('助理页：等待行有「停止这一问」，已停止的写「已停止这一问」并可重问；主进程有对应入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(src, /data-ca="stop:\$\{esc\(id\)\}">停止这一问<\/button>/);
  assert.match(src, /c\.stopped \? '已停止这一问'/);
  assert.match(src, /call\('stop-chat', \{ id: arg \}\)/);
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'company-assistant-handlers.js'), 'utf8');
  assert.match(ipc, /'stop-chat': async request => \(\{ ok: true, item: await service\.stopChat\(/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /A3-17[^\n]*\n\s*isSessionProcessAlive: id => sessionProcessAlive\(id\)/, '助理接上进程存活判断（公开版也有）');
  assert.match(main, /^function sessionProcessAlive\(id\) \{/m);
});
