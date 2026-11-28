'use strict';
// R66 Antigravity 审查 1 的修复回归（3 P1 + 2 P2）。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const D = require('../core/company-assistant/data');
const RR = require('../core/company-assistant/reply-review');
const G = require('../core/company-assistant/digest');
const B = require('../core/company-assistant/brief');

const NOW = Date.parse('2026-11-05T15:20:00+08:00'); // 周四 15:20
const DAY = '2026-11-05';
const H = 3600000;

function fixture(t, { snapshot = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-r66r-'));
  const sessions = new Map(), prompts = [], closed = [], finals = new Map(), busy = new Set(), published = [];
  let clock = NOW;
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: true, noArchive: true,
    bus: { latest: () => [], publish: n => { published.push(n); return true; } }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle', transcriptPath: 'x.jsonl' }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    closeSession: async id => { closed.push(id); sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); return { ok: true }; },
    interruptSession: async () => {},
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
  a.write(`raw-${DAY}.json`, { at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' }, conversations: [], messages: {}, meetings: [], calendar: [], mails: [], errors: [], ...snapshot });
  const markOf = id => ([...prompts].reverse().find(p => p.id === id)?.text.match(/\[助理回执:[^\]]+\]/) || [''])[0];
  const answer = (id, text) => { const list = finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text: text + '\n' + markOf(id) }); finals.set(id, list); };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)); };
  return { a, sessions, prompts, closed, busy, published, answer, settle, advance: ms => { clock += ms; } };
}
const item = (f, id) => f.a.chat().find(c => c.id === id);

test('P1-1 助理关着时新发起的团队分析：照样起收答器，能收到回答，不被当成助理作业停下', async t => {
  const f = fixture(t);
  f.a.started = true; f.a.pause();
  let collectors = 0; const start = f.a.startPptCollector.bind(f.a); f.a.startPptCollector = () => { collectors++; return start(); };
  const q = f.a.ask('团队这周的风险点', { teamOwner: 'owner' }); await f.settle();
  assert.equal(collectors, 1, '团队分析排进来时起收答器');
  assert.ok(f.a.lanes.chat.job, '没有被关助理拦下');
  f.answer(f.prompts[0].id, '风险点：联调环境');
  await f.a.collectJob(); await f.settle();
  assert.equal(item(f, q.id).state, 'done');
});

test('P1-2 关助理打断简报整理：当场不发任何通知，记下被打断；重开后 tick 自动补跑一次', async t => {
  const f = fixture(t);
  f.a.started = true;
  f.a.write(`brief-${DAY}.json`, { day: DAY, generatedAt: NOW, by: 'list', total: 2, organizing: true, sections: [{ title: '会议', items: [{ text: 'A' }, { text: 'B' }] }] });
  f.a.enqueue({ type: 'brief', day: DAY, prompt: '整理简报' }); await f.settle();
  assert.ok(f.a.lanes.brief.job);
  f.a.pause(); await f.settle();
  assert.equal(f.published.length, 0, '关助理时不弹「今日简报」');
  const brief = f.a.brief(DAY);
  assert.equal(brief.interrupted, true); assert.equal(brief.organizing, false); assert.equal(brief.total, 2, '规则清单还在');
  assert.doesNotMatch(brief.note, /重问/);
  // 重开后 tick 补跑
  f.a.resume();
  let regenerated = 0;
  f.a.generateBrief = async () => { regenerated++; };
  f.a.auth.check = async () => {}; f.a.refresh = async () => {}; f.a.maybeSizeGroups = async () => 0; f.a.maybeReviewReplies = () => false;
  await f.a.tick();
  assert.equal(regenerated, 1);
});

test('P1-2 关助理打断待回复复核：时段记号退回，重开后 tick 按时段自动补跑；不记成错误', async t => {
  const conv = { id: 'p1', name: '周工', group: false };
  const f = fixture(t, { snapshot: { conversations: [conv], messages: { p1: [{ sourceId: 'msg:p1:1', conv: 'p1', convName: '周工', group: false, key: '1', at: NOW - 2 * H, sender: '周工', account: 'z1', mine: false, text: '你确认一下门限？' }] } } });
  f.a.started = true;
  f.a.saveState({ replyReviewSlot: `${DAY}@540` });
  const slot = RR.slotOf(NOW);
  assert.equal(f.a.maybeReviewReplies(NOW), true); await f.settle();
  assert.equal(f.a.state().replyReviewSlot, slot);
  f.a.pause(); await f.settle();
  assert.equal(f.a.state().replyReviewSlot, `${DAY}@540`, '退回到被打断前');
  assert.equal(f.a.state().replyReviewError, '');
  assert.equal(f.published.length, 0);
  f.a.resume();
  assert.equal(f.a.maybeReviewReplies(NOW), true, '重开后同一时段会再跑');
});

test('P1-3 复核、汇总、简报、提问材料读快照都按同一份「我」：本人另一种写法的接话后，复核锚与等你回复一致', () => {
  const conv = { id: 'g1', name: '联调群', group: true };
  const rows = [
    { sourceId: 'msg:g1:1', conv: 'g1', convName: '联调群', group: true, key: '1', at: NOW - 3 * H, sender: '甲', account: 'a1', mine: false, atMe: true, text: '明天谁来搭环境？' },
    { sourceId: 'msg:g1:2', conv: 'g1', convName: '联调群', group: true, key: '2', at: NOW - 2 * H, sender: '林某', account: 'x00200002', mine: false, text: '我来' },
  ];
  const snap = { at: NOW, day: DAY, login: { ok: true, uid: '00200002' }, conversations: [conv], messages: { g1: rows }, meetings: [], calendar: [], mails: [] };
  const cands = RR.candidates(snap, { now: NOW, settings: {} });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].lastKey, '2', '锚是本人那句接话');
  assert.match(cands[0].lines.join('\n'), /我: 我来/);
  const settings = { replyReview: { items: { g1: { lastKey: cands[0].lastKey, verdict: 'no', reason: '已接话' } } } };
  assert.equal(D.awaiting(snap, settings, { now: NOW })[0].aiVerdict, 'no', '复核结论没被作废');
  // 汇总：本人接过话的群消息不进汇总
  assert.equal(G.digestItems(snap, { settings: {}, now: NOW }).filter(i => i.kind === 'mention').length, 0);
  // 简报：标「你之后在群里说过话」
  const brief = B.fallbackBrief(snap, { day: DAY, now: NOW, settings: {} });
  const all = brief.sections.flatMap(s => s.items);
  assert.ok(all.some(i => i.settledLabel === '你之后在群里说过话'));
  assert.equal(D.convRows(snap, {}, 'g1')[1].mine, true);
});

test('P2-1 冷启动时助理关着：paused 为真，不预开；没 start 过时 pause 也记成关；start 后清掉', t => {
  const f = fixture(t);
  assert.equal(f.a.paused, false);
  f.a.paused = true; // main.js 冷启动、助理关着
  f.a.deps.noPrewarm = false;
  assert.equal(f.a.prewarm('desk'), null);
  f.a.paused = false; f.a.deps.noPrewarm = true;
  f.a.pause();
  assert.equal(f.a.paused, true, '没 start 过也记成关');
  f.a.start();
  assert.equal(f.a.paused, false);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /else companyAssistantService\.paused = true;/);
});

test('P2-2 进程已退、接口报错收场的不进迟到等待；用今天摘要答的补回时保留范围行', async t => {
  const f = fixture(t, { snapshot: { meetings: [{ sourceId: 'mtg:1', subject: 'SRS 周期配置评审', start: NOW + H, end: NOW + 2 * H, timeStatus: 'known' }] } });
  // 进程已退
  const q1 = f.a.ask('第一问'); await f.settle();
  f.a.deps.isSessionProcessAlive = () => false;
  await f.a.collectJob('chat'); await f.settle();
  assert.equal(item(f, q1.id).state, 'error');
  assert.equal(f.a.lateAnswers.has(q1.id), false);
  f.a.deps.isSessionProcessAlive = () => true;
  // 接口报错
  const q2 = f.a.ask('第二问'); await f.settle();
  const job2 = f.a.lanes.chat.job; job2.apiError = { id: 'e1', at: NOW };
  f.a.failJob(job2, '模型接口 429');
  assert.equal(f.a.lateAnswers.has(q2.id), false);
  // 超时 + 今天摘要范围
  const q3 = f.a.ask('下午有什么会'); await f.settle();
  const job3 = f.a.lanes.chat.job; job3.digest = { ok: true, line: '今天摘要 · 快照 15:19' };
  f.advance(13 * 60000); await f.a.collectJob('chat'); await f.settle();
  assert.equal(item(f, q3.id).state, 'error');
  assert.ok(f.a.lateAnswers.has(q3.id));
  f.answer(job3.sessionId, '16:20 有 [mtg:1]');
  await f.a.collectJob(); await f.settle();
  const done = item(f, q3.id);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.coverage, { ok: true, line: '今天摘要 · 快照 15:19' });
});

test('关助理停下的手机提问不往手机推「没答上」', async t => {
  const f = fixture(t);
  f.a.started = true;
  const sent = [];
  f.a.phone.send = async (...args) => { sent.push(args); return { ok: true }; };
  f.a.phone.sendBot = async (...args) => { sent.push(args); return { ok: true }; };
  const q = f.a.ask('手机上问的', { via: 'phone' }); await f.settle();
  f.a.phone.update(cur => ({ pending: { ...cur.pending, [q.id]: { at: NOW } } }));
  f.a.pause(); await f.settle();
  assert.equal(item(f, q.id).stopped, true);
  assert.equal(sent.length, 0);
  assert.equal(f.a.phone.state().pending[q.id], undefined, '待回记录撤掉');
});
