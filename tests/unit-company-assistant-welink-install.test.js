'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { createWelinkInstaller, addUserPath, normalizeRegistry, readPackage } = require('../core/company-assistant/welink-install');
const { connectionState } = require('../renderer/company-assistant-connection');

const REG = 'https://repo.example.test/npm/';
function entry(name, body, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const pack = files => zlib.gzipSync(Buffer.concat([...files.map(f => entry(...f)), Buffer.alloc(1024)]));
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 7)]);
const good = () => pack([['package/package.json', Buffer.from(JSON.stringify({ name: '@welink/welink-cli', version: '1.0.20' }))], ['package/scripts/install.js', Buffer.from('x')], ['package/welink-cli.exe', EXE]]);
const res = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer });
function setup(tgz = good(), over = {}, metaOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welink-install-'));
  const meta = { 'dist-tags': { latest: '1.0.20' }, versions: { '1.0.20': { dist: { tarball: REG + '@welink/welink-cli/-/welink-cli-1.0.20.tgz', integrity: 'sha512-' + createHash('sha512').update(tgz).digest('base64'), ...metaOver } } } };
  const calls = [], configured = [];
  const installer = createWelinkInstaller({ dir, registry: REG, verify: async () => {}, updatePath: async () => ({ added: true }), configure: exe => configured.push(exe),
    fetchImpl: async url => { calls.push(url); return url.endsWith('.tgz') ? res(tgz) : res(JSON.stringify(meta)); }, ...over });
  return { dir, installer, calls, configured };
}
const clean = (t, ...items) => t.after(() => items.forEach(s => fs.rmSync(s.dir, { recursive: true, force: true })));

test('installs only the verified exe and registers its path', async t => {
  const s = setup(); clean(t, s);
  const r = await s.installer.install();
  assert.equal(r.phase, 'done');
  const exe = path.join(s.dir, '1.0.20', 'welink-cli.exe');
  assert.deepEqual(s.configured, [exe]); assert.deepEqual(fs.readFileSync(exe), EXE);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, '1.0.20')), ['welink-cli.exe']);
  assert.deepEqual(fs.readdirSync(s.dir), ['1.0.20'], 'temporary job directory is removed');
});
test('a wrong checksum stops before anything is registered', async t => {
  const s = setup(good(), {}, { integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') }); clean(t, s);
  const r = await s.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(r.code, 'WELINK_INSTALL_HASH'); assert.deepEqual(s.configured, []);
  assert.deepEqual(fs.readdirSync(s.dir), []);
});
test('a tarball on another host is refused', async t => {
  const s = setup(good(), {}, { tarball: 'https://other.example.test/a.tgz' }); clean(t, s);
  const r = await s.installer.install();
  assert.equal(r.code, 'WELINK_INSTALL_META'); assert.equal(s.calls.length, 1);
});
test('a program that cannot run is not registered', async t => {
  const s = setup(good(), { verify: async () => { throw new Error('blocked'); } }); clean(t, s);
  const r = await s.installer.install();
  assert.equal(r.code, 'WELINK_INSTALL_RUN'); assert.deepEqual(s.configured, []);
});
test('auth and network failures read as plain next steps', async t => {
  const a = setup(good(), { fetchImpl: async () => res('', 403) }), b = setup(good(), { fetchImpl: async () => { throw new TypeError('fetch failed'); } }); clean(t, a, b);
  assert.match((await a.installer.install()).error, /要求登录/); assert.match((await b.installer.install()).error, /公司网络/);
});
test('a PATH failure does not fail the install', async t => {
  const s = setup(good(), { updatePath: async () => { throw new Error('denied'); } }); clean(t, s);
  assert.equal((await s.installer.install()).phase, 'done');
});
test('package checks reject foreign or non-Windows contents', () => {
  assert.throws(() => readPackage(pack([['package/package.json', Buffer.from('{"name":"other","version":"1"}')], ['package/welink-cli.exe', EXE]])), /不是 welink-cli/);
  const json = Buffer.from('{"name":"@welink/welink-cli","version":"1"}');
  assert.throws(() => readPackage(pack([['package/package.json', json], ['package/welink-cli.exe', Buffer.from('ELF')]])), /没有 Windows/);
  assert.throws(() => readPackage(pack([['package/package.json', json], ['other/deep/welink-cli.exe', EXE]])), /没有 Windows/);
});
test('without a source one-click stays hidden; http sources are rejected', () => {
  assert.equal(createWelinkInstaller({ dir: 'x', registry: '', readNpmrc: () => '' }).available(), false);
  assert.equal(normalizeRegistry('http://a.test/'), '');
  assert.equal(normalizeRegistry('https://a.test/npm'), 'https://a.test/npm/');
});
test('user PATH keeps unexpanded entries and is not duplicated', async () => {
  const writes = [], env = { Path: 'C:\\a' };
  const run = async (file, args) => { if (args[0] === 'query') return '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n'; writes.push(args); return ''; };
  assert.deepEqual(await addUserPath('D:\\t', { run, env }), { added: true });
  assert.equal(writes[0][writes[0].indexOf('/d') + 1], '%USERPROFILE%\\bin;C:\\x;D:\\t');
  assert.equal(writes[0][writes[0].indexOf('/t') + 1], 'REG_EXPAND_SZ');
  assert.equal(env.Path, 'C:\\a;D:\\t');
  assert.equal((await addUserPath('c:\\X\\', { run, env })).reason, 'present');
  assert.equal(writes.length, 1);
});
test('connection card offers one-click only when available', () => {
  assert.equal(connectionState({ cliFound: false, cliInstallAvailable: true, cliSearch: { state: 'notfound' } }).action, 'install-cli');
  assert.equal(connectionState({ cliFound: false, cliInstallAvailable: false, cliSearch: { state: 'notfound' } }).action, 'find-cli');
  assert.equal(connectionState({ cliFound: false, cliInstallAvailable: true, cliInstall: { phase: 'downloading', message: 'm' } }).kind, 'searching');
  const failed = connectionState({ cliFound: false, cliInstallAvailable: true, cliInstall: { phase: 'error', error: '连不上' } });
  assert.equal(failed.label, '重试安装'); assert.match(failed.detail, /连不上/);
});
