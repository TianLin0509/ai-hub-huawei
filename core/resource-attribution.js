'use strict';
// 设置页「资源与后台」的当前占用（2026-11-23 低开销模式）：把 Hub 整棵进程树按「是谁拉起的」归到各项后台功能。
// 只在页面打开时按需采样（主进程复用 core/process-inspector.js），不新增常驻采样。
// 归类依据（按先后）：
//   1. 主进程登记的已知进程号：桌宠窗口、搜索子进程、会议室组件、各窗口的渲染进程（按页面地址）；
//   2. 进程名与命令行：msedge.exe → 公司网页取数；nvidia-smi / 读网卡脚本 → 底栏读数；桌宠全屏检测脚本 → 桌宠；
//   3. Electron 自己的 GPU、网络、崩溃收集进程 → Hub 本体；其余子进程（终端里的 Claude、Codex、CodeAgent 等）→ 会话。

const GROUPS = Object.freeze({
  core: 'Hub 本体（窗口与界面）',
  sessions: '会话（终端与 AI 进程）',
  companyWeb: '公司网页取数（帖子 / 考勤 / 门户共用）',
  rooms: '会议室组件',
  pet: '桌宠',
  liveMeter: '底栏网速与显卡读数',
  searchIndex: '会话搜索索引',
});

// PowerShell 脚本都用 -EncodedCommand（UTF-16LE base64）传入，解开后按内容认。
function decodeEncodedCommand(cmd) {
  const m = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(String(cmd || ''));
  if (!m) return '';
  try { return Buffer.from(m[1], 'base64').toString('utf16le'); } catch { return ''; }
}

function classifyProcess(proc, known = {}) {
  const pid = Number(proc.pid);
  if (known.byPid && known.byPid.has(pid)) return known.byPid.get(pid);
  const name = String(proc.name || '').toLowerCase();
  const cmd = String(proc.cmd || '');
  if (name === 'msedge.exe') return 'companyWeb';
  if (name === 'nvidia-smi.exe') return 'liveMeter';
  // 底栏 CPU 读数用的常驻计数器（core/cpu-utility-sampler.js），算 Hub 本体。
  if (name === 'typeperf.exe') return 'core';
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    const script = decodeEncodedCommand(cmd);
    if (/GetIPv4Statistics/.test(script)) return 'liveMeter';
    // 本页自己读占用时起的采集脚本（core/process-inspector.js），不算进任何一项。
    if (/Get-CimInstance Win32_Process/.test(script)) return 'measure';
    if (/HubPet\b/.test(script)) return 'pet';
    return 'core';
  }
  if (name === 'conhost.exe' && known.parentGroup) return known.parentGroup;
  // Electron 自己的渲染、GPU、网络、崩溃收集进程（打包版的 exe 名由主进程传入）。
  if (name === 'electron.exe' || (known.exeName && name === known.exeName)) return 'core';
  return 'sessions';
}

// rows：整棵进程树（含根），每行 { pid, ppid, name, cmd, wsBytes, cpuDeltaMs }（core/process-inspector.js 的格式）；cpuWindowMs：两次采样的间隔。
// known.byPid：Map(pid → 组)；没登记、又是某个已归类进程的子孙（例如会议室组件自己再起的进程），跟着父进程走。
function attribute(rows, { rootPid, known = {}, cpuWindowMs = null, cpuCount = 1 } = {}) {
  const byPid = new Map(rows.map(r => [Number(r.pid), r]));
  const group = new Map();
  const groupOf = (pid, depth = 0) => {
    if (group.has(pid)) return group.get(pid);
    const proc = byPid.get(pid);
    if (!proc) return 'core';
    let g;
    if (known.byPid && known.byPid.has(pid)) g = known.byPid.get(pid);
    else if (pid === Number(rootPid)) g = 'core';
    else {
      const parent = Number(proc.ppid);
      const parentGroup = parent !== Number(rootPid) && byPid.has(parent) && depth < 64 ? groupOf(parent, depth + 1) : null;
      // 父进程已经归到某项后台功能（不是本体、不是会话）：子孙一律跟着它。
      if (parentGroup && parentGroup !== 'core' && parentGroup !== 'sessions') g = parentGroup;
      else g = classifyProcess(proc, { ...known, parentGroup });
    }
    group.set(pid, g);
    return g;
  };
  const out = {};
  for (const id of Object.keys(GROUPS)) out[id] = { id, label: GROUPS[id], memBytes: 0, procs: 0, cpuMs: 0, cpuKnown: false };
  for (const r of rows) {
    const g = groupOf(Number(r.pid));
    if (g === 'measure') continue;
    const slot = out[g] || out.core;
    slot.memBytes += Number(r.wsBytes ?? r.ws) || 0;
    slot.procs += 1;
    if (Number.isFinite(r.cpuDeltaMs)) { slot.cpuMs += r.cpuDeltaMs; slot.cpuKnown = true; }
  }
  const total = { memBytes: 0, procs: 0, cpuMs: 0, cpuKnown: false };
  for (const slot of Object.values(out)) {
    total.memBytes += slot.memBytes; total.procs += slot.procs; total.cpuMs += slot.cpuMs; total.cpuKnown = total.cpuKnown || slot.cpuKnown;
  }
  // CPU 按整机换算（和任务管理器一致）；第一次打开页面只有一份采样，算不出，给 null。
  const pct = s => (cpuWindowMs > 0 && s.cpuKnown ? Math.round(1000 * s.cpuMs / cpuWindowMs / Math.max(1, cpuCount)) / 10 : null);
  const groups = Object.values(out).map(s => ({ id: s.id, label: s.label, memMB: Math.round(s.memBytes / 1048576), procs: s.procs, cpuPct: pct(s) }));
  return { groups, total: { memMB: Math.round(total.memBytes / 1048576), procs: total.procs, cpuPct: pct(total) } };
}

// 从进程采集器的快照里取出以 rootPid 为根的整棵树。
function treeRows(snapshot, rootPid) {
  const { collectTree } = require('./process-inspector');
  const ids = collectTree(rootPid, snapshot.childrenMap);
  return [...ids].map(id => snapshot.byPid.get(id)).filter(Boolean);
}

module.exports = { GROUPS, decodeEncodedCommand, classifyProcess, attribute, treeRows };
