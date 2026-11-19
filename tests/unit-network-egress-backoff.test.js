'use strict';
// 2026-11-20 运行时风暴排查：VPN 断着时出口探测按连续失败次数退避，不再每次底栏刷新都重探；VPN 网卡查询 3 分钟一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNetworkEgressMonitor } = require('../core/network-egress-monitor');
const { createWindowsNetworkContext } = require('../core/windows-network-context');

test('VPN 一直不通：15 秒一刷的底栏在 1 小时里只触发少量探测，恢复后回到正常节奏', async () => {
  let t = 0, probes = 0, up = false;
  const m = createNetworkEgressMonitor({
    now: () => t, getProxy: () => 'http://127.0.0.1:7890', fs: { existsSync: () => false, readFileSync: () => '', writeFileSync() {}, mkdirSync() {}, renameSync() {} },
    logger: { warn() {}, log() {}, error() {} },
    probe: ({ route }) => { if (route === 'proxy') probes += 1; return up || route === 'direct' ? { ok: true, ip: '1.1.1.1', country: 'SG', countryCode: 'SG' } : { ok: false, errorCode: 'timeout', error: 'x' }; },
  });
  for (; t < 3600000; t += 15000) await m.getStatus();
  assert.ok(probes <= 40, `1 小时探测 ${probes} 次（改前约 240 次）`);
  up = true; t += 130000; await m.getStatus();
  const before = probes; for (let i = 0; i < 4; i += 1) { t += 15000; await m.getStatus(); }
  assert.ok(probes - before <= 1, '恢复后按正常 60 秒缓存');
});

test('VPN 网卡与 xGate 查询 3 分钟内复用结果', async () => {
  let t = 0; const calls = [];
  const ctx = createWindowsNetworkContext({ platform: 'win32', now: () => t, execFile: (file, _a, _o, cb) => { calls.push(file); cb(null, ''); } });
  await ctx.tunnel(); t += 60000; await ctx.tunnel(); t += 60000; await ctx.tunnel();
  assert.equal(calls.filter(f => /powershell/i.test(f)).length, 1);
  t += 61000; await ctx.tunnel();
  assert.equal(calls.filter(f => /powershell/i.test(f)).length, 2);
});
