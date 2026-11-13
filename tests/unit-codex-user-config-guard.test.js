'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isHubOwnedCodexHome, repairHubCodexConfigText, repairUserCodexConfigFile } = require('../core/codex-user-config-guard');

const HUB_TAIL = '\n[notice]\nhide_full_access_warning = true\nhide_rate_limit_model_nudge = true\n\n[windows]\nsandbox = "unelevated"\n';
const HUB_TUI = '\n[tui]\nstatus_line = ["model-with-reasoning", "context-remaining", "current-dir"]\n';

test('只有 Hub 数据目录下的 CODEX_HOME 算 Hub 自己的', () => {
  const hub = path.join(os.tmpdir(), 'hub-data');
  assert.equal(isHubOwnedCodexHome(path.join(hub, 'codex-api-profile'), hub), true);
  assert.equal(isHubOwnedCodexHome(null, hub), false, '未指定 = 用户全局 ~/.codex');
  assert.equal(isHubOwnedCodexHome(path.join(os.homedir(), '.codex'), hub), false);
  assert.equal(isHubOwnedCodexHome(hub + '-other', hub), false, '同前缀的兄弟目录不算');
});

test('粘行 [windows]sandbox 拆开并还原为 elevated', () => {
  const broken = '[windows]sandbox = "unelevated"\n\n[notice]\nhide_full_access_warning = true\nhide_rate_limit_model_nudge = true\n';
  const r = repairHubCodexConfigText(broken);
  assert.equal(r.changed, true);
  assert.match(r.text, /^\[windows\]\nsandbox = "elevated"\n/);
});

test('键粘在上一条键值后面也拆开', () => {
  const r = repairHubCodexConfigText('[notice]\nfoo = 1hide_full_access_warning = true\n');
  assert.equal(r.text, '[notice]\nfoo = 1\nhide_full_access_warning = true\n');
});

test('点号键 / 内联表 / 表头带注释 / notice 点号键：删掉 Hub 追加的重复块', () => {
  for (const head of ['model = "gpt-5"\nwindows.sandbox = "elevated"\n', 'windows = { sandbox = "elevated" }\n', '[windows] # mine\nsandbox = "elevated"\n']) {
    const r = repairHubCodexConfigText(head + HUB_TAIL);
    assert.equal(r.changed, true, head);
    assert.equal((r.text.match(/^\[windows\]$/mg) || []).length, 0, head);
    assert.match(r.text, /hide_rate_limit_model_nudge = true/, '不冲突的 [notice] 块保留');
  }
  const r = repairHubCodexConfigText('notice.hide_full_access_warning = true\n' + HUB_TAIL);
  assert.equal((r.text.match(/^\[notice\]$/mg) || []).length, 0);
  assert.match(r.text, /^\[windows\]\nsandbox = "unelevated"$/m);
});

test('正常文件、合法相似写法一字不改', () => {
  const ok = [
    'model = "gpt-5"\n' + HUB_TAIL,
    '[notice.model_migrations]\n"gpt-5" = "gpt-5.1"\n' + HUB_TAIL,
    'my_sandbox = "unelevated"\n',
    '# 注释 sandbox = "unelevated"\n',
    '[windows]\nsandbox = "elevated"\r\n',
    '[notice]\r\nhide_full_access_warning = true\r\n',
  ];
  for (const text of ok) assert.deepEqual(repairHubCodexConfigText(text), { text, changed: false, fixes: [] }, text);
});

test('写文件前留备份，文件不存在时不建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-'));
  try {
    const file = path.join(dir, 'config.toml');
    assert.deepEqual(repairUserCodexConfigFile(file, { logger: {} }), { changed: false, fixes: [], error: null });
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '[windows]sandbox = "unelevated"\n');
    const r = repairUserCodexConfigFile(file, { logger: {} });
    assert.equal(r.changed, true);
    assert.equal(fs.readFileSync(r.backup, 'utf8'), '[windows]sandbox = "unelevated"\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '[windows]\nsandbox = "elevated"\n');
    assert.equal(repairUserCodexConfigFile(file, { logger: {} }).changed, false, '修好后再跑不动');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Hub 追加的重复 tui 块被移除，用户原有内容和 CRLF 保留，修复幂等', () => {
  for (const original of [
    '[tui]\nnotifications = false\n',
    '[tui] # mine\nstatus_line = ["model"]\n',
    '[ "tui" ]\nnotifications = false\n',
    'tui.notifications = false\n',
    'tui = { notifications = false }\n',
  ]) for (const newline of ['\n', '\r\n']) {
    const source = original.replace(/\n/g, newline);
    const broken = source + HUB_TUI.replace(/\n/g, newline);
    const result = repairHubCodexConfigText(broken);
    assert.equal(result.text, source, broken);
    assert.equal(result.changed, true);
    assert.deepEqual(result.fixes, ['删除与原有写法重复的 [tui] 块']);
    assert.equal(repairHubCodexConfigText(result.text).changed, false);
    assert.equal(repairHubCodexConfigText(broken + HUB_TUI.replace(/\n/g, newline)).text, source);
  }
});

test('不删正常 tui、用户自定义的重复块或字符串中的假表头', () => {
  for (const text of [
    HUB_TUI,
    '[tui]\nnotifications = false\n',
    '[tui]\nnotifications = false\n\n[tui]\nstatus_line = ["my-status"]\n',
    '[tui]\nnotifications = false\n' + HUB_TUI + 'theme = "mine"\n',
    '[tui]\nnotifications = false\n' + HUB_TUI.trimEnd() + ' # user annotation\n',
    'description = """\n[tui]\nstatus_line = ["model-with-reasoning", "context-remaining", "current-dir"]\n"""\n' + HUB_TUI,
    '[tui.extra]\nvalue = true\n' + HUB_TUI,
  ]) assert.deepEqual(repairHubCodexConfigText(text), { text, changed: false, fixes: [] }, text);
});

test('启动函数只修复旧 tui 损坏，遵守 CODEX_HOME，不再往任何正常配置追加内容', t => {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tui-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('function ensureCodexContextConfig()');
  const end = source.indexOf('\nfunction ensureGeminiMcpInstalled', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ require: createRequire(filename), process: { env: { USERPROFILE: path.join(dir, 'user'), CODEX_HOME: path.join(dir, 'custom') } },
    path, os, console: { warn() {} } });
  vm.runInContext(source.slice(start, end) + '\nthis.run = ensureCodexContextConfig;', context);
  context.run();
  assert.equal(fs.existsSync(path.join(dir, 'custom')), false, '不存在的用户配置不能被创建');
  fs.mkdirSync(path.join(dir, 'custom'));
  const file = path.join(dir, 'custom', 'config.toml');
  for (const text of ['model = "internal-model"\n', '[tui]\nnotifications = false\n', '# status_line\n']) {
    fs.writeFileSync(file, text);
    context.run(); context.run();
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  const before = '[tui]\nnotifications = false\n';
  fs.writeFileSync(file, before + HUB_TUI);
  context.run(); context.run();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const backup = fs.readdirSync(path.dirname(file)).find(name => name.includes('.hub-repair-'));
  assert.ok(backup); assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), before + HUB_TUI);
  assert.equal(fs.existsSync(path.join(dir, 'user')), false, '自定义 CODEX_HOME 不应写到 ~/.codex');
});

test('状态栏只作为本次会话参数传入，自定义设置与旧注释退出开关保留', t => {
  const { codexStatusLineConfigArg } = require('../core/codex-user-config-guard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tui-arg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { CODEX_HOME: dir };
  const arg = codexStatusLineConfigArg(null, { env });
  assert.equal(arg, ' -c \'tui.status_line=["model-with-reasoning", "context-remaining", "current-dir"]\'');
  assert.equal(fs.existsSync(path.join(dir, 'config.toml')), false);
  const file = path.join(dir, 'config.toml');
  for (const text of ['[tui]\nstatus_line = ["mine"]\n', '# status_line\n']) {
    fs.writeFileSync(file, text);
    assert.equal(codexStatusLineConfigArg(null, { env }), '');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  assert.equal(codexStatusLineConfigArg(dir, { env: {}, fsModule: { readFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }), '');
  const launch = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(launch, /codexStatusLineConfigArg\(sessionEnv\.CODEX_HOME \|\| null\)/);
  assert.match(launch, /codexStatusLineConfigArg\(codexConfigDir\)/);
});
