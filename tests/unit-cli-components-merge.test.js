'use strict';
// r41：打组件包的脚本「增量合并」——只重打 pi 时，线上目录里其余组件（claude、codex、dsh、node、git）条目原样保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const catalogLib = require('../core/cli-tools/catalog');
const { parseArgs, loadBase, resolveBase, mergeComponents, assertKept } = require('../scripts/build-cli-components');

const { publicKey: TEST_PUB, privateKey: TEST_KEY } = crypto.generateKeyPairSync('ed25519');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-cli-components.js');

const entry = (id, version, extra = {}) => ({ id, name: id, version, kind: 'tgz', license: 'MIT', preferOfficial: false,
  files: [{ name: `${id}-${version}.tgz`, bytes: 1234, sha256: crypto.createHash('sha256').update(id + version).digest('hex'), url: `${id}/${version}/${id}-${version}.tgz` }],
  install: { versionArgs: ['--version'] }, ...extra });
const online = () => [entry('claude', '2.1.319', { preferOfficial: true }), entry('codex', '0.167.0'), entry('dsh', '0.2.1-rc.2+tui.0.16.1'), entry('node', '22.23.4'), entry('git', '2.56.0+windows.4')];

test('merge: adding pi keeps claude/codex/dsh/node/git byte-identical and orders by catalog IDS', () => {
  const prev = online();
  const before = JSON.stringify(prev);
  const merged = mergeComponents(prev, [entry('pi', '1.5.2')], ['pi']);
  assert.deepEqual(merged.map(c => c.id), ['claude', 'codex', 'dsh', 'node', 'git', 'pi']);
  for (const c of prev) assert.equal(JSON.stringify(merged.find(m => m.id === c.id)), JSON.stringify(c));
  assert.equal(JSON.stringify(prev), before, 'base entries not mutated');
  assert.doesNotThrow(() => assertKept(prev, merged, ['pi']));
});

test('merge: rebuilding one id replaces only that entry', () => {
  const merged = mergeComponents(online(), [entry('node', '22.24.0')], ['node']);
  assert.equal(merged.length, 5);
  assert.equal(merged.find(c => c.id === 'node').version, '22.24.0');
  assert.equal(merged.find(c => c.id === 'git').version, '2.56.0+windows.4');
});

test('assertKept: a dropped or altered component is refused', () => {
  const prev = online();
  assert.throws(() => assertKept(prev, prev.filter(c => c.id !== 'dsh'), ['pi']), /丢了组件 dsh/);
  const changed = JSON.parse(JSON.stringify(prev));
  changed.find(c => c.id === 'codex').files[0].sha256 = 'f'.repeat(64);
  assert.throws(() => assertKept(prev, changed, ['pi']), /组件 codex 的条目变了/);
});

test('loadBase: signed base passes (file and https); tampered or unsigned base is refused', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r41-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signed = catalogLib.sign({ schema: 1, publishedAt: '2026-11-08T05:35:07.794Z', components: online() }, TEST_KEY);
  const file = path.join(dir, 'components.json');
  fs.writeFileSync(file, JSON.stringify(signed));
  const got = await loadBase(file, { key: TEST_PUB });
  assert.deepEqual(got, signed.components);
  const viaUrl = await loadBase('https://example.invalid/hub-update/components/components.json', { key: TEST_PUB, fetchText: async () => JSON.stringify(signed) });
  assert.deepEqual(viaUrl, signed.components);
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.components[1].version = '9.9.9';
  fs.writeFileSync(file, JSON.stringify(tampered));
  await assert.rejects(loadBase(file, { key: TEST_PUB }), /签名不正确/);
  const { signature, ...unsigned } = signed;
  fs.writeFileSync(file, JSON.stringify(unsigned));
  await assert.rejects(loadBase(file, { key: TEST_PUB }), /签名不正确/);
});

test('cli: --only pi with no base catalog stops before building instead of dropping the other components', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r41-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let err;
  try { execFileSync(process.execPath, [SCRIPT, '--only', 'pi', '--out', dir], { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 }); } catch (e) { err = e; }
  assert.ok(err, 'script must fail');
  assert.match(String(err.stderr), /会丢掉其他组件/);
  assert.equal(fs.existsSync(path.join(dir, 'components', 'components.json')), false);
  assert.equal(parseArgs(['--only', 'pi', '--base', 'https://x/components.json']).base, 'https://x/components.json');
  assert.equal(parseArgs(['--only', 'pi', '--fresh']).fresh, true);
});

// ---------- r41 返工：隐式本地底目录验签、--fresh 语义 ----------
const runCli = (args, timeout = 30000) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
};
const tmp = (t, tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), tag)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const writeLocal = (outDir, content) => {
  fs.mkdirSync(path.join(outDir, 'components'), { recursive: true });
  const f = path.join(outDir, 'components', 'components.json');
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
};

test('resolveBase: implicit local catalog is verified like --base (signed ok; unsigned / tampered / broken refused; missing = no base)', async t => {
  const dir = tmp(t, 'r41-implicit-');
  const outRoot = path.join(dir, 'components');
  assert.deepEqual(await resolveBase({}, outRoot, { key: TEST_PUB }), { previous: [], from: null });
  const signed = catalogLib.sign({ schema: 1, publishedAt: '2026-11-08T05:35:07.794Z', components: online() }, TEST_KEY);
  const f = writeLocal(dir, signed);
  const ok = await resolveBase({}, outRoot, { key: TEST_PUB });
  assert.equal(ok.from, f);
  assert.deepEqual(ok.previous, signed.components);
  const { signature, ...unsigned } = signed;
  writeLocal(dir, unsigned);
  await assert.rejects(resolveBase({}, outRoot, { key: TEST_PUB }), /验证不通过.*签名不正确/);
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.components.find(c => c.id === 'node').files[0].url = 'https://evil.invalid/node.tgz';
  writeLocal(dir, tampered);
  await assert.rejects(resolveBase({}, outRoot, { key: TEST_PUB }), /验证不通过.*签名不正确/);
  writeLocal(dir, '{ not json');
  await assert.rejects(resolveBase({}, outRoot, { key: TEST_PUB }), /验证不通过/);
});

test('resolveBase: --fresh ignores any local catalog; --base and --fresh together are refused', async t => {
  const dir = tmp(t, 'r41-fresh-');
  writeLocal(dir, catalogLib.sign({ schema: 1, publishedAt: 'x', components: online() }, TEST_KEY));
  assert.deepEqual(await resolveBase({ fresh: true }, path.join(dir, 'components'), { key: TEST_PUB }), { previous: [], from: null });
  assert.deepEqual(mergeComponents([], [entry('pi', '1.5.2')], ['pi']).map(c => c.id), ['pi']);
  assert.throws(() => parseArgs(['--only', 'pi', '--base', 'https://x/components.json', '--fresh']), /不能同时用/);
});

test('cli: unsigned / tampered / broken local catalog in --out is refused before any network, file untouched, nothing re-signed', t => {
  const keyFile = path.join(tmp(t, 'r41-key-'), 'k.pem');
  fs.writeFileSync(keyFile, TEST_KEY.export({ type: 'pkcs8', format: 'pem' }));
  const evil = online().filter(c => c.id === 'node');
  evil[0].files[0].url = 'https://evil.invalid/node.tgz';
  evil[0].files[0].sha256 = 'e'.repeat(64);
  const cases = { unsigned: { schema: 1, publishedAt: 'x', components: evil },
    tampered: (() => { const c = catalogLib.sign({ schema: 1, publishedAt: 'x', components: online() }, TEST_KEY); c.components[3] = evil[0]; return c; })(),
    broken: '{ "schema": 1, ' };
  for (const [name, content] of Object.entries(cases)) {
    const out = tmp(t, `r41-cli-${name}-`);
    const f = writeLocal(out, content);
    const before = fs.readFileSync(f);
    // --only pi 会先查版本；底目录在那之前就被拒，所以不联网。空 --only 是审查复现用的「不下载不打包」路径，一起覆盖。
    for (const only of ['pi', '']) {
      const r = runCli(['--only', only, '--out', out, '--key', keyFile]);
      assert.notEqual(r.code, 0, `${name}/${only || '空'} must fail`);
      assert.match(r.err, /验证不通过/, `${name}/${only || '空'}: ${r.err}`);
      assert.deepEqual(fs.readFileSync(f), before, `${name}: local catalog must stay byte-identical`);
      assert.equal(fs.existsSync(path.join(out, '.staging')), false);
    }
  }
});

test('cli: --fresh reusing an output dir writes a catalog with only the --only components and keeps old package files on disk', t => {
  const out = tmp(t, 'r41-cli-fresh-');
  const keyFile = path.join(tmp(t, 'r41-key-'), 'k.pem');
  fs.writeFileSync(keyFile, TEST_KEY.export({ type: 'pkcs8', format: 'pem' }));
  const f = writeLocal(out, { schema: 1, publishedAt: 'x', components: online().filter(c => c.id === 'node') });
  const oldPkg = path.join(out, 'components', 'node', '22.23.4', 'node-22.23.4.tgz');
  fs.mkdirSync(path.dirname(oldPkg), { recursive: true });
  fs.writeFileSync(oldPkg, 'old');
  // 空 --only + --fresh：不下载不打包，只验证目录语义（真实 main()，测试钥匙签名）。
  const r = runCli(['--only', '', '--fresh', '--out', out, '--key', keyFile]);
  assert.equal(r.code, 0, r.err);
  const cat = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(cat.components.map(c => c.id), [], 'old node entry must not survive --fresh');
  assert.doesNotThrow(() => catalogLib.validateCatalog(cat, { key: TEST_PUB }));
  assert.equal(fs.readFileSync(oldPkg, 'utf8'), 'old', 'old package files are not deleted');
  const both = runCli(['--only', 'pi', '--base', f, '--fresh', '--out', out]);
  assert.notEqual(both.code, 0);
  assert.match(both.err, /不能同时用/);
});

test('ci: this file is listed in tests/unit-test-files.json so npm test / CI runs it', () => {
  const listed = require('./unit-test-files.json');
  assert.ok(listed.includes('tests/unit-cli-components-merge.test.js'));
});
