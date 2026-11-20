'use strict';
// Read the existing pool and model-permission cache; team planning never logs
// in, probes a model, or changes an account's settings.
const PERSONAL_ACCOUNT_ID = 'personal';
const PERSONAL_SHARED_NOTE = '这些成员和你共用同一个号的额度与并发，人多会变慢；想更快可以在号池再登一个别的号';

// 个人账号一行：只读个人配置目录，成员会话和普通个人会话走同一条启动路径。
function personalCandidate({ dataDir, personalDir, credentials, sessionManager }) {
  const pool = require('../../core/codeagent-pool'), quota = require('../../core/codeagent-quota');
  const known = require('../../core/codeagent-model-route').personalModels({ dataDir, personalDir, single: true });
  const state = pool.accountState(credentials);
  const avoid = quota.activeAvoid(dataDir).personal
    || quota.modelAvoidEntry(quota.modelAvoidAll(dataDir), 'personal', pool.readSettingsModel(personalDir)) || null;
  const activeSessions = (sessionManager.getAllSessions?.() || []).filter(s => /^codeagent(?:-resume)?$/.test(String(s.kind || ''))
    && !s.codeagentPoolAccount && s.status !== 'dormant' && s.status !== 'closed').length;
  return { state, avoid, models: known.models || [], modelsAuthoritative: !!known.authoritative, defaultModel: known.defaultModel || '', activeSessions };
}

function listTeamAccounts({ dataDir, sessionManager, env = process.env }) {
  const pool = require('../../core/codeagent-pool');
  const personalDir = require('../../core/codeagent-config').resolveCodeAgentConfig(env).configDir;
  const credentials = pool.readCredentials(personalDir);
  const accounts = pool.withPauseStatus(dataDir, pool.listAccounts(dataDir, {
    activeCounts: sessionManager.codeagentPoolActiveCounts?.() || {},
    personalAccountId: credentials.accountId,
  }));
  const rows = accounts.map(a => ({
    id: a.id, label: pool.label(a), state: a.state,
    usable: a.state === 'ready' && !a.sameAsPersonal && !a.duplicateOf && !a.avoid,
    activeSessions: a.activeSessions, models: a.models, modelsAuthoritative: a.modelsAuthoritative,
    defaultModel: pool.plannedModel(a.dir, { idle: a.activeSessions === 0 }),
    unavailableReason: a.sameAsPersonal ? pool.SAME_AS_PERSONAL_NOTE : a.duplicateOf ? '重复账号'
      : a.avoid ? '暂停中' : a.state !== 'ready' ? '登录状态不可用' : '',
    // 号池这份自己的暂停/登录状态单独带出：同一人时也只在这份本身能用（已登录、没暂停）才按本尊建成员，
    // 暂停或登录过期的照旧拒绝，不借本尊绕过暂停。
    paused: !!a.avoid,
    // 和个人账号或号池里别的号是同一个人：计划里点名它时按它本尊建成员（2026-11-20 单号组队）。
    ...(a.sameAsPersonal ? { sameAs: PERSONAL_ACCOUNT_ID } : a.duplicateOf ? { sameAs: a.duplicateOf } : {}),
  }));
  const usablePool = accounts.filter(a => rows.find(r => r.id === a.id)?.usable);
  const personal = personalCandidate({ dataDir, personalDir, credentials, sessionManager });
  rows.push({
    id: PERSONAL_ACCOUNT_ID, label: '个人账号（与负责人共用额度）', state: personal.state, personal: true,
    usable: personal.state === 'ready' && !personal.avoid,
    activeSessions: personal.activeSessions, models: personal.models, modelsAuthoritative: personal.modelsAuthoritative,
    defaultModel: personal.defaultModel, sharedNote: PERSONAL_SHARED_NOTE,
    unavailableReason: personal.state !== 'ready' ? '个人账号还没登录，请先在左栏「账号」登录' : personal.avoid ? '暂停中' : '',
  });
  // 号池有可用号时照旧优先；没有才落到个人账号。
  const choice = pool.pickAutoChoice(usablePool, personal);
  return { kind: 'codeagent', recommendedId: choice?.personal ? PERSONAL_ACCOUNT_ID : choice?.account?.id || '', rows };
}
module.exports = { listTeamAccounts, PERSONAL_ACCOUNT_ID, PERSONAL_SHARED_NOTE };
