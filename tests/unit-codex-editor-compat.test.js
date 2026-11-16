'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureCodexEditorInput } = require('../core/codex-editor-input');

test('超出实测范围的 Codex 先尝试 Ctrl+G，无响应才退回普通粘贴', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_HOME: root, VISUAL: 'user-editor' };
  const channel = configureCodexEditorInput(env, { dataDir: root, cwd: root, platform: 'win32',
    capabilities: { tested: false, version: '0.999.0', compatibilityNotice: 'CLI 版本 0.999.0 未经测试，已用兼容方式启动' } });
  t.after(() => channel.dispose());
  assert.equal(channel.untested, true);
  const writes = [], text = 'x'.repeat(2200);
  assert.equal(await channel.load(text, data => writes.push(data), { startupMs: 30 }), false);
  assert.deepEqual(writes, ['\x07']);
  assert.equal(channel.failed, false);
  assert.equal(fs.existsSync(path.join(channel.directory, 'request.json')), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(channel.directory, 'cancelled.json'), 'utf8')).id);
});

test('超出实测范围但能交接的 Codex 仍用外部编辑器，不退回普通粘贴', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-success-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = configureCodexEditorInput({ CODEX_HOME: root }, { dataDir: root, cwd: root, platform: 'win32', capabilities: { tested: false } });
  t.after(() => channel.dispose());
  const text = 'x'.repeat(2200), writes = [];
  assert.equal(await channel.load(text, data => {
    writes.push(data);
    const request = JSON.parse(fs.readFileSync(path.join(channel.directory, 'request.json'), 'utf8'));
    fs.unlinkSync(path.join(channel.directory, 'request.json'));
    fs.writeFileSync(path.join(channel.directory, 'receipt.json'), JSON.stringify({ id: request.id, ok: true, digest: request.digest }));
    channel.onOutput('\x1b[?2004l\x1b[?2004h\x1b[?2026l');
  }, { startupMs: 100, timeoutMs: 100 }), true);
  assert.deepEqual(writes, ['\x07']);
  assert.equal(channel.lastTransfer.chars, text.length);
});

test('Codex 已进入编辑器而未确认恢复时不得重复粘贴', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-engaged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = configureCodexEditorInput({ CODEX_HOME: root }, { dataDir: root, cwd: root, platform: 'win32', capabilities: { tested: false } });
  t.after(() => channel.dispose());
  await assert.rejects(channel.load('x'.repeat(2200), () => channel.onOutput('\x1b[?2004l'), { timeoutMs: 30 }), { notSent: true });
  assert.equal(channel.failed, true);
});

test('超时取消瞬间 helper 抢先接管请求时不得退回重复粘贴', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = configureCodexEditorInput({ CODEX_HOME: root }, { dataDir: root, cwd: root, platform: 'win32', capabilities: { tested: false } });
  t.after(() => channel.dispose());
  const cancel = channel.cancel.bind(channel);
  channel.cancel = id => {
    fs.renameSync(path.join(channel.directory, 'request.json'), path.join(channel.directory, 'active.json'));
    cancel(id);
  };
  await assert.rejects(channel.load('x'.repeat(2200), () => {}, { startupMs: 30 }), { notSent: true });
  assert.equal(channel.failed, true);
});

for (const tested of [null, true]) {
  test(`探测${tested === null ? '失败' : '通过'}的 Codex 保留既有外部编辑器通道及清理行为`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-editor-compat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { CODEX_HOME: root, VISUAL: 'user-editor' };
    const channel = configureCodexEditorInput(env, { dataDir: root, cwd: root, platform: 'win32', capabilities: { tested } });
    assert.ok(channel);
    assert.equal(JSON.parse(fs.readFileSync(path.join(channel.directory, 'session.json'), 'utf8')).visual, 'user-editor');
    assert.match(env.VISUAL, /editor\.cmd/);
    channel.dispose();
    assert.equal(fs.existsSync(channel.directory), false);
  });
}

test('APPDATA npm 与 PATH native 并存时，PTY 路径绑定被探测的 npm 安装', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-selected-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appdata = path.join(root, 'appdata'), other = path.join(root, 'native');
  const shimDir = path.join(appdata, 'npm');
  fs.mkdirSync(shimDir, { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(path.join(shimDir, 'codex.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(other, 'codex.exe'), 'native');
  const env = { APPDATA: appdata, PATH: other };
  const commands = require('../main/codex-windows-command');
  const selected = commands.locateWindowsCodex(env);
  assert.equal(selected.kind, 'npm');
  assert.equal(commands.ensureCodexOnSessionPath(env), true);
  const ptySelection = commands.locateWindowsCodex({ PATH: env.PATH });
  assert.equal(ptySelection.shim, selected.shim);
  assert.equal(env.PATH.split(path.delimiter)[0], shimDir);
});
