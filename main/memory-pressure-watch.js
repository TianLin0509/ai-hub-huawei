'use strict';
// 内存紧张就地提示（R59 方案 A，2026-11-27）主进程侧：
//   - 每分钟读一次整机内存（os.freemem，开销可忽略）和会话清单；紧张与否、闲着几个、在跑几个有变化才推给界面；
//   - 紧张时才量一次「闲着的会话」进程树占多少内存（进程枚举约 0.8 秒，最多 3 分钟一次，闲置名单变了才重量）；
//   - 一键休眠闲着的：逐个走 session-manager.suspendSession 的现成闸门（与「释放内存」面板同一组参数），续接走原生 --resume；
//   - 一键反馈的运行快照要「各会话进程树内存合计」：同步读缓存，过期就顺手异步刷新。
// 只看本 Hub 自己的会话；不结束任何非会话进程。
// 「闲着」= MEMORY_HINT_SUSPEND_OPTIONS 闸门放行：面板口径（答完闲置满 10 分钟、非当前、非群聊、CodeAgent 已结算、不在等用户确认）
// 再豁免置顶与 CodeAgent-Lite，另加调用方给的受保护会话。

const os = require('os');
const hint = require('../core/memory-pressure-hint');

const CHECK_MS = 60 * 1000;
const MEASURE_MIN_GAP_MS = 3 * 60 * 1000;
const ALL_MEM_TTL_MS = 60 * 1000;
const SETTLE_MS = 2500;

function sessionTreeBytes(snap, roots) {
  const { subtreePids } = require('../core/process-reclaim');
  const list = (snap && snap.processes || []).filter(p => p && p.pid > 0);
  const byPid = snap && snap.byPid instanceof Map ? snap.byPid : new Map(list.map(p => [p.pid, p]));
  const children = snap && snap.childrenMap instanceof Map ? snap.childrenMap : require('../core/process-inspector').buildChildrenMap(list);
  const owned = new Set(), out = [];
  for (const { id, pid } of roots || []) {
    if (!id || !byPid.has(Number(pid))) continue;
    let bytes = 0, processes = 0;
    for (const x of subtreePids(Number(pid), children, byPid)) {
      if (owned.has(x)) continue;
      owned.add(x);
      bytes += Number(byPid.get(x)?.wsBytes) || 0; processes += 1;
    }
    out.push({ id, bytes, processes });
  }
  return out;
}

function createMemoryPressureWatch(options = {}) {
  const {
    getSessionManager = () => null,
    isLowOverheadOn = () => false,
    send = () => {},
    osApi = os,
    now = Date.now,
    createInspector = () => require('../core/process-inspector').createProcessInspector({ ttlMs: 20000, logger: { warn() {} } }),
    treeBytes = sessionTreeBytes,
    listServeHosts = () => { try { return require('../core/codeagent-serve-host').listHosts(); } catch { return []; } },
    suspendOptions = () => require('../core/session-manager').MEMORY_HINT_SUSPEND_OPTIONS,
    // 组队负责人与成员、WeLink 连线、会议录制理解、联赛、学习 Tab 等受保护会话：不计入「闲着」、一键休眠不碰。
    getProtectedSessionIds = () => new Set(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    logger = console,
  } = options;

  let inspector = null;
  const inspect = async () => { inspector = inspector || createInspector(); return inspector.snapshot(); };
  let wasTight = false;
  let lastSent = '';
  let last = null;
  let measured = { key: '', at: 0, bytes: null };
  let allMem = null;
  let allMemPending = null;

  function memory() {
    const total = Number(osApi.totalmem()) || 0;
    const free = Number(osApi.freemem()) || 0;
    return { totalBytes: total, freeBytes: free, usage: total > 0 ? 1 - free / total : 0 };
  }
  function rows() {
    const sm = getSessionManager();
    try {
      return sm && typeof sm.describeSessionsForMemory === 'function'
        ? sm.describeSessionsForMemory({ now: now(), suspendOptions: suspendOptions(), excludeSessionIds: protectedIds() }) : [];
    } catch { return []; }
  }
  function protectedIds() { try { const ids = getProtectedSessionIds(); return ids instanceof Set ? ids : new Set(ids || []); } catch { return new Set(); } }
  const lowOn = () => { try { return isLowOverheadOn() === true; } catch { return false; } };

  async function measureIdle(list, force) {
    const idle = list.filter(r => r.suspendable === true && Number(r.ptyPid) > 0);
    const key = idle.map(r => r.id).sort().join(',');
    if (!idle.length) { measured = { key, at: now(), bytes: null }; return null; }
    if (!force && measured.key === key && now() - measured.at < MEASURE_MIN_GAP_MS) return measured.bytes;
    try {
      const snap = await inspect();
      const found = treeBytes(snap, idle.map(r => ({ id: r.id, pid: r.ptyPid })));
      const bytes = found.reduce((s, x) => s + (Number(x.bytes) || 0), 0);
      if (!(bytes > 0)) logger?.log?.(`[memory-pressure] idle trees measured 0: ${idle.length} root(s), ${found.length} found in snapshot of ${snap?.processes?.length || 0} processes`);
      // 量出 0（进程快照比会话还旧，没找到它的进程）不缓存，下一轮重量，免得 3 分钟里一直显示不出占用。
      measured = bytes > 0 ? { key, at: now(), bytes } : { key, at: 0, bytes: null };
    } catch (error) {
      logger?.warn?.('[memory-pressure] measure failed:', error?.message || error);
      measured = { key, at: now(), bytes: null };
    }
    return measured.bytes;
  }

  // measure：紧张时是否量闲置会话的进程树（界面主动问、启动中心打开时传 true）。
  async function check({ measure = false, forceMeasure = false } = {}) {
    const mem = memory();
    const list = rows();
    let summary = hint.summarize({ ...mem, rows: list, wasTight, lowOverheadOn: lowOn() });
    if (summary.tight && (measure || summary.idleCount > 0)) {
      const bytes = await measureIdle(list, forceMeasure);
      summary = { ...summary, idleBytes: bytes };
    }
    wasTight = summary.tight;
    last = summary;
    const sig = hint.signature(summary);
    if (sig !== lastSent) {
      lastSent = sig;
      try { send(summary); } catch { /* 窗口刚关 */ }
    }
    return summary;
  }

  async function suspendIdle() {
    const sm = getSessionManager();
    if (!sm || typeof sm.suspendSession !== 'function') return { ok: false, error: 'no-session-manager', requested: 0, failed: 0 };
    const freeBefore = Number(osApi.freemem()) || 0;
    const opts = { ...suspendOptions(), excludeSessionIds: protectedIds() };
    let requested = 0, failed = 0;
    for (const row of rows()) {
      if (!row || row.suspendable !== true) continue;
      let result = null;
      try { result = sm.suspendSession(row.id, { ...opts, now: now(), reason: 'memory-release' }); } catch (error) { result = { ok: false, error: error?.message }; }
      if (result && result.ok) requested += 1; else failed += 1;
    }
    if (requested) await delay(SETTLE_MS);
    const freedBytes = Math.max(0, (Number(osApi.freemem()) || 0) - freeBefore);
    if (requested) logger?.log?.(`[memory-pressure] one-click suspended ${requested} idle session(s), freed ~${Math.round(freedBytes / 1048576)} MB`);
    const state = await check({ measure: true, forceMeasure: true });
    return { ok: true, requested, failed, freedBytes, state };
  }

  // 各会话进程树（PTY 会话 + Lite 共享后台）合计，给一键反馈的运行快照用。
  async function refreshAllMem() {
    if (allMemPending) return allMemPending;
    allMemPending = (async () => {
      try {
        const sm = getSessionManager();
        const roots = [];
        for (const [id, s] of sm?.sessions?.entries?.() || []) {
          const status = String(s?.info?.status || '');
          const pid = Number(s?.pty?.pid);
          if (pid > 0 && !/^(dormant|closed)$/.test(status)) roots.push({ id, pid });
        }
        let serve = 0;
        for (const h of listServeHosts() || []) if (Number(h.pid) > 0 && h.running !== false) { roots.push({ id: 'serve:' + h.key, pid: Number(h.pid) }); serve += 1; }
        if (!roots.length) { allMem = { at: now(), bytes: 0, processes: 0, sessions: 0, serve: 0 }; return allMem; }
        const rowsOut = treeBytes(await inspect(), roots);
        allMem = { at: now(), bytes: rowsOut.reduce((s, x) => s + (Number(x.bytes) || 0), 0), processes: rowsOut.reduce((s, x) => s + (Number(x.processes) || 0), 0),
          sessions: rowsOut.filter(x => !String(x.id).startsWith('serve:')).length, serve };
      } catch (error) {
        allMem = { at: now(), error: String(error?.message || error) };
      } finally { allMemPending = null; }
      return allMem;
    })();
    return allMemPending;
  }
  // 同步：返回缓存（可能为 null），过期就后台刷新一次。
  function allMemCached() {
    if (!allMem || now() - allMem.at > ALL_MEM_TTL_MS) void refreshAllMem();
    return allMem;
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setIntervalFn(() => { check({}).catch(error => logger?.warn?.('[memory-pressure] check failed:', error?.message || error)); }, CHECK_MS);
    timer?.unref?.();
  }
  function stop() { if (timer) { clearIntervalFn(timer); timer = null; } }

  return { start, stop, check, suspendIdle, refreshAllMem, allMemCached, last: () => last };
}

// 一键反馈运行快照里的一段文字。
function runtimeText({ lowOverheadOn, allMem } = {}) {
  const parts = [`低开销模式 ${lowOverheadOn ? '开' : '关'}`];
  if (!allMem) parts.push('会话进程树内存：测量中');
  else if (allMem.error) parts.push('会话进程树内存：测量失败');
  else parts.push(`会话进程树内存合计 ${(allMem.bytes / 1024 ** 3).toFixed(1)} GB（${allMem.sessions} 个会话${allMem.serve ? `、${allMem.serve} 个 Lite 共享后台` : ''}，${allMem.processes} 个进程）`);
  return parts.join(' · ');
}

module.exports = { createMemoryPressureWatch, runtimeText, sessionTreeBytes, CHECK_MS, MEASURE_MIN_GAP_MS };
