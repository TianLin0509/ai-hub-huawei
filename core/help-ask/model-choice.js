'use strict';
// 答疑沿用新建会话的默认选型；替代候选也来自启动中心，不能把旧模型名当权限清单。
const fs = require('node:fs');
const path = require('node:path');
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
function defaultModel(dataDir, kind, { config = require('../hub-config').getConfig(), env = process.env,
  resolveCodeAgent = require('../codeagent-config').resolveCodeAgentConfig } = {}) {
  if (kind !== 'codeagent' && require('../company-api-config').isCompany()) {
    const saved = require('../default-model-preference').readDefaultModels(config)[kind];
    return saved && require('../model-id').isSafeModelId(saved) ? saved : '';
  }
  if (kind !== 'codeagent') return require('../default-model-preference').resolveDefaultModel(kind, config);
  const dir = resolveCodeAgent(env)?.configDir;
  if (!dir) return '';
  const pool = require('../codeagent-pool'), launch = require('../codeagent-launch-model');
  const known = pool.accountModels(dir, undefined, pool.personalModelsFile(dataDir));
  const blocked = require('../codeagent-models').unavailableModels(dataDir, { accountKey: 'personal' });
  const hub = launch.hubDefaultModel(config, { ...known, blocked });
  if (hub.model) return hub.model;
  let model = require('../codeagent-model-route').personalModels({ dataDir, personalDir: dir, single: true }).defaultModel;
  if (!model) {
    const last = launch.lastEntry(dataDir, 'personal');
    let settingsAt = 0;
    try { settingsAt = fs.statSync(path.join(dir, 'settings.json')).mtimeMs; } catch { /* CLI 尚无配置 */ }
    model = launch.chooseLaunchModel({ ...known, singleModelReliable: true, current: pool.readSettingsModel(dir),
      currentNewer: settingsAt > last.at, last: last.model, first: '' }).model;
  }
  // 清单未知时新会话也会沿用 CLI 当前配置；保留实际名称，重试时才能排除刚失败的模型。
  model = model || pool.readSettingsModel(dir);
  return require('../model-id').isSafeModelId(model) ? model : '';
}
function modelUnavailable(error) {
  const text = String(error?.message || error || '');
  return /模型[^\n]*(?:升级|调整.{0,4}权限|无权限|没有权限|不可用|不存在|不支持|未授权)|(?:无权限|没有权限|无权|不支持|无法使用)[^\n]*模型|model[^\n]*(?:not[_ -]found|not[_ -]available|unavailable|does not exist|not exist|not[_ -]supported|not[_ -]permitted|permission|access|unauthorized|forbidden)|(?:no access|do not have access|not authorized)[^\n]*model/i.test(text);
}
function alternative(dataDir, failed, { env = process.env, findCommand, config, resolveCodeAgent } = {}) {
  const models = failed.kind === 'codeagent'
    ? require('../codeagent-assistant-route').modelOptions(dataDir, 'personal', resolveCodeAgent(env)?.configDir)
    : require('../feature-agent-choice').catalog(dataDir, { env, findCommand }).find(b => b.kind === failed.kind && b.available)?.models || [];
  // 公司版外壳的模型带来源（部门 key / 公司模型），替代也只在同一来源里找，不跨来源换线路。
  const options = models.filter(m => !m.unavailable && !eq(m.id, failed.model) && (!failed.source || m.source === failed.source));
  const preferred = defaultModel(dataDir, failed.kind, { env, config, resolveCodeAgent });
  const next = options.find(m => eq(m.id, preferred)) || options[0];
  return next ? { kind: failed.kind, model: next.id, ...(failed.source ? { source: failed.source } : {}), ...require('../codeagent-model-choice').routeFields(next) } : null;
}
module.exports = { defaultModel, modelUnavailable, alternative };
