'use strict';
// 在跑一览与密钥拦截（2026-11-20）：快照分组、矛盾提示、4 KB 截断；助理工具挂在 desk/phone；
// 助理记忆和组队计划的密钥拦截，普通提交号、网址、UUID 不误伤。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRunningOverview, createRunningOverview, CAP } = require('../core/running-overview');
const { findSecret, assertPlanFree } = require('../core/secret-guard');

const NOW = Date.parse('2026-11-20T15:00:00+08:00');
const MIN = 60000, HOUR = 60 * MIN;
const facts = map => s => map[s.id] || {};

test('快照分组：等你回复 > 卡住嫌疑 > 运行中 > 刚完成，其余只计数', () => {
  const sessions = [
    { id: 'a', title: '等确认', kind: 'codeagent', lastOutputAt: NOW - 2 * MIN },
    { id: 'b', title: '在跑正常', kind: 'codeagent', lastOutputAt: NOW - 1 * MIN },
    { id: 'c', title: '在跑但沉默', kind: 'codeagent', lastOutputAt: NOW - 45 * MIN },
    { id: 'd', title: '刚答完', kind: 'pi', lastOutputAt: NOW - 20 * MIN },
    { id: 'e', title: '昨天的', kind: 'codeagent', lastOutputAt: NOW - 30 * HOUR },
    { id: 'f', title: '群聊成员', kind: 'codeagent', lastOutputAt: NOW },
    { id: 'g', title: '要拍板', kind: 'codeagent', lastOutputAt: NOW - 5 * MIN },
  ];
  const cards = [{ sessionId: 'g', mtimeMs: NOW - 5 * MIN, plain: { status: '顺利', line: '方案二选一', decision: { question: '用方案A还是B', recommendation: 'A' } } }];
  const teams = [{ leadSid: 'b', members: [{ memberId: 'm1', sid: 'c', status: 'active' }] }];
  const v = buildRunningOverview({ sessions, cards, teams, now: NOW, facts: facts({
    a: { needsInput: true, busy: true, kind: 'CodeAgent' }, b: { busy: true, kind: 'CodeAgent' }, c: { busy: true, kind: 'CodeAgent' },
    d: { kind: 'pi', completed: true }, e: { completed: true }, f: { listed: false }, g: {},
  }) });
  const group = id => v.rows.find(r => r.id === id)?.group;
  assert.equal(group('a'), 'waiting');
  assert.equal(group('g'), 'waiting');
  assert.equal(group('c'), 'suspect');
  assert.equal(group('b'), 'running');
  assert.equal(group('d'), 'done');
  assert.equal(group('e'), undefined);
  assert.deepEqual(v.counts, { waiting: 2, suspect: 1, running: 1, done: 1, rest: 2 });
  assert.equal(v.rows.find(r => r.id === 'b').team.text, '负责人');
  assert.equal(v.rows.find(r => r.id === 'c').team.text, '成员 m1');
  assert.match(v.text, /【在等你回复（2）】/);
  assert.match(v.text, /拍板：用方案A还是B（推荐 A）/);
  assert.match(v.text, /其余 2 个会话/);
  assert.ok(v.rows.findIndex(r => r.group === 'waiting') < v.rows.findIndex(r => r.group === 'running'));
});

test('矛盾提示两条：卡写在跑但 1 小时没输出；在跑但进展卡 3 小时没更新', () => {
  const sessions = [
    { id: 'x', title: '卡说顺利', lastOutputAt: NOW - 2 * HOUR },
    { id: 'y', title: '卡没更新', lastOutputAt: NOW - 1 * MIN },
    { id: 'z', title: '老卡不翻旧账', lastOutputAt: NOW - 50 * HOUR },
  ];
  const cards = [
    { sessionId: 'x', mtimeMs: NOW - 2 * HOUR, plain: { status: '顺利', line: '在跑仿真' } },
    { sessionId: 'y', mtimeMs: NOW - 4 * HOUR, plain: { status: '顺利', line: '写代码' } },
    { sessionId: 'z', mtimeMs: NOW - 50 * HOUR, plain: { status: '顺利', line: '很久以前' } },
  ];
  const v = buildRunningOverview({ sessions, cards, now: NOW, facts: facts({ y: { busy: true } }) });
  const x = v.rows.find(r => r.id === 'x'), y = v.rows.find(r => r.id === 'y');
  assert.equal(x.group, 'suspect');
  assert.match(x.warnings[0], /卡写在跑，但 2 小时没输出/);
  assert.equal(y.group, 'suspect');
  assert.match(y.warnings[0], /在跑，但进展卡 4 小时没更新/);
  assert.ok(!v.rows.some(r => r.id === 'z'));
  assert.match(v.text, /⚠ 卡写在跑/);
});

test('文字版不超过 4 KB：放不下的从低优先级组折叠成「另有 N 个」', () => {
  const sessions = [], f = {};
  for (let i = 0; i < 120; i++) {
    sessions.push({ id: 's' + i, title: '一个名字比较长的会话标题用来撑满长度第' + i + '号', lastOutputAt: NOW - (i % 10) * MIN });
    f['s' + i] = i < 10 ? { needsInput: true } : { busy: i < 80, completed: true, kind: 'CodeAgent' };
  }
  const cards = sessions.map(s => ({ sessionId: s.id, mtimeMs: NOW - MIN, plain: { status: '顺利', line: '进展卡第一句写得也很长，'.repeat(6) } }));
  const v = buildRunningOverview({ sessions, cards, now: NOW, facts: facts(f) });
  assert.ok(v.bytes <= CAP, `实际 ${v.bytes} 字节`);
  assert.equal(v.rows.length, 120, '结构化行不截断，界面自己分页');
  assert.match(v.text, /另有 \d+ 个没列出/);
  assert.match(v.text, /【在等你回复（10）】/);
  assert.ok(v.text.split('\n').filter(l => l.startsWith('- ') && !l.includes('另有')).length > 5);
});

test('主进程取数：内部会话、群聊成员、休眠会话只计数；在跑以进展卡服务的判断为准', () => {
  const sessions = [
    { id: 'p1', title: '普通', kind: 'codeagent', status: 'idle', lastOutputAt: NOW - 10 * MIN, lastCompletedAt: NOW - 10 * MIN },
    { id: 'p2', title: '助理', kind: 'codeagent', purpose: 'company-assistant', lastOutputAt: NOW },
    { id: 'p3', title: '群成员', kind: 'claude', meetingId: 'mt1', lastOutputAt: NOW },
    { id: 'p4', title: '休眠', kind: 'codeagent', status: 'dormant', lastOutputAt: NOW },
    { id: 'p5', title: '渲染进程说在跑', kind: 'codeagent-resume', status: 'idle', lastOutputAt: NOW - MIN },
  ];
  const ro = createRunningOverview({ getSessions: () => sessions, now: () => NOW, isReportedRunning: s => s.id === 'p5',
    getCards: () => { throw new Error('卡服务没起来'); } });
  const v = ro.get();
  assert.deepEqual(v.rows.map(r => [r.id, r.group]).sort(), [['p1', 'done'], ['p5', 'running']]);
  assert.equal(v.counts.rest, 3);
  assert.equal(v.rows.find(r => r.id === 'p5').kind, 'CodeAgent');
  assert.equal(ro.get({ exclude: s => s.id === 'p1' }).rows.length, 1);
});

test('公司助理工具：running_overview 挂在 desk 和 phone，ppt/brief 不挂；调用返回同一份文字', async () => {
  const { TOOLSETS, toolsFor } = require('../core/company-assistant/mcp');
  assert.ok(TOOLSETS.desk.includes('running_overview') && TOOLSETS.phone.includes('running_overview'));
  assert.ok(!TOOLSETS.ppt.includes('running_overview') && !TOOLSETS.brief.includes('running_overview'));
  const tool = toolsFor('desk').find(t => t.name === 'running_overview');
  assert.equal(tool.annotations.readOnlyHint, true);
  const { HubTools } = require('../core/company-assistant/hub-tools');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-overview-'));
  try {
    const a = { dir, now: () => NOW, changed() {}, state: () => ({ sessionId: 'legacy' }), toolsetFor: id => (id === 'desk-1' ? 'desk' : id === 'ppt-1' ? 'ppt' : null) };
    let seenExclude = null;
    const tools = new HubTools(a, { runningOverview: ({ exclude }) => { seenExclude = exclude; return { text: '【在跑一览】在等你回复 0', counts: { waiting: 0 } }; } });
    const out = await tools.invoke({ name: 'running_overview', arguments: {}, callerSessionId: 'desk-1' });
    assert.match(out.overview, /在跑一览/);
    assert.equal(seenExclude({ id: 'desk-1' }), true, '助理自己的问答会话不列');
    assert.equal(seenExclude({ id: 'user-1', kind: 'codeagent' }), false);
    await assert.rejects(tools.invoke({ name: 'running_overview', arguments: {}, callerSessionId: 'ppt-1' }), /没有挂这个工具/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('密钥识别：常见密钥命中，提交号、网址、UUID、普通数字放行', () => {
  const hits = [
    'key 是 sk-AbCdEf0123456789xyzXYZ',
    'Authorization: Bearer abcDEF1234567890ghijKLMN',
    'ghp_0123456789abcdefABCDEF0123',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    '-----BEGIN RSA ' + 'PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'https://gw.example.com/v1?api_key=Zx81kQ09aa77Lm2P',
    '密码：Hello@2026',
    'api_key = 7f3k9QpL2mN8xR4v',
    '部门的 key：Q2xpZW50U2VjcmV0S2V5MTIzNDU2Nzg5MEFCQ0RFRg',
  ];
  for (const s of hits) assert.ok(findSecret(s), '应命中：' + s);
  const passes = [
    '提交 3234ab934c0f1e2d3a4b5c6d7e8f90123456789a 已合入',
    'https://github.com/example/repo/commit/3234ab934c0f1e2d3a4b5c6d7e8f90123456789a',
    '会话 25ee64bf-593b-4195-80b8-cb4fd1f0988c 在跑',
    'token 用量：1200000，key：领域',
    '用户偏好：周报每周五下午发，抄送组长',
    'sk-短的',
    'D:/AIWork/20261120-hubh-frontdesk-lead-claude/tasks/m2-在跑一览与密钥拦截.md',
    '密钥在设置里，名称 部门网关',
  ];
  for (const s of passes) assert.equal(findSecret(s), null, '不应命中：' + s);
});

test('助理记忆：含密钥拒写并提示去设置保存，普通文本照常写入', () => {
  const { AssistantMemory, SECRET_BLOCKED } = require('../core/company-assistant/memory');
  const files = {};
  const a = { now: () => NOW, read: (n, d) => files[n] || d, write: (n, v) => { files[n] = v; }, auth: null, snapshot: () => ({ login: { uid: 'u1' } }) };
  const m = new AssistantMemory(a);
  assert.equal(SECRET_BLOCKED, '密钥已拦截，不进记忆；请在设置里的 API 配置保存');
  assert.throws(() => m.execute({ op: 'save', key: '网关', text: 'sk-AbCdEf0123456789xyzXYZ' }, { fromSettings: true }), new RegExp(SECRET_BLOCKED));
  assert.throws(() => m.execute({ op: 'save', key: 'Bearer abcDEF1234567890ghijKLMN', text: '网关' }, { fromSettings: true }), /密钥已拦截/);
  // 超长的密钥也先报拦截，而不是「最多 60 字」。
  assert.throws(() => m.execute({ op: 'save', key: '网关', text: '我的 key 是 sk-' + 'A1b2C3d4'.repeat(12) }, { fromSettings: true }), /密钥已拦截/);
  assert.equal((files['memory.json']?.items || []).length, 0);
  const ok = m.execute({ op: 'save', key: '周报', kind: 'routine', text: '每周五下午发，提交号 3234ab934 记在周报里' }, { fromSettings: true });
  assert.equal(ok.ok, true);
});

test('组队计划：goal/task 含密钥拒收并提示改写，正常计划照常提交', async t => {
  assert.throws(() => assertPlanFree({ goal: '接网关 sk-AbCdEf0123456789xyzXYZ', members: [] }), /goal 里疑似有密钥.*密钥在设置里，名称 X/);
  assert.throws(() => assertPlanFree({ goal: '目标', members: [{ role: '实现', task: '用 Bearer abcDEF1234567890ghijKLMN 调接口' }] }), /第 1 人的 task/);
  assert.doesNotThrow(() => assertPlanFree({ goal: '目标', members: [{ role: '实现', task: '读 D:/AIWork/x/tasks/m2.md，密钥在设置里，名称 部门网关' }] }));
  const { createTeamService } = require('../main/team/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-secret-'));
  const rows = [{ id: 'pool-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }];
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: dir }]]);
  const service = createTeamService({ company: true, getHubDataDir: () => dir, getConfig: () => ({}), listAccounts: () => ({ recommendedId: 'pool-a', rows }),
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: () => false }, commandPath: () => path.join(dir, 'hub-team.cmd'),
    createSession: async () => { throw new Error('不该建会话'); }, submitPrompt: async () => ({ ok: true }) });
  t.after(() => { service.freeze(); service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(service.invoke('lead-0001', 'propose', { goal: '目标', members: [{ role: '实现', task: 'key: sk-AbCdEf0123456789xyzXYZ', account: 'pool-a' }] }), /已拒收/);
  assert.equal(service.listTeams().length, 0, '拒收时不落盘');
  const p = await service.invoke('lead-0001', 'propose', { goal: '目标', members: [{ role: '实现', task: '正常任务', account: 'pool-a' }] });
  assert.equal(p.status, 'pending');
});

// ---- Codex 审查返工（2026-11-20）：每条撤掉修复即失败 ----
test('审查 P1：输出时间用会话条目上的实时值，持续输出的长任务不报「久没输出」', () => {
  const sessions = [{ id: 'L', title: '长任务', kind: 'codeagent', status: 'running', lastMessageTime: NOW - 2 * HOUR }];
  const ro = createRunningOverview({ getSessions: () => sessions, now: () => NOW, isReportedRunning: () => true, getLastOutputAt: id => (id === 'L' ? NOW - 20000 : 0) });
  const row = ro.get().rows[0];
  assert.equal(row.group, 'running');
  assert.equal(row.silent, '刚刚');
});

test('审查 P1：「刚完成」要有完成证据；刚新建、已中断的只有近期活动，不进刚完成', () => {
  const sessions = [
    { id: 'new', title: '刚新建', kind: 'codeagent', status: 'idle', lastMessageTime: NOW - MIN },
    { id: 'int', title: '已中断', kind: 'codeagent', status: 'idle', lastOutputAt: NOW - 5 * MIN, nativeRuntime: { state: 'interrupted' } },
    { id: 'ok', title: '真答完', kind: 'codeagent', status: 'idle', lastOutputAt: NOW - 5 * MIN, lastCompletedAt: NOW - 5 * MIN },
  ];
  const ro = createRunningOverview({ getSessions: () => sessions, now: () => NOW, isReportedRunning: () => false });
  const v = ro.get();
  assert.deepEqual(v.rows.map(r => [r.id, r.group]), [['ok', 'done']]);
  assert.equal(v.counts.rest, 2);
  // 纯函数层：没有 completed 证据就不进刚完成
  const pure = buildRunningOverview({ sessions: [{ id: 'x', lastOutputAt: NOW - MIN }], now: NOW, facts: () => ({}) });
  assert.equal(pure.rows.length, 0);
});

test('审查 P1：运行时状态 waiting（等批准）进「在等你回复」', () => {
  const sessions = [{ id: 'w', title: '等批准', kind: 'codeagent', status: 'running', agentRuntime: 'pty', lastOutputAt: NOW - MIN,
    cliRuntime: { state: 'waiting', connection: 'connected' } }];
  const ro = createRunningOverview({ getSessions: () => sessions, now: () => NOW });
  const row = ro.get().rows[0];
  assert.equal(row.group, 'waiting');
  assert.equal(row.state, '在等你批准或确认');
});

test('审查 P2：旧字段 status=running 不盖过可信状态，只在没有可信状态时兜底', () => {
  const done = [{ id: 'c', title: '已完成', kind: 'codeagent', status: 'running', agentRuntime: 'pty', lastOutputAt: NOW - MIN, lastCompletedAt: NOW - MIN,
    cliRuntime: { state: 'completed', connection: 'connected', completedAt: NOW - MIN } }];
  assert.equal(createRunningOverview({ getSessions: () => done, now: () => NOW }).get().rows[0].group, 'done');
  assert.equal(createRunningOverview({ getSessions: () => done, now: () => NOW, isReportedRunning: () => false }).get().rows[0].group, 'done', '界面报不在跑也不被旧字段推翻');
  const legacy = [{ id: 'u', title: '没有可信状态', kind: 'codeagent', status: 'running', lastOutputAt: NOW - MIN }];
  const f = createRunningOverview({ getSessions: () => legacy, now: () => NOW }).facts(legacy[0]);
  assert.equal(f.busy, true, '没有任何可信状态时才用旧字段');
});

test('审查 P2：界面只在打开和点「刷新」时读，不加定时器', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'running-overview.js'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout/);
  assert.match(src, /data-action="refresh"/);
});

test('审查 P1/P2：JSON 形式的字段名能拦；图片网址、base64 图片、混合大小写十六进制不误拦', () => {
  for (const s of ['{"api_key":"0123456789abcdef0123456789abcdef"}', "{'secret': 'abcdefghijklmnopqrstuvwx'}", 'api_key: abcdefghijklmnopqrstuvwx', '"token":"x8Kq2mN5pL9rT3vW"'])
    assert.ok(findSecret(s), '应命中：' + s);
  for (const s of ['https://cdn.example.com/img/Ab3dEf9hJk2mN5pQ8rS1tU4vW7xY0zAb.png', '![图](images/Ab3dEf9hJk2mN5pQ8rS1tU4vW7xY0zAbCd.jpg)',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    '摘要 3F2a9C4b7D1e8A5f6B0c9D2e7F4a1B3c', 'key: introduction_section_name', 'token: 1200000000000000'])
    assert.equal(findSecret(s), null, '不应命中：' + s);
  // 无标签、不在网址里的随机串仍拦
  assert.ok(findSecret('部门给的是 Q2xpZW50U2VjcmV0S2V5MTIzNDU2Nzg5MEFCQ0RFRg 这个'));
});
