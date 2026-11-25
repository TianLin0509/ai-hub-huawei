'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os'), path = require('node:path');
const { buildIsolatedHubEnv } = require('./helpers/hub-launcher');
const data = path.join(os.tmpdir(), '20261124-launcher-narrow-m2', 'data');
const external = path.join(path.parse(data).root, 'external-fixture-not-a-real-account');
const narrow = { allowExternalState: ['CLAUDE_CONFIG_DIR'], windowMode: 'hidden' };
test('默认仍拒绝外部Claude目录；窄例外只复用给定路径，不访问目录内容', () => {
  assert.throws(() => buildIsolatedHubEnv(data, { CLAUDE_CONFIG_DIR: external }, {}), /CLAUDE_CONFIG_DIR/);
  const env = buildIsolatedHubEnv(data, { CLAUDE_CONFIG_DIR: external }, {}, narrow);
  assert.equal(env.CLAUDE_CONFIG_DIR, external); assert.equal(env.CLAUDE_HUB_DATA_DIR, data);
  assert.equal(env.CLAUDE_HUB_HOME_DIR, path.join(data, 'isolated-home'));
  assert.equal(env.DEEPSEEK_API_KEY, ''); assert.equal(env.CLAUDE_HUB_E2E, '1'); assert.equal(env.AI_HUB_UPDATE_PROGRESS_UI, '0');
});
test('Claude窄例外保留其他目录和按量Key隔离，不把数组truthy当全局放开', () => {
  const keys = ['CLAUDE_HUB_DATA_DIR', 'CLAUDE_HUB_HOME_DIR', 'CODEX_HOME', 'XRESEARCH_AGENT_LEAGUE_DIR', 'AGENT_STUDY_DIR', 'CLAUDE_HUB_WRITING_ROOT', 'CLAUDE_HUB_WRITING_SKILLS_DIR', 'CLAUDE_HUB_VOICE_DIR'];
  for (const key of keys) assert.throws(() => buildIsolatedHubEnv(data, { CLAUDE_CONFIG_DIR: external, [key]: external }, {}, narrow), /isolated Hub/, key);
  assert.throws(() => buildIsolatedHubEnv(data, { CLAUDE_CONFIG_DIR: external, DEEPSEEK_API_KEY: 'dummy-never-a-real-key' }, {}, narrow), /DEEPSEEK_API_KEY/);
  assert.throws(() => buildIsolatedHubEnv(external, { CLAUDE_CONFIG_DIR: external }, {}, narrow), /OS temp/);
});
test('未知窄例外明确拒绝，空白名单不放开，原true专项仍保持兼容', () => {
  assert.throws(() => buildIsolatedHubEnv(data, {}, {}, { allowExternalState: ['CODEX_HOME'] }), /allowlist/);
  assert.throws(() => buildIsolatedHubEnv(data, {}, {}, { allowExternalState: 'CLAUDE_CONFIG_DIR' }), /boolean/);
  assert.throws(() => buildIsolatedHubEnv(data, { CLAUDE_CONFIG_DIR: external }, {}, { allowExternalState: [] }), /CLAUDE_CONFIG_DIR/);
  const legacy = buildIsolatedHubEnv(data, { CLAUDE_HUB_DATA_DIR: external, CODEX_HOME: external }, {}, { allowExternalState: true });
  assert.equal(legacy.CLAUDE_HUB_DATA_DIR, external); assert.equal(legacy.CODEX_HOME, external);
});
