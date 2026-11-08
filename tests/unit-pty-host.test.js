'use strict';
// core/pty-host.js：Windows 上优先用 node-pty 自带的 ConPTY，失败退回系统 ConPTY。
// 背景（2026-11-07 本机实测，Windows 11 26200）：系统 ConPTY 把送进 CLI 的引号、破折号、省略号、箭头、
// ①、× ± °、表情等符号直接丢掉，1667 个测试字符丢 1197 个；自带 ConPTY 不丢。
// 真机探针：用 Electron 当 node 跑 node-pty，分别以 useConptyDll false/true 拉起一个逐字回显码位的
// python 小程序，括号粘贴同一串字符后比对（比对脚本不进仓库，结论记在 core/pty-host.js 头注释）。
const test = require('node:test');
const assert = require('node:assert');
const host = require('../core/pty-host');

function fakePty({ failDll = false } = {}) {
  const calls = [];
  return {
    calls,
    spawn(file, args, options) {
      calls.push(options);
      if (failDll && options.useConptyDll) throw new Error('Cannot find conpty.dll');
      return { pid: 1, options };
    },
  };
}

const onWindows = process.platform === 'win32' && !!host.bundledConptyDir();

test('Windows ConPTY sessions use the bundled ConPTY when it ships with node-pty', { skip: !onWindows }, () => {
  const pty = fakePty();
  host.spawnPty(pty, 'powershell.exe', [], { useConpty: true, cols: 80, rows: 20 });
  assert.strictEqual(pty.calls.length, 1);
  assert.strictEqual(pty.calls[0].useConptyDll, true);
  assert.strictEqual(pty.calls[0].cols, 80);
});

test('falls back to the system ConPTY when the bundled one cannot start', { skip: !onWindows }, () => {
  const pty = fakePty({ failDll: true });
  const warn = console.warn; console.warn = () => {};
  try {
    const proc = host.spawnPty(pty, 'powershell.exe', [], { useConpty: true });
    assert.strictEqual(pty.calls.length, 2);
    assert.ok(!proc.options.useConptyDll, 'second attempt uses the original options');
  } finally { console.warn = warn; host._resetForTest(); }
});

test('AI_HUB_PTY_HOST=system and useConpty:false keep the original options', () => {
  const pty = fakePty();
  const saved = process.env.AI_HUB_PTY_HOST;
  process.env.AI_HUB_PTY_HOST = 'system';
  try { host.spawnPty(pty, 'x', [], { useConpty: true }); } finally {
    if (saved === undefined) delete process.env.AI_HUB_PTY_HOST; else process.env.AI_HUB_PTY_HOST = saved;
  }
  host.spawnPty(pty, 'x', [], { useConpty: false });
  assert.ok(pty.calls.every(options => !('useConptyDll' in options)));
});

test('every PTY launch site goes through pty-host', () => {
  const fs = require('fs'), path = require('path');
  for (const file of ['core/session-manager.js', 'core/dsh-cli-session.js', 'core/qwen-cli-session.js', 'core/martty-cli-session.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // 拼接写法：避免导出器的相对引用检查把这条字符串当成 tests/ 下的 require。
    assert.ok(src.includes(['require(', "'./pty-host'", ').spawnPty('].join('')), file + ' uses spawnPty');
    assert.ok(!/require\('node-pty'\)\.spawn\(|\bpty\.spawn\(/.test(src.replace(/^\s*\/\/.*$/gm, '')), file + ' has no direct node-pty spawn');
  }
});
