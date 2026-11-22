'use strict';

const models = require('./codeagent-models');

// 在线显示和恢复启动共用账号清单，不能把别的会话见过的模型当成当前账号权限。
function resolveAccountModel(actual, { dataDir, configDir, pool = null, accountKey = 'personal' } = {}) {
  const accounts = require('./codeagent-pool');
  const known = pool?.account
    ? { models: pool.account.models || [], authoritative: !!pool.account.modelsAuthoritative }
    : accounts.accountModels(configDir, undefined, accountKey === 'personal' ? accounts.personalModelsFile(dataDir) : null);
  if (!known.authoritative) return '';
  return models.resolveObservedSwitch(actual, {
    options: known.models, defaultModel: accounts.readSettingsModel(configDir),
  });
}

function resumeModelFields(session, file, options) {
  const last = require('./read-last-assistant').readLastAssistantMessageSync(file);
  if (!last || !models.isSafeModelId(last.model)) return {};
  // Hub 中刚选的新模型优先，旧回答不能撤销这次明确选择。
  if (Number.isFinite(session.modelSwitchConfirmedAt)
    && (!Number.isFinite(last.ts) || last.ts <= session.modelSwitchConfirmedAt)) return {};
  const actual = last.model.trim();
  let target = resolveAccountModel(actual, options);
  const current = session.fixedModel || session.codeagentUserModel || session.model || '';
  // Auto 的后端分流不代表用户切换菜单项，沿用原有显示口径。
  if (models.isAutoModel(current) && models.modelFamily(current)
    && models.modelFamily(current) === models.modelFamily(actual)) {
    target = resolveAccountModel(current, options);
  }
  models.appendModelLog(options.dataDir, { event: 'resume-transcript-model',
    session: String(session.id || '').slice(0, 8), actual, model: target || current,
    reason: target ? 'account-model' : 'not-in-account-list' });
  if (!target) return { codeagentBackendSwitch: null };
  return { ...require('./session-actual-model').actualModelFields(session, actual, target),
    codeagentActualModel: actual, codeagentUserModel: target, codeagentBackendSwitch: null };
}

module.exports = { resolveAccountModel, resumeModelFields };
