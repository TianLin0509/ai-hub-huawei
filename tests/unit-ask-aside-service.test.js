'use strict';
// 「问一下」公司版主进程服务：后台 --print --resume --fork-session --no-session-persistence 单次问答（text 输出），
// 问题以 UTF-8 字节走标准输入，账号与模型跟随会话（公司回执 Q-1104-06）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createAskAsideService, runAsk, buildArgs, cleanAnswer, resolveAskMode, argQuestion, sessionModel, PREAMBLE } = require('../main/ask-aside/service');

const CC = '0f1d0937-bf2e-4347-9348-56b3a37ff7bc';
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-aside-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = ''; const chunks = [];
    child.stdin = new PassThrough();
    child.stdin.on('data', d => { chunks.push(d); input += d; });
    child.kill = () => { child.emit('close', null); };
    calls.push({ file, args, opts, get input() { return input; }, get raw() { return Buffer.concat(chunks); }, child });
    child.stdin.on('finish', () => setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      if (!hang) setImmediate(() => child.emit('close', code));
    }));
    return child;
  };
  return { spawnFn, calls };
}

const config = dir => ({ command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir });

test('只用公司实测过的参数；Windows 下经 cmd 调用，问题不进命令行而走标准输入', async t => {
  const dir = tmp(t), { spawnFn, calls } = fakeSpawn({ stdout: '扩展初始化中：C:\\x\\ext.mjs\n卡在接口联调，等 m2 的字段表。' });
  const question = '现在卡在哪？ "a" & %PATH% | <b> ^c';
  const result = await runAsk({ config: config(dir), cwd: dir, ccSessionId: CC, question, spawnFn, platform: 'win32', model: 'GLM-5.2-WX-Auto',
    env: { PATH: 'x', CLAUDE_HUB_SESSION_ID: 'hub-1', CLAUDE_HUB_TOKEN: 'secret', CODEAGENT_HUB_X: '1', CODEAGENT3_LAUNCHER_PID: '9' } });
  assert.equal(result.answer, '卡在接口联调，等 m2 的字段表。');
  const call = calls[0];
  assert.equal(call.file, 'cmd.exe');
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.windowsVerbatimArguments, true);
  assert.equal(call.opts.cwd, dir);
  const line = call.args.join(' ');
  for (const flag of ['--print', `--resume ${CC}`, '--fork-session', '--no-session-persistence', '--output-format text', '--permission-mode default', '--model GLM-5.2-WX-Auto'])
    assert.ok(line.includes(flag), flag);
  assert.ok(!line.includes('PATH%') && !line.includes('现在卡在哪'), '问题不能出现在命令行');
  assert.equal(call.input, PREAMBLE + question);
  assert.ok(Buffer.isBuffer(call.raw) && call.raw.equals(Buffer.from(PREAMBLE + question, 'utf8')), '问题以 UTF-8 字节写入标准输入');
  assert.equal(call.opts.env.CODEAGENT3_CONFIG_DIR, dir);
  for (const key of ['CLAUDE_HUB_SESSION_ID', 'CLAUDE_HUB_TOKEN', 'CODEAGENT_HUB_X', 'CODEAGENT3_LAUNCHER_PID']) assert.equal(key in call.opts.env, false, key);
  assert.deepEqual(buildArgs(CC).slice(0, 5), ['--print', '--resume', CC, '--fork-session', '--no-session-persistence']);
});

test('会话记录编号不是 UUID 时不启动进程', async t => {
  const { spawnFn, calls } = fakeSpawn();
  await assert.rejects(runAsk({ config: config(tmp(t)), cwd: '.', ccSessionId: 'abc & del', question: 'q', spawnFn }), /编号无效/);
  assert.equal(calls.length, 0);
});

test('超时按进程树结束，并保留已收到的部分答案', async t => {
  const { spawnFn, calls } = fakeSpawn({ stdout: '先说一半', hang: true });
  const killed = [];
  const pending = runAsk({ config: config(tmp(t)), cwd: '.', ccSessionId: CC, question: 'q', spawnFn, platform: 'win32', timeoutMs: 50,
    killTree: pid => { killed.push(pid); setImmediate(() => calls[0].child.emit('close', 1)); } });
  await assert.rejects(pending, error => /超过 0 秒|没答完/.test(error.message) && error.answer === '先说一半');
  assert.deepEqual(killed, [4321]);
});

test('非零退出给出可读原因', async t => {
  const { spawnFn } = fakeSpawn({ stderr: 'No conversation found with session ID\n', code: 1 });
  await assert.rejects(runAsk({ config: config(tmp(t)), cwd: '.', ccSessionId: CC, question: 'q', spawnFn, platform: 'linux' }), /退出码 1.*No conversation found/);
});

function serviceFixture(t, { sessions = {}, run, hasHistory = () => true } = {}) {
  const dataDir = tmp(t), events = [];
  const poolDirs = {};
  const sessionManager = { getSession: id => sessions[id] || null };
  const svc = createAskAsideService({ sessionManager, getHubDataDir: () => dataDir,
    sendToRenderer: (channel, payload) => events.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }),
    resolveConfig: () => config(path.join(dataDir, 'personal')),
    accountDir: id => { const dir = path.join(dataDir, 'pool', id); poolDirs[id] = dir; return dir; },
    hasHistory, run, streamThrottleMs: 0, resolveMode: () => ({ input: 'stdin' }) });
  return { svc, dataDir, events, poolDirs };
}

test('只支持有记录的 CodeAgent 会话，原因可读', t => {
  const cwd = tmp(t);
  const { svc } = serviceFixture(t, { sessions: {
    a: { kind: 'powershell', cwd }, b: { kind: 'codeagent', cwd }, c: { kind: 'codeagent', cwd, ccSessionId: CC },
    d: { kind: 'codeagent-resume', cwd, ccSessionId: CC, codeagentPoolAccount: 'acc2' } } });
  assert.match(svc.support('none').reason, /请先打开/);
  assert.match(svc.support('a').reason, /只支持 CodeAgent/);
  assert.match(svc.support('b').reason, /还没聊过/);
  assert.equal(svc.support('c').supported, true);
  assert.equal(svc.support('c').account, '个人账号');
  assert.equal(svc.support('d').account, '号池账号', '号池里查不到这个号时写泛称，不报错');
  assert.match(svc.support('d').reason, /号池账号已被移除/);
  const noHistory = serviceFixture(t, { sessions: { c: { kind: 'codeagent', cwd, ccSessionId: CC } }, hasHistory: () => false });
  assert.match(noHistory.svc.support('c').reason, /没找到这个会话的记录/);
});

test('提问：账号与模型跟随会话、不推中间片段、落盘历史；同一会话按顺序答', async t => {
  const cwd = tmp(t), seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = async ({ config: cfg, cwd: runCwd, ccSessionId, question, mode, model, onChunk }) => {
    seen.push({ dir: cfg.configDir, cwd: runCwd, ccSessionId, question, mode, model, onChunk });
    if (seen.length === 1) await gate;
    return { answer: `答：${question}`, truncated: false };
  };
  const fx = serviceFixture(t, { sessions: { s1: { kind: 'codeagent', cwd, ccSessionId: CC, codeagentPoolAccount: 'acc2', currentModel: { id: 'GLM-5.2-WX-Auto' } } }, run });
  fs.mkdirSync(path.join(fx.dataDir, 'pool', 'acc2'), { recursive: true });
  const first = fx.svc.ask({ sessionId: 's1', question: '现在卡在哪？' });
  fx.svc.ask({ sessionId: 's1', question: '还要多久？' });
  assert.equal(first.status, 'queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 1, '第二问要等第一问答完');
  assert.equal(seen[0].dir, path.join(fx.dataDir, 'pool', 'acc2'));
  assert.equal(seen[0].cwd, cwd);
  assert.deepEqual(seen[0].mode, { input: 'stdin' });
  assert.equal(seen[0].model, 'GLM-5.2-WX-Auto', '显式传会话当前模型');
  assert.equal(seen[0].onChunk, undefined, 'text 输出没有真流式，不推中间片段');
  assert.ok(fx.events.some(e => e.payload.items[0].status === 'running' && e.payload.items[0].a === '' && e.payload.items[0].startedAt));
  release();
  await fx.svc.drain();
  assert.equal(seen.length, 2);
  const items = fx.svc.list('s1').items;
  assert.deepEqual(items.map(i => [i.status, i.a]), [['done', '答：现在卡在哪？'], ['done', '答：还要多久？']]);
  const saved = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'ask-aside', 's1.json'), 'utf8'));
  assert.equal(saved.items.length, 2);
  assert.ok(fx.events.every(e => e.channel === 'ask-aside:changed'));
});

test('失败记进历史并保留部分答案；重开 Hub 后排队/进行中的变成中断', async t => {
  const cwd = tmp(t);
  const run = async () => { throw Object.assign(new Error('超过 120 秒没答完，已停止'), { answer: '半句' }); };
  const fx = serviceFixture(t, { sessions: { s1: { kind: 'codeagent', cwd, ccSessionId: CC } }, run });
  fx.svc.ask({ sessionId: 's1', question: 'q' });
  await fx.svc.drain();
  const [item] = fx.svc.list('s1').items;
  assert.equal(item.status, 'error'); assert.equal(item.a, '半句'); assert.match(item.error, /120 秒/);
  const file = path.join(fx.dataDir, 'ask-aside', 's1.json');
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'x', q: 'q', a: '', status: 'running' }] }));
  const again = createAskAsideService({ sessionManager: { getSession: () => ({ kind: 'codeagent', cwd, ccSessionId: CC }) },
    getHubDataDir: () => fx.dataDir, resolveConfig: () => config(cwd), hasHistory: () => true, run });
  assert.equal(again.list('s1').items[0].status, 'error');
});

test('输入校验与排队上限；关闭时不再接新问题', async t => {
  const cwd = tmp(t);
  let hold; const gate = new Promise(resolve => { hold = resolve; });
  const fx = serviceFixture(t, { sessions: { s1: { kind: 'codeagent', cwd, ccSessionId: CC } }, run: async () => { await gate; return { answer: 'ok' }; } });
  assert.throws(() => fx.svc.ask({ sessionId: 's1', question: '  ' }), /有效问题/);
  assert.throws(() => fx.svc.ask({ sessionId: 's1', question: 'a\x1bb' }), /有效问题/);
  for (let i = 0; i < 20; i++) fx.svc.ask({ sessionId: 's1', question: 'q' + i });
  assert.throws(() => fx.svc.ask({ sessionId: 's1', question: 'q21' }), /排队/);
  hold();
  await fx.svc.dispose();
  assert.throws(() => fx.svc.ask({ sessionId: 's1', question: 'later' }), /正在关闭/);
});

test('Windows 真实 cmd 链路：.cmd 包装下中文与特殊字符原样经标准输入送达', { skip: process.platform !== 'win32' }, async t => {
  const dir = tmp(t), bin = path.join(dir, 'bin dir');
  fs.mkdirSync(bin);
  const echo = path.join(bin, 'echo-cli.js');
  fs.writeFileSync(echo, "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:s,hex:Buffer.from(s,'utf8').toString('hex'),dir:process.env.CODEAGENT3_CONFIG_DIR,hub:process.env.CLAUDE_HUB_SESSION_ID||null}))});");
  const cmd = path.join(bin, 'codeagent.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
  const question = '为什么改成 20ms？ "引号" & %PATH% | <尖括号> ^ 100%';
  const { answer } = await runAsk({ config: { command: cmd, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir }, cwd: dir, ccSessionId: CC, question,
    env: { ...process.env, CLAUDE_HUB_SESSION_ID: 'hub-1' } });
  const got = JSON.parse(answer);
  assert.equal(got.input, PREAMBLE + question);
  // 字节级：子进程收到的标准输入与问题的 UTF-8 编码逐字节相同（公司回执：经 PowerShell 管道中文会变成 ?????）
  assert.equal(got.hex, Buffer.from(PREAMBLE + question, 'utf8').toString('hex'));
  assert.ok(!got.input.includes('?'.repeat(3)));
  assert.deepEqual(got.args, buildArgs(CC));
  assert.equal(got.dir, dir);
  assert.equal(got.hub, null);
});

test('兜底开关：环境变量优先于 Hub 配置，取值不认识时用默认 stdin；输出固定 text、始终不落盘', () => {
  assert.deepEqual(resolveAskMode({}, {}), { input: 'stdin' });
  assert.deepEqual(resolveAskMode({}, { askAside: { input: 'arg' } }), { input: 'arg' });
  assert.deepEqual(resolveAskMode({ AI_HUB_ASK_ASIDE_INPUT: 'STDIN' }, { askAside: { input: 'arg' } }), { input: 'stdin' });
  assert.deepEqual(resolveAskMode({ AI_HUB_ASK_ASIDE_INPUT: 'bogus' }, { askAside: { input: 'x' } }), { input: 'stdin' });
  for (const args of [buildArgs(CC), buildArgs(CC, { model: 'm' })]) {
    const line = args.join(' ');
    assert.ok(line.includes('--output-format text') && !line.includes('stream-text'));
    assert.ok(args.includes('--no-session-persistence') && args.includes('--fork-session'), '公司回执：不带它会往原会话追加问答');
  }
});

test('模型：用会话当前模型，没有就用账号 settings.json 的；不安全的模型名不进命令行', t => {
  const dir = tmp(t);
  assert.equal(sessionModel({ currentModel: { id: 'GLM-5.2-WX-Auto' } }, dir), 'GLM-5.2-WX-Auto');
  assert.equal(sessionModel({ currentModel: { id: '' } }, dir), '');
  fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ model: 'deepseek-v4-flash-0731' }));
  assert.equal(sessionModel({ currentModel: { id: '' } }, dir), 'deepseek-v4-flash-0731');
  assert.equal(sessionModel({ currentModel: { id: 'x & del' } }, dir), 'deepseek-v4-flash-0731');
  assert.deepEqual(buildArgs(CC, { model: 'GLM-5.2-WX-Auto' }).slice(-2), ['--model', 'GLM-5.2-WX-Auto']);
  assert.ok(!buildArgs(CC, { model: 'a & b' }).includes('--model'));
  assert.ok(!buildArgs(CC).includes('--model'));
});

test('兜底模式：问题放命令行末尾，去掉 cmd 特殊字符与换行后整体加引号，标准输入为空；过长直接拒绝', async t => {
  const { spawnFn, calls } = fakeSpawn({ stdout: '\x1b[32m好的\x1b[0m，正在联调。' });
  const question = '现在卡在哪？\n"a" & %PATH% | <b> ^c !d';
  const result = await runAsk({ config: config(tmp(t)), cwd: '.', ccSessionId: CC, question, spawnFn, platform: 'win32', mode: { input: 'arg' } });
  assert.equal(result.answer, '好的，正在联调。', '颜色码要去掉');
  const line = calls[0].args.join(' ');
  assert.ok(line.includes('--output-format text'));
  assert.ok(line.endsWith(`"${argQuestion(PREAMBLE + question)}""`), '问题在最后，cmd /s 外层引号之内再加一对引号');
  assert.ok(!/[%&|<>^!]/.test(argQuestion(question)) && !argQuestion(question).includes('\n'));
  assert.match(argQuestion(question), /现在卡在哪？ a PATH b c d/);
  assert.equal(calls[0].input, '');
  const { spawnFn: spawn2, calls: calls2 } = fakeSpawn();
  await assert.rejects(runAsk({ config: config(tmp(t)), cwd: '.', ccSessionId: CC, question: '长'.repeat(2100), spawnFn: spawn2, platform: 'win32', mode: { input: 'arg' } }), /兜底模式.*2000/);
  assert.equal(calls2.length, 0);
  assert.equal(cleanAnswer('\x1b[1;34m扩展初始化中：C:\\x\\a.mjs\x1b[0m 答'), '答');
});

test('Windows 真实 cmd 链路·兜底模式：问题作为最后一个参数原样到达（中文保留，特殊字符已去掉）', { skip: process.platform !== 'win32' }, async t => {
  const dir = tmp(t), bin = path.join(dir, 'bin dir');
  fs.mkdirSync(bin);
  const echo = path.join(bin, 'echo-cli.js');
  fs.writeFileSync(echo, "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:s}))});");
  const cmd = path.join(bin, 'codeagent.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
  const question = '为什么改成 20ms？\n第二行 "引号" & %PATH% | <尖括号> ^ 100% (括号)';
  const { answer } = await runAsk({ config: { command: cmd, configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: dir }, cwd: dir, ccSessionId: CC, question, mode: { input: 'arg' }, model: 'GLM-5.2-WX-Auto' });
  const got = JSON.parse(answer);
  assert.deepEqual(got.args, [...buildArgs(CC, { model: 'GLM-5.2-WX-Auto' }), argQuestion(PREAMBLE + question)]);
  assert.match(got.args.at(-1), /为什么改成 20ms？ 第二行 引号 PATH 尖括号 100 \(括号\)$/);
  assert.equal(got.input, '');
});
