'use strict';
// 小版本静默送达：后台下载校验，关闭 Hub 时隐藏替换、不重开；大版本和用户关掉开关时不动。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: {} });
const { createAppUpdateController } = require('../main/app-update-controller.js');
const { packPayload } = require('../core/app-update/payload.js');
const { HELPER } = require('../core/app-update/apply.js');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' };
const respJson = obj => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj) });
const respFile = buf => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : 'application/octet-stream') },
  body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })), cancel: async () => {} }; } } });
const settle = async (c, phases) => { for (let i = 0; i < 200; i++) { if (phases.includes(c.getState().phase)) return; await new Promise(r => setTimeout(r, 20)); } };

function setup({ currentVersion = '5.5.13', version = '5.5.14', fail = false, quietDelivery = true } = {}) {
  const res = tmp('quiet-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'icon.ico'), 'icon');
  const gzPath = path.join(tmp('quiet-gz-'), 'pkg.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath);
  const m = { schema: 1, version, notes: ['n'], runtime: { electron: '41.2.0', native: {} }, incremental: { file: `X-${version}-update.gz`, bytes: gz.length, sha256: sha(gz) },
    installer: { file: `X-Setup-${version}.exe`, bytes: 4096, sha256: sha(Buffer.alloc(4096)) } };
  const requests = [];
  let offline = false;
  const fetchImpl = async url => {
    url = String(url); requests.push(url);
    if (offline) throw new Error('offline');
    if (url.endsWith('latest.json')) return respJson(m);
    if (fail) return { ok: false, status: 500, headers: { get: () => '' }, text: async () => '' };
    return respFile(gz);
  };
  const dataDir = tmp('quiet-data-'); const spawned = [];
  const spawnImpl = (cmd, args) => { spawned.push({ cmd, args }); return { unref() {}, on() {} }; };
  const c = createAppUpdateController({ quietDelivery, app: { quit() {} }, config: { sources: [SRC], releasePage: '' }, dataDir, currentVersion, fetchImpl,
    isPackaged: true, resourcesPath: res, env: { AI_HUB_UPDATE_RESOURCES: res }, logger: { warn() {} }, prepareLaunch: () => null, spawnImpl });
  return { c, dataDir, requests, spawned, setManifest: extra => Object.assign(m, extra), setOffline: v => { offline = v; }, res };
}

test('只改末位：后台查到就自动下载好，退出时隐藏启动替换脚本且不重开', async () => {
  const { c, dataDir, spawned } = setup();
  await c.check({ silent: true });
  await settle(c, ['ready']);
  const state = c.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.quiet, true);
  assert.equal(state.latest.notify, false, '界面仍按不提醒处理');
  assert.equal(spawned.length, 0, '下载好之后还不动程序');
  assert.equal(c.applyOnQuit(), true);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args[0], /-WindowStyle Hidden/);
  const plan = JSON.parse(fs.readFileSync(path.join(dataDir, 'app-update', 'plan.json'), 'utf8'));
  assert.equal(plan.relaunch, false, '退出时替换不重开程序');
  assert.equal(plan.quiet, true);
  assert.equal(c.applyOnQuit(), false, '只替换一次');
});

test('用户手动打开「检查更新」查到的不算静默，退出时不自动替换', async () => {
  const { c } = setup();
  await c.check({ silent: false });
  assert.equal(c.getState().phase, 'available');
  await c.download();
  assert.equal(c.getState().phase, 'ready');
  assert.ok(!c.getState().quiet);
  assert.equal(c.applyOnQuit(), false);
});

test('x 或 y 变了的版本照旧走弹窗提醒，不自动下载', async () => {
  const { c, requests } = setup({ version: '5.6.0' });
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.getState().phase, 'available');
  assert.equal(c.getState().latest.notify, true);
  assert.ok(!requests.some(u => u.endsWith('.gz')));
});

test('清单里写 quiet:false 时所有人停止后台下载（远程总开关）', async () => {
  const { c, requests, setManifest } = setup();
  setManifest({ quiet: false });
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.getState().phase, 'available');
  assert.ok(!requests.some(u => u.endsWith('.gz')));
});

test('用户关掉自动更新后不下载，打开后下次检查才下载', async () => {
  const { c, requests } = setup();
  assert.equal(c.getState().quietEnabled, true);
  c.setQuietEnabled(false);
  assert.equal(c.getState().quietEnabled, false);
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.getState().phase, 'available');
  assert.ok(!requests.some(u => u.endsWith('.gz')));
  c.setQuietEnabled(true);
  await c.check({ silent: true });
  await settle(c, ['ready']);
  assert.equal(c.getState().phase, 'ready');
});

test('静默下载失败：回到有新版可下载，不显示错误，同一版本不反复试', async () => {
  const { c, requests } = setup({ fail: true });
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(c.getState().phase, 'available');
  assert.ok(!c.getState().error);
  assert.ok(!c.getState().quiet);
  const before = requests.filter(u => u.endsWith('.gz')).length;
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(requests.filter(u => u.endsWith('.gz')).length, before);
});

test('替换脚本在 relaunch=false 时真实替换文件、写结果、不重开', { skip: process.platform !== 'win32' }, () => {
  const root = tmp('quiet-helper-');
  const resources = path.join(root, 'app', 'resources'); fs.mkdirSync(resources, { recursive: true });
  const newDir = path.join(root, 'new'); fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old-content');
  const fresh = Buffer.from('new-content');
  fs.writeFileSync(path.join(newDir, 'app.asar'), fresh);
  const sentinelExe = path.join(root, 'should-not-run.exe');
  const plan = { version: '5.5.14', from: '5.5.13', pid: 0, exe: sentinelExe, args: [], relaunch: false, quiet: true, waitSeconds: 5, resourcesDir: resources, appDir: path.dirname(resources), leftoverWaitSeconds: 0,
    newDir, stagingDir: root, resultFile: path.join(root, 'last-result.json'), files: [{ path: 'app.asar', sha256: sha(fresh) }] };
  const planFile = path.join(root, 'plan.json'), helper = path.join(root, 'apply-update.ps1');
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8');
  fs.writeFileSync(helper, '﻿' + HELPER, 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper, '-Plan', planFile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8'), 'new-content');
  const result = JSON.parse(fs.readFileSync(plan.resultFile, 'utf8').replace(/^﻿/, ''));
  assert.equal(result.ok, true);
  assert.equal(result.quiet, true);
  fs.rmSync(root, { recursive: true, force: true });
});

async function readyQuiet(options) {
  const ctx = setup(options);
  await ctx.c.check({ silent: true });
  await settle(ctx.c, ['ready']);
  assert.equal(ctx.c.getState().quiet, true);
  return { ...ctx, planFile: path.join(ctx.dataDir, 'app-update', 'plan.json') };
}

test('已经下好后用户关掉开关：退出时不替换', async () => {
  const { c, spawned } = await readyQuiet();
  c.setQuietEnabled(false);
  assert.equal(c.applyOnQuit(), false);
  assert.equal(spawned.length, 0);
});

test('已经下好后远程写 quiet:false：下一次定时检查丢掉旧包，退出时不替换', async () => {
  const { c, spawned, setManifest } = await readyQuiet();
  setManifest({ quiet: false });
  await c.check({ silent: true });
  assert.equal(c.getState().phase, 'available');
  assert.equal(c.getState().quiet, false);
  assert.equal(c.applyOnQuit(), false);
  assert.equal(spawned.length, 0);
});

test('已经下好后又发了新版：丢掉旧包，自动换成新版', async () => {
  const { c, setManifest, planFile } = await readyQuiet();
  setManifest({ version: '5.5.15' });
  await c.check({ silent: true });
  await settle(c, ['ready']);
  assert.equal(c.getState().latest.version, '5.5.15');
  assert.equal(c.applyOnQuit(), true);
  assert.equal(JSON.parse(fs.readFileSync(planFile, 'utf8')).version, '5.5.15');
});

test('已经下好后复查连不上清单：保持原样，退出时照常替换', async () => {
  const { c, setOffline, spawned } = await readyQuiet();
  setOffline(true);
  await c.check({ silent: true });
  assert.equal(c.getState().phase, 'ready');
  assert.equal(c.applyOnQuit(), true);
  assert.equal(spawned.length, 1);
});

test('用户手动检查不影响已下好的静默包', async () => {
  const { c, setManifest } = await readyQuiet();
  setManifest({ quiet: false });
  await c.check({ silent: false });
  assert.equal(c.getState().phase, 'ready');
});

test('后台静默包不挡换通道', async () => {
  const { c, spawned } = await readyQuiet();
  c.useConfig({ sources: [SRC] });
  assert.equal(c.getState().phase, 'idle');
  assert.equal(c.applyOnQuit(), false);
  assert.equal(spawned.length, 0);
});

test('多开：计划文件是别的窗口写的新版本就不动；版本相同时等的是自己', async () => {
  let ctx = await readyQuiet();
  let written = JSON.parse(fs.readFileSync(ctx.planFile, 'utf8'));
  fs.writeFileSync(ctx.planFile, JSON.stringify({ ...written, version: '9.9.9' }));
  assert.equal(ctx.c.applyOnQuit(), false);
  assert.equal(ctx.spawned.length, 0);

  ctx = await readyQuiet();
  written = JSON.parse(fs.readFileSync(ctx.planFile, 'utf8'));
  fs.writeFileSync(ctx.planFile, JSON.stringify({ ...written, pid: 999999 }));
  assert.equal(ctx.c.applyOnQuit(), true);
  assert.equal(JSON.parse(fs.readFileSync(ctx.planFile, 'utf8')).pid, process.pid);
});

test('app.asar 排在最后换：中途断掉时版本号还是旧的，下次还能更新', async () => {
  const { planFile } = await readyQuiet();
  const files = JSON.parse(fs.readFileSync(planFile, 'utf8')).files.map(f => f.path);
  assert.ok(files.length >= 2, files.join());
  assert.equal(files[files.length - 1], 'app.asar');
});

function helperCase(extra = {}) {
  const root = tmp('quiet-helper-');
  const resources = path.join(root, 'app', 'resources');
  const newDir = path.join(root, 'new');
  for (const dir of [path.join(resources, 'app.asar.unpacked'), path.join(newDir, 'app.asar.unpacked')]) fs.mkdirSync(dir, { recursive: true });
  const asar = path.join(resources, 'app.asar'), icon = path.join(resources, 'app.asar.unpacked', 'icon.ico');
  fs.writeFileSync(asar, 'old-asar'); fs.writeFileSync(icon, 'old-icon');
  fs.writeFileSync(path.join(newDir, 'app.asar'), 'new-asar');
  fs.writeFileSync(path.join(newDir, 'app.asar.unpacked', 'icon.ico'), 'new-icon');
  const plan = { version: '5.5.14', from: '5.5.13', pid: 0, exe: path.join(root, 'should-not-run.exe'), args: [], relaunch: false, quiet: true, waitSeconds: 5, resourcesDir: resources,
    appDir: path.dirname(resources), leftoverWaitSeconds: 0, newDir, stagingDir: root, resultFile: path.join(root, 'last-result.json'),
    files: [{ path: 'app.asar.unpacked/icon.ico', sha256: sha(Buffer.from('new-icon')) }, { path: 'app.asar', sha256: sha(Buffer.from('new-asar')) }], ...extra };
  const planFile = path.join(root, 'plan.json'), helper = path.join(root, 'apply-update.ps1');
  fs.writeFileSync(planFile, JSON.stringify(plan), 'utf8');
  fs.writeFileSync(helper, '﻿' + HELPER, 'utf8');
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper, '-Plan', planFile], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const result = () => JSON.parse(fs.readFileSync(plan.resultFile, 'utf8').replace(/^﻿/, ''));
  return { root, resources, asar, icon, plan, run, result, read: f => fs.readFileSync(f, 'utf8'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const winOnly = { skip: process.platform !== 'win32' };

test('替换脚本：上次被打断留下的临时文件不影响这次，换完不留痕迹', winOnly, () => {
  const k = helperCase();
  fs.writeFileSync(k.asar + '.hub-new', 'half-written');
  assert.equal(k.run().status, 0);
  assert.equal(k.read(k.asar), 'new-asar');
  assert.equal(k.read(k.icon), 'new-icon');
  assert.equal(k.result().ok, true);
  assert.equal(k.result().restoreFailed, false);
  assert.deepEqual(fs.readdirSync(k.resources).sort(), ['app.asar', 'app.asar.unpacked']);
  k.done();
});

test('替换脚本：新文件校验不对时原文件一个字节都不动', winOnly, () => {
  const k = helperCase({ files: [{ path: 'app.asar', sha256: 'deadbeef' }] });
  assert.equal(k.run().status, 0);
  assert.equal(k.read(k.asar), 'old-asar');
  assert.equal(k.result().ok, false);
  assert.equal(k.result().rolledBack, true);
  assert.equal(k.result().restoreFailed, false);
  assert.deepEqual(fs.readdirSync(k.resources).sort(), ['app.asar', 'app.asar.unpacked']);
  k.done();
});

test('替换脚本：换到一半失败时全部还原', winOnly, () => {
  const k = helperCase({ simulateFailure: '模拟失败' });
  assert.equal(k.run().status, 0);
  assert.equal(k.read(k.asar), 'old-asar');
  assert.equal(k.read(k.icon), 'old-icon');
  assert.equal(k.result().ok, false);
  assert.match(k.result().reason, /模拟失败/);
  assert.equal(k.result().rolledBack, true);
  k.done();
});

test('替换脚本：多开时另一个脚本已经在干活，这个直接退出', winOnly, () => {
  const k = helperCase();
  const lock = fs.openSync(path.join(k.root, 'helper.lock'), 'w');
  assert.equal(k.run().status, 0);
  fs.closeSync(lock);
  assert.equal(k.read(k.asar), 'old-asar');
  assert.equal(fs.existsSync(k.plan.resultFile), false);
  k.done();
});

test('替换脚本：文件被占用时重试，放开后换上', winOnly, async () => {
  const k = helperCase();
  const flag = path.join(k.root, 'holding.flag');
  const hold = `$f=[IO.File]::Open('${k.asar.replace(/'/g, "''")}','Open','Read','Read');Set-Content -LiteralPath '${flag.replace(/'/g, "''")}' -Value x;Start-Sleep -Seconds 4;$f.Close()`;
  const holder = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', hold], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 150 && !fs.existsSync(flag); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(flag), '占用进程没起来');
  assert.equal(k.run().status, 0);
  await new Promise(r => holder.once('exit', r));
  assert.equal(k.read(k.asar), 'new-asar');
  assert.equal(k.result().ok, true);
  k.done();
});

test('静默送达默认关（11-07 定先不上线）：不开时只提醒、不后台下载，设置里也不显示勾选', async () => {
  const { c } = setup({ quietDelivery: false });
  await c.check({ silent: true });
  await new Promise(r => setTimeout(r, 200));
  const state = c.getState();
  assert.equal(state.quietFeature, false);
  assert.equal(state.quietEnabled, false);
  assert.notEqual(state.phase, 'ready', '没有自动下载');
  assert.notEqual(state.quiet, true);
  assert.equal(c.applyOnQuit(), false);
});

// 2026-11-12 公司电脑事故：cmd 带 detached 时没有控制台，powershell 只好新开一个，Windows Terminal 下藏不住，
// 留下空的「管理员:」窗口，重启后的 Hub 挂在上面，一关窗口 Hub 也退出。替换脚本必须继承一个没有窗口的控制台。
test('启动替换脚本：经 cmd start /b 转一手，不带 detached，只用 windowsHide', () => {
  const { launchHelper } = require('../core/app-update/apply');
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.push('unref'); } }; };
  launchHelper({ helper: 'C:\a b\apply-update.ps1', plan: 'C:\a b\plan.json' }, { env: { X: '1' }, spawnImpl: fake });
  const { args, opts } = calls[0];
  assert.match(args[0], /start "" \/b powershell\.exe .*-WindowStyle Hidden -File "C:\a b\apply-update\.ps1" -Plan "C:\a b\plan\.json"/);
  assert.equal(opts.detached, undefined);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.stdio, 'ignore');
  assert.deepEqual(opts.env, { X: '1' });
  assert.equal(calls[1], 'unref');
});
