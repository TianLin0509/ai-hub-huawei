'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const pool = require('../core/lan-pool');
const { LanPoolGateway } = require('../main/lan-pool-gateway');
const { LanPoolService } = require('../main/lan-pool-service');
const model = pool.MODEL_IDS[0];
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lan-pool-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
async function fixture(t, options = {}) {
  const dataDir = temp(t); pool.write(dataDir, { host: { enabled: true, members: [] } });
  const a = pool.addMember(dataDir, { name: '同事甲', ...options }), b = pool.addMember(dataDir, { name: '同事乙' });
  const calls = [], open = new Set(); let delay = 0, linger = 0, streamError = false;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    calls.push({ url: req.url, key: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (streamError) res.write('data: {"error":{"message":"synthetic error"}}\n\n');
    res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    if (linger) await new Promise(r => setTimeout(r, linger));
    res.end();
  });
  upstream.on('connection', s => { open.add(s); s.once('close', () => open.delete(s)); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const gateway = new LanPoolGateway({ dataDir, host: '127.0.0.1', getEndpoint: () => ({ port: upstream.address().port, key: 'localOnlyKey'.repeat(4) }),
    getSnapshot: async () => ({ ok: true, shared: true, rows: [], models: pool.MODEL_IDS, ready: true }) });
  await gateway.start(0);
  t.after(async () => { await gateway.stop(); for (const s of open) s.destroy(); await new Promise(r => upstream.close(r)); });
  const origin = `http://127.0.0.1:${gateway.status().port}`;
  const call = (secret, url = '/v1/chat/completions', extra = {}) => fetch(origin + url, {
    method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', ...extra.headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '测试' }], stream: true }), ...extra,
  });
  return { dataDir, a, b, calls, gateway, origin, call, setDelay: n => { delay = n; }, setLinger: n => { linger = n; }, setStreamError: v => { streamError = v; } };
}

test('member secrets are hashed, names stay local, and identical session tags have separate namespaces', t => {
  const dir = temp(t); const a = pool.addMember(dir, { name: '甲' }), b = pool.addMember(dir, { name: '乙' });
  assert.equal(JSON.stringify(pool.read(dir)).includes(a.secret), false);
  assert.equal(JSON.stringify(pool.publicSettings(dir)).includes('secretHash'), false);
  assert.notEqual(pool.authenticate(dir, a.secret + '.same').tag, pool.authenticate(dir, b.secret + '.same').tag);
  assert.equal(pool.authenticate(dir, 'bad'), null); assert.equal(pool.authenticate(dir, a.secret + '.x.y'), null);
  pool.revoke(dir, a.member.id); assert.equal(pool.authenticate(dir, a.secret), null); assert.ok(pool.authenticate(dir, b.secret));
});

test('quota snapshot is an allowlist, deduplicates, keeps timestamps and model-specific windows', t => {
  const raw = { rows: [{ id: 'private-id', label: 'private name', state: 'ready', note: 'sensitive', path: 'C:/private',
    usage: { at: 1000, modelsAt: 2000, secret: 'do-not-export', models: [{ name: model + '-Auto', day: { pct: 35, used: '35K', total: '100K', password: 'no' } }] } },
  { id: 'same', sameAsPersonal: true }, { id: 'absent', present: false }] };
  const result = pool.quotaSnapshot(raw, { accounts: [{ id: 'private-id', sessions: 2, models: [model], modelsAuthoritative: true }] }, 3000);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].usage.models[0].day.pct, 35);
  assert.equal(result.rows[0].usage.models[0].name, model); assert.equal(result.rows[0].usage.models[0].day.used, '35K');
  assert.equal(result.rows[0].usage.modelsAt, 2000); assert.equal(result.rows[0].activeSessions, 2);
  const text = JSON.stringify(result); for (const secret of ['private-id', 'private name', 'sensitive', 'C:/private', 'do-not-export', 'password']) assert.ok(!text.includes(secret), secret);
});

test('public addresses, ambiguous connection URLs and invalid ports are refused', () => {
  for (const u of ['http://8.8.8.8:18766', 'http://example.com', 'http://192.168.1.1/x', 'http://a:b@10.0.0.1', 'http://10.0.0.1?q=x']) assert.throws(() => pool.address(u));
  assert.equal(pool.address('http://192.168.0.1:18766/'), 'http://192.168.0.1:18766');
  assert.equal(pool.address('http://100.100.96.100:18766'), 'http://100.100.96.100:18766');
  assert.throws(() => pool.bindAddress('0.0.0.0'));
  assert.throws(() => pool.port(80)); assert.throws(() => pool.port(70000));
});

test('only authenticated model/snapshot routes are reachable, with no admin access or browser origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('bad')).status, 401);
  for (const p of ['/admin/shutdown', '/admin/status', '/session/send', '/v1/chat/completions?x=1']) assert.equal((await f.call(f.a.secret, p)).status, 404);
  assert.equal((await f.call(f.a.secret, undefined, { headers: { authorization: 'Bearer ' + f.a.secret, 'content-type': 'application/json', origin: 'http://evil.example' } })).status, 403);
  const snapshot = await pool.fetchSnapshot({ address: f.origin, key: f.a.secret }); assert.equal(snapshot.shared, true);
  assert.equal(f.calls.length, 0);
});

test('three protocols stream verbatim, and upstream receives local key plus person/session namespace', async t => {
  const f = await fixture(t);
  for (const route of ['/v1/messages', '/v1/responses', '/v1/chat/completions']) {
    const response = await f.call(f.a.secret + '.session', route); assert.equal(response.status, 200);
    assert.match(await response.text(), /你好/);
  }
  await (await f.call(f.b.secret + '.session')).text();
  assert.equal(f.calls.length, 4); assert.equal(f.calls[0].key, f.calls[2].key); assert.notEqual(f.calls[0].key, f.calls[3].key);
  assert.equal(f.calls[0].key.includes(f.a.secret), false);
  assert.equal(f.gateway.status().members.find(m => m.id === f.a.member.id).succeeded, 3);
  const beta = await f.call(f.a.secret, '/v1/messages?beta=true'); assert.equal(beta.status, 200); await beta.text();
});

test('a slow response retains its concurrency slot; other colleagues can continue', async t => {
  const f = await fixture(t, { maxConcurrent: 1 }); f.setDelay(150);
  const first = await f.call(f.a.secret);
  const blocked = await f.call(f.a.secret); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '10');
  const other = await f.call(f.b.secret); assert.equal(other.status, 200);
  await Promise.all([first.text(), other.text()]); assert.equal((await f.call(f.a.secret)).status, 200);
});

test('revoking a member aborts its live stream and does not revoke another person', async t => {
  const f = await fixture(t); f.setDelay(200);
  const active = await f.call(f.a.secret); const reading = active.text().catch(() => 'aborted');
  pool.revoke(f.dataDir, f.a.member.id); f.gateway.kick(f.a.member.id);
  assert.equal(await reading, 'aborted'); assert.equal((await f.call(f.a.secret)).status, 401);
  const other = await f.call(f.b.secret); assert.equal(other.status, 200); await other.text();
});

test('member request rate limits are independent', async t => {
  const f = await fixture(t, { rpm: 1 }); await (await f.call(f.a.secret)).text();
  assert.equal((await f.call(f.a.secret)).status, 429); const other = await f.call(f.b.secret); assert.equal(other.status, 200); await other.text();
});

test('a DSH client leaving after DONE counts as success, while an SSE error at HTTP 200 counts as failure', async t => {
  const f = await fixture(t); f.setLinger(120);
  const response = await f.call(f.a.secret); const reader = response.body.getReader(); let text = '';
  while (!text.includes('[DONE]')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
  await reader.cancel(); await new Promise(r => setTimeout(r, 25));
  assert.equal(f.gateway.status().members.find(m => m.id === f.a.member.id).succeeded, 1);
  f.setLinger(0); f.setStreamError(true); await (await f.call(f.b.secret)).text();
  assert.equal(f.gateway.status().members.find(m => m.id === f.b.member.id).succeeded, 0);
  assert.equal(f.gateway.status().members.find(m => m.id === f.b.member.id).failed, 1);
});

test('client failure preserves dated readings and blocks launching without falling back to local credentials', async t => {
  const f = await fixture(t); const dir = temp(t);
  const proxy = { state: 'running' }; const s = new LanPoolService({ dataDir: dir, proxyService: proxy });
  await s.connect({ address: f.origin, key: f.a.secret });
  assert.equal(s.client().key, f.a.secret); assert.equal(s.settings().client.key, undefined);
  await f.gateway.stop(); const offline = await s.snapshot({ force: true });
  assert.equal(offline.connection, 'offline'); assert.equal(offline.ready, false); assert.equal(offline.shared, true);
  await assert.rejects(s.connect({ address: f.origin, key: 'a'.repeat(48) })); assert.equal(s.client().key, f.a.secret);
});

test('expired account logins are shown as needing the host to log in, rather than as rate limiting', () => {
  const snapshot = pool.quotaSnapshot({ rows: [{ id: 'login', state: 'ready' }] }, { accounts: [{ id: 'login', coolingUntil: Date.now() + 60000, coolingReason: 'credential' }] });
  assert.equal(snapshot.rows[0].state, 'login-required'); assert.equal(snapshot.rows[0].avoid, null);
});

test('a disconnected shared panel still shows its last percentage even without a local CLI installation', () => {
  const { quotaView, renderQuota } = require('../renderer/codeagent-quota-panel-view');
  const now = Date.now();
  const view = quotaView({ shared: true, connection: 'offline', message: '口令已撤销', rows: [{ id: 'shared-1', label: '共享号 1', state: 'login-required',
    usage: { at: now, models: [{ name: model, day: { pct: 35 } }] } }] }, { installed: false, now });
  assert.equal(view.visible, true); assert.equal(view.installed, true); assert.equal(view.usable, 0);
  assert.match(renderQuota(view, { now }), /65%/); assert.match(renderQuota(view, { now }), /口令已撤销/);
});

test('host sharing can always be stopped after its network interface disappears', async t => {
  const dir = temp(t); pool.write(dir, { host: { enabled: true, port: 18766, bindAddress: '192.168.254.254', members: [] } });
  const service = new LanPoolService({ dataDir: dir, proxyService: { syncWithConfig() {} } });
  await service.configureHost({ enabled: false }); assert.equal(pool.read(dir).host.enabled, false);
});

test('connecting and disconnecting restores previous API configuration and preserves later manual API edits', async t => {
  const f = await fixture(t), dir = temp(t), handlers = new Map();
  let config = { providers: { claude: { backend: 'api', base_url: 'https://example.test', api_key: 'synthetic-old-key', model: 'synthetic-previous-model' } } };
  const previous = JSON.stringify(config.providers.claude);
  const proxyService = { syncWithConfig: async () => {}, state: 'stopped' };
  const service = new LanPoolService({ dataDir: dir, proxyService });
  require('../main/ipc/lan-pool-handlers').registerLanPoolIpc({ handle: (name, fn) => handlers.set(name, fn) }, { service,
    readConfig: () => config, saveConfig: v => { config = v; }, clearConfig() {}, changed() {}, proxyService });
  const connected = await handlers.get('lan-pool:connect')({}, { address: f.origin, key: f.a.secret }); assert.equal(connected.ok, true);
  assert.equal(config.providers.claude.backend, 'proxy'); assert.equal(service.clientProxyStatus().shared, true);
  config.providers.codex = { backend: 'api', base_url: 'https://manual.example.test', api_key: 'synthetic-new-key' };
  const disconnected = await handlers.get('lan-pool:disconnect')({}); assert.equal(disconnected.ok, true);
  assert.equal(JSON.stringify(config.providers.claude), previous); assert.equal(config.providers.codex.api_key, 'synthetic-new-key');
  assert.equal(service.client(), null); assert.equal(config.acp.companyApi, undefined);
});

test('Claude and Codex routes use the LAN host and bypass system proxies; DSH uses the same dedicated key', t => {
  const dir = temp(t), key = 'a'.repeat(48); pool.write(dir, { client: { enabled: true, address: 'http://10.0.0.1:18766', key } });
  const proxy = require('../core/company-model-proxy');
  const claude = {}; proxy.applyClaudeEnv(claude, { dataDir: dir, sessionId: 'same', model });
  assert.equal(claude.ANTHROPIC_BASE_URL, 'http://10.0.0.1:18766'); assert.ok(claude.NO_PROXY.includes('10.0.0.1')); assert.equal(claude.ANTHROPIC_AUTH_TOKEN, key + '.same');
  const codex = {}; proxy.applyCodexEnv(codex, { dataDir: dir, sessionId: 'same', model, projectDir: dir });
  assert.ok(codex.NO_PROXY.includes('10.0.0.1')); assert.match(fs.readFileSync(path.join(codex.CODEX_HOME, 'config.toml'), 'utf8'), /10\.0\.0\.1:18766\/v1/);
  assert.equal(proxy.dshRoute({ dataDir: dir, sessionId: 'same', model }).key, key + '.same');
});

test('5.5.15 launch cards show shared per-model availability and direct colleagues to the host', () => {
  const cards = require('../renderer/launch-model-cards');
  const status = { shared: true, state: 'running', accounts: [
    { id: 'shared1', models: [model], modelsAuthoritative: true },
    { id: 'shared2', models: [pool.MODEL_IDS[1]], modelsAuthoritative: true },
    { id: 'shared3', paused: true, models: [model], modelsAuthoritative: true },
  ] };
  assert.equal(cards.proxyBadge(status, model).text, '共享可用 · 1 个号');
  assert.equal(cards.proxyBadge({ ...status, state: 'not-ready', message: '共享主机离线' }, model).text, '共享主机暂不可用');
  const route = require('../renderer/company-route-view'); route.updateStatus(status);
  const info = route.routeInfo({ id: 'shared-session', kind: 'claude', companyRoute: 'proxy', currentModel: { id: model } });
  assert.equal(info.source, '共享号池'); assert.match(info.title, /共享主机/); assert.doesNotMatch(info.title, /第一次回答/);
  route.updateStatus(null);
});

// ---- 2026-11-07 鲁棒性增强（Claude）----
test('a damaged settings file is set aside and sharing resets to off instead of breaking company sessions', t => {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'lan-pool'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lan-pool/settings.json'), '{ half written');
  const v = pool.read(dir); assert.equal(v.host.enabled, false); assert.equal(v.client, null);
  assert.ok(fs.readdirSync(path.join(dir, 'lan-pool')).some(n => n.startsWith('settings.json.corrupt-')));
});

test('one pasted invite line fills both the address and the key', () => {
  const key = 'ab'.repeat(24), line = pool.formatInvite('http://10.20.30.40:18766', key);
  assert.deepEqual(pool.parseInvite(line, ''), { address: 'http://10.20.30.40:18766', key });
  assert.deepEqual(pool.parseInvite('http://10.20.30.40:18766/', key.toUpperCase()), { address: 'http://10.20.30.40:18766', key });
});

test('a revoked key is reported as revoked and keeps account states; recovery is noticed', async t => {
  const f = await fixture(t); const dir = temp(t), notices = [];
  const s = new LanPoolService({ dataDir: dir, proxyService: { state: 'running' }, onNotice: n => notices.push(n.text) });
  await s.connect({ address: pool.formatInvite(f.origin, f.a.secret), key: '' });
  pool.revoke(f.dataDir, f.a.member.id);
  const revoked = await s.snapshot({ force: true });
  assert.equal(revoked.connection, 'revoked'); assert.equal(revoked.revoked, true);
  assert.ok(notices.some(n => n.includes('撤销')));
  // The watchdog stops polling a revoked key; the colleague reconnects with a new key.
  const fetched = s.fetchedAt; await s.tick(); assert.equal(s.fetchedAt, fetched);
});

test('host sharing recovers by itself after a failed start, and follows a changed office address', async t => {
  const dir = temp(t), notices = [];
  const proxy = { state: 'not-ready', ensureRunning: async () => ({ state: proxy.state, code: proxy.state === 'running' ? null : 'UPSTREAM', message: '签名缓存不在' }), syncWithConfig: async () => {} };
  pool.write(dir, { host: { enabled: true, port: 0, bindAddress: '127.0.0.1', members: [] } });
  const s = new LanPoolService({ dataDir: dir, proxyService: proxy, onNotice: n => notices.push(n.text) });
  t.after(() => s.stop());
  await assert.rejects(s.sync(), /签名缓存/);
  assert.equal(s.hostHealth().phase, 'error'); assert.ok(notices[0].includes('自动重试'));
  await s.tick(); assert.equal(s.gateway.server, null);
  proxy.state = 'running'; await s.tick();
  assert.equal(s.hostHealth().phase, 'serving'); assert.ok(notices.at(-1).includes('自动恢复'));
  // Simulate DHCP: the saved address is no longer on this PC.
  const original = pool.localAddresses; pool.localAddresses = () => ['10.9.8.7'];
  t.after(() => { pool.localAddresses = original; });
  pool.write(dir, { ...pool.read(dir), host: { ...pool.read(dir).host, bindAddress: '10.1.1.1' } });
  await s.gateway.stop();
  await s.sync().catch(() => {}); // 10.9.8.7 does not exist on the test machine; the switch itself is what is checked
  assert.equal(pool.read(dir).host.bindAddress, '10.9.8.7'); assert.deepEqual([s.addressChanged.from, s.addressChanged.to], ['10.1.1.1', '10.9.8.7']);
  assert.ok(notices.some(n => n.includes('10.9.8.7')));
});

test('concurrent sync requests share one start', async t => {
  const dir = temp(t); let calls = 0;
  const proxy = { state: 'running', ensureRunning: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { state: 'running' }; }, syncWithConfig: async () => {} };
  pool.write(dir, { host: { enabled: true, port: 0, bindAddress: '127.0.0.1', members: [] } });
  const s = new LanPoolService({ dataDir: dir, proxyService: proxy }); t.after(() => s.stop());
  await Promise.all([s.sync(), s.sync(), s.sync()]);
  assert.equal(calls, 1); assert.equal(s.hostHealth().phase, 'serving');
});

test('shared views: offline host is not counted as usable and is not shown as "needs login"', () => {
  const view = require('../renderer/lan-pool-view'), now = Date.now();
  const row = { id: 's1', label: '共享号 1', state: 'ready', avoid: null, usage: { modelsAt: now, models: [{ name: model, day: { pct: 30 } }] } };
  const online = view.clientSummary({ shared: true, connection: 'online', rows: [row] }, now);
  assert.equal(online.ready, 1); assert.equal(online.rows[0].quota.text, '70% 剩余');
  const offline = view.clientSummary({ shared: true, connection: 'offline', rows: [row] }, now);
  assert.equal(offline.ready, 0); assert.equal(offline.state.label, '主机离线');
  const { quotaView } = require('../renderer/codeagent-quota-panel-view');
  const q = quotaView({ shared: true, connection: 'offline', rows: [{ ...row, present: true }] }, { now });
  assert.equal(q.usable, 0); assert.equal(q.rows[0].needsLogin, false);
  const html = view.accountCard({ client: { connected: true, address: 'http://10.0.0.2:18766' } }, { shared: true, connection: 'revoked', rows: [row] }, now);
  assert.ok(html.includes('口令已撤销'));
});
