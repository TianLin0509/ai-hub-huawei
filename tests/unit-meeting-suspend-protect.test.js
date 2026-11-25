'use strict';
// 内存紧张休眠不收走在用的会议会话（2026-11-24 m4 走查）：录制/暂停中或有在途理解、问答作业的会议受保护，结束且无在途后不再保护。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { collectProtectedSessionIds, createSessionAutoSuspendScheduler } = require('../main/session-auto-suspend');

function companion(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-protect-'));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null },
    { powerSaveBlocker: false, meetingAsr: { status: () => ({ ready: false }), close() {} } });
  t.after(() => { m.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return m;
}

test('录制、暂停、有在途作业的会议会话受保护；结束且无在途、或作业已失败的不保护', t => {
  const c = companion(t);
  // 同一时刻只能有一场在采集：先建好各场再把状态改掉，最后建录制中那场。
  const mk = (title, patch) => { const m = c.create({ title }); clearInterval(c.timer); c.timer = 1; Object.assign(m, patch); c.save(m); return m; };
  const p = mk('暂停中', { state: 'ended' });
  const endedBusy = mk('会后在整理', { state: 'ended', job: { kind: 'understand', state: 'running', sessionId: 'job-sid' } });
  const endedQuestion = mk('会后在问答', { state: 'ended', job: null, questionJob: { kind: 'question', engine: 'ask-aside', state: 'queued', sourceSessionId: 'src-sid' } });
  const endedIdle = mk('会后空闲', { state: 'ended', job: null, finalRequested: false, primeRequested: false, requested: false, autoUnderstand: false });
  const endedFailed = mk('会后失败', { state: 'ended', job: { kind: 'start', state: 'error' }, finalRequested: true });
  const pm = c.load(p.id); pm.state = 'paused'; c.save(pm); // 暂停也算在采集
  const live = { ...pm };
  for (const m of [live, p, endedBusy, endedQuestion, endedIdle, endedFailed]) c.pending.add(m.id);
  const ids = c.protectedSessionIds();
  for (const m of [live, p, endedBusy, endedQuestion]) assert.ok(ids.has(m.sessionId), m.title + ' 的理解会话受保护');
  assert.ok(ids.has('job-sid')); assert.ok(ids.has('src-sid'));
  assert.equal(ids.has(endedIdle.sessionId), false, '结束且无在途不再保护');
  assert.equal(ids.has(endedFailed.sessionId), false, '作业已失败不算在途');
});

test('休眠保护名单带上会议会话，公司助理还没建好时不报错', t => {
  const c = companion(t), live = c.create({ title: '录制中' }); clearInterval(c.timer); c.timer = 1;
  assert.ok(collectProtectedSessionIds({ getCompanyMeetings: () => c }).has(live.sessionId));
  assert.equal(collectProtectedSessionIds({ getCompanyMeetings: () => null }).size, 0);
  assert.equal(collectProtectedSessionIds({ getCompanyMeetings: () => { throw new Error('尚未初始化'); } }).size, 0);
});

test('内存 95% 时排在最先的会议理解会话被保护名单挡住，不被休眠', t => {
  const c = companion(t), live = c.create({ title: '录制中' }); clearInterval(c.timer); c.timer = 1;
  const suspended = [];
  const sessionManager = {
    suspendIdleSessions: () => ({ ok: true, count: 0, requested: [] }),
    previewIdleSuspend: opts => ({ items: [
      { sessionId: live.sessionId, purpose: 'company-assistant', eligible: !opts.excludeSessionIds.has(live.sessionId), lastActivityAt: 1 },
      { sessionId: 'other', purpose: 'company-assistant', eligible: true, lastActivityAt: 2 }] }),
    suspendSession: (id, opts) => { if (opts.excludeSessionIds.has(id)) return { ok: false }; suspended.push(id); return { ok: true }; },
  };
  let tick;
  const s = createSessionAutoSuspendScheduler({ sessionManager, getMemoryUsage: () => 0.96, logger: { log() {}, warn() {} },
    getProtectedSessionIds: () => collectProtectedSessionIds({ getCompanyMeetings: () => c }),
    setIntervalFn: fn => { tick ||= fn; return { unref() {} }; }, clearIntervalFn() {} });
  s.start(); tick();
  assert.deepEqual(suspended, ['other']);
  s.stop?.();
});

test('保护名单缓存 4 秒，不在每次内存巡检都重读会议文件', t => {
  const c = companion(t), live = c.create({ title: '录制中' }); clearInterval(c.timer); c.timer = 1;
  let t0 = 1000; c.now = () => t0;
  assert.ok(c.protectedSessionIds().has(live.sessionId));
  const load = t.mock.method(c, 'peek'); // 会议正本常驻内存后保护名单读正本（peek），缓存语义不变
  c.protectedSessionIds(); t0 += 3999; c.protectedSessionIds(); assert.equal(load.mock.callCount(), 0);
  t0 += 2; c.protectedSessionIds(); assert.ok(load.mock.callCount() >= 1);
});
