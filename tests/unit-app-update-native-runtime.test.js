'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { packPayload, sha256, unpackPayload } = require('../core/app-update/payload');
const manifest = require('../core/app-update/manifest');
// Keep real on-disk native package detection; only supply the Electron host
// version while running this controller test under the system Node runner.
const readRuntime = manifest.currentRuntime;
manifest.currentRuntime = options => readRuntime({ ...options, electron: '41.2.0' });
const { createAppUpdateController } = require('../main/app-update-controller');

function fixture(t, nativeChanged) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-native-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base'), next = path.join(root, 'next');
  for (const [dir, version, bytes] of [[base, '1.1.0', 'old native'], [next, nativeChanged ? '1.2.0-beta.13' : '1.1.0', nativeChanged ? 'new native' : 'old native']]) {
    const pkg = path.join(dir, 'app.asar.unpacked/node_modules/node-pty');
    fs.mkdirSync(path.join(pkg, 'prebuilds/win32-x64'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
    for (const name of ['conpty.node', 'conpty_console_list.node']) fs.writeFileSync(path.join(pkg, 'prebuilds/win32-x64', name), bytes);
    fs.mkdirSync(path.join(dir, 'app.asar.unpacked/core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.asar.unpacked/core/worker.mjs'), dir === base ? 'old worker' : 'new worker');
    fs.writeFileSync(path.join(dir, 'app.asar'), crypto.randomBytes(4096));
  }
  const previous = packPayload(base, path.join(root, 'old.gz'));
  const fullFile = path.join(root, 'full.gz'), deltaFile = path.join(root, 'delta.gz');
  const full = packPayload(next, fullFile), delta = packPayload(next, deltaFile, { previous: previous.index });
  const installer = crypto.randomBytes(2048); installer.write('MZ');
  const asset = (file, p) => ({ file, bytes: p.bytes, sha256: p.sha256 });
  const document = { schema: 1, version: '5.6.27', runtime: readRuntime({ resourcesPath: next, electron: '41.2.0' }),
    incremental: asset('full.gz', full), incrementalDelta: { ...asset('delta.gz', delta), requires: delta.requires },
    installer: { file: 'Setup-5.6.27.exe', bytes: installer.length, sha256: sha256(installer) } };
  return { root, base, next, document, full, delta, fullFile, deltaFile, installer };
}
function controller(f, { installer404 = false } = {}) {
  const urls = [], dataDir = path.join(f.root, 'data');
  const sources = ['blocked', 'mirror'].map(id => ({ id, name: id, manifest: `https://${id}.invalid/latest.json`, files: `https://${id}.invalid/` }));
  const c = createAppUpdateController({ app: { quit() { throw Error('download test must never quit/apply'); } },
    config: { sources }, currentVersion: '5.6.26', dataDir, isPackaged: true, resourcesPath: f.base,
    env: { AI_HUB_UPDATE_RESOURCES: f.base }, logger: { warn() {} }, fetchImpl: async url => {
      url = String(url); urls.push(url);
      if (url.endsWith('latest.json')) return Response.json(f.document);
      if (installer404 && url.endsWith('.exe')) return new Response('missing installer', { status: 404 });
      if (url.includes('blocked.invalid')) return new Response('<html>Access Denied</html>' + ' '.repeat(3300), { headers: { 'content-type': 'text/html' } });
      const bytes = url.endsWith('.exe') ? f.installer : fs.readFileSync(url.endsWith('delta.gz') ? f.deltaFile : f.fullFile);
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } });
    } });
  return { c, urls, dataDir };
}

test('native unpacked binaries change: choose full installer before delta, mirror fallback reaches verified ready', async t => {
  const f = fixture(t, true), { c, urls, dataDir } = controller(f);
  assert(!f.delta.files.some(row => row.path.includes('/node_modules/')));
  assert(!f.full.files.some(row => row.path.includes('/node_modules/')));
  await c.check({ quietAllowed: false });
  assert.equal(c.view().plan.kind, 'full');
  assert.match(c.view().plan.reason, /原生依赖/);
  await c.download();
  assert.equal(c.view().phase, 'ready', c.view().error);
  assert.equal(c.view().readySource, 'mirror');
  assert(!urls.some(url => url.endsWith('.gz')), 'never patch native dependencies using delta or complete incremental');
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'app-update/downloads/Setup-5.6.27.exe')), f.installer);
  assert.equal(fs.readFileSync(path.join(f.base, 'app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node'), 'utf8'), 'old native');
});

test('installer absent from both sources: terminal error is reported, no delta/native replacement occurs', async t => {
  const f = fixture(t, true), { c, urls } = controller(f, { installer404: true });
  await c.check({ quietAllowed: false }); await c.download();
  assert.equal(c.view().phase, 'error');
  assert.match(c.view().error, /更新包下载没有完成/);
  assert(!urls.some(url => url.endsWith('.gz')));
  assert(c.view().attempts.every(row => /404/.test(row.reason)));
});

test('ordinary unpacked code changes with unchanged native runtime: delta stages exact new file and leaves installed files intact', async t => {
  const f = fixture(t, false), { c, dataDir } = controller(f);
  await c.check({ quietAllowed: false });
  assert.equal(c.view().plan.variant, 'delta'); await c.download();
  assert.equal(c.view().phase, 'ready', c.view().error);
  assert.equal(fs.readFileSync(path.join(dataDir, 'app-update/new/app.asar.unpacked/core/worker.mjs'), 'utf8'), 'new worker');
  assert.equal(fs.readFileSync(path.join(f.base, 'app.asar.unpacked/core/worker.mjs'), 'utf8'), 'old worker');
  // A malformed payload cannot smuggle native node_modules into a delta.
  const zlib = require('node:zlib'), file = path.join(f.root, 'unsafe.gz'), bytes = Buffer.from('native overwrite');
  const asarBytes = Buffer.from('app');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([Buffer.from(JSON.stringify({ schema: 1, files: [
    { path: 'app.asar', bytes: asarBytes.length, sha256: sha256(asarBytes) },
    { path: 'app.asar.unpacked/node_modules/node-pty/conpty.node', bytes: bytes.length, sha256: sha256(bytes) },
  ] }) + '\n'), asarBytes, bytes])));
  assert.throws(() => unpackPayload(file, path.join(f.root, 'unsafe-stage')), /不允许的文件.*node_modules/);
});
