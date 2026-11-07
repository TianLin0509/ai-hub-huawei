'use strict';

// DSH 的 /fork 把源会话历史整份复制进分支，复制来的那段标「分支前」，分支自己说的不标；休眠会话的记录也能读出来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDshCliTranscript } = require('../core/dsh-cli-session');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers');

let seq = 0;
const T0 = Date.parse('2026-11-07T10:31:00.000Z');
// 一轮：提问、请求头（带模型）、用量与上下文窗口、回答、结束。ids 固定，分支复制时原样保留（实测的 hub-events 就是这样）。
function round(n, id, prompt, answer, model) {
  const at = T0 + n * 10_000;
  return [
    { seq: ++seq, type: 'turn/start', time: at, data: { turn: n } },
    { seq: ++seq, type: 'user/message', time: at + 1, data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } },
    { seq: ++seq, type: 'request/header', time: at + 2, data: { header: { config: { provider: 'company-proxy', model, reasoningEffort: 'high' } } } },
    { seq: ++seq, type: 'request/context', time: at + 3, data: { contextWindow: 128000 } },
    { seq: ++seq, type: 'assistant/message', time: at + 4, data: { turn: n, step: 1, usage: { inputTokens: 10, outputTokens: 5 },
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: answer }] } } },
    { seq: ++seq, type: 'turn/end', time: at + 5, data: { turn: n, reason: { kind: 'completed' } } },
  ];
}
const file = (dir, sessionId, events, later = []) => {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(target, [JSON.stringify({ type: 'ready' }), JSON.stringify({ type: 'bound', sessionId, events }),
    ...later.map(event => JSON.stringify({ type: 'event', sessionId, event }))].join('\n') + '\n');
  return target;
};

test('DSH cards name the model as the speaker; a dormant transcript with usage events still reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cards-'));
  try {
    const events = [...round(1, 'u-1', '第一轮', 'MOCK_FINAL: ONE', 'GLM-5.2-WX'), ...round(2, 'u-2', '第二轮', 'MOCK_FINAL: TWO', 'deepseek-v4.1-flash-1017')];
    const turns = readDshCliTranscript(file(root, 's-1', events));
    assert.deepEqual(turns.map(t => [t.role, t.text, t.model || null]), [
      ['user', '第一轮', null], ['assistant', 'MOCK_FINAL: ONE', 'GLM-5.2-WX'],
      ['user', '第二轮', null], ['assistant', 'MOCK_FINAL: TWO', 'deepseek-v4.1-flash-1017'],
    ]);
    // 渲染层发言人：有 model 就写 model（renderer/turn-card-renderer.js who）。
    const source = fs.readFileSync(path.join(__dirname, '../renderer/turn-card-renderer.js'), 'utf8');
    assert.match(source, /isUser \? '用户' : \(turn\.model \|\|/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSH branch: history copied by /fork is tagged 分支前, the branch own turn is not (dormant and live)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-branch-'));
  try {
    const inherited = [...round(1, 'u-1', '第一轮', 'MOCK_FINAL: ONE', 'GLM-5.2-WX'), ...round(2, 'u-2', '第二轮', 'MOCK_FINAL: TWO', 'GLM-5.2-WX')];
    const sourceFile = file(path.join(root, 'a', '.dsh', 'hub-events'), 'src', inherited);
    // 分支文件：bound 里是复制来的源历史（同 id），之后是分支自己的一轮；「继续」类重说同一句也不算分支前。
    const branchFile = file(path.join(root, 'b', '.dsh', 'hub-events'), 'br', inherited,
      [...round(3, 'u-3', '分支里', 'MOCK_FINAL: BRANCH', 'GLM-5.2-WX'), ...round(4, 'u-4', '第一轮', 'MOCK_FINAL: ONE', 'GLM-5.2-WX')]);
    const parent = { hubId: 'p1', id: 'p1', kind: 'deepseek-acp', transcriptPath: sourceFile };
    const branch = { hubId: 'b1', id: 'b1', kind: 'deepseek-acp', transcriptPath: branchFile, branchSourceSessionId: 'p1' };
    const expected = [
      ['user', '第一轮', true], ['assistant', 'MOCK_FINAL: ONE', true],
      ['user', '第二轮', true], ['assistant', 'MOCK_FINAL: TWO', true],
      ['user', '分支里', false], ['assistant', 'MOCK_FINAL: BRANCH', false],
      ['user', '第一轮', false], ['assistant', 'MOCK_FINAL: ONE', false],
    ];
    const shape = result => result.turns.map(t => [t.role, t.text, !!t.inherited]);

    // 休眠：两边都只剩落盘记录。
    const dormant = { dataDir: root, sessionManager: { getSession: () => null }, getPersistedSessions: () => [parent, branch], isCodexCliKind: () => false };
    const fromDisk = await parseSessionTranscript({ hubSessionId: 'b1', kind: 'deepseek-acp', transcriptPath: branchFile, opts: { limit: 50, fromTail: true } }, dormant);
    assert.equal(fromDisk.error, null);
    assert.deepEqual(shape(fromDisk), expected);
    assert.ok(fromDisk.turns.filter(t => t.inherited).every(t => t.inheritedFrom === 'p1'));
    assert.ok(!fromDisk.turns.some(t => String(t.id).startsWith('branch-inherited:')), 'nothing prepended twice');

    // 活会话：卡片来自 DSH 会话对象自己的 readTranscript。
    const views = { p1: sourceFile, b1: branchFile };
    const native = id => views[id] ? { isCliProvider: true, options: { kind: 'deepseek-acp' }, runtime: {}, start: async () => {},
      readTranscript: options => readDshCliTranscript(views[id], options) } : null;
    const live = new Map([['p1', parent], ['b1', branch]]);
    const liveDeps = { dataDir: root, sessionManager: { getSession: id => live.get(id) || null, getNativeSession: native, updateSessionMeta() {} },
      getPersistedSessions: () => [], isCodexCliKind: () => false };
    const fromLive = await parseSessionTranscript({ hubSessionId: 'b1', opts: { limit: 50, fromTail: true } }, liveDeps);
    assert.deepEqual(shape(fromLive), expected);
    // 只取某一轮（刷新单张卡）不补。
    const one = await parseSessionTranscript({ hubSessionId: 'b1', opts: { latestTurn: true } }, liveDeps);
    assert.ok(one.turns.every(t => !t.inherited));
    // 源会话自己不是分支：不标。
    const own = await parseSessionTranscript({ hubSessionId: 'p1', opts: { limit: 50, fromTail: true } }, liveDeps);
    assert.ok(own.turns.length === 4 && own.turns.every(t => !t.inherited));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
