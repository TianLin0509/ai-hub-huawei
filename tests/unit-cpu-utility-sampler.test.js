'use strict';

// 底栏 CPU 与任务管理器同口径（2026-11-28）：按 Windows 版本选口径、typeperf 两列解析、窗口均值、
// 自停与回落；接到 IPC 采样器后的 cpuSource 与 Top 3 折算。
const assert = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const { createCpuUtilitySampler, parseTypeperfLine, averageSince, taskManagerCpuMode } = require('../core/cpu-utility-sampler.js');
const { createSystemResourceSampler, scaleTopProcesses } = require('../main/ipc/app-utility-handlers.js');

// 版本判定：公司 26100.4061 实测任务管理器用利用率；KB5064081（26100.5074）起与 25H2 用忙碌时间。
assert.strictEqual(taskManagerCpuMode('10.0.26100', 4061), 'utility');
assert.strictEqual(taskManagerCpuMode('10.0.26100', 5074), 'time');
assert.strictEqual(taskManagerCpuMode('10.0.26100', null), 'utility', '读不到补丁号按旧版');
assert.strictEqual(taskManagerCpuMode('10.0.26200', 9974), 'time');
assert.strictEqual(taskManagerCpuMode('10.0.22631', 6000), 'utility');
assert.strictEqual(taskManagerCpuMode('10.0.19045', 5000), 'utility');
assert.strictEqual(taskManagerCpuMode('', null), 'utility');

assert.deepStrictEqual(parseTypeperfLine('"11/28/2026 16:40:59.294","48.771819","30.5"'), { utility: 48.771819, time: 30.5 });
assert.deepStrictEqual(parseTypeperfLine('"11/28/2026 16:40:59.294","121.1","90"\r'), { utility: 121.1, time: 90 });
assert.deepStrictEqual(parseTypeperfLine('"28.11.2026 16:40:59","48,5","30,25"'), { utility: 48.5, time: 30.25 }, '逗号小数点');
assert.strictEqual(parseTypeperfLine('"(PDH-CSV 4.0)","\\\\HOST\\Processor Information(_Total)\\% Processor Utility","\\\\HOST\\x"'), null);
assert.strictEqual(parseTypeperfLine('"11/28/2026 16:40:59.294"," "," "'), null);
assert.strictEqual(parseTypeperfLine(''), null);

// 利用率可超 100（睿频），显示按任务管理器封顶 100；scale = 利用率 / 忙碌时间。
assert.deepStrictEqual(averageSince([{ at: 1, utility: 50, time: 50 }, { at: 5, utility: 130, time: 100 }, { at: 6, utility: 120, time: 100 }], 2), { pct: 100, scale: 1.25, count: 2 });
assert.deepStrictEqual(averageSince([{ at: 5, utility: 40, time: 20 }, { at: 6, utility: 60, time: 30 }], 2), { pct: 50, scale: 2, count: 2 });
assert.strictEqual(averageSince([{ at: 5, utility: 3, time: 0.2 }], 2).scale, null, '几乎空闲时不给折算系数');
assert.strictEqual(averageSince([{ at: 1, utility: 40, time: 20 }], 2), null);
assert.strictEqual(averageSince([{ at: 5, utility: 130, time: 100 }, { at: 6, utility: 60, time: 60 }], 2).pct, 80, '逐秒封顶 100 再平均，同任务管理器每秒读数');

function fakeSpawnFactory() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const tmpFile = name => path.join(os.tmpdir(), `hub-cpu-utility-${name}-${process.pid}.txt`);

// 旧版任务管理器：起 typeperf，取最近窗口均值。
{
  let t = 100_000;
  const { spawn, calls } = fakeSpawnFactory();
  const sampler = createCpuUtilitySampler({ platform: 'win32', mode: 'utility', spawn, now: () => t, idleMs: 30_000, counterFile: tmpFile('a') });
  assert.deepStrictEqual(sampler.read(5000), { mode: 'utility', pct: null, scale: null, count: 0 }, '刚启动还没有样本');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'typeperf');
  assert.strictEqual(calls[0].opts.windowsHide, true, '后台无感：不弹窗');
  assert.ok(calls[0].args.includes('-sc'), '带样本上限，Hub 崩了 typeperf 也会自己退出');
  const emit = (u, tm) => { t += 1000; calls[0].child.stdout.emit('data', `"11/28/2026","${u}","${tm}"\r\n`); };
  calls[0].child.stdout.emit('data', '\r\n"(PDH-CSV 4.0)","\\\\H\\a","\\\\H\\b"\r\n');
  [[10, 5], [20, 10], [30, 15], [40, 20], [50, 25], [60, 30], [70, 35]].forEach(([u, tm]) => emit(u, tm));
  t += 200;
  const result = sampler.read(5000);
  assert.strictEqual(result.count, 5, '只取最近 5 秒');
  assert.strictEqual(result.pct, 50);
  assert.strictEqual(result.scale, 2);
  assert.strictEqual(calls.length, 1, '读数不重复起进程');

  // -sc 到点退出，有人在读就续上；没有样本就连续失败三次后冷却，不反复起进程。
  calls[0].child.emit('exit', 0);
  assert.strictEqual(calls.length, 2, '正常到点退出后立即续采');
  calls[1].child.emit('exit', 1);
  sampler.read(5000); calls[2].child.emit('exit', 1);
  sampler.read(5000); calls[3].child.emit('exit', 1);
  sampler.read(5000);
  assert.strictEqual(calls.length, 4, '计数器读不到时冷却，不再每次重起');
  sampler.dispose();
}

// 新版任务管理器：不起任何进程，交给 os.cpus()。
{
  const sampler = createCpuUtilitySampler({ platform: 'win32', release: '10.0.26200', spawn: () => { throw new Error('不该起进程'); } });
  assert.deepStrictEqual(sampler.read(), { mode: 'time', pct: null, scale: 1, count: 0 });
  assert.strictEqual(sampler._state().mode, 'time');
}

// 26100：先按旧版，异步读到补丁号后切换。
{
  let callback = null;
  const execFile = (cmd, args, opts, cb) => { assert.strictEqual(cmd, 'reg'); assert.strictEqual(opts.windowsHide, true); callback = cb; };
  const { spawn } = fakeSpawnFactory();
  const sampler = createCpuUtilitySampler({ platform: 'win32', release: '10.0.26100', execFile, spawn, counterFile: tmpFile('b') });
  assert.strictEqual(sampler._state().mode, 'utility');
  callback(null, '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    UBR    REG_DWORD    0x26f6\r\n');
  assert.strictEqual(sampler._state().mode, 'time', '0x26f6 = 9974 ≥ 5074');
  sampler.dispose();
  const old = createCpuUtilitySampler({ platform: 'win32', release: '10.0.26100', execFile: (c, a, o, cb) => cb(null, '    UBR    REG_DWORD    0xfdd\r\n'), spawn, counterFile: tmpFile('c') });
  assert.strictEqual(old._state().mode, 'utility', '0xfdd = 4061 < 5074');
  old.dispose();
}

{
  // spawn 同步抛错也计入失败，三次后冷却。
  let n = 0;
  const sampler = createCpuUtilitySampler({ platform: 'win32', mode: 'utility', now: () => 1, spawn: () => { n++; throw new Error('no typeperf'); }, counterFile: tmpFile('d') });
  for (let i = 0; i < 6; i++) sampler.read();
  assert.strictEqual(n, 3);
  sampler.dispose();
}

{
  const sampler = createCpuUtilitySampler({ platform: 'linux', spawn: () => { throw new Error('不该起进程'); } });
  assert.strictEqual(sampler.read(), null);
}

// IPC 采样器：cpuSource 标明口径；内存给出总量与可用；Top 3 按口径折算。
{
  let busy = 0;
  const fakeOs = {
    cpus: () => [{ times: { user: busy, nice: 0, sys: 0, idle: 1000, irq: 0 } }],
    totalmem: () => 64 * 1024 ** 3,
    freemem: () => 16 * 1024 ** 3,
  };
  let reading = null;
  const sample = createSystemResourceSampler(fakeOs, { cpuUtility: { read: () => reading } });
  busy = 300;
  let r = sample();
  assert.strictEqual(r.cpuSource, 'processor-time');
  assert.strictEqual(r.memoryPct, 75);
  assert.strictEqual(r.memoryTotalBytes, 64 * 1024 ** 3);
  assert.strictEqual(r.memoryAvailableBytes, 16 * 1024 ** 3);
  reading = { mode: 'time', pct: null, scale: 1, count: 0 };
  busy = 400;
  r = sample();
  assert.strictEqual(r.cpuSource, 'processor-time-taskmgr', '新版任务管理器：忙碌时间就是同口径');
  assert.strictEqual(sample.cpuMode(), 'time');
  assert.strictEqual(sample.cpuScale(), null);
  reading = { mode: 'utility', pct: 62.4, scale: 1.6, count: 5 };
  busy = 500;
  r = sample();
  assert.strictEqual(r.cpuSource, 'processor-utility');
  assert.strictEqual(r.cpuPct, 62);
  assert.strictEqual(sample.cpuScale(), 1.6);
  reading = { mode: 'utility', pct: null, scale: null, count: 0 };
  busy = 600;
  assert.strictEqual(sample().cpuSource, 'processor-time', '旧版读不到计数器：回落并标明');
  reading = { mode: 'time', pct: null, scale: 1, count: 0 };
  busy = 800;
  const before = sample();
  const again = sample();
  assert.strictEqual(again.cpuPct, before.cpuPct, '忙碌时间没有增量时沿用上一次读数，不闪「—」');
  assert.strictEqual(again.cpuSource, 'processor-time-taskmgr');
  const truncOs = { ...fakeOs, freemem: () => 64 * 1024 ** 3 * 0.331 };
  assert.strictEqual(createSystemResourceSampler(truncOs)().memoryPct, 66, '内存 66.9% 显示 66，同任务管理器截断取整');
  const throwing = createSystemResourceSampler(fakeOs, { cpuUtility: { read: () => { throw new Error('x'); } } });
  busy = 900;
  assert.strictEqual(throwing().cpuSource, 'processor-time', '利用率读坏了不影响底栏');

  const top = { status: 'ok', cpu: [{ pid: 1, cpuPct: 40 }, { pid: 2, cpuPct: 70 }, { pid: 3, cpuPct: null }], memory: [] };
  assert.deepStrictEqual(scaleTopProcesses(top, 1.6, 'utility').cpu.map(row => row.cpuPct), [64, 100, null]);
  assert.strictEqual(scaleTopProcesses(top, 1.6, 'utility').cpuBasis, 'utility');
  assert.strictEqual(scaleTopProcesses(top, 1, 'time').cpuBasis, 'time-taskmgr');
  assert.deepStrictEqual(scaleTopProcesses(top, 1, 'time').cpu, top.cpu);
  assert.strictEqual(scaleTopProcesses(top, null, 'utility').cpuBasis, 'time');
  assert.deepStrictEqual(scaleTopProcesses({ status: 'unavailable' }, 2, 'utility'), { status: 'unavailable' });
}

console.log('unit-cpu-utility-sampler OK');
