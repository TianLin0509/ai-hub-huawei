'use strict';
// 签名首次初始化探测必须带 --model（2026-11-20 公司反馈：CodeAgent 1.2615.02.05 在空 settings 下读到空模型，
// 提示用 --model 指定后以退出码 1 结束、不写签名日志，7 次启动 6 次失败）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const stampModule = () => import(pathToFileURL(path.join(__dirname, '../core/company-proxy/native-stamp.mjs')).href);
const profileModule = () => import(pathToFileURL(path.join(__dirname, '../core/company-proxy/upstream-profile.mjs')).href);

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-model-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// A CodeAgent CLI like 1.2615.02.05: without a usable --model it prints the upgrade hint and exits 1 with no signer log;
// with an accepted model it writes the signer log and keeps running (Hub stops it). `accepts` = models it accepts
// (null: accepts any model, but still needs one).
function newCli({ accepts = null } = {}) {
  const launches = [], killed = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', null);
    if (/taskkill/i.test(command)) {
      const pid = Number(args[1]); killed.push(pid);
      queueMicrotask(() => {
        const owner = launches.find(item => item.cliPid === pid || item.hostPid === pid);
        if (owner) owner.child.emit('close', 0);
        child.emit('close', 0);
      });
      return child;
    }
    const argv = options.env.HUB_STAMP_ARGS;
    const model = (/--model (\S+)/.exec(argv) || [])[1] || '';
    const retry = options.env.HUB_STAMP_PRIVATE_RETRY === '1';
    const item = { child, cliPid: 700 + launches.length, hostPid: 900 + launches.length, model, retry }; launches.push(item);
    const ok = !!model && (!accepts || accepts.includes(model));
    queueMicrotask(() => {
      if (retry) {
        child.stdout.write(`CLI_MODE=private-desktop-start-process\r\nHOST_PID=${item.hostPid}\r\n`);
        fs.writeFileSync(options.env.HUB_STAMP_PROTOCOL, JSON.stringify({ started: true, pid: item.cliPid, exitCode: ok ? null : 1 }));
      } else child.stdout.write(`CLI_MODE=private-desktop\r\nCLI_PID=${item.cliPid}\r\n`);
      if (ok) {
        fs.writeFileSync(path.join(options.env.TEMP, 'codeagent_signer.log'), 'x SnapEngineSigner created: 1.2615.02.05-win32-x64-1730000000123 more\n');
        return; // keeps running until Hub stops it
      }
      fs.writeFileSync(options.env.HUB_STAMP_OUT, `您当前的模型"${model}"不可用，请升级或使用--model重新获取最新的模型列表\n`);
      queueMicrotask(() => { child.stdout.write(`${retry ? 'HOST_EXIT' : 'CLI_EXIT'}=1\r\n`); child.emit('close', 0); });
    });
    return child;
  };
  return { spawn, launches, killed };
}
const probeOptions = (t, cli, extra) => ({ cliExe: 'C:\\X\\codeagentcli.exe', expectedVersion: '1.2615.02.05', workRoot: temp(t),
  env: {}, spawnImpl: cli.spawn, pollMs: 5, timeoutMs: 300, ...extra });

test('a probe without --model fails on CodeAgent 1.2615.02.05 and is named as a model problem, not a login one', async t => {
  const { probeNativeStamp } = await stampModule();
  const cli = newCli();
  const result = await probeNativeStamp(probeOptions(t, cli, { model: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.report.error, 'CLI_MODEL_REJECTED');
  assert.equal(result.report.cliExitCode, 1);
  const { signerInitFailureMessage } = await profileModule();
  const text = signerInitFailureMessage('SIGNER_INIT_NO_STAMP', { version: '1.2615.02.05', detail: result.report.error, report: result.report });
  assert.match(text, /没有可用的模型/); assert.match(text, /\/model/);
  assert.doesNotMatch(text, /重新登录/);
});

test('with a model the same CLI writes the signer log on the first run', async t => {
  const { probeNativeStamp } = await stampModule();
  const cli = newCli();
  const result = await probeNativeStamp(probeOptions(t, cli, { model: 'deepseek-v4.1-flash-1017' }));
  assert.equal(result.ok, true); assert.equal(result.stamp, '1730000000123');
  assert.equal(cli.launches.length, 1); assert.equal(cli.launches[0].model, 'deepseek-v4.1-flash-1017');
});

test('a rejected first model is replaced by the fallback model on the one retry', async t => {
  const { probeNativeStamp } = await stampModule();
  const cli = newCli({ accepts: ['GLM-5.2-WX-Auto'] });
  const result = await probeNativeStamp(probeOptions(t, cli, { model: 'retired-model-1', fallbackModel: 'GLM-5.2-WX-Auto' }));
  assert.equal(result.ok, true);
  assert.deepEqual(cli.launches.map(item => item.model), ['retired-model-1', 'GLM-5.2-WX-Auto']);
  assert.equal(result.report.attempts[0].error, 'CLI_MODEL_REJECTED');
});

test('probe model order: upstream.json, CodeAgent settings default, account list, model catalog, Hub default', async () => {
  const { stampProbeModels, STAMP_PROBE_DEFAULT_MODEL } = await profileModule();
  const reads = { readCatalog: () => ({ accounts: { personal: { models: [{ id: 'GLM-5.3', menuId: 'GLM-5.3-Auto' }] } } }) };
  const settings = { models: ['deepseek-v4.1-flash-1017', 'GLM-5.2-WX-Auto'], defaultModel: 'deepseek-v4.1-flash-1017', authoritative: true };
  assert.deepEqual(stampProbeModels({ stampProbeModel: 'Pinned-1' }, { dataDir: 'D', readConfigured: () => settings, ...reads }),
    { models: ['Pinned-1', 'deepseek-v4.1-flash-1017'], source: 'config:upstream.json' });
  assert.deepEqual(stampProbeModels({}, { dataDir: 'D', readConfigured: () => settings, ...reads }),
    { models: ['deepseek-v4.1-flash-1017', 'GLM-5.2-WX-Auto'], source: 'codeagent:settings' });
  // A settings default outside the account's own list is skipped (10-19 case: no permission for it).
  assert.deepEqual(stampProbeModels({}, { dataDir: 'D', readConfigured: () => ({ ...settings, models: ['GLM-5.2-WX-Auto'] }), ...reads }).models,
    ['GLM-5.2-WX-Auto', 'GLM-5.3-Auto']);
  assert.deepEqual(stampProbeModels({}, { dataDir: 'D', readConfigured: () => null, ...reads }),
    { models: ['GLM-5.3-Auto', STAMP_PROBE_DEFAULT_MODEL], source: 'hub:model-catalog' });
  // Nothing known (fresh machine, unreadable files): still names a model.
  assert.deepEqual(stampProbeModels({}, { readConfigured: () => { throw new Error('x'); }, readCatalog: () => { throw new Error('y'); } }),
    { models: [STAMP_PROBE_DEFAULT_MODEL], source: 'hub:default' });
  // Another CLI's model name never reaches CodeAgent.
  assert.equal(stampProbeModels({}, { readConfigured: () => ({ models: [], defaultModel: 'claude-sonnet-4', authoritative: false }), readCatalog: () => null }).models[0],
    STAMP_PROBE_DEFAULT_MODEL);
});

test('first-time initialization passes the CodeAgent settings model read from the real config directory', async t => {
  const { loadSigner } = await profileModule();
  const root = temp(t);
  const cac = path.join(root, '.cac'); fs.mkdirSync(cac, { recursive: true });
  fs.writeFileSync(path.join(cac, 'settings.json'), JSON.stringify({ model: 'deepseek-v4.1-flash-1017' }));
  const workDir = path.join(root, 'data', 'company-model-proxy'); fs.mkdirSync(workDir, { recursive: true });
  const seen = [];
  const profile = { signerMode: 'native', codeagentVersion: '1.2615.02.05', codeagentDir: path.join(root, 'CodeAgentCLI'),
    personalCredential: path.join(cac, '.credentials.json'), signerCacheEnv: 'HWTRAN_AUTH_DIR', signerInit: { needed: true, reason: 'missing' } };
  const error = await loadSigner(profile, { workDir, stampProbe: async options => {
    seen.push(options);
    return { ok: false, report: { ran: true, cliStarted: true, cliExitCode: 1, stoppedBy: 'exit', logExists: false, error: 'CLI_MODEL_REJECTED', model: options.model } };
  } }).then(() => null, e => e);
  assert.ok(error, 'probe failure surfaces');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'deepseek-v4.1-flash-1017', 'the probe names the user\'s CodeAgent model instead of leaving it empty');
  assert.equal(seen[0].fallbackModel, 'GLM-5.2-WX-Auto');
  assert.equal(error.firstInit.probe.modelSource, 'codeagent:settings');
  assert.match(error.message, /deepseek-v4\.1-flash-1017/);
});
