'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { featureReadiness } = require('../core/feature-readiness');
const { fullArchive, createDoctorInstaller, extractZip } = require('../core/company-assistant/ppt-doctor-install');
const item = (id, status) => ({ id, name: id, status, detail: status });

test('已安装CLI不能掩盖未启用、失败或未检测的公司模型', () => {
  for (const state of ['off', 'bad', 'warn']) {
    const result = featureReadiness([item('claude', 'ok'), item('git-bash', 'ok'), item('codeagent', 'ok'), item('company-proxy', state)]);
    assert.notEqual(result.find(f => f.id === 'claude-company').status, 'ok');
  }
  const ready = featureReadiness([item('codex', 'ok'), item('codeagent', 'ok'), item('company-proxy', 'ok')]).find(f => f.id === 'codex-company');
  assert.equal(ready.label, '组件已就绪'); assert.match(ready.detail, /不代表.*真实模型/);
});
test('不支持的功能不显示；组件尚未检测不报就绪', () => {
  assert.deepEqual(featureReadiness([]), []);
  const [f] = featureReadiness([item('welink', 'ok')]);
  assert.equal(f.status, 'warn'); assert.match(f.detail, /尚未检测/);
});
test('完整基线保留实际版本，拒绝跨站下载及缺少hash', () => {
  const full = { version: '2.0.7', path: 'PPT-Doctor-v2.0.7.zip', sha256: 'a'.repeat(64) };
  const r = fullArchive({ version: '2.1.0', full }, 'https://example.test/ppt/manifest.json');
  assert.equal(r.version, '2.0.7'); assert.equal(r.latestVersion, '2.1.0');
  assert.equal(r.url, 'https://example.test/ppt/PPT-Doctor-v2.0.7.zip');
  for (const full of [{}, { version: '2.1.0', path: 'https://other.test/a.zip', sha256: 'a'.repeat(64) }, { version: '2.1.0', path: '../a.zip', sha256: 'a'.repeat(64) }]) {
    assert.throws(() => fullArchive({ version: '2.1.0', full }, 'https://example.test/manifest.json'));
  }
});

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-center-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = Buffer.from('fixture archive'), digest = createHash('sha256').update(payload).digest('hex');
  let configured = '', downloads = 0;
  const phases = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify({ version: '2.1.0', full: { version: '2.0.7', path: 'PPT-Doctor-v2.0.7.zip', sha256: options.badHash ? 'f'.repeat(64) : digest } }));
    if (init.method !== 'HEAD') downloads++;
    return new Response(init.method === 'HEAD' ? null : payload, { headers: { 'content-length': String(payload.length), 'content-type': 'application/zip' } });
  };
  const installer = createDoctorInstaller({ dataDir: root, sources: ['https://example.test/manifest.json'], fetchImpl,
    extract: async (_zip, out) => { if (options.extractError) throw new Error('bad zip'); await fs.writeFile(path.join(out, 'PPT-Doctor.exe'), 'fake'); },
    verify: async () => options.badCapability ? null : ({ apiVersion: 1 }),
    configure: async exe => { configured = exe; }, onState: s => phases.push(s.phase), ...options.deps });
  return { root, installer, phases, configured: () => configured, downloads: () => downloads };
}
test('真实下载器校验后再登记，重复点击共用安装，保留完整基线版本', async t => {
  const f = await fixture(t);
  const a = f.installer.install(), b = f.installer.install(); assert.equal(a, b);
  const r = await a;
  assert.equal(r.phase, 'done'); assert.equal(r.version, '2.0.7'); assert.match(r.message, /完整基线/);
  assert.equal(f.downloads(), 1); assert.ok(f.configured().startsWith(f.root));
  assert.equal(await fs.readFile(f.configured(), 'utf8'), 'fake');
  assert.ok(f.phases.includes('downloading')); assert.ok(f.phases.includes('extracting'));
});
for (const bad of ['badHash', 'badCapability', 'extractError']) test(`${bad} 保留原设置且清理本次暂存`, async t => {
  const f = await fixture(t, { [bad]: true });
  const r = await f.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(f.configured(), '');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'tools', 'ppt-doctor')), []);
});
test('下载中取消不会登记半成品', async t => {
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { deps: { download: async ({ signal }) => { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { ok: false, cancelled: true }; } } });
  const pending = f.installer.install(); await start; f.installer.cancel();
  assert.equal((await pending).phase, 'cancelled'); assert.equal(f.configured(), '');
});
test('界面关闭导致进度通知失败，不中断已经授权的安装', async t => {
  const f = await fixture(t, { deps: { onState: () => { throw new Error('view closed'); } } });
  assert.equal((await f.installer.install()).phase, 'done');
  assert.ok(f.configured());
});

// A tiny ZIP writer avoids new dependencies and exercises the real Windows extraction boundary.
function zip(name, content = 'hello') {
  const file = Buffer.from(name), data = Buffer.from(content);
  let crc = 0xFFFFFFFF;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0); }
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + file.length, 12); end.writeUInt32LE(local.length + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}
test('Windows 实际解压：合法包可用，目录越界在写任何文件前拒绝', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-extract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [i, name] of ['app/PPT-Doctor.exe', '../outside.txt', 'app/CON.txt'].entries()) {
    const archive = path.join(root, `package-${i}.zip`), dest = path.join(root, `out-${i}`);
    await fs.writeFile(archive, zip(name)); await fs.mkdir(dest);
    if (!i) { await extractZip(archive, dest); assert.equal(await fs.readFile(path.join(dest, name), 'utf8'), 'hello'); }
    else { await assert.rejects(extractZip(archive, dest)); assert.deepEqual(await fs.readdir(dest), []); }
  }
});
