'use strict';
// R31（2026-11-24）：PPT Doctor 和 Hub 永远适配。
// 起因：公司电脑覆盖安装 v2.1.9 时 PPT-Doctor.exe 被占用没换掉，联动标记 hub-api.json 已是 2.1.9，
// Hub 按「标记哈希 ≠ 程序哈希」判成版本太旧，一键升级又只会装镜像上的完整基线 2.0.7，把新版装回旧版。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { PptDoctor } = require('../core/company-assistant/ppt-doctor');
const { createDoctorInstaller, installPlan, fullArchive } = require('../core/company-assistant/ppt-doctor-install');
const { isHubInstall } = require('../core/company-assistant/ppt-doctor-discovery');
const sha = data => createHash('sha256').update(data).digest('hex');
const FAKE = path.join(__dirname, 'fixtures/ppt-doctor-fake.js');

// 一份「装了一半」的 PPT Doctor：主程序是旧字节，标记写的是新版主程序的哈希。
function halfUpdated(t, { exeVersion = '2.1.0', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r31-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'PPT-Doctor.exe');
  fs.writeFileSync(exe, 'exe bytes of v2.1.0');
  fs.writeFileSync(path.join(dir, 'hub-api.json'), JSON.stringify({ apiVersion: 1, doctorVersion: '2.1.9', executable: 'PPT-Doctor.exe',
    exeSha256: sha('exe bytes of v2.1.9'), capabilities: ['status', 'search', 'read', 'catalog', 'report', 'index', 'serve'] }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '2.1.9' }));
  const spawned = [];
  const doctor = new PptDoctor({ dir, settings: () => ({ ppt: { doctorExe: exe } }) }, {
    pptEnv: env, pptDoctorArgs: [FAKE], pptDoctorExeVersion: async () => exeVersion,
    pptDoctorSpawn(file, args, opts) { spawned.push({ file, args }); return spawn(process.execPath, args, opts); },
  });
  t.after(() => doctor.close());
  return { dir, exe, doctor, spawned };
}

test('标记哈希和主程序对不上、但实测 status 协议对得上：照常可用，只走单次调用', async t => {
  const { doctor, spawned, exe } = halfUpdated(t);
  const status = await doctor.status();
  assert.equal(status.state, 'ready', status.error);
  assert.ok(spawned.length >= 2, '先实测一次 status，再执行真正的调用');
  assert.ok(spawned.every(s => s.file === exe && s.args.includes('--hub')));
  assert.ok(!spawned.some(s => s.args.includes('serve')), '主程序可能比标记旧，不启用常驻服务');
  // 同一个程序文件只实测一次。
  const before = spawned.length;
  await doctor.call('status');
  assert.equal(spawned.length, before + 1);
});

test('标记哈希对不上且实测回执协议不对：提示一键升级并写清是装了一半，已装版本按新的算', async t => {
  const { doctor } = halfUpdated(t, { env: { PPT_DOCTOR_FIXTURE: 'old' } });
  const status = await doctor.status();
  assert.equal(status.state, 'upgrade'); assert.equal(status.installed, true);
  assert.match(status.error, /安装不完整/); assert.match(status.error, /2\.1\.0/); assert.match(status.error, /2\.1\.9/);
  assert.equal(status.installedVersion, '2.1.9');
});

test('主程序版本早于第一版带 --hub 的 2.0.7：不启动它（避免弹出界面），直接提示升级', async t => {
  const { doctor, spawned } = halfUpdated(t, { exeVersion: '1.9.3' });
  const status = await doctor.status();
  assert.equal(status.state, 'upgrade'); assert.equal(spawned.length, 0);
});

test('已装版本取主程序、安装清单和联动标记里最高的那个', async t => {
  const { doctor } = halfUpdated(t);
  assert.equal(await doctor.installedVersion(), '2.1.9');
});

const full = { version: '2.0.7', path: 'PPT-Doctor-v2.0.7.zip', sha256: 'a'.repeat(64) };
test('安装计划：有文件表就补到最新；只能装基线且比已装旧时拒绝', () => {
  const files = { 'PPT-Doctor.exe': { hash: 'b'.repeat(64), size: 3 } };
  const withFiles = { version: '2.1.14', full, files }, noFiles = { version: '2.1.14', full };
  const meta = m => fullArchive(m, 'https://example.test/pptutor/manifest.json');
  assert.deepEqual([installPlan(withFiles, meta(withFiles), '2.1.9').refuse, installPlan(withFiles, meta(withFiles), '2.1.9').target], [false, '2.1.14']);
  assert.equal(installPlan(noFiles, meta(noFiles), '2.1.9').refuse, true);
  assert.equal(installPlan(noFiles, meta(noFiles), '').target, '2.0.7');
  assert.equal(installPlan(noFiles, meta(noFiles), '2.0.7').refuse, false, '同版本修复照常装');
  assert.equal(installPlan(withFiles, meta(withFiles), '2.2.0').refuse, true, '本机比清单最新还新也不装');
  for (const bad of ['../evil.exe', 'C:/evil.exe', 'a.dll:stream', '_internal/CON.txt', 'aux', 'x/lpt1', 'dir./a', 'a ', 'x\\evil'])
    assert.throws(() => installPlan({ ...withFiles, files: { [bad]: { hash: 'b'.repeat(64), size: 1 } } }, meta(withFiles), ''), /越界/, bad);
  assert.doesNotThrow(() => installPlan({ ...withFiles, files: { '_internal/console.dll': { hash: 'b'.repeat(64), size: 1 } } }, meta(withFiles), ''));
});

// 模拟镜像：清单 + 完整基线 zip + files/<sha256> 块。
async function mirrorFixture(t, { installed = '', withFiles = true, missingBlock = false, onlineDown = false, bundled = null, markerAsDir = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hub-r31-install-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const zip = Buffer.from('baseline archive'), newExe = Buffer.from('exe bytes v2.1.14'), same = Buffer.from('runtime unchanged');
  const marker = Buffer.from(JSON.stringify({ apiVersion: 1, doctorVersion: '2.1.14', executable: 'PPT-Doctor.exe', exeSha256: sha(newExe), capabilities: ['status'] }));
  const latest = { version: '2.1.14', full: { version: '2.0.7', path: 'PPT-Doctor-v2.0.7.zip', sha256: sha(zip) },
    ...(withFiles ? { files: {
      'PPT-Doctor.exe': { hash: sha(newExe), size: newExe.length },
      'hub-api.json': { hash: sha(marker), size: marker.length },
      '_internal/runtime.dll': { hash: sha(same), size: same.length },
    } } : {}) };
  const blocks = new Map([[sha(newExe), newExe], [sha(marker), marker]]);
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(`${init.method || 'GET'} ${url}`);
    if (url.endsWith('/manifest.json')) return onlineDown ? new Response('down', { status: 503 }) : new Response(JSON.stringify(latest));
    const block = url.match(/\/files\/([a-f0-9]{64})$/);
    if (block) return missingBlock || !blocks.has(block[1]) ? new Response('nope', { status: 404 }) : new Response(blocks.get(block[1]));
    return new Response(init.method === 'HEAD' ? null : zip, { headers: { 'content-length': String(zip.length), 'content-type': 'application/zip' } });
  };
  let configured = '';
  const installer = createDoctorInstaller({ dataDir: root, sources: ['https://example.test/pptutor/manifest.json'], fetchImpl,
    bundledManifest: () => bundled, installedVersion: async () => installed,
    extract: async (_zip, out) => {
      const app = path.join(out, 'PPT-Doctor'); await fsp.mkdir(path.join(app, '_internal'), { recursive: true });
      await fsp.writeFile(path.join(app, 'PPT-Doctor.exe'), 'exe bytes v2.0.7');
      await fsp.writeFile(path.join(app, '_internal/runtime.dll'), same);
      await fsp.writeFile(path.join(app, '_internal/dropped.pyd'), 'only in 2.0.7');
      const oldMarker = JSON.stringify({ apiVersion: 1, doctorVersion: '2.0.7', executable: 'PPT-Doctor.exe', exeSha256: sha('exe bytes v2.0.7'), capabilities: ['status'] });
      if (markerAsDir) await fsp.mkdir(path.join(app, 'hub-api.json')); else await fsp.writeFile(path.join(app, 'hub-api.json'), oldMarker);
      await fsp.writeFile(path.join(app, 'manifest.json'), JSON.stringify({ version: '2.0.7', files: {
        'PPT-Doctor.exe': { hash: sha('exe bytes v2.0.7'), size: 16 }, '_internal/runtime.dll': { hash: sha(same), size: same.length },
        '_internal/dropped.pyd': { hash: sha('only in 2.0.7'), size: 13 }, 'hub-api.json': { hash: sha(oldMarker), size: oldMarker.length } } }));
    },
    configure: async exe => { configured = exe; } });
  return { root, installer, requests, configured: () => configured, newExe };
}

test('一键升级：完整基线 + 增量补到最新，装好的是最新版且标记和主程序一致', async t => {
  const f = await mirrorFixture(t, { installed: '2.1.9' });
  const r = await f.installer.install();
  assert.equal(r.phase, 'done', r.error); assert.equal(r.version, '2.1.14'); assert.doesNotMatch(r.message, /完整基线/);
  const app = path.dirname(f.configured());
  assert.ok(isHubInstall(f.configured()));
  assert.deepEqual(fs.readFileSync(f.configured()), f.newExe);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'manifest.json'), 'utf8')).version, '2.1.14');
  assert.equal(fs.existsSync(path.join(app, '_internal/dropped.pyd')), false, '新版不再有的文件删掉');
  assert.ok(!f.requests.some(u => u.includes('/files/' + sha('runtime unchanged'))), '没变的文件不下载');
});

test('已装 2.1.9、下载源只有 2.0.7 完整基线（没有文件表）：不下载、不装回旧版，提示去 PPT Doctor 里更新', async t => {
  const f = await mirrorFixture(t, { installed: '2.1.9', withFiles: false });
  const r = await f.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(f.configured(), '');
  assert.match(r.error, /2\.1\.9/); assert.match(r.error, /不会装回旧版/); assert.match(r.error, /检查更新/);
  assert.ok(!f.requests.some(u => u.startsWith('GET') && u.endsWith('.zip')), '不该下载 600 MB 的旧基线');
});

test('增量块缺失：已装比基线新时原有安装不动；本机没装时退回只装基线', async t => {
  const blocked = await mirrorFixture(t, { installed: '2.1.9', missingBlock: true });
  const r = await blocked.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(blocked.configured(), ''); assert.match(r.error, /原有安装未更改/);
  const fresh = await mirrorFixture(t, { installed: '', missingBlock: true });
  const ok = await fresh.installer.install();
  assert.equal(ok.phase, 'done', ok.error); assert.equal(ok.version, '2.0.7'); assert.match(ok.message, /完整基线/);
});

test('Hub 一键装的那份不算用户手动指定，有更新的安装时自动换过去', () => {
  const hubCopy = path.join('C:/Users/x/.claude-session-hub', 'tools', 'ppt-doctor', 'install-0f8fad5b-d9cb-469f-a165-70867728950e', 'app', 'PPT-Doctor', 'PPT-Doctor.exe');
  assert.equal(isHubInstall(hubCopy), true);
  assert.equal(isHubInstall('C:\\Users\\x\\.claude-session-hub\\tools\\ppt-doctor\\install-0f8fad5b-d9cb-469f-a165-70867728950e\\app\\PPT-Doctor.exe'), true);
  assert.equal(isHubInstall('C:/Users/x/AppData/Local/Programs/PPT-Doctor/PPT-Doctor.exe'), false);
  const { pptDoctorAdapter } = require('../core/tool-discovery/tools');
  const { choose } = require('../core/tool-discovery/candidates');
  const adapter = pptDoctorAdapter({ settings: () => ({ ppt: { doctorExe: hubCopy } }), setSettings() {} }, { env: {} });
  const decision = choose([{ path: hubCopy, version: '2.0.7', order: 0, key: 'a' }, { path: 'C:/P/PPT-Doctor.exe', version: '2.1.14', order: 1, key: 'b' }],
    hubCopy, { configuredByUser: adapter.configuredByUser() });
  assert.equal(decision.pick.version, '2.1.14'); assert.equal(decision.reason, 'upgraded');
});

// ---- R31 审查补丁（Antigravity 问题清单 #1–#5）----
test('#1 在线源全挂、只剩自带清单快照（只有旧基线）：在线源的真实原因和「不装回旧版」一起写出来', async t => {
  const f = await mirrorFixture(t, { installed: '2.1.9', onlineDown: true, bundled: { version: '2.1.14', full: { version: '2.0.7', path: 'PPT-Doctor-v2.0.7.zip', sha256: 'c'.repeat(64) } } });
  const r = await f.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(f.configured(), '');
  assert.match(r.error, /在线下载源这次用不了/); assert.match(r.error, /503/); assert.match(r.error, /不会装回旧版/);
});

test('#2 自动发现：标记和主程序对不上且读不出主程序版本，不当可用候选；对得上时直接用标记里的版本', async t => {
  const { pptDoctorAdapter } = require('../core/tool-discovery/tools');
  const half = halfUpdated(t);
  const adapter = pptDoctorAdapter({ settings: () => ({ ppt: {} }), setSettings() {} }, { env: {} });
  if (process.platform === 'win32') {
    // 夹具 exe 不是真 PE，读不出文件版本：必须判不可用，不能写回设置。
    const probe = await adapter.probe(half.exe);
    assert.equal(probe.ok, false); assert.match(probe.reason, /对不上/);
  }
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r31-good-')); t.after(() => fs.rmSync(good, { recursive: true, force: true }));
  const exe = path.join(good, 'PPT-Doctor.exe'); fs.writeFileSync(exe, 'consistent exe');
  fs.writeFileSync(path.join(good, 'hub-api.json'), JSON.stringify({ apiVersion: 1, doctorVersion: '2.1.14', executable: 'PPT-Doctor.exe', exeSha256: sha('consistent exe'), capabilities: ['status'] }));
  assert.deepEqual(await adapter.probe(exe), { ok: true, version: '2.1.14' });
});

test('#3 增量换入到一半失败：不把半新半旧的目录当基线登记，暂存块清掉', async t => {
  const f = await mirrorFixture(t, { installed: '', markerAsDir: true });
  const r = await f.installer.install();
  assert.equal(r.phase, 'error'); assert.equal(f.configured(), ''); assert.match(r.error, /换入中途失败/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'tools', 'ppt-doctor')), [], '本次安装目录（含暂存块）整个清掉');
});

test('#3 增量块下不到、退回只装基线时，暂存块不留在磁盘上', async t => {
  const f = await mirrorFixture(t, { installed: '', missingBlock: true });
  const r = await f.installer.install();
  assert.equal(r.phase, 'done', r.error); assert.equal(r.version, '2.0.7');
  const job = path.dirname(path.dirname(path.dirname(f.configured())));
  assert.equal(fs.existsSync(path.join(job, 'delta')), false);
});

test('#5 环境体检：装了一半显示「安装不完整」，真的旧版仍显示「版本太旧」', async () => {
  const envCheck = require('../core/env-check');
  const run = async doctor => {
    const assistant = { cli: () => '', auth: { status: () => ({ state: 'unknown' }) }, rawWelink: async () => ({ code: 1, stdout: '' }),
      findCli: async () => ({ state: 'notfound' }), ppt: { doctor: { status: async () => doctor } } };
    const r = await envCheck.runEnvCheck({ platform: 'linux', kindAllowed: () => false, setup: { findCommand: () => null, findGitBash: () => null }, assistant: () => assistant });
    return r.items.find(i => i.id === 'ppt-doctor');
  };
  const half = await run({ state: 'upgrade', incomplete: true, installedVersion: '2.1.9', error: 'PPT Doctor 安装不完整' });
  assert.match(half.detail, /安装不完整/); assert.doesNotMatch(half.detail, /太旧/);
  const old = await run({ state: 'upgrade', installedVersion: '1.8.2', error: '旧' });
  assert.match(old.detail, /版本太旧/);
});
