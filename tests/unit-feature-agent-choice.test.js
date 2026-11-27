'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const choice = require('../core/feature-agent-choice'), routes = require('../core/codeagent-assistant-route');
// 公司版：Claude Code / Codex 只当外壳，模型带来源（部门 API key = gateway、公司模型 = company，core/feature-agent-choice.js）。
const backends = [{ kind: 'claude', label: 'Claude Code', available: true, models: [{ id: 'haiku', source: 'gateway' }] },
  { kind: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-6-astra', source: 'company' }] },
  { kind: 'codeagent', label: 'CodeAgent', available: true, models: [{ id: 'glm-test', provider: 'builtin' }, { id: 'glm-alt', provider: 'builtin' }] }];
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-agent-r13-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('所有功能未设置时返回原 kind 和同一个 opts，不改变旧助理供应商', t => {
  const dir = temp(t), opts = { model: 'existing', codeagentPoolPick: 'account' };
  routes.setPreference(dir, 'personal', { model: 'legacy', provider: 'builtin' });
  for (const f of choice.FEATURES) {
    const r = choice.session(dir, f.id, 'codeagent', opts, { backends });
    assert.equal(r.kind, 'codeagent'); assert.equal(r.opts, opts); assert.equal(r.warning, '');
  }
  assert.equal(routes.preference(dir).model, 'legacy');
});
test('各功能独立持久化选择，重新读取仍有效，恢复默认保留旧供应商', t => {
  const dir = temp(t);
  routes.setPreference(dir, 'personal', { model: 'legacy', provider: 'builtin' });
  for (const f of choice.FEATURES) {
    const selected = f.kinds.includes('codex') && !f.exclude?.includes('codex') ? { kind: 'codex', model: 'gpt-6-astra', source: 'company' } : { kind: 'codeagent', model: 'glm-test' };
    choice.set(dir, f.id, selected, { backends });
    assert.deepEqual(choice.resolve(dir, f.id, { backends }).selected, selected);
  }
  choice.set(dir, 'help', null, { backends });
  assert.equal(choice.resolve(dir, 'help').selected, null);
  assert.equal(choice.resolve(dir, 'assistant', { backends }).selected.kind, 'codeagent');
  assert.equal(routes.preference(dir).model, 'legacy');
});
test('后端卸载、模型撤回、模型不可用均按原选项回退并保留恢复入口', t => {
  const dir = temp(t), opts = { model: 'legacy' };
  choice.set(dir, 'help', { kind: 'claude', model: 'haiku', source: 'gateway' }, { backends });
  for (const broken of [[], [{ ...backends[0], available: false }], [{ ...backends[0], models: [] }], [{ ...backends[0], models: [{ id: 'haiku', source: 'gateway', unavailable: true }] }], [{ ...backends[0], models: [{ id: 'haiku', source: 'company' }] }]]) {
    const r = choice.session(dir, 'help', 'codeagent', opts, { backends: broken });
    assert.equal(r.kind, 'codeagent'); assert.equal(r.opts, opts); assert.match(r.warning, /不可用/);
    assert.equal(choice.resolve(dir, 'help', { backends: broken }).choice.model, 'haiku');
  }
});
test('CodeAgent 供应商同名消歧保持，换其他后端不携带旧账号字段', t => {
  const dir = temp(t);
  choice.set(dir, 'assistant', { kind: 'codeagent', model: 'glm-test', provider: 'builtin' }, { backends });
  const r = choice.session(dir, 'assistant', 'codeagent', {}, { backends });
  assert.equal(r.opts.codeagentModelProvider, 'builtin');
  assert.throws(() => choice.set(dir, 'assistant', { kind: 'claude', model: 'haiku' }, { backends }));
  routes.setFeaturePreference(dir, 'assistant', { kind: 'claude', model: 'haiku' });
  const opts = { codeagentPoolPick: 'old', codeagentRouteModel: 'old' };
  const other = choice.session(dir, 'assistant', 'codeagent', opts, { backends });
  assert.equal(other.kind, 'codeagent'); assert.equal(other.opts, opts); assert.match(other.warning, /公司里用不了/);
  assert.equal(choice.stale(dir, 'assistant', r.opts, { backends }), true);
  assert.equal(choice.stale(dir, 'assistant', other.opts, { backends }), false);
});
test('无效功能、非法模型、不可用后端不写入配置', t => {
  const dir = temp(t);
  assert.throws(() => choice.set(dir, 'unknown', null));
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'a\nb' }, { backends }));
  assert.throws(() => choice.set(dir, 'help', { kind: 'claude', model: 'missing' }, { backends }));
  assert.equal(routes.featurePreference(dir, 'help'), null);
});
test('团队来信隐藏并拒绝 Codex，旧配置不会被继续执行，其他单次功能照常可选', t => {
  const dir = temp(t), crew = choice.FEATURES.find(f => f.id === 'crew');
  assert.ok(!choice.featureOptions(crew, backends).some(b => b.value === 'codex'));
  assert.ok(choice.featureOptions(choice.FEATURES.find(f => f.id === 'help'), backends).some(b => b.value === 'codex'));
  const codex = { kind: 'codex', source: 'company', model: 'gpt-6-astra' };
  assert.throws(() => choice.set(dir, 'crew', codex, { backends }), /可用的后端/);
  routes.setFeaturePreference(dir, 'crew', codex);
  assert.equal(choice.resolve(dir, 'crew', { backends }).selected, null);
  assert.match(choice.resolve(dir, 'crew', { backends }).warning, /不支持/);
});
test('公司版外壳目录与启动中心同源：只有部门 key 与公司模型，没有 claude-opus / gpt 这类公司用不了的模型', t => {
  const dir = temp(t);
  t.mock.method(require('../core/hub-config'), 'getConfig', () => ({ acp: { providers: { 'deepseek-acp': { entryPath: __filename, model: 'custom-company-model' } } } }));
  t.mock.method(require('../core/hub-config'), 'readConfigJsonForUpdate', () => ({}));
  const settings = require('../core/company-api-config').settings;
  const fake = { backend: 'local', companyModels: [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }], gatewayModels: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', note: '可用' }] };
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({ claude: fake, codex: fake, 'deepseek-acp': fake }));
  const catalog = choice.catalog(dir, { env: { USERPROFILE: dir, CODEX_HOME: dir, CLAUDE_HUB_HOME_DIR: dir }, findCommand: () => 'fixture' });
  void settings;
  for (const kind of ['claude', 'codex', 'deepseek-acp']) {
    const row = catalog.find(b => b.kind === kind);
    assert.equal(row.harness, true);
    assert.ok(row.models.length > 0);
    for (const m of row.models) { assert.ok(['gateway', 'company'].includes(m.source), kind + ' ' + m.id); assert.doesNotMatch(m.id, /claude-|gpt-|opus|sonnet|haiku/i); }
    assert.ok(row.models.some(m => m.source === 'gateway' && m.id === 'deepseek-v4.1-flash'));
  }
  // 没有部门 key、也没有 CodeAgent：外壳不可用，原因说清要先配置什么。
  t.mock.method(require('../core/company-api-config'), 'settings', () => ({ claude: { ...fake, gatewayModels: undefined }, codex: { ...fake, gatewayModels: undefined }, 'deepseek-acp': { ...fake, gatewayModels: undefined } }));
  const none = choice.catalog(dir, { env: { USERPROFILE: dir, CODEX_HOME: dir, CLAUDE_HUB_HOME_DIR: dir }, findCommand: kind => kind === 'codeagent' ? '' : 'fixture' });
  const claude = none.find(b => b.kind === 'claude');
  assert.equal(claude.available, false); assert.match(claude.reason, /部门 API key、自有 API/); assert.equal(claude.setup, 'source');
  assert.equal(claude.models.length, 0);
});
test('助理和 PPT 的真实建会话入口分别读取相应功能选型', async t => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const dir = temp(t), called = [];
  const original = choice.session;
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  choice.set(dir, 'assistant', { kind: 'codeagent', model: 'glm-test' }, { backends });
  choice.set(dir, 'ppt', { kind: 'codeagent', model: 'glm-alt' }, { backends });
  choice.set(dir, 'pptMake', { kind: 'codeagent', model: 'glm-test' }, { backends });
  choice.set(dir, 'pptImgtext', { kind: 'codeagent', model: 'glm-alt' }, { backends });
  const a = { deps: { dataDir: dir, createSession: async (kind, opts) => { called.push({ kind, opts }); return { id: opts.id }; } },
    prepareWorkspace() {}, pool: new Map(), now: Date.now, settings: () => ({}), workspaceFor: () => dir };
  await CompanyAssistant.prototype.openPooled.call(a, 'desk');
  await CompanyAssistant.prototype.openPooled.call(a, 'ppt');
  await CompanyAssistant.prototype.openPooled.call(a, 'ppt', 'pptMake');
  await CompanyAssistant.prototype.openPooled.call(a, 'ppt', 'pptImgtext');
  assert.deepEqual(called.map(c => [c.kind, c.opts.model]), [['codeagent', 'glm-test'], ['codeagent', 'glm-alt'], ['codeagent', 'glm-test'], ['codeagent', 'glm-alt']]);
});
test('PPT 做页与图转字的独立选型随问题排队和重试保留', () => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  for (const featureAgent of ['pptMake', 'pptImgtext']) {
    let queued, saved;
    const a = { now: Date.now, verifyTeamOwner() {}, chat: () => [], saveChat: items => { saved = items[0]; },
      enqueue: job => { queued = job; }, startPptCollector() {}, changed() {} };
    CompanyAssistant.prototype.ask.call(a, '任务', { entry: 'ppt', featureAgent });
    assert.equal(queued.featureAgent, featureAgent); assert.equal(saved.featureAgent, featureAgent);
    let retried;
    CompanyAssistant.prototype.retryChat.call({ chat: () => [saved], ask: (_q, opts) => { retried = opts; } }, saved.id);
    assert.equal(retried.featureAgent, featureAgent);
  }
});
test('团队分析闲置会话在改选后换新，在途分析保留', async t => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const dir = temp(t), original = choice.session, key = require('node:crypto').createHash('sha256').update('owner').digest('hex');
  t.mock.method(require('../core/work-file-root'), 'directory', (_name, fallback) => fallback);
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  t.mock.method(choice, 'stale', () => true);
  choice.set(dir, 'assistant', { kind: 'codeagent', model: 'glm-alt' }, { backends });
  let closed = 0, created, busy = false;
  const a = { deps: { dataDir: dir, getSession: id => id === 'old' ? { id } : null,
    closeSession: async () => { closed++; }, createSession: async (kind, opts) => { created = { kind, opts }; return { id: opts.id }; } },
    verifyTeamOwner() {}, state: () => ({ teamSessionIds: { [key]: 'old' } }), saveState() {}, sessionBusy: () => busy };
  await CompanyAssistant.prototype.ensureTeamSession.call(a, 'owner');
  assert.equal(closed, 1); assert.equal(created.kind, 'codeagent');
  busy = true;
  await assert.rejects(() => CompanyAssistant.prototype.ensureTeamSession.call(a, 'owner'), /还在回答/);
  assert.equal(closed, 1);
});
test('分身真实建会话入口读取选择，保留工作目录和身份', async t => {
  const { AgentSessions } = require('../core/avatar/agent-session');
  const dir = temp(t), original = choice.session;
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  choice.set(dir, 'avatar', { kind: 'codeagent', model: 'glm-alt' }, { backends });
  let called;
  const sessions = new AgentSessions({ dataDir: dir, getSession: () => null, createSession: async (kind, opts) => { called = { kind, opts }; return { id: opts.id }; } });
  const result = await sessions.ensure({ id: 'avatar', name: '分身', sources: [] }, null, dir);
  assert.equal(called.kind, 'codeagent'); assert.equal(called.opts.model, 'glm-alt'); assert.equal(called.opts.cwd, dir); assert.equal(called.opts.id, result.id);
});
test('问问 Hub 单次引擎与库地图均读取选择并交给同一只读执行器', async t => {
  const dir = temp(t), calls = [];
  t.mock.method(choice, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async (selected, prompt) => { calls.push({ selected, prompt }); return '已回答'; });
  const engine = require('../core/help-ask/engine').createHelpAskEngine({ dataDir: dir, findCommand: () => 'fake', manualPath: () => 'fake', readManual: () => '说明书' });
  const answer = await engine.ask({ question: '在哪设置？' });
  assert.equal(answer.ok, true); assert.equal(answer.model, 'haiku');
  const channel = require('../core/company-assistant/ppt-map-model').createCodeAgentChannel({ dataDir: dir });
  assert.equal((await channel.probe()).model, 'haiku'); assert.equal(await channel.run('分类'), '已回答');
  assert.equal(calls.length, 2); assert.equal(calls[0].selected.kind, 'claude');
});
test('论坛、会议与进展摘要的真实消费入口读取选择', async t => {
  const dir = temp(t), original = choice.session;
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  choice.set(dir, 'forum', { kind: 'codeagent', model: 'glm-alt' }, { backends });
  let called;
  const forum = { deps: { dataDir: dir, getSession: () => null, createSession: async (kind, opts) => { called = { kind, opts }; return { id: opts.id }; } }, state: () => ({}), workspace: dir, saveState() {} };
  await require('../core/company-forum/service').CompanyForum.prototype.ensureSession.call(forum);
  assert.equal(called.kind, 'codeagent'); assert.equal(called.opts.model, 'glm-alt');
  t.mock.method(choice, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async selected => selected.model);
  const meeting = require('../core/company-assistant/meeting');
  const Meeting = Object.values(meeting).find(v => typeof v === 'function' && v.prototype?.engineFor);
  assert.equal(Meeting.prototype.engineFor.call({ a: { deps: { dataDir: dir } } }, {}).model, 'haiku');
  assert.equal(await require('../main/progress-card-service').haikuSummarizer()('进展'), 'haiku');
});
test('读取 ACP 原生终态，过滤仍在输出的卡片；Codex 落盘读取不再伪装 Claude', () => {
  const finals = require('../core/feature-agent-finals');
  const manager = { getNativeSession: () => ({ readTranscript: () => [{ role: 'assistant', text: '完成', stopReason: 'completed' }, { role: 'assistant', text: '未完', stopReason: 'inProgress' }] }) };
  assert.deepEqual(finals.read({ id: 'sid', kind: 'deepseek-acp' }, manager, null).map(r => r.text), ['完成']);
  let seen;
  finals.read({ id: 'sid', kind: 'codex' }, {}, { read: meta => { seen = meta; return { available: true, records: [] }; } });
  assert.equal(seen.kind, 'codex');
});
test('单次执行器将实际所选模型传给 CLI，保留只读、MCP 禁用和取消信号', async t => {
  const dir = temp(t), calls = [], signal = new AbortController().signal;
  const runOnce = async spec => { calls.push(spec); return spec.args.includes('--help') ? { code: 0, stdout: '-p --tools --model --strict-mcp-config --no-session-persistence --permission-mode' } : { code: 0, stdout: '回答' }; };
  const runner = require('../core/feature-agent-run');
  assert.equal(await runner.run({ kind: 'claude', model: 'haiku' }, '问题', { dataDir: dir, signal, runOnce, findCommand: () => 'fixture' }), '回答');
  const request = calls.at(-1);
  assert.equal(request.args[request.args.indexOf('--model') + 1], 'haiku');
  assert.equal(request.args[request.args.indexOf('--tools') + 1], '');
  assert.ok(request.args.includes('--strict-mcp-config')); assert.equal(request.signal, signal);
  calls.length = 0;
  await runner.run({ kind: 'codex', model: 'gpt-6-astra' }, '问题', { dataDir: dir, signal, runOnce, findCommand: () => 'fixture', env: { CODEX_HOME: dir } });
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(calls.at(-1).args.includes('read-only'));
});
test('共用文字任务通过真实执行入口使用选择，返回实际模型', async t => {
  const dir = temp(t), original = choice.session;
  t.mock.method(choice, 'session', (data, feature, kind, opts) => original(data, feature, kind, opts, { backends }));
  choice.set(dir, 'text', { kind: 'codeagent', model: 'glm-test' }, { backends });
  let called, final;
  const tasks = new (require('../core/company-ai-tasks').CompanyAiTasks)({ dataDir: dir,
    createSession: async (kind, opts) => { called = { kind, opts }; return { id: opts.id }; },
    sendPrompt: async (_id, prompt) => { final = { text: '结果\n' + prompt.match(/\[任务回执:[^\]]+\]/)[0] }; return { ok: true }; },
    lastFinal: () => final, closeSession: async () => {}, pollMs: 1 });
  const result = await tasks.run({ text: '材料', label: '草稿' }); tasks.close();
  assert.equal(called.kind, 'codeagent'); assert.equal(called.opts.model, 'glm-test'); assert.equal(result.model, 'glm-test'); assert.equal(result.text, '结果');
});
test('库地图从其他后端恢复默认时，不把上一家模型名传给 CodeAgent', async t => {
  const dir = temp(t); let selected = { kind: 'claude', model: 'haiku' };
  t.mock.method(choice, 'resolve', () => ({ selected }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async () => '结果');
  const channel = require('../core/company-assistant/ppt-map-model').createCodeAgentChannel({ dataDir: dir });
  await channel.run('分类'); assert.equal(channel.model(), 'haiku');
  selected = null; assert.equal(channel.model(), '');
});
