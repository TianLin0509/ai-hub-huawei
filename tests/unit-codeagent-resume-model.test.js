'use strict';
// N3：按真机口径验收恢复启动，而不是把 --settings 假设成每次请求的最高优先级。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'node-pty') return {};
  return load.call(this, id, ...args);
};
const { _private } = require('../core/session-manager');
Module._load = load;
const models = require('../core/codeagent-models');
const pool = require('../core/codeagent-pool');
const config = require('../core/hub-config');
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4.1-flash-1017';
const NATIVE = '11111111-1111-4111-8111-111111111111';

function fixture(t, list = [GLM, DS]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n3-resume-'));
  const cfg = path.join(root, 'cac'), history = path.join(cfg, 'projects', 'project', NATIVE + '.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: GLM }));
  require('../core/codeagent-model-probe').writeProbed(pool.personalModelsFile(root), { source: 'serve', models: list });
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  config.clearConfigCache();
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => 'Usage: codeagent\n --settings <file>\n --resume <id>\n');
  t.mock.method(require('../core/codeagent-serve'), 'serveEnabled', () => true);
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    config.clearConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const answer = (model, ts = Date.now()) => fs.appendFileSync(history, JSON.stringify({ type: 'assistant', sessionId: NATIVE,
    timestamp: new Date(ts).toISOString(), message: { role: 'assistant', model, content: [{ type: 'text', text: '回答' }] } }) + '\n');
  const launch = (extra = {}) => _private.buildCodeAgentPtyLaunch('n3', 'codeagent', {
    fixedModel: GLM, model: GLM, currentModel: { id: GLM }, mcpProfile: 'full', ...extra,
  }, root, { HOME: root, USERPROFILE: root }, { command: 'never-run', configDir: cfg });
  return { root, cfg, history, answer, launch, settings: () => JSON.parse(fs.readFileSync(path.join(root, 'codeagent-launch/n3.json'), 'utf8')) };
}

for (const lifecycle of ['休眠唤醒', '关闭重开']) test(`${lifecycle}：GLM 创建、终端 DS 作答后，--resume 的 --settings 仍用 DS`, t => {
  const f = fixture(t);
  assert.equal(f.launch().fixedModel, GLM);
  f.answer(GLM, Date.now() - 1000);
  f.answer(DS);
  const built = f.launch({ resumeCCSessionId: NATIVE, resumeTranscriptPath: f.history });
  assert.match(built.cmd, new RegExp('--resume ' + NATIVE));
  assert.match(built.cmd, /--settings/);
  assert.equal(built.settingsModel, DS);
  assert.equal(built.fixedModel, DS);
  assert.equal(built.modelPinSource, 'cli');
  assert.equal(built.actualModel.id, DS);
  assert.equal(f.settings().model, DS);
  // 与在线观察共用账号映射来源，恢复后的首轮仍保持 DS。
  const target = require('../core/codeagent-resume-model').resolveAccountModel(DS, { dataDir: f.root, configDir: f.cfg });
  const observed = models.observeModel({ id: 'n3', kind: 'codeagent', fixedModel: GLM, currentModel: { id: GLM } }, DS,
    { followActual: true, resolveSwitch: () => target });
  assert.equal(observed.fields.currentModel.id, built.fixedModel);
  assert.equal(f.launch({ ...built, resumeCCSessionId: NATIVE }).settingsModel, DS);
});

test('记录中的模型不在账号清单：回退旧模型并记录原因，不能采纳其他会话见过的模型', t => {
  const f = fixture(t, [GLM]);
  f.answer(DS);
  models.recordObserved(f.root, DS);
  const built = f.launch({ resumeCCSessionId: NATIVE });
  assert.equal(built.fixedModel, GLM);
  assert.equal(f.settings().model, GLM);
  const log = fs.readFileSync(path.join(f.root, 'logs/codeagent-model.log'), 'utf8');
  assert.match(log, /event=resume-transcript-model.*actual=deepseek.*reason=not-in-account-list/);
});

test('找不到实际回答、记录缺失、新会话和分支均保留原来的模型', t => {
  const f = fixture(t);
  fs.writeFileSync(f.history, '{}\n');
  assert.equal(f.launch({ resumeCCSessionId: NATIVE }).settingsModel, GLM);
  fs.unlinkSync(f.history);
  assert.equal(f.launch({ resumeCCSessionId: NATIVE }).settingsModel, GLM);
  f.answer(DS);
  assert.equal(f.launch().settingsModel, GLM);
  assert.equal(f.launch({ forkCCSessionId: NATIVE }).settingsModel, GLM);
});

test('显式选型后的旧回答不能把新选择撤回；更新的回答仍可跟随', t => {
  const f = fixture(t), now = Date.now();
  f.answer(DS, now - 1000);
  assert.equal(f.launch({ resumeCCSessionId: NATIVE, modelSwitchConfirmedAt: now }).settingsModel, GLM);
  f.answer(DS, now + 1);
  assert.equal(f.launch({ resumeCCSessionId: NATIVE, modelSwitchConfirmedAt: now }).settingsModel, DS);
});

test('Auto 后端名称映射回菜单模型，大小写采用账号原名', t => {
  const f = fixture(t);
  f.answer('GLM-5.2-WX');
  assert.equal(f.launch({ resumeCCSessionId: NATIVE }).settingsModel, GLM);
  f.answer(DS.toUpperCase());
  assert.equal(f.launch({ resumeCCSessionId: NATIVE }).settingsModel, DS);
});

test('号池恢复只使用该号的清单，不借用个人账号的权限', t => {
  const f = fixture(t);
  f.answer(DS);
  const options = { dataDir: f.root, configDir: f.cfg, pool: { account: { models: [GLM], modelsAuthoritative: true } } };
  const fields = require('../core/codeagent-resume-model').resumeModelFields({ fixedModel: GLM }, f.history, options);
  assert.equal(fields.fixedModel, undefined);
});
