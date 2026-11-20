'use strict';

// 反代模型跟 CodeAgent 模型目录保持一致（2026-11-20 同事反馈：CodeAgent 能选 GLM-5.3，经反代的 Claude Code / Codex 只有 5.2）。
// 目录解析与名字匹配、Hub 侧清单现读缓存、反代进程按缓存目录放行新模型（合成上游，不连公司网络）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = path.join(__dirname, '..', 'core', 'company-proxy');
const catalog = require('../core/company-proxy/model-catalog.cjs');

// 黄区真机 2026-11-20 个人号目录的形状（只留解析用到的字段），外加按同事菜单名拼的 5.3 项。
const REAL = [
  { name: 'GLM-5.2-WX-Auto', modelId: 'GLM-5.2-WX-Auto', context: 202752, input: 169984, output: 32768, modalities: '{"input":["text"],"output":["text"]}',
    routModels: [{ name: 'GLM-5.2-WX', modelId: 'GLM-5.2-WX', modelLevel: 'large', input: 169984, output: 32768 },
      { name: 'Qwen3.6-27B-CodeAgent', modelId: 'Qwen3.6-27B-CodeAgent-VL', modelLevel: 'small', input: 169984, output: 32768 }] },
  { name: 'deepseek-v4.1-flash-1017', modelId: 'deepseek-v4.1-flash-1017', context: 409600, input: 344064, output: 65536, modalities: '{"input":["text"],"output":["text"]}' },
];
const COLLEAGUE = [
  { name: 'GLM-5.3-Auto(Volcano-MaaS)', modelId: 'GLM-5.3-Auto(Volcano-MaaS)', input: 169984, output: 32768,
    routModels: [{ modelId: 'maas-glm-5-3-260814', modelLevel: 'large' }, { modelId: 'Qwen3.6-27B-CodeAgent-VL', modelLevel: 'small' }] },
  ...REAL,
];

test('目录解析：-Auto 项取 large 主模型当上游名，显示名用菜单名；不展开 small 分流模型', () => {
  const models = catalog.parseCatalog(REAL);
  assert.deepEqual(models.map(m => m.id), ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017'], '和以前写死的两个完全一致');
  assert.equal(models[0].menuId, 'GLM-5.2-WX-Auto');
  assert.equal(models[0].label, 'GLM-5.2-WX');
  assert.equal(models[0].input, 169984);
  assert.equal(models[0].thinking, true);
  const c = catalog.parseCatalog(COLLEAGUE);
  assert.equal(c[0].id, 'maas-glm-5-3-260814');
  assert.equal(c[0].label, 'GLM-5.3（Volcano-MaaS）');
  assert.throws(() => catalog.parseCatalog({ nope: 1 }), /CATALOG_SHAPE_INVALID/);
});

test('名字匹配：要 5.3 给 5.3、目录没有的版本明说、不认识的名字走默认、下线旧版本只升不降', () => {
  const list = catalog.parseCatalog(COLLEAGUE);
  const r = name => catalog.resolveModel(name, list);
  assert.equal(r('glm-5.3').id, 'maas-glm-5-3-260814');
  assert.equal(r('GLM-5.3-Auto(Volcano-MaaS)').id, 'maas-glm-5-3-260814', '按 CodeAgent 菜单名也认');
  assert.equal(r('GLM-5.2-WX-Auto').id, 'GLM-5.2-WX');
  assert.equal(r('GLM-5.2-WX').how, 'exact');
  assert.equal(r('deepseek').id, 'deepseek-v4.1-flash-1017');
  assert.equal(r('claude-haiku-4-5').id, 'GLM-5.2-WX', 'Claude Code 后台小请求落到默认：有 GLM-5.2-WX 就一直是它，不随目录顺序变');
  assert.equal(catalog.defaultModel(catalog.parseCatalog(COLLEAGUE.slice(0, 1))).id, 'maas-glm-5-3-260814', '没有 5.2 时取版本最高的 GLM');
  const variants = [{ id: 'deepseek-v4.1-flash-1017', menuId: 'deepseek-v4.1-flash-1017' }, { id: 'deepseek-v4.1-pro-1120', menuId: 'deepseek-v4.1-pro-1120' }];
  assert.equal(catalog.resolveModel('deepseek-v4.1-pro', variants).id, 'deepseek-v4.1-pro-1120', '同版本多个变体按名字挑');
  assert.equal(catalog.resolveModel('deepseek-v4.1-flash', variants).id, 'deepseek-v4.1-flash-1017');
  assert.equal(catalog.parseCatalog([{ modelId: 'GLM-9-Auto' }]).length, 0, '没有 routModels 的 -Auto 项不列');
  assert.throws(() => r('glm-5.9'), e => e.code === 'MODEL_NOT_IN_CATALOG' && /glm-5\.9/.test(e.message));
  const only53 = catalog.parseCatalog(COLLEAGUE.slice(0, 1));
  assert.deepEqual(catalog.resolveModel('GLM-5.2-WX', only53), { id: 'maas-glm-5-3-260814', how: 'retired-upgrade' });
  assert.throws(() => catalog.resolveModel('deepseek-v4.1', only53), e => e.code === 'MODEL_NOT_IN_CATALOG', '整个家族都没有：报错不换家族');
});

test('Hub 侧清单现读反代存的目录；没有目录时是内置的两个', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-hub-'));
  try {
    const proxy = require('../core/company-model-proxy');
    assert.deepEqual(proxy.companyModelIds(dataDir), ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017']);
    catalog.writeCache(dataDir, { schema: 1, at: Date.now(), accounts: {
      personal: { at: Date.now(), models: catalog.parseCatalog(REAL) }, abc1234: { at: Date.now(), models: catalog.parseCatalog(COLLEAGUE) } } });
    assert.deepEqual(proxy.companyModelIds(dataDir), ['GLM-5.2-WX', 'deepseek-v4.1-flash-1017', 'maas-glm-5-3-260814'], '个人号在前，号池补上');
    assert.equal(proxy.normalizeModel('glm-5.3', dataDir), 'maas-glm-5-3-260814');
    assert.throws(() => proxy.normalizeModel('glm-5.9', dataDir), /没有 glm-5\.9/);
    assert.equal(proxy.launchModel('glm-5.9', { dataDir }), 'GLM-5.2-WX', '启动时不认识的落到默认、不报错（同以前）');
    const codex = proxy.codexCatalog(proxy.companyModelIds(dataDir), undefined, proxy.companyModels(dataDir));
    assert.equal(codex.models.length, 3);
    assert.equal(codex.models[0].context_window, 128000, '上下文不超过以前的 128000');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

function startProxy(dataDir, key) {
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs'), '--data-dir', dataDir, '--port', '0', '--mock-upstream', '--parent-pid', String(process.pid)],
    { env: { ...process.env, AI_HUB_COMPANY_PROXY_KEY: key, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const stateFile = path.join(dataDir, 'company-model-proxy', 'proxy-state.json');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      try { const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (state.pid === child.pid) { clearInterval(poll); resolve({ child, port: state.port, log: () => log }); } } catch { /* not yet */ }
      if (Date.now() - started > 15000) { clearInterval(poll); child.kill(); reject(new Error('proxy did not start: ' + log)); }
    }, 50);
  });
}

test('反代进程：按目录列模型、新模型直接可用、Qwen 去掉思考参数、目录外版本回 422 不悄悄换成 5.2', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-proxy-'));
  const key = 'k'.repeat(40);
  catalog.writeCache(dataDir, { schema: 1, at: Date.now(), accounts: { personal: { at: Date.now(), models: [
    ...catalog.parseCatalog(COLLEAGUE), { id: 'Qwen3.6-27B-CodeAgent-VL', label: 'Qwen3.6', menuId: 'Qwen3.6-27B-CodeAgent-VL' }] } } });
  const { child, port, log } = await startProxy(dataDir, key);
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${key}.s1`, 'content-type': 'application/json' };
  const claude = (model, extra = {}) => fetch(base + '/v1/messages', { method: 'POST', headers: auth,
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extra }) });
  try {
    const list = await (await fetch(base + '/v1/models', { headers: auth })).json();
    assert.deepEqual(list.data.map(m => m.id), ['maas-glm-5-3-260814', 'GLM-5.2-WX', 'deepseek-v4.1-flash-1017', 'Qwen3.6-27B-CodeAgent-VL']);
    let r = await claude('glm-5.3', { thinking: { type: 'enabled', budget_tokens: 1024 } });
    assert.equal(r.status, 200, log()); await r.text();
    r = await claude('Qwen3.6-27B-CodeAgent-VL', { thinking: { type: 'enabled', budget_tokens: 1024 } });
    assert.equal(r.status, 200, log()); await r.text();
    r = await claude('glm-5.9');
    assert.equal(r.status, 422);
    assert.match((await r.json()).error.message, /没有 glm-5\.9/);
    const status = await (await fetch(base + '/admin/status', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.mockUpstream.byModel['maas-glm-5-3-260814'], 1);
    assert.equal(status.mockUpstream.byModel['Qwen3.6-27B-CodeAgent-VL'], 1);
    assert.equal(status.mockUpstream.byModel['GLM-5.2-WX'], undefined, '没有一条被悄悄换成 5.2');
    assert.equal(status.mockUpstream.thinkingRequests, 1, '只有 GLM 那条带思考');
    assert.equal(status.modelCatalog.source, 'catalog');
  } finally {
    try { await fetch(base + '/admin/shutdown', { method: 'POST', headers: { authorization: `Bearer ${key}` } }); } catch { /* gone */ }
    await new Promise(r => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(() => { child.kill(); r(); }, 5000); } });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
