'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const caps = require('../core/codeagent-capabilities');

const HELP = 'Usage: codeagent\n  --model <id>\n  --resume [id]\n';
const FULL = ['--model', 'm', '--disable-update', '--effort', 'high'];

function fakeCli(t, content = 'one') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'codeagent.cmd');
  fs.writeFileSync(file, content);
  return file;
}
// 模拟异步 CLI。delays 让测试决定回调何时到；calls 记录真正起了几个进程。
function fakeExec(outputs, calls = [], { hold = false } = {}) {
  const releases = [];
  const exec = (file, args, opts, callback) => {
    const flag = String(args.at(-1)).split(' ').at(-1);
    calls.push({ file, flag, windowsHide: opts.windowsHide });
    const child = new EventEmitter();
    child.pid = 4242;
    const reply = () => {
      const out = outputs[flag];
      if (out === undefined) callback(Object.assign(new Error('fail'), { code: 1 }), '', '');
      else callback(null, out, '');
    };
    if (hold) releases.push(reply); else setImmediate(reply);
    return child;
  };
  return { exec, releases };
}
// 模拟同步 CLI：同步入口的判定结果作为对照基准。
const fakeRun = outputs => (file, args) => {
  const flag = String(args.at(-1)).split(' ').at(-1);
  return outputs[flag] === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: outputs[flag] };
};

for (const [label, outputs, expected] of [
  ['旧版过滤帮助里没有的参数', { '--version': '1.2605.05.01\n', '--help': HELP }, ['--model', 'm']],
  ['1.2615 及以上原样', { '--version': '1.2615.0.0\n', '--help': HELP }, FULL],
  ['版本读不到原样', { '--help': HELP }, FULL],
  ['旧版但帮助读不到原样', { '--version': '1.2605.05.01\n' }, FULL],
  ['旧版但帮助不像 CodeAgent 原样', { '--version': '1.2605.05.01\n', '--help': 'garbage\n' }, FULL],
]) {
  test(`异步探测与同步入口判定一致：${label}`, async t => {
    const command = fakeCli(t);
    caps._helpCache.clear();
    const calls = [];
    await caps.prepare(command, { exec: fakeExec(outputs, calls).exec, platform: 'win32' });
    assert.ok(calls.length >= 1 && calls.every(call => call.windowsHide === true), '探测进程隐藏窗口');
    const noRun = () => { throw new Error('prepare 之后不应再同步起进程'); };
    const afterPrepare = caps.filterArgs(FULL, caps.readHelp(command, { run: noRun, platform: 'win32' }));
    caps._helpCache.clear();
    const synchronous = caps.filterArgs(FULL, caps.readHelp(command, { run: fakeRun(outputs), platform: 'win32' }));
    assert.deepEqual(afterPrepare.args, expected);
    assert.deepEqual(afterPrepare, synchronous);
  });
}

test('并发建会话共用一次探测', async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  const calls = [];
  const { exec } = fakeExec({ '--version': '1.2605.05.01\n', '--help': HELP }, calls);
  await Promise.all([1, 2, 3, 4, 5].map(() => caps.prepare(command, { exec, platform: 'win32' })));
  assert.deepEqual(calls.map(call => call.flag), ['--version', '--help']);
  await caps.prepare(command, { exec, platform: 'win32' });
  assert.equal(calls.length, 2, '热缓存不再起进程');
});

test('程序文件被替换后立即重新探测，6 小时内容不变则不重探', async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  const calls = [];
  await caps.prepare(command, { exec: fakeExec({ '--version': '1.2605.05.01\n', '--help': HELP }, calls).exec, platform: 'win32' });
  assert.notEqual(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '');
  fs.writeFileSync(command, 'upgraded-binary');
  await caps.prepare(command, { exec: fakeExec({ '--version': '1.2615.0.0\n' }, calls).exec, platform: 'win32' });
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '', '升级后不再过滤');
  assert.deepEqual(calls.map(call => call.flag), ['--version', '--help', '--version']);
});

test('6 小时到期重新探测', async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  const calls = [];
  const { exec } = fakeExec({ '--version': '1.2615.0.0\n' }, calls);
  let now = 1000;
  await caps.prepare(command, { exec, platform: 'win32', now: () => now });
  now += 6 * 3600 * 1000 - 1;
  await caps.prepare(command, { exec, platform: 'win32', now: () => now });
  assert.equal(calls.length, 1);
  now += 1;
  await caps.prepare(command, { exec, platform: 'win32', now: () => now });
  assert.equal(calls.length, 2);
});

test('探测途中程序被替换：旧探测晚到不覆盖新结果', async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  const older = fakeExec({ '--version': '1.2605.05.01\n', '--help': HELP }, [], { hold: true });
  const first = caps.prepare(command, { exec: older.exec, platform: 'win32' });
  await new Promise(setImmediate);
  fs.writeFileSync(command, 'upgraded-binary');
  await caps.prepare(command, { exec: fakeExec({ '--version': '1.2615.0.0\n' }).exec, platform: 'win32' });
  older.releases.shift()();
  await new Promise(setImmediate);
  older.releases.shift()?.();
  await first;
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '');
});

test('没走 prepare 的入口仍同步探测，结果写入缓存', t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  let runs = 0;
  const run = (...args) => { runs++; return fakeRun({ '--version': '1.2605.05.01\n', '--help': HELP })(...args); };
  assert.equal(caps.readHelp(command, { run, platform: 'win32' }), HELP);
  assert.equal(caps.readHelp(command, { run, platform: 'win32' }), HELP);
  assert.equal(runs, 2, '--version 和 --help 各一次');
});

test('命令找不到时探测失败按原样启动，装上后马上重探', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = path.join(dir, 'codeagent.cmd');
  caps._helpCache.clear();
  const calls = [];
  await caps.prepare(command, { exec: fakeExec({}, calls).exec, platform: 'win32' });
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '');
  fs.writeFileSync(command, 'installed');
  await caps.prepare(command, { exec: fakeExec({ '--version': '1.2605.05.01\n', '--help': HELP }, calls).exec, platform: 'win32' });
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), HELP);
});

test('启动命令抛错时 prepare 不 reject，按原样启动', async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  await caps.prepare(command, { exec: () => { throw new Error('spawn EPERM'); }, platform: 'win32' });
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '');
});

test('子进程占着管道不回调时 4 秒放行并结束进程树', { timeout: 12000 }, async t => {
  const command = fakeCli(t);
  caps._helpCache.clear();
  const killed = [];
  const { exec } = fakeExec({}, [], { hold: true });
  // 产品里的计时器不阻止进程退出；模拟子进程又没有真实句柄，这里要自己撑住事件循环。
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const started = Date.now();
  await caps.prepare(command, { exec, platform: 'win32', kill: child => killed.push(child.pid) });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 3900 && elapsed < 6000, `耗时 ${elapsed}ms`);
  assert.deepEqual(killed, [4242]);
  assert.equal(caps.readHelp(command, { run: () => { throw new Error('no'); }, platform: 'win32' }), '', '超时按读不到处理，原样启动');
});

test('prepareForKind 只处理 CodeAgent', async () => {
  caps._helpCache.clear();
  await caps.prepareForKind('claude', { exec: () => { throw new Error('不应探测'); } });
  await caps.prepareForKind('powershell', { exec: () => { throw new Error('不应探测'); } });
  assert.equal(caps._helpCache.size, 0);
});
