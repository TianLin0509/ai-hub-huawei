'use strict';

// Claude 分支（`--resume <源> --fork-session --session-id <新>`）会写一份以新 id 命名的 JSONL。
// 2026-11-07 公司版验收：分支启动时被预先挂上源会话的记录路径，卡片视图一直读源文件，
// 分支里新一轮的回答终端里有、卡片里永远不出现（hook 不在时没有任何改绑）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchTranscriptPath } = require('../core/session-history-state');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers');
const { parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript');

const SOURCE = 'b29c4117-2bc8-45ba-8190-067a16712b66';
const BRANCH = '705330b3-a2ef-48e3-a482-998f817ca92a';

test('Claude 分支不把源会话的记录当成自己的记录', () => {
  const sourceFile = path.join('D:\\x', 'projects', 'D--w', SOURCE + '.jsonl');
  // 分支：源路径只给账号定位和原生 fork 用，不能落到分支自己的 transcriptPath。
  assert.equal(launchTranscriptPath({ forkCCSessionId: SOURCE, resumeTranscriptPath: sourceFile },
    { ownClaudeSessionId: BRANCH }), null);
  // 早先存坏的分支记录恢复时：本会话 id 已知、文件名对不上，同样不认。
  assert.equal(launchTranscriptPath({ resumeCCSessionId: BRANCH, resumeTranscriptPath: sourceFile },
    { ownClaudeSessionId: BRANCH }), null);
  // 普通恢复：文件名就是本会话 id，照旧立即绑定（W3 resume 修复的行为不变）。
  assert.equal(launchTranscriptPath({ resumeCCSessionId: SOURCE, resumeTranscriptPath: sourceFile },
    { ownClaudeSessionId: SOURCE.toUpperCase() }), sourceFile);
  // 其它家族不知道 Claude id 时行为不变；终端 codex fork 仍不挂源路径。
  assert.equal(launchTranscriptPath({ resumeTranscriptPath: '/r/rollout.jsonl' }), '/r/rollout.jsonl');
  assert.equal(launchTranscriptPath({ resumeTranscriptPath: '/r/rollout.jsonl' }, { ptyCodexFork: true }), null);
  assert.equal(launchTranscriptPath({}), null);
});

// promptIdOf：Claude 普通会话每次发送各有一个 promptId；`--fork-session` 写的分支文件把复制来的
// 历史和分支里的新提问全部改写成同一个（2026-11-07 验收实测）。记录 uuid 原样保留。
function rows(sessionId, turns, promptIdOf = index => `prompt-${index}`) {
  const out = [];
  let parent = null;
  turns.forEach(([prompt, answer], index) => {
    const at = Date.parse('2026-11-07T05:25:00.000Z') + index * 20_000;
    const u = `u${index}`, a = `a${index}`;
    out.push({ type: 'user', uuid: u, parentUuid: parent, sessionId, timestamp: new Date(at).toISOString(),
      promptId: promptIdOf(index), message: { role: 'user', content: prompt } });
    out.push({ type: 'assistant', uuid: a, parentUuid: u, sessionId, timestamp: new Date(at + 500).toISOString(),
      message: { id: `msg_${index}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] } });
    parent = a;
  });
  return out.map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('分支发出新一轮后，卡片读到分支自己的回答', async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'claude-fork-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bucket = path.join(root, 'projects', 'D--w');
  fs.mkdirSync(bucket, { recursive: true });
  const sourceFile = path.join(bucket, SOURCE + '.jsonl');
  const branchFile = path.join(bucket, BRANCH + '.jsonl');
  const inherited = [['第一轮', 'MOCK_FINAL: ONE'], ['第二轮', 'MOCK_FINAL: TWO']];
  fs.writeFileSync(sourceFile, rows(SOURCE, inherited));
  // fork 后的文件整份复制了源历史，再加分支里的新一轮。
  fs.writeFileSync(branchFile, rows(BRANCH, [...inherited, ['分支里', 'MOCK_FINAL: BRANCH']], () => 'prompt-fork'));

  const parent = { id: 'p1', hubId: 'p1', kind: 'claude', cwd: 'D:\\w', ccSessionId: SOURCE, transcriptPath: sourceFile };
  const launchOpts = { forkCCSessionId: SOURCE, resumeTranscriptPath: sourceFile };
  const bound = launchTranscriptPath(launchOpts, { ownClaudeSessionId: BRANCH });
  const branch = { id: 'b1', hubId: 'b1', kind: 'claude', cwd: 'D:\\w', ccSessionId: BRANCH,
    branchSourceSessionId: 'p1', branchIndex: 1, ...(bound ? { transcriptPath: bound } : {}) };
  const live = new Map([[parent.id, parent], [branch.id, branch]]);
  const rebinds = [];
  const deps = {
    sessionManager: { getSession: id => live.get(id) || null, updateSessionMeta() {} },
    dataDir: root,
    parseClaudeTranscriptToNativeTurns,
    isCodexCliKind: () => false,
    findTranscriptByCCSessionId: id => [sourceFile, branchFile].find(file => path.basename(file) === id + '.jsonl') || null,
    updateSessionTranscriptBinding: (id, fields) => { rebinds.push([id, fields.transcriptPath]); },
    getPersistedSessions: () => [],
  };
  const result = await parseSessionTranscript({ hubSessionId: 'b1', opts: { limit: 50, fromTail: true } }, deps);
  assert.equal(result.error, null);
  assert.equal(result.transcriptPath, branchFile);
  // 和 Codex 分支一样：每次提问一个用户气泡、每个回答一张卡；复制来的两轮标「分支前」，分支自己的一轮只出现一次。
  assert.deepEqual(result.turns.map(turn => [turn.role, turn.text, !!turn.inherited]), [
    ['user', '第一轮', true], ['assistant', 'MOCK_FINAL: ONE', true],
    ['user', '第二轮', true], ['assistant', 'MOCK_FINAL: TWO', true],
    ['user', '分支里', false], ['assistant', 'MOCK_FINAL: BRANCH', false],
  ]);
  assert.deepEqual(rebinds, [['b1', branchFile]]);
});

test('分支文件里同一个 promptId 不会把后面的提问当成重复', () => {
  const { claudeDiskRecords } = require('../core/claude-disk-transcript');
  const entries = rows(BRANCH, [['第一轮', 'ONE'], ['第二轮', 'TWO'], ['分支里', 'BRANCH']], () => 'prompt-fork')
    .trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
  assert.deepEqual(claudeDiskRecords(entries).map(record => record.finalText),
    ['ONE', 'TWO', 'BRANCH']);
});

test('只有开头复制来的那段算分支前；分支里重说同一句话不算', () => {
  const { mergeInheritedTurns } = require('../core/branch-transcript-inheritance');
  const parent = [{ id: 'u0', role: 'user', text: '继续', ts: 1 }, { id: 'u0:assistant', role: 'assistant', text: '好的', ts: 2 }];
  const child = [...parent, { id: 'u1', role: 'user', text: '继续', ts: 10 }, { id: 'u1:assistant', role: 'assistant', text: '好的', ts: 11 }];
  assert.deepEqual(mergeInheritedTurns(parent, child, { forkAt: 1, sourceSessionId: 'p1' })
    .map(turn => [turn.id, !!turn.inherited, turn.inheritedFrom || null]),
  [['u0', true, 'p1'], ['u0:assistant', true, 'p1'], ['u1', false, null], ['u1:assistant', false, null]]);
  // Codex 分支（子文件不含父历史）照旧：父历史改 id 前置，子会话自己的不动。
  const codex = mergeInheritedTurns(parent, [{ id: 'r9', role: 'user', text: '新问题', ts: 10 }], { forkAt: 5, sourceSessionId: 'p1' });
  assert.deepEqual(codex.map(turn => [turn.id, !!turn.inherited]),
    [['branch-inherited:u0', true], ['branch-inherited:u0:assistant', true], ['r9', false]]);
});
