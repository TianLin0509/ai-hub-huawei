'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { createAsarDelta, applyAsarDelta } = require('../core/app-update/asar-delta');
const { packPayload, unpackPayload, sha256, verifyLocalFiles, ASAR_CAPABILITY } = require('../core/app-update/payload');
const { prepareDelta } = require('../scripts/prepare-asar-delta');
const manifestLib = require('../core/app-update/manifest');
const runtime = { electron: '41.2.0', native: {} };
manifestLib.currentRuntime = () => runtime;
const { createAppUpdateController } = require('../main/app-update-controller');

function asar(files) {
  let offset = 0; const rows = {}, data = [];
  for (const [name, buf] of Object.entries(files)) { rows[name] = { size: buf.length, offset: String(offset) }; offset += buf.length; data.push(buf); }
  rows.unpacked = { size: 123, unpacked: true }; rows.link = { link: 'keep' };
  const json = Buffer.from(JSON.stringify({ files: rows })), header = Buffer.alloc(8 + Math.ceil((json.length + 1) / 4) * 4);
  header.writeUInt32LE(header.length - 4); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
  const size = Buffer.alloc(8); size.writeUInt32LE(4); size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, ...data]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-delta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keep = crypto.randomBytes(100000), old = asar({ keep, removed: Buffer.from('old'), changed: Buffer.from('before') });
  // File order, header, offsets and deletions all change; copy ranges must still reproduce exact bytes.
  const next = asar({ added: crypto.randomBytes(5000), changed: Buffer.from('after'), keep, empty: Buffer.alloc(0) });
  const base = path.join(root, 'base'), target = path.join(root, 'target');
  for (const [dir, buf] of [[base, old], [target, next]]) {
    fs.mkdirSync(path.dirname(path.join(dir, ASAR_CAPABILITY)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.asar'), buf);
    fs.copyFileSync(path.join(__dirname, '../core/app-update/asar-delta-capability.json'), path.join(dir, ASAR_CAPABILITY));
  }
  const oldFile = path.join(root, 'old.gz'), fullFile = path.join(root, 'full.gz'), deltaFile = path.join(root, 'delta.gz');
  const previous = packPayload(base, oldFile), full = packPayload(target, fullFile);
  const delta = packPayload(target, deltaFile, { previous: previous.index, baseAsar: old, baseVersion: '5.6.21' });
  const asset = (file, packed) => ({ file, bytes: packed.bytes, sha256: packed.sha256 });
  const manifest = { schema: 1, version: '5.6.22', runtime, incremental: asset('full.gz', full),
    incrementalDelta: { ...asset('delta.gz', delta), schema: 3, baseVersion: '5.6.21', requires: delta.requires,
      resultAsar: { bytes: next.length, sha256: sha256(next) } }, installer: { file: 'setup.exe', bytes: 5000, sha256: 'a'.repeat(64) } };
  return { root, base, target, old, next, previous, delta, full, oldFile, fullFile, deltaFile, manifest };
}

test('ASAR copies unchanged files and preserves exact target header, order, additions and deletions', t => {
  const f = fixture(t), patch = createAsarDelta(f.old, f.next);
  assert.deepEqual(applyAsarDelta(f.old, patch), f.next);
  assert.ok(f.delta.bytes < f.full.bytes / 5);
  assert.throws(() => applyAsarDelta(Buffer.from('bad base'), patch), /base checksum/);
  const corrupt = Buffer.from(patch); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => applyAsarDelta(f.old, corrupt), /checksum/);
  const nl = patch.indexOf(10), header = JSON.parse(patch.subarray(0, nl));
  header.parts[0].offset = f.old.length + 1;
  assert.throws(() => applyAsarDelta(f.old, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), patch.subarray(nl + 1)])), /source range/);
});

test('release generator verifies local and downloaded baseline, then builds schema 3', async t => {
  const f = fixture(t), document = { incremental: { bytes: f.previous.bytes, sha256: f.previous.sha256 } };
  const previous = { version: '5.6.21', index: f.previous.index, document, packageUrl: 'https://example.invalid/old.gz' };
  const file = path.join(f.root, 'prepared.gz');
  const local = await prepareDelta(f.target, file, { previous, localPackage: f.oldFile });
  assert.equal(local.schema, 3); assert.equal(local.sha256, f.delta.sha256);
  const remote = await prepareDelta(f.target, file, { previous, fetchImpl: async () => new Response(fs.readFileSync(f.oldFile)) });
  assert.equal(remote.schema, 3); assert.equal(remote.sha256, f.delta.sha256);
  document.incremental.sha256 = '0'.repeat(64);
  const fallback = await prepareDelta(f.target, file, { previous, localPackage: f.oldFile, log() {} });
  assert.equal(fallback.schema, 2);
  const dest = path.join(f.root, 'legacy-stage');
  unpackPayload(file, dest, { resourcesDir: f.base });
  assert.deepEqual(fs.readFileSync(path.join(dest, 'app.asar')), f.next, 'schema 2 remains byte-exact');
});

test('payload reconstruction verifies baseline version and manifest target SHA before staging', t => {
  const f = fixture(t), dest = path.join(f.root, 'stage');
  const opts = { resourcesDir: f.base, from: '5.6.21', expectedAsar: f.manifest.incrementalDelta.resultAsar };
  const files = unpackPayload(f.deltaFile, dest, opts);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'app.asar')), f.next);
  assert.equal(files.find(file => file.path === 'app.asar').sha256, sha256(f.next));
  assert.throws(() => unpackPayload(f.deltaFile, dest, { ...opts, from: '5.6.20' }), /基线版本/);
  assert.throws(() => unpackPayload(f.deltaFile, dest, { ...opts, expectedAsar: { bytes: f.next.length, sha256: 'b'.repeat(64) } }), /发布清单/);
  const oldClientResources = path.join(f.root, 'legacy'); fs.mkdirSync(oldClientResources);
  fs.writeFileSync(path.join(oldClientResources, 'app.asar'), f.old);
  assert.equal(verifyLocalFiles(f.delta.requires, oldClientResources).ok, false, 'legacy clients without the capability marker choose complete');
  assert.equal(manifestLib.validateManifest(f.manifest).incrementalDelta.schema, 3);
});

for (const scenario of ['delta', 'cross-version', 'missing-capability', 'manifest-target-mismatch', 'corrupt-download', 'base-changed-during-download', 'corrupt-literal', 'delta-404']) {
  test(`controller ${scenario}: reaches ready with verified target and keeps installed base intact`, async t => {
    const f = fixture(t), urls = [];
    if (scenario === 'missing-capability') fs.unlinkSync(path.join(f.base, ASAR_CAPABILITY));
    if (scenario === 'manifest-target-mismatch') f.manifest.incrementalDelta.resultAsar.sha256 = 'b'.repeat(64);
    if (scenario === 'corrupt-literal') {
      const body = zlib.gunzipSync(fs.readFileSync(f.deltaFile)); body[body.length - 1] ^= 1;
      const gz = zlib.gzipSync(body); fs.writeFileSync(f.deltaFile, gz);
      f.manifest.incrementalDelta.bytes = gz.length; f.manifest.incrementalDelta.sha256 = sha256(gz);
    }
    const c = createAppUpdateController({ app: { quit() {} }, config: { sources: [{ id: 'local', name: 'local', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/' }] },
      dataDir: path.join(f.root, 'data'), currentVersion: scenario === 'cross-version' ? '5.6.20' : '5.6.21', isPackaged: false,
      env: { AI_HUB_UPDATE_RESOURCES: f.base, AI_HUB_UPDATE_FORCE_APPLY: '1' }, logger: { warn() {} },
      fetchImpl: async url => {
        urls.push(String(url));
        if (String(url).endsWith('latest.json')) return Response.json(f.manifest);
        const delta = String(url).endsWith('delta.gz');
        if (delta && scenario === 'delta-404') return new Response('not found', { status: 404 });
        if (delta && scenario === 'base-changed-during-download') { const buf = Buffer.from(f.old); buf[buf.length - 1] ^= 1; fs.writeFileSync(path.join(f.base, 'app.asar'), buf); }
        const buf = fs.readFileSync(delta ? f.deltaFile : f.fullFile);
        if (delta && scenario === 'corrupt-download') buf[buf.length - 1] ^= 1;
        return new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) } });
      } });
    await c.check({ quietAllowed: false });
    const skipDelta = ['cross-version', 'missing-capability'].includes(scenario);
    assert.equal(c.view().plan.variant, skipDelta ? 'complete' : 'delta');
    await c.download();
    assert.equal(c.view().phase, 'ready', c.view().error);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'data/app-update/new/app.asar')), f.next);
    assert.equal(urls.some(url => url.endsWith('delta.gz')), !skipDelta);
    assert.equal(urls.some(url => url.endsWith('full.gz')), scenario !== 'delta');
    assert.equal(c.view().plan.variant, scenario === 'delta' ? 'delta' : 'complete');
    if (scenario !== 'base-changed-during-download') assert.deepEqual(fs.readFileSync(path.join(f.base, 'app.asar')), f.old);
  });
}
