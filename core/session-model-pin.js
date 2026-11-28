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
  if (models.isSafeModelId(session.actualModel?.id) && models.isSafeModelId(session.actualModel?.launchModel)) {
    fields.actualModel = { id: session.actualModel.id, launchModel: session.actualModel.launchModel,
      ...(session.actualModel.terminalSwitch === true ? { terminalSwitch: true } : {}) };
  }
  for (const key of ['fixedModel', 'codeagentUserModel']) {
    if (models.isSafeModelId(session[key])) fields[key] = session[key].trim();
  }
  if (typeof session.modelConfirmationRequired === 'boolean') fields.modelConfirmationRequired = session.modelConfirmationRequired;
  if (typeof session.modelUnavailableReason === 'string') fields.modelUnavailableReason = session.modelUnavailableReason.slice(0, 300);
  if (typeof session.modelPinSource === 'string') fields.modelPinSource = session.modelPinSource.slice(0, 80);
  if (Number.isFinite(session.modelSwitchConfirmedAt) && session.modelSwitchConfirmedAt > 0) {
    fields.modelSwitchConfirmedAt = session.modelSwitchConfirmedAt;
  }
  const sw = session.codeagentBackendSwitch;
  if (sw && models.isSafeModelId(sw.from) && models.isSafeModelId(sw.actual)) {
    fields.codeagentBackendSwitch = { from: sw.from.trim(), actual: sw.actual.trim(), at: Number(sw.at) || 0 };
  }
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
  // 同一模型的不同写法（线路前缀、内部 id、菜单显示名）按统一对照认成清单里的那一个（core/model-name-match.js）。
  const nameMatch = require('./model-name-match');
  const match = value => list.find(id => id.toLowerCase() === String(value || '').toLowerCase()) || nameMatch.findSame(value, list) || undefined;
  const requested = require('./codeagent-launch-model').explicitModel(opts)
    || (opts.resumeCCSessionId || opts.forkCCSessionId ? opts.model : '');
  let fixedModel = opts.fixedModel || opts.codeagentUserModel || requested || defaultModel || '';
  if (!models.isSafeModelId(fixedModel)) fixedModel = '';
  // 恢复会话用最后一次确认的模型（2026-11-19 审查）：用户在终端里 /model 换了代、回答里只有对不回清单的后端名时，固定模型还是旧的；
  // 照它启动会把用户的新选择撤掉。这时 CodeAgent 自己记着的默认模型（/model 回车写的就是它）和回答同一家、版本也对得上，就按它启动。
  // 只在固定模型仍是换代前那个时生效：之后用户在 Hub 里重新选过模型，记录自然失效。
  const backendSwitch = opts.codeagentBackendSwitch;
  let pinSource = '';
  if (fixedModel && backendSwitch && String(backendSwitch.from || '').toLowerCase() === fixedModel.toLowerCase()
      && models.isSafeModelId(defaultModel) && defaultModel.toLowerCase() !== fixedModel.toLowerCase()
      && models.modelFamily(defaultModel) && models.modelFamily(defaultModel) === models.modelFamily(backendSwitch.actual)
      && !!models.modelVersion(defaultModel) && !models.versionsDiffer(models.modelVersion(defaultModel), models.modelVersion(backendSwitch.actual))) {
    fixedModel = defaultModel.trim();
    pinSource = 'cli';
  }
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
  // settings.json 里自配供应商的模型 CLI 能直接用（会话下拉、分身模型卡都列它）：权威清单里没有也不算没权限。
  // 只放行固定，不进清单，不当自动替代的候选（2e0d46306：自配模型不进自动挑号）。
  const configured = () => models.settingsProviderModels(configDir).some(row => row.id.toLowerCase() === String(fixedModel).toLowerCase());
  if (!reason && fixedModel && known.authoritative && !match(fixedModel) && !configured()) reason = '账号的权威模型清单已不包含它，可能没有使用权限';
  else if (!reason && fixedModel && !settingsSupported) reason = '当前 CLI 版本不支持 --settings，无法固定会话模型';
  let modelChange = null;
  if (reason) {
    // 自动替代只用两种：已确认的账号默认模型（在清单里），或统一对照认定的唯一同版本替代（同家族、主小版本相同、Auto 一致）。
    // 对照结果是 none / ambiguous（跨版本、多条线路同分）时不自取清单第一条：没有默认模型就停下，由用户选。
    const family = models.modelFamily(fixedModel), sameFamily = list.filter(id => family && models.modelFamily(id) === family);
    const confirmedDefault = sameFamily.find(id => id.toLowerCase() === String(defaultModel).toLowerCase() && id.toLowerCase() !== String(fixedModel).toLowerCase()) || '';
    const next = nameMatch.resolveName(fixedModel, sameFamily, { allowSimilar: true }).name || confirmedDefault
      || (!known.authoritative && match(defaultModel) === match(fixedModel) && defaultModel);
    // 后台自动开的会话（助理、今日摘要、分身等，没人守着点确认框）：模型来自账号默认、不是用户明确选的，
    // 就直接换成推荐的那个（与确认框里的「推荐」同一个），记一条 modelChange 由功能页提示一行；用户明确选过的模型照旧停下来问。
    // 2026-11-28 黄区真机：默认模型下线时公司助理卡在「新建会话需要换个模型」确认框，没人点就一直不回。
    const autoSession = opts.source === 'auto' || require('./auto-dispatch-rules').AUTO_PURPOSES.includes(opts.purpose);
    const userChose = !!(opts.fixedModel || opts.codeagentUserModel || requested || opts.modelPinSource === 'user');
    const autoPick = autoSession && !userChose && !failureReason && !opts.modelConfirmationRequired
      ? (models.isSafeModelId(next) ? next : list.find(id => models.isSafeModelId(id) && id.toLowerCase() !== String(fixedModel).toLowerCase()) || '') : '';
    if (autoPick) {
      return { ...modelPinFields(opts), fixedModel: autoPick, modelPinSource: 'auto-switch',
        modelChange: { from: fixedModel, to: autoPick, reason, at: Date.now(), auto: true }, modelChanged: true, settingsSupported };
    }
    if (policy === 'stop-and-ask' || opts.modelConfirmationRequired) throw Object.assign(unavailableError(fixedModel, reason, list, next || match(defaultModel) || list[0]),
      { canChooseAlternative: settingsSupported && failureCode !== 'SETTINGS_WRITE_FAILED' });
    if (!models.isSafeModelId(next)) throw unavailableError(fixedModel, reason + '，没有同版本可替代的模型、账号也没有同家族的已确认默认模型，请选一个模型后继续（跨家族切换需要手动确认）', list, match(defaultModel) || '');
    modelChange = { from: fixedModel, to: next, reason, at: Date.now() };
    fixedModel = next;
  } else if (match(fixedModel)) fixedModel = match(fixedModel);
  return { ...modelPinFields(opts), fixedModel, modelPinSource: modelChange ? 'auto-switch' : pinSource || opts.modelPinSource || 'created',
    modelChange: modelChange || opts.modelChange || null, modelChanged: !!modelChange, settingsSupported };
}

// 默认模型不可用时替它挑的推荐模型（新建会话自动替换与确认卡片共用一个口径）：
// 只认两种明确的推荐——统一模型名对照命中的同家族同版本那一个（core/model-name-match.js，不跨版本；多条线路同分算不明），
// 或调用方给出、且在清单里的推荐模型（账号默认）。都没有返回 ''：不拿清单第一项凑数，由原来的确认或报错接手。
function recommendedReplacement(from, available = [], suggested = '') {
  const lower = value => String(value || '').toLowerCase();
  const list = (Array.isArray(available) ? available : []).filter(id => models.isSafeModelId(id) && lower(id) !== lower(from));
  if (!list.length) return '';
  const same = require('./model-name-match').resolveName(from, list, { allowSimilar: true });
  return same.name || list.find(id => lower(id) === lower(suggested)) || '';
}

function modelChangeMessage(change) {
  if (!change) return '';
  return change.from === change.to
    ? `原模型 ${change.from} 无法固定，已按账号默认 ${change.to} 继续（${change.reason}）。`
    : `原模型 ${change.from} 不可用，已换成 ${change.to}（${change.reason}）。`;
}

module.exports = { captureSessionExecution, sameSessionExecution, unavailablePolicy, modelPinFields, migrateModelPin, unavailableError, resolveCodeAgentPin, recommendedReplacement, modelChangeMessage };
