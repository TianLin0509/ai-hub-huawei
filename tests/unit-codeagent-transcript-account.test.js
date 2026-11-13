'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSessionTranscript } = require('../main/ipc/transcript-handlers');
const { findTranscriptByCCSessionId } = require('../core/claude-transcript-locator');
const { parseClaudeTranscriptToNativeTurns } = require('../core/claude-disk-transcript');
const { accountProjectsRoot, projectSlugOf } = require('../core/codeagent-transcript-dirs');
const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
const SID = '11111111-1111-4111-8111-111111111111';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-card-account-'));
  const configDir = path.join(root, '非默认账号'), cwd = path.join(root, '中文工作区'), dataDir = path.join(root, 'hub');
  fs.mkdirSync(cwd, { recursive: true });
  const previous = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR;
    else process.env.CLAUDE_HUB_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const writeHistory = (dir, text = '来自本账号的回答') => {
    const file = path.join(dir, 'projects', projectSlugOf(cwd), SID + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { type: 'user', uuid: 'u1', sessionId: SID, cwd, timestamp: '2026-11-13T01:00:00Z', message: { role: 'user', content: '请回答' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SID, cwd, timestamp: '2026-11-13T01:00:01Z',
        message: { id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    return file;
  };
  const record = { id: 'hub-card', hubId: 'hub-card', kind: 'codeagent', cwd, ccSessionId: SID, codeagentConfigDir: configDir };
  const deps = (live = record, persisted = []) => ({
    sessionManager: { getSession: () => live }, getPersistedSessions: () => persisted,
    isCodexCliKind: () => false, parseClaudeTranscriptToNativeTurns,
    findTranscriptByCCSessionId: (id, home, roots) => findTranscriptByCCSessionId(id, root, roots || [path.join(root, 'default', 'projects')]),
    updateSessionTranscriptBinding() {},
  });
  return { root, configDir, cwd, dataDir, record, writeHistory, deps };
}

test('CodeAgent hook 没有 transcript_path 时，卡片按本账号 SID 读非默认中文目录', async t => {
  const f = fixture(t), file = f.writeHistory(f.configDir);
  f.writeHistory(path.join(f.root, 'default'), '其他账号的同名文件');
  const result = await parseSessionTranscript({ hubSessionId: f.record.id }, f.deps());
  assert.equal(result.error, null);
  assert.equal(result.transcriptPath, file);
  assert.deepEqual(result.turns.map(x => x.text), ['请回答', '来自本账号的回答']);
});

test('休眠的 CodeAgent 卡片从保存的账号目录读记录，无需启动 CLI', async t => {
  const f = fixture(t), file = f.writeHistory(f.configDir);
  const result = await parseSessionTranscript({ hubSessionId: f.record.id, kind: 'codeagent' }, f.deps(null, [f.record]));
  assert.equal(result.error, null);
  assert.equal(result.transcriptPath, file);
  assert.equal(result.turns.at(-1).text, '来自本账号的回答');
});

test('绑定文件已迁移时只在本账号恢复相同 SID，不读取其他账号', async t => {
  const f = fixture(t), file = f.writeHistory(f.configDir);
  f.record.transcriptPath = path.join(f.root, 'removed', SID + '.jsonl');
  const recovered = await parseSessionTranscript({ hubSessionId: f.record.id }, f.deps());
  assert.equal(recovered.transcriptPath, file);
  fs.unlinkSync(file);
  f.writeHistory(path.join(f.root, 'default'), '其他账号的回答');
  f.record.transcriptPath = null;
  const missing = await parseSessionTranscript({ hubSessionId: f.record.id }, f.deps());
  assert.deepEqual(missing.turns, []);
  assert.equal(missing.error, 'transcript not found');
});

test('旧号池元数据未存配置目录时仍只查询该号目录', async t => {
  const f = fixture(t);
  delete f.record.codeagentConfigDir;
  f.record.codeagentPoolAccount = 'a12345';
  const configDir = require('../core/codeagent-pool').accountDir(f.dataDir, f.record.codeagentPoolAccount);
  const file = f.writeHistory(configDir);
  assert.equal(accountProjectsRoot(f.record, f.dataDir), path.join(configDir, 'projects'));
  const result = await parseSessionTranscript({ hubSessionId: f.record.id }, f.deps());
  assert.equal(result.transcriptPath, file);
  assert.equal(result.turns.at(-1).text, '来自本账号的回答');
});

test('非法旧号池编号返回卡片错误，不 reject 或查询默认账号', async t => {
  const f = fixture(t);
  delete f.record.codeagentConfigDir;
  f.record.codeagentPoolAccount = '../invalid';
  const deps = f.deps();
  deps.findTranscriptByCCSessionId = () => assert.fail('非法号池不能回退默认账号');
  const result = await parseSessionTranscript({ hubSessionId: f.record.id }, deps);
  assert.deepEqual(result.turns, []);
  assert.equal(result.transcriptPath, null);
  assert.equal(result.error, 'CodeAgent account directory unavailable');
});

test('CodeAgent 配置目录经过会话保存和恢复，随原生 SID 一起传回启动器', async t => {
  const f = fixture(t), file = f.writeHistory(f.configDir);
  const store = require('../core/session-store');
  store.saveSessionFile(f.record.id, f.record);
  const saved = store.loadSessionFile(f.record.id, { strict: true });
  assert.equal(saved.codeagentConfigDir, f.configDir);
  const calls = [];
  const resume = createResumeSessionHandler({
    fs, os, path, getHubDataDir: () => f.dataDir, getHookPort: () => 0,
    isClaudeFamily: kind => /^codeagent(?:-resume)?$/.test(kind), isCodexBaseKind: () => false,
    findTranscriptByCCSessionId: f.deps().findTranscriptByCCSessionId,
    sessionManager: { getSession: () => null, createSession: (kind, opts) => { calls.push(opts); return { id: opts.id, kind }; } },
    slotIds: [], meetingManager: { getAllMeetings: () => [], getMeeting: () => null },
    registerSessionForTap() {}, sendToRenderer() {},
  });
  await resume({ hubId: f.record.id, kind: 'codeagent' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].codeagentConfigDir, f.configDir);
  assert.equal(calls[0].resumeCCSessionId, SID);
  assert.equal(calls[0].resumeTranscriptPath, file);
});
