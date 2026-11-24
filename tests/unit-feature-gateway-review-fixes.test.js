'use strict';
// 部门 API key 扩到 8 项功能后的三审整改（2026-11-24）：恢复只认磁盘记录、none 档 MCP 必须、全局 Claude 配置不误杀、
// 删 key 后恢复被拦、后台功能网关报错 8 秒收场且带基线、问一下的 --settings 覆盖层、手填模型的顺序。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const route = require('../core/assistant-gateway-route');
const GW = JSON.stringify({ kind: 'api-gateway', model: '' });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-review-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const gatewayOpts = (extra = {}) => ({ featureAgent: 'forum', purpose: 'company-forum', featureAgentChoice: GW, apiGatewayRoute: true, mcpProfile: 'none', ...extra });

test('放行必须是 none 档 MCP：缺档位、full、lean 一律拒绝', () => {
  assert.equal(route.allowedSession('claude', gatewayOpts()), true);
  assert.equal(route.allowedSession('claude-resume', gatewayOpts()), true);
  for (const mcpProfile of [undefined, 'full', 'lean', '']) {
    assert.equal(route.allowedSession('claude', gatewayOpts({ mcpProfile })), false, String(mcpProfile));
    assert.throws(() => require('../core/feature-agent-choice').assertSessionKind('claude', gatewayOpts({ mcpProfile })), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND');
  }
});

test('恢复字段只按磁盘记录推出：功能、用途、选型配套且是 Claude Code 会话才给，强制 none 档', () => {
  const saved = { kind: 'claude', featureAgent: 'forum', purpose: 'company-forum', featureAgentChoice: GW, mcpProfile: 'full' };
  assert.deepEqual(route.resumeFields(saved), { featureAgent: 'forum', featureAgentChoice: GW, purpose: 'company-forum', apiGatewayRoute: true, mcpProfile: 'none' });
  assert.equal(route.resumeFields(null), null);
  assert.equal(route.resumeFields({ ...saved, purpose: 'avatar-agent' }), null, '用途不配套');
  assert.equal(route.resumeFields({ ...saved, featureAgentChoice: JSON.stringify({ kind: 'codeagent' }) }), null, '选型不是部门 key');
  assert.equal(route.resumeFields({ ...saved, kind: 'codex' }), null, '不是 Claude Code');
  assert.equal(route.resumeFields({ ...saved, featureAgent: 'help' }), null, '功能不在表里');
});

// ---- 恢复休眠会话：登录检查和创建会话看到的是同一份权威字段 ----
function resumeFixture(t, { saved = null, available = true } = {}) {
  const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
  t.mock.method(require('../core/session-store'), 'loadSessionFile', () => (saved ? JSON.parse(JSON.stringify(saved)) : null));
  t.mock.method(route, 'availability', () => (available ? { available: true, reason: '' } : { available: false, reason: '还没保存部门 API key' }));
  const auth = [], created = [], live = new Map();
  const resume = createResumeSessionHandler({ fs, os, path, getHookPort: () => 0, getHubDataDir: () => tmp(t),
    isClaudeFamily: () => false, isCodexBaseKind: () => false, meetingManager: { getAllMeetings: () => [] },
    ensureLaunchAuth: async (kind, opts) => { auth.push({ kind, opts }); }, registerSessionForTap() {}, sendToRenderer() {},
    sessionManager: { getSession: id => live.get(id), _openOwners: () => ({ owner: () => null }),
      createSession(kind, opts) { created.push({ kind, opts }); const s = { id: opts.id, kind, status: 'idle' }; live.set(opts.id, s); return s; } } });
  return { resume, auth, created };
}
const FORGED = { featureAgent: 'forum', featureAgentChoice: GW, apiGatewayRoute: true, purpose: 'company-forum', mcpProfile: 'none' };

test('恢复：磁盘记录是部门 key 的论坛会话 → 登录检查前就带上网关标记与 none 档，创建参数同一份', async t => {
  const f = resumeFixture(t, { saved: { hubId: 'h1', kind: 'claude', featureAgent: 'forum', purpose: 'company-forum', featureAgentChoice: GW, mcpProfile: 'full', cwd: os.tmpdir() } });
  await f.resume({ hubId: 'h1', kind: 'claude' });
  assert.equal(f.auth.length, 1);
  assert.equal(route.allowedSession(f.auth[0].kind, f.auth[0].opts), true, '登录检查看得到网关会话（据此拉起本机反代，不查全局 Claude）');
  const opts = f.created[0].opts;
  assert.equal(opts.apiGatewayRoute, true); assert.equal(opts.mcpProfile, 'none', '记录里的 full 被强制成 none');
  assert.equal(route.allowedSession(f.created[0].kind, opts), true);
});

test('恢复：渲染层伪造 featureAgent / 选型 / 网关标记一概不认（有磁盘记录、没有磁盘记录、伪造在启动覆盖里）', async t => {
  for (const [label, saved, meta] of [
    ['有记录但不是功能会话', { hubId: 'h2', kind: 'claude', cwd: os.tmpdir() }, { hubId: 'h2', kind: 'claude', ...FORGED }],
    ['没有磁盘记录', null, { hubId: 'h3', kind: 'claude', ...FORGED }],
    ['伪造在启动覆盖里', { hubId: 'h4', kind: 'claude', cwd: os.tmpdir() }, { hubId: 'h4', kind: 'claude', launchOverrides: FORGED }],
  ]) {
    const f = resumeFixture(t, { saved });
    await f.resume(meta);
    for (const opts of [f.auth[0].opts, f.created[0].opts]) {
      assert.equal(opts.apiGatewayRoute, undefined, label);
      assert.equal(opts.featureAgent, undefined, label);
      assert.equal(route.allowedSession('claude', opts), false, label);
    }
    t.mock.restoreAll();
  }
});

test('恢复：部门 key 已删时恢复旧网关会话被拦，给一步可做的人话，不起会话', async t => {
  const f = resumeFixture(t, { available: false, saved: { hubId: 'h5', kind: 'claude', featureAgent: 'text', purpose: 'company-ai', featureAgentChoice: GW, cwd: os.tmpdir() } });
  await assert.rejects(() => f.resume({ hubId: 'h5', kind: 'claude' }), e => /部门 API key/.test(e.message) && /设置 → API 网关/.test(e.message));
  assert.equal(f.created.length, 0); assert.equal(f.auth.length, 0);
});

// ---- 启动前配置检查 ----
test('全局 Claude「自有 API」配坏了不误杀网关功能；部门 key 没了就清楚报出来', t => {
  const config = require('../core/company-api-config');
  const store = require('../core/api-gateway');
  let configured = true;
  t.mock.method(store, 'configured', () => configured);
  const broken = { claudeApiKeyNeedsInput: true, claudeApiBaseUrl: 'not a url', claudeApiModel: 'bad model ✗' };
  assert.doesNotThrow(() => config.assertLaunchConfigured('claude', broken, gatewayOpts()));
  assert.doesNotThrow(() => config.assertLaunchConfigured('claude-resume', broken, gatewayOpts()));
  configured = false;
  assert.throws(() => config.assertLaunchConfigured('claude', broken, gatewayOpts()), e => e.code === 'API_GATEWAY_KEY_MISSING' && /设置 → API 网关/.test(e.message));
  // 伪造的（缺 none 档）不享受豁免，照常走全局检查（这里不是公司版时直接返回，不抛网关错）。
  assert.doesNotThrow(() => { try { config.assertLaunchConfigured('claude', {}, gatewayOpts({ mcpProfile: 'full' })); } catch (e) { assert.notEqual(e.code, 'API_GATEWAY_KEY_MISSING'); } });
});

test('部门 key 会话写不出受控 MCP 配置就不启动，不退回全量加载用户 MCP；普通会话保持原来的回退', t => {
  const { buildClaudeMeetingMcpArgs } = require('../core/session-manager')._private;
  const hubDataDir = tmp(t);
  const brokenFs = { ...fs, writeFileSync() { throw new Error('disk full'); }, renameSync() { throw new Error('disk full'); }, mkdirSync() { throw new Error('disk full'); } };
  const quiet = t.mock.method(console, 'warn', () => {});
  assert.throws(() => buildClaudeMeetingMcpArgs({ mcpProfile: 'none', hubDataDir, cwd: hubDataDir, fsModule: brokenFs, failClosed: true }), e => e.code === 'GATEWAY_MCP_CONFIG_FAILED');
  assert.equal(buildClaudeMeetingMcpArgs({ mcpProfile: 'none', hubDataDir, cwd: hubDataDir, fsModule: brokenFs }).profile, 'full');
  const ok = buildClaudeMeetingMcpArgs({ mcpProfile: 'none', hubDataDir, cwd: hubDataDir, failClosed: true });
  assert.equal(ok.profile, 'none'); assert.match(ok.args, /--strict-mcp-config/);
  void quiet;
});

// ---- 后台功能的网关报错 ----
test('网关报错：后台功能稳定 8 秒收场、带基线不被旧错锁死；认不出的也给网关口径，绝不说「Agent 尚未登录」', () => {
  const { createReader } = require('../core/feature-agent-session-failure');
  let clock = 0, err = { id: 'e1', text: 'API Error: 429 {"error":{"message":"rate limited"}}' }, meta = { apiGatewayRoute: true };
  const reader = createReader({ now: () => clock, getSession: () => meta, readTurnApiError: () => err }, { settleMs: 8000 });
  assert.equal(reader.read('s'), '');
  clock = 7999; assert.equal(reader.read('s'), '');
  clock = 8000; assert.match(reader.read('s'), /^部门 API key（网关）：/);
  // 本轮基线就是这条旧错：不拦。
  assert.equal(reader.read('s', 'e1'), '');
  // 助理（不传 settleMs）仍只提前收 key / 地址类，限流交给它自己的按回合判定。
  assert.equal(createReader({ getSession: () => meta, readTurnApiError: () => err }).read('s'), '');
  // 认不出的报错：网关口径，不落成 CodeAgent「尚未登录」。
  err = { id: 'e2', text: 'Connection error.' };
  const r2 = createReader({ now: () => clock, getSession: () => meta, readTurnApiError: () => err }, { settleMs: 1 });
  r2.read('s'); clock += 5;
  const line = r2.read('s');
  assert.match(line, /^部门 API key（网关）：/); assert.doesNotMatch(line, /尚未登录/);
  // 401 带原文 key 无效：立即收，网关口径。
  err = { id: 'e3', text: 'API Error: 401 Unauthorized' };
  assert.match(createReader({ getSession: () => meta, readTurnApiError: () => err }).read('s'), /^部门 API key（网关）：/);
  // 运行时字段报登录失败：也换成网关口径。
  meta = { apiGatewayRoute: true, connectionIssue: { code: 'auth_required' } };
  const r3 = createReader({ getSession: () => meta, readTurnApiError: () => null }).read('s');
  assert.match(r3, /^部门 API key（网关）：/); assert.doesNotMatch(r3, /尚未登录/);
  // CodeAgent 会话不受影响。
  assert.match(createReader({ getSession: () => ({ connectionIssue: { code: 'auth_required' } }), readTurnApiError: () => null }).read('s'), /尚未登录/);
});

test('认不出的网关报错给兜底一行（可重试，不给 CodeAgent 修复卡）', () => {
  const gw = route.gatewayFailure('weird socket hang up');
  assert.match(gw.line, /^部门 API key（网关）：网关报错/); assert.deepEqual(gw.actions, ['retry']);
  assert.deepEqual(route.gatewayFailure('API Error: 401 x').actions, ['gateway-settings']);
});

test('论坛：网关 429 稳定 8 秒就收场；本轮基线挡住上一轮的旧错', async () => {
  const { CompanyForum } = require('../core/company-forum/service');
  let clock = 0, reason = null;
  const deps = { now: () => clock, getSession: () => ({ apiGatewayRoute: true }), readTurnApiError: () => ({ id: 'e9', text: 'API Error: 429 too many' }) };
  const ctx = { deps, job: { sessionId: 'sid', sentAt: 1, apiErrorBaseline: null }, lastFinal: () => null, sessionBusy: () => true, now: () => clock,
    finishSummary: (_job, _text, error) => { reason = error; } };
  await CompanyForum.prototype.collectJob.call(ctx);
  assert.equal(reason, null, '刚出现，先等稳定');
  clock = 9000; await CompanyForum.prototype.collectJob.call(ctx);
  assert.match(reason, /^部门 API key（网关）：/);
  // 旧错（修好 key 前的 401）是本轮基线：不拦，会话照常等回答。
  reason = null;
  const old = { ...ctx, launchFailures: null, job: { sessionId: 'sid', sentAt: 1, apiErrorBaseline: 'e9' }, deps: { ...deps, readTurnApiError: () => ({ id: 'e9', text: 'API Error: 401 x' }) } };
  clock = 99999; await CompanyForum.prototype.collectJob.call(old);
  assert.equal(reason, null);
});

test('会议：复用会话带本轮基线；网关报错稳定后收场，报网关口径', async () => {
  const { MeetingCompanion } = require('../core/company-assistant/meeting');
  let clock = 0, reason = '';
  const a = { deps: { now: () => clock, getSession: () => ({ apiGatewayRoute: true }), readTurnApiError: () => ({ id: 'm1', text: 'API Error: 503 busy' }) },
    lastFinal: () => null, sessionGone: (_sid, baseline) => { assert.equal(baseline, 'old'); return ''; }, sessionBusy: () => true };
  const ctx = { a, lane: () => ({}), now: () => clock, fail: (_id, error) => { reason = error.message; } };
  const m = { id: 'meeting', job: { sessionId: 'sid', apiErrorBaseline: 'old', sentAt: 0 } };
  await MeetingCompanion.prototype.collect.call(ctx, m);
  assert.equal(reason, '');
  clock = 8000; await MeetingCompanion.prototype.collect.call(ctx, m);
  assert.match(reason, /^部门 API key（网关）：/);
});

// ---- 问一下（会议问答）----
test('问一下：部门 key 会话用找到的 claude 路径，并带 --settings 覆盖层；问完删掉临时文件', async t => {
  const { createAskAsideService, runAsk } = require('../main/ask-aside/service');
  const dataDir = tmp(t), cwd = tmp(t), CC = '0f1d0937-bf2e-4347-9348-56b3a37ff7bc';
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/gw', ANTHROPIC_AUTH_TOKEN: 'local.sess__gw', ANTHROPIC_MODEL: 'glm-5.3-flash', CLAUDE_CONFIG_DIR: path.join(cwd, 'cfg') };
  const calls = [];
  const sessionManager = { getSession: id => ({ s: { kind: 'claude', agentRuntime: 'pty', ccSessionId: CC, cwd, apiGatewayRoute: true } }[id] || null),
    sessions: new Map([['s', { pty: {}, askAsideEnv: env }]]) };
  const svc = createAskAsideService({ sessionManager, getHubDataDir: () => dataDir, hasHistory: () => true, findCommand: () => 'C:/tools/claude.exe',
    run: async opts => { calls.push(opts); return { answer: 'ok' }; }, resolveConfig: () => { throw Error('不该读 CodeAgent'); }, resolveMode: () => ({ input: 'stdin' }) });
  svc.ask({ sessionId: 's', question: '刚才说了什么' }); await svc.drain();
  const config = calls[0].config;
  assert.equal(config.command, 'C:/tools/claude.exe');
  assert.equal(config.settingsEnv.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.equal(config.settingsEnv.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_AUTH_TOKEN);
  // runAsk 真跑一个子进程：参数里有 --settings，文件内容是覆盖层，问完删掉。
  let seenArgs = null, seenFile = null, seenBody = null;
  const spawnFn = (_cmd, args, opts) => {
    seenArgs = args; seenFile = args[args.indexOf('--settings') + 1]; seenBody = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    return require('node:child_process').spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("答"))'], { ...opts, windowsHide: true });
  };
  const result = await runAsk({ config: { ...config, command: 'claude', settingsDir: dataDir }, cwd, ccSessionId: CC, question: 'q', env: {}, spawnFn, platform: 'linux' });
  assert.equal(result.answer, '答');
  assert.ok(seenArgs.includes('--settings'));
  assert.equal(seenBody.env.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.equal(fs.existsSync(seenFile), false, '临时 settings 已删');
  // 普通 Claude 会话不加覆盖层。
  calls.length = 0; sessionManager.getSession = id => ({ s: { kind: 'claude', agentRuntime: 'pty', ccSessionId: CC, cwd } }[id] || null);
  svc.ask({ sessionId: 's', question: '再问' }); await svc.drain();
  assert.equal(calls[0].config.settingsEnv, undefined);
});

// ---- 手填模型 ----
test('手填模型：不支持网关的功能、没存 key 时不试跑不写配置；正常时先记选型再热更新反代', async t => {
  const handlers = new Map();
  const featureAgents = require('../core/feature-agent-choice');
  const gateway = require('../core/api-gateway');
  const order = [];
  t.mock.method(gateway, 'addCustomModel', async (_dir, model) => { order.push('add'); return { ok: true, model }; });
  t.mock.method(featureAgents, 'set', (_dir, id, choice) => { order.push('set:' + id + ':' + choice.model); });
  t.mock.method(featureAgents, 'state', () => ({ ok: true, features: [], backends: [] }));
  let available = false;
  t.mock.method(route, 'availability', () => (available ? { available: true, reason: '' } : { available: false, reason: '还没保存部门 API key' }));
  require('../main/ipc/config-handlers').registerConfigIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} },
    { companyProxyService: { applyGatewayChange: async () => { order.push('apply'); return { state: 'running' }; } }, sendToRenderer() {} });
  const call = request => handlers.get('feature-agents:custom-model')({}, request);
  assert.match((await call({ feature: 'help', model: 'm-1' })).error, /不支持/);
  assert.match((await call({ feature: 'forum', model: 'm-1' })).error, /还没保存部门 API key/);
  assert.deepEqual(order, [], '前置校验没过，不试跑、不写网关配置');
  available = true;
  const ok = await call({ feature: 'forum', model: 'm-1' });
  assert.equal(ok.ok, true); assert.equal(ok.warning, undefined);
  assert.deepEqual(order, ['add', 'set:forum:m-1', 'apply']);
});

test('本机反代正在启动时热更新先等它起好，不误报「重启 Hub 后生效」', async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const svc = Object.create(CompanyProxyService.prototype);
  let ready = false;
  Object.assign(svc, { logger: { warn() {} }, gatewaySettings: () => ({ models: ['m'] }), child: {},
    starting: new Promise(resolve => setTimeout(() => { ready = true; resolve(); }, 20)),
    request: async () => { if (!ready) throw new Error('not ready'); return { ok: true }; }, syncWithConfig: async () => ({ state: 'running' }) });
  assert.deepEqual(await svc.applyGatewayChange(), { state: 'running' });
});

// ---- R2 复审：恢复路径共用启动前检查、登录检查豁免、问一下写失败不留文件 ----
test('登录检查：部门 key 功能会话不查任何订阅账号（非公司版也不查 Claude 订阅）；伪造的照常查', async () => {
  const { LaunchAuth } = require('../core/launch-auth');
  let checks = 0;
  const auth = new LaunchAuth({ getConfig: () => ({ companyCli: false, claudeBackend: 'subscription' }),
    accounts: { check: async () => { checks++; return { state: 'signed_in' }; }, recentObservation: () => null } });
  assert.equal(auth.connection('claude', gatewayOpts()), null);
  assert.equal(auth.connection('claude-resume', gatewayOpts()), null);
  await auth.ensure('claude', gatewayOpts());
  assert.equal(checks, 0, '没有去查订阅登录');
  assert.notEqual(auth.connection('claude', gatewayOpts({ mcpProfile: 'full' })), null, '缺 none 档的伪造会话不享受豁免');
});

test('main.js：新建与休眠恢复共用同一个启动前检查，部门 key 会话会拉起本机反代', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function ensureSessionLaunchAuth('), src.indexOf('const resumeSession = createResumeSessionHandler({'));
  assert.ok(fn.length > 100, '共用函数存在且定义在恢复处理之前');
  assert.match(fn, /allowedSession\(kind, opts \|\| \{\}\)/);
  assert.match(fn, /companyProxyService\.ensureRunning\(\)/);
  const resumeBlock = src.slice(src.indexOf('const resumeSession = createResumeSessionHandler({'), src.indexOf('const resumeSession = createResumeSessionHandler({') + 400);
  assert.match(resumeBlock, /ensureLaunchAuth: ensureSessionLaunchAuth,/, '恢复路径用共用检查');
  const sessionIpc = src.slice(src.indexOf('const sessionOperations = registerSessionIpc(ipcMain, {'), src.indexOf('prepareLaunchAuth:(kind,opts)=>launchAuth.precheck(kind,opts),'));
  assert.match(sessionIpc, /ensureLaunchAuth: ensureSessionLaunchAuth,/, '新建路径用同一个');
  assert.equal((src.match(/ensureLaunchAuth: async \(kind, opts\) => \{\n\s+if \(require\('\.\/core\/assistant-gateway-route'\)/g) || []).length, 0, '不再留一份内联副本');
});

test('问一下：临时 settings 写到一半失败（磁盘满）不留空文件', async t => {
  const { runAsk } = require('../main/ask-aside/service');
  const dir = tmp(t), realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (String(file).includes('ask-aside-')) { realWrite(file, ''); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }
    return realWrite(file, ...rest);
  });
  let spawned = false;
  await assert.rejects(() => runAsk({ config: { command: 'claude', flavor: 'claude', settingsEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, settingsDir: dir },
    cwd: dir, ccSessionId: '0f1d0937-bf2e-4347-9348-56b3a37ff7bc', question: 'q', env: {}, platform: 'linux', spawnFn: () => { spawned = true; } }), /连接设置失败/);
  assert.equal(spawned, false);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('ask-aside-')), [], '没有留下空文件');
});
