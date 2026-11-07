'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLiteralLocalPath, _cleanPathCandidate } = require('../renderer/path-candidates.js');

test('A2-14 名字带 %xx 的文件按原样打开，不被解码成另一个路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-pct-'));
  try {
    for (const name of ['%E6%8A%A5%E5%91%8A.pdf', 'a%20b.md', '进度100%25.md']) {
      const real = path.join(dir, name);
      fs.writeFileSync(real, 'x');
      assert.equal(resolveLiteralLocalPath(real), real, name);
      assert.equal(resolveLiteralLocalPath(name, dir), real, name + ' (相对)');
    }
    assert.equal(resolveLiteralLocalPath(path.join(dir, 'nope.md')), null);
    assert.equal(resolveLiteralLocalPath('https://example.com/a.md'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A2-14 目录名以 ) ! ] 结尾时原样存在即可打开；括号成对不被剥掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-par-'));
  try {
    for (const name of ['方案(终版)', '重要!', 'data]']) {
      const real = path.join(dir, name);
      fs.mkdirSync(real);
      assert.equal(resolveLiteralLocalPath(real), real, name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(_cleanPathCandidate('D:\\x\\方案(终版)'), 'D:\\x\\方案(终版)');
  assert.equal(_cleanPathCandidate('(见 D:\\x\\a.md)'), '见 D:\\x\\a.md');
  assert.equal(_cleanPathCandidate('D:\\x\\a.md).'), 'D:\\x\\a.md');
  assert.equal(_cleanPathCandidate('"D:\\x\\a.md",'), 'D:\\x\\a.md');
});

test('A2-15 复制文件：路径经环境变量 JSON 传入，不拼进命令串', { skip: process.platform !== 'win32' }, async () => {
  const { registerFileManagerIpc } = require('../main/ipc/file-manager-handlers.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-clip-'));
  const evil = 'John\u2019s report.txt';
  fs.writeFileSync(path.join(dir, evil), 'x');
  const calls = [];
  const handlers = new Map();
  registerFileManagerIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    electron: { clipboard: {}, nativeImage: {}, shell: {} },
    dataDir: dir,
    execFile: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '' }; },
  });
  try {
    const result = await handlers.get('file-manager:copy')({}, { root: dir, kind: 'files', paths: [path.join(dir, evil)] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    const command = calls[0].args[calls[0].args.length - 1];
    assert.ok(!command.includes(evil) && !command.includes('\u2019'), '命令串里不应出现文件名');
    assert.deepEqual(JSON.parse(calls[0].options.env.HUB_CLIP_PATHS), [path.join(dir, evil)]);
    assert.equal(calls[0].options.windowsHide, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
