'use strict';
// 测试期间占住事件循环（2026-11-24）。
// 产品代码里的超时与轮询定时器都 unref（不拦 Hub 退出）；真实运行时有网络请求、子进程占着事件循环，定时器照常到点。
// 测试把它们换成假对象后，事件循环里只剩这些 unref 定时器：Node 22 的测试运行器会判「循环已空、Promise 仍在等」，
// 把当前用例连同同文件后面的全部记为 cancelledByParent（Node 24 不这样判，所以只在 CI 的 Node 22 上出现）。
// 用法：test('…', async t => { holdEventLoop(t); … })，用例结束自动放开；真卡住时仍由用例超时报错。
function holdEventLoop(t) {
  const handle = setInterval(() => {}, 60_000);
  t.after(() => clearInterval(handle));
}

module.exports = { holdEventLoop };
