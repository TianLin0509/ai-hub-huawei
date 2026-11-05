'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const pool = require('../core/codeagent-pool');
const quota = require('../core/codeagent-quota');
const { listTeamAccounts } = require('../main/team/codeagent-accounts');

test('company team accounts use pool permissions, load, duplicate and avoid state without exposing credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = path.join(root, 'personal'), dataDir = path.join(root, 'data');
  fs.mkdirSync(personal);
  const write = (dir, accountId) => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId, xAuthToken: 'test-secret', expiresAt: Date.now() + 60000 } }));
    require('../core/codeagent-model-probe').writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2'], defaultModel: 'GLM-5.2' });
  };
  write(personal, 'personal');
  const ids = Array.from({ length: 5 }, () => pool.addAccount(dataDir));
  write(pool.accountDir(dataDir, ids[0]), 'busy'); write(pool.accountDir(dataDir, ids[1]), 'idle');
  write(pool.accountDir(dataDir, ids[2]), 'busy'); write(pool.accountDir(dataDir, ids[3]), 'personal');
  const get = () => listTeamAccounts({ dataDir, env: { AI_HUB_CODEAGENT_CONFIG_DIR: personal },
    sessionManager: { codeagentPoolActiveCounts: () => ({ [ids[0]]: 2 }) } });
  let result = get();
  assert.equal(result.recommendedId, ids[1]);
  assert.deepEqual(result.rows.map(r => r.usable), [true, true, false, false, false]);
  assert.deepEqual(result.rows[0].models, ['GLM-5.2']); assert.equal(result.rows[0].modelsAuthoritative, true);
  assert.equal(result.rows[0].activeSessions, 2);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
  assert.ok(result.rows.every(r => !('dir' in r) && !('accessToken' in r)));
  quota.markAvoid(dataDir, ids[1], { source: 'manual', until: null });
  result = get(); assert.equal(result.recommendedId, ids[0]); assert.equal(result.rows[1].usable, false);
  assert.equal(result.rows[1].unavailableReason, '暂停中');
  // A previously probed menu default can differ from the account's current
  // settings. Show the launch plan, rather than the stale menu snapshot.
  const dir = pool.accountDir(dataDir, ids[0]);
  require('../core/codeagent-model-probe').writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2', 'MiniMax-M2.7'], defaultModel: 'GLM-5.2' });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'MiniMax-M2.7' }));
  assert.equal(get().rows[0].defaultModel, 'MiniMax-M2.7');
});

function pausedPool(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-model-pause-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), personal = path.join(root, 'personal');
  const ids = Array.from({ length: 2 }, () => pool.addAccount(dataDir));
  for (const id of ids) {
    const dir = pool.accountDir(dataDir, id);
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ idaasOAuth: {
      accountId: id, xAuthToken: 'fixture-secret', expiresAt: Date.now() + 3600000,
    } }));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'GLM-5.2' }));
    require('../core/codeagent-model-probe').writeProbed(path.join(dir, 'hub-models.json'), {
      models: ['GLM-5.2', 'MiniMax-M2.7'], defaultModel: 'GLM-5.2',
    });
  }
  const list = () => listTeamAccounts({ dataDir, sessionManager: {}, env: { AI_HUB_CODEAGENT_CONFIG_DIR: personal } });
  return { dataDir, ids, list };
}

test('team availability follows current-model pauses, keeps other models usable and recovers without writes', t => {
  const { dataDir, ids, list } = pausedPool(t);
  quota.markModelAvoid(dataDir, ids[0], { model: 'MiniMax-M2.7' });
  assert.equal(list().rows[0].usable, true, 'another model must not pause the current account model');
  quota.markModelAvoid(dataDir, ids[0], { model: 'GLM-5.2' });
  const settings = path.join(pool.accountDir(dataDir, ids[0]), 'settings.json');
  const before = { settings: fs.readFileSync(settings, 'utf8'), models: quota.modelAvoidAll(dataDir) };
  const result = list();
  assert.equal(result.rows[0].usable, false, 'the current model pause must be visible before approval');
  assert.equal(result.rows[0].unavailableReason, '暂停中');
  assert.equal(result.recommendedId, ids[1], 'recommendations must skip the paused account');
  assert.deepEqual({ settings: fs.readFileSync(settings, 'utf8'), models: quota.modelAvoidAll(dataDir) }, before);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  quota.clearModelAvoid(dataDir, ids[0], 'GLM-5.2');
  assert.equal(list().rows[0].usable, true, 'clearing the current-model pause restores availability');
  assert.equal(list().rows[0].unavailableReason, '');
  quota.markAvoid(dataDir, ids[0], { source: 'manual', until: null });
  assert.equal(list().rows[0].usable, false, 'whole-account pause remains effective');
});

test('real team accounts reject paused proposals and recheck model pauses before creating any member', async t => {
  const { dataDir, ids, list } = pausedPool(t), created = [];
  const { createTeamService } = require('../main/team/service');
  const service = createTeamService({ getHubDataDir: () => dataDir, listAccounts: list,
    sessionManager: { getSession: id => id === 'lead-0001' ? { id, kind: 'codeagent' } : null, isAgentTurnActive: () => false },
    createSession: async request => { created.push(request); return { id: 'member-0001', kind: 'codeagent' }; },
    submitPrompt: async () => ({ ok: true }),
  });
  t.after(() => { service.freeze(); service.stop(); });
  const args = { goal: 'model pause regression', members: [{ account: ids[0], role: 'review', task: 'verify' }] };
  quota.markModelAvoid(dataDir, ids[0], { model: 'GLM-5.2' });
  assert.equal((await service.invoke('lead-0001', 'accounts')).rows[0].usable, false);
  await assert.rejects(service.invoke('lead-0001', 'propose', args), /账号不可用/);
  assert.equal(service.listTeams().length, 0);
  quota.clearModelAvoid(dataDir, ids[0]);
  const plan = await service.invoke('lead-0001', 'propose', args);
  quota.markModelAvoid(dataDir, ids[0], { model: 'GLM-5.2' });
  await assert.rejects(service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true }), /账号不可用/);
  assert.equal(created.length, 0);
  assert.equal(service.listTeams()[0].plans[0].status, 'pending');
  quota.clearModelAvoid(dataDir, ids[0]);
  const approved = await service.decide({ leadSid: 'lead-0001', planId: plan.planId, approve: true });
  assert.equal(approved.created.length, 1);
  assert.equal(created[0].opts.codeagentPoolPick, ids[0]);
});
