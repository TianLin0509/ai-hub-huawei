'use strict';
// 2026-11-23 维护人实测两个群聊问题的回归：
// 1. 群聊输入框按 Enter 变换行：a5eda3fb8 删了 renderer.js 的全局 formatPastedFilePaths，meeting-room.js 还在直接引用，
//    输入框初始化中途抛 ReferenceError，Enter 发送监听没挂上。这里静态核对：交给群聊输入工具的每个裸标识符都真有定义。
// 2. 成员答完但没写回答文件：卡片停在「还没交」且没有「提取」。「提取」在回答文件为空时改从会话记录取最终回复写进回答文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function declaredIn(source, name) {
  const decl = new RegExp(`\\b(?:function\\s*\\*?\\s*|(?:const|let|var)\\s+)${name}\\b`);
  if (decl.test(source)) return true;
  // 顶层解构：const { a, b: c, d } = require(...)
  const destructure = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/gm;
  for (const match of source.matchAll(destructure)) {
    const names = match[1].split(',').map(part => part.split(':').pop().split('=')[0].trim()).filter(Boolean);
    if (names.includes(name)) return true;
  }
  return false;
}

test('群聊输入工具收到的函数都有定义（防 formatPastedFilePaths 这类全局被删后输入框整段初始化失败）', () => {
  const meetingRoom = read('renderer/meeting-room.js');
  const renderer = read('renderer/renderer.js');
  // 拼接写法：避免公开版封装扫描把这串文字当成真实的模块引用。
  const start = meetingRoom.indexOf(['group', 'composer', 'tools'].join('-') + "').mountGroupComposerTools({");
  assert.ok(start > 0, '找到群聊输入工具的挂载调用');
  const body = meetingRoom.slice(meetingRoom.indexOf('{', start) + 1, meetingRoom.indexOf('});', start));
  const identifiers = [];
  for (const raw of body.replace(/\/\/[^\n]*/g, '').split(/,\s*(?![^()]*\))/)) {
    const part = raw.trim();
    if (!part) continue;
    const value = part.includes(':') ? part.slice(part.indexOf(':') + 1).trim() : part;
    if (/^[A-Za-z_$][\w$]*$/.test(value) && !['true', 'false', 'null', 'undefined'].includes(value)) identifiers.push(value);
  }
  assert.ok(identifiers.includes('droppedFilePath') && identifiers.includes('ipcRenderer'), `解析出标识符：${identifiers.join(',')}`);
  const missing = identifiers.filter(name => !declaredIn(meetingRoom, name) && !declaredIn(renderer, name));
  assert.deepEqual(missing, [], `这些标识符在 meeting-room.js / renderer.js 里都没有定义：${missing.join(',')}`);
});

test('群聊输入框 Enter 发送监听仍在 setupInput 里绑定', () => {
  const meetingRoom = read('renderer/meeting-room.js');
  const setup = meetingRoom.slice(meetingRoom.indexOf('function setupInput(meeting)'));
  assert.match(setup, /inputBox\.addEventListener\('keydown'[\s\S]*?isSendKey\(e, enterMode\)[\s\S]*?doSend\(\)/);
});

function recoveryFixture({ extractedText = '会话记录里的最终回答' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-extract-'));
  const answerDir = path.join(dir, 'task-docs', 'm1', 'answers', 'turn-2', 'member');
  fs.mkdirSync(answerDir, { recursive: true });
  const entry = { kind: 'plain', dir: answerDir, ready: path.join(answerDir, '回答.md'), memberId: 'member', speaker: 'Claude' };
  const message = { id: 'a2', turnNum: 2, role: 'assistant', sid: 'sid-1', content: '' };
  const orch = {
    state: {
      currentTurn: 2, revision: 7, answerFiles: { 2: { 'sid-1': entry } },
      turns: [{ n: 2, byStatus: { 'sid-1': 'completed' } }],
      messages: [{ id: 'u2', turnNum: 2, role: 'user', content: '问题', createdAt: Date.now() - 1000 }, message],
    },
    answerFileFor: (n, sid) => orch.state.answerFiles[n]?.[sid] || null,
    applyAnswerFile(turnNum, sid, got) { message.content = got.text; message.answer = { state: got.state }; return true; },
    getAttempt: () => null,
  };
  const handlers = {}, sent = [];
  require('../main/ipc/groupchat-recovery-handlers').registerGroupchatRecoveryIpc({ handle: (name, fn) => { handlers[name] = fn; } }, {
    dispatchGroupChatTurn: async () => ({}), getHubDataDir: () => dir, getActiveWatchers: () => new Map(),
    groupchat: { getOrchestrator: () => orch }, groupChatWatcher: { extractStreamingText: () => null },
    logger: { warn() {}, error() {}, log() {} },
    meetingManager: { getMeeting: () => ({ id: 'm1', groupChat: true }) },
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    sessionManager: { getSession: () => ({ kind: 'claude' }) },
    transcriptTap: { extractLatestTurn: async () => (extractedText ? { text: extractedText, source: 'transcript' } : null) },
  });
  return { dir, entry, message, sent, extract: payload => handlers['groupchat-manual-extract']({}, { meetingId: 'm1', sid: 'sid-1', turnNum: 2, ...payload }) };
}

test('「重新提取」不带兜底时：回答文件为空就如实说没交，不碰会话记录', async () => {
  const f = recoveryFixture();
  const r = await f.extract({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'answer_file_missing');
  assert.equal(fs.existsSync(f.entry.ready), false);
});

test('「提取」：回答文件为空时从会话记录取最终回复，写进回答文件并刷新卡片', async () => {
  const f = recoveryFixture();
  const r = await f.extract({ answerFileFallback: 'transcript' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'answer_file_from_transcript');
  assert.equal(fs.readFileSync(f.entry.ready, 'utf8').trim(), '会话记录里的最终回答');
  assert.equal(f.message.content, '会话记录里的最终回答');
  assert.ok(f.sent.some(item => item.channel === 'groupchat:answer-file'));
  assert.deepEqual(fs.readdirSync(f.entry.dir), ['回答.md'], '不留临时文件');
});

test('「提取」：回答文件已有内容时照旧读文件，不用会话记录覆盖', async () => {
  const f = recoveryFixture();
  fs.writeFileSync(f.entry.ready, '成员自己写的回答', 'utf8');
  const r = await f.extract({ answerFileFallback: 'transcript' });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'answer_file_recollect');
  assert.equal(fs.readFileSync(f.entry.ready, 'utf8'), '成员自己写的回答');
});

test('「提取」：会话记录也读不到回答时如实报错，不写空文件', async () => {
  const f = recoveryFixture({ extractedText: '' });
  const r = await f.extract({ answerFileFallback: 'transcript' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_content');
  assert.equal(fs.existsSync(f.entry.ready), false);
});
