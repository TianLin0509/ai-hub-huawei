'use strict';
// pi 接入（r39）：线路与启动参数、观察扩展、事件 → 卡片、会话文件回放、打包解包。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pi-'));
function fakeRuntime() {
  const prefix = tmp();
  const pkg = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(path.join(pkg, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'dist', 'bundle', 'cli.js'), '');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.5.2' }));
  return prefix;
}
const baseEnv = extra => ({ PATH: path.dirname(process.execPath), AI_HUB_CLI_TOOLS_DIR: tmp(), CLAUDE_HUB_TOKEN: 'secret-hub-token', ...extra });

test('pi 是独立会话种类：家族、标签齐全，走 provider CLI 管道但不进 ACP 设置页', () => {
  const kinds = require('../core/ai-kinds');
  assert.ok(kinds.ALL_AI_KINDS.includes('pi'));
  assert.equal(kinds.canonicalAiKind('pi-resume'), 'pi');
  assert.ok(kinds.FAMILY_KINDS.includes('pi'));
  assert.ok(kinds.KIND_LABELS.pi && kinds.HARNESS_LABELS.pi);
  const acp = require('../core/acp-profiles');
  assert.equal(acp.isAcpKind('pi'), true);
  assert.equal(acp.isAcpKind('pi-resume'), true);
  assert.ok(!acp.ACP_KINDS.includes('pi'));
  assert.ok(require('../community-edition.json').kinds.includes('pi'));
});

test('模型线路：先用 Hub 已有钥匙（DeepSeek 设置 > 本机环境变量 > Token Plan），都没有时只剩 pi 自己的默认模型', () => {
  const pi = require('../core/pi-cli-profile');
  const none = pi.piModelOptions({}, baseEnv());
  assert.equal(none.length, 1);
  assert.equal(none[0].id, '');
  assert.equal(pi.defaultPiModel({}, baseEnv()), '');
  const fromEnv = pi.availableRoutes({}, baseEnv({ DEEPSEEK_API_KEY: 'sk-env' }));
  assert.deepEqual(fromEnv.map(r => r.id), ['deepseek']);
  assert.equal(fromEnv[0].key, 'sk-env');
  const both = pi.availableRoutes({ deepseekApiKey: 'sk-config', acp: { apiKey: 'plan-key' } }, baseEnv({ DEEPSEEK_API_KEY: 'sk-env' }));
  assert.deepEqual(both.map(r => r.id), ['deepseek', 'tokenplan']);
  assert.equal(both[0].key, 'sk-config');
  assert.equal(pi.defaultPiModel({ acp: { apiKey: 'plan-key' } }, baseEnv()), 'hub-tokenplan/deepseek-v4.1-flash');
  const options = pi.piModelOptions({ acp: { apiKey: 'plan-key' } }, baseEnv());
  assert.ok(options.every(o => o.id.startsWith('hub-tokenplan/')));
});

test('启动参数：-e 加载观察扩展，Hub 线路给 --provider/--model，钥匙只经环境变量，恢复用会话文件；Hub 内部变量不传给 pi', () => {
  const pi = require('../core/pi-cli-profile');
  const prefix = fakeRuntime();
  const sessionFile = path.join(tmp(), 's.jsonl'); fs.writeFileSync(sessionFile, '');
  const env = baseEnv({ NPM_CONFIG_PREFIX: prefix });
  const out = pi.buildPiCliOptions('pi', { id: 'hub-1', cwd: 'D:\\work', model: '', effort: 'low', acpSid: 'abc', piSessionFile: sessionFile },
    { deepseekApiKey: 'sk-config', acp: { apiKey: 'plan-key' } }, tmp(), env);
  const args = out.launch.args;
  assert.equal(args[0], path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'));
  assert.equal(args[1], '-e');
  assert.match(args[2], /pi-cli-observer\.mjs$/);
  assert.deepEqual(args.slice(3), ['--provider', 'deepseek', '--model', 'deepseek-flash', '--thinking', 'low', '--session', sessionFile]);
  assert.equal(out.model, 'deepseek/deepseek-flash');
  assert.equal(out.route, 'deepseek');
  assert.equal(out.launch.env.DEEPSEEK_API_KEY, 'sk-config');
  assert.equal(out.launch.env.AI_HUB_PI_TOKEN_PLAN_KEY, 'plan-key');
  assert.equal(out.launch.env.CLAUDE_HUB_TOKEN, undefined);
  assert.ok(!args.join(' ').includes('sk-config') && !args.join(' ').includes('plan-key'));
  const providers = JSON.parse(out.launch.env.AI_HUB_PI_PROVIDERS);
  assert.equal(providers['hub-tokenplan'].apiKey, '$AI_HUB_PI_TOKEN_PLAN_KEY');
  // 选了套餐模型
  const plan = pi.buildPiCliOptions('pi', { id: 'hub-2', cwd: 'D:\\work', model: 'hub-tokenplan/qwen3.8-max' }, { deepseekApiKey: 'sk', acp: { apiKey: 'k' } }, tmp(), env);
  assert.deepEqual(plan.launch.args.slice(3), ['--provider', 'hub-tokenplan', '--model', 'qwen3.8-max']);
  // 存的线路这次没钥匙：不换线路、不换模型，报清缺什么（详细回归见下面 r39 返工的用例）
  assert.throws(() => pi.buildPiCliOptions('pi', { id: 'hub-3', cwd: 'D:\\work', model: 'hub-tokenplan/qwen3.8-max' }, { deepseekApiKey: 'sk' }, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING');
  // 没有任何钥匙：不指定模型，交给 pi 自己
  const native = pi.buildPiCliOptions('pi', { id: 'hub-4', cwd: 'D:\\work' }, {}, tmp(), env);
  assert.deepEqual(native.launch.args.slice(3), []);
  assert.equal(native.route, 'native');
});

test('没装 pi 或只装了旧包：报错写清下一步（一键安装）', () => {
  const pi = require('../core/pi-cli-profile');
  const env = baseEnv({ NPM_CONFIG_PREFIX: tmp() });
  assert.equal(pi.diagnosePi(env).state, 'none');
  assert.throws(() => pi.buildPiCliOptions('pi', { id: 'x', cwd: 'D:\\' }, {}, tmp(), env), /一键安装|安装 pi/);
  const legacy = tmp();
  fs.mkdirSync(path.join(legacy, 'node_modules', '@mariozechner', 'pi-coding-agent'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'node_modules', '@mariozechner', 'pi-coding-agent', 'package.json'), JSON.stringify({ version: '0.73.1' }));
  const d = pi.diagnosePi(baseEnv({ NPM_CONFIG_PREFIX: legacy }));
  assert.equal(d.state, 'legacy');
  assert.match(d.message, /0\.73\.1/);
  assert.equal(pi.diagnosePi(baseEnv({ NPM_CONFIG_PREFIX: fakeRuntime() })).state, 'ready');
});

test('观察扩展：注册 Hub 线路，按事件写身份、状态、消息', async () => {
  const log = path.join(tmp(), 'events.jsonl');
  process.env.AI_HUB_PI_EVENT_LOG = log;
  process.env.AI_HUB_PI_PROVIDERS = JSON.stringify({ 'hub-tokenplan': { baseUrl: 'https://x', api: 'openai-completions', apiKey: '$K', models: [] } });
  try {
    const mod = await import(pathToFileURL(path.join(root, 'core', 'pi-cli-observer.mjs')).href + '?t=' + Date.now());
    const handlers = {}, registered = [];
    mod.default({ on: (name, fn) => { handlers[name] = fn; }, registerProvider: (name, cfg) => registered.push([name, cfg]), getThinkingLevel: () => 'high' });
    assert.deepEqual(registered.map(r => r[0]), ['hub-tokenplan']);
    const ctx = { cwd: 'D:\\w', model: { provider: 'deepseek', id: 'deepseek-flash' },
      sessionManager: { getSessionId: () => 'sid-1', getSessionFile: () => 'D:\\s.jsonl' } };
    await handlers.session_start({ reason: 'startup' }, ctx);
    await handlers.agent_start({}, ctx);
    await handlers.message_end({ message: { role: 'user', content: 'hi', timestamp: 1 } }, ctx);
    await handlers.message_end({ message: { role: 'system', content: '' } }, ctx);
    await handlers.agent_settled({ aborted: false }, ctx);
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.type), ['bound', 'status', 'message', 'settled']);
    assert.equal(rows[0].sessionId, 'sid-1');
    assert.equal(rows[0].sessionFile, 'D:\\s.jsonl');
    assert.deepEqual(rows[0].model, { provider: 'deepseek', id: 'deepseek-flash' });
  } finally { delete process.env.AI_HUB_PI_EVENT_LOG; delete process.env.AI_HUB_PI_PROVIDERS; }
});

function fakeSession() {
  const { PiCliSession } = require('../core/pi-cli-session');
  const session = new PiCliSession({ id: 'hub-1', cwd: 'D:\\w', model: 'deepseek/deepseek-flash', eventDir: tmp(), launch: { command: 'node', args: [], env: {} } });
  session.output = 'ready'; session.lastOutputAt = 0; session.ready = Promise.resolve();
  return session;
}

test('事件 → 卡片：发送回执以 pi 记下的 user 消息为准，轮次完成、模型、用量、流式半截都对得上', async () => {
  const session = fakeSession();
  const lifecycle = [], states = [];
  session.on('lifecycle', e => lifecycle.push(e.type));
  session.on('state', s => states.push(s.state));
  session.observe({ type: 'bound', sessionId: 'sid-1', sessionFile: null, cwd: 'D:\\w', model: { provider: 'deepseek', id: 'deepseek-flash' } });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(session.runtime.connection, 'connected');
  const receipt = new Promise(resolve => { session.pending = { id: 'c-1', text: '你好', resolve, timer: setTimeout(() => {}, 0) }; });
  session.observe({ type: 'status', sessionId: 'sid-1', status: 'running', at: 10 });
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 11 } });
  const ack = await receipt;
  assert.equal(ack.ok, true);
  assert.equal(ack.clientSubmissionId, 'c-1');
  session.observe({ type: 'partial', sessionId: 'sid-1', text: '半截' });
  assert.equal(session.readTranscript().at(-1).text, '半截');
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash',
    content: [{ type: 'thinking', thinking: '想' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
    usage: { input: 10, output: 5, cacheRead: 2, totalTokens: 17 }, stopReason: 'toolUse', timestamp: 12 } });
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], isError: false, timestamp: 13 } });
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash',
    content: [{ type: 'text', text: '有 a.txt' }], usage: { input: 3, output: 4, cacheRead: 0, totalTokens: 24 }, stopReason: 'stop', timestamp: 14 } });
  session.observe({ type: 'settled', sessionId: 'sid-1', aborted: false, at: 15 });
  const cards = session.readTranscript();
  assert.deepEqual(cards.map(c => c.role), ['user', 'assistant']);
  assert.equal(cards[1].text, '有 a.txt');
  assert.equal(cards[1].model, 'deepseek/deepseek-flash');
  assert.equal(cards[1].kind, 'pi');
  assert.deepEqual(lifecycle, ['turn-started', 'prompt-submitted', 'turn-complete']);
  assert.equal(session.runtime.state, 'completed');
  assert.equal(session.usageTotals.input, 15);
  // 中断与失败
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'user', content: '再来', timestamp: 20 } });
  session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '403 denied', timestamp: 21 } });
  session.observe({ type: 'settled', sessionId: 'sid-1', aborted: false, at: 22 });
  assert.equal(session.runtime.state, 'failed');
  assert.match(session.runtime.reason, /403/);
  // 别的会话的行忽略
  session.observe({ type: 'message', sessionId: 'other', message: { role: 'user', content: 'x', timestamp: 30 } });
  assert.equal(session.records.length, 2);
  session.dispose();
});

test('换模型 / 思考强度：等观察扩展报回才算生效', async () => {
  const session = fakeSession();
  session.observe({ type: 'bound', sessionId: 'sid-1', cwd: 'D:\\w', model: { provider: 'deepseek', id: 'deepseek-flash' } });
  await new Promise(resolve => setTimeout(resolve, 120));
  const sent = [];
  session.send = async (text, opts) => { sent.push([text, opts.configurationCommand]);
    setTimeout(() => session.observe(text.startsWith('/model') ? { type: 'model', sessionId: 'sid-1', model: { provider: 'deepseek', id: 'deepseek-v4-pro' } }
      : { type: 'thinking', sessionId: 'sid-1', level: 'high' }), 20); return { ok: true }; };
  const result = await session.configure({ model: 'deepseek/deepseek-v4-pro', effort: 'high' });
  assert.deepEqual(sent, [['/model deepseek/deepseek-v4-pro', true], ['/thinking high', true]]);
  assert.equal(result.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(result.effort, 'high');
  await assert.rejects(session.fork(), /\/fork/);
  await assert.rejects(session.askSide('?'), /问一下/);
  session.dispose();
});

test('休眠会话：直接读 pi 会话文件，只显示当前分支', () => {
  const { readPiCliTranscript } = require('../core/pi-cli-session');
  const file = path.join(tmp(), 'session.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 'sid', cwd: 'D:\\w' },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: '第一问', timestamp: 1 } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', content: [{ type: 'text', text: '第一答' }], stopReason: 'stop', timestamp: 2 } },
    { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: '废弃分支', timestamp: 3 } },
    { type: 'model_change', id: 'm', parentId: 'b', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
    { type: 'message', id: 'd', parentId: 'm', message: { role: 'user', content: '第二问', timestamp: 4 } },
    { type: 'message', id: 'e', parentId: 'd', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-pro', content: [{ type: 'text', text: '第二答' }], stopReason: 'stop', timestamp: 5 } },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n{"type":"mess');
  const cards = readPiCliTranscript(file);
  assert.deepEqual(cards.map(c => c.text), ['第一问', '第一答', '第二问', '第二答']);
  assert.equal(cards.at(-1).model, 'deepseek/deepseek-v4-pro');
});

test('打包：观察扩展由外部 Node 加载，必须解包；构建脚本和一键安装都认 pi', () => {
  assert.ok(require('../package.json').build.asarUnpack.includes('core/pi-cli-observer.mjs'));
  assert.ok(require('../core/cli-tools/catalog').IDS.includes('pi'));
  assert.ok(require('../core/cli-tools/registry').IDS.includes('pi'));
  assert.ok(require('../core/cli-tools/installer').NAMES.pi);
  const src = fs.readFileSync(path.join(root, 'scripts', 'build-cli-components.js'), 'utf8');
  assert.match(src, /planPi/);
});

test('发送：自带 ConPTY 下粘贴里的换行改成回车（否则 pi 收到 Ctrl+Enter 键码），系统 ConPTY 下原样', async () => {
  for (const bundled of [true, false]) {
    const session = fakeSession();
    session.observe({ type: 'bound', sessionId: 'sid-1', cwd: 'D:\w' });
    await new Promise(resolve => setTimeout(resolve, 120));
    const written = [];
    session.pty = { hubBundledConpty: bundled, write: data => { written.push(data); if (data === '\r') setTimeout(() => session.observe({ type: 'message', sessionId: 'sid-1', message: { role: 'user', content: '第一行\n第二行', timestamp: 1 } }), 10); } };
    session.output = '第一行 第二行';
    const result = await session.send('第一行\n第二行', { clientSubmissionId: 'c-9' });
    assert.equal(result.ok, true);
    assert.equal(result.clientSubmissionId, 'c-9');
    const paste = written.find(w => w.startsWith('\x1b[200~'));
    assert.equal(paste, '\x1b[200~' + (bundled ? '第一行\r第二行' : '第一行\n第二行') + '\x1b[201~');
    session.dispose();
  }
});

// ---------- r39 返工（m112 审查 3 项必改 + 2 项建议） ----------
const cp = require('node:child_process');
// 让本进程里所有 `node --version` 都报 version（审查探针同样做法：替换版本命令输出，不装旧 Node、不改真实环境）。
function withNodeVersion(version, fn) {
  const real = cp.spawnSync;
  cp.spawnSync = (file, args, opts) => (Array.isArray(args) && args[0] === '--version' ? { stdout: `v${version}\n`, status: 0 } : real(file, args, opts));
  delete require.cache[require.resolve('../core/local-node')];
  const restore = () => { cp.spawnSync = real; delete require.cache[require.resolve('../core/local-node')]; };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (error) { restore(); throw error; }
}

test('返工 P1：存的是 Token Plan 模型、套餐 Key 不在，有 DeepSeek Key 也不悄悄换线路——新建和恢复都当场报缺 Key', () => {
  const pi = require('../core/pi-cli-profile');
  const env = baseEnv({ NPM_CONFIG_PREFIX: fakeRuntime() });
  const sessionFile = path.join(tmp(), 's.jsonl'); fs.writeFileSync(sessionFile, '');
  const cases = [
    { id: 'new', model: 'hub-tokenplan/qwen3.8-max' },
    { id: 'resume', model: 'hub-tokenplan/qwen3.8-max', acpSid: 'sid-9', piSessionFile: sessionFile },
  ];
  for (const opts of cases) {
    let error = null;
    try { pi.buildPiCliOptions('pi', { cwd: 'D:\\w', ...opts }, { deepseekApiKey: 'sk-only-deepseek' }, tmp(), env); } catch (e) { error = e; }
    assert.ok(error, opts.id + '：必须报错，不能换成 deepseek 启动');
    assert.equal(error.code, 'PI_ROUTE_KEY_MISSING');
    assert.equal(error.piRoute.route, 'tokenplan');
    assert.equal(error.piRoute.keyField, 'tokenplan');
    assert.match(error.message, /Token Plan/);
    assert.match(error.message, /qwen3\.8-max/);
    assert.match(error.message, /没有改用别的线路/);
    assert.ok(!error.message.includes('sk-only-deepseek'), '报错里不带钥匙');
  }
  // 存的是 DeepSeek 模型、DeepSeek Key 没了、只有套餐 Key：同样不换
  assert.throws(() => pi.buildPiCliOptions('pi', { id: 'd', cwd: 'D:\\w', model: 'deepseek/deepseek-v4-pro' }, { acp: { apiKey: 'plan' } }, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING' && e.piRoute.keyField === 'deepseek');
  // 公司模型线路没配好：报错，但没有 Key 可填
  assert.throws(() => pi.buildPiCliOptions('pi', { id: 'c', cwd: 'D:\\w', model: 'company-proxy/x' }, { deepseekApiKey: 'sk' }, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING' && e.piRoute.keyField === null);
  // 没指定模型的新会话：照常自动选默认线路
  const fresh = pi.buildPiCliOptions('pi', { id: 'f', cwd: 'D:\\w' }, { acp: { apiKey: 'plan' } }, tmp(), env);
  assert.equal(fresh.route, 'tokenplan');
  // 补上 Key 后：按原来选的模型和线路启动
  const fixed = pi.buildPiCliOptions('pi', { id: 'r', cwd: 'D:\\w', model: 'hub-tokenplan/qwen3.8-max', acpSid: 'sid-9', piSessionFile: sessionFile },
    { deepseekApiKey: 'sk', acp: { apiKey: 'plan' } }, tmp(), env);
  assert.deepEqual(fixed.launch.args.slice(3), ['--provider', 'hub-tokenplan', '--model', 'qwen3.8-max', '--session', sessionFile]);
  // pi 自己的模型（不是 Hub 线路）原样交给 pi
  const own = pi.buildPiCliOptions('pi', { id: 'o', cwd: 'D:\\w', model: 'anthropic/claude-x' }, {}, tmp(), env);
  assert.deepEqual(own.launch.args.slice(3), ['--model', 'anthropic/claude-x']);
  // 界面用的检查：缺 Key 时给出线路和要补的字段
  assert.equal(pi.piRouteCheck('hub-tokenplan/qwen3.8-max', { deepseekApiKey: 'sk' }, env).keyField, 'tokenplan');
  assert.equal(pi.piRouteCheck('hub-tokenplan/qwen3.8-max', { acp: { apiKey: 'plan' } }, env).ok, true);
  assert.equal(pi.piRouteCheck('', {}, env).ok, true);
});

test('二次返工 P2：pi 自己配的 DeepSeek 首次走 native，恢复沿用 pi 自己的配置不拦；Hub 线路会话缺 Key 仍拦、不悄悄换凭据来源', () => {
  const pi = require('../core/pi-cli-profile');
  const env = baseEnv({ NPM_CONFIG_PREFIX: fakeRuntime() });
  const sessionFile = path.join(tmp(), 's.jsonl'); fs.writeFileSync(sessionFile, '');
  // 首次：Hub 没有任何 Key，交给 pi 自己选模型，记下凭据来源 pi:native
  const first = pi.buildPiCliOptions('pi', { id: 'n', cwd: 'D:\w' }, {}, tmp(), env);
  assert.equal(first.route, 'native');
  assert.equal(first.profileId, 'pi:native');
  // pi 上报的模型是 deepseek/…（pi 自带 provider 名），带着 pi:native 恢复：不拦，原样交给 pi 解析
  const resumed = pi.buildPiCliOptions('pi-resume', { id: 'n', cwd: 'D:\w', model: 'deepseek/own-model', acpSid: 'sid-n', piSessionFile: sessionFile, piProfileId: first.profileId }, {}, tmp(), env);
  assert.equal(resumed.route, 'native');
  assert.equal(resumed.profileId, 'pi:native');
  assert.deepEqual(resumed.launch.args.slice(3), ['--model', 'deepseek/own-model', '--session', sessionFile]);
  // 之后 Hub 里又填了 DeepSeek Key：native 会话仍用 pi 自己的配置，不被改成 Hub 线路
  const later = pi.buildPiCliOptions('pi-resume', { id: 'n', cwd: 'D:\w', model: 'deepseek/own-model', piProfileId: 'pi:native' }, { deepseekApiKey: 'sk-hub' }, tmp(), env);
  assert.equal(later.route, 'native');
  assert.ok(!later.launch.args.includes('--provider'));
  // Hub DeepSeek 线路的会话（pi:deepseek）Key 删了：照旧拦，不悄悄改用 pi 自己的凭据
  assert.throws(() => pi.buildPiCliOptions('pi-resume', { id: 'h', cwd: 'D:\w', model: 'deepseek/deepseek-flash', piProfileId: 'pi:deepseek' }, {}, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING' && e.piRoute.keyField === 'deepseek');
  // 没有来源记录的老会话：按 Hub 线路处理（和上一轮一致）
  assert.throws(() => pi.buildPiCliOptions('pi-resume', { id: 'o', cwd: 'D:\w', model: 'deepseek/deepseek-flash' }, {}, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING');
  // native 会话里切到只有 Hub 才有的套餐 / 公司模型、Key 不在：仍拦（这些 provider 只有 Hub 注入才存在）
  assert.throws(() => pi.buildPiCliOptions('pi-resume', { id: 'p', cwd: 'D:\w', model: 'hub-tokenplan/qwen3.8-max', piProfileId: 'pi:native' }, { deepseekApiKey: 'sk' }, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING' && e.piRoute.keyField === 'tokenplan');
  assert.throws(() => pi.buildPiCliOptions('pi-resume', { id: 'c', cwd: 'D:\w', model: 'company-proxy/x', piProfileId: 'pi:native' }, {}, tmp(), env),
    e => e.code === 'PI_ROUTE_KEY_MISSING');
  // 界面检查同口径
  assert.equal(pi.piRouteCheck('deepseek/own-model', {}, env, { profileId: 'pi:native' }).ok, true);
  assert.equal(pi.piRouteCheck('deepseek/own-model', {}, env, { profileId: 'pi:deepseek' }).keyField, 'deepseek');
  assert.equal(pi.piRouteCheck('deepseek/own-model', {}, env).ok, false);
  assert.equal(pi.savedRouteSource('pi:native'), 'native');
  assert.equal(pi.savedRouteSource('tokenplan:deepseek-acp'), '');
  // 恢复链路：恢复处理器把会话存的 acpProfileId 传成 piProfileId；补 Key 页查询带上会话的 acpProfileId
  const resumeSrc = fs.readFileSync(path.join(root, 'main/ipc/resume-session-handlers.js'), 'utf8');
  assert.match(resumeSrc, /piProfileId: meta\.acpProfileId/);
  const fixSrc = fs.readFileSync(path.join(root, 'renderer/pi-route-key-fix.js'), 'utf8');
  assert.match(fixSrc, /profileId: session\.acpProfileId/);
  const ipcSrc = fs.readFileSync(path.join(root, 'main/ipc/acp-handlers.js'), 'utf8');
  assert.match(ipcSrc, /profileId: String\(profileId/);
});

test('返工 P1：唤醒失败页就地补 Key——填好点「保存并继续」存到设置同一字段并重新唤醒；线路可用或不是 pi 时不出现', async () => {
  const { mountPiRouteKeyFix } = require('../renderer/pi-route-key-fix');
  // 极简 DOM
  const make = tag => ({ tagName: tag, children: [], listeners: {}, attrs: {}, isConnected: true, disabled: false, value: '', textContent: '',
    append(...k) { this.children.push(...k); }, setAttribute(n, v) { this.attrs[n] = v; }, focus() {},
    addEventListener(n, fn) { this.listeners[n] = fn; } });
  const doc = { createElement: make };
  const find = (el, pred) => pred(el) ? el : el.children.map(c => find(c, pred)).find(Boolean) || null;
  const calls = [];
  const ipc = { invoke: async (channel, payload) => { calls.push([channel, payload]);
    if (channel === 'pi:route-check') return payload.model.startsWith('hub-tokenplan/')
      ? { ok: false, route: 'tokenplan', label: 'Token Plan', keyField: 'tokenplan', message: '缺套餐 Key' } : { ok: true };
    if (channel === 'acp:settings:save') return { ok: true };
    if (channel === 'save-hub-config') return { success: true };
    throw new Error('unexpected ' + channel); } };
  let retried = 0;
  const box = make('div');
  assert.equal(await mountPiRouteKeyFix(box, { session: { id: 's', kind: 'pi' }, modelId: 'hub-tokenplan/qwen3.8-max', ipc, document: doc, onRetry: () => { retried++; } }), true);
  const input = find(box, el => el.tagName === 'input');
  const button = find(box, el => el.tagName === 'button');
  assert.equal(button.textContent, '保存并继续');
  assert.equal(input.type, 'password');
  input.value = '  plan-new  ';
  button.listeners.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls.find(c => c[0] === 'acp:settings:save'), ['acp:settings:save', { apiKey: 'plan-new' }]);
  assert.equal(retried, 1);
  // DeepSeek 线路存到设置页 DeepSeek 同一字段
  const { saveRouteKey } = require('../renderer/pi-route-key-fix');
  await saveRouteKey(ipc, 'deepseek', 'sk-new');
  assert.deepEqual(calls.at(-1), ['save-hub-config', { deepseekApiKey: 'sk-new' }]);
  // 线路可用、不是 pi：什么也不挂
  assert.equal(await mountPiRouteKeyFix(make('div'), { session: { id: 's', kind: 'pi' }, modelId: 'deepseek/deepseek-flash', ipc, document: doc }), false);
  assert.equal(await mountPiRouteKeyFix(make('div'), { session: { id: 's', kind: 'claude' }, modelId: 'hub-tokenplan/x', ipc, document: doc }), false);
  // 唤醒失败页确实挂了它
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
  assert.match(renderer, /pi-route-key-fix'\)\.mountPiRouteKeyFix\(copy/);
  const handlers = fs.readFileSync(path.join(root, 'main', 'ipc', 'acp-handlers.js'), 'utf8');
  assert.match(handlers, /ipcMain\.handle\('pi:route-check'/);
});

test('返工 P2：Node 版本按完整的 22.19.0 判——22.18 不算就绪，22.19 和更新的算', () => {
  const local = require('../core/local-node');
  assert.equal(local.versionAtLeast('v22.18.9', '22.19.0'), false);
  assert.equal(local.versionAtLeast('22.19.0', '22.19.0'), true);
  assert.equal(local.versionAtLeast('v24.1.0', '22.19.0'), true);
  assert.equal(local.versionAtLeast('v22.0.0', 22), true);
  assert.equal(local.versionAtLeast('', 22), false);
  const env = baseEnv({ NPM_CONFIG_PREFIX: fakeRuntime() });
  for (const [version, state] of [['22.0.0', 'no-node'], ['22.18.0', 'no-node'], ['22.19.0', 'ready'], ['24.3.1', 'ready']]) {
    withNodeVersion(version, () => {
      const pi = require('../core/pi-cli-profile');
      assert.equal(pi.diagnosePi(env).state, state, `Node ${version}`);
      if (state === 'no-node') assert.throws(() => pi.buildPiCliOptions('pi', { id: 'x', cwd: 'D:\\w' }, {}, tmp(), env), /22\.19/);
    });
  }
  // Hub 自管的 Node 也核版本：登记着一份 22.0 的 Node，不能直接拿来用
  const toolsDir = tmp();
  const exe = path.basename(process.execPath);
  fs.mkdirSync(path.join(toolsDir, 'node', '22.0.0'), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'node', '22.0.0', exe), 'fake');
  fs.writeFileSync(path.join(toolsDir, 'installed.json'), JSON.stringify({ schema: 1, tools: { node: { version: '22.0.0', dir: 'node/22.0.0', bin: exe } } }));
  const hubEnv = { ...env, AI_HUB_CLI_TOOLS_DIR: toolsDir };
  assert.ok(require('../core/cli-tools/registry').managedBin('node', hubEnv), '测试前提：Hub 自管 Node 已登记');
  withNodeVersion('22.0.0', () => assert.equal(require('../core/pi-cli-profile').nodeFor(hubEnv), ''));
  withNodeVersion('22.19.0', () => assert.equal(require('../core/pi-cli-profile').nodeFor(hubEnv), require('../core/cli-tools/registry').managedBin('node', hubEnv)));
});

function fakePiNpm(entrySource = 'console.log("1.5.2")') {
  return async args => {
    const target = args[args.indexOf('--prefix') + 1];
    const pkg = path.join(target, 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(path.join(pkg, 'dist', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'dist', 'bundle', 'cli.js'), entrySource);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.5.2' }));
    return '';
  };
}

test('返工 P2：npm 后备装完要真跑一次 pi --version，跑不起来不登记、不报装好', async () => {
  const { createCliInstaller } = require('../core/cli-tools/installer');
  const registry = require('../core/cli-tools/registry');
  // 1) npm 成功、但入口跑不起来 → error，installed.json 里没有 pi，试运行确实调用过
  {
    const env = baseEnv();
    const probes = [];
    const installer = createCliInstaller({ sources: [], env, busyRetry: { attempts: 1, delays: [0] },
      run: async (file, args) => { probes.push([file, args]); throw Object.assign(new Error('exit 1'), { stderr: 'Error: boom' }); },
      npmRun: fakePiNpm('throw new Error("boom")') });
    const state = await installer.install('pi');
    assert.equal(state.tools.pi.phase, 'error');
    assert.match(state.tools.pi.error, /试运行没有通过/);
    assert.ok(probes.length >= 1);
    assert.equal(probes[0][1][1], '--version');
    assert.match(probes[0][1][0], /pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/);
    assert.equal(registry.readInstalled(registry.toolsRoot(env)).tools.pi, undefined);
  }
  // 2) 试运行通过 → done，用的是 22.19 以上的 Node
  {
    const env = baseEnv();
    const probes = [];
    const installer = createCliInstaller({ sources: [], env, run: async (file, args) => { probes.push([file, args]); return '1.5.2'; }, npmRun: fakePiNpm() });
    const state = await installer.install('pi');
    assert.equal(state.tools.pi.phase, 'done');
    assert.equal(probes.length, 1);
    const local = require('../core/local-node');
    assert.ok(local.versionAtLeast(local.nodeVersion(probes[0][0]), '22.19.0'));
    assert.equal(registry.readInstalled(registry.toolsRoot(env)).tools.pi.version, '1.5.2');
  }
});

test('返工 P2：npm 后备时本机 Node 不够 22.19、组件目录也补不上——不跑 npm，说清要先装 Node', async () => {
  await withNodeVersion('22.18.0', async () => {
    const { createCliInstaller } = require('../core/cli-tools/installer');
    const env = baseEnv();
    let npmCalls = 0;
    const npm = fakePiNpm();
    const installer = createCliInstaller({ sources: [], env, run: async () => '1.5.2', npmRun: async (...a) => { npmCalls++; return npm(...a); } });
    const state = await installer.install('pi');
    assert.equal(state.tools.pi.phase, 'error');
    assert.match(state.tools.pi.error, /Node\.js 22\.19\.0 或更新/);
    assert.equal(npmCalls, 0);
  });
});

test('返工 P3：pi 模型菜单不再统一写「阿里云套餐模型」；没有 Hub 钥匙时也说明降级功能', () => {
  const modelUi = fs.readFileSync(path.join(root, 'renderer', 'model-ui.js'), 'utf8');
  assert.match(modelUi, /strategy === 'acp-native' && \/\^pi/);
  const wc = fs.readFileSync(path.join(root, 'renderer', 'workspace-controller.js'), 'utf8');
  const block = wc.slice(wc.indexOf('function paintPiNote'), wc.indexOf('async function installPiFromLaunch'));
  assert.match(block, /\+ 'Hub 的「问一下」与分支按钮暂不支持 pi/);
});

test('返工：pi 报过的会话文件不在（一句没聊过）就开新的，不拿会话 id 去续（否则 pi 找不到直接退出）；没报过路径的老记录仍按 id 续', () => {
  const pi = require('../core/pi-cli-profile');
  const env = baseEnv({ NPM_CONFIG_PREFIX: fakeRuntime() });
  const missing = pi.buildPiCliOptions('pi', { id: 'a', cwd: 'D:\w', acpSid: 'sid-1', piSessionFile: path.join(tmp(), 'never-written.jsonl') }, {}, tmp(), env);
  assert.ok(!missing.launch.args.includes('--session'));
  assert.equal(missing.resumeId, null, '开新的就不按旧 id 核身份');
  const legacy = pi.buildPiCliOptions('pi', { id: 'b', cwd: 'D:\w', acpSid: 'sid-1' }, {}, tmp(), env);
  assert.deepEqual(legacy.launch.args.slice(-2), ['--session', 'sid-1']);
});
