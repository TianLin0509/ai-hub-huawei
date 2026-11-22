'use strict';
// CodeAgent ACP 试点：用按公司真机 1.2615.02.03 抓取格式回放事件的假 serve，走完整卡片驱动。
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
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
    this.status = { type: 'idle' };
    this.messages = new Map();
    this.promptCount = 0;
  }
  async listen() { await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.port = this.server.address().port; }
  get pid() { return this.proc.pid; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async ensure() { return this; }
  release() { this.refs -= 1; }
  send(type, properties) {
    if (type === 'session.status') this.status = properties.status;
    if (type === 'session.idle') this.status = { type: 'idle' };
    if (type === 'session.error') this.status = { type: 'error', error: properties.error };
    if (type === 'message.part.updated') {
      const part = properties.part;
      const message = this.messages.get(part.messageID) || { info: { id: part.messageID, role: 'assistant' }, parts: [] };
      const index = message.parts.findIndex(p => p.id === part.id);
      if (index < 0) message.parts.push(part); else message.parts[index] = part;
      this.messages.set(part.messageID, message);
    }
    if (type === 'session.error') {
      const message = [...this.messages.values()].at(-1);
      if (message) message.info.error = properties.error;
    }
    const frame = `data: ${JSON.stringify({ type, properties: { sessionID: SID, ...properties } })}\n\n`;
    for (const s of this.streams) s.write(frame);
  }
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
      if (url.pathname === '/api/v2/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); this.streams.add(res); res.on('close', () => this.streams.delete(res)); return; }
      if (req.method === 'POST' && url.pathname === '/api/v2/session') return json(200, { id: SID, model: { providerID: 'w3', id: 'deepseek-v4.1-flash-1017' } });
      if (req.method === 'GET' && url.pathname === `/api/v2/session/${SID}`) return json(200, { id: SID, model: { providerID: 'w3', id: 'deepseek-v4.1-flash-1017' } });
      if (url.pathname.endsWith('/prompt_async')) { this.promptCount++; json(202, {}); setImmediate(() => this.onPrompt(body)); return; }
      if (url.pathname.endsWith('/abort')) { json(200, {}); setImmediate(() => { this.send('session.error', { error: { name: 'MessageAbortedError', message: 'Request was aborted.' }, result: 'aborted' }); this.idle(); }); return; }
      if (/\/(permission|question)\/.+\/(reply|reject)$/.test(url.pathname)) return json(200, true);
      json(404, {});
    });
  }
  busy() { this.send('session.status', { status: { type: 'busy' } }); }
  idle() { this.send('session.idle', { runningSubagents: 0 }); this.send('session.status', { status: { type: 'idle' } }); }
  reply(text, messageID = 'msg_' + this.promptCount) {
    if (this.messages.get(messageID)?.parts.some(p => p.type === 'text' && p.text)) {
      this.send('message.part.updated', { part: { id: 'prt_0', messageID, type: 'text', text } });
      return;
    }
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
    recoverDelayMs: 10, permissionMode: 'default', profileId: 'codeagent-serve', storeDir, launch: { env: {} },
    spawnTerminal: options => {
      const term = new EventEmitter();
      Object.assign(term, { options, written: [], onData: fn => { term.on('data', fn); return { dispose: () => term.off('data', fn) }; }, onExit: fn => term.on('exit', fn), write: data => term.written.push(data), resize: (c, r) => { term.size = [c, r]; }, kill: () => { term.killed = true; term.emit('exit', {}); } });
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

test('新轮订阅就绪但 POST 尚未发出时，旧 busy/idle 不能结算本轮', async t => {
  const { serve, session } = await setup(t);
  const client = session.client, subscribe = client._subscribe.bind(client);
  client._subscribe = async (...args) => {
    await subscribe(...args);
    client.handleEvent({ type: 'session.status', properties: { sessionID: SID, status: { type: 'busy' } } });
    client.handleEvent({ type: 'session.idle', properties: { sessionID: SID } });
    assert.ok(client.pending, '尚未投递不能被旧终态提前结算');
  };
  serve.onPrompt = () => { serve.busy(); serve.reply('本轮回答'); serve.idle(); };
  await session.send('本轮');
  await until(() => session.runtime.state === 'completed', '本轮完成');
  assert.equal(agentText(session), '本轮回答');
});

test('恢复身份不调用未经证实的 HTTP 消息接口', async t => {
  const { serve, session } = await setup(t);
  await session.client.request('session/load', { sessionId: SID });
  assert.ok(!serve.calls.some(c => /\/(status|messages?)$/.test(c.path)));
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

test('R-03：仅事件流断线不清当前轮次，重连后的最终输出完整归档且不重发', async t => {
  const { serve, session } = await setup(t);
  const notices = [];
  session.on('action-error', message => notices.push(message));
  serve.onPrompt = () => { serve.busy(); serve.reply('写到一半'); };
  await session.send('长任务').catch(() => {});
  await until(() => agentText(session), '开始输出');
  const active = session.active, client = session.client;
  const terminal = await session.attachTerminal({});
  assert.equal(terminal.ok, true);
  serve.crash();
  await until(() => notices.some(text => text.includes('已重新订阅')), '自动恢复', 5000);
  assert.equal(session.runtime.connection, 'connected');
  assert.equal(session.active, active);
  assert.equal(session.client, client);
  assert.equal(session.runtime.submission.status, 'accepted');
  assert.equal(lastTurn(session).status, 'inProgress');
  assert.ok(session.terminal, '单独事件流断线不关闭后台终端');
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 1, '不自动重发');
  serve.send('message.part.updated', { part: { id: 'prt_0', messageID: 'msg_1', type: 'text', text: '写到一半，最终完成' } });
  serve.idle();
  await until(() => session.runtime.state === 'completed', '恢复后的原轮次完成');
  assert.equal(agentText(session), '写到一半，最终完成');
  assert.equal(lastTurn(session).status, 'completed');
  assert.ok(notices.every(text => !text.includes('没有跑完')));
  serve.onPrompt = () => { serve.busy(); serve.reply('恢复后正常'); serve.idle(); };
  await session.send('继续');
  await until(() => agentText(session) === '恢复后正常', '恢复后回答');
});

for (const missingBusy of [false, true]) {
  test(`断线窗口错过终态（busy丢失=${missingBusy}）：保留未知及轮次，不查询假设接口`, async t => {
    const { serve, session } = await setup(t);
    session.client.recoveryResultMs = 60;
    serve.onPrompt = () => {
      if (!missingBusy) { serve.busy(); serve.reply('前半'); }
      setTimeout(() => { serve.crash(); serve.busy(); serve.reply('窗口内最终结果'); serve.idle(); }, 10);
    };
    await session.send('断线任务').catch(() => {});
    await until(() => session.runtime.submission.status === 'unknown', '结果未知');
    assert.ok(session.active);
    assert.ok(session.client.pending);
    assert.equal(await session.readOutcome(session.active.turnId), null);
    assert.equal(lastTurn(session).status, 'inProgress');
    assert.match(session.runtime.submission.error, /服务端结果未知.*后台终端/);
    await assert.rejects(session._send('第二轮', {}), /尚未结束/);
    assert.equal(serve.promptCount, 1);
    assert.ok(!serve.calls.some(c => /\/(status|messages?)$/.test(c.path)));
  });
}

test('历史消息和旧错误不能结算恢复中的新轮次', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('旧回答', 'old'); serve.idle(); };
  await session.send('上一轮');
  await until(() => session.runtime.state === 'completed', '上一轮完成');
  serve.messages.get('old').info.error = { name: 'APIError', message: 'Old failure' };
  serve.onPrompt = () => { serve.busy(); serve.reply('新轮前缀', 'new'); };
  await session.send('新一轮');
  const previousStream = session.client.sse;
  serve.crash();
  await until(() => session.client.sse && session.client.sse !== previousStream, '恢复仍在执行的新一轮', 5000);
  assert.ok(session.active);
  assert.equal(lastTurn(session).status, 'inProgress');
  serve.reply('新轮前缀与结果', 'new'); serve.idle();
  // 恢复后的事件流在机器负载高时可能晚于 3 秒到达（v5.6.82 预检 3.5 秒超时），与上一步一样给 5 秒。
  await until(() => session.runtime.state === 'completed', '本轮完成', 5000);
  assert.equal(agentText(session), '新轮前缀与结果');
});

for (const aborted of [true, false]) {
  test(`重订后收到${aborted ? ' abort' : '报错'}终态，才按真实结果结算`, async t => {
    const { serve, session } = await setup(t);
    serve.onPrompt = () => { serve.busy(); serve.reply('部分结果'); };
    await session.send('执行');
    const previous = session.client.sse;
    serve.crash();
    await until(() => session.client.sse && session.client.sse !== previous && serve.streams.size, '重订');
    serve.send('session.error', { error: { name: aborted ? 'MessageAbortedError' : 'APIError', message: aborted ? 'Request was aborted.' : 'Quota exhausted' } });
    serve.idle();
    await until(() => session.runtime.state === (aborted ? 'interrupted' : 'failed'), '真实终态');
    if (!aborted) assert.match(lastTurn(session).error, /Quota exhausted/);
  });
}

test('delta 缺口续接：重订后的无位置 delta 不污染前缀，SSE 全文追上后继续去重', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('AB'); };
  await session.send('字母');
  await until(() => agentText(session) === 'AB', '前缀');
  serve.crash();
  serve.send('message.part.updated', { part: { id: 'prt_0', messageID: 'msg_1', type: 'text', text: 'ABCDEF' } });
  const client = session.client, subscribe = client._subscribe.bind(client);
  client._subscribe = async () => {
    await subscribe();
    serve.send('message.part.delta', { messageID: 'msg_1', partID: 'block_0', field: 'text', delta: 'EF' });
  };
  await until(() => client.sse && serve.streams.size, '重订', 5000);
  await wait(25);
  assert.equal(agentText(session), 'AB', '无位置 delta 不能拼接缺口');
  serve.send('message.part.updated', { part: { id: 'prt_0', messageID: 'msg_1', type: 'text', text: 'ABCDEFG' } });
  serve.send('message.part.delta', { messageID: 'msg_1', partID: 'block_0', field: 'text', delta: 'H' });
  await until(() => agentText(session) === 'ABCDEFGH', '全文追上后恢复增量');
  serve.send('message.part.updated', { part: { id: 'prt_0', messageID: 'msg_1', type: 'text', text: 'ABCDEFGH' } });
  serve.idle();
  await until(() => session.runtime.state === 'completed', '续接完成');
  assert.equal(agentText(session), 'ABCDEFGH');
});

test('R-06：重订在途再次断线必须继续重订，不能声称已恢复', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('A'); };
  await session.send('竞态');
  const client = session.client, subscribe = client._subscribe.bind(client);
  const notices = [];
  session.on('action-error', text => notices.push(text));
  let attempts = 0;
  client._subscribe = async (...args) => {
    await subscribe(...args);
    if (++attempts === 1) { serve.crash(); await wait(30); }
  };
  serve.crash();
  await until(() => attempts === 2 && client.sse && serve.streams.size, '再次重订');
  assert.ok(!notices.some(text => text.includes('已恢复') || text.includes('已自动恢复')));
  serve.reply('ABC'); serve.idle();
  await until(() => session.runtime.state === 'completed', '真实终态');
});

test('R-05：pending 超时保留 unknown、Stop 和原轮次；迟到结果不串轮', async t => {
  const { serve, session } = await setup(t);
  session.client.pendingTimeoutMs = 40;
  serve.onPrompt = () => { serve.busy(); serve.reply('未完成'); };
  await session.send('不回终态');
  const active = session.active;
  await until(() => session.runtime.submission.status === 'unknown', '等待兜底');
  assert.match(session.runtime.submission.error, /等待结果超时/);
  assert.equal(session.runtime.connection, 'connected');
  assert.equal(session.active, active);
  assert.ok(session.client.pending);
  assert.equal(await session.readOutcome(active.turnId), null);
  await assert.rejects(session._send('第二轮', {}), /尚未结束/);
  assert.equal(serve.promptCount, 1);
  serve.reply('未完成的迟到结果'); serve.idle();
  await until(() => session.runtime.state === 'completed', '迟到终态');
  assert.equal(session.runtime.submission.status, 'accepted');
  assert.equal(agentText(session), '未完成的迟到结果');
  serve.onPrompt = () => { serve.busy(); serve.reply('新轮'); };
  await session.send('下一轮');
  const next = session.active;
  session.client.handleEvent({ type: 'session.idle', properties: { sessionID: SID } }, session.client.round - 1);
  assert.equal(session.active, next, '旧订阅代次的终态不能结算新轮');
  serve.reply('旧轮污染', 'msg_1'); serve.idle();
  await wait(25);
  assert.equal(session.active, next);
  assert.equal(agentText(session), '新轮');
  serve.reply('新轮完成'); serve.idle();
  await until(() => session.runtime.state === 'completed', '新轮终态');
  assert.equal(agentText(session), '新轮完成');
});

test('R-05：未知轮次仍可以 Stop，服务端确认后才记中断', async t => {
  const { serve, session } = await setup(t);
  session.client.pendingTimeoutMs = 30;
  serve.onPrompt = () => { serve.busy(); serve.reply('仍忙'); };
  await session.send('执行');
  await until(() => session.runtime.submission.status === 'unknown', '未知');
  await session.interrupt();
  await until(() => session.runtime.state === 'interrupted', '停止确认');
  assert.ok(serve.calls.some(c => c.path.endsWith('/abort')));
});

test('R-05：没有早期执行证据时超时，迟到正文仍保留 unknown，直到终态', async t => {
  const { serve, session } = await setup(t);
  session.client.pendingTimeoutMs = 30;
  await session.send('没有早期证据').catch(() => {});
  assert.equal(session.runtime.submission.status, 'unknown');
  const active = session.active;
  serve.reply('迟到正文');
  await until(() => agentText(session) === '迟到正文', '迟到正文');
  assert.equal(session.runtime.submission.status, 'unknown');
  assert.equal(session.active, active);
  serve.idle();
  await until(() => session.runtime.state === 'completed', '迟到终态');
  assert.equal(session.runtime.submission.status, 'accepted');
});

test('重订次数有限：耗尽后保留 unknown，不切换后端或放行下一轮', async t => {
  const { serve, session } = await setup(t);
  let attempts = 0, fallbacks = 0;
  serve.onPrompt = () => { serve.busy(); serve.reply('仍忙'); };
  await session.send('执行');
  session.on('serve-fallback', () => fallbacks++);
  session.client._subscribe = async () => { attempts++; throw new Error('fixture reconnect error'); };
  serve.crash();
  await until(() => session.runtime.submission.status === 'unknown', '次数耗尽');
  await wait(40);
  assert.equal(attempts, 3);
  assert.equal(fallbacks, 0);
  assert.ok(session.active);
  assert.equal(serve.promptCount, 1);
});

test('连续失败超过上限，请 Hub 改回 PTY', async t => {
  const { serve, session } = await setup(t);
  const fallback = new Promise(resolve => session.once('serve-fallback', resolve));
  session.failures = [Date.now(), Date.now(), Date.now()];
  serve.crash();
  const event = await fallback;
  assert.match(event.reason, /断开/);
});

test('事件流首次重连失败后继续重试，只有服务端确认 abort 才记中断', async t => {
  const { serve, session } = await setup(t);
  serve.onPrompt = () => { serve.busy(); serve.reply('仍在执行'); };
  await session.send('长任务');
  const client = session.client, active = session.active;
  const subscribe = client._subscribe.bind(client);
  let attempts = 0;
  client._subscribe = () => ++attempts === 1 ? Promise.reject(new Error('暂时不可用')) : subscribe();
  serve.crash();
  await until(() => attempts === 2 && serve.streams.size > 0, '第二次重连', 5000);
  assert.equal(session.active, active);
  assert.equal(lastTurn(session).status, 'inProgress');
  serve.send('session.error', { error: { name: 'MessageAbortedError', message: 'Request was aborted.' }, result: 'aborted' });
  serve.idle();
  await until(() => session.runtime.state === 'interrupted', '服务端确认中断');
  assert.equal(lastTurn(session).status, 'interrupted');
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

test('发送结果不明时保留 unknown，不宣称中断或自动重发', async t => {
  const { serve, session } = await setup(t);
  const notices = [];
  session.on('action-error', message => notices.push(message));
  const call = session.client.call.bind(session.client);
  session.client.call = (method, pathname, body, timeout) => (pathname.includes('/prompt_async')
    ? Promise.resolve({ status: 0, text: '请求超时', json: null }) : call(method, pathname, body, timeout));
  await session.send('可能没送到').catch(() => {});
  await until(() => notices.some(text => text.includes('结果不明')), '结果不明', 5000);
  assert.equal(session.runtime.submission.status, 'unknown');
  assert.equal(lastTurn(session).status, 'inProgress');
  assert.ok(session.active);
  assert.equal(serve.calls.filter(c => c.path.endsWith('/prompt_async')).length, 0);
});

test('R-02：serve 快速 attach 保留 bypass 确认监听但不投递 shell 命令，默认 PTY 照常启动', () => {
  const source = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  const from = source.indexOf('    const agentPtyLaunch = claudePtyLaunch || codeagentLaunch;');
  const to = source.indexOf('\n    if (isGemini)', from);
  assert.ok(from > 0 && to > from);
  for (const isCodeAgentServe of [true, false]) {
    for (const trigger of ['deadline', 'quiet']) {
    const writes = [], timers = [], listeners = [];
    const command = ' codeagent --disable-update --skip-safe-check\r\n';
    const driver = { terminal: { write: text => writes.push(text) }, write: CodeAgentServeSession.prototype.write,
      onData: fn => { listeners.push(fn); return { dispose() {} }; } };
    let bypassTarget;
    const context = { isCodeAgentServe, claudePtyLaunch: null, codeagentLaunch: { cmd: command, settingsModel: 'demo', bypassLaunch: true },
      ptyProcess: driver, id: 'fixture', kind: 'codeagent', codeagentPool: null, codeagentPickFirst: false,
      pendingTimers: [], sessions: new Map([['fixture', { pty: driver }]]), emit() {}, console: { log() {} },
      getHubDataDir: () => 'fixture', setTimeout: (fn, ms) => { const token = { fn, ms }; timers.push(token); return token; },
      clearTimeout() {}, queueMicrotask() {}, require: name => {
        if (name === './claude-trust-dialog.js') return {
          watchBypassWarning: target => { bypassTarget = target; return () => {}; },
          createTrustScreen: () => ({ dispose() {}, write() {}, lines: async () => [] }),
        };
        if (name === './codeagent-model-picker') return { resetFailure() {} };
        if (name === './codeagent-models') return { appendModelLog() {} };
        throw new Error('Unexpected dependency ' + name);
      } };
    vm.runInNewContext(source.slice(from, to), context);
    assert.equal(bypassTarget, isCodeAgentServe ? undefined : driver);
    if (isCodeAgentServe) {
      assert.equal(timers.length, 0, 'serve 创建时不注册监听或投递 shell');
      assert.equal(listeners.length, 0);
      assert.deepEqual(writes, []);
    } else {
      assert.ok(listeners.length > 0);
      if (trigger === 'quiet') listeners.at(-1)('terminal output');
      timers.find(timer => timer.ms === (trigger === 'quiet' ? 200 : 3000)).fn();
      assert.deepEqual(writes, [command]);
      listeners.at(-1)('terminal output');
      assert.deepEqual(writes, [command], '启动命令只投递一次');
    }
    }
  }
});

test('R-07：晚 attach、保温重接和关闭后重开均注册真实 bypass 监听；detach 清理', async t => {
  const { watchBypassWarning } = require('../core/claude-trust-dialog');
  const warning = ['WARNING: CodeAgent running in Bypass Permissions mode', '',
    'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
    '❯ 1. No, exit', '  2. Yes, I accept', 'Enter to confirm · Esc to cancel'];
  let registrations = 0;
  const { session, terminals } = await setup(t, { permissionMode: 'bypassPermissions', watchBypassWarning: pty => {
    registrations++;
    return watchBypassWarning(pty, { createScreen: () => ({ write() {}, lines: async () => warning, dispose() {} }), settleMs: 5, pollMs: 2 });
  } });
  assert.equal(registrations, 0, '创建后不消耗 attach 的监听期限');
  const realNow = Date.now;
  Date.now = () => realNow() + 90_001;
  try { await session.attachTerminal(); } finally { Date.now = realNow; }
  assert.equal(registrations, 1);
  assert.equal(terminals[0].listenerCount('data'), 2);
  terminals[0].emit('data', 'warning');
  await until(() => terminals[0].written.length === 2, '实际确认按键');
  assert.deepEqual(terminals[0].written, ['\x1b[B', '\r']);
  session.detachTerminal({ delayMs: 1000 });
  assert.equal(terminals[0].listenerCount('data'), 1, '只保留输出转发');
  await session.attachTerminal();
  assert.equal(registrations, 2);
  assert.equal(terminals[0].listenerCount('data'), 2);
  terminals[0].emit('data', 'warning');
  session.detachTerminal({ delayMs: 1 });
  await until(() => terminals[0].killed, '关闭');
  await wait(90);
  assert.equal(terminals[0].written.length, 2, 'detach 后不再向旧终端按确认键');
  await session.attachTerminal();
  assert.equal(registrations, 3);
  terminals[1].emit('data', 'warning');
  await until(() => terminals[1].written.length === 2, '重开后的确认按键');
  assert.deepEqual(terminals[1].written, ['\x1b[B', '\r']);
  session.closeTerminal();
  assert.equal(session.stopBypassWatch, null);
});

test('未知轮次提供可点击的后台查看入口，默认用户不出现入口', async () => {
  const { createCodexNativeControls } = require('../renderer/codex-native-controls');
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; }
    setAttribute() {}
    append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
    insertBefore(child, next) { child.parent = this; const i = this.children.indexOf(next); this.children.splice(i < 0 ? this.children.length : i, 0, child); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    get childElementCount() { return this.children.length; }
    get lastElementChild() { return this.children.at(-1); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  }
  let opens = 0;
  const controls = createCodexNativeControls({ sessionId: 'fixture', document: { createElement: tag => new Element(tag) },
    invoke: () => { throw new Error('不能重发'); }, openBackstage: async () => { opens++; } });
  const session = { runtimeBackend: 'acp', codeagentRunMode: 'serve', nativeRuntime: { connection: 'connected', state: 'running', submission: { status: 'unknown', error: 'fixture' } } };
  controls.update(session);
  const button = controls.element.children[0].children.find(e => e.tag === 'button');
  assert.equal(button.textContent, '在后台终端查看');
  await button.handlers.click();
  assert.equal(opens, 1);
  controls.update({ ...session, codeagentRunMode: 'pty' });
  assert.equal(controls.element.childElementCount, 0);
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
