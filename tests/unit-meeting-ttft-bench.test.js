'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { stats, options, QUESTIONS, measuredRunner, launchOptions, detectUi, requireUi, sampleDomTiming, recordSendClick, measurementOrigin } = require('../scripts/bench-meeting-ttft');
const { buildIsolatedHubEnv } = require('./helpers/hub-launcher');
const { makeArgs, measure } = require('../scripts/bench-meeting-ttft-cli');
const path = require('node:path');
test('首字基准按材料、档位、模式、题号分组，并保留失败数', () => {
  const base = { material: 'simulation', speed: 'fast', mode: 'fork', questionIndex: 1 };
  const got = stats([{ ...base, ttftMs: 8, totalMs: 12 }, { ...base, ttftMs: 2, totalMs: 14 }, { ...base, ttftMs: null, error: 'failed' }, { ...base, mode: 'fresh', ttftMs: 1, totalMs: 3 }]);
  assert.deepEqual(got['simulation/fast/fork/1'], { ttftMs: { n: 2, median: 5, max: 8 }, totalMs: { n: 2, median: 13, max: 14 }, failures: 1 });
  assert.equal(got['simulation/fast/fresh/1'].ttftMs.median, 1);
});
test('独立 CLI 基准沿用产品参数，fresh 不分叉、预热保留会话、三档不换模型', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const base = { model: 'haiku', format: 'stream-json', effort: 'low', settingsFile: 'test-settings.json' };
  const fresh = makeArgs(id, { ...base, mode: 'fresh' });
  assert.ok(!fresh.includes('--resume') && !fresh.includes('--fork-session'));
  assert.ok(fresh.includes('--no-session-persistence') && fresh.includes('--include-partial-messages'));
  assert.equal(fresh[fresh.indexOf('--model') + 1], 'haiku');
  const fork = makeArgs(id, { ...base, mode: 'fork' }); assert.equal(fork[fork.indexOf('--resume') + 1], id);
  const prime = makeArgs(id, { ...base, prime: true }); assert.ok(prime.includes('--session-id') && !prime.includes('--no-session-persistence'));
  const resume = makeArgs(id, { ...base, resumePrime: true }); assert.ok(resume.includes('--resume') && !resume.includes('--fork-session') && !resume.includes('--no-session-persistence'));
});
test('独立 CLI 计时器读取真实假进程 JSON 增量，最终 assistant 不重复拼接', async () => {
  const fixture = path.join(__dirname, 'fixtures/meeting-ttft-cli.js');
  const result = await measure({ command: process.execPath, args: [fixture, '--output-format', 'stream-json'], prompt: '测试', cwd: __dirname, timeoutMs: 10000 });
  assert.equal(result.error, '');
  assert.equal(result.answer, '模拟回答：已依据会议材料核对结论、数字与负责人。');
  assert.ok(result.firstEventAt <= result.firstTokenAt && result.firstTokenAt < result.endedAt);
});
test('首字基准必须显式选择订阅账号与模型，固定五类会议问题', () => {
  assert.equal(options([]).model, 'fixture');
  assert.throws(() => options(['--model']), /参数/);
  assert.throws(() => options(['--profile', 'oauth-profile', '--model', 'haiku']), /不接收账号配置/);
  assert.throws(() => options(['--repeats', '1']), /至少 2 次/);
  assert.equal(QUESTIONS.length, 5);
});

test('真Claude必须提供运行者目录；默认固定5题×2轮fast/fresh，拒绝假CLI旧基线混算', () => {
  const cfg = path.resolve(__dirname, 'fixtures', 'nonexistent-not-read-claude-dir');
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.throws(() => options(['--real-claude'], {}), /CLAUDE_CONFIG_DIR/);
  assert.throws(() => options(['--real-claude'], { CLAUDE_CONFIG_DIR: 'relative' }), /绝对路径/);
  const args = options(['--real-claude', '--model', 'claude-haiku-4-5'], env);
  assert.equal(args.model, 'claude-haiku-4-5'); assert.equal(args.realClaude, true);
  assert.equal(args.claudeConfigDir, cfg); assert.equal(args.speeds, 'fast'); assert.equal(args.modes, 'fresh');
  assert.equal(QUESTIONS.length * Number(args.repeats || 2), 10);
  for (const extra of [['--baseline-ref', '0186fd5c'], ['--fixture', '1']]) assert.throws(() => options(['--real-claude', ...extra], env), /不能混用/);
  for (const extra of [['--speeds', 'normal'], ['--modes', 'fork']]) assert.throws(() => options(['--real-claude', ...extra], env), /fast.*fresh/);
  assert.throws(() => options(['--real-claude', '--repeats', '1'], env), /至少 2 次/);
  assert.throws(() => options(['--real-claude', '--model', 'fixture'], env), /模型名称无效/);
});

test('真Claude仅放行配置目录，Hub data/home/codex/key等隔离检查仍保留', () => {
  const root = path.join(require('node:os').tmpdir(), 'meeting-ttft-contract-only');
  const data = path.join(root, 'data'), work = path.join(root, 'work'), cfg = path.resolve('external-claude-contract-only');
  const args = options(['--real-claude'], { CLAUDE_CONFIG_DIR: cfg });
  const launch = launchOptions(args, { data, work, cfg, root }, { ANTHROPIC_API_KEY: 'not-a-key-fixture', CLAUDE_CODE_OAUTH_TOKEN: 'not-a-token-fixture' });
  assert.deepEqual(launch.allowExternalState, ['CLAUDE_CONFIG_DIR']); assert.equal(launch.windowMode, 'hidden');
  assert.equal(launch.extraEnv.ANTHROPIC_API_KEY, ''); assert.equal(launch.extraEnv.CLAUDE_CODE_OAUTH_TOKEN, '');
  const build = extra => buildIsolatedHubEnv(data, { ...launch.extraEnv, ...extra }, {}, launch);
  const isolated = build({});
  assert.equal(isolated.CLAUDE_CONFIG_DIR, cfg); assert.equal(isolated.CLAUDE_HUB_DATA_DIR, data);
  for (const key of ['CLAUDE_HUB_HOME_DIR', 'CODEX_HOME', 'CLAUDE_HUB_WRITING_ROOT']) assert.throws(() => build({ [key]: path.resolve('external-other-contract-only') }), /inside the test root/);
  assert.throws(() => build({ CLAUDE_HUB_DATA_DIR: path.resolve('external-data-contract-only') }), /forbids overriding/);
  assert.throws(() => build({ DEEPSEEK_API_KEY: 'not-a-key-fixture' }), /non-empty DEEPSEEK_API_KEY/);
});

test('真Claude测量只监听实际runAsk，不替换命令/输入/答案；首字事件只记一次并保留产品回调', async () => {
  const events = [], chunks = [], processes = [], config = { flavor: 'claude', command: 'actual-claude', configDir: 'not-read' };
  const result = { answer: 'mock contract result' }; let calls = 0;
  const run = measuredRunner(async opts => {
    calls++; assert.equal(opts.config, config); assert.equal(opts.spawnFn, undefined);
    assert.equal(opts.question, '真实传给产品的问题'); assert.equal(opts.context, '模拟会议材料');
    opts.onProcess({ pid: 123, args: ['--model', 'claude-haiku-4-5', '--output-format', 'stream-json'] });
    opts.onChunk('第'); opts.onChunk('二'); return result;
  }, { realClaude: true, model: 'claude-haiku-4-5', fakeCommand: 'must-not-use-fixture' }, (channel, value) => events.push({ channel, value }));
  const opts = { config, model: 'claude-haiku-4-5', fresh: true, stream: true, effort: 'low', thinkingOff: true,
    question: '真实传给产品的问题', context: '模拟会议材料', onChunk: text => chunks.push(text), onProcess: p => processes.push(p) };
  assert.equal(await run(opts), result); assert.equal(calls, 1); assert.deepEqual(chunks, ['第', '二']); assert.equal(processes.length, 1);
  assert.equal(events.filter(e => e.value.firstTokenAt).length, 1);
  assert.equal(events[0].value.execution.outputFormat, 'stream-json');
  assert.equal(events[0].value.execution.argvModel, 'claude-haiku-4-5');
  for (const wrong of [{ fresh: false }, { model: 'wrong' }, { thinkingOff: false }, { stream: false }, { effort: 'high' }]) assert.throws(() => run({ ...opts, ...wrong }), /已拒绝错误接线/);
  assert.equal(calls, 1, '错误接线在启动真实模型前失败');
});

test('旧UI在真实模式前置拒绝；新UI只采流式/完成正文，不采阶段文字或历史答案', () => {
  const legacy = detectUi({ querySelector: s => s === '[data-m="timeline"]' ? {} : null });
  assert.equal(legacy.kind, 'legacy-timeline'); assert.throws(() => requireUi(legacy, true), /未发送任何真实模型问题/);
  const ui = requireUi(detectUi({ querySelector: () => ({}) }), true); assert.equal(ui.kind, 'assistant-tab-stream');
  const timing = { questionId: 'question-fixture' }; let body = null;
  const card = { dataset: { questionState: 'running' }, querySelector: s => { assert.equal(s, '.meeting-chat-a > .meeting-chat-partial, .meeting-chat-a > .meeting-answer-body'); return body; } };
  const doc = { querySelector: s => { assert.equal(s, ui.card + '[data-answer="question-fixture"]'); return card; } };
  sampleDomTiming(timing, doc, ui, 10); assert.equal(timing.domFirstAt, undefined, '单有阶段/问题/历史内容不算首字');
  body = { textContent: '第一段实际增量', hidden: false, classList: { contains: c => c === 'meeting-chat-partial' } };
  sampleDomTiming(timing, doc, ui, 20); assert.equal(timing.domFirstAt, 20); assert.equal(timing.domFirstSource, 'streaming-partial-body');
  card.dataset.questionState = 'done'; sampleDomTiming(timing, doc, ui, 30);
  assert.equal(timing.domFirstAt, 20); assert.equal(timing.domDoneAt, 30);
});

test('产品askMeeting实际选择claude|model，向测量器传递fast/fresh关思考和主进程首字', async t => {
  const fs = require('node:fs'), { randomUUID } = require('node:crypto');
  const { createAskAsideService, buildArgs } = require('../main/ask-aside/service');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '20261124-ttft-contract-m2-'));
  const model = 'claude-haiku-4-5', sessionId = randomUUID(), meetingId = randomUUID(), questionId = randomUUID();
  const session = { id: sessionId, ccSessionId: randomUUID(), kind: 'claude', cwd: root, agentRuntime: 'pty', currentModel: { id: model } };
  let actual;
  const run = measuredRunner(async opts => {
    actual = opts;
    opts.onProcess({ pid: 999, args: buildArgs('', { ...opts, flavor: opts.config.flavor }) });
    opts.onChunk('仅单测模拟输出'); return { answer: '仅单测模拟输出' };
  }, { realClaude: true, model }, () => {});
  const service = createAskAsideService({ getHubDataDir: () => root,
    sessionManager: { getSession: () => session, sessions: new Map([[sessionId, { pty: {}, askAsideEnv: { CLAUDE_CONFIG_DIR: root } }]]) },
    getSessionMetadata: () => session, findCommand: () => 'contract-claude', hasHistory: () => true,
    resolveClaudeProfile: () => { throw Error('不应读取账号库'); }, run, sendToRenderer: () => {},
  });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = service.askMeeting({ sessionId, meetingId, questionId, question: '会中决定了什么？', context: '仅模拟会议材料',
    engine: `claude|${model}`, model, speed: 'fast', mode: 'fresh', cwd: root });
  await service.drain();
  const result = service.meetingResult({ sessionId, meetingId, id: request.id });
  assert.equal(result.status, 'done'); assert.equal(actual.config.command, 'contract-claude');
  assert.equal(actual.model, model); assert.equal(actual.fresh, true); assert.equal(actual.thinkingOff, true);
  assert.equal(actual.stream, true); assert.equal(actual.effort, 'low'); assert.equal(actual.context, '仅模拟会议材料');
  const live = service.meetingLive({ meetingId, questionId });
  assert.ok(Number.isFinite(live.firstTokenAt)); assert.equal(actual.config.flavor, 'claude');
});

test('实际发送click才记录起点；真实模式不以IPC时刻补缺，假CLI保留原IPC口径', () => {
  const timing = { submittedAt: 130, deliveredAt: 150 };
  const event = (button, isTrusted = true) => ({ isTrusted, target: { closest: selector => { assert.equal(selector, '[data-act="ask"]'); return button; } } });
  recordSendClick(event(null), timing, 70); // 例如切换tab或点输入框。
  recordSendClick(event({ disabled: true }), timing, 80);
  recordSendClick(event({ disabled: false }, false), timing, 90); // 脚本dispatchEvent不是实际发送。
  assert.equal(timing.clickedAt, undefined);
  assert.throws(() => measurementOrigin(timing, true), /缺少实际发送点击clickedAt.*不能用IPC/);
  assert.equal(measurementOrigin(timing, false), 130);
  recordSendClick(event({ disabled: false }), timing, 100); // 含按钮内图标通过closest匹配。
  recordSendClick(event({ disabled: false }), timing, 110);
  assert.equal(timing.clickedAt, 100, '记录本题第一次实际发送点击');
  assert.equal(measurementOrigin(timing, true), 100);
  assert.equal(measurementOrigin(timing, false), 130, '假CLI不改变历史比较口径');
  assert.equal(200 - measurementOrigin(timing, true), 100, '真实TTFT包含点击至IPC的30毫秒');
});
