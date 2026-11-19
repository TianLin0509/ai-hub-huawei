'use strict';

// 2026-11-19 API 网关（部门 API key 用户）：Key 加密保存、保存前先验证、线路切换与会话环境。
// 用假的 safeStorage 与假的网关 fetch，不碰真实网关和真实 key。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gateway = require('../core/api-gateway');
const MODELS = ['qwen-aw-35b', 'deepseek-v4.1-flash', 'qwen3.8-27b', 'glm-5.3-flash'];
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('enc:' + s), decryptString: b => String(b).replace(/^enc:/, '') };
function fakeFetch({ key = 'sk-good', down = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    if (down) throw new Error('ECONNREFUSED');
    if (init.headers.authorization !== 'Bearer ' + key) return new Response('{"error":{"message":"Invalid token","type":"new_api_error"}}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS.map(id => ({ id })) }), { status: 200 });
    if (url.endsWith('/api/usage/token/')) return new Response(JSON.stringify({ code: true, data: { total_used: 25103, total_granted: 0, total_available: -25103, unlimited_quota: true, expires_at: 0 } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}
function tempDir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cfg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('首次保存：先验证再加密落盘，默认模型选 deepseek-v4.1-flash，文件里没有明文 key', async t => {
  const dir = tempDir(t);
  assert.equal(gateway.read(dir).keySet, false);
  assert.equal(gateway.read(dir).baseURL, gateway.DEFAULT_BASE_URL, '地址默认预填');
  const f = fakeFetch();
  const r = await gateway.save(dir, { apiKey: ' sk-good ' }, { safeStorage: fakeSafe, fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, MODELS);
  assert.equal(r.model, 'deepseek-v4.1-flash');
  assert.equal(r.keySet, true);
  const onDisk = fs.readFileSync(gateway.file(dir), 'utf8');
  assert.doesNotMatch(onDisk, /sk-good/);
  assert.equal(gateway.decryptKey(dir, fakeSafe), 'sk-good');
  assert.ok(r.choices.find(c => c.id === 'glm-5.3-flash').note.includes('推理'));
});

test('key 错误或网关不通：不落盘，返回白话原因与下一步', async t => {
  const dir = tempDir(t);
  const bad = await gateway.save(dir, { apiKey: 'sk-bad' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'bad_key'); assert.match(bad.message, /重新粘贴/);
  const down = await gateway.save(dir, { apiKey: 'sk-good' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch({ down: true }).impl });
  assert.equal(down.ok, false); assert.equal(down.code, 'unreachable'); assert.match(down.message, /内网/);
  assert.equal(fs.existsSync(gateway.file(dir)), false);
  await assert.rejects(gateway.save(dir, { apiKey: 'sk good\n' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl }), /不能包含空格或换行/);
  await assert.rejects(gateway.save(dir, { baseURL: 'ftp://x' , apiKey: 'sk-good' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl }), /网关地址/);
});

test('只改模型或地址时沿用已存的 key；用量接口读得出已用量与不限额', async t => {
  const dir = tempDir(t);
  await gateway.save(dir, { apiKey: 'sk-good' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  const again = await gateway.save(dir, { model: 'glm-5.3-flash' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  assert.equal(again.ok, true); assert.equal(again.model, 'glm-5.3-flash');
  assert.equal(gateway.resolveModel(dir, 'claude-haiku-4-5'), 'glm-5.3-flash', '表外名字落到默认模型');
  assert.equal(gateway.resolveModel(dir, 'qwen3.8-27b'), 'qwen3.8-27b');
  const u = await gateway.usage({ baseURL: gateway.read(dir).baseURL, apiKey: 'sk-good', fetchImpl: fakeFetch().impl });
  assert.deepEqual({ ok: u.ok, used: u.used, unlimited: u.unlimited }, { ok: true, used: 25103, unlimited: true });
  gateway.clear(dir);
  assert.equal(gateway.read(dir).keySet, false);
});

test('线路：选「API 网关」= 经反代 + 网关上游；切回公司模型或自有接口时去掉网关标记', async t => {
  const dir = tempDir(t);
  const prev = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prev; });
  const api = require('../core/company-api-config');
  assert.throws(() => api.withSettings({}, { kind: 'claude', backend: 'gateway' }), /粘贴 API key/, '没存 key 时不让切');
  await gateway.save(dir, { apiKey: 'sk-good' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  let raw = api.withSettings({}, { kind: 'claude', backend: 'gateway', model: 'glm-5.3-flash' });
  raw = api.withSettings(raw, { kind: 'deepseek-acp', backend: 'gateway' });
  assert.deepEqual(raw.providers.claude, { backend: 'proxy', model: 'glm-5.3-flash', upstream: 'gateway' });
  assert.deepEqual(raw.acp.companyApi, { backend: 'proxy', model: 'deepseek-v4.1-flash', upstream: 'gateway' });
  assert.equal(api.anyProxy(raw), true, '网关会话也要本机反代在跑');
  assert.equal(api.anyGateway(raw), true);
  const view = api.settings(raw);
  assert.equal(view.claude.upstream, 'gateway'); assert.equal(api.gatewayView().keySet, true);
  if (api.isCompany()) {
    const config = api.applyCompanyConfig({}, raw);
    assert.equal(config.claudeBackend, 'proxy'); assert.equal(config.claudeUpstream, 'gateway'); assert.equal(config.dshUpstream, 'gateway');
    const proxy = require('../core/company-model-proxy');
    assert.equal(proxy.usesGateway('claude', config), true);
    assert.equal(proxy.usesGateway('codex', config), false);
    api.assertLaunchConfigured('claude', config); // 有 key：不报错
  }
  const back = api.withSettings(raw, { kind: 'claude', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.equal('upstream' in back.providers.claude, false, '切回公司模型后没有网关标记');
  const own = api.withSettings(raw, { kind: 'claude', baseURL: 'https://example.com', apiKey: 'k', model: 'm' });
  assert.equal('upstream' in own.providers.claude, false, '切到自有接口后没有网关标记');
});

test('会话环境：Claude 会话的 key 带 __gw、模型照网关表；Codex 用独立 home 与网关模型目录', async t => {
  const dir = tempDir(t);
  await gateway.save(dir, { apiKey: 'sk-good', model: 'qwen3.8-27b' }, { safeStorage: fakeSafe, fetchImpl: fakeFetch().impl });
  const proxy = require('../core/company-model-proxy');
  proxy.ensureEndpoint(dir);
  const env = { ANTHROPIC_API_KEY: 'x' };
  const chosen = proxy.applyClaudeEnv(env, { dataDir: dir, sessionId: 'sess-1', model: 'glm-5.3-flash', gateway: true });
  assert.equal(chosen, 'glm-5.3-flash');
  assert.match(env.ANTHROPIC_AUTH_TOKEN, /\.sess-1__gw$/);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'glm-5.3-flash');
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.doesNotMatch(JSON.stringify(env), /sk-good/, '网关 key 不进会话环境，只在反代里');
  const company = {}; proxy.applyClaudeEnv(company, { dataDir: dir, sessionId: 'sess-2', model: 'glm-5.3-flash' });
  assert.equal(company.ANTHROPIC_MODEL, proxy.MODEL_IDS[0], '公司模型会话不受影响');
  assert.doesNotMatch(company.ANTHROPIC_AUTH_TOKEN, /__gw/);
  const codexEnv = {};
  proxy.applyCodexEnv(codexEnv, { dataDir: dir, sessionId: 'sess-3', model: 'deepseek-v4.1-flash', projectDir: dir, gateway: true });
  assert.equal(path.basename(codexEnv.CODEX_HOME), 'codex-api-gateway');
  const catalog = JSON.parse(fs.readFileSync(path.join(codexEnv.CODEX_HOME, 'company-model-catalog.json'), 'utf8'));
  assert.deepEqual(catalog.models.map(m => m.slug), MODELS);
  assert.match(fs.readFileSync(path.join(codexEnv.CODEX_HOME, 'config.toml'), 'utf8'), /model = "deepseek-v4.1-flash"/);
  const dsh = proxy.dshRoute({ dataDir: dir, sessionId: 'sess-4', model: '', gateway: true });
  assert.equal(dsh.model, 'qwen3.8-27b');
  assert.match(dsh.key, /__gw$/);
  assert.deepEqual(dsh.providerConfig.models.map(m => m.id), MODELS);
});

test('验证 key 时网关先回响应头、正文卡住：在超时内结束并提示连不上，不会一直「正在验证」', async () => {
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({ start(c) { signal.addEventListener('abort', () => c.error(new Error('aborted'))); } }), { status: 200 });
  const started = Date.now();
  const r = await gateway.probe({ baseURL: 'http://gw.test/v1', apiKey: 'k', fetchImpl, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unreachable');
  assert.ok(Date.now() - started < 2000);
});

test('群聊成员：当前走公司线路时选网关模型，保存成网关线路（不是自有接口）；选公司模型仍走公司线路', () => {
  const cards = require('../renderer/launch-model-cards.js');
  const provider = { backend: 'proxy', upstream: 'company', companyModels: [{ id: 'GLM-5.2-WX' }], gatewayModels: [{ id: 'glm-5.3-flash' }, { id: 'qwen-aw-35b' }] };
  assert.deepEqual(cards.memberSaveRequests([{ kind: 'claude', model: 'glm-5.3-flash' }], { claude: provider }), [{ kind: 'claude', backend: 'gateway', model: 'glm-5.3-flash' }]);
  assert.deepEqual(cards.memberSaveRequests([{ kind: 'claude', model: 'GLM-5.2-WX' }], { claude: provider }), [{ kind: 'claude', backend: 'proxy', model: 'GLM-5.2-WX' }]);
  // 已选中的自有接口恰好也叫这个名字：保留自有接口，不悄悄换到网关。
  const own = { backend: 'own', apiProfiles: [{ id: 'x', model: 'glm-5.3-flash' }], selectedProfileId: 'x', gatewayModels: [{ id: 'glm-5.3-flash' }] };
  assert.deepEqual(cards.memberSaveRequests([{ kind: 'claude', model: 'glm-5.3-flash' }], { claude: own }), [{ kind: 'claude', profileAction: 'select', profileId: 'x' }]);
  const plainApi = { backend: 'api', model: 'glm-5.3-flash', gatewayModels: [{ id: 'glm-5.3-flash' }] };
  assert.ok(!cards.memberSaveRequests([{ kind: 'claude', model: 'glm-5.3-flash' }], { claude: plainApi }).some(r => r.backend === 'gateway'), '没有命名 profile 的自有接口也保留');
});

test('自动识别 API 用户：在 Claude Code / Codex 设置和环境变量里找网关地址旁的 key，只回打码样子；没有网关地址的文件不取', t => {
  const detect = require('../core/api-gateway-detect');
  const home = tempDir(t);
  const k1 = 'sk-' + 'a'.repeat(40), k2 = 'sk-' + 'b'.repeat(40), k3 = 'sk-' + 'c'.repeat(40), other = 'sk-' + 'z'.repeat(40);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://gw.dept.example', ANTHROPIC_AUTH_TOKEN: k1 } }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model_provider = "ascend"\n[model_providers.ascend]\nbase_url = "http://gw.dept.example/v1"\n');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: k2 }));
  fs.mkdirSync(path.join(home, '.continue'), { recursive: true });
  fs.writeFileSync(path.join(home, '.continue', 'config.json'), JSON.stringify({ apiBase: 'https://api.openai.com/v1', apiKey: other }));
  const env = { OPENAI_BASE_URL: 'http://gw.dept.example/v1', OPENAI_API_KEY: k3, PATH: 'x' };
  const found = detect.detect('http://gw.dept.example/v1', { env, home, appData: path.join(home, 'AppData') });
  assert.deepEqual(found.map(f => f.source), ['环境变量', 'Claude Code 设置', 'Codex 设置']);
  assert.ok(found.every(f => /^sk-…\w{4}$/.test(f.masked)), '界面只拿到打码样子');
  assert.equal(JSON.stringify(found).includes(k1), false);
  assert.deepEqual(found.map(f => detect.take(f.id).key), [k3, k1, k2]);
  assert.equal(found.some(f => detect.take(f.id).key === other), false, '没有网关地址的配置里的 key 不取');
  // 同一份配置里还有别家供应商：只取紧挨着网关地址的那个 key；环境变量只取同前缀的。
  const mixed = JSON.stringify({ models: [{ apiBase: 'https://api.deepseek.com', apiKey: other }, { apiBase: 'http://gw.dept.example/v1', apiKey: k1 }] });
  assert.deepEqual(detect.pairedKeys(mixed, 'gw.dept.example'), [k1]);
  // 网关条目里地址和 key 之间隔着别的字段，也只取同一个对象里的 key（不按字符距离）。
  const spread = JSON.stringify({ models: [{ title: 'o', apiBase: 'https://api.openai.com/v1', apiKey: other }, { title: 'gw', provider: 'openai', model: 'x', apiBase: 'http://gw.dept.example/v1', apiKey: k1 }] });
  assert.deepEqual(detect.pairedKeys(spread, 'gw.dept.example'), [k1]);
  // Codex：只认当前选中的供应商；它写了 env_key 就取那个环境变量，不取全局 OPENAI_API_KEY。
  const H = 'gw.dept.example', gwToml = '[model_providers.gw]\nbase_url = "http://' + H + '/v1"\nenv_key = "GW_KEY"\n';
  assert.equal(detect.codexKey('model_provider = "openai"\n' + gwToml, JSON.stringify({ OPENAI_API_KEY: other }), { GW_KEY: k1 }, H), '');
  assert.equal(detect.codexKey('model_provider = "gw"\n' + gwToml, JSON.stringify({ OPENAI_API_KEY: other }), { GW_KEY: k1 }, H), k1);
  assert.equal(detect.codexKey("model_provider = 'gw'\n[model_providers.gw]\nbase_url = 'http://" + H + "/v1'\nenv_key = 'GW_KEY'\n", JSON.stringify({ OPENAI_API_KEY: other }), { GW_KEY: k1 }, H), k1, 'TOML 单引号');
  assert.equal(detect.codexKey('model_provider = "gw"\n[model_providers.gw]\nbase_url = "http://' + H + '/v1"\nenv_key = GW_KEY\n', JSON.stringify({ OPENAI_API_KEY: other }), { GW_KEY: k1 }, H), '', 'env_key 读不出就不推荐，不回退全局 key');
  // 非 JSON（如 YAML）配不了对：不看。
  assert.deepEqual(detect.pairedKeys('models:\n - apiBase: https://api.openai.com\n   apiKey: ' + other + '\n - apiBase: http://' + H + '/v1\n', H), []);
  const envMixed = detect.detect('http://gw.dept.example/v1', { env: { OPENAI_BASE_URL: 'http://gw.dept.example/v1', OPENAI_API_KEY: k3, DEEPSEEK_API_KEY: other }, home: tempDir(t) });
  assert.deepEqual(envMixed.map(f => detect.take(f.id).key), [k3]);
  assert.notEqual(envMixed[0].id, found[0].id, '每次检测的编号都不同，旧按钮不会指到别的 key');
  assert.deepEqual(detect.detect('http://gw.dept.example/v1', { env: {}, home: tempDir(t) }), []);
});
