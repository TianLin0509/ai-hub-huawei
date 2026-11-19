'use strict';
// 会议记录删除（2026-11-18 反馈「会议记录缺少删除功能」）：只删这一场，采集中不让删，删前要确认。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

function companion(t, deps = {}) {
  const gone = new Set(); // 已关掉的会话；默认关会话成功，会话随即消失

  const base = path.join(__dirname, '../artifacts'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'meeting-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => null }, {
    powerSaveBlocker: false, getSession: sid => (gone.has(sid) ? null : {}), closeSession: async sid => { gone.add(sid); }, meetingAsr: { status: () => ({ ready: false }), close() {} }, ...deps,
  });
  m.tools = { start: async () => {}, bind() {}, close() {}, unbind(x) { (m.unbound ||= []).push(x.id); } };
  m.start = () => {}; m.tick = async () => {}; // 不起后台定时器和理解轮次，只测删除本身
  t.after(() => m.close());
  return m;
}
const ended = (m, title) => { const x = m.create({ title }); m.control(x.id, 'stop'); return m.load(x.id); };

test('删除一场会议：只删它自己的文件夹、关它自己的会话，其他会议和词库不动', async t => {
  const closed = [];
  const m = companion(t, { closeSession: async sid => { closed.push(sid); }, getSession: sid => (closed.includes(sid) ? null : {}) });
  const a = ended(m, '周例会'), b = ended(m, '评审会');
  fs.writeFileSync(path.join(m.dir(a.id), 'page-1.jpg'), 'x');
  const glossary = path.join(m.root, '..', 'glossary-probe.txt'); fs.writeFileSync(glossary, 'OLLA');
  const done = await m.remove(a.id);
  assert.deepEqual(done, { id: a.id, title: '周例会' });
  assert.equal(fs.existsSync(m.dir(a.id)), false, '这一场的文件夹已删');
  assert.deepEqual(m.list().map(x => x.id), [b.id], '另一场还在');
  assert.equal(m.load(b.id).title, '评审会');
  assert.ok(fs.existsSync(glossary), '会议目录外的文件不受影响');
  assert.deepEqual(closed, [a.sessionId], '只关这一场自己的理解会话');
  assert.deepEqual(m.unbound, [a.id]);
  assert.equal(m.pending.has(a.id), false);
  await assert.rejects(() => m.remove(a.id), /会议不存在/);
});

test('采集中、正在整理时不能删；编号不合法直接拒绝', async t => {
  const m = companion(t);
  const live = m.create({ title: '进行中' });
  await assert.rejects(() => m.remove(live.id), /先点「结束会议」/);
  assert.ok(fs.existsSync(m.dir(live.id)));
  m.control(live.id, 'stop');
  m.lanes.add(live.id + ':job');
  await assert.rejects(() => m.remove(live.id), /正在整理/);
  m.lanes.delete(live.id + ':job');
  await m.remove(live.id);
  assert.equal(fs.existsSync(m.dir(live.id)), false);
  await assert.rejects(() => m.remove('../x'), /会议编号无效/);
});

test('IPC 只执行删除；二次确认在页面里用 Hub 自己的确认框（不弹系统窗口），取消就不调用', async t => {
  const m = companion(t);
  const a = ended(m, '待删');
  const handlers = require('../core/company-assistant/meeting-ipc').createMeetingHandlers({ meetings: m });
  const r = await handlers['meeting-delete']({ id: a.id });
  assert.equal(r.ok, true); assert.equal(r.title, '待删');
  assert.equal(fs.existsSync(m.dir(a.id)), false);
  const page = fs.readFileSync(path.join(__dirname, '../renderer/company-meeting-page.js'), 'utf8');
  const branch = page.slice(page.indexOf("op === 'delete-meeting'"), page.indexOf("op === 'save-video'"));
  assert.ok(branch.indexOf('confirmHubAction') >= 0 && branch.indexOf('confirmHubAction') < branch.indexOf("call('meeting-delete'"), '先确认再调用');
  assert.match(branch, /if \(!ok \|\| id !== target\) return;/, '取消或已切到别的会议时不删');
});

// 返工（独立审查 P1）：轮询锁只在一次 tick 里存在，AI 在回复时锁是空的；要按持久的作业状态挡住删除。
const realTick = m => MeetingCompanion.prototype.tick.call(m);

test('理解正在等 AI 回复时（一次真实 tick 之后轮询锁已释放）不能删', async t => {
  const m = companion(t);
  const a = ended(m, '刚结束');
  const x = m.load(a.id); x.job = { kind: 'understand', sessionId: x.sessionId, token: 't1', state: 'running', sentAt: Date.now(), from: 0, to: 0 }; m.save(x);
  m.a.sessionBusy = () => true; // AI 正在写
  await realTick(m);
  assert.equal(m.lanes.size, 0, '复现原问题的前提：tick 结束后轮询锁为空');
  await assert.rejects(() => m.remove(a.id), /正在整理纪要或回答问题/);
  m.a.sessionBusy = () => false; // 两轮回复之间会话空闲，作业仍未收回
  await assert.rejects(() => m.remove(a.id), /正在整理纪要或回答问题/);
  assert.ok(fs.existsSync(m.dir(a.id)));
  const y = m.load(a.id); y.job = { ...y.job, state: 'error' }; m.save(y); // 出错停下后可删
  await m.remove(a.id);
  assert.equal(fs.existsSync(m.dir(a.id)), false);
});

test('「问一下」正在回答时（旁路问答排队或运行中）不能删', async t => {
  const status = { v: 'running' };
  const m = companion(t, { getMeetingAskAside: () => ({ meetingResult: r => ({ questionId: r.qid || 'q1', status: status.v }) }) });
  const a = ended(m, '问答中');
  const x = m.load(a.id);
  x.answers.push({ id: 'q1', q: '谁负责？', state: 'running', queuedAt: Date.now() });
  x.questionJob = { kind: 'question', engine: 'ask-aside', token: 'q-t', sourceSessionId: x.sessionId, questionId: 'q1', requestId: 'r1', state: 'running', sentAt: Date.now() };
  m.save(x);
  await realTick(m);
  assert.equal(m.lanes.size, 0);
  assert.equal(m.load(a.id).questionJob.state, 'running');
  await assert.rejects(() => m.remove(a.id), /正在整理纪要或回答问题/);
  const y = m.load(a.id); y.questionJob = null; y.answers[0].state = 'queued'; m.save(y); // 刚提问、还没派出去
  await assert.rejects(() => m.remove(a.id), /正在整理纪要或回答问题/);
  assert.ok(fs.existsSync(m.dir(a.id)));
});

test('关会话期间：后台轮询跳过这一场；用户又提了问题就不删', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const gone = new Set();
  const m = companion(t, { getSession: sid => (gone.has(sid) ? null : {}), closeSession: async sid => { await gate; gone.add(sid); } });
  const a = ended(m, '关会话中');
  const ran = []; m.runLane = async (id, slot) => { ran.push(id + slot); };
  const p = m.remove(a.id);
  await realTick(m);
  assert.deepEqual(ran, [], '删除进行中，这一场不再派出整理或问答');
  await assert.rejects(() => m.remove(a.id), /正在删除/);
  m.control(a.id, 'ask', '还有问题');
  release();
  await assert.rejects(p, /正在整理纪要或回答问题/);
  assert.ok(fs.existsSync(m.dir(a.id)), '会议保留');
  await realTick(m);
  assert.ok(ran.length > 0, '删除放弃后轮询恢复');
});

// 二次返工（复审 P2）：关会话期间点「手动整理」或重试转写，请求被接受后不能随后把会议删掉。
for (const [op, value] of [['understand'], ['retry-asr']]) test(`关会话期间又点了 ${op}：放弃删除，请求保留，之后可再删`, async t => {
  let release; const gate = new Promise(r => { release = r; });
  const gone = new Set();
  const m = companion(t, { getSession: sid => (gone.has(sid) ? null : {}), closeSession: async sid => { await gate; gone.add(sid); } });
  const a = ended(m, '关会话中点整理');
  const p = m.remove(a.id);
  const st = m.control(a.id, op, value);
  assert.equal(st.ok, true, '请求照常接受');
  if (op === 'understand') assert.equal(m.load(a.id).requested, true);
  release();
  await assert.rejects(p, /删除期间又提交了整理或转写请求，会议没有删/);
  assert.ok(fs.existsSync(m.dir(a.id)), '会议目录保留');
  if (op === 'understand') assert.equal(m.load(a.id).requested, true, '整理请求还在，轮询恢复后会派出');
  assert.equal(m.removing.has(a.id), false, '删除状态已解除');
  // 删除前提交的旧请求不挡下一次删除
  await m.remove(a.id);
  assert.equal(fs.existsSync(m.dir(a.id)), false);
});

// 返工（独立审查 P2）：关会话失败不能删文件、不能报成功。
test('关闭会议会话失败：不删文件，如实报错，之后可重试', async t => {
  const open = new Set(); let fail = true;
  const m = companion(t, {
    getSession: sid => (open.has(sid) ? {} : null),
    closeSession: async sid => { if (fail) throw new Error('CodeAgent 任务会话尚未关闭'); open.delete(sid); },
  });
  const a = ended(m, '关不掉');
  open.add(a.sessionId);
  await assert.rejects(() => m.remove(a.id), /AI 会话没能关闭（CodeAgent 任务会话尚未关闭），会议没有删/);
  assert.ok(fs.existsSync(m.dir(a.id)), '文件夹还在');
  assert.equal(m.load(a.id).sessionId, a.sessionId, '会议与会话的关联保留，供重试');
  assert.deepEqual(m.list().map(x => x.id), [a.id]);
  assert.deepEqual(m.unbound || [], [], '工具口令没收回');
  // 关闭「返回了」但会话其实还在，同样不删
  m.deps.closeSession = async () => ({ ok: true });
  await assert.rejects(() => m.remove(a.id), /会话仍在运行/);
  assert.ok(fs.existsSync(m.dir(a.id)));
  const handlers = require('../core/company-assistant/meeting-ipc').createMeetingHandlers({ meetings: m });
  await assert.rejects(() => handlers['meeting-delete']({ id: a.id }), /会议没有删/);
  fail = false; m.deps.closeSession = async sid => { open.delete(sid); };
  await m.remove(a.id);
  assert.equal(fs.existsSync(m.dir(a.id)), false, '会话关掉后重试成功');
});

test('墓碑文件暂时读不了（被占用）时，删别的会议不会整份覆盖它，已删的会议不会复活', async t => {
  const m = companion(t);
  const f = m.tombstoneFiles()[0];
  const oldId = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify([oldId]), 'utf8');
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { if (path.resolve(String(p)) === path.resolve(f)) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real.call(fs, p, ...rest); };
  try { m.deletedIds = null; m.bury('66666666-7777-8888-9999-000000000000'); }
  finally { fs.readFileSync = real; }
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).includes(oldId), '读不了的墓碑不能被不含旧编号的新内容覆盖');
});
