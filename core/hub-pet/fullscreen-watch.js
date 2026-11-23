'use strict';
// 只核对当前前台窗口与所在显示器的完整边界，不用系统「请勿打扰」状态：演示模式并不等于前台全屏。
// 隐藏的 PowerShell 每 3 秒回报一次；读取失败、进程退出或读数超时都恢复桌宠。
// 脚本用 -EncodedCommand 传入，兼容 app.asar；窗口与显示器都读物理像素，兼容多屏缩放。
const { spawn } = require('child_process');

function buildScript(parentPid, intervalSec, { foreground = false } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -Namespace HubPet -Name Fg -UsingNamespace System.Text -MemberDefinition '" + [
      '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
      '[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT Monitor; public RECT Work; public uint Flags; }',
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
      '[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);',
      '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);',
      '[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);',
      '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
      '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    ].join(' ') + "'",
    'try { if (-not [HubPet.Fg]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][HubPet.Fg]::SetProcessDPIAware() } } catch { try { [void][HubPet.Fg]::SetProcessDPIAware() } catch {} }',
    "$lastW = ''",
    'while ($true) {',
    '  if (-not (Get-Process -Id ' + Number(parentPid) + ' -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $f = "F unknown"; $w = "W unknown"',
    '  try {',
    '    $h = [HubPet.Fg]::GetForegroundWindow()',
    '    if ($h -eq [IntPtr]::Zero -or [HubPet.Fg]::IsIconic($h) -or -not [HubPet.Fg]::IsWindowVisible($h)) { $f = "F desk"; $w = "W desk" }',
    '    else {',
    '      $sb = New-Object System.Text.StringBuilder 64',
    '      if ([HubPet.Fg]::GetClassName($h, $sb, 64) -le 0) { throw "window class unavailable" }',
    "      if ($sb.ToString() -in @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) { $f = 'F desk'; $w = 'W desk' }",
    '      else {',
    '        $r = New-Object HubPet.Fg+RECT',
    '        if (-not [HubPet.Fg]::GetWindowRect($h, [ref]$r)) { throw "window rect unavailable" }',
    '        $w = "W win $($r.L) $($r.T) $($r.R) $($r.B)"',
    // DWM 边界去掉窗口不可见的缩放边框；不可用时退回 GetWindowRect。
    '        $frame = New-Object HubPet.Fg+RECT',
    '        if ([HubPet.Fg]::DwmGetWindowAttribute($h, 9, [ref]$frame, 16) -eq 0) { $r = $frame }',
    '        $monitor = [HubPet.Fg]::MonitorFromWindow($h, 0)',
    '        $mi = New-Object HubPet.Fg+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)',
    '        if ($monitor -eq [IntPtr]::Zero -or -not [HubPet.Fg]::GetMonitorInfo($monitor, [ref]$mi)) { throw "monitor unavailable" }',
    // 用完整屏幕 Monitor，不用扣掉任务栏的 Work；普通最大化不算全屏。
    '        $m = $mi.Monitor',
    '        $f = "F win $($r.L) $($r.T) $($r.R) $($r.B) $($m.L) $($m.T) $($m.R) $($m.B)"',
    '      }',
    '      if ($h -ne [HubPet.Fg]::GetForegroundWindow()) { $f = "F unknown"; $w = "W unknown" }',
    '    }',
    '  } catch { $f = "F unknown"; $w = "W unknown" }',
    // 每轮都有全屏读数，主进程能判断常驻进程是否失去响应。
    '  [Console]::Out.WriteLine($f); [Console]::Out.Flush()',
    ...(foreground ? ['  if ($w -ne $lastW) { [Console]::Out.WriteLine($w); [Console]::Out.Flush(); $lastW = $w }'] : []),
    '  Start-Sleep -Seconds ' + Number(intervalSec),
    '}',
  ].join('\n');
}

// F win：窗口四边 + 所在显示器四边；只容忍 1 个物理像素的舍入误差。
function isFullscreenLine(text) {
  const p = text.split(/\s+/);
  if (p.length !== 10 || p[0] !== 'F' || p[1] !== 'win') return false;
  const v = p.slice(2).map(Number);
  if (!v.every(Number.isSafeInteger)) return false;
  const [l, t, r, b, ml, mt, mr, mb] = v;
  return r > l && b > t && mr > ml && mb > mt && v.slice(0, 4).every((n, i) => Math.abs(n - v[i + 4]) <= 1);
}

function encode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

function createFullscreenWatch({ onChange, platform = process.platform, spawnFn = spawn, intervalSec = 3, logger = console, foreground = false,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let child = null, fullscreen = false, fg = null, stopped = true, staleTimer = null;
  function setFullscreen(next) {
    if (next === fullscreen) return;
    fullscreen = next;
    try { onChange?.(fullscreen); } catch (error) { logger.warn?.('[hub-pet] fullscreen handler', error.message); }
  }
  function clearStale() { if (staleTimer !== null) clearTimeoutFn(staleTimer); staleTimer = null; }
  function reset() { clearStale(); fg = null; setFullscreen(false); }
  function handleLine(line) {
    const text = String(line).trim();
    if (text.startsWith('W ')) {
      const p = text.split(/\s+/);
      if (p[1] === 'win' && p.length === 6) {
        const [l, t, r, b] = p.slice(2).map(Number);
        fg = [l, t, r, b].every(Number.isFinite) && r > l && b > t ? { kind: 'win', rect: { x: l, y: t, width: r - l, height: b - t }, at: Date.now() } : { kind: 'unknown', at: Date.now() };
      } else fg = { kind: p[1] === 'desk' ? 'desk' : 'unknown', at: Date.now() };
      return;
    }
    setFullscreen(isFullscreenLine(text));
    if (child) {
      clearStale();
      staleTimer = setTimeoutFn(() => { staleTimer = null; fg = null; setFullscreen(false); }, Math.max(15000, intervalSec * 3000));
      staleTimer?.unref?.();
    }
  }

  function start() {
    if (platform !== 'win32' || child) return false;
    stopped = false;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(buildScript(process.pid, intervalSec, { foreground }))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { logger.warn?.('[hub-pet] fullscreen watch unavailable:', error.message); child = null; reset(); return false; }
    const me = child;
    let buf = '', err = '';
    child.stdout.on('data', chunk => {
      if (child !== me || stopped) return;
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', chunk => { if (err.length < 2000) err += chunk.toString('utf8'); });
    child.on('error', error => {
      logger.warn?.('[hub-pet] fullscreen watch error:', error.message);
      if (child === me) { child = null; reset(); try { me.kill(); } catch (_) {} }
    });
    child.on('exit', code => {
      if (child !== me) return;
      child = null;
      if (!stopped) logger.warn?.('[hub-pet] fullscreen watch exited', code, err.trim().slice(0, 300));
      reset();
    });
    return true;
  }

  function stop() {
    stopped = true;
    const me = child; child = null;
    if (me) { try { me.kill(); } catch (_) {} }
    reset();
  }

  return { start, stop, isFullscreen: () => fullscreen, isRunning: () => !!child, foreground: () => (fg ? { ...fg, ...(fg.rect ? { rect: { ...fg.rect } } : {}) } : null), _handleLine: handleLine };
}

module.exports = { buildScript, createFullscreenWatch, encode, isFullscreenLine };
