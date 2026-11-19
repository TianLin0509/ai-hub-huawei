'use strict';

// 2026-11-20 自有模型接不上（群诉求遗漏清单第 1、7 项）：DSH 的「自有接口」真正能启动；自有 API 账号能删能改。
// 只用临时目录和假的 DSH 运行环境，不起进程、不连网。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../core/company-api-config');
const cards = require('../renderer/launch-model-cards');
const OWN = { baseURL: 'http://own.example.test/v1', apiKey: 'sk-own-secret', model: 'GLM-V5_1' };

function fakeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-dsh-rt-'));
  for (const file of ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-harness-tui/dsh-tui/package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '{}');
  }
  return root;
}

test('DSH 自有接口：保存后启动配置是 api，带地址、Key、模型；缺模型时就地说清下一步', { skip: !api.isCompany() }, () => {
  const raw = api.withSettings({}, { kind: 'deepseek-acp', ...OWN });
  assert.deepEqual(raw.acp.companyApi, OWN);
  const config = api.applyCompanyConfig({}, raw);
  assert.equal(config.dshBackend, 'api');
  assert.equal(config.dshApiBaseUrl, OWN.baseURL);
  assert.equal(config.dshApiKey, OWN.apiKey);
  assert.equal(config.dshApiModel, OWN.model);
  api.assertLaunchConfigured('deepseek-acp', config);
  const view = api.settings(raw)['deepseek-acp'];
  assert.equal(view.backend, 'api');
  assert.deepEqual(view.own, { backend: 'api', model: OWN.model });
  assert.equal(view.apiKeySet, true);
  assert.doesNotMatch(JSON.stringify(view), /sk-own-secret/, '界面视图不带 Key');

  const noModel = api.applyCompanyConfig({}, api.withSettings({}, { kind: 'deepseek-acp', baseURL: OWN.baseURL, apiKey: 'k', model: '' }));
  assert.equal(noModel.dshBackend, 'api');
  assert.throws(() => api.assertLaunchConfigured('deepseek-acp', noModel), /还没填模型名.*测试连接/);
  const nothing = api.applyCompanyConfig({}, {});
  assert.equal(nothing.dshBackend, 'local');
  assert.throws(() => api.assertLaunchConfigured('deepseek-acp', nothing), /API 网关.*公司模型.*自有接口/);
  // 清空：回到没配的状态。
  assert.equal(api.applyCompanyConfig({}, api.withSettings(raw, { kind: 'deepseek-acp', useLocal: true })).dshBackend, 'local');
  // 只改模型、Key 留空：沿用已存的 Key。
  const kept = api.withSettings(raw, { kind: 'deepseek-acp', baseURL: OWN.baseURL, apiKey: '', model: 'qwen3.8-27b' });
  assert.equal(kept.acp.companyApi.apiKey, OWN.apiKey);
});

test('DSH 切到公司模型再切回：自有接口留着，启动中心一键回到自有卡', { skip: !api.isCompany() }, () => {
  let raw = api.withSettings({}, { kind: 'deepseek-acp', ...OWN });
  raw = api.withSettings(raw, { kind: 'deepseek-acp', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.equal(raw.acp.companyApi.backend, 'proxy');
  assert.deepEqual(raw.acp.companyApi.own_api, { base_url: OWN.baseURL, api_key: OWN.apiKey, model: OWN.model });
  assert.equal(api.applyCompanyConfig({}, raw).dshBackend, 'proxy');
  const view = api.settings(raw)['deepseek-acp'];
  assert.deepEqual(view.own, { backend: 'api', model: OWN.model });
  const provider = { ...view };
  const list = cards.cardsFor('deepseek-acp', provider, null, cards.defaultPick('deepseek-acp', provider));
  assert.ok(list.some(c => c.source === 'own' && c.name === OWN.model), '启动中心有 DSH 自有接口卡');
  assert.deepEqual(cards.saveRequest('deepseek-acp', provider, { source: 'own' }), { kind: 'deepseek-acp', backend: 'own' });
  const back = api.withSettings(raw, { kind: 'deepseek-acp', backend: 'own' });
  assert.deepEqual(back.acp.companyApi, OWN);
  assert.equal(api.applyCompanyConfig({}, back).dshBackend, 'api');
  assert.throws(() => api.withSettings({}, { kind: 'deepseek-acp', backend: 'own' }), /还没有保存过自有接口/);
});

test('启动中心：DSH 存的是自有接口时默认选自有卡，新建会话不再悄悄改成公司模型', () => {
  const provider = { backend: 'api', model: OWN.model, own: { backend: 'api', model: OWN.model }, companyModels: [{ id: 'GLM-5.2-WX' }] };
  const pick = cards.defaultPick('deepseek-acp', provider);
  assert.deepEqual(pick, { source: 'own', model: OWN.model });
  assert.equal(cards.saveRequest('deepseek-acp', provider, pick), null);
  const list = cards.cardsFor('deepseek-acp', provider, null, pick);
  assert.equal(list.find(c => c.checked)?.source, 'own');
  // 没填过自有接口的 DSH：不出现自有卡（公司版 DSH 没有本机配置可沿用），老行为不变。
  const plain = { backend: 'proxy', model: 'GLM-5.2-WX', own: { backend: 'local', model: '' }, companyModels: [{ id: 'GLM-5.2-WX' }] };
  assert.equal(cards.cardsFor('deepseek-acp', plain, null, cards.defaultPick('deepseek-acp', plain)).some(c => c.source === 'own'), false);
  assert.equal(cards.defaultPick('deepseek-acp', plain).source, 'company');
});

test('DSH 自有接口的启动文件：直连用户地址、Key 只在环境变量、模型名可带斜杠', { skip: !api.isCompany() }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-dsh-data-'));
  const runtime = fakeRuntime();
  const config = api.applyCompanyConfig({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { cliRoot: runtime } } } },
    { acp: { companyApi: { ...OWN, model: 'Qwen/Qwen3-32B' } } });
  const options = require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp', { id: 'own-1', cwd: dataDir }, config, dataDir,
    { PATH: process.env.PATH, OPENAI_API_KEY: 'should-go' });
  const env = options.launch.env;
  const proxy = require('../core/company-model-proxy');
  assert.equal(env.AI_HUB_DSH_OWN_KEY, OWN.apiKey);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env[proxy.KEY_ENV], undefined, '不经本机反代');
  const model = JSON.parse(fs.readFileSync(path.join(options.home, '.dsh-tui/model.json'), 'utf8'));
  assert.deepEqual(model, { provider: 'hub-own-api', model: 'Qwen/Qwen3-32B' });
  const settings = fs.readFileSync(path.join(options.home, '.dsh/settings.yaml'), 'utf8');
  assert.match(settings, /own\.example\.test\/v1/);
  assert.doesNotMatch(settings, /sk-own-secret/, 'Key 不写进配置文件');
  assert.ok(options.launch.secrets.includes(OWN.apiKey), 'Key 登记为机密，日志里打码');
  assert.ok(String(options.profileId).startsWith('own-api:'));
});

test('自有 API 账号：可编辑、可删除；删掉正在用的改选剩下的，删光回到本机配置；走公司模型时只改列表', () => {
  const profiles = require('../core/cli-api-profiles');
  let raw = profiles.withProfile({}, { kind: 'claude', profileAction: 'save', label: '部门 A', baseURL: 'http://a.test/v1', apiKey: 'ka', model: 'glm-a' });
  const a = raw.providers.claude.selected_api_profile;
  raw = profiles.withProfile(raw, { kind: 'claude', profileAction: 'save', label: '部门 B', baseURL: 'http://b.test/v1', apiKey: 'kb', model: 'glm-b' });
  const b = raw.providers.claude.selected_api_profile;
  // 编辑 B：改模型名，Key 留空保留原 Key。
  raw = profiles.withProfile(raw, { kind: 'claude', profileAction: 'save', profileId: b, label: '部门 B', baseURL: 'http://b.test/v1', apiKey: '', model: 'glm-b2' });
  assert.equal(raw.providers.claude.api_profiles.find(p => p.id === b).model, 'glm-b2');
  assert.equal(raw.providers.claude.api_profiles.find(p => p.id === b).apiKey, 'kb');
  assert.equal(raw.providers.claude.model, 'glm-b2');
  // 删 B（正在用）：改选 A。
  raw = profiles.withProfile(raw, { kind: 'claude', profileAction: 'delete', profileId: b });
  assert.deepEqual(raw.providers.claude.api_profiles.map(p => p.id), [a]);
  assert.equal(raw.providers.claude.selected_api_profile, a);
  assert.equal(raw.providers.claude.base_url, 'http://a.test/v1');
  // 删 A（最后一个）：回到本机配置。
  raw = profiles.withProfile(raw, { kind: 'claude', profileAction: 'delete', profileId: a });
  assert.deepEqual(raw.providers.claude.api_profiles, []);
  assert.equal(raw.providers.claude.selected_api_profile, '');
  assert.equal(raw.providers.claude.base_url, '');
  assert.throws(() => profiles.withProfile(raw, { kind: 'claude', profileAction: 'delete', profileId: a }), /不存在/);
  // 走公司模型时删账号：线路不动。
  let proxyRaw = profiles.withProfile({}, { kind: 'codex', profileAction: 'save', label: 'X', baseURL: 'http://x.test/v1', apiKey: 'kx', model: 'mx' });
  const x = proxyRaw.providers.codex.selected_api_profile;
  proxyRaw = { ...proxyRaw, providers: { ...proxyRaw.providers, codex: { ...proxyRaw.providers.codex, backend: 'proxy', model: 'GLM-5.2-WX' } } };
  proxyRaw = profiles.withProfile(proxyRaw, { kind: 'codex', profileAction: 'delete', profileId: x });
  assert.equal(proxyRaw.providers.codex.backend, 'proxy');
  assert.equal(proxyRaw.providers.codex.model, 'GLM-5.2-WX');
  assert.deepEqual(proxyRaw.providers.codex.api_profiles, []);
});

test('删账号时一并换掉「切回用的自有接口」：删了的账号不能再从公司模型切回去用（Codex 审查 P2）', () => {
  const profiles = require('../core/cli-api-profiles');
  let raw = profiles.withProfile({}, { kind: 'claude', profileAction: 'save', label: 'A', baseURL: 'http://a.test/v1', apiKey: 'ka', model: 'ma' });
  const a = raw.providers.claude.selected_api_profile;
  // 切到公司模型：当前接口（A）留在 own_api。
  raw = api.withSettings(raw, { kind: 'claude', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.equal(raw.providers.claude.own_api.api_key, 'ka');
  raw = profiles.withProfile(raw, { kind: 'claude', profileAction: 'delete', profileId: a });
  assert.equal(raw.providers.claude.backend, 'proxy', '线路不动');
  assert.equal(raw.providers.claude.own_api, undefined, '被删账号的接口和 Key 不再留着');
  assert.doesNotMatch(JSON.stringify(raw), /"ka"/);
});

test('dsh-tools 0.2.2 起 mode 是 z.never()：不再写 tools.mode=native（否则 DSH 起不来）；老版本照旧写', () => {
  const compat = require('../core/dsh-tools-compat');
  const make = source => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-dsh-tools-'));
    const dir = path.join(root, '@deepseek-ai', 'dsh-tools', 'lib');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '..', 'package.json'), '{"main":"lib/index.js"}');
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return root;
  };
  const newer = make('var ToolsService = class extends Service {\n\tstatic Config = z.object({\n\t\tmode: z.never().description("Removed. Mount a native or PTC tool executor instead."),\n\t\tmaxParallelSubCalls: z.never()\n\t});\n};');
  assert.equal(compat.installedToolsNativeSupport({ modules: newer }), false);
  assert.deepEqual(compat.companyToolsPatch({ modules: newer }), []);
  const older = make('class ToolsService { static Config = z.object({ mode: z.string().default("ptc") }); }');
  assert.deepEqual(compat.companyToolsPatch({ modules: older }), [{ id: 'tools', config: { mode: 'native' } }]);
});

test('DSH 自己报 startup failed 时，会话错误写清哪个插件、什么校验没过，不再只说「启动未确认」', () => {
  const { DshCliSession } = require('../core/dsh-cli-session');
  const errors = [];
  const fake = { output: '\x1b[31mError: dsh: startup failed: 2 required plugins did not activate\x1b[0m\n\n  Failed plugins (1):\n    tools\n      Package: @deepseek-ai/dsh-tools\n      ValidationError: invalid config:\n        - $.mode expected nullable but got native (at mode)\n          at resolveConfig (file:///x)\n',
    sideAsks: new Map(), apply: state => errors.push(state.reason), emit() {}, readyReject: null, startTimer: null, pending: null };
  DshCliSession.prototype.fail.call(fake, new Error('DSH CLI 已退出'));
  assert.match(errors[0], /DSH 启动失败——插件 tools（@deepseek-ai\/dsh-tools）：ValidationError: invalid config: - \$\.mode expected nullable but got native/);
  assert.match(errors[0], /升级 Hub/);
});

test('DSH 建智能体失败（新版标准预设要 pluginManager）：会话错误带上原因；公司/自有线路不再关掉 plugin-manager 服务', () => {
  const { DshCliSession } = require('../core/dsh-cli-session');
  const errors = [];
  const fake = { output: '\x1b[>4m\x1b[<u dsh-tui startup failed: dsh-tui: failed to create agent (provider=company-proxy, model=deepseek-v4.1-flash): tool-plugin-manager (@deepseek-ai/dsh-plugin-manager/tools): waiting for pluginManager\r\n',
    sideAsks: new Map(), apply: state => errors.push(state.reason), emit() {}, readyReject: null, startTimer: null, pending: null };
  DshCliSession.prototype.fail.call(fake, new Error('DSH CLI 已退出'));
  assert.match(errors[0], /DSH 启动失败——dsh-tui: failed to create agent: tool-plugin-manager .*waiting for pluginManager/);
  assert.doesNotMatch(errors[0], /provider=/);
  const route = require('../core/company-model-proxy').dshOwnRoute({ baseURL: 'http://x.test/v1', apiKey: 'k', model: 'm' });
  const disabled = route.disabledPatches.map(p => p.id);
  assert.ok(!disabled.includes('plugin-manager'));
  assert.ok(disabled.includes('tool-plugin-manager'));
});
