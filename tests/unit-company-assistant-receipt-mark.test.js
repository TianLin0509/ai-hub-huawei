'use strict';
// 2026-11-06 CodeAgent 性能盘点「助理收工改看回执标记」：提问末尾要求最后一行写本问的回执标记，
// 带标记的回答才算答完（中途一句过渡话不再被收走）；没写标记时按原判定兜底，不让回答永远收不了。全部为合成数据。
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
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle' }); return { id: opts.id, cwd: opts.cwd }; },
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

test('提问末尾要求写回执标记；中途的过渡话不收，带标记的回答才收，标记不显示', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const p = f.prompts[0];
  const mark = f.markOf(p.id);
  assert.match(mark, /^\[助理回执:[0-9a-f-]{36}\]$/);
  assert.ok(p.text.trimEnd().endsWith(mark + '（Hub 据此判断你已答完，这一行不会显示给用户）'), '回执要求放在提问最后');
  f.answer(p.id, '我先查一下今天的日历。');
  await f.a.collectJob('chat');
  f.advance(5000);
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'running', '过渡话没写标记，会话空闲也要稳定 8 秒，5 秒内不收');
  f.answer(p.id, `今天 1 场会：14:30 SRS 周期配置评审。\n${mark}`);
  await f.a.collectJob('chat');
  const done = f.a.chat().find(c => c.id === q.id);
  assert.equal(done.state, 'done');
  assert.equal(done.a, '今天 1 场会：14:30 SRS 周期配置评审。');
  assert.doesNotMatch(done.agentText, /助理回执/);
});

test('带标记的回答：会话状态还没报空闲也直接收', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const p = f.prompts[0];
  f.setBusy(true);
  f.answer(p.id, '还在查。');
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'running', '没标记、会话在忙：照旧等');
  f.answer(p.id, `查完了，没有会。\n[助理回执：${f.markOf(p.id).slice(6, -1)}]`);
  await f.a.collectJob('chat');
  const done = f.a.chat().find(c => c.id === q.id);
  assert.equal(done.state, 'done', '全角冒号的标记也认');
  assert.equal(done.a, '查完了，没有会。');
});

test('没写标记的兜底：会话空闲、回答稳定 8 秒后按原判定收下；期间有新回答重新计时', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  const p = f.prompts[0];
  f.answer(p.id, '第一段。');
  await f.a.collectJob('chat');
  f.advance(5000);
  f.answer(p.id, '今天没有会。');
  await f.a.collectJob('chat');
  f.advance(5000);
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === q.id).state, 'running', '新回答出现后重新计时');
  f.advance(4000);
  await f.a.collectJob('chat');
  const done = f.a.chat().find(c => c.id === q.id);
  assert.equal(done.state, 'done');
  assert.equal(done.a, '今天没有会。');
});

test('只回了标记、没有正文：这一问报错，可重问', async t => {
  const f = fixture(t);
  const q = f.a.ask('今天有哪些会');
  await f.settle();
  f.answer(f.prompts[0].id, f.markOf(f.prompts[0].id));
  await f.a.collectJob('chat');
  const item = f.a.chat().find(c => c.id === q.id);
  assert.equal(item.state, 'error');
  assert.match(item.error, /没有正文/);
});
