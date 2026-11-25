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
const { CompanyAssistant, DESK_RULES, MEETING_SEARCH_RULE, PHONE_RULES, PPT_RULES, PREWARM_TTL_MS, TOOLS_VERSION } = require('../core/company-assistant/service');
const { HubTools } = require('../core/company-assistant/hub-tools');
const { TOOLSETS, toolsFor, allTools } = require('../core/company-assistant/mcp');
const AC = require('../core/company-assistant/answer-context');
// 5.5.14 起默认按「作答手册 + Hub 备好的材料」提问：固定规则换成新版。
const GUIDED_RULES = AC.ASK_RULES.replace('{{TOOLS}}', AC.WELINK_TOOLS) + '\n' + MEETING_SEARCH_RULE;

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
  // Task metering intentionally writes in the background. Event-loop turns do not
  // wait for its filesystem work; drain the actual writes before removing their root.
  const meterWrites = [], finishMetering = a.metering.finish.bind(a.metering);
  a.metering.finish = (...args) => {
    const pending = finishMetering(...args);
    if (pending) meterWrites.push(pending);
    return pending;
  };
  t.after(async () => {
    a.close();
    for (let i = 0; i < meterWrites.length; i++) await meterWrites[i];
    a.welinkGate.flush?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
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
  f.advance(4 * 60000); // TTL 内仍复用；超时后的新建由专门回归覆盖。
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
  assert.match(fs.readFileSync(path.join(f.a.pptWorkspace, 'skills', 'ppt-make.md'), 'utf8'), /只通过 ppt_make 产出/);
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
  await assert.rejects(tools.invoke({ name: 'ppt_find', arguments: {}, callerSessionId: desk }), /没有挂这个工具/);
  assert.deepEqual((await tools.invoke({ name: 'list_sessions', arguments: {}, callerSessionId: desk })).sessions, [], '电脑上问助理也能列会话（5.6.2）');
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

test('工具按用途挂载：电脑问答带会话管理、不带 PPT，抢会议室移出助理', () => {
  const names = set => toolsFor(set).map(t => t.name);
  assert.deepEqual(names('desk'), names('phone'), '电脑和手机同一组：WeLink 查询 + 记忆 + 提醒 + 会话管理');
  assert.ok(names('desk').includes('list_sessions') && names('desk').includes('create_session'));
  assert.ok(names('phone').includes('send_session'));
  assert.ok(!names('desk').some(n => n.startsWith('ppt_')));
  assert.deepEqual(names('ppt').sort(), [...TOOLSETS.ppt].sort());
  assert.ok(!allTools.some(t => t.name === 'room_booking'));
});

test('电脑上问其他会话：规则带会话管理，提问里附 Hub 会话现状；没开手机对话时盯着的会话做完弹桌面通知', async t => {
  const f = fixture(t, { prewarm: false });
  const other = { id: 's-work', title: '仿真对比', kind: 'codeagent', cwd: 'D:/proj/sim', status: 'running', createdAt: NOW - 600000 };
  f.a.tools = new HubTools(f.a, { getAllSessions: () => [other], isAgentTurnActive: () => other.status === 'running' });
  f.a.ask('当前有哪些 session 在跑'); await f.settle();
  const prompt = f.prompts[0].text;
  assert.match(prompt, /11\. 管这台电脑 Hub 里的其他会话用会话工具/);
  assert.match(prompt, /Hub 会话现状.*\n- 仿真对比｜运行中｜D:\/proj\/sim/);
  assert.ok(!prompt.includes(f.prompts[0].id), '助理自己的会话不列进去');
  assert.equal(f.a.sessionsBlock('今天有哪些会'), '', '没问会话就不附');
  // 盯着它：运行中不提醒，答完后提醒一次，走提醒总线（手机对话没开）
  const notices = []; f.a.bus = { publish: n => { notices.push(n); return true; } };
  f.a.phone.watch(other.id, { baseline: null, title: other.title, why: 'watch' });
  await f.a.phone.watchTick();
  assert.equal(notices.length, 0);
  other.status = 'idle';
  f.a.tools.lastFinal = () => ({ id: 'f9', text: '对比完成，增益 3.2%' });
  await f.a.phone.watchTick(); await f.a.phone.watchTick();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'session');
  assert.match(notices[0].title, /「仿真对比」这一轮答完了/);
  assert.match(notices[0].text, /增益 3\.2%/);
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

test('CLI 没就绪（cli-not-ready）不让这一问失败：同一会话隔一会儿再发，就绪后照常答', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.deps.notReadyRetryMs = 0;
  const realSend = f.a.deps.sendPrompt;
  let notReady = 2;
  f.a.deps.sendPrompt = async (id, text) => {
    if (notReady > 0) { notReady -= 1; f.advance(60000); return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready' }; }
    return realSend(id, text);
  };
  const item = f.a.ask('今天有哪些会');
  // 重试走真实定时器：机器忙时 5 毫秒不够（发版预检并行跑时偶发 0 !== 1），最多等 2 秒直到发出去。
  for (let waited = 0; f.prompts.length < 1 && waited < 2000; waited += 20) { await f.settle(); await new Promise(r => setTimeout(r, 20)); }
  await f.settle();
  assert.equal(f.prompts.length, 1, '就绪后发出去一次');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running');
  f.answer(f.prompts[0].id, '今天两场会');
  await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'done');
});

test('CLI 一直没就绪：到上限才报失败，提示可以重问', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.deps.notReadyRetryMs = 0;
  f.a.deps.sendPrompt = async () => { f.advance(120000); return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready' }; };
  const item = f.a.ask('今天有哪些会');
  for (let i = 0; i < 5; i += 1) { await f.settle(); await new Promise(r => setTimeout(r, 5)); }
  const row = f.a.chat().find(c => c.id === item.id);
  assert.equal(row.state, 'error');
  assert.match(row.error, /还没启动好.*可以重问/);
  assert.doesNotMatch(row.error, /cli-not-ready/);
});

test('等 CLI 就绪期间点停止：不再发问，按停止结束', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.deps.notReadyRetryMs = 20;
  let sends = 0;
  f.a.deps.sendPrompt = async () => { sends += 1; return { ok: false, notSent: true, sendStatus: 'rejected', error: 'cli-not-ready' }; };
  const item = f.a.ask('今天有哪些会');
  await f.settle();
  await f.a.stopChat(item.id);
  await new Promise(r => setTimeout(r, 40)); await f.settle();
  assert.equal(sends, 1);
  const row = f.a.chat().find(c => c.id === item.id);
  assert.equal(row.state, 'error'); assert.equal(row.stopped, true);
});

test('发出后 90 秒没忙、没绑定记录：换新会话重发一次，再不行就报失败，不空等 12 分钟', async t => {
  const f = fixture(t, { prewarm: false });
  const item = f.a.ask('今天有哪些会');
  await f.settle();
  assert.equal(f.prompts.length, 1);
  f.advance(91000);
  await f.a.collectJob('chat'); await f.settle();
  assert.equal(f.prompts.length, 2, '重发一次');
  assert.notEqual(f.prompts[1].id, f.prompts[0].id, '换了新会话');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running');
  f.advance(91000);
  await f.a.collectJob('chat'); await f.settle();
  const row = f.a.chat().find(c => c.id === item.id);
  assert.equal(row.state, 'error');
  assert.match(row.error, /没能送进 CodeAgent/);
  assert.equal(f.prompts.length, 2, '只重发一次');
});

test('已绑定记录的会话答得慢：不算没送达，不重发', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.ask('今天有哪些会');
  await f.settle();
  f.sessions.get(f.prompts[0].id).transcriptPath = 'x.jsonl';
  f.advance(120000);
  await f.a.collectJob('chat'); await f.settle();
  assert.equal(f.prompts.length, 1);
});

test('CLI 提交仍在等待时，90 秒轮询不得回收或重发；提交成功才开始回答计时', async t => {
  const f = fixture(t, { prewarm: false });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.a.deps.sendPrompt = async (id, text) => { f.prompts.push({ id, text }); return pending; };
  const item = f.a.ask('今天有什么会议'); await f.settle();
  const job = f.a.lanes.chat.job, id = job.sessionId;
  f.advance(91000); await f.a.collectJob('chat'); await f.settle();
  assert.equal(job.resent, undefined); assert.equal(f.closed.includes(id), false);
  assert.equal(f.prompts.length, 1); assert.equal(f.a.lanes.chat.job, job);
  release({ ok: true }); await f.settle();
  assert.equal(job.sentAt, NOW + 91000);
  assert.equal(f.a.chat().find(c => c.id === item.id).answeringAt, NOW + 91000);
  f.answer(id, '今天没有会议'); await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'done');
});

test('默认guided与classic的电脑/手机实际提问都带会议搜索规则，且只附一次', t => {
  const f = fixture(t, { prewarm: false });
  assert.equal(f.a.guided(), true, '全新助理默认guided');
  assert.match(MEETING_SEARCH_RULE, /以前哪次会议说过什么、谁说过什么时先用 meeting_search/);
  for (const style of ['guided', 'classic']) {
    f.a.setSettings({ answerStyle: style });
    for (const toolset of ['desk', 'phone']) {
      const prompt = f.a.composePrompt({ prompt: '以前哪次会议说过分档门限？' }, toolset);
      assert.equal(prompt.split(MEETING_SEARCH_RULE).length - 1, 1, `${style}/${toolset}只附一份共享规则`);
      assert.match(prompt, /meetingId 与 seq 或 itemId/);
      assert.ok(prompt.startsWith(style === 'guided' ? GUIDED_RULES : DESK_RULES));
    }
  }
});

test('工具v6或无版本的旧预开会话退役，新会话挂meeting_search，当前版本继续预热复用', async t => {
  assert.equal(TOOLS_VERSION, 7, '新增会议检索工具升级为v7');
  for (const legacyVersion of [6, undefined]) {
    const f = fixture(t);
    f.a.tools = new HubTools(f.a, {});
    const launchTools = new Map(), create = f.a.deps.createSession;
    f.a.deps.createSession = async (kind, opts) => {
      // 在实际建会话的挂载时机检查：openPooled必须先登记工具用途。
      const plan = f.a.sessionPlan({ opts });
      launchTools.set(opts.id, toolsFor(plan.mcp.env.HUB_COMPANY_TOOLSET).map(tool => tool.name));
      return create(kind, opts);
    };
    f.a.prewarm('desk'); await f.settle();
    const old = f.a.warm.desk;
    if (legacyVersion === undefined) delete f.a.pool.get(old).toolsVersion;
    else f.a.pool.get(old).toolsVersion = legacyVersion;
    const next = await f.a.takeSession('desk'); await f.settle();
    assert.notEqual(next, old);
    assert.ok(f.closed.includes(old), `旧版本${legacyVersion}会话已关闭`);
    assert.equal(f.a.pool.has(old), false);
    assert.equal(f.a.pool.get(next).toolsVersion, TOOLS_VERSION);
    assert.ok(launchTools.get(next).includes('meeting_search'), '新会话启动时可见会议搜索工具');
    f.a.keepWarm('desk', next);
    assert.equal(await f.a.takeSession('desk'), next, '同版本预热会话正常复用');
    assert.equal(launchTools.size, 2, '复用不额外建会话');
    assert.equal(f.closed.includes(next), false);
  }
});

test('工具升级不关闭正在回答或已被问题占用的旧会话，空闲后才换新', async t => {
  for (const ownership of ['running', 'job']) {
    const f = fixture(t); f.a.prewarm('desk'); await f.settle();
    const old = f.a.warm.desk; f.a.pool.get(old).toolsVersion = 6;
    if (ownership === 'running') f.sessions.get(old).status = 'running';
    else f.a.lanes.chat.job = { sessionId: old };
    const next = await f.a.takeSession('desk'); await f.settle();
    assert.notEqual(next, old);
    assert.equal(f.closed.includes(old), false, '升级不得打断旧会话');
    assert.equal(f.a.warm.desk, old);
    assert.equal(f.a.pool.has(old), true);
    f.sessions.get(old).status = 'idle'; f.a.lanes.chat.job = null;
    assert.notEqual(await f.a.takeSession('desk'), old); await f.settle();
    assert.ok(f.closed.includes(old), '归还且空闲后旧版本退役');
  }
});

test('预热会话已确认退出时，新问题用新会话', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle();
  const warm = f.a.warm.desk;
  f.a.deps.isSessionProcessAlive = id => id !== warm;
  assert.notEqual(await f.a.takeSession('desk'), warm);
  await f.settle(); assert.ok(f.closed.includes(warm));
});

test('预热闲置满 TTL 后关闭，包括从未绑定原生 ID 的会话，不会立即再预开', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle();
  const warm = f.a.warm.desk;
  assert.equal(f.sessions.get(warm).ccSessionId, undefined);
  f.advance(PREWARM_TTL_MS - 1); f.a.retireExpiredWarm(); await f.settle();
  assert.equal(f.closed.includes(warm), false);
  f.advance(1); f.a.retireExpiredWarm(); await f.settle();
  assert.ok(f.closed.includes(warm)); assert.equal(f.a.warm.desk, undefined);
  assert.equal(f.a.pool.has(warm), false); assert.equal(f.sessions.size, 0, '回收后不自动补开');
});

test('下一问到达前超时但清扫尚未运行，也不能复用旧预热；没超时仍复用', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle();
  const first = f.a.warm.desk; f.advance(PREWARM_TTL_MS - 1);
  assert.equal(await f.a.takeSession('desk'), first);
  f.a.prewarm('desk'); await f.settle(); const next = f.a.warm.desk;
  f.advance(PREWARM_TTL_MS);
  assert.notEqual(await f.a.takeSession('desk'), next);
  await f.settle(); assert.ok(f.closed.includes(next)); assert.ok(!f.closed.includes(first), '已取去回答的会话不回收');
});

test('预热清扫保护正在运行和已经交给提问的会话，重新空闲后再算 TTL', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.sessions.get(warm).status = 'running'; f.advance(PREWARM_TTL_MS); f.a.retireExpiredWarm(); await f.settle();
  assert.ok(!f.closed.includes(warm));
  f.sessions.get(warm).status = 'idle'; f.a.retireExpiredWarm();
  f.advance(PREWARM_TTL_MS - 1); f.a.retireExpiredWarm(); assert.ok(!f.closed.includes(warm));
  f.advance(1); f.a.retireExpiredWarm(); await f.settle(); assert.ok(f.closed.includes(warm));
  const item = f.a.ask('今天有哪些会'); await f.settle(); const active = f.a.lanes.chat.job.sessionId;
  f.advance(PREWARM_TTL_MS); f.a.retireExpiredWarm(); await f.settle();
  assert.ok(!f.closed.includes(active)); assert.equal(f.a.chat().find(c => c.id === item.id).state, 'running');
});

test('PTY 进程还活着但预热已退回 PowerShell，takeSession 不复用；历史 shell 字样不会误伤', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.advance(90000);
  f.a.deps.isSessionProcessAlive = () => true;
  f.a.deps.readTerminalScreen = () => ({ text: 'CLI stopped\r\nPS D:\\Work> ' });
  assert.notEqual(await f.a.takeSession('desk'), warm); await f.settle(); assert.ok(f.closed.includes(warm));
  f.a.prewarm('desk'); await f.settle(); const ready = f.a.warm.desk;
  f.a.deps.readTerminalScreen = () => ({ text: 'PS D:\\Work> codeagent\r\nCodeAgent\r\n> ' });
  assert.equal(await f.a.takeSession('desk'), ready);
});

test('预热冷启动的 shell 提示符有 90 秒宽限，真实进程退出仍立即回收', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.a.deps.readTerminalScreen = () => ({ text: 'PS D:\\Work> ' });
  f.a.retireExpiredWarm(); await f.settle(); assert.ok(!f.closed.includes(warm));
  f.advance(89999); f.a.retireExpiredWarm(); await f.settle(); assert.ok(!f.closed.includes(warm));
  assert.equal(await f.a.takeSession('desk'), warm, '启动宽限内留给提交就绪检测，不因 shell 画面误杀');
  f.a.keepWarm('desk', warm); f.advance(1); f.a.retireExpiredWarm(); await f.settle();
  assert.ok(f.closed.includes(warm), '宽限到期后真实 shell 可回收');
  f.a.prewarm('desk'); await f.settle(); const exited = f.a.warm.desk;
  f.a.deps.isSessionProcessAlive = id => id !== exited;
  f.a.retireExpiredWarm(); await f.settle(); assert.ok(f.closed.includes(exited));
});

test('未交给问题的预热持续忙碌 10 分钟会回收，边界前不回收', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.sessions.get(warm).status = 'running'; f.a.retireExpiredWarm();
  f.advance(10 * 60000 - 1); f.a.retireExpiredWarm(); await f.settle(); assert.ok(!f.closed.includes(warm));
  f.advance(1); f.a.retireExpiredWarm(); await f.settle(); assert.ok(f.closed.includes(warm));
  assert.equal(f.a.warm.desk, undefined); assert.equal(f.a.pool.has(warm), false);
});

test('预热忙碌上限会在空闲后重新计算，且不回收已有问题拥有的会话', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.a.deps.isAgentTurnActive = id => id === warm;
  f.a.retireExpiredWarm(); f.advance(9 * 60000);
  f.a.deps.isAgentTurnActive = () => false; f.a.retireExpiredWarm();
  f.a.deps.isAgentTurnActive = id => id === warm; f.a.retireExpiredWarm();
  f.advance(9 * 60000); f.a.retireExpiredWarm(); await f.settle(); assert.ok(!f.closed.includes(warm));
  f.a.lanes.chat.job = { sessionId: warm };
  f.advance(2 * 60000); f.a.retireExpiredWarm(); await f.settle(); assert.ok(!f.closed.includes(warm));
  f.a.lanes.chat.job = null; f.a.retireExpiredWarm(); await f.settle(); assert.ok(f.closed.includes(warm));
});

test('预热回收独立计时，助理暂停后仍执行；close 会清掉清扫定时器', async t => {
  const f = fixture(t); f.a.deps.noTimer = false;
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.a.started = true; f.a.pause();
  f.advance(PREWARM_TTL_MS); t.mock.timers.tick(PREWARM_TTL_MS); await f.settle();
  assert.ok(f.closed.includes(warm)); assert.equal(f.a.warmSweepTimer, null);
  f.a.prewarm('desk'); await f.settle(); assert.ok(f.a.warmSweepTimer);
  f.a.close(); assert.equal(f.a.warmSweepTimer, null);
});

test('终端暂时读不到时不误判退出，TTL 到时仍能回收', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.a.deps.readTerminalScreen = () => { throw Error('screen unavailable'); };
  assert.doesNotThrow(() => f.a.retireExpiredWarm()); assert.ok(!f.closed.includes(warm));
  f.advance(PREWARM_TTL_MS); assert.doesNotThrow(() => f.a.retireExpiredWarm());
  await f.settle(); assert.ok(f.closed.includes(warm));
});

test('预热仍在运行且屏幕暂现 shell 时，清扫不关闭，下一问也不复用', async t => {
  const f = fixture(t); f.a.prewarm('desk'); await f.settle(); const warm = f.a.warm.desk;
  f.sessions.get(warm).status = 'running';
  f.a.deps.readTerminalScreen = id => ({ text: id === warm ? 'PS D:\\Work> ' : '' });
  f.advance(PREWARM_TTL_MS); f.a.retireExpiredWarm(); await f.settle();
  assert.ok(!f.closed.includes(warm), '运行状态优先于单帧 shell 判断');
  assert.notEqual(await f.a.takeSession('desk'), warm, '运行中的预热不用于新问题');
  await f.settle(); assert.ok(!f.closed.includes(warm));
  f.sessions.get(warm).status = 'idle'; f.a.retireExpiredWarm(); await f.settle();
  assert.ok(f.closed.includes(warm), '空闲后确认退到 shell 才关闭');
});

test('明确 CLI 已退出且没发出时只换会话重发一次；未知提交不自动重发', async t => {
  const f = fixture(t, { prewarm: false });
  let n = 0;
  f.a.deps.sendPrompt = async (id, text) => { f.prompts.push({ id, text }); return n++ === 0
    ? { ok: false, notSent: true, error: 'send-threw', code: 'cli-exited', message: 'CLI 已退出到系统终端' } : { ok: true }; };
  const item = f.a.ask('今天有什么会议'); await f.settle();
  assert.equal(f.prompts.length, 2); assert.notEqual(f.prompts[0].id, f.prompts[1].id);
  f.answer(f.prompts[1].id, '没有会议'); await f.a.collectJob('chat');
  assert.equal(f.a.chat().find(c => c.id === item.id).state, 'done');
  for (const unknown of [{ ok: false, unconfirmed: true, error: 'cli-exited' }, { ok: false, sendStatus: 'stuck' }]) {
    f.a.deps.sendPrompt = async (id, text) => { f.prompts.push({ id, text }); return unknown; };
    const next = f.a.ask('接着问'); await f.settle();
    const before = f.prompts.length;
    f.advance(91000); await f.a.collectJob('chat'); await f.settle(); assert.equal(f.prompts.length, before);
    await f.a.stopChat(next.id); await f.settle();
  }
});

test('换新会话仍然明确退出时停止自动重发', async t => {
  const f = fixture(t, { prewarm: false });
  f.a.deps.sendPrompt = async (id, text) => { f.prompts.push({ id, text }); return { ok: false, notSent: true, error: 'cli-exited', message: 'CLI 已退出' }; };
  const item = f.a.ask('今天有什么会议'); await f.settle();
  assert.equal(f.prompts.length, 2); assert.equal(f.a.chat().find(c => c.id === item.id).state, 'error');
});

test('预开的会话固定在用户已换掉的模型上（或已因模型暂停）时不再用它，改开新会话', async t => {
  const f = fixture(t);
  f.a.prewarm('desk');
  await f.settle();
  const warm = f.a.warm.desk;
  assert.ok(warm);
  Object.assign(f.sessions.get(warm), { fixedModel: 'model-old', modelPinSource: 'created' });
  require('../core/codeagent-model-replacements').recordReplacement(f.root, 'model-old', 'model-new');
  const taken = await f.a.takeSession('desk');
  assert.notEqual(taken, warm, '换掉的模型上的预开会话不用');
  await f.settle();
  assert.ok(f.closed.includes(warm), '旧的预开会话关掉');
  Object.assign(f.sessions.get(taken), { fixedModel: 'model-new', modelPinSource: 'created', modelConfirmationRequired: true });
  f.a.warm.desk = taken;
  assert.notEqual(await f.a.takeSession('desk'), taken, '已因模型暂停的会话也不用');
});

test('welink-cli：自动记下的路径让位给自动发现选出的新版；用户亲手选的路径不被换掉', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-cli-'));
  const oldCli = path.join(root, 'uni', 'welink-cli.exe'), newCli = path.join(root, 'npm', 'welink-cli.exe');
  for (const f of [oldCli, newCli]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  const a = new CompanyAssistant({ dataDir: root, now: () => NOW, noTimer: true, noTools: true, noPrewarm: true,
    bus: { latest: () => [], publish: () => true }, welinkRun: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    toolDiscovery: { register() { return this; }, has: () => false, pick: () => newCli }, resolveCli: ({ configured }) => configured });
  t.after(() => { a.closed = true; a.welinkGate.flush?.(); fs.rmSync(root, { recursive: true, force: true }); });
  a.setSettings({ cliPath: oldCli });
  assert.equal(a.cli(), newCli, '自动记下的旧版让位');
  a.setSettings({ cliPath: oldCli, cliPathManual: true });
  assert.equal(a.settings().cliPathManual, true);
  assert.equal(a.cli(), oldCli, '用户亲手选的保持不变');
});
