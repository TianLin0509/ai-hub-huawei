'use strict';
// A-08 附带（2026-11-28 黄区 f09d）：新会话日志先记「CLI 记着 GLM-5.2-WX-Auto，不开菜单」，随后仍为同一个模型开 /model 菜单，
// 撞上启动公告被判未就绪，首句没发出。模型是从账号默认推出来的、又正是 CLI 这次启动会用的那个时，不再开菜单。
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

// 首次打开：serve 清单还没读到（没有探测文件），--settings 写法拿不准，以前只能靠 /model 菜单。
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-skip-'));
  const cfg = path.join(root, '.cac');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: GLM }));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  const config = require('../core/hub-config');
  config.clearConfigCache();
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => 'Usage: codeagent\n --settings <file>\n --resume <id>\n');
  t.mock.method(require('../core/codeagent-serve'), 'serveEnabled', () => true);
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    config.clearConfigCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  const launch = opts => _private.buildCodeAgentPtyLaunch('menu-skip', 'codeagent', { mcpProfile: 'full', ...opts }, root,
    { HOME: root, USERPROFILE: root }, { command: 'never-run', configDir: cfg });
  return { launch };
}

test('model pinned from the account default and equal to what CLI starts with: no /model menu', t => {
  const built = fixture(t).launch({});
  assert.equal(built.settingsModel, '', '首次打开、清单未知时 --settings 写法拿不准（夹具前提）');
  assert.equal(built.model, GLM);
  assert.equal(built.requiresMenu, false);
  assert.equal(built.menuSkippedSameAsCli, true);
});

test('explicitly chosen model still opens the menu (or uses --settings), even if it equals the CLI default', t => {
  const built = fixture(t).launch({ model: GLM, codeagentModelPick: true });
  assert.ok(built.settingsModel || built.requiresMenu, '明确指定的照旧核实');
  assert.ok(!built.menuSkippedSameAsCli);
});

test('default differs from what Hub pins (e.g. replacement): menu still opens', t => {
  const built = fixture(t).launch({ fixedModel: DS });
  assert.ok(built.settingsModel || built.requiresMenu);
  assert.ok(!built.menuSkippedSameAsCli);
});
