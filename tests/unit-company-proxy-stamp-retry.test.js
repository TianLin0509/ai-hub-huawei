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

// These scenarios specify process events, not elapsed startup time. Publish them
// asynchronously without wall-clock timers; timeout boundaries are tested below
// with the injected logical clock instead of racing filesystem setup under load.
function launcher(cases, { killSucceeds = true, later = queueMicrotask, soon = queueMicrotask } = {}) {
  const calls = [], launches = [], killed = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', null);
    calls.push({ command, args, options });
    if (/taskkill/i.test(command)) {
      const pid = Number(args[1]); killed.push(pid);
      soon(() => {
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
    later(() => {
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
      if (!scenario.hang) later(() => {
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

test('no-log retry supplies argv input and skips scratch cwd safety prompts without changing the first launch', async t => {
  const { probeNativeStamp } = await load();
  const inputs = [];
  const fake = launcher([{ exitCode: 1, stderr: 'Input must be provided either through stdin or as a prompt argument when using --print' },
    { log: true, hang: true }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t), env: {},
    pollMs: 5, timeoutMs: 150, spawnImpl(command, args, options) {
      if (options?.env?.HUB_STAMP_ARGS) inputs.push({ args: options.env.HUB_STAMP_ARGS,
        stdin: fs.readFileSync(options.env.HUB_STAMP_IN, 'utf8'), cwd: options.env.HUB_STAMP_CWD,
        settings: JSON.parse(fs.readFileSync(path.join(options.env.HUB_STAMP_CWD, '..', 'settings.json'), 'utf8')) });
      return fake.spawn(command, args, options);
    } });
  assert.equal(result.ok, true);
  assert.equal(inputs.length, 2);
  assert.match(inputs[0].stdin, /^Reply with exactly STAMP_[a-f0-9]+ and nothing else/);
  assert.doesNotMatch(inputs[0].args, /STAMP_|--skip-safe-check/);
  assert.equal(inputs[1].stdin, '', 'stdin cannot duplicate or consume the retry prompt');
  assert.match(inputs[1].args, /--skip-safe-check "Reply with exactly STAMP_[a-f0-9]+ and nothing else\. Do not use tools\."$/);
  assert.match(inputs[1].args, /--tools "" --strict-mcp-config/);
  assert.equal(path.basename(inputs[1].cwd), 'cwd');
  assert.notEqual(inputs[0].cwd, inputs[1].cwd);
  assert.deepEqual(inputs[1].settings, {});
  assert.equal(result.report.attempts[0].error, 'CLI_INPUT_MISSING');
  assert.doesNotMatch(JSON.stringify(result.report), /STAMP_[a-f0-9]+/);
});

test('missing --print input is explained as input delivery failure without guessing a login failure', async t => {
  const { probeNativeStamp } = await load();
  const missing = 'Error: Input must be provided either through stdin or as a prompt argument when using --print';
  const fake = launcher([{ exitCode: 1, stderr: missing }, { exitCode: 1, stderr: missing }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: fake.spawn, pollMs: 5, timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.equal(result.report.error, 'CLI_INPUT_MISSING');
  const { signerInitFailureMessage } = await import(pathToFileURL(path.join(__dirname, '../core/company-proxy/upstream-profile.mjs')).href);
  const message = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: result.report.error, report: result.report });
  assert.match(message, /未收到.*测试输入/);
  assert.doesNotMatch(message, /重新启动反代/);
  assert.match(message, /直接点「一键反馈」/);
  assert.match(message, /一键反馈/);
  assert.doesNotMatch(message, /已登录|登录过期|确认 CodeAgent/);
  const blocked = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_INPUT_MISSING',
    report: { retrySuppressed: 'cleanup-unconfirmed' } });
  assert.match(blocked, /后台进程还没确认结束.*停止重试/);
  assert.doesNotMatch(blocked, /已尝试通过命令行参数补发输入|重新启动反代/);
});

test('no-log retry leaves existing CodeAgent config, root trust and credentials unchanged', async t => {
  const { probeNativeStamp } = await load();
  const root = temp(t), configDir = path.join(root, 'config'), home = path.join(root, 'home');
  for (const dir of [configDir, home]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({ other: 'keep', projects: { 'C:/existing': { hasTrustDialogAccepted: false } } }));
  }
  const credential = path.join(configDir, '.credentials.json'); fs.writeFileSync(credential, 'fixture-auth-untouched');
  const observed = [];
  const fake = launcher([{ exitCode: 1 }, { log: true, hang: true }]);
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', configDir, expectedVersion: '9.1.2', workRoot: root,
    env: { USERPROFILE: home }, pollMs: 5, timeoutMs: 150, spawnImpl(command, args, options) {
      if (options?.env?.HUB_STAMP_ARGS) observed.push({ cwd: options.env.HUB_STAMP_CWD,
        states: [configDir, home].map(dir => JSON.parse(fs.readFileSync(path.join(dir, '.cac.json'), 'utf8'))) });
      return fake.spawn(command, args, options);
    } });
  assert.equal(result.ok, true); assert.equal(observed.length, 2);
  for (const attempt of observed) for (const state of attempt.states) {
    assert.equal(state.other, 'keep'); assert.equal(state.projects['C:/existing'].hasTrustDialogAccepted, false);
    assert.deepEqual(Object.keys(state.projects), ['C:/existing'], 'no probe cwd is added to either trust store');
  }
  assert.equal(fs.readFileSync(credential, 'utf8'), 'fixture-auth-untouched');
});

test('production signer failure messages keep restart protection synchronized with known-issue matching', async () => {
  const { signerInitFailureMessage } = await import(pathToFileURL(path.join(__dirname, '../core/company-proxy/upstream-profile.mjs')).href);
  const { matchKnownIssue } = require('../core/known-issues');
  for (const report of [{ retried: true }, { retrySuppressed: 'cleanup-unconfirmed' }]) {
    const message = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_INPUT_MISSING', report });
    assert.equal(matchKnownIssue({ area: 'notice', details: message }), null, message);
    assert.doesNotMatch(message, /重新启动反代/);
    assert.match(message, /一键反馈/);
  }
  const ordinary = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'CLI_INPUT_MISSING', report: {} });
  assert.equal(matchKnownIssue({ area: 'notice', details: ordinary })?.action?.act, 'known:proxy-restart');
  const genericBlocked = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { detail: 'LOG_MISSING',
    report: { retrySuppressed: 'cleanup-unconfirmed' } });
  assert.equal(matchKnownIssue({ area: 'notice', details: genericBlocked }), null);
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
  // Only an awaited poll advances this clock. Filesystem work and event-loop
  // scheduling cannot consume the CLI's 35ms budget before its PID arrives.
  let time = 1000;
  const waits = [];
  const clock = { now: () => time, waitFor: async (closed, ms) => {
    let exited = false;
    closed.then(() => { exited = true; });
    await Promise.resolve();
    if (!exited) { waits.push(ms); time += ms; }
  } };
  const schedule = { later: queueMicrotask, soon: queueMicrotask };
  const timed = launcher([{ hang: true }], schedule);
  const started = time;
  const result = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: timed.spawn, pollMs: 5, timeoutMs: 35, ...clock });
  assert.equal(timed.launches.length, 2); assert.equal(result.report.error, 'CLI_TIMEOUT');
  assert.equal(time - started, 70);
  assert.equal(result.report.elapsedMs, 70);
  assert.deepEqual(result.report.attempts.map(attempt => [attempt.stoppedBy, attempt.error, attempt.elapsedMs]),
    [['timeout', 'CLI_TIMEOUT', 35], ['timeout', 'CLI_TIMEOUT', 35]]);
  assert.deepEqual(waits, Array(14).fill(5));
  assert.deepEqual(timed.killed, [700, 701]);
  const stuck = launcher([{ hang: true }], { killSucceeds: false, ...schedule });
  const failed = await probeNativeStamp({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '9.1.2', workRoot: temp(t),
    env: {}, spawnImpl: stuck.spawn, pollMs: 5, timeoutMs: 25, ...clock });
  assert.equal(stuck.launches.length, 1); assert.equal(failed.report.cleanupConfirmed, false);
  assert.equal(failed.report.retrySuppressed, 'cleanup-unconfirmed');
  assert.equal(failed.report.error, 'CLI_TIMEOUT');
  assert.equal(failed.report.stoppedBy, 'timeout');
  assert.deepEqual(stuck.killed, [700]);
  assert.deepEqual(waits.slice(14), [5, 5, 5, 5, 5, 3000]);
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
