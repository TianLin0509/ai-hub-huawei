'use strict';
// CodeAgent ACP 试点：用按公司真机 1.2615.02.03 抓取格式回放事件的假 serve，走完整卡片驱动。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CodeAgentServeSession } = require('../core/codeagent-serve-session');
const { usesServeRuntime, normalizeRunMode, withRunModeInJson } = require('../core/codeagent-run-mode');

const SID = '73ef6af8-c06d-4619-988b-ea0f99968c2f';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await wait(5); }
  throw new Error('等待超时：' + label);
}

class FakeServe extends EventEmitter {
  constructor() {
    super();
    this.streams = new Set();
    this.calls = [];
    this.onPrompt = () => {};
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.token = 'fake-token';
    this.proc = { pid: 4242 };
    this.refs = 0;
  }
  async listen() { await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.port = this.server.address().port; }
  get pid() { return this.proc.pid; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async ensure() { return this; }
  release() { this.refs -= 1; }
  send(type, properties) { const frame = `data: ${JSON.stringify({ type, properties: { sessionID: SID, ...properties } })}\n\n`; for (const s of this.streams) s.write(frame); }
  crash() { for (const s of this.streams) s.destroy(); this.streams.clear(); }
  async close() { this.crash(); this.server.closeAllConnections?.(); await new Promise(resolve => this.server.close(resolve)); }
  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      this.calls.push({ method: req.method, path: url.pathname, body });
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/v2/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); this.streams.add(res); return; }
      if (req.method === 'POST' && url.pathname === '/api/v2/session') return json(200, { id: SID, model: { providerID: 'w3', id: 'deepseek-v4.1-flash-1017' } });
      if (req.method === 'GET' && url.pathname === `/api/v2/session/${SID}`) return json(200, { id: SID, model: { providerID: 'w3', id: 'deepseek-v4.1-flash-1017' } });
      if (url.pathname.endsWith('/prompt_async')) { json(202, {}); setImmediate(() => this.onPrompt(body)); return; }
      if (url.pathname.endsWith('/abort')) { json(200, {}); setImmediate(() => { this.send('session.error', { error: { name: 'MessageAbortedError', message: 'Request was aborted.' }, result: 'aborted' }); this.idle(); }); return; }
      if (/\/(permission|question)\/.+\/(reply|reject)$/.test(url.pathname)) return json(200, true);
      json(404, {});
    });
  }
  busy() { this.send('session.status', { status: { type: 'busy' } }); }
  idle() { this.send('session.idle', { runningSubagents: 0 }); this.send('session.status', { status: { type: 'idle' } }); }
  reply(text, messageID = 'msg_1') {
    this.send('message.part.updated', { part: { id: 'prt_0', messageID, type: 'text', text: '' } });
    this.send('message.part.delta', { messageID, partID: 'block_0', field: 'text', delta: text.slice(0, 2) });
    this.send('message.part.delta', { messageID, partID: 'block_0', field: 'text', delta: text.slice(2) });
    this.send('message.part.updated', { part: { id: 'prt_0', messageID, type: 'text', text } });
  }
}

async function setup(t, extra = {}) {
  const serve = new FakeServe();
  await serve.listen();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-session-'));
  const terminals = [];
  const session = new CodeAgentServeSession({ id: 'hub-1', kind: 'codeagent', cwd: storeDir, host: serve, model: 'deepseek-v4.1-flash-1017', provider: 'w3',
    permissionMode: 'default', profileId: 'codeagent-serve', storeDir, launch: { env: {} },
    spawnTerminal: options => {
      const term = new EventEmitter();
      Object.assign(term, { options, written: [], onData: fn => term.on('data', fn), onExit: fn => term.on('exit', fn), write: data => term.written.push(data), resize: (c, r) => { term.size = [c, r]; }, kill: () => { term.killed = true; term.emit('exit', {}); } });
      terminals.push(term);
      return term;
    }, ...extra });
  session.on('action-error', () => {});
  t.after(async () => { try { session.kill(); } catch {} await serve.close(); fs.rmSync(storeDir, { recursive: true, force: true }); });
  await session.start();
  return { serve, session, terminals };
}
const lastTurn = session => [...session.history.values()].at(-1);
const agentText = session => (session.active ? [...session.items.values()] : lastTurn(session).items).filter(item => item.type === 'agentMessage').map(item => item.text).join('');

test('普通一轮：增量和收尾全文不重复，结束信号来自 serve', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('你好世界'); serve.idle(); };
  await session.send('只回复你好');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(agentText(session), '你好世界');
  assert.equal(lastTurn(session).status, 'completed');
});

test('上一轮残留的空闲信号不会提前结束下一轮', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.idle(); serve.busy(); serve.reply('完整回答'); serve.idle(); };
  await session.send('测试');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(agentText(session), '完整回答');
});

test('工具调用显示在卡片上，完成后带输出', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => {
    serve.busy();
    serve.send('message.part.updated', { part: { id: 'prt_x', messageID: 'msg_2', type: 'tool', tool: 'Bash', callID: 'call-1', state: { status: 'running', input: {} } } });
    serve.send('message.part.updated', { part: { id: 'prt_x', messageID: 'msg_2', type: 'tool', tool: 'Bash', callID: 'call-1', state: { status: 'completed', input: { command: 'echo pilot' }, output: 'pilot' } } });
    serve.reply('完成', 'msg_3');
    serve.idle();
  };
  await session.send('跑个命令');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  const tool = lastTurn(session).items.find(item => item.type === 'acpTool');
  assert.equal(tool.status, 'completed');
  assert.match(tool.title, /echo pilot/);
  assert.equal(tool.result[0].content.text, 'pilot');
});

test('权限确认在卡片里回答后发回 serve', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.send('permission.asked', { id: 'perm_1', permission: 'Write', metadata: { filepath: 'C:\\a.txt' }, tool: { callID: 'call-2' } }); };
  await session.send('写文件');
  const request = await until(() => session.runtime.requests[0], '权限请求');
  assert.match(request.params.toolCall.title, /Write/);
  await session.reply(request.id, { outcome: { outcome: 'selected', optionId: 'once' } }, session.runtime.epoch);
  const call = serve.calls.find(c => c.path === '/api/v1/permission/perm_1/reply');
  assert.deepEqual(call.body, { reply: 'once' });
  serve.reply('已写'); serve.idle();
  await until(() => session.runtime.state === 'completed', '本轮完成');
});

test('提问在卡片里回答，答案按 serve 的格式发回', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.send('question.asked', { id: 'q_1', questions: [{ question: '选 A 还是 B？', header: '选择', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }], tool: { callID: 'call-3' } }); };
  await session.send('问我');
  const request = await until(() => session.runtime.requests[0], '提问');
  assert.equal(request.params.toolCall._meta.questionTitle, 'CodeAgent 需要你的回答');
  await session.reply(request.id, { outcome: { outcome: 'selected', optionId: 'answer' }, answers: { 0: 'B' } }, session.runtime.epoch);
  assert.deepEqual(serve.calls.find(c => c.path === '/api/v1/question/q_1/reply').body, { answers: [['B']] });
  serve.reply('B'); serve.idle();
  await until(() => session.runtime.state === 'completed', '本轮完成');
});

test('终端里已回答的权限，卡片按钮自动收起', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.send('permission.asked', { id: 'perm_2', permission: 'Write', metadata: {} }); };
  await session.send('写文件');
  await until(() => session.runtime.requests[0], '权限请求');
  serve.send('permission.replied', { requestID: 'perm_2', reply: 'once' });
  await until(() => session.runtime.requests.length === 0, '按钮收起');
  assert.equal(serve.calls.some(c => c.path.includes('/permission/perm_2/reply')), false);
});

test('停止：卡片走 abort，这一轮记为中断', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('数到一半'); };
  await session.send('数数');
  await until(() => agentText(session), '开始输出');
  await session.interrupt();
  await until(() => session.runtime.state === 'interrupted', '已中断');
  assert.equal(lastTurn(session).status, 'interrupted');
});

test('真实终端里发的话也进卡片', async t => {
  const { serve, session } = await setup(t);
  serve.busy();
  serve.send('message.updated', { info: { id: 'msg_u1', role: 'user', payload: { message: { role: 'user', content: '终端里打的字' } } } });
  await until(() => session.active, '接成一轮');
  serve.reply('收到终端消息', 'msg_4');
  serve.idle();
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(lastTurn(session).items[0].content[0].text, '终端里打的字');
  assert.equal(agentText(session), '收到终端消息');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 0, '不能把终端里的话再发一遍');
});

test('后台终端：按需打开，离开后保温，再回来复用，关闭不影响会话', async t => {
  const { serve, session, terminals } = await setup(t);
  assert.equal(terminals.length, 0, '默认不开终端');
  const first = await session.attachTerminal({ cols: 100, rows: 40 });
  assert.equal(first.reused, false);
  assert.ok(terminals[0].options.args.includes('--server-url'));
  assert.equal(terminals[0].options.args.at(-1), SID);
  session.detachTerminal({ delayMs: 60_000 });
  assert.equal((await session.attachTerminal({})).reused, true);
  assert.equal(terminals.length, 1);
  session.write('x');
  assert.deepEqual(terminals[0].written, ['x']);
  session.detachTerminal({ delayMs: 1 });
  await until(() => terminals[0].killed, '保温到期关闭');
  serve.onPrompt = () => { serve.busy(); serve.reply('还在'); serve.idle(); };
  await session.send('继续');
  await until(() => session.runtime.state === 'completed', '终端关闭后继续');
});

test('serve 中断后自动恢复，上一轮不重发，能继续对话', async t => {
  const { serve, session } = await setup(t);
  const notices = [];
  session.on('action-error', message => notices.push(message));
  serve.onPrompt = () => { serve.busy(); serve.reply('写到一半'); };
  await session.send('长任务').catch(() => {});
  await until(() => agentText(session), '开始输出');
  serve.crash();
  await until(() => notices.some(text => text.includes('已自动恢复')), '自动恢复', 5000);
  assert.equal(session.runtime.connection, 'connected');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 1, '不自动重发');
  serve.onPrompt = () => { serve.busy(); serve.reply('恢复后正常'); serve.idle(); };
  await session.send('继续');
  await until(() => agentText(session) === '恢复后正常', '恢复后回答');
});

test('连续失败超过上限，请 Hub 改回 PTY', async t => {
  const { serve, session } = await setup(t);
  const fallback = new Promise(resolve => session.once('serve-fallback', resolve));
  session.failures = [Date.now(), Date.now(), Date.now()];
  serve.crash();
  const event = await fallback;
  assert.match(event.reason, /断开/);
});

test('终端里发斜杠命令不进卡片，卡片下一条消息照常发出', async t => {
  const { serve, session } = await setup(t);
  serve.busy();
  serve.send('message.updated', { info: { id: 'msg_cmd', role: 'user', payload: { message: { role: 'user', content: '/status' } } } });
  serve.idle();
  await wait(30);
  assert.ok(!session.active, '斜杠命令不接成卡片轮次');
  serve.onPrompt = () => { serve.busy(); serve.reply('正常回答'); serve.idle(); };
  await session.send('卡片消息');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 1, '卡片消息不能被吞');
});

test('终端消息接管失败时清掉接管标记，下一条不被吞', async t => {
  const { serve, session } = await setup(t);
  const realSend = session._send;
  session._send = async () => { throw new Error('模拟接管失败'); };
  serve.busy();
  serve.send('message.updated', { info: { id: 'msg_x', role: 'user', payload: { message: { role: 'user', content: '终端消息' } } } });
  await until(() => session.client.adopting === null, '接管标记清除');
  session._send = realSend;
  serve.idle();
  await wait(20);
  serve.onPrompt = () => { serve.busy(); serve.reply('正常'); serve.idle(); };
  await session.send('卡片消息');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 1);
});

test('终端里的短回复先结束也能收尾，用户消息先于 busy 到达也能接管', async t => {
  const { serve, session } = await setup(t);
  serve.send('message.updated', { info: { id: 'msg_early', role: 'user', payload: { message: { role: 'user', content: '先到的消息' } } } });
  serve.busy();
  serve.reply('短回复', 'msg_5');
  serve.idle();
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(lastTurn(session).items[0].content[0].text, '先到的消息');
});

test('终端连接中切回卡片：开好后进入保温倒计时，不留常驻进程', async t => {
  const { session, terminals } = await setup(t);
  const opening = session.attachTerminal({ cols: 100, rows: 30 });
  session.detachTerminal({ delayMs: 1 });
  await opening;
  await until(() => terminals[0]?.killed, '保温到期关闭');
  assert.equal(session.terminal, null);
});

test('恢复期间重复断线只改回 PTY 一次', async t => {
  const { serve, session } = await setup(t);
  let fallbacks = 0;
  session.on('serve-fallback', () => { fallbacks += 1; });
  session.failures = [Date.now(), Date.now(), Date.now()];
  const client = session.client;
  serve.crash();
  await until(() => fallbacks === 1, '改回 PTY');
  await session.recover(client, new Error('再次断线'));
  await wait(30);
  assert.equal(fallbacks, 1);
});

test('发送结果不明时走断线恢复，不自动重发', async t => {
  const { serve, session } = await setup(t);
  const notices = [];
  session.on('action-error', message => notices.push(message));
  const call = session.client.call.bind(session.client);
  session.client.call = (method, pathname, body, timeout) => (pathname.includes('/prompt_async')
    ? Promise.resolve({ status: 0, text: '请求超时', json: null }) : call(method, pathname, body, timeout));
  await session.send('可能没送到').catch(() => {});
  await until(() => notices.some(text => text.includes('已自动恢复')), '自动恢复', 5000);
  assert.equal(session.runtime.connection, 'connected');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 0);
});

test('运行方式：默认 PTY，组队、会议和自动会话不走 serve', () => {
  assert.equal(normalizeRunMode(undefined), 'pty');
  assert.equal(normalizeRunMode('乱写'), 'pty');
  assert.equal(usesServeRuntime('codeagent', {}), false);
  assert.equal(usesServeRuntime('claude', { codeagentRunMode: 'serve' }), false);
  assert.equal(usesServeRuntime('codeagent', { codeagentRunMode: 'serve' }), true);
  for (const extra of [{ meetingId: 'm' }, { teamId: 't' }, { purpose: 'avatar-agent' }, { purpose: 'hub-assistant' }, { resumePicker: true }]) {
    assert.equal(usesServeRuntime('codeagent', { codeagentRunMode: 'serve', ...extra }), false);
  }
  assert.deepEqual(withRunModeInJson({ runtime: { agent: 'pty' }, x: 1 }, 'serve'), { runtime: { agent: 'pty', codeagentRunMode: 'serve' }, x: 1 });
});
