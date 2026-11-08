'use strict';
// CLI 一键安装（core/cli-tools）：组件目录校验与签名、tgz 解压、下载 + 校验 + 原子安装（本机 http 服务当下载源）、
// 检测能看到 Hub 装的工具、会话 PATH 注入、启动中心弹窗的进度文字。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const catalogLib = require('../core/cli-tools/catalog');
const tar = require('../core/cli-tools/tar');
const registry = require('../core/cli-tools/registry');
const { createCliInstaller } = require('../core/cli-tools/installer');
const view = require('../renderer/cli-install-view');

const { publicKey: TEST_PUB, privateKey: TEST_KEY } = crypto.generateKeyPairSync('ed25519');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function tempDir(t, prefix = 'cli-tools-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function tgz(t, entries) {
  const file = path.join(tempDir(t, 'cli-tgz-'), 'p.tgz');
  await tar.packTgz(entries, file);
  return fs.readFileSync(file);
}
function component(id, version, buf, extra = {}) {
  const name = `${id}-${version}.tgz`;
  return { id, name: id, version, kind: 'tgz', license: 'test',
    files: [{ name, bytes: buf.length, sha256: sha256(buf), url: `${id}/${version}/${name}`, ...(extra.official ? { official: extra.official } : {}) }],
    install: extra.install || {}, ...(extra.preferOfficial ? { preferOfficial: true } : {}) };
}
const signed = components => catalogLib.sign({ schema: 1, publishedAt: '2026-11-07T00:00:00Z', components }, TEST_KEY);

// 本机下载源：routes 是 { 路径: Buffer | (req,res)=>void }。
async function server(t, routes) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    hits.push(url);
    const r = routes[url];
    if (typeof r === 'function') return r(req, res);
    if (!r) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': r.length });
    res.end(r);
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, hits, routes, manifest: `${base}/hub-update/components/components.json` };
}
function publish(srv, catalog, files) {
  srv.routes['/hub-update/components/components.json'] = Buffer.from(JSON.stringify(catalog));
  for (const [rel, buf] of Object.entries(files)) srv.routes['/hub-update/components/' + rel] = buf;
}
function makeInstaller(srv, root, opts = {}) {
  const states = [];
  const runs = [];
  const installer = createCliInstaller({ sources: [{ id: 'aliyun', name: '阿里云', manifest: srv.manifest }], fetchImpl: globalThis.fetch,
    env: { AI_HUB_CLI_TOOLS_DIR: root, PATH: '' }, key: TEST_PUB, onState: s => states.push(s),
    run: opts.run || (async (file, args) => { runs.push([file, args]); return 'v-test'; }),
    nodeUsable: opts.nodeUsable || (async () => ({ ok: true })), connectTimeoutMs: 3000, idleTimeoutMs: 3000, logger: { warn() {} }, ...opts.extra });
  return { installer, states, runs };
}

// ---------- 组件目录 ----------
test('catalog: a signed catalog validates; tampering, missing signature and bad fields are rejected', () => {
  const buf = Buffer.from('x'.repeat(2000));
  const good = signed([component('codex', '0.167.0', buf, { install: { strip: 'package/vendor', bin: 'bin/codex.exe', pathDirs: ['bin', 'codex-path'], versionArgs: ['--version'] } }),
    { id: 'future-tool', version: '1.0.0' }]);
  const checked = catalogLib.validateCatalog(good, { key: TEST_PUB });
  assert.deepEqual(checked.components.map(c => c.id), ['codex'], 'unknown future ids are skipped, not fatal');
  assert.deepEqual(checked.components[0].install, { strip: 'package/vendor', bin: 'bin/codex.exe', pathDirs: ['bin', 'codex-path'], versionArgs: ['--version'] });
  const tampered = JSON.parse(JSON.stringify(good)); tampered.components[0].files[0].sha256 = 'a'.repeat(64);
  assert.throws(() => catalogLib.validateCatalog(tampered, { key: TEST_PUB }), /签名不正确/);
  const { signature, ...unsigned } = good;
  assert.throws(() => catalogLib.validateCatalog(unsigned, { key: TEST_PUB }), /签名不正确/);
  assert.throws(() => catalogLib.validateCatalog(good), /签名不正确/, 'the built-in release key does not accept a test-signed catalog');
  const bad = patch => { const c = component('codex', '0.167.0', buf); patch(c); return () => catalogLib.validateCatalog({ schema: 1, components: [c] }, { key: null }); };
  assert.throws(bad(c => { c.files[0].url = '../escape.tgz'; }), /自家地址不合规/);
  assert.throws(bad(c => { delete c.files[0].url; }), /没有任何下载地址/);
  assert.throws(bad(c => { c.files[0].official = ['http://plain.example/x.tgz']; }), /https/);
  assert.throws(bad(c => { c.kind = 'msi'; }), /包类型/);
  assert.throws(bad(c => { c.files.push({ ...c.files[0] }); }), /文件清单/);
  assert.throws(bad(c => { c.version = 'latest'; }), /版本号/);
  assert.throws(bad(c => { c.install = { bin: '../../evil.exe' }; }), /路径不合规/);
  assert.throws(bad(c => { c.install = { versionArgs: ['; rm -rf'] }; }), /版本参数/);
  assert.throws(bad(c => { c.kind = 'exe'; c.install = {}; }), /缺少程序文件名/);
  assert.equal(catalogLib.validateCatalog({ schema: 1, components: [component('dsh', '0.2.1-rc.2+tui.0.16.1', buf)] }, { key: null }).components[0].version, '0.2.1-rc.2+tui.0.16.1');
});

test('catalog: the URL is derived from the update sources (own host only), with an env override for tests', () => {
  const config = { sources: [
    { id: 'aliyun', name: '阿里云', manifest: 'https://mirror.example.cn/hub-update/m-test/latest.json', files: 'https://mirror.example.cn/hub-update/m-test/v{version}/' },
    { id: 'github', name: 'GitHub', manifest: 'https://github.com/owner/repo/releases/latest/download/latest.json' },
    { id: 'plain', name: 'plain', manifest: 'http://insecure.example/latest.json' }] };
  assert.deepEqual(catalogLib.catalogSources({ config, env: {} }), [{ id: 'aliyun', name: '阿里云', manifest: 'https://mirror.example.cn/hub-update/components/components.json' }]);
  const local = catalogLib.catalogSources({ config, env: { AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: '本机', manifest: 'http://127.0.0.1:9/latest.json' }]) } });
  assert.equal(local[0].manifest, 'http://127.0.0.1:9/hub-update/components/components.json');
  const direct = catalogLib.catalogSources({ config, env: { AI_HUB_CLI_COMPONENTS_SOURCES: JSON.stringify([{ id: 'x', manifest: 'http://127.0.0.1:9/c.json' }]) } });
  assert.deepEqual(direct, [{ id: 'x', name: 'x', manifest: 'http://127.0.0.1:9/c.json' }]);
  assert.deepEqual(catalogLib.catalogSources({ config: null, env: {} }), []);
});

test('catalog: download order is our mirror then official, or official first when preferOfficial', () => {
  const buf = Buffer.alloc(1500);
  const official = ['https://registry.npmmirror.com/@x/y/-/y-1.tgz', 'https://registry.npmjs.org/@x/y/-/y-1.tgz'];
  const list = [{ id: 'aliyun', name: '阿里云', manifest: 'https://m.example/hub-update/components/components.json' }];
  const mirrorFirst = catalogLib.validateCatalog({ schema: 1, components: [component('codex', '1.0.0', buf, { official })] }, { key: null }).components[0];
  assert.deepEqual(catalogLib.fileSources(mirrorFirst, mirrorFirst.files[0], list).map(s => s.name), ['阿里云', 'npm 国内镜像', 'npm 官方源']);
  assert.equal(catalogLib.fileSources(mirrorFirst, mirrorFirst.files[0], list)[0].url, 'https://m.example/hub-update/components/codex/1.0.0/codex-1.0.0.tgz');
  const claude = component('claude', '2.1.0', buf, { official, preferOfficial: true });
  delete claude.files[0].url;
  const c = catalogLib.validateCatalog({ schema: 1, components: [claude] }, { key: null }).components[0];
  assert.deepEqual(catalogLib.fileSources(c, c.files[0], list).map(s => s.name), ['npm 国内镜像', 'npm 官方源'], 'not on our mirror: official only');
});

// ---------- tgz ----------
function rawTar(name, type = '0', data = Buffer.alloc(0)) {
  const h = Buffer.alloc(512);
  h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return zlib.gzipSync(Buffer.concat([h, data, pad, Buffer.alloc(1024)]));
}

test('tgz: long names, nested dirs, strip prefix and empty files survive a round trip', async t => {
  const dir = tempDir(t);
  const long = 'node_modules/@scope/' + 'very-long-package-name-'.repeat(6) + '/lib/文件.js';
  const file = path.join(dir, 'a.tgz');
  await tar.packTgz([{ name: 'package/' + long, data: 'hello' }, { name: 'package/empty.txt', data: '' }, { name: 'package/bin/x.exe', data: Buffer.alloc(70000, 7) }, { name: 'outside.txt', data: 'no' }], file);
  const seen = [];
  const r = await tar.extractTgz(file, path.join(dir, 'out'), { strip: 'package', onEntry: e => seen.push(e.files) });
  assert.deepEqual(r, { files: 3, bytes: 70005 });
  assert.equal(fs.readFileSync(path.join(dir, 'out', ...long.split('/')), 'utf8'), 'hello');
  assert.equal(fs.statSync(path.join(dir, 'out', 'empty.txt')).size, 0);
  assert.equal(fs.statSync(path.join(dir, 'out', 'bin', 'x.exe')).size, 70000);
  assert.equal(fs.existsSync(path.join(dir, 'out', 'outside.txt')), false, 'entries outside the strip prefix are skipped');
  assert.equal(seen.at(-1), 3);
  const again = path.join(dir, 'b.tgz');
  await tar.packTgz([{ name: 'package/bin/x.exe', data: Buffer.alloc(70000, 7) }, { name: 'outside.txt', data: 'no' }, { name: 'package/' + long, data: 'hello' }, { name: 'package/empty.txt', data: '' }], again);
  assert.equal(sha256(fs.readFileSync(again)), sha256(fs.readFileSync(file)), 'packing is deterministic regardless of input order');
});

test('tgz: path traversal, absolute paths, links and corrupt archives are refused', async t => {
  const dir = tempDir(t);
  const cases = [['../evil.txt', '0', /不安全的路径/], ['/abs.txt', '0', /不安全的路径/], ['C:/abs.txt', '0', /不安全的路径/], ['ok/link', '2', /不支持的条目类型/], ['ok/hard', '1', /硬链接指向不存在的文件/]];
  for (const [i, [name, type, re]] of cases.entries()) {
    const file = path.join(dir, `bad${i}.tgz`);
    fs.writeFileSync(file, rawTar(name, type, Buffer.from('x')));
    await assert.rejects(tar.extractTgz(file, path.join(dir, 'out' + i)), re, name);
  }
  assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);
  fs.writeFileSync(path.join(dir, 'junk.tgz'), Buffer.from('<html>blocked</html>'));
  await assert.rejects(tar.extractTgz(path.join(dir, 'junk.tgz'), path.join(dir, 'junk')), /不是有效的 tgz/);
  const good = await tgz(t, [{ name: 'a.txt', data: Buffer.alloc(5000, 1) }]);
  fs.writeFileSync(path.join(dir, 'cut.tgz'), good.subarray(0, good.length - 40));
  await assert.rejects(tar.extractTgz(path.join(dir, 'cut.tgz'), path.join(dir, 'cut')));
});

// ---------- 下载 + 校验 + 原子安装 ----------
test('install: download, verify, extract, probe, rename into tools/<id>/<version> and record installed.json', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const pkg = await tgz(t, [{ name: 'package/claude.exe', data: Buffer.alloc(4096, 3) }, { name: 'package/README.md', data: 'r' }]);
  const c = component('claude', '2.1.319', pkg, { install: { strip: 'package', bin: 'claude.exe', pathDirs: ['.'], versionArgs: ['--version'] } });
  publish(srv, signed([c]), { [c.files[0].url]: pkg });
  const { installer, states, runs } = makeInstaller(srv, root);
  const result = await installer.install('claude');
  assert.equal(result.tools.claude.phase, 'done', result.tools.claude.error);
  const phases = [...new Set(states.map(s => s.tools.claude.phase))];
  for (const p of ['checking', 'downloading', 'verifying', 'installing', 'probing', 'done']) assert.ok(phases.includes(p), `phase ${p} in ${phases}`);
  const exe = path.join(root, 'claude', '2.1.319', 'claude.exe');
  assert.equal(fs.statSync(exe).size, 4096);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0][1], ['--version']);
  assert.ok(runs[0][0].endsWith('claude.exe') && runs[0][0].includes('.tmp'), 'the probe runs on the unpacked copy before it is promoted');
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'installed.json'), 'utf8'));
  assert.equal(installed.tools.claude.version, '2.1.319');
  assert.equal(installed.tools.claude.dir, 'claude/2.1.319');
  assert.deepEqual(fs.readdirSync(path.join(root, 'claude')), ['2.1.319'], 'no temp dir left behind');
  assert.equal(fs.existsSync(path.join(root, '.staging')) && fs.readdirSync(path.join(root, '.staging')).length, 0);
  assert.equal(registry.managedBin('claude', { AI_HUB_CLI_TOOLS_DIR: root }), exe);
  assert.equal(result.installed.claude.version, '2.1.319');
});

test('install: a corrupt mirror copy falls back to the official URL; all sources failing keeps the old version', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const v1 = await tgz(t, [{ name: 'package/vendor/bin/codex.exe', data: Buffer.alloc(3000, 1) }]);
  const v2 = await tgz(t, [{ name: 'package/vendor/bin/codex.exe', data: Buffer.alloc(3000, 2) }, { name: 'package/vendor/codex-path/rg.exe', data: 'rg' }]);
  const install = { strip: 'package/vendor', bin: 'bin/codex.exe', pathDirs: ['bin', 'codex-path'] };
  const c1 = component('codex', '1.0.0', v1, { install });
  publish(srv, signed([c1]), { [c1.files[0].url]: v1 });
  const first = makeInstaller(srv, root);
  assert.equal((await first.installer.install('codex')).tools.codex.phase, 'done');
  // v2：自家源上的文件被换了（sha 对不上），官方地址是对的。
  srv.routes['/official/codex-2.0.0.tgz'] = v2;
  const c2 = component('codex', '2.0.0', v2, { install });
  publish(srv, signed([c2]), { [c2.files[0].url]: Buffer.alloc(v2.length, 9) });
  // 目录里的官方地址必须是 https；单测里在下载顺序末尾补一个本机 http 地址充当「官方源」。
  const second = makeInstaller(srv, root);
  const origFileSources = catalogLib.fileSources;
  catalogLib.fileSources = (comp, file, list) => [...origFileSources(comp, file, list), { id: 'official-0', name: 'npm 官方源', url: srv.base + '/official/codex-2.0.0.tgz' }];
  t.after(() => { catalogLib.fileSources = origFileSources; });
  const ok = await second.installer.install('codex');
  assert.equal(ok.tools.codex.phase, 'done', ok.tools.codex.error);
  assert.ok(srv.hits.includes('/official/codex-2.0.0.tgz'), 'fell back to the official URL');
  const attempts = second.states.map(s => s.tools.codex.attempts).filter(a => a && a.length).at(-1);
  assert.deepEqual(attempts.map(a => [a.name, a.status]), [['阿里云', 'failed'], ['npm 官方源', 'ok']]);
  assert.match(attempts[0].reason, /校验不一致/);
  const rec = registry.readInstalled(root).tools.codex;
  assert.equal(rec.version, '2.0.0');
  assert.equal(rec.previous, '1.0.0');
  assert.deepEqual(fs.readdirSync(path.join(root, 'codex')).sort(), ['1.0.0', '2.0.0'], 'the previous version is kept');
  // v3：所有源都坏了 → 报错，2.0.0 原样可用。
  const v3 = await tgz(t, [{ name: 'package/vendor/bin/codex.exe', data: Buffer.alloc(3000, 3) }]);
  const c3 = component('codex', '3.0.0', v3, { install });
  publish(srv, signed([c3]), {});
  catalogLib.fileSources = origFileSources;
  const third = makeInstaller(srv, root);
  const failed = await third.installer.install('codex');
  assert.equal(failed.tools.codex.phase, 'error');
  assert.match(failed.tools.codex.error, /没下载成功.*HTTP 404/);
  assert.equal(registry.readInstalled(root).tools.codex.version, '2.0.0');
  assert.equal(registry.managedBin('codex', { AI_HUB_CLI_TOOLS_DIR: root }), path.join(root, 'codex', '2.0.0', 'bin', 'codex.exe'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'codex')).sort(), ['1.0.0', '2.0.0']);
  // v3 修好后再装：只留 3.0.0 和上一版 2.0.0，1.0.0 清掉。
  publish(srv, signed([c3]), { [c3.files[0].url]: v3 });
  assert.equal((await makeInstaller(srv, root).installer.install('codex')).tools.codex.phase, 'done');
  assert.deepEqual(fs.readdirSync(path.join(root, 'codex')).sort(), ['2.0.0', '3.0.0']);
});

test('install: a failing probe, a missing main program or a bad signature installs nothing', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const pkg = await tgz(t, [{ name: 'package/claude.exe', data: Buffer.alloc(2000, 5) }]);
  const c = component('claude', '1.0.0', pkg, { install: { strip: 'package', bin: 'claude.exe', versionArgs: ['--version'] } });
  publish(srv, signed([c]), { [c.files[0].url]: pkg });
  const probeFail = makeInstaller(srv, root, { run: async () => { throw Object.assign(new Error('blocked by policy'), { killed: false }); } });
  const r1 = await probeFail.installer.install('claude');
  assert.equal(r1.tools.claude.phase, 'error');
  assert.match(r1.tools.claude.error, /试运行没有通过.*blocked by policy/);
  assert.equal(fs.existsSync(path.join(root, 'claude', '1.0.0')), false);
  assert.equal(registry.managed('claude', { AI_HUB_CLI_TOOLS_DIR: root }), null);
  const missing = component('claude', '1.0.0', pkg, { install: { strip: 'package', bin: 'bin/claude.exe' } });
  publish(srv, signed([missing]), { [missing.files[0].url]: pkg });
  const r2 = await makeInstaller(srv, root).installer.install('claude');
  assert.match(r2.tools.claude.error, /缺少 bin\/claude\.exe/);
  const forged = catalogLib.sign({ schema: 1, components: [c] }, crypto.generateKeyPairSync('ed25519').privateKey);
  publish(srv, forged, { [c.files[0].url]: pkg });
  const r3 = await makeInstaller(srv, root).installer.install('claude');
  assert.match(r3.tools.claude.error, /读不到组件目录.*签名不正确/);
  assert.equal(fs.existsSync(path.join(root, 'claude')) ? fs.readdirSync(path.join(root, 'claude')).length : 0, 0, 'no leftovers');
});

test('install: DSH brings its own Node only when the machine has none that is new enough', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const nodePkg = await tgz(t, [{ name: 'node.exe', data: Buffer.alloc(3000, 4) }]);
  const dshPkg = await tgz(t, [{ name: 'node_modules/@deepseek-ai/dsh/lib/bin.js', data: 'bin' }, { name: 'node_modules/@deepseek-harness-tui/dsh-tui/package.json', data: '{}' }]);
  const node = component('node', '22.23.4', nodePkg, { install: { bin: 'node.exe', pathDirs: ['.'] } });
  const dsh = component('dsh', '0.2.1-rc.2+tui.0.16.1', dshPkg, { install: { requires: ['node'], minNode: 22, versionArgs: ['--version'] } });
  publish(srv, signed([dsh, node]), { [node.files[0].url]: nodePkg, [dsh.files[0].url]: dshPkg });
  const asked = [];
  const { installer, states, runs } = makeInstaller(srv, root, { nodeUsable: async min => { asked.push(min); return { ok: false, reason: '本机没有 Node.js' }; } });
  const r = await installer.install('dsh');
  assert.equal(r.tools.dsh.phase, 'done', r.tools.dsh.error);
  // DSH 的试运行用 Hub 刚装好的 node 跑入口脚本。
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], path.join(root, 'node', '22.23.4', 'node.exe'));
  assert.ok(runs[0][1][0].endsWith(path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), runs[0][1][0]);
  assert.match(path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(runs[0][1][0])))))), /^\.tmp-[0-9a-f]{8}$/, 'probed before promotion');
  assert.deepEqual(runs[0][1].slice(1), ['--version']);
  assert.deepEqual(asked, [22]);
  const steps = [...new Set(states.map(s => s.tools.dsh.step && `${s.tools.dsh.step.index}/${s.tools.dsh.step.count} ${s.tools.dsh.step.name}`).filter(Boolean))];
  assert.deepEqual(steps, ['1/2 node', '2/2 dsh']);
  assert.equal(states.find(s => s.tools.dsh.phase === 'downloading').tools.dsh.total, nodePkg.length + dshPkg.length, 'one progress bar over both downloads');
  const env = { AI_HUB_CLI_TOOLS_DIR: root };
  assert.equal(registry.managedDshRoot(env), path.join(root, 'dsh', '0.2.1-rc.2+tui.0.16.1'));
  assert.equal(registry.managedBin('node', env), path.join(root, 'node', '22.23.4', 'node.exe'));
  // 再装一次 DSH：Node 已经有了，不再问本机、不再下载 Node。
  asked.length = 0;
  const before = srv.hits.filter(h => h.includes('node-22')).length;
  await installer.install('dsh');
  assert.deepEqual(asked, []);
  assert.equal(srv.hits.filter(h => h.includes('node-22')).length, before);
});

test('install: a proxy block page on our host is auto-unblocked once and retried', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const pkg = await tgz(t, [{ name: 'package/claude.exe', data: Buffer.alloc(200000, 6) }]);
  const c = component('claude', '1.0.0', pkg, { install: { strip: 'package', bin: 'claude.exe' } });
  publish(srv, signed([c]), {});
  let unblocked = false;
  srv.routes['/hub-update/components/' + c.files[0].url] = (req, res) => {
    if (unblocked) { res.writeHead(200, { 'content-length': pkg.length }); res.end(pkg); return; }
    const page = Buffer.from('<!doctype html><html>风险提醒</html>');
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': page.length }); res.end(page);
  };
  const calls = [];
  const { installer } = makeInstaller(srv, root, { extra: { unblock: async url => { calls.push(url); unblocked = true; return true; }, isOwnUrl: url => url.startsWith(srv.base) } });
  const r = await installer.install('claude');
  assert.equal(r.tools.claude.phase, 'done', r.tools.claude.error);
  assert.equal(calls.length, 1);
  // 放行器不认的地址：报错并把被拦的网址交给界面。
  const root2 = tempDir(t);
  unblocked = false;
  const blocked = await makeInstaller(srv, root2).installer.install('claude');
  assert.equal(blocked.tools.claude.phase, 'error');
  assert.ok(blocked.tools.claude.blocked.startsWith(srv.base), 'the blocked URL is reported for the user');
});

test('install: one install at a time, cancel works, and node is not installable on its own', async t => {
  const root = tempDir(t);
  const srv = await server(t, {});
  const pkg = await tgz(t, [{ name: 'package/claude.exe', data: crypto.randomBytes(300000) }]);
  const c = component('claude', '1.0.0', pkg, { install: { strip: 'package', bin: 'claude.exe' } });
  publish(srv, signed([c]), {});
  srv.routes['/hub-update/components/' + c.files[0].url] = (req, res) => {
    res.writeHead(200, { 'content-length': pkg.length });
    res.write(pkg.subarray(0, 1000)); // 然后一直不发，等取消
  };
  const { installer } = makeInstaller(srv, root);
  const running = installer.install('claude');
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(installer.install('codex'), /正在安装 Claude Code/);
  await assert.rejects(installer.install('node'), /不认识的组件/);
  installer.cancel();
  const r = await running;
  assert.equal(r.tools.claude.phase, 'cancelled');
  assert.equal(r.busy, null);
  assert.equal(registry.managed('claude', { AI_HUB_CLI_TOOLS_DIR: root }), null);
});

// ---------- 检测与会话 PATH ----------
function fakeTools(t) {
  const root = tempDir(t, 'cli-managed-');
  const put = (rel, data = 'x') => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  put('claude/2.1.319/claude.exe');
  put('codex/0.167.0/bin/codex.exe'); put('codex/0.167.0/codex-path/rg.exe');
  put('dsh/0.2.1/node_modules/@deepseek-ai/dsh/lib/bin.js'); put('dsh/0.2.1/node_modules/@deepseek-harness-tui/dsh-tui/package.json', '{}');
  put('node/22.23.4/node.exe');
  registry.writeInstalled(root, { tools: {
    claude: { version: '2.1.319', dir: 'claude/2.1.319', bin: 'claude.exe', pathDirs: ['.'] },
    codex: { version: '0.167.0', dir: 'codex/0.167.0', bin: 'bin/codex.exe', pathDirs: ['bin', 'codex-path'] },
    dsh: { version: '0.2.1', dir: 'dsh/0.2.1' },
    node: { version: '22.23.4', dir: 'node/22.23.4', bin: 'node.exe', pathDirs: ['.'] } } });
  const home = tempDir(t, 'cli-home-');
  return { root, home, env: { AI_HUB_CLI_TOOLS_DIR: root, USERPROFILE: home, PATH: '' } };
}

test('detection: every lookup sees Hub-installed tools, but a user install on PATH still wins', t => {
  const { root, home, env } = fakeTools(t);
  const setup = require('../core/community-setup');
  const codexCmd = require('../main/codex-windows-command');
  const { resolveClaudeExe } = require('../core/account-adapters');
  assert.equal(setup.findCommand('claude', env, 'win32'), path.join(root, 'claude', '2.1.319', 'claude.exe'));
  assert.deepEqual(codexCmd.locateWindowsCodex(env), { kind: 'native', command: path.join(root, 'codex', '0.167.0', 'bin', 'codex.exe'), source: 'hub-tools' });
  assert.equal(setup.findCommand('codex', env, 'win32'), path.join(root, 'codex', '0.167.0', 'bin', 'codex.exe'));
  assert.equal(resolveClaudeExe(env), path.join(root, 'claude', '2.1.319', 'claude.exe'));
  const launch = codexCmd.resolveWindowsCodex(env);
  assert.ok(launch.env.PATH.split(path.delimiter).includes(path.join(root, 'codex', '0.167.0', 'codex-path')), 'Hub Codex gets its bundled tool folder');
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = home; // resolveDshCliRuntime 读 ~/.dsh/hub-cli-runtime.json，指到空目录
  t.after(() => { process.env.USERPROFILE = savedProfile; });
  const dsh = require('../core/dsh-cli-profile').resolveDshCliRuntime({}, env);
  assert.equal(dsh.root, path.join(root, 'dsh', '0.2.1'));
  // 用户自己的安装优先。
  const userBin = tempDir(t, 'cli-user-');
  fs.writeFileSync(path.join(userBin, 'claude.exe'), 'u'); fs.writeFileSync(path.join(userBin, 'codex.exe'), 'u');
  const withUser = { ...env, PATH: userBin };
  assert.equal(setup.findCommand('claude', withUser, 'win32'), path.join(userBin, 'claude.exe'));
  assert.equal(resolveClaudeExe(withUser), path.join(userBin, 'claude.exe'));
  assert.equal(codexCmd.locateWindowsCodex(withUser).source, 'PATH');
  const local = path.join(home, '.local', 'bin'); fs.mkdirSync(local, { recursive: true }); fs.writeFileSync(path.join(local, 'claude.exe'), 'l');
  assert.equal(resolveClaudeExe(env), path.join(local, 'claude.exe'), 'the official installer location beats the Hub copy');
  // 记录还在但文件被删了：当没装，不报一个启动不了的路径。
  fs.rmSync(path.join(root, 'codex', '0.167.0', 'bin', 'codex.exe'));
  assert.equal(codexCmd.locateWindowsCodex({ ...env, PATH: '' }), null);
});

test('session PATH: Hub tool folders go first only when the user has no install of their own', t => {
  const { root, home, env } = fakeTools(t);
  const { PATH: _unused, ...withoutPath } = env;
  const sessionEnv = { ...withoutPath, Path: 'C:\\Windows\\System32' };
  const added = registry.applySessionPath(sessionEnv, { platform: 'win32' });
  const claudeDir = path.join(root, 'claude', '2.1.319');
  const codexDirs = [path.join(root, 'codex', '0.167.0', 'bin'), path.join(root, 'codex', '0.167.0', 'codex-path')];
  assert.deepEqual(added, [claudeDir, ...codexDirs]);
  assert.deepEqual(sessionEnv.Path.split(path.delimiter), [...codexDirs, claudeDir, 'C:\\Windows\\System32'], 'the existing PATH key is reused');
  assert.equal('PATH' in sessionEnv, false, 'no second PATH key is invented');
  assert.deepEqual(registry.applySessionPath(sessionEnv, { platform: 'win32' }), [], 'idempotent');
  assert.deepEqual(registry.applySessionPath({ ...env }, { platform: 'linux' }), []);
  // 用户自己装了（npm 全局的 claude.cmd、PATH 上的 codex.cmd）：一个目录都不加。
  const appData = tempDir(t, 'cli-appdata-');
  fs.mkdirSync(path.join(appData, 'npm')); fs.writeFileSync(path.join(appData, 'npm', 'claude.cmd'), '');
  const userBin = tempDir(t, 'cli-user-'); fs.writeFileSync(path.join(userBin, 'codex.cmd'), '');
  const own = { AI_HUB_CLI_TOOLS_DIR: root, USERPROFILE: home, APPDATA: appData, PATH: userBin };
  assert.deepEqual(registry.applySessionPath(own, { platform: 'win32' }), []);
  assert.equal(own.PATH, userBin);
  // 没有 Hub 装的工具：PATH 原样不动。
  const none = { AI_HUB_CLI_TOOLS_DIR: tempDir(t), PATH: 'X' };
  assert.deepEqual(registry.applySessionPath(none, { platform: 'win32' }), []);
  assert.equal(none.PATH, 'X');
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const at = source.indexOf("require(" + "'./cli-tools/registry').applySessionPath(sessionEnv)");
  assert.ok(at > 0 && at > source.indexOf('const sessionEnv = { ...process.env };'), 'every new session env goes through applySessionPath');
});

test('DSH company route uses the Hub Node when one was installed', t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'acp-profiles.js'), 'utf8');
  assert.match(source, /managedBin\('node', baseEnv\)/);
  assert.match(source, /hubNode \|\| require\('\.\/company-model-proxy'\)\.findNodeOnPath\(baseEnv\)/);
});

// ---------- 启动中心弹窗 ----------
test('install dialog: plain-words progress for every phase, retry on failure, nothing when unavailable', () => {
  assert.equal(view.installBlockHtml('claude', { available: false }), '');
  assert.equal(view.installBlockHtml('claude', null), '');
  const base = { available: true, busy: null, tools: {}, git: { bash: 'C:\\Git\\bin\\bash.exe', source: 'user' }, catalog: [{ id: 'claude', bytes: 160447830 }, { id: 'dsh', bytes: 200 * 1024 * 1024 }] };
  const idle = view.installBlockHtml('claude', base);
  assert.match(idle, /data-cli-action="install"[^>]*>一键安装</);
  assert.match(idle, /约 153 MB/);
  assert.match(idle, /不需要管理员权限/);
  assert.match(view.installBlockHtml('deepseek-acp', base), /没有 Node\.js 时另加约 30 MB/);
  const at = tool => view.installBlockHtml('claude', { ...base, busy: tool.phase === 'done' || tool.phase === 'error' ? null : 'claude', tools: { claude: tool } });
  assert.match(at({ phase: 'checking' }), /正在读取组件目录/);
  const dl = at({ phase: 'downloading', received: 1024 * 1024, total: 4 * 1024 * 1024, sourceName: '阿里云', step: { index: 1, count: 2, name: 'Node.js 运行环境' } });
  assert.match(dl, /下载中 1\.0 \/ 4\.0 MB（第 1\/2 项：Node\.js 运行环境） · 来自阿里云/);
  assert.match(dl, /aria-valuenow="25"/);
  assert.match(dl, /data-cli-action="cancel"/);
  assert.doesNotMatch(dl, /data-cli-action="install"/);
  assert.match(at({ phase: 'verifying', received: 4, total: 4 }), /正在校验文件/);
  assert.match(at({ phase: 'installing', files: 1200 }), /正在安装（已解压 1200 个文件）/);
  assert.match(at({ phase: 'probing' }), /正在试运行/);
  const done = at({ phase: 'done', received: 4, total: 4 });
  assert.match(done, /安装完成/);
  assert.doesNotMatch(done, /data-cli-action/);
  const err = at({ phase: 'error', error: '阿里云：连接超时 <b>', blocked: 'https://m.example/x.tgz' });
  assert.match(err, /安装没有成功：阿里云：连接超时 &lt;b&gt;/);
  assert.match(err, />重试</);
  assert.match(err, /<code>https:\/\/m\.example\/x\.tgz<\/code>/);
  assert.match(at({ phase: 'cancelled' }), /已取消，可以重新安装/);
  const other = view.installBlockHtml('codex', { ...base, busy: 'claude', tools: { claude: { phase: 'downloading' } } });
  assert.match(other, /data-cli-action="install" disabled/);
  assert.match(other, /正在安装Claude Code，装完再装这个/);
  const advice = view.installBlockHtml('codex', { ...base, tools: { codex: { phase: 'done' } }, advice: { codex: '某条提醒' } });
  assert.match(advice, /某条提醒/);
  // 本机找到了 Git Bash：Claude 区块里不出 Git 小节。
  assert.doesNotMatch(view.installBlockHtml('claude', base), /install-git/);
  // 没找到：Claude 区块下面出「一键安装 Git for Windows」，原来那句提醒不再重复。
  const noGit = view.installBlockHtml('claude', { ...base, git: null, tools: { claude: { phase: 'done' } }, advice: { claude: '没找到 Git for Windows' },
    catalog: [...base.catalog, { id: 'git', bytes: 120 * 1024 * 1024 }] });
  assert.match(noGit, /data-cli-action="install-git"[^>]*>一键安装 Git for Windows</);
  assert.match(noGit, /改用 PowerShell/);
  assert.match(noGit, /约 120 MB/);
  assert.match(noGit, /全局找一遍/);
  assert.doesNotMatch(noGit, /cli-install-note">没找到 Git for Windows/);
  const gitAt = tool => view.installBlockHtml('claude', { ...base, git: null, busy: ['done', 'error'].includes(tool.phase) ? null : 'git', tools: { git: tool } });
  assert.match(gitAt({ phase: 'checking' }), /正在全局查找本机的 Git/);
  assert.match(gitAt({ phase: 'checking' }), /data-cli-action="install" disabled/, 'Claude 的按钮在装 Git 时不能点');
  assert.match(gitAt({ phase: 'downloading', received: 1024 * 1024, total: 2 * 1024 * 1024 }), /下载中 1\.0 \/ 2\.0 MB/);
  assert.match(gitAt({ phase: 'error', error: '超时' }), /重试安装 Git/);
  assert.match(view.installBlockHtml('claude', { ...base, tools: { git: { phase: 'done', found: 'D:\\PortableGit\\bin\\bash.exe' } } }), /已经有 Git Bash（D:\\PortableGit\\bin\\bash\.exe），不用重复安装/);
  assert.match(view.installBlockHtml('claude', { ...base, tools: { git: { phase: 'done' } } }), /Git for Windows 已装好/);
  assert.equal(view.gitBlockHtml({ available: false }), '');
});

test('install dialog wiring: one click installs, progress events re-render, success re-detects without restart', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-api-settings.js'), 'utf8');
  assert.match(source, /require\('\.\/cli-install-view'\)/);
  assert.match(source, /ipcRenderer\.invoke\('cli-tools:install', \{ id \}\)/);
  assert.match(source, /ipcRenderer\.on\('cli-tools:state'/);
  assert.match(source, /data-cli-install="\$\{kind\}"/);
  const run = source.slice(source.indexOf('async function runInstall'), source.indexOf('function showInstall'));
  assert.ok(run.indexOf('await refreshInstall()') > run.indexOf("invoke('cli-tools:install'"), 're-detect after installing');
  for (const kind of ['deepseek-acp', 'claude']) assert.ok(source.includes(kind === 'claude' ? 'heading(`安装 ${LABELS[kind]}`' : "heading('安装 DSH 运行环境'"));
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'main', 'cli-tools-ipc.js'), 'utf8');
  for (const channel of ['cli-tools:state', 'cli-tools:install', 'cli-tools:cancel']) assert.ok(ipc.includes(`'${channel}'`), channel);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /registerCliToolsIpc\(ipcMain, \{ installer: cliToolsInstallerRef \}\)/);
});

test('install IPC: no installer means a plain "not available" answer, never a throw', async () => {
  const handlers = {};
  require('../main/cli-tools-ipc').registerCliToolsIpc({ handle: (name, fn) => { handlers[name] = fn; } }, { installer: null });
  assert.equal((await handlers['cli-tools:state']()).available, false);
  const r = await handlers['cli-tools:install']({}, { id: 'claude' });
  assert.equal(r.ok, false);
  assert.match(r.error, /暂不支持一键安装/);
});

test('packaging script: arguments parse, unknown components are refused', () => {
  const { parseArgs } = require('../scripts/build-cli-components');
  const o = parseArgs(['--only', 'codex,dsh', '--dsh-version', '0.2.1-rc.2', '--dry-run']);
  assert.deepEqual(o.only, ['codex', 'dsh']);
  assert.equal(o.dsh, '0.2.1-rc.2');
  assert.equal(o.dryRun, true);
  assert.equal(o.registry, 'https://registry.npmmirror.com');
  assert.throws(() => parseArgs(['--only', 'gemini']), /不认识的组件/);
  assert.throws(() => parseArgs(['--upload']), /不认识的参数/);
});

test('install: the fast mirror lagging behind (older catalog) does not win; the newer catalog and its host go first', async t => {
  const root = tempDir(t);
  const fast = await server(t, {}), old = await server(t, {});
  const pkgOld = await tgz(t, [{ name: 'package/claude.exe', data: Buffer.alloc(1024, 1) }]);
  const pkgNew = await tgz(t, [{ name: 'package/claude.exe', data: Buffer.alloc(2048, 2) }]);
  const install = { strip: 'package', bin: 'claude.exe', pathDirs: ['.'], versionArgs: ['--version'] };
  const cOld = component('claude', '2.1.300', pkgOld, { install }), cNew = component('claude', '2.1.319', pkgNew, { install });
  publish(fast, catalogLib.sign({ schema: 1, publishedAt: '2026-11-06T00:00:00Z', components: [cOld] }, TEST_KEY), { [cOld.files[0].url]: pkgOld });
  publish(old, catalogLib.sign({ schema: 1, publishedAt: '2026-11-07T00:00:00Z', components: [cNew] }, TEST_KEY), { [cNew.files[0].url]: pkgNew });
  const { installer } = makeInstaller(fast, root, { extra: { sources: [
    { id: 'aliyun-fast', name: '阿里云高速', manifest: fast.manifest }, { id: 'aliyun', name: '阿里云', manifest: old.manifest }] } });
  const result = await installer.install('claude');
  assert.equal(result.tools.claude.phase, 'done', result.tools.claude.error);
  assert.equal(result.installed.claude.version, '2.1.319');
  assert.ok(old.hits.includes('/hub-update/components/' + cNew.files[0].url), 'downloaded from the host whose catalog is newest');
  assert.ok(!fast.hits.some(h => h.endsWith('.tgz')), 'the lagging mirror was not asked for the file');
});
