'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../core/company-api-config');
const policy = require('../core/company-ai-policy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('company defaults apply only to tools without prior sessions, including resumed sessions', t => {
  const state = { sessions: [] };
  t.mock.method(require('../core/state-store'), 'load', () => state);
  const cards = require('../renderer/launch-model-cards');
  for (const kind of ['claude', 'codex']) {
    const otherKind = kind === 'claude' ? 'codex' : 'claude';
    for (const savedKind of [kind, `${kind}-resume`]) {
      state.sessions = [{ kind: savedKind }];
      const view = api.settings({});
      assert.equal(view[kind].companyDefault, false);
      const pick = cards.defaultPick(kind, view[kind]);
      assert.equal(pick.source, 'own');
      assert.equal(cards.saveRequest(kind, view[kind], pick), null);
      assert.equal(view[otherKind].companyDefault, api.isCompany());
      const saved = api.withSettings({}, { kind, backend: 'proxy', model: 'GLM-5.2-WX' });
      assert.equal(cards.defaultPick(kind, api.settings(saved)[kind]).source, 'company');
    }
  }
});

test('external single-session tools do not become company dream or group runtimes', () => {
  for (const kind of [...api.KINDS, 'powershell']) {
    assert.doesNotThrow(() => policy.assertKind(kind));
    assert.equal(policy.taskKindAllowed(kind), false);
    assert.equal(policy.taskKindAllowed(kind + '-resume'), false);
    assert.throws(() => policy.assertTaskKind(kind), /只使用 CodeAgent/);
  }
  for (const kind of ['codeagent', 'codeagent-resume']) {
    assert.equal(policy.taskKindAllowed(kind), true);
    assert.doesNotThrow(() => policy.assertTaskKind(kind));
  }
  assert.deepEqual(require('../renderer/memory-panel').dreamKinds(), ['codeagent']);
});

test('dream backend rejects company external runtimes before accessing source history or creating a job', async () => {
  const { HubMemoryService } = require('../core/hub-memory-service');
  let reads = 0;
  const service = { sourceFor: async () => { reads++; throw Error('reached-source'); } };
  for (const kind of [...api.KINDS, 'codex-resume', 'claude-resume']) {
    await assert.rejects(HubMemoryService.prototype.start.call(service, { kind }), /只使用 CodeAgent/);
  }
  assert.equal(reads, 0);
  for (const request of [{ kind: 'codeagent' }, {}]) {
    await assert.rejects(HubMemoryService.prototype.start.call(service, request), /reached-source/);
  }
  assert.equal(reads, 2);
});

function meetingBoundary() {
  const handlers = new Map();
  let lookups = 0, auth = 0;
  const internal = require('../main/ipc/meeting-create-handlers').registerMeetingCreateIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    meetingManager: { getMeeting() { lookups++; throw Error('reached-meeting'); } },
    ensureLaunchAuth: async () => { auth++; throw Error('reached-auth'); },
  });
  return { handlers, internal, calls: () => ({ lookups, auth }) };
}

test('new company groups reject external slots and slotSpecs before any account or session work', async () => {
  const fixture = meetingBoundary();
  for (const kind of api.KINDS) {
    for (const field of ['slots', 'slotSpecs']) {
      await assert.rejects(fixture.handlers.get('create-meeting')(null, { [field]: [{ kind: 'codeagent' }, { kind }] }), /只使用 CodeAgent/);
    }
  }
  assert.deepEqual(fixture.calls(), { lookups: 0, auth: 0 });
  await assert.rejects(fixture.handlers.get('create-meeting')(null, { slots: [{ kind: 'codeagent' }] }), /reached-auth/);
});

test('adding a company group member is blocked at IPC and the shared internal entry', async () => {
  const fixture = meetingBoundary();
  for (const kind of [...api.KINDS, 'codex-resume', 'claude-resume']) {
    await assert.rejects(fixture.handlers.get('add-meeting-sub')(null, { meetingId: 'existing-group', kind }), /只使用 CodeAgent/);
    await assert.rejects(fixture.internal.addMeetingSubInternal('existing-group', kind), /只使用 CodeAgent/);
  }
  assert.deepEqual(fixture.calls(), { lookups: 0, auth: 0 });
  await assert.rejects(fixture.handlers.get('add-meeting-sub')(null, { meetingId: 'existing-group', kind: 'codeagent' }), /reached-meeting/);
  assert.deepEqual(fixture.calls(), { lookups: 1, auth: 0 });
});

test('non-company policy keeps allowed external dream and group runtimes', () => {
  const vm = require('node:vm');
  const module = { exports: {} };
  const file = path.resolve(__dirname, '../core/company-ai-policy.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
    require: name => { assert.equal(name, './distribution'); return { target: null, kindAllowed: () => true }; } });
  for (const kind of ['claude', 'codex', 'deepseek-acp', 'powershell']) {
    assert.equal(module.exports.taskKindAllowed(kind), true);
    assert.doesNotThrow(() => module.exports.assertTaskKind(kind));
  }
  const kinds = require('../renderer/memory-panel').dreamKinds(module.exports.taskKindAllowed);
  assert.equal(kinds[0], 'codex'); assert.ok(kinds.includes('claude'));
});

function sessionHelpers() {
  // Use the real profile/environment builders without starting a terminal or
  // loading Electron's native PTY binary into the Node test runner.
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'node-pty') return { spawn() { throw new Error('Unit tests cannot launch a PTY'); } };
    return original.call(this, id, ...args);
  };
  try { return require('../core/session-manager')._private; }
  finally { Module._load = original; }
}

test('distribution allows the three external tools and resume kinds without enabling account or quota pages', () => {
  const distribution = require('../core/distribution');
  for (const kind of [...api.KINDS, 'codeagent', 'powershell']) {
    assert.doesNotThrow(() => policy.assertKind(kind));
    assert.doesNotThrow(() => policy.assertKind(kind + '-resume'));
  }
  assert.throws(() => policy.assertKind('gemini'), /不支持/);
  assert.equal(distribution.featureEnabled('accounts'), false);
  assert.equal(distribution.featureEnabled('quotaBar'), false);
  assert.deepEqual(require('../core/ai-kinds').GROUP_MEMBER_KINDS, ['codeagent']);
});
const request = (kind, extra = {}) => ({ kind, baseURL: 'https://api.example.test/v1/', apiKey: 'fixture-api-key', model: 'company/model-1', ...extra });
test('saving API settings preserves unrelated configuration and never returns a credential', () => {
  const original = { ui: { card_font_size: 16 }, providers: { codex: { subscription_profile: 'local-user' } } };
  const next = api.withSettings(original, request('claude'));
  assert.deepEqual(next.ui, original.ui);
  assert.deepEqual(next.providers.codex, original.providers.codex);
  assert.equal(original.providers.claude, undefined);
  assert.equal(next.providers.claude.backend, 'api');
  assert.equal(next.providers.claude.base_url, 'https://api.example.test/v1');
  const view = api.settings(next);
  assert.equal(view.claude.apiKeySet, true);
  assert.equal(JSON.stringify(view).includes('fixture-api-key'), false);
});
test('blank key preserves a saved key and a new empty form uses the installed CLI', () => {
  const saved = api.withSettings({}, request('claude'));
  const next = api.withSettings(saved, request('claude', { apiKey: '', model: 'different-model' }));
  assert.equal(next.providers.claude.api_key, 'fixture-api-key');
  assert.equal(api.withSettings({}, request('claude', { apiKey: '' })).providers.claude.api_key, '');
  const local = api.withSettings(saved, { kind: 'claude', useLocal: true });
  const { companyModels, own, companyDefault, ...connection } = api.settings(local).claude;
  assert.deepEqual(connection, { backend: 'local', baseURL: '', apiKeySet: false, model: '' });
  assert.deepEqual(own, { backend: 'local', model: '' }); // launch center: the own-source card
  assert.equal(companyModels.length, 2);
});
test('Codex protocol defaults to responses and explicitly accepts chat', () => {
  assert.equal(api.withSettings({}, request('codex')).providers.codex.wire_api, 'responses');
  const chat = api.withSettings({}, request('codex', { wireApi: 'chat' }));
  assert.equal(api.settings(chat).codex.wireApi, 'chat');
  assert.throws(() => api.withSettings({}, request('codex', { wireApi: 'other' })), /协议/);
});
test('company runtime uses only its saved API connection, even if old settings say subscription', () => {
  const raw = api.withSettings({}, request('claude'));
  const config = api.applyCompanyConfig({ claudeBackend: 'subscription', codexBackend: 'subscription',
    codexApiKey: 'inherited-fixture', proxy: 'http://localhost:1234', claudeSubscriptionProfiles: [{ id: 'old' }] }, raw);
  assert.equal(config.claudeBackend, 'api');
  assert.equal(config.codexBackend, 'local');
  assert.equal(config.codexApiKey, '');
  assert.equal(config.proxy, '');
  assert.deepEqual(config.claudeSubscriptionProfiles, []);
  assert.doesNotThrow(() => api.assertLaunchConfigured('claude-resume', config));
  assert.doesNotThrow(() => api.assertLaunchConfigured('codex', config));
  assert.doesNotThrow(() => api.assertLaunchConfigured('codeagent', config));
});
test('incomplete or invalid input cannot select a fallback or embed credentials into the URL', () => {
  for (const baseURL of ['file:///tmp/config', 'https://user:password@example.test/v1', 'https://example.test/#key']) {
    assert.throws(() => api.withSettings({}, request('claude', { baseURL })));
  }
  assert.throws(() => api.withSettings({}, request('claude', { model: 'bad\nmodel' })), /模型/);
  assert.throws(() => api.withSettings({}, request('gemini')), /不支持/);
});

test('company Claude leaves all native settings untouched when blank and only injects supplied fields', () => {
  const { applyClaudeSessionEnv, resolveClaudeLaunchModel } = sessionHelpers();
  const env = { CLAUDE_CONFIG_DIR: 'fixture-native-home', CLAUDE_CODE_OAUTH_TOKEN: 'native-fixture',
    ANTHROPIC_BASE_URL: 'https://native.example.test', HTTPS_PROXY: 'http://localhost:1234' };
  const copy = { ...env };
  applyClaudeSessionEnv(copy, { COMPANY_CLI: true, CLAUDE_BACKEND: 'local' });
  assert.deepEqual(copy, env);
  assert.equal(resolveClaudeLaunchModel({ COMPANY_CLI: true }, undefined), '');
  applyClaudeSessionEnv(copy, { COMPANY_CLI: true, CLAUDE_API_MODEL: 'Own/Model-V1' });
  assert.deepEqual(copy, { ...env, ANTHROPIC_MODEL: 'Own/Model-V1' });
  assert.doesNotThrow(() => api.withSettings({}, { kind: 'claude', model: 'Own/Model-V1' }));
  const { LaunchAuth } = require('../core/launch-auth');
  const auth = new LaunchAuth({ getConfig: () => ({ companyCli: true }), accounts: {} });
  assert.equal(auth.connection('claude'), null);
  assert.equal(auth.connection('codex-resume'), null);
});

test('company Codex model survives the launch and restored-session builders without a subscription default', () => {
  const { resolveCodexLaunchModel, quotePowerShellLiteral } = sessionHelpers();
  const cv = { COMPANY_CLI: true, CODEX_BACKEND: 'api', CODEX_API_MODEL: 'Company/Model-V1' };
  assert.equal(resolveCodexLaunchModel(cv), cv.CODEX_API_MODEL);
  assert.equal(resolveCodexLaunchModel(cv, 'Own.V2'), 'Own.V2');
  assert.equal(resolveCodexLaunchModel({ COMPANY_CLI: true, CODEX_BACKEND: 'local' }), '');
  const { sessionModelId } = require('../core/session-capabilities');
  assert.equal(sessionModelId({ kind: 'codex', currentModel: { id: cv.CODEX_API_MODEL },
    codexSessionsRoot: 'D:/fixture/codex-api-profile/sessions' }), cv.CODEX_API_MODEL);
  assert.equal(quotePowerShellLiteral("model'; value"), "'model''; value'");
});
test('DSH form data is separate from the token-plan credential while its runtime integration is pending', () => {
  const raw = { acp: { apiKey: 'existing-plan-fixture', providers: { 'deepseek-acp': { cliRoot: 'fixture-runtime' } } } };
  const next = api.withSettings(raw, request('deepseek-acp'));
  assert.equal(next.acp.apiKey, 'existing-plan-fixture');
  assert.deepEqual(next.acp.providers, raw.acp.providers);
  assert.equal(next.acp.companyApi.apiKey, 'fixture-api-key');
  assert.equal(api.settings(next)['deepseek-acp'].apiKeySet, true);
  assert.throws(() => api.assertLaunchConfigured('deepseek-acp', { acp: next.acp }), /公司模型/);
});

test('Claude launch applies the selected API endpoint and token without inherited API or proxy credentials', () => {
  const { applyClaudeSessionEnv } = sessionHelpers();
  const env = { PATH: 'fixture-path', ANTHROPIC_API_KEY: 'old-fixture', ANTHROPIC_BASE_URL: 'https://old.example.test',
    ANTHROPIC_API_BASE_URL: 'https://old.example.test', HTTPS_PROXY: 'http://localhost:1234',
    CLAUDE_CODE_OAUTH_TOKEN: 'old-subscription-fixture', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '7',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'old-session-fixture' };
  const mode = applyClaudeSessionEnv(env, { CLAUDE_BACKEND: 'api', CLAUDE_API_KEY: 'fixture-api-key',
    CLAUDE_API_BASE_URL: 'https://api.example.test/anthropic' });
  assert.equal(mode, 'api');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.example.test/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'fixture-api-key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_BASE_URL, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ACCESS_TOKEN, undefined);
  assert.equal(env.PATH, 'fixture-path');
});

test('real Codex API profile writer persists both protocols and keeps native history settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-external-api-profile-'));
  const old = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  t.after(() => {
    if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old;
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('hub-external-api-profile-')) throw new Error('Unexpected fixture directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const { ensureCodexApiProfile } = sessionHelpers();
  const cv = { CODEX_API_KEY: 'fixture-codex-key', CODEX_API_BASE_URL: 'https://api.example.test/v1',
    CODEX_API_MODEL: 'company-model', CODEX_API_PROVIDER: 'openai-api' };
  const home = ensureCodexApiProfile(cv, path.join(root, 'work'));
  assert.equal(home, path.join(root, 'codex-api-profile'));
  const file = path.join(home, 'config.toml');
  assert.match(fs.readFileSync(file, 'utf8'), /wire_api = "responses"/);
  fs.appendFileSync(file, '\n[tui]\nnotifications = false\n');
  ensureCodexApiProfile({ ...cv, CODEX_API_WIRE_API: 'chat' }, path.join(root, 'work'));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /wire_api = "chat"/);
  assert.match(content, /base_url = "https:\/\/api\.example\.test\/v1"/);
  assert.match(content, /model = "company-model"/);
  assert.match(content, /\[tui\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, cv.CODEX_API_KEY);
  assert.throws(() => ensureCodexApiProfile({ ...cv, CODEX_API_WIRE_API: 'invalid' }, root), /协议/);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});
