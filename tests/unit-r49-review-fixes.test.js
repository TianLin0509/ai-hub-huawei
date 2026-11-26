'use strict';
// R49 审查（Antigravity job 20261126-232547-0d450f）3 个 P1 的回归：撤掉对应修复，这里的用例会失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cards = require('../renderer/launch-model-cards');

const COMPANY = [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }];
const GATEWAY = [{ id: 'qwen-aw-35b', note: '' }, { id: 'deepseek-v4.1-flash', note: '' }];

test('P1-1：自有接口 / 沿用本机配置 / API 账号会话，会话内切换的准备与确认两步同一口径；全局线路在网关时也读得到自有接口的模型表', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-switch-'));
  const previous = { data: process.env.CLAUDE_HUB_DATA_DIR, startup: process.env.CLAUDE_HUB_CODEAGENT_STARTUP_PROBE };
  process.env.CLAUDE_HUB_DATA_DIR = root; process.env.CLAUDE_HUB_CODEAGENT_STARTUP_PROBE = '0';
  t.after(() => {
    if (previous.data === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous.data;
    if (previous.startup === undefined) delete process.env.CLAUDE_HUB_CODEAGENT_STARTUP_PROBE; else process.env.CLAUDE_HUB_CODEAGENT_STARTUP_PROBE = previous.startup;
    fs.rmSync(root, { recursive: true, force: true });
  });
  require('../core/hub-config').clearConfigCache?.();
  // 全局线路此刻是 API 网关，自有接口（两个模型）留在 own_api 里。
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ providers: { claude: { backend: 'proxy', upstream: 'gateway', model: 'qwen-aw-35b',
    own_api: { base_url: 'http://own.example/v1', api_key: '', model: 'ma-1', model_list: ['ma-1', 'ma-2'] } } } }));
  const ownHome = path.join(root, 'own-home'), localHome = path.join(root, 'local-home');
  for (const dir of [ownHome, localHome]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(ownHome, 'settings.json'), JSON.stringify({ model: 'ma-1', keep: true }));
  fs.writeFileSync(path.join(localHome, 'settings.json'), JSON.stringify({ model: 'local-a', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'local-b' } }));
  const sessions = new Map([
    ['own', { id: 'own', kind: 'claude', companyRoute: 'api', claudeConfigDir: ownHome }],
    ['local', { id: 'local', kind: 'claude', companyRoute: 'local', claudeConfigDir: localHome }],
  ]);
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getSession: id => sessions.get(id), getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}),
      updateSessionMeta: (id, fields) => Object.assign(sessions.get(id), fields) }, sendToRenderer() {},
  });
  const prepare = handlers.get('prepare-session-model-switch'), confirm = handlers.get('confirm-session-model-switch');
  // 自有接口会话：两步都认 ma-2（以前 confirm 按 Claude 官方名校验，切换后报「不属于当前 CLI 的会话模型目录」）
  assert.equal((await prepare(null, { sessionId: 'own', modelId: 'ma-2' })).ok, true, 'prepare ma-2');
  const own = await confirm(null, { sessionId: 'own', modelId: 'ma-2' });
  assert.equal(own.ok, true, own.message);
  assert.equal(sessions.get('own').currentModel.id, 'ma-2');
  assert.equal((await prepare(null, { sessionId: 'own', modelId: 'claude-opus-5' })).ok, false, '不在自有接口模型表里的照样拒');
  assert.equal((await confirm(null, { sessionId: 'own', modelId: 'claude-opus-5' })).ok, false);
  // 沿用本机 CLI 配置的会话：prepare 也认本机目录里的模型（以前只有 confirm 认）
  assert.equal((await prepare(null, { sessionId: 'local', modelId: 'local-b' })).ok, true, 'prepare local-b');
  assert.equal((await confirm(null, { sessionId: 'local', modelId: 'local-b' })).ok, true);
  assert.equal((await prepare(null, { sessionId: 'local', modelId: 'not-configured' })).ok, false);
});

test('P1-2：「设为默认」存下的模型在当前卡里时，打开启动中心默认选它；不在就用保存的来源和模型', () => {
  const provider = { backend: 'proxy', upstream: 'gateway', model: 'deepseek-v4.1-flash', companyModels: COMPANY, gatewayModels: GATEWAY,
    own: { backend: 'api', model: 'ma-1', models: ['ma-1', 'ma-2'] }, companyDefault: false };
  assert.deepEqual(cards.defaultPick('claude', provider, { codeagentInstalled: false }), { source: 'gateway', model: 'deepseek-v4.1-flash' }, '没设默认：上次选的');
  assert.deepEqual(cards.defaultPick('claude', provider, { codeagentInstalled: false, preferred: 'qwen-aw-35b' }), { source: 'gateway', model: 'qwen-aw-35b' });
  assert.deepEqual(cards.defaultPick('claude', provider, { codeagentInstalled: false, preferred: 'ma-2' }), { source: 'own', model: 'ma-2' }, '默认模型在自有接口卡里');
  assert.deepEqual(cards.defaultPick('claude', provider, { codeagentInstalled: false, preferred: 'claude-opus-5[1m]' }), { source: 'gateway', model: 'deepseek-v4.1-flash' }, '不在卡里：回到保存的');
  assert.deepEqual(cards.defaultPick('claude', provider, { codeagentInstalled: false, preferred: 'GLM-5.2-WX' }), { source: 'gateway', model: 'deepseek-v4.1-flash' }, '没有 CodeAgent：不默认选公司模型');
});

test('P1-3：没装 CodeAgent 时，自有接口用户和全新用户的模型清单里没有用不了的公司模型', () => {
  const ownUser = { backend: 'api', model: 'ma-1', ownModels: ['ma-1', 'ma-2'], companyModels: COMPANY, own: { backend: 'api', model: 'ma-1', models: ['ma-1', 'ma-2'] }, companyDefault: false };
  const freshUser = { backend: 'local', model: '', companyModels: COMPANY, gatewayModels: GATEWAY, own: { backend: 'local', model: '' }, companyDefault: true };
  assert.deepEqual(cards.modelOptions('claude', ownUser, null, { codeagentInstalled: false }).map(o => o.id), ['ma-1', 'ma-2']);
  assert.deepEqual(cards.modelOptions('claude', freshUser, null, { codeagentInstalled: false }).map(o => o.id), ['qwen-aw-35b', 'deepseek-v4.1-flash', '']);
  // 装了 CodeAgent（或还不知道）：公司模型照旧列出
  assert.ok(cards.modelOptions('claude', ownUser, null, { codeagentInstalled: true }).some(o => o.route === 'company'));
  assert.ok(cards.modelOptions('claude', ownUser, null, {}).some(o => o.route === 'company'));
});
