'use strict';
// 2026-11-28: the HUB-H trial window opened a pair of Google sign-in tabs every ~6 minutes.
// Its background `agy -p /usage` + `/credits` ran with the real PATH, so an expired token made
// agy fall back to interactive OAuth through rundll32. These tests pin the guards: no-browser
// stub (and no self-updater) on every background agy run, and a 30-minute back-off once agy
// says "not signed in". Duplicate explicit sign-in windows are already prevented by
// AccountCenter (in-flight + lease, resumeLogin), so no extra lock is added there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const cfg = require('../core/antigravity-config');

const AGY = 'D:\\DevTools\\AntigravityCLI\\bin\\agy.exe';

test('background runCli puts the no-op rundll32 stub first on PATH and never mutates the caller env', async () => {
  let call;
  const execFileImpl = (file, argv, opts, cb) => { call = {file, argv, opts}; cb(null, '{}', ''); };
  const env = {ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\Windows\\System32', PATH: 'dup'};
  await cfg.runCli(AGY, ['--output-format', 'json', '-p', '/usage'], env, 30000, {platform: 'win32', execFileImpl, stubDir: () => 'D:\\stub'});
  assert.deepEqual(Object.keys(call.opts.env).filter(k => k.toLowerCase() === 'path'), ['Path']);
  assert.equal(call.opts.env.Path, 'D:\\stub;C:\\Windows\\System32');
  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.PATH, 'dup');
});

test('stub preparation failure rejects instead of running agy without the guard', async () => {
  let ran = false;
  await assert.rejects(cfg.runCli(AGY, ['models'], {}, 1000, {platform: 'win32', execFileImpl: () => { ran = true; },
    stubDir: () => { throw Object.assign(Error('EACCES'), {code: 'EACCES'}); }}), /免弹窗环境/);
  assert.equal(ran, false);
});

test('no-browser stub is a rundll32.cmd that exits 0 and is restored when tampered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stub-hubh-'));
  try {
    assert.equal(cfg.noBrowserDir({dir}), dir);
    const file = path.join(dir, 'rundll32.cmd');
    assert.equal(fs.readFileSync(file, 'utf8'), '@exit /b 0\r\n');
    fs.writeFileSync(file, 'start chrome %*');
    cfg.noBrowserDir({dir});
    assert.equal(fs.readFileSync(file, 'utf8'), '@exit /b 0\r\n');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('usage poll backs off 30 minutes after agy says not signed in, and a forced refresh still runs', async () => {
  const {createAntigravityUsage, LOGIN_BACKOFF_MS} = require('../main/usage/antigravity-account-usage');
  let t = 1_000_000, calls = 0;
  const runImpl = async () => { calls++; return {code: 1, stdout: '', stderr: 'Please sign in to continue: triggering interactive OAuth'}; };
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => t, ttlMs: 300000});
  const first = await usage.refresh();
  assert.equal(calls, 2, 'one /usage and one /credits');
  assert.equal(first.loginRequired, true);
  assert.match(first.error, /未登录|过期/);
  t += 6 * 60 * 1000; await usage.refresh();          // the old 5-minute poll would ask again here
  assert.equal(calls, 2, 'held back while not signed in');
  t += LOGIN_BACKOFF_MS; await usage.refresh();
  assert.equal(calls, 4, 'asks again once the back-off ends');
  await usage.refresh(true);
  assert.equal(calls, 6, 'a forced refresh (user clicked) is never held back');
});

test('usage poll clears the login flag once agy answers again', async () => {
  const {createAntigravityUsage} = require('../main/usage/antigravity-account-usage');
  let t = 0, signedIn = false;
  const ok = name => ({code: 0, stderr: '', stdout: JSON.stringify(name === '/usage'
    ? {status: 'SUCCESS', num_turns: 0, command: {name: 'usage', data: {groups: [{name: 'Gemini', buckets: [{id: 'gemini-x', window: '5h', remaining_fraction: 0.5}]}]}}}
    : {status: 'SUCCESS', num_turns: 0, command: {name: 'credits', data: {remaining_credits: 10}}})});
  const runImpl = async (cmd, args) => signedIn ? ok(args[3]) : {code: 1, stdout: 'not signed in', stderr: ''};
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => t});
  assert.equal((await usage.refresh()).loginRequired, true);
  signedIn = true;
  const next = await usage.refresh(true);
  assert.equal(next.loginRequired, undefined);
  assert.equal(next.error, undefined);
  assert.equal(next.usage5h.pct, 50);
});

test('model catalog holds a "not signed in" answer for 30 minutes unless forced', async () => {
  const catalog = require('../core/antigravity-model-catalog');
  catalog.resetModelCatalogCache();
  let t = 0, calls = 0;
  const runImpl = async () => { calls++; return {code: 1, stdout: 'Please sign in', stderr: ''}; };
  const ask = force => catalog.readModelCatalog({env: {AI_HUB_ANTIGRAVITY_COMMAND: AGY}, runImpl, now: () => t, force, profileId: 'p-test'});
  assert.equal((await ask(false)).loginRequired, true);
  t += 5 * 60 * 1000; await ask(false);
  assert.equal(calls, 1, 'the old 1-minute failure TTL would have re-run agy models');
  t += 30 * 60 * 1000; await ask(false);
  assert.equal(calls, 2);
  await ask(true);
  assert.equal(calls, 3, 'a pending explicit login is never held back');
  catalog.resetModelCatalogCache();
});


test('background env also switches off the agy self-updater, on every platform', () => {
  assert.equal(cfg.backgroundEnv({Path: 'x'}, {platform: 'win32', stubDir: () => 'S'}).AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  const linux = cfg.backgroundEnv({PATH: '/usr/bin'}, {platform: 'linux', stubDir: () => assert.fail('no stub off Windows')});
  assert.equal(linux.PATH, '/usr/bin');
  assert.equal(linux.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
});

test('unattended headless prompt (dream consolidation) also runs with the no-browser env', async () => {
  const {EventEmitter} = require('events');
  const {runPrompt} = require('../core/antigravity-headless');
  let seen;
  const spawnImpl = (cmd, args, opts) => {
    seen = opts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = () => setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({event: 'result', result: {status: 'SUCCESS', response: 'ok'}}) + '\n');
      child.emit('close', 0);
    });
    child.kill = () => {};
    return child;
  };
  const env = {Path: 'WINPATH', AI_HUB_ANTIGRAVITY_COMMAND: AGY};
  assert.equal(await runPrompt('hi', {env, spawnImpl}), 'ok');
  assert.equal(seen.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  if (process.platform === 'win32') assert.match(seen.Path, /ai-hub-agy-no-browser;WINPATH$/);
});

test('a query killed while agy waits for the OAuth callback still counts as not signed in', async () => {
  const {createAntigravityUsage} = require('../main/usage/antigravity-account-usage');
  let t = 0, calls = 0;
  const runImpl = async () => { calls++; throw Object.assign(Error('Antigravity 查询超时'), {code: 'ETIMEDOUT', killed: true, stdout: '', stderr: 'token expired, triggering interactive OAuth'}); };
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => t});
  assert.equal((await usage.refresh()).loginRequired, true);
  t += 6 * 60 * 1000; await usage.refresh();
  assert.equal(calls, 2, 'no new agy pair within the back-off');
  const catalog = require('../core/antigravity-model-catalog');
  catalog.resetModelCatalogCache();
  const r = await catalog.readModelCatalog({env: {AI_HUB_ANTIGRAVITY_COMMAND: AGY}, runImpl, profileId: 'p-timeout'});
  assert.equal(r.loginRequired, true);
  catalog.resetModelCatalogCache();
});

test('runCli keeps agy output on timeout and leaves no dangling timer after a fast answer', async () => {
  let cb;
  const killed = [];
  const p = cfg.runCli(AGY, ['models'], {}, 20, {platform: 'win32', stubDir: () => 'S', killTree: pid => { killed.push(pid); cb(Object.assign(Error('killed'), {killed: true}), 'partial', 'triggering interactive OAuth'); },
    execFileImpl: (f, a, o, c) => { cb = c; return {pid: 7, kill() {}}; }});
  const error = await p.catch(e => e);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(error.stderr, 'triggering interactive OAuth');
  assert.deepEqual(killed, [7]);
});

test('eligibility or proxy errors that mention accounts.google.com are not "not signed in"', async () => {
  const {createAntigravityUsage} = require('../main/usage/antigravity-account-usage');
  let t = 0, calls = 0;
  const runImpl = async () => { calls++; return {code: 1, stdout: '', stderr: 'Eligibility check failed: Your current account is not eligible for Antigravity. https://accounts.google.com/x'}; };
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => t, ttlMs: 300000});
  const r = await usage.refresh();
  assert.equal(r.loginRequired, undefined);
  t += 6 * 60 * 1000; await usage.refresh();
  assert.equal(calls, 4, 'ordinary errors keep the normal 5-minute cadence');
});

test('an ordinary error after a not-signed-in answer drops the stale login flag', async () => {
  const {createAntigravityUsage} = require('../main/usage/antigravity-account-usage');
  let signedOut = true;
  const runImpl = async () => signedOut ? {code: 1, stdout: 'not signed in', stderr: ''} : {code: 1, stdout: '', stderr: 'dial tcp: i/o timeout'};
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => 0});
  assert.equal((await usage.refresh()).loginRequired, true);
  signedOut = false;
  const next = await usage.refresh(true);
  assert.equal(next.loginRequired, undefined);
  assert.ok(next.error);
});

test('credits saying "not signed in" is enough to back off', async () => {
  const {createAntigravityUsage} = require('../main/usage/antigravity-account-usage');
  const runImpl = async (cmd, args) => args[3] === '/credits' ? {code: 1, stdout: 'Please sign in', stderr: ''} : {code: 1, stdout: '', stderr: 'boom'};
  const usage = createAntigravityUsage({env: {}, runImpl, now: () => 0});
  assert.equal((await usage.refresh()).loginRequired, true);
});
