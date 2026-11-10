'use strict';
// 首次启动准备：什么时候显示、一步失败不拖累其他步、依赖没好时不空跑。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const prep = require('../core/first-run-prep');

const fp = { path: 'C:\\A\\bin\\codeagentcli.exe', size: 10, mtimeMs: 5 };
const good = (over = {}) => ({
  discover: async () => {}, codeagentFile: () => fp.path, fingerprint: () => fp, readState: () => null, saveState: () => true,
  envCheck: async () => ({ ok: true, items: [{ id: 'codeagent', status: 'ok', detail: 'v1' }, { id: 'disk', status: 'ok', detail: '86 GB' }] }),
  loginState: async () => 'ready', readModels: async () => ({ ok: true, models: ['GLM'] }),
  proxyEnabled: () => true, proxyReady: async () => ({ state: 'running', zone: { zone: 'green', text: '绿区' }, accounts: [], firstInit: { ran: true } }),
  hello: async () => ({ ok: true, model: 'GLM', answer: 'OK' }),
  netPass: async () => ({ available: true, hosts: [{ state: 'ok', page: 'https://a/' }] }), systemProxy: async () => 'DIRECT', clockSkew: async () => 1000, ...over,
});
const run = (over, mode, isCompany = true) => prep.createPrep({ isCompany, deps: good(over) }).run(mode);

test('什么时候显示：没做过全屏，指纹变了只同步，有遗留问题小提示，其余不打扰', () => {
  assert.equal(prep.decide(null, fp), 'full');
  assert.equal(prep.decide({ schema: prep.SCHEMA - 1, fingerprint: fp }, fp), 'full');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, fp), 'none');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, { ...fp, size: 11 }), 'changed');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: null, problems: [] }, fp), 'changed', '后来才装上 CodeAgent');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, null), 'none', 'CodeAgent 不见了不在打开时打扰');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: ['net-pass'] }, fp), 'remind');
});
test('全部顺利：真实问答通过，存下结果', async () => {
  let saved = null;
  const r = await run({ saveState: s => { saved = s; } });
  assert.deepEqual(r.problems, []); assert.deepEqual(r.held, []);
  assert.equal(r.rows.hello.status, 'ok'); assert.equal(r.rows.sign.status, 'ok');
  assert.equal(saved.schema, prep.SCHEMA); assert.deepEqual(saved.fingerprint, fp);
});
test('没装 CodeAgent：后面依赖它的等待，不去启动反代也不发问', async () => {
  let started = 0;
  const r = await run({ codeagentFile: () => '', proxyReady: async () => { started++; return {}; }, hello: async () => { started++; return {}; },
    envCheck: async () => ({ ok: true, items: [{ id: 'codeagent', status: 'bad', detail: '没找到', fixes: [{ label: '打开下载页', act: 'open-url' }] }] }) });
  assert.equal(started, 0);
  assert.deepEqual(r.problems, ['codeagent']);
  for (const id of ['login', 'models', 'proxy', 'sign', 'hello']) assert.equal(r.rows[id].status, 'hold', id);
});
test('一步抛错只影响它自己', async () => {
  const r = await run({ systemProxy: async () => { throw new Error('boom'); }, envCheck: async () => { throw new Error('env'); } });
  assert.equal(r.rows['sys-proxy'].status, 'warn'); assert.equal(r.rows.disk.status, 'warn');
  assert.equal(r.rows.hello.status, 'ok');
});
test('通道没起来：说清原因，问答等待；启动失败时试一次重新读配置', async () => {
  let reloads = 0;
  const r = await run({ proxyReady: async () => ({ state: 'not-ready', message: '公司上游信息不全' }), proxyReload: async () => { reloads++; return { state: 'not-ready', message: '公司上游信息不全' }; } });
  assert.equal(reloads, 1); assert.equal(r.rows.proxy.status, 'bad'); assert.match(r.rows.proxy.detail, /信息不全/); assert.equal(r.rows.hello.status, 'hold');
});
test('被拦没放行成功给放行按钮；没开公司模型时相关项不适用；个人版没有公司项', async () => {
  const blocked = await run({ netPass: async () => ({ available: true, hosts: [{ state: 'blocked', page: 'https://x/' }] }) });
  assert.equal(blocked.rows['net-pass'].status, 'bad'); assert.equal(blocked.rows['net-pass'].fixes[0].act, 'open-gate');
  const off = await run({ proxyEnabled: () => false });
  assert.equal(off.rows.hello.status, 'off'); assert.deepEqual(off.problems, []);
  const personal = await run({}, 'full', false);
  assert.equal(personal.rows.hello, undefined);
});
test('可选工具没装不算问题，手动选择按钮说人话', async () => {
  const r = await run({ envCheck: async () => ({ ok: true, items: [{ id: 'welink', status: 'bad', detail: '没找到', fixes: [{ label: '一键安装', act: 'x' }] },
    { id: 'codeagent', status: 'bad', detail: '没找到', fixes: [{ label: '打开 CodeAgent 设置', act: 'open-codeagent' }] }] }) });
  assert.equal(r.rows.welink.status, 'off'); assert.deepEqual(r.rows.welink.fixes, []);
  assert.deepEqual(r.problems, ['codeagent']); assert.equal(r.rows.codeagent.fixes[0].label, '已装，手动选择');
});
test('CodeAgent 变化只重做受影响的项', async () => {
  let net = 0;
  const r = await run({ netPass: async () => { net++; return null; } }, 'changed');
  assert.equal(net, 0);
  assert.deepEqual(Object.keys(r.rows).sort(), ['codeagent', 'login', 'hello', 'models', 'proxy', 'sign'].sort());
});

test('CodeAgent 新装或更新后仍检查登录，未登录不能报同步成功', async () => {
  let reads = 0;
  const r = await run({ loginState: async () => 'missing', readModels: async () => { reads++; return {}; } }, 'changed');
  assert.ok(r.problems.includes('login'));
  assert.equal(r.rows.login.fixes[0].act, 'codeagent-login');
  assert.equal(r.rows.login.fixes[0].label, '一键登录');
  assert.equal(r.rows.models.status, 'hold');
  assert.equal(reads, 0);
});

test('环境体检、登录和模型读取不等下载服务器放行', async () => {
  let release, checked = 0, passed = false, loggedIn = 0, models = 0;
  const gate = new Promise(resolve => { release = () => { passed = true; resolve(null); }; });
  const pending = run({ netPass: () => gate, loginState: async () => { loggedIn++; return 'ready'; },
    readModels: async () => { models++; return { ok: true, models: ['GLM'] }; }, envCheck: async () => {
    checked++; assert.equal(passed, false);
    return { ok: true, items: [{ id: 'app-update', status: 'ok', detail: '可用' }] };
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checked, 1); assert.equal(loggedIn, 1); assert.equal(models, 1);
  release();
  const result = await pending;
  assert.equal(checked, 1); assert.equal(result.rows['app-update'].status, 'ok');
});

test('放行失败也继续检查更新源，其余准备项照常结束', async () => {
  let checked = false;
  const result = await run({ netPass: async () => { throw new Error('网络错误'); },
    envCheck: async () => { checked = true; return { ok: true, items: [{ id: 'app-update', status: 'bad', detail: '连不上' }] }; } });
  assert.equal(checked, true); assert.equal(result.rows['net-pass'].status, 'warn');
  assert.equal(result.rows['app-update'].status, 'bad'); assert.equal(result.rows.login.status, 'ok');
});
test('读模型太慢不拖住，默认模型不行换下一个；指纹读文件', async () => {
  let n = 0;
  const hit = await prep.helloAny({ port: 1, key: 'k', models: ['A', 'B'], ask: async ({ model }) => { n++; return model === 'B' ? { ok: true, model, answer: 'OK' } : { ok: false, error: 'no' }; } });
  assert.equal(hit.model, 'B'); assert.equal(n, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), f = path.join(dir, 'x.exe');
  fs.writeFileSync(f, 'abc');
  assert.equal(prep.fingerprint(f).size, 3); assert.equal(prep.fingerprint(path.join(dir, 'no')), null);
  assert.equal(prep.writeState(dir, { schema: 1 }), true); assert.equal(prep.readState(dir).schema, 1);
});
