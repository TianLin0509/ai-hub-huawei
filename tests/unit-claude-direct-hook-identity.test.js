'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TranscriptTap } = require('../core/transcript-tap');

const user = (uuid, promptId, at) => ({ type: 'user', uuid, promptId,
  timestamp: new Date(at).toISOString(), message: { role: 'user', content: '同一个问题' } });
const answer = (uuid, parentUuid, text, at) => ({ type: 'assistant', uuid, parentUuid,
  timestamp: new Date(at).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text }] } });
function fixture(t, kind, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-hook-identity-'));
  const file = path.join(dir, 'session.jsonl');
  const write = () => fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  write();
  const tap = new TranscriptTap(); tap.registerSession('s', kind, { transcriptPath: file });
  const completed = []; tap.on('turn-complete', event => completed.push(event));
  t.after(() => { tap.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { tap, file, completed, write };
}

for (const kind of ['claude', 'codeagent']) test(`${kind} direct input binds native promptId when its user row precedes the hook`, async t => {
  const at = Date.now() - 5000;
  const rows = [user('old', 'p-old', at - 2000), answer('a-old', 'old', '旧答案', at - 1000),
    user('current', 'p-current', at)];
  const { tap, file, completed, write } = fixture(t, kind, rows);
  // Real Claude Code ordering measured in review: user row precedes hook by
  // 140/317/271 ms. Repeated prompt text makes prompt-only guessing ambiguous.
  await tap.watchClaudeTranscript('s', file, { newTurn: true, turnId: 'p-current', prompt: '同一个问题', at: at + 317 });
  rows.push(answer('a-current', 'current', '当前答案', at + 2000)); write();
  await tap.notifyClaudeStop('s', file, { turnId: 'p-current' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].userRecordId, 'current');
  assert.equal(completed[0].turnId, 'p-current');
  assert.equal(completed[0].text, '当前答案');
});

test('a direct CodeAgent hook without prompt id accepts a pre-hook user row without recycling its previous completion', async t => {
  const at = Date.now() - 5000;
  const rows = [user('old', undefined, at - 2000), answer('a-old', 'old', '旧答案', at - 1000)];
  const { tap, file, completed, write } = fixture(t, 'codeagent', rows);
  await tap.notifyClaudeStop('s', file);
  assert.equal(completed.length, 1);
  await tap.watchClaudeTranscript('s', file, { newTurn: true, prompt: '同一个问题', at: at + 317 });
  await tap.notifyClaudeStop('s', file);
  assert.equal(completed.length, 1, 'no new user record must remain pending');
  rows.push(user('current', undefined, at), answer('a-current', 'current', '当前答案', at + 2000)); write();
  await tap.notifyClaudeStop('s', file);
  assert.equal(completed.length, 2);
  assert.equal(completed[1].userRecordId, 'current');
  assert.equal(completed[1].text, '当前答案');
});

test('a Hub-dispatched prompt with native promptId completes after its delayed hook', async t => {
  const rows = [user('old', 'p-old', Date.now() - 5000)];
  const { tap, file, completed, write } = fixture(t, 'claude', rows);
  tap.notePrompt('s', 'claude', '同一个问题');
  const at = Date.now() + 1;
  rows.push(user('current', 'p-current', at)); write();
  await tap.watchClaudeTranscript('s', file, { newTurn: true, turnId: 'p-current', prompt: '同一个问题', at: at + 317 });
  rows.push(answer('a-current', 'current', '派发回答', at + 1000)); write();
  await tap.notifyClaudeStop('s', file, { turnId: 'p-current' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].userRecordId, 'current');
  assert.equal(completed[0].turnId, 'p-current');
  assert.equal(completed[0].text, '派发回答');
});

test('a Hub dispatch keeps its strict boundary when a late hook cannot identify a new user', async t => {
  const at = Date.now() - 2000;
  const rows = [user('old', 'p-old', at), answer('a-old', 'old', '旧答案', at + 100)];
  const { tap, file, completed } = fixture(t, 'claude', rows);
  tap.notePrompt('s', 'claude', '同一个问题');
  await tap.watchClaudeTranscript('s', file, { newTurn: true, turnId: 'p-new', prompt: '同一个问题', at: Date.now() + 317 });
  await tap.notifyClaudeStop('s', file, { turnId: 'p-new' });
  assert.equal(completed.length, 0);
});
