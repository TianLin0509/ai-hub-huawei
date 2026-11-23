'use strict';
// 隔离 Hub 空闲开销实测（2026-11-23 低开销模式对比用）：启动 → 预热 warmSec 秒 → 每 5 秒采样一次整棵进程树，共 idleSec 秒。
// 输出空闲期 CPU（按单核、整机换算）、内存均值/峰值、进程数、空闲期新起的进程数，以及各进程明细。
// envJson 里的 __seed 把文件预置进数据目录（例如 state.json 模拟老用户）。
// 用法：node tests/perf-low-overhead-idle.js <label> <outJson> [warmSec=60] [idleSec=300] [envJson]
const path = require('path'), fs = require('fs'), os = require('os'), net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
// 采样某个根 PID 的整棵进程树：进程数、工作集内存、累计 CPU 时间。隐藏窗口调用 PowerShell。
const { execFile } = require('child_process');
const PS = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`;
function snapshot() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', PS],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
  });
}
async function sampleTree(rootPid) {
  const rows = await snapshot();
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []); kids.get(r.ParentProcessId).push(r); }
  const out = []; const stack = [rows.find(r => r.ProcessId === rootPid)].filter(Boolean);
  while (stack.length) { const r = stack.pop(); out.push(r); for (const c of kids.get(r.ProcessId) || []) stack.push(c); }
  const cpu100ns = out.reduce((s, r) => s + Number(r.KernelModeTime || 0) + Number(r.UserModeTime || 0), 0);
  const ws = out.reduce((s, r) => s + Number(r.WorkingSetSize || 0), 0);
  const names = {}; for (const r of out) names[r.Name] = (names[r.Name] || 0) + 1;
  return { at: Date.now(), count: out.length, wsMB: ws / 1048576, cpuSec: cpu100ns / 1e7, names, procs: out.map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, cmd: String(r.CommandLine || "").slice(0, 300), wsMB: +(r.WorkingSetSize / 1048576).toFixed(1), cpuSec: +((Number(r.KernelModeTime) + Number(r.UserModeTime)) / 1e7).toFixed(2) })) };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  const [label = 'run', outJson = 'out.json', warmSec = '60', idleSec = '300', envJson = '{}'] = process.argv.slice(2);
  const extra = JSON.parse(envJson);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idle-' + label + '-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (extra.__seed) { for (const [rel, body] of Object.entries(extra.__seed)) { const f = path.join(data, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); } delete extra.__seed; }
  const hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), label, extraEnv: {
    CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: home, HOME: home, USERPROFILE: home, CLAUDE_HUB_E2E_FAKE_HOME: '1', ...extra } });
  const samples = [];
  try {
    const t0 = Date.now();
    await wait(Number(warmSec) * 1000);
    const end = Date.now() + Number(idleSec) * 1000;
    while (Date.now() < end) { samples.push(await sampleTree(hub.pid)); await wait(5000); }
    samples.push(await sampleTree(hub.pid));
    const a = samples[0], b = samples[samples.length - 1];
    const wall = (b.at - a.at) / 1000;
    // 逐对相邻采样累加每个进程的 CPU 增量；新出现的进程整份计入（它在窗口内启动），退出的进程不再倒扣。
    let idleCpu = 0; const seen = new Set(); const spawnedInfo = new Map();
    for (let i = 1; i < samples.length; i++) {
      const prev = new Map(samples[i - 1].procs.map(p => [p.pid + ':' + p.name, p.cpuSec]));
      for (const p of samples[i].procs) { const k = p.pid + ':' + p.name; seen.add(k); idleCpu += prev.has(k) ? Math.max(0, p.cpuSec - prev.get(k)) : p.cpuSec; const s = spawnedInfo.get(k); spawnedInfo.set(k, { name: p.name, cmd: p.cmd, ppid: p.ppid, cpuSec: Math.max(s ? s.cpuSec : 0, p.cpuSec), wsMB: Math.max(s ? s.wsMB : 0, p.wsMB) }); }
    }
    for (const p of a.procs) seen.delete(p.pid + ':' + p.name);
    const res = {
      label, warmSec: +warmSec, idleSec: wall,
      cpuPctOfOneCore: +(idleCpu / wall * 100).toFixed(2), idleCpuSec: +idleCpu.toFixed(1), spawnedDuringIdle: seen.size,
      cpuPctOfMachine: +(idleCpu / wall / os.cpus().length * 100).toFixed(3),
      memAvgMB: +(samples.reduce((s, x) => s + x.wsMB, 0) / samples.length).toFixed(0),
      memMaxMB: +Math.max(...samples.map(x => x.wsMB)).toFixed(0),
      procMax: Math.max(...samples.map(x => x.count)), procEnd: b.count,
      startupCpuSec: +a.cpuSec.toFixed(1), sinceLaunchSec: (a.at - t0) / 1000 + Number(warmSec),
      namesEnd: b.names,
      spawned: [...seen].map(k => spawnedInfo.get(k)).filter(Boolean).sort((x, y) => y.cpuSec - x.cpuSec),
      perProcDelta: b.procs.map(p => { const q = a.procs.find(x => x.pid === p.pid); return { ...p, idleCpuSec: +(p.cpuSec - (q ? q.cpuSec : 0)).toFixed(2) }; }).sort((x, y) => y.idleCpuSec - x.idleCpuSec),
    };
    fs.writeFileSync(outJson, JSON.stringify(res, null, 1));
    console.log(JSON.stringify({ ...res, perProcDelta: undefined }));
  } finally {
    await gracefulQuit(hub).catch(e => console.warn('quit:', e.message));
  }
})().catch(e => { console.error(e); process.exit(1); });
