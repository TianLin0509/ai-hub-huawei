'use strict';
// 助理和分身共用线路；按账号记在已有的上次模型文件里，不改 CodeAgent 用户配置。
const fs = require('node:fs');
const path = require('node:path');
const { FILE } = require('./codeagent-launch-model');
const { routeFields } = require('./codeagent-model-choice');
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
function read(dataDir, account = 'personal') {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'))[account] || {}; } catch { return {}; }
}
function write(dataDir, account, patch) {
  const file = path.join(dataDir, FILE);
  let all; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { all = {}; }
  if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
  all[account] = { ...all[account], ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
}
function valid(choice) {
  return require('./model-id').isSafeModelId(choice?.model) && !!routeFields(choice).codeagentModelProvider;
}
function preference(dataDir, account = 'personal') { return read(dataDir, account).assistantChoice || null; }
function setPreference(dataDir, account = 'personal', choice = null) {
  if (choice !== null && !valid(choice)) throw new Error('请选择带供应商的模型');
  const value = choice ? { model: choice.model, ...routeFields(choice) } : null;
  write(dataDir, account, { assistantChoice: value });
  return value;
}
function lastSuccessful(dataDir, account = 'personal') {
  const row = read(dataDir, account).manualSuccess;
  return valid(row) ? row : null;
}
function modelOptions(dataDir, account = 'personal', configDir = null) {
  const models = require('./codeagent-models');
  const dir = configDir || (account === 'personal' ? require('./codeagent-config').resolveCodeAgentConfig(process.env).configDir
    : require('./codeagent-pool').accountDir(dataDir, account));
  const catalog = models.readModelCatalog(dataDir, { configDir: dir, accountKey: account });
  return models.modelOptions(dataDir, { configDir: dir, accountKey: account }).map(o => {
    const own = (catalog?.details || []).filter(d => d.id.toLowerCase() === o.id.toLowerCase());
    const d = own.length === 1 ? own[0] : null;
    return !o.provider && d?.provider ? { ...o, provider: d.provider, providerLabel: d.providerLabel || d.provider,
      menuLabel: d.label || o.id, label: `${o.label} · ${d.providerLabel || d.provider}` } : o;
  });
}
function choose(dataDir, account = 'personal', target = '', { options = null, configDir = null, explicitModel = '' } = {}) {
  const selected = preference(dataDir, account);
  // 用户明确设置可改模型；分身单独指定了另一个模型时仍守住它的选择。
  if (valid(selected)) return !explicitModel || eq(explicitModel, selected.model) ? selected : null;
  const saved = lastSuccessful(dataDir, account);
  if (!valid(saved) || !target || !eq(target, saved.model)) return null;
  const candidates = (options || modelOptions(dataDir, account, configDir)).filter(o => eq(o.id, target) && o.provider && !o.unavailable);
  // 成功记录只为原目标的同名多供应商消歧，不能改变单供应商用户的默认模型。
  return new Set(candidates.map(o => o.provider.toLowerCase())).size > 1
    && candidates.some(o => eq(o.provider, saved.codeagentModelProvider)) ? saved : null;
}
const routeKey = route => `${String(route?.model || '').toLowerCase()}|${String(route?.codeagentModelProvider || '').toLowerCase()}`;
const deferredModel = session => String(session?.codeagentRouteDeferred || '').split('|')[0] || '';
// 熔断期按 CLI 当前模型起的会话记着暂缓的是哪条线路（codeagentRouteDeferred）。只在下面几条都成立时仍算同一条线路，不每问重开：
// 目标线路不为空且与记录一致；这个号的熔断还开着（要传 dataDir 才查得到，不传一律不认）；会话之后没有真换过模型或线路。
// 熔断解除、会话里换了模型、线路被清掉，都判不匹配，让调用方换回按真实线路起的新会话（2026-11-25 复审 P1）。
// A deferred route still matches only while the breaker is open, the route is unchanged and the session never switched model since.
function deferredStillValid(session, route, dataDir) {
  if (!route || !dataDir || session.codeagentRouteDeferred !== routeKey(route)) return false;
  if (session.codeagentModelProvider || session.codeagentUserModel || session.codeagentBackendSwitch
    || session.modelPinSource && session.modelPinSource !== 'created') return false;
  try { return !!require('./codeagent-auto-pick').openFor(dataDir, session.codeagentPoolAccount || 'personal'); } catch { return false; }
}
function matchesSession(session, route, { dataDir = '' } = {}) {
  if (session?.codeagentRouteDeferred) return deferredStillValid(session, route, dataDir);
  return !route || eq(session?.codeagentModelProvider, route.codeagentModelProvider)
    && [session?.currentModel?.id, session?.fixedModel, session?.codeagentUserModel].some(model => eq(model, route.model));
}
function repairAction(dataDir, account = 'personal') {
  return { account, canUseManual: !!lastSuccessful(dataDir, account) };
}
function rememberSuccess(dataDir, session, answer, { options = [], settings = {} } = {}) {
  if (!/^codeagent(?:-resume)?$/.test(session?.kind || '') || session.purpose || session.autonomous
    || !answer?.text?.trim() || !['end_turn', 'stop_sequence'].includes(answer.stopReason)
    || !require('./model-id').isSafeModelId(answer.model) || !Number.isFinite(answer.ts)) return false;
  const model = session.currentModel?.id || answer.model;
  const models = require('./codeagent-models');
  if (!eq(model, answer.model) && (!models.isAutoModel(model) || !models.modelFamily(model) || models.modelFamily(model) !== models.modelFamily(answer.model))) return false;
  let route = routeFields(session);
  if (!route.codeagentModelProvider) {
    const matches = options.filter(o => eq(o.id, model) && !o.unavailable);
    if (matches.length === 1) route = routeFields(matches[0]);
    if (!route.codeagentModelProvider && eq(settings.model, model)) route = routeFields({ provider: settings.provider });
  }
  if (!route.codeagentModelProvider) return false;
  const account = session.codeagentPoolAccount || 'personal';
  if ((lastSuccessful(dataDir, account)?.at || 0) >= answer.ts) return false;
  write(dataDir, account, { manualSuccess: { model, ...route, at: answer.ts } });
  return true;
}
// 地址只显示协议、主机和路径；不把密钥、用户信息、查询参数带到提示里。
function connection(configDir, provider = '') {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* 会话已明确的供应商仍可显示。 */ }
  const id = routeFields({ provider: provider || s.provider || s.enterprise?.activeProvider }).codeagentModelProvider || '';
  try {
    const raw = s.enterprise?.providers?.[id]?.apiBaseUrl;
    const u = new URL(raw);
    return { provider: id, address: /^https?:$/.test(u.protocol) ? u.origin + u.pathname : '' };
  } catch { return { provider: id, address: '' }; }
}
// 功能选型复用这份账号线路文件；旧助理设置继续由原接口管理。
function featurePreference(dataDir, feature) { return read(dataDir).featureChoices?.[feature] || null; }
function setFeaturePreference(dataDir, feature, choice) {
  const choices = { ...read(dataDir).featureChoices };
  if (choice) choices[feature] = choice; else delete choices[feature];
  write(dataDir, 'personal', { featureChoices: choices });
}
module.exports = { choose, preference, setPreference, lastSuccessful, rememberSuccess, connection, modelOptions, matchesSession, routeKey, deferredModel, repairAction, featurePreference, setFeaturePreference };
