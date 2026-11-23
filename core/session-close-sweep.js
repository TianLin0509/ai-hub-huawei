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

// 会话的 pty.pid 指向共享后台进程（CodeAgent-Lite 的共享 serve、App Server、stream-json 等）时不能按进程树补杀：
// 那棵树属于同账号的所有会话，杀掉会拖垮其他还在用的会话（与 session-manager _terminateWithTreeSweep 同一口径）。
function sharedRuntime(entry) {
  const backend = entry?.info?.runtimeBackend;
  return entry?.info?.codeagentRunMode === 'serve' || ['codex-app-server', 'claude-stream-json'].includes(backend)
    || (backend === 'acp' && !entry?.pty?.isCliProvider);
}
// 补杀保护名单：Hub 自己、其他会话的根、所有共享 serve（含本会话借用的那个）。
function protectedPids(manager, rootPid) {
  let serve = [];
  try { serve = require('./codeagent-serve-host').livePids(); } catch { serve = []; }
  return [process.pid, ...(manager?.listLivePtyPids?.() || []).filter(pid => pid !== rootPid), ...serve];
}

// 返回 { schedule() }：关会话之后调用 schedule() 安排补杀。拍不到快照、不是 CodeAgent 会话时返回 null（照常关、不补杀）。
async function prepareCloseSweep(manager, id, { inspect = getInspector, platform = process.platform, timeoutMs = SNAPSHOT_TIMEOUT_MS, log = line => console.info('[session-close-sweep]', line) } = {}) {
  if (platform !== 'win32') return null;
  const entry = manager?.sessions?.get?.(id);
  const rootPid = Number(entry?.pty?.pid) || 0;
  if (!rootPid || !KINDS.test(String(entry?.info?.kind || '')) || sharedRuntime(entry)) return null;
  const ins = inspect();
  let snap = null;
  try {
    snap = await Promise.race([ins.snapshot({ force: true }), new Promise(r => { const t = setTimeout(() => r(null), timeoutMs); t.unref?.(); })]);
  } catch { snap = null; }
  const before = snap ? captureTree(snap, rootPid) : [];
  if (before.length < 2) return null; // 只有根自己：node-pty 收得掉，不用补
  const sweeper = createTreeSweeper({ inspector: ins, log,
    protect: () => protectedPids(manager, rootPid) });
  return { before, schedule: () => sweeper.schedule(before, `session=${String(id).slice(0, 8)}`) };
}

// ---------------------------------------------------------------- 所有关闭 / 休眠路径通用（2026-11-23）
// 内存压力休眠都漏了。会话管理器在这些路径结束 CodeAgent 终端前调用 plan()：
//   - 最近一次进程快照（任一检查器的缓存）里有这个会话的根、且根的启动时间对得上本会话：同步取整棵树，照常立刻结束；
//     快照之后才派生的插件，只要父进程在树里，补杀时一并算上（session-tree-sweep.js residualTargets 第 2 条）；
//   - 缓存里没有：现拍一张（最多等 timeoutMs），拍完再结束——关闭 / 休眠最多晚这么一会儿，换来孤儿不再漏网。
// 关完 delayMs（默认 8 秒）后重新枚举，PID + 启动时间都对得上的残余按 PID 结束。保护名单（Hub 自己、其他会话的根、
// 同账号共享 serve 和临时 serve）里的绝不碰；从不按命令行或进程名匹配。
const ROOT_START_SLACK_MS = 120000;
function createExitTreeSweep({ inspectors = () => [getInspector()], protect = () => [process.pid], platform = process.platform,
  timeoutMs = SNAPSHOT_TIMEOUT_MS, log = line => console.info('[session-close-sweep]', line), sweeperOptions = {} } = {}) {
  const list = () => { try { return (inspectors() || []).filter(i => i && typeof i.snapshot === 'function'); } catch { return []; } };
  // 快照里的根是不是本会话的那个进程：会话开始前就已存在的同号进程（PID 复用）不算。
  const rootMatches = (snap, rootPid, startedAt) => {
    const row = snap && (snap.byPid instanceof Map ? snap.byPid.get(rootPid) : (snap.processes || []).find(p => p && p.pid === rootPid));
    if (!row) return false;
    const at = Number(row.startedAt) || 0;
    return !(at > 0 && Number(startedAt) > 0 && at < Number(startedAt) - ROOT_START_SLACK_MS);
  };
  function fromCache(rootPid, startedAt) {
    let best = null;
    for (const ins of list()) {
      let snap = null;
      try { snap = typeof ins.getCached === 'function' ? ins.getCached() : null; } catch { snap = null; }
      if (!snap || !rootMatches(snap, rootPid, startedAt)) continue;
      if (!best || (Number(snap.sampledAt) || 0) > (Number(best.sampledAt) || 0)) best = snap;
    }
    const before = best ? captureTree(best, rootPid) : [];
    return before.length >= 2 ? before : null;
  }
  async function fresh(rootPid, startedAt) {
    const ins = list()[0];
    if (!ins) return [];
    let snap = null;
    try {
      snap = await Promise.race([ins.snapshot({ force: true }), new Promise(r => { const t = setTimeout(() => r(null), timeoutMs); t.unref?.(); })]);
    } catch { snap = null; }
    return snap && rootMatches(snap, rootPid, startedAt) ? captureTree(snap, rootPid) : [];
  }
  // 返回 null（不补杀，照常结束）、{ before }（同步拿到，立刻结束）或 { pending: Promise<before[]> }（等快照再结束）。
  function plan(rootPid, { startedAt = 0 } = {}) {
    const root = Number(rootPid) || 0;
    if (platform !== 'win32' || !(root > 0)) return null;
    const cached = fromCache(root, startedAt);
    if (cached) return { before: cached };
    if (!list().length) return null;
    return { pending: fresh(root, startedAt).catch(() => []) };
  }
  function schedule(before, { rootPid = 0, label = '' } = {}) {
    if (!before || before.length < 2) return false; // 只有根自己：node-pty 收得掉，不用补
    const ins = list()[0];
    if (!ins) return false;
    const sweeper = createTreeSweeper({ inspector: ins, log, ...sweeperOptions,
      protect: () => { let pids = []; try { pids = protect() || []; } catch { pids = [process.pid]; } return pids.map(Number).filter(pid => pid > 0 && pid !== Number(rootPid)); } });
    return sweeper.schedule(before, label);
  }
  return { plan, schedule };
}

module.exports = { prepareCloseSweep, createExitTreeSweep, getInspector, sharedRuntime, protectedPids, KINDS, ROOT_START_SLACK_MS };
