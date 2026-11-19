'use strict';
// 2026-11-20 运行时风暴排查第二批：独立审查补点 + 进程表共享采集。
const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetService } = require('../core/avatar/fleet.js');
const { createProcessInspector } = require('../core/process-inspector.js');

function fleetCtx(fail) {
  const calls = [];
  const ctx = {
    t: 1_000_000, hotAt: 0, live: new Map(), readError: '',
    now() { return this.t; }, myName: () => '我', merge() {},
    messages: () => [],
    assistant: () => ({ welink: async (args) => {
      const id = args[3]; calls.push(id);
      return fail.has(id) ? { code: 1, stderr: 'no permission', stdout: '' } : { code: 0, stdout: '{"data":[]}' };
    } }),
  };
  const fleet = { avatars: [{ enabled: true, kind: 'pick', targets: ['bad', 'a', 'b'].map(id => ({ id })) }] };
  const convs = ['bad', 'a', 'b'].map(id => ({ id, group: true, name: id }));
  return { ctx, fleet, convs, calls };
}

test('分身读群：一个群永久读不了不挡住后面的群，也不让整体退避', async () => {
  const { ctx, fleet, convs, calls } = fleetCtx(new Set(['bad']));
  await FleetService.prototype.readHot.call(ctx, '我', fleet, convs);
  assert.deepEqual(calls, ['bad', 'a', 'b']);
  assert.ok(!(ctx.readBackoffUntil > ctx.t), '有群读成功就不退避');
  ctx.t += 30_000; calls.length = 0;
  await FleetService.prototype.readHot.call(ctx, '我', fleet, convs);
  assert.deepEqual(calls.sort(), ['a', 'b', 'bad']);
});

test('分身读群：一轮全部失败才退避，退避期内不再起 welink-cli', async () => {
  const { ctx, fleet, convs, calls } = fleetCtx(new Set(['bad', 'a', 'b']));
  await FleetService.prototype.readHot.call(ctx, '我', fleet, convs);
  assert.equal(calls.length, 3);
  assert.equal(ctx.readBackoffUntil, ctx.t + 60_000);
  ctx.t += 30_000; calls.length = 0;
  await FleetService.prototype.readHot.call(ctx, '我', fleet, convs);
  assert.equal(calls.length, 0);
  assert.ok(ctx.readError, '退避期间保留出错原因');
});

function fakePs() {
  let n = 0;
  const execFile = async () => { n += 1; await new Promise(r => setTimeout(r, 20));
    return { stdout: JSON.stringify({ processes: [{ pid: 4, ppid: 0, name: 'System' }] }) }; };
  return { execFile, count: () => n };
}

test('进程表：多个检查器同时要，只起一次采集；各自 CPU 基线互不干扰', async () => {
  const ps = fakePs();
  const a = createProcessInspector({ execFile: ps.execFile, logger: { warn() {} } });
  const b = createProcessInspector({ execFile: ps.execFile, logger: { warn() {} } });
  const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
  assert.equal(ps.count(), 1);
  assert.notEqual(sa.processes[0], sb.processes[0], '每个实例拿到自己的行副本');
});

test('进程表：force 一定重新采集（结束进程后确认要看最新的）', async () => {
  const ps = fakePs();
  const a = createProcessInspector({ execFile: ps.execFile, logger: { warn() {} } });
  const b = createProcessInspector({ execFile: ps.execFile, logger: { warn() {} } });
  await a.snapshot();
  await b.snapshot({ force: true });
  assert.equal(ps.count(), 2);
});
