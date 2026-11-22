'use strict';
// T4：新建明确选型必须进入本会话设置，不能被 CLI 记住的默认模型覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'node-pty') return {};
  return originalLoad.call(this, name, ...args);
};
const { _private } = require('../core/session-manager');
Module._load = originalLoad;
const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4.1-flash-1017';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't4-new-model-'));
  const cfg = path.join(root, '.cac');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: GLM }));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  const config = require('../core/hub-config');
  config.clearConfigCache();
  require('../core/codeagent-model-probe').writeProbed(require('../core/codeagent-pool').personalModelsFile(root),
    { source: 'serve', models: [GLM, DS] });
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => 'Usage: codeagent\n --settings <file>\n --resume <id>\n');
  t.mock.method(require('../core/codeagent-serve'), 'serveEnabled', () => true);
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    config.clearConfigCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  const launch = opts => _private.buildCodeAgentPtyLaunch('t4-new', 'codeagent', { mcpProfile: 'full', ...opts }, root,
    { HOME: root, USERPROFILE: root }, { command: 'never-run', configDir: cfg });
  return { root, cfg, launch };
}

for (const pick of [true, DS]) test(`新建明确选 DS、CLI 默认 GLM：--settings 与 Hub 固定模型一致（选型标记 ${pick}）`, t => {
  const f = fixture(t), opts = { model: DS, codeagentModelPick: pick };
  assert.equal(_private.shouldPickCodeAgentModel(opts), true, '明确选型不进入 cli-remembered 分支');
  const built = require('../main/session-model-creation').createSessionWithModelPolicy({ kind: 'codeagent', opts,
    create: (_kind, normalized) => f.launch(normalized) });
  assert.equal(built.model, DS);
  assert.equal(built.fixedModel, DS);
  assert.equal(built.settingsModel, DS);
  assert.equal(built.modelPinSource, 'user');
  assert.equal(built.requiresMenu, false);
  assert.match(built.cmd, /--settings/);
  assert.doesNotMatch(built.cmd, /--model(?:\s|$)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'codeagent-launch/t4-new.json'), 'utf8')).model, DS);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.cfg, 'settings.json'), 'utf8')).model, GLM);
  // 直接走核心新建入口也应采用同一个明确选型，不依赖 IPC 恰好补了 fixedModel。
  assert.equal(f.launch(opts).settingsModel, DS);
});

test('只有历史 model 元数据、没有明确选型的新建仍沿用 CLI 默认', t => {
  const f = fixture(t);
  assert.equal(_private.shouldPickCodeAgentModel({ model: DS, codeagentModelPick: false }), false);
  assert.equal(f.launch({ model: DS, codeagentModelPick: false }).settingsModel, GLM);
  assert.equal(f.launch({}).settingsModel, GLM);
});
