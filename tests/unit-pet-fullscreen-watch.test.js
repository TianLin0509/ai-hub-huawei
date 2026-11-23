'use strict';
// 同事反馈回归：前台真实全屏才躲边；切走、退出和检测异常都能回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFullscreenWatch, isFullscreenLine, buildScript } = require('../core/hub-pet/fullscreen-watch');

const FULL = 'F win 0 0 1920 1080 0 0 1920 1080';
const MAXIMIZED = 'F win 0 0 1920 1040 0 0 1920 1080';
function fixture() {
  const changes = [], children = [];
  let timeout;
  const watch = createFullscreenWatch({
    platform: 'win32', foreground: true, onChange: next => changes.push(next), logger: { warn() {} },
    setTimeoutFn: fn => { timeout = fn; return 1; }, clearTimeoutFn: () => { timeout = null; },
    spawnFn: (_cmd, args, options) => {
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('Hidden'));
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      children.push(child); return child;
    },
  });
  return { watch, changes, children, line: s => children.at(-1).stdout.emit('data', Buffer.from(s + '\r\n')), expire: () => timeout() };
}

test('进入全屏躲边，重复读数不重复通知；退出、切到普通窗口或桌面后恢复', () => {
  for (const exit of [MAXIMIZED, 'F win 300 100 1000 700 0 0 1920 1080', 'F desk']) {
    const f = fixture(); f.watch.start();
    f.line(MAXIMIZED); assert.equal(f.watch.isFullscreen(), false);
    f.line(FULL); f.line(FULL); assert.equal(f.watch.isFullscreen(), true);
    f.line(exit); assert.equal(f.watch.isFullscreen(), false);
    assert.deepEqual(f.changes, [true, false]); f.watch.stop();
  }
});

test('完整显示器边界支持副屏负坐标与 DPI 物理像素；工作区最大化、跨屏大窗都不算', () => {
  assert.equal(isFullscreenLine('F win -2560 0 0 1440 -2560 0 0 1440'), true);
  assert.equal(isFullscreenLine('F win 0 0 3840 2160 0 0 3840 2160'), true);
  assert.equal(isFullscreenLine('F win 1 0 1919 1080 0 0 1920 1080'), true);
  assert.equal(isFullscreenLine(MAXIMIZED), false);
  assert.equal(isFullscreenLine('F win -8 -8 1928 1048 0 0 1920 1080'), false);
  assert.equal(isFullscreenLine('F win 0 0 3840 1080 0 0 1920 1080'), false);
});

test('读取失败、坏数据和旧通知状态都默认不躲，下一轮成功后仍能检测', () => {
  const f = fixture(); f.watch.start();
  for (const bad of ['F unknown', 'F win 0 0 1920 NaN 0 0 1920 1080', 'F win 0 0 0 0 0 0 1920 1080', 'F win 0 0', '2', '3', '4', '', 'error']) {
    f.line(FULL); f.line(bad); assert.equal(f.watch.isFullscreen(), false, bad);
  }
  f.line(FULL); assert.equal(f.watch.isFullscreen(), true); f.watch.stop();
});

test('子进程出错、退出、无响应和主动停止均恢复；旧进程迟到的读数不会影响重启', () => {
  for (const fail of [f => f.children[0].emit('error', new Error('读数失败')), f => f.children[0].emit('exit', 1), f => f.expire(), f => f.watch.stop()]) {
    const f = fixture(); f.watch.start(); f.line(FULL); fail(f);
    assert.equal(f.watch.isFullscreen(), false); assert.deepEqual(f.changes, [true, false]); f.watch.stop();
  }
  const f = fixture(); f.watch.start(); const old = f.children[0]; f.line(FULL); f.watch.stop(); f.watch.start();
  old.stdout.emit('data', Buffer.from(FULL + '\n')); old.emit('exit', 0);
  assert.equal(f.watch.isFullscreen(), false); assert.equal(f.watch.isRunning(), true);
  // stdout 会分块，前台避让读数与全屏判断共用进程但互不干扰。
  const child = f.children.at(-1); child.stdout.emit('data', Buffer.from(FULL.slice(0, 15)));
  assert.equal(f.watch.isFullscreen(), false);
  child.stdout.emit('data', Buffer.from(FULL.slice(15) + '\nW win 100 50 900 700\n'));
  assert.equal(f.watch.isFullscreen(), true); assert.deepEqual(f.watch.foreground().rect, { x: 100, y: 50, width: 800, height: 650 });
  f.watch.stop(); assert.equal(f.watch.foreground(), null);
});

test('无法启动检测或非 Windows 时不躲；脚本不再查询通知状态', () => {
  const watch = createFullscreenWatch({ platform: 'win32', spawnFn() { throw new Error('禁止创建进程'); }, logger: { warn() {} } });
  assert.equal(watch.start(), false); assert.equal(watch.isFullscreen(), false);
  assert.equal(createFullscreenWatch({ platform: 'linux' }).start(), false);
  const script = buildScript(1, 3, { foreground: true });
  assert.doesNotMatch(script, /SHQueryUserNotificationState/);
  assert.match(script, /GetForegroundWindow/); assert.match(script, /GetMonitorInfo/);
});
