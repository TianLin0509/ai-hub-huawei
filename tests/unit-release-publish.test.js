'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { publishRelease, parseChecksums, MARKER } = require('../scripts/publish-release-assets');

const TAG = 'v1.2.3', REPO = 'example/release-fixture', SOURCE = 'a'.repeat(40);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const jsonCopy = obj => JSON.parse(JSON.stringify(obj));
function writeBatch(dir, generation = 'original', sourceSha = SOURCE) {
  const names = ['AIHubHuawei-Setup-1.2.3.exe', 'AIHubHuawei-1.2.3-win-x64.zip', 'AIHubHuawei-source-1.2.3.zip',
    'install-release.ps1', 'AIHubHuawei-1.2.3-update.gz', 'AIHubHuawei-1.2.3-update-delta.gz', 'latest.json'];
  for (const name of names) fs.writeFileSync(path.join(dir, name), name + ':' + generation);
  const assets = names.slice(0, 4).map(name => {
    const bytes = fs.readFileSync(path.join(dir, name));
    return { name, bytes: bytes.length, sha256: digest(bytes) };
  });
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify({ version: '1.2.3', sourceSha, assets, generation }) + '\n');
  names.push('release-manifest.json');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), names.map(name => digest(fs.readFileSync(path.join(dir, name))) + '  ' + name).join('\n') + '\n');
  return new Map([...names, 'SHA256SUMS.txt'].map(name => [name, fs.readFileSync(path.join(dir, name))]));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-unit-'));
  t.after(() => { assert.ok(path.basename(root).startsWith('release-publish-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  const dir = path.join(root, 'dist'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(dir);
  const original = writeBatch(dir);
  const snapshot = path.join(cacheRoot, ...REPO.split('/'), TAG);
  const state = { release: null, calls: [], uploads: [], blobs: new Map(), nextId: 10, hook: null, now: 0, sleeps: [] };
  const ok = stdout => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
  const failed = (message = 'network interrupted') => ({ status: 1, stdout: '', stderr: message });
  const addAsset = (name, bytes, extra = {}) => {
    state.blobs.set(name, bytes);
    const asset = { id: state.nextId++, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + digest(bytes), ...extra };
    state.release.assets.push(asset); return asset;
  };
  const run = (args, opts) => {
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.stdio[0], 'ignore');
    assert.ok(opts.timeout > 0 && opts.timeout <= 300_000);
    state.calls.push({ args: [...args], timeout: opts.timeout });
    const overridden = state.hook?.(args, opts, { ok, failed, addAsset });
    if (overridden !== undefined) return overridden;
    if (args[0] === 'api' && args[1] === `repos/${REPO}/releases/tags/${TAG}`) {
      return state.release ? ok(jsonCopy(state.release)) : failed('gh: Not Found (HTTP 404)');
    }
    if (args[0] === 'release' && args[1] === 'create') {
      assert.ok(args.includes('--draft')); assert.ok(args.includes('--prerelease')); assert.ok(args.includes('--verify-tag'));
      state.release = { id: 1, tag_name: TAG, draft: true, prerelease: true, assets: [] };
      return ok('created');
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      const file = args[3], name = path.basename(file);
      assert.equal(path.dirname(file), snapshot, 'uploads must use the verified snapshot');
      assert.equal(args.includes('--clobber'), false);
      assert.equal(state.release.assets.some(asset => asset.name === name), false, 'complete assets are never uploaded twice');
      const bytes = fs.readFileSync(file); state.uploads.push(name); addAsset(name, bytes); return ok('uploaded');
    }
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'DELETE') {
      const id = Number(args[3].split('/').at(-1)), asset = state.release.assets.find(asset => asset.id === id);
      assert.ok(asset && asset.state !== 'uploaded', 'only incomplete assets may be removed');
      state.release.assets = state.release.assets.filter(asset => asset.id !== id); return ok('');
    }
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') {
      assert.equal(state.release.draft, true);
      assert.ok(args.includes('draft=false') && args.includes('prerelease=true') && args.includes('make_latest=false'));
      state.release.draft = false; state.release.prerelease = true; return ok(state.release);
    }
    if (args[0] === 'release' && args[1] === 'download') return ok(state.blobs.get(args[args.indexOf('--pattern') + 1]).toString('utf8'));
    assert.fail('Unexpected mock GitHub command: ' + JSON.stringify(args));
  };
  const options = { dir, cacheRoot, repo: REPO, tag: TAG };
  const deps = { run, now: () => state.now, sleep: async ms => { state.sleeps.push(ms); state.now += ms; }, log() {}, env: {} };
  const publish = extra => publishRelease({ ...options, ...extra }, deps);
  return { root, dir, cacheRoot, original, snapshot, state, options, deps, publish, ok, failed, addAsset };
}

test('publishes each checksum-verified asset individually, then publishes the draft and clears only its own snapshot', async t => {
  const f = fixture(t), other = path.join(f.cacheRoot, ...REPO.split('/'), 'v1.2.2');
  fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, MARKER), 'other snapshot');
  const result = await f.publish();
  assert.equal(result.ok, true); assert.equal(result.uploaded.length, 9);
  assert.equal(f.state.release.draft, false); assert.equal(f.state.release.prerelease, true);
  assert.equal(fs.existsSync(f.snapshot), false); assert.equal(fs.existsSync(other), true);
  for (const [name, bytes] of f.original) assert.deepEqual(f.state.blobs.get(name), bytes);
});

test('one timed-out asset is retried without uploading completed assets again', async t => {
  const f = fixture(t); let tries = 0;
  f.state.hook = args => {
    if (args[0] === 'release' && args[1] === 'upload' && args[3].endsWith('.exe') && ++tries === 1) return { error: { code: 'ETIMEDOUT' }, status: null };
  };
  await f.publish();
  assert.equal(tries, 2); assert.equal(f.state.uploads.length, 9); assert.equal(f.state.sleeps.length, 1);
  assert.equal(f.state.calls.filter(call => call.args[0] === 'release' && call.args[1] === 'upload' && call.args[3].endsWith('.exe')).length, 2);
});

test('exhausted retries leave a draft and a complete verified snapshot', async t => {
  const f = fixture(t); let tries = 0;
  f.state.hook = args => {
    if (args[0] === 'release' && args[1] === 'upload' && args[3].endsWith('win-x64.zip')) { tries++; return f.failed(); }
  };
  await assert.rejects(f.publish(), /draft and verified snapshot retained/);
  assert.equal(tries, 3); assert.equal(f.state.release.draft, true);
  const marker = JSON.parse(fs.readFileSync(path.join(f.snapshot, MARKER), 'utf8'));
  assert.equal(marker.sourceSha, SOURCE); assert.equal(marker.assets.length, 9);
  assert.equal(f.state.calls.some(call => call.args.includes('PATCH')), false);
});

test('rerunning a whole failed job reuses the original batch even when dist was rebuilt', async t => {
  const f = fixture(t);
  f.state.hook = args => {
    if (args[0] === 'release' && args[1] === 'upload' && args[3].endsWith('win-x64.zip')) return f.failed();
  };
  await assert.rejects(f.publish(), /retained/);
  assert.deepEqual(f.state.uploads, ['AIHubHuawei-Setup-1.2.3.exe']);
  writeBatch(f.dir, 'rebuilt with different timestamps');
  f.state.hook = null;
  const result = await f.publish();
  assert.equal(result.skipped.includes('AIHubHuawei-Setup-1.2.3.exe'), true);
  assert.equal(f.state.uploads.length, 9);
  for (const [name, bytes] of f.original) assert.deepEqual(f.state.blobs.get(name), bytes, name + ' must remain from the first batch');
  assert.equal(fs.existsSync(f.snapshot), false);
});

test('a response lost after the server stored an asset is recovered by checking the next attempt', async t => {
  const f = fixture(t); let interrupted = false;
  f.state.hook = (args, opts, { addAsset }) => {
    if (!interrupted && args[0] === 'release' && args[1] === 'upload') {
      interrupted = true; addAsset(path.basename(args[3]), fs.readFileSync(args[3])); return f.failed();
    }
  };
  const result = await f.publish();
  assert.equal(result.skipped.length, 1); assert.equal(f.state.uploads.length, 8);
  assert.equal(f.state.release.draft, false);
});

test('a failed starter asset is removed and replaced, while complete matching assets are skipped', async t => {
  const f = fixture(t);
  f.state.release = { id: 1, tag_name: TAG, draft: true, prerelease: true, assets: [] };
  f.addAsset('AIHubHuawei-Setup-1.2.3.exe', f.original.get('AIHubHuawei-Setup-1.2.3.exe'));
  f.state.release.assets.push({ id: 90, name: 'AIHubHuawei-1.2.3-win-x64.zip', state: 'starter', size: 0 });
  const result = await f.publish();
  assert.equal(result.skipped.length, 1); assert.equal(f.state.uploads.length, 8);
  assert.equal(f.state.calls.filter(call => call.args.includes('DELETE')).length, 1);
});

test('a completed remote asset with a different digest is never deleted or overwritten', async t => {
  const f = fixture(t);
  f.state.release = { id: 1, tag_name: TAG, draft: true, prerelease: true, assets: [] };
  f.addAsset('AIHubHuawei-Setup-1.2.3.exe', Buffer.from('different batch'));
  await assert.rejects(f.publish(), /Existing uploaded asset differs/);
  assert.equal(f.state.calls.some(call => call.args.includes('DELETE') || call.args.includes('PATCH')), false);
  assert.equal(f.state.uploads.length, 0); assert.equal(f.state.release.draft, true);
});

test('a snapshot without its completeness marker is not reused', async t => {
  const f = fixture(t); fs.mkdirSync(f.snapshot, { recursive: true }); fs.writeFileSync(path.join(f.snapshot, 'leftover'), 'partial');
  await assert.rejects(f.publish(), /snapshot is incomplete/);
  assert.equal(f.state.release, null); assert.equal(f.state.uploads.length, 0);
});

test('a snapshot for another commit is rejected before upload', async t => {
  const f = fixture(t); f.state.hook = args => args[0] === 'release' && args[1] === 'upload' ? f.failed() : undefined;
  await assert.rejects(f.publish(), /retained/);
  writeBatch(f.dir, 'another commit', 'b'.repeat(40)); f.state.hook = null;
  await assert.rejects(f.publish(), /different tag or commit/);
  assert.equal(f.state.uploads.length, 0);
});

test('a modified snapshot asset cannot bypass verification on retry', async t => {
  const f = fixture(t); f.state.hook = args => args[0] === 'release' && args[1] === 'upload' ? f.failed() : undefined;
  await assert.rejects(f.publish(), /retained/);
  fs.appendFileSync(path.join(f.snapshot, 'install-release.ps1'), 'changed'); f.state.hook = null;
  await assert.rejects(f.publish(), /checksum mismatch/); assert.equal(f.state.uploads.length, 0);
});

test('a checksum mismatch in dist stops before a draft or snapshot is created', async t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.dir, 'install-release.ps1'), 'changed');
  await assert.rejects(f.publish(), /checksum mismatch/);
  assert.equal(f.state.release, null); assert.equal(fs.existsSync(f.snapshot), false);
});

test('the total time budget bounds each request and retains a failed batch', async t => {
  const f = fixture(t);
  f.state.hook = args => {
    if (args[0] === 'release' && args[1] === 'upload') { f.state.now += 6000; return f.failed(); }
  };
  await assert.rejects(f.publish({ totalTimeoutMs: 5000 }), /retained/);
  assert.ok(f.state.calls.every(call => call.timeout <= 5000));
  assert.equal(f.state.release.draft, true); assert.equal(fs.existsSync(f.snapshot), true);
});

test('an already published complete release is verified from its original metadata after a rebuild', async t => {
  const f = fixture(t); await f.publish();
  f.state.release.prerelease = false;
  const uploads = f.state.uploads.length; f.state.calls = []; writeBatch(f.dir, 'rebuilt after publication');
  const result = await f.publish();
  assert.equal(result.alreadyPublished, true); assert.equal(f.state.release.prerelease, false);
  assert.equal(f.state.uploads.length, uploads); assert.equal(fs.existsSync(f.snapshot), false);
  assert.equal(f.state.calls.filter(call => call.args[0] === 'release' && call.args[1] === 'download').length, 2);
  assert.equal(f.state.calls.some(call => call.args.includes('PATCH')), false);
});

test('a published release with a broken asset is reported without modifying it', async t => {
  const f = fixture(t); await f.publish(); f.state.calls = [];
  f.state.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(f.publish(), /Published asset could not be verified/);
  assert.equal(f.state.calls.some(call => call.args.includes('PATCH') || call.args.includes('DELETE') || call.args[1] === 'upload'), false);
});

test('a failed final publication keeps the batch, and a rerun skips every already-uploaded asset', async t => {
  const f = fixture(t); f.state.hook = args => args.includes('PATCH') ? f.failed() : undefined;
  await assert.rejects(f.publish(), /GitHub request failed/);
  assert.equal(f.state.release.draft, true); assert.equal(fs.existsSync(f.snapshot), true);
  f.state.hook = null; writeBatch(f.dir, 'rebuilt');
  const result = await f.publish(); assert.equal(result.uploaded.length, 0); assert.equal(result.skipped.length, 9);
  assert.equal(f.state.uploads.length, 9); assert.equal(fs.existsSync(f.snapshot), false);
});

test('a cleanup marker mismatch preserves the snapshot without failing a verified published release', async t => {
  const f = fixture(t); f.state.hook = args => args.includes('PATCH') ? f.failed() : undefined;
  await assert.rejects(f.publish(), /GitHub request failed/);
  f.state.hook = null; f.state.release.draft = false;
  const markerFile = path.join(f.snapshot, MARKER), marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.sourceSha = 'b'.repeat(40); fs.writeFileSync(markerFile, JSON.stringify(marker));
  assert.equal((await f.publish()).alreadyPublished, true);
  assert.equal(fs.existsSync(f.snapshot), true);
});

test('promotion by the follow-up service immediately after publishing is accepted without downgrading it', async t => {
  const f = fixture(t);
  f.state.hook = args => {
    if (args.includes('PATCH')) { f.state.release.draft = false; f.state.release.prerelease = false; return f.ok(f.state.release); }
  };
  assert.equal((await f.publish()).ok, true);
  assert.equal(f.state.release.prerelease, false); assert.equal(fs.existsSync(f.snapshot), false);
});

test('unexpected assets in an existing draft are neither published nor silently deleted', async t => {
  const f = fixture(t);
  f.state.release = { id: 1, tag_name: TAG, draft: true, prerelease: true, assets: [] };
  f.addAsset('unexpected.txt', Buffer.from('outside the release batch'));
  await assert.rejects(f.publish(), /outside the verified batch/);
  assert.equal(f.state.calls.some(call => call.args.includes('DELETE') || call.args.includes('PATCH')), false);
});

test('an uncertain draft creation response resumes the draft created by that request', async t => {
  const f = fixture(t);
  f.state.hook = args => {
    if (args[0] === 'release' && args[1] === 'create') {
      f.state.release = { id: 1, tag_name: TAG, draft: true, prerelease: true, assets: [] }; return f.failed();
    }
  };
  assert.equal((await f.publish()).ok, true); assert.equal(f.state.uploads.length, 9);
});

test('authentication failures are not interpreted as a missing release', async t => {
  const f = fixture(t); f.state.hook = () => f.failed('gh: unauthorized (HTTP 401)');
  await assert.rejects(f.publish(), /GitHub request failed/);
  assert.equal(f.state.calls.length, 1); assert.equal(fs.existsSync(f.snapshot), false);
});

test('the CI commit must match the release manifest', async t => {
  const f = fixture(t); f.deps.env.GITHUB_SHA = 'b'.repeat(40);
  await assert.rejects(f.publish(), /does not match the CI commit/); assert.equal(f.state.calls.length, 0);
});

test('the shared asset cache environment overrides a runner-specific tool cache', async t => {
  const f = fixture(t);
  f.deps.env.AI_HUB_RELEASE_ASSET_CACHE = f.cacheRoot;
  f.deps.env.RUNNER_TOOL_CACHE = path.join(f.root, 'other-runner-tools');
  const result = await publishRelease({ ...f.options, cacheRoot: undefined }, f.deps);
  assert.equal(result.ok, true); assert.equal(f.state.uploads.length, 9);
  assert.equal(fs.existsSync(f.deps.env.RUNNER_TOOL_CACHE), false);
});

test('repository identifiers cannot escape the dedicated snapshot cache', async t => {
  const f = fixture(t);
  for (const repo of ['../outside', 'example/..']) await assert.rejects(f.publish({ repo }), /GH_REPO must be owner\/repository/);
  assert.equal(f.state.calls.length, 0); assert.equal(fs.existsSync(f.cacheRoot), false);
});

test('checksum entries cannot escape the asset directory or introduce duplicate assets', () => {
  assert.throws(() => parseChecksums('a'.repeat(64) + '  ../outside.zip', TAG), /Invalid release checksum/);
  assert.throws(() => parseChecksums('a'.repeat(64) + '  cache:stream', TAG), /Invalid release checksum/);
  const line = 'a'.repeat(64) + '  duplicate.zip\n';
  assert.throws(() => parseChecksums(line + line, TAG), /Duplicate/);
});

