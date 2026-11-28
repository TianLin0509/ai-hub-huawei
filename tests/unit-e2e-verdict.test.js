'use strict';
// 真机压测脚本的总判定（审查 P2）：本轮只要有过任何一次关 Hub 出错就判失败，即使之后强制结束、收尾 close 返回 true。
const test = require('node:test');
const assert = require('node:assert/strict');
const { e2ePassed } = require('./helpers/e2e-verdict');
const ok = () => ({ checks: [{ ok: true }] });
test('全过且收尾关得掉：通过', () => assert.equal(e2ePassed(ok(), true), true));
test('中途关 Hub 出过错（之后被强制结束，收尾 close 返回 true）：失败', () => {
  assert.equal(e2ePassed({ ...ok(), quitErrors: [{ why: '转换中关 Hub', error: 'timeout' }] }, true), false);
});
test('收尾关不掉、有残留 PID、用例失败或没有用例：失败', () => {
  assert.equal(e2ePassed(ok(), false), false);
  assert.equal(e2ePassed({ ...ok(), hubLeft: { pid: 1 } }, true), false);
  assert.equal(e2ePassed({ checks: [{ ok: false }] }, true), false);
  assert.equal(e2ePassed({ checks: [] }, true), false);
  assert.equal(e2ePassed({ ...ok(), error: 'x' }, true), false);
});
