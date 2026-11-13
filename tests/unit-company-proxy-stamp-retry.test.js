'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../core/company-proxy/native-stamp.mjs')).href);

test('known OAuth token fields redact mixed base64 values through JSON escape layers', async () => {
  const { sanitizeProbeStderr } = await load();
  const token = 'ab+/cd'.repeat(8);
  for (const key of ['xAuthToken', 'mtoken', 'accessToken', 'refreshToken']) {
    let input = JSON.stringify({ [key]: token });
    for (let layer = 0; layer < 3; layer++) {
      const redacted = sanitizeProbeStderr(input, { env: {} }).join('\n');
      assert.equal(redacted.includes(token), false, key + ' layer ' + layer);
      assert.match(redacted, /已隐去/);
      input = JSON.stringify(input);
    }
  }
});
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-retry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

function launcher(cases, { killSucceeds = true } = {}) {
  const calls = [], launches = [], killed = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', null);
    calls.push({ command, args, options });
    if (/taskkill/i.test(command)) {
      const pid = Number(args[1]); killed.push(pid);
      setImmediate(() => {
        if (killSucceeds) {
          const owner = launches.find(item => item.cliPid === pid || item.hostPid === pid);
          if (owner) owner.child.emit('close', 0);
        }
        child.emit('close', killSucceeds ? 0 : 1);
      });
      return child;
    }
    const index = launches.length, scenario = cases[Math.min(index, cases.length - 1)];
    const retry = options.env.HUB_STAMP_PRIVATE_RETRY === '1';
    const item = { child, cliPid: 700 + index, hostPid: 900 + index, retry }; launches.push(item);
    setTimeout(() => {
      if (scenario.startFailed) {
        child.stdout.write('CLI_START_FAILED\r\nCLI_ERROR=PRIVATE_DESKTOP_START_FAILED\r\n'); child.emit('close', 3); return;
      }
      if (retry) {
        child.stdout.write(`CLI_MODE=private-desktop-start-process\r\nHOST_PID=${item.hostPid}\r\n`);
        fs.writeFileSync(options.env.HUB_STAMP_PROTOCOL, JSON.stringify({ started: true, pid: item.cliPid, exitCode: scenario.hang ? null : scenario.exitCode ?? 7 }));
        if (scenario.hostStderr) fs.writeFileSync(options.env.HUB_STAMP_HOST_ERR, scenario.hostStderr);
      } else child.stdout.write(`CLI_MODE=${scenario.mode || 'private-desktop'}\r\nCLI_PID=${item.cliPid}\r\n`);
      if (scenario.stderr) fs.writeFileSync(options.env.HUB_STAMP_ERR, scenario.stderr);
      if (scenario.log) fs.writeFileSync(path.join(options.env.TEMP, 'codeagent_signer.log'), scenario.log === true
        ? 'x SnapEngineSigner created: 9.1.2-win32-x64-1730000000123 more\n' : scenario.log);
      if (!scenario.hang) setTimeout(() => {
        child.stdout.write(`${retry ? 'HOST_EXIT' : 'CLI_EXIT'}=${scenario.exitCode ?? 7}\r\n`); child.emit('close', 0);
      }, 6);
    }, 4);
    return child;
  };
  return { spawn, calls, launches, killed };
}

test('private-desktop no-log early exit retries once through a private Start-Process host, using the real CLI PID', async t => {
  const { probeNativeStamp } = await load();
  const fake = launcher([{ exitCode: 7, stderr: 'first attempt failed' }, { log: true, hang: true }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 150 });
  assert.equal(result.ok, true); assert.equal(result.stamp, '1730000000123');
  assert.equal(fake.launches.length, 2); assert.equal(result.report.retried, true);
  assert.equal(result.report.cliRuns, 2); assert.equal(result.report.attempts.length, 2);
  assert.equal(result.report.attempts[0].cliExitCode, 7);
  assert.equal(result.report.attempts[0].error, 'LOG_MISSING');
  assert.equal(result.report.consoleMode, 'private-desktop-start-process');
  assert.deepEqual(fake.killed, [701], 'cleanup targets the protocol CLI PID, not the host PID 901');
  const retry = fake.calls.filter(call => /powershell/i.test(call.command))[1];
  assert.equal(retry.options.windowsHide, true); assert.equal(retry.options.detached, false);
  assert.match(retry.options.env.HUB_STAMP_CS, /CreateDesktopW/);
  const encoded = retry.options.env.HUB_STAMP_HOST_ARGS.split(' ').at(-1);
  const hostScript = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(hostScript, /Start-Process .*?-WindowStyle Hidden/);
  assert.match(hostScript, /pid=\$p\.Id/); assert.match(hostScript, /exitCode=\$p\.ExitCode/);
  assert.doesNotMatch(JSON.stringify(result.report), /CLI_PID|HOST_PID|C:\\\\X/);
});

test('both failed attempts retain separate sanitized CLI and host stderr facts, with no third run', async t => {
  const { probeNativeStamp } = await load();
  const userPath = ['C:', 'Users', 'Fixture Person', 'cache'].join('\\');
  const fake = launcher([{ exitCode: 2, stderr: userPath }, { exitCode: 9, stderr: 'token=' + 'q'.repeat(40), hostStderr: '/home/Fixture Person/cache 123456789' }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t), env: {}, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal(fake.launches.length, 2); assert.equal(result.report.cliRuns, 2);
  assert.deepEqual(result.report.attempts.map(report => report.cliExitCode), [2, 9]);
  assert.equal(result.report.cliExitCode, 9);
  assert.equal(result.report.hostExitCode, 9);
  assert.ok(result.report.hostStderrPreview.length > 0);
  const serialized = JSON.stringify(result.report);
  for (const raw of ['Fixture', 'Person', '123456789', 'q'.repeat(40)]) assert.equal(serialized.includes(raw), false, raw);
});

test('logs, explicit non-private tests and private desktop startup failure never activate the retry', async t => {
  const { probeNativeStamp } = await load();
  for (const scenario of [{ log: 'unrecognized signer output\n' }, { mode: 'hidden-console' }, { startFailed: true }]) {
    const fake = launcher([scenario]);
    const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
      env: {}, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 100, ...(scenario.mode ? { privateDesktop: false } : {}) });
    assert.equal(fake.launches.length, 1); assert.notEqual(result.report.retried, true);
    if (scenario.startFailed) {
      assert.equal(result.report.launchFailure, 'private-desktop');
      assert.equal(result.report.consoleMode, 'unknown'); assert.equal(result.report.cliRuns, 0);
      const script = fake.calls[0].args.at(-1);
      const guard = script.indexOf('if($cs -and $id -le 0)');
      assert.ok(guard > script.indexOf('[HubStampLaunch]::Start'));
      assert.ok(guard < script.indexOf('try{$p=Start-Process'), 'private failure exits before the user-desktop control path');
      assert.match(script.slice(guard, script.indexOf('try{$p=Start-Process')), /exit 3/);
    }
  }
});

test('each retry attempt is bounded and an unconfirmed first CLI cleanup suppresses the second run', async t => {
  const { probeNativeStamp } = await load();
  const timed = launcher([{ hang: true }]);
  const started = Date.now();
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: timed.spawn, pollMs: 5, timeoutMs: 35 });
  assert.equal(timed.launches.length, 2); assert.equal(result.report.error, 'CLI_TIMEOUT');
  assert.ok(Date.now() - started >= 60 && Date.now() - started < 1000);
  assert.deepEqual(timed.killed, [700, 701]);
  const stuck = launcher([{ hang: true }], { killSucceeds: false });
  const failed = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: stuck.spawn, pollMs: 5, timeoutMs: 25 });
  assert.equal(stuck.launches.length, 1); assert.equal(failed.report.cleanupConfirmed, false);
  assert.equal(failed.report.retrySuppressed, 'cleanup-unconfirmed');
});

test('stderr redaction masks complete spaced profile names through raw and two JSON escape layers', async () => {
  const { sanitizeProbeStderr } = await load();
  const paths = [['C:', 'Users', 'Fixture Person', 'cache'].join('\\'), '/home/Fixture Person/cache', '/Users/Fixture Person/cache'];
  for (const file of paths) {
    let input = file;
    for (let layer = 0; layer < 3; layer++) {
      const output = sanitizeProbeStderr(input, { env: {} }).join('\n');
      assert.equal(output.includes('Fixture'), false, output);
      assert.equal(output.includes('Person'), false, output);
      input = JSON.stringify({ path: input });
    }
  }
});

test('the unpacked proxy module tree imports and redacts without a parent hub-feedback.js', async t => {
  const root = temp(t), copied = path.join(root, 'core', 'company-proxy');
  fs.cpSync(path.join(__dirname, '../core/company-proxy'), copied, { recursive: true,
    filter: file => fs.statSync(file).isDirectory() || /\.(?:mjs|json)$/.test(file) });
  assert.equal(fs.existsSync(path.join(root, 'core/hub-feedback.js')), false);
  const isolated = await import(pathToFileURL(path.join(copied, 'native-stamp.mjs')).href);
  const token = 'sk-' + 'a'.repeat(40);
  assert.equal(isolated.sanitizeProbeStderr('token=' + token, { env: {} }).join('').includes(token), false);
});

test('stderr JSON previews stay within 4096 UTF-8 bytes and explicitly report all cropping', async t => {
  const { probeNativeStamp } = await load();
  for (const stderr of [Array.from({ length: 21 }, (_, index) => 'line ' + index).join('\n'),
    '测'.repeat(800), Array.from({ length: 20 }, () => '测'.repeat(500)).join('\n'), '"\\'.repeat(20000)]) {
    const fake = launcher([{ mode: 'hidden-console', stderr }]);
    const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t), env: {},
      privateDesktop: false, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 100 });
    assert.equal(result.report.stderrPreviewTruncated, true);
    assert.ok(result.report.stderrPreview.length <= 20);
    assert.ok(Buffer.byteLength(JSON.stringify(result.report.stderrPreview)) <= 4096);
  }
  const fake = launcher([{ mode: 'hidden-console', stderr: 'short detail\n' }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t), env: {},
    privateDesktop: false, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 100 });
  assert.equal(result.report.stderrPreviewTruncated, false);
  assert.deepEqual(result.report.stderrPreview, ['short detail']);
});
