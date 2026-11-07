'use strict';

// Company-model proxy: account routing, upstream discovery and the proxy process
// against the synthetic upstream (no company network, no real credentials).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'core', 'company-proxy');
const load = name => import(pathToFileURL(path.join(dir, name)).href);

function sse(text = 'ok', model = 'GLM-5.2-WX') {
  return new Response(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const limited = (retry = '30') => new Response('{}', { status: 429, headers: { 'retry-after': retry } });

test('router keeps a session on one account and spreads new sessions', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const used = [];
  const router = createAccountRouter({
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool' }, { id: 'bbbbbb2', kind: 'pool' }, { id: 'personal', kind: 'personal' }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); return sse(); } }),
  });
  await router.complete({}, { sessionTag: 's1' });
  await router.complete({}, { sessionTag: 's1' });
  await router.complete({}, { sessionTag: 's2' });
  assert.deepEqual(used, ['aaaaaa1', 'aaaaaa1', 'bbbbbb2']);
  assert.equal(router.accountFor('s1'), 'aaaaaa1');
});

test('429 cools the account down and the same request moves to another account', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  let now = 1_000_000;
  const events = [];
  const router = createAccountRouter({ now: () => now, onEvent: e => events.push(e),
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool' }, { id: 'bbbbbb2', kind: 'pool' }],
    makeProvider: account => ({ complete: async () => account.id === 'aaaaaa1' ? limited('30') : sse() }),
  });
  const response = await router.complete({}, { sessionTag: 's1' });
  assert.equal(response.status, 200);
  assert.equal(router.accountFor('s1'), 'bbbbbb2');
  const snap = router.snapshot();
  assert.equal(snap.accounts.find(a => a.id === 'aaaaaa1').coolingUntil, now + 30_000);
  assert.ok(events.some(e => e.type === 'rate_limited' && e.account === 'aaaaaa1'));
  assert.ok(events.some(e => e.type === 'switch' && e.from === 'aaaaaa1' && e.to === 'bbbbbb2'));
  // The session stays on its new account after the cooldown expires.
  now += 31_000;
  await router.complete({}, { sessionTag: 's1' });
  assert.equal(router.accountFor('s1'), 'bbbbbb2');
});

test('unreadable pool login falls back to the personal account with an event', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const events = [];
  const router = createAccountRouter({ onEvent: e => events.push(e),
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool' }, { id: 'personal', kind: 'personal' }],
    makeProvider: (account, { onCredentialFailure }) => ({ complete: async () => {
      if (account.id === 'aaaaaa1') { onCredentialFailure(); throw new Error('COMPANY_ACCESS_TOKEN_FAILED'); }
      return sse();
    } }),
  });
  const response = await router.complete({}, { sessionTag: 's1' });
  assert.equal(response.status, 200);
  assert.equal(router.accountFor('s1'), 'personal');
  assert.ok(events.some(e => e.type === 'credential_failed' && e.account === 'aaaaaa1'));
  assert.ok(events.some(e => e.type === 'fallback_personal'));
});

test('when every account is limited the last 429 is returned; paused accounts are skipped', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const calls = [];
  const router = createAccountRouter({
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool', paused: true }, { id: 'bbbbbb2', kind: 'pool' }, { id: 'personal', kind: 'personal' }],
    makeProvider: account => ({ complete: async () => { calls.push(account.id); return limited('5'); } }),
  });
  const response = await router.complete({}, { sessionTag: 's1' });
  assert.equal(response.status, 429);
  assert.deepEqual(calls, ['bbbbbb2', 'personal']);
  await assert.rejects(router.complete({}, { sessionTag: 's2' }), e => e.code === 'COMPANY_NO_ACCOUNT_AVAILABLE' && e.retryAfterSeconds >= 1);
});

test('non-429 errors are not retried on another account', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const calls = [];
  const router = createAccountRouter({
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool' }, { id: 'bbbbbb2', kind: 'pool' }],
    makeProvider: account => ({ complete: async () => { calls.push(account.id); return new Response('{}', { status: 500 }); } }),
  });
  assert.equal((await router.complete({}, { sessionTag: 's' })).status, 500);
  assert.deepEqual(calls, ['aaaaaa1']);
});

test('Retry-After parsing: seconds, HTTP date and fallback', async () => {
  const { retryAfterMs } = await load('account-router.mjs');
  assert.equal(retryAfterMs('12', 0), 12_000);
  assert.equal(retryAfterMs(new Date(90_000).toUTCString(), 0), 90_000);
  assert.equal(retryAfterMs(undefined, 0), 60_000);
  assert.equal(retryAfterMs('999999', 0), 60 * 60_000);
});

test('upstream values are discovered from adapter sources, never compiled in', async () => {
  const { discoverFromSources } = await load('upstream-profile.mjs');
  const found = discoverFromSources({
    'package/lib/index.js': "const URL='https://chat.example.test/api/v2/chat/completions'; headers={'app-id':'com.example.client'}",
    'package/lib/codeagent.js': "const BASE='https://id.example.test'; post(BASE+'/svc/auth/getUserDetail')",
    'package/lib/signer.js': 'const dir = process.env.EXAMPLE_AUTH_DIR;',
  });
  assert.equal(found.chatUrl, 'https://chat.example.test/api/v2/chat/completions');
  assert.equal(found.identityUrl, 'https://id.example.test/svc/auth/getUserDetail');
  assert.equal(found.appId, 'com.example.client');
  assert.equal(found.signerCacheEnv, 'EXAMPLE_AUTH_DIR');
  assert.deepEqual(discoverFromSources({}), {});
});

test('upstream profile names what is missing in plain words', async () => {
  const { resolveUpstreamProfile } = await load('upstream-profile.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-profile-'));
  try {
    await assert.rejects(resolveUpstreamProfile({ dataDir, env: { TEMP: dataDir }, versionReader: async () => '', packageFinder: async () => '', archiveReader: async () => '' }),
      e => e.code === 'PROFILE_INCOMPLETE' && /模型适配包/.test(e.message) && e.missing.includes('chatUrl'));
    const cache = path.join(dataDir, 'cache');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'codeagent-version-stamp'), '9.1.2\n123\n');
    fs.mkdirSync(path.join(dataDir, 'company-model-proxy'));
    fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'upstream.json'), JSON.stringify({
      adapterPackage: path.join(dataDir, 'a.tgz'), signerCacheDir: cache, signerCacheEnv: 'X_AUTH_DIR', codeagentVersion: '9.1.2',
      identityUrl: 'https://id.example.test/svc/auth/getUserDetail', identityAccountField: 'staffAccount', chatUrl: 'https://chat.example.test/api/v2/chat/completions', appId: 'com.example.client' }));
    const profile = await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: dataDir }, versionReader: async () => 'unused', archiveReader: async () => '' });
    assert.equal(profile.codeagentVersion, '9.1.2');
    assert.equal(profile.personalCredential, path.join(dataDir, '.cac', '.credentials.json'));
    assert.equal(profile.signerCacheDir, cache);
    assert.equal(profile.sources.signerCacheDir, 'config');
    assert.equal(profile.signerInit.needed, false);
    // CodeAgent upgraded (cache is 9.1.1, installed 9.1.2): no error, a first-time initialization into Hub's cache.
    fs.writeFileSync(path.join(cache, 'codeagent-version-stamp'), '9.1.1\n123\n');
    const stale = await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: dataDir }, archiveReader: async () => '' });
    assert.equal(stale.signerInit.needed, true);
    assert.equal(stale.signerInit.reason, 'version');
    assert.match(stale.signerInit.text, /CodeAgent 升级过（缓存是 9\.1\.1 版的，现装的是 9\.1\.2 版）/);
    assert.equal(stale.signerCacheDir, path.join(dataDir, 'company-model-proxy', 'signer-cache'));
    assert.equal(stale.sources.signerCacheDir, 'hub:first-init');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('signed provider refuses to start without configured https endpoints', async () => {
  const { createCompanyPersonalProvider } = await load('signed-provider.mjs');
  const { createMockSigner } = await load('mock-upstream.mjs');
  const signer = createMockSigner();
  const base = { signer, appId: 'mock-client', expectedVersion: signer.codeagentVersion(), readAccessToken: async () => 't', identityAccountField: 'staffAccount' };
  assert.throws(() => createCompanyPersonalProvider(base), e => e.code === 'COMPANY_ENDPOINT_UNCONFIGURED');
  // The identity field names come from the adapter; without them the provider does not start.
  assert.throws(() => createCompanyPersonalProvider({ ...base, identityAccountField: undefined,
    identityUrl: 'https://id.example.test/svc/auth/getUserDetail', chatUrl: 'https://c.example.test/api/v2/chat/completions' }), e => e.code === 'COMPANY_IDENTITY_FIELDS_UNCONFIGURED');
  assert.throws(() => createCompanyPersonalProvider({ ...base, expectedVersion: '0.0.1',
    identityUrl: 'https://id.example.test/svc/auth/getUserDetail', chatUrl: 'https://c.example.test/api/v2/chat/completions' }),
  e => e.code === 'COMPANY_SIGNER_VERSION_UNVERIFIED');
  assert.ok(createCompanyPersonalProvider({ ...base,
    identityUrl: 'https://id.example.test/svc/auth/getUserDetail', chatUrl: 'https://c.example.test/api/v2/chat/completions' }));
});

// ---------- the proxy process itself, mock upstream ----------
// A pool account's model permission list, stored the way Hub's account page stores it (hub-models.json).
function writeModels(dataDir, id, models) {
  const accountDir = path.join(dataDir, 'codeagent-pool', 'accounts', id);
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, 'hub-models.json'), JSON.stringify({ models, defaultModel: models[0], at: new Date().toISOString(), source: 'serve' }));
}
function startProxy(dataDir, key, extraArgs = []) {
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs'), '--data-dir', dataDir, '--port', '0', '--mock-upstream', '--parent-pid', String(process.pid), ...extraArgs],
    { env: { ...process.env, AI_HUB_COMPANY_PROXY_KEY: key, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const stateFile = path.join(dataDir, 'company-model-proxy', 'proxy-state.json');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.pid === child.pid) { clearInterval(poll); resolve({ child, port: state.port, log: () => log }); }
      } catch { /* not yet */ }
      if (Date.now() - started > 15000) { clearInterval(poll); child.kill(); reject(new Error('proxy did not start: ' + log)); }
    }, 50);
  });
}
async function sseText(response) {
  const text = await response.text();
  return text.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(5)))
    .map(c => c.choices?.[0]?.delta?.content || '').join('');
}

test('proxy process: three client protocols, session stickiness and 429 switch over loopback', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'k'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1' }, { id: 'bbbbbb2' }] }));
  writeModels(dataDir, 'aaaaaa1', ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
  writeModels(dataDir, 'bbbbbb2', ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
  const { child, port } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, tag = 'sess1') => fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${key}.${tag}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/admin/status')).status, 401);
    assert.equal((await post('/v1/chat/completions', { model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] }, 'bad tag!')).status, 401);
    // DSH (chat completions)
    let r = await post('/v1/chat/completions', { model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.equal(await sseText(r), 'MOCK_OK');
    // Claude Code (messages, streaming and non-streaming)
    r = await post('/v1/messages', { model: 'claude-haiku-4', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /MOCK_OK/);
    r = await post('/v1/messages', { model: 'GLM-5.2-WX', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).content.find(b => b.type === 'text').text, 'MOCK_OK');
    // Codex (responses)
    r = await post('/v1/responses', { model: 'deepseek-v4.1-flash-1017', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [], tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'medium' } });
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(await r.text(), /MOCK_OK/);
    const auth = { headers: { authorization: `Bearer ${key}` } };
    let status = await (await fetch(base + '/admin/status', auth)).json();
    assert.equal(status.ready, true);
    assert.equal(status.router.accounts.find(a => a.id === 'aaaaaa1').sessions, 1);
    // Rate-limit the session's account: the request succeeds on the other one.
    fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ rateLimitedTokens: ['mock-token-aaaaaa1'] }));
    r = await post('/v1/chat/completions', { model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'again' }] });
    assert.equal(r.status, 200);
    await r.text();
    status = await (await fetch(base + '/admin/status', auth)).json();
    assert.ok(status.router.accounts.find(a => a.id === 'aaaaaa1').coolingUntil > Date.now());
    assert.ok(status.router.events.some(e => e.type === 'switch' && e.to === 'bbbbbb2'));
    // Every account limited: the client sees 429 with Retry-After, not a hang.
    fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ rateLimitedTokens: ['mock-token-aaaaaa1', 'mock-token-bbbbbb2', 'mock-token-personal'] }));
    r = await post('/v1/chat/completions', { model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'x' }] }, 'sess2');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    await r.text();
    // Broken pool credentials: falls back to personal.
    fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ brokenCredentials: ['aaaaaa1', 'bbbbbb2'] }));
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('proxy process: pool logins unreadable -> personal account, with a fallback event', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'q'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1' }] }));
  writeModels(dataDir, 'aaaaaa1', ['deepseek-v4.1-flash-1017']);
  fs.mkdirSync(path.join(dataDir, 'company-model-proxy'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ brokenCredentials: ['aaaaaa1'] }));
  const { child, port } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}.s9`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-1017', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 200);
    await r.text();
    const status = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.ok(status.router.events.some(e => e.type === 'credential_failed' && e.account === 'aaaaaa1'));
    assert.ok(status.router.events.some(e => e.type === 'fallback_personal'));
    assert.equal(status.mockUpstream.byToken['mock-token-personal'], 1);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Hub side: settings, launch environments, service lifecycle ----------
const hubProxy = require('../core/company-model-proxy');
const companyApi = require('../core/company-api-config');
const hubData = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-hub-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 18999 });
  return dataDir;
};
const hasLoopbackBypass = env => ['NO_PROXY', 'no_proxy'].every(name => ['127.0.0.1', 'localhost'].every(h => env[name].split(',').includes(h)));

test('company model choice is saved per tool, exposes both models and can be switched back', () => {
  let raw = companyApi.withSettings({}, { kind: 'claude', backend: 'proxy', model: 'deepseek-v4.1-flash-1017' });
  raw = companyApi.withSettings(raw, { kind: 'deepseek-acp', backend: 'proxy', model: 'GLM-5.2-WX' });
  const view = companyApi.settings(raw);
  assert.equal(view.claude.backend, 'proxy');
  assert.equal(view.claude.model, 'deepseek-v4.1-flash-1017');
  assert.deepEqual(view.claude.models.map(m => m.id), hubProxy.MODEL_IDS);
  assert.equal(view['deepseek-acp'].backend, 'proxy');
  assert.throws(() => companyApi.withSettings({}, { kind: 'codex', backend: 'proxy', model: 'gpt-x' }), /公司模型只支持/);
  if (companyApi.isCompany()) {
    const config = companyApi.applyCompanyConfig({}, raw);
    assert.equal(config.claudeBackend, 'proxy');
    assert.equal(config.dshBackend, 'proxy');
    assert.equal(config.companyProxyEnabled, true);
    assert.equal(hubProxy.usesProxy('claude-resume', config), true);
    assert.equal(hubProxy.usesProxy('codex', config), false);
    assert.doesNotThrow(() => companyApi.assertLaunchConfigured('deepseek-acp', config));
  }
  const local = companyApi.withSettings(raw, { kind: 'claude', useLocal: true });
  assert.equal(companyApi.settings(local).claude.backend, 'local');
  assert.equal(companyApi.anyProxy(local), true, 'DSH still uses the company model');
});

test('Claude and Codex sessions point at the local proxy with a per-session key and bypass system proxies', () => {
  const dataDir = hubData();
  const endpoint = hubProxy.readEndpoint(dataDir);
  const claude = { ANTHROPIC_API_KEY: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'old', NO_PROXY: 'corp.example' };
  assert.equal(hubProxy.applyClaudeEnv(claude, { dataDir, sessionId: 'sess-1', model: 'opus' }), 'GLM-5.2-WX');
  assert.equal(claude.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18999');
  assert.equal(claude.ANTHROPIC_AUTH_TOKEN, endpoint.key + '.sess-1');
  assert.equal(claude.ANTHROPIC_API_KEY, undefined);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(hasLoopbackBypass(claude) && claude.NO_PROXY.startsWith('corp.example'));

  const codex = { OPENAI_API_KEY: 'old' };
  const home = hubProxy.applyCodexEnv(codex, { dataDir, sessionId: 'sess-2', model: 'deepseek-v4.1-flash-1017', projectDir: dataDir });
  assert.equal(codex[hubProxy.KEY_ENV], endpoint.key + '.sess-2');
  assert.equal(codex.OPENAI_API_KEY, undefined);
  assert.ok(hasLoopbackBypass(codex));
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:18999\/v1"/);
  assert.match(toml, /model = "deepseek-v4\.1-flash-1017"/);
  assert.match(toml, /\[windows\]\nsandbox = "unelevated"/);
  // Company test Q-1106-04 r7: unelevated works only together with danger-full-access (not workspace-write).
  assert.match(toml, /^sandbox_mode = "danger-full-access"$/m);
  assert.ok(!toml.includes(endpoint.key), 'the key stays out of config files');
  assert.equal(hubProxy.codexWindowsSandbox({ AI_HUB_COMPANY_CODEX_SANDBOX: 'elevated' }), 'elevated');
  assert.equal(hubProxy.codexWindowsSandbox({ AI_HUB_COMPANY_CODEX_SANDBOX: 'bad value"' }), hubProxy.CODEX_WINDOWS_SANDBOX_DEFAULT);
});

test('DSH terminal session uses the company provider, its own key variable and the loopback bypass', () => {
  if (!companyApi.isCompany()) return;
  const dataDir = hubData();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-dsh-'));
  for (const file of ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-harness-tui/dsh-tui/package.json']) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
    fs.writeFileSync(path.join(runtime, file), '{}');
  }
  const config = companyApi.applyCompanyConfig({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { cliRoot: runtime } } } },
    { acp: { companyApi: { backend: 'proxy', model: 'deepseek-v4.1-flash-1017' } } });
  const options = require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp',
    { id: 'dsh-1', cwd: dataDir }, config, dataDir, { PATH: process.env.PATH, BAILIAN_API_KEY: 'old' });
  const env = options.launch.env;
  const endpoint = hubProxy.readEndpoint(dataDir);
  assert.equal(env[hubProxy.KEY_ENV], endpoint.key + '.dsh-1');
  assert.equal(env.BAILIAN_API_KEY, undefined);
  assert.ok(hasLoopbackBypass(env));
  const model = JSON.parse(fs.readFileSync(path.join(options.home, '.dsh-tui/model.json'), 'utf8'));
  assert.deepEqual(model, { provider: 'company-proxy', model: 'deepseek-v4.1-flash-1017' });
  assert.ok(options.launch.secrets.includes(endpoint.key + '.dsh-1'));
});

test('proxy service: starts with the Hub, restarts once after a crash, then explains the failure', { timeout: 60000 }, async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-svc-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 0 });
  const states = [];
  const service = new CompanyProxyService({ dataDir, isEnabled: () => true, mock: true, logger: { warn() {} },
    onStatus: s => states.push(s.state) });
  const waitFor = async (predicate, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('timeout: ' + label);
  };
  try {
    const first = await service.syncWithConfig();
    assert.equal(first.state, 'running');
    assert.ok(first.port > 0);
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/health`)).status, 200);
    const pid1 = service.child.pid;
    service.child.kill();
    await waitFor(() => service.state === 'running' && service.child && service.child.pid !== pid1, 'automatic restart');
    assert.equal(service.restarts, 1);
    service.child.kill();
    await waitFor(() => service.state === 'failed', 'second crash');
    assert.match(service.status().message, /反复退出.*重新启动反代/);
    assert.equal((await service.restart()).state, 'running');
  } finally { await service.stop(); }
  assert.equal(service.state, 'stopped');
  assert.equal(service.child, null);
  assert.ok(states.includes('starting') && states.includes('failed'));
});

// ---------- 2026-11-06 pre-release fixes: model-aware pool, signer cache lookup, system CA, notices ----------
test('pool picks only accounts with the requested model; none -> personal with reason "model"', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const events = [];
  const used = [];
  const router = createAccountRouter({ onEvent: e => events.push(e),
    listAccounts: () => [{ id: 'dsonly1', kind: 'pool', models: ['deepseek-v4.1-flash-1017'], modelsAuthoritative: true },
      { id: 'glmonly2', kind: 'pool', models: ['GLM-5.2-WX-Auto'], modelsAuthoritative: true }, { id: 'personal', kind: 'personal' }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); return sse(); } }),
  });
  await router.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 'glm' });
  await router.complete({ model: 'deepseek-v4.1-flash-1017' }, { sessionTag: 'ds' });
  assert.deepEqual(used, ['glmonly2', 'dsonly1']);
  // The session switches model: its DS-only account cannot serve GLM, it moves to the GLM account.
  await router.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 'ds' });
  assert.equal(router.accountFor('ds'), 'glmonly2');
  assert.ok(events.some(e => e.type === 'switch' && e.from === 'dsonly1' && e.to === 'glmonly2' && e.reason === 'model'));
  // A model no pool account has: personal account, and the event says why.
  await router.complete({ model: 'some-other-model' }, { sessionTag: 'x' });
  assert.equal(router.accountFor('x'), 'personal');
  assert.ok(events.some(e => e.type === 'fallback_personal' && e.reason === 'model' && e.model === 'some-other-model'));
});

test('a GLM session is never sent to a DeepSeek-only account, even when that is the only free one', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const events = [];
  const used = [];
  const router = createAccountRouter({ onEvent: e => events.push(e),
    listAccounts: () => [{ id: 'dsonly1', kind: 'pool', models: ['deepseek-v4.1-flash-1017'], modelsAuthoritative: true }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); return sse(); } }),
  });
  assert.equal((await router.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 's' })).status, 200);
  assert.deepEqual(used, ['personal']);
  assert.ok(events.some(e => e.type === 'fallback_personal' && e.reason === 'model' && e.model === 'GLM-5.2-WX'));
});

test('review 1: a permission list that is not authoritative (never probed, empty, unreadable) refuses nothing, like Hub; known accounts are preferred', async () => {
  const { createAccountRouter, accountHasModel } = await load('account-router.mjs');
  assert.equal(accountHasModel({ kind: 'pool', models: ['deepseek-x'] }, 'GLM-5.2-WX'), true, 'not authoritative -> unknown -> allowed');
  assert.equal(accountHasModel({ kind: 'pool', models: [], modelsAuthoritative: true }, 'GLM-5.2-WX'), true, 'empty list -> unknown');
  assert.equal(accountHasModel({ kind: 'pool', models: ['deepseek-x'], modelsAuthoritative: true }, 'GLM-5.2-WX'), false);
  const used = [];
  const router = createAccountRouter({
    listAccounts: () => [{ id: 'unknown1', kind: 'pool', models: [] }, { id: 'partial2', kind: 'pool', models: ['deepseek-x'] }, { id: 'glm3', kind: 'pool', models: ['GLM-5.2-WX'], modelsAuthoritative: true }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); return sse(); } }) });
  await router.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 'a' });
  assert.deepEqual(used, ['glm3'], 'an account listing the model goes first');
  const router2 = createAccountRouter({
    listAccounts: () => [{ id: 'unknown1', kind: 'pool', models: [] }, { id: 'partial2', kind: 'pool', models: ['deepseek-x'] }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); return sse(); } }) });
  await router2.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 'b' });
  await router2.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 'c' });
  assert.deepEqual(used.slice(1), ['unknown1', 'partial2'], 'without a known account the unknown lists serve instead of falling back to personal');
});

test('review 1: proxy reads unprobed / failed-to-read pool accounts as unknown (not as "no models")', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'u'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'never1' }] }));
  const { child, port } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}.t1`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 200); await r.text();
    const status = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.mockUpstream.byToken['mock-token-never1'], 1, 'the never-probed account serves the request');
    assert.equal(status.router.accounts.find(a => a.id === 'never1').modelsAuthoritative, false);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('proxy process: GLM request with only a DeepSeek pool account goes to the personal account', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'm'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'dsonly1' }] }));
  writeModels(dataDir, 'dsonly1', ['deepseek-v4.1-flash-1017']);
  const { child, port } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  const post = (model, tag) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}.${tag}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  try {
    let r = await post('GLM-5.2-WX', 'glm1'); assert.equal(r.status, 200); await r.text();
    r = await post('deepseek-v4.1-flash-1017', 'ds1'); assert.equal(r.status, 200); await r.text();
    const status = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.mockUpstream.byToken['mock-token-personal'], 1);
    assert.equal(status.mockUpstream.byToken['mock-token-dsonly1'], 1);
    assert.deepEqual(status.router.accounts.find(a => a.id === 'dsonly1').models, ['deepseek-v4.1-flash-1017']);
    assert.ok(status.router.events.some(e => e.type === 'fallback_personal' && e.reason === 'model' && e.model === 'GLM-5.2-WX'));
    // Hub's notice for it names the model.
    const { NOTICE } = require('../main/company-proxy-service');
    assert.match(NOTICE.fallback_personal(status.router.events.find(e => e.type === 'fallback_personal')), /没有对 GLM-5\.2-WX 有权限的号.*个人/);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('signer cache lookup: Hub, adapter, CodeAgent, upstream.json, prototype TEMP; nothing -> first-time init planned', async () => {
  const { resolveUpstreamProfile, signerCacheCandidates } = await load('upstream-profile.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-cache-'));
  const dataDir = path.join(root, 'hub'), home = path.join(root, 'home'), envDir = path.join(root, 'envcache'), configured = path.join(root, 'configured');
  const stamp = (target, version) => { fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'codeagent-version-stamp'), `${version}\n4242\n`); };
  const hubCache = path.join(dataDir, 'company-model-proxy', 'signer-cache');
  const adapterCache = path.join(home, '.dsh', 'hw-llm-adapter', 'data');
  const codeagentCache = path.join(home, '.cac'), temp = path.join(root, 'temp');
  const prototypeCache = path.join(temp, '20261106-native-stamp-codex-v1', 'native-run', 'signer-cache');
  try {
    fs.mkdirSync(path.join(dataDir, 'company-model-proxy'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'upstream.json'), JSON.stringify({
      adapterPackage: path.join(root, 'a.tgz'), signerCacheEnv: 'X_AUTH_DIR', codeagentVersion: '9.1.2', signerCacheDir: configured,
      identityUrl: 'https://id.example.test/svc/auth/getUserDetail', identityAccountField: 'staffAccount', chatUrl: 'https://chat.example.test/api/v2/chat/completions', appId: 'c.example' }));
    const env = { USERPROFILE: home, X_AUTH_DIR: envDir, TEMP: temp };
    const resolveIt = () => resolveUpstreamProfile({ dataDir, env, versionReader: async () => 'unused', archiveReader: async () => '' });
    assert.deepEqual(signerCacheCandidates({ dataDir, env, signerCacheEnv: 'X_AUTH_DIR', configured }).map(c => c.source),
      ['hub', 'adapter-env', 'adapter', 'codeagent', 'config', 'prototype']);
    assert.equal(signerCacheCandidates({ dataDir, env: { ...env, CODEAGENT3_CONFIG_DIR: path.join(root, 'cfg') } }).find(c => c.source === 'codeagent').dir, path.join(root, 'cfg'));
    // Nothing anywhere: a first-time initialization into Hub's own cache is planned, with every place looked at.
    const none = await resolveIt();
    assert.deepEqual({ needed: none.signerInit.needed, reason: none.signerInit.reason }, { needed: true, reason: 'missing' });
    assert.equal(none.signerInit.tried.map(t => t.source).join(), 'hub,adapter-env,adapter,codeagent,config,prototype');
    assert.equal(none.signerCacheDir, hubCache);
    assert.match(none.signerInit.text, /还没有签名信息/);
    stamp(prototypeCache, '9.1.2');
    assert.equal((await resolveIt()).sources.signerCacheDir, 'prototype');
    assert.deepEqual(signerCacheCandidates({ dataDir, env, signerCacheEnv: 'X_AUTH_DIR', configured, reuse: false }).map(c => c.source), ['hub']);
    stamp(configured, '9.1.2');
    assert.equal((await resolveIt()).sources.signerCacheDir, 'config');
    stamp(codeagentCache, '9.1.2');
    assert.equal((await resolveIt()).sources.signerCacheDir, 'codeagent');
    stamp(adapterCache, '9.1.2');
    assert.equal((await resolveIt()).signerCacheDir, adapterCache);
    stamp(envDir, '9.1.2');
    assert.equal((await resolveIt()).sources.signerCacheDir, 'adapter-env');
    // A cache from an older CodeAgent is skipped, a later matching one is used.
    stamp(hubCache, '9.0.0');
    assert.equal((await resolveIt()).sources.signerCacheDir, 'adapter-env');
    stamp(hubCache, '9.1.2');
    assert.equal((await resolveIt()).signerCacheDir, hubCache);
    // Lookup only reads: the cache file is unchanged.
    assert.equal(fs.readFileSync(path.join(hubCache, 'codeagent-version-stamp'), 'utf8'), '9.1.2\n4242\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const source = fs.readFileSync(path.join(dir, 'upstream-profile.mjs'), 'utf8');
  assert.doesNotMatch(source, /\\\\Users\\\\|[A-Za-z]:\\\\Users/);
});

test('system certificates: the proxy process is started with --use-system-ca, or merges the Windows roots itself', async () => {
  const { systemCaArgs } = require('../main/company-proxy-service');
  assert.deepEqual(systemCaArgs(new Set(['--use-system-ca'])), ['--use-system-ca']);
  assert.deepEqual(systemCaArgs(new Set()), []);
  const { ensureSystemCa } = await load('server.mjs');
  let set = null;
  const fake = { getCACertificates: kind => kind === 'system' ? ['SYS1', 'SYS2'] : ['BUNDLED', 'SYS1'], setDefaultCACertificates: list => { set = list; } };
  assert.deepEqual(ensureSystemCa(fake), { mode: 'runtime', system: 2, total: 3 });
  assert.deepEqual(set, ['BUNDLED', 'SYS1', 'SYS2']);
  assert.equal(ensureSystemCa({ getCACertificates: kind => kind === 'system' ? ['S'] : ['B', 'S'] }).mode, 'flag');
  assert.equal(ensureSystemCa({}).mode, 'unavailable');
});

test('system certificates are in effect in the runtime Hub really uses (Electron as Node)', { skip: process.platform !== 'win32', timeout: 60000 }, () => {
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const runtime = fs.existsSync(electron) ? electron : process.execPath;
  const { systemCaArgs } = require('../main/company-proxy-service');
  // Same flag detection as the Hub main process; Electron 41 (Node 24) supports the flag.
  const probe = "const tls=require('tls');const s=tls.getCACertificates('system'),d=new Set(tls.getCACertificates('default'));"
    + "process.stdout.write(JSON.stringify({system:s.length,missing:s.filter(c=>!d.has(c)).length,bundled:tls.getCACertificates('bundled').length,total:d.size}))";
  const run = args => JSON.parse(require('node:child_process').execFileSync(runtime, [...args, '-e', probe],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000 }));
  const flagged = run(systemCaArgs());
  assert.ok(flagged.system > 0, 'Windows certificate store has roots');
  assert.equal(flagged.missing, 0, 'every Windows root is trusted by default');
  assert.ok(flagged.total > flagged.bundled);
  const plain = run([]);
  assert.ok(plain.missing > 0, 'without the flag some Windows roots are not trusted (the flag is what makes the difference)');
});

test('proxy process reports the system certificates in effect', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-ca-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 0 });
  const service = new CompanyProxyService({ dataDir, isEnabled: () => true, mock: true, logger: { warn() {} } });
  try {
    assert.equal((await service.syncWithConfig()).state, 'running');
    const status = await service.request('/admin/status');
    assert.equal(status.systemCa.mode, 'flag');
    assert.ok(status.systemCa.system > 0);
    assert.match(fs.readFileSync(service.logPath(), 'utf8'), /system certificates: flag/);
  } finally { await service.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('account-switch notices are sticky and shown only the first time for each reason', async () => {
  const { CompanyProxyService, noticeKey } = require('../main/company-proxy-service');
  const notices = [];
  const service = new CompanyProxyService({ dataDir: os.tmpdir(), isEnabled: () => false, logger: { warn() {} }, onNotice: n => notices.push(n) });
  service.child = { pid: 1 };
  const events = [{ at: 1, type: 'rate_limited', session: 'a', account: 'personal' }, { at: 2, type: 'rate_limited', session: 'b', account: 'personal' }];
  service.request = async () => ({ ready: true, router: { events } });
  await service.poll();
  events.push({ at: 3, type: 'fallback_personal', session: 'c', reason: 'model', model: 'GLM-5.2-WX' },
    { at: 4, type: 'fallback_personal', session: 'd', reason: 'model', model: 'GLM-5.2-WX' },
    { at: 5, type: 'fallback_personal', session: 'e', reason: 'pool_unavailable' });
  await service.poll();
  assert.deepEqual(notices.map(n => n.type), ['rate_limited', 'fallback_personal', 'fallback_personal']);
  assert.ok(notices.every(n => n.persistent === true));
  assert.notEqual(noticeKey(events[2]), noticeKey(events[4]));
  service.child = null;
});

test('sticky notice stays until closed and does not stack duplicates', () => {
  const { showStickyNotice, STACK_ID } = require('../renderer/sticky-notice.js');
  const byId = {};
  const make = tag => ({ tagName: tag, style: {}, dataset: {}, children: [], attrs: {}, listeners: {}, textContent: '', parent: null, id: '',
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.listeners[t] = f; },
    appendChild(c) { c.parent = this; this.children.push(c); if (c.id) byId[c.id] = c; return c; }, append(...cs) { cs.forEach(c => this.appendChild(c)); },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } });
  const document = { body: make('body'), createElement: make, getElementById: id => byId[id] || null };
  const first = showStickyNotice(document, '公司模型：换号了', 'warning');
  assert.equal(showStickyNotice(document, '公司模型：换号了', 'warning'), first);
  showStickyNotice(document, '另一条', 'error');
  const stack = byId[STACK_ID];
  assert.equal(stack.children.length, 2);
  assert.equal(first.children[0].textContent, '公司模型：换号了');
  assert.equal(first.children[1].textContent, '知道了');
  first.children[1].listeners.click();
  assert.equal(stack.children.length, 1);
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(rendererSource, /payload\.persistent === true\) require\('\.\/sticky-notice\.js'\)\.showStickyNotice/);
});

// ---------- Codex tool history replay (company Q-1106-04 r7: real DeepSeek, no thinking, second turn refused) ----------
function chatSse(chunks, model = 'deepseek-v4.1-flash-1017') {
  const body = chunks.map(c => `data: ${JSON.stringify({ model, ...c })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
// The items Codex keeps for its history: every output_item.done, in the order they arrive.
async function doneItems(response) {
  const items = [];
  for (const frame of (await response.text()).split('\n\n')) {
    const line = frame.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === 'response.output_item.done') items.push(event.item);
  }
  return items;
}
const codexTools = [
  { type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar' } },
];
const codexBody = input => ({ model: 'deepseek-v4.1-flash-1017', stream: true, input, tools: codexTools, tool_choice: 'auto',
  parallel_tool_calls: true, reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'], store: false });
const userItem = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
// History rule real upstreams enforce: each tool message answers a call of the assistant message right before it.
function assertChatHistory(messages) {
  let open = new Set();
  for (const m of messages) {
    if (m.role === 'assistant') open = new Set((m.tool_calls || []).map(c => c.id));
    else if (m.role === 'tool') assert.ok(open.delete(m.tool_call_id), `tool result ${m.tool_call_id} has no preceding call`);
    else open = new Set();
  }
}

test('Codex + DeepSeek without thinking: two tool rounds replay without reasoning, text and calls stay one assistant turn', async () => {
  const { createCodexAdapter } = await load('adapters.mjs');
  const adapter = createCodexAdapter({ defaultModel: 'deepseek-v4.1-flash-1017' });
  const patchArgs = '{"input": "*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"}'; // spaced, as DeepSeek sends it
  let input = [userItem('write a.txt then read it')];
  // Round 1: no reasoning_content at all, a short text, then a custom tool call.
  let request = codexBody(input);
  let converted = adapter.convertRequest(request);
  let items = await doneItems(await adapter.convertResponse(chatSse([
    { choices: [{ index: 0, delta: { content: '先写文件。' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'apply_patch', arguments: patchArgs } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]), { request }));
  assert.deepEqual(items.map(i => i.type), ['message', 'custom_tool_call'], 'text finishes before the call');
  // Round 2: Codex replays the turn (no reasoning item) plus the tool output.
  input = [...input, ...items, { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Success' }];
  request = codexBody(input);
  converted = adapter.convertRequest(request);
  assertChatHistory(converted.messages);
  const turn = converted.messages.find(m => m.role === 'assistant');
  assert.equal(turn.content, '先写文件。');
  assert.equal(turn.tool_calls[0].function.arguments, patchArgs, 'custom tool input replayed byte for byte');
  assert.ok(!('reasoning_content' in turn));
  items = await doneItems(await adapter.convertResponse(chatSse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'shell_command', arguments: '{"command": "type a.txt"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]), { request }));
  // Round 3: two tool rounds of history, still no reasoning anywhere.
  input = [...input, ...items, { type: 'function_call_output', call_id: 'call_2', output: 'hi' }];
  converted = adapter.convertRequest(codexBody(input));
  assertChatHistory(converted.messages);
  assert.deepEqual(converted.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool']);
  assert.ok(converted.messages.every(m => !('reasoning_content' in m)));
});

test('Codex replay: an older client order (calls before text) is folded into one assistant turn', async () => {
  const { convertResponsesRequest } = await load('responses-converter.mjs');
  const out = convertResponsesRequest(codexBody([userItem('go'),
    { type: 'function_call', call_id: 'c1', name: 'shell_command', arguments: '{}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reading' }] },
    { type: 'function_call_output', call_id: 'c1', output: 'x' }]), { mapReasoning: () => ({}) });
  assertChatHistory(out.messages);
  assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(out.messages[1].content, 'reading');
});

test('Codex replay with thinking: from the store, or from the echoed summary after a restart; lost thinking is refused', async () => {
  const { createCodexAdapter } = await load('adapters.mjs');
  const adapter = createCodexAdapter({ defaultModel: 'deepseek-v4.1-flash-1017' });
  let input = [userItem('go')];
  const request = codexBody(input);
  adapter.convertRequest(request);
  const items = await doneItems(await adapter.convertResponse(chatSse([
    { choices: [{ index: 0, delta: { reasoning_content: 'think about it' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'shell_command', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]), { request }));
  assert.deepEqual(items.map(i => i.type), ['reasoning', 'function_call']);
  input = [...input, ...items, { type: 'function_call_output', call_id: 'c1', output: 'x' }];
  let converted = adapter.convertRequest(codexBody(input));
  assert.equal(converted.messages[1].reasoning_content, 'think about it');
  // A fresh adapter (Hub restarted) still has the thinking text the client echoes in the summary.
  const fresh = createCodexAdapter({ defaultModel: 'deepseek-v4.1-flash-1017' });
  converted = fresh.convertRequest(codexBody(input));
  assert.equal(converted.messages[1].reasoning_content, 'think about it');
  assertChatHistory(converted.messages);
  // The client kept a reasoning item but its thinking is gone: refused, not silently dropped.
  const lost = input.map(i => i.type === 'reasoning' ? { ...i, summary: [] } : i);
  assert.throws(() => fresh.convertRequest(codexBody(lost)), e => e.status === 422 && /could not be replayed/.test(e.message));
});

test('mock DeepSeek-style upstream without thinking: Codex completes two rounds with a valid chat history', { timeout: 60000 }, async () => {
  const { startMockUpstream } = await load('mock-upstream.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-ds-'));
  const controlFile = path.join(dataDir, 'mock-control.json');
  fs.writeFileSync(controlFile, JSON.stringify({ deepseekNoThinking: true }));
  const upstream = await startMockUpstream({ controlFile });
  try {
    const { createCodexAdapter } = await load('adapters.mjs');
    const adapter = createCodexAdapter({ defaultModel: 'deepseek-v4.1-flash-1017' });
    let input = [userItem('read C:\\mock\\file.txt')];
    for (let round = 0; round < 2; round++) {
      const request = codexBody(input);
      const converted = adapter.convertRequest(request);
      const response = await fetch(upstream.origin + '/api/v2/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json', hash3: 'x', 'x-auth-token': 't', 'kernel-version': 'k' }, body: JSON.stringify(converted) });
      const items = await doneItems(await adapter.convertResponse(response, { request }));
      const call = items.find(i => i.type === 'function_call');
      if (round === 0) {
        assert.ok(call, 'first round calls a tool');
        assert.ok(!items.some(i => i.type === 'reasoning'));
        input = [...input, ...items, { type: 'function_call_output', call_id: call.call_id, output: 'TEXT_MARKER_42' }];
      } else {
        assert.ok(items.some(i => i.type === 'message' && /TEXT_MARKER_42/.test(i.content[0].text)));
      }
    }
    assert.equal(upstream.stats.historyErrors, 0);
    assert.equal(upstream.stats.toolCalls, 1);
    assert.equal(upstream.stats.finals, 1);
  } finally { await upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- company Q-1106-08: chat URL built from a zone template, sources and tried places reported ----------
test('chat URL is found when the adapter builds it from the zone (template, concatenation, base + path)', async () => {
  const { scanAdapterSources, discoverFromSources } = await load('upstream-profile.mjs');
  const identity = { 'package/lib/codeagent.js': "const ID_URL = 'https://id.example.test/svc/auth/getUserDetail';" };
  const forms = {
    template: "const zone = opts.zone || 'yellow';\nconst url = `https://chat.zone-${zone[0]}.example.test/api/v2/chat/completions`;",
    templateConsts: "const HOST_PREFIX = 'chat.zone-';\nconst HOST_SUFFIX = '.example.test';\nconst CHAT_PATH = '/api/v2/chat/completions';\n" +
      'const endpoint = `https://${HOST_PREFIX}${this.zone.charAt(0)}${HOST_SUFFIX}${CHAT_PATH}`;',
    concat: "const endpoint = 'https://chat.zone-' + zone[0] + '.example.test' + '/api/v2/chat/completions';",
    basePlusPath: "const BASE = `https://chat.zone-${zone[0]}.example.test`;\nfetch(BASE + '/api/v2/chat/completions');",
  };
  for (const [name, body] of Object.entries(forms)) {
    const scan = scanAdapterSources({ ...identity, 'package/lib/index.js': body }, { zone: 'yellow' });
    assert.equal(scan.found.chatUrl, 'https://chat.zone-y.example.test/api/v2/chat/completions', name);
    assert.equal(scanAdapterSources({ ...identity, 'package/lib/index.js': body }).found.chatUrl, undefined, name + ': no zone, no guessed host');
    assert.match(scan.from.chatUrl, /^adapter:index\.js/, name);
    assert.equal(scan.found.identityUrl, 'https://id.example.test/svc/auth/getUserDetail', name);
  }
  // The shape of dsh-hw-llm-adapter 1.0.27 index.js (company Q-1106-09): two constants around the zone letter,
  // a template on the main path and a + chain on the recovery path; the adapter's own fallback is green.
  const real = [
    "const SNAPENGINE_BASE = 'https://chat.example.test.prod-z-';",
    "const SNAPENGINE_PATH = '.example.test/api/v2/chat/completions';",
    'const { username, zone } = this.config.options();',
    'const z = (zone || "green").charAt(0).toLowerCase();',
    'const snapengineUrl = `${SNAPENGINE_BASE}${z}${SNAPENGINE_PATH}`;',
    'zone: { type: "string", default: "green", volatile: true },',
  ].join('\n');
  const realScan = scanAdapterSources({ ...identity, 'package/lib/index.js': real }, { zone: 'yellow' });
  assert.equal(realScan.found.chatUrl, 'https://chat.example.test.prod-z-y.example.test/api/v2/chat/completions');
  // The recovery path alone (+ chain) gives the same URL.
  const recovery = real.replace(/const snapengineUrl[^\n]*\n/, '') + '\nconst zz = String(zone ?? "green")[0].toLowerCase();\nconst recoveryUrl = SNAPENGINE_BASE + zz + SNAPENGINE_PATH;';
  assert.equal(scanAdapterSources({ ...identity, 'package/lib/index.js': recovery }, { zone: 'yellow' }).found.chatUrl,
    'https://chat.example.test.prod-z-y.example.test/api/v2/chat/completions');
  // All three zones: green -> g, blue -> b; the adapter's own "green" fallback is never used by Hub.
  assert.equal(scanAdapterSources({ 'package/lib/index.js': forms.template }, { zone: 'green' }).found.chatUrl,
    'https://chat.zone-g.example.test/api/v2/chat/completions');
  assert.equal(scanAdapterSources({ ...identity, 'package/lib/index.js': real }, { zone: 'blue' }).found.chatUrl,
    'https://chat.example.test.prod-z-b.example.test/api/v2/chat/completions');
  assert.equal(scanAdapterSources({ ...identity, 'package/lib/index.js': real }).found.chatUrl, undefined);
  // Two candidate origins and no full URL: no guess.
  const ambiguous = discoverFromSources({ 'package/lib/index.js': "const A='https://a.example.test'; const B='https://b.example.test'; post(A+x+'chat/completions')" });
  assert.equal(ambiguous.chatUrl, undefined);
  // An unresolvable piece (runtime config) is not guessed either.
  assert.equal(discoverFromSources({ 'package/lib/index.js': 'const u = `https://${config.host}/api/v2/chat/completions`;' }).chatUrl, undefined);
});

test('profile diagnostics: each value names its source category and file; a failure lists every place tried', async () => {
  const { resolveUpstreamProfile } = await load('upstream-profile.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-diag-'));
  try {
    fs.mkdirSync(path.join(dataDir, '.cac'));
    fs.writeFileSync(path.join(dataDir, '.cac', '.credentials.json'), '{}');
    const members = {
      'package/lib/index.js': "headers={'app-id':'com.example.client'}; const u = `https://chat.zone-${zone[0]}.example.test/api/v2/chat/completions`;",
      'package/lib/codeagent.js': "const ID='https://id.example.test/svc/auth/getUserDetail';\nasync function getUserDetail(t) { const j = await post(ID, t); return { account: j.data.staffAccount, deptPath: j.data.orgPath || \'\' }; }",
      'package/lib/signer.js': 'process.env.EXAMPLE_AUTH_DIR',
    };
    fs.writeFileSync(path.join(dataDir, '.cac', '.cac.json'), JSON.stringify({ enterpriseNetworkZoneCache: 'yellow' }));
    const base = { dataDir, env: { USERPROFILE: dataDir }, versionReader: async () => '9.1.2', packageFinder: async () => path.join(dataDir, 'dsh-hw-llm-adapter-1.0.27.tgz') };
    // Without the chat line: PROFILE_INCOMPLETE, with what was found, where, and every place looked at.
    const noChat = { ...members, 'package/lib/index.js': "headers={'app-id':'com.example.client'}" };
    const error = await resolveUpstreamProfile({ ...base, archiveReader: async (_a, m) => noChat[m] || '' }).catch(e => e);
    assert.equal(error.code, 'PROFILE_INCOMPLETE');
    assert.deepEqual(error.missing, ['chatUrl']);
    assert.match(error.message, /模型接口地址（config:upstream\.json、adapter:index\.js:full-url/);
    const d = error.diagnostics;
    assert.equal(d.personalCredentialFile, true, 'default personal login path is <USERPROFILE>\\.cac\\.credentials.json');
    assert.equal(d.sources.personalCredential, 'default:.cac/.credentials.json');
    assert.equal(d.sources.adapterPackage, 'welink:dsh-hw-llm-adapter-1.0.27.tgz');
    assert.equal(d.sources.identityUrl, 'adapter:codeagent.js');
    assert.equal(d.sources.codeagentVersion, 'registry:Uninstall');
    assert.equal(d.codeagentVersion, '9.1.2', 'the version read from the registry is reported, not only its source');
    assert.equal(d.zone, 'yellow');
    assert.ok(d.tried.chatUrl.includes('adapter:codeagent.js:full-url'));
    assert.ok(!JSON.stringify(d).includes('example.test'), 'diagnostics never carry URL text');
    // With it: complete, and every source named.
    const cache = path.join(dataDir, 'company-model-proxy', 'signer-cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'codeagent-version-stamp'), '9.1.2\n123\n');
    const profile = await resolveUpstreamProfile({ ...base, archiveReader: async (_a, m) => members[m] || '' });
    assert.equal(profile.chatUrl, 'https://chat.zone-y.example.test/api/v2/chat/completions');
    assert.equal(profile.sources.chatUrl, 'adapter:index.js');
    assert.equal(profile.sources.zone, 'codeagent:.cac.json:word');
    assert.equal(profile.sources.identityFields, 'adapter:codeagent.js');
    assert.equal(profile.identityAccountField, 'staffAccount');
    assert.equal(profile.identityDeptField, 'orgPath');
    assert.equal(profile.sources.signerCacheDir, 'hub');
    assert.equal(profile.diagnostics.personalCredentialFile, true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- zone: explicit choice > CodeAgent's .cac.json (word, then region letter) > identity answer > ask the user ----------
async function zoneProfile({ cac, homeCac, upstream = {}, chatTemplate = true, zoneOverride = null } = {}) {
  const { resolveUpstreamProfile } = await load('upstream-profile.mjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-zone-'));
  fs.mkdirSync(path.join(dataDir, '.cac'), { recursive: true });
  if (cac) fs.writeFileSync(path.join(dataDir, '.cac', '.cac.json'), JSON.stringify(cac));
  if (homeCac) fs.writeFileSync(path.join(dataDir, '.cac.json'), JSON.stringify(homeCac));
  fs.mkdirSync(path.join(dataDir, 'company-model-proxy', 'signer-cache'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'signer-cache', 'codeagent-version-stamp'), '9.1.2\n123\n');
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'upstream.json'), JSON.stringify(upstream));
  const members = {
    'package/lib/index.js': "headers={'app-id':'com.example.client'};\nconst SNAP_BASE = 'https://chat.example.test.zone-';\nconst SNAP_PATH = '.example.test/api/v2/chat/completions';\n" +
      (chatTemplate ? 'const z = (zone || "green").charAt(0).toLowerCase();\nconst u = `${SNAP_BASE}${z}${SNAP_PATH}`;' : ''),
    'package/lib/codeagent.js': "const ID='https://id.example.test/svc/auth/getUserDetail';\nasync function getUserDetail(t) { const j = await post(ID, t); return { account: j.data.staffAccount, deptPath: j.data.orgPath || '' }; }",
    'package/lib/signer.js': 'process.env.EXAMPLE_AUTH_DIR',
  };
  try {
    return await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: dataDir }, versionReader: async () => '9.1.2', zoneOverride,
      packageFinder: async () => path.join(dataDir, 'a.tgz'), archiveReader: async (_a, m) => members[m] || '' }).catch(e => e);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('zone: the zone word CodeAgent cached (.cac.json enterpriseNetworkZoneCache), said in plain words', async () => {
  const profile = await zoneProfile({ cac: { enterpriseNetworkZoneCache: 'yellow', enterpriseUserDetailCache: { region: 'g', staffNo: 'x123' } } });
  assert.equal(profile.zone, 'yellow', 'the word wins over the letter');
  assert.equal(profile.chatUrl, 'https://chat.example.test.zone-y.example.test/api/v2/chat/completions');
  assert.equal(profile.zoneInfo.source, 'codeagent:.cac.json:word');
  assert.equal(profile.zoneInfo.text, '已从 CodeAgent 识别为黄区（CodeAgent 登录时记下的区域）。');
  assert.ok(!JSON.stringify(profile).includes('x123'), 'no other field of that file is kept');
});

test('zone: the region letter CodeAgent cached (enterpriseUserDetailCache.region y/g/b), also from the home copy; Settings wins', async () => {
  const green = await zoneProfile({ cac: { enterpriseUserDetailCache: { region: 'g' } } });
  assert.equal(green.chatUrl, 'https://chat.example.test.zone-g.example.test/api/v2/chat/completions');
  assert.equal(green.zoneInfo.source, 'codeagent:.cac.json:letter');
  assert.match(green.zoneInfo.text, /已从 CodeAgent 识别为绿区/);
  const blue = await zoneProfile({ homeCac: { enterpriseUserDetailCache: { region: 'B' } } });
  assert.equal(blue.zone, 'blue');
  assert.equal(blue.zoneInfo.source, 'codeagent:home/.cac.json:letter');
  const chosen = await zoneProfile({ cac: { enterpriseNetworkZoneCache: 'yellow' }, upstream: { zone: 'green', zoneChosenBy: 'settings' } });
  assert.equal(chosen.chatUrl, 'https://chat.example.test.zone-g.example.test/api/v2/chat/completions');
  assert.equal(chosen.sources.zone, 'settings');
  assert.equal(chosen.zoneInfo.text, '用的是绿区（你在这里选的）。');
  const configured = await zoneProfile({ upstream: { zone: 'blue' } });
  assert.match(configured.zoneInfo.text, /蓝区（来自 Hub 数据目录里的上游配置 upstream\.json）/);
  // Nothing on disk, but the identity answer carried the region letter (server.mjs passes it as zoneOverride).
  const identity = await zoneProfile({ zoneOverride: { zone: 'yellow' } });
  assert.equal(identity.zone, 'yellow');
  assert.equal(identity.zoneInfo.source, 'identity:region');
  assert.match(identity.zoneInfo.text, /已从 CodeAgent 识别为黄区（公司身份接口返回的区域）/);
});

test('zone: both fields missing or not valid -> ZONE_UNKNOWN asking the user to choose (never guessed)', async () => {
  for (const cac of [undefined, {}, { enterpriseNetworkZoneCache: 'green-zone' }, { enterpriseUserDetailCache: { region: 'x' } },
    { enterpriseNetworkZoneCache: 42, enterpriseUserDetailCache: { region: 'yy' } }, { zone: 'yellow' }]) {
    const error = await zoneProfile({ cac });
    assert.equal(error.code, 'ZONE_UNKNOWN', JSON.stringify(cac));
    assert.deepEqual(error.missing, ['zone']);
    assert.match(error.message, /「所在区域」里选择/);
    assert.equal(error.zone.zone, '');
    assert.ok(error.diagnostics.tried.zone.includes('codeagent:.cac.json'));
    assert.ok(error.identityProbe && error.identityProbe.identityUrl.startsWith('https://'), 'the proxy may still ask the identity service');
    assert.ok(!JSON.stringify(error.diagnostics).includes('example.test'));
  }
  // No zone-dependent chat URL in the adapter at all: the old "missing chat URL" report, not a zone question.
  const noChat = await zoneProfile({ chatTemplate: false });
  assert.equal(noChat.code, 'PROFILE_INCOMPLETE');
  assert.deepEqual(noChat.missing, ['chatUrl']);
});

test('zone choice in Settings is written to upstream.json and can be reset to automatic', () => {
  const proxy = require('../core/company-model-proxy');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-zonecfg-'));
  try {
    fs.mkdirSync(proxy.proxyDir(dataDir), { recursive: true });
    fs.writeFileSync(proxy.upstreamFile(dataDir), JSON.stringify({ codeagentDir: 'C:\\X' }));
    proxy.setUpstreamZone(dataDir, 'green');
    assert.deepEqual(proxy.readUpstreamConfig(dataDir), { codeagentDir: 'C:\\X', zone: 'green', zoneChosenBy: 'settings' });
    assert.deepEqual(proxy.chosenZone(dataDir), { zone: 'green', chosenBy: 'settings' });
    proxy.setUpstreamZone(dataDir, '');
    assert.deepEqual(proxy.readUpstreamConfig(dataDir), { codeagentDir: 'C:\\X' });
    assert.throws(() => proxy.setUpstreamZone(dataDir, 'red'), /区域只能是/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('Settings shows the zone, where it came from, and a dropdown when it is unknown', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-api-settings.js'), 'utf8');
  assert.match(source, /所在区域<select name="zone"/);
  assert.match(source, /company-proxy:set-zone/);
  assert.match(source, /ZONE_UNKNOWN/);
  for (const name of ['蓝区', '绿区', '黄区', '自动识别']) assert.ok(source.includes(name), name);
});

test('CodeAgent version from the registry: one distinct DisplayVersion counts', async () => {
  const { parseRegistryVersions } = await load('upstream-profile.mjs');
  assert.equal(parseRegistryVersions('["1.2615.02.03"]'), '1.2615.02.03');
  assert.equal(parseRegistryVersions('"1.2615.02.03"\r\n'), '1.2615.02.03');
  assert.equal(parseRegistryVersions('["1.2615.02.03","1.2615.02.03 "]'), '1.2615.02.03', 'same install under two roots');
  assert.equal(parseRegistryVersions('["1.2615.02.03","0.3.2"]'), '');
  for (const bad of ['[]', '', '[null]', '{"DisplayVersion":"1.2"}', 'not json', '["HKEY_LOCAL_MACHINE\\\\SOFTWARE"]']) assert.equal(parseRegistryVersions(bad), '', bad);
  const source = fs.readFileSync(path.join(dir, 'upstream-profile.mjs'), 'utf8');
  assert.match(source, /\[string\]\$p\.DisplayVersion/, 'the query returns the DisplayVersion value, not the key');
});

// ---------- signer first-time initialization (adapter's own flow, one hidden CLI run) ----------
const FAKE_SIGNER = `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
let version = '', ok = false;
export function codeagentVersion() { return version; }
export async function isAvailable() { return ok; }
export async function init(dir) {
  version = readFileSync(join(dir, 'version.txt'), 'utf8').trim();
  if (process.env.FAKE_SIGNER_HANG === '1') return new Promise(() => {});
  const file = join(process.env.FAKE_AUTH_DIR, 'codeagent-version-stamp');
  if (existsSync(file) && readFileSync(file, 'utf8').split(/\\r?\\n/)[0] === version) { ok = true; return true; }
  const log = join(process.env.TEMP || process.env.TMP || '.', 'codeagent_signer.log');
  try { unlinkSync(log); } catch {}
  const stamp = await new Promise(resolve => {
    let child;
    try { child = spawn(join(dir, 'bin', 'codeagentcli.exe'), ['--skip-safe-check', '-p', '--tools', '', '--no-session-persistence'],
      { windowsHide: false, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEAGENT_SIGNER_LOG: '1' } }); }
    catch { resolve(null); return; }
    child.on('error', () => resolve(null));
    child.on('exit', () => { try { const m = readFileSync(log, 'utf8').match(/SnapEngineSigner created:.*?win32-x64-(\\d+)/); resolve(m ? m[1] : null); } catch { resolve(null); } });
    child.stdin?.end('hi\\n');
  });
  if (stamp) writeFileSync(file, version + '\\n' + stamp + '\\n');
  ok = true; return true;
}
`;
function fakeAdapter(root) {
  const pkg = path.join(root, 'pkgsrc', 'package');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fake-adapter', version: '0.0.1', type: 'module' }));
  fs.writeFileSync(path.join(pkg, 'lib', 'signer.js'), FAKE_SIGNER);
  const archive = path.join(root, 'fake-llm-adapter-0.0.1.tgz');
  require('node:child_process').execFileSync('C:\\Windows\\System32\\tar.exe', ['-czf', archive, '-C', path.join(root, 'pkgsrc'), 'package'], { windowsHide: true });
  return archive;
}
// A child the test delegate hands back: writes the signer log like the CLI would, then exits.
function fakeCliChild({ temp, writeLog = true, exitAfterMs = 20 }) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdin = { end() {} }; child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
  setTimeout(() => {
    if (child.killed) return;
    if (writeLog) fs.writeFileSync(path.join(temp, 'codeagent_signer.log'), 'x SnapEngineSigner created: v=9 win32-x64-1730000000123 more\n');
    child.emit('exit', 0, null);
  }, exitAfterMs);
  return child;
}
async function firstInitFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeagentDir = path.join(root, 'CodeAgentCLI'), temp = path.join(root, 'temp'), cache = path.join(root, 'hub', 'company-model-proxy', 'signer-cache');
  fs.mkdirSync(path.join(codeagentDir, 'bin'), { recursive: true }); fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(path.join(codeagentDir, 'version.txt'), '9.1.2');
  const profile = { adapterPackage: fakeAdapter(root), codeagentDir, codeagentVersion: '9.1.2', signerCacheEnv: 'FAKE_AUTH_DIR',
    signerCacheDir: cache, signerInit: { needed: true, reason: 'missing' } };
  const saved = { TEMP: process.env.TEMP, KEY: process.env.AI_HUB_COMPANY_PROXY_KEY, HANG: process.env.FAKE_SIGNER_HANG };
  process.env.TEMP = temp; process.env.AI_HUB_COMPANY_PROXY_KEY = 'k'.repeat(40);
  t.after(() => { for (const [k, n] of [['TEMP', 'TEMP'], ['KEY', 'AI_HUB_COMPANY_PROXY_KEY'], ['HANG', 'FAKE_SIGNER_HANG']]) { if (saved[k] === undefined) delete process.env[n]; else process.env[n] = saved[k]; } delete process.env.FAKE_AUTH_DIR; });
  return { root, codeagentDir, temp, cache, profile, workDir: path.join(root, 'work') };
}

// The native stamp probe as loadSigner sees it: one CLI run, returns the stamp read from the signer log.
const fakeProbe = (calls, { stamp = '1730000000123', ok = true, report = {} } = {}) => async options => {
  calls.push(options);
  const base = { ran: true, cliStarted: true, cliExitCode: 0, stoppedBy: ok ? 'stamp' : 'exit', logExists: ok, logBytes: ok ? 60 : 0, logLines: ok ? 1 : 0,
    markerMatched: ok, stampParsed: ok, logVersionStatus: 'unknown', error: ok ? null : 'LOG_MISSING', ...report };
  return ok ? { ok, report: base, stamp } : { ok, report: base };
};

test('first-time signer init: one native CLI run writes the cache, the signer itself starts no CLI; a second run reuses it', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { loadSigner, inspectStamp } = await load('upstream-profile.mjs');
  const f = await firstInitFixture(t);
  f.profile.personalCredential = path.join(f.root, 'home', '.cac', '.credentials.json');
  const probes = [], spawned = [];
  const delegate = (command, args, options) => { spawned.push(command); return fakeCliChild({ temp: f.temp }); };
  const first = await loadSigner(f.profile, { workDir: f.workDir, testOnlySpawnDelegate: delegate, stampProbe: fakeProbe(probes) });
  assert.equal(first.firstInit.ran, true);
  assert.equal(first.firstInit.cliRuns, 1);
  assert.equal(first.firstInit.method, 'native-cli');
  assert.equal(first.firstInit.cacheWrite.category, 'hub-signer-cache');
  assert.equal(first.firstInit.probe.stampParsed, true);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].cliExe, path.join(f.codeagentDir, 'bin', 'codeagentcli.exe'));
  assert.equal(probes[0].configDir, path.join(f.root, 'home', '.cac'), 'CodeAgent\'s own data dir (where the personal login lives)');
  assert.equal(probes[0].expectedVersion, '9.1.2');
  assert.ok(probes[0].timeoutMs > 0 && probes[0].timeoutMs <= 45000);
  assert.deepEqual(spawned, [], 'with the cache in place the signer does not start the CLI');
  assert.deepEqual(await inspectStamp(f.cache, '9.1.2'), { state: 'ok' });
  assert.equal(fs.readFileSync(path.join(f.cache, 'codeagent-version-stamp'), 'utf8'), '9.1.2\n1730000000123\n');
  assert.ok(!JSON.stringify(first.firstInit).includes('1730000000123'), 'the stamp is not in the status');
});

test('first-time signer init is refused outside its scope: no CLI run when the cache is fine, a second CLI run is blocked', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const { initializeCacheOnlySigner } = await load('signer-init.mjs');
  const codeagentDir = 'C:\\Fake\\CodeAgentCLI', cli = codeagentDir + '\\bin\\codeagentcli.exe';
  const signerWith = runs => async () => ({ async init() { for (let i = 0; i < runs; i++) require('node:child_process').spawn(cli, ['-p'], {}); return true; },
    async isAvailable() { return true; }, codeagentVersion: () => '9.1.2' });
  const delegate = () => ({ once() {}, on() {}, kill() {} });
  // Without allowStampProbe (cache hit path) a CLI run is blocked, as before.
  await assert.rejects(initializeCacheOnlySigner({ codeagentDir, loadSigner: signerWith(1), testOnly: true, testOnlySpawnDelegate: delegate }),
    e => e.code === 'SIGNER_INIT_SPAWN_BLOCKED' && e.spawnSummary.cliBlocked === 1 && e.spawnSummary.cliAllowed === 0);
  // With it: exactly one.
  await assert.rejects(initializeCacheOnlySigner({ codeagentDir, allowStampProbe: true, loadSigner: signerWith(2), testOnly: true, testOnlySpawnDelegate: delegate }),
    e => e.code === 'SIGNER_INIT_SPAWN_BLOCKED' && e.spawnSummary.cliAllowed === 1 && e.spawnSummary.cliBlocked === 1);
  // Other programs stay blocked even in first-time mode.
  const other = async () => ({ async init() { require('node:child_process').spawn('cmd.exe', ['/c', 'echo'], { windowsHide: true }); return true; }, async isAvailable() { return true; } });
  await assert.rejects(initializeCacheOnlySigner({ codeagentDir, allowStampProbe: true, loadSigner: other, testOnly: true, testOnlySpawnDelegate: delegate }),
    e => e.code === 'SIGNER_INIT_SPAWN_BLOCKED' && e.spawnSummary.otherBlocked === 1);
});

test('first-time signer init failures are explained with diagnostics: no stamp, timeout, CLI not started, cache not writable', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { loadSigner } = await load('upstream-profile.mjs');
  const f = await firstInitFixture(t);
  const noStamp = await loadSigner(f.profile, { workDir: f.workDir, stampProbe: fakeProbe([], { ok: false }) }).catch(e => e);
  assert.equal(noStamp.code, 'SIGNER_INIT_NO_STAMP');
  assert.match(noStamp.message, /首次签名初始化没完成（CodeAgent 命令行跑完了，但没有留下签名信息：签名日志没有生成）/);
  assert.match(noStamp.message, /不弹窗、不登录、不刷新登录/);
  assert.match(noStamp.message, /重新启动反代/);
  assert.equal(noStamp.firstInit.ran, true);
  assert.deepEqual([noStamp.firstInit.probe.cliExitCode, noStamp.firstInit.probe.logExists, noStamp.firstInit.probe.logLines, noStamp.firstInit.probe.markerMatched, noStamp.firstInit.probe.stampParsed], [0, false, 0, false, false]);
  const marker = await loadSigner(f.profile, { workDir: f.workDir, stampProbe: fakeProbe([], { ok: false, report: { logExists: true, logLines: 3, error: 'MARKER_MISSING' } }) }).catch(e => e);
  assert.match(marker.message, /签名日志里没有签名记录/);
  const timeout = await loadSigner(f.profile, { workDir: f.workDir, stampProbe: fakeProbe([], { ok: false, report: { stoppedBy: 'timeout', error: 'CLI_TIMEOUT' } }) }).catch(e => e);
  assert.equal(timeout.code, 'SIGNER_INIT_TIMEOUT');
  assert.match(timeout.message, /CodeAgent 命令行在 45 秒内没有结束/);
  const notStarted = await loadSigner(f.profile, { workDir: f.workDir, stampProbe: fakeProbe([], { ok: false, report: { cliStarted: false, error: 'CLI_START_FAILED' } }) }).catch(e => e);
  assert.equal(notStarted.code, 'SIGNER_INIT_CLI_FAILED');
  assert.equal(notStarted.firstInit.cliRuns, 0);
  const thrown = await loadSigner(f.profile, { workDir: f.workDir, stampProbe: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }).catch(e => e);
  assert.equal(thrown.code, 'SIGNER_INIT_CLI_FAILED');
  assert.equal(thrown.firstInit.probe.error, 'PROBE_FAILED:EACCES');
  // A file where the cache directory should be: the stamp was read but cannot be stored.
  const blocked = { ...f.profile, signerCacheDir: path.join(f.root, 'cache-file') };
  fs.writeFileSync(path.join(f.root, 'cache-file'), 'x');
  const write = await loadSigner(blocked, { workDir: f.workDir, stampProbe: fakeProbe([]) }).catch(e => e);
  assert.ok(['SIGNER_INIT_CACHE_WRITE', 'SIGNER_INIT_FAILED'].includes(write.code), write.code);
});

test('first-time signer init timeout kills the CLI and says so', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { initializeCacheOnlySigner } = await load('signer-init.mjs');
  const { signerInitFailureMessage } = await load('upstream-profile.mjs');
  const codeagentDir = 'C:\\Fake\\CodeAgentCLI', cli = codeagentDir + '\\bin\\codeagentcli.exe';
  let killed = false;
  const delegate = () => ({ once() {}, on() {}, kill() { killed = true; } });
  const hang = async () => ({ async init() { require('node:child_process').spawn(cli, ['-p'], {}); return new Promise(() => {}); }, async isAvailable() { return true; } });
  const started = Date.now();
  // The init timeout timer is unref'd (it must never keep Hub alive). Hold the test's own event loop open,
  // otherwise a runner with nothing else pending cancels the test before the timeout fires.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(initializeCacheOnlySigner({ codeagentDir, allowStampProbe: true, timeoutMs: 300, loadSigner: hang, testOnly: true, testOnlySpawnDelegate: delegate }),
    e => e.code === 'SIGNER_INIT_TIMEOUT' && e.spawnSummary.cliAllowed === 1);
  clearInterval(keepAlive);
  assert.ok(Date.now() - started < 5000);
  assert.equal(killed, true);
  assert.match(signerInitFailureMessage('SIGNER_INIT_TIMEOUT', { version: '9.1.2', timeoutMs: 60000 }), /CodeAgent 命令行在 60 秒内没有结束/);
});

test('CodeAgent upgraded: the cache of the old version triggers a new first-time init', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { loadSigner, resolveUpstreamProfile } = await load('upstream-profile.mjs');
  const f = await firstInitFixture(t);
  const probes = [];
  const probe = fakeProbe(probes);
  await loadSigner(f.profile, { workDir: f.workDir, stampProbe: probe });
  assert.equal(probes.length, 1);
  // Upgrade to 9.2.0: lookup reports a stale cache and plans a first-time init, which rewrites the cache.
  fs.writeFileSync(path.join(f.codeagentDir, 'version.txt'), '9.2.0');
  const dataDir = path.join(f.root, 'hub');
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'upstream.json'), JSON.stringify({ adapterPackage: f.profile.adapterPackage, codeagentDir: f.codeagentDir,
    codeagentVersion: '9.2.0', signerCacheEnv: 'FAKE_AUTH_DIR', zone: 'yellow', identityUrl: 'https://id.example.test/svc/auth/getUserDetail', identityAccountField: 'staffAccount',
    chatUrl: 'https://chat.example.test/api/v2/chat/completions', appId: 'c.example' }));
  const profile = await resolveUpstreamProfile({ dataDir, env: { USERPROFILE: f.root }, archiveReader: async () => '' });
  assert.equal(profile.signerInit.reason, 'version');
  // The ESM signer is cached per process; a fresh copy of the fake is loaded through a new work dir.
  const again = await loadSigner(profile, { workDir: path.join(f.root, 'work2'), stampProbe: probe });
  assert.equal(again.firstInit.ran, true);
  assert.equal(probes.length, 2);
  assert.match(fs.readFileSync(path.join(f.cache, 'codeagent-version-stamp'), 'utf8'), /^9\.2\.0\n\d+\n$/);
});

// ---- native stamp probe (core/company-proxy/native-stamp.mjs) ----
test('native stamp: log parsing takes the first complete marker line, never a half-written tail', async () => {
  const { parseStampLog } = await load('native-stamp.mjs');
  assert.deepEqual(parseStampLog(''), { lines: 0, markerMatched: false, stamp: null, logVersion: null, incompleteTail: false });
  const two = parseStampLog('a\nx SnapEngineSigner created: v 1.2615.02.03-win32-x64-1730000000111 y\nSnapEngineSigner created: win32-x64-222\n');
  assert.equal(two.stamp, '1730000000111'); assert.equal(two.logVersion, '1.2615.02.03'); assert.equal(two.markerMatched, true);
  const tail = parseStampLog('a\r\nSnapEngineSigner created: win32-x64-1730');
  assert.equal(tail.stamp, null); assert.equal(tail.incompleteTail, true); assert.equal(tail.lines, 2);
  const noDigits = parseStampLog('SnapEngineSigner created: win32-x64-abc\n');
  assert.equal(noDigits.stamp, null); assert.equal(noDigits.markerMatched, true);
});

test('native stamp: CLI environment drops proxy key and a surrounding CodeAgent / Claude Code session, sets the signer log and fresh TEMP', async () => {
  const { cliEnvironment, quoteArg, cliArguments } = await load('native-stamp.mjs');
  const { env, dropped } = cliEnvironment({ PATH: 'p', AI_HUB_COMPANY_PROXY_KEY: 'k', CODEAGENT3_LAUNCHER_PID: '1', CodeAgent3_Config_Dir: 'x', CLAUDECODE: '1',
    NODE_OPTIONS: '--x', ELECTRON_RUN_AS_NODE: '1', TEMP: 'old', TMP: 'old', CODEAGENT_SIGNER_LOG: '0' }, { temp: 'C:\\t', configDir: 'C:\\u\\.cac' });
  assert.deepEqual(env, { PATH: 'p', CODEAGENT_SIGNER_LOG: '1', TEMP: 'C:\\t', TMP: 'C:\\t', CODEAGENT3_CONFIG_DIR: 'C:\\u\\.cac' });
  assert.equal(dropped, 9);
  assert.equal(quoteArg(''), '""'); assert.equal(quoteArg('a'), 'a'); assert.equal(quoteArg('C:\\a b\\'), '"C:\\a b\\\\"'); assert.equal(quoteArg('x"y'), '"x\\"y"');
  const args = cliArguments({ mcp: 'm', settings: 's' });
  assert.equal(args[0], '--print'); assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(!args.includes('--model'));
  assert.deepEqual(cliArguments({ mcp: 'm', settings: 's', model: 'x1' }).slice(-2), ['--model', 'x1']);
});

function fakeLauncher({ temp, writeLog = true, exitCode = 0, hang = false, pid = 777 } = {}, calls) {
  const { EventEmitter } = require('node:events');
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    if (/taskkill/i.test(command)) { setImmediate(() => { calls.killed = true; calls.launcher?.emit('close', 1); child.emit('close', 0); }); return child; }
    const { PassThrough } = require('node:stream');
    child.stdout = new PassThrough(); child.kill = () => { child.emit('close', null); };
    calls.launcher = child;
    const tempDir = options.env.TEMP;
    setTimeout(() => {
      child.stdout.write(`CLI_PID=${pid}\r\n`);
      if (writeLog) fs.writeFileSync(path.join(tempDir, 'codeagent_signer.log'), 'z SnapEngineSigner created: 9.1.2-win32-x64-1730000000555 q\n');
      if (!hang) setTimeout(() => { child.stdout.write(`CLI_EXIT=${exitCode}\r\n`); child.emit('close', 0); }, writeLog ? 400 : 20);
    }, 20);
    return child;
  };
}

test('native stamp: hidden PowerShell launcher, no window flags, stops the CLI as soon as the stamp is in the log', { timeout: 30000 }, async t => {
  const { probeNativeStamp } = await load('native-stamp.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-native-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const r = await probeNativeStamp({ cliExe: 'C:\\X\\bin\\codeagentcli.exe', configDir: 'C:\\u\\.cac', expectedVersion: '9.1.2', workRoot: root,
    env: { PATH: 'p', AI_HUB_COMPANY_PROXY_KEY: 'k' }, spawnImpl: fakeLauncher({ hang: true }, calls), pollMs: 20, timeoutMs: 5000 });
  assert.equal(r.ok, true); assert.equal(r.stamp, '1730000000555');
  assert.equal(r.report.stoppedBy, 'stamp'); assert.equal(r.report.logVersionStatus, 'matched'); assert.equal(r.report.cliStarted, true);
  assert.equal(calls.killed, true, 'the CLI tree is stopped with taskkill once the stamp is read');
  const launch = calls[0];
  assert.match(launch.command, /powershell\.exe$/i);
  assert.equal(launch.options.windowsHide, true); assert.equal(launch.options.shell, false); assert.equal(launch.options.detached, false);
  assert.match(launch.args.at(-1), /Start-Process -FilePath \$exe -ArgumentList \$argLine .*-WindowStyle Hidden/);
  assert.ok(!launch.args.at(-1).includes('codeagentcli'), 'paths reach PowerShell through variables, not spliced into the script');
  assert.equal(launch.options.env.CODEAGENT_SIGNER_LOG, '1');
  assert.equal(launch.options.env.AI_HUB_COMPANY_PROXY_KEY, undefined);
  assert.match(launch.options.env.HUB_STAMP_ARGS, /^--print .* --tools "" /);
  assert.equal(calls.find(c => /taskkill/i.test(c.command)).args.join(' '), '/PID 777 /T /F');
  assert.deepEqual(fs.readdirSync(root), [], 'the scratch directory (CLI answer, log) is removed after success');
  // Private desktop first (C# source via a variable that is removed before the CLI starts), hidden console as fallback.
  assert.match(launch.options.env.HUB_STAMP_CS, /CreateDesktopW[\s\S]*si\.desktop = "WinSta0\\\\" \+ name[\s\S]*si\.show = 0/);
  assert.match(launch.args.at(-1), /'HUB_STAMP_CS'\)\{Remove-Item/);
  assert.ok(launch.args.at(-1).indexOf('[HubStampLaunch]::Start') < launch.args.at(-1).indexOf('Start-Process'), 'private desktop is tried first');
  assert.equal(r.report.consoleMode, 'unknown', 'a launcher that does not say its mode is not reported as hidden');
  const calls2 = [];
  const modeLauncher = fakeLauncher({ hang: true }, calls2);
  const r2 = await probeNativeStamp({ cliExe: 'C:\\X\\bin\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: root, env: {}, pollMs: 20, timeoutMs: 5000,
    privateDesktop: false, spawnImpl: (c, a, o) => { const child = modeLauncher(c, a, o); child.stdout?.write('CLI_MODE=hidden-console\r\n'); return child; } });
  assert.equal(r2.report.consoleMode, 'hidden-console');
  assert.equal(calls2[0].options.env.HUB_STAMP_CS, undefined, 'privateDesktop:false sends no C# source');
});

test('native stamp: failures report exit code, log existence, lines, marker, stamp - and keep the scratch dir locally', { timeout: 30000 }, async t => {
  const { probeNativeStamp } = await load('native-stamp.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-native-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const noLog = await probeNativeStamp({ cliExe: 'C:\\X\\c.exe', expectedVersion: '9.1.2', workRoot: root, env: {}, spawnImpl: fakeLauncher({ writeLog: false, exitCode: 2 }, []), pollMs: 20 });
  assert.equal(noLog.ok, false); assert.equal(noLog.stamp, undefined);
  assert.deepEqual([noLog.report.cliExitCode, noLog.report.stoppedBy, noLog.report.logExists, noLog.report.logLines, noLog.report.markerMatched, noLog.report.stampParsed, noLog.report.error],
    [2, 'exit', false, 0, false, false, 'LOG_MISSING']);
  const calls = [];
  const hang = await probeNativeStamp({ cliExe: 'C:\\X\\c.exe', expectedVersion: '9.1.2', workRoot: root, env: {}, spawnImpl: fakeLauncher({ writeLog: false, hang: true }, calls), pollMs: 20, timeoutMs: 300 });
  assert.equal(hang.report.stoppedBy, 'timeout'); assert.equal(hang.report.error, 'CLI_TIMEOUT'); assert.equal(calls.killed, true);
  const mismatch = await probeNativeStamp({ cliExe: 'C:\\X\\c.exe', expectedVersion: '9.9.9', workRoot: root, env: {}, spawnImpl: fakeLauncher({}, []), pollMs: 20 });
  assert.equal(mismatch.ok, false); assert.equal(mismatch.report.error, 'STAMP_VERSION_MISMATCH'); assert.equal(mismatch.stamp, undefined);
  const notStarted = await probeNativeStamp({ cliExe: 'C:\\X\\c.exe', expectedVersion: '9.1.2', workRoot: root, env: {}, spawnImpl: () => { throw new Error('ENOENT'); }, pollMs: 20 });
  assert.equal(notStarted.report.error, 'CLI_START_FAILED'); assert.equal(notStarted.report.cliStarted, false);
  assert.equal(fs.readdirSync(root).length, 4, 'failed runs keep their scratch dirs for local troubleshooting');
});

test('native stamp: cache file written atomically as "<version>\\n<stamp>\\n"; bad values refused', async t => {
  const { writeStampCache } = await load('native-stamp.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-native-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirc = path.join(root, 'c');
  assert.equal(await writeStampCache(dirc, '9.1.2', '123'), 'hub-signer-cache');
  assert.equal(await writeStampCache(dirc, '9.2.0', '456'), 'hub-signer-cache');
  assert.equal(fs.readFileSync(path.join(dirc, 'codeagent-version-stamp'), 'utf8'), '9.2.0\n456\n');
  assert.deepEqual(fs.readdirSync(dirc), ['codeagent-version-stamp']);
  await assert.rejects(writeStampCache(dirc, '9.1.2', '12a'), e => e.code === 'STAMP_INVALID');
});

// ---------- 2026-11-06 independent review fixes (items 2, 3, 5) and identity fields / region ----------
test('review 2: an expired / unreadable login is "login needed" (401, plain words), never shown as rate limiting', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const { loginNeededMessage } = await load('server.mjs');
  const broken = new Set(['personal']);
  const router = createAccountRouter({ listAccounts: () => [{ id: 'personal', kind: 'personal' }],
    makeProvider: (account, { onCredentialFailure }) => ({ complete: async () => { if (broken.has(account.id)) { onCredentialFailure(); throw new Error('expired'); } return sse(); } }) });
  const error = await router.complete({ model: 'GLM-5.2-WX' }, { sessionTag: 's' }).catch(e => e);
  assert.equal(error.code, 'COMPANY_LOGIN_NEEDED'); assert.equal(error.status, 401); assert.equal(error.personal, true);
  assert.match(loginNeededMessage(error), /需要重新登录：你自己的 CodeAgent 登录过期了或读不出来（不是限流）。请打开 CodeAgent 命令行登录一下/);
  assert.match(loginNeededMessage({ poolAccounts: 2 }), /号池里 2 个号的登录.*到 Hub 账号页把这些号重新登录/);
  // A real rate limit still reads as one, even when another account needs a login.
  const limited = createAccountRouter({ listAccounts: () => [{ id: 'pool111', kind: 'pool' }, { id: 'personal', kind: 'personal' }],
    makeProvider: (account, { onCredentialFailure }) => ({ complete: async () => {
      if (account.id === 'personal') { onCredentialFailure(); throw new Error('expired'); }
      return new Response('{}', { status: 429, headers: { 'retry-after': '30' } }); } }) });
  assert.equal((await limited.complete({ model: 'm' }, { sessionTag: 'a' })).status, 429);
  const again = await limited.complete({ model: 'm' }, { sessionTag: 'a' }).catch(e => e);
  assert.equal(again.code, 'COMPANY_NO_ACCOUNT_AVAILABLE'); assert.equal(again.status, 429);
});

test('review 2: a new login (the login file changed) ends the login cooldown at once', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  let stamp = 'v1', broken = true; const events = [];
  const router = createAccountRouter({ onEvent: e => events.push(e.type), credentialStamp: () => stamp,
    listAccounts: () => [{ id: 'personal', kind: 'personal', credentialFile: 'C:\\x\\.credentials.json' }],
    makeProvider: (account, { onCredentialFailure }) => ({ complete: async () => { if (broken) { onCredentialFailure(); throw new Error('expired'); } return sse(); } }) });
  assert.equal((await router.complete({}, { sessionTag: 's' }).catch(e => e)).code, 'COMPANY_LOGIN_NEEDED');
  broken = false;
  assert.equal((await router.complete({}, { sessionTag: 's' }).catch(e => e)).code, 'COMPANY_LOGIN_NEEDED', 'same file: still set aside');
  stamp = 'v2';
  assert.equal((await router.complete({}, { sessionTag: 's' })).status, 200, 'file rewritten by a login: used again without waiting 5 minutes');
  assert.ok(events.includes('credential_renewed'));
  // Default stamp: size + mtime of the file.
  const { fileStamp } = await load('account-router.mjs');
  const f = path.join(os.tmpdir(), `cmp-stamp-${process.pid}.json`); fs.writeFileSync(f, 'a');
  const a = fileStamp(f, fs.statSync); fs.writeFileSync(f, 'ab'); assert.notEqual(fileStamp(f, fs.statSync), a); fs.rmSync(f);
  assert.equal(fileStamp(f, fs.statSync), 'missing'); assert.equal(fileStamp('', fs.statSync), '');
});

test('review 2: proxy process answers 401 with the login hint when every login is unreadable', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'l'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'company-model-proxy'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ brokenCredentials: ['personal'] }));
  const { child, port } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': `${key}.t`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2-WX', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('retry-after'), null);
    const body = await r.json();
    assert.equal(body.error.type, 'authentication_error');
    assert.match(body.error.message, /需要重新登录.*不是限流.*登录后会自动恢复/);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const sseOf = frames => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
const chunk = delta => `data: ${JSON.stringify({ id: 'c1', model: 'GLM-5.2-WX', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;

test('review 3: Messages stream that breaks after it started ends with Anthropic "event: error" and a readable reason', async () => {
  const { convertChatResponse } = await load('messages-converter.mjs');
  const out = await (await convertChatResponse(sseOf([chunk({ content: 'hel' })]))).text();
  assert.match(out, /event: message_start/);
  const tail = out.trim().split('\n\n').pop();
  assert.match(tail, /^event: error\ndata: /);
  const data = JSON.parse(tail.split('\ndata: ')[1]);
  assert.equal(data.type, 'error'); assert.equal(data.error.type, 'api_error');
  assert.match(data.error.message, /中途失败：上游的流没有正常结束/);
  // A tool call without arguments ("") is an empty object, not a JSON.parse crash.
  const tool = `data: ${JSON.stringify({ id: 'c1', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '' } }] }, finish_reason: 'tool_calls' }] })}\n\n`;
  const ok = await (await convertChatResponse(sseOf([tool, 'data: [DONE]\n\n']))).text();
  assert.match(ok, /"partial_json":"\{\}"/); assert.doesNotMatch(ok, /event: error/);
});

test('review 3: Responses stream that breaks after it started ends with response.failed and a readable reason', async () => {
  const { convertChatToResponses } = await load('responses-converter.mjs');
  const out = await (await convertChatToResponses(sseOf([chunk({ content: 'hel' })]), { request: { model: 'GLM-5.2-WX' } })).text();
  const events = out.trim().split('\n\n').map(f => f.split('\n')[0].slice(7));
  assert.equal(events[0], 'response.created'); assert.equal(events.at(-1), 'response.failed');
  const failed = JSON.parse(out.trim().split('\n\n').pop().split('\ndata: ')[1]);
  assert.equal(failed.response.status, 'failed');
  assert.match(failed.response.error.message, /中途失败/);
  assert.ok(Number.isInteger(failed.sequence_number));
  // Empty function-call arguments become "{}".
  const tool = `data: ${JSON.stringify({ id: 'c1', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '' } }] }, finish_reason: 'tool_calls' }] })}\n\n`;
  const ok = await (await convertChatToResponses(sseOf([tool, 'data: [DONE]\n\n']), { request: { model: 'GLM-5.2-WX', tools: [{ type: 'function', name: 'shell', parameters: {} }] } })).text();
  assert.match(ok, /"arguments":"\{\}"/); assert.match(ok, /response\.completed/);
});

async function transportWith(provider, path_ = '/v1/chat/completions', adapters = {}) {
  const { createProxy } = await load('transport.mjs');
  const key = 'k'.repeat(32);
  const proxy = createProxy({ provider: { listModels: async () => [], ...provider }, accessKey: key, protocolAdapters: adapters });
  const { port } = await proxy.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path_}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    return { status: r.status, text: await r.text().catch(() => '<broken>') };
  } finally { await proxy.close(); }
}

test('review 3: before the stream, the error names the step (signature, upstream HTTP status, timeout); mid-stream chat break gets an error frame', async () => {
  const signFail = await transportWith({ complete: async () => { throw Object.assign(new Error('x'), { code: 'COMPANY_SIGNATURE_FAILED' }); } });
  assert.equal(signFail.status, 502);
  assert.match(JSON.parse(signFail.text).error.message, /卡在「请求签名（CodeAgent 签名模块）」这一步（COMPANY_SIGNATURE_FAILED）/);
  const login = await transportWith({ complete: async () => { throw Object.assign(new Error('x'), { code: 'COMPANY_ACCESS_TOKEN_FAILED' }); } });
  assert.match(JSON.parse(login.text).error.message, /读取登录信息/);
  const http500 = await transportWith({ complete: async () => new Response(JSON.stringify({ error: { message: 'busy at https://inner.host.example/x node-7.a.b' } }), { status: 500 }) });
  assert.equal(http500.status, 500);
  const m = JSON.parse(http500.text).error.message;
  assert.match(m, /^公司模型上游返回 HTTP 500（公司服务端出错）：busy at/);
  assert.doesNotMatch(m, /inner\.host|node-7\.a\.b|https:/, 'no URL or host text from the upstream body');
  const own = await transportWith({ complete: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: '需要重新登录' } }), { status: 401, headers: { 'x-company-proxy-own': '1' } }) });
  assert.equal(own.status, 401); assert.equal(JSON.parse(own.text).error.message, '需要重新登录', 'the proxy\'s own messages pass unchanged');
  // DSH passthrough: the upstream body breaks after the first chunk -> a chat-completions error frame, no fake [DONE].
  const broken = await transportWith({ complete: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunk({ content: 'hi' }))); setTimeout(() => c.error(new Error('reset')), 20); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(broken.status, 200);
  assert.match(broken.text, /data: \{"error":\{"type":"upstream_error","message":"公司模型的回复中途失败/);
  assert.doesNotMatch(broken.text, /\[DONE\]/);
  const { failureStep, preStreamMessage } = await load('failure-text.mjs');
  assert.match(preStreamMessage(null, { timedOut: true }), /等待公司上游超时/);
  assert.match(failureStep('COMPANY_IDENTITY_HTTP_FAILED'), /身份校验/);
});

test('review 5: the request slot is held until the stream ends, not released at the headers', { timeout: 30000 }, async () => {
  const { releaseOnEnd } = await load('server.mjs');
  let released = 0;
  let push;
  const upstream = new Response(new ReadableStream({ start(c) { push = c; } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const wrapped = releaseOnEnd(upstream, () => { released++; });
  const reader = wrapped.body.getReader();
  push.enqueue(new TextEncoder().encode('data: a\n\n'));
  await reader.read();
  assert.equal(released, 0, 'headers and the first chunk are out, the slot is still held');
  push.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(released, 1);
  const cancelled = releaseOnEnd(new Response(new ReadableStream({ start() {} })), () => { released++; });
  await cancelled.body.cancel();
  assert.equal(released, 2, 'a cancelled body releases too, once');
});

test('review 5: proxy process with --max-concurrent 1 queues a second request until the first stream ended', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'q'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'company-model-proxy'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify({ streamDelayMs: 1200 }));
  const { child, port } = await startProxy(dataDir, key, ['--max-concurrent', '1']);
  const base = `http://127.0.0.1:${port}`;
  const post = tag => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}.${tag}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  try {
    const first = await post('a');
    const second = post('b');
    await new Promise(r => setTimeout(r, 300));
    const mid = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(mid.stats.inFlight, 1, 'the first stream is still open: it holds the only slot');
    assert.equal(mid.stats.queued, 1, 'the second request waits');
    await first.text(); await (await second).text();
    const end = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(end.stats.inFlight, 0); assert.equal(end.stats.ok, 2);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('review 5: an aborted request cancels the 429 body it had kept', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  let cancelled = false;
  const controller = new AbortController();
  const router = createAccountRouter({ listAccounts: () => [{ id: 'pool111', kind: 'pool' }, { id: 'personal', kind: 'personal' }],
    makeProvider: account => ({ complete: async () => {
      if (account.id === 'pool111') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
      controller.abort(); throw Object.assign(new Error('aborted'), { code: 'L1_ABORTED' }); } }) });
  await assert.rejects(router.complete({}, { sessionTag: 's', signal: controller.signal }));
  assert.equal(cancelled, true);
});

test('review 5: stop during start stays "stopped"; a failed start does not trigger an automatic restart', { timeout: 60000 }, async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-svc-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 0 });
  const states = [];
  const service = new CompanyProxyService({ dataDir, isEnabled: () => true, mock: true, logger: { warn() {} }, onStatus: s => states.push(s.state) });
  try {
    const starting = service.ensureRunning();
    await new Promise(r => setTimeout(r, 30));
    await service.stop();
    const result = await starting.catch(e => ({ error: e.message }));
    assert.equal(service.state, 'stopped', JSON.stringify(result));
    assert.ok(!states.includes('failed'), states.join(','));
    // A start that never comes up: our own kill is not an "unexpected exit" (no automatic restart).
    service.waitForState = async () => null;
    await assert.rejects(service.ensureRunning());
    await new Promise(r => setTimeout(r, 500));
    assert.equal(service.state, 'failed');
    assert.equal(service.restarts, 0);
    assert.equal(service.child, null);
  } finally { await service.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('review 5: switching off the last company-model tool waits for requests in flight, says so, then stops', { timeout: 60000 }, async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-svc-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 0 });
  let enabled = true; const notices = [];
  const service = new CompanyProxyService({ dataDir, isEnabled: () => enabled, mock: true, logger: { warn() {} }, onNotice: n => notices.push(n) });
  try {
    await service.syncWithConfig();
    let inFlight = 1;
    service.request = async pathname => pathname === '/admin/status' ? { ready: true, stats: { inFlight, queued: 0 } } : {};
    enabled = false;
    const done = service.stopWhenIdle({ pollMs: 50, maxMs: 5000 });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(service.state, 'draining');
    assert.match(service.status().message, /等正在进行的 1 个公司模型请求结束后再停下反代/);
    assert.ok(notices.some(n => n.type === 'proxy_draining'));
    inFlight = 0;
    await done;
    assert.equal(service.state, 'stopped');
    // Idle: stops at once.
    enabled = true; delete service.request; await service.syncWithConfig();
    enabled = false; await service.syncWithConfig();
    assert.equal(service.state, 'stopped');
  } finally { await service.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('identity: endpoint and field names are read from the adapter source (function name as the only clue); the answer region letter is passed on', async () => {
  const { scanAdapterSources, scanIdentityFields } = await load('upstream-profile.mjs');
  const scan = scanAdapterSources({ 'package/lib/codeagent.js': "const BASE='https://id.example.test';\nconst P='/svc/v9/getUserDetail';\nasync function getUserDetail(t){ const r = await post(BASE+P); const data = r.data; if (!data.staffAccount) throw new Error('no staffAccount'); return { account: data.staffAccount, deptPath: data.orgDepartmentPath ?? '' }; }" });
  assert.equal(scan.found.identityUrl, 'https://id.example.test/svc/v9/getUserDetail');
  assert.equal(scan.found.identityAccountField, 'staffAccount'); assert.equal(scan.found.identityDeptField, 'orgDepartmentPath');
  assert.deepEqual(scanIdentityFields('async function getUserDetail(x) { const { staffAccount, orgDept } = (await r.json()).data; }'), { account: 'staffAccount', dept: 'orgDept' });
  assert.equal(scanIdentityFields('function other() { return data.x; }'), null);
  // Provider reads exactly those fields and reports the region letter.
  const { createCompanyPersonalProvider } = await load('signed-provider.mjs');
  const { createMockSigner, startMockUpstream, MOCK_IDENTITY_PATH, MOCK_IDENTITY_FIELDS } = await load('mock-upstream.mjs');
  const mock = await startMockUpstream({});
  const regions = [];
  try {
    const signer = createMockSigner();
    const provider = createCompanyPersonalProvider({ signer, appId: 'mock-client', expectedVersion: signer.codeagentVersion(), readAccessToken: async () => 'mock-token-personal',
      identityAccountField: MOCK_IDENTITY_FIELDS.account, identityDeptField: MOCK_IDENTITY_FIELDS.dept, testOnlyIdentityPath: MOCK_IDENTITY_PATH,
      testOnlyLoopbackOrigin: mock.origin, onIdentityRegion: r => regions.push(r), experimentalNativeThinking: true });
    const r = await provider.complete({ model: 'GLM-5.2-WX', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200); await r.text();
    assert.deepEqual(regions, ['y']);
  } finally { await mock.close?.(); }
  // Startup zone from the identity answer (server.mjs identityRegion).
  const { identityRegion } = await load('server.mjs');
  const fetchImpl = async () => new Response(JSON.stringify({ data: { region: 'G', other: 'x' } }), { status: 200 });
  assert.equal(await identityRegion({ identityUrl: 'https://id.example.test/a/getUserDetail', credential: 'C:\\c.json' }, { readToken: async () => 't', fetchImpl }), 'g');
  const bad = async () => new Response(JSON.stringify({ data: { region: 'yellow' } }), { status: 200 });
  assert.equal(await identityRegion({ identityUrl: 'https://id.example.test/a/getUserDetail', credential: 'C:\\c.json' }, { readToken: async () => 't', fetchImpl: bad }), '');
});

test('public edition: no internal address, path or field name is written in the company proxy code or its tests', () => {
  const files = [...fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).map(f => path.join(dir, f)),
    path.join(__dirname, '..', 'main', 'company-proxy-service.js'), path.join(__dirname, '..', 'core', 'company-model-proxy.js'),
    __filename, path.join(__dirname, 'helpers', 'company-proxy-fake-adapter.js'), path.join(__dirname, 'e2e-company-proxy-signer-init.js')];
  // Built from pieces so this test itself does not contain the words it looks for.
  const words = [['prod', 'szv'].join('-'), ['code', 'Agent', 'Pro'].join(''), ['w3', 'account'].join(''), ['c', 'ida'].join(''), ['dra', 'gon'].join('')];
  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const word of words) assert.ok(!body.includes(word.toLowerCase()), `${path.basename(file)} contains ${word}`);
  }
});

// ---------- DSH-style client: closes the connection as soon as it has read [DONE] ----------
// Upstream mimics fetch: aborting the request signal errors the body; a tee'd tap reads its own copy (like the
// acceptance tap), so an abort after a complete answer shows up there as a failed chat.
function lingeringUpstream({ frames, lingerMs = 400, signal }) {
  const enc = new TextEncoder();
  const info = { cancelledAt: 0, closedAt: 0, erroredByAbort: false, tapFailed: false, tapEnded: false };
  let timer;
  const source = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      timer = setTimeout(() => { try { c.close(); info.closedAt = Date.now(); } catch { /* already gone */ } }, lingerMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); info.erroredByAbort = true; try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* done */ } }, { once: true });
    },
    cancel() { clearTimeout(timer); info.cancelledAt = Date.now(); },
  });
  const [forClient, forTap] = source.tee();
  (async () => { const r = forTap.getReader(); try { for (;;) { const { done } = await r.read(); if (done) break; } info.tapEnded = true; } catch { info.tapFailed = true; } })();
  return { response: new Response(forClient, { status: 200, headers: { 'content-type': 'text/event-stream' } }), info, source };
}
const chatFrame = obj => `data: ${JSON.stringify(obj)}\n\n`;

// The proxy sees a plain fetch Response; the tap holds the other tee branch. Without a tap we cancel the
// source directly to check that the proxy really lets go of the upstream body.
async function dshClientRun({ frames, lingerMs = 3000, closeAfter, adapters, tap = true }) {
  const { createProxy } = await load('transport.mjs');
  const http = require('node:http');
  const key = 'd'.repeat(32), events = [];
  let up;
  const complete = async (body, { signal }) => {
    if (tap) { up = lingeringUpstream({ frames, lingerMs, signal }); return up.response; }
    const enc = new TextEncoder(); const info = { cancelledAt: 0, closedAt: 0, erroredByAbort: false };
    let timer;
    const stream = new ReadableStream({
      start(c) { for (const f of frames) c.enqueue(enc.encode(f)); timer = setTimeout(() => { try { c.close(); info.closedAt = Date.now(); } catch { /* gone */ } }, lingerMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); info.erroredByAbort = true; try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* done */ } }, { once: true }); },
      cancel() { clearTimeout(timer); info.cancelledAt = Date.now(); },
    });
    up = { info }; return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const proxy = createProxy({ provider: { listModels: async () => [], complete }, accessKey: key, onEvent: e => events.push(e), protocolAdapters: adapters || {} });
  const { port } = await proxy.listen(0);
  try {
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client timeout')), 8000);
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, res => {
        let text = '';
        res.on('data', d => { text += d; if (closeAfter && closeAfter.test(text)) { clearTimeout(timer); req.destroy(); resolve({ text, closedAt: Date.now() }); } });
        res.on('end', () => { clearTimeout(timer); resolve({ text, closedAt: Date.now(), ended: true }); });
        res.on('error', () => {});
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ model: 'GLM-5.2-WX', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 2000 && !events.length) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 50));
    return { got, events, info: up.info };
  } finally { await proxy.close(); }
}

const finishedFrames = [chatFrame({ id: 'c', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: { content: 'marker-ok' }, finish_reason: null }] }),
  chatFrame({ id: 'c', model: 'GLM-5.2-WX', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'];

test('DSH: client closes right after [DONE] -> request_finished, upstream not aborted, upstream body released within 1s', { timeout: 30000 }, async () => {
  const { createDshAdapter } = await load('adapters.mjs');
  for (const adapters of [{}, { '/v1/chat/completions': createDshAdapter({ defaultModel: 'GLM-5.2-WX' }) }]) {
    for (const tap of [true, false]) {
      const { got, events, info } = await dshClientRun({ frames: finishedFrames, closeAfter: /data: \[DONE\]/, adapters, tap });
      assert.match(got.text, /marker-ok/);
      assert.deepEqual(events.map(e => e.type), ['request_finished'], 'a complete answer the client stopped reading is not an abort');
      assert.equal(events[0].clientClosedAfterDone, true);
      assert.equal(info.erroredByAbort, false, 'the upstream request signal is not aborted, so a tap sees no failure');
      if (tap) assert.equal(info.tapFailed, false);
      else {
        assert.ok(info.cancelledAt > 0, 'the proxy cancels its upstream body');
        assert.ok(info.cancelledAt - got.closedAt < 1000, `released within 1s (${info.cancelledAt - got.closedAt}ms)`);
      }
    }
  }
});

test('DSH: client leaves before [DONE], or [DONE] without a finish -> request_aborted, upstream request aborted', { timeout: 30000 }, async () => {
  const { createDshAdapter } = await load('adapters.mjs');
  for (const adapters of [{}, { '/v1/chat/completions': createDshAdapter({ defaultModel: 'GLM-5.2-WX' }) }]) {
    for (const [frames, closeAfter] of [[finishedFrames.slice(0, 1), /marker-ok/], [finishedFrames.slice(0, 2), /"stop"/], [[finishedFrames[0], 'data: [DONE]\n\n'], /\[DONE\]/]]) {
      const t0 = Date.now();
      const { events, info } = await dshClientRun({ frames, closeAfter, adapters });
      assert.deepEqual(events.map(e => e.type), ['request_aborted']);
      assert.equal(info.erroredByAbort, true, 'a real stop tears the upstream request down');
      assert.ok(Date.now() - t0 < 2500, 'without waiting for the upstream to finish');
    }
  }
});

test('DSH: client that reads to the end still gets request_finished; an upstream ending without [DONE] still fails', { timeout: 30000 }, async () => {
  const { createDshAdapter } = await load('adapters.mjs');
  for (const adapters of [{}, { '/v1/chat/completions': createDshAdapter({ defaultModel: 'GLM-5.2-WX' }) }]) {
    const { got, events, info } = await dshClientRun({ frames: finishedFrames, lingerMs: 30, adapters });
    assert.equal(got.ended, true); assert.match(got.text, /\[DONE\]/);
    assert.deepEqual(events.map(e => e.type), ['request_finished']);
    assert.equal(events[0].clientClosedAfterDone, undefined);
    assert.equal(info.tapEnded, true);
    const cut = await dshClientRun({ frames: finishedFrames.slice(0, 2), lingerMs: 30, adapters });
    assert.deepEqual(cut.events.map(e => e.type), ['request_failed']);
    assert.match(cut.got.text, /"error":\{"type":"upstream_error"/);
  }
});

test('router: an aborted request is not an account failure (no cooldown, no switch, no retry)', async () => {
  const { createAccountRouter } = await load('account-router.mjs');
  const ctrl = new AbortController(), used = [];
  const router = createAccountRouter({
    listAccounts: () => [{ id: 'aaaaaa1', kind: 'pool' }, { id: 'bbbbbb2', kind: 'pool' }],
    makeProvider: account => ({ complete: async () => { used.push(account.id); ctrl.abort(); throw Object.assign(new Error('aborted'), { code: 'L1_ABORTED', status: 499 }); } }),
  });
  await assert.rejects(router.complete({ model: 'GLM-5.2-WX' }, { signal: ctrl.signal, sessionTag: 's' }));
  const snap = router.snapshot();
  assert.deepEqual(used, ['aaaaaa1'], 'not retried on another account');
  assert.ok(snap.accounts.every(a => a.coolingUntil === null), 'no account cooled down');
  assert.equal(snap.events.length, 0);
});

test('proxy process (mock upstream keeps the stream open after [DONE]): a DSH client leaving after [DONE] is a normal end; leaving mid-answer is an abort without a switch', { timeout: 60000 }, async () => {
  const http = require('node:http');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-proxy-'));
  const key = 'z'.repeat(40);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1' }, { id: 'bbbbbb2' }] }));
  writeModels(dataDir, 'aaaaaa1', ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
  writeModels(dataDir, 'bbbbbb2', ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
  fs.mkdirSync(path.join(dataDir, 'company-model-proxy'), { recursive: true });
  const control = value => fs.writeFileSync(path.join(dataDir, 'company-model-proxy', 'mock-control.json'), JSON.stringify(value));
  control({ lingerAfterDoneMs: 5000 });
  const { child, port, log } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
  // Reads like pi-ai: stops at the pattern and closes the connection.
  const dshCall = (model, stopAt) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${key}.dshsess`, 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', d => { text += d; if (stopAt.test(text)) { req.destroy(); resolve({ text, at: Date.now() }); } });
      res.on('end', () => resolve({ text, at: Date.now(), ended: true }));
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    setTimeout(() => reject(new Error('client timeout')), 15000);
  });
  const waitFor = async (check, ms = 3000) => { const t0 = Date.now(); for (;;) { const s = await status(); if (check(s) || Date.now() - t0 > ms) return s; await new Promise(r => setTimeout(r, 25)); } };
  try {
    for (const model of ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']) {
      const before = (await status()).mockUpstream.chatClosedEarly || 0;
      const got = await dshCall(model, /data: \[DONE\]/);
      assert.match(got.text, /MOCK_OK/);
      const s = await waitFor(x => (x.mockUpstream.chatClosedEarly || 0) > before && x.stats.inFlight === 0);
      assert.equal((s.mockUpstream.chatClosedEarly || 0) - before, 1, 'the proxy lets go of the upstream stream instead of waiting 5s for its end');
      assert.equal(s.stats.inFlight, 0, 'the request slot is free again');
      assert.ok(Date.now() - got.at < 1500, 'released within about 1s');
    }
    let s = await status();
    assert.equal(s.stats.failed, 0);
    assert.doesNotMatch(log(), /request_aborted|request_failed/, 'two complete answers are not logged as aborted or failed');
    assert.ok(s.router.accounts.every(a => a.coolingUntil === null));
    const account = s.router.accounts.find(a => a.sessions > 0)?.id;
    // Real mid-answer stop (before [DONE]): logged as an abort, the same account keeps the session, no cooldown.
    control({ streamDelayMs: 3000 });
    await dshCall('GLM-5.2-WX', /MOCK_OK/);
    s = await waitFor(x => x.stats.inFlight === 0);
    await new Promise(r => setTimeout(r, 100));
    assert.match(log(), /proxy event request_aborted/);
    assert.equal(s.stats.inFlight, 0);
    assert.ok(s.router.accounts.every(a => a.coolingUntil === null), 'an abort cools no account');
    assert.equal(s.router.events.filter(e => e.type === 'switch' || e.type === 'credential_failed' || e.type === 'rate_limited').length, 0, 'and switches none');
    assert.equal(s.router.accounts.find(a => a.sessions > 0)?.id, account);
  } finally {
    await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }).catch(() => {});
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- Launch center model cards (renderer/launch-model-cards.js) ----------
test('model cards: two company models + the own source, status in plain words, remembered pick, save request', () => {
  const cards = require('../renderer/launch-model-cards.js');
  const models = [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }];
  const local = { backend: 'local', model: '', companyModels: models, own: { backend: 'local', model: '' } };
  const proxyDs = { backend: 'proxy', model: 'deepseek-v4.1-flash-1017', companyModels: models, models, own: { backend: 'api', model: 'my-model' } };
  // Remembered pick = the saved source and model.
  assert.deepEqual(cards.defaultPick('claude', local), { source: 'own', model: '' });
  assert.deepEqual(cards.defaultPick('codex', proxyDs), { source: 'company', model: 'deepseek-v4.1-flash-1017' });
  assert.deepEqual(cards.defaultPick('deepseek-acp', { backend: 'local', companyModels: models }), { source: 'company', model: 'GLM-5.2-WX' }, 'DSH only has company models');
  // Save only when the pick differs from what is saved.
  assert.deepEqual(cards.saveRequest('claude', local, { source: 'company', model: 'GLM-5.2-WX' }), { kind: 'claude', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.equal(cards.saveRequest('codex', proxyDs, { source: 'company', model: 'deepseek-v4.1-flash-1017' }), null);
  assert.deepEqual(cards.saveRequest('codex', proxyDs, { source: 'own', model: '' }), { kind: 'codex', backend: 'own' });
  assert.equal(cards.saveRequest('claude', local, { source: 'own', model: '' }), null);
  // Cards: company models with source and state; own card says CLI 默认 or 自有接口.
  const running = { state: 'running', accounts: [{ id: 'a1', kind: 'pool' }, { id: 'a2', kind: 'pool' }, { id: 'personal', kind: 'personal' }] };
  const list = cards.cardsFor('claude', local, running, { source: 'company', model: 'GLM-5.2-WX' });
  assert.deepEqual(list.map(c => [c.id, c.source, c.state, c.checked]), [['GLM-5.2-WX', 'company', 'ready', true], ['deepseek-v4.1-flash-1017', 'company', 'ready', false], ['own', 'own', 'ready', false]]);
  assert.equal(list[0].statusText, '可用 · 号池 2 个号'); assert.equal(list[2].sourceText, 'CLI 默认');
  assert.equal(cards.cardsFor('codex', proxyDs, running, null)[2].sourceText, '自有接口');
  assert.equal(cards.cardsFor('deepseek-acp', { companyModels: models }, running, null).length, 2);
  const html = cards.renderCards(list, x => String(x));
  assert.match(html, /role="radio" aria-checked="true"[^>]*data-model-card="GLM-5.2-WX" data-source="company" data-state="ready"/);
  // Reasons when not ready.
  const badge = (status, model) => cards.proxyBadge(status, model);
  assert.equal(badge(null).text, '选中后自动启动'); assert.equal(badge(null).state, 'idle');
  assert.equal(badge({ state: 'starting' }).text, '公司模型准备中');
  assert.equal(badge({ state: 'not-ready', code: 'INITIALIZING' }).text, '公司模型准备中');
  assert.equal(badge({ state: 'not-ready', code: 'ZONE_UNKNOWN', message: 'm' }).text, '需要选择区域');
  assert.equal(badge({ state: 'not-ready', code: 'SIGNER_INIT_TIMEOUT' }).state, 'needs');
  assert.equal(badge({ state: 'failed', message: 'x' }).state, 'error');
  assert.equal(badge({ state: 'running', accounts: [{ id: 'a1', kind: 'pool', coolingUntil: 9, coolingReason: 'credential' }, { id: 'personal', kind: 'personal', coolingUntil: 9, coolingReason: 'credential' }] }).text, '需要在 CodeAgent 登录');
  assert.equal(badge({ state: 'running', accounts: [{ id: 'a1', kind: 'pool', coolingUntil: 9, coolingReason: 'rate_limit' }, { id: 'personal', kind: 'personal', coolingUntil: 9, coolingReason: 'rate_limit' }] }).text, '号都在限流冷却');
  assert.equal(badge({ state: 'running', accounts: [{ id: 'a1', kind: 'pool', models: ['deepseek-v4.1-flash-1017'], modelsAuthoritative: true }, { id: 'personal', kind: 'personal' }] }, 'GLM-5.2-WX').text, '可用 · 个人号');
});

test('company API settings: picking company models keeps the own interface, the own card restores it; DSH has no own source', () => {
  const api = require('../core/company-api-config');
  let raw = { providers: { codex: { backend: 'api', base_url: 'https://own.example/v1', api_key: 'sk-own', model: 'own-1', wire_api: 'chat' } } };
  raw = api.withSettings(raw, { kind: 'codex', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.equal(raw.providers.codex.backend, 'proxy'); assert.equal(raw.providers.codex.base_url, undefined);
  assert.deepEqual(api.settings(raw).codex.own, { backend: 'api', model: 'own-1' });
  raw = api.withSettings(raw, { kind: 'codex', backend: 'proxy', model: 'deepseek-v4.1-flash-1017' });
  assert.equal(raw.providers.codex.own_api.api_key, 'sk-own', 'switching between company models keeps the own interface');
  raw = api.withSettings(raw, { kind: 'codex', backend: 'own' });
  assert.deepEqual([raw.providers.codex.backend, raw.providers.codex.base_url, raw.providers.codex.api_key, raw.providers.codex.model, raw.providers.codex.wire_api, raw.providers.codex.own_api],
    ['api', 'https://own.example/v1', 'sk-own', 'own-1', 'chat', undefined]);
  // No own interface before: back to CLI 默认.
  let r2 = api.withSettings({}, { kind: 'claude', backend: 'proxy', model: 'GLM-5.2-WX' });
  assert.deepEqual(api.settings(r2).claude.own, { backend: 'local', model: '' });
  r2 = api.withSettings(r2, { kind: 'claude', backend: 'own' });
  assert.equal(api.settings(r2).claude.backend, 'local');
  assert.equal(api.settings({}).claude.companyModels.length, 2, 'company models listed even before choosing them');
  assert.equal(api.settings({})['deepseek-acp'].own, null);
  assert.throws(() => api.withSettings({}, { kind: 'deepseek-acp', backend: 'own' }), /只能用公司模型/);
});

test('session card / title bar route: model, company model and the pool alias for the session tag', () => {
  const view = require('../renderer/company-route-view.js');
  const { sessionTag } = require('../core/company-model-proxy');
  for (const id of ['3f2a-77.b c', 'x'.repeat(80), '']) assert.equal(view.tagOf(id), sessionTag(id), 'same tag rule as the proxy key');
  const s = { id: 'sess-1', kind: 'codex', companyRoute: 'proxy', currentModel: { id: 'GLM-5.2-WX' } };
  assert.equal(view.routeInfo(s).text, 'GLM-5.2-WX · 公司模型');
  let fired = 0; view.onChange(() => fired++);
  assert.equal(view.updateStatus({ sessionAccounts: { 'sess-1': '号 2' } }), true); assert.equal(fired, 1);
  assert.equal(view.updateStatus({ sessionAccounts: { 'sess-1': '号 2' } }), false, 'unchanged status does not repaint');
  assert.equal(view.routeInfo(s).text, 'GLM-5.2-WX · 公司模型 · 号 2'); assert.equal(view.routeInfo(s).chip, 'GLM · 号 2');
  view.updateStatus({ sessionAccounts: { 'sess-1': '个人' } });
  assert.equal(view.routeInfo(s).text, 'GLM-5.2-WX · 公司模型 · 个人号');
  assert.equal(view.routeInfo({ ...s, companyRoute: 'api', currentModel: { id: 'own-1' } }).text, 'own-1 · 自有接口');
  assert.equal(view.routeInfo({ ...s, companyRoute: 'local', currentModel: null }).chip, '', 'CLI default needs no chip on the card');
  assert.equal(view.routeInfo({ ...s, kind: 'gemini' }), null);
});

test('proxy status names the account of each session by its alias, never by id', async () => {
  const { CompanyProxyService } = require('../main/company-proxy-service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-alias-'));
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'aaaaaa1' }, { id: 'bbbbbb2' }] }));
  try {
    const service = new CompanyProxyService({ dataDir, isEnabled: () => false });
    assert.deepEqual(service.sessionAccounts({ s1: 'bbbbbb2', s2: 'personal', s3: 'aaaaaa1' }), { s1: '号 2', s2: '个人', s3: '号 1' });
    assert.deepEqual(service.sessionAccounts(null), {});
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
