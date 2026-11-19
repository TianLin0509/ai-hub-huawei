'use strict';
// 后台 CodeAgent 会话关闭时补杀整棵进程树（2026-11-19）。
// 起因：node-pty 在 Windows 上关会话只结束挂在伪终端上的进程；CodeAgent 拉起的 MCP 插件链（cmd/uvx/python/node，
// 以及插件再拉起的浏览器）带独立 conhost，根结束后成了孤儿（公司真机一会话 92 个进程、4–4.8 GB）。
// 5.6.53 起「分身」每个分身一个常驻 CodeAgent 会话，坏了、闲了、问满了就关掉换新，每次都可能留下一串孤儿。
// 做法同休眠补杀（core/session-tree-sweep.js）：关之前拍一张进程快照记下整棵树（PID + 启动时间），
// 关完 8 秒后重新枚举，还活着且 PID、启动时间都对得上的按 PID 结束。只认这棵树，从不按命令行或进程名匹配。
const { captureTree, createTreeSweeper } = require('./session-tree-sweep');

const KINDS = /^codeagent(?:-resume)?$/;
const SNAPSHOT_TIMEOUT_MS = 3000;
let inspector = null;

function getInspector() {
  if (!inspector) inspector = require('./process-inspector').createProcessInspector({ ttlMs: 2000, logger: { warn() {} } });
  return inspector;
}

// 返回 { schedule() }：关会话之后调用 schedule() 安排补杀。拍不到快照、不是 CodeAgent 会话时返回 null（照常关、不补杀）。
async function prepareCloseSweep(manager, id, { inspect = getInspector, platform = process.platform, timeoutMs = SNAPSHOT_TIMEOUT_MS, log = line => console.info('[session-close-sweep]', line) } = {}) {
  if (platform !== 'win32') return null;
  const entry = manager?.sessions?.get?.(id);
  const rootPid = Number(entry?.pty?.pid) || 0;
  if (!rootPid || !KINDS.test(String(entry?.info?.kind || ''))) return null;
  const ins = inspect();
  let snap = null;
  try {
    snap = await Promise.race([ins.snapshot({ force: true }), new Promise(r => { const t = setTimeout(() => r(null), timeoutMs); t.unref?.(); })]);
  } catch { snap = null; }
  const before = snap ? captureTree(snap, rootPid) : [];
  if (before.length < 2) return null; // 只有根自己：node-pty 收得掉，不用补
  const sweeper = createTreeSweeper({ inspector: ins, log,
    protect: () => [process.pid, ...(manager.listLivePtyPids?.() || []).filter(pid => pid !== rootPid)] });
  return { before, schedule: () => sweeper.schedule(before, `session=${String(id).slice(0, 8)}`) };
}

module.exports = { prepareCloseSweep, KINDS };
