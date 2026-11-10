'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const canary = require('../core/app-update/canary');
const { createAppUpdateController } = require('../main/app-update-controller');
const { probePage, attendanceFetch } = require('../core/app-update/canary-network');
const { runEnvCheck } = require('../core/env-check');
function tmp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
const source = { id: 's', name: 'source', manifest: 'https://example.invalid/latest.json', files: 'https://example.invalid/v{version}/' };
function manifest(version) { return { schema: 1, version, runtime: { electron: '41.2.0', native: {} }, installer: { file: 'setup.exe', bytes: 4096, sha256: '1'.repeat(64) }, canary: { sha: 'a'.repeat(40) } }; }
function controller(t, dataDir, request) { const c = createAppUpdateController({ config: { sources: [source] }, env: {}, dataDir, currentVersion: '5.5.63',
  fetchImpl: async url => { request.push(url); return new Response(JSON.stringify(manifest(url.endsWith('canary.json') ? '5.5.65' : '5.5.64')), { headers: { 'Content-Type': 'application/json' } }); } }); t.after(() => c.dispose()); return c; }
test('默认只查正式清单；开启才查抢先版，关闭立即恢复并持久化', async t => {
  const dir = tmp(t), calls = [], c = controller(t, dir, calls);
  assert.equal((await c.check()).latest.version, '5.5.64'); assert.equal(calls.some(u => u.endsWith('canary.json')), false);
  c.setPreviewEnabled(true); assert.equal(canary.read(dir).enabled, true);
  assert.equal((await c.check()).latest.version, '5.5.65');
  c.setPreviewEnabled(false); calls.length = 0; assert.equal((await c.check()).latest.version, '5.5.64'); assert.equal(calls.length, 1);
});
test('抢先版 404 自动使用正式清单；不改变下载地址', async t => {
  const dir = tmp(t); canary.write(dir, { enabled: true });
  const c = createAppUpdateController({ config: { sources: [source] }, env: {}, dataDir: dir, currentVersion: '5.5.63', fetchImpl: async url =>
    url.endsWith('canary.json') ? new Response('', { status: 404 }) : new Response(JSON.stringify(manifest('5.5.64')), { headers: { 'Content-Type': 'application/json' } }) }); t.after(() => c.dispose());
  assert.equal((await c.check()).latest.version, '5.5.64');
  assert.equal(canary.previewSources([source])[0].files, source.files);
});
test('管理命令修改同一偏好文件，下一次后台检查识别，不扩展远程协议', async t => {
  const dir = tmp(t), calls = [], c = controller(t, dir, calls);
  canary.write(dir, { enabled: true, machine: 'preserved-machine' });
  assert.equal((await c.check()).latest.version, '5.5.65');
  assert.equal(c.getState().previewEnabled, true);
  canary.write(dir, { enabled: false }); calls.length = 0;
  assert.equal((await c.check()).latest.version, '5.5.64'); assert.equal(calls.length, 1);
  assert.equal(canary.read(dir).machine, 'preserved-machine');
});
test('体检报告离线留存，入队后去重；不采集未选字段，文本留出加密空间', async t => {
  const dir = tmp(t); canary.write(dir, { enabled: true }); let checks = 0, online = false, received;
  const runner = canary.createCanaryRunner({ dataDir: dir, version: '5.5.65', zone: () => '绿区', runCheck: async () => { checks++; return { items: [{ id: 'x', name: '检查', status: 'ok', detail: os.homedir(), apiKey: 'private', fingerprint: { token: 'Bearer secretsecretsecret' } }] }; }, sendReport: async r => { received = r; return online; } });
  await runner.run('a'.repeat(40)); assert.ok(canary.read(dir).pending); online = true;
  await runner.run('a'.repeat(40)); await runner.run('a'.repeat(40));
  assert.equal(checks, 1); assert.equal(canary.read(dir).pending, null); assert.equal(received.zone, '绿区');
  assert.equal(JSON.stringify(received).includes('private'), false); assert.equal(JSON.stringify(received).includes(os.homedir()), false);
  assert.ok(Buffer.byteLength(JSON.stringify(received)) <= canary.MAX_BYTES);
});
test('登录跳转与 HIS 拦截标为失败，正常页面通过，URL 查询凭据不入指纹', async () => {
  for (const [html, url, status] of [['ok', 'https://example.invalid/page?token=secret', 'ok'], ['Sign in', 'https://example.invalid/login?code=secret', 'bad'], ['<title>HIS Proxy Notification</title>', 'https://example.invalid/blocked', 'bad']]) {
    const response = new Response(html); Object.defineProperty(response, 'url', { value: url });
    const r = await probePage('https://example.invalid/', { fetchImpl: async () => response });
    assert.equal(r.status, status); assert.equal(JSON.stringify(r.fingerprint).includes('secret'), false);
  }
});
test('P1-1 普通 this/history 与小写 his 不会误认成代理拦截页', async () => {
  for (const html of ['this.history.pushState();', '<h1>History</h1>', '<title>his proxy notification</title>']) {
    const response = new Response(html);
    const r = await probePage('https://example.invalid/attendance', { fetchImpl: async () => response });
    assert.equal(r.status, 'ok'); assert.equal(r.fingerprint.blocked, false);
  }
});
test('P1-1 正文登录提示不算跳转，只按最终登录地址判断', async () => {
  for (const [url, login] of [['https://example.invalid/attendance?next=/login', false], ['https://example.invalid/sso/login?code=secret', true], ['https://login.example.invalid/start', true]]) {
    const response = new Response('最近登录记录，登录状态正常，sign in history'); Object.defineProperty(response, 'url', { value: url });
    const r = await probePage('https://example.invalid/attendance', { fetchImpl: async () => response });
    assert.equal(r.fingerprint.login, login); assert.equal(r.status, login ? 'bad' : 'ok');
  }
});
test('P1-1 考勤页面使用持久论坛分区的 fetch 与登录态', async () => {
  const calls = [], authenticated = { marker: 'logged-in', async fetch(url, options) { assert.equal(this.marker, 'logged-in'); calls.push({ url, redirect: options.redirect }); return new Response('attendance'); } };
  const fetchImpl = attendanceFetch({ fromPartition(partition) { assert.equal(partition, 'persist:company-forum'); return authenticated; } });
  assert.equal((await probePage('https://example.invalid/attendance', { fetchImpl })).status, 'ok');
  assert.equal(calls.length, 1); assert.equal(calls[0].redirect, 'follow');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /return probePage\(url, \{ fetchImpl: attendanceFetch\(require\('electron'\)\.session\) \}\)/, '主进程必须接入该分区适配器');
});
test('P1-1 考勤结果照常回报但不使客户端报告整体失败', () => {
  const r = canary.makeReport({ version: '5.5.65', items: [{ id: 'codeagent', name: 'CLI', status: 'ok' }, { id: 'attendance-page', name: '考勤', status: 'bad', raw: '登录未就绪' }] }, { machine: 'machine-123456' });
  assert.equal(r.passed, true); assert.equal(r.items[1].status, 'bad'); assert.equal(r.items[1].error, '登录未就绪');
});
test('P1-2 sanitize 覆盖 8.3 用户目录、转义 JSON 和所有回传文本字段', () => {
  const short = 'C:\\Users\\L00807~1\\AppData\\Local\\Temp\\codeagent';
  const { sanitize } = require('../core/env-check');
  for (const value of [short, short.toLowerCase(), short.replace(/\\/g, '/'), JSON.stringify({ runtime: short })]) {
    assert.doesNotMatch(sanitize(value, { home: 'C:\\Users\\example-user', user: 'someone' }), /L00807~1|l00807~1/);
  }
  const report = canary.makeReport({ version: '5.5.65', items: [{ id: short, name: short, status: 'bad', detail: short, raw: short, fingerprint: { source: short } }] }, { machine: 'machine-123456', zone: short });
  assert.doesNotMatch(JSON.stringify(report), /L00807~1/);
});
test('P1-2 签名运行库指纹只含位置类别，TEMP 与安装目录不泄露路径', async t => {
  const root = tmp(t), install = path.join(root, 'install'), configDir = path.join(root, 'config'), tempDir = path.join(root, 'temp'), dataDir = path.join(root, 'data');
  for (const [kind, dir] of [['配置目录', path.join(dataDir, 'company-model-proxy/native-runtime/1.2615.02.02')], ['安装目录', path.join(install, 'bin')], ['TEMP', path.join(tempDir, 'codeagent/signer-x64-win32-test')]]) {
    fs.mkdirSync(dir, { recursive: true }); for (const file of ['libsnap_engine.dll', 'koffi.node']) fs.writeFileSync(path.join(dir, file), 'fixture');
    const ctx = { env: { TEMP: tempDir }, dataDir, codeagentConfig: () => ({ command: 'fixture', configDir }), codeagentInstallDir: () => install, codeagentVersion: async () => '1.2615.02.02' };
    const row = require('../core/canary-env-probes').probes(ctx).find(p => p.id === 'codeagent-signer');
    const result = await row.run(); assert.equal(result.status, 'ok');
    assert.deepEqual(result.fingerprint, { installLocation: '安装目录', runtimeLocation: kind });
    assert.equal(JSON.stringify(result).includes(root), false);
    for (const file of ['libsnap_engine.dll', 'koffi.node']) fs.unlinkSync(path.join(dir, file));
  }
});
test('默认更新放行：抢先关闭时 silent 检查自家源被拦，后台放行一次后重试成功', async t => {
  const dir = tmp(t), events = []; let passed = 0;
  assert.equal(canary.read(dir).enabled, false);
  const c = createAppUpdateController({ config: { sources: [source] }, env: {}, dataDir: dir, currentVersion: '5.5.63', isOwnUrl: url => url === source.manifest,
    unblock: async url => { assert.equal(url, source.manifest); events.push('unblock'); return true; },
    unblockInteractive: async () => assert.fail('检查应保持无感'), unblockPassed: () => passed++,
    fetchImpl: async url => { assert.equal(url, source.manifest); events.push('fetch'); return events.length === 1
      ? new Response('<title>HIS Proxy Notification</title>', { headers: { 'Content-Type': 'text/html' } })
      : new Response(JSON.stringify(manifest('5.5.64')), { headers: { 'Content-Type': 'application/json' } }); } }); t.after(() => c.dispose());
  const state = await c.check({ silent: true });
  assert.deepEqual(events, ['fetch', 'unblock', 'fetch']); assert.equal(passed, 1);
  assert.equal(state.previewEnabled, false); assert.equal(state.phase, 'available'); assert.equal(state.latest.version, '5.5.64');
});
test('默认更新放行：抢先关闭时下载被拦，后台放行失败后交互放行并重新下载成功', async t => {
  const dir = tmp(t), events = [], payload = Buffer.alloc(4096, 7), m = manifest('5.5.64'); let passed = 0;
  m.installer.sha256 = require('node:crypto').createHash('sha256').update(payload).digest('hex');
  assert.equal(canary.read(dir).enabled, false);
  const assetUrl = 'https://example.invalid/v5.5.64/setup.exe';
  const c = createAppUpdateController({ config: { sources: [source] }, env: {}, dataDir: dir, currentVersion: '5.5.63', isOwnUrl: url => url === assetUrl,
    unblock: async url => { assert.equal(url, assetUrl); events.push('unblock'); return false; },
    unblockInteractive: async url => { assert.equal(url, assetUrl); events.push('interactive'); }, unblockPassed: () => passed++,
    fetchImpl: async url => { if (url.endsWith('.json')) return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } });
      assert.equal(url, assetUrl); events.push('download'); return events.length === 1
        ? new Response('<title>HIS Proxy Notification</title>', { headers: { 'Content-Type': 'text/html' } })
        : new Response(payload, { headers: { 'Content-Type': 'application/octet-stream' } }); } }); t.after(() => c.dispose());
  await c.check({ silent: true }); const state = await c.download();
  assert.deepEqual(events, ['download', 'unblock', 'interactive', 'download']); assert.equal(passed, 1);
  assert.equal(state.previewEnabled, false); assert.equal(state.phase, 'ready');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'app-update/downloads/setup.exe')), payload);
});
test('P1-3 抢先开关打开后更新和体检周期仍为六小时，不另加检查请求', async t => {
  const dir = tmp(t); canary.write(dir, { enabled: true }); const timers = [], fake = (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; };
  const c = controller(t, dir, []);
  t.mock.method(global, 'setTimeout', fake); t.mock.method(global, 'clearTimeout', () => {});
  c.startBackgroundChecks(); assert.equal(timers[0].ms, 20000); timers[0].callback();
  assert.ok(timers.some(timer => timer.ms === 6 * 60 * 60 * 1000));
  const previewTimers = [];
  const dispose = canary.scheduleChecks(() => {}, { setTimeoutImpl: (_, ms) => { previewTimers.push(ms); return {}; }, setIntervalImpl: (_, ms) => { previewTimers.push(ms); return {}; }, clearTimeoutImpl() {}, clearIntervalImpl() {} });
  assert.deepEqual(previewTimers, [30000, 6 * 60 * 60 * 1000]); dispose(); c.dispose();
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('const runner = preview.createCanaryRunner'), end = main.indexOf("app.once('will-quit', preview.scheduleChecks(tick))", start);
  assert.ok(start > 0 && end > start); assert.doesNotMatch(main.slice(start, end), /appUpdate\.check\(/, '体检循环不能增加更新检查');
});
test('大报告保留每项状态并标明截断，不会因报告超限退化成无报告放行', () => {
  const report = canary.makeReport({ version: '5.5.65', items: Array.from({ length: 80 }, (_, i) => ({ id: 'probe-' + i, name: '检查'.repeat(40), status: i === 79 ? 'bad' : 'ok', detail: '正文'.repeat(100), raw: '失败原因'.repeat(100), fingerprint: { text: '指纹'.repeat(200) } })) }, { machine: 'machine-123456', zone: '绿区', releaseSha: 'a'.repeat(40) });
  assert.equal(report.truncated, true); assert.equal(report.passed, false); assert.equal(report.items.length, 80); assert.equal(report.items[79].status, 'bad');
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= canary.MAX_BYTES);
});
test('体检途中关闭抢先版，结果不再发送', async t => {
  const dir = tmp(t); canary.write(dir, { enabled: true }); let sent = false;
  const runner = canary.createCanaryRunner({ dataDir: dir, version: '5.5.65', runCheck: async () => { canary.write(dir, { enabled: false }); return { items: [{ id: 'x', name: 'x', status: 'ok', detail: '' }] }; }, sendReport: async () => { sent = true; return true; } });
  await runner.run('a'.repeat(40)); assert.equal(sent, false); assert.equal(canary.read(dir).enabled, false);
});
test('金丝雀复用体检调度，覆盖必检项，缺少根目录信任文件不误报成功', async t => {
  const dir = tmp(t), cfg = path.join(dir, 'config'); fs.mkdirSync(cfg);
  const ctx = { canary: true, dataDir: dir, homeDir: dir, version: '5.5.65', isCompany: true,
    setup: { findCommand: k => k === 'codeagent' ? 'codeagent.exe' : null }, codeagentVersion: async () => '1.2615.02.02', codeagentCommand: () => 'codeagent',
    codeagentConfig: () => ({ configDir: cfg }), kindAllowed: () => true, discoverAttendanceDomain: () => ({ domain: 'example.invalid', from: 'test' }),
    probeAttendancePage: async () => ({ status: 'ok', detail: 'HTTP 200' }), getConfig: () => ({}),
    appUpdate: () => ({ probeSources: async () => ({ sources: [{ id: 's', ok: true, version: '5.5.65' }] }) }) };
  const r = await runEnvCheck(ctx), by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by['codeagent-trust'].status, 'warn'); assert.equal(by['attendance-domain'].status, 'ok'); assert.equal(by['canary-pages'].status, 'ok'); assert.equal(by.claude, undefined);
  fs.writeFileSync(path.join(dir, '.cac.json'), '{"projects":{}}');
  assert.equal((await runEnvCheck(ctx)).items.find(i => i.id === 'codeagent-trust').status, 'ok');
  fs.unlinkSync(path.join(dir, '.cac.json')); fs.writeFileSync(path.join(cfg, '.cac.json'), '{}');
  assert.equal((await runEnvCheck({ ...ctx, codeagentVersion: async () => '1.2615.02.03' })).items.find(i => i.id === 'codeagent-trust').status, 'ok', '新版 CLI 允许配置目录内的信任文件');
});
