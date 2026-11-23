'use strict';
// 群里「模型列表只保留能用的」）。全部用临时目录和假清单，不启动 CLI。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launchModel = require('../core/codeagent-launch-model');
const preference = require('../core/default-model-preference');
const pool = require('../core/codeagent-pool');
const models = require('../core/codeagent-models');
const probe = require('../core/codeagent-model-probe');
const serve = require('../core/codeagent-serve');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const LIST = ['GLM-5.3-Auto', 'maas-deepseek-v4.1-flash-aliyun-codeagent', 'GLM-5.2-WX-Auto'];

test('设为默认的 CodeAgent 模型存得进、读得回（以前读回时被静态清单整条扔掉）', () => {
  assert.deepEqual(preference.readDefaultModels({ defaultModels: { codeagent: 'GLM-5.3-Auto' } }), { codeagent: 'GLM-5.3-Auto' });
  const json = preference.withDefaultModelInJson({}, 'codeagent', 'maas-deepseek-v4.1-flash-aliyun-codeagent', { availableIds: LIST });
  assert.equal(json.models.defaults.codeagent, 'maas-deepseek-v4.1-flash-aliyun-codeagent');
  assert.equal(preference.resolveDefaultModel('codeagent', { defaultModels: json.models.defaults }), 'maas-deepseek-v4.1-flash-aliyun-codeagent');
  // 清掉：回到跟随 CodeAgent
  assert.deepEqual(preference.withDefaultModelInJson(json, 'codeagent', '').models.defaults, {});
  // 命令行安全白名单照旧把关
  assert.equal(preference.isModelValidForKind('codeagent', 'bad model;rm'), false);
});

test('hubDefaultModel：只在清单可靠且有它时用；w3/ 前缀、-Auto 分档名都认', () => {
  const cfg = model => ({ defaultModels: { codeagent: model } });
  assert.deepEqual(launchModel.hubDefaultModel({}, { models: LIST, authoritative: true }), { model: '', reason: 'unset' });
  assert.equal(launchModel.hubDefaultModel(cfg('glm-5.3-auto'), { models: LIST, authoritative: true }).model, 'GLM-5.3-Auto');
  assert.equal(launchModel.hubDefaultModel(cfg('w3/GLM-5.2-WX-Auto'), { models: LIST, authoritative: true }).model, 'GLM-5.2-WX-Auto');
  assert.equal(launchModel.hubDefaultModel(cfg('GLM-5.2-WX'), { models: LIST, authoritative: true }).model, 'GLM-5.2-WX-Auto');
  assert.equal(launchModel.hubDefaultModel(cfg('GLM-5.3-Auto'), { models: LIST, authoritative: false }).reason, 'list-unknown');
  const gone = launchModel.hubDefaultModel(cfg('kimi-k3'), { models: LIST, authoritative: true });
  assert.equal(gone.model, ''); assert.equal(gone.reason, 'not-in-list'); assert.equal(gone.saved, 'kimi-k3');
});

test('settings.json 里带内置通道前缀的模型名按去掉前缀认（反馈 24908907：w3/GLM-5.2-WX-Auto 报模型不存在）', () => {
  const known = { models: ['GLM-5.2-WX-Auto', 'DeepSeek-V4-Flash-0731'], authoritative: true };
  assert.equal(pool.personalDefaultModel('w3/GLM-5.2-WX-Auto', known), 'GLM-5.2-WX-Auto');
  assert.equal(pool.personalDefaultModel('Built-in/GLM-5.2-WX', known), 'GLM-5.2-WX-Auto');
  assert.equal(pool.personalDefaultModel('other/GLM-5.2-WX-Auto', known), '', '只认内置通道前缀，不乱剥别的');
  assert.equal(pool.strictDefaultModel('w3/GLM-5.2-WX-Auto', known.models).model, 'GLM-5.2-WX-Auto');
});

test('用不了的模型：默认清单里没有，界面清单排在最后、带原因；依据是供应商状态和「模型不存在」避让记录', t => {
  const dataDir = temp(t), configDir = path.join(dataDir, 'personal');
  fs.mkdirSync(configDir, { recursive: true });
  const parsed = serve.parseProviders({ providers: [
    { id: 'w3', status: 'available', models: { 'GLM-5.3-Auto': { id: 'GLM-5.3-Auto' }, 'GLM-5.2-WX-Auto': { id: 'GLM-5.2-WX-Auto' } } },
    { id: 'team', display_name: '团队自配', status: 'disabled', models: { 'kimi-k3-mini': { id: 'kimi-k3-mini' }, default: {} } },
  ] });
  assert.deepEqual(parsed.skipped[0].modelIds, ['kimi-k3-mini']);
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: ['GLM-5.3-Auto', 'GLM-5.2-WX-Auto'], source: 'serve', details: parsed.models, skipped: parsed.skipped });
  assert.deepEqual(probe.readProbed(pool.personalModelsFile(dataDir)).unavailable, [{ id: 'kimi-k3-mini', provider: '团队自配', status: 'disabled' }]);
  require('../core/codeagent-quota').markModelAvoid(dataDir, 'personal', { model: 'GLM-5.2-WX-Auto', reason: '模型不存在或配置有误' }, Date.now());

  const plain = models.modelOptions(dataDir, { configDir });
  assert.deepEqual(plain.map(o => o.id), ['GLM-5.3-Auto'], '启动选型、后台对回模型名只看能用的');
  const ui = models.modelOptions(dataDir, { configDir, includeUnavailable: true });
  assert.deepEqual(ui.map(o => [o.id, !!o.unavailable]), [['GLM-5.3-Auto', false], ['GLM-5.2-WX-Auto', true], ['kimi-k3-mini', true]]);
  assert.match(ui[1].unavailableReason, /模型不存在或配置有误/);
  assert.match(ui[2].unavailableReason, /团队自配.*disabled/);
});

test('session-manager：没明确选模型的新会话先用 Hub 默认；明确跟随 CodeAgent、调度方指定模型的会话不套', () => {
  const source = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  const block = source.slice(source.indexOf('let hubDefaultTarget = '), source.indexOf('// 公司模型（经本机反代）'));
  assert.match(block, /!opts\.codeagentFollowCli/);
  assert.match(block, /!HUB_DEFAULT_SKIP_PURPOSES\.includes\(opts\.purpose\)/);
  assert.match(block, /freshLaunch/);
  // 自动会话仍先取 Hub 默认；成功记录只给同名目标消歧，显式设置可改模型。
  assert.match(source, /const defaultTarget = hubDefaultTarget \|\| \(codeagentPool/);
  assert.match(source, /const target = assistantRoute\?\.model \|\| defaultTarget/);
});

test('Codex 审查补点：停用供应商不误伤别家同名可用模型；Hub 默认被判用不了时不套', t => {
  const dataDir = temp(t), configDir = path.join(dataDir, 'personal');
  fs.mkdirSync(configDir, { recursive: true });
  const parsed = serve.parseProviders({ providers: [
    { id: 'w3', status: 'available', models: { 'GLM-5.3-Auto': { id: 'GLM-5.3-Auto' } } },
    { id: 'team', display_name: '团队自配', status: 'disabled', models: { 'GLM-5.3-Auto': { id: 'GLM-5.3-Auto' }, 'kimi-k3-mini': { id: 'kimi-k3-mini' } } },
  ] });
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: ['GLM-5.3-Auto'], source: 'serve', details: parsed.models, skipped: parsed.skipped });
  const ui = models.modelOptions(dataDir, { configDir, includeUnavailable: true });
  assert.deepEqual(ui.map(o => [o.id, !!o.unavailable]), [['GLM-5.3-Auto', false], ['kimi-k3-mini', true]]);

  require('../core/codeagent-quota').markModelAvoid(dataDir, 'personal', { model: 'GLM-5.3-Auto', reason: '模型不存在或配置有误' });
  const blocked = models.unavailableModels(dataDir, { accountKey: 'personal' });
  const result = launchModel.hubDefaultModel({ defaultModels: { codeagent: 'GLM-5.3-Auto' } }, { models: ['GLM-5.3-Auto', 'GLM-5.2-WX-Auto'], authoritative: true, blocked });
  assert.deepEqual(result, { model: '', reason: 'unavailable', saved: 'GLM-5.3-Auto' });
});

test('Codex 审查补点：号池汇总同名时可用项优先；重开启动中心清掉「跟随 CodeAgent」', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  assert.match(handlers, /else if \(options\[at\]\.unavailable && !option\.unavailable\) options\[at\] = option;/);
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/workspace-controller.js'), 'utf8');
  assert.match(renderer, /tuningMemory\.clear\(\);\r?\n[^\n]*\r?\n\s*codeagentFollowCli = false;/);
});

test('Codex 复审补点：只从配置补进来的自配模型，所在供应商被报停用时仍置灰', t => {
  const dataDir = temp(t), configDir = path.join(dataDir, 'personal');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'GLM-5.3-Auto', enterprise: { providers: { team: { provider: 'openai', mainModel: 'kimi-k3-mini' } } } }));
  const parsed = serve.parseProviders({ providers: [
    { id: 'w3', status: 'available', models: { 'GLM-5.3-Auto': { id: 'GLM-5.3-Auto' } } },
    { id: 'team', status: 'disabled', models: { 'kimi-k3-mini': { id: 'kimi-k3-mini' } } },
  ] });
  probe.writeProbed(pool.personalModelsFile(dataDir), { models: ['GLM-5.3-Auto'], source: 'serve', details: parsed.models, skipped: parsed.skipped });
  assert.deepEqual(models.modelOptions(dataDir, { configDir }).map(o => o.id), ['GLM-5.3-Auto']);
  const ui = models.modelOptions(dataDir, { configDir, includeUnavailable: true });
  assert.deepEqual(ui.map(o => [o.id, !!o.unavailable]), [['GLM-5.3-Auto', false], ['kimi-k3-mini', true]]);
});

test('复审补点：避让记录过了试探时间、或出错时号的清单里本来就有它，都不再置灰', t => {
  const dataDir = temp(t);
  const quota = require('../core/codeagent-quota');
  const now = Date.now();
  quota.markModelAvoid(dataDir, 'personal', { model: 'GLM-OLD-Auto', reason: '模型不存在或配置有误' }, now - 7 * 24 * 3600 * 1000);
  quota.markModelAvoid(dataDir, 'personal', { model: 'GLM-HAVE-Auto', reason: '模型不存在或配置有误', have: ['GLM-HAVE-Auto'] }, now);
  quota.markModelAvoid(dataDir, 'personal', { model: 'GLM-NEW-Auto', reason: '模型不存在或配置有误' }, now);
  const blocked = models.unavailableModels(dataDir, { accountKey: 'personal' });
  assert.ok(!blocked.has('glm-old-auto'), '过期的避让记录不置灰');
  assert.ok(!blocked.has('glm-have-auto'), '号的清单里有的不置灰');
  assert.ok(blocked.has('glm-new-auto'), '刚报错、清单里没有的仍置灰');
});
