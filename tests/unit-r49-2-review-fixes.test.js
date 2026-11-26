'use strict';
// R49-2 审查（Antigravity job 20261126-234132-f9e27f）2 个 P1 的回归：撤掉对应修复，这里的用例会失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CodeAgent 配置目录指到空的临时目录，不读本机真实的 CodeAgent 自配模型。
process.env.AI_HUB_CODEAGENT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r49b-cac-'));
const route = require('../core/assistant-gateway-route');
const pool = require('../core/codeagent-pool');
const probe = require('../core/codeagent-model-probe');
const Q = require('../core/codeagent-quota');
const gateway = require('../core/api-gateway');
const fakeSafe = require('./helpers/fake-safe-storage');

const KEY = 'sk-dept-r49b-0123456789';
const MODEL = 'GLM-5.2-WX-Auto';
const withCodeagent = { findCommand: kind => (kind === 'codeagent' || kind === 'claude' ? 'C:/x/' + kind + '.exe' : null) };
function tempDir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r49b-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const writeCatalog = dir => probe.writeProbed(pool.personalModelsFile(dir), { models: [MODEL], source: 'serve' });

test('P1-1 情形 A：serve 连上了、清单是空的 → 算没有可用 CodeAgent；之后读到非空清单就恢复', t => {
  const dir = tempDir(t);
  assert.equal(route.codeagentMissing(dir, withCodeagent), false, '从没读过清单：按「有」处理');
  probe.writeEmptyCatalog(pool.personalModelsFile(dir));
  assert.equal(route.codeagentMissing(dir, withCodeagent), true, '读到过空清单');
  writeCatalog(dir);
  assert.equal(route.codeagentMissing(dir, withCodeagent), false, '后来读到了模型：空清单标记清掉');
  // 先有旧的非空清单、后来又读到空清单：以新的为准
  probe.writeEmptyCatalog(pool.personalModelsFile(dir), { now: Date.now() + 60_000 });
  assert.equal(route.codeagentMissing(dir, withCodeagent), true);
});

test('P1-1 情形 B：清单里有模型、调用都报没权限（真实写入带 have）→ 算没有；6 小时试探期过了也不翻回；一次成功回答解除后恢复', t => {
  const dir = tempDir(t);
  writeCatalog(dir);
  assert.equal(route.codeagentMissing(dir, withCodeagent), false);
  // 生产里 quota-watch 写入时 have 一定含这个模型（codeagent-models 的下拉显示会因此不置灰）
  Q.markModelAvoid(dir, 'personal', { model: MODEL, have: [MODEL], reason: 'model-config' });
  assert.equal(route.codeagentMissing(dir, withCodeagent), true, 'have 豁免不影响这里的判断');
  // 试探期已过（7 小时前记的）：仍算没有
  Q.clearModelAvoid(dir, 'personal');
  Q.markModelAvoid(dir, 'personal', { model: MODEL, have: [MODEL] }, Date.now() - 7 * 3600_000);
  assert.equal(route.codeagentMissing(dir, withCodeagent), true, '6 小时到期后不翻回');
  Q.clearModelAvoid(dir, 'personal', MODEL);
  assert.equal(route.codeagentMissing(dir, withCodeagent), false, '成功回答解除后算有');
  // 号池登记了号：可能用号池的号，不算没有
  Q.markModelAvoid(dir, 'personal', { model: MODEL, have: [MODEL] });
  fs.writeFileSync(path.join(dir, 'codeagent-pool', 'pool.json'), JSON.stringify({ accounts: [{ id: 'acc12345', note: '' }] }));
  assert.equal(route.codeagentMissing(dir, withCodeagent), false);
});

test('P1-2：分身没选过后端、走自动默认部门 key 时，分身页的网关行算选中（自检 / 试答 / 纠错重答按网关放行）', async t => {
  const dir = tempDir(t);
  const impl = async (url, init = {}) => {
    if (init.headers?.authorization !== 'Bearer ' + KEY) return new Response('{}', { status: 401 });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  assert.equal((await gateway.save(dir, { apiKey: KEY }, { safeStorage: fakeSafe, fetchImpl: impl })).ok, true);
  const { gatewayRow } = require('../main/ipc/avatar-handlers');
  const claudeOnly = { findCommand: kind => (kind === 'claude' ? 'C:/x/claude.exe' : null) };
  const row = gatewayRow(dir, { availability: claudeOnly });
  assert.equal(row.selected, true, '自动默认生效：网关行选中');
  assert.equal(row.auto, true);
  assert.equal(row.configured, false, '不是用户手动选的');
  // 有 CodeAgent 的老用户：不选中网关行
  assert.equal(gatewayRow(dir, { availability: withCodeagent }).selected, false);
  // 用户手动选了 CodeAgent：不被自动默认盖掉
  require('../core/codeagent-assistant-route').setFeaturePreference(dir, 'avatar', { kind: 'codeagent', model: '' });
  assert.equal(gatewayRow(dir, { availability: claudeOnly }).selected, false);
});

// ---- 窄复审（job 20261127-000040-60a491）2 个 P2 ----
test('窄复审 P2-1：分身网关在自动默认时点回 CodeAgent 账号卡，存明确的 CodeAgent，不被自动默认盖回', async t => {
  const { accountSwitchChoice } = require('../renderer/avatar-page.js');
  assert.deepEqual(accountSwitchChoice([{ id: 'personal' }, { id: 'api-gateway', gateway: true, selected: true, auto: true, configured: false }]), { kind: 'codeagent', model: '' });
  assert.deepEqual(accountSwitchChoice([{ id: 'api-gateway', gateway: true, selected: false, configured: true }]), { kind: 'codeagent', model: '' });
  assert.equal(accountSwitchChoice([{ id: 'personal' }, { id: 'api-gateway', gateway: true, selected: false, configured: false }]), null, '网关没在用：不改设置');
  // 存了明确的 CodeAgent 后，没有可用 CodeAgent 也不再自动选中网关行
  const dir = tempDir(t);
  const impl = async (url, init = {}) => (url.endsWith('/models') && init.headers?.authorization === 'Bearer ' + KEY
    ? new Response(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }), { status: 200 }) : new Response('{}', { status: 401 }));
  assert.equal((await gateway.save(dir, { apiKey: KEY }, { safeStorage: fakeSafe, fetchImpl: impl })).ok, true);
  const { gatewayRow } = require('../main/ipc/avatar-handlers');
  const claudeOnly = { findCommand: kind => (kind === 'claude' ? 'C:/x/claude.exe' : null) };
  assert.equal(gatewayRow(dir, { availability: claudeOnly }).selected, true);
  require('../core/codeagent-assistant-route').setFeaturePreference(dir, 'avatar', accountSwitchChoice([gatewayRow(dir, { availability: claudeOnly })]));
  assert.equal(gatewayRow(dir, { availability: claudeOnly }).selected, false);
});

test('窄复审 P2-2：serve 报空清单，但 CodeAgent 的 settings.json 自配了供应商模型 → 按有 CodeAgent 处理', t => {
  const dir = tempDir(t);
  const settings = path.join(process.env.AI_HUB_CODEAGENT_CONFIG_DIR, 'settings.json');
  t.after(() => fs.rmSync(settings, { force: true }));
  probe.writeEmptyCatalog(pool.personalModelsFile(dir));
  assert.equal(route.codeagentMissing(dir, withCodeagent), true, '没有自配模型：空清单算没有');
  fs.writeFileSync(settings, JSON.stringify({ enterprise: { providers: { dept: { mainModel: 'dept-model-1' } } } }));
  assert.equal(route.codeagentMissing(dir, withCodeagent), false, '自配了供应商模型：算有');
});
