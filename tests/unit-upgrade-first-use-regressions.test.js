'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { wrapSync, wrapAsync } = require('../core/fs-rename-retry');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upgrade-first-use-'));
process.env.CLAUDE_HUB_DATA_DIR = dir;
const config = require('../core/hub-config');
const stateStore = require('../core/state-store');
const configFile = path.join(dir, 'config.json');
const busy = () => Object.assign(new Error('sharing violation'), { code: 'EPERM' });

test('30: 空配置或截断配置恢复默认，设置可读取并保存', () => {
  for (const contents of ['', '{broken']) {
    fs.writeFileSync(configFile, contents);
    config.clearConfigCache();
    assert.ok(require('../core/codex-global-account').currentConfig());
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {});
    config.saveConfig({ ...config.readConfigJsonForUpdate(), acp: { restored: true } });
    assert.equal(config.readConfigJsonForUpdate().acp.restored, true);
    fs.rmSync(configFile + '.bak', { force: true });
  }
});

test('30: 损坏主配置优先恢复备份，保留备份及未知字段', () => {
  const previous = { acp: { retained: 1 }, custom: { retained: 2 } };
  const backup = '\uFEFF' + JSON.stringify(previous);
  fs.writeFileSync(configFile + '.bak', backup);
  fs.writeFileSync(configFile, '{broken');
  assert.deepEqual(config.readConfigJsonForUpdate(), previous);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), previous);
  assert.equal(fs.readFileSync(configFile + '.bak', 'utf8'), backup);
});

test('配置真实读取失败仍抛错，不能把权限失败当默认配置覆盖', () => {
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...rest) {
    if (file === configFile) throw busy();
    return read.call(fs, file, ...rest);
  };
  try { assert.throws(() => config.readConfigJsonForUpdate(), { code: 'EPERM' }); }
  finally { fs.readFileSync = read; }
});

test('43: 同步重试不叠加，25.5 秒降为 0.3 秒', () => {
  let calls = 0, waited = 0;
  const rename = wrapSync(() => { calls++; throw busy(); }, { sleep: ms => { waited += ms; } });
  assert.throws(() => stateStore._private._renameWithRetrySync('source', 'target', {
    rename, sleep: ms => { waited += ms; },
  }), { code: 'EPERM' });
  assert.equal(calls, 21);
  assert.equal(waited, 300);
});

test('43: 异步重试也识别已有标记，未包装的临时错误仍可恢复', async () => {
  let calls = 0, outerWait = 0;
  const rename = wrapAsync(async () => { calls++; throw busy(); }, { retries: 2, delayMs: 0 });
  await assert.rejects(stateStore._private._renameWithRetryAsync('source', 'target', {
    rename, sleep: async ms => { outerWait += ms; },
  }), { code: 'EPERM' });
  assert.equal(calls, 3);
  assert.equal(outerWait, 0);
  let attempts = 0;
  assert.equal(await stateStore._private._renameWithRetryAsync('source', 'target', {
    rename: async () => { if (attempts++ < 2) throw busy(); }, sleep: async () => {},
  }), 2);
});

test('43: 启动遇到独占改名失败仍返回状态与原因，解锁后重试保留磁盘记录', async () => {
  const persisted = { version: 1, cleanShutdown: true, sessions: [{ hubId: 'saved', updatedAt: 1 }], meetings: [] };
  fs.writeFileSync(stateStore.STATE_FILE, JSON.stringify(persisted));
  const rename = fs.renameSync;
  fs.renameSync = wrapSync(() => { throw busy(); }, { sleep: () => {} });
  let boot;
  try { boot = stateStore.loadAndSelfHeal(); }
  finally { fs.renameSync = rename; }
  assert.equal(boot.storageWriteError.code, 'EPERM');
  assert.equal(boot.sessions[0].hubId, 'saved');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf8')), persisted);
  await stateStore.saveForRestart({ ...boot, sessions: [] });
  assert.equal(JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf8')).sessions[0].hubId, 'saved');
});

async function dispatch(input, options = {}, meetingOptions = {}) {
  const watcher = require('../core/group-chat-watcher');
  const answers = require('../core/group-answer-files');
  const oldSend = watcher.sendToPty, oldEnabled = answers.enabled;
  const sent = [];
  watcher.sendToPty = async sid => { sent.push(sid); return { ok: false, reason: 'fixture-no-cli' }; };
  answers.enabled = () => false;
  const meeting = { id: 'fixture-group', groupChat: true, subSessions: ['a', 'b'], participants: [0, 1], ...meetingOptions };
  const state = { messages: [], currentTurn: 0 };
  const orch = new Proxy({ state, ensureMemberIdentity: (sid, id) => id,
    beginTurn: () => ({ turnNum: 1, runId: 'fixture-run', didAppendUserMessage: true }),
    pendingUserSupplementsFor: () => [], buildFirstDelta: () => input,
  }, { get: (object, key) => key in object ? object[key] : () => null });
  const dispatcher = require('../main/groupchat/dispatcher').createGroupChatDispatcher({
    getHubDataDir: () => dir, meetingManager: { getMeeting: () => meeting },
    groupchat: { getOrchestrator: () => orch, buildSystemPromptText: () => '' },
    sessionManager: { getSession: sid => ({ id: sid, kind: 'codeagent', title: sid, status: 'idle' }) },
    transcriptTap: { clearStreamingBuf() {} }, maybeAutoTitleMeetingFromPrompt() {},
    sendToRenderer() {}, logger: { warn() {}, log() {} }, isCodexBaseKind: () => false,
  });
  try {
    await dispatcher.dispatchGroupChatTurn(meeting.id, { userInput: input, recipientSids: ['a', 'b'], ...options });
    assert.deepEqual(meeting.participants, meetingOptions.participants || [0, 1], '点亮状态不变');
    return sent;
  } finally { watcher.sendToPty = oldSend; answers.enabled = oldEnabled; }
}

test('普通群聊发送链路：头像全亮时 @m1 只投递成员一，未点亮成员也可点名', async () => {
  assert.deepEqual(await dispatch('@m1帮我看下'), ['a']);
  assert.deepEqual(await dispatch('@m2 看一下', { recipientSids: ['a'] }, { participants: [0] }), ['b']);
});

test('混合未知点名、@所有人、无点名沿用头像选择，内部定向重发不受影响', async () => {
  for (const input of ['普通问题', '@不在群内', '@m1 @不在群内', '@所有人', '@all']) {
    assert.deepEqual(await dispatch(input, { recipientSids: ['b'] }, { participants: [1] }), ['b'], input);
  }
  assert.deepEqual(await dispatch('@m1 @m2看下'), ['a', 'b']);
  assert.deepEqual(await dispatch('@m1', { recipientSids: undefined, targetMemberIds: ['m2'] }), ['b']);
  assert.deepEqual(await dispatch('@m1', {}, { serialWorkflow: { enabled: true } }), ['a', 'b']);
});

test('43: 首屏提示后异步自动重试，解除占用后停止重试，不重复启动', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const code = source.slice(source.indexOf('    if (bootState.storageWriteError'), source.indexOf("    sendToRenderer('hook-status'", source.indexOf('    if (bootState.storageWriteError')));
  const timers = [], notices = [], snapshots = [];
  let blocked = true;
  const context = vm.createContext({
    bootState: { storageWriteError: { code: 'EPERM' } }, global: {},
    lastPersistedSessions: [{ hubId: 'latest-session' }], _immersiveByMeeting: {},
    meetingManager: { getAllMeetings: () => [{ id: 'latest-group' }] },
    sendToRenderer: (channel, payload) => notices.push({ channel, ...payload }),
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; },
    stateStore: { saveForRestart: async snapshot => { snapshots.push(snapshot); if (blocked) throw busy(); } },
  });
  vm.runInContext(code, context);
  vm.runInContext(code, context);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /数据文件暂时被占用，稍后自动重试/);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
  await timers.shift().callback();
  assert.equal(timers.length, 1, '仍占用时只排下一次异步重试');
  blocked = false;
  await timers.shift().callback();
  assert.equal(timers.length, 0);
  assert.equal(snapshots.at(-1).sessions[0].hubId, 'latest-session');
  assert.match(notices.at(-1).message, /保存已恢复/);
});
