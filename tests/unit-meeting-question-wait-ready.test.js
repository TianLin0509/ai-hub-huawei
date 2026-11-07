'use strict';
// 开会第一分钟或理解会话轮换时「问一下」：理解会话未就绪不算失败，问题留在队列里等，就绪后自动发送，超时才报错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { createAskAsideService } = require('../main/ask-aside/service.js');

function make({ aside, clock }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-q-'));
  const shell = { dir, workspace: path.join(dir, 'workspace'), changed() {}, sessionBusy: () => false, lastFinal: () => null };
  const m = new MeetingCompanion(shell, { now: () => clock.t, meetingModels: () => [], meetingAsr: { status: () => ({ ready: true }), close() {} }, getMeetingAskAside: () => aside,
    createSession: async () => ({}), getSession: () => null, getSessionMetadata: () => null, sendPrompt: async () => ({ ok: true }) });
  m.tools.start = async () => {}; m.tools.bind = () => {}; m.tools.close = () => {};
  const meeting = m.create({ title: 'Q', audio: [] }); clearInterval(m.timer);
  return { m, id: meeting.id };
}
const notReady = () => Object.assign(new Error('会议上下文尚未就绪，可稍后重试：这个会话还没聊过，没有可以问的内容'), { code: 'MEETING_CONTEXT_NOT_READY' });

test('理解会话未就绪：问题保持排队，就绪后自动发出', async () => {
  const clock = { t: 1_000_000 }; let ready = false;
  const aside = { askMeeting: () => { if (!ready) throw notReady(); return { id: 'req-1' }; } };
  const { m, id } = make({ aside, clock });
  m.control(id, 'ask', '现在讨论到哪了？'); clearInterval(m.timer);
  await m.runQuestion(m.load(id));
  let q = m.load(id).answers[0];
  assert.equal(q.state, 'queued'); assert.match(q.waiting, /就绪/);
  assert.equal(m.load(id).questionJob, null);
  clock.t += 20_000; ready = true;
  await m.runQuestion(m.load(id));
  assert.equal(m.load(id).questionJob.requestId, 'req-1');
  assert.equal(m.load(id).answers[0].state, 'queued');
  m.close();
});

test('一直未就绪：超过等待上限才报错', async () => {
  const clock = { t: 1_000_000 };
  const { m, id } = make({ aside: { askMeeting: () => { throw notReady(); } }, clock });
  m.control(id, 'ask', '在吗？'); clearInterval(m.timer);
  await m.runQuestion(m.load(id));
  assert.equal(m.load(id).answers[0].state, 'queued');
  clock.t += 4 * 60000;
  await m.runQuestion(m.load(id));
  assert.equal(m.load(id).answers[0].state, 'error');
  m.close();
});

test('其他错误仍然立即报错', async () => {
  const clock = { t: 1_000_000 };
  const { m, id } = make({ aside: { askMeeting: () => { throw new Error('请输入有效问题'); } }, clock });
  m.control(id, 'ask', 'x'); clearInterval(m.timer);
  await m.runQuestion(m.load(id));
  assert.equal(m.load(id).answers[0].state, 'error');
  m.close();
});

test('ask-aside：会话还没有 ccSessionId 时带上「未就绪」标记，其他不支持原因不带', () => {
  const live = new Map([['s1', { id: 's1', kind: 'codeagent', cwd: os.tmpdir() }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-'));
  const aside = createAskAsideService({ sessionManager: { getSession: id => live.get(id) || null }, getHubDataDir: () => dir, resolveConfig: () => ({ command: 'codeagent', configDir: dir, configDirEnv: 'X' }), hasHistory: () => true, logger: { warn() {}, error() {} } });
  assert.throws(() => aside.askMeeting({ sessionId: 's1', meetingId: '11111111-1111-4111-8111-111111111111', questionId: '11111111-1111-4111-8111-111111111111', question: 'hi', context: 'c', responseHint: 'h' }), e => e.code === 'MEETING_CONTEXT_NOT_READY');
  assert.throws(() => aside.askMeeting({ sessionId: 'none', meetingId: '11111111-1111-4111-8111-111111111111', questionId: '11111111-1111-4111-8111-111111111111', question: 'hi', context: 'c', responseHint: 'h' }), e => e.code !== 'MEETING_CONTEXT_NOT_READY');
});
