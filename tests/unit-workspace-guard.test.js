'use strict';
// R34（2026-11-24 WeLink 反馈）：「只允许改工作目录内的文件」。工作目录本身只是启动目录，Claude / CodeAgent
// 靠本次启动专用 --settings 里的 PreToolUse hook 拦下改工作区外文件的工具调用；Codex 拦不住，只提示。
// 铁律：只写 Hub 数据目录里的叠加文件，不碰用户自己的 settings.json。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const guard = require('../core/workspace-guard');

function decodeRoots(command) {
  const b64 = /\s([A-Za-z0-9+/=]+)$/.exec(command)[1];
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

test('notes: Claude/CodeAgent can be limited, Codex and Lite only get the honest hint', () => {
  assert.equal(guard.note('claude', true), guard.GUARD_ON);
  assert.match(guard.GUARD_ON, /^已限制只能改工作区内的文件/);
  assert.equal(guard.note('codeagent-resume', false), guard.GUARD_OFF);
  assert.equal(guard.note('codex', true), guard.HINT_ONLY);
  assert.equal(guard.note('codeagent', true, { available: false }), guard.HINT_ONLY);
  assert.match(guard.HINT_ONLY, /只是提示 AI，拦不住它改别处的文件；重要代码请先提交或备份/);
  assert.equal(guard.note('powershell', true), '');
  assert.equal(guard.supports('codex'), false);
});

test('allowed roots: cwd first, extra dirs and CLI plan/memory/temp folders, no duplicates or relative paths', () => {
  const root = path.join(os.tmpdir(), 'wg-roots');
  const roots = guard.allowedRoots({ cwd: path.join(root, 'ws'), addDirs: [path.join(root, 'ws'), path.join(root, 'extra'), 'relative'],
    configDir: path.join(root, 'cfg'), env: { TEMP: path.join(root, 'tmp') } });
  assert.equal(roots[0], path.join(root, 'ws'));
  assert.ok(roots.includes(path.join(root, 'extra')));
  assert.ok(roots.includes(path.join(root, 'cfg', 'plans')));
  assert.ok(roots.includes(path.join(root, 'tmp')));
  assert.equal(roots.filter(r => r === path.join(root, 'ws')).length, 1);
  assert.ok(!roots.some(r => r.endsWith('relative')));
});

test('overlay only when ticked and the backend supports it; hooks merge with personal-policy hooks', () => {
  const cwd = path.join(os.tmpdir(), 'wg-ws');
  assert.equal(guard.settingsOverlay('claude', {}, { cwd }), null);
  assert.equal(guard.settingsOverlay('codex', { workspaceGuard: true }, { cwd }), null);
  const overlay = guard.settingsOverlay('claude', { workspaceGuard: true }, { cwd, env: {} });
  const entry = overlay.hooks.PreToolUse[0];
  assert.equal(entry.matcher, guard.MATCHER);
  assert.match(entry.hooks[0].command, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*hub-workspace-guard\.ps1" /);
  assert.equal(decodeRoots(entry.hooks[0].command)[0], cwd);
  const merged = guard.mergeHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [{ hooks: [] }] }, overlay.hooks);
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.Stop.length, 1);
});

function loadHelpers(t, root) {
  const load = Module._load;
  Module._load = function (id, ...args) { return id === 'node-pty' ? { spawn() { throw Error('No PTY'); } } : load.call(this, id, ...args); };
  let helpers;
  try { helpers = require('../core/session-manager')._private; } finally { Module._load = load; }
  const prior = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior; });
  return helpers;
}

test('Claude PTY and native launches carry the guard in the per-session overlay; user settings.json untouched', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const userSettings = path.join(home, 'settings.json');
  const original = JSON.stringify({ hooks: {}, theme: 'dark' });
  fs.writeFileSync(userSettings, original);
  const env = { CLAUDE_CONFIG_DIR: home, USERPROFILE: root };
  const helpers = loadHelpers(t, root);
  const settingsOf = cmd => { const m = /--settings (?:'([^']+)'|([^\s]+))/.exec(cmd); return JSON.parse(fs.readFileSync(m[1] || m[2], 'utf8')); };
  const on = helpers.buildClaudePtyLaunch('wg-on', 'claude', { model: 'hub-model', fastMode: false, mcpProfile: 'full', workspaceGuard: true }, cwd, env, {});
  const hooks = settingsOf(on.cmd).hooks.PreToolUse;
  assert.equal(hooks.length, 1);
  assert.equal(decodeRoots(hooks[0].hooks[0].command)[0], path.resolve(cwd));
  const off = helpers.buildClaudePtyLaunch('wg-off', 'claude', { model: 'hub-model', fastMode: false, mcpProfile: 'full' }, cwd, env, {});
  assert.equal(settingsOf(off.cmd).hooks, undefined);
  const native = helpers.createNativeClaudeDriver('wg-native', 'claude', { model: 'hub-model', lazyStart: true, fastMode: false, mcpProfile: 'full', workspaceGuard: true }, cwd, env, false);
  const nativeSettings = JSON.parse(fs.readFileSync(native.options.settingsFile, 'utf8'));
  assert.equal(nativeSettings.hooks.PreToolUse[0].matcher, guard.MATCHER);
  assert.equal(fs.readFileSync(userSettings, 'utf8'), original);
});

test('CodeAgent launch settings keep the guard hooks when the model is rewritten mid-session', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ca-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helpers = loadHelpers(t, root);
  const hooks = guard.claudeHooks({ roots: [root], scriptPath: guard.scriptPath() });
  const file = helpers.writeCodeAgentLaunchSettings(root, 'sess-1', '', hooks);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks });
  helpers.writeCodeAgentLaunchSettings(root, 'sess-1', 'GLM-5');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'GLM-5', hooks });
  helpers.writeCodeAgentLaunchSettings(root, 'sess-1', 'GLM-5', null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'GLM-5' });
});

test('the PowerShell guard blocks edits outside the allowed roots and lets everything else through', { skip: process.platform !== 'win32' }, () => {
  const ws = path.join(os.tmpdir(), 'wg-ps', 'ws');
  const other = path.join(os.tmpdir(), 'wg-ps', '中文 目录');
  const b64 = guard.encodeRoots([ws, other]);
  const run = (filePath, toolInput) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guard.scriptPath(), b64],
    { input: JSON.stringify({ cwd: ws, tool_name: 'Write', tool_input: toolInput || { file_path: filePath } }), windowsHide: true });
  const cases = [
    [path.join(ws, 'a.txt'), 0],
    ['sub\\b.txt', 0],
    [path.join(other, 'x.md'), 0],
    [ws.toUpperCase() + '\\c.txt', 0],
    [ws + 'X\\a.txt', 2],
    [path.join(ws, '..', 'evil.txt'), 2],
    ['/c/Windows/evil.txt', 2],
  ];
  for (const [file, code] of cases) {
    const r = run(file);
    assert.equal(r.status, code, `${file}: ${r.stderr}`);
    if (code === 2) assert.match(r.stderr.toString('utf8'), /Refused by AI Hub/);
  }
  assert.equal(run(null, { notebook_path: 'C:\\elsewhere\\n.ipynb' }).status, 2);
  assert.equal(run(null, { command: 'echo hi' }).status, 0);
});

test('CodeAgent terminal launch adds a hooks-only --settings when no model file is used, and nothing when unticked', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ca-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helpers = loadHelpers(t, path.join(root, 'hub-data'));
  fs.mkdirSync(path.join(root, 'hub-data'), { recursive: true });
  const configDir = path.join(root, 'cac');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const launch = opts => helpers.buildCodeAgentPtyLaunch('ca-guard', 'codeagent', opts, root, { USERPROFILE: root, HOME: root }, config);
  const on = launch({ workspaceGuard: true });
  assert.equal(on.workspaceGuard, 'on');
  const file = path.join(root, 'hub-data', 'codeagent-launch', 'ca-guard.json');
  assert.ok(on.cmd.includes(file), on.cmd);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].matcher, guard.MATCHER);
  assert.equal(on.settingsModel, '');
  const off = launch({});
  assert.equal(off.workspaceGuard, undefined);
  assert.doesNotMatch(off.cmd, /--settings/);
});

test('in-place Claude relaunch: one --settings carrying the guard, roots include the session extra folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-relaunch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project'), extra = path.join(root, 'extra');
  for (const dir of [home, cwd, extra]) fs.mkdirSync(dir, { recursive: true });
  loadHelpers(t, root);
  const config = require('../core/hub-config'), managerModule = require('../core/session-manager');
  config.clearConfigCache(); managerModule.clearSessionManagerConfigCache();
  t.after(() => { config.clearConfigCache(); managerModule.clearSessionManagerConfigCache(); });
  for (const autonomous of [true, false]) {
    const commands = [];
    const manager = Object.create(managerModule.SessionManager.prototype);
    manager.sessions = new Map([['wg-re', { info: { id: 'wg-re', kind: 'claude', currentModel: { id: 'hub-model' }, fastMode: false, mcpProfile: 'full',
      cwd, claudeConfigDir: home, autonomous, workspaceGuard: true, addDirs: [extra] }, pty: { write: cmd => commands.push(cmd) } }]]);
    manager.emit = () => {};
    manager.hubRulesSystemPrompt = () => null;
    assert.equal(manager.relaunchCli('wg-re'), true);
    const cmd = commands.find(c => /claude/.test(c));
    assert.equal((cmd.match(/--settings/g) || []).length, 1, cmd);
    const file = /--settings (?:'([^']+)'|"([^"]+)")/.exec(cmd);
    const settings = JSON.parse(fs.readFileSync(path.normalize(file[1] || file[2]), 'utf8'));
    const roots = decodeRoots(settings.hooks.PreToolUse.find(h => h.matcher === guard.MATCHER).hooks[0].command);
    assert.equal(roots[0], path.resolve(cwd));
    assert.ok(roots.some(r => r.toLowerCase() === extra.toLowerCase()), JSON.stringify(roots));
    assert.ok(cmd.includes(`--add-dir "${extra}"`), cmd);
  }
});

test('the PowerShell guard sees through device prefixes, drive-relative paths and junctions', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-link-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real-ws'), outside = path.join(base, 'outside'), viaLink = path.join(base, 'ws-link');
  fs.mkdirSync(real); fs.mkdirSync(outside);
  fs.symlinkSync(real, viaLink, 'junction');
  fs.symlinkSync(outside, path.join(real, 'escape'), 'junction');
  // 工作目录经 junction 打开：Hub 把真实路径也放进放行名单。
  const roots = guard.allowedRoots({ cwd: viaLink, env: { TEMP: path.join(base, 'tmp') } });
  assert.ok(roots.some(r => r.toLowerCase() === fs.realpathSync.native(real).toLowerCase()), JSON.stringify(roots));
  const b64 = guard.encodeRoots(roots);
  const run = (file, cwd = viaLink) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guard.scriptPath(), b64],
    { input: JSON.stringify({ cwd, tool_name: 'Write', tool_input: { file_path: file } }), windowsHide: true });
  const drive = viaLink.slice(0, 2);
  const DEVICE = '\\\\?\\';
  const cases = [
    [path.join(viaLink, 'a.txt'), 0],
    [path.join(real, 'a.txt'), 0],
    [DEVICE + path.join(real, 'b.txt'), 0],
    [drive + 'c.txt', 0],
    [drive + path.join('..', '..', 'evil.txt'), 2],
    [path.join(viaLink, 'escape', 'evil.txt'), 2],
    [path.join(real, 'escape', 'new-dir', 'evil.txt'), 2],
    [DEVICE + path.join(outside, 'x.txt'), 2],
  ];
  for (const [file, code] of cases) assert.equal(run(file).status, code, file);
  assert.equal(spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guard.scriptPath(), b64],
    { input: JSON.stringify({ cwd: viaLink, tool_name: 'TodoWrite', tool_input: { todos: [] } }), windowsHide: true }).status, 0);
});
