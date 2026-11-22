'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isSafeModelId, MAX_MODEL_ID_LENGTH } = require('../core/model-id');
const models = require('../core/codeagent-models');
const { isLocalCliModelId, readLocalCliModels } = require('../core/local-cli-models');
const { setPersonalModel } = require('../core/codeagent-personal-model');
const quota = require('../core/codeagent-quota');
const { buildArgs, sessionModel } = require('../main/ask-aside/service');
const { buildCodexSideArgs } = require('../core/ask-aside-codex');
const SID = '00000000-0000-4000-8000-000000000001';
const IDS = ['GLM-5.2-Auto(Volcano-MaaS)', 'GLM-5.3-Auto(Baidu-MaaS)',
  'provider/GLM-5.2:preview@v2+fast[1m]', 'G'.repeat(MAX_MODEL_ID_LENGTH)];
const BAD = ['', 'not a model', 'GLM-5.2 Auto', '--model', '../model',
  'GLM;whoami', 'GLM&whoami', 'GLM|whoami', 'GLM%PATH%', 'GLM`whoami',
  'GLM$(whoami)', 'GLM"x', "GLM'x", 'GLM\\x', 'GLM\n', '\rGLM', 'GLM\t',
  'GLM\0', 'GLM\x7f', 'G'.repeat(MAX_MODEL_ID_LENGTH + 1), null, {}, 42];
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const json = (dir, name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));

test('one model ID rule covers the union of supported characters and length without prose or shell syntax', () => {
  assert.equal(models.isSafeModelId, isSafeModelId, 'existing public API reexports the shared validator');
  for (const id of IDS) assert.equal(isSafeModelId(id), true, id);
  for (const id of BAD) assert.equal(isSafeModelId(id), false, JSON.stringify(id));
});

test('CodeAgent account catalog and fallback scanner preserve shared ID characters', t => {
  const dir = temp(t), id = 'GLM-5.2@preview+fast[1m]';
  json(dir, '.cac.json', { enterpriseModelOptionsCache: IDS.map(value => ({ value })) });
  assert.deepEqual(models.configuredModels(dir).models, IDS);
  const scanned = new Set();
  models.scanModelNamesInText(JSON.stringify({ modelOptions: [id, 'GLM-5.2;bad', 'not a model'] }), scanned);
  assert.deepEqual([...scanned], [id]);
});

for (const encoding of ['plain', 'base64', 'segments']) test(`codeagent-models decodes synthetic End-terminated options (${encoding})`, t => {
  const dir = temp(t), configDir = path.join(dir, '.cac');
  fs.mkdirSync(configDir);
  const ids = ['GLM-8.1-Test', 'deepseek-8.2-test'];
  const text = JSON.stringify(ids.map(value => ({ value, contextWindow: 128000 }))) + (encoding === 'plain' ? '\n End \n' : 'End');
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  const value = encoding === 'plain' ? text : encoding === 'base64' ? encode(text) : encode('SyntheticCache') + encode(text);
  json(configDir, '.cac.json', { enterpriseModelOptionsCache: ['MiniMax-8.0-Test'] });
  json(dir, '.cac.json', { enterpriseModelOptionsCacheV3_5: value });
  const read = models.configuredModels(configDir);
  assert.equal(read.authoritative, true);
  assert.deepEqual(read.models, ids);
  assert.equal(models.contextWindowFor(configDir, [ids[1]]).window, 128000);
});

for (const layout of ['same-file', 'home-file']) for (const malformed of ['truncated', 'unknown-tail', 'empty']) test(`codeagent-models malformed latest cache cannot make legacy options authoritative (${layout}, ${malformed})`, t => {
  const dir = temp(t), configDir = path.join(dir, '.cac');
  fs.mkdirSync(configDir);
  const old = { enterpriseModelOptionsCache: [{ value: 'GLM-8.0-Test', contextWindow: 96000 }] };
  const text = malformed === 'truncated' ? '[{"value":"deepseek-8.2-test"}'
    : malformed === 'unknown-tail' ? '[{"value":"deepseek-8.2-test"}]Unknown' : '[]';
  const broken = { enterpriseModelOptionsCacheV3_5: Buffer.from(text, 'utf8').toString('base64') };
  json(configDir, '.cac.json', layout === 'same-file' ? { ...old, ...broken } : old);
  if (layout === 'home-file') json(dir, '.cac.json', broken);
  const read = models.configuredModels(configDir);
  assert.equal(read.authoritative, false);
  assert.ok(read.models.includes('GLM-8.0-Test'), '旧缓存仍可用于非权威候选');
  assert.equal(models.contextWindowFor(configDir, ['GLM-8.0-Test']).window, null);
});

test('codeagent-models legacy-only valid options remain authoritative', t => {
  const dir = temp(t);
  json(dir, '.cac.json', { enterpriseModelOptionsCache: ['GLM-8.0-Test'] });
  assert.deepEqual(models.configuredModels(dir), { models: ['GLM-8.0-Test'], defaultModel: '', authoritative: true });
});

test('personal default model repair accepts shared IDs while retaining permission checks and backup behavior', t => {
  const dir = temp(t);
  json(dir, 'settings.json', { model: 'GLM-5.2', keep: { enabled: true } });
  json(dir, '.cac.json', { enterpriseModelOptionsCache: IDS.map(value => ({ value })) });
  for (const [index, model] of IDS.entries()) {
    const changed = setPersonalModel({ personalDir: dir, model, now: 1730000000000 + index });
    assert.equal(changed.after, model);
    assert.equal(changed.verifiedBy, 'enterprise');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))), { model, keep: { enabled: true } });
  }
  assert.throws(() => setPersonalModel({ personalDir: dir, model: 'GLM-99.9' }), { code: 'not-in-list' });
  assert.throws(() => setPersonalModel({ personalDir: dir, model: 'not a model' }), { code: 'bad-model' });
});

test('quota model-error extraction and custom capture validation use shared ID syntax', () => {
  const { rules, errors } = quota.loadRules();
  assert.deepEqual(errors, []);
  for (const model of IDS) for (const quote of ['"', '', '“']) {
    const found = quota.matchText(`API Error: 模型 ${quote}${model}${quote} 不存在或配置有误`, rules, 'transcript');
    assert.equal(found?.model, model);
  }
  const custom = quota.compileRule({ id: 'test-model', kind: 'model-config', where: ['transcript'], pattern: 'MODEL=(.*)' }).rule;
  assert.equal(quota.matchText('MODEL=not a model', [custom], 'transcript').model, '');
});

test('local CLI catalog shares ID syntax while still rejecting non-conversation models', t => {
  const dir = temp(t);
  json(dir, 'settings.json', { model: IDS[0] });
  json(dir, '.claude.json', { additionalModelOptionsCache: [...IDS, ...BAD, 'gpt-image-gen2'].map(value => ({ value })) });
  assert.deepEqual(readLocalCliModels('claude', { configDir: dir, env: {} }).models.map(item => item.id), IDS);
  for (const id of IDS) assert.equal(isLocalCliModelId(id), true);
  for (const id of [...BAD, 'gpt-image-gen2']) assert.equal(isLocalCliModelId(id), false);
});

test('ask-aside model selection and both CLI argument builders preserve supported IDs as one argument', () => {
  for (const model of IDS) {
    assert.equal(sessionModel({ currentModel: { id: model } }), model);
    const args = buildArgs(SID, { model });
    assert.equal(args[args.indexOf('--model') + 1], model);
    const codex = buildCodexSideArgs({ session: { codexSid: SID, currentModel: { id: model } }, outputFile: 'answer.txt' });
    assert.equal(codex[codex.indexOf('-m') + 1], model);
  }
  for (const model of BAD) assert.equal(buildArgs(SID, { model }).includes('--model'), false);
});
