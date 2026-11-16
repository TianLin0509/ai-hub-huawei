'use strict';
// 兼容渲染（2026-11-16）：只有打开兼容模式的人才多加参数，默认的同事一个参数都不加。
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { applyGpuMode, COMPAT_SWITCHES, MARKER } = require('../core/gpu-mode.js');

function fakeApp() {
  const switches = [];
  return { switches, disabled: false, disableHardwareAcceleration() { this.disabled = true; },
    commandLine: { appendSwitch(s) { switches.push(s); } }, on() {} };
}
const quiet = { log() {}, warn() {} };

test('默认（没开兼容模式）：不关加速、不加任何参数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-'));
  const app = fakeApp();
  assert.strictEqual(applyGpuMode({ app, env: {}, argv: ['hub.exe'], dataDir: dir, logger: quiet }), null);
  assert.strictEqual(app.disabled, false);
  assert.deepStrictEqual(app.switches, []);
});

for (const [name, opts] of [['环境变量', { env: { AI_HUB_DISABLE_GPU: '1' }, argv: ['hub.exe'] }],
  ['数据目录标记', { env: {}, argv: ['hub.exe'], marker: true }]]) {
  test(`兼容模式（${name}）：关加速并且不起 GPU 子进程，不放开全部沙箱`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-'));
    if (opts.marker) fs.writeFileSync(path.join(dir, MARKER), '{}');
    const app = fakeApp();
    assert.ok(applyGpuMode({ app, env: opts.env, argv: opts.argv, dataDir: dir, logger: quiet }));
    assert.strictEqual(app.disabled, true);
    assert.deepStrictEqual(app.switches, COMPAT_SWITCHES);
    assert.ok(app.switches.includes('disable-software-rasterizer'));
    assert.ok(!app.switches.includes('no-sandbox'));
  });
}

test('命令行已带的参数不重复追加', () => {
  const app = fakeApp();
  applyGpuMode({ app, env: {}, argv: ['hub.exe', '--disable-gpu', '--disable-gpu-compositing'], logger: quiet });
  assert.deepStrictEqual(app.switches, ['disable-software-rasterizer', 'disable-gpu-sandbox']);
});
