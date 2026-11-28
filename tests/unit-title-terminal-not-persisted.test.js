'use strict';
// O-03（2026-11-28 黄区）：改过名的纯终端会话以前会被标题服务写进 sessions/，平常重启偶尔留下、手动更新后又被清掉。
// 设计口径：终端不跨重启保留——改名只改内存、不落盘；AI 会话改名照旧落盘。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

test('终端会话改名只改内存不落盘；AI 会话改名照旧写进 sessions/', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-terminal-'));
  const prior = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  const stateStore = require('../core/state-store'), sessionStore = require('../core/session-store'), meetingStore = require('../core/meeting-store');
  const { createTitleService } = require('../main/session-title-service');
  const live = new Map([
    ['term-0001', { id: 'term-0001', kind: 'powershell', title: 'PowerShell', userRenamed: false }],
    ['ai-0001', { id: 'ai-0001', hubId: 'ai-0001', kind: 'codeagent', title: '原名', userRenamed: false, updatedAt: 1 }],
  ]);
  let saved = [{ ...live.get('ai-0001') }];
  const sent = [];
  const sessions = { getSession: id => (live.has(id) ? { ...live.get(id) } : null), updateSessionMeta: (id, patch) => Object.assign(live.get(id), patch),
    renameSession: (id, title, opts) => Object.assign(live.get(id), { title, userRenamed: !!opts.userRenamed }) };
  const deps = { sessionManager: sessions, meetingManager: { getMeeting: () => null }, stateStore, sessionStore, meetingStore,
    getLastPersistedSessions: () => saved, setLastPersistedSessions: rows => { saved = rows; }, sendToRenderer: (ch, p) => sent.push([ch, p]) };
  sessionStore.saveSessionFile('ai-0001', live.get('ai-0001'));
  await stateStore.saveForRestart({ version: 1, sessions: saved, meetings: [] });
  t.after(async () => { await stateStore.flushPending(); sessionStore.flushAll(); await meetingStore.flushAll(); if (prior === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = prior; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const service = createTitleService(deps);

  const r1 = await service.rename({ type: 'session', id: 'term-0001', title: '终端-甲' });
  assert.equal(r1.ok, true); assert.equal(r1.record.title, '终端-甲');
  assert.equal(live.get('term-0001').title, '终端-甲', '内存里改了名');
  assert.ok(sent.some(([ch, p]) => ch === 'session-updated' && p.session.id === 'term-0001' && p.session.title === '终端-甲'), '界面收到新名');
  await sessionStore.flushPending?.();
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'term-0001.json')), false, '终端没写进 sessions/');
  assert.equal(saved.some(row => (row.hubId || row.id) === 'term-0001'), false, '终端没进保留清单');

  const r2 = await service.rename({ type: 'session', id: 'ai-0001', title: 'AI-甲' });
  assert.equal(r2.record.title, 'AI-甲');
  await sessionStore.flushPending?.();
  assert.equal(sessionStore.loadSessionFile('ai-0001').title, 'AI-甲', 'AI 会话照旧落盘');
});
