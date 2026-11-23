'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const secrets = require('../core/own-api-secrets');
const safe = require('./helpers/fake-safe-storage');
const config = require('../core/hub-config');
const api = require('../core/company-api-config');
const profiles = require('../core/cli-api-profiles');
test.beforeEach(t => {
  t.mock.method(secrets, 'safeStorage', () => safe);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-key-dpapi-'));
  const previous = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  config.clearConfigCache();
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous;
    config.clearConfigCache(); fs.rmSync(root, { recursive: true, force: true });
  });
});
function legacy() {
  return { ui: { keep: 42 }, providers: {
    claude: { backend: 'api', base_url: 'https://claude.example.test', api_key: 'fixture-claude', model: 'claude-model' },
    codex: { backend: 'proxy', model: 'GLM-5.2-WX', selected_api_profile: 'two',
      own_api: { base_url: 'https://two.example.test', api_key: 'fixture-two', model: 'two-model' },
      api_profiles: ['one', 'two'].map(id => ({ id, label: id, baseURL: `https://${id}.example.test`, apiKey: 'fixture-' + id, model: id + '-model' })) },
  }, acp: { apiKey: 'unrelated-plan', companyApi: { baseURL: 'https://dsh.example.test', apiKey: 'fixture-dsh', model: 'dsh-model',
    own_api: { api_key: 'fixture-stash' } } } };
}
function assertEncryptedDisk(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /fixture-|"api_key"|"apiKey"\s*:\s*"fixture/);
  assert.match(text, /encrypted_api_key|encryptedApiKey/);
}
test('读取旧配置迁移全部工具、多账号、切回备份，清理主文件及 .bak 的明文字段', () => {
  const file = config.getConfigPath();
  fs.writeFileSync(file, JSON.stringify(legacy()));
  fs.writeFileSync(file + '.bak', JSON.stringify(legacy()));
  const opened = config.readConfigJsonForUpdate();
  assert.equal(opened.providers.codex.api_profiles[0].apiKey, 'fixture-one');
  assert.equal(opened.acp.companyApi.apiKey, 'fixture-dsh');
  assertEncryptedDisk(file); assertEncryptedDisk(file + '.bak');
  assert.deepEqual(config.readConfigJsonForUpdate(), opened);
  assert.deepEqual(opened.ui, { keep: 42 });
  assert.equal(opened.acp.apiKey, 'unrelated-plan');
  assert.doesNotMatch(JSON.stringify(api.settings(opened)), /fixture-|encrypted/);
});
test('保存直接加密，空 Key 保留、切换及删除多账号互不串 Key', () => {
  config.saveConfig(legacy());
  let raw = config.readConfigJsonForUpdate();
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'select', profileId: 'one' });
  config.saveConfig(raw);
  raw = config.readConfigJsonForUpdate();
  assert.equal(raw.providers.codex.api_key, 'fixture-one');
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'save', profileId: 'one', label: 'renamed',
    baseURL: 'https://one.example.test', model: 'new-model', apiKey: '' });
  config.saveConfig(raw);
  assert.equal(config.readConfigJsonForUpdate().providers.codex.api_profiles[1].apiKey, 'fixture-two');
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'delete', profileId: 'one' });
  config.saveConfig(raw);
  assert.equal(config.readConfigJsonForUpdate().providers.codex.api_key, 'fixture-two');
  assertEncryptedDisk(config.getConfigPath()); assertEncryptedDisk(config.getConfigPath() + '.bak');
});
test('主配置损坏时从旧明文备份恢复，备份与修复后的主文件均迁移为密文', () => {
  const file = config.getConfigPath();
  fs.writeFileSync(file, '{broken');
  fs.writeFileSync(file + '.bak', '\uFEFF' + JSON.stringify(legacy()));
  const raw = config.readConfigJsonForUpdate();
  assert.equal(raw.providers.claude.api_key, 'fixture-claude');
  assert.deepEqual(raw.ui, { keep: 42 });
  assertEncryptedDisk(file); assertEncryptedDisk(file + '.bak');
});
test('密文解不开只标记对应账号，阻止启动与空保存，补 Key 后恢复且保留其他账号', () => {
  for (const encryptedApiKey of ['', null, 42]) {
    const broken = secrets.openSecret({ apiKey: 'fixture-stale', encryptedApiKey });
    assert.equal(broken.apiKey, '');
    assert.equal(broken.apiKeyNeedsInput, true);
  }
  const disk = secrets.sealConfig(legacy());
  disk.providers.codex.api_profiles[0].encryptedApiKey = 'invalid';
  disk.providers.claude.encrypted_api_key = 'invalid';
  fs.writeFileSync(config.getConfigPath(), JSON.stringify(disk));
  let raw = config.readConfigJsonForUpdate();
  const view = api.settings(raw);
  assert.equal(view.codex.apiProfiles[0].apiKeyNeedsInput, true);
  assert.equal(view.codex.apiProfiles[0].apiKeySet, false);
  assert.equal(view.codex.apiProfiles[1].apiKeySet, true);
  assert.equal(view.claude.apiKeyNeedsInput, true);
  const promoted = api.withSettings(raw, { kind: 'claude', profileAction: 'save', label: 'new', baseURL: 'https://new.example.test',
    model: 'new-model', apiKey: 'fixture-new' });
  assert.equal(api.settings(promoted).claude.apiProfiles.find(p => p.label === '原有接口').apiKeyNeedsInput, true);
  const cards = require('../renderer/launch-model-cards').cardsFor('codex', view.codex, null, null);
  assert.equal(cards.find(c => c.profileId === 'one').state, 'needs');
  assert.equal(cards.find(c => c.profileId === 'two').state, 'ready');
  assert.throws(() => api.assertLaunchConfigured('claude', api.applyCompanyConfig({}, raw)), /无法解密/);
  assert.throws(() => api.withSettings(raw, { kind: 'claude', baseURL: 'https://claude.example.test', model: 'model' }), /无法解密/);
  assert.throws(() => api.withSettings(raw, { kind: 'codex', profileAction: 'select', profileId: 'one' }), /无法解密/);
  config.saveConfig(raw); // 无关设置保存仍保留损坏密文，不能把账号悄悄清空。
  assert.equal(JSON.parse(fs.readFileSync(config.getConfigPath())).providers.claude.encrypted_api_key, 'invalid');
  raw = api.withSettings(raw, { kind: 'claude', baseURL: 'https://claude.example.test', model: 'model', apiKey: 'fixture-replacement' });
  config.saveConfig(raw);
  assert.equal(config.readConfigJsonForUpdate().providers.claude.api_key, 'fixture-replacement');
  assert.equal(api.settings(config.readConfigJsonForUpdate()).claude.apiKeyNeedsInput, undefined);
});
test('系统加密不可用时拒绝保存且保留原文件，不降级落明文', t => {
  config.saveConfig(legacy());
  const original = fs.readFileSync(config.getConfigPath(), 'utf8');
  t.mock.method(secrets, 'safeStorage', () => ({ isEncryptionAvailable: () => false }));
  assert.throws(() => config.saveConfig(legacy()), /加密不可用/);
  assert.equal(fs.readFileSync(config.getConfigPath(), 'utf8'), original);
});
test('损坏账号补 Key 后即时清除错误；删掉当前账号切到损坏账号时保留补填状态', () => {
  let raw = legacy();
  raw.providers.codex.backend = 'api';
  raw.providers.codex.api_profiles[0] = { ...raw.providers.codex.api_profiles[0], apiKey: '', encryptedApiKey: 'bad', apiKeyNeedsInput: true };
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'delete', profileId: 'two' });
  assert.equal(api.settings(raw).codex.apiKeyNeedsInput, true);
  raw = api.withSettings(raw, { kind: 'codex', profileAction: 'save', profileId: 'one', label: 'one',
    baseURL: 'https://one.example.test', model: 'one-model', apiKey: 'fixture-repaired' });
  assert.equal(api.settings(raw).codex.apiKeyNeedsInput, undefined);
  config.saveConfig(raw);
  assert.equal(config.readConfigJsonForUpdate().providers.codex.api_key, 'fixture-repaired');
});
test('DSH 解密失败、切到公司模型再切回时不丢密文，补 Key 后恢复', () => {
  const disk = secrets.sealConfig(legacy());
  disk.acp.companyApi.encryptedApiKey = 'bad';
  let raw = secrets.openConfig(disk);
  assert.equal(api.settings(raw)['deepseek-acp'].apiKeyNeedsInput, true);
  assert.throws(() => api.assertLaunchConfigured('deepseek-acp', api.applyCompanyConfig({}, raw)), /无法解密/);
  raw = api.withSettings(raw, { kind: 'deepseek-acp', backend: 'proxy', model: 'GLM-5.2-WX' });
  config.saveConfig(raw);
  raw = config.readConfigJsonForUpdate();
  assert.equal(api.settings(raw)['deepseek-acp'].ownConnection.baseURL, 'https://dsh.example.test');
  assert.throws(() => api.withSettings(raw, { kind: 'deepseek-acp', backend: 'own' }), /无法解密/);
  raw = api.withSettings(raw, { kind: 'deepseek-acp', baseURL: 'https://dsh.example.test', model: 'model', apiKey: 'fixture-repaired' });
  config.saveConfig(raw);
  assert.equal(config.readConfigJsonForUpdate().acp.companyApi.apiKey, 'fixture-repaired');
});
test('连接快照加密、旧明文按需迁移，重复启动版本稳定且原会话保持原账号', () => {
  const raw = legacy();
  raw.providers.codex.backend = 'api';
  const options = { raw, dataDir: path.dirname(config.getConfigPath()), values: {} };
  const launch = profiles.prepareLaunch('codex', {}, options);
  assertEncryptedDisk(path.join(launch.home, 'connection.json'));
  assert.equal(launch.values.CODEX_API_KEY, 'fixture-two');
  assert.equal(profiles.prepareLaunch('codex', {}, options).home, launch.home);
  for (let i = 0; i < 2; i++) {
    const reloaded = secrets.openConfig(secrets.sealConfig(raw));
    assert.equal(profiles.prepareLaunch('codex', {}, { ...options, raw: reloaded }).home, launch.home);
  }
  const file = path.join(launch.home, 'connection.json');
  fs.writeFileSync(file, JSON.stringify(launch.profile));
  raw.providers.codex.selected_api_profile = 'one';
  assert.equal(profiles.prepareLaunch('codex-resume', launch.meta, options).values.CODEX_API_KEY, 'fixture-two');
  assertEncryptedDisk(file);
  const broken = JSON.parse(fs.readFileSync(file)); broken.encryptedApiKey = 'bad';
  fs.writeFileSync(file, JSON.stringify(broken));
  assert.throws(() => profiles.prepareLaunch('codex-resume', launch.meta, options), /无法解密/);
  config.saveConfig(raw);
  const repaired = profiles.prepareLaunch('codex-resume', launch.meta, options);
  assert.equal(repaired.values.CODEX_API_KEY, 'fixture-two');
  assert.equal(repaired.home, launch.home);
  assertEncryptedDisk(file);
});

test('旧明文快照加密不可用仍恢复原账号，磁盘不改写且下一次读取能继续迁移', t => {
  const raw = legacy(); raw.providers.codex.backend = 'api';
  const options = { raw, dataDir: path.dirname(config.getConfigPath()), values: {} };
  const launch = profiles.prepareLaunch('codex', {}, options);
  const file = path.join(launch.home, 'connection.json');
  const previous = JSON.stringify(launch.profile);
  fs.writeFileSync(file, previous);
  const unavailable = t.mock.method(secrets, 'safeStorage', () => null);
  const resumed = profiles.prepareLaunch('codex-resume', { ...launch.meta, useResume: true }, options);
  assert.equal(resumed.values.CODEX_API_KEY, 'fixture-two');
  assert.equal(resumed.meta.cliApiProfileId, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  unavailable.mock.restore();
  assert.equal(profiles.readConnection('codex', launch.meta, options.dataDir).apiKey, 'fixture-two');
  assertEncryptedDisk(file);
});

test('旧明文快照写回失败仍恢复，错误不丢账号和 Key，下一次再迁移', t => {
  const raw = legacy(); raw.providers.codex.backend = 'api';
  const options = { raw, dataDir: path.dirname(config.getConfigPath()), values: {} };
  const launch = profiles.prepareLaunch('codex', {}, options);
  const file = path.join(launch.home, 'connection.json');
  const previous = JSON.stringify(launch.profile); fs.writeFileSync(file, previous);
  const write = require('../core/atomic-write');
  const failed = t.mock.method(write, 'writeFileAtomic', () => { throw Object.assign(new Error('read-only fixture'), { code: 'EPERM' }); });
  assert.equal(profiles.prepareLaunch('codex-resume', launch.meta, options).values.CODEX_API_KEY, 'fixture-two');
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  failed.mock.restore();
  profiles.readConnection('codex', launch.meta, options.dataDir);
  assertEncryptedDisk(file);
});

test('新快照加密不可用必须停止启动并给出下一步，不能创建明文快照', t => {
  t.mock.method(secrets, 'safeStorage', () => null);
  const raw = legacy(); raw.providers.codex.backend = 'api';
  const dir = path.dirname(config.getConfigPath());
  assert.throws(() => profiles.prepareLaunch('codex', {}, { raw, dataDir: dir, values: {} }), error => {
    assert.match(error.message, /系统密钥加密不可用.*已停止创建会话.*重新打开 Hub/);
    assert.doesNotMatch(error.message, /fixture-/);
    return true;
  });
  const root = path.join(dir, 'cli-api-profiles', 'codex', 'two');
  for (const revision of fs.readdirSync(root)) assert.deepEqual(fs.readdirSync(path.join(root, revision)), []);
});
