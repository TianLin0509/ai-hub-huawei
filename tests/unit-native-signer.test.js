'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = () => import('../core/company-proxy/native-signer.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-native-signer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeagentDir = path.join(root, 'cli'), cacheDir = path.join(root, 'cache'), tempDir = path.join(root, 'tmp');
  for (const dir of [path.join(codeagentDir, 'bin'), cacheDir, tempDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(codeagentDir, 'bin/codeagentcli.exe'), 'test-only-placeholder');
  fs.writeFileSync(path.join(cacheDir, 'codeagent-version-stamp'), '9.1.2\n1234567\n');
  const runtimeDir = path.join(tempDir, 'signer-x64-win32-fixture');
  fs.mkdirSync(runtimeDir);
  for (const name of ['libsnap_engine.dll', 'koffi.node']) fs.writeFileSync(path.join(runtimeDir, name), 'not-loaded');
  return { root, codeagentDir, cacheDir, tempDir, version: '9.1.2', appId: 'com.example.client' };
}
function library({ createRc = 0, signRc = 0, output = 'a'.repeat(64), terminate = true } = {}) {
  const calls = { declarations: [], config: null, request: null, unloaded: 0, output: null };
  return { calls, loadLibrary: () => ({
    func(declaration) {
      calls.declarations.push(declaration);
      if (declaration.includes('_create')) return text => { calls.config = JSON.parse(text); return createRc; };
      return (text, buffer) => {
        calls.request = JSON.parse(text); calls.output = buffer;
        buffer.write(output, 'latin1'); if (!terminate) buffer[64] = 65; return signRc;
      };
    },
    unload() { calls.unloaded++; },
  }) };
}

test('native ABI, kernel and request fields agree; no archive or process spawn is needed', async t => {
  const { createNativeSigner } = await load(), f = fixture(t), lib = library();
  const signer = createNativeSigner({ ...f, ...lib });
  const a = signer.init(), b = signer.init(); assert.equal(a, b); await a;
  assert.equal(signer.isAvailable(), true);
  assert.deepEqual(lib.calls.declarations, ['int snapengine_signer_create(const char *config)', 'int snapengine_signer_sign_request(const char *request, void *output)']);
  assert.equal(lib.calls.config.kernel_version, signer.kernelVersion());
  assert.equal(signer.kernelVersion(), '9.1.2-win32-x64-1234567');
  assert.equal(lib.calls.config.telemetry_base_url, '');
  const signed = await signer.signHash3('fixture-token', 'fixture-model');
  assert.equal(signed.hash3, 'a'.repeat(64));
  assert.equal(lib.calls.request.timestamp, signed.timestamp);
  assert.equal(lib.calls.request.trace_id, signed.traceId);
  assert.equal(lib.calls.request.span_id, signed.spanId);
  assert.equal(lib.calls.request.auth_token, 'fixture-token');
  assert.equal(lib.calls.request.model_id, 'fixture-model');
  assert.match(signed.spanId, /^[a-f0-9]{16}$/); assert.match(signed.traceId, /^[a-f0-9]{32}$/);
  assert.ok(lib.calls.output.every(v => v === 0));
  signer.cleanup(); signer.cleanup(); assert.equal(lib.calls.unloaded, 1);
  await assert.rejects(signer.signHash3('fixture-token'), { code: 'SIGNER_UNAVAILABLE' });
});

for (const stamp of ['9.1.1\n123\n', '9.1.2\nNaN\n', '9.1.2\n123\nextra', '']) {
  test('unverified stamp is rejected before loading native code: ' + JSON.stringify(stamp), async t => {
    const { createNativeSigner } = await load(), f = fixture(t);
    fs.writeFileSync(path.join(f.cacheDir, 'codeagent-version-stamp'), stamp);
    await assert.rejects(createNativeSigner({ ...f, loadLibrary: () => assert.fail('must not load') }).init(), { code: 'SIGNER_STAMP_INVALID' });
  });
}
for (const options of [{ signRc: 1 }, { output: 'not-a-hash' }, { output: '\xe1'.repeat(64) }, { terminate: false }]) {
  test('native sign errors never return a partial hash: ' + JSON.stringify(options), async t => {
    const { createNativeSigner } = await load(), f = fixture(t), lib = library(options);
    const signer = createNativeSigner({ ...f, ...lib }); await signer.init();
    await assert.rejects(signer.signHash3('fixture-token'), /SIGNER_NATIVE_/);
    assert.ok(lib.calls.output.every(v => v === 0)); signer.cleanup();
  });
}
test('create failure unloads the library and does not expose native error contents', async t => {
  const { createNativeSigner } = await load(), f = fixture(t), lib = library({ createRc: 7 });
  const signer = createNativeSigner({ ...f, ...lib });
  await assert.rejects(signer.init(), { code: 'SIGNER_NATIVE_CREATE_FAILED' });
  assert.equal(lib.calls.unloaded, 1); assert.equal(signer.isAvailable(), false);
  await assert.rejects(createNativeSigner({ ...f, loadLibrary: () => { throw Error('private-path-or-token'); } }).init(), { message: 'SIGNER_NATIVE_LOAD_FAILED' });
});
test('runtime retention copies only the DLL and FFI module and reuses a complete pair', async t => {
  const { findNativeRuntime, retainNativeRuntime } = await load(), f = fixture(t);
  const src = path.join(f.tempDir, 'signer-x64-win32-fixture');
  fs.writeFileSync(path.join(src, 'private-log.txt'), 'must-not-copy');
  const runtimeDir = path.join(f.root, 'saved/runtime');
  await retainNativeRuntime(f.tempDir, runtimeDir);
  await retainNativeRuntime(f.tempDir, runtimeDir);
  assert.deepEqual(fs.readdirSync(runtimeDir).sort(), ['koffi.node', 'libsnap_engine.dll']);
  assert.equal((await findNativeRuntime({ ...f, runtimeDir })).dll, path.join(runtimeDir, 'libsnap_engine.dll'));
  fs.unlinkSync(path.join(runtimeDir, 'koffi.node'));
  assert.equal(path.dirname((await findNativeRuntime({ ...f, runtimeDir })).dll), src);
  fs.writeFileSync(path.join(runtimeDir, 'libsnap_engine.dll'), 'old-incomplete-pair');
  await retainNativeRuntime(f.tempDir, runtimeDir);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'libsnap_engine.dll'), 'utf8'), 'not-loaded');
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'koffi.node'), 'utf8'), 'not-loaded');
  const backups = fs.readdirSync(path.dirname(runtimeDir)).filter(name => name.startsWith('runtime.incomplete-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(runtimeDir), backups[0], 'libsnap_engine.dll'), 'utf8'), 'old-incomplete-pair');
});

test('runtime repair rejects unrelated contents and directory links without moving them', async t => {
  const { retainNativeRuntime } = await load(), f = fixture(t);
  const runtimeDir = path.join(f.root, 'unrelated'); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'keep.txt'), 'untouched');
  await assert.rejects(retainNativeRuntime(f.tempDir, runtimeDir), { code: 'SIGNER_NATIVE_CACHE_INVALID' });
  assert.deepEqual(fs.readdirSync(runtimeDir), ['keep.txt']);
  const link = path.join(f.root, 'linked'); fs.symlinkSync(runtimeDir, link, 'junction');
  await assert.rejects(retainNativeRuntime(f.tempDir, link), { code: 'SIGNER_NATIVE_CACHE_INVALID' });
  fs.unlinkSync(link);
});

test('retention uses the exact CLI-loaded installation cache, never the newest unrelated pair', async t => {
  const { retainNativeRuntime } = await load(), f = fixture(t);
  const base = path.join(f.codeagentDir, 'temp', 'codeagent');
  const selected = path.join(base, 'signer-x64-win32-loaded'), other = path.join(base, 'signer-x64-win32-newer');
  for (const dir of [selected, other]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['libsnap_engine.dll', 'koffi.node']) fs.writeFileSync(path.join(dir, name), dir === selected ? 'live-pair' : 'wrong-pair');
  }
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(other, 'libsnap_engine.dll'), future, future);
  const saved = path.join(f.root, 'saved'), files = { dll: path.join(selected, 'libsnap_engine.dll'), ffi: path.join(selected, 'koffi.node') };
  // No fresh extraction: only a pair explicitly observed in our live CLI is accepted.
  await retainNativeRuntime('', saved, { codeagentDir: f.codeagentDir, loadRuntime: async () => files });
  assert.equal(fs.readFileSync(path.join(saved, 'libsnap_engine.dll'), 'utf8'), 'live-pair');
  assert.equal(fs.readFileSync(path.join(saved, 'koffi.node'), 'utf8'), 'live-pair');
  const missing = path.join(f.root, 'not-created');
  await assert.rejects(retainNativeRuntime('', missing, { codeagentDir: f.codeagentDir }), { code: 'SIGNER_NATIVE_FILES_MISSING' });
  await assert.rejects(retainNativeRuntime('', missing, { codeagentDir: f.codeagentDir,
    loadRuntime: async () => ({ ...files, ffi: path.join(other, 'koffi.node') }) }), { code: 'SIGNER_NATIVE_FILES_MISSING' });
  const ambient = path.join(f.tempDir, 'signer-x64-win32-fixture');
  await assert.rejects(retainNativeRuntime('', missing, { codeagentDir: f.codeagentDir,
    loadRuntime: async () => ({ dll: path.join(ambient, 'libsnap_engine.dll'), ffi: path.join(ambient, 'koffi.node') }) }), { code: 'SIGNER_NATIVE_FILES_MISSING' });
  assert.equal(fs.existsSync(missing), false);
});

test('CLI-loaded runtime rejects a junction in the installation cache ancestry', async t => {
  const { retainNativeRuntime } = await load(), f = fixture(t);
  const actual = path.join(f.root, 'external'), linked = path.join(f.codeagentDir, 'temp');
  const dir = path.join(actual, 'codeagent', 'signer-x64-win32-linked');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['libsnap_engine.dll', 'koffi.node']) fs.writeFileSync(path.join(dir, name), 'external');
  fs.symlinkSync(actual, linked, 'junction');
  try {
    const candidate = path.join(linked, 'codeagent', 'signer-x64-win32-linked');
    await assert.rejects(retainNativeRuntime('', path.join(f.root, 'saved'), { codeagentDir: f.codeagentDir,
      loadRuntime: async () => ({ dll: path.join(candidate, 'libsnap_engine.dll'), ffi: path.join(candidate, 'koffi.node') }) }), { code: 'SIGNER_NATIVE_FILES_MISSING' });
  } finally { fs.unlinkSync(linked); }
});

test('production-style native signer does not fall back to ambient TEMP after cache loss', async t => {
  const { createNativeSigner } = await load(), f = fixture(t);
  await assert.rejects(createNativeSigner({ ...f, tempDir: '', runtimeDir: path.join(f.root, 'lost'),
    loadLibrary: () => assert.fail('must not load ambient runtime') }).init(), { code: 'SIGNER_NATIVE_FILES_MISSING' });
});
test('symlink runtime directories and missing runtime pairs are not loaded', async t => {
  const { findNativeRuntime } = await load(), f = fixture(t);
  const real = path.join(f.tempDir, 'signer-x64-win32-fixture');
  fs.renameSync(real, path.join(f.root, 'real'));
  fs.symlinkSync(path.join(f.root, 'real'), real, 'junction');
  assert.equal(await findNativeRuntime(f), null);
  fs.unlinkSync(real);
});

test('invalid version and non-absolute paths fail before native loading or probing', async t => {
  const { createNativeSigner } = await load(), f = fixture(t);
  for (const patch of [{ version: '../outside' }, { cacheDir: 'relative' }, { codeagentDir: undefined }]) {
    await assert.rejects(createNativeSigner({ ...f, ...patch, loadLibrary: () => assert.fail('must not load') }).init(), { code: 'SIGNER_CONFIGURATION_INVALID' });
  }
  const { loadSigner } = await import('../core/company-proxy/upstream-profile.mjs');
  await assert.rejects(loadSigner({ signerMode: 'native', codeagentVersion: '../outside' }, {
    workDir: f.root, stampProbe: () => assert.fail('must not probe'),
  }), { code: 'SIGNER_VERSION' });
});

test('finds the runtime in the real layout: <TEMP>/codeagent/signer-x64-win32-*', async t => {
  const { findNativeRuntime, retainNativeRuntime } = await load(), f = fixture(t);
  const probeTemp = path.join(f.root, 'probe-temp'), dir = path.join(probeTemp, 'codeagent', 'signer-x64-win32-b07ce00-1a1ae85c220');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['libsnap_engine.dll', 'koffi.node']) fs.writeFileSync(path.join(dir, name), 'real-layout');
  assert.equal((await findNativeRuntime({ tempDir: probeTemp })).dll, path.join(dir, 'libsnap_engine.dll'));
  const saved = path.join(f.root, 'saved-real');
  await retainNativeRuntime(probeTemp, saved);
  assert.equal(fs.readFileSync(path.join(saved, 'koffi.node'), 'utf8'), 'real-layout');
});
