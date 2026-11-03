'use strict';
// Read the existing pool and model-permission cache; team planning never logs
// in, probes a model, or changes an account's settings.
function listTeamAccounts({ dataDir, sessionManager, env = process.env }) {
  const pool = require('../../core/codeagent-pool');
  const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(env).configDir;
  const avoid = require('../../core/codeagent-quota').activeAvoid(dataDir);
  const accounts = pool.listAccounts(dataDir, {
    activeCounts: sessionManager.codeagentPoolActiveCounts?.() || {},
    personalAccountId: pool.readCredentials(personalDir).accountId,
  });
  const rows = accounts.map(a => ({
    id: a.id, label: pool.label(a), state: a.state,
    usable: a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf && !avoid[a.id],
    activeSessions: a.activeSessions, models: a.models, modelsAuthoritative: a.modelsAuthoritative,
    defaultModel: pool.plannedModel(a.dir, { idle: a.activeSessions === 0 }),
    unavailableReason: a.sameAsPersonal || a.duplicateOf ? '重复账号'
      : avoid[a.id] ? '账号正在避让' : a.state !== 'ready' ? '登录状态不可用' : '',
  }));
  const recommended = pool.pickAccount(accounts.filter(a => rows.find(r => r.id === a.id)?.usable));
  return { kind: 'codeagent', recommendedId: recommended?.id || '', rows };
}
module.exports = { listTeamAccounts };
