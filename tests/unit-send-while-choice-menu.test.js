'use strict';
// 「执行中发的第二条消息没执行」（群分身 #83，2026-11-20）：回答进行中 Claude / Codex 停在权限确认菜单上，
// 会话早已过了启动后的一分钟，旧代码照样把第二条粘贴进菜单再回车——消息被菜单吞掉，回车还替用户选了「Yes」。
// 修复后：认出菜单就不写一个字，返回「未发送」并说明原因。撤掉修复，第一、二条测试失败。
const test = require('node:test');
const assert = require('node:assert/strict');

const CLAUDE_PERMISSION = 'Running…\r\n╭────────────────────────────────────────────╮\r\n│ Bash command                               │\r\n│   npm test                                 │\r\n'
  + '│ Do you want to proceed?                    │\r\n│ ❯ 1. Yes                                   │\r\n│   2. Yes, and don\'t ask again for npm commands │\r\n'
  + '│   3. No, and tell Claude what to do differently (esc) │\r\n╰────────────────────────────────────────────╯\r\n';
const CODEX_APPROVAL = '• Running npm test\r\n\r\n  Would you like to run the following command?\r\n\r\n  $ npm test\r\n\r\n'
  + '› 1. Yes, proceed (y)\r\n  2. Yes, and don\'t ask again for this command (a)\r\n  3. No, and tell Codex what to do differently (esc)\r\n\r\n  Press enter to confirm or esc to cancel\r\n';
const CLAUDE_RUNNING = '● 我先读一下 main.js\r\n  ⎿  Read 120 lines\r\n  1. 先改配置\r\n  2. 再跑测试\r\n✻ Thinking… (esc to interrupt)\r\n╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n';
const CODEX_IDLE = '• 改好了：\r\n  1. 配置\r\n  2. 测试\r\n\r\n› Ask Codex to do anything\r\n  ⏎ send\r\n';

function fakeManager(kind, screen) {
  const writes = [];
  return { writes, sessionManager: {
    getSession: () => ({ id: 's1', kind, createdAt: Date.now() - 10 * 60_000 }),
    getSessionBuffer: () => screen, getGroupChatReady: () => true, setGroupChatReady() {},
    writeToSession: (_id, data) => writes.push(data), write: (_id, data) => writes.push(data),
    getGroupChatLastActivity: () => 0, sessions: new Map(),
  } };
}

async function send(kind, screen) {
  const watcher = require('../core/group-chat-watcher');
  const { writes, sessionManager } = fakeManager(kind, screen);
  watcher.init({ sessionManager, cliReadyDetector: { isReady: () => true, isChoiceDialogVisible: () => false }, transcriptTap: null });
  let error = null;
  try { await watcher.sendToPty('s1', '再帮我看下第二个问题', kind, { requireReady: false }); } catch (e) { error = e; }
  return { error, writes };
}

test('Claude waiting on a permission menu mid-turn: the second message is not typed into it', { timeout: 20000 }, async () => {
  const { error, writes } = await send('claude', CLAUDE_PERMISSION);
  assert.deepEqual(writes, [], 'nothing may be written: no paste, no Enter');
  assert.ok(error, 'must be reported as not sent');
  assert.equal(error.notSent, true);
  assert.equal(error.code, 'cli-choice-pending');
  assert.equal(error.choiceKind, 'permission');
  assert.match(error.message, /未发送/);
});

test('Codex waiting on a command approval mid-turn: the second message is not typed into it', { timeout: 20000 }, async () => {
  const { error, writes } = await send('codex', CODEX_APPROVAL);
  assert.deepEqual(writes, []);
  assert.equal(error?.code, 'cli-choice-pending');
});

test('no menu on screen: normal running/idle screens with numbered output are not mistaken for one', async () => {
  const { visibleChoiceMenu } = require('../core/group-chat-watcher')._private;
  for (const [name, screen] of Object.entries({ CLAUDE_RUNNING, CODEX_IDLE })) {
    const { sessionManager } = fakeManager('claude', screen);
    assert.equal(await visibleChoiceMenu(sessionManager, 's1'), null, name);
  }
  const { sessionManager } = fakeManager('claude', CLAUDE_PERMISSION + '\x1b[2J\x1b[H╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n');
  assert.equal(await visibleChoiceMenu(sessionManager, 's1'), null, 'a menu that was answered and redrawn over does not count');
});

// 审查补充（2026-11-21）：CodeAgent 的「Bypass Permissions mode」警告框（❯ 1. No, exit / 2. Yes, I accept）不能被上面的通用拒发拦下，
// 要交给 codeagent-input-guard 按会话权限档自动选 Yes（rsi-c）。撤掉 skip，这条会以 cli-choice-pending 失败。
test('CodeAgent bypass warning mid-session: send goes on to the guard, which accepts it, not cli-choice-pending', { timeout: 30000 }, async () => {
  const { EventEmitter } = require('node:events');
  const WARNING = ['', '  WARNING: CodeAgent running in Bypass Permissions mode', '',
    '  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.', '',
    '  ❯ 1. No, exit', '    2. Yes, I accept', '', '  Enter to confirm · Esc to cancel'].join('\r\n');
  const IDLE = '\x1b[2J\x1b[H │ > Anything I can assist you with? │\r\n │ Bypass (Cycle shift+tab) | GLM │\r\n';
  let screen = WARNING, snapshots = 0;
  const writes = [];
  const entry = { pty: {}, info: { id: 's1', kind: 'codeagent', agentRuntime: 'pty', status: 'idle', createdAt: Date.now() - 600000 } };
  const sessionManager = Object.assign(new EventEmitter(), {
    sessions: new Map([['s1', entry]]),
    getSession: () => ({ ...entry.info }),
    getSessionBuffer: () => screen,
    // 框晚出现：发送入口的第一次守卫检查时屏幕还是空闲输入框，之后警告框才画出来。
    getSessionBufferSnapshot: async () => ({ text: snapshots++ === 0 ? IDLE : screen, cols: 120, rows: 30, seq: 0, operations: [] }),
    getGroupChatReady: () => true, setGroupChatReady() {}, getGroupChatLastActivity: () => 0,
    writeToSession: (_id, data) => { writes.push(data); if (data === '\r' && screen === WARNING) screen = IDLE; },
  });
  sessionManager.write = sessionManager.writeToSession;
  const watcher = require('../core/group-chat-watcher');
  watcher.init({ sessionManager, cliReadyDetector: { isReady: () => true, isChoiceDialogVisible: () => false }, transcriptTap: null });
  let error = null;
  const run = watcher.sendToPty('s1', '再帮我看下第二个问题', 'codeagent', { requireReady: false }).catch(e => { error = e; });
  await Promise.race([run, new Promise(r => setTimeout(r, 15000))]);
  assert.notEqual(error?.code, 'cli-choice-pending', 'the generic menu refusal must leave the bypass warning to the guard');
  assert.ok(writes.includes('\x1b[B'), 'guard moved to "Yes, I accept": ' + JSON.stringify(writes.slice(0, 6)));
  assert.ok(!writes.includes('\x1b'), 'never Esc (Esc means "No, exit")');
});
