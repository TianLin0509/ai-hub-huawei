'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const connection = require('../core/claude-connection-settings');
const { prepareClaudeSettingsOverlay } = require('../core/claude-native-launch');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-connection-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project', 'child');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(home, 'settings.json');
  const original = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://old.example.test', ANTHROPIC_AUTH_TOKEN: 'old-secret',
    ANTHROPIC_MODEL: 'old-model', CLAUDE_CODE_USE_VERTEX: '1', EDITOR: 'keep' }, hooks: {}, theme: 'dark' });
  fs.writeFileSync(file, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, file, original, env: { CLAUDE_CONFIG_DIR: home, USERPROFILE: root,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345', ANTHROPIC_AUTH_TOKEN: 'hub-secret', ANTHROPIC_MODEL: 'hub-model' } };
}
const values = { COMPANY_CLI: true, CLAUDE_BACKEND: 'proxy' };

test('explicit Hub connection overrides settings env while retaining unrelated user settings and original bytes', t => {
  const f = fixture(t);
  const result = connection.connectionSettings({ values, env: f.env, cwd: f.cwd, model: 'selected-model' });
  const overlayFile = prepareClaudeSettingsOverlay([], { directory: path.join(f.root, 'overlays'), sessionId: 'session-a', overrides: { env: result.env } });
  const overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
  const effective = { ...JSON.parse(f.original).env, ...overlay.env };
  assert.equal(effective.ANTHROPIC_BASE_URL, f.env.ANTHROPIC_BASE_URL);
  assert.equal(effective.ANTHROPIC_AUTH_TOKEN, 'hub-secret');
  assert.equal(effective.ANTHROPIC_MODEL, 'selected-model');
  assert.equal(effective.CLAUDE_CODE_USE_VERTEX, '');
  assert.equal(effective.ANTHROPIC_API_KEY, '');
  assert.equal(effective.EDITOR, 'keep');
  assert.match(result.notice, /ANTHROPIC_BASE_URL/);
  assert.match(result.notice, /原配置文件未修改/);
  assert.doesNotMatch(result.notice, /old-secret|hub-secret|https?:/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('project and parent local settings conflicts are detected; only Hub-selected API connections change', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'project', '.claude'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'settings.local.json'), '\ufeff' + JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-small' } }));
  assert.match(connection.connectionSettings({ values, env: f.env, cwd: f.cwd }).notice, /ANTHROPIC_DEFAULT_HAIKU_MODEL/);
  for (const local of [{}, { COMPANY_CLI: true, CLAUDE_BACKEND: 'local' }, { CLAUDE_BACKEND: 'subscription' }]) {
    assert.deepEqual(connection.connectionSettings({ values: local, env: f.env, cwd: f.cwd }), { env: null, notice: '' });
  }
  assert.equal(connection.connectionSettings({ values: { CLAUDE_BACKEND: 'api', CLAUDE_API_KEY: 'fixture' }, env: f.env }).env.ANTHROPIC_AUTH_TOKEN, 'hub-secret');
  assert.equal(connection.connectionEnv(values, { ...f.env, CLAUDE_CODE_USE_VERTEX: '1' }).CLAUDE_CODE_USE_VERTEX, '');
  for (const key of connection.PROVIDER_KEYS) {
    const overlay = connection.connectionEnv(values, { ...f.env, [key]: '1' });
    assert.equal(overlay[key], '', key);
  }
});

test('partial local CLI settings preserve the login and endpoint fields that Hub did not configure', t => {
  const f = fixture(t);
  const endpoint = connection.connectionSettings({ values: { COMPANY_CLI: true, CLAUDE_BACKEND: 'local', CLAUDE_API_BASE_URL: 'https://selected.example.test' },
    env: { CLAUDE_CONFIG_DIR: f.home, ANTHROPIC_BASE_URL: 'https://selected.example.test' } });
  assert.equal(endpoint.env.ANTHROPIC_BASE_URL, 'https://selected.example.test');
  assert.equal(Object.hasOwn(endpoint.env, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(Object.hasOwn(endpoint.env, 'ANTHROPIC_API_KEY'), false);
  assert.equal({ ...JSON.parse(f.original).env, ...endpoint.env }.ANTHROPIC_AUTH_TOKEN, 'old-secret');
  assert.doesNotMatch(endpoint.notice, /ANTHROPIC_AUTH_TOKEN/);
  const token = connection.connectionEnv({ COMPANY_CLI: true, CLAUDE_BACKEND: 'local', CLAUDE_API_KEY: 'selected-token' }, {});
  assert.equal(Object.hasOwn(token, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(token.ANTHROPIC_AUTH_TOKEN, 'selected-token');
});

test('real PTY launch has one merged settings overlay and a safe conflict notice for new/resume/fork and rooms', t => {
  const f = fixture(t), load = Module._load;
  Module._load = function (id, ...args) { return id === 'node-pty' ? { spawn() { throw Error('No PTY'); } } : load.call(this, id, ...args); };
  let helpers;
  try { helpers = require('../core/session-manager')._private; } finally { Module._load = load; }
  const prior = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = f.root;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior; });
  for (const extra of [{}, { resumeCCSessionId: 'history-id' }, { forkCCSessionId: '3a432daf-7436-4531-a823-123456789abc' }, { meetingId: 'room', autonomous: true }]) {
    const launch = helpers.buildClaudePtyLaunch('fixture', 'claude', { model: 'hub-model', fastMode: false, mcpProfile: 'full', ...extra }, f.cwd, f.env, values);
    assert.equal((launch.cmd.match(/--settings /g) || []).length, 1);
    const file = /--settings (?:'([^']+)'|([^\s]+))/.exec(launch.cmd);
    assert.ok(file, launch.cmd);
    const settings = JSON.parse(fs.readFileSync(file[1] || file[2], 'utf8'));
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'hub-secret');
    assert.equal(settings.env.ANTHROPIC_BASE_URL, f.env.ANTHROPIC_BASE_URL);
    assert.equal(settings.fastMode, false);
    assert.match(launch.connectionNotice, /连接设置与 Hub 冲突/);
    assert.doesNotMatch(launch.cmd, /hub-secret/);
    if (extra.meetingId) assert.equal(settings.enabledPlugins['superpowers@claude-plugins-official'], false);
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  const native = helpers.createNativeClaudeDriver('native-fixture', 'claude', {
    model: 'hub-model', lazyStart: true, fastMode: false, mcpProfile: 'full', claudeConnectionValues: values,
  }, f.cwd, f.env, false);
  const nativeSettings = JSON.parse(fs.readFileSync(native.options.settingsFile, 'utf8'));
  assert.equal(nativeSettings.env.ANTHROPIC_AUTH_TOKEN, 'hub-secret');
  assert.equal(nativeSettings.env.ANTHROPIC_BASE_URL, f.env.ANTHROPIC_BASE_URL);
  assert.match(native.claudeConnectionNotice, /连接设置与 Hub 冲突/);
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '--model <id>\n--effort <level>');
  assert.throws(() => helpers.buildClaudePtyLaunch('unsupported', 'claude', { model: 'hub-model', fastMode: false, mcpProfile: 'full' }, f.cwd, f.env, values),
    { code: 'CLAUDE_CONNECTION_SETTINGS_UNSUPPORTED' });
  assert.throws(() => helpers.createNativeClaudeDriver('unsupported', 'claude', {
    model: 'hub-model', lazyStart: true, claudeConnectionValues: values, mcpProfile: 'full',
  }, f.cwd, f.env, false), { code: 'CLAUDE_CONNECTION_SETTINGS_UNSUPPORTED' });
});

test('relaunch reconstructs the selected Hub connection when the PTY no longer exposes its environment', t => {
  const f = fixture(t), prior = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = f.root;
  const config = require('../core/hub-config'), managerModule = require('../core/session-manager');
  config.clearConfigCache(); managerModule.clearSessionManagerConfigCache();
  Object.assign(config.getConfig(), { companyCli: true, claudeBackend: 'local', claudeApiBaseUrl: 'https://fixture.example.test',
    claudeApiKey: 'selected-fixture-token', claudeApiModel: 'selected-model' });
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior;
    config.clearConfigCache(); managerModule.clearSessionManagerConfigCache(); });
  const manager = Object.create(managerModule.SessionManager.prototype), commands = [], notices = [];
  manager.sessions = new Map([['relaunch', { info: { id: 'relaunch', kind: 'claude', currentModel: { id: 'selected-model' },
    fastMode: false, mcpProfile: 'full', cwd: f.cwd, claudeConfigDir: f.home, autonomous: true },
    pty: { write: cmd => commands.push(cmd) } }]]);
  manager.emit = (event, payload) => { if (event === 'session-notice') notices.push(payload); };
  manager.hubRulesSystemPrompt = () => null;
  assert.equal(manager.relaunchCli('relaunch'), true);
  assert.equal((commands[0].match(/--settings /g) || []).length, 1);
  const file = /--settings '([^']+)'/.exec(commands[0]); assert.ok(file);
  const settings = JSON.parse(fs.readFileSync(file[1], 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'selected-fixture-token');
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://fixture.example.test');
  assert.equal(settings.enabledPlugins['superpowers@claude-plugins-official'], false);
  assert.equal(settings.fastMode, false);
  assert.ok(notices.some(n => /连接设置与 Hub 冲突/.test(n.message)));
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('Hub-connected assistant relaunch retains standard settings when fastMode is unspecified', t => {
  const f = fixture(t), prior = process.env.CLAUDE_HUB_DATA_DIR, noFast = process.env.CLAUDE_HUB_NO_FAST;
  process.env.CLAUDE_HUB_DATA_DIR = f.root;
  delete process.env.CLAUDE_HUB_NO_FAST;
  const config = require('../core/hub-config'), load = Module._load;
  Module._load = function (id, ...args) { return id === 'node-pty' ? { spawn() { throw Error('No PTY'); } } : load.call(this, id, ...args); };
  let managerModule;
  try { managerModule = require('../core/session-manager'); } finally { Module._load = load; }
  config.clearConfigCache(); managerModule.clearSessionManagerConfigCache();
  t.after(() => {
    if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior;
    if (noFast === undefined) delete process.env.CLAUDE_HUB_NO_FAST; else process.env.CLAUDE_HUB_NO_FAST = noFast;
    config.clearConfigCache(); managerModule.clearSessionManagerConfigCache();
  });
  Object.assign(config.getConfig(), { companyCli: true, claudeBackend: 'local', claudeApiBaseUrl: 'https://fixture.example.test',
    claudeApiKey: 'selected-fixture-token' });
  for (const purpose of ['hub-assistant', 'hub-photo-assistant']) {
    for (const fastMode of [undefined, false, true]) {
      const commands = [];
      const info = { kind: 'claude', purpose, autonomous: true, fastMode, mcpProfile: 'full',
        currentModel: { id: 'hub-model' }, cwd: f.cwd, claudeConfigDir: f.home };
      const manager = Object.create(managerModule.SessionManager.prototype);
      manager.sessions = new Map([['assistant-fixture', { info, pty: { write: cmd => commands.push(cmd) } }]]);
      manager.emit = () => {};
      manager.hubRulesSystemPrompt = () => null;
      assert.equal(manager.relaunchCli('assistant-fixture'), true);
      assert.equal((commands[0].match(/--settings /g) || []).length, 1);
      const file = /--settings '([^']+)'/.exec(commands[0]); assert.ok(file);
      const settings = JSON.parse(fs.readFileSync(file[1], 'utf8'));
      assert.equal(settings.fastMode, false, `${purpose}, fastMode=${fastMode}: autonomous assistants retain the existing standard-mode policy`);
      assert.equal(settings.skipDangerousModePermissionPrompt, true);
      assert.equal(settings.enabledPlugins['superpowers@claude-plugins-official'], false);
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'selected-fixture-token');
    }
  }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});
