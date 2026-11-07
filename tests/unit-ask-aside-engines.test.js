'use strict';
// 问一下 · Claude Code / Codex / DSH 终端会话（2026-11-07）。CodeAgent 的原有行为见 unit-ask-aside-service.test.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAskAsideService, buildArgs } = require('../main/ask-aside/service');
const { DshCliSession } = require('../core/dsh-cli-session');
const { buildCodexSideArgs, codexSideHomes } = require('../core/ask-aside-codex');
const CC = '0f1d0937-bf2e-4347-9348-56b3a37ff7bc', CX = '019a0000-1111-7222-8333-444455556666';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-aside-eng-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { sessions, entries, run, runCodex, hasHistory = () => true }) {
  const dataDir = tmp(t);
  const sessionManager = { getSession: id => sessions[id] || null, sessions: new Map(Object.entries(entries)),
    writeToSession: () => { throw Error('问一下不能往终端打字'); } };
  return createAskAsideService({ sessionManager, getHubDataDir: () => dataDir, run, runCodex, hasHistory,
    resolveConfig: () => { throw Error('非 CodeAgent 会话不该读 CodeAgent 配置'); }, resolveMode: () => ({ input: 'stdin' }) });
}

test('Claude Code 后台分叉：不带 CodeAgent 专有开关、不起 MCP，用终端启动时的环境与模型', async t => {
  assert.deepEqual(buildArgs(CC, { model: 'GLM-5.2-WX', flavor: 'claude' }),
    ['--print', '--resume', CC, '--fork-session', '--no-session-persistence', '--output-format', 'text', '--permission-mode', 'default', '--strict-mcp-config', '--model', 'GLM-5.2-WX']);
  assert.ok(buildArgs(CC).includes('--skip-safe-check'));
  const cwd = tmp(t), calls = [];
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'k.s', ANTHROPIC_MODEL: 'GLM-5.2-WX', CLAUDE_CONFIG_DIR: path.join(cwd, 'cfg') };
  const svc = fixture(t, { sessions: { s: { kind: 'claude', agentRuntime: 'pty', ccSessionId: CC, cwd } },
    entries: { s: { pty: {}, askAsideEnv: env } }, run: async opts => { calls.push(opts); return { answer: '在跑测试' }; } });
  assert.deepEqual(svc.support('s'), { supported: true, reason: '', account: '', engine: 'claude' });
  svc.ask({ sessionId: 's', question: '现在卡在哪？' }); await svc.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.flavor, 'claude'); assert.equal(calls[0].config.command, 'claude');
  assert.equal(calls[0].config.configDir, env.CLAUDE_CONFIG_DIR);
  assert.equal(calls[0].env, env); assert.equal(calls[0].model, 'GLM-5.2-WX'); assert.equal(calls[0].ccSessionId, CC);
  assert.deepEqual(svc.list('s').items.map(i => [i.engine, i.status, i.a]), [['claude', 'done', '在跑测试']]);
});

test('不能问的情况各有人话原因：原生后端、终端没开、旧版打开、还没聊过、没有记录', t => {
  const cwd = tmp(t), env = {}, missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const svc = fixture(t, { hasHistory: id => id !== missing, sessions: {
    native: { kind: 'claude', agentRuntime: null, runtimeBackend: 'claude-stream-json', ccSessionId: CC, cwd },
    closed: { kind: 'codex', agentRuntime: 'pty', codexSid: CX, cwd },
    old: { kind: 'claude', agentRuntime: 'pty', ccSessionId: CC, cwd },
    fresh: { kind: 'codex-resume', agentRuntime: 'pty', cwd },
    nohist: { kind: 'claude', agentRuntime: 'pty', ccSessionId: missing, cwd },
    shell: { kind: 'powershell', cwd } },
  entries: { native: { pty: {} }, closed: { pty: {}, confirmedExit: {} }, old: { pty: {} }, fresh: { pty: {}, askAsideEnv: env }, nohist: { pty: {}, askAsideEnv: env } } });
  assert.match(svc.support('native').reason, /只支持 Claude Code 终端会话/);
  assert.match(svc.support('closed').reason, /Codex 终端没在运行/);
  assert.match(svc.support('old').reason, /旧版 Hub 打开的/);
  assert.match(svc.support('fresh').reason, /还没聊过/);
  assert.match(svc.support('nohist').reason, /没找到这个会话的记录/);
  assert.match(svc.support('shell').reason, /支持 CodeAgent、Claude Code、Codex 和 DSH/);
});

test('Codex 用终端启动时的环境（公司模型代理的 CODEX_HOME 与会话 Key）在后台只读分叉', async t => {
  const env = { CODEX_HOME: 'D:/hub/codex-company-proxy', AI_HUB_COMPANY_MODEL_KEY: 'k.s' };
  assert.deepEqual(codexSideHomes({ codexRuntimeHome: 'D:/other' }, 'C:/home', env), { home: env.CODEX_HOME, sqliteHome: env.CODEX_HOME });
  const args = buildCodexSideArgs({ session: { codexSid: CX, cwd: 'D:/w', currentModel: { id: 'GLM-5.2-WX' } }, outputFile: 'o.md' });
  assert.ok(args.includes('--ephemeral') && args.includes('read-only'));
  assert.deepEqual(args.slice(-3), ['fork', CX, '-']);
  assert.equal(args[args.indexOf('-m') + 1], 'GLM-5.2-WX');
  const seen = [];
  const svc = fixture(t, { sessions: { s: { kind: 'codex', agentRuntime: 'pty', codexSid: CX, cwd: 'D:/w' } },
    entries: { s: { pty: {}, askAsideEnv: env } }, runCodex: async opts => { seen.push(opts); return { answer: '在改配置', truncated: false }; } });
  assert.equal(svc.support('s').engine, 'codex');
  svc.ask({ sessionId: 's', question: '在干嘛' }); await svc.drain();
  assert.equal(seen[0].env, env); assert.equal(seen[0].session.codexSid, CX); assert.equal(seen[0].question, '在干嘛');
  assert.equal(svc.list('s').items[0].a, '在改配置');
});

test('DSH 走进程里的旁问通道，同一会话按顺序问，不碰终端输入', async t => {
  const gate = deferred(), questions = [];
  const pty = { askSide: async q => { questions.push(q); if (questions.length === 1) await gate.promise; return { answer: 'A:' + q }; } };
  const svc = fixture(t, { sessions: { s: { kind: 'deepseek-acp', agentRuntime: 'pty' } }, entries: { s: { pty } } });
  assert.equal(svc.support('s').engine, 'dsh');
  svc.ask({ sessionId: 's', question: '一' }); svc.ask({ sessionId: 's', question: '二' });
  await tick(); await tick();
  assert.deepEqual(questions, ['一']);
  gate.resolve(); await svc.drain(); await svc.drain();
  assert.deepEqual(svc.list('s').items.map(i => [i.engine, i.status, i.a]), [['dsh', 'done', 'A:一'], ['dsh', 'done', 'A:二']]);
});

test('DshCliSession.askSide 写问题文件、按编号认回答；出错与断开都会结束等待', async t => {
  const home = tmp(t);
  const session = new DshCliSession({ home, id: 'x', launch: { args: [] } });
  await assert.rejects(session.askSide('早了'), /未连接/);
  session.runtime.connection = 'connected'; session.threadId = 'thread-1';
  const pending = session.askSide('暗号？', { timeoutMs: 30000 });
  const files = fs.readdirSync(session.askDir).filter(name => name.endsWith('.ask.json'));
  assert.equal(files.length, 1);
  const request = JSON.parse(fs.readFileSync(path.join(session.askDir, files[0]), 'utf8'));
  assert.equal(request.question, '暗号？');
  session.observe({ type: 'btw', id: 'someone-else', answer: '不是这条' });
  session.observe({ type: 'btw', id: request.id, answer: '蓝鲸-7' });
  assert.deepEqual(await pending, { answer: '蓝鲸-7' });
  const failing = session.askSide('再问', { timeoutMs: 30000 });
  const second = JSON.parse(fs.readFileSync(path.join(session.askDir, fs.readdirSync(session.askDir).find(n => n.endsWith('.ask.json') && n !== files[0])), 'utf8'));
  session.observe({ type: 'btw', id: second.id, error: 'DSH 模型服务不可用' });
  await assert.rejects(failing, /模型服务不可用/);
  const dropped = session.askSide('断开前', { timeoutMs: 30000 });
  session.fail(new Error('DSH CLI 已退出'));
  await assert.rejects(dropped, /已断开/);
  assert.equal(session.sideAsks.size, 0);
  session.dispose();
});
