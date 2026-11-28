'use strict';

// 整机 CPU 读数与任务管理器同口径（2026-11-28，两台电脑实测后定）。
//
// 任务管理器的 CPU 口径随 Windows 版本变：
// - 旧版（Win10、Win11 24H2 早期补丁，如 26100.4061）：「进程 / 性能」页显示「% Processor Utility」
//   （处理器利用率 = 忙碌时间 × 当前频率 / 标称频率，睿频时高于忙碌时间，超过 100 按 100 显示）。
//   i7-14700 实测：任务管理器 51–94%，同刻利用率计数器 46–90%，忙碌时间只有 23–54%。
// - 新版（Win11 24H2 的 KB5064081 起即 26100.5074+，25H2 即 26200+）：微软改成「标准口径」
//   = 各进程 CPU 时间增量 ÷（经过时间 × 逻辑核数），即忙碌时间，和 os.cpus() 同一算法。
// 所以按系统版本选口径：新版直接用 os.cpus()（不起任何进程）；旧版起一个常驻 typeperf
// （系统自带计数器工具，无窗口、无 .NET）每秒读利用率与忙碌时间，取最近窗口均值。
// typeperf 带 -sc 上限会自己退出（Hub 崩了也不残留），仍有人在读就续上，没人读 idleMs 后停掉；
// 计数器读不到（策略限制）时 pct 为 null，调用方回落忙碌时间并在悬停里写明。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: spawnDefault, execFile: execFileDefault } = require('child_process');

const COUNTERS = [
  '\\Processor Information(_Total)\\% Processor Utility',
  '\\Processor Information(_Total)\\% Processor Time',
];
const SAMPLE_COUNT = 300;
const IDLE_MS = 30_000;
const KEEP_MS = 15_000;
const MAX_FAILED_STARTS = 3;
const FAILED_COOLDOWN_MS = 10 * 60_000;
// KB5064081（2025-08，24H2 预览更新）起任务管理器改用标准口径；26100 补丁号不低于它即新版。
const NEW_TASKMGR_26100_UBR = 5074;

// typeperf 一行：`"11/28/2026 16:40:59.294","48.77","30.12"`（利用率、忙碌时间）；
// 表头、空行、读不到时的 `" "` 都跳过。小数点按区域设置可能是逗号，统一换成点。
function parseTypeperfLine(line) {
  const match = String(line || '').trim().match(/^"[^"]*","(-?[\d.,]+)","(-?[\d.,]+)"$/);
  if (!match) return null;
  const utility = Number(match[1].replace(',', '.'));
  const time = Number(match[2].replace(',', '.'));
  return Number.isFinite(utility) && utility >= 0 && Number.isFinite(time) && time >= 0 ? { utility, time } : null;
}

// scale = 利用率 / 忙碌时间：用来把单个进程的 CPU 时间折算成旧版任务管理器「进程」页的数。
function averageSince(samples, cutoff) {
  const recent = samples.filter(sample => sample.at > cutoff);
  if (!recent.length) return null;
  // 任务管理器每秒的读数各自封顶 100，所以先逐秒封顶再平均（公司实测：不逐秒封顶时满载段会高出 11 点）。
  const shown = recent.reduce((sum, sample) => sum + Math.min(100, sample.utility), 0) / recent.length;
  const utility = recent.reduce((sum, sample) => sum + sample.utility, 0) / recent.length;
  const time = recent.reduce((sum, sample) => sum + sample.time, 0) / recent.length;
  return { pct: shown, scale: time >= 1 ? utility / time : null, count: recent.length };
}

// 任务管理器用哪种口径：'time'（新版，忙碌时间）或 'utility'（旧版，处理器利用率）。
// release 形如 '10.0.26100'（os.release()）；ubr 是补丁号（注册表 CurrentVersion\UBR），只有 26100 需要。
function taskManagerCpuMode(release, ubr) {
  const build = Number(String(release || '').split('.')[2]);
  if (!Number.isFinite(build)) return 'utility';
  if (build >= 26200) return 'time';
  if (build === 26100) return Number(ubr) >= NEW_TASKMGR_26100_UBR ? 'time' : 'utility';
  return 'utility';
}

function readUbr(execFile, done) {
  try {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'UBR'],
      { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
        const match = !error && String(stdout || '').match(/UBR\s+REG_DWORD\s+0x([0-9a-f]+)/i);
        done(match ? parseInt(match[1], 16) : null);
      });
  } catch { done(null); }
}

function createCpuUtilitySampler(options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawn || spawnDefault;
  const now = options.now || Date.now;
  const idleMs = options.idleMs || IDLE_MS;
  const counterFile = options.counterFile || path.join(os.tmpdir(), `hub-cpu-utility-counter-${process.pid}.txt`);
  // 口径：单测可直接传 mode；否则按系统版本判断。26100 要异步读补丁号，读到前按旧版处理。
  let mode = options.mode || null;
  if (!mode && platform === 'win32') {
    const release = options.release || os.release();
    if (String(release).split('.')[2] === '26100') {
      mode = 'utility';
      readUbr(options.execFile || execFileDefault, ubr => {
        mode = taskManagerCpuMode(release, ubr);
        // 补丁号回来前若已按旧版起了 typeperf，切到新版后立刻停掉（延后一拍，回调可能是同步的）。
        if (mode === 'time') setImmediate(() => { if (child) stop(); });
      });
    } else {
      mode = taskManagerCpuMode(release, null);
    }
  }
  let child = null;
  let samples = [];
  let lastReadAt = 0;
  let failedStarts = 0;
  let cooldownUntil = 0;
  let idleTimer = null;
  let disposed = false;

  function stop() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const target = child;
    child = null;
    if (target) { try { target.kill(); } catch {} }
  }

  function noteFailedStart() {
    if (++failedStarts < MAX_FAILED_STARTS) return;
    failedStarts = 0;
    cooldownUntil = now() + FAILED_COOLDOWN_MS;
  }

  function start() {
    if (disposed || platform !== 'win32' || child || now() < cooldownUntil) return;
    // 计数器名放进 -cf 文件：直接当参数传时 typeperf 报「没有有效的计数器」（Node 加引号的方式它不认）。
    try { fs.writeFileSync(counterFile, COUNTERS.join('\r\n') + '\r\n', 'ascii'); } catch { noteFailedStart(); return; }
    let target;
    try {
      target = spawn('typeperf', ['-cf', counterFile, '-si', '1', '-sc', String(SAMPLE_COUNT)], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { noteFailedStart(); return; }
    child = target;
    let buffer = '';
    let gotSample = false;
    target.stdout?.setEncoding?.('latin1');
    target.stdout?.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const value = parseTypeperfLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (value == null) continue;
        gotSample = true;
        failedStarts = 0;
        const at = now();
        samples.push({ at, ...value });
        if (samples.length > 64) samples = samples.filter(sample => sample.at > at - KEEP_MS);
      }
    });
    const onEnd = () => {
      if (child !== target) return;
      child = null;
      if (!gotSample) { noteFailedStart(); return; }
      // -sc 到点正常退出：还有人在看就接着采。
      if (now() - lastReadAt < idleMs) start();
    };
    target.on?.('exit', onEnd);
    target.on?.('error', onEnd);
  }

  // 返回 { mode, pct, scale, count }：
  // - mode 'time'：任务管理器按忙碌时间算，调用方直接用 os.cpus()；这里不起进程，pct 为 null。
  // - mode 'utility'：pct 是最近 windowMs 内的平均利用率（0–100）；没有新鲜样本时 pct 为 null。
  // 非 Windows 返回 null。
  function read(windowMs = 5_000) {
    if (disposed || platform !== 'win32') return null;
    if (mode === 'time') {
      if (child) stop();
      return { mode: 'time', pct: null, scale: 1, count: 0 };
    }
    lastReadAt = now();
    if (!child) start();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
    idleTimer.unref?.();
    const avg = averageSince(samples, lastReadAt - Math.max(1_500, windowMs));
    return { mode: 'utility', pct: avg ? avg.pct : null, scale: avg ? avg.scale : null, count: avg ? avg.count : 0 };
  }

  return {
    read,
    dispose() {
      disposed = true; stop();
      if (!options.counterFile) { try { fs.unlinkSync(counterFile); } catch {} }
    },
    _state: () => ({ running: !!child, samples: samples.length, cooldownUntil, mode }),
  };
}

module.exports = { createCpuUtilitySampler, parseTypeperfLine, averageSince, taskManagerCpuMode, COUNTERS };
