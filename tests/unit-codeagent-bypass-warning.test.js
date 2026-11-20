'use strict';
// CodeAgent 第一次用 bypass 档时的「Bypass Permissions mode」确认框（2026-11-20 一键反馈 v5.6.64）。
// 画面取自反馈附带的 codeagent-model-picker-last.txt：默认高亮「1. No, exit」，Esc 也是取消。
// 以前：启动时没人点、模型菜单卡住；发消息时输入守卫按 Esc 关不掉，报「终端里有未关闭的菜单，请到终端确认」。
const test = require('node:test');
const assert = require('node:assert');
const { detectBypassWarningInLines, watchBypassWarning } = require('../core/claude-trust-dialog');
const { createCodeAgentInputGuard } = require('../core/codeagent-input-guard');

const WARNING = [
  'PS C:\\Users\\u\\Workspaces>  & \'C:\\Program Files\\CodeAgentCLI\\codeagent.bat\' --disable-update --skip-safe-check --permission-mode bypassPermissions',
  '',
  '────────────────────────────────────────────────────────────',
  '  WARNING: CodeAgent running in Bypass Permissions mode',
  '',
  '  In Bypass Permissions mode, CodeAgent will not ask for your approval before running potentially dangerous commands.',
  '  This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.',
  '',
  '  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
  '',
  '  ask the ops team for help',
  '',
  '  ❯ 1. No, exit',
  '    2. Yes, I accept',
  '',
  '  Enter to confirm · Esc to cancel',
];
const IDLE = [' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │'];

test('the real CodeAgent warning frame yields Down + Enter onto "Yes, I accept"', () => {
  const dialog = detectBypassWarningInLines(WARNING);
  assert.deepStrictEqual(dialog.keys, ['\x1b[B', '\r']);
  assert.strictEqual(WARNING[dialog.acceptRow - 1].trim(), '2. Yes, I accept');
});

test('cursor already on Yes only presses Enter; no prompt or no cursor means no keys', () => {
  const onYes = WARNING.map(line => line.replace('❯ 1. No, exit', '  1. No, exit').replace('    2. Yes, I accept', '  ❯ 2. Yes, I accept'));
  assert.deepStrictEqual(detectBypassWarningInLines(onYes).keys, ['\r']);
  assert.strictEqual(detectBypassWarningInLines(WARNING.map(line => line.replace('❯', ' '))), null);
  // 普通输出里提到这几个词、但不是那个框：不按键
  assert.strictEqual(detectBypassWarningInLines(['Bypass Permissions mode is documented here', '❯ 1. Yes, I accept the terms']), null);
  assert.strictEqual(detectBypassWarningInLines(IDLE), null);
});

function fakePty() {
  const listeners = [], writes = [];
  return { writes, emit: d => listeners.forEach(cb => cb(d)), onData(cb) { listeners.push(cb); return { dispose() { listeners.splice(listeners.indexOf(cb), 1); } }; }, write: d => writes.push(d) };
}
function fakeScreen(frameRef) {
  return () => ({ write() {}, lines: async () => frameRef.lines, dispose() { frameRef.disposed = true; } });
}

test('startup watcher accepts the warning once, after the frame settles', async () => {
  const pty = fakePty(), frame = { lines: WARNING };
  const accepted = [];
  watchBypassWarning(pty, { createScreen: fakeScreen(frame), onAccepted: d => accepted.push(d), settleMs: 20, pollMs: 5, timeoutMs: 2000 });
  pty.emit('frame');
  await new Promise(r => setTimeout(r, 150));
  assert.deepStrictEqual(pty.writes, ['\x1b[B', '\r']);
  assert.strictEqual(accepted.length, 1);
  assert.ok(frame.disposed);
  pty.emit('again');
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(pty.writes.length, 2, 'only once');
});

test('startup watcher never presses keys when no warning is shown', async () => {
  const pty = fakePty(), frame = { lines: IDLE };
  const stop = watchBypassWarning(pty, { createScreen: fakeScreen(frame), settleMs: 10, pollMs: 5, timeoutMs: 2000 });
  pty.emit('frame');
  await new Promise(r => setTimeout(r, 60));
  stop();
  assert.deepStrictEqual(pty.writes, []);
});

test('sending into a session stuck on the warning accepts it instead of pressing Esc, then sends', async () => {
  let frame = WARNING;
  const writes = [], diagnosed = [];
  const entry = { pty: {}, info: { id: 's', kind: 'codeagent', agentRuntime: 'pty', status: 'idle' } };
  const manager = {
    sessions: new Map([['s', entry]]), getSession: () => ({ ...entry.info }), emit() {},
    writeToSession: (_id, d) => { writes.push(d); if (d === '\r') frame = IDLE; },
  };
  const guard = createCodeAgentInputGuard(manager, {
    openScreen: async () => ({ lines: async () => frame, dispose() {} }),
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), diagnose: e => diagnosed.push(e), stopDiagnose() {},
  });
  const result = await guard.check('s');
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(writes, ['\x1b[B', '\r']);
  assert.ok(!writes.includes('\x1b'), 'Esc would pick "No, exit"');
  assert.ok(diagnosed.includes('bypass-warning-accepted'));
});

test('CodeAgent bypass launches are flagged and _createSession starts the watcher for them', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { _private } = require('../core/session-manager');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-flag-'));
  const savedDir = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(tmp, 'hub-data');
  fs.mkdirSync(process.env.CLAUDE_HUB_DATA_DIR, { recursive: true });
  const configDir = path.join(tmp, 'cac');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const warn = console.warn; console.warn = () => {};
  try {
    const launch = opts => _private.buildCodeAgentPtyLaunch('hub-1', 'codeagent', opts, tmp, { USERPROFILE: tmp, HOME: tmp }, config);
    assert.strictEqual(launch({}).bypassLaunch, true);
    assert.match(launch({}).cmd, /--permission-mode bypassPermissions/);
    assert.strictEqual(launch({ permissionMode: 'default' }).bypassLaunch, false);
  } finally {
    console.warn = warn;
    if (savedDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = savedDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(src, /codeagentLaunch && codeagentLaunch\.bypassLaunch\)[\s\S]{0,200}watchBypassWarning\(ptyProcess/);
});

function guardFor(info, frameRef) {
  const writes = [];
  const entry = { pty: {}, info: { id: 's', kind: 'codeagent', agentRuntime: 'pty', status: 'idle', ...info } };
  const manager = { sessions: new Map([['s', entry]]), getSession: () => ({ ...entry.info }), emit() {},
    writeToSession: (_id, d) => { writes.push(d); if (d === '\r') frameRef.lines = IDLE; } };
  const guard = createCodeAgentInputGuard(manager, {
    openScreen: async () => ({ lines: async () => frameRef.lines, dispose() {} }),
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))), diagnose() {}, stopDiagnose() {},
  });
  return { guard, writes };
}

test('a session started in another permission mode never presses keys on the warning and refuses to send', async () => {
  for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
    const { guard, writes } = guardFor({ permissionMode }, { lines: WARNING });
    const result = await guard.check('s');
    assert.strictEqual(result.ok, false, permissionMode);
    assert.strictEqual(result.notSent, true);
    assert.deepStrictEqual(writes, [], permissionMode + ': no keys at all');
  }
  const explicit = guardFor({ permissionMode: 'bypassPermissions' }, { lines: WARNING });
  assert.strictEqual((await explicit.guard.check('s')).ok, true);
  assert.deepStrictEqual(explicit.writes, ['\x1b[B', '\r']);
});

test('warning text left in scrollback above the live input box is not acted on', () => {
  // 框已经点掉、画面滚动后，旧文字还在屏幕上；光标符号在下方输入框里
  const history = [...WARNING.map(line => line.replace('❯', ' ')), '', '● 已完成上一条任务', '', ' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │'];
  assert.strictEqual(detectBypassWarningInLines(history), null);
  // 光标仍在选项上、但下面又有输入框的光标：同样不按
  assert.strictEqual(detectBypassWarningInLines([...WARNING, '❯ ']), null);
  // 两项不相邻、或不在警告字样之后：不按
  const apart = WARNING.slice(); apart.splice(13, 0, '    (something else)');
  assert.strictEqual(detectBypassWarningInLines(apart), null);
  const before = [WARNING[12], WARNING[13], ...WARNING.slice(0, 12)];
  assert.strictEqual(detectBypassWarningInLines(before), null);
});

test('stale warning left on screen above a boxed input that already holds user text is not acted on', () => {
  // 确认后屏幕没清：旧框的「❯ 1. No, exit」还在，下面是公司 CodeAgent 带竖线的输入框，里面有用户打了一半的字。
  // 这时按 Down+Enter 会把用户的文字提交出去，必须不按键。
  const stale = [...WARNING, '', ' │ > 帮我把这段日志整理一下 │', ' │ Bypass (Cycle shift+tab) | GLM │'];
  assert.strictEqual(detectBypassWarningInLines(stale), null);
  const staleCursor = [...WARNING, '', ' │ ❯ 帮我把这段日志整理一下 │'];
  assert.strictEqual(detectBypassWarningInLines(staleCursor), null);
  // 对照：框下面只有状态栏（不是输入框行）时照常认出
  assert.deepStrictEqual(detectBypassWarningInLines([...WARNING, ' │ Bypass (Cycle shift+tab) | GLM │']).keys, ['\x1b[B', '\r']);
});

test('in-place relaunch of a CodeAgent bypass session also starts the watcher', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(src, /relaunchBypass = launch\.bypassLaunch === true;/);
  assert.match(src, /if \(relaunchBypass\) require\('\.\/claude-trust-dialog\.js'\)\.watchBypassWarning\(s\.pty/);
});
