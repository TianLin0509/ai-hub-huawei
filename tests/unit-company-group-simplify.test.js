'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../main/ipc/meeting-create-handlers.js');
const source = fs.readFileSync(file, 'utf8'), realRequire = createRequire(file);
function create(advanced) {
  const module = { exports: {} }, handlers = new Map();
  const require = name => name === '../../core/distribution' ? { featureEnabled: () => advanced } : realRequire(name);
  vm.runInNewContext(source, { module, exports: module.exports, require, console });
  module.exports.registerMeetingCreateIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    // Reaching launch authentication proves the request passed the distribution
    // boundary without starting or mutating any sessions in this test.
    ensureLaunchAuth: async () => { throw Error('reached-launch-auth'); },
  });
  return opts => handlers.get('create-meeting')(null, { slots: [{ kind: 'codeagent' }], ...opts });
}
test('company rejects advanced new groups before any launch but permits ordinary group creation', async () => {
  const company = create(false);
  for (const opts of [{ mode: 'dev' }, { scene: 'dev' }, { orchestration: { enabled: true } }, { serialWorkflow: { enabled: true } }])
    await assert.rejects(company(opts), /公司版只提供普通群聊/);
  await assert.rejects(company({ mode: 'group', scene: 'general' }), /reached-launch-auth/);
});
test('home retains the existing advanced group creation path', async () => {
  for (const opts of [{ mode: 'dev' }, { orchestration: { enabled: true } }, { serialWorkflow: { enabled: true } }])
    await assert.rejects(create(true)(opts), /reached-launch-auth/);
});
