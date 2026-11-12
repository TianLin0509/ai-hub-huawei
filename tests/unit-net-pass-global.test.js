'use strict';
// 底栏「一键放行」的显示与结果文案（真实界面见 tests/e2e-net-pass-global-cdp.js）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { view, summary } = require('../renderer/net-pass-global');

test('圆点状态：被拦标橙并列出被拦的地方；正常标绿；没有可放行的服务器就不显示', () => {
  assert.equal(view({ available: false }, false), null);
  assert.equal(view({ available: true, hosts: [{ state: 'ok' }], blocked: [] }, false).state, 'ok');
  const b = view({ available: true, hosts: [{ state: 'ok' }], blocked: ['通道服务器'] }, false);
  assert.equal(b.state, 'blocked'); assert.match(b.title, /通道服务器/);
  assert.equal(view(null, true).state, 'running');
});

test('结果文案：全通报处数，没通的逐个说清楚', () => {
  assert.equal(summary({ steps: [{ name: 'a', ok: true }, { name: 'b', ok: true }] }), '已全部放行（2 处）');
  assert.match(summary({ steps: [{ name: '通道服务器', ok: false, note: '还被拦着' }] }), /1 处没放行：通道服务器（还被拦着）/);
  assert.match(summary(null), /没有完成/);
});
