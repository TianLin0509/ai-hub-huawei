'use strict';
// 5.5.11 助理改版：每问一个会话 + 预开、三条队列互不阻塞、提问内容（规则/今天摘要/最近两轮）、
// 工具按用途挂载与身份核对、快照内找消息、查询范围结构化、会议同名同时段合并。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const { CompanyAssistant, DESK_RULES, PHONE_RULES, PPT_RULES } = require('../core/company-assistant/service');
const { HubTools } = require('../core/company-assistant/hub-tools');
const { TOOLSETS, toolsFor, allTools } = require('../core/company-assistant/mcp');
const AC = require('../core/company-assistant/answer-context');
// 5.5.14 起默认按「作答手册 + Hub 备好的材料」提问：固定规则换成新版。
const GUIDED_RULES = AC.ASK_RULES.replace('{{TOOLS}}', AC.WELINK_TOOLS);

const NOW = Date.parse('2026-11-05T15:20:00+08:00');
const DAY = '2026-11-05';
const at = hhmm => Date.parse(`${DAY}T${hhmm}:00+08:00`);

function snapshot() {
  return {
    at: NOW - 60000, day: DAY, login: { ok: true, uid: 'owner' },
    conversations: [{ id: 'p1', name: '周工', group: false }, { id: 'g1', name: '无线联调群', group: true }],
    messages: {
      p1: [{ sourceId: 'msg:p1:1', conv: 'p1', convName: '周工', group: false, sender: '周工', account: 'z1', at: at('10:12'), text: '分档门限你确认一下？评审会要用' }],
      g1: [{ sourceId: 'msg:g1:1', conv: 'g1', convName: '无线联调群', group: true, sender: '李明', account: 'l1', at: at('09:41'), atMe: true, text: '明天联调环境谁来搭？' }],
    },
    meetings: [{ sourceId: 'mtg:1', subject: 'SRS 周期配置评审', start: at('14:30'), end: at('15:30'), location: 'F1-3', timeStatus: 'known' }],
    calendar: [{ sourceId: 'cal:1', subject: 'SRS周期配置评审', start: at('14:30'), end: at('15:30'), timeStatus: 'known' }],
    mails: [{ sourceId: 'mail:m1', id: 'm1', subject: 'Q4 预算评审材料提交通知', from: '财经部', at: at('09:02'), preview: '请于 11月8日 前提交' }],
    scope: { fetched: 2, known: 2 }, meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'complete' }, mailCoverage: { status: 'complete' }, errors: [],
  };
}

function fixture(t, { prewarm = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-pool-'));
  const sessions = new Map(), prompts = [], closed = [], finals = new Map();
  let clock = NOW;
  const deps = {
    dataDir: root, now: () => clock, noTimer: true, noTools: true, noPrewarm: !prewarm, bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle' }); return { id: opts.id, cwd: opts.cwd }; },
    getSession: id => sessions.get(id) || null,
    closeSession: async id => { closed.push(id); sessions.delete(id); },
    sendPrompt: async (id, text) => { prompts.push({ id, text }); return { ok: true }; },
    readFinals: meta => finals.get(meta.id) || [],
    isAgentTurnActive: () => false,
  };
  const a = new CompanyAssistant(deps);
  t.after(() => { a.closed = true; a.welinkGate.flush?.(); fs.rmSync(root, { recursive: true, force: true }); });
  a.cli = () => 'fixture-cli';
  a.auth.status = () => ({ state: 'online', login: { ok: true, uid: 'owner' } });
  a.write(`raw-${DAY}.json`, snapshot());
  // 照真实 CodeAgent 的样子：回答最后一行带上这一问的回执标记（发给这个会话的最后一条提问里的那个）。
  const markOf = id => ([...prompts].reverse().find(p => p.id === id)?.text.match(/\[助理回执:[^\]]+\]/) || [''])[0];
  const answer = (id, text) => { const list = finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text: text + '\n' + markOf(id) }); finals.set(id, list); };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setImmediate(r)); };
  return { a, root, sessions, prompts, closed, answer, settle, advance: ms => { clock += ms; } };
}

test('每个问题用一个新会话：提问带固定规则、今天摘要；答完预开下一个，第二问接着用并带上最近一轮', async t => {
  const f = fixture(t);
  const first = f.a.ask('今天有哪些会');
  await f.settle();
  assert.equal(f.prompts.length, 1);
  const p1 = f.prompts[0];
  assert.ok(p1.text.startsWith(GUIDED_RULES + '\n\n作答手册 · 通用'), '规则和手册通用部分放在最前面，各会话前缀一致');
  assert.match(p1.text, /作答手册 · 今天的会/, '按问题类型带对应手册');
  assert.match(p1.text, /Hub 备好的材料[\s\S]*【今天的会 · 1 场】/);
  assert.match(p1.text, /今天摘要/);
  assert.match(p1.text, /SRS 周期配置评审[^\n]*WeLink \+ 日历[^\n]*\[mtg:1\]/, '摘要里的会议已合并');
  assert.doesNotMatch(p1.text, /最近的对话/);
  assert.equal(f.a.toolsetFor(p1.id), 'desk');
  const waiting = f.a.chat().find(c => c.id === first.id);
  assert.deepEqual(waiting.guide, { kinds: ['今天的会'], items: waiting.guide.items }, '等回答时页面能显示按哪类问题作答');
  assert.ok(waiting.guide.items >= 1, '备好的材料条数');
  f.answer(p1.id, '今天 1 场会：14:30 SRS 周期配置评审 [mtg:1]。');
  await f.a.collectJob('chat');
  const done = f.a.chat().find(c => c.id === first.id);
  assert.equal(done.state, 'done');
  assert.doesNotMatch(done.a, /Hub 核实的查询范围/, '回答不再带范围前缀');
  assert.equal(done.coverage.ok, true, '没调工具时用今天摘要的范围');
  assert.match(done.coverage.line, /今天摘要/);
  assert.match(done.sources['mtg:1'], /SRS/);
  await f.settle();
  const warm = f.a.warm.desk;
  assert.ok(warm && warm !== p1.id, '已经预开了下一个会话');
  f.advance(5 * 60000);
  f.a.ask('短一点');
  await f.settle();
  assert.equal(f.prompts[1].id, warm, '第二问用预开好的会话');
  assert.match(f.prompts[1].text, /最近的对话（Hub 附上/);
  assert.match(f.prompts[1].text, /问（15:20）：今天有哪些会/);
  f.answer(warm, '好的。');
  await f.a.collectJob('chat');
  await f.settle();
  assert.deepEqual(f.closed, [p1.id], '只留最近答过的一个会话，更早的关掉');
});

test('上一问答完超过 30 分钟就不再附最近对话；手机的问题用手机那组规则', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.ask('今天有哪些会'); await f.settle();
  f.answer(f.prompts[0].id, '一场会。'); await f.a.collectJob('chat');
  f.advance(31 * 60000);
  f.a.ask('还有别的吗'); await f.settle();
  assert.doesNotMatch(f.prompts[1].text, /最近的对话/);
  f.answer(f.prompts[1].id, '没有了。'); await f.a.collectJob('chat');
  f.a.ask('现在有哪些会话在跑', { via: 'phone' }); await f.settle();
  const phone = f.prompts[2];
  assert.equal(f.a.toolsetFor(phone.id), 'phone');
  assert.ok(phone.text.startsWith(GUIDED_RULES + '\n' + PHONE_RULES));
});

test('PPT 页的提问走自己的队列和会话，不挡住助理提问，也不出现在助理页', async t => {
  const f = fixture(t, { prewarm: false });
  const ppt = f.a.ask('找 SRS 周期的对比页', { entry: 'ppt' });
  const chat = f.a.ask('今天有哪些会');
  await f.settle();
  assert.equal(f.prompts.length, 2, '两条队列同时发出');
  const pptPrompt = f.prompts.find(p => p.text.startsWith(PPT_RULES)), chatPrompt = f.prompts.find(p => p.text.startsWith(GUIDED_RULES));
  assert.ok(pptPrompt && chatPrompt);
  assert.equal(f.a.toolsetFor(pptPrompt.id), 'ppt');
  assert.equal(f.sessions.get(pptPrompt.id).cwd, f.a.pptWorkspace);
  assert.doesNotMatch(pptPrompt.text, /今天摘要/);
  assert.ok(fs.existsSync(path.join(f.a.pptWorkspace, 'skills', 'ppt-search.md')));
  const status = f.a.status();
  assert.ok(status.chat.some(c => c.id === chat.id));
  assert.ok(!status.chat.some(c => c.id === ppt.id), '助理页不显示 PPT 页的问答');
  assert.equal(status.pptQueued, 1);
});

test('工具身份：只认 Hub 登记过的助理会话，并且只放行它那一组工具', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.ask('今天有哪些会'); f.a.ask('现在有哪些会话', { via: 'phone' });
  await f.settle();
  const desk = f.prompts[0].id;
  const tools = new HubTools(f.a, {});
  await assert.rejects(tools.invoke({ name: 'list_sessions', arguments: {}, callerSessionId: desk }), /没有挂这个工具/);
  await assert.rejects(tools.invoke({ name: 'welink_find', arguments: { person: '周工' }, callerSessionId: 'stranger' }), /只有公司助理会话/);
  const found = await tools.invoke({ name: 'welink_find', arguments: { person: '周工' }, callerSessionId: desk });
  assert.match(found.text, /分档门限你确认一下/);
  assert.match(found.text, /\[msg:p1:1\]/);
  assert.equal(found.total, 1);
  // 找到的范围记在这一问上，答完变成页面底部的一行
  f.answer(desk, '周工问分档门限 [msg:p1:1]');
  await f.a.collectJob('chat');
  const item = f.a.chat().find(c => c.q === '今天有哪些会');
  assert.equal(item.coverage.ok, true);
  assert.match(item.coverage.line, /快照 15:19 · 人「周工」 · 命中 1 条/);
  assert.ok(item.coverage.details.length >= 2);
});

test('工具按用途挂载：电脑问答不带会话管理和 PPT，抢会议室移出助理', () => {
  const names = set => toolsFor(set).map(t => t.name);
  assert.deepEqual(names('desk'), ['welink_find', 'welink_inbox', 'welink_message', 'welink_meetings', 'welink_mail', 'assistant_memory', 'pet_remind']);
  assert.ok(names('phone').includes('send_session'));
  assert.ok(!names('desk').some(n => n.startsWith('ppt_') || n.endsWith('_session')));
  assert.deepEqual(names('ppt').sort(), [...TOOLSETS.ppt].sort());
  assert.ok(!allTools.some(t => t.name === 'room_booking'));
  assert.ok(JSON.stringify(toolsFor('desk')).length < JSON.stringify(allTools).length / 2, '电脑问答的工具描述不到全部的一半');
});

test('会议同名同时段合并：主题忽略空白标点，开始结束都在 1 分钟内；简报会前准备按任一出处都能对上', () => {
  const rows = D.mergeMeetings([...snapshot().meetings, ...snapshot().calendar, { sourceId: 'cal:2', subject: 'SRS周期配置评审', start: at('16:00'), end: at('17:00') }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].sources, ['mtg:1', 'cal:1']);
  assert.equal(rows[0].mergedLabel, 'WeLink + 日历');
  assert.equal(rows[0].location, 'F1-3');
  const list = B.fallbackBrief(snapshot(), { day: DAY, now: NOW });
  const meetings = list.sections.find(s => s.key === 'meetings').items;
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].merged, true);
  assert.equal(meetings[0].start, at('14:30'));
  const parsed = B.parseAgentBrief('```json\n{"meetings":[{"source":"cal:1","preparation":"带上同种子对比"}],"awaiting":[],"commitments":[],"groups":[],"mail":[]}\n```', snapshot(), { day: DAY, now: NOW });
  const m = parsed.sections.find(s => s.key === 'meetings').items[0];
  assert.equal(m.preparation, '带上同种子对比');
  assert.equal(parsed.dropped, 0);
});

test('简报走自己的队列，不挡提问', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.enqueue({ type: 'brief', day: DAY, prompt: '请整理今天的工作简报' });
  f.a.ask('今天有哪些会');
  await f.settle();
  assert.equal(f.prompts.length, 2);
  const brief = f.prompts.find(p => p.text.includes('请整理今天的工作简报'));
  assert.equal(f.a.toolsetFor(brief.id), 'brief');
  assert.ok(f.a.briefRunning(DAY));
});

test('助理思考档：默认不带，设成 low 后新开的问答会话带上；PPT 会话不受影响', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.ask('今天有哪些会');
  await f.settle();
  const first = f.sessions.get(f.prompts[0].id);
  assert.equal(first.effort, undefined, '默认用账号自己的思考档');
  f.a.setSettings({ answerEffort: 'low' });
  assert.equal(f.a.settings().answerEffort, 'low');
  f.a.setSettings({ answerEffort: 'turbo' });
  assert.equal(f.a.settings().answerEffort, 'low', '不认识的值不改');
  f.answer(f.prompts[0].id, '今天 1 场会。');
  await f.a.collectJob('chat');
  f.a.ask('谁在等我回复');
  await f.settle();
  assert.equal(f.sessions.get(f.prompts[1].id).effort, 'low');
  const id = await f.a.openPooled('ppt');
  assert.equal(f.sessions.get(id).effort, undefined);
});
