'use strict';

const models = require('./codeagent-models');

function unavailablePolicy(value) {
  return value === 'stop-and-ask' ? value : 'auto-switch-notify';
}

function captureSessionExecution(manager, sessionId) {
  const owner = manager.sessions?.get(sessionId);
  const info = owner?.info || manager.getSession?.(sessionId);
  return { owner, epoch: owner?.modelSubmissionEpoch || 0, nativeId: info?.ccSessionId || '' };
}

function sameSessionExecution(snapshot, manager, sessionId) {
  const info = manager.getSession?.(sessionId), current = captureSessionExecution(manager, sessionId);
  const owner = current.owner;
  return !!info && !['closed', 'dormant', 'exited'].includes(info.status)
    && !owner?.closeRequestedAt && !owner?.suspendRequestedAt && !owner?.confirmedExit && owner?.pty?.closed !== true
    && snapshot.owner === owner && snapshot.epoch === current.epoch
    // A first hook may bind a previously unknown id; a known id cannot change.
    && (!snapshot.nativeId || snapshot.nativeId === current.nativeId);
}

function modelPinFields(session = {}) {
  const fields = {};
  for (const key of ['fixedModel', 'codeagentUserModel']) {
    if (models.isSafeModelId(session[key])) fields[key] = session[key].trim();
  }
  if (typeof session.modelConfirmationRequired === 'boolean') fields.modelConfirmationRequired = session.modelConfirmationRequired;
  if (typeof session.modelUnavailableReason === 'string') fields.modelUnavailableReason = session.modelUnavailableReason.slice(0, 300);
  if (typeof session.modelPinSource === 'string') fields.modelPinSource = session.modelPinSource.slice(0, 80);
  const change = session.modelChange;
  if (change === null) fields.modelChange = null;
  if (change && models.isSafeModelId(change.from) && models.isSafeModelId(change.to)) {
    fields.modelChange = { from: change.from, to: change.to, reason: String(change.reason || '').slice(0, 300), at: Number(change.at) || 0 };
  }
  return fields;
}

function migrateModelPin(session = {}) {
  const fields = modelPinFields(session);
  // codeagentModelPick also marks a startup menu still in flight when the
  // session is suspended. Only an explicit modelConfirmationRequired pauses it.
  if (fields.fixedModel) return fields;
  const current = require('./session-capabilities').sessionModelId(session);
  const model = fields.codeagentUserModel || current;
  if (models.isSafeModelId(model)) {
    fields.fixedModel = model;
    fields.modelPinSource = fields.codeagentUserModel ? 'legacy-user' : 'legacy-current';
  }
  return fields;
}

function unavailableError(model, reason, availableModels = [], suggestedModel = availableModels[0] || '') {
  return Object.assign(new Error(`原模型 ${model} 不可用（${reason}），请手动选择可用模型后继续。`), {
    code: 'SESSION_MODEL_UNAVAILABLE', notSent: true, model, reason, availableModels,
    suggestedModel: models.isSafeModelId(suggestedModel) ? suggestedModel : '',
  });
}

function resolveCodeAgentPin(opts, { dataDir, configDir, command, pool = null, failureReason = '', failureCode = '' } = {}) {
  const accounts = require('./codeagent-pool');
  const caps = require('./codeagent-capabilities');
  const known = pool?.account ? { models: pool.account.models || [], authoritative: !!pool.account.modelsAuthoritative }
    : accounts.accountModels(configDir, undefined, accounts.personalModelsFile(dataDir));
  const list = known.models || [];
  const defaultModel = accounts.readSettingsModel(configDir);
  const match = value => list.find(id => id.toLowerCase() === String(value || '').toLowerCase());
  const requested = opts.codeagentModelPick === true || opts.resumeCCSessionId || opts.forkCCSessionId ? opts.model : '';
  let fixedModel = opts.fixedModel || opts.codeagentUserModel || requested || defaultModel || '';
  if (!models.isSafeModelId(fixedModel)) fixedModel = '';
  if (!fixedModel && known.authoritative && list.length === 1) fixedModel = list[0];
  if (fixedModel) fixedModel = accounts.personalDefaultModel(fixedModel, { models: list, authoritative: known.authoritative }) || fixedModel;
  // 只由 CodeAgent 默认模型推出来的（用户没指定）：用户已为它确认过替代模型，就直接用替代，不再每个新会话问一次。
  if (fixedModel && !opts.fixedModel && !opts.codeagentUserModel && !requested && dataDir) {
    const replaced = require('./codeagent-model-replacements').replacementFor(dataDir, fixedModel, known);
    if (replaced) fixedModel = replaced;
  }
  const settingsSupported = caps.filterArgs(['--settings', 'session.json'], caps.readHelp(command)).args.includes('--settings');
  const policy = unavailablePolicy(require('./hub-config').getConfig().sessionModelUnavailablePolicy);
  let reason = failureReason || (opts.modelConfirmationRequired ? opts.modelUnavailableReason || '原模型已暂停，须由用户明确确认后继续' : '');
  if (!reason && fixedModel && known.authoritative && !match(fixedModel)) reason = '账号的权威模型清单已不包含它，可能没有使用权限';
  else if (!reason && fixedModel && !settingsSupported) reason = '当前 CLI 版本不支持 --settings，无法固定会话模型';
  let modelChange = null;
  if (reason) {
    const family = models.modelFamily(fixedModel), sameFamily = list.filter(id => family && models.modelFamily(id) === family);
    const next = sameFamily.find(id => id.toLowerCase() === String(defaultModel).toLowerCase()) || sameFamily[0]
      || (!known.authoritative && match(defaultModel) === match(fixedModel) && defaultModel);
    if (policy === 'stop-and-ask' || opts.modelConfirmationRequired) throw Object.assign(unavailableError(fixedModel, reason, list, next || match(defaultModel) || list[0]),
      { canChooseAlternative: settingsSupported && failureCode !== 'SETTINGS_WRITE_FAILED' });
    if (!models.isSafeModelId(next)) throw unavailableError(fixedModel, reason + '，没有同家族可用替代模型，跨家族切换需要手动确认', list, match(defaultModel) || list[0]);
    modelChange = { from: fixedModel, to: next, reason, at: Date.now() };
    fixedModel = next;
  } else if (match(fixedModel)) fixedModel = match(fixedModel);
  return { ...modelPinFields(opts), fixedModel, modelPinSource: modelChange ? 'auto-switch' : opts.modelPinSource || 'created',
    modelChange: modelChange || opts.modelChange || null, modelChanged: !!modelChange, settingsSupported };
}

function modelChangeMessage(change) {
  if (!change) return '';
  return change.from === change.to
    ? `原模型 ${change.from} 无法固定，已按账号默认 ${change.to} 继续（${change.reason}）。`
    : `原模型 ${change.from} 不可用，已换成 ${change.to}（${change.reason}）。`;
}

module.exports = { captureSessionExecution, sameSessionExecution, unavailablePolicy, modelPinFields, migrateModelPin, unavailableError, resolveCodeAgentPin, modelChangeMessage };
