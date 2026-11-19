'use strict';
// Hub 子进程生命周期登记（2026-11-19，同事反馈 5.6.53 后台开出大量 Edge 进程、内存被撑满）。
// 起因（隔离压测实测）：无头 Edge 每个实例约 14 个进程、700+ MB；帖子、门户待办、考勤各开各的、没有总上限，
// 4 个同时跑就是 56 个 Edge 进程约 3 GB；考勤页卡死时调试协议请求没有超时，那个 Edge 一直挂到 Hub 退出。
// 这里统一做五件事：
//   1. 登记：每个后台子进程起来就记下 PID、启动时间、用途、归属、临时目录、最晚结束时间，写到数据目录 runtime/child-registry.json；
//   2. 名额：同一类（如 edge）同时最多 N 个，多出的排队，先到先得；
//   3. 超时强收：过了最晚结束时间还没结束的，按 PID 结束整棵进程树（taskkill /PID /T /F）并删临时目录；
//   4. 遗留清理：Hub 启动时只看自己登记过、且登记它的 Hub 进程已经不在的条目，PID 和启动时间都对得上才结束；
//   5. 内存保护：系统可用内存低于阈值时新的后台浏览器先等、等不到就这次不开（功能稍后自动重试），并先收掉闲着的实例。
// 只按登记的 PID + 启动时间认人，从不按命令行关键字或进程名批量结束。窗口一律隐藏（windowsHide）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');

const START_TOLERANCE_MS = 5000;
const RECENT_KEEP = 30;
const DEFAULT_LIMITS = { edge: 1 };
const DEFAULT_WATCH_MS = 15000;
const LOW_MEM_BYTES = 1.2 * 1024 ** 3;
const LOW_MEM_RATIO = 0.08;

function envLimit(env, kind, fallback) {
  const n = Number(env[`CLAUDE_HUB_${String(kind).toUpperCase()}_MAX`]);
  return Number.isInteger(n) && n > 0 && n <= 8 ? n : fallback;
}

function defaultKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { return false; } } return true; }
  try {
    const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 一次查出给定 PID 的启动时间（毫秒）：只在启动清理遗留、且确实有遗留条目时调用一次。
function defaultProbeStarts(pids) {
  if (process.platform !== 'win32' || !pids.length) return Promise.resolve(new Map());
  const filter = pids.map(p => `ProcessId=${Number(p)}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => {
      const out = new Map();
      if (!error) for (const line of String(stdout).split(/\r?\n/)) { const [pid, at] = line.trim().split(/\s+/).map(Number); if (pid > 0 && at > 0) out.set(pid, at); }
      resolve(out);
    });
  });
}

function removeDir(dir) {
  if (!dir) return true;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); return !fs.existsSync(dir); } catch { return false; }
}

function createChildLifecycle({ dataDir = '', env = process.env, limits = {}, now = () => Date.now(), killTree = defaultKillTree, probeStarts = defaultProbeStarts,
  freeMem = () => os.freemem(), totalMem = () => os.totalmem(), watchMs = DEFAULT_WATCH_MS, logger = console, hubPid = process.pid } = {}) {
  const file = dataDir ? path.join(dataDir, 'runtime', 'child-registry.json') : '';
  const lim = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_LIMITS, ...limits })) lim[k] = envLimit(env, k, v);
  const entries = new Map(); // id → entry
  const slots = new Map(); // kind → { used, queue: [] }
  const idleClosers = new Set();
  const recent = [];
  let seq = 0, watchTimer = null, foreign = [];
  // 先把文件里别的 Hub（含上次崩掉的）登记的条目读进来：启动清理之前就有新登记写文件时不会把它们冲掉（审查 #3）。
  if (file) { try { foreign = (JSON.parse(fs.readFileSync(file, 'utf8')).entries || []).filter(e => e && e.hubPid !== hubPid); } catch { foreign = []; } }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const mine = [...entries.values()].map(e => ({ id: e.id, hubPid, pid: e.pid, startedAt: e.startedAt, kind: e.kind, purpose: e.purpose, owner: e.owner, userDataDir: e.userDataDir || '' }));
      const tmp = `${file}.${hubPid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: now(), entries: [...foreign, ...mine] }), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) { logger.warn?.('[child-lifecycle] 登记文件写不进去', e.code || e.message); }
  }
  function note(entry, reason, extra = {}) {
    recent.unshift({ at: now(), pid: entry.pid, kind: entry.kind, purpose: entry.purpose, reason, ...extra });
    recent.length = Math.min(recent.length, RECENT_KEEP);
  }

  function register({ pid, kind = 'process', purpose = '', owner = '', userDataDir = '', maxLifeMs = 0, startedAt = now() } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return '';
    const id = `${kind}-${hubPid}-${++seq}`;
    entries.set(id, { id, pid, kind, purpose, owner, userDataDir, startedAt, deadlineAt: maxLifeMs > 0 ? startedAt + maxLifeMs : 0 });
    persist();
    ensureWatch();
    return id;
  }
  function unregister(id, reason = '用完已关') {
    const e = entries.get(id);
    if (!e) return false;
    entries.delete(id);
    note(e, reason);
    persist();
    return true;
  }
  // 按 PID 结束整棵树并删临时目录，然后注销。
  // 结束失败（拒绝访问、taskkill 超时）时保留登记并标记，下一轮看门狗和下次启动还会再收（审查 #2）。
  function reclaim(id, reason = '回收') {
    const e = entries.get(id);
    if (!e) return false;
    const killed = pidAlive(e.pid) ? killTree(e.pid) : false;
    if (pidAlive(e.pid) && !killed) {
      e.failedAt = now(); e.deadlineAt = e.deadlineAt || now();
      note(e, reason + '（结束失败，稍后再试）', { killed: false });
      persist();
      return false;
    }
    const cleaned = removeDir(e.userDataDir);
    entries.delete(id);
    note(e, reason, { killed, cleaned });
    persist();
    logger.info?.(`[child-lifecycle] ${reason}：${e.purpose || e.kind} pid=${e.pid}${killed ? ' 已结束进程树' : ''}`);
    return true;
  }
  function watchTick() {
    const t = now();
    for (const e of [...entries.values()]) {
      if (!pidAlive(e.pid)) { removeDir(e.userDataDir); unregister(e.id, '进程已自行退出'); continue; }
      if (e.deadlineAt && t > e.deadlineAt) reclaim(e.id, '超过最长运行时间，强制回收');
    }
    if (memoryLow()) closeIdle('内存紧张');
    if (!entries.size && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }
  function ensureWatch() {
    if (watchTimer || !watchMs) return;
    watchTimer = setInterval(watchTick, watchMs);
    watchTimer.unref?.();
  }

  function memory() {
    const free = Number(freeMem()) || 0, total = Number(totalMem()) || 0;
    const threshold = Math.max(LOW_MEM_BYTES, total * LOW_MEM_RATIO);
    return { freeMB: Math.round(free / 1048576), totalMB: Math.round(total / 1048576), thresholdMB: Math.round(threshold / 1048576), low: total > 0 && free < threshold };
  }
  function memoryLow() { return memory().low; }
  function onIdleClose(fn) { idleClosers.add(fn); return () => idleClosers.delete(fn); }
  function closeIdle(reason) { for (const fn of idleClosers) { try { fn(reason); } catch { /* 下一轮再收 */ } } }

  function slot(kind) { if (!slots.has(kind)) slots.set(kind, { used: 0, queue: [] }); return slots.get(kind); }
  // 申请一个名额：拿到返回 release()；排队超过 waitMs 或内存一直紧张时抛错（带 code，功能侧照常记一次失败、稍后自动重试）。
  async function acquire(kind, { purpose = '', waitMs = 10 * 60000, memWaitMs = 120000, signal = null } = {}) {
    const s = slot(kind), limit = lim[kind] || Infinity;
    if (s.used >= limit) {
      const queued = new Promise((resolve, reject) => {
        const waiter = { resolve, purpose, at: now() };
        const timer = setTimeout(() => { s.queue.splice(s.queue.indexOf(waiter), 1); reject(Object.assign(new Error(`后台浏览器正被别的功能占用，排队超过 ${Math.round(waitMs / 60000)} 分钟，稍后自动重试`), { code: 'CHILD_QUEUE_TIMEOUT' })); }, waitMs);
        timer.unref?.();
        waiter.resolve = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener?.('abort', () => { const i = s.queue.indexOf(waiter); if (i >= 0) { s.queue.splice(i, 1); clearTimeout(timer); reject(Object.assign(new Error('已取消'), { code: 'ABORT_ERR' })); } }, { once: true });
        s.queue.push(waiter);
      });
      // 先排上队再请闲着的实例收掉：它一交还名额，排在第一个的就拿到。
      closeIdle(`${purpose || kind} 在排队`);
      await queued;
    } else s.used += 1;
    // 拿到名额后再看内存：紧张就先收闲着的实例、等一会儿；一直紧张就放弃这次。
    if (kind === 'edge' && memoryLow()) {
      closeIdle('内存紧张');
      const until = now() + memWaitMs;
      while (memoryLow() && now() < until && !signal?.aborted) await new Promise(r => { const t = setTimeout(r, 5000); t.unref?.(); });
      if (memoryLow()) {
        const m = memory();
        release(kind);
        note({ pid: 0, kind, purpose }, '内存紧张，这次没开', { freeMB: m.freeMB });
        throw Object.assign(new Error(`电脑可用内存只剩 ${(m.freeMB / 1024).toFixed(1)} GB，这次先不开后台浏览器，稍后自动重试`), { code: 'CHILD_LOW_MEMORY' });
      }
    }
    let released = false;
    return () => { if (!released) { released = true; release(kind); } };
  }
  function release(kind) {
    const s = slot(kind);
    const next = s.queue.shift();
    if (next) next.resolve(); else s.used = Math.max(0, s.used - 1);
  }

  // 启动时清理遗留：只认登记文件里、登记它的 Hub 已不在的条目；PID 活着且启动时间对得上才结束。
  async function reclaimOrphans() {
    if (!file) return { checked: 0, killed: 0, cleaned: 0 };
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).entries || []; } catch { return { checked: 0, killed: 0, cleaned: 0 }; }
    const stale = [], alive = [], keep = [];
    for (const e of saved) {
      if (!e || !Number.isInteger(e.pid)) continue;
      if (e.hubPid !== hubPid && pidAlive(e.hubPid)) alive.push(e); else if (e.hubPid !== hubPid) stale.push(e);
    }
    foreign = alive; // 另一个还在运行的 Hub 登记的，原样保留
    let killed = 0, cleaned = 0;
    const live = stale.filter(e => pidAlive(e.pid));
    const starts = live.length ? await probeStarts(live.map(e => e.pid)) : new Map();
    for (const e of stale) {
      const at = starts.get(e.pid);
      // 进程还活着却没查到启动时间（查询失败）：这次不动，留到下次再核对，不丢记录。
      if (!at && pidAlive(e.pid)) { keep.push(e); continue; }
      const same = at && e.startedAt && Math.abs(at - e.startedAt) <= START_TOLERANCE_MS;
      if (same && !killTree(e.pid) && pidAlive(e.pid)) { keep.push(e); continue; }
      if (same) killed += 1;
      if (e.userDataDir && removeDir(e.userDataDir)) cleaned += 1;
      note(e, same ? '上次 Hub 遗留，已结束' : '上次 Hub 遗留（进程已不在或号码被复用，只清目录）', { killed: !!same });
    }
    foreign = [...alive, ...keep];
    persist();
    if (stale.length) logger.info?.(`[child-lifecycle] 启动清理：上次遗留 ${stale.length} 条，结束 ${killed} 个进程树，删 ${cleaned} 个临时目录`);
    return { checked: stale.length, killed, cleaned };
  }

  // Hub 退出时同步收尾：自己登记的全部按 PID 结束。
  function shutdownSync() {
    for (const id of [...entries.keys()]) reclaim(id, 'Hub 退出');
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  function status() {
    const t = now();
    const active = [...entries.values()].map(e => ({ pid: e.pid, kind: e.kind, purpose: e.purpose, owner: e.owner, ageSec: Math.round((t - e.startedAt) / 1000), deadlineInSec: e.deadlineAt ? Math.round((e.deadlineAt - t) / 1000) : null }));
    const queued = {}, used = {};
    for (const [k, s] of slots) { queued[k] = s.queue.length; used[k] = s.used; }
    return { ok: true, limits: { ...lim }, used, queued, active, recent: recent.slice(0, 10), memory: memory() };
  }

  return { register, unregister, reclaim, acquire, onIdleClose, closeIdle, memory, reclaimOrphans, shutdownSync, status, watchTick, file };
}

let shared = null;
function initChildLifecycle(opts = {}) { if (shared) shared.shutdownSync(); shared = createChildLifecycle(opts); return shared; }
function getChildLifecycle() { if (!shared) shared = createChildLifecycle({}); return shared; }

module.exports = { createChildLifecycle, initChildLifecycle, getChildLifecycle, defaultKillTree, pidAlive, START_TOLERANCE_MS };
