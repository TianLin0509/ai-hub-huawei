'use strict';
// Synthetic CodeAgent install + model-adapter package for the company-proxy end-to-end tests (Windows only).
// The adapter's signer.js follows the real one's cache-miss flow: spawn <CodeAgent>\bin\codeagentcli.exe (asking for a
// visible window and a shell, which Hub must override), parse %TEMP%\codeagent_signer.log, write the stamp cache
// into the directory named by FAKE_AUTH_DIR. The CLI is a tiny console program compiled with the .NET Framework
// compiler; it records into FAKE_CLI_REPORT whether it got a console window and whether the proxy key leaked to it.
// index.js builds the chat host from the zone letter like dsh-hw-llm-adapter 1.0.27 does.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI_SOURCE = String.raw`using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
class FakeCodeAgentCli {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static string Console_() { IntPtr w = GetConsoleWindow(); return "consoleWindow=" + (w != IntPtr.Zero ? 1 : 0) + " visible=" + (w != IntPtr.Zero && IsWindowVisible(w) ? 1 : 0); }
  static int Main(string[] args) {
    string report = Environment.GetEnvironmentVariable("FAKE_CLI_REPORT");
    if (args.Length == 1 && args[0] == "--grandchild") { File.AppendAllText(report, "grandchild " + Console_() + "\n"); return 0; }
    IntPtr w = GetConsoleWindow();
    bool visible = w != IntPtr.Zero && IsWindowVisible(w);
    // Like a CLI that runs "cmd /c ..." without hiding it: the grandchild shares the CLI's console if there is one.
    // Without a console it would get a new visible one, so the fake only records that instead of flashing a window.
    string grand = "skipped-no-console";
    if (w != IntPtr.Zero && !visible) {
      var psi = new ProcessStartInfo("cmd.exe", "/d /c \"\"" + Process.GetCurrentProcess().MainModule.FileName + "\" --grandchild\"");
      psi.UseShellExecute = false; psi.CreateNoWindow = false;
      Process.Start(psi).WaitForExit(); grand = "ran";
    }
    string stdin = "";
    try { if (Console.IsInputRedirected) stdin = Console.In.ReadToEnd(); } catch { }
    Thread.Sleep(800);
    string temp = Environment.GetEnvironmentVariable("TEMP");
    if (Environment.GetEnvironmentVariable("CODEAGENT_SIGNER_LOG") == "1" && Environment.GetEnvironmentVariable("FAKE_CLI_NO_LOG") == null)
      File.WriteAllText(Path.Combine(temp, "codeagent_signer.log"), "t SnapEngineSigner created: build win32-x64-1730000000999 ok\n");
    File.AppendAllText(report, "run consoleWindow=" + (w != IntPtr.Zero ? 1 : 0) + " visible=" + (visible ? 1 : 0)
      + " proxyKeyInherited=" + (Environment.GetEnvironmentVariable("AI_HUB_COMPANY_PROXY_KEY") != null ? 1 : 0)
      + " sessionVarsInherited=" + (Environment.GetEnvironmentVariable("CODEAGENT3_LAUNCHER_PID") != null ? 1 : 0)
      + " promptOnStdin=" + (stdin.Length > 0 ? 1 : 0) + " grandchild=" + grand + "\n");
    if (Environment.GetEnvironmentVariable("FAKE_CLI_HANG") != null) Thread.Sleep(600000);
    return 0;
  }
}`;

const SIGNER = `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
let version = '', ok = false;
export function codeagentVersion() { return version; }
export function kernelVersion() { return 'fake'; }
export async function isAvailable() { return ok; }
export async function signHash3() { return null; }
export async function init(dir) {
  version = readFileSync(join(dir, 'version.txt'), 'utf8').trim();
  const file = join(process.env.FAKE_AUTH_DIR, 'codeagent-version-stamp');
  if (existsSync(file) && readFileSync(file, 'utf8').split(/\\r?\\n/)[0] === version) { ok = true; return true; }
  const log = join(process.env.TEMP || process.env.TMP || '.', 'codeagent_signer.log');
  try { unlinkSync(log); } catch {}
  const stamp = await new Promise(resolve => {
    let child;
    try { child = spawn(join(dir, 'bin', 'codeagentcli.exe'), ['--skip-safe-check', '-p', '--tools', '', '--no-session-persistence'],
      { windowsHide: false, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEAGENT_SIGNER_LOG: '1' } }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    child.on('error', () => resolve(null));
    child.on('exit', () => { clearTimeout(timer); try { const m = readFileSync(log, 'utf8').match(/SnapEngineSigner created:.*?win32-x64-(\\d+)/); resolve(m ? m[1] : null); } catch { resolve(null); } });
    child.stdin.end('hi\\n');
  });
  if (stamp) writeFileSync(file, version + '\\n' + stamp + '\\n');
  ok = true; return true;
}
`;
const INDEX = [
  "const headers = { 'app-id': 'com.example.fake-client' };",
  "const SNAP_BASE = 'https://chat.example.test.prod-z-';",
  "const SNAP_PATH = '.example.test/api/v2/chat/completions';",
  'const { username, zone } = this.config.options();',
  'const z = (zone || "green").charAt(0).toLowerCase();',
  'const snapengineUrl = `${SNAP_BASE}${z}${SNAP_PATH}`;',
].join('\n');
const CODEAGENT = ["const IDENTITY = 'https://id.example.test/svc/auth/getUserDetail';",
  "async function getUserDetail(t) { const j = await post(IDENTITY, t); return { account: j.data.staffAccount, deptPath: j.data.orgPath || '' }; }"].join('\n');

function buildFakeCodeAgent(work, { version = '9.1.2' } = {}) {
  const codeagentDir = path.join(work, 'CodeAgentCLI');
  fs.mkdirSync(path.join(codeagentDir, 'bin'), { recursive: true });
  const cs = path.join(work, 'fake-cli.cs');
  fs.writeFileSync(cs, CLI_SOURCE);
  execFileSync(String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, ['/nologo', '/target:exe', '/out:' + path.join(codeagentDir, 'bin', 'codeagentcli.exe'), cs], { windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(path.join(codeagentDir, 'version.txt'), version);
  const pkg = path.join(work, 'pkgsrc', 'package');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fake-hw-llm-adapter', version: '0.0.1', type: 'module' }));
  fs.writeFileSync(path.join(pkg, 'lib', 'signer.js'), SIGNER);
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), INDEX);
  fs.writeFileSync(path.join(pkg, 'lib', 'codeagent.js'), CODEAGENT);
  const adapter = path.join(work, 'fake-llm-adapter-0.0.1.tgz');
  execFileSync(String.raw`C:\Windows\System32\tar.exe`, ['-czf', adapter, '-C', path.join(work, 'pkgsrc'), 'package'], { windowsHide: true });
  return { codeagentDir, adapter, cliReport: path.join(work, 'cli-runs.txt') };
}
const cliLines = file => { try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { return []; } };
const cliRuns = file => cliLines(file).filter(l => l.startsWith('run '));
const grandchildRuns = file => cliLines(file).filter(l => l.startsWith('grandchild '));

module.exports = { buildFakeCodeAgent, cliRuns, grandchildRuns };
