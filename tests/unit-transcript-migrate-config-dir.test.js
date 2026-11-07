'use strict';
// 工作目录回落后，对话记录要复制到新目录对应的桶，并且只在指定的 CLI 配置目录里找。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateTranscriptsForCwdChange, projectSlug } = require('../core/claude-transcript-locator');

test('migrate copies the transcript into the new cwd bucket under the given configDir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cfg-'));
  try {
    const configDir = path.join(tmp, 'cac');
    const ID = '44444444-4444-4444-8444-444444444444';
    const oldBucket = path.join(configDir, 'projects', 'D--gone-dir');
    fs.mkdirSync(oldBucket, { recursive: true });
    fs.writeFileSync(path.join(oldBucket, ID + '.jsonl'), '{"a":1}\n');
    const toCwd = path.join(tmp, 'home');
    fs.mkdirSync(toCwd);
    const result = migrateTranscriptsForCwdChange({ toCwd, ccSessionIds: [ID], configDir, homeDir: tmp, logger: { warn() {} } });
    assert.strictEqual(result.errors.length, 0);
    const target = path.join(configDir, 'projects', projectSlug(toCwd), ID + '.jsonl');
    assert.ok(fs.existsSync(target));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
    // 另一个配置目录里没有这份记录：不应找到
    const other = migrateTranscriptsForCwdChange({ toCwd, ccSessionIds: [ID], configDir: path.join(tmp, 'other'), homeDir: tmp, logger: { warn() {} } });
    assert.deepStrictEqual(other.missing, [ID]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('session manager migrates before building the CodeAgent launch when cwd fell back', () => {
  const src = fs.readFileSync(require.resolve('../core/session-manager.js'), 'utf8');
  const migrate = src.indexOf('toCwd: spawnCwd, ccSessionIds: [opts.resumeCCSessionId]');
  const build = src.indexOf('codeagentLaunch = buildCodeAgentPtyLaunch(id, kind, opts, spawnCwd');
  assert.ok(migrate > 0 && build > migrate);
});
