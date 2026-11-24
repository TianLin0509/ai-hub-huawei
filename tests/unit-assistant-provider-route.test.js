'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const route = require('../core/codeagent-assistant-route');
const picker = require('../core/codeagent-model-picker');
const launch = require('../core/codeagent-launch-model');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { describe } = require('../core/company-assistant/turn-api-error');
const { AgentSessions } = require('../core/avatar/agent-session');
const ID = 'deepseek4.1';
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-provider-r12-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const manual = (provider = 'good', account = 'personal') => ({ kind: 'codeagent', currentModel: { id: ID }, codeagentModelProvider: provider, codeagentPoolAccount: account });
const answer = (ts = 1000) => ({ model: ID, text: '成功回答', stopReason: 'end_turn', ts });
const options = [{ id: ID, provider: 'bad' }, { id: ID, provider: 'good' }];
const pick = (dir, account = 'personal', target = ID, extra = {}) => route.choose(dir, account, target, { options, ...extra });
function seedAmbiguity(dir, model = ID) {
  require('../core/codeagent-model-probe').writeProbed(require('../core/codeagent-pool').personalModelsFile(dir),
    { source: 'serve', models: [model], details: [{ id: model, provider: 'bad' }, { id: model, provider: 'good' }] });
}

test('只记录手动成功回答的模型与供应商；选择、报错和自动会话均不能覆盖', t => {
  const dir = temp(t);
  assert.equal(route.choose(dir), null);
  assert.equal(route.rememberSuccess(dir, manual(), answer()), true);
  assert.equal(pick(dir).codeagentModelProvider, 'good');
  launch.rememberModel(dir, 'personal', 'other');
  assert.equal(pick(dir).model, ID, '菜单刚选中不算成功');
  for (const s of [{ ...manual('bad'), purpose: 'company-assistant' }, { ...manual('bad'), purpose: 'avatar-agent' }, { ...manual('bad'), autonomous: true }]) {
    assert.equal(route.rememberSuccess(dir, s, answer(2000)), false);
  }
  assert.equal(route.rememberSuccess(dir, manual('bad'), { ...answer(2000), model: '<synthetic>' }), false);
  assert.equal(route.rememberSuccess(dir, manual('bad'), { ...answer(2000), stopReason: 'tool_use' }), false);
  assert.equal(route.rememberSuccess(dir, manual('bad'), answer(999)), false, '旧回答不能倒灌');
  assert.equal(pick(dir).codeagentModelProvider, 'good');
});

test('按账号隔离；显式设置优先；跟随记录时不会偷换分身指定的其他模型', t => {
  const dir = temp(t);
  route.rememberSuccess(dir, manual(), answer());
  route.rememberSuccess(dir, manual('pool-good', 'pool1'), answer());
  assert.equal(pick(dir, 'pool1', ID, { options: [{ id: ID, provider: 'bad' }, { id: ID, provider: 'pool-good' }] }).codeagentModelProvider, 'pool-good');
  assert.equal(route.choose(dir, 'missing'), null);
  route.setPreference(dir, 'personal', { model: ID, provider: 'chosen' });
  assert.equal(route.choose(dir).codeagentModelProvider, 'chosen');
  assert.equal(pick(dir, 'personal', 'another', { explicitModel: 'another' }), null);
  route.setPreference(dir);
  assert.equal(pick(dir).codeagentModelProvider, 'good');
  assert.throws(() => route.setPreference(dir, 'personal', { model: ID }), /供应商/);
});

test('未带供应商的手动成功记录可从唯一清单或 CLI 当前配置恢复；模型不一致不猜', t => {
  const dir = temp(t), s = { kind: 'codeagent', currentModel: { id: ID } };
  assert.equal(route.rememberSuccess(dir, s, answer(), { options: [{ id: ID, provider: 'good' }] }), true);
  assert.equal(route.lastSuccessful(dir).codeagentModelProvider, 'good');
  assert.equal(route.rememberSuccess(dir, s, answer(2000), { options: [{ id: ID, provider: 'a' }, { id: ID, provider: 'b' }] }), false);
  assert.equal(route.rememberSuccess(dir, s, answer(2000), { settings: { model: ID, provider: 'cli' } }), true);
  assert.equal(route.rememberSuccess(dir, manual('bad'), { ...answer(3000), model: 'unrelated' }), false);
});

test('同名多供应商不选第一行；明确供应商和菜单唯一默认组都能选择', () => {
  const rows = [{ label: ID, group: 'bad', text: ID }, { label: ID, group: 'good', text: ID }];
  assert.equal(picker.findTarget({ rows }, ID), -1);
  assert.equal(picker.findTarget({ rows }, ID, { provider: 'good' }), 1);
  assert.equal(picker.findTarget({ rows }, 'deepseek'), -1, '前缀也不能绕过分组消歧');
  rows[1].text += ' default ✓';
  assert.equal(picker.findTarget({ rows }, ID), 1);
});

test('自动菜单保护会恢复模型和供应商，其他新写入的配置保留', async t => {
  const dir = temp(t), file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: ID, provider: 'good', enterprise: { activeProvider: 'good' } }));
  const snapshot = picker.snapshotDefaults(dir);
  fs.writeFileSync(file, JSON.stringify({ model: ID, provider: 'bad', enterprise: { activeProvider: 'bad', keep: 1 }, keep: true }));
  const guarded = await picker.guardDefaults(snapshot, { durationMs: 0 });
  assert.equal(guarded.verified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: ID, provider: 'good', enterprise: { activeProvider: 'good', keep: 1 }, keep: true });
});

test('配置补入的自配模型保留每个同名供应商，助理设置可独立选', t => {
  const dir = temp(t), configDir = path.join(dir, 'config'); fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enterprise: { providers: { bad: { mainModel: ID }, good: { mainModel: ID } } } }));
  const models = require('../core/codeagent-models');
  models.recordMenu(dir, [ID], { complete: true });
  const rows = models.modelOptions(dir, { configDir }).filter(o => o.provider);
  assert.deepEqual(rows.map(o => o.provider), ['bad', 'good']);
});

test('自动启动真实选型分支：默认模型不被手动记录覆盖，同名多供应商才注入且仍检查熔断', t => {
  const dir = temp(t); route.rememberSuccess(dir, manual(), answer()); seedAmbiguity(dir);
  const source = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  const begin = source.indexOf('    if (isCodeAgent && codeAgentReadOnly(opts) && !opts.fixedModel) {');
  const end = source.indexOf('    // 手动新建的会话（启动中心）也核一次', begin);
  const vm = require('node:vm');
  const run = (purpose, target = 'hub-default', open = null) => {
    let skipCalls = 0, openCalls = 0;
    const ctx = { opts: { purpose }, isCodeAgent: true, codeAgentReadOnly: () => true, codeagentPool: null, hubDefaultTarget: target,
      codeAgentRouteModel: () => '', getHubDataDir: () => dir, codeAgentExpectedModel: () => 'legacy', codeagentConfig: {}, id: 's', freshLaunch: true, console,
      require: name => name === './codeagent-pool' ? {} : name === './codeagent-auto-pick' ? { skipReason: () => { skipCalls++; return null; }, openFor: () => { openCalls++; return open; } }
        : name === './codeagent-assistant-route' ? route : name === './codeagent-model-choice' ? require('../core/codeagent-model-choice')
        : name === './feature-agent-choice' ? require('../core/feature-agent-choice') : {} };
    vm.runInNewContext(source.slice(begin, end), ctx);
    return { opts: ctx.opts, skipCalls, openCalls };
  };
  for (const purpose of ['company-assistant', 'avatar-agent']) {
    const normal = run(purpose);
    assert.equal(normal.opts.model, 'hub-default'); assert.equal(normal.opts.codeagentModelProvider, undefined); assert.equal(normal.skipCalls, 1);
    const r = run(purpose, ID);
    assert.equal(r.opts.model, ID); assert.equal(r.opts.codeagentModelProvider, 'good'); assert.equal(r.skipCalls, 0); assert.equal(r.openCalls, 1);
    assert.throws(() => run(purpose, ID, { until: Date.now() + 3600000 }), err => err.code === 'CODEAGENT_MODEL_PICK_BREAKER_OPEN' && err.notSent);
  }
  const ordinary = run('forum'); assert.equal(ordinary.opts.model, 'hub-default'); assert.equal(ordinary.skipCalls, 1);
  route.setPreference(dir, 'personal', { model: ID, provider: 'good' });
  assert.equal(run('company-assistant').opts.model, ID, '显式设置允许覆盖默认模型');
});

test('单供应商、多供应商但目标不同、未知清单均保持默认；显式设置可主动覆盖', t => {
  const dir = temp(t); route.rememberSuccess(dir, manual(), answer());
  assert.equal(pick(dir, 'personal', ID, { options: [{ id: ID, provider: 'good' }] }), null);
  assert.equal(pick(dir, 'personal', 'hub-default'), null);
  assert.equal(pick(dir, 'personal', ID, { options: [] }), null);
  assert.equal(route.choose(dir), null);
  route.setPreference(dir, 'personal', { model: ID, provider: 'good' });
  assert.equal(route.choose(dir, 'personal', 'hub-default').model, ID);
});

test('405/404/501 提示带供应商与脱敏地址，401/429 仍走原提示', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ provider: 'bad', enterprise: { providers: { bad: { apiBaseUrl: 'https://user:secret@example.test/v1?key=private#secret' } } } }));
  for (const status of [404, 405, 501]) {
    const d = describe(`API Error: ${status} Method Not Allowed`, { ...manual('bad'), codeagentConfigDir: dir });
    assert.match(d.kind, /bad.*https:\/\/example.test\/v1.*不接受对话请求/);
    assert.doesNotMatch(d.kind, /user|secret|private/);
    assert.equal(d.routeRejected, true);
  }
  assert.match(describe('401 unauthorized').kind, /鉴权/);
  assert.match(describe('429 rate limit').kind, /限流/);
  assert.match(describe('405 Method Not Allowed', { codeagentConfigDir: dir }).kind, /bad.*example.test\/v1/);
});

test('一键恢复沿用成功供应商并淘汰闲置预热，不中断在途回答', t => {
  const dir = temp(t);
  route.rememberSuccess(dir, manual(), answer());
  route.setPreference(dir, 'personal', { model: ID, provider: 'bad' });
  const retired = [], a = { deps: { dataDir: dir }, warm: { desk: 'idle', phone: 'busy' },
    modelSettings: () => ({ manual: route.lastSuccessful(dir), options: [] }), sessionBusy: id => id === 'busy', retire: id => retired.push(id), changed() {} };
  CompanyAssistant.prototype.setModelChoice.call(a, { useManual: true });
  assert.equal(route.choose(dir).codeagentModelProvider, 'good');
  assert.deepEqual(retired, ['idle']); assert.equal(a.warm.phone, 'busy');
});

test('手动成功线路更新后，助理预热会话只在仍匹配时复用', t => {
  const dir = temp(t); route.rememberSuccess(dir, manual(), answer()); seedAmbiguity(dir);
  const meta = { ...manual('bad'), fixedModel: ID };
  const a = { deps: { dataDir: dir, getSession: () => meta } };
  assert.equal(CompanyAssistant.prototype.staleModel.call(a, 'warm'), true);
  meta.codeagentModelProvider = 'good'; meta.modelPinSource = 'user';
  assert.equal(CompanyAssistant.prototype.staleModel.call(a, 'warm'), false);
});

test('Auto 模型的 currentModel 与 fixedModel 写法不同时，助理和分身不反复退役', async t => {
  const dir = temp(t), model = 'GLM-5.2-WX-Auto'; seedAmbiguity(dir, model);
  route.rememberSuccess(dir, { ...manual(), currentModel: { id: model } }, { ...answer(), model: 'GLM-5.2-WX' });
  const meta = { ...manual(), currentModel: { id: model }, fixedModel: 'GLM-5.2-WX', modelPinSource: 'created', status: 'idle' };
  const a = { deps: { dataDir: dir, getSession: () => meta } };
  assert.equal(CompanyAssistant.prototype.staleModel.call(a, 'warm'), false);
  let closes = 0;
  const sessions = new AgentSessions({ dataDir: dir, getSession: () => meta, closeSession: async () => { closes++; }, createSession: async () => { throw new Error('不应新建'); } });
  const current = { id: 'warm', questions: 1 };
  assert.equal(await sessions.ensure({ id: 'av', backend: {} }, current, dir), current);
  assert.equal(closes, 0);
  meta.codeagentModelProvider = 'bad';
  assert.equal(CompanyAssistant.prototype.staleModel.call(a, 'warm'), true, '真实供应商变化仍会淘汰旧预热');
});

test('助理设置能显示唯一内置供应商并保存选择，不改变公共模型清单的默认样式', t => {
  const dir = temp(t), configDir = path.join(dir, 'personal'); fs.mkdirSync(configDir);
  t.mock.method(require('../core/codeagent-config'), 'resolveCodeAgentConfig', () => ({ configDir }));
  require('../core/codeagent-model-probe').writeProbed(require('../core/codeagent-pool').personalModelsFile(dir),
    { source: 'serve', models: [ID], details: [{ id: ID, provider: 'w3' }] });
  const a = { deps: { dataDir: dir }, warm: {}, changed() {} };
  a.modelSettings = account => CompanyAssistant.prototype.modelSettings.call(a, account);
  const info = a.modelSettings();
  assert.equal(info.options[0].provider, 'w3');
  assert.equal(require('../core/codeagent-models').modelOptions(dir, { configDir })[0].provider, undefined);
  CompanyAssistant.prototype.setModelChoice.call(a, { value: require('../core/codeagent-model-choice').choiceValue(info.options[0]) });
  assert.equal(route.preference(dir).codeagentModelProvider, 'w3');
});

test('常驻分身在成功线路改变后重开，沿用时继续复用', async t => {
  const dir = temp(t); route.rememberSuccess(dir, manual(), answer()); seedAmbiguity(dir);
  const closed = [], av = { id: 'av', name: '分身', backend: {} }, old = { id: 'old', questions: 1 };
  const meta = { ...manual('bad'), fixedModel: ID, status: 'idle' };
  const sessions = new AgentSessions({ dataDir: dir, getSession: id => id === 'old' && !closed.length ? meta : null,
    closeSession: async id => closed.push(id), createSession: async (_kind, opts) => ({ id: opts.id }) });
  const fresh = await sessions.ensure(av, old, dir);
  assert.notEqual(fresh.id, old.id); assert.deepEqual(closed, ['old']);
});

test('分身收到 405 稳定报错时提示供应商并提供修复动作，不再空等五分钟', async t => {
  const dir = temp(t), file = path.join(dir, 'turn.jsonl');
  let clock = 0;
  const s = { ...manual('bad'), transcriptPath: file };
  const sessions = new AgentSessions({ now: () => clock += 4000, pollMs: 1, getSession: () => s,
    sendPrompt: async () => { fs.writeFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'e1', isApiErrorMessage: true,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 405 Method Not Allowed' }] } }) + '\n'); return { ok: true }; }, lastFinal: () => null });
  await assert.rejects(sessions.ask({ id: 's' }, 'task.md'), err => {
    assert.match(err.message, /bad.*不接受对话请求/); assert.deepEqual(err.providerRepair, { account: 'personal', canUseManual: false }); return true;
  });
});
