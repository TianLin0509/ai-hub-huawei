'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const link = require('../core/weclaw-link');
const { WeclawLinkService } = require('../main/weclaw-link-service');
const { describe } = require('../renderer/weclaw-page');

// 假的员工助手本机服务：只在 localhost:3008 上回应（模拟 7.9 只听 ::1，127.0.0.1 连不上）。
function fakeWeclaw({ up = true } = {}) {
  const calls = [];
  let provider = null;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ host: u.host, path: u.pathname, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (!fake.up || u.host !== 'localhost:3008') throw new Error('ECONNREFUSED');
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/config/opencode/global/models' && method === 'GET') {
      const providers = [{ id: 'myagent', options: {}, models: { q: {} } }];
      if (provider) providers.push({ id: link.PROVIDER_ID, options: provider.options, models: provider.models });
      return reply(200, { providers });
    }
    if (u.pathname.endsWith('/models/provider') && method === 'PUT') { if (fake.beforePut) await fake.beforePut(); provider =JSON.parse(init.body)[link.PROVIDER_ID]; return reply(200, { ok: true, pendingReload: false }); }
    if (u.pathname.endsWith(`/models/provider/${link.PROVIDER_ID}`) && method === 'DELETE') { if (!provider) return reply(404, { error: 'not found' }); provider = null; return reply(200, { ok: true }); }
    return reply(404, {});
  };
  const fake = { up, calls, fetchImpl, get provider() { return provider; } };
  return fake;
}
function fakeProxy(port = 54761) {
  const proxy = { state: 'stopped', port, syncs: 0,
    status() { return { state: this.state, port: this.state === 'running' ? this.port : 0 }; },
    async ensureReady() { this.state = 'running'; return this.status(); },
    async syncWithConfig() { this.syncs += 1; } };
  return proxy;
}
const MODELS = [{ id: 'Glm-5.3', label: 'GLM-5.3-CodeAgent', contextWindow: 202752, thinking: true }, { id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }];
function setup(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weclaw-link-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const weclaw = fakeWeclaw(opts), proxy = fakeProxy();
  const service = new WeclawLinkService({ dataDir, proxy, fetchImpl: weclaw.fetchImpl, readEndpoint: () => ({ port: proxy.port, key: 'a'.repeat(48) }),
    listModels: () => MODELS, findInstall: () => 'C:/x/WeClaw Desktop.exe', log: { info() {} } });
  return { dataDir, weclaw, proxy, service };
}

test('配置：指向本机代理，默认固定本人账号，模型名带 HUB-H 前缀', () => {
  const p = link.buildProvider({ port: 54761, key: 'k', models: MODELS })[link.PROVIDER_ID];
  assert.equal(p.options.baseURL, 'http://127.0.0.1:54761/v1');
  assert.equal(p.options.apiKey, 'k.weclaw__pin_personal');
  assert.equal(p.options.modelOrigin, 'internal');
  assert.equal(p.models['Glm-5.3'].name, 'HUB-H · GLM-5.3-CodeAgent');
  assert.equal(p.models['Glm-5.3'].limit.context, 202752);
  assert.equal(link.buildProvider({ port: 1, key: 'k', models: MODELS, allowPool: true })[link.PROVIDER_ID].options.apiKey, 'k.weclaw');
  assert.throws(() => link.buildProvider({ port: 0, key: 'k', models: [] }));
});

test('一键接入：启动代理、经 localhost 合入、记下端口；状态显示已接入', async t => {
  const { weclaw, proxy, service, dataDir } = setup(t);
  const r = await service.connect();
  assert.equal(r.applied, true);
  assert.equal(proxy.state, 'running');
  assert.ok(proxy.syncs >= 1);
  assert.equal(weclaw.provider.options.baseURL, 'http://127.0.0.1:54761/v1');
  assert.ok(weclaw.calls.some(c => c.method === 'PUT' && c.host === 'localhost:3008'));
  assert.equal(link.readState(dataDir).port, 54761);
  const s = await service.status();
  assert.equal(s.linked.present, true);
  assert.equal(s.linked.port, 54761);
  assert.equal(s.stale, false);
  assert.equal(describe(s).linked[1], '已接入');
  assert.ok(!JSON.stringify(s).includes('a'.repeat(48)), '状态里不带主 key');
});

test('员工助手没开：先记下，打开后同步自动合入', async t => {
  const { weclaw, service } = setup(t, { up: false });
  const r = await service.connect();
  assert.equal(r.applied, false);
  assert.equal(describe(await service.status()).linked[1], '等员工助手打开');
  weclaw.up = true;
  await service.sync();
  assert.equal(weclaw.provider.options.baseURL, 'http://127.0.0.1:54761/v1');
});

test('HUB-H 重启换了端口：同步时自动重写；端口没变不重写', async t => {
  const { weclaw, proxy, service } = setup(t);
  await service.connect();
  const puts = () => weclaw.calls.filter(c => c.method === 'PUT').length;
  await service.sync();
  assert.equal(puts(), 1);
  proxy.port = 60001;
  assert.equal((await service.status()).stale, true);
  await service.sync();
  assert.equal(puts(), 2);
  assert.equal(weclaw.provider.options.baseURL, 'http://127.0.0.1:60001/v1');
});

test('代理没在跑时不拿 endpoint.json 里的旧端口去写', async t => {
  const { weclaw, proxy, service, dataDir } = setup(t);
  link.writeState(dataDir, { enabled: true, allowPool: false });
  proxy.state = 'stopped';
  const r = await service.sync();
  assert.equal(r.skipped, 'proxy-not-ready');
  assert.equal(weclaw.provider, null);
});

test('允许号池：重写为不带 pin 的 key；断开：删掉配置、状态回到未接入', async t => {
  const { weclaw, service, dataDir } = setup(t);
  await service.connect();
  await service.setAllowPool(true);
  assert.equal(weclaw.provider.options.apiKey.endsWith('__pin_personal'), false);
  const r = await service.disconnect();
  assert.equal(r.removed, true);
  assert.equal(weclaw.provider, null);
  assert.equal(link.readState(dataDir).enabled, false);
  assert.equal(describe(await service.status()).linked[1], '未接入');
  // 用户已在员工助手里自己删掉：再断开也算成功
  assert.equal((await service.disconnect()).removed, true);
});

test('没装员工助手：页面提示没找到，接入按钮不可点', () => {
  const d = describe({ installed: false, running: false, enabled: false, proxy: { state: 'stopped' }, linked: { present: false, models: [] } });
  assert.equal(d.app[1], '没找到员工助手');
});

// ---- 审查补测（Codex 11-26）----
function setupWith(t, { key = 'a'.repeat(48), models = MODELS } = {}) {
  const ctx = setup(t);
  const env = { key, models };
  ctx.service.readEndpoint = () => ({ port: ctx.proxy.port, key: env.key });
  ctx.service.listModels = () => env.models;
  return { ...ctx, env };
}

test('同步正在写的时候点断开：断开最后生效，不被旧写入盖回去', async t => {
  const { weclaw, service, proxy, dataDir } = setup(t);
  await service.connect();
  proxy.port = 60002; // 让下一次同步要重写
  let release;
  weclaw.beforePut = () => new Promise(resolve => { release = resolve; });
  const syncing = service.sync();
  await new Promise(r => setTimeout(r, 20));
  const disconnecting = service.disconnect();
  release();
  await syncing; await disconnecting;
  weclaw.beforePut = null;
  assert.equal(weclaw.provider, null);
  assert.equal(link.readState(dataDir).enabled, false);
  await service.sync();
  assert.equal(weclaw.provider, null, '之后的同步也不再写回');
});

test('员工助手没开时断开：记下待移除，打开后自动删掉', async t => {
  const { weclaw, service, dataDir } = setup(t);
  await service.connect();
  weclaw.up = false;
  const r = await service.disconnect();
  assert.equal(r.removed, false);
  assert.equal(link.readState(dataDir).pendingRemove, true);
  assert.equal(describe(await service.status()).linked[1], '待移除');
  weclaw.up = true;
  await service.sync();
  assert.equal(weclaw.provider, null);
  assert.equal(link.readState(dataDir).pendingRemove, false);
});

test('端口没变但钥匙变了、或模型清单变了：同步时重写', async t => {
  const { weclaw, service, env } = setupWith(t);
  await service.connect();
  const puts = () => weclaw.calls.filter(c => c.method === 'PUT').length;
  env.key = 'b'.repeat(48);
  assert.equal((await service.status()).stale, true);
  await service.sync();
  assert.equal(puts(), 2);
  assert.ok(weclaw.provider.options.apiKey.startsWith('b'.repeat(48)));
  env.models = [...MODELS, { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' }];
  await service.sync();
  assert.equal(puts(), 3);
  assert.ok(weclaw.provider.models['deepseek-v4.1-flash-1017']);
  await service.sync();
  assert.equal(puts(), 3, '一致时不重写');
});

test('上游未就绪：不显示全绿', () => {
  const d = describe({ installed: true, running: true, enabled: true, proxy: { state: 'not-ready', port: 1, message: '个人账号未登录' }, linked: { present: true, models: ['x'], pinned: true } });
  assert.equal(d.proxy[1], '上游未就绪');
  assert.equal(d.proxy[2], '个人账号未登录');
  assert.equal(d.linked[1], '已接入，暂不可用');
});

// ---- 第二版：四步清单、版本、在线、跳转、升级、试一次 ----
const { steps } = require('../renderer/weclaw-page');

test('版本比较与找员工助手下载好的安装包', () => {
  assert.equal(link.compareVersions('7.11.100-1130', '7.9.74-0924'), 1);
  assert.equal(link.compareVersions('7.11.100-1130', '7.11.100-1130.1'), -1);
  assert.equal(link.compareVersions('7.9.74', '7.9.74'), 0);
  const pkg = link.findDownloadedInstaller({ env: { APPDATA: 'C:/A' }, readdir: () => ['WeclawDesktop_Setup_7.9.74-0924.exe', 'x.tmp', 'WeclawDesktop_Setup_7.11.100-1130.exe'] });
  assert.equal(pkg.version, '7.11.100-1130');
  assert.match(pkg.file.split(String.fromCharCode(92)).join('/'), /weclaw-desktop\/upgrade-cache\/WeclawDesktop_Setup_7\.11\.100-1130\.exe$/);
  assert.equal(link.findDownloadedInstaller({ env: {}, readdir: () => [] }), null);
});

test('在线检查：自检接口 ok 且带账号才算已登录，页面拿不到账号本身', async () => {
  const mk = body => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  assert.deepEqual(await link.readHealth(mk({ status: 'ok', userId: 'u1' }), 'http://x'), { healthy: true, loggedIn: true });
  assert.deepEqual(await link.readHealth(mk({ status: 'ok' }), 'http://x'), { healthy: true, loggedIn: false });
  assert.deepEqual(await link.readHealth(async () => { throw new Error('down'); }, 'http://x'), { healthy: false, loggedIn: false });
});

test('试一次：解析流式回复，量首字', async () => {
  let t = 1000;
  const lines = ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n', 'data: {"choices":[{"delta":{"content":"收"}}]}\n', 'data: {"choices":[{"delta":{"content":"到"}}]}\n', 'data: [DONE]\n'];
  const fetchImpl = async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:5555\/v1\/chat\/completions$/);
    assert.equal(init.headers.Authorization, 'Bearer k.weclaw__pin_personal');
    return { ok: true, status: 200, body: (async function* () { for (const l of lines) { t += 400; yield Buffer.from(l); } })() };
  };
  const r = await link.probeModel({ fetchImpl, port: 5555, key: 'k.weclaw__pin_personal', model: 'Glm-5.3', now: () => t });
  assert.equal(r.ok, true);
  assert.equal(r.firstTokenMs, 800);
  assert.equal(r.reply, '收到');
  const bad = await link.probeModel({ fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'upstream' }), port: 1, key: 'k', model: 'm' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /upstream/);
});

function setupV2(t, opts = {}) {
  const ctx = setup(t);
  const calls = { open: 0, external: [], installer: [] };
  Object.assign(ctx.service, {
    openPath: async () => { calls.open += 1; ctx.weclaw.up = true; return ''; },
    openExternal: async url => { calls.external.push(url); },
    readVersion: async () => opts.installed ?? '7.9.74-0924',
    findInstaller: () => (opts.noPkg ? null : { version: '7.11.100-1130', file: 'C:/A/WeclawDesktop_Setup_7.11.100-1130.exe' }),
    verifySignature: async () => ({ ok: opts.sigOk !== false, detail: opts.sigOk === false ? 'NotSigned' : 'Valid' }),
    stage: file => file,
    runInstaller: async file => { calls.installer.push(file); ctx.weclaw.up = false; return opts.installerCode ?? 0; },
    probe: async ({ model }) => ({ ok: true, firstTokenMs: 1900, totalMs: 2400, model, reply: '收到' }),
    relaunchDelayMs: 0,
  });
  return { ...ctx, calls };
}

test('四步：新版已下载时第 1 步要升级；升级核签名、跑安装包、装完重新打开员工助手', async t => {
  const { service, calls } = setupV2(t);
  let s = await service.status();
  assert.equal(s.version.upgradeAvailable, true);
  assert.equal(steps(s)[0].action.op, 'upgrade');
  const r = await service.upgrade();
  assert.equal(r.started, true);
  await service.upgradeDone;
  assert.equal(calls.installer.length, 1);
  assert.equal(calls.open, 1, '装完员工助手没开着，自动重新打开');
  assert.equal(service.lastUpgrade.ok, true);
});

test('四步：签名不对不装', async t => {
  const { service, calls } = setupV2(t, { sigOk: false });
  await assert.rejects(service.upgrade(), /签名/);
  assert.equal(calls.installer.length, 0);
});

test('四步：全新用户从头走到全绿；跳转用员工助手自己的协议', async t => {
  const { service, weclaw, calls } = setupV2(t, { installed: '7.11.100-1130' });
  weclaw.up = false;
  let st = steps(await service.status());
  assert.deepEqual(st.map(x => x.state), ['done', 'todo', 'todo', 'todo']);
  assert.equal(st[1].action.op, 'open');
  assert.equal(st[3].action.disabled, true, '没接入不能试');
  await service.open();
  assert.equal(calls.open, 1);
  st = steps(await service.status());
  assert.equal(st[1].state, 'todo', '假服务的自检没带账号，算没登录');
  await service.connect();
  const r = await service.test();
  assert.equal(r.firstTokenMs, 1900);
  st = steps(await service.status());
  assert.equal(st[2].state, 'done');
  assert.equal(st[3].state, 'done');
  assert.match(st[3].detail, /首字 1\.9 秒/);
  await service.newChat();
  assert.deepEqual(calls.external, ['weclaw://home/chat']);
});

test('四步：没接入时试一次直接报原因', async t => {
  const { service } = setupV2(t);
  await assert.rejects(service.test(), /接入 HUB-H/);
});

// ---- 审查补测（Codex 第 3 轮）----
test('升级：连点两下只起一个安装程序；签名失败也释放占位', async t => {
  const { service, calls } = setupV2(t);
  const [a, b] = await Promise.all([service.upgrade(), service.upgrade()]);
  await service.upgradeDone;
  assert.equal([a, b].filter(r => r.started).length, 1);
  assert.equal(calls.installer.length, 1);
  const bad = setupV2(t, { sigOk: false });
  await assert.rejects(bad.service.upgrade(), /签名/);
  assert.equal(bad.service.upgrading, null);
  assert.match(bad.service.lastUpgrade.error, /签名/);
});

test('升级：用户拒绝管理员权限报失败，不报成功', async t => {
  const { service, calls } = setupV2(t, { installerCode: 1223 });
  await service.upgrade(); await service.upgradeDone;
  assert.equal(service.lastUpgrade.ok, false);
  assert.match(service.lastUpgrade.error, /管理员权限/);
  assert.equal(calls.open, 0);
});

test('试一次：收到 [DONE] 就结束，不等连接关闭', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, body: (async function* () {
    yield Buffer.from(['data: {"choices":[{"delta":{"content":"收到"}}]}', '', 'data: [DONE]', ''].join(String.fromCharCode(10)));
    await new Promise(() => {}); // 连接一直不关
  })() });
  const r = await link.probeModel({ fetchImpl, port: 1, key: 'k', model: 'm', timeoutMs: 3000 });
  assert.equal(r.ok, true);
  assert.equal(r.reply, '收到');
});

test('四步：旧的测试结果在端口变了或代理没跑时不算全绿；本机服务不正常不算已登录', () => {
  const base = { installed: true, running: true, online: { healthy: true, loggedIn: true }, enabled: true, version: { installed: '7.11.100' },
    proxy: { state: 'running', port: 2 }, linked: { present: true, models: ['a'], pinned: true }, lastTest: { ok: true, firstTokenMs: 1000, totalMs: 1500, label: 'GLM', port: 1 } };
  assert.equal(steps(base)[3].state, 'todo');
  assert.equal(steps({ ...base, lastTest: { ...base.lastTest, port: 2 } })[3].state, 'done');
  assert.equal(steps({ ...base, lastTest: { ...base.lastTest, port: 2 }, proxy: { state: 'stopped', port: 0 } })[3].state, 'todo');
  assert.equal(steps({ ...base, online: { healthy: false, loggedIn: true } })[1].state, 'todo');
  assert.match(steps(base)[0].detail, /没有待安装的新版/);
});
