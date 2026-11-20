// 2026-11-20 API 网关体检（B 线）：目录解析与分组推断（用 11-20 黄区 /api/pricing 还原样本）、报错分类、
// 本机代理的流式整理（五种变体）、首字等待上限、一键体检（假网关）、目录缓存不变空、真实反代里的报错与不重试头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeStream, normalizeChunk, explainGatewayError, createGatewayProvider, gatewayBody } from '../core/company-proxy/gateway-provider.mjs';
import { main } from '../core/company-proxy/server.mjs';

const require = createRequire(import.meta.url);
const catalogLib = require('../core/api-gateway-catalog');
const errors = require('../core/api-gateway-errors');
const health = require('../core/api-gateway-healthcheck');
const gateway = require('../core/api-gateway');
const { startFakeAscend, PRICING, FREE } = require('./helpers/fake-ascend-gateway');

const fakeSafe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).replace(/^enc:/, '') };
async function tempDir(t) { const d = await mkdtemp(join(tmpdir(), 'ascend-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }

// ---------- 目录与分组 ----------
test('目录：8 个模型里 5 个对话模型，生图 / 生视频 / 语音 3 个排除；上下文从标签和说明里取到 256K', () => {
  const c = catalogLib.parsePricing(PRICING);
  assert.equal(c.models.length, 8);
  assert.deepEqual(c.models.filter(m => !m.chat).map(m => m.id).sort(), ['minimax-h3', 'platform-tts', 'qwen-image-2.1']);
  assert.equal(c.models.find(m => m.id === 'qwen3.8-27b').context, 256000, '标签「256K上下文」');
  assert.equal(c.models.find(m => m.id === 'deepseek-v4.1-flash').context, 256000, '说明「上下文256K」');
  assert.equal(c.models.find(m => m.id === 'glm-5.3-flash').context, 0, '没写的不猜');
  assert.equal(catalogLib.contextOf(c, 'glm-5.3-flash'), 128000, '取不到用保守默认');
  assert.deepEqual(c.models.find(m => m.id === 'glm-5.3-flash').endpoints, ['anthropic', 'openai']);
  assert.deepEqual(Object.keys(c.groups).sort(), ['default', 'free', 'max', 'vip']);
  assert.equal(c.groups.free.ratio, 0.01); assert.match(c.groups.free.desc, /签到/);
  assert.equal(c.groups.max.ratio, 10);
  assert.equal(catalogLib.parseContext('支持 128k context'), 128000);
  assert.equal(catalogLib.parseContext('上下文 1M'), 1000000);
});

test('分组推断：负责人的 key 看到 4 个 → free；max、default 的 key 也各自认得出；看不到的模型说清开给谁', () => {
  const c = catalogLib.parsePricing(PRICING);
  assert.deepEqual(catalogLib.inferGroup(c, FREE), { group: 'free', exact: true, candidates: ['free'] });
  assert.equal(catalogLib.inferGroup(c, ['qwen3.8-27b', 'deepseek-v4.1-flash', 'glm-5.3-flash']).group, 'max');
  const def = c.models.filter(m => m.groups.includes('default')).map(m => m.id);
  assert.equal(catalogLib.inferGroup(c, def).group, 'default');
  const near = catalogLib.inferGroup(c, ['qwen-aw-35b', 'deepseek-v4.1-flash']);
  assert.equal(near.exact, false, '对不齐时标出「推断」');
  const s = catalogLib.summarize(c, FREE);
  assert.deepEqual(s.hidden, [{ id: 'qwen3.8-flash-next', groups: ['default'] }]);
  assert.equal(s.groupRatio, 0.01);
});

test('目录缓存：拉到新目录才覆盖；网关不通或返回空目录时保留上一版，界面不突然变空', async t => {
  const dir = await tempDir(t);
  const gw = await startFakeAscend(); t.after(() => gw.close());
  const first = await catalogLib.refresh(dir, { baseURL: gw.baseURL });
  assert.equal(first.ok, true); assert.equal(first.catalog.models.length, 8);
  const empty = await catalogLib.refresh(dir, { baseURL: gw.baseURL, fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [] })) });
  assert.equal(empty.ok, false); assert.equal(empty.code, 'empty'); assert.equal(empty.stale, true); assert.equal(empty.catalog.models.length, 8);
  const down = await catalogLib.refresh(dir, { baseURL: gw.baseURL, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.code, 'unreachable'); assert.equal(down.catalog.models.length, 8);
  assert.equal(catalogLib.cached(dir, 'http://other.example/v1'), null, '换了网关不拿别家的旧目录');
});

// ---------- 报错翻译 ----------
test('报错分类：每类一句人话 + 按钮；key 无效、无权限、白名单、额度、分组无渠道不重试；原话打码', () => {
  const body = (message, code = '') => JSON.stringify({ error: { message, code, type: 'new_api_error' } });
  const c = (status, b, ctx = {}) => errors.classify({ status, body: b, model: 'qwen3.8-flash-next', usable: FREE, ...ctx });
  const cases = [
    [c(401, body('Invalid token')), 'bad_key', false, ['rekey']],
    [c(403, body('该令牌无权使用模型：x')), 'forbidden', false, ['switch-model']],
    [c(403, body('模型无权限')), 'forbidden', false, []],
    [c(403, body('不在白名单中')), 'forbidden', false, []],
    // 教程按钮只在有教程地址的成员版出现；公开版导出时剥掉了地址（core/api-gateway-errors.js 的 TUTORIAL_URL）。
    [c(403, body('用户额度不足，剩余额度：0')), 'quota', false, errors.TUTORIAL_URL ? ['tutorial'] : []],
    [c(429, body('token quota is not enough')), 'quota', false, []],
    [c(503, body('No available channel for model qwen3.8-flash-next under group free (distributor)', 'model_not_found')), 'no_channel', false, ['switch-model', 'group-help']],
    [c(503, body('当前分组 free 下对于模型 x 无可用渠道')), 'no_channel', false, []],
    [c(503, body('No available channel for model ghost under group free', 'model_not_found'), { model: 'ghost', known: ['qwen-aw-35b'] }), 'model_gone', false, ['switch-model']],
    [c(400, body("This model's maximum context length is 262144 tokens", 'context_length_exceeded')), 'context_too_long', false, []],
    [c(404, body('model qwen3.8-flash-next is not served here')), 'model_gone', false, ['switch-model']],
    [c(404, '404 page not found'), 'http_404', false, [], '不点名模型的 404 是地址不对：留给 http_404，自有接口「测试连接」靠它补 /v1'],
    [c(404, ''), 'http_404', false, []],
    [errors.classify({ status: 404, body: 'Not Found' }), 'http_404', false, []],
    [c(429, body('Too Many Requests')), 'rate_limited', true, ['retry']],
    [c(502, '<html>bad gateway</html>'), 'server', true, []],
    [errors.classify({ networkCode: 'unreachable' }), 'unreachable', true, ['retry']],
    [errors.classify({ networkCode: 'timeout', waitedMs: 61000, model: 'glm-5.3-flash', usable: FREE }), 'timeout', true, ['switch-model']],
  ];
  for (const [r, code, retry, actions, why = ''] of cases) {
    assert.equal(r.code, code, why + JSON.stringify(r));
    assert.equal(r.retry, retry, code + ' retry');
    for (const a of actions) assert.ok(r.actions.includes(a), `${code} 有按钮 ${a}`);
    if (!errors.TUTORIAL_URL) assert.ok(!r.actions.includes('tutorial'), `${code} 没有教程地址时不出「打开教程」`);
    assert.ok(r.message && r.title, code + ' 有人话');
  }
  const free = c(503, body('No available channel for model qwen3.8-flash-next under group free'));
  assert.match(free.title, /不对你的 free 分组开放/);
  assert.match(free.message, /能用的有：qwen-aw-35b、deepseek-v4.1-flash/);
  assert.doesNotMatch(free.message, /网络/, '不再说成网络波动');
  const leaked = errors.classify({ status: 401, body: body('Invalid token sk-abcdefghijklmnop1234 for user 12345678 at http://10.1.2.3:3000/x') });
  assert.doesNotMatch(leaked.detail, /sk-abcdefghijklmnop1234|12345678|10\.1\.2\.3/);
  assert.match(leaked.detail, /Invalid token/);
});

// ---------- 流式整理（本机代理） ----------
async function pipe(text, model = 'deepseek-v4.1-flash') {
  const body = new Response(text).body;
  return new Response(normalizeStream(body, model)).text();
}
const dataLines = text => text.split('\n').filter(l => l.startsWith('data:'));
test('流式整理五种变体：正常、每段带空 tool_calls、reasoning、data: 后没空格、解析不了的行原样透传', async () => {
  // 1 正常
  const normal = await pipe('data: {"model":"dsv41","choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  assert.deepEqual(JSON.parse(dataLines(normal)[0].slice(6)), { model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'OK' } }] });
  assert.ok(normal.includes('data: [DONE]'));
  // 2 每段都带空 tool_calls：删掉，正文保留；真有工具调用的不动
  const empty = await pipe('data: {"choices":[{"delta":{"content":"现在","tool_calls":[]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]}}]}\n\n');
  const [a, b] = dataLines(empty).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(a.choices[0].delta, { content: '现在' });
  assert.equal(b.choices[0].delta.tool_calls.length, 1);
  // 3 reasoning → reasoning_content；已有 reasoning_content 的不重复
  const think = await pipe('data: {"choices":[{"delta":{"reasoning":"想"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"已是标准"}}]}\n\n');
  const [r1, r2] = dataLines(think).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(r1.choices[0].delta, { reasoning_content: '想' });
  assert.deepEqual(r2.choices[0].delta, { reasoning_content: '已是标准' });
  // 4 data: 后没空格：补上
  const tight = await pipe('data:{"choices":[{"delta":{"content":"x","tool_calls":[]}}]}\n\ndata:[DONE]\n\n');
  assert.ok(dataLines(tight)[0].startsWith('data: {'), '补上空格');
  assert.deepEqual(JSON.parse(dataLines(tight)[0].slice(6)).choices[0].delta, { content: 'x' });
  assert.ok(tight.includes('data:[DONE]'), '[DONE] 原样');
  // 5 解析不了的行、注释行、event 行原样透传；跨块拼接
  const odd = 'event: ping\n: keep-alive\ndata: {not json\n\n';
  assert.equal(await pipe(odd), odd);
  const enc = new TextEncoder();
  const split = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"con')); c.enqueue(enc.encode('tent":"拼","tool_calls":[]}}]}\n\n')); c.close(); } });
  const joined = await new Response(normalizeStream(split, 'm')).text();
  assert.deepEqual(JSON.parse(dataLines(joined)[0].slice(6)).choices[0].delta, { content: '拼' });
  assert.equal(normalizeChunk({ choices: [{ message: { content: 'x', tool_calls: [] } }] }).choices[0].message.tool_calls, undefined);
});

// ---------- 首字等待上限 ----------
test('首字等待上限：至少原来的 150 秒、只往上调（首字 × 6，最多 300 秒）；没测过 150 秒', () => {
  assert.equal(health.firstTokenTimeoutMs(undefined), 150000);
  assert.equal(health.firstTokenTimeoutMs(0), 150000);
  assert.equal(health.firstTokenTimeoutMs(3000), 150000, '快模型也不低于原来的 150 秒（长上下文 prefill 慢，不能误判 504）');
  assert.equal(health.firstTokenTimeoutMs(15000), 150000);
  assert.equal(health.firstTokenTimeoutMs(31000), 186000, '慢模型往上放宽');
  assert.equal(health.firstTokenTimeoutMs(60000), 300000);
  assert.equal(health.firstTokenTimeoutMs(120000), 300000, '最多 300 秒');
});

test('代理按模型自适应首包等待：快模型仍等满 150 秒，测到首字慢的模型放宽', async () => {
  const waits = [];
  const fetchImpl = (url, init) => new Promise((_, reject) => { const t0 = Date.now(); init.signal.addEventListener('abort', () => { waits.push(Date.now() - t0); reject(new Error('aborted')); }); });
  const provider = createGatewayProvider({ baseURL: 'http://gw.test/v1', apiKey: 'k', fetchImpl, ownError: (s, m, h) => new Response(JSON.stringify({ m }), { status: s, headers: h }),
    firstTokenMs: { fast: 1, slow: 40000 } });
  // 只校验算出的上限传进了请求：替换计时器观察
  const realSetTimeout = globalThis.setTimeout; const asked = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { asked.push(ms); return realSetTimeout(fn, 5, ...rest); };
  try {
    const r = await provider.complete({ model: 'fast', messages: [] });
    assert.equal(r.status, 504);
    const r2 = await provider.complete({ model: 'unknown', messages: [] });
    assert.equal(r2.status, 504);
    const r3 = await provider.complete({ model: 'slow', messages: [] });
    assert.equal(r3.status, 504);
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(asked.slice(0, 2), [150000, 150000], '测到首字快的模型不往下压：每次 150 秒，共重试 1 次');
  assert.deepEqual(asked.slice(2, 4), [150000, 150000], '没测过的：每次 150 秒');
  assert.deepEqual(asked.slice(4, 6), [240000, 240000], '首字 40 秒的慢模型：放宽到 240 秒');
  assert.equal(waits.length, 6);
});

// ---------- 一键体检（假网关） ----------
test('一键体检：4 个对话模型并发试跑，能力表写清能不能用、首字、工具、思考、上下文、接口；503 分组无渠道讲成人话', async t => {
  const dir = await tempDir(t);
  const gw = await startFakeAscend({ keyModels: [...FREE, 'qwen-image-2.1'] }); t.after(() => gw.close());
  const saved = await gateway.save(dir, { baseURL: gw.baseURL, apiKey: gw.key }, { safeStorage: fakeSafe });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models, FREE, '生图模型不进对话模型表');
  assert.equal(saved.group, 'free', '多看到一个生图模型也推得出 free（按重合度）');
  assert.equal(saved.catalog.hidden[0].id, 'qwen3.8-flash-next');
  const progress = [];
  const r = await gateway.healthcheck(dir, { safeStorage: fakeSafe, onProgress: row => progress.push(row.id) });
  assert.equal(r.ok, true);
  assert.equal(progress.length, 4);
  const row = id => r.health.rows.find(x => x.id === id);
  assert.equal(row('deepseek-v4.1-flash').ok, true); assert.equal(row('deepseek-v4.1-flash').tools, true); assert.equal(row('deepseek-v4.1-flash').thinking, false);
  assert.equal(row('deepseek-v4.1-flash').context, 256000);
  assert.equal(row('glm-5.3-flash').tools, true); assert.equal(row('glm-5.3-flash').thinking, true);
  assert.deepEqual(row('glm-5.3-flash').endpoints, ['anthropic', 'openai']);
  assert.equal(row('qwen-aw-35b').ok, true); assert.equal(row('qwen-aw-35b').tools, false, '只回正文不调工具');
  assert.ok(row('qwen-aw-35b').emptyToolCalls >= 3, '记下了空 tool_calls 形态');
  assert.equal(row('qwen3.8-27b').ok, false); assert.equal(row('qwen3.8-27b').error.code, 'no_channel');
  assert.match(row('qwen3.8-27b').error.title, /free 分组/);
  assert.ok(row('deepseek-v4.1-flash').firstMs >= 0);
  // 请求本身：极短、流式、带一个工具、max_tokens 小
  for (const b of gw.seen) { assert.equal(b.stream, true); assert.equal(b.tools.length, 1); assert.ok(b.max_tokens <= 1024); }
  // 能力以体检为准：下拉框说明、给反代的首字时间
  const notes = Object.fromEntries(gateway.modelChoices(dir).map(c => [c.id, c.note]));
  assert.match(notes['deepseek-v4.1-flash'], /首字 .* · 会用工具 · 上下文 256K/);
  assert.match(notes['glm-5.3-flash'], /会先思考/);
  assert.match(notes['qwen3.8-27b'], /暂不可用/);
  assert.deepEqual(Object.keys(gateway.firstTokenMs(dir)).sort(), ['deepseek-v4.1-flash', 'glm-5.3-flash', 'qwen-aw-35b']);
  assert.equal(gateway.contextOf(dir, 'qwen3.8-27b'), 256000);
  assert.equal(gateway.contextOf(dir, 'glm-5.3-flash'), 128000);
  const onDisk = await readFile(health.file(dir), 'utf8');
  assert.doesNotMatch(onDisk, new RegExp(gw.key), '体检记录里没有 key');
});

test('一键体检：模型表拉取失败时不覆盖旧表；key 失效讲成「key 无效」', async t => {
  const dir = await tempDir(t);
  const gw = await startFakeAscend(); t.after(() => gw.close());
  await gateway.save(dir, { baseURL: gw.baseURL, apiKey: gw.key }, { safeStorage: fakeSafe });
  const before = gateway.read(dir).models;
  const r = await gateway.healthcheck(dir, { safeStorage: { ...fakeSafe, decryptString: () => 'wrong-key' } });
  assert.equal(r.ok, false); assert.equal(r.code, 'bad_key');
  assert.deepEqual(gateway.read(dir).models, before);
  const none = await gateway.healthcheck(await tempDir(t), { safeStorage: fakeSafe });
  assert.equal(none.code, 'no_key');
});

test('体检单个模型挂起：首字等待到点就停，记「太久没开始回答」，别的模型照常测完', async t => {
  const gw = await startFakeAscend({ behaviors: { 'qwen-aw-35b': 'hang' } }); t.after(() => gw.close());
  const results = await health.run({ baseURL: gw.baseURL, apiKey: gw.key, models: ['qwen-aw-35b', 'deepseek-v4.1-flash'], firstTimeoutMs: 300, totalTimeoutMs: 2000 });
  assert.equal(results[0].ok, false); assert.equal(results[0].error.code, 'timeout');
  assert.equal(results[1].ok, true);
});

// ---------- 真实反代 + 假网关 ----------
async function startProxy(t, gw, extraEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ascend-proxy-'));
  const key = 'b'.repeat(48);
  const env = { AI_HUB_COMPANY_PROXY_KEY: key, AI_HUB_API_GATEWAY_URL: gw.baseURL, AI_HUB_API_GATEWAY_KEY: gw.key,
    AI_HUB_API_GATEWAY_MODELS: FREE.join(','), AI_HUB_API_GATEWAY_MODEL: 'deepseek-v4.1-flash', AI_HUB_API_GATEWAY_GROUP: 'free',
    AI_HUB_API_GATEWAY_FIRST_MS: JSON.stringify({ 'deepseek-v4.1-flash': 4000 }), ...extraEnv };
  const running = main(['--data-dir', dataDir, '--port', '0', '--mock-upstream'], { env });
  const stateFile = join(dataDir, 'company-model-proxy', 'proxy-state.json');
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { try { port = JSON.parse(fs.readFileSync(stateFile, 'utf8')).port; } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.ok(port, 'proxy listening');
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await fetch(origin + '/admin/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + key } }).catch(() => {});
    await running.catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  return { origin, key };
}

test('真实反代：503 分组无渠道 → 400「不对你的 free 分组开放」+ 能用的模型，只发一次不重试；Claude 入口也一样', async t => {
  const gw = await startFakeAscend(); t.after(() => gw.close());
  const p = await startProxy(t, gw);
  const res = await fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.s1__gw` },
    body: JSON.stringify({ model: 'qwen3.8-27b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 400);
  const text = JSON.stringify(await res.json());
  assert.match(text, /不对你的 free 分组开放/); assert.match(text, /deepseek-v4\.1-flash/); assert.match(text, /网关原话/);
  const claude = await fetch(p.origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.s2__gw`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'qwen3.8-27b', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(claude.status, 400);
  assert.match(JSON.stringify(await claude.json()), /free 分组/);
  assert.equal(gw.seen.length, 2, '不重试：每个请求只发一次');
});

test('真实反代：每段带空 tool_calls、data: 没空格的流，经 Codex 入口正文完整不被吞', async t => {
  const gw = await startFakeAscend(); t.after(() => gw.close());
  const p = await startProxy(t, gw);
  const res = await fetch(p.origin + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.c1__gw` },
    body: JSON.stringify({ model: 'qwen-aw-35b', stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: '几点了' }] }] }) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const text = raw.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
    .filter(e => e?.type === 'response.output_text.delta').map(e => e.delta).join('');
  assert.equal(text, '现在是下午三点');
  assert.doesNotMatch(raw, /function_call/, '没有凭空多出工具调用');
});

test('真实反代：额度不足、key 无效都不重试，状态码分别是 400 / 401', async t => {
  const gw = await startFakeAscend({ behaviors: { 'deepseek-v4.1-flash': 'quota' } }); t.after(() => gw.close());
  const p = await startProxy(t, gw);
  const ask = model => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.q__gw` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  const quota = await ask('deepseek-v4.1-flash');
  assert.equal(quota.status, 400, '4xx：客户端不会自己重试');
  assert.match(JSON.stringify(await quota.json()), /额度/);
  const e = explainGatewayError(401, '{"error":{"message":"Invalid token"}}');
  assert.equal(e.status, 401); assert.equal(e.retry, false); assert.match(e.message, /重新粘贴/);
});

test('只出思考的提示只进用户看得见的对话：Claude Code 后台起标题（不带工具）不注入，带工具的对话回合照补', async t => {
  const gw = await startFakeAscend({ behaviors: { 'qwen-aw-35b': 'think-only' } }); t.after(() => gw.close());
  const p = await startProxy(t, gw);
  const ask = extra => fetch(p.origin + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': `${p.key}.t1__gw`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'qwen-aw-35b', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '给这段对话起个标题' }], ...extra }) }).then(r => r.text());
  const title = await ask({});
  assert.doesNotMatch(title, /想了太久/, '标题请求的输出会被当成会话标题，不能注入提示');
  const turn = await ask({ tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }] });
  assert.match(turn, /想了太久/, '用户对话回合照常补提示');
  // 直接调用 provider：track=false 同样不注入
  const provider = createGatewayProvider({ baseURL: gw.baseURL, apiKey: gw.key, ownError: (s, m) => new Response(m, { status: s }) });
  const bg = await (await provider.complete({ model: 'qwen-aw-35b', messages: [] }, { track: false })).text();
  assert.doesNotMatch(bg, /想了太久/);
  assert.match(await (await provider.complete({ model: 'qwen-aw-35b', messages: [] })).text(), /想了太久/);
});

// ---------- 会话里的报错卡 ----------
test('会话报错卡：API 网关的人话先认——分组无渠道不再是「网络波动」，key 无效不再是「登录过期」', () => {
  const { classifyError } = require('../renderer/turn-error-help');
  const line = message => `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"${message}"}}`;
  const group = classifyError(line(explainGatewayError(503, '{"error":{"message":"No available channel for model qwen3.8-27b under group free"}}', { model: 'qwen3.8-27b', usable: FREE }).message));
  assert.equal(group.kind, 'gateway-model'); assert.ok(group.actions.includes('model'));
  assert.equal(classifyError(line(explainGatewayError(401, '{"error":{"message":"Invalid token"}}').message)).kind, 'gateway-key');
  assert.equal(classifyError(line(explainGatewayError(403, '{"error":{"message":"用户额度不足"}}').message)).kind, 'gateway-quota');
  assert.equal(classifyError(line(explainGatewayError(400, '{"error":{"message":"maximum context length is 262144 tokens"}}', { model: 'm' }).message)).kind, 'context');
  assert.equal(classifyError('API Error: 502 upstream connect error').kind, 'service', '别的服务报错照旧');
});

// ---------- 黄区真实流样本（11-20 负责人抓包，tests/fixtures/ascend-sse-yellow-20261120.txt）----------
// 每条流只留了前 4 帧和最后 2 帧（usage 帧 "choices": [] 与 [DONE]）；思考字段叫 delta.reasoning；帧里带 vLLM 的
// prompt_token_ids / token_ids（null）；同一条流里有的帧冒号后带空格、有的不带。
function yellowStreams() {
  const text = fs.readFileSync(new URL('./fixtures/ascend-sse-yellow-20261120.txt', import.meta.url), 'utf8');
  const out = {};
  for (const block of text.split(/^### /m).slice(1)) {
    const [head, ...rest] = block.split('\n');
    const [model, tools] = head.split(' ');
    out[`${model} ${tools}`] = rest.filter(l => l.trim().startsWith('data:')).map(l => l.trim()).join('\n\n') + '\n\n';
  }
  return out;
}
test('黄区真流回归：思考 reasoning→reasoning_content、模型简称回写、usage 帧 choices:[] 与 vLLM 额外字段原样、空格不一的帧都认', async () => {
  const streams = yellowStreams();
  assert.ok(Object.keys(streams).length >= 8, '8 条流');
  const qwen = await pipe(streams['qwen3.8-27b tools=False'], 'qwen3.8-27b');
  const frames = dataLines(qwen).filter(l => !l.includes('[DONE]')).map(l => JSON.parse(l.slice(5)));
  assert.ok(frames.every(f => f.model === 'qwen3.8-27b'), '模型名回写成请求名');
  assert.equal(frames[1].choices[0].delta.reasoning_content, 'We');
  assert.equal('reasoning' in frames[1].choices[0].delta, false);
  assert.equal(frames[0].prompt_token_ids, null, 'vLLM 额外字段不删');
  assert.deepEqual(frames.at(-1).choices, [], 'usage 帧照旧');
  assert.equal(frames.at(-1).usage.completion_tokens_details.reasoning_tokens, 48);
  assert.ok(qwen.includes('data: [DONE]'));
  const ds = await pipe(streams['deepseek-v4.1-flash tools=True'], 'deepseek-v4.1-flash');
  const text = dataLines(ds).filter(l => !l.includes('[DONE]')).map(l => JSON.parse(l.slice(5))).flatMap(f => f.choices.map(c => c.delta?.content || '')).join('');
  assert.equal(text, 'Hello there, nice to meet', '正文一字不少');
  // 体检读流：qwen 这条只有思考 → 首思考有、首正文没有、标「想太久没回答」
  const stat = await health.readStream(new Response(streams['qwen3.8-27b tools=False']).body, { started: Date.now() });
  assert.equal(stat.thinking, true); assert.notEqual(stat.firstThinkMs, null); assert.equal(stat.firstTextMs, null); assert.equal(stat.text, 0);
  const dstat = await health.readStream(new Response(streams['deepseek-v4.1-flash tools=True']).body, { started: Date.now() });
  assert.notEqual(dstat.firstTextMs, null); assert.equal(dstat.firstThinkMs, null);
});

test('只出思考、到输出上限也没正文：代理在结束帧前补一句人话，指向「关闭思考」；有正文的流不补', async () => {
  const thinkOnly = 'data: {"id":"x","model":"q","choices":[{"index":0,"delta":{"reasoning":"想"}}]}\n\ndata: {"id":"x","model":"q","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
  const out = await pipe(thinkOnly, 'qwen-aw-35b');
  const frames = dataLines(out).filter(l => !l.includes('[DONE]')).map(l => JSON.parse(l.slice(5)));
  assert.equal(frames.length, 3);
  assert.match(frames[1].choices[0].delta.content, /想了太久.*关闭思考/);
  assert.equal(frames[2].choices[0].finish_reason, 'length', '原结束帧保留在后面');
  const answered = 'data: {"choices":[{"index":0,"delta":{"reasoning":"想"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"答"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n';
  assert.doesNotMatch(await pipe(answered), /想了太久/);
});

test('关闭思考：按模型存；代理只给这些模型注入 enable_thinking=false；体检按设置试跑；能力表分首思考 / 首正文', async t => {
  const body = gatewayBody({ model: 'm', messages: [], chat_template_kwargs: { other: 1 } }, { noThinking: true });
  assert.deepEqual(body.chat_template_kwargs, { other: 1, enable_thinking: false });
  assert.equal('chat_template_kwargs' in gatewayBody({ model: 'm', messages: [] }), false);
  const dir = await tempDir(t);
  const gw = await startFakeAscend(); t.after(() => gw.close());
  await gateway.save(dir, { baseURL: gw.baseURL, apiKey: gw.key }, { safeStorage: fakeSafe });
  assert.deepEqual(gateway.setThinking(dir, 'qwen-aw-35b', false).noThinking, ['qwen-aw-35b']);
  const r = await gateway.healthcheck(dir, { safeStorage: fakeSafe });
  const sent = id => gw.seen.find(b => b.model === id);
  assert.deepEqual(sent('qwen-aw-35b').chat_template_kwargs, { enable_thinking: false });
  assert.equal('chat_template_kwargs' in sent('glm-5.3-flash'), false);
  const glm = r.health.rows.find(x => x.id === 'glm-5.3-flash');
  assert.notEqual(glm.firstThinkMs, null); assert.notEqual(glm.firstTextMs, null, '工具调用算正文');
  assert.match(gateway.modelChoices(dir).find(c => c.id === 'glm-5.3-flash').note, /首思考 .* · 首正文/);
  assert.match(gateway.modelChoices(dir).find(c => c.id === 'qwen-aw-35b').note, /已关闭思考/);
  assert.deepEqual(gateway.setThinking(dir, 'qwen-aw-35b', true).noThinking, []);
});

test('真实反代：NO_THINK 里的模型请求带 enable_thinking=false，别的模型不带', async t => {
  const gw = await startFakeAscend(); t.after(() => gw.close());
  const p = await startProxy(t, gw, { AI_HUB_API_GATEWAY_NO_THINK: 'qwen-aw-35b' });
  const ask = model => fetch(p.origin + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}.n__gw` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) }).then(r => r.text());
  await ask('qwen-aw-35b'); await ask('deepseek-v4.1-flash');
  assert.deepEqual(gw.seen[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal('chat_template_kwargs' in gw.seen[1], false);
});
