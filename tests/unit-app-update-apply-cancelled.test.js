'use strict';
// r43（2026-11-18）：点「立即重启」后 Hub 没退出（退出被取消、替换脚本先结束），一键更新不能停在「正在应用」。
// 以前旧 Hub 一直停在「正在应用」：弹窗没有按钮，同一版本的提醒已用掉，后台检查也被覆盖，之后自动下载、升级都不再出现。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: {} });
const { createAppUpdateController } = require('../main/app-update-controller.js');
const { packPayload } = require('../core/app-update/payload.js');
const { stagingPaths } = require('../core/app-update/apply.js');

const winOnly = { skip: process.platform !== 'win32' };
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const q = s => String(s).replace(/'/g, "''");
const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' };
const respJson = obj => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj) });
const respFile = buf => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : 'application/octet-stream') },
  body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })), cancel: async () => {} }; }, cancel: async () => {} } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };

async function setup({ dataDir = tmp('cancel-data-'), spawnImpl, download = true } = {}) {
  const res = tmp('cancel-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  const gzPath = path.join(tmp('cancel-gz-'), 'pkg.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath), inst = crypto.randomBytes(2048);
  const m = { schema: 1, version: '5.6.47', notes: [], runtime: { electron: '41.2.0', native: {} },
    incremental: { file: 'X-5.6.47-update.gz', bytes: gz.length, sha256: sha(gz) }, installer: { file: 'X-Setup-5.6.47.exe', bytes: inst.length, sha256: sha(inst) } };
  let manifestFetches = 0;
  const fetchImpl = async url => { url = String(url); if (url.endsWith('latest.json')) { manifestFetches += 1; return respJson(m); } if (url.endsWith('.gz')) return respFile(gz); return { ok: false, status: 404, headers: { get: () => '' } }; };
  let quits = 0;
  const started = () => fs.writeFileSync(stagingPaths(dataDir).started, 'x');
  const c = createAppUpdateController({ app: { quit() { quits += 1; } }, config: { sources: [SRC], releasePage: '' }, dataDir, currentVersion: '5.6.43', fetchImpl,
    isPackaged: true, resourcesPath: res, env: { AI_HUB_UPDATE_RESOURCES: res }, logger: { warn() {} }, prepareLaunch: () => null, helperStartWaitMs: 3000,
    spawnImpl: spawnImpl || (() => { setTimeout(started, 50); return { unref() {} }; }) });
  if (download) { await c.check({ silent: false }); await c.download(); assert.equal(c.getState().phase, 'ready'); }
  return { c, dataDir, p: stagingPaths(dataDir), quits: () => quits, manifestFetches: () => manifestFetches };
}
// 冒充替换脚本：以「不共享」方式占住 helper.lock（与 apply.js 的 HELPER 一致），seconds 秒后放开。
function holdLock(file, seconds) {
  const flag = file + '.held';
  const c = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[IO.File]::Open('${q(file)}','OpenOrCreate','ReadWrite','None');Set-Content -LiteralPath '${q(flag)}' -Value x;Start-Sleep -Seconds ${seconds};$f.Close()`],
  { windowsHide: true, stdio: 'ignore' });
  return { c, ready: () => until(() => fs.existsSync(flag)), exited: () => new Promise(r => (c.exitCode !== null || c.signalCode ? r() : c.once('exit', r))) };
}

test('退出被取消：回到「已下载好」并说明原因，留下放弃标记让替换脚本结束；再点「立即重启」照常走', async () => {
  const { c, p, quits } = await setup();
  c.apply();
  assert.ok(await until(() => quits() === 1), '看到已开始标记后请求退出');
  assert.equal(c.getState().phase, 'applying');
  const s = c.applyCancelled('窗口还有未保存的内容，已取消退出；请完成保存后再试');
  assert.equal(s.phase, 'ready');
  assert.match(s.applyCancelled.reason, /没有升级.*未保存的内容.*立即重启/);
  assert.ok(fs.existsSync(p.cancel), '留下放弃标记：替换脚本看到就结束，进度小窗随之关闭');
  // 再点一次：放弃标记被清掉，替换脚本能重新开始；提示也清掉。
  c.apply();
  assert.equal(fs.existsSync(p.cancel), false);
  assert.equal(c.getState().phase, 'applying');
  assert.equal(c.getState().applyCancelled, null);
  assert.ok(await until(() => quits() === 2));
  c.dispose();
});

test('不在应用中时 applyCancelled 不动状态（正常关 Hub 被取消不影响更新状态）', async () => {
  const { c, p } = await setup();
  assert.equal(c.applyCancelled('x').phase, 'ready');
  assert.equal(c.getState().applyCancelled, undefined);
  assert.equal(fs.existsSync(p.cancel), false);
  c.dispose();
});

test('正在应用时后台检查不改状态（不再把界面改回「有新版本」盖掉替换进度）', async () => {
  const { c, quits, manifestFetches } = await setup();
  c.apply();
  assert.ok(await until(() => quits() === 1));
  const before = manifestFetches();
  await c.check({ silent: true });
  await c.check({ silent: false });
  assert.equal(c.getState().phase, 'applying');
  assert.equal(manifestFetches(), before);
  c.dispose();
});

test('替换脚本先结束（锁放开）而 Hub 还活着：自动回到「已下载好」；脚本还占着锁时保持「正在应用」', winOnly, async () => {
  const { c, p, quits } = await setup();
  const h = holdLock(p.lock, 7);
  assert.ok(await h.ready(), '冒充的替换脚本占住了锁');
  c.apply();
  assert.ok(await until(() => quits() === 1));
  await wait(4000);
  assert.equal(c.getState().phase, 'applying', '脚本还在：不提前放弃');
  await h.exited();
  assert.ok(await until(() => c.getState().phase === 'ready', 6000), '脚本结束后回到已下载好');
  assert.match(c.getState().applyCancelled.reason, /替换程序已经结束/);
  c.dispose();
});

test('启动自愈：上一轮残留（10 分钟以上没动）的进度、按钮选择、标记在替换脚本不在时清掉；脚本还在或刚写的不动', winOnly, async () => {
  const dataDir = tmp('cancel-stale-');
  const p = stagingPaths(dataDir);
  fs.mkdirSync(p.root, { recursive: true });
  const files = [p.progress, p.decision, p.focus, p.started, p.cancel];
  const put = (ageMs = 11 * 60000) => { const t = new Date(Date.now() - ageMs); for (const f of files) { fs.writeFileSync(f, '{"state":"running"}'); fs.utimesSync(f, t, t); } };
  put();
  const h = holdLock(p.lock, 30);
  assert.ok(await h.ready());
  let { c } = await setup({ dataDir, download: false });
  for (const f of [p.progress, p.decision, p.focus, p.started, p.cancel]) assert.ok(fs.existsSync(f), `另一个窗口的替换脚本还在：不动 ${path.basename(f)}`);
  c.dispose(); h.c.kill(); await h.exited();
  // 刚升级完（几秒前写的进度）：进度小窗还要读它显示「升级完成」后自己关，不能删。
  put(5000);
  ({ c } = await setup({ dataDir, download: false }));
  for (const f of files) assert.ok(fs.existsSync(f), `刚写的 ${path.basename(f)} 留着`);
  c.dispose();
  put();
  ({ c } = await setup({ dataDir, download: false }));
  for (const f of files) assert.equal(fs.existsSync(f), false, `${path.basename(f)} 已清掉`);
  c.dispose();
});

test('界面：退出被取消时重新打开更新窗口并说明；上次自己点的升级没成就重新提醒（含只改末位的小版本）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app-update.js'), 'utf8');
  assert.match(src, /s\.applyCancelled\) body \+= .*data-au-cancelled/);
  assert.match(src, /c\.at !== cancelSeen\) \{ cancelSeen = c\.at; openDialog\(\); \}/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /function restoreWindowAfterFailedShutdown\(reason = ''\) \{[\s\S]{0,400}appUpdateControllerRef\?\.applyCancelled\?\.\(reason\)/);
});

// 用真实 renderer 源码和最小 DOM / IPC 替身，数后台检查查到小版本时自动弹了几次更新窗口（r43 返工，按审查复现）。
function bootRenderer(initial, storage = new Map()) {
  const vm = require('node:vm');
  const file = path.join(__dirname, '..', 'renderer', 'app-update.js');
  const handlers = new Map();
  let prompts = 0;
  class El {
    constructor() { this.open = false; this.dataset = {}; this.style = {}; this.title = ''; this.listeners = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener(k, f) { this.listeners[k] = f; }
    appendChild() {} remove() {} querySelector() { return null; } querySelectorAll() { return []; }
    showModal() { this.open = true; prompts++; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  const dialogs = [];
  const document = { head: new El(), body: new El(), getElementById() { return null; }, createElement(tag) { const e = new El(); if (tag === 'dialog') dialogs.push(e); return e; } };
  const ipcRenderer = { on(k, f) { handlers.set(k, f); }, async invoke(k) { return k === 'app-update:get-state' ? initial : null; } };
  const context = { console, window: {}, document, setTimeout() {}, setInterval() {}, clearTimeout() {},
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    require(k) {
      if (k === '../core/distribution') return { updateConfig: { sources: [] }, productName: 'test' };
      if (k === 'electron') return { ipcRenderer, shell: {} };
      if (k === './net-pass-view') return { boxHtml() { return ''; }, bind() {}, ensureCss() {} };
      throw new Error(k);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { storage, send(st) { handlers.get('app-update:state')(null, st); }, close() { dialogs.at(-1)?.close(); }, prompts: () => prompts };
}
const minorAvailable = version => ({ phase: 'available', current: '5.6.43', latest: { version, notify: false, notes: [] }, plan: { kind: 'incremental' }, sources: [] });
const tick = () => new Promise(r => setImmediate(r));

test('失败补提醒只给没升成的那个版本：之后别的小版本不弹；同一失败版本只补一次', async () => {
  const normal = bootRenderer({ phase: 'idle' });
  await tick();
  normal.send(minorAvailable('5.6.47'));
  assert.equal(normal.prompts(), 0, '没有失败记录：只改末位的小版本不主动弹');

  const failedResult = { ok: false, quiet: false, version: '5.6.47', reason: '窗口被关掉' };
  const a = bootRenderer({ phase: 'idle', lastResult: failedResult });
  await tick();
  a.send(minorAvailable('5.6.47'));
  assert.equal(a.prompts(), 1, '失败过的 5.6.47：后台查到时补提醒一次');
  a.close(); a.send(minorAvailable('5.6.47'));
  assert.equal(a.prompts(), 1, '同版本再次后台检查不重复弹');
  a.send(minorAvailable('5.6.48'));
  assert.equal(a.prompts(), 1, '从没试过的 5.6.48：照普通小版本，不主动弹');
  a.send(minorAvailable('5.6.49'));
  assert.equal(a.prompts(), 1, '5.6.49 同样不弹');

  // 同一版本又失败一次（重开 Hub 带着同样的失败结果）：已经补过，不再补。
  const b = bootRenderer({ phase: 'idle', lastResult: failedResult }, a.storage);
  await tick();
  b.send(minorAvailable('5.6.47'));
  assert.equal(b.prompts(), 0, '同一失败版本只补一次');

  // 换了一个版本失败：这个新失败版本补一次。
  const c = bootRenderer({ phase: 'idle', lastResult: { ...failedResult, version: '5.6.48' } }, a.storage);
  await tick();
  c.send(minorAvailable('5.6.48'));
  assert.equal(c.prompts(), 1, '新的失败版本 5.6.48 补提醒一次');

  // 后台静默替换失败不补提醒。
  const d = bootRenderer({ phase: 'idle', lastResult: { ...failedResult, version: '5.6.50', quiet: true } });
  await tick();
  d.send(minorAvailable('5.6.50'));
  assert.equal(d.prompts(), 0, '静默替换失败不打扰');
});

test('重开 Hub / 重启电脑后：残留的 plan.json、new 目录、helper.lock 文件不拦启动，检查与下载照常；升级半路被打断的当作没升成、重新提醒，只报一次', winOnly, async () => {
  const dataDir = tmp('cancel-reboot-');
  const p = stagingPaths(dataDir);
  fs.mkdirSync(path.join(p.newDir, 'sub'), { recursive: true });
  fs.writeFileSync(p.plan, JSON.stringify({ version: '5.6.47', from: '5.6.43' }));
  fs.writeFileSync(path.join(p.newDir, 'app.asar'), 'half');
  fs.writeFileSync(p.lock, '');
  fs.writeFileSync(p.started, 'x');
  const at = new Date().toISOString();
  fs.writeFileSync(p.progress, JSON.stringify({ state: 'running', version: '5.6.47', from: '5.6.43', step: 1, label: '保存会话并关闭旧窗口', updatedAt: at, startedAt: at, stepStartedAt: at, helperPid: 999999 }));
  const guard = require('../core/app-update/launch-guard.js');
  assert.equal(guard.deferToRunningUpgrade({ dataDir }), false, '替换脚本已不在（锁没人占）：点图标照常启动');
  let { c } = await setup({ dataDir, download: false });
  const lr = c.getState().lastResult;
  assert.ok(lr && lr.ok === false && lr.version === '5.6.47' && lr.interrupted, '当作一次没升成：界面会提示并重新提醒这一版');
  assert.match(lr.reason, /中断/);
  await c.check({ silent: true });
  assert.equal(c.getState().phase, 'available', '后台检查照常查到新版');
  await c.download();
  assert.equal(c.getState().phase, 'ready', '下载照常');
  c.dispose();
  ({ c } = await setup({ dataDir, download: false }));
  assert.equal(c.getState().lastResult, undefined, '同一次中断只报一次');
  c.dispose();
});
