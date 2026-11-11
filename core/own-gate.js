'use strict';
// 自家下载服务器被公司网络确认页拦住时的统一放行入口（5.6.2，2026-11-11 用户：涉及放行的地方要么自动放行，要么当场给放行页，
// 不能只甩一句看不懂的报错）。主进程启动时登记放行办法（main.js，背后是 core/net-pass.js 的 passUrl）；
// 各下载功能失败时调 pass(url)：这台主机确实被拦才动手——成员版先在看不见的窗口里自动点，不行或公开版就在 Hub 里弹出放行页；
// 没被拦（别的原因失败）、不是自家主机、没登记（测试、无界面脚本）都立即返回 false，不影响原来的失败处理。
let handler = null;
function setHandler(fn) { handler = typeof fn === 'function' ? fn : null; }
// 返回 'passed'（原先被拦，现在通了，值得重试）/ 'blocked'（被拦且没放行成功）/ false。
// interactive=false：只做后台自动放行，不弹窗（后台定时任务用）。
async function pass(url, { interactive = true } = {}) {
  if (!handler || !url) return false;
  try { return (await handler(String(url), { interactive })) || false; } catch { return false; }
}
const BLOCKED_TEXT = '下载服务器被公司网络的确认页拦住了：在弹出的放行页上点「放行」，放行后再点一次即可';
const BLOCKED_QUIET_TEXT = '下载服务器被公司网络的确认页拦住了，需要先放行（设置里的「放行下载服务器」）';
const PASSED_TEXT = '下载服务器已放行，请再点一次';
// 跑一遍 run()；失败时逐个看这些地址所在的自家主机是不是被拦，放行成功就再跑一遍；被拦又没放行成，换成一句人话。
async function withGate(urls, run, opts = {}) {
  try { return await run(); }
  catch (error) {
    let blocked = false;
    for (const url of [].concat(urls || [])) {
      const r = await pass(url, opts);
      if (r === 'passed') {
        // 放行花的时间可能已经超过调用方给这次请求的时限：重试再失败就请用户再点一次，不把超时原文甩出去。
        try { return await run(); } catch (again) { throw Object.assign(new Error(PASSED_TEXT), { passed: true, cause: again }); }
      }
      if (r === 'blocked') blocked = true;
    }
    if (blocked) throw Object.assign(new Error(opts.interactive === false ? BLOCKED_QUIET_TEXT : BLOCKED_TEXT), { blocked: true, cause: error });
    throw error;
  }
}
// 给取清单、取小文件的 fetch 包一层：请求失败，或成功却拿到网页（确认页冒充文件）时走 withGate。
function gatedFetch(fetchImpl, opts) {
  return (url, init) => withGate(url, async () => {
    const response = await fetchImpl(url, init);
    if (response && response.ok && /text\/html/i.test(response.headers?.get?.('content-type') || '')) {
      try { void response.body?.cancel().catch(() => {}); } catch (_) {}
      throw Object.assign(new Error('收到的是网页而不是文件（可能被网络确认页替换）'), { blocked: true });
    }
    return response;
  }, opts);
}
module.exports = { setHandler, pass, withGate, gatedFetch, BLOCKED_TEXT, BLOCKED_QUIET_TEXT, PASSED_TEXT };
