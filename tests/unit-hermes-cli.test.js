'use strict';
// Hermes 后端（2026-11-28）：登记、权限档、启动参数（每会话 HERMES_HOME + config.yaml、钥匙只在环境变量、清掉别家钥匙）、
// 线路缺失提示、组件目录认 hermes、卡片会话按启动档设 Hermes 的会话模式（session/set_mode）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = require('../core/hermes-cli-profile');
const aiKinds = require('../core/ai-kinds');
const permissionModes = require('../core/permission-modes');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hermes-')); }
function fakePython(dir) { const bin = path.join(dir, 'python.exe'); fs.writeFileSync(bin, ''); fs.mkdirSync(path.join(dir, 'Lib', 'site-packages', 'acp_adapter'), { recursive: true }); return bin; }

test('Hermes 登记为 Hub 的 AI 种类、卡片 ACP 后端和组件', () => {
  assert.ok(aiKinds.ALL_AI_KINDS.includes('hermes'));
  assert.equal(aiKinds.getAgentLabel('hermes-resume'), 'Hermes');
  assert.equal(aiKinds.canonicalAiKind('hermes-resume'), 'hermes');
  const acp = require('../core/acp-profiles');
  assert.ok(acp.isAcpKind('hermes'));
  assert.ok(!acp.PROVIDER_CLI_KINDS.includes('hermes'), '不走终端 provider CLI');
  assert.ok(!acp.ACP_KINDS.includes('hermes'), '不进套餐 ACP 设置页');
  assert.ok(require('../community-edition.json').kinds.includes('hermes'));
  assert.ok(require('../core/cli-tools/catalog').IDS.includes('hermes'));
  assert.ok(require('../package.json').build.asarUnpack.includes('core/hermes-acp-launch.py'));
  assert.equal(require('../core/model-options').canSwitchInSession('hermes'), false, '会话里不换模型');
});

test('权限档映射到 Hermes 的会话模式', () => {
  assert.deepEqual(permissionModes.modesFor('hermes'), ['bypassPermissions', 'acceptEdits', 'default']);
  assert.equal(permissionModes.launchDefault('hermes'), 'default');
  assert.deepEqual(profile.permissionFor('bypassPermissions'), { mode: 'bypassPermissions', sessionModeId: 'dont_ask', policy: 'bypass' });
  assert.deepEqual(profile.permissionFor('acceptEdits'), { mode: 'acceptEdits', sessionModeId: 'accept_edits', policy: 'ask' });
  assert.deepEqual(profile.permissionFor('default'), { mode: 'default', sessionModeId: 'default', policy: 'ask' });
  assert.equal(profile.permissionFor('plan').mode, 'bypassPermissions', '不支持的档按主进程缺省（完全放开）');
  assert.equal(profile.permissionFor(undefined).sessionModeId, 'dont_ask');
});

test('启动参数：每会话一个 HERMES_HOME，config.yaml 只写钥匙变量名，别家钥匙和 Hub 令牌不带给 Hermes', () => {
  const dir = tmp();
  const env = { AI_HUB_HERMES_PYTHON: fakePython(dir), PATH: '', DEEPSEEK_API_KEY: 'sk-secret-123', OPENAI_API_KEY: 'sk-other', OPENAI_BASE_URL: 'https://x',
    claude_hub_token: 'tok', CLAUDE_HUB_TEAM_TOKEN: 'team', HUB_BRIDGE_SESSION_PASS: 'p', HUB_FEISHU_APP_SECRET: 's', MOBILE_FIXED_PIN: '1', CLAUDECODE: '1', PYTHONPATH: 'C:/evil', HERMES_HOME: 'C:/old', GITHUB_TOKEN: 'keep-gh', HTTP_PROXY: 'http://proxy:8080' };
  const options = profile.buildHermesOptions('hermes', { id: 'hub-1', cwd: dir, permissionMode: 'acceptEdits' }, {}, dir, env);
  assert.equal(options.kind, 'hermes');
  assert.equal(options.hubModel, 'hub-deepseek/deepseek-flash');
  assert.equal(options.model, 'custom:deepseek-flash', 'Hermes 报的当前模型编号');
  assert.equal(options.profileId, 'hermes:deepseek');
  assert.equal(options.sessionModeId, 'accept_edits');
  assert.equal(options.permissionPolicy, 'ask');
  assert.equal(options.launch.command, env.AI_HUB_HERMES_PYTHON);
  assert.deepEqual(options.launch.args.slice(0, 3), ['-I', '-X', 'utf8']);
  assert.match(options.launch.args[3], /hermes-acp-launch\.py$/);
  assert.ok(fs.existsSync(options.launch.args[3].replace(/app\.asar\.unpacked/, 'app.asar')), '启动入口文件存在');
  const e = options.launch.env;
  assert.equal(e.HERMES_HOME, options.home);
  assert.equal(e[profile.KEY_ENV], 'sk-secret-123');
  assert.equal(e.DEEPSEEK_API_KEY, undefined);
  assert.equal(e.OPENAI_API_KEY, undefined);
  assert.equal(e.OPENAI_BASE_URL, undefined);
  assert.equal(e.claude_hub_token, undefined);
  for (const n of ['CLAUDE_HUB_TEAM_TOKEN', 'HUB_BRIDGE_SESSION_PASS', 'HUB_FEISHU_APP_SECRET', 'MOBILE_FIXED_PIN']) assert.equal(e[n], undefined, n + ' 不带给 Hermes');
  assert.match(profile.KEY_ENV, /^AUXILIARY_.+_API_KEY$/, 'Hermes 认作内部密钥，终端快照和子进程里会剥掉');
  assert.equal(e.CLAUDECODE, undefined);
  assert.equal(e.PYTHONPATH, undefined);
  assert.equal(e.GITHUB_TOKEN, 'keep-gh', 'git 自己的令牌保留');
  assert.equal(e.HERMES_YOLO_MODE, undefined);
  assert.deepEqual(options.launch.secrets, ['sk-secret-123']);
  const config = JSON.parse(fs.readFileSync(path.join(options.home, 'config.yaml'), 'utf8'));
  assert.deepEqual(config.model, { default: 'deepseek-flash', provider: 'custom', base_url: 'https://api.deepseek.com/v1', api_key: '${' + profile.KEY_ENV + '}', context_length: 128000 });
  assert.ok(!fs.readFileSync(path.join(options.home, 'config.yaml'), 'utf8').includes('sk-secret'), '钥匙不落盘');
  // 同一个 Hub 会话恢复时用同一个目录（Hermes 的 state.db 在里面）；不同会话互不影响。
  const again = profile.buildHermesOptions('hermes-resume', { id: 'hub-1', cwd: dir, acpSid: '071f8669-e1a3-4471-9149-e539d4df13cb' }, {}, dir, env);
  assert.equal(again.home, options.home);
  assert.equal(again.resumeId, '071f8669-e1a3-4471-9149-e539d4df13cb');
  assert.notEqual(profile.buildHermesOptions('hermes', { id: 'hub-2', cwd: dir }, {}, dir, env).home, options.home);
});

test('完全放开：自动批准并打开 Hermes 的 YOLO；没有 Hub 线路时用 Hermes 自己的配置', () => {
  const dir = tmp();
  const env = { AI_HUB_HERMES_PYTHON: fakePython(dir), PATH: '', DEEPSEEK_API_KEY: 'sk-1', OPENAI_API_KEY: 'sk-user' };
  const bypass = profile.buildHermesOptions('hermes', { id: 'a', cwd: dir, autonomous: true }, {}, dir, env);
  assert.equal(bypass.permissionPolicy, 'bypass');
  assert.equal(bypass.sessionModeId, 'dont_ask');
  assert.equal(bypass.launch.env.HERMES_YOLO_MODE, '1');
  const native = profile.buildHermesOptions('hermes', { id: 'b', cwd: dir }, {}, dir, { AI_HUB_HERMES_PYTHON: env.AI_HUB_HERMES_PYTHON, PATH: '', OPENAI_API_KEY: 'sk-user' });
  assert.equal(native.profileId, 'hermes:native');
  assert.equal(native.home, null);
  assert.equal(native.model, undefined);
  assert.equal(native.launch.env.HERMES_HOME, undefined);
  assert.equal(native.launch.env.OPENAI_API_KEY, 'sk-user', '用 Hermes 自己配置时保留用户的钥匙');
  assert.deepEqual(profile.hermesModelOptions({}, { PATH: '' }).map(m => m.source), ['hermes-native']);
});

test('存的线路这次不可用：说清缺什么，不悄悄换线路；编号损坏不冒充恢复；没装给安装提示', () => {
  const dir = tmp();
  const env = { AI_HUB_HERMES_PYTHON: fakePython(dir), PATH: '' };
  assert.throws(() => profile.buildHermesOptions('hermes', { id: 'x', cwd: dir, model: 'hub-deepseek/deepseek-flash' }, {}, dir, env),
    e => e.code === 'HERMES_ROUTE_MISSING' && /Hermes 会话/.test(e.message) && /DeepSeek API Key/.test(e.message));
  assert.throws(() => profile.buildHermesOptions('hermes', { id: 'x', cwd: dir, acpSid: '../../etc' }, {}, dir, { ...env, DEEPSEEK_API_KEY: 'k' }), /记录编号已损坏/);
  assert.throws(() => profile.buildHermesOptions('hermes', { id: 'x', cwd: dir }, {}, dir, { PATH: '', AI_HUB_HERMES_PYTHON: path.join(dir, 'none.exe') }), /一键安装 Hermes/);
  assert.equal(profile.diagnoseHermes({ PATH: '', LOCALAPPDATA: dir, AI_HUB_CLI_TOOLS_DIR: dir }).state, 'none');
});

test('识别官方安装脚本装的 Hermes（虚拟环境里有 acp_adapter 才算）', () => {
  const dir = tmp();
  const scripts = path.join(dir, 'hermes', 'hermes-agent', 'venv', 'Scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'python.exe'), '');
  const env = { PATH: '', LOCALAPPDATA: dir, AI_HUB_CLI_TOOLS_DIR: path.join(dir, 'tools') };
  assert.equal(profile.diagnoseHermes(env).state, 'none', '没装 ACP 扩展不算');
  fs.mkdirSync(path.join(dir, 'hermes', 'hermes-agent', 'venv', 'Lib', 'site-packages', 'acp_adapter'), { recursive: true });
  const d = profile.diagnoseHermes(env);
  assert.equal(d.state, 'ready');
  assert.equal(d.source, 'user');
});

test('卡片会话：按启动档向 Hermes 设会话模式，恢复时也设；模型编号已是当前值不重复设置', async () => {
  const { AcpSession } = require('../core/acp-session');
  const dir = tmp();
  const calls = [];
  const { EventEmitter } = require('node:events');
  const client = new EventEmitter();
  Object.assign(client, {
    async start() { return { protocolVersion: 1, agentCapabilities: { loadSession: true } }; },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'session/new' || method === 'session/load') return { sessionId: params.sessionId || 'sid-1', configOptions: [],
        models: { currentModelId: 'custom:m1', availableModels: [{ modelId: 'custom:m1', name: 'm1' }] },
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept_edits' }, { id: 'dont_ask' }] } };
      if (method === 'session/set_mode') return {};
      throw new Error('unexpected ' + method);
    },
    respond() {}, close() {}, kill() {},
  });
  const session = new AcpSession({ id: 'hub-x', kind: 'hermes', cwd: dir, profileId: 'hermes:company', model: 'custom:m1',
    sessionModeId: 'dont_ask', permissionPolicy: 'bypass', storeDir: path.join(dir, 'store'), clientFactory: () => client, launch: {} });
  session.on('error', () => {});
  await session.start();
  assert.deepEqual(calls.map(c => c[0]), ['session/new', 'session/set_mode']);
  assert.deepEqual(calls[1][1], { sessionId: 'sid-1', modeId: 'dont_ask' });
  assert.equal(session.currentModel, 'custom:m1');
  session.kill?.();
});

test('休眠会话：从 Hub 的 ACP 历史库读出卡片；配置域对不上返回 null', () => {
  const { AcpSession, readStoredAcpTranscript } = require('../core/acp-session');
  const dir = tmp();
  const storeDir = path.join(dir, 'acp-history');
  const live = new AcpSession({ id: 'hub-d', kind: 'hermes', cwd: dir, profileId: 'hermes:company', storeDir, launch: {} });
  live.threadId = 'sid-d';
  live.history.set('t1', { id: 't1', status: 'completed', items: [
    { id: 't1:user', type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
    { id: 'a1', type: 'agentMessage', text: '已收到' }] });
  live.persist();
  live._historyStore?.close();
  const cards = readStoredAcpTranscript({ id: 'hub-d', kind: 'hermes', cwd: dir, profileId: 'hermes:company', storeDir }, { limit: 50 });
  assert.ok(cards && cards.some(c => c.role === 'assistant' && /已收到/.test(c.text)), JSON.stringify(cards));
  assert.equal(readStoredAcpTranscript({ id: 'hub-d', kind: 'hermes', cwd: path.join(dir, 'other'), profileId: 'hermes:company', storeDir }), null);
  assert.equal(readStoredAcpTranscript({ id: 'nope', kind: 'hermes', cwd: dir, profileId: 'hermes:company', storeDir }), null);
});
