'use strict';
// R58b：公司版组队成员放开 Claude Code、Codex（方案一），accounts 返回各后端就绪情况与混编配方（方案二），
// 小队负责人提示词默认分工（G1）。负责人仍只能是 CodeAgent。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTeamService } = require('../main/team/service');
const B = require('../main/team/backends');

const fakeDeps = ({ peek = {}, launch = {}, configured = {}, own = {} } = {}) => ({
  locator: { peek: id => peek[id] ?? null, launchSpec: id => launch[id] ?? null },
  proxy: { companyModelIds: () => ['GLM-5.2-WX', 'DeepSeek-V4.1-Flash'], gatewayModelIds: () => ['gw-model-a'] },
  apiConfig: {
    assertLaunchConfigured: kind => { if (configured[kind] === false) throw new Error(`${kind} 线路没配好`); },
    ownSource: (_raw, kind) => own[kind] || { backend: 'local', model: '' },
  },
  readRaw: () => ({}),
  kindAllowed: () => true,
});

test('backends: install, route, readiness and model lists come from local state only', () => {
  const rows = B.listTeamBackends({
    config: { claudeBackend: 'proxy', claudeUpstream: '', claudeApiModel: 'GLM-5.2-WX', codexBackend: 'api', codexApiModel: 'own-1' },
    kinds: ['claude', 'codex'],
    deps: fakeDeps({ peek: { claude: { verdict: 'ok' }, codex: null }, launch: { codex: { command: 'codex.cmd' } },
      own: { codex: { backend: 'api', model: 'own-1', models: ['own-1', 'own-2'] } } }),
  });
  const claude = rows.find(r => r.kind === 'claude'), codex = rows.find(r => r.kind === 'codex');
  assert.equal(claude.ready, true); assert.equal(claude.companyRoute, true);
  assert.deepEqual(claude.models, ['GLM-5.2-WX', 'DeepSeek-V4.1-Flash']); assert.equal(claude.defaultModel, 'GLM-5.2-WX');
  assert.match(claude.routeLabel, /公司模型/);
  assert.equal(codex.ready, true); assert.equal(codex.companyRoute, false); assert.equal(codex.installUnverified, true);
  assert.deepEqual(codex.models, ['own-1', 'own-2']);

  const missing = B.listTeamBackends({ config: {}, kinds: ['claude', 'codex'],
    deps: fakeDeps({ peek: { claude: { verdict: 'not-found', reason: '这台电脑上没找到 Claude Code' } }, configured: { codex: false }, launch: { codex: { command: 'x' } } }) });
  assert.equal(missing[0].ready, false); assert.match(missing[0].unavailableReason, /没找到/);
  assert.equal(missing[1].ready, false); assert.match(missing[1].unavailableReason, /线路没配好/);
  assert.deepEqual(missing[0].models, [], 'CLI 自带配置没有可选模型表');
});

test('recommendedMix only recommends ready backends on a company route', () => {
  const none = B.recommendedMix([{ kind: 'codex', label: 'Codex', ready: true, companyRoute: false }]);
  assert.deepEqual(none.heterogeneous, []);
  assert.match(none.note, /全队用 CodeAgent/);
  const mix = B.recommendedMix([
    { kind: 'codex', label: 'Codex', ready: true, companyRoute: true, routeLabel: '公司模型' },
    { kind: 'claude', label: 'Claude Code', ready: true, companyRoute: true, routeLabel: '公司模型' },
    { kind: 'deepseek-acp', label: 'DSH', ready: false, companyRoute: true },
  ]);
  assert.deepEqual(mix.heterogeneous, ['claude', 'codex']);
  assert.equal(mix.minNonCodeAgent, 1);
  assert.equal(mix.slots.find(s => s.slot === '审查/复核').kind, 'claude');
  assert.match(mix.note, /建议，不强制/);
});

function harness(t, backends) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-team-mix-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [{ id: 'pool-a', usable: true, models: ['GLM-5.2'], modelsAuthoritative: true }];
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: dir }]]), created = [], sent = [];
  const h = { fail: null };
  const service = createTeamService({ getHubDataDir: () => dir, getConfig: () => ({}),
    listAccounts: () => ({ recommendedId: 'pool-a', rows }), listBackends: () => backends,
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: () => false }, commandPath: () => path.join(dir, 'hub-team.cmd'),
    createSession: async request => {
      created.push(request);
      if (h.fail) throw h.fail;
      const s = { id: `member-${created.length}xxx`, kind: request.kind }; sessions.set(s.id, s); return s;
    },
    submitPrompt: async (sid, text) => { sent.push({ sid, text }); return { ok: true }; } });
  t.after(() => { service.freeze(); service.stop(); });
  return Object.assign(h, { service, created, sent, sessions, dir });
}
const ready = (kind, extra = {}) => ({ kind, label: B.LABELS[kind], ready: true, companyRoute: true, routeLabel: '公司模型（CodeAgent 账号，经本机反代）',
  models: ['GLM-5.2-WX', 'DeepSeek-V4.1-Flash'], defaultModel: 'GLM-5.2-WX', ...extra });

test('a plan mixes CodeAgent with Claude Code and Codex; non-CodeAgent members get no pool options', async t => {
  const h = harness(t, [ready('claude'), ready('codex')]);
  const r = await h.service.decide({ leadSid: 'lead-0001', approve: true, planId: (await h.service.invoke('lead-0001', 'propose', { goal: '实现加审查', members: [
    { role: '实现', task: '实现' },
    { role: '审查', task: '异构审查', kind: 'claude', model: 'deepseek-v4.1-flash' },
    { role: '补测试', task: '补测试', kind: 'Codex' },
  ] })).planId });
  assert.equal(r.created.length, 3);
  assert.deepEqual(h.created.map(c => c.kind), ['codeagent', 'claude', 'codex']);
  assert.equal(h.created[0].opts.codeagentAccount, 'pool');
  for (const c of h.created.slice(1)) {
    assert.equal(c.opts.hubTeamMember, true);
    assert.equal(c.opts.openInBackground, true);
    for (const key of ['codeagentAccount', 'codeagentPoolPick', 'codeagentModelPick']) assert.equal(Object.hasOwn(c.opts, key), false, key);
    assert.equal(Object.hasOwn(c.opts, 'cardRunMode'), false, '组队建成员不带卡片模式');
  }
  assert.equal(h.created[1].opts.model, 'DeepSeek-V4.1-Flash', '模型名换成线路模型表里的写法');
  assert.equal(Object.hasOwn(h.created[2].opts, 'model'), false, '没指定模型就沿用线路默认');
  const members = h.service.listTeams()[0].members;
  assert.deepEqual(members.map(m => [m.kind, m.account]), [['codeagent', 'pool-a'], ['claude', ''], ['codex', '']]);
});

test('non-CodeAgent members: account, unready backend, unknown model and unknown kinds are rejected before any session', async t => {
  const h = harness(t, [ready('claude'), ready('codex', { ready: false, unavailableReason: '本机没找到 Codex，可在启动中心一键安装' }),
    ready('deepseek-acp', { ready: false, unavailableReason: 'DSH 还没选模型来源' })]);
  const propose = member => h.service.invoke('lead-0001', 'propose', { goal: '目标', members: [{ role: '审查', task: '审查', ...member }] });
  await assert.rejects(propose({ kind: 'claude', account: 'pool-a' }), /不点名账号/);
  await assert.rejects(propose({ kind: 'codex' }), /还不能用：本机没找到 Codex/);
  await assert.rejects(propose({ kind: 'claude', model: 'no-such-model' }), /不在 Claude Code 这条线路.*GLM-5\.2-WX/);
  await assert.rejects(propose({ kind: 'dsh' }), /DSH 还不能用：DSH 还没选模型来源/);
  await assert.rejects(propose({ kind: 'powershell' }), /不可用/);
  assert.equal(h.created.length, 0);
});

test('a model the route rejects is not silently replaced for non-CodeAgent members', async t => {
  const h = harness(t, [ready('claude')]);
  h.fail = Object.assign(new Error('模型不可用'), { code: 'SESSION_MODEL_UNAVAILABLE' });
  const p = await h.service.invoke('lead-0001', 'propose', { goal: '目标', members: [{ role: '审查', task: '审查', kind: 'claude', model: 'GLM-5.2-WX' }] });
  const r = await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(h.created.length, 1, '不退回默认模型再建一次');
  assert.equal(r.failed.length, 1);
});

test('accounts returns backends and the mix recipe; a non-CodeAgent lead is still rejected', async t => {
  const h = harness(t, [ready('claude')]);
  const a = await h.service.invoke('lead-0001', 'accounts');
  assert.equal(a.backends[0].kind, 'claude');
  assert.deepEqual(a.recommendedMix.heterogeneous, ['claude']);
  assert.match(a.note, /backends/);
  h.sessions.set('claude-0001', { id: 'claude-0001', kind: 'claude' });
  await assert.rejects(h.service.invoke('claude-0001', 'propose', { goal: '目标', members: [{ role: 'x', task: 'y' }] }), /CodeAgent 会话/);
});

test('team members never join a shared card process', () => {
  const card = require('../core/card-run-mode');
  const config = { companyCli: true, claudeBackend: 'proxy', dshBackend: 'proxy' };
  assert.equal(card.isCardSession('claude', { cardRunMode: 'card' }, config), true);
  assert.equal(card.isCardSession('claude', { cardRunMode: 'card', hubTeamMember: true }, config), false);
  assert.equal(card.isCardSession('deepseek-acp', { cardRunMode: 'card', hubTeamMember: true }, config), false);
  // 休眠后叫醒、重启时会话信息带着 hubTeamMember，接回的仍是独立进程；DSH 不会算出共享进程的目录。
  assert.equal(card.isCardSession('deepseek-acp-resume', { cardRunMode: 'card', hubTeamMember: true, acpSid: 'old' }, config), false);
  assert.equal(card.usesCardDriver('deepseek-acp', { cardRunMode: 'card', hubTeamMember: true }, config), false);
});

test('squad leader prompt asks for a split by default and lists what each backend is good at (G1)', () => {
  const P = require('../core/squad-protocol');
  const text = P.leaderPrompt('做个方案', { leaderMemberId: 'm1', members: [{ memberId: 'm1', label: '成员 1', kind: 'codeagent' },
    { memberId: 'm2', label: '成员 2', kind: 'deepseek-acp' }, { memberId: 'm3', label: '成员 3', kind: 'claude' }] });
  assert.match(text, /用户开了小队就是希望分工/);
  assert.match(text, /至少派给一位成员/);
  assert.doesNotMatch(text, /简单问题直接回答，不写派工块/);
  assert.match(text, /@m2：成员 2（deepseek-acp），适合异构审查/);
  assert.match(text, /@m3：成员 3（claude）[^\n]*，适合异构审查/);
});

test('team guide tells the CodeAgent lead about other backends in both languages', () => {
  const g = require('../core/team-guide');
  assert.match(g.TEAM_GUIDE, /backends.*recommendedMix/);
  assert.match(g.TEAM_GUIDE, /Members can be CodeAgent or any ready backend/);
  assert.equal(g.teamGuideFor({ kind: 'claude' }), null, '只有 CodeAgent 会话能当负责人');
});
