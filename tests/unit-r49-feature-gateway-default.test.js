'use strict';
// R49-2（2026-11-26）：只配了部门 key、没有可用 CodeAgent（没装或没有模型权限）的人，8 项会话功能和 PPT 库地图没选过时
// 默认走部门 key；用户手动选过的不变；有 CodeAgent 的老用户默认不变；设置页写明「默认：部门 API key（未检测到 CodeAgent）」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CodeAgent 配置目录指到空的临时目录，不读本机真实的 CodeAgent 自配模型。
process.env.AI_HUB_CODEAGENT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-cac-'));
const gateway = require('../core/api-gateway');
const route = require('../core/assistant-gateway-route');
const choice = require('../core/feature-agent-choice');
const routes = require('../core/codeagent-assistant-route');
const fakeSafe = require('./helpers/fake-safe-storage');

const KEY = 'sk-dept-r49-0123456789';
const MODELS = ['deepseek-v4.1-flash', 'qwen-aw-35b'];
const SESSION_FEATURES = ['assistant', 'ppt', 'pptMake', 'pptImgtext', 'avatar', 'forum', 'meeting', 'text'];
const GW = { kind: 'api-gateway', model: '' };
function tempDir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-fa-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
async function withKey(dir) {
  const impl = async (url, init = {}) => {
    if (init.headers?.authorization !== 'Bearer ' + KEY) return new Response('{}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS.map(id => ({ id })) }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  assert.equal((await gateway.save(dir, { apiKey: KEY }, { safeStorage: fakeSafe, fetchImpl: impl })).ok, true);
}
const harness = kind => ({ kind, label: kind, harness: true, available: true, defaultModel: MODELS[0], defaultSource: 'gateway',
  models: MODELS.map(id => ({ id, source: 'gateway' })) });
const backends = codeagent => [{ kind: 'codeagent', available: codeagent, models: codeagent ? [{ id: 'GLM-5.2-WX-Auto' }] : [] },
  { kind: 'codeagent-lite', available: codeagent, models: [] }, harness('claude'), harness('codex'),
  { kind: 'api-gateway', available: true, defaultModel: MODELS[0], models: MODELS.map(id => ({ id })) }];

test('没装 CodeAgent + 部门 key：8 项会话功能都默认部门 key，PPT 库地图默认 Claude Code 外壳经部门 key', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const b = backends(false);
  for (const id of SESSION_FEATURES) {
    const r = choice.resolve(dir, id, { backends: b });
    assert.deepEqual(r.selected, GW, id); assert.equal(r.auto, true, id);
  }
  assert.deepEqual(choice.resolve(dir, 'pptMap', { backends: b }).selected, { kind: 'claude', model: MODELS[0], source: 'gateway' });
  // 没有 Claude Code 只有 Codex：库地图用 Codex 外壳
  assert.equal(choice.resolve(dir, 'pptMap', { backends: b.filter(x => x.kind !== 'claude') }).selected.kind, 'codex');
  // 设置页：默认值写部门 key，并标出是自动默认
  const st = choice.state(dir, { backends: b });
  for (const id of [...SESSION_FEATURES, 'pptMap']) {
    const f = st.features.find(x => x.id === id);
    assert.equal(f.auto, true, id); assert.match(f.defaultText, /^部门 API key/, id);
  }
  // 单次功能「问问 Hub」不在这次范围里，默认不变
  assert.equal(choice.resolve(dir, 'help', { backends: b }).selected, null);
});

test('用户手动选过的值不变：选了 CodeAgent 的那项不被自动改走部门 key', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  routes.setFeaturePreference(dir, 'forum', { kind: 'codeagent', model: '' });
  routes.setFeaturePreference(dir, 'pptMap', { kind: 'codeagent', model: '' });
  const b = backends(false);
  for (const id of ['forum', 'pptMap']) {
    const r = choice.resolve(dir, id, { backends: b });
    assert.deepEqual(r.choice, { kind: 'codeagent', model: '' }, id);
    assert.notEqual(r.auto, true, id);
    assert.notDeepEqual(r.selected, GW, id);
  }
  assert.deepEqual(choice.resolve(dir, 'ppt', { backends: b }).selected, GW, '没选过的照常自动');
});

test('有 CodeAgent 的老用户：存过部门 key 也不改默认', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const b = backends(true);
  for (const id of [...SESSION_FEATURES, 'pptMap']) {
    const r = choice.resolve(dir, id, { backends: b });
    assert.equal(r.selected, null, id); assert.notEqual(r.auto, true, id);
  }
  // 真实判定（不传目录）：查得到 codeagent、模型清单还没读到过 → 按「有」处理
  const find = kind => (kind === 'codeagent' || kind === 'claude' ? 'C:/x/' + kind + '.exe' : null);
  assert.equal(route.autoDefault(dir, { findCommand: find }), false);
  assert.equal(route.codeagentMissing(dir, { findCommand: find }), false);
  // 没存部门 key：谁都不自动
  const bare = tempDir(t);
  assert.equal(choice.resolve(bare, 'forum', { backends: [...backends(false).slice(0, -1), { kind: 'api-gateway', available: false, models: [] }] }).selected, null);
  assert.equal(choice.resolve(bare, 'pptMap', { backends: backends(false) }).selected, null);
});

test('装了 CodeAgent 但没有模型权限（个人号清单里的模型都报没权限、号池没有号）：同样默认走部门 key', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  fs.mkdirSync(path.join(dir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codeagent-pool', 'personal-models.json'), JSON.stringify({ models: ['GLM-5.2-WX-Auto'], source: 'serve', at: new Date().toISOString() }));
  const find = kind => (kind === 'codeagent' || kind === 'claude' ? 'C:/x/' + kind + '.exe' : null);
  assert.equal(route.codeagentMissing(dir, { findCommand: find }), false, '清单里的模型还能用：算有 CodeAgent');
  require('../core/codeagent-quota').markModelAvoid(dir, 'personal', { model: 'GLM-5.2-WX-Auto', reason: 'model-not-found' });
  assert.equal(route.codeagentMissing(dir, { findCommand: find }), true, '清单里的模型都报没权限');
  assert.equal(route.autoDefault(dir, { findCommand: find }), true);
  assert.deepEqual(choice.resolve(dir, 'ppt', { backends: backends(true) }).selected, GW);
  assert.equal(choice.resolve(dir, 'pptMap', { backends: backends(true) }).selected.source, 'gateway');
  // 号池里登记了号：可能用号池的号，不算没有 CodeAgent
  fs.writeFileSync(path.join(dir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'acc12345', note: '' }] }));
  assert.equal(require('../core/codeagent-pool').readRegistry(dir).accounts.length, 1);
  assert.equal(route.codeagentMissing(dir, { findCommand: find }), false);
});

test('本机反代常驻：有任一项没选过且会自动走部门 key 时常驻', async t => {
  const dir = tempDir(t);
  await withKey(dir);
  const claudeOnly = { findCommand: kind => (kind === 'claude' ? 'C:/x/claude.exe' : null) };
  routes.setFeaturePreference(dir, 'assistant', { kind: 'codeagent', model: '' });
  assert.equal(route.inUse(dir, claudeOnly), true);
});
