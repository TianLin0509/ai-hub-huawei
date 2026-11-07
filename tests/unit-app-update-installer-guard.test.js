'use strict';
// 点「立即安装」：安装包被杀软删除或启动失败时 Hub 不崩溃、不退出、可重试。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const manifestLib = require('../core/app-update/manifest.js');
manifestLib.currentRuntime = () => ({ electron: '41.2.0', native: {} });
const { createAppUpdateController } = require('../main/app-update-controller.js');
const { packPayload } = require('../core/app-update/payload.js');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const SRC = { id: 'a', name: '源A', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' };
const respJson = obj => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(obj) });
const respFile = buf => ({ ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(buf.length) : 'application/octet-stream') },
  body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })), cancel: async () => {} }; }, cancel: async () => {} } });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function setup({ full = false, spawnImpl, helperStartWaitMs = 500 } = {}) {
  const res = tmp('apply-res-');
  fs.writeFileSync(path.join(res, 'app.asar'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'icon.ico'), 'icon');
  const gzPath = path.join(tmp('apply-gz-'), 'pkg.gz'); packPayload(res, gzPath);
  const gz = fs.readFileSync(gzPath), inst = crypto.randomBytes(2048);
  const m = { schema: 1, version: '5.5.14', notes: [], runtime: { electron: full ? '99.0.0' : '41.2.0', native: {} },
    incremental: { file: 'X-5.5.14-update.gz', bytes: gz.length, sha256: sha(gz) }, installer: { file: 'X-Setup-5.5.14.exe', bytes: inst.length, sha256: sha(inst) } };
  const fetchImpl = async url => { url = String(url); if (url.endsWith('latest.json')) return respJson(m); if (url.endsWith('.gz')) return respFile(gz); if (url.endsWith('.exe')) return respFile(inst); return { ok: false, status: 404, headers: { get: () => '' } }; };
  const dataDir = tmp('apply-data-'); let quits = 0;
  const c = createAppUpdateController({ app: { quit() { quits += 1; } }, config: { sources: [SRC], releasePage: '' }, dataDir, currentVersion: '5.5.13', fetchImpl,
    isPackaged: true, resourcesPath: res, env: { AI_HUB_UPDATE_RESOURCES: res }, logger: { warn() {} }, prepareLaunch: () => null, spawnImpl, helperStartWaitMs });
  await c.check({ silent: true, quietAllowed: false }); await c.download();
  assert.equal(c.getState().phase, 'ready');
  return { c, dataDir, quits: () => quits };
}

test('安装包被删后点安装：不崩溃、不退出、给人话', async () => {
  let spawned = 0;
  const { c, dataDir, quits } = await setup({ full: true, spawnImpl: () => { spawned += 1; return { unref() {} }; } });
  fs.rmSync(path.join(dataDir, 'app-update', 'downloads', 'X-Setup-5.5.14.exe'), { force: true });
  c.apply();
  await wait(500);
  assert.equal(spawned, 0);
  assert.equal(quits(), 0);
  assert.equal(c.getState().phase, 'error');
  assert.match(c.getState().error, /安装程序启动不了/);
});

test('安装包启动时异步报错：接住 error 事件，不退出', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  const { c, quits } = await setup({ full: true, spawnImpl: () => { setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return child; } });
  c.apply();
  await wait(600);
  assert.equal(quits(), 0);
  assert.equal(c.getState().phase, 'error');
});

test('安装包正常启动：退出一次', async () => {
  const child = new EventEmitter(); child.unref = () => {};
  const { c, quits } = await setup({ full: true, spawnImpl: () => child });
  c.apply();
  await wait(600);
  assert.equal(quits(), 1);
});
