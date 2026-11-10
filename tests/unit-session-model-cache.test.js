'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../core/codeagent-pool');
const OLD = 'GLM-5.2-WX-Auto', NEXT = 'MiniMax-M2.7';

function fixture(t, { at = '2020-01-01T00:00:00.000Z', complete = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-model-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'account'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: OLD }));
  if (complete) fs.writeFileSync(path.join(dir, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [{ value: OLD }, { value: NEXT }] }));
  const probe = path.join(dir, 'hub-models.json');
  fs.writeFileSync(probe, JSON.stringify({ source: 'serve', models: [NEXT], defaultModel: NEXT, ...(at === null ? {} : { at }) }));
  const read = () => pool.accountModels(dir);
  read.configDir = dir;
  return read;
}

test('an expired serve snapshot cannot override a current complete account catalog', t => {
  const known = fixture(t)();
  assert.deepEqual(known.models, [OLD, NEXT]);
  assert.equal(known.defaultModel, OLD);
  assert.equal(known.authoritative, true);
  assert.equal(known.probeReliable, false);
});

test('an expired serve snapshot alone cannot prove that an unlisted fixed model lost permission', t => {
  const known = fixture(t, { complete: false })();
  assert.equal(known.authoritative, false);
  assert.equal(known.probeReliable, false);
  assert.equal(known.models.includes(OLD), true);
  assert.equal(known.defaultModel, OLD);
});

test('a fresh reliable serve snapshot still takes priority over local configuration', t => {
  const known = fixture(t, { at: new Date().toISOString() })();
  assert.deepEqual(known.models, [NEXT]);
  assert.equal(known.defaultModel, NEXT);
  assert.equal(known.authoritative, true);
  assert.equal(known.probeReliable, true);
});

test('a newly written legacy undated serve snapshot uses its known file age', t => {
  const known = fixture(t, { at: null })();
  assert.deepEqual(known.models, [NEXT]);
  assert.equal(known.authoritative, true);
});

for (const policy of ['auto-switch-notify', 'stop-and-ask']) {
  for (const complete of [true, false]) test(`expired evidence preserves a fixed model under ${policy} (complete config=${complete})`, t => {
    const read = fixture(t, { complete }), known = read();
    t.mock.method(require('../core/codeagent-capabilities'), 'readHelp', () => '');
    t.mock.method(require('../core/hub-config'), 'getConfig', () => ({ sessionModelUnavailablePolicy: policy }));
    const requested = complete ? OLD : 'unlisted-but-unproven';
    const resolved = require('../core/session-model-pin').resolveCodeAgentPin({ fixedModel: requested }, {
      configDir: read.configDir, command: 'never-run',
      pool: { account: { models: known.models, modelsAuthoritative: known.authoritative } },
    });
    assert.equal(resolved.fixedModel, requested);
    assert.equal(resolved.modelChanged, false);
  });
}

test('undated historical serve files cannot become fresh just because their date field is missing', t => {
  const read = fixture(t, { at: null });
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(read.configDir, 'hub-models.json'), old, old);
  assert.deepEqual(read().models, [OLD, NEXT]);
  assert.equal(read().probeReliable, false);
});
