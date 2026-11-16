'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { validateDataRoot } = require('../core/company-assistant/data-root');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-data-root-'));
  const dataDir = path.join(root, 'hub'), target = path.join(root, '新目录 with spaces');
  const base = path.join(dataDir, 'company-assistant');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = () => {
    const a = new CompanyAssistant({ dataDir, noTools: true, noTimer: true, bus: { latest: () => [] }, welinkRun: async () => ({ code: 0, stdout: '{}' }), getSession: () => null });
    a.cli = () => ''; a.changed = () => {};
    return a;
  };
  return { root, dataDir, target, base, make };
}
test('默认路径保持不变；保存目录不热切换，重启后全部路径统一且设置留在默认目录', t => {
  const { make, base, target } = fixture(t), a = make();
  assert.equal(a.dir, base);
  a.setSettings({ dataRoot: target, email: 'fixture@example.test' });
  assert.equal(a.dir, base);
  assert.equal(a.status().dataDirectory.restartRequired, true);
  const b = make();
  assert.equal(b.dir, target);
  assert.equal(b.workspace, path.join(target, 'workspace'));
  assert.equal(b.pptWorkspace, path.join(target, 'ppt-workspace'));
  assert.equal(b.meetings.root, path.join(target, 'workspace', 'meetings'));
  assert.ok(b.archive.root('fixture').startsWith(path.join(target, 'archive') + path.sep));
  assert.equal(b.file('settings.json'), path.join(base, 'settings.json'));
  b.setSettings({ myName: '测试' });
  assert.equal(b.settings().email, 'fixture@example.test');
  assert.equal(fs.existsSync(path.join(target, 'settings.json')), false);
  assert.equal(b.status().dataDirectory.restartRequired, false);
});
test('首次复制所有旧数据但不删源文件；只重写托管的 cliPath；再次启动不覆盖目标数据', t => {
  const { make, base, target } = fixture(t), a = make();
  for (const name of ['chat.json', 'state.json', 'archive/a/messages.jsonl', 'workspace/meetings/m/transcript.txt', 'ppt-workspace/material.txt', 'tools/welink-cli/welink-cli.exe', 'diag/error.log', 'metering-1.jsonl']) {
    const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  a.setSettings({ dataRoot: target, cliPath: path.join(base, 'tools/welink-cli/welink-cli.exe') });
  const b = make();
  for (const name of fs.readdirSync(base).filter(n => n !== 'settings.json')) {
    assert.ok(fs.existsSync(path.join(target, name))); assert.ok(fs.existsSync(path.join(base, name)));
  }
  assert.equal(b.settings().cliPath, path.join(target, 'tools/welink-cli/welink-cli.exe'));
  b.write('chat.json', ['new']);
  assert.deepEqual(make().chat(), ['new']);
});
test('第二次换目录从当前目录复制；外部 CLI 路径不改；恢复默认只在重启生效', t => {
  const { make, root, base, target } = fixture(t), a = make();
  const external = path.join(root, 'external.exe');
  a.setSettings({ dataRoot: target, cliPath: external });
  const b = make(); b.write('chat.json', ['current']);
  const next = path.join(root, 'next'); b.setSettings({ dataRoot: next });
  const c = make(); assert.deepEqual(c.chat(), ['current']); assert.equal(c.settings().cliPath, external);
  c.setSettings({ dataRoot: '' }); assert.equal(c.dir, next);
  const d = make(); assert.equal(d.dir, base); assert.deepEqual(d.chat(), ['current']);
});
test('目标已有助理数据时直接使用，不覆盖；设置始终使用默认位置的版本', t => {
  const { make, target } = fixture(t), a = make(); a.write('chat.json', ['old']);
  a.setSettings({ dataRoot: target, myName: 'default-settings' });
  fs.writeFileSync(path.join(target, 'chat.json'), JSON.stringify(['target']));
  fs.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ myName: 'wrong' }));
  const b = make(); assert.deepEqual(b.chat(), ['target']); assert.equal(b.settings().myName, 'default-settings');
});
test('相对路径、非字符串、嵌套目录、文件和不可写目录被拒绝，设置不变', t => {
  const { make, root, base, target } = fixture(t), a = make(); a.write('chat.json', []);
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'x');
  for (const invalid of ['relative', 123, path.join(base, 'nested'), root, file]) assert.throws(() => a.setSettings({ dataRoot: invalid }));
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => { if (String(file).includes('.write-check-')) throw new Error('EACCES fixture'); return write(file, ...args); });
  assert.throws(() => a.setSettings({ dataRoot: target }), /不可写/);
  assert.equal(a.settings().dataRoot, '');
});
test('junction 指向默认目录及其子目录时拒绝，防止绕过嵌套检查', t => {
  const { root, base } = fixture(t); fs.mkdirSync(base, { recursive: true });
  const alias = path.join(root, 'alias'); fs.symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateDataRoot(path.join(alias, 'child'), base), /互相包含/);
});
test('复制中断退回默认目录并显示原因；下一次启动重试完整复制', t => {
  const { make, base, target } = fixture(t), a = make(); a.write('chat.json', ['old']); a.write('state.json', { done: {} });
  a.setSettings({ dataRoot: target });
  const copy = fs.copyFileSync; let count = 0;
  const mock = t.mock.method(fs, 'copyFileSync', (...args) => { if (++count === 2) throw new Error('ENOSPC fixture'); return copy(...args); });
  const b = make(); assert.equal(b.dir, base); assert.match(b.status().dataDirectory.error, /ENOSPC/);
  assert.ok(fs.existsSync(path.join(target, '.data-root-migration.json')));
  mock.mock.restore();
  const c = make(); assert.equal(c.dir, target); assert.deepEqual(c.chat(), ['old']);
  assert.ok(fs.existsSync(path.join(target, 'state.json')));
  assert.equal(fs.existsSync(path.join(target, '.data-root-migration.json')), false);
});
test('启动时重新校验目录，非法持久设置回退默认且提供可见错误', t => {
  const { make, base } = fixture(t); const a = make(); a.write('settings.json', { dataRoot: 'relative' });
  const b = make(); assert.equal(b.dir, base); assert.match(b.status().dataDirectory.error, /绝对路径/);
});
test('目标只有无关文件时仍复制助理数据，并保留无关文件', t => {
  const { make, target } = fixture(t), a = make(); a.write('chat.json', ['old']); a.setSettings({ dataRoot: target });
  fs.writeFileSync(path.join(target, 'readme.txt'), 'unrelated');
  const b = make(); assert.deepEqual(b.chat(), ['old']); assert.equal(fs.readFileSync(path.join(target, 'readme.txt'), 'utf8'), 'unrelated');
});
test('选择文件夹 IPC 使用系统目录选择器；取消不保存，选中后校验并仅保存设置', async t => {
  const { make, target, base } = fixture(t), a = make();
  const Module = require('node:module'), original = Module._load, handlers = new Map();
  let result = { canceled: true, filePaths: [] }, options;
  t.mock.method(Module, '_load', function(name, ...args) {
    if (name === 'electron') return { BrowserWindow: { getFocusedWindow: () => null }, dialog: { showOpenDialog: async (_window, opts) => { options = opts; return result; } } };
    return original.call(this, name, ...args);
  });
  require('../main/ipc/company-assistant-handlers').registerCompanyAssistantIpc({ handle: (key, fn) => handlers.set(key, fn) }, a);
  const pick = handlers.get('company-assistant:pick-data-root');
  assert.equal((await pick(null)).canceled, true); assert.equal(a.settings().dataRoot, '');
  assert.deepEqual(options.properties, ['openDirectory', 'createDirectory']);
  result = { canceled: false, filePaths: [target] };
  assert.equal((await pick(null)).ok, true); assert.equal(a.settings().dataRoot, target); assert.equal(a.dir, base);
  result = { canceled: false, filePaths: ['relative'] };
  assert.equal((await pick(null)).ok, false); assert.equal(a.settings().dataRoot, target);
});
test('生成的 PPT 和评测包装同时传递新数据目录和默认设置文件', t => {
  const { make, base, target } = fixture(t), a = make(); a.setSettings({ dataRoot: target });
  const b = make(); b.prepareWorkspace();
  for (const file of [path.join(b.workspace, 'assistant-bench.cmd'), path.join(b.pptWorkspace, 'ppt-ro.cmd')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('CLAUDE_HUB_ASSISTANT_DIR=' + target));
    assert.ok(text.includes('CLAUDE_HUB_ASSISTANT_SETTINGS=' + path.join(base, 'settings.json')));
  }
});
test('实际 Electron 运行时可在中文目录覆盖半份数据并完成迁移重试', { skip: process.platform !== 'win32' }, t => {
  const { make, base, target } = fixture(t), a = make();
  a.write('chat.json', ['complete']); a.setSettings({ dataRoot: target });
  fs.writeFileSync(path.join(target, 'chat.json'), '["partial"]');
  fs.writeFileSync(path.join(target, '.data-root-migration.json'), JSON.stringify({ source: base }));
  const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
  for (const root of [base, target]) fs.mkdirSync(path.join(root, 'archive', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(base, 'archive', 'nested', 'binary.dat'), binary);
  fs.writeFileSync(path.join(target, 'archive', 'nested', 'binary.dat'), 'partial');
  const script = `const assert=require('node:assert/strict');const {prepareDataRoot}=require(${JSON.stringify(require.resolve('../core/company-assistant/data-root'))});const r=prepareDataRoot(${JSON.stringify(base)});assert.equal(r.error,'');assert.equal(r.dir,${JSON.stringify(target)});`;
  const executable = process.versions.electron ? process.execPath : require('electron');
  const r = require('node:child_process').spawnSync(executable, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 0, `Electron migration failed: ${r.error?.message || r.stderr}; signal=${r.signal}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'chat.json'), 'utf8')), ['complete']);
  assert.deepEqual(fs.readFileSync(path.join(target, 'archive', 'nested', 'binary.dat')), binary);
  assert.deepEqual(fs.readFileSync(path.join(base, 'archive', 'nested', 'binary.dat')), binary);
  assert.equal(fs.existsSync(path.join(target, '.data-root-migration.json')), false);
});
