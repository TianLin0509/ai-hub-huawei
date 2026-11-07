'use strict';

// 公司版：Claude Code / Codex / DSH 走公司模型（本机反代）时，这个会话固定用哪个号（2026-11-07 用户：
// 「启动中心里也要支持账号选择——和 CodeAgent 一致」）。
// - 新建：启动中心传 companyProxyPick（'auto' 自动挑号 / 'personal' 个人账号 / 号池账号 id），这里按账号页同一口径核对
//   （在号池里、登录可用、不重复、没暂停、有所选模型的权限），不行就不建会话并用大白话说明。
// - 恢复、分支：带着会话自己记的 companyProxyAccount，不再核对（号后来暂停或移出，由反代在发消息时说明，不让会话打不开）。
// 结果写进会话（companyProxyAccount + companyProxyLabel），环境变量里的 Key 带上它（core/company-model-proxy.js sessionKey），
// 反代对这个会话只用这个号，不换号（core/company-proxy/account-router.mjs）。
const proxy = require('./company-model-proxy');

// 和反代 account-router.mjs accountHasModel 同一规则：只有权威的清单才拒绝，忽略大小写和「-Auto」后缀。
const baseModel = value => String(value || '').trim().toLowerCase().replace(/-auto$/, '');
function accountHasModel(account, model) {
  if (!model || !account || account.id === 'personal') return true;
  const models = Array.isArray(account.models) ? account.models : [];
  if (account.modelsAuthoritative !== true || !models.length) return true;
  return models.some(m => baseModel(m) === baseModel(model));
}

function aliasOf(dataDir, id) {
  if (id === 'personal') return '个人';
  try { return require('./codeagent-quota').aliasMap(dataDir).get(id) || '号池账号'; } catch { return '号池账号'; }
}

function sharedClient(dataDir) {
  try { return !!require('./lan-pool').read(dataDir).client?.enabled; } catch { return false; }
}

function defaultAccounts(dataDir) {
  const pool = require('./codeagent-pool');
  let personalAccountId = '';
  try { personalAccountId = pool.readCredentials(require('./codeagent-config').resolveCodeAgentConfig(process.env).configDir).accountId || ''; } catch { /* 只用来标重复 */ }
  return pool.withPauseStatus(dataDir, pool.listAccounts(dataDir, { personalAccountId }));
}

/**
 * -> null（自动分配）| { id, label }。label 是代称（个人 / 号 N），不含工号和备注。
 * 新建时选的号不能用会抛错（错误信息直接给用户看）。
 */
function resolveCompanyProxyAccount({ dataDir, pick, stored, model = '', shared = sharedClient(dataDir), listAccounts = defaultAccounts } = {}) {
  // 团队共享主机：号由主机分配，这台电脑不固定号。
  if (shared) return null;
  const kept = proxy.normalizePin(stored);
  if (kept) return { id: kept, label: aliasOf(dataDir, kept) };
  const id = String(pick || '').trim();
  if (!id || id === 'auto') return null;
  if (id === 'personal') return { id, label: '个人' };
  if (!proxy.normalizePin(id)) throw new Error('所选账号不认识，请重新选择');
  const alias = aliasOf(dataDir, id);
  const account = (listAccounts(dataDir) || []).find(a => a && a.id === id);
  if (!account) throw new Error('选的号已不在号池里，请重新选择');
  if (account.state !== 'ready') throw new Error(`${alias} 需要号主重新登录，未启动会话`);
  if (account.sameAsPersonal || account.duplicateOf) throw new Error(`${alias} 和别的号重复，不能单独使用`);
  if (account.avoid) throw new Error(`${alias} 已暂停使用，请在左栏「账号」恢复后再新建会话，或选「自动挑号」`);
  if (!accountHasModel(account, model)) throw new Error(`${alias} 没有 ${model} 的权限，请换一个号或换一个模型`);
  return { id, label: alias };
}

module.exports = { resolveCompanyProxyAccount, accountHasModel };
