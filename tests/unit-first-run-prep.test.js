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
  systemProxy: async () => 'DIRECT', clockSkew: async () => 1000, ...over,
});
const run = (over, mode, isCompany = true) => prep.createPrep({ isCompany, deps: good(over) }).run(mode);

test('模型清单：成功结果里的空 skipped 数组不表示跳过，只有布尔 true 才跳过', async () => {
  const success = await run({ readModels: async () => ({ ok: true, models: ['GLM', 'DeepSeek'], skipped: [] }) });
  assert.equal(success.rows.models.status, 'ok');
  assert.equal(success.rows.models.detail, 'GLM、DeepSeek');
  const skipped = await run({ readModels: async () => ({ skipped: true }) });
  assert.equal(skipped.rows.models.status, 'off');
});

test('什么时候显示：没做过全屏，指纹变了只同步，有遗留问题小提示，其余不打扰', () => {
  assert.equal(prep.decide(null, fp), 'full');
  assert.equal(prep.decide({ schema: prep.SCHEMA - 1, fingerprint: fp }, fp), 'full');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, fp), 'none');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, { ...fp, size: 11 }), 'changed');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: null, problems: [] }, fp), 'changed', '后来才装上 CodeAgent');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: [] }, null), 'none', 'CodeAgent 不见了不在打开时打扰');
  assert.equal(prep.decide({ schema: prep.SCHEMA, fingerprint: fp, problems: ['login'] }, fp), 'remind');
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
test('不再有下载服务器放行一项（R35）；没开公司模型时相关项不适用；个人版没有公司项', async () => {
  const r0 = await run({});
  assert.equal(r0.rows['net-pass'], undefined);
  const off = await run({ proxyEnabled: () => false });
  assert.equal(off.rows.hello.status, 'off'); assert.deepEqual(off.problems, []);
  const personal = await run({}, 'full', false);
  assert.equal(personal.rows.hello, undefined);
});
test('可选工具没装不算问题，手动选择按钮说人话', async () => {
  const r = await run({ envCheck: async () => ({ ok: true, items: [{ id: 'welink', status: 'bad', installed: false, detail: '没找到', fixes: [{ label: '一键安装', act: 'x' }] },
    { id: 'codeagent', status: 'bad', detail: '没找到', fixes: [{ label: '打开 CodeAgent 设置', act: 'open-codeagent' }] }] }) });
  assert.equal(r.rows.welink.status, 'off'); assert.deepEqual(r.rows.welink.fixes, []);
  assert.deepEqual(r.problems, ['codeagent']); assert.equal(r.rows.codeagent.fixes[0].label, '已装，手动选择');
});

test('可选工具已安装但有提醒时保留真实说明，不计入未就绪', async () => {
  let saved;
  const items = [
    { id: 'welink', status: 'warn', detail: '找到了，但 WeLink 登录已过期 · v1.0.20', cause: '登录令牌过期' },
    { id: 'ppt-doctor', status: 'warn', detail: '已检测到 v1，版本太旧，和 Hub 联动不上' },
    { id: 'claude', status: 'warn', detail: '找到了，但版本号没读出来' },
    { id: 'dsh', status: 'warn', installed: false, detail: '没装' },
    { id: 'node', status: 'off', installed: false, detail: '没装，用到时再装' },
  ];
  const r = await run({ envCheck: async () => ({ items }), saveState: s => { saved = s; } });
  for (const item of items) {
    assert.equal(r.rows[item.id].status, 'off');
    assert.equal(r.rows[item.id].detail, item.installed === false ? '没装，用到时再装' : [item.detail, item.cause].filter(Boolean).join('：'));
  }
  assert.deepEqual(saved.problems, []); assert.deepEqual(r.problems, []);
});
test('CodeAgent 变化只重做受影响的项', async () => {
  let proxies = 0;
  const r = await run({ systemProxy: async () => { proxies++; return 'DIRECT'; } }, 'changed');
  assert.equal(proxies, 0);
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

test('读模型太慢不拖住，默认模型不行换下一个；指纹读文件', async () => {
  let n = 0;
  const hit = await prep.helloAny({ port: 1, key: 'k', models: ['A', 'B'], ask: async ({ model }) => { n++; return model === 'B' ? { ok: true, model, answer: 'OK' } : { ok: false, error: 'no' }; } });
  assert.equal(hit.model, 'B'); assert.equal(n, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), f = path.join(dir, 'x.exe');
  fs.writeFileSync(f, 'abc');
  assert.equal(prep.fingerprint(f).size, 3); assert.equal(prep.fingerprint(path.join(dir, 'no')), null);
  assert.equal(prep.writeState(dir, { schema: 1 }), true); assert.equal(prep.readState(dir).schema, 1);
});

test('手动选 CodeAgent 只经定位中心记账：弹框走 harness:pick-path，已知路径走 harness:set-path，不再调旧的 tool-discovery:pick', async () => {
  const { pickCodeAgent } = require('../renderer/first-run-codeagent-pick');
  const calls = [];
  const ipc = answer => ({ invoke: async (ch, req) => { calls.push([ch, req]); return answer; } });
  assert.deepEqual(await pickCodeAgent(ipc(null)), { canceled: true });
  assert.deepEqual(calls.pop(), ['harness:pick-path', { id: 'codeagent' }]);
  const ok = { verdict: 'ok', chosen: { path: 'C:\CA\codeagent.exe' } };
  assert.equal((await pickCodeAgent(ipc(ok), { act: 'open-codeagent', path: 'C:\CA\codeagent.exe' })).ok, true);
  assert.deepEqual(calls.pop(), ['harness:set-path', { id: 'codeagent', path: 'C:\CA\codeagent.exe' }]);
  const bad = await pickCodeAgent(ipc({ verdict: 'broken', reasonCode: 'manual-path-failed', reason: '你选的 X 没通过试跑' }));
  assert.equal(bad.ok, false); assert.match(bad.error, /没通过试跑/);
  assert.equal((await pickCodeAgent(ipc({ ok: false, error: '不认识的 CLI' }))).error, '不认识的 CLI');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'first-run-prep.js'), 'utf8');
  assert.ok(!src.includes('tool-discovery:pick'), '首次准备不再走旧的记账口');
  assert.match(src, /first-run-codeagent-pick'\)\.pickCodeAgent\(ipcRenderer, fix\)/);
});
