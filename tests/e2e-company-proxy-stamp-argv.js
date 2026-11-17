'use strict';
// Windows process integration with a simulated CodeAgent executable, not a real
// model/login test. Exercises both private-desktop launchers and argv quoting.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows required');
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/r33/native-argv');
  const scratch = path.join(out, 'fixture ' + Date.now());
  fs.mkdirSync(scratch, { recursive: true });
  const source = path.join(scratch, 'fixture.cs'), exe = path.join(scratch, 'codeagent fixture.exe');
  fs.writeFileSync(source, `using System; using System.IO;
public static class Fixture {
  public static int Main(string[] args) {
    string input = Console.In.ReadToEnd();
    bool prompt = args.Length > 0 && System.Text.RegularExpressions.Regex.IsMatch(args[args.Length-1],
      @"^Reply with exactly STAMP_[a-f0-9]{12} and nothing else\\. Do not use tools\\.$");
    bool skip = Array.IndexOf(args, "--skip-safe-check") >= 0;
    if (!prompt || !skip) {
      Console.Error.WriteLine("fixture stdin was consumed by startup check: " + (input.Length > 0));
      Console.Error.WriteLine("Error: Input must be provided either through stdin or as a prompt argument when using --print");
      return 1;
    }
    int tools = Array.IndexOf(args, "--tools");
    if (input.Length != 0 || tools < 0 || tools+1 >= args.Length || args[tools+1] != "") return 2;
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "codeagent_signer.log"),
      "SnapEngineSigner created: 9.1.2-win32-x64-1730000000111\\n");
    return 0;
  }
}`, 'utf8');
  const compile = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop";Add-Type -Path $env:HUB_FIXTURE_SOURCE -OutputAssembly $env:HUB_FIXTURE_EXE -OutputType ConsoleApplication'],
    { windowsHide: true, encoding: 'utf8', env: { ...process.env, HUB_FIXTURE_SOURCE: source, HUB_FIXTURE_EXE: exe } });
  assert.equal(compile.status, 0, compile.stderr);
  const { probeNativeStamp } = await import(pathToFileURL(path.resolve(__dirname, '../core/company-proxy/native-stamp.mjs')).href);
  const configDir = path.join(scratch, 'isolated-config');
  fs.mkdirSync(configDir);
  const options = { cliExe: exe, configDir, expectedVersion: '9.1.2', workRoot: scratch, timeoutMs: 20000, pollMs: 50 };
  // Removing only the changed retry arguments must bring the original failure
  // back, while still running the real private desktop / Start-Process chain.
  const control = await probeNativeStamp({ ...options, spawnImpl(command, args, opts) {
    if (opts.env?.HUB_STAMP_PRIVATE_RETRY) opts = { ...opts, env: { ...opts.env,
      HUB_STAMP_ARGS: opts.env.HUB_STAMP_ARGS.replace(/ --skip-safe-check "Reply with exactly STAMP_[^"]+"$/, '') } };
    return spawn(command, args, opts);
  } });
  assert.equal(control.ok, false);
  assert.equal(control.report.cliRuns, 2);
  assert.equal(control.report.error, 'CLI_INPUT_MISSING');
  const fixed = await probeNativeStamp(options);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.report.cliRuns, 2);
  assert.equal(fixed.report.consoleMode, 'private-desktop-start-process');
  assert.equal(fixed.report.cleanupConfirmed, true);
  assert.equal(fixed.report.logVersionStatus, 'matched');
  assert.equal(fixed.stamp, '1730000000111');
  const report = { ok: true, simulatedCLI: true, realWindowsLaunchers: true,
    control: control.report, fixed: fixed.report };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
