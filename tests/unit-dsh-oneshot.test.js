'use strict';
// 后台单次功能用 DSH 外壳答一次（core/dsh-oneshot.js）：线路按所选来源拼配置、只收正文、权限一律拒、超时与取消、自有接口没填时报人话。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { run } = require('../core/dsh-oneshot');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-oneshot-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// 假 ACP 客户端：script 决定 session/prompt 时推哪些消息、怎么结束。
function fakeClient(script = {}) {
  const made = [];
  class FakeAcp extends EventEmitter {
    constructor(options) { super(); this.options = options; this.sent = []; this.responses = []; this.closed = false; made.push(this); }
    async start() { this.started = true; }
    request(method, params) {
      this.sent.push({ method, params });
      if (method === 'session/new') return Promise.resolve({ sessionId: 's1', configOptions: script.configOptions || [] });
      if (method === 'session/set_config_option') return Promise.resolve({});
      if (method === 'session/prompt') return script.prompt ? script.prompt(this) : Promise.resolve({ stopReason: 'end_turn' });
      return Promise.reject(new Error('unexpected ' + method));
    }
    async respond(id, result, error) { this.responses.push({ id, result, error }); }
    async notify(method, params) { this.sent.push({ method, params, notify: true }); }
    close() { this.closed = true; }
    chunk(kind, text) { this.emit('notification', { method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: kind, content: { type: 'text', text } } } }); }
  }
  return { FakeAcp, made };
}
function setup(t, extra = {}) {
  const dataDir = temp(t), cwd = path.join(dataDir, 'scratch');
  const calls = { proxy: [], build: [] };
  const opts = {
    dataDir, cwd, getConfig: () => ({ acp: {}, dshBackend: 'local' }),
    ensureProxy: async source => { calls.proxy.push(source); },
    ownConnection: () => ({ baseURL: 'https://own.example/v1', apiKey: 'sk-own-123456789', model: 'own-model' }),
    buildOptions: (kind, o, config, dir) => {
      calls.build.push({ kind, opts: o, config, dir });
      const home = path.join(dir, 'acp', 'h' + calls.build.length, 'home');
      fs.mkdirSync(home, { recursive: true });
      return { home, defaultMode: 'read-only', launch: { command: 'node', args: ['dsh'], cwd: o.cwd, env: {}, secrets: [] } };
    },
    ...extra,
  };
  return { opts, calls, dataDir, cwd };
}

test('部门 key：先拉起反代，按 proxy + gateway 建卡片只读会话，正文拼接、思考不收，用完关进程并清掉本次目录', async t => {
  const { FakeAcp, made } = fakeClient({ prompt: async c => { c.chunk('agent_thought_chunk', '想一想'); c.chunk('agent_message_chunk', ' 你好'); c.chunk('agent_message_chunk', '，世界 '); return { stopReason: 'end_turn' }; } });
  const activity = [];
  const { opts, calls, cwd } = setup(t, { AcpClient: FakeAcp, onActivity: x => activity.push(x) });
  const text = await run({ kind: 'deepseek-acp', source: 'gateway', model: 'deepseek-v4.1-flash' }, '问题', opts);
  assert.equal(text, '你好，世界');
  assert.deepEqual(calls.proxy, ['gateway']);
  const b = calls.build[0];
  assert.equal(b.kind, 'deepseek-acp');
  assert.equal(b.config.companyCli, true); assert.equal(b.config.dshBackend, 'proxy'); assert.equal(b.config.dshUpstream, 'gateway'); assert.equal(b.config.dshApiModel, 'deepseek-v4.1-flash');
  assert.equal(b.opts.dshCardAcp, true); assert.equal(b.opts.permissionMode, 'plan'); assert.equal(b.opts.model, 'deepseek-v4.1-flash');
  assert.match(b.opts.id, /^feature-[0-9a-f]{8}$/); assert.equal(b.opts.dshCardKeyTag, b.opts.id); assert.equal(b.opts.dshCardScope, undefined);
  assert.equal(b.opts.cwd, cwd); assert.ok(fs.existsSync(cwd));
  const c = made[0];
  assert.equal(c.options.cwd, path.join(b.dir, 'acp', 'h1', 'home'));
  assert.deepEqual(c.sent.find(s => s.method === 'session/new').params, { cwd, mcpServers: [] });
  assert.deepEqual(c.sent.find(s => s.method === 'session/prompt').params.prompt, [{ type: 'text', text: '问题' }]);
  assert.deepEqual(activity, [' 你好', '，世界 ']);
  assert.equal(c.closed, true);
  assert.equal(fs.existsSync(path.join(b.dir, 'acp', 'h1')), false);
});

test('公司模型走 proxy + company；外壳提供权限档时切到只读档', async t => {
  const { FakeAcp, made } = fakeClient({ configOptions: [{ id: 'mode', category: 'mode', currentValue: 'danger-full-access', options: [{ value: 'read-only' }, { value: 'danger-full-access' }] }],
    prompt: async c => { c.chunk('agent_message_chunk', 'ok'); return { stopReason: 'end_turn' }; } });
  const { opts, calls } = setup(t, { AcpClient: FakeAcp });
  await run({ kind: 'deepseek-acp', source: 'company', model: 'GLM-5.2-WX' }, 'q', opts);
  assert.deepEqual(calls.proxy, ['company']);
  assert.equal(calls.build[0].config.dshUpstream, 'company');
  assert.deepEqual(made[0].sent.find(s => s.method === 'session/set_config_option').params, { sessionId: 's1', configId: 'mode', value: 'read-only' });
});

test('自有接口：不拉反代，按 api 线路带上地址和 Key；没选模型用接口自己的模型', async t => {
  const { FakeAcp } = fakeClient({ prompt: async c => { c.chunk('agent_message_chunk', 'ok'); return { stopReason: 'end_turn' }; } });
  const { opts, calls } = setup(t, { AcpClient: FakeAcp });
  await run({ kind: 'deepseek-acp', source: 'own', model: '' }, 'q', opts);
  assert.deepEqual(calls.proxy, []);
  const cfg = calls.build[0].config;
  assert.equal(cfg.dshBackend, 'api'); assert.equal(cfg.dshUpstream, '');
  assert.equal(cfg.dshApiBaseUrl, 'https://own.example/v1'); assert.equal(cfg.dshApiKey, 'sk-own-123456789'); assert.equal(cfg.dshApiModel, 'own-model');
});

test('自有接口没填 / Key 要重填：报人话，不起进程', async t => {
  const { FakeAcp, made } = fakeClient();
  const a = setup(t, { AcpClient: FakeAcp, ownConnection: () => null });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'own', model: 'm' }, 'q', a.opts), /DSH 还没填自有接口/);
  const b = setup(t, { AcpClient: FakeAcp, ownConnection: () => ({ baseURL: 'https://x', apiKeyNeedsInput: true }) });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'own', model: 'm' }, 'q', b.opts), { message: require('../core/own-api-secrets').KEY_NEEDED });
  assert.equal(made.length, 0);
});

test('权限请求一律拒（优先 reject_once，没有就取消）；其他反向请求回 -32601', async t => {
  const { FakeAcp, made } = fakeClient({ prompt: async c => {
    c.emit('request', { id: 7, method: 'session/request_permission', params: { sessionId: 's1', options: [{ kind: 'allow_once', optionId: 'a' }, { kind: 'reject_once', optionId: 'r' }] } });
    c.emit('request', { id: 8, method: 'session/request_permission', params: { sessionId: 's1', options: [{ kind: 'allow_once', optionId: 'a' }] } });
    c.emit('request', { id: 9, method: 'fs/write_text_file', params: {} });
    c.chunk('agent_message_chunk', 'done');
    return { stopReason: 'end_turn' };
  } });
  const { opts } = setup(t, { AcpClient: FakeAcp });
  assert.equal(await run({ kind: 'deepseek-acp', source: 'gateway', model: 'm' }, 'q', opts), 'done');
  const r = made[0].responses;
  assert.deepEqual(r[0], { id: 7, result: { outcome: { outcome: 'selected', optionId: 'r' } }, error: undefined });
  assert.deepEqual(r[1].result, { outcome: { outcome: 'cancelled' } });
  assert.equal(r[2].result, null); assert.equal(r[2].error.code, -32601);
});

test('超时：报 timedOut、发 session/cancel 并关进程', async t => {
  const { FakeAcp, made } = fakeClient({ prompt: () => new Promise(() => {}) });
  const { opts } = setup(t, { AcpClient: FakeAcp, timeoutMs: 50 });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'gateway', model: 'm' }, 'q', opts), e => e.timedOut === true && e.message === '所选模型回答超时');
  assert.ok(made[0].sent.some(s => s.notify && s.method === 'session/cancel'));
  assert.equal(made[0].closed, true);
});

test('取消：报「已取消」并关进程', async t => {
  const ac = new AbortController();
  const { FakeAcp, made } = fakeClient({ prompt: () => { setTimeout(() => ac.abort(), 10); return new Promise(() => {}); } });
  const { opts } = setup(t, { AcpClient: FakeAcp, signal: ac.signal });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'gateway', model: 'm' }, 'q', opts), { message: '已取消' });
  assert.ok(made[0].sent.some(s => s.notify && s.method === 'session/cancel'));
  assert.equal(made[0].closed, true);
});

test('没答完或没内容：报「所选模型未能回答」', async t => {
  const { FakeAcp } = fakeClient({ prompt: async () => ({ stopReason: 'refusal' }) });
  const { opts } = setup(t, { AcpClient: FakeAcp });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'gateway', model: 'm' }, 'q', opts), /^Error: 所选模型未能回答：结束原因 refusal/);
  const empty = fakeClient();
  const s = setup(t, { AcpClient: empty.FakeAcp });
  await assert.rejects(run({ kind: 'deepseek-acp', source: 'gateway', model: 'm' }, 'q', s.opts), /所选模型未能回答：没有返回内容/);
});
