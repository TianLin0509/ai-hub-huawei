'use strict';
// Windows process integration with a simulated CodeAgent 1.2615.02.05 executable (not a real model/login test):
// without a usable --model it prints the "use --model" hint on stdout and exits 1 with no signer log.
// Runs the real private-desktop launchers and the one retry.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows required');
  const out = path.resolve(process.env.HUB_E2E_ARTIFACT_DIR || 'artifacts/rsi1120-a/stamp-model');
  const scratch = path.join(out, 'fixture ' + Date.now());
  fs.mkdirSync(scratch, { recursive: true });
  const source = path.join(scratch, 'fixture.cs'), exe = path.join(scratch, 'codeagent fixture.exe');
  fs.writeFileSync(source, `using System; using System.IO;
public static class Fixture {
  public static int Main(string[] args) {
    int at = Array.IndexOf(args, "--model");
    string model = at >= 0 && at + 1 < args.Length ? args[at + 1] : "";
    if (model != "GLM-5.2-WX-Auto") {
      Console.Out.WriteLine("model \\"" + model + "\\" is unavailable, upgrade or use --model to refresh the model list");
      return 1;
    }
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "codeagent_signer.log"),
      "SnapEngineSigner created: 1.2615.02.05-win32-x64-1730000000222\\n");
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
  const options = { cliExe: exe, configDir, expectedVersion: '1.2615.02.05', workRoot: scratch, timeoutMs: 20000, pollMs: 50 };
  // Before the fix Hub sent no --model: both runs fail and the failure is named as a model problem.
  const control = await probeNativeStamp({ ...options, model: '' });
  assert.equal(control.ok, false);
  assert.equal(control.report.cliRuns, 2);
  assert.equal(control.report.error, 'CLI_MODEL_REJECTED');
  // With a model the first run succeeds.
  const direct = await probeNativeStamp({ ...options, model: 'GLM-5.2-WX-Auto' });
  assert.equal(direct.ok, true);
  assert.equal(direct.report.cliRuns, 1);
  assert.equal(direct.stamp, '1730000000222');
  // A rejected first model: the retry (Start-Process launcher) names the fallback model.
  const fallback = await probeNativeStamp({ ...options, model: 'retired-model-1', fallbackModel: 'GLM-5.2-WX-Auto' });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.report.cliRuns, 2);
  assert.equal(fallback.report.attempts[0].error, 'CLI_MODEL_REJECTED');
  assert.equal(fallback.report.consoleMode, 'private-desktop-start-process');
  assert.equal(fallback.report.cleanupConfirmed, true);
  const report = { ok: true, simulatedCLI: true, realWindowsLaunchers: true,
    control: control.report, direct: direct.report, fallback: fallback.report };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, control: control.report.error, direct: direct.report.cliRuns, fallback: fallback.report.cliRuns }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
