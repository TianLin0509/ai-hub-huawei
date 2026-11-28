'use strict';
// 隔离守卫（2026-11-28 事故：隔离副本被当成完整 Hub 跑在生产数据目录上，和生产 Hub 同跑 28 分钟）。
// 启动隔离 Hub 后的前几秒里核对它的子进程：命令行里出现生产数据目录（AppData\Roaming\ai-hub-community、
// 用户目录下的 .ai-hub-community），或 renderer 的 --user-data-dir 不在本次隔离目录下，就只结束这一个
// 核实过的主进程 PID（不按进程树、不按名字），并抛错让驱动报失败退出。只在 Windows 上查（用 PowerShell CIM 只读列进程）。
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// 公司电脑的 TEMP 常是 8.3 短名（形如 ABCDEF~1），比较前统一成真实长路径。
const real = p => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return String(p).toLowerCase(); } };

function productionDirs(home = os.homedir(), appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) {
  return [path.join(appData, 'ai-hub-community'), path.join(home, '.ai-hub-community')].map(p => p.toLowerCase());
}

// 纯判定，便于单测：procs 是 { pid, ppid, cmd } 列表；返回违规说明（空串表示没问题）。
function violation({ rootPid, isolatedRoot, procs, prodDirs = productionDirs() }) {
  const iso = String(isolatedRoot || '').toLowerCase();
  const kids = procs.filter(p => p.ppid === rootPid);
  for (const p of [procs.find(x => x.pid === rootPid), ...kids].filter(Boolean)) {
    const cmd = String(p.cmd || '').toLowerCase().replace(/\//g, '\\');
    const hit = prodDirs.find(d => cmd.includes(d));
    if (hit) return `进程 ${p.pid} 的命令行用到了生产数据目录 ${hit}`;
    const m = cmd.match(/--user-data-dir="?([^"]+?)"?(\s|$)/);
    if (m && /--type=renderer/.test(cmd) && iso && !real(m[1]).startsWith(real(iso))) return `renderer ${p.pid} 的 --user-data-dir 不在隔离目录下：${m[1]}`;
  }
  return '';
}

function listProcs() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='AI Hub Community.exe'\" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine; exe = $_.ExecutablePath } } | ConvertTo-Json -Compress";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const v = out.trim() ? JSON.parse(out) : [];
  return Array.isArray(v) ? v : [v];
}

// hub：launchIsolatedHub 的返回值；isolatedRoot：本次隔离数据根目录。默认在 5 秒里每秒查一次。
async function guardIsolatedHub(hub, isolatedRoot, { seconds = 5, list = listProcs } = {}) {
  if (process.platform !== 'win32') return { checked: 0 };
  let checked = 0;
  // 一次列进程约 1–3 秒（起 PowerShell），所以不另睡：从启动起连续查，直到覆盖满 seconds 秒且至少查两次。
  const t0 = Date.now();
  while (checked < 2 || Date.now() - t0 < seconds * 1000) {
    await new Promise(r => setTimeout(r, 300));
    const procs = list(); checked++;
    const why = violation({ rootPid: hub.pid, isolatedRoot, procs });
    if (why) {
      const me = procs.find(p => p.pid === hub.pid);
      if (me && hub.child && hub.child.pid === hub.pid && hub.child.exitCode == null) { try { hub.child.kill(); } catch {} }
      const error = new Error('隔离守卫：' + why + '；已只结束这一个隔离 Hub 主进程 ' + hub.pid);
      error.code = 'ISOLATION_GUARD';
      throw error;
    }
  }
  return { checked };
}

module.exports = { guardIsolatedHub, violation, productionDirs };
