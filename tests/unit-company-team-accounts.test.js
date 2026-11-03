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
  assert.equal(result.rows[1].unavailableReason, '账号正在避让');
  // A previously probed menu default can differ from the account's current
  // settings. Show the launch plan, rather than the stale menu snapshot.
  const dir = pool.accountDir(dataDir, ids[0]);
  require('../core/codeagent-model-probe').writeProbed(path.join(dir, 'hub-models.json'), { models: ['GLM-5.2', 'MiniMax-M2.7'], defaultModel: 'GLM-5.2' });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'MiniMax-M2.7' }));
  assert.equal(get().rows[0].defaultModel, 'MiniMax-M2.7');
});
