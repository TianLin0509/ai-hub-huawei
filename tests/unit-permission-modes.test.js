'use strict';
// 启动中心「权限模式」（2026-11-20）：每个工具 × 每档的启动命令、记住上次、恢复链路带回，
// 以及回归守护——组队成员 / 群聊 / autonomous 会话不带 permissionMode 时仍是 bypass。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const modes = require('../core/permission-modes');

function loadSessionManager() {
  const load = Module._load;
  Module._load = function patched(id, ...args) {
    if (id === 'node-pty') return { spawn() { throw new Error('No real CLI in permission-mode unit tests'); } };
    return load.call(this, id, ...args);
  };
  try { return require('../core/session-manager'); } finally { Module._load = load; }
}

test('mode table: Claude 4 档、CodeAgent 5 档含 auto、Codex 2 档、DSH 3 档（另见 unit-permission-modes-dsh）、其余只有完全放开', () => {
  assert.deepEqual(modes.modesFor('claude'), ['bypassPermissions', 'acceptEdits', 'default', 'plan']);
  assert.deepEqual(modes.modesFor('claude-resume'), modes.modesFor('claude'));
  assert.deepEqual(modes.modesFor('codeagent'), ['bypassPermissions', 'acceptEdits', 'default', 'plan', 'auto']);
  assert.deepEqual(modes.modesFor('codex'), ['bypassPermissions', 'default']);
  assert.equal(modes.normalize('codex-resume', 'default'), 'default');
  assert.equal(modes.normalize('codex', 'plan'), null);
  assert.match(modes.describe('codex', 'default'), /只读沙箱/);
  for (const kind of ['deepseek', 'pi', 'powershell']) {
    assert.deepEqual(modes.modesFor(kind), ['bypassPermissions'], kind);
    assert.equal(modes.supportsSwitch(kind), false, kind);
    assert.equal(modes.normalize(kind, 'default'), null, kind);
  }
  assert.equal(modes.normalize('claude', 'auto'), null, 'Claude Code 不开 auto（另计费）');
  assert.equal(modes.normalize('codeagent', 'auto'), 'auto');
  assert.equal(modes.normalize('claude', 'default; rm -rf /'), null);
  assert.equal(modes.normalize('claude', 'dontAsk'), null);
  assert.match(modes.optionsFor('claude', { userDefault: 'bypassPermissions' }).find(o => o.id === 'bypassPermissions').label, /完全放开（默认）/);
  assert.match(modes.BYPASS_RISK, /不要只为少点确认而选它/);
});

test('Claude PTY 启动命令：每档原样带上，不传则 bypass', t => {
  const { _private } = loadSessionManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-claude-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '');
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { USERPROFILE: root, HOME: root };
  const build = extra => _private.buildClaudePtyLaunch('perm', 'claude', { model: 'claude-opus-4-8', effort: 'max', fastMode: false, mcpProfile: 'none', ...extra }, root, env, {}).cmd;
  assert.match(build({}), /--permission-mode bypassPermissions\b/);
  for (const mode of modes.modesFor('claude')) assert.match(build({ permissionMode: mode }), new RegExp(`--permission-mode ${mode}\\b`), mode);
  assert.match(build({ permissionMode: 'auto' }), /--permission-mode bypassPermissions\b/, 'Claude 不开放 auto：落回默认，不让建会话失败');
});

test('CodeAgent 启动命令：5 档含 auto；非法值与不传都落回 bypass；旧版不认参数时标出来', t => {
  const { _private } = loadSessionManager();
  const caps = require('../core/codeagent-capabilities');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-codeagent-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(tmp, 'hub-data');
  fs.mkdirSync(process.env.CLAUDE_HUB_DATA_DIR, { recursive: true });
  const configDir = path.join(tmp, 'cac');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  let help = '';
  t.mock.method(caps, 'readHelp', () => help);
  const warn = console.warn; console.warn = () => {};
  t.after(() => {
    console.warn = warn;
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const launch = opts => _private.buildCodeAgentPtyLaunch('hub-1', 'codeagent', opts, tmp, { USERPROFILE: tmp, HOME: tmp }, config);
  assert.match(launch({}).cmd, /--permission-mode bypassPermissions\b/);
  for (const mode of modes.modesFor('codeagent')) assert.match(launch({ permissionMode: mode }).cmd, new RegExp(`--permission-mode ${mode}\\b`), mode);
  assert.match(launch({ permissionMode: 'dontAsk' }).cmd, /--permission-mode bypassPermissions\b/);
  assert.equal(launch({ permissionMode: 'default' }).permissionModeDropped, undefined);
  // 旧版（如 1.2605）的 --help 里没有 --permission-mode：参数被去掉，结果里要标出来让界面提示。
  help = 'Usage: codeagent [options]\n  --disable-update\n  --skip-safe-check\n  --effort <level>\n  --settings <file>\n  --mcp-config <configs...>\n';
  const old = launch({ permissionMode: 'default' });
  assert.doesNotMatch(old.cmd, /--permission-mode/);
  assert.equal(old.permissionModeDropped, 'default');
  assert.equal(launch({}).permissionModeDropped, undefined, '默认完全放开被去掉不用提示');
});

test('原地重拉（relaunchCli）Claude：沿用所选档位；普通会话缺省带 bypass；autonomous 始终 bypass', t => {
  const { SessionManager } = loadSessionManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-relaunch-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = root;
  t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '');
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { USERPROFILE: root, HOME: root };
  const relaunch = info => {
    const manager = Object.create(SessionManager.prototype), commands = [];
    manager.sessions = new Map([['r', { info: { id: 'r', kind: 'claude', currentModel: { id: 'claude-opus-4-8' }, effort: 'max', fastMode: false, mcpProfile: 'none', cwd: root, ...info },
      pty: { options: { env }, write: cmd => commands.push(cmd) } }]]);
    manager.hubRulesSystemPrompt = () => null;
    manager.emit = () => {};
    assert.equal(manager.relaunchCli('r'), true);
    return commands[0];
  };
  assert.match(relaunch({}), /--permission-mode bypassPermissions\b/, '以前这里不带参数，会落到本机 Claude 自己的默认');
  assert.match(relaunch({ permissionMode: 'default' }), /--permission-mode default\b/);
  assert.match(relaunch({ permissionMode: 'plan' }), /--permission-mode plan\b/);
  assert.match(relaunch({ permissionMode: 'auto' }), /--permission-mode bypassPermissions\b/, 'Claude 不认的值落回默认');
  assert.match(relaunch({ autonomous: true, permissionMode: 'default' }), /--permission-mode bypassPermissions\b/);
});

test('恢复链路：会话元数据、重启元数据、分支、休眠恢复都带回权限模式', async () => {
  const { buildSessionResumeMeta } = require('../core/session-capabilities');
  const meta = buildSessionResumeMeta({ id: 'a', kind: 'claude', cwd: 'C:/x', permissionMode: 'default' });
  assert.equal(meta.permissionMode, 'default');
  assert.equal(buildSessionResumeMeta({ id: 'b', kind: 'claude', cwd: 'C:/x' }).permissionMode, null);

  const { planSessionFork } = require('../core/session-fork-plan');
  const fork = planSessionFork({ source: { id: 'a', kind: 'codeagent', cwd: 'C:/x', title: 't', ccSessionId: '11111111-1111-4111-8111-111111111111', permissionMode: 'auto' } });
  assert.equal(fork.ok, true);
  assert.equal(fork.opts.permissionMode, 'auto');

  const persisted = fs.readFileSync(path.join(__dirname, '../main/ipc/persistence-handlers.js'), 'utf8');
  assert.match(persisted, /'permissionMode',/);
  const restart = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  assert.match(restart, /old\.permissionMode \? \{ permissionMode: old\.permissionMode \}/);
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.equal((renderer.match(/permissionMode: (?:s|meta)\.permissionMode \|\| null/g) || []).length, 2, '渲染层两份落盘记录都带');

  // 休眠恢复：resume handler 把落盘的 permissionMode 交回 createSession。
  const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
  const calls = [];
  const sessionManager = {
    getSession: () => null,
    createSession(kind, opts) { calls.push({ kind, opts }); return { id: opts.id || 'new', kind, status: 'idle' }; },
    writeToSession() {},
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-resume-'));
  try {
    const resume = createResumeSessionHandler({ fs, os, path, getHubDataDir: () => dataDir, getHookPort: () => 0,
      isClaudeFamily: kind => /^claude(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
      findTranscriptByCCSessionId: () => null, sessionManager, slotIds: [],
      meetingManager: { getAllMeetings: () => [], getMeeting: () => null }, registerSessionForTap() {}, sendToRenderer() {} });
    await resume({ hubId: 'h1', kind: 'claude', cwd: dataDir, permissionMode: 'default' });
    await resume({ hubId: 'h2', kind: 'claude', cwd: dataDir });
    await resume({ hubId: 'h3', kind: 'claude', cwd: dataDir, autonomous: true, permissionMode: 'default' });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].opts.permissionMode, 'default');
  assert.equal(calls[1].opts.permissionMode, undefined, '没选过的老会话照旧走主进程缺省 bypass');
  assert.equal(calls[2].opts.permissionMode, undefined, 'autonomous 会话恢复后仍旁路');
});

test('回归守护：组队成员、群聊、后台助理建会话都不带 permissionMode（主进程缺省 bypass 不变）', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['main/team/service.js', 'main/ipc/meeting-create-handlers.js', 'main/groupchat/loop-engine.js']) {
    if (!fs.existsSync(path.join(__dirname, '..', file))) continue;
    assert.doesNotMatch(read(file), /permissionMode/, file);
  }
  const sm = read('core/session-manager.js');
  assert.match(sm, /normalize\('claude', opts\.permissionMode\) \|\| 'bypassPermissions'/, 'Claude PTY 缺省 bypass');
  // Codex 审查 2026-11-20：原生 Claude 也要归一（auto 不让建会话失败，autonomous 强制旁路）；群聊成员（含分支到群聊）去掉权限模式；
  // CodeAgent 原地重拉遇到旧版也要提示。
  assert.match(sm, /\(opts\.autonomous === true \? null : require\('\.\/permission-modes'\)\.normalize\('claude', opts\.permissionMode\)\) \|\| 'bypassPermissions'/);
  assert.match(sm, /if \(opts && opts\.meetingId && opts\.permissionMode\) \{ opts = \{ \.\.\.opts \}; delete opts\.permissionMode; \}/);
  assert.equal((sm.match(/codeAgentPermissionDroppedMessage\(/g) || []).length, 3, '定义 + 新建 + 重拉各一处');
  assert.match(sm, /normalize\('codeagent', opts\.permissionMode\) \|\| 'bypassPermissions'/, 'CodeAgent 缺省 bypass');
  // autonomous 不落盘 permissionMode：恢复后由 autonomous 标记重建旁路。
  assert.match(sm, /opts\.autonomous !== true && require\('\.\/permission-modes'\)\.normalize\(kind, opts\.permissionMode\)/);
});

test('Codex（二期）：完全放开保留旁路参数；每步确认去掉旁路、改为只读沙箱 + 按需批准；新建/分支/恢复/重拉 7 处都走同一开关', () => {
  const { _private } = loadSessionManager();
  const bypass = _private.buildCodexReasoningConfigArg('max');
  assert.match(bypass, /approval_policy="never"/);
  assert.match(bypass, /sandbox_mode="danger-full-access"/);
  const ask = _private.buildCodexReasoningConfigArg('max', 'default');
  assert.match(ask, /approval_policy="on-request"/);
  assert.match(ask, /sandbox_mode="read-only"/);
  assert.doesNotMatch(ask, /never|danger-full-access/);
  assert.match(ask, /windows\.sandbox="unelevated"/, 'Windows 只读沙箱用 unelevated（ask-aside 同款）');
  assert.equal(modes.codexPermissionArgs('default').flag, '');
  assert.equal(modes.codexPermissionArgs('bypassPermissions').flag, ' --dangerously-bypass-approvals-and-sandbox');
  assert.equal(modes.codexPermissionArgs('garbage').flag, ' --dangerously-bypass-approvals-and-sandbox');
  const sm = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  assert.doesNotMatch(sm, /` codex[^`]*--dangerously-bypass-approvals-and-sandbox/, '命令里不再写死旁路参数');
  assert.equal((sm.match(/\$\{codexBypassFlag\}/g) || []).length, 5, '新建、分支、按 id 恢复、选择恢复、--last 恢复');
  assert.match(sm, /codexPermissionArgs\(codexRelaunchPermission\)\.flag/, '原地重拉');
  assert.match(sm, /opts\.autonomous === true \? null : require\('\.\/permission-modes'\)\.normalize\(kind, opts\.permissionMode\)\) \|\| 'bypassPermissions'/);
});

test('Codex 原生回退（runtime.agent=native）也按所选权限模式；显式落盘值优先；群聊与 autonomous 仍完全放开', t => {
  const { _private } = loadSessionManager();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-native-codex-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const info = { kind: 'codex', cwd: dir, currentModel: { id: 'gpt-5.5' }, mcpProfile: 'none', codexSpeedTier: 'inherit' };
  const env = { CODEX_HOME: path.join(dir, 'codex-home'), USERPROFILE: dir, HOME: dir };
  const thread = opts => _private.buildNativeCodexOptions(info, opts, env).threadParams;
  assert.deepEqual([thread({}).approvalPolicy, thread({}).sandbox], ['never', 'danger-full-access']);
  assert.deepEqual([thread({ permissionMode: 'default' }).approvalPolicy, thread({ permissionMode: 'default' }).sandbox], ['on-request', 'read-only']);
  assert.equal(thread({ permissionMode: 'default', approvalPolicy: 'never', sandbox: 'danger-full-access' }).approvalPolicy, 'never', '落盘的显式值优先');
  assert.equal(thread({ permissionMode: 'default', meetingId: 'm1' }).approvalPolicy, 'never');
  assert.equal(thread({ permissionMode: 'default', autonomous: true }).approvalPolicy, 'never');
});
