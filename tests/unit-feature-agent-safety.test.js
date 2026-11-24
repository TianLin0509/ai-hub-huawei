'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const choices = require('../core/feature-agent-choice'), routes = require('../core/codeagent-assistant-route');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-agent-safe-r13-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('工具会话不提供未受控的后端，旧选择回默认且保留恢复提示', t => {
  const dir = temp(t), ids = ['assistant', 'ppt', 'pptMake', 'pptImgtext', 'avatar', 'forum', 'meeting', 'text'];
  for (const id of ids) for (const kind of ['claude', 'codex', 'deepseek-acp', 'qwen', 'glm']) {
    // 会话功能只开放 CodeAgent 及其省内存方式 CodeAgent-Lite（同一 CLI、同一受控 MCP，2026-11-23）。
    // 另有「部门 API key（网关）」（2026-11-24 起 8 项都可选）：Claude Code 只挂该功能自己的会话工具，见 core/assistant-gateway-route.js。
    assert.deepEqual(choices.FEATURES.find(f => f.id === id).kinds, ['codeagent', 'codeagent-lite', 'api-gateway']);
    assert.throws(() => choices.set(dir, id, { kind, model: '' }, { backends: [{ kind, available: true, models: [] }] }));
    routes.setFeaturePreference(dir, id, { kind, model: '' });
    const opts = { purpose: 'company-assistant', autonomous: true };
    const picked = choices.session(dir, id, 'codeagent', opts, { backends: [{ kind, available: true, models: [] }] });
    assert.equal(picked.kind, 'codeagent'); assert.equal(picked.opts, opts); assert.match(picked.warning, /只读/);
  }
});
test('创建入口在获得会话和 PTY 之前拒绝带功能标记的不安全后端，手动默认路径不变', () => {
  const { SessionManager } = require('../core/session-manager');
  for (const purpose of ['company-assistant', 'company-forum', 'company-ai', 'avatar-agent']) for (const kind of ['claude', 'codex', 'deepseek-acp']) {
    const opts = { featureAgent: 'assistant', purpose, autonomous: true, permissionMode: 'bypassPermissions' };
    assert.throws(() => SessionManager.prototype.createSession.call({}, kind, opts), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND' && e.notSent);
    assert.throws(() => SessionManager.prototype._createSession.call({}, kind, opts), e => e.code === 'FEATURE_AGENT_UNSAFE_BACKEND');
  }
  assert.doesNotThrow(() => choices.assertSessionKind('claude', { autonomous: true }));
  assert.doesNotThrow(() => choices.assertSessionKind('codeagent', { featureAgent: 'assistant', purpose: 'company-assistant' }));
});
test('所选模型运行时登录失败，问问 Hub 在同一时限内回默认链并返回可见提示', async t => {
  const dir = temp(t); let selectedCalls = 0, defaults = 0;
  t.mock.method(choices, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async () => { selectedCalls++; throw new Error('Not logged in'); });
  const engine = require('../core/help-ask/engine').createHelpAskEngine({ dataDir: dir, env: {}, edition: 'member',
    findCommand: kind => kind === 'claude' ? 'fixture' : null, manualPath: () => 'manual', readManual: () => '说明书',
    runOnce: async spec => { if (spec.args.includes('--help')) return { code: 0, stdout: '-p --tools --strict-mcp-config --no-session-persistence' }; defaults++; return { code: 0, stdout: '默认回答' }; } });
  const answer = await engine.ask({ question: '设置在哪？' });
  assert.equal(answer.ok, true); assert.equal(answer.answer, '默认回答'); assert.equal(selectedCalls, 1); assert.equal(defaults, 1);
  assert.match(answer.warning, /所选 Claude Code 失败，已改用默认/); assert.equal(answer.tried[0].selected, true);
});
test('所选调用取消或超时后不再发默认请求', async t => {
  const dir = temp(t); let fallback = 0;
  t.mock.method(choices, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  const runner = t.mock.method(require('../core/feature-agent-run'), 'run', async () => { throw Object.assign(new Error('超时'), { timedOut: true }); });
  const engine = require('../core/help-ask/engine').createHelpAskEngine({ dataDir: dir, findCommand: () => 'fixture', manualPath: () => 'manual', readManual: () => '', runOnce: async () => { fallback++; return { code: 0, stdout: '' }; } });
  assert.equal((await engine.ask({ question: '问题' })).timedOut, true); assert.equal(fallback, 0);
  const controller = new AbortController();
  runner.mock.mockImplementation(async () => { controller.abort(); throw Object.assign(new Error('已取消'), { aborted: true }); });
  assert.equal((await engine.ask({ question: '问题', signal: controller.signal })).cancelled, true); assert.equal(fallback, 0);
});
test('库地图所选后端失败标 channelDown，同次更新多批不重复调用，主动新更新才能重试', async t => {
  const dir = temp(t); let calls = 0;
  t.mock.method(choices, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async () => { calls++; throw new Error('Not logged in'); });
  const channel = require('../core/company-assistant/ppt-map-model').createCodeAgentChannel({ dataDir: dir });
  for (let batch = 0; batch < 3; batch++) await assert.rejects(() => channel.run('分类'), e => e.channelDown && /规则分类/.test(e.message));
  assert.equal(calls, 1); assert.match(channel.reason(), /Not logged in/);
  await channel.probe(); await assert.rejects(() => channel.run('主动更新'), e => e.channelDown); assert.equal(calls, 2);
});
test('库地图用户取消仍是取消，不转成规则失败或封住后续调用', async t => {
  const dir = temp(t), controller = new AbortController();
  t.mock.method(choices, 'resolve', () => ({ selected: { kind: 'claude', model: 'haiku' } }));
  t.mock.method(require('../core/feature-agent-run'), 'run', async () => { controller.abort(); throw new Error('已取消'); });
  const channel = require('../core/company-assistant/ppt-map-model').createCodeAgentChannel({ dataDir: dir });
  await assert.rejects(() => channel.run('分类', { signal: controller.signal }), e => e.aborted && !e.channelDown);
});
test('明确登录元数据和新 401 立即报错，旧错误基线与未确认输出不误判', () => {
  let meta = { connectionIssue: { code: 'auth_required' } }, screen = { text: '' }, api = null;
  const reader = require('../core/feature-agent-session-failure').createReader({ getSession: () => meta, readTerminalScreen: () => screen, readTurnApiError: () => api });
  assert.match(reader.read('sid'), /登录/);
  meta = {}; api = { id: 'old', text: 'API Error: 401 Unauthorized' };
  assert.equal(reader.read('sid', 'old'), ''); assert.match(reader.read('sid'), /登录/);
  api = null; screen = { text: 'Please run /login', activity: 1 };
  assert.equal(reader.read('sid'), ''); screen.activity = 2; assert.equal(reader.read('sid'), '');
  assert.match(reader.read('sid'), /登录/);
  screen.text = '正在回答'; assert.equal(reader.read('sid'), '');
});
test('助理启动阶段已知鉴权失败不再进入 sendPrompt 或分钟级重试', async () => {
  const { CompanyAssistant } = require('../core/company-assistant/service'); let sends = 0;
  const a = { now: Date.now, deps: { sendPrompt: async () => { sends++; } }, sessionGone: () => 'Agent 尚未登录' };
  await assert.rejects(() => CompanyAssistant.prototype.sendWhenReady.call(a, {}, 'sid', '问题'), /登录/); assert.equal(sends, 0);
});
test('分身和文字任务登录失败立即停止，未提交材料', async t => {
  const { AgentSessions } = require('../core/avatar/agent-session'); let sends = 0;
  const deps = { getSession: () => ({ connectionIssue: { code: 'auth_required' } }), sendPrompt: async () => { sends++; }, lastFinal: () => null };
  await assert.rejects(() => new AgentSessions(deps).ask({ id: 'sid' }, 'question.json'), /登录/); assert.equal(sends, 0);
  const dir = temp(t); let created = false;
  const tasks = new (require('../core/company-ai-tasks').CompanyAiTasks)({ dataDir: dir, getSession: () => created ? { connectionIssue: { code: 'auth_required' } } : null,
    createSession: async (_kind, opts) => { created = true; return { id: opts.id }; }, sendPrompt: async () => { sends++; }, closeSession: async () => {} });
  await assert.rejects(() => tasks.run({ text: '材料' }), /登录/); tasks.close(); assert.equal(sends, 0);
});
test('论坛和会议先报登录失败，再判断会话忙，不空等五分钟', async () => {
  const { CompanyForum } = require('../core/company-forum/service'); let reason = '';
  await CompanyForum.prototype.collectJob.call({ job: { sessionId: 'sid', sentAt: 1 }, deps: { getSession: () => ({ connectionIssue: { code: 'auth_required' } }) },
    lastFinal: () => null, sessionBusy: () => { throw new Error('不应先等忙状态'); }, finishSummary: (_job, _text, error) => { reason = error; } });
  assert.match(reason, /登录/);
  const { MeetingCompanion } = require('../core/company-assistant/meeting'); reason = '';
  await MeetingCompanion.prototype.collect.call({ a: { lastFinal: () => null, sessionGone: () => 'Agent 尚未登录', sessionBusy: () => { throw new Error('不应等待'); } },
    lane: () => ({}), fail: (_id, error) => { reason = error.message; } }, { id: 'meeting', job: { sessionId: 'sid' } });
  assert.match(reason, /登录/);
});
test('终态正文提到登录错误不当成鉴权横幅，未知终端读取故障继续等待', async () => {
  const reader = require('../core/feature-agent-session-failure').createReader({ getSession: () => ({}), readTerminalScreen: () => { throw Error('screen unavailable'); } });
  assert.equal(reader.read('sid'), '');
  const { CompanyForum } = require('../core/company-forum/service'); let accepted;
  await CompanyForum.prototype.collectJob.call({ job: { sessionId: 'sid', sentAt: 1, baseline: 'old' }, lastFinal: () => ({ id: 'new', text: '原文说 Not logged in' }),
    launchFailures: { read: () => { throw new Error('终态已确认，不应判横幅'); } }, sessionBusy: () => false,
    finishSummary: (_job, text, error) => { accepted = { text, error }; } });
  assert.equal(accepted.text, '原文说 Not logged in'); assert.equal(accepted.error, null);
});
