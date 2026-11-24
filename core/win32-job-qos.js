'use strict';
// Windows 分层 Job Object + 低开销模式 EcoQoS（2026-11-23 P2）。
//
// 为什么要：node-pty 关会话只结束挂在伪终端上的那个进程；CodeAgent 拉起的 MCP 插件链（cmd/uvx/python/node/bun）、
// 共享 serve 和临时 serve 脱离父进程后成了孤儿；Hub 自己被强杀（任务管理器、内存耗尽）时更是一个都收不到。
// Job Object 是 Windows 内核的「进程收纳盒」：盒里进程派生的子孙自动进盒，盒子标了 KILL_ON_JOB_CLOSE，
// 最后一个句柄关掉时内核把盒里进程一次全部结束。
//
// 做法（零原生插件）：按需起一个隐藏的 Windows PowerShell，加载 scripts/win32-job-qos.cs（C# 5.0），逐行收发 JSON。
//   - assign：建盒、把目标进程（连同它已经派生的子孙）放进去，再用 DuplicateHandle 把盒子句柄复制进 Hub 主进程的句柄表，
//     broker 自己那份随即关掉。所以 broker 空闲 45 秒退出（稳态 0 MB）、甚至被杀，所有盒子照样在；
//     Hub 一死，内核关掉 Hub 的全部句柄，盒里进程一次清光。
//   - terminate：把 Hub 里那份句柄「收回并关闭」（DUPLICATE_CLOSE_SOURCE），结束盒里全部进程。
//   - setJobEco / setPidEco：低开销模式下给整盒进程开关 EcoQoS（节能调度）+ 低于正常优先级。
// 分层：调用方用不同前缀区分 pty: / serve: / temp-serve: / task:，每个盒子只管自己那一层，绝不跨层。
// Hub 自己从不进任何盒子：自动更新安装器、外部打开的程序、后台 taskkill 都要活过 Hub 退出。
//
// 口径：这是「内核级主兜底 + 既有进程树补杀双保险」。绑定是异步的（broker 冷启动约 0.5 秒），这段时间里已派生的子孙
// 在绑定时一并收编，但绑定前就已退出的短命根留下的孤儿仍靠 session-close-sweep / child-lifecycle 原有补杀收。
//
// 开关：AI_HUB_WIN32_JOB_OBJECT=0 关掉收纳盒，AI_HUB_WIN32_ECOQOS=0 关掉 EcoQoS，AI_HUB_WIN32_JOB_BREAKAWAY=1 应急允许
// 子进程显式脱盒（默认不允许）；非 Windows、企业策略不让嵌套（拒绝访问）、broker 起不来时都只记一条警告、照常运行。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IDLE_EXIT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MS = 45_000;
const START_TOLERANCE_MS = 10_000;
const BROKER_RETRY_MS = 10 * 60_000;
const DIRTY_RETRY_MS = 30_000;
const CPU_BUSY_HOLD_MS = 10 * 60_000;
const ECO_CPU_PERCENT = 20;
const ECO_CPU_SAMPLE_MS = 1000;
const ERROR_ACCESS_DENIED = 5;
// 这些命令重复执行结果相同，broker 中途退出时可直接重发；assign / terminate 只在确定没写出去时重发
// （terminate 带 DUPLICATE_CLOSE_SOURCE：已执行过再拿同一个句柄值重发，可能关掉 Hub 里被复用的别的句柄）。
const IDEMPOTENT = new Set(['ping', 'setJobEco', 'setPidEco', 'inspect', 'inJob', 'describe', 'cpu']);
const TRANSIENT = new Set(['broker-exit', 'broker-write', 'broker-error']);
const DEAD_TARGET = new Set(['open-process', 'start-mismatch', 'bad-pid']);

// 打包后脚本在 app.asar.unpacked/scripts（package.json asarUnpack），同 core/desktop-icon-layout.js。
function brokerScript(moduleDir = __dirname, resourcesPath = process.resourcesPath, exists = fs.existsSync) {
  const local = path.join(moduleDir, '..', 'scripts', 'win32-job-qos.ps1');
  if (!(resourcesPath && /\.asar(?:\.unpacked)?[\\/]/i.test(moduleDir))) return local;
  const unpacked = path.join(resourcesPath, 'app.asar.unpacked', 'scripts', 'win32-job-qos.ps1');
  return exists(unpacked) ? unpacked : path.join(resourcesPath, 'scripts', 'win32-job-qos.ps1');
}

// 调用方传局部 env（如测试只覆写开关）不能把 LOCALAPPDATA / TEMP / SystemRoot 等 Windows 基础环境抹空；
// 开关本身仍只看入参 env，spawn 进程再把 process.env 作为底座合入并去掉 PSModulePath。
function mergeSpawnEnv(env) {
  if (!env || env === process.env) return process.env;
  const merged = { ...process.env };
  const lowerKeys = new Map(Object.keys(merged).map(k => [k.toLowerCase(), k]));
  for (const [k, v] of Object.entries(env)) {
    const existing = lowerKeys.get(k.toLowerCase());
    const targetKey = existing || k;
    if (v === undefined) delete merged[targetKey];
    else { merged[targetKey] = v; lowerKeys.set(k.toLowerCase(), targetKey); }
  }
  return merged;
}
function powershellPath(env) {
  try { return require('./windows-powershell').windowsPowerShellPath(env); } catch { return 'powershell.exe'; }
}
function powershellEnv(env) {
  try { return require('./windows-powershell').windowsPowerShellEnv(env); } catch { return { ...env }; }
}
const tag = (pid, startMs) => `${pid}:${startMs}`;
const withTimeout = (promise, ms, code = 'wait-timeout') => (ms > 0
  ? Promise.race([promise, new Promise(resolve => { const t = setTimeout(() => resolve({ ok: false, code }), ms); t.unref?.(); })])
  : promise);

function createWin32JobQos({
  platform = process.platform, env = process.env, ownerPid = process.pid, scriptPath = null,
  idleExitMs = IDLE_EXIT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, startupTimeoutMs = null, spawnImpl = spawn,
  setPriority = os.setPriority, getPriority = os.getPriority, logger = console, now = Date.now,
  dirtyRetryMs = DIRTY_RETRY_MS, brokerRetryMs = BROKER_RETRY_MS, ecoCpuPercent = ECO_CPU_PERCENT, ecoCpuSampleMs = ECO_CPU_SAMPLE_MS,
} = {}) {
  const jobsOn = platform === 'win32' && String(env.AI_HUB_WIN32_JOB_OBJECT ?? '') !== '0';
  const ecoOn = platform === 'win32' && String(env.AI_HUB_WIN32_ECOQOS ?? '') !== '0';
  const breakaway = String(env.AI_HUB_WIN32_JOB_BREAKAWAY ?? '') === '1';
  // 冷启动（首次编译 C# 或杀毒扫描）单独给足宽限；broker 就绪后仍按 requestTimeoutMs 判定。
  // 调用方显式把 requestTimeoutMs 调小（如超时晚到测试传 1ms）且没单设 startupTimeoutMs 时，按调用方的值生效。
  const coldTimeoutMs = startupTimeoutMs != null
    ? startupTimeoutMs
    : (requestTimeoutMs < REQUEST_TIMEOUT_MS ? requestTimeoutMs : Math.max(requestTimeoutMs, STARTUP_TIMEOUT_MS));
  const PRIO = (os.constants && os.constants.priority) || {};
  const entries = new Map(); // key → job entry
  const pidEco = new Map();  // key → 独立进程的 EcoQoS 记录
  let gen = 0, seq = 0, broker = null, brokerDownUntil = 0, shuttingDown = false;
  const warned = new Set();
  const stats = { spawns: 0, requests: 0, retries: 0, assigned: 0, terminated: 0, failed: 0, lateAssigns: 0, ecoCalls: 0, wakes: 0, cpuSkips: 0 };

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    try { logger?.warn?.(`[win32-job-qos] ${message}`); } catch { /* 日志失败不影响 */ }
  }
  function tripBreaker(reason) {
    brokerDownUntil = now() + brokerRetryMs;
    warnOnce(`breaker-${reason}`, `broker 起不来（${reason}），10 分钟内不再尝试，期间按原方式关闭进程`);
  }

  // ── broker ────────────────────────────────────────────────────────────
  function settle(waiter, res) {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    waiter.resolve(res);
  }
  function failAll(b, code) {
    for (const [, waiter] of b.pending) {
      if (waiter.late) { lostLate(waiter); continue; }
      settle(waiter, { ok: false, code, written: waiter.written });
    }
    b.pending.clear();
  }
  function liveCount(b) { let n = 0; for (const w of b.pending.values()) if (!w.late) n += 1; return n; }
  function startBroker() {
    const file = scriptPath || brokerScript();
    let proc;
    const spawnEnv = mergeSpawnEnv(env);
    try {
      proc = spawnImpl(powershellPath(spawnEnv), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: powershellEnv(spawnEnv) });
    } catch (error) {
      tripBreaker(error.message);
      return null;
    }
    stats.spawns += 1;
    const b = { proc, pending: new Map(), buf: '', idleTimer: null, ready: false, closing: false, shutdown: false };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      b.buf += chunk;
      let i;
      while ((i = b.buf.indexOf('\n')) >= 0) {
        const line = b.buf.slice(0, i).trim();
        b.buf = b.buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready === false) { tripBreaker(msg.error || '初始化失败'); failAll(b, 'broker-unavailable'); continue; }
        if (msg.ready === true) { b.ready = true; continue; }
        const waiter = b.pending.get(String(msg.id));
        if (!waiter) continue;
        b.pending.delete(String(msg.id));
        if (waiter.late) handleLate(waiter, msg);
        else settle(waiter, msg);
        armIdle(b);
      }
    });
    proc.on('error', error => {
      if (broker === b) broker = null;
      if (!b.ready && !b.shutdown) tripBreaker(error.message);
      failAll(b, 'broker-error');
    });
    proc.on('exit', code => {
      if (broker === b) broker = null;
      clearTimeout(b.idleTimer);
      // 还没就绪就退出（脚本缺失、策略拦截、编译失败）：熔断 10 分钟，免得每轮巡检都拉起一个注定失败的 PowerShell。
      if (!b.ready && !b.shutdown && !b.closing) tripBreaker(`退出码 ${code}`);
      failAll(b, 'broker-exit');
    });
    proc.stdin.on('error', () => { /* broker 已退出：exit 里统一收尾 */ });
    return b;
  }
  function armIdle(b) {
    clearTimeout(b.idleTimer);
    b.idleTimer = null;
    if (liveCount(b) || !(idleExitMs > 0) || b.closing) return;
    // 空闲就先摘掉引用、再关 stdin：之后的新请求一定发给新 broker，不会落到正在退出的这个上。句柄都在 Hub 里，盒子不受影响。
    b.idleTimer = setTimeout(() => {
      if (liveCount(b)) return;
      if (broker === b) broker = null;
      b.closing = true;
      try { b.proc.stdin.end(); } catch { /* 已退出 */ }
    }, idleExitMs);
    b.idleTimer.unref?.();
  }
  function blocked() {
    if (shuttingDown) return { ok: false, code: 'shutting-down', skipped: 'shutting-down' };
    if (platform !== 'win32') return { ok: false, code: 'not-windows' };
    if (now() < brokerDownUntil) return { ok: false, code: 'broker-unavailable' };
    return null;
  }
  function sendOnce(cmd, fields, extra) {
    const stop = blocked();
    if (stop) return Promise.resolve(stop);
    if (!broker || broker.closing) broker = startBroker();
    const b = broker;
    if (!b) return Promise.resolve({ ok: false, code: 'broker-unavailable' });
    clearTimeout(b.idleTimer);
    b.idleTimer = null;
    const id = String(++seq);
    stats.requests += 1;
    const timeoutMs = b.ready ? requestTimeoutMs : coldTimeoutMs;
    return new Promise(resolve => {
      const waiter = { cmd, resolve, timer: null, written: false, done: false, late: false, ...extra };
      waiter.timer = setTimeout(() => {
        // assign 超时不丢账：broker 晚到的句柄还要认领或回收（见 handleLate）。
        if (cmd === 'assign') waiter.late = true; else b.pending.delete(id);
        settle(waiter, { ok: false, code: 'timeout', written: waiter.written });
        armIdle(b);
      }, timeoutMs);
      waiter.timer.unref?.();
      b.pending.set(id, waiter);
      try {
        b.proc.stdin.write(JSON.stringify({ id, cmd, ownerPid, ...fields }) + '\n', error => {
          if (error) { b.pending.delete(id); settle(waiter, { ok: false, code: 'broker-write', written: false }); } else waiter.written = true;
        });
      } catch { b.pending.delete(id); settle(waiter, { ok: false, code: 'broker-write', written: false }); }
    });
  }
  // 瞬态失败（broker 中途退出、写不进去）重建 broker 重试一次。
  async function request(cmd, fields = {}, extra = {}) {
    const res = await sendOnce(cmd, fields, extra);
    if (!res || res.ok || !TRANSIENT.has(res.code) || blocked()) return res;
    if (!IDEMPOTENT.has(cmd) && res.written) return res;
    stats.retries += 1;
    return sendOnce(cmd, fields, extra);
  }

  // ── jobs ──────────────────────────────────────────────────────────────
  // 返回这次绑定的 key（`<base>:<gen>`），调用方记下、之后按它结束；关掉或不适用时返回 ''。
  // 身份核对：expectedStartMs ± toleranceMs 是估计；minStartMs / maxStartMs 是观察边界（进程不可能晚于看到它的那一刻出生），
  // broker 在同一个句柄上核对：下界留 0.5 秒时钟余量，上界严格（晚于观察时刻出生即拒绝）。
  function assign(base, pid, { expectedStartMs = 0, toleranceMs = START_TOLERANCE_MS, minStartMs = 0, maxStartMs = 0,
    layer = String(base).split(':')[0], descendants = true } = {}) {
    if (!jobsOn || shuttingDown) return '';
    const n = Number(pid);
    if (!Number.isSafeInteger(n) || n <= 0 || n === ownerPid) return '';
    const key = `${base}:${++gen}`;
    const entry = { key, base: String(base), layer, pid: n, state: 'pending', handle: 0, eco: false, dirty: false, ecoGen: 0,
      lowered: new Set(), cancelRequested: false, startMs: 0, at: now(), lastDirtyTry: 0, cpuBusyUntil: 0 };
    entries.set(key, entry);
    const round = v => Math.max(0, Math.round(Number(v) || 0));
    entry.ready = request('assign', { pid: n, expectedStartMs: round(expectedStartMs), toleranceMs, minStartMs: round(minStartMs),
      maxStartMs: round(maxStartMs), descendants, breakaway }, { entry }).then(res => onAssigned(entry, res));
    return key;
  }
  function adopt(entry, res) {
    entry.handle = Number(res.jobHandle);
    entry.startMs = Number(res.startMs) || 0;
    entry.state = 'active';
    stats.assigned += 1;
  }
  function onAssigned(entry, res) {
    if (res && res.ok && Number(res.jobHandle) > 0) {
      adopt(entry, res);
      // 绑定还没回来时就被要求结束：拿到句柄立刻补发结束，句柄不泄漏、进程不漏杀。
      if (entry.cancelRequested) return finishTerminate(entry);
      return res;
    }
    if (res && res.code === 'timeout') { entry.state = 'lost'; return res; } // 等 broker 晚到的回包
    entry.state = 'failed';
    stats.failed += 1;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (res && Number(res.win32Error) === ERROR_ACCESS_DENIED && res.code === 'assign') {
      warnOnce('nested', '系统不允许把进程放进新的 Job（企业策略或宿主限制），退回原有的关闭补杀');
    } else if (res && !['start-mismatch', 'open-process', 'not-windows', 'shutting-down', 'broker-unavailable'].includes(res.code)) {
      warnOnce(`assign-${res && res.code}`, `进程收纳没成功（${res && res.code}${res && res.win32Error ? ` / ${res.win32Error}` : ''}），退回原有的关闭补杀`);
    }
    return res;
  }
  // 超时之后 broker 才回的 assign：会话还在等就认领回来；已被要求结束或 Hub 正在退出就立刻回收句柄。
  function handleLate(waiter, msg) {
    const entry = waiter.entry;
    stats.lateAssigns += 1;
    const handle = msg && msg.ok ? Number(msg.jobHandle) : 0;
    if (!(handle > 0)) { lostLate(waiter); return; }
    const tracked = entry && entries.get(entry.key) === entry && entry.state === 'lost';
    if (tracked) {
      adopt(entry, msg);
      if (entry.cancelRequested && !shuttingDown) void finishTerminate(entry);
      return;
    }
    // 没人认领：只要不是在退出，就收回并结束这个盒子（Hub 退出时内核也会关掉它）。
    if (!shuttingDown) void request('terminate', { jobHandle: handle });
  }
  function lostLate(waiter) {
    const entry = waiter.entry;
    if (entry && entries.get(entry.key) === entry && entry.state === 'lost') { entry.state = 'failed'; entries.delete(entry.key); }
  }
  function finishTerminate(entry) {
    entry.state = 'releasing';
    entry.releasing = request('terminate', { jobHandle: entry.handle }).then(res => {
      const code = res && res.code;
      if ((res && res.ok) || code === 'bad-handle' || code === 'duplicate-handle') {
        entry.state = 'released';
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        if (res && res.ok) stats.terminated += 1;
      } else if (!res || res.written || code === 'timeout' || code === 'exception') {
        // 可能已在 broker 里执行过（句柄已收回关闭）：不能拿同一个句柄值重发，只记账；Hub 退出时内核兜底。
        entry.state = 'released';
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        warnOnce('terminate-uncertain', `结束进程盒子的结果不确定（${code}），交给原有补杀与 Hub 退出兜底`);
      } else {
        entry.state = 'active'; // 确定没执行（退出中、broker 不可用、没写出去）：留账，可再结束，Hub 退出时内核兜底
      }
      entry.releasing = null;
      return res;
    });
    return entry.releasing;
  }
  // 结束这一盒（只这一盒）。正常关闭时调用方在根进程确认退出之后再调，用来收脱离的孙进程。
  // timeoutMs：调用方最多等这么久（关闭路径不长阻塞），超时后后台照常继续。
  function terminate(key, { timeoutMs = 0 } = {}) {
    const entry = key ? entries.get(key) : null;
    if (!entry) return Promise.resolve({ ok: false, code: 'unknown-key' });
    let p;
    if (entry.state === 'pending') { entry.cancelRequested = true; p = entry.ready; }
    else if (entry.state === 'lost') { entry.cancelRequested = true; p = Promise.resolve({ ok: false, code: 'pending-late' }); }
    else if (entry.state === 'active') p = finishTerminate(entry);
    else p = entry.releasing || entry.ready || Promise.resolve({ ok: false, code: entry.state });
    return withTimeout(p, timeoutMs);
  }

  // ── EcoQoS ────────────────────────────────────────────────────────────
  // entry.eco 是期望态，entry.dirty 表示「还没确认落实」（请求失败或部分进程没改成）：dirty 时巡检、唤醒、全量恢复都会重试。
  // entry.lowered 是 broker 回报的「被我们从正常降到低于正常」的进程（PID + 启动时间），恢复时只把这些抬回去，
  // 本来就是低于正常的进程（按算力账本降过权的长任务等）保持不变。
  function setJobEco(key, enabled) {
    const entry = key ? entries.get(key) : null;
    const want = enabled === true;
    if (shuttingDown) return Promise.resolve({ ok: false, skipped: 'shutting-down' });
    if (!entry || entry.state !== 'active') return Promise.resolve({ ok: false, code: 'not-active' });
    if (want && !ecoOn) return Promise.resolve({ ok: false, code: 'eco-disabled' });
    // 状态没变不发命令：不会为了「保持原样」去唤醒已经退出的 broker。
    if (entry.eco === want && !entry.dirty) return Promise.resolve({ ok: true, unchanged: true });
    if (want && entry.cpuBusyUntil > now()) return Promise.resolve({ ok: true, skipped: 'cpu-busy' });
    const myGen = ++entry.ecoGen;
    entry.eco = want;
    entry.dirty = true;
    entry.lastDirtyTry = now();
    stats.ecoCalls += 1;
    const fields = { jobHandle: entry.handle, enabled: want, lowered: [...entry.lowered].join(',') };
    // 第一次降速前先量 1 秒盒内 CPU：超过单核 20%（后台仿真、编译还在跑）就这轮不降。
    if (want && !entry.lowered.size && ecoCpuPercent > 0) Object.assign(fields, { maxCpuPercent: ecoCpuPercent, sampleMs: ecoCpuSampleMs });
    return request('setJobEco', fields).then(res => {
      // 降速请求在途（含 1 秒 CPU 采样）时被唤醒覆盖：broker 仍可能已经降了一批进程。不管代次，先把它回报的「被我们降过」并入账；
      // 若此刻期望是全速，立刻抬回根进程并补发一次恢复，把刚降的那批全部抬回正常（否则在途的恢复请求拿的是旧清单、抬不回）。
      if (want && res && res.ok && entries.get(key) === entry) {
        for (const t of String(res.lowered || '').split(',').filter(Boolean)) entry.lowered.add(t);
        if (entry.ecoGen !== myGen && !entry.eco && res.lowered) {
          raiseRoot(entry);
          entry.dirty = true;
          entry.lastDirtyTry = 0;
          void setJobEco(key, false);
          return res;
        }
      }
      if (entry.ecoGen !== myGen || entries.get(key) !== entry) return res; // 已有更新的一次开关，不覆盖
      if (res && res.ok && res.skipped === 'cpu-busy') {
        entry.eco = false; entry.dirty = false; entry.cpuBusyUntil = now() + CPU_BUSY_HOLD_MS; stats.cpuSkips += 1;
        return res;
      }
      if (res && res.ok && !(Number(res.failed) > 0)) { entry.dirty = false; if (!want) entry.lowered.clear(); }
      return res;
    });
  }
  function isNormalPrio(pid) { try { return PRIO.PRIORITY_NORMAL != null && getPriority(pid) === PRIO.PRIORITY_NORMAL; } catch { return false; } }
  // 同步把根进程抬回正常优先级（一次系统调用）。只在 broker 回报过「根是我们降的」、且这一代盒子还在（根没退出）时才动。
  function raiseRoot(entry) {
    if (PRIO.PRIORITY_NORMAL == null || entry.state !== 'active' || !entry.lowered.has(tag(entry.pid, entry.startMs))) return false;
    try { setPriority(entry.pid, PRIO.PRIORITY_NORMAL); return true; } catch { return false; /* 进程已退出 */ }
  }
  function wake(key, { force = false } = {}) {
    const entry = key ? entries.get(key) : null;
    if (!entry || entry.state !== 'active' || !(entry.eco || entry.dirty)) return false;
    // 关闭没确认落实（dirty）时限速重试，免得每敲一个键就去拉一次 broker。
    if (!entry.eco && !force && now() - entry.lastDirtyTry < dirtyRetryMs) return false;
    stats.wakes += 1;
    const t0 = process.hrtime.bigint();
    raiseRoot(entry);
    stats.lastRaiseUs = Number(process.hrtime.bigint() - t0) / 1000;
    void setJobEco(key, false);
    return true;
  }
  // 独立进程（历史搜索子进程）：priority=false 时只动 EcoQoS，不碰它本来就设好的优先级。opGen 防开关重叠互相覆盖。
  function setPidEco(key, pid, { expectedStartMs = 0, toleranceMs = START_TOLERANCE_MS, maxStartMs = 0, enabled = false, priority = true } = {}) {
    const want = enabled === true;
    const n = Number(pid);
    if (shuttingDown) return Promise.resolve({ ok: false, skipped: 'shutting-down' });
    if (!Number.isSafeInteger(n) || n <= 0 || n === ownerPid) return Promise.resolve({ ok: false, code: 'bad-pid' });
    let rec = pidEco.get(key);
    if (rec && rec.pid !== n) { pidEco.delete(key); rec = null; } // 换了进程：旧的已经不在
    if (!rec) {
      if (!want) return Promise.resolve({ ok: true, unchanged: true });
      if (!ecoOn) return Promise.resolve({ ok: false, code: 'eco-disabled' });
      rec = { pid: n, startMs: Math.round(Number(expectedStartMs) || 0), maxStartMs: Math.round(Number(maxStartMs) || 0), toleranceMs,
        eco: false, dirty: false, priority: priority !== false, lowered: false, opGen: 0, lastDirtyTry: 0 };
      pidEco.set(key, rec);
    }
    if (want && !ecoOn) return Promise.resolve({ ok: false, code: 'eco-disabled' });
    if (rec.eco === want && !rec.dirty) return Promise.resolve({ ok: true, unchanged: true });
    const myGen = ++rec.opGen;
    rec.eco = want;
    rec.dirty = true;
    rec.lastDirtyTry = now();
    stats.ecoCalls += 1;
    return request('setPidEco', { pid: n, expectedStartMs: rec.startMs, toleranceMs: rec.toleranceMs, maxStartMs: rec.maxStartMs, enabled: want,
      priority: rec.priority, restorePriority: rec.lowered }).then(res => {
      // 同 setJobEco：开启在途时被关闭覆盖，broker 已降的优先级先并入账，期望是全速就立刻抬回并补发一次恢复。
      if (want && res && res.ok && res.lowered === true) {
        rec.lowered = true;
        if (rec.opGen !== myGen && !rec.eco) {
          if (!pidEco.has(key)) pidEco.set(key, rec);
          if (pidEco.get(key) === rec) {
            if (rec.priority && PRIO.PRIORITY_NORMAL != null) { try { setPriority(rec.pid, PRIO.PRIORITY_NORMAL); } catch { /* 已退出 */ } }
            rec.dirty = true;
            rec.lastDirtyTry = 0;
            void setPidEco(key, rec.pid, { expectedStartMs: rec.startMs, maxStartMs: rec.maxStartMs, toleranceMs: rec.toleranceMs, enabled: false, priority: rec.priority });
          }
          return res;
        }
      }
      if (pidEco.get(key) !== rec || rec.opGen !== myGen) return res; // 新的一次开关已经发出，不覆盖、不删除
      if (res && res.ok && res.applied) {
        rec.dirty = false;
        if (!want) pidEco.delete(key);
      } else if (res && !res.ok && DEAD_TARGET.has(res.code)) pidEco.delete(key); // 进程已不在（或号码被复用）
      return res;
    });
  }
  function wakePid(key, { force = false } = {}) {
    const rec = pidEco.get(key);
    if (!rec || !(rec.eco || rec.dirty)) return false;
    if (!rec.eco && !force && now() - rec.lastDirtyTry < dirtyRetryMs) return false;
    stats.wakes += 1;
    if (rec.priority && rec.lowered && PRIO.PRIORITY_NORMAL != null) { try { setPriority(rec.pid, PRIO.PRIORITY_NORMAL); } catch { /* 已退出 */ } }
    void setPidEco(key, rec.pid, { expectedStartMs: rec.startMs, maxStartMs: rec.maxStartMs, toleranceMs: rec.toleranceMs, enabled: false, priority: rec.priority });
    return true;
  }
  // 关掉低开销模式：所有降速（或恢复未确认）的盒子和进程立刻恢复。
  function restoreAllEco() {
    let n = 0;
    for (const entry of [...entries.values()]) if (wake(entry.key, { force: true })) n += 1;
    for (const key of [...pidEco.keys()]) if (wakePid(key, { force: true })) n += 1;
    return n;
  }

  // Hub 退出（will-quit 最后）：终态屏障——之后不再绑定、不再改 EcoQoS、不再拉起 broker；关掉 broker、清表。
  // Hub 进程一退出，内核关闭它持有的全部盒子句柄（盒里还剩的进程一并结束）。
  function shutdownSync() {
    shuttingDown = true;
    const b = broker;
    broker = null;
    if (b) {
      b.shutdown = true;
      clearTimeout(b.idleTimer);
      failAll(b, 'shutting-down');
      try { b.proc.stdin.end(); } catch { /* 已退出 */ }
      try { b.proc.kill(); } catch { /* 已退出 */ }
    }
    const n = entries.size;
    entries.clear();
    pidEco.clear();
    return n;
  }

  function get(key) {
    const e = entries.get(key);
    return e ? { key: e.key, layer: e.layer, pid: e.pid, state: e.state, eco: e.eco, dirty: e.dirty, handle: e.handle, startMs: e.startMs,
      lowered: [...e.lowered], cancelRequested: e.cancelRequested, cpuBusyUntil: e.cpuBusyUntil } : null;
  }
  function list() { return [...entries.values()].map(e => ({ key: e.key, layer: e.layer, pid: e.pid, state: e.state, eco: e.eco, dirty: e.dirty, handle: e.handle })); }
  function brokerPid() { return broker?.proc?.pid || 0; }

  return {
    enabled: () => jobsOn, ecoAvailable: () => ecoOn,
    assign, terminate, setJobEco, wake, setPidEco, wakePid, restoreAllEco, shutdownSync,
    get, list, brokerPid, isEco: key => entries.get(key)?.eco === true, pidEcoOn: key => pidEco.get(key)?.eco === true,
    pidEcoRecord: key => { const r = pidEco.get(key); return r ? { ...r } : null; },
    stats: () => ({ ...stats, jobs: entries.size, ecoJobs: [...entries.values()].filter(e => e.eco).length, broker: brokerPid(),
      breakerOpen: now() < brokerDownUntil, shuttingDown }),
    request, // 诊断与测试：inspect / inJob / describe / cpu
  };
}

// 主进程装上之前，全局实例是不做任何事的空壳：单测、公开版脚本、子进程里 require 这些模块时不会去起 broker。
const INERT = Object.freeze({
  enabled: () => false, ecoAvailable: () => false, assign: () => '', terminate: () => Promise.resolve({ ok: false, code: 'inert' }),
  setJobEco: () => Promise.resolve({ ok: false, code: 'inert' }), wake: () => false,
  setPidEco: () => Promise.resolve({ ok: false, code: 'inert' }), wakePid: () => false, restoreAllEco: () => 0, shutdownSync: () => 0,
  get: () => null, list: () => [], brokerPid: () => 0, isEco: () => false, pidEcoOn: () => false, pidEcoRecord: () => null, stats: () => ({ jobs: 0 }),
  request: () => Promise.resolve({ ok: false, code: 'inert' }),
});
let shared = null;
function initWin32JobQos(options = {}) { if (shared) shared.shutdownSync(); shared = createWin32JobQos(options); return shared; }
function getWin32JobQos() { return shared || INERT; }
function resetWin32JobQosForTest() { if (shared) shared.shutdownSync(); shared = null; }

module.exports = { createWin32JobQos, initWin32JobQos, getWin32JobQos, resetWin32JobQosForTest, brokerScript, IDLE_EXIT_MS, REQUEST_TIMEOUT_MS, STARTUP_TIMEOUT_MS, START_TOLERANCE_MS };
