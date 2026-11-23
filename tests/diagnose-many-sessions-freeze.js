'use strict';
// 「开很多会话、CodeAgent 跑任务时 Hub 每 3–5 秒卡一下」的本机复现与计量（2026-11-23）。
// 隔离 Hub（后台窗口、独立数据目录）里开 N 个 CodeAgent 会话，全部用 tests/fixtures/codeagent-busy-fake 替身：
// 终端持续刷新、原生记录持续追加、每次工具调用报 hook。等它们跑稳后同时量：
//   主进程：事件循环卡顿（>50 ms 的停顿、延迟分布）、CPU 剖析、同步起子进程耗时（core/main-cpu-profiler.js）；
//   界面进程：50 ms 心跳的迟到量、longtask、CPU 剖析；
//   往返：界面每 250 ms 调一次最轻的 IPC，量主进程响应耗时。
// 输出到 --out 目录：summary.json（数字）+ 两份 cpuprofile + 卡顿窗口里最常见的调用栈。
//
//   node tests/diagnose-many-sessions-freeze.js [--sessions 12] [--warm 25] [--measure 60] [--out <dir>] [--label before]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const N = Math.max(1, Math.min(24, Number(arg('--sessions', 12))));
const warmSec = Number(arg('--warm', 25));
const measureSec = Number(arg('--measure', 60));
const label = arg('--label', 'run');
const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), `hub-many-sessions-${label}-${Date.now()}`)));
fs.mkdirSync(outDir, { recursive: true });
for (const key of Object.keys(process.env)) {
  if (/^CODEAGENT_HUB_/.test(key) || ['CODEAGENT3_LAUNCHER_PID', 'CODEAGENT3_X_AUTH_TOKEN', 'CODEAGENT3_CONFIG_DIR'].includes(key)) delete process.env[key];
}
process.env.HUB_TEST_PRIORITY = process.env.HUB_TEST_PRIORITY || 'normal';
const FAKE = path.join(__dirname, 'fixtures', 'codeagent-busy-fake', 'codeagent.cmd');
const j = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// 卡顿窗口里出现最多的调用栈（叶子往上取 8 层、只留 Hub 自己的代码帧）。
function stacksInWindows(profile, windows, toProfileUs) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const frameOf = n => { const cf = n.callFrame; const file = (cf.url || '').split(/[\\/]/).slice(-2).join('/'); return `${cf.functionName || '(anon)'}@${file}:${cf.lineNumber + 1}`; };
  const appFrame = n => /claude-session-hub|wt-r14|aihub|[\\/](core|main|renderer)[\\/]|main\.js/.test(n.callFrame.url || '') && !/node_modules/.test(n.callFrame.url || '');
  const counts = new Map(); const selfCounts = new Map();
  let t = profile.startTime;
  const wins = windows.map(w => [toProfileUs(w[0]), toProfileUs(w[1])]);
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] || 0;
    if (!wins.some(([a, b]) => t >= a && t <= b)) continue;
    let id = profile.samples[i]; const chain = []; const leaf = byId.get(id);
    if (leaf) selfCounts.set(frameOf(leaf), (selfCounts.get(frameOf(leaf)) || 0) + 1);
    while (id != null && chain.length < 8) { const n = byId.get(id); if (!n) break; if (appFrame(n)) chain.push(frameOf(n)); id = parent.get(id); }
    const key = chain.join(' <- ') || '(无 Hub 代码帧：GC / 原生 / 空闲)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ samples: v, stack: k }));
  return { topAppStacks: top(counts), topSelf: top(selfCounts) };
}

function selfTimeTop(profile, limit = 25) {
  const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); if (!n) continue;
    const cf = n.callFrame; const key = `${cf.functionName || '(anon)'}@${(cf.url || '').split(/[\\/]/).slice(-2).join('/')}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, us]) => ({ ms: Math.round(us / 1000), fn: k }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-many-'));
  const dataDir = path.join(root, 'data'), cac = path.join(root, '.cac'), home = path.join(root, 'home');
  for (const d of [dataDir, cac, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  const trigger = path.join(root, 'start-main-profile');
  let hub, c;
  const summary = { label, sessions: N, warmSec, measureSec, startedAt: new Date().toISOString() };
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'background', label: 'many-sessions', extraArgs: argv.includes('--trace-gc') ? ['--js-flags=--trace-gc'] : [], extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: FAKE, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: home, DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      HUB_MAIN_CPU_PROFILE: String(measureSec), HUB_MAIN_CPU_PROFILE_TRIGGER: trigger, HUB_MAIN_HEAP_SAMPLE: argv.includes('--heap') ? '1' : '' } });
    c = await connectFirstPage(hub, null, { commandTimeoutMs: 60000 });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(300); } throw Error('timeout: ' + what); };
    await until('typeof sessions !== "undefined" && typeof ipcRenderer !== "undefined"', 'renderer ready');
    const ids = [];
    for (let i = 0; i < N; i++) {
      const cwd = path.join(root, `ws-${String(i + 1).padStart(2, '0')}`); fs.mkdirSync(cwd, { recursive: true });
      const created = await c.eval(`ipcRenderer.invoke('create-session', ${j({ kind: 'codeagent', opts: { cwd, effort: 'low', mcpProfile: 'none' } })})`);
      if (!created || !created.id) throw Error('create-session failed: ' + j(created));
      ids.push(created.id);
    }
    summary.sessionIds = ids.length;
    await until(`document.querySelectorAll('.session-item').length >= ${N}`, 'sidebar rows', 30000);
    // 选中第一个会话（用户正在看其中一个终端），其余在后台跑。
    await c.eval(`selectSession(${j(ids[0])})`);
    await sleep(warmSec * 1000);
    summary.transcriptBytesAtStart = dirBytes(path.join(cac, 'projects'));

    // 界面进程心跳 + longtask + IPC 往返
    await c.eval(`(() => {
      const w = window.__freezeProbe = { lates: [], stalls: [], longtasks: [], ipc: [], ipcSlow: [], t0: Date.now() };
      let last = performance.now();
      w.hb = setInterval(() => { const t = performance.now(); const late = t - last - 50; w.lates.push(Math.max(0, late)); if (late >= 50) w.stalls.push([Date.now() - late, Date.now(), Math.round(late)]); last = t; }, 50);
      try { w.po = new PerformanceObserver(l => { for (const e of l.getEntries()) w.longtasks.push(Math.round(e.duration)); }); w.po.observe({ entryTypes: ['longtask'] }); } catch {}
      w.ipcT = setInterval(async () => { const a = performance.now(); try { await ipcRenderer.invoke('hub:feedback-ping'); } catch {} const d = performance.now() - a; w.ipc.push(d); if (d >= 100) w.ipcSlow.push([Date.now() - d, Date.now(), Math.round(d)]); }, 250);
      return true; })()`);
    await c.send('Profiler.enable');
    await c.send('Profiler.setSamplingInterval', { interval: 1000 });
    const rendererProfileEpochMs = await c.eval('Date.now()');
    await c.send('Profiler.start');
    fs.writeFileSync(trigger, 'go');
    const mainStartEpoch = Date.now();
    await sleep(measureSec * 1000);
    const { profile: rProfile } = await c.send('Profiler.stop', {}, { timeoutMs: 120000 });
    const probe = await c.eval(`(() => { const w = window.__freezeProbe; clearInterval(w.hb); clearInterval(w.ipcT); try { w.po.disconnect(); } catch {} return w; })()`);
    fs.writeFileSync(path.join(outDir, `renderer-${label}.cpuprofile`), JSON.stringify(rProfile));
    summary.transcriptBytesAtEnd = dirBytes(path.join(cac, 'projects'));
    summary.renderer = {
      heartbeatLateMaxMs: Math.round(Math.max(0, ...probe.lates)), heartbeatLateP95Ms: Math.round(pct(probe.lates, 95)), heartbeatLateP99Ms: Math.round(pct(probe.lates, 99)),
      stallsOver50: probe.stalls.length, stallsOver100: probe.stalls.filter(s => s[2] >= 100).length, stallsOver250: probe.stalls.filter(s => s[2] >= 250).length,
      longtasks: probe.longtasks.length, longtaskMaxMs: Math.max(0, ...probe.longtasks), longtaskTotalMs: probe.longtasks.reduce((a, b) => a + b, 0),
      stallTimeline: probe.stalls.slice(0, 80).map(s => [Math.round((s[1] - rendererProfileEpochMs) / 100) / 10, s[2]]),
      selfTop: selfTimeTop(rProfile),
    };
    summary.ipcRoundTrip = { maxMs: Math.round(Math.max(0, ...probe.ipc)), p95Ms: Math.round(pct(probe.ipc, 95)), over100: probe.ipcSlow.length, n: probe.ipc.length };
    const rToUs = epoch => rProfile.startTime + (epoch - rendererProfileEpochMs) * 1000;
    summary.renderer.inStalls = stacksInWindows(rProfile, probe.stalls.filter(s => s[2] >= 100).map(s => [s[0], s[1]]), rToUs);

    // 主进程剖析文件（profiler 结束后写盘）
    const diag = path.join(dataDir, 'diagnostics');
    const end = Date.now() + 60000; let mainJson = null;
    while (Date.now() < end) {
      const f = fs.existsSync(diag) && fs.readdirSync(diag).find(n => /^main-cpu-profile-.*\.json$/.test(n));
      if (f) { await sleep(500); try { mainJson = JSON.parse(fs.readFileSync(path.join(diag, f), 'utf8')); fs.copyFileSync(path.join(diag, f.replace(/\.json$/, '.cpuprofile')), path.join(outDir, `main-${label}.cpuprofile`)); const hp = path.join(diag, f.replace(/\.json$/, '.heapprofile')); if (fs.existsSync(hp)) fs.copyFileSync(hp, path.join(outDir, `main-${label}.heapprofile`)); break; } catch {} }
      await sleep(500);
    }
    if (mainJson) {
      const mProfile = JSON.parse(fs.readFileSync(path.join(outDir, `main-${label}.cpuprofile`), 'utf8'));
      const lags = mainJson.stallsOver50ms.map(s => s.lagMs);
      const spawnsInWindow = mainJson.spawns.filter(s => s.at >= mainJson.startedAt);
      const spawnBy = new Map();
      for (const s of spawnsInWindow) { const k = `${s.api} ${s.file.split(/[\\/]/).pop()} ${s.caller.replace(/^at /, '').replace(/\(.*[\\/]/, '(')}`; const r = spawnBy.get(k) || { n: 0, ms: 0, max: 0 }; r.n++; r.ms += s.ms; r.max = Math.max(r.max, s.ms); spawnBy.set(k, r); }
      summary.main = {
        stallsOver50: lags.length, stallsOver100: lags.filter(x => x >= 100).length, stallsOver250: lags.filter(x => x >= 250).length,
        stallMaxMs: Math.max(0, ...lags), loopDelay: mainJson.loopDelay, memoryEnd: mainJson.memoryEnd, gcPauses: (mainJson.gcPausesOver20ms || []).map(g => [Math.round((g.at - mainJson.startedAt) / 100) / 10, g.ms, g.kind, g.flags]), cpuPercentOfOneCore: mainJson.cpuPercentOfOneCore,
        stallTimeline: mainJson.stallsOver50ms.slice(0, 80).map(s => [Math.round((s.at - mainJson.startedAt) / 100) / 10, s.lagMs]),
        spawns: [...spawnBy].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20).map(([k, r]) => ({ call: k, n: r.n, totalMs: Math.round(r.ms), maxMs: r.max })),
        ipcTop: Object.entries(mainJson.ipc.toRenderer).slice(0, 15), invokeTop: Object.entries(mainJson.ipc.invoke).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10),
        selfTop: selfTimeTop(mProfile),
      };
      const mToUs = epoch => mProfile.startTime + (epoch - mainJson.startedAt) * 1000;
      summary.main.inStalls = stacksInWindows(mProfile, mainJson.stallsOver50ms.filter(s => s.lagMs >= 100).map(s => [s.at - s.lagMs - 20, s.at]), mToUs);
    } else summary.main = { error: 'main profile not written' };
    void mainStartEpoch;
  } finally {
    try { await c?.close(); } catch {}
    if (hub && argv.includes('--trace-gc')) summary.gcLog = hub.log().filter(l => /Mark-Compact|Scavenge|Mark-sweep/i.test(l)).slice(-300);
    if (hub) { try { await gracefulQuit(hub); } catch (e) { summary.quitError = e.message; } }
    fs.writeFileSync(path.join(outDir, `summary-${label}.json`), JSON.stringify(summary, null, 1));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
  const brief = { label, renderer: summary.renderer && { max: summary.renderer.heartbeatLateMaxMs, p95: summary.renderer.heartbeatLateP95Ms, over100: summary.renderer.stallsOver100, longtasks: summary.renderer.longtasks },
    main: summary.main && { max: summary.main.stallMaxMs, p95: summary.main.loopDelay && summary.main.loopDelay.p95Ms, over100: summary.main.stallsOver100 }, ipc: summary.ipcRoundTrip, out: outDir };
  console.log(JSON.stringify(brief));
}

function dirBytes(dir) {
  let total = 0;
  const walk = d => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of list) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch {} } };
  walk(dir); return total;
}

main().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
