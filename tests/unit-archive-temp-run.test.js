'use strict';
// core/archive-temp-run.js + core/pty-host.js：在压缩包里直接运行、终端原生模块缺失时说人话。
// 样本来自 2026-11-20 一键反馈（v5.6.65）：程序跑在 WinRAR 临时目录，会话恢复报
// Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64。
const test = require('node:test');
const assert = require('node:assert');
const run = require('../core/archive-temp-run');
const host = require('../core/pty-host');

const RAW = "Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: Error: Cannot find module './prebuilds/win32-x64/conpty.node'";

test('recognises the temp folders archive tools run programs from', () => {
  const cases = {
    'C:\\Users\\u\\AppData\\Local\\Temp\\Rar$EXa48360.28580.rartemp\\AI Hub Community.exe': 'WinRAR',
    'C:\\Users\\u\\AppData\\Local\\Temp\\Rar$EXa48360.28580.rartemp\\AI Hub Community\\AI Hub Community.exe': 'WinRAR',
    'C:\\Users\\u\\AppData\\Local\\Temp\\7zO4F2C1A3B\\AI Hub Community.exe': '7-Zip',
    'C:\\Users\\u\\AppData\\Local\\Temp\\Temp1_AIHubHuawei-5.6.65-win-x64.zip\\AI Hub Community.exe': 'Windows 资源管理器',
    'C:\\Users\\u\\AppData\\Local\\Temp\\BNZ.6738a1b2c3\\AI Hub Community.exe': 'Bandizip',
  };
  for (const [exe, tool] of Object.entries(cases)) assert.strictEqual(run.detectArchiveTempRun(exe)?.tool, tool, exe);
  assert.match(run.detectArchiveTempRun(Object.keys(cases)[0]).dir, /Rar\$EXa48360\.28580\.rartemp$/);
});

test('normal install folders are not flagged', () => {
  for (const exe of ['D:\\AIHub\\AI Hub Community\\AI Hub Community.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\AI Hub Community\\AI Hub Community.exe',
    'C:\\Users\\u\\AppData\\Local\\Temp\\AI Hub Community.exe', 'D:\\Rar\\7zip\\AI Hub Community.exe', ''])
    assert.strictEqual(run.detectArchiveTempRun(exe), null, exe);
});

test('native load failure from an archive temp folder tells the user to unzip first', () => {
  const msg = run.nativeLoadMessage(new Error(RAW), { execPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\Rar$EXa1.2.rartemp\\AI Hub Community.exe' });
  assert.match(msg, /conpty\.node/);
  assert.match(msg, /WinRAR/);
  assert.match(msg, /解压/);
  assert.doesNotMatch(msg, /Cannot find module/);
});

test('native load failure elsewhere asks for a full reinstall; other errors pass through', () => {
  const msg = run.nativeLoadMessage(new Error(RAW), { execPath: 'D:\\AIHub\\AI Hub Community.exe' });
  assert.match(msg, /完整安装包/);
  assert.strictEqual(run.nativeLoadMessage(new Error('spawn ENOENT')), null);
});

test('pty-host rethrows a missing native module with the plain-language message and keeps the cause', () => {
  const failing = { spawn() { throw new Error(RAW); } };
  const warn = console.warn; console.warn = () => {};
  try {
    assert.throws(() => host.spawnPty(failing, 'powershell.exe', [], { useConpty: false }), error => {
      assert.strictEqual(error.code, 'PTY_NATIVE_MISSING');
      assert.match(error.message, /终端组件 conpty\.node/);
      assert.strictEqual(error.cause.message, RAW);
      return true;
    });
    // 自带 ConPTY 失败、退回系统 ConPTY 仍失败时同样转换
    assert.throws(() => host.spawnPty(failing, 'powershell.exe', [], { useConpty: true }), { code: 'PTY_NATIVE_MISSING' });
    // 其它启动错误原样抛出
    const other = { spawn() { throw new Error('File not found: x.exe'); } };
    assert.throws(() => host.spawnPty(other, 'x.exe', [], { useConpty: false }), /File not found: x\.exe/);
  } finally { console.warn = warn; host._resetForTest(); }
});

test('startup warning only fires for packaged Windows builds in an archive temp folder', async () => {
  const shown = [];
  let quit = 0;
  const app = { isPackaged: true, whenReady: () => Promise.resolve(), quit: () => { quit += 1; } };
  const dialog = { showMessageBox: async options => { shown.push(options); return { response: 0 }; } };
  const exe = 'C:\\Users\\u\\AppData\\Local\\Temp\\Rar$EXa1.2.rartemp\\AI Hub Community.exe';
  assert.strictEqual(run.warnIfRunningFromArchive({ app, dialog, execPath: 'D:\\AIHub\\AI Hub Community.exe' }), null);
  assert.strictEqual(run.warnIfRunningFromArchive({ app, dialog, execPath: exe, isPackaged: false }), null);
  const hit = run.warnIfRunningFromArchive({ app, dialog, execPath: exe });
  if (process.platform !== 'win32') { assert.strictEqual(hit, null); return; }
  assert.strictEqual(hit.tool, 'WinRAR');
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0].detail, /解压/);
  assert.strictEqual(quit, 1, '选「退出」就退出');
});
