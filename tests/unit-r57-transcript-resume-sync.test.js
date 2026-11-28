'use strict';
// R57：同一个对话号在几个记录目录里各有一份时，续接与迁移都要用最新的那份；覆盖前核对对话号、非空、没截断；旧的改名备份。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../core/transcript-resume-sync');
const { migrateTranscriptsForCwdChange, projectSlug } = require('../core/claude-transcript-locator');

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const line = (id, cwd, text) => JSON.stringify({ type: 'user', sessionId: id, cwd, message: { content: text } }) + '\n';

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r57-sync-'));
  const configDir = path.join(tmp, 'cac'), home = path.join(tmp, 'home'), orig = path.join(tmp, 'a-proj');
  const file = dir => path.join(configDir, 'projects', projectSlug(dir), ID + '.jsonl');
  const write = (dir, body, ageMs) => {
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    fs.writeFileSync(file(dir), body);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file(dir), t, t);
  };
  return { tmp, configDir, home, orig, file, write, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('原目录里是旧副本、主目录里是最新的：续接前换成最新的，旧的改名备份', () => {
  const f = fixture();
  try {
    f.write(f.orig, line(ID, f.orig, 'OLD-1123'), 3 * 86400e3);
    f.write(f.home, line(ID, f.orig, 'OLD-1123') + line(ID, f.home, 'NEW-1126'), 60e3);
    const result = sync.syncFreshestForResume({ sessionId: ID, cwd: f.orig, configDir: f.configDir });
    assert.strictEqual(result.action, 'synced');
    assert.match(fs.readFileSync(f.file(f.orig), 'utf8'), /NEW-1126/);
    const backup = f.file(f.orig) + sync.BACKUP_SUFFIX;
    assert.ok(fs.existsSync(backup), '旧副本要改名备份');
    assert.doesNotMatch(fs.readFileSync(backup, 'utf8'), /NEW-1126/);
    assert.strictEqual(result.copies.length, 2);
  } finally { f.done(); }
});

test('当前目录那份就是最新的：不动', () => {
  const f = fixture();
  try {
    f.write(f.home, line(ID, f.home, 'OLD'), 3 * 86400e3);
    f.write(f.orig, line(ID, f.orig, 'NEW'), 60e3);
    const before = fs.readFileSync(f.file(f.orig), 'utf8');
    assert.strictEqual(sync.syncFreshestForResume({ sessionId: ID, cwd: f.orig, configDir: f.configDir }).action, 'kept');
    assert.strictEqual(fs.readFileSync(f.file(f.orig), 'utf8'), before);
    assert.ok(!fs.existsSync(f.file(f.orig) + sync.BACKUP_SUFFIX));
  } finally { f.done(); }
});

test('当前目录还没有记录：把最新那份复制过来', () => {
  const f = fixture();
  try {
    f.write(f.orig, line(ID, f.orig, 'ONLY'), 60e3);
    assert.strictEqual(sync.syncFreshestForResume({ sessionId: ID, cwd: f.home, configDir: f.configDir }).action, 'synced');
    assert.match(fs.readFileSync(f.file(f.home), 'utf8'), /ONLY/);
  } finally { f.done(); }
});

for (const [name, body, reason] of [
  ['最新那份里的对话号对不上', line(OTHER, 'x', 'NEW-LONG-ENOUGH-TEXT'), 'session-id-mismatch'],
  ['最新那份是空文件', '', 'freshest-empty'],
  ['最新那份比当前那份小很多（疑似截断）', line(ID, 'x', 'N'), 'freshest-truncated'],
]) {
  test(name + '：只记异常、不覆盖', () => {
    const f = fixture();
    try {
      f.write(f.orig, line(ID, f.orig, 'OLD-' + 'x'.repeat(400)), 3 * 86400e3);
      f.write(f.home, body, 60e3);
      const before = fs.readFileSync(f.file(f.orig), 'utf8');
      const result = sync.syncFreshestForResume({ sessionId: ID, cwd: f.orig, configDir: f.configDir });
      assert.strictEqual(result.action, 'anomaly');
      assert.strictEqual(result.reason, reason);
      assert.strictEqual(fs.readFileSync(f.file(f.orig), 'utf8'), before);
      // 日志带「异常」、不带路径
      const dataDir = path.join(f.tmp, 'hub');
      sync.logSync(dataDir, { hubSessionId: 'abcdef1234', sessionId: ID, cwdFellBack: false, result });
      const log = fs.readFileSync(path.join(dataDir, 'logs', sync.LOG_NAME), 'utf8');
      assert.match(log, /异常/);
      assert.ok(!log.includes(f.tmp) && !log.includes(f.tmp.replace(/\\/g, '\\\\')), '日志里不能有路径');
    } finally { f.done(); }
  });
}

test('迁移（回落、归档）不再拿枚举到的第一份旧副本盖掉更新的目标', () => {
  const f = fixture();
  try {
    // 原目录桶名排在主目录前面：以前 findTranscriptByCCSessionId 先找到它，copyFileSync 直接覆盖今天的记录。
    f.write(f.orig, line(ID, f.orig, 'OLD-1123'), 3 * 86400e3);
    f.write(f.home, line(ID, f.orig, 'OLD-1123') + line(ID, f.home, 'NEW-1126'), 60e3);
    const result = migrateTranscriptsForCwdChange({ toCwd: f.home, ccSessionIds: [ID], configDir: f.configDir, logger: { warn() {} } });
    assert.deepStrictEqual(result.errors, []);
    assert.match(fs.readFileSync(f.file(f.home), 'utf8'), /NEW-1126/);
  } finally { f.done(); }
});

test('迁移时目标是旧副本：用最新那份覆盖，旧的改名备份', () => {
  const f = fixture();
  const third = path.join(f.tmp, 'z-dest');
  try {
    f.write(third, line(ID, third, 'STALE'), 5 * 86400e3);
    f.write(f.orig, line(ID, f.orig, 'MID'), 3 * 86400e3);
    f.write(f.home, line(ID, f.home, 'NEWEST-TEXT'), 60e3);
    migrateTranscriptsForCwdChange({ toCwd: third, ccSessionIds: [ID], configDir: f.configDir, logger: { warn() {} } });
    assert.match(fs.readFileSync(f.file(third), 'utf8'), /NEWEST-TEXT/);
    assert.match(fs.readFileSync(f.file(third) + sync.BACKUP_SUFFIX, 'utf8'), /STALE/);
  } finally { f.done(); }
});

test('CodeAgent 启动记诊断：找不到记录、没绑定对话号都按新对话启动并带「异常」', () => {
  const { _private } = require('../core/session-manager');
  const f = fixture();
  const savedDir = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(f.tmp, 'hub-data');
  fs.mkdirSync(process.env.CLAUDE_HUB_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(f.configDir, 'projects'), { recursive: true });
  const config = { command: 'codeagent-probe-not-installed', configDir: f.configDir, configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const warn = console.warn; console.warn = () => {};
  try {
    const launch = opts => _private.buildCodeAgentPtyLaunch('hub-r57-1', 'codeagent', opts, f.tmp, { USERPROFILE: f.tmp, HOME: f.tmp }, config);
    assert.strictEqual(launch({ resumeCCSessionId: ID }).resumeHistoryMissing, true);
    assert.strictEqual(launch({ codeagentResumeNoIdentity: true }).resumeWithoutIdentity, true);
    assert.strictEqual(launch({}).resumeWithoutIdentity, undefined);
    const rows = fs.readFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR, 'logs', sync.LOG_NAME), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(rows.map(r => [r.event, r.decision, r.reason || null]), [
      ['launch', 'fresh', 'history-missing'], ['launch', 'fresh', 'no-identity'], ['launch', 'fresh', null]]);
    assert.ok(rows.slice(0, 2).every(r => /异常/.test(r.message) && !("note" in r)));
    assert.strictEqual(rows[0].requested, ID.slice(0, 8));
  } finally {
    console.warn = warn;
    if (savedDir === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = savedDir;
    f.done();
  }
});

test('session-manager 在构建 CodeAgent 启动命令之前做续接同步，恢复入口给无号会话打标记', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const at = src.indexOf('syncResumeTranscript({ id, kind, opts, cwd: spawnCwd, configDir: codeagentConfig.configDir');
  const build = src.indexOf('codeagentLaunch = buildCodeAgentPtyLaunch(id, kind, opts, spawnCwd');
  assert.ok(at > 0 && build > at);
  assert.match(src, /codeagentLaunch && codeagentLaunch\.resumeWithoutIdentity\)[\s\S]{0,200}session-notice/);
  const resume = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'resume-session-handlers.js'), 'utf8');
  assert.match(resume, /codeagentResumeNoIdentity: true/);
});
