'use strict';
// R61（2026-11-27 反馈：助理前台显示「没答上」，切到后台其实已经答完）：判了没答上之后从不再看这一问，
// 后来写进会话记录的回答永远不会出现。现在同一会话 30 分钟内补出的回答按收回答的同一套规则补回前台。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');

const NOW = Date.parse('2026-11-05T15:20:00+08:00');
const DAY = '2026-11-05';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-receipt-'));
  const sessions = new Map(), prompts = [], finals = new Map();
  let clock = NOW, busy = false;
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: true, bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    // 会话已绑定到 CodeAgent 记录（问题送进去了），这样走的是「超时没答」而不是「没送进去、换会话重发」。
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle', ccSessionId: 'cc-' + opts.id }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    closeSession: async id => { sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); return { ok: true }; },
    readFinals: meta => finals.get(meta.id) || [],
    isAgentTurnActive: () => busy,
  };
  const a = new CompanyAssistant(deps);
  t.after(() => { a.closed = true; a.welinkGate.flush?.(); fs.rmSync(root, { recursive: true, force: true }); });
  a.cli = () => 'fixture-cli';
  a.auth.status = () => ({ state: 'online', login: { ok: true, uid: 'owner' } });
  a.write(`raw-${DAY}.json`, { at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' }, conversations: [], messages: {}, meetings: [], calendar: [], mails: [], scope: { fetched: 0, known: 0 }, errors: [] });
  const markOf = id => ([...prompts].reverse().find(p => p.id === id)?.text.match(/\[助理回执:[^\]]+\]/) || [''])[0];
  const answer = (id, text) => { const list = finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text }); finals.set(id, list); };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)); };
  return { a, prompts, answer, markOf, settle, advance: ms => { clock += ms; }, setBusy: v => { busy = v; } };
}


const TIMEOUT = 12 * 60000 + 1000;

test('12 分钟没答判了没答上，之后会话里写出带回执标记的回答：补回前台标完成，注明是后来补上的', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const p = f.prompts[0];
  f.advance(TIMEOUT);
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'error');
  f.answer(p.id, `今天 2 场会。\n${f.markOf(p.id)}`);
  await f.a.collectJob();
  const item = f.a.chat().find(c => c.id === q.id);
  assert.equal(item.state, 'done');
  assert.equal(item.a, '今天 2 场会。');
  assert.equal(item.error, null);
  assert.match(item.lateAnswer.failedWith, /12 分钟/);
});

test('迟到回答没写标记：会话空闲且稳定 8 秒才补；会话又忙起来就接着等', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const p = f.prompts[0];
  f.advance(TIMEOUT);
  await f.a.collectJob('chat');
  f.answer(p.id, '我先查一下。');
  f.setBusy(true);
  await f.a.collectJob();
  f.advance(9000);
  await f.a.collectJob();
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'error', '会话在忙：中途的话不补');
  f.setBusy(false);
  f.answer(p.id, '今天没有会。');
  await f.a.collectJob();
  f.advance(5000);
  await f.a.collectJob();
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'error', '还没稳定 8 秒');
  f.advance(4000);
  await f.a.collectJob();
  const item = f.a.chat().find(c => c.id === q.id);
  assert.equal(item.state, 'done');
  assert.equal(item.a, '今天没有会。');
});

test('后面又问了别的：迟到回答只补给它自己那一问，不串到新问题；用户自己停的不补', async t => {
  const f = fixture(t);
  const first = f.a.ask('第一问');
  await f.settle();
  const p1 = f.prompts[0];
  f.advance(TIMEOUT);
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === first.id).state, 'error');
  const second = f.a.ask('第二问');
  await f.settle();
  f.answer(p1.id, `第一问的回答\n${f.markOf(p1.id)}`);
  await f.a.collectJob();
  assert.equal(f.a.chat().find(c => c.id === first.id).a, '第一问的回答');
  assert.equal(f.a.chat().find(c => c.id === second.id).state, 'running', '第一问的回答不算第二问的');

  const g = fixture(t);
  const stopped = g.a.ask('停掉的一问');
  await g.settle();
  const p = g.prompts[0];
  await g.a.stopChat(stopped.id);
  g.answer(p.id, `停了之后才出的回答\n${g.markOf(p.id)}`);
  g.advance(10000);
  await g.a.collectJob();
  assert.equal(g.a.chat().find(c => c.id === stopped.id).state, 'error');
});

test('超过 30 分钟才出的回答不再补', async t => {
  const g = fixture(t);
  const late = g.a.ask('很慢的一问');
  await g.settle();
  const p = g.prompts[0];
  g.advance(TIMEOUT);
  await g.a.collectJob('chat');
  g.advance(31 * 60000);
  await g.a.collectJob();
  g.answer(p.id, `终于答了\n${g.markOf(p.id)}`);
  await g.a.collectJob();
  assert.equal(g.a.chat().find(c => c.id === late.id).state, 'error');
});

// 审查修复：后面的提问先答完时，旧会话还在等迟到回答，不能被关掉（P1-1）；点「重问」后旧卡不再等（负责人定 B）；
// 同一问题两份回答时，带给下一问的最近对话只带一份（P2-5）。
test('审查 P1-1：第一问失败后第二问先答完，第一问的会话不被关掉，迟到回答照样补回；补回后再关', async t => {
  const f = fixture(t);
  const closed = [];
  const close = f.a.deps.closeSession;
  f.a.deps.closeSession = async id => { closed.push(id); return close(id); };
  const first = f.a.ask('第一问');
  await f.settle();
  const p1 = f.prompts[0];
  f.advance(TIMEOUT);
  await f.a.collectJob('chat');
  const second = f.a.ask('第二问');
  await f.settle();
  const p2 = f.prompts.at(-1);
  assert.notEqual(p2.id, p1.id);
  f.answer(p2.id, `第二问的回答\n${f.markOf(p2.id)}`);
  await f.a.collectJob();
  await f.settle();
  assert.equal(f.a.chat().find(c => c.id === second.id).state, 'done');
  assert.ok(!closed.includes(p1.id), '第一问的会话还在等迟到回答');
  f.answer(p1.id, `第一问的回答\n${f.markOf(p1.id)}`);
  await f.a.collectJob();
  await f.settle();
  assert.equal(f.a.chat().find(c => c.id === first.id).a, '第一问的回答');
  assert.ok(closed.includes(p1.id), '补回后旧会话照常关掉');
});

test('负责人定 B：点「重问」后旧卡保持失败，不再补迟到回答', async t => {
  const f = fixture(t);
  const first = f.a.ask('今天有哪些会');
  await f.settle();
  const p1 = f.prompts[0];
  f.advance(TIMEOUT);
  await f.a.collectJob('chat');
  f.a.retryChat(first.id);
  await f.settle();
  f.answer(p1.id, `迟到的回答\n${f.markOf(p1.id)}`);
  await f.a.collectJob();
  assert.equal(f.a.chat().find(c => c.id === first.id).state, 'error');
});

test('审查 P2-5：同一问题答了两份，带给下一问的最近对话只带较新那份，不挤掉别的话题', async t => {
  const f = fixture(t);
  const now = f.a.now();
  f.a.saveChat([
    { id: 'a', q: '另一个话题', state: 'done', a: '另一个回答', askedAt: now - 300000, answeredAt: now - 290000 },
    { id: 'b', q: '同一个问题', state: 'done', a: '迟到补回的回答', askedAt: now - 200000, answeredAt: now - 60000, lateAnswer: { failedWith: 'x', at: now - 60000 } },
    { id: 'c', q: '同一个问题', state: 'done', a: '重问的回答', askedAt: now - 100000, answeredAt: now - 30000 },
  ]);
  const text = f.a.recentHistory({ type: 'chat', chatId: 'next' });
  assert.match(text, /另一个话题/);
  assert.match(text, /重问的回答/);
  assert.doesNotMatch(text, /迟到补回的回答/);
});
