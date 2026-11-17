'use strict';
// 全屏检测（会议共享、放映 PPT、全屏视频时桌宠躲到屏幕边只露个头）。
// 用 Windows 自带的 SHQueryUserNotificationState：它就是系统判断「现在别弹通知」的依据，
// 2=有程序全屏、3=全屏 D3D 游戏、4=演示模式。由一个隐藏的 PowerShell 常驻进程每 3 秒查一次，状态变了才输出一行；
// 只在桌宠开着时运行，桌宠关掉或 Hub 退出时结束，Hub 意外退出时它发现父进程没了也会自己退出。
// 脚本用 -EncodedCommand 传入：打包后源码在 app.asar 里，PowerShell 读不到 .ps1 文件。
const { spawn } = require('child_process');

const BUSY_STATES = new Set([2, 3, 4]);

// 2026-11-17 r27f：同一个常驻进程顺带报前台窗口的位置（桌宠在任务栏上走动时躲开它），变了才输出一行：
// 「W desk」＝前台是桌面/任务栏/没有前台窗口；「W win 左 上 右 下」＝前台窗口的物理像素矩形。
// 进程先声明「每屏 DPI 感知」，读到的是真实物理像素，主进程再按各屏缩放换成 DIP（多屏、不同缩放各算各的）。
function buildScript(parentPid, intervalSec, { foreground = false } = {}) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace HubPet -Name Quns -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern int SHQueryUserNotificationState(out int state);'",
  ];
  if (foreground) lines.push(
    "Add-Type -Namespace HubPet -Name Fg -UsingNamespace System.Text -MemberDefinition '" + [
      '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
      '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);',
      '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
      '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();',
    ].join(' ') + "'",
    'try { if (-not [HubPet.Fg]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][HubPet.Fg]::SetProcessDPIAware() } } catch { try { [void][HubPet.Fg]::SetProcessDPIAware() } catch {} }',
    "$lastW = ''",
  );
  lines.push(
    '$last = -1',
    'while ($true) {',
    '  if (-not (Get-Process -Id ' + Number(parentPid) + ' -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $s = 0',
    '  [void][HubPet.Quns]::SHQueryUserNotificationState([ref]$s)',
    '  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }',
  );
  if (foreground) lines.push(
    '  $w = "W desk"',
    '  try {',
    '    $h = [HubPet.Fg]::GetForegroundWindow()',
    '    if ($h -ne [IntPtr]::Zero -and -not [HubPet.Fg]::IsIconic($h)) {',
    '      $sb = New-Object System.Text.StringBuilder 64; [void][HubPet.Fg]::GetClassName($h, $sb, 64); $c = $sb.ToString()',
    "      if ($c -notin @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) {",
    '        $r = New-Object HubPet.Fg+RECT',
    '        if ([HubPet.Fg]::GetWindowRect($h, [ref]$r)) { $w = "W win $($r.L) $($r.T) $($r.R) $($r.B)" }',
    '      }',
    '    }',
    '  } catch { $w = "W unknown" }',
    '  if ($w -ne $lastW) { [Console]::Out.WriteLine($w); [Console]::Out.Flush(); $lastW = $w }',
  );
  lines.push('  Start-Sleep -Seconds ' + Number(intervalSec), '}');
  return lines.join('\n');
}

function encode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function createFullscreenWatch({ onChange, platform = process.platform, spawnFn = spawn, intervalSec = 3, logger = console, foreground = false } = {}) {
  let child = null;
  let fullscreen = false;
  // 前台窗口：{ kind: 'desk' | 'win' | 'unknown', rect?: { x, y, width, height }（物理像素）, at }；还没收到时为 null。
  let fg = null;
  let stopped = true;

  function handleLine(line) {
    const text = String(line).trim();
    if (text.startsWith('W ')) {
      const p = text.split(/\s+/);
      if (p[1] === 'win' && p.length >= 6) {
        const [l, t, r, b] = p.slice(2, 6).map(Number);
        fg = [l, t, r, b].every(Number.isFinite) && r > l && b > t ? { kind: 'win', rect: { x: l, y: t, width: r - l, height: b - t }, at: Date.now() } : { kind: 'unknown', at: Date.now() };
      } else fg = { kind: p[1] === 'desk' ? 'desk' : 'unknown', at: Date.now() };
      return;
    }
    const state = Number(text);
    if (!Number.isFinite(state)) return;
    const next = BUSY_STATES.has(state);
    if (next === fullscreen) return;
    fullscreen = next;
    try { onChange?.(fullscreen, state); } catch (error) { logger.warn?.('[hub-pet] fullscreen handler', error.message); }
  }

  function start() {
    if (platform !== 'win32' || child) return false;
    stopped = false;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(buildScript(process.pid, intervalSec, { foreground }))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { logger.warn?.('[hub-pet] fullscreen watch unavailable:', error.message); child = null; return false; }
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    let err = '';
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk.toString('utf8'); });
    const me = child;
    child.on('error', error => logger.warn?.('[hub-pet] fullscreen watch error:', error.message));
    child.on('exit', code => {
      if (child === me) child = null;
      if (!stopped) logger.warn?.('[hub-pet] fullscreen watch exited', code, err.trim().slice(0, 300));
      fg = null;
      if (fullscreen) { fullscreen = false; try { onChange?.(false, 0); } catch (_) {} }
    });
    return true;
  }

  function stop() {
    stopped = true;
    if (child) { try { child.kill(); } catch (_) {} child = null; }
    fg = null;
  }

  return { start, stop, isFullscreen: () => fullscreen, isRunning: () => !!child, foreground: () => (fg ? { ...fg, ...(fg.rect ? { rect: { ...fg.rect } } : {}) } : null), _handleLine: handleLine };
}

module.exports = { BUSY_STATES, buildScript, createFullscreenWatch, encode };
