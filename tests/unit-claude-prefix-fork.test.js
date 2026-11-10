'use strict';

// All records here are synthetic; no user transcript is a test fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { forkClaudePrefix, listTranscriptTurns, readStableTranscript, projectSlug, reasonText } = require('../core/claude-prefix-fork');
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const at = n => new Date(1700000000000 + n * 1000).toISOString();
const user = (uuid, text, extra = {}) => ({ type: 'user', uuid, parentUuid: null, isSidechain: false,
  sessionId: SOURCE_ID, timestamp: at(0), message: { role: 'user', content: text }, ...extra });
const answer = (uuid, parentUuid, extra = {}) => ({ type: 'assistant', uuid, parentUuid, isSidechain: false,
  sessionId: SOURCE_ID, timestamp: at(1), message: { role: 'assistant', id: 'message-' + uuid,
    content: [{ type: 'text', text: '合成回答' }], stop_reason: 'end_turn' }, ...extra });
function threeTurns() {
  return [user('u1', '记住甲=123'), answer('a1', 'u1'), user('u2', '把甲改成456', { parentUuid: 'a1' }),
    answer('a2', 'u2'), user('u3', '再聊一句', { parentUuid: 'a2' }), answer('a3', 'u3')];
}
function fixture(t, rows = threeTurns()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-fork-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'account'), cwd = path.join(root, 'project');
  const bucket = path.join(configDir, 'projects', projectSlug(cwd));
  fs.mkdirSync(bucket, { recursive: true });
  fs.mkdirSync(cwd);
  const sourceFile = path.join(bucket, SOURCE_ID + '.jsonl');
  const write = records => fs.writeFileSync(sourceFile, records.map(JSON.stringify).join('\n') + '\n');
  write(rows);
  return { root, sourceFile, write, configDir, cwd, bucket,
    options: { sourceFile, configDir, cwd, cutUserUuid: 'u2', newSessionId: NEW_ID } };
}
function readRows(file) { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse); }
function script(f, args, env = {}) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/codeagent-prefix-fork-try.js'), ...args,
    '--cwd', f.cwd, '--config-dir', f.configDir], { cwd: f.root, encoding: 'utf8',
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: path.join(f.root, 'hub-data'), ...env }, windowsHide: true });
}

test('three turns: exclusive second user cut, exact identity rewrite, source bytes and timestamps unchanged', t => {
  const f = fixture(t), before = fs.readFileSync(f.sourceFile), stat = fs.statSync(f.sourceFile);
  const result = forkClaudePrefix(f.options);
  assert.deepEqual(result, { ok: true, newSessionId: NEW_ID, file: path.join(f.bucket, NEW_ID + '.jsonl'),
    keptLines: 2, droppedLines: 4, cutUserUuid: 'u2', reason: null });
  const rows = readRows(result.file);
  assert.deepEqual(rows.map(row => row.uuid), ['u1', 'a1']);
  assert.equal(rows[1].parentUuid, 'u1');
  assert.ok(rows.every(row => row.sessionId === NEW_ID));
  assert.deepEqual(fs.readFileSync(f.sourceFile), before);
  assert.equal(fs.statSync(f.sourceFile).size, stat.size);
  assert.equal(fs.statSync(f.sourceFile).mtimeMs, stat.mtimeMs);
  assert.equal(fs.readdirSync(f.bucket).some(name => name.endsWith('.tmp')), false);
});

test('skill opener is one real turn; cutting it removes its isMeta material and answer', t => {
  const rows = threeTurns();
  rows[2] = user('skill-opener', '<command-message>fake-skill</command-message>\n<command-name>/fake-skill</command-name>\n<command-args>合成\n参数</command-args>',
    { isMeta: true, promptId: 'skill-prompt', parentUuid: 'a1' });
  rows.splice(3, 0, user('skill-body', 'Base directory for this skill: C:/example-project\n合成技能材料',
    { isMeta: true, promptId: 'skill-prompt', parentUuid: 'skill-opener' }));
  rows[4].parentUuid = 'skill-body';
  const f = fixture(t, rows), result = forkClaudePrefix({ ...f.options, cutUserUuid: 'skill-opener' });
  assert.equal(result.ok, true);
  assert.deepEqual(readRows(result.file).map(row => row.uuid), ['u1', 'a1']);
  assert.equal(listTranscriptTurns(rows)[1].text, '/fake-skill 合成\n参数');
});

test('tool calls and results must both be retained exactly once', t => {
  const rows = threeTurns();
  rows[1].message.content = [{ type: 'tool_use', id: 'tool-one', name: 'fake_tool', input: {} }];
  const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'unpaired-tool');
  rows.splice(2, 0, user('tool-result', [{ type: 'tool_result', tool_use_id: 'tool-one', content: '合成结果' }], { parentUuid: 'a1' }));
  rows[3].parentUuid = 'tool-result';
  f.write(rows);
  assert.equal(forkClaudePrefix(f.options).ok, true);
});

test('orphan tool_result is refused', t => {
  const rows = threeTurns();
  rows.splice(2, 0, user('orphan', [{ type: 'tool_result', tool_use_id: 'missing', content: '合成' }], { parentUuid: 'a1' }));
  const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'unpaired-tool');
});

for (const metadata of [
  { preservedSegment: { headUuid: 'u1', anchorUuid: 'u2', tailUuid: 'a1' } },
  { preservedMessages: { anchorUuid: 'a1', uuids: ['u1', 'u3'], allUuids: ['u1'] } },
  { runningTurnSends: { uuids: ['u1'], openerUuid: 'u2' } },
]) test('compact references outside prefix are refused: ' + Object.keys(metadata)[0], t => {
  const rows = threeTurns();
  rows.splice(2, 0, { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
    logicalParentUuid: 'a1', sessionId: SOURCE_ID, compactMetadata: metadata });
  const f = fixture(t, rows), result = forkClaudePrefix(f.options);
  assert.equal(result.reason, 'compact-reference-outside-prefix');
  assert.equal(reasonText(result.reason), '压缩记录引用了被截掉的内容');
  assert.equal(fs.existsSync(path.join(f.bucket, NEW_ID + '.jsonl')), false);
});

test('fully retained compact transaction and its hidden summary are preserved', t => {
  const rows = threeTurns();
  rows.splice(2, 0, { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
    logicalParentUuid: 'a1', sessionId: SOURCE_ID, compactMetadata: {
      preservedSegment: { headUuid: 'u1', anchorUuid: 'summary', tailUuid: 'a1' },
      preservedMessages: { anchorUuid: 'summary', uuids: ['u1', 'a1'] },
      runningTurnSends: { uuids: [], openerUuid: 'u1' } } },
  user('summary', '合成压缩摘要', { parentUuid: 'compact', isCompactSummary: true, isVisibleInTranscriptOnly: true }));
  rows[4].parentUuid = 'summary';
  const f = fixture(t, rows), result = forkClaudePrefix(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.keptLines, 4);
  assert.equal(readRows(result.file)[3].isCompactSummary, true);
});

test('compact after the cut has no effect on the retained prefix', t => {
  const rows = threeTurns();
  rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'later-compact', sessionId: SOURCE_ID,
    compactMetadata: { preservedMessages: { anchorUuid: 'u3' } } });
  const f = fixture(t, rows), result = forkClaudePrefix(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.keptLines, 2);
  assert.equal(result.droppedLines, 5);
});

test('last-prompt with a discarded leaf is removed; a retained leaf is kept', t => {
  const rows = threeTurns();
  rows.splice(2, 0, { type: 'last-prompt', sessionId: SOURCE_ID, leafUuid: 'u3', lastPrompt: '不能带入的合成索引' },
    { type: 'last-prompt', sessionId: SOURCE_ID, leafUuid: 'a1', lastPrompt: '保留的合成索引' });
  const f = fixture(t, rows), result = forkClaudePrefix(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.keptLines, 3);
  assert.equal(result.droppedLines, 5);
  assert.deepEqual(readRows(result.file).filter(row => row.type === 'last-prompt').map(row => row.leafUuid), ['a1']);
});

test('rewrite only top-level identity, including proven session_id alias; prose and nested identity stay untouched', t => {
  const rows = threeTurns();
  rows[0].message.content = SOURCE_ID;
  rows[0].session_id = SOURCE_ID;
  rows[0].nested = { sessionId: SOURCE_ID };
  const f = fixture(t, rows), result = forkClaudePrefix(f.options), first = readRows(result.file)[0];
  assert.equal(first.sessionId, NEW_ID);
  assert.equal(first.session_id, NEW_ID);
  assert.equal(first.message.content, SOURCE_ID);
  assert.equal(first.nested.sessionId, SOURCE_ID);
});

test('unproven session_id alias is refused rather than guessed', t => {
  const rows = threeTurns(); rows[0].session_id = 'some-other-identity';
  const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'session-identity-mismatch');
});

test('existing destination is refused and its bytes stay intact', t => {
  const f = fixture(t), target = path.join(f.bucket, NEW_ID + '.jsonl');
  fs.writeFileSync(target, 'existing destination');
  let observed;
  const fsModule = { ...fs, openSync(file, flags, ...rest) {
    if (file !== target) return fs.openSync(file, flags, ...rest);
    assert.equal(flags, 'wx');
    try { return fs.openSync(file, flags, ...rest); }
    catch (error) { observed = error.code; throw error; }
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'target-exists');
  assert.equal(observed, 'EEXIST');
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing destination');
});

test('before first turn returns empty-prefix without creating any destination', t => {
  const f = fixture(t), result = forkClaudePrefix({ ...f.options, cutUserUuid: 'u1' });
  assert.equal(result.reason, 'empty-prefix');
  assert.equal(result.droppedLines, 6);
  assert.deepEqual(fs.readdirSync(f.bucket), [SOURCE_ID + '.jsonl']);
});

test('changing size on both read attempts is refused; no writes occur', t => {
  const f = fixture(t); let stats = 0;
  const fsModule = { ...fs, fstatSync(fd) {
    const stat = fs.fstatSync(fd); stats++;
    return { ...stat, size: stat.size + (stats % 2 === 0 ? 1 : 0), isFile: () => true };
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'source-changing');
  assert.equal(stats, 4);
  assert.deepEqual(fs.readdirSync(f.bucket), [SOURCE_ID + '.jsonl']);
});

test('a first unstable read is retried once and a stable second attempt succeeds', t => {
  const f = fixture(t); let stats = 0;
  const fsModule = { ...fs, fstatSync(fd) {
    const stat = fs.fstatSync(fd); stats++;
    return { ...stat, size: stat.size + (stats === 2 ? 1 : 0), isFile: () => true };
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).ok, true);
  assert.equal(stats, 4);
});

test('an incomplete last JSON record is retried once, still refused, and source preserved', t => {
  const f = fixture(t), raw = fs.readFileSync(f.sourceFile, 'utf8') + '{"type":"user"';
  fs.writeFileSync(f.sourceFile, raw); let reads = 0;
  const fsModule = { ...fs, openSync(file, flags, ...rest) { if (flags === 'r') reads++; return fs.openSync(file, flags, ...rest); } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'incomplete-json');
  assert.equal(reads, 2);
  assert.equal(fs.readFileSync(f.sourceFile, 'utf8'), raw);
});

test('a partial first read that completes on retry succeeds', t => {
  const f = fixture(t); let reads = 0;
  const fsModule = { ...fs,
    openSync(file, flags, ...rest) { if (flags === 'r') reads++; return fs.openSync(file, flags, ...rest); },
    readSync(fd, buffer, offset, length, position) {
      const count = fs.readSync(fd, buffer, offset, length, position);
      if (reads === 1 && count && position === 0) buffer[offset + count - 1] = 123;
      return count;
    } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).ok, true);
  assert.equal(reads, 2);
});

test('mtime changes without size changes are detected', t => {
  const f = fixture(t); let stats = 0;
  const fsModule = { ...fs, fstatSync(fd) {
    const stat = fs.fstatSync(fd); stats++;
    return { ...stat, mtimeMs: stat.mtimeMs + (stats % 2 === 0 ? 1 : 0), isFile: () => true };
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'source-changing');
  assert.equal(stats, 4);
});

test('complete last record without trailing newline is accepted', t => {
  const f = fixture(t); fs.writeFileSync(f.sourceFile, fs.readFileSync(f.sourceFile, 'utf8').trimEnd());
  assert.equal(forkClaudePrefix(f.options).ok, true);
});

test('unknown metadata referring to a discarded uuid and dangling parents are refused', t => {
  const rows = threeTurns(); rows.splice(2, 0, { type: 'future-format', targetUuid: 'u3', sessionId: SOURCE_ID });
  const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'unknown-reference-outside-prefix');
  const plain = threeTurns(); plain[0].parentUuid = 'missing-parent'; f.write(plain);
  assert.equal(forkClaudePrefix(f.options).reason, 'reference-outside-prefix');
  const nested = threeTurns(); nested.splice(2, 0, { type: 'future-format', content: { reference: { uuid: 'u3' } } }); f.write(nested);
  assert.equal(forkClaudePrefix(f.options).reason, 'unknown-reference-outside-prefix');
});

for (const [record, reason] of [
  [user('u2', '合成旁支', { isSidechain: true }), 'unsupported-sidechain'],
  [user('u2', '/model'), 'unsupported-local-command'],
  [user('u2', '<command-name>/clear</command-name>'), 'unsupported-local-command'],
  [user('u2', '合成技能正文', { isMeta: true }), 'not-human-turn'],
  [{ type: 'attachment', uuid: 'u2', attachment: { type: 'queued_command', source_uuid: 'queued-user' }, sessionId: SOURCE_ID }, 'unsupported-queued-command'],
]) test('unsupported cut is explicit: ' + reason + ':' + (record.message?.content || record.type), t => {
  const rows = threeTurns(); rows[2] = record; const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, reason);
});

test('duplicate UUID and duplicate real prompt aliases cannot choose an arbitrary cut', t => {
  const rows = threeTurns(); rows.push({ ...rows[2] }); const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'ambiguous-cut');
  const plain = threeTurns(); plain[0].promptId = plain[2].promptId = 'same-prompt'; f.write(plain);
  assert.equal(forkClaudePrefix(f.options).reason, 'ambiguous-cut');
});

test('queued source alias and later user echo are refused as queued, not guessed as a turn', t => {
  const rows = threeTurns(); rows.splice(2, 0, { type: 'attachment', uuid: 'queued-attachment', sessionId: SOURCE_ID,
    attachment: { type: 'queued_command', source_uuid: 'u2', prompt: '合成排队内容' } });
  const f = fixture(t, rows);
  assert.equal(forkClaudePrefix(f.options).reason, 'unsupported-queued-command');
});

test('failed exclusive-file write is cleaned up and leaves source unchanged', t => {
  const f = fixture(t), raw = fs.readFileSync(f.sourceFile);
  const fsModule = { ...fs, fsyncSync() { throw new Error('synthetic write failure'); } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'write-failed');
  assert.deepEqual(fs.readFileSync(f.sourceFile), raw);
  assert.deepEqual(fs.readdirSync(f.bucket), [SOURCE_ID + '.jsonl']);
});

test('source changing while the new file is written causes the new file to be removed', t => {
  const f = fixture(t), raw = fs.readFileSync(f.sourceFile); let sourceStats = 0;
  const fsModule = { ...fs, statSync(file, ...args) {
    const stat = fs.statSync(file, ...args);
    if (file !== f.sourceFile) return stat;
    sourceStats++;
    return sourceStats === 3 ? { ...stat, size: stat.size + 1 } : stat;
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'source-changing');
  assert.deepEqual(fs.readFileSync(f.sourceFile), raw);
  assert.deepEqual(fs.readdirSync(f.bucket), [SOURCE_ID + '.jsonl']);
});

test('a target created by another caller immediately before open is never overwritten or removed', t => {
  const f = fixture(t), target = path.join(f.bucket, NEW_ID + '.jsonl'); let raced = false;
  const fsModule = { ...fs, openSync(file, flags, ...rest) {
    if (file === target) { fs.writeFileSync(target, 'synthetic concurrent target'); raced = true; }
    return fs.openSync(file, flags, ...rest);
  } };
  assert.equal(forkClaudePrefix(f.options, { fsModule }).reason, 'target-exists');
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic concurrent target');
});

test('manual script lists sessions and turns, generates the new file and prints source statistics and resume command', t => {
  const f = fixture(t), raw = fs.readFileSync(f.sourceFile);
  const listed = script(f, ['--list']); assert.equal(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes(SOURCE_ID)); assert.match(listed.stdout, /\| 3/);
  const turns = script(f, ['--session', SOURCE_ID]); assert.equal(turns.status, 0, turns.stderr);
  assert.match(turns.stdout, /2 \| u2 \| 把甲改成456/);
  const created = script(f, ['--session', SOURCE_ID, '--before', '2']); assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /保留 2 行，去掉 4 行/);
  assert.match(created.stdout, /源文件 size\/mtime 一致：是/);
  assert.match(created.stdout, /--resume '[0-9a-f-]{36}'/);
  assert.match(created.stdout, /\$env:CODEAGENT3_CONFIG_DIR/);
  assert.deepEqual(fs.readFileSync(f.sourceFile), raw);
  const log = fs.readFileSync(path.join(f.root, 'hub-data/logs/codeagent-prefix-fork.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 3);
  assert.equal(log.includes('记住甲'), false);
  assert.equal(log.includes('把甲改成456'), false);
  assert.equal(log.includes(f.root.replace(/\\/g, '\\\\')), false);
  assert.equal(JSON.parse(log.trim().split('\n').at(-1)).reason, 'created');
});

test('manual script uses default config, limits the listing to five, and logs fallback in cwd', t => {
  const f = fixture(t);
  for (let n = 3; n <= 8; n++) {
    const id = String(n).repeat(8) + '-3333-4333-8333-' + String(n).repeat(12);
    const file = path.join(f.bucket, id + '.jsonl'); fs.copyFileSync(f.sourceFile, file); fs.utimesSync(file, 1700000000 + n, 1700000000 + n);
  }
  const blocked = path.join(f.root, 'blocked-data'); fs.writeFileSync(blocked, 'not a directory');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/codeagent-prefix-fork-try.js'), '--list', '--cwd', f.cwd],
    { cwd: f.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, AI_HUB_CODEAGENT_CONFIG_DIR: f.configDir, CLAUDE_HUB_DATA_DIR: blocked } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n').filter(line => /^[0-9a-f-]{36} \|/.test(line)).length, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'codeagent-prefix-fork.log'), 'utf8')).reason, 'listed');
});

test('manual script rejection is Chinese and does not create a seed', t => {
  const f = fixture(t), result = script(f, ['--session', SOURCE_ID, '--before', '1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /没有提问轮次/);
  assert.deepEqual(fs.readdirSync(f.bucket), [SOURCE_ID + '.jsonl']);
});

test('help documents Node and bundled Electron without launching either CLI', t => {
  const f = fixture(t), result = script(f, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /node scripts\/codeagent-prefix-fork-try.js/);
  assert.match(result.stdout, /ELECTRON_RUN_AS_NODE/);
  assert.match(result.stdout, /electron.exe/);
});
