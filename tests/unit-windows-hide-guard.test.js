'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scanSource, scanTree } = require('../scripts/check-windows-hide');
const cp = "const { spawn, execFile: execute } = require('node:child_process');\n";

test('运行时 child_process 调用隐藏终端；主动打开的 GUI 有精确登记', () => {
  assert.deepEqual(scanTree(path.resolve(__dirname, '..')), []);
});
test('扫描器逐次检查调用，识别别名、单独的选项和展开；注释中的开关无效', () => {
  assert.equal(scanSource(cp + "spawn('cmd.exe', [], {}); // windowsHide: true").length, 1);
  assert.equal(scanSource(cp + "execute('cmd.exe', [], { windowsHide: false }, done)").length, 1);
  assert.equal(scanSource(cp + "spawn('cmd.exe', [], { windowsHide: true }); spawn('cmd.exe', []);").length, 1);
  assert.equal(scanSource(cp + "const opts={windowsHide:true}; spawn('cmd.exe', [], {...opts, env});").length, 0);
  assert.equal(scanSource(cp + "const opts={env}; spawn('cmd.exe', [], opts);").length, 1);
  assert.equal(scanSource("const {fork}=require('child_process'); fork('job.js', [], {});").length, 1);
});

test('撤掉本轮各处隐藏开关时，静态守卫逐文件报错', () => {
  const fs = require('node:fs');
  for (const file of ['core/off-main-exec.js', 'core/network-egress-monitor.js', 'core/cli-tools/installer.js',
    'core/codeagent-serve.js', 'core/company-assistant/ppt-map-model.js', 'core/owned-process.js', 'scripts/publish-release-assets.js']) {
    // Some distributions intentionally omit optional modules.
    const full = path.join(__dirname, '..', file);
    if (!fs.existsSync(full)) continue;
    const reverted = fs.readFileSync(full, 'utf8').replace(/windowsHide\s*:\s*true/g, 'windowsHide:false');
    assert.ok(scanSource(reverted, file).length > 0, file);
  }
});

test('off-main 的工作线程不可用时，兜底也强制隐藏控制台', async () => {
  const { createOffMainExecFile } = require('../core/off-main-exec');
  let got;
  const exec = createOffMainExecFile({ WorkerImpl: class { constructor() { throw Error('no worker'); } },
    fallback: (_file, _args, options, cb) => { got = options; cb(null, 'ok', ''); } });
  await exec('cmd.exe', [], { windowsHide: false });
  assert.equal(got.windowsHide, true);
});

test('主进程的桌面卡、Windows toast、托盘气球共用关闭通知策略，仍保留要紧提醒', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const fn = source.match(/function desktopNoticesAllowed\(payload = \{\}\) \{[\s\S]*?\n\}/)[0];
  const context = { require: id => require(path.join(__dirname, '..', id)), hubPetController: { getSettings: () => ({ notifyMode: 'off' }) } };
  vm.createContext(context); vm.runInContext(fn, context);
  assert.equal(context.desktopNoticesAllowed({}), false);
  assert.equal(context.desktopNoticesAllowed({ tone: 'bad' }), true);
  assert.equal(context.desktopNoticesAllowed({ kind: 'reminder' }), true);
  context.hubPetController.getSettings = () => ({ notifyMode: 'pet' });
  assert.equal(context.desktopNoticesAllowed({}), true);
  assert.match(source, /canNotify: \(\) => desktopNoticesAllowed\(\)/);
  assert.match(source, /canShow: payload => desktopNoticesAllowed\(payload\)/);
  assert.match(source, /if \(desktopNoticesAllowed\(\{ tone: r.state[\s\S]*?new \(require\('electron'\).Notification\)/);
});
