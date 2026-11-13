'use strict';
// First-time signer stamp run must never show a window, not even for a few milliseconds (home-only, Windows).
//   node tests/e2e-company-proxy-stamp-window.js [runs=20]
// Each run: tests/helpers/window-flash-watch.py starts a driver (on a private desktop, so the screen is never
// touched); the driver calls the real probeNativeStamp with real PowerShell on a fake codeagentcli.exe. The fake CLI
// starts console children the way a Node CLI does (plain, windowsHide, nested cmd, shell exec, a detached helper
// that starts cmd), then writes the signer log. The watcher reports every window shown in that process tree
// (WinEvent EVENT_OBJECT_SHOW + 20 ms EnumDesktopWindows/IsWindowVisible).
// Scenarios:
//   control  = the old way: PowerShell started without windowsHide by a parent without a console. Must flash
//              (proves the watcher catches it).
//   hidden-console-only = the earlier launcher (hidden console, no private desktop) with a CLI that starts a
//              console program from a detached helper: flashes (the company v4 case).
//   current  = the shipped code, parent with a console (Hub starts the proxy that way). 0 windows in every run.
//   current-no-console = the shipped code, parent without any console. 0 windows in every run.
//   private-retry = first CLI exits without a log, then private-desktop Start-Process retries successfully; 0 windows.
// SCENARIOS=a,b and KINDS=... narrow a run for troubleshooting; KEEP_STAMP_WINDOW_DIR=1 keeps the raw results.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ALL_KINDS = 'inherit,hide,hide-nested,shell,detached';

if (process.argv[2] === '--driver') {
  (async () => {
    const [launcher, fakeExe, workRoot, resultFile, kinds] = process.argv.slice(3);
    const { probeNativeStamp } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'company-proxy', 'native-stamp.mjs')).href);
    const { spawn } = require('node:child_process');
    // Control: PowerShell without windowsHide. Its new console is hosted by conhost.exe explicitly (as on the company
    // machine) so that Windows 11 does not hand it to Windows Terminal on the user's desktop.
    const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
    const spawnImpl = launcher === 'old' ? (cmd, args, opts) => spawn(conhost, [cmd, ...args], { ...opts, windowsHide: false }) : spawn;
    const r = await probeNativeStamp({ cliExe: fakeExe, expectedVersion: '9.1.2', workRoot, timeoutMs: 20000, spawnImpl, pollMs: 100, privateDesktop: launcher === 'current' || launcher === 'current-retry',
      env: { ...process.env, FAKE_CLI_NODE: process.execPath, FAKE_CLI_SCRIPT: path.join(path.dirname(fakeExe), 'fake-cli.js'), FAKE_CLI_CHILDREN: kinds,
        ...(launcher === 'current-retry' ? { FAKE_CLI_SKIP_FIRST: path.join(workRoot, 'first-attempt.seen') } : {}) } });
    fs.writeFileSync(resultFile, JSON.stringify({ ok: r.ok, stoppedBy: r.report.stoppedBy, error: r.report.error, cliStarted: r.report.cliStarted,
      consoleMode: r.report.consoleMode, retried: r.report.retried === true, cliRuns: r.report.cliRuns }));
  })().catch(error => { fs.writeFileSync(process.argv[6], JSON.stringify({ ok: false, error: String(error?.message || error) })); process.exitCode = 1; });
  return;
}

const FAKE_CS = `using System; using System.Diagnostics;
class FakeCli { static int Main(string[] a) {
  var p = new ProcessStartInfo(Environment.GetEnvironmentVariable("FAKE_CLI_NODE"), "\\"" + Environment.GetEnvironmentVariable("FAKE_CLI_SCRIPT") + "\\"");
  p.UseShellExecute = false; p.CreateNoWindow = false; // shares this console, like a launcher exe would
  var c = Process.Start(p); c.WaitForExit(); return c.ExitCode; } }`;

const FAKE_JS = `const { spawn, exec } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
if (process.env.FAKE_CLI_SKIP_FIRST && !fs.existsSync(process.env.FAKE_CLI_SKIP_FIRST)) { fs.writeFileSync(process.env.FAKE_CLI_SKIP_FIRST, 'seen'); process.exit(7); }
const ping = 'ping -n 2 127.0.0.1 >nul';
const kinds = (process.env.FAKE_CLI_CHILDREN || '').split(',');
setTimeout(() => {
  if (kinds.includes('inherit')) spawn('cmd.exe', ['/d', '/s', '/c', ping], { stdio: 'ignore' });
  if (kinds.includes('hide')) spawn('cmd.exe', ['/d', '/s', '/c', ping], { stdio: 'ignore', windowsHide: true });
  if (kinds.includes('hide-nested')) spawn('cmd.exe', ['/d', '/s', '/c', 'cmd /d /c ' + ping], { stdio: 'ignore', windowsHide: true });
  if (kinds.includes('shell')) exec(ping, () => {});
  // A helper without any console (detached) that starts a console program: that program gets a new, shown console.
  // conhost.exe hosts it explicitly (as on the company machine), so Windows 11 never hands it to Windows Terminal.
  if (kinds.includes('detached')) spawn(process.execPath, ['-e', "require('child_process').spawn(process.env.SystemRoot+'\\\\\\\\System32\\\\\\\\conhost.exe',['cmd.exe','/d','/c','ping -n 2 127.0.0.1 >nul'],{stdio:'ignore'})"], { stdio: 'ignore', detached: true });
}, 150);
setTimeout(() => fs.writeFileSync(path.join(process.env.TEMP, 'codeagent_signer.log'), 'x SnapEngineSigner created: 9.1.2-win32-x64-1730000000123 more\\n'), 1300);
setTimeout(() => {}, 15000);`;

const SCENARIOS = {
  control: { launcher: 'old', noConsole: true, kinds: 'inherit', expect: 'flash' },
  'hidden-console-only': { launcher: 'hidden-console', noConsole: false, kinds: 'detached', expect: 'flash' },
  current: { launcher: 'current', noConsole: false, kinds: ALL_KINDS, expect: 'none' },
  'current-no-console': { launcher: 'current', noConsole: true, kinds: ALL_KINDS, expect: 'none' },
  'private-retry': { launcher: 'current-retry', noConsole: true, kinds: ALL_KINDS, expect: 'none' },
};

function main() {
  if (process.platform !== 'win32') { console.log(JSON.stringify({ skipped: 'windows only' })); return; }
  const runs = Number(process.argv[2]) || 20;
  const root = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'stamp-window-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake.cs'), FAKE_CS);
  fs.writeFileSync(path.join(bin, 'fake-cli.js'), FAKE_JS);
  const fakeExe = path.join(bin, 'codeagentcli.exe');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', '/out:' + fakeExe, path.join(bin, 'fake.cs')], { windowsHide: true, stdio: 'ignore' });
  const watcher = path.join(__dirname, 'helpers', 'window-flash-watch.py');
  const names = process.env.SCENARIOS ? process.env.SCENARIOS.split(',') : Object.keys(SCENARIOS);
  const summary = { runs, scenarios: {} };
  for (const name of names) {
    const sc = { ...SCENARIOS[name], ...(process.env.KINDS ? { kinds: process.env.KINDS } : {}) };
    const m = summary.scenarios[name] = { ...sc, runs: 0, runsWithWindow: 0, windows: 0, probeOk: 0, retries: 0, hookInstalled: 0, consoleModes: {}, byProcess: {}, perRun: [] };
    const count = sc.expect === 'flash' ? Math.min(runs, 3) : runs;
    for (let i = 0; i < count; i++) {
      const work = path.join(root, `${name}-${i}`); fs.mkdirSync(work);
      const out = path.join(root, `${name}-${i}.json`);
      spawnSync('python', [watcher, '--out', out, '--grace-ms', '2500', ...(sc.noConsole ? ['--no-console'] : []), '--',
        process.execPath, __filename, '--driver', sc.launcher, fakeExe, work, out + '.probe', sc.kinds], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
      const r = JSON.parse(fs.readFileSync(out, 'utf8'));
      const probe = (() => { try { return JSON.parse(fs.readFileSync(out + '.probe', 'utf8')); } catch { return {}; } })();
      if (!r.privateDesktop) throw new Error('watcher did not use a private desktop');
      m.runs++;
      if (probe.ok) m.probeOk++;
      if (probe.retried && probe.cliRuns === 2) m.retries++;
      m.consoleModes[probe.consoleMode] = (m.consoleModes[probe.consoleMode] || 0) + 1;
      if (r.hookInstalled) m.hookInstalled++;
      if (r.visible.length) m.runsWithWindow++;
      m.windows += r.visible.length;
      for (const v of r.visible) { const k = `${v.process}/${v.class}/${v.source}`; m.byProcess[k] = (m.byProcess[k] || 0) + 1; }
      m.perRun.push({ windows: r.visible.length, probeOk: !!probe.ok, retried: !!probe.retried, cliRuns: probe.cliRuns, polls: r.polls, tree: r.treeProcesses });
    }
    m.pass = m.hookInstalled === m.runs && (sc.expect === 'flash' ? m.runsWithWindow === m.runs : m.windows === 0 && m.probeOk === m.runs
      && (sc.launcher !== 'current' || m.consoleModes['private-desktop'] === m.runs)
      && (sc.launcher !== 'current-retry' || m.consoleModes['private-desktop-start-process'] === m.runs && m.retries === m.runs));
  }
  if (!process.env.KEEP_STAMP_WINDOW_DIR) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); else summary.dir = root;
  summary.pass = Object.values(summary.scenarios).every(s => s.pass);
  console.log(JSON.stringify(summary, null, 1));
  if (!summary.pass) process.exitCode = 1;
}
main();
