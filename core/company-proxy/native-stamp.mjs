// First-time signer stamp, read the way CodeAgent itself produces it (proven on the company machine by the
// prototype's native run): run the CodeAgent CLI once with CODEAGENT_SIGNER_LOG=1 and a fresh TEMP/TMP, wait for
// the first complete "SnapEngineSigner created:" line in <TEMP>\codeagent_signer.log, take the digits after
// "win32-x64-" as the stamp, stop the CLI, write "<version>\n<stamp>\n" into the Hub signer cache.
//
// Why not the adapter's own probe: on the company machine it ran 16 s (its 15 s kill), init() still returned true
// and no cache appeared (Q-1106-08 r3). Its CLI run gets no prompt on stdin within that window and inherits the
// caller's CodeAgent session variables; here the prompt is given on stdin and those variables are removed.
//
// Window: Node's windowsHide gives the child CREATE_NO_WINDOW, i.e. no console at all, and any console program the
// CLI then starts without its own hiding (cmd /c ...) gets a brand-new, visible console. The CLI is therefore started
// by a hidden PowerShell with Start-Process -WindowStyle Hidden: the CLI owns a console that is never shown and its
// own children inherit that same hidden console. On top of that the CLI runs on a private desktop (see
// PRIVATE_DESKTOP_CS); tests/e2e-company-proxy-stamp-window.js measures both.
//
// The report carries counts and booleans only; the stamp, the log text and the CLI output never leave this module
// except the stamp into the cache file.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile, rename, rm, lstat, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { retainNativeRuntime } from './native-signer.mjs';

export const STAMP_LOG = 'codeagent_signer.log';
export const STAMP_FILE = 'codeagent-version-stamp';
const MARKER = 'SnapEngineSigner created:';
const ARCH = 'win32-x64-';
const MAX_LOG_BYTES = 1024 * 1024;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';

const RUNTIME_QUERY = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  "$ErrorActionPreference='Stop';try{",
  '$p=Get-Process -Id ([int]$env:HUB_STAMP_QUERY_PID) -ErrorAction Stop',
  "if($p.Path -ine $env:HUB_STAMP_QUERY_EXE){throw 'CLI_MISMATCH'}",
  '$modules=@($p.Modules)',
  "$dll=@($modules|Where-Object {$_.ModuleName -ieq 'libsnap_engine.dll'})",
  "$ffi=@($modules|Where-Object {$_.ModuleName -ieq 'koffi.node'})",
  "if($dll.Count -ne 1 -or $ffi.Count -ne 1){throw 'PAIR_NOT_LOADED'}",
  '@{dll=$dll[0].FileName;ffi=$ffi[0].FileName}|ConvertTo-Json -Compress',
  '}catch{exit 1}',
].join(';');

// This exact PID was returned by our launcher. Inspect only that live CLI and
// return its pair in-process; never publish module paths in status or logs.
export function queryLoadedRuntime({ pid, cliExe, spawnImpl = nodeSpawn, timeoutMs = 8000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof cliExe !== 'string') return Promise.resolve(null);
  return new Promise(resolve => {
    let child, timer, output = '', settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try {
      child = spawnImpl(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', RUNTIME_QUERY], {
        windowsHide: true, shell: false, detached: false, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, HUB_STAMP_QUERY_PID: String(pid), HUB_STAMP_QUERY_EXE: cliExe },
      });
    } catch { done(null); return; }
    timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (settled) return;
      output += chunk.toString('utf8');
      if (output.length > 8192) { try { child.kill(); } catch {} done(null); }
    });
    child.once('error', () => done(null));
    child.once('close', code => {
      if (code !== 0 || settled) { done(null); return; }
      try {
        const value = JSON.parse(output.trim());
        done(value && typeof value.dll === 'string' && typeof value.ffi === 'string' ? value : null);
      } catch { done(null); }
    });
  });
}

// Variables the CLI must not inherit: Hub/proxy internals, and a surrounding CodeAgent / Claude Code session
// (a CLI started inside another one attaches to it instead of starting its own signer).
const DROP_EXACT = new Set(['CODEAGENT3_X_AUTH_TOKEN', 'CODEAGENT3_CONFIG_DIR', 'CODEAGENT3_LAUNCHER_PID', 'CODEAGENT_SIGNER_LOG',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'TEMP', 'TMP', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT']);
const DROP_PREFIX = /^(CLAUDE_HUB_|CODEAGENT_HUB_|AI_HUB_|[A-Z]+_BRIDGE_)/; // Hub and its relay helpers

export function cliEnvironment(base, { temp, configDir }) {
  const env = {}; let dropped = 0;
  for (const [key, value] of Object.entries(base || {})) {
    const name = key.toUpperCase();
    if (DROP_EXACT.has(name) || DROP_PREFIX.test(name)) { dropped++; continue; }
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, { CODEAGENT_SIGNER_LOG: '1', TEMP: temp, TMP: temp });
  if (configDir) env.CODEAGENT3_CONFIG_DIR = configDir;
  return { env, dropped };
}

// Windows command-line quoting (CommandLineToArgvW rules); empty arguments stay "".
export function quoteArg(arg) {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"', slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch; slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

export function cliArguments({ mcp, settings, model }) {
  return ['--print', '--output-format', 'text', '--no-session-persistence', '--permission-mode', 'default', '--tools', '',
    '--strict-mcp-config', '--mcp-config', mcp, '--settings', settings, '--setting-sources', '', '--disable-slash-commands',
    ...(model ? ['--model', model] : [])];
}

// Private desktop: the hidden console covers the CLI and every child that shares its console, but not a helper the
// CLI starts without any console (detached, or a GUI-type program) which then starts a console program: Windows
// gives that program a new console window, shown (company v4: one visible conhost.exe in the proxy's tree, timing
// dependent). The CLI is therefore started on a desktop of its own that is never displayed; every process it starts
// inherits that desktop, so no window of the tree can reach the user's screen. Started with CreateProcess (console
// still hidden, standard handles redirected to the same files). If this cannot be compiled or started (e.g. a
// restricted PowerShell language mode), the launcher falls back to the hidden console alone (consoleMode tells).
const PRIVATE_DESKTOP_CS = String.raw`using System; using System.Runtime.InteropServices; using System.Text;
public static class HubStampLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string reserved; public string desktop; public string title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public bool inherit; }
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SA sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int code);
  static IntPtr desk = IntPtr.Zero; static PI child;
  static IntPtr Open(string path, bool write, ref SA sa) {
    IntPtr h = CreateFileW(path, write ? 0x40000000u : 0x80000000u, 1, ref sa, write ? 2u : 3u, 0x80, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Exception("file");
    return h;
  }
  public static int Start(string exe, string argLine, string cwd, string input, string output, string error) {
    string name = "HubStamp" + Guid.NewGuid().ToString("N");
    desk = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero);
    if (desk == IntPtr.Zero) throw new Exception("desktop");
    SA sa = new SA(); sa.length = Marshal.SizeOf(sa); sa.inherit = true;
    IntPtr i = Open(input, false, ref sa), o = Open(output, true, ref sa), e = Open(error, true, ref sa);
    SI si = new SI(); si.cb = Marshal.SizeOf(si); si.desktop = "WinSta0\\" + name;
    si.flags = 0x101; si.show = 0; si.stdIn = i; si.stdOut = o; si.stdErr = e; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SW_HIDE
    StringBuilder line = new StringBuilder("\"" + exe + "\" " + argLine);
    bool ok = CreateProcessW(exe, line, IntPtr.Zero, IntPtr.Zero, true, 0x10, IntPtr.Zero, cwd, ref si, out child); // CREATE_NEW_CONSOLE
    CloseHandle(i); CloseHandle(o); CloseHandle(e);
    if (!ok) { CloseDesktop(desk); desk = IntPtr.Zero; throw new Exception("start"); }
    CloseHandle(child.thread);
    return child.pid;
  }
  public static int Wait() {
    WaitForSingleObject(child.process, 0xFFFFFFFF); int code; GetExitCodeProcess(child.process, out code);
    CloseHandle(child.process); if (desk != IntPtr.Zero) CloseDesktop(desk); return code;
  }
}`;

// Paths, the argument line and the C# source reach PowerShell through variables (removed again before the CLI
// starts), so no path text is spliced into the script.
const LAUNCHER = [
  "$ErrorActionPreference='Stop'",
  '$exe=$env:HUB_STAMP_EXE;$argLine=$env:HUB_STAMP_ARGS;$cwd=$env:HUB_STAMP_CWD;$in=$env:HUB_STAMP_IN;$out=$env:HUB_STAMP_OUT;$err=$env:HUB_STAMP_ERR;$cs=$env:HUB_STAMP_CS',
  "foreach($n in 'HUB_STAMP_EXE','HUB_STAMP_ARGS','HUB_STAMP_CWD','HUB_STAMP_IN','HUB_STAMP_OUT','HUB_STAMP_ERR','HUB_STAMP_CS'){Remove-Item -LiteralPath ('Env:'+$n) -ErrorAction SilentlyContinue}",
  '$id=0;if($cs){try{Add-Type -TypeDefinition $cs -ErrorAction Stop;$id=[HubStampLaunch]::Start($exe,$argLine,$cwd,$in,$out,$err)}catch{$id=0}}',
  'if($id -gt 0){[Console]::Out.WriteLine("CLI_MODE=private-desktop");[Console]::Out.WriteLine("CLI_PID="+$id);[Console]::Out.Flush();$code=[HubStampLaunch]::Wait();[Console]::Out.WriteLine("CLI_EXIT="+$code);exit 0}',
  'try{$p=Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $cwd -WindowStyle Hidden -PassThru -RedirectStandardInput $in -RedirectStandardOutput $out -RedirectStandardError $err}catch{[Console]::Out.WriteLine("CLI_START_FAILED");exit 3}',
  '$null=$p.Handle;[Console]::Out.WriteLine("CLI_MODE=hidden-console");[Console]::Out.WriteLine("CLI_PID="+$p.Id);[Console]::Out.Flush()',
  '$p.WaitForExit();[Console]::Out.WriteLine("CLI_EXIT="+$p.ExitCode);exit 0',
].join(';');

/** Parses the signer log text: first complete line with the marker -> { lines, markerMatched, stamp, logVersion }. */
export function parseStampLog(text) {
  const parts = text.split(/\r?\n/);
  const tail = parts.pop();
  const result = { lines: parts.length + (tail ? 1 : 0), markerMatched: false, stamp: null, logVersion: null, incompleteTail: false };
  for (const line of parts) {
    const at = line.indexOf(MARKER); if (at < 0) continue;
    result.markerMatched = true;
    const suffix = line.slice(at + MARKER.length);
    const arch = suffix.indexOf(ARCH); if (arch < 0) continue;
    const stamp = suffix.slice(arch + ARCH.length).match(/^\d{1,64}/)?.[0];
    if (!stamp) continue;
    result.stamp = stamp;
    result.logVersion = suffix.slice(0, arch).match(/(?:^|[^\d.])(\d+(?:\.\d+){1,4})-$/)?.[1] || null;
    return result;
  }
  if (tail && tail.includes(MARKER)) { result.markerMatched = true; result.incompleteTail = true; }
  return result;
}

async function readLog(file) {
  try {
    const s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink()) return { exists: true, bytes: s.size, invalid: true };
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(s.size, MAX_LOG_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { exists: true, bytes: s.size, text: buffer.subarray(0, bytesRead).toString('utf8') };
    } finally { await handle.close(); }
  } catch (error) { return { exists: error?.code !== 'ENOENT', bytes: 0, invalid: error?.code !== 'ENOENT' }; }
}

const killTree = (spawnImpl, pid) => new Promise(resolve => {
  if (!Number.isSafeInteger(pid) || pid <= 0) { resolve(false); return; }
  let killer;
  try { killer = spawnImpl(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); }
  catch { resolve(false); return; }
  const timer = setTimeout(() => resolve(false), 3000);
  killer.once?.('error', () => { clearTimeout(timer); resolve(false); });
  killer.once?.('close', code => { clearTimeout(timer); resolve(code === 0); });
});

/**
 * One CLI run -> { ok, report, stamp? }. report: { ran, cliStarted, cliExitCode, stoppedBy ('stamp'|'exit'|'timeout'|'start-failed'),
 * logExists, logBytes, logLines, markerMatched, stampParsed, logVersionStatus, envDropped, consoleMode, elapsedMs, error }.
 * Options: cliExe, configDir (CodeAgent's data dir), expectedVersion, workRoot (an existing Hub-owned directory),
 * timeoutMs, model (optional), env (base environment), spawnImpl / powershell (tests).
 */
export async function probeNativeStamp({ cliExe, configDir, expectedVersion, workRoot, timeoutMs = 45_000, model = '',
  env = process.env, spawnImpl = nodeSpawn, powershell = POWERSHELL, pollMs = 250, privateDesktop = true, nativeRuntimeDir } = {}) {
  const started = Date.now();
  const report = { ran: true, cliStarted: false, cliExitCode: null, stoppedBy: null, logExists: false, logBytes: 0, logLines: 0,
    markerMatched: false, stampParsed: false, logVersionStatus: 'unknown', envDropped: 0, consoleMode: 'unknown',
    tempCategory: 'hub-work-temp', elapsedMs: 0, error: null };
  const dir = join(workRoot, 'native-stamp-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex'));
  const temp = join(dir, 'temp'), cwd = join(dir, 'cwd');
  await mkdir(temp, { recursive: true }); await mkdir(cwd, { recursive: true });
  const mcp = join(dir, 'empty-mcp.json'), settings = join(dir, 'settings.json');
  await writeFile(mcp, JSON.stringify({ mcpServers: {} }), { flag: 'wx' });
  await writeFile(settings, JSON.stringify({}), { flag: 'wx' });
  const promptFile = join(dir, 'prompt.txt');
  await writeFile(promptFile, `Reply with exactly STAMP_${randomBytes(6).toString('hex')} and nothing else. Do not use tools.\n`, { flag: 'wx' });
  const { env: childEnv, dropped } = cliEnvironment(env, { temp, configDir });
  report.envDropped = dropped;
  const logFile = join(temp, STAMP_LOG);
  const launcherEnv = { ...childEnv, HUB_STAMP_EXE: cliExe, HUB_STAMP_ARGS: cliArguments({ mcp, settings, model }).map(quoteArg).join(' '),
    HUB_STAMP_CWD: cwd, HUB_STAMP_IN: promptFile, HUB_STAMP_OUT: join(dir, 'cli-stdout.txt'), HUB_STAMP_ERR: join(dir, 'cli-stderr.txt'), ...(privateDesktop ? { HUB_STAMP_CS: PRIVATE_DESKTOP_CS } : {}) };

  let launcher, cliPid = null, launcherClosed = false, stdoutText = '';
  const closed = new Promise(resolve => {
    try {
      launcher = spawnImpl(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LAUNCHER],
        { windowsHide: true, shell: false, detached: false, stdio: ['ignore', 'pipe', 'ignore'], env: launcherEnv });
    } catch { launcherClosed = true; report.error = 'CLI_START_FAILED'; resolve(); return; }
    launcher.stdout?.on('data', chunk => {
      stdoutText = (stdoutText + chunk.toString('utf8')).slice(-4096);
      const pid = stdoutText.match(/CLI_PID=(\d+)/); if (pid) { cliPid = Number(pid[1]); report.cliStarted = true; }
      const exit = stdoutText.match(/CLI_EXIT=(-?\d+)/); if (exit) report.cliExitCode = Number(exit[1]);
      if (stdoutText.includes('CLI_START_FAILED')) report.error = 'CLI_START_FAILED';
      const mode = stdoutText.match(/CLI_MODE=(private-desktop|hidden-console)/); if (mode) report.consoleMode = mode[1];
    });
    launcher.once('error', () => { launcherClosed = true; report.error = report.error || 'CLI_START_FAILED'; resolve(); });
    launcher.once('close', () => { launcherClosed = true; resolve(); });
  });

  let parsed = null;
  const check = async () => {
    const log = await readLog(logFile);
    report.logExists = log.exists; report.logBytes = log.bytes;
    if (log.text === undefined) return false;
    parsed = parseStampLog(log.text);
    report.logLines = parsed.lines; report.markerMatched = parsed.markerMatched;
    return !!parsed.stamp;
  };
  const deadline = started + timeoutMs;
  while (true) {
    if (await check()) { report.stoppedBy = 'stamp'; break; }
    if (launcherClosed) { await check(); report.stoppedBy = report.error === 'CLI_START_FAILED' || !report.cliStarted ? 'start-failed' : 'exit'; break; }
    if (Date.now() >= deadline) { report.stoppedBy = 'timeout'; break; }
    await Promise.race([closed, new Promise(r => setTimeout(r, pollMs))]);
  }
  const stamp = parsed?.stamp || null;
  report.stampParsed = !!stamp;
  if (stamp) report.logVersionStatus = parsed.logVersion ? (parsed.logVersion === expectedVersion ? 'matched' : 'mismatch') : 'unknown';
  if (!stamp && !report.error) {
    report.error = !report.cliStarted ? 'CLI_START_FAILED' : report.stoppedBy === 'timeout' ? 'CLI_TIMEOUT'
      : !report.logExists ? 'LOG_MISSING' : parsed?.incompleteTail ? 'LOG_INCOMPLETE' : report.markerMatched ? 'STAMP_NOT_PARSED' : 'MARKER_MISSING';
  }
  if (stamp && report.logVersionStatus === 'mismatch') report.error = 'STAMP_VERSION_MISMATCH';
  let ok = !!stamp && report.logVersionStatus !== 'mismatch';
  if (ok && nativeRuntimeDir) {
    // Keep the pair while the CLI still owns it: shutdown may remove its extracted
    // files. Some installations load the pair directly from their own bin folder.
    try {
      await retainNativeRuntime(temp, nativeRuntimeDir, { codeagentDir: dirname(dirname(cliExe)),
        loadRuntime: () => queryLoadedRuntime({ pid: cliPid, cliExe, spawnImpl }) });
      report.nativeRuntimeRetained = true;
    }
    catch { ok = false; report.nativeRuntimeRetained = false; report.error = 'SIGNER_NATIVE_FILES_MISSING'; }
  }
  if (!launcherClosed) {
    if (cliPid) await killTree(spawnImpl, cliPid);
    await Promise.race([closed, new Promise(r => setTimeout(r, 3000))]);
    if (!launcherClosed) { try { launcher?.kill(); } catch { /* gone */ } }
  }
  report.elapsedMs = Date.now() - started;
  // Our own scratch directory: removed after success (it holds the CLI answer and the log); kept after a failure
  // for local troubleshooting (never sent anywhere).
  if (ok) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  return ok ? { ok, report, stamp } : { ok, report };
}

/** Writes "<version>\n<stamp>\n" into cacheDir (atomic replace) -> path category for the report. */
export async function writeStampCache(cacheDir, version, stamp) {
  if (!/^\d{1,64}$/.test(stamp) || !/^\d[0-9A-Za-z.+-]{0,40}$/.test(version)) throw Object.assign(new Error('STAMP_INVALID'), { code: 'STAMP_INVALID' });
  await mkdir(cacheDir, { recursive: true });
  const file = join(cacheDir, STAMP_FILE), part = file + '.' + randomBytes(3).toString('hex') + '.part';
  await writeFile(part, `${version}\n${stamp}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(part, file);
  return 'hub-signer-cache';
}

export const configDirOf = credentialFile => (credentialFile ? dirname(credentialFile) : '');
