'use strict';
// 分身后端列表只保留一行个人账号，组队兜底不会让它重复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('the avatar backend list keeps exactly one personal row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-personal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { accountId: 'me', xAuthToken: 'fixture-secret', expiresAt: Date.now() + 3600000 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(personal, 'hub-models.json'), { models: ['GLM-5.2'], defaultModel: 'GLM-5.2' });
  const { listAvatarBackends } = require('../main/ipc/avatar-handlers');
  const rows = listAvatarBackends({ dataDir, sessionManager: {}, env: { AI_HUB_CODEAGENT_CONFIG_DIR: personal } }).rows;
  assert.equal(rows.filter(r => r.id === 'personal').length, 1);
  assert.equal(rows.find(r => r.id === 'personal').pool, false);
});
