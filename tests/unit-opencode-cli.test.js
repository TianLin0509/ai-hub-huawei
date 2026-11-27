'use strict';
// opencode 后端（2026-11-26）：启动参数、权限档、线路缺失提示、消息到卡片的整形、休眠快照读取、发送前的拒收条件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = require('../core/opencode-cli-profile');
const { OpencodeCliSession, readOpencodeCliTranscript, buildRecords, messageId } = require('../core/opencode-cli-session');
const aiKinds = require('../core/ai-kinds');
const permissionModes = require('../core/permission-modes');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hub-opencode-')); }
function fakeBin(dir) { const bin = path.join(dir, 'opencode.exe'); fs.writeFileSync(bin, ''); return bin; }

test('opencode 登记为 Hub 的 AI 种类和 provider CLI', () => {
  assert.ok(aiKinds.ALL_AI_KINDS.includes('opencode'));
  assert.equal(aiKinds.getAgentLabel('opencode-resume'), 'opencode');
  assert.equal(aiKinds.canonicalAiKind('opencode-resume'), 'opencode');
  assert.ok(require('../core/acp-profiles').isAcpKind('opencode'));
  assert.ok(require('../community-edition.json').kinds.includes('opencode'));
});

test('权限档映射到 opencode 的 permission 配置', () => {
  assert.deepEqual(permissionModes.modesFor('opencode'), ['bypassPermissions', 'acceptEdits', 'default', 'plan']);
  assert.equal(permissionModes.launchDefault('opencode'), 'default');
  assert.deepEqual(profile.permissionConfig('bypassPermissions'), { permission: 'allow' });
  assert.deepEqual(profile.permissionConfig(null), { permission: 'allow' });
  assert.equal(profile.permissionConfig('acceptEdits').permission.edit, 'allow');
  assert.equal(profile.permissionConfig('acceptEdits').permission.bash, 'ask');
  assert.equal(profile.permissionConfig('default').permission.edit, 'ask');
  assert.equal(profile.permissionConfig('plan').default_agent, 'plan');
});

test('启动参数：本机服务只听 127.0.0.1、带随机密码、Hub 线路写进临时配置且钥匙不落盘', () => {
  const dir = tmp();
  const env = { AI_HUB_OPENCODE_PATH: fakeBin(dir), PATH: '', DEEPSEEK_API_KEY: 'sk-secret-123', opencode_server_password: 'leak', claude_hub_token: 'tok', CLAUDECODE: '1', HTTP_PROXY: 'http://proxy:8080' };
  const options = profile.buildOpencodeCliOptions('opencode', { id: 'hub-1', cwd: dir, permissionMode: 'default' }, {}, dir, env);
  assert.equal(options.kind, 'opencode');
  assert.equal(options.model, 'hub-deepseek/deepseek-flash');
  assert.deepEqual(options.launch.args.slice(0, 2), ['--hostname', '127.0.0.1']);
  assert.ok(options.launch.args.includes('--model'));
  assert.ok(!options.launch.args.includes('--session'));
  assert.match(options.password, /^[a-f0-9]{36}$/);
  assert.equal(options.launch.env.OPENCODE_SERVER_PASSWORD, options.password);
  assert.equal(options.launch.env.opencode_server_password, undefined, '小写同名变量也清掉');
  assert.equal(options.launch.env.claude_hub_token, undefined);
  assert.equal(options.launch.env.CLAUDECODE, undefined);
  assert.equal(options.launch.env.DEEPSEEK_API_KEY, undefined, '原始 Key 变量不带给 opencode');
  assert.match(options.launch.env.NO_PROXY, /127.0.0.1/, '本机服务不走代理');
  assert.deepEqual(options.modelOptions.map(m => m.id), ['hub-deepseek/deepseek-flash', 'hub-deepseek/deepseek-v4-pro']);
  const config = fs.readFileSync(options.launch.env.OPENCODE_CONFIG, 'utf8');
  assert.ok(!config.includes('sk-secret-123'), '钥匙不写进配置文件');
  const parsed = JSON.parse(config);
  assert.equal(parsed.provider['hub-deepseek'].options.apiKey, '{env:AI_HUB_OPENCODE_DEEPSEEK_KEY}');
  assert.equal(parsed.provider['hub-deepseek'].npm, '@ai-sdk/openai-compatible');
  assert.equal(parsed.permission.bash, 'ask');
  assert.equal(parsed.autoupdate, false);
  assert.equal(options.launch.env.AI_HUB_OPENCODE_DEEPSEEK_KEY, 'sk-secret-123');
  // 后台会话（autonomous）始终完全放开，免得停在确认框上
  const bg = profile.buildOpencodeCliOptions('opencode', { id: 'hub-2', cwd: dir, permissionMode: 'default', autonomous: true }, {}, dir, env);
  assert.equal(JSON.parse(fs.readFileSync(bg.launch.env.OPENCODE_CONFIG, 'utf8')).permission, 'allow');
});

test('恢复：只接受 opencode 的会话 id；线路缺钥匙时说清缺什么、不悄悄换线路', () => {
  const dir = tmp();
  const env = { AI_HUB_OPENCODE_PATH: fakeBin(dir), PATH: '' };
  const resumed = profile.buildOpencodeCliOptions('opencode-resume', { id: 'hub-3', cwd: dir, acpSid: 'ses_abc123' }, {}, dir, env);
  assert.equal(resumed.resumeId, 'ses_abc123');
  assert.equal(resumed.route, 'native');
  assert.equal(resumed.model, '');
  assert.throws(() => profile.buildOpencodeCliOptions('opencode-resume', { id: 'hub-4', cwd: dir, acpSid: 'ses_bad-id_1' }, {}, dir, env), /编号已损坏/, '坏编号不悄悄开新会话');
  assert.throws(() => profile.buildOpencodeCliOptions('opencode-resume', { id: 'hub-5', cwd: dir, model: 'hub-deepseek/deepseek-flash' }, {}, dir, env),
    error => error.code === 'OPENCODE_ROUTE_MISSING' && /DeepSeek API Key/.test(error.message));
  // 用户自己 opencode 里的模型（不是 Hub 线路）原样交给 opencode
  const own = profile.buildOpencodeCliOptions('opencode', { id: 'hub-6', cwd: dir, model: 'anthropic/claude-x' }, {}, dir, env);
  assert.equal(own.model, 'anthropic/claude-x');
});

test('没装 opencode：给出一键安装的提示', () => {
  const dir = tmp();
  assert.throws(() => profile.buildOpencodeCliOptions('opencode', { id: 'x', cwd: dir }, {}, dir, { PATH: '', APPDATA: dir, USERPROFILE: dir, AI_HUB_CLI_TOOLS_DIR: path.join(dir, 'tools') }), /一键安装 opencode/);
});

const MESSAGES = [
  { info: { id: 'msg_1', role: 'user', time: { created: 1000 } }, parts: [{ id: 'p1', type: 'text', text: '你好\n第二行' }] },
  { info: { id: 'msg_2', role: 'assistant', providerID: 'hub-company', modelID: 'GLM-5.3', time: { created: 1001, completed: 1005 }, tokens: { input: 10, output: 5 } },
    parts: [{ id: 'p2', type: 'reasoning', text: '想一想' }, { id: 'p3', type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed', input: { filePath: 'a.txt' }, output: '内容' } },
      { id: 'p4', type: 'text', text: '答复正文' }] },
  { info: { id: 'msg_3', role: 'user', time: { created: 2000 } }, parts: [{ id: 'p5', type: 'text', text: '第二问' }] },
  { info: { id: 'msg_4', role: 'assistant', time: { created: 2001 }, error: { name: 'APIError', data: { message: '模型服务 503' } } }, parts: [] },
];

test('opencode 消息整形成卡片：思考、工具调用与结果、正文、报错', () => {
  const records = buildRecords(MESSAGES);
  assert.equal(records.length, 2);
  assert.equal(records[0].text, '你好\n第二行');
  assert.equal(records[0].finalText, '答复正文');
  assert.equal(records[0].model, 'hub-company/GLM-5.3');
  assert.equal(records[1].errorMessage, '模型服务 503');
  const dir = tmp();
  const file = path.join(dir, 'transcript-ses_x.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessionID: 'ses_x', messages: MESSAGES }));
  const cards = readOpencodeCliTranscript(file);
  assert.ok(cards.some(c => c.role === 'user' && /你好/.test(c.text)));
  assert.ok(cards.every(c => c.kind === 'opencode'));
  assert.ok(cards.some(c => c.role === 'assistant' && /答复正文/.test(c.text || '')));
});

test('发送：运行中、等确认、带附件、没模型时都不发并说明原因', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: '', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.ready = Promise.resolve();
  s.runtime = { connection: 'connected', state: 'running' };
  await assert.rejects(s.send('hi'), e => e.notSent && /上一条/.test(e.message));
  s.runtime.state = 'waiting';
  await assert.rejects(s.send('hi'), e => e.notSent && /终端里确认/.test(e.message));
  s.runtime.state = 'idle';
  await assert.rejects(s.send('hi', { attachments: [{}] }), e => e.notSent && /@文件/.test(e.message));
  await assert.rejects(s.send('hi'), e => e.notSent && /没有可用的模型/.test(e.message));
});

test('事件：只认绑定的会话；只认 Hub 发出的编号才算回执；idle 收尾', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'idle' };
  s.reload = async () => {};
  const events = [];
  s.on('lifecycle', e => events.push(e.type));
  const receipt = new Promise(resolve => { s.pending = { id: 'sub1', text: 'q', messageID: 'msg_9', resolve, timer: null }; });
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_other', role: 'user', sessionID: 'ses_2' } } });
  assert.ok(s.pending, '别的会话的消息不算回执');
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_terminal', role: 'user', sessionID: 'ses_1', time: { created: 1 } } } });
  assert.ok(s.pending, '终端里同时输入的另一条不算这次的回执');
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_9', role: 'user', sessionID: 'ses_1', time: { created: 1 } } } });
  const r = await receipt;
  assert.equal(r.ok, true); assert.equal(r.turnId, 'msg_9'); assert.equal(r.clientSubmissionId, 'sub1');
  s.observe({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
  assert.equal(s.runtime.state, 'running');
  s.observe({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'per_1' } });
  assert.equal(s.runtime.state, 'waiting');
  s.observe({ type: 'permission.replied', properties: { sessionID: 'ses_1' } });
  assert.equal(s.runtime.state, 'running');
  await s.settle();
  assert.equal(s.runtime.state, 'completed');
  assert.deepEqual(events, ['prompt-submitted', 'turn-started', 'turn-complete']);
  s.dispose();
});

test('Hub 生成的消息编号符合 opencode 格式且按时间递增', () => {
  const a = messageId(1795683597717), b = messageId(1795683597717), c = messageId(1795683597800);
  assert.match(a, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(a.slice(4, 15), '217153d9500');   // 与 opencode 自己在同一毫秒生成的编号同前缀（实测 msg_217153d95001…）
  assert.ok(a < b && b < c);
});

test('发送时连接中断不算「没发出」，按编号等回执；明确拒收才算没发出', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.ready = Promise.resolve(); s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'idle' };
  s.selectInTerminal = async () => {};
  let body = null;
  s.api = async (method, route, b) => { body = b; s.observe({ type: 'message.updated', properties: { info: { id: b.messageID, role: 'user', sessionID: 'ses_1', time: { created: 1 } } } }); throw new TypeError('fetch failed'); };
  const r = await s.send('hi');
  assert.equal(r.ok, true, '已被 opencode 记下的消息即使响应断了也算送到');
  assert.equal(r.turnId, body.messageID);
  s.runtime = { connection: 'connected', state: 'idle' };
  s.api = async (method) => { throw Object.assign(new Error(method === 'POST' ? 'opencode 服务返回 400' : 'opencode 服务返回 404'), { status: method === 'POST' ? 400 : 404 }); };
  await assert.rejects(s.send('hi2'), e => e.notSent === true);
  assert.equal(s.pending, null);
  s.dispose();
});

test('收尾查询期间开始了新一轮：旧结果不覆盖新一轮的状态', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'running', turnId: 'msg_1' }; s.turnGen = 1;
  const events = []; s.on('lifecycle', e => events.push([e.type, e.turnId]));
  s.messages.set('msg_1', { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: new Map(), touchedAt: 0 });
  let release; s.reload = () => new Promise(resolve => { release = resolve; });
  const settling = s.settle();
  assert.equal(s.runtime.state, 'running', '收尾期间对外仍是运行中，不出现「状态未知」');
  s.observe({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });   // 终端里又开了一轮，busy 先到
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_2', role: 'user', sessionID: 'ses_1', time: { created: 2 } } } });
  release(); await settling;
  assert.equal(s.runtime.state, 'running');
  assert.equal(s.runtime.turnId, 'msg_2', '新一轮绑到新消息');
  assert.ok(events.some(([type, turn]) => type === 'turn-complete' && turn === 'msg_1'), '旧一轮照样补发完成：' + JSON.stringify(events));
  s.dispose();
});

test('校对历史不盖掉用户刚选的模型', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'p/new', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1';
  s.api = async () => [{ info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [] }, { info: { id: 'msg_2', role: 'assistant', providerID: 'p', modelID: 'old', time: { created: 2 } }, parts: [] }];
  await s.reload();
  assert.equal(s.currentModel, 'p/new');
  s.dispose();
});

test('启动途中被关掉：不再拉起 opencode；启动失败报真实原因、不被「已关闭」盖掉', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  const errors = []; s.on('action-error', m => errors.push(m));
  const starting = s.start();
  s.kill();
  await assert.rejects(starting, /已关闭/);
  assert.equal(s.pty, undefined, '没有拉起进程');
});

test('waiting 中断线，重连时 opencode 已在继续干活：回到运行中', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'waiting', turnId: 'msg_1' };
  s.reload = async () => {};
  s.api = async (method, route) => route === '/session/status' ? { ses_1: { type: 'busy' } } : [];
  await s.reconcileState();
  assert.equal(s.runtime.state, 'running');
  s.api = async (method, route) => route === '/session/status' ? { ses_1: { type: 'busy' } } : route === '/permission' ? [{ sessionID: 'ses_1' }] : [];
  await s.reconcileState();
  assert.equal(s.runtime.state, 'waiting', '断线期间弹了确认框：回到等确认');
  s.dispose();
});

test('终端里 /models 换了模型：Hub 跟着更新显示；缺线路名不拼出 undefined', () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'p/old', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1';
  const bound = []; s.on('bound', b => bound.push(b.model));
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_2', role: 'assistant', sessionID: 'ses_1', providerID: 'p', modelID: 'new', time: { created: 5 } } } });
  assert.equal(s.currentModel, 'p/new'); assert.deepEqual(bound, ['p/new']);
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_3', role: 'assistant', sessionID: 'ses_1', modelID: 'solo', time: { created: 6 } } } });
  assert.equal(s.currentModel, 'p/new');
  s.dispose();
});

test('复审二：收尾途中又开又结束的一轮不会卡在运行中', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'running', turnId: 'msg_1' }; s.turnGen = 1;
  let release; let calls = 0;
  s.reload = () => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); };
  const settling = s.settle();
  s.observe({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
  s.observe({ type: 'message.updated', properties: { info: { id: 'msg_2', role: 'user', sessionID: 'ses_1', time: { created: 2 } } } });
  s.observe({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
  release(); await settling;
  assert.equal(s.runtime.state, 'completed');
  s.dispose();
});

test('复审二：还没拉起终端就被关，照样发出退出事件', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  let exits = 0; s.onExit(() => exits++);
  const starting = s.start().catch(() => {});
  s.kill(); await starting; await new Promise(r => setImmediate(r));
  assert.equal(exits, 1);
});

test('复审二：响应断了但历史里有这条，消息本身也记进来；超时又查不到不报「没发出」', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'a/b', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.ready = Promise.resolve(); s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'idle' }; s.selectInTerminal = async () => {};
  s.api = async (method, route) => {
    if (method === 'POST') throw new Error('socket hang up');
    const id = route.split('/').pop();
    return { info: { id, role: 'user', sessionID: 'ses_1', time: { created: 9 } }, parts: [{ id: 'prt_1', type: 'text', text: 'hi' }] };
  };
  const r = await s.send('hi');
  assert.equal(r.ok, true); assert.ok(s.messages.has(r.turnId), '这条用户消息进了内存');
  s.runtime = { connection: 'connected', state: 'idle' };
  s.api = async (method) => { if (method === 'POST') throw Object.assign(new Error('10 秒没有响应'), { name: 'TimeoutError' }); throw Object.assign(new Error('404'), { status: 404 }); };
  const r2 = await s.send('/compact');
  assert.equal(r2.ok, true); assert.equal(r2.sendStatus, 'dispatched');
  s.dispose();
});

test('复审二：会话只认启动时那条线路，换到别的 Hub 线路当场拒绝', async () => {
  const s = new OpencodeCliSession({ id: 'h', cwd: '.', model: 'hub-deepseek/deepseek-flash', route: 'deepseek', password: 'p', sessionRoot: tmp(), launch: { command: 'x', args: [], env: {} } });
  s.ready = Promise.resolve(); s.threadId = 'ses_1'; s.runtime = { connection: 'connected', state: 'idle' };
  await assert.rejects(s.configure({ model: 'hub-tokenplan/qwen' }), /新建一个 opencode 会话/);
  const ok = await s.configure({ model: 'hub-deepseek/deepseek-v4-pro' });
  assert.equal(ok.modelId, 'hub-deepseek/deepseek-v4-pro');
  s.dispose();
});

test('复审二：用 opencode 自己配置时不删用户自己的模型 Key', () => {
  const dir = tmp();
  const o = profile.buildOpencodeCliOptions('opencode', { id: 'n1', cwd: dir }, {}, dir, { AI_HUB_OPENCODE_PATH: fakeBin(dir), PATH: '', ANTHROPIC_API_KEY: 'a1', AI_HUB_CLI_TOOLS_DIR: path.join(dir, 't') });
  assert.equal(o.route, 'native'); assert.equal(o.launch.env.ANTHROPIC_API_KEY, 'a1');
});
