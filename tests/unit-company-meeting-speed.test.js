'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { compactEvents, selectedModel, similar } = require('../core/company-assistant/meeting-context');
const turn = () => new Promise(r => setImmediate(r));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-speed-'));
  let now = 100000, blockedSid, release, rejectQuestion = false;
  const sessions = new Map(), finals = new Map(), prompts = [], retired = [];
  const asideRequests = [], asideResults = new Map();
  const aside = {
    askMeeting(request) {
      if (rejectQuestion) throw new Error('test send failure');
      const id = randomUUID(); asideRequests.push(request); asideResults.set(id, { ...request, id, status: 'running', a: '' }); return { id, status: 'queued' };
    },
    meetingResult: ({ id }) => asideResults.get(id),
  };
  const deps = { dataDir: root, now: () => now, meetingModels: () => [{ id: 'GLM-5.2-WX-Auto' }, { id: 'DeepSeek-Flash-1017', fast: true }], getSession: id => sessions.get(id), createSession: async (_, opts) => { sessions.set(opts.id, opts); }, closeSession: async id => { retired.push(id); sessions.delete(id); },
    getMeetingAskAside: () => aside,
    sendPrompt: async (id, prompt, token) => { prompts.push({ id, prompt, token }); if (id === blockedSid) await new Promise(r => { release = r; }); if (rejectQuestion && /用户在会议中提问/.test(prompt)) return { notSent: true, error: 'test send failure' }; return { ok: true }; }, meetingAsr: { status: () => ({ ready: false }), close() {} } };
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: id => finals.get(id) }, deps);
  m.tools = { start: async () => {}, bind() {}, close() {} };
  try {
    const first = m.create({ speed: 'fast' }); clearInterval(m.timer); m.timer = 1;
    async function finish(slot, text = '总结 [事件 1]') { const state = m.load(first.id), job = state[slot]; if (slot === 'questionJob') Object.assign(asideResults.get(job.requestId), { status: 'done', a: text }); else finals.set(job.sessionId, { id: randomUUID(), text: `${text}\n[会议回执:${job.token}]` }); await m.collect(m.load(first.id), slot); }
    await m.tick(); assert.equal(m.load(first.id).job.kind, 'prime'); assert.equal(m.load(first.id).questionJob, undefined, 'no second terminal warmup');
    assert.equal(sessions.get(first.sessionId).model, 'DeepSeek-Flash-1017'); assert.equal(sessions.size, 1);
    await finish('job', '已就绪');
    let state = m.load(first.id); state.autoUnderstand = false; state.requested = true;
    m.event(state, 'transcript', { at: 100, end: 2000, track: 'system', text: '先固定信道参数，再比较候选算法。' });
    m.event(state, 'transcript', { at: 120, end: 2010, track: 'mic', text: '先固定信道参数，再比较候选算法！' }); m.save(state);
    blockedSid = first.sessionId; const understanding = m.tick(); await turn();
    assert.ok(release, 'understanding send is deliberately blocked');
    m.control(first.id, 'ask', '当前结论？'); await turn(); await turn();
    state = m.load(first.id); assert.equal(state.questionJob.engine, 'ask-aside'); assert.equal(state.job.state, 'sending'); assert.equal(state.questionJob.sourceSessionId, state.job.sessionId);
    const askPrompt = asideRequests.at(-1).context; assert.match(askPrompt, /当前会议理解/); assert.match(askPrompt, /\[1,2\] 00:00 系统声音/);
    assert.ok(prompts.every(p => !p.prompt.includes('当前结论？')), 'question never enters the main terminal');
    await finish('questionJob', '先固定参数'); assert.equal(m.load(first.id).cursor, 0); assert.equal(m.load(first.id).summary, '');
    release(); blockedSid = null; await understanding;
    const file = prompts.find(p => p.id === first.sessionId && /input-/.test(p.prompt)).prompt.match(/input-[\w-]+\.txt/)[0];
    const input = fs.readFileSync(path.join(m.dir(first.id), file), 'utf8'); assert.equal((input.match(/先固定信道参数/g) || []).length, 1); assert.doesNotMatch(input, /audioSeq|recentContext|previousSummary/);
    await finish('job');
    // Three completed understanding turns retire only that lane; the new session reads the skill inside its first round (no separate warmup turn).
    for (let i = 0; i < 2; i++) { state = m.load(first.id); state.requested = true; m.save(state); await m.tick(); await finish('job'); }
    state = m.load(first.id); state.requested = true; m.save(state); await m.tick();
    state = m.load(first.id); assert.equal(state.job.kind, 'understand'); assert.notEqual(state.sessionId, first.sessionId); assert.deepEqual(retired, [first.sessionId]); assert.equal(state.questionSessionId, first.questionSessionId);
    const rounds = prompts.filter(p => /input-/.test(p.prompt));
    assert.ok(rounds.filter(p => p.id === first.sessionId).every(p => !p.prompt.includes('SKILL.md')), 'old session never re-reads the skill');
    assert.deepEqual(rounds.filter(p => p.id === state.sessionId).map(p => p.prompt.includes('SKILL.md')), [true], 'new session reads it once, in its first round');
    await finish('job', '- [T1] 换会话后第一轮'); assert.equal(m.load(first.id).agent.state, 'ready'); assert.equal(m.load(first.id).skillPending, undefined);
    rejectQuestion = true; m.control(first.id, 'ask', '故障问题'); await turn(); await turn(); state = m.load(first.id); const failed = state.answers.at(-1); assert.equal(failed.state, 'error'); assert.match(state.questionError, /test send failure/);
    rejectQuestion = false; m.control(first.id, 'ask', '新问题'); await turn(); await turn(); state = m.load(first.id); const runningToken = state.questionJob.token;
    m.control(first.id, 'retry-question', failed.id); await turn(); assert.equal(m.load(first.id).questionJob.token, runningToken, 'retry never replaces a newer active question');
    await finish('questionJob'); await m.tick(); await finish('questionJob');
    await m.tick(); state = m.load(first.id);
    assert.equal(state.questionJob, null, 'completed questions do not prewarm another terminal');
    assert.equal(state.questionSessionId, null); assert.equal(sessions.size, 1);
    m.control(first.id, 'ask', '第四个问题'); await turn(); await turn();
    assert.equal(m.load(first.id).questionJob.kind, 'question', 'next question uses the already-warm successor');
    assert.throws(() => selectedModel({ speed: 'fast', fastModel: 'Absent-1' }, deps), /不在可用/);
    assert.equal(similar('嗯先固定信道参数再比较', '先固定信道参数再比较啊'), true);
    assert.equal(similar('本轮算法收益为15后续保持同样种子验证', '本轮算法收益为16后续保持同样种子验证'), false, 'changed numbers cannot disappear through fuzzy dedupe');
    assert.equal(similar('本轮暂不采用算法a后续固定种子验证', '本轮采用算法a后续固定种子验证'), false, 'changed decisions remain separate');
    const text = compactEvents([{ seq: 1, kind: 'transcript', at: 0, end: 1000, track: 'mic', text: '同一句' }, { seq: 2, kind: 'transcript', at: 0, end: 1000, track: 'mic', text: '同一句' }, { seq: 3, kind: 'transcript', at: 9000, end: 10000, track: 'system', text: '同一句' }]); assert.equal(text.split('\n').length, 3, 'same-track and distant repetitions remain evidence');
    now += 13 * 60000; Object.assign(asideResults.get(m.load(first.id).questionJob.requestId), { status: 'error', error: '超过 120 秒没答完，已停止' });
    await m.collect(m.load(first.id), 'questionJob'); assert.equal(m.load(first.id).questionJob.state, 'error');
    const endedIds = new Set();
    for (let n = 0; n < 10; n++) {
      const old = { ...m.load(first.id), id: randomUUID(), state: 'ended', events: [], answers: [], job: null, questionJob: null, primeRequested: false, questionPrimeRequested: false, requested: false, finalRequested: false, autoUnderstand: false };
      m.save(old); endedIds.add(old.id);
    }
    const restarted = new MeetingCompanion(m.a, { ...deps, meetingAsr: { status: () => ({ ready: true }), close() {} } });
    restarted.tools = { start: async () => {}, bind() {}, close() {} };
    try {
      restarted.start(); clearInterval(restarted.timer); restarted.timer = 1;
      const load = restarted.load.bind(restarted), reads = [];
      restarted.load = id => { reads.push(id); return load(id); };
      await restarted.tick(); assert.equal(reads.filter(id => endedIds.has(id)).length, 0, 'tick and ASR read none of ten completed meetings after restart');
      const oldId = [...endedIds][0]; restarted.control(oldId, 'ask', '会后补问'); await turn(); await turn();
      assert.equal(restarted.load(oldId).questionJob.kind, 'question', 'an action reactivates a completed meeting');
      const job = restarted.load(oldId).questionJob; Object.assign(asideResults.get(job.requestId), { status: 'done', a: '' });
      await restarted.collect(restarted.load(oldId), 'questionJob'); assert.match(restarted.load(oldId).questionError, /空回复/, 'receipt without content fails immediately');
    } finally { restarted.close(); }
    console.log('meeting speed: parallel lanes, bounded context, compact evidence, model choice and failure recovery PASS');
  } finally { m.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

const test = require('node:test');
const { createAskAsideService } = require('../main/ask-aside/service');
const until = async condition => { const deadline = Date.now() + 5000; while (!condition()) { if (Date.now() > deadline) throw Error('fixture condition timed out'); await turn(); } };

function asideMeetingFixture(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-aside-')), sessions = new Map(), prompts = [], finals = new Map(), closed = [];
  const personal = path.join(root, 'account'); fs.mkdirSync(personal);
  let svc;
  const makeService = () => createAskAsideService({ sessionManager: { getSession: id => sessions.get(id) }, getHubDataDir: () => root,
    resolveConfig: () => ({ command: 'codeagent', configDirEnv: 'CODEAGENT3_CONFIG_DIR', configDir: personal }), hasHistory: () => true, run });
  svc = makeService();
  const deps = { dataDir: root, getMeetingAskAside: () => svc, meetingModels: () => [{ id: 'fixture-model' }], getSession: id => sessions.get(id), createSession: async (_kind, options) => sessions.set(options.id, options),
    closeSession: async id => { closed.push(id); sessions.delete(id); },
    sendPrompt: async (...args) => { prompts.push(args); return { ok: true }; }, meetingAsr: { status: () => ({ ready: false }), close() {} } };
  const owner = { dir: root, workspace: root, changed() {}, sessionBusy: () => true, lastFinal: id => finals.get(id) };
  const makeCompanion = () => { const m = new MeetingCompanion(owner, deps); m.tools = { start: async () => {}, bind() {}, close() {} }; return m; };
  const m = makeCompanion(), first = m.create({ title: '后台会议测试' }); clearInterval(m.timer); m.timer = 1;
  sessions.set(first.sessionId, { kind: 'codeagent', cwd: root, ccSessionId: randomUUID(), currentModel: { id: 'fixture-model' } });
  first.primeRequested = false; first.autoUnderstand = false; m.save(first);
  const companions = [m], services = [svc];
  t.after(async () => { for (const item of companions) item.close(); await Promise.all(services.map(item => item.dispose())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, m, first, sessions, prompts, finals, owner, closed, service: () => svc,
    restart: () => { m.close(); svc = makeService(); services.push(svc); const next = makeCompanion(); companions.push(next); return next; } };
}

test('录制中连续三问按编号返回，纪要继续且主终端不接收问题，材料取最近40条', async t => {
  const runs = [], release = [];
  const fx = asideMeetingFixture(t, args => new Promise(resolve => { runs.push(args); release.push(resolve); }));
  const { m, first } = fx;
  const saved = m.load(first.id); saved.summary = '上一版纪要'; saved.job = { kind: 'understand', state: 'running', token: randomUUID(), sessionId: first.sessionId, sentAt: Date.now() };
  for (let n = 1; n <= 45; n++) m.event(saved, 'transcript', { at: n * 1000, end: n * 1000 + 500, track: 'system', text: '明确数据编号' + n });
  m.save(saved); const originalJob = JSON.stringify(saved.job);
  for (const q of ['问题一', '问题二', '问题三']) m.control(first.id, 'ask', q);
  await until(() => runs.length === 1);
  assert.match(runs[0].context, /上一版纪要/); assert.ok(!runs[0].context.includes('明确数据编号5\n')); assert.match(runs[0].context, /明确数据编号6/); assert.match(runs[0].context, /明确数据编号45/);
  assert.equal(m.load(first.id).answers.filter(q => q.state === 'done').length, 0);
  for (let i = 0; i < 3; i++) {
    await until(() => runs.length === i + 1); assert.equal(runs[i].question, ['问题一', '问题二', '问题三'][i]);
    assert.equal(runs[i].model, 'fixture-model');
    release[i]({ answer: '回答' + (i + 1) + ' [事件 6]' }); await fx.service().drain(); await m.tick(); await m.tick();
  }
  const complete = m.load(first.id);
  assert.deepEqual(complete.answers.map(q => q.answer), ['回答1 [事件 6]', '回答2 [事件 6]', '回答3 [事件 6]']);
  assert.equal(complete.summary, '上一版纪要'); assert.equal(JSON.stringify(complete.job), originalJob);
  assert.equal(complete.questionSessionId, null); assert.equal(fx.prompts.length, 0);
});

test('一问失败不阻塞后续两问，旧失败请求迟到不会覆盖后续回答', async t => {
  const calls = [];
  const fx = asideMeetingFixture(t, async args => { calls.push(args.question); if (args.question === '第一问') throw Error('模拟一次失败'); return { answer: args.question + '的答案' }; });
  const saved = fx.m.load(fx.first.id); saved.state = 'ended'; saved.job = { kind: 'understand', state: 'running', token: randomUUID(), sessionId: saved.sessionId, sentAt: Date.now() }; fx.m.save(saved);
  for (const q of ['第一问', '第二问', '第三问']) fx.m.control(saved.id, 'ask', q);
  const stale = fx.m.load(saved.id);
  await fx.service().drain(); await fx.m.tick();
  assert.deepEqual(fx.m.status(saved.id).meeting.answers.map(q => q.state), ['error', 'queued', 'queued']);
  await fx.m.tick(); await fx.service().drain();
  await fx.m.collect(stale, 'questionJob');
  assert.notEqual(fx.m.load(saved.id).questionJob.token, stale.questionJob.token);
  await fx.m.tick(); await fx.m.tick(); await fx.service().drain(); await fx.m.tick();
  const after = fx.m.status(saved.id).meeting;
  assert.deepEqual(calls, ['第一问', '第二问', '第三问']);
  assert.deepEqual(after.answers.map(q => q.state), ['error', 'done', 'done']);
  assert.equal(after.answers[0].error, '模拟一次失败');
  assert.deepEqual(after.answers.slice(1).map(q => q.answer), ['第二问的答案', '第三问的答案']);
  assert.deepEqual(after.job, saved.job); assert.equal(fx.prompts.length, 0);
});

test('已结束会议重启继续后续排队问题，不自动重发失败问题', async t => {
  const calls = [], fx = asideMeetingFixture(t, async args => { calls.push(args.question); return { answer: '后续回答' }; });
  const saved = fx.m.load(fx.first.id), failedId = randomUUID(); saved.state = 'ended';
  saved.answers = [{ id: failedId, q: '失败的旧问题', state: 'error', queuedAt: saved.startedAt + 1000, error: '旧失败' }, { id: randomUUID(), q: '已排队问题', state: 'queued', queuedAt: saved.startedAt + 2000 }];
  saved.questionJob = { kind: 'question', engine: 'ask-aside', state: 'error', questionId: failedId, token: randomUUID() }; fx.m.save(saved);
  const restarted = fx.restart(); restarted.start(); clearInterval(restarted.timer); restarted.timer = 1;
  assert.ok(restarted.pending.has(saved.id)); await restarted.tick(); await fx.service().drain(); await restarted.tick(); await restarted.tick();
  assert.deepEqual(calls, ['已排队问题']); assert.deepEqual(restarted.status(saved.id).meeting.answers.map(q => q.state), ['error', 'done']);
  assert.equal(restarted.pending.has(saved.id), false);
});

test('重试沿用问题编号和原时间流位置，旧无queuedAt记录也保持原位置', async t => {
  const fx = asideMeetingFixture(t, async () => ({ answer: '重试回答' })), saved = fx.m.load(fx.first.id);
  const { flowEntries } = require('../renderer/company-meeting-flow');
  saved.answers = [
    { id: randomUUID(), q: '有原提问时刻', state: 'error', queuedAt: saved.startedAt + 2000, error: '旧失败' },
    { id: randomUUID(), q: '旧记录', state: 'error', at: saved.startedAt + 3000, error: '旧失败' },
  ]; fx.m.save(saved);
  const positions = flowEntries(saved).map(q => ({ key: q.key, at: q.at }));
  fx.m.now = () => saved.startedAt + 60000;
  for (const question of saved.answers) {
    fx.m.control(saved.id, 'retry-question', question.id); await turn(); await fx.service().drain(); await fx.m.tick();
    const latest = fx.m.status(saved.id).meeting;
    assert.deepEqual(flowEntries(latest).map(q => ({ key: q.key, at: q.at })), positions);
    assert.equal(latest.answers.find(q => q.id === question.id).retriedAt, saved.startedAt + 60000);
  }
  assert.equal(fx.m.status(saved.id).meeting.answers.length, 2);
});

test('纪要会话换代与Hub重启后仍按原请求接回完成回答，不重发问题', async t => {
  let resolve, calls = 0;
  const fx = asideMeetingFixture(t, () => new Promise(done => { calls++; resolve = done; }));
  fx.m.control(fx.first.id, 'ask', '换代前的问题'); await until(() => !!resolve);
  const queued = fx.m.load(fx.first.id), oldSource = queued.questionJob.sourceSessionId;
  queued.sessionId = randomUUID(); fx.m.save(queued); fx.sessions.delete(oldSource);
  resolve({ answer: '原上下文的答案' }); await fx.service().drain();
  const restarted = fx.restart(); await restarted.runLane(fx.first.id, 'questionJob');
  assert.equal(restarted.load(fx.first.id).answers[0].answer, '原上下文的答案'); assert.equal(calls, 1); assert.equal(fx.prompts.length, 0);
});

test('后台回答未结束时纪要照常收取并发起下一轮理解', async t => {
  let finish;
  const fx = asideMeetingFixture(t, () => new Promise(resolve => { finish = resolve; }));
  const saved = fx.m.load(fx.first.id), token = randomUUID();
  saved.summary = '## 议题\n- [T1] 旧纪要'; saved.job = { kind: 'understand', sessionId: saved.sessionId, token, state: 'running', sentAt: Date.now(), from: 0, to: 0, final: false };
  fx.m.save(saved); fx.m.control(saved.id, 'ask', '正在回答的问题'); await until(() => !!finish);
  fx.owner.sessionBusy = () => false;
  fx.finals.set(saved.sessionId, { id: randomUUID(), text: '- [T1] 更新后的纪要\n本轮小结：改了议题\n[会议回执:' + token + ']' });
  await fx.m.tick(); let latest = fx.m.load(saved.id);
  assert.equal(latest.summary, '## 议题\n- [T1] 更新后的纪要'); assert.equal(latest.lastChange, '改了议题'); assert.equal(latest.answers[0].state, 'running');
  latest.requested = true; fx.m.save(latest); await fx.m.tick(); latest = fx.m.load(saved.id);
  assert.equal(latest.job.kind, 'understand'); assert.equal(latest.answers[0].state, 'running');
  assert.equal(fx.prompts.length, 1); assert.ok(!fx.prompts[0][1].includes('正在回答的问题'));
  finish({ answer: '后台回答' }); await fx.service().drain(); await fx.m.runLane(saved.id, 'questionJob');
  assert.equal(fx.m.load(saved.id).answers[0].answer, '后台回答');
});

test('关闭后的未完成问题可重试，旧请求迟到不覆盖新问题，错配编号拒绝写入', async t => {
  let calls = 0;
  const fx = asideMeetingFixture(t, async args => { calls++; if (calls === 1) await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true })); return { answer: '回答' + calls }; });
  fx.m.control(fx.first.id, 'ask', '可重试问题'); await until(() => calls === 1);
  const stale = fx.m.load(fx.first.id); await fx.service().dispose();
  const restarted = fx.restart(); await restarted.runLane(fx.first.id, 'questionJob');
  let state = restarted.load(fx.first.id); assert.equal(state.answers[0].state, 'error'); assert.match(state.questionError, /关闭/);
  // Restarted companion has no timer in this fixture; control still exercises its real queue.
  restarted.timer = 1; restarted.control(fx.first.id, 'retry-question', state.answers[0].id); await until(() => calls === 2);
  await fx.service().drain(); await restarted.collect(stale, 'questionJob');
  state = restarted.load(fx.first.id); assert.notEqual(state.questionJob.token, stale.questionJob.token, 'stale collector did not replace the retried request');
  await restarted.runLane(fx.first.id, 'questionJob'); assert.equal(restarted.load(fx.first.id).answers[0].answer, '回答2');
  restarted.control(fx.first.id, 'ask', '编号检查'); await until(() => calls === 3); await fx.service().drain();
  const realResult = fx.service().meetingResult; fx.service().meetingResult = request => ({ ...realResult(request), questionId: randomUUID() });
  await restarted.runLane(fx.first.id, 'questionJob'); assert.match(restarted.load(fx.first.id).questionError, /编号不一致/);
  assert.equal(fx.prompts.length, 0);
});

test('旧版本在途问答只读取原回执，后续问题才走后台', async t => {
  const fx = asideMeetingFixture(t, async () => ({ answer: '新后台答案' }));
  const saved = fx.m.load(fx.first.id), oldSession = randomUUID(), q = { id: randomUUID(), q: '旧问题', state: 'running' };
  saved.answers.push(q); saved.questionSessionId = oldSession; saved.questionPrimeRequested = true;
  saved.questionJob = { kind: 'question', questionId: q.id, token: randomUUID(), sessionId: oldSession, sentAt: Date.now(), state: 'running' };
  fx.m.save(saved); fx.owner.sessionBusy = () => false;
  fx.finals.set(oldSession, { id: randomUUID(), text: '旧问题回答\n[会议回执:' + saved.questionJob.token + ']' });
  await fx.m.runLane(saved.id, 'questionJob'); assert.equal(fx.m.load(saved.id).answers[0].answer, '旧问题回答');
  assert.deepEqual(fx.closed, [oldSession], 'only retire the old question terminal after collecting its answer');
  fx.m.control(saved.id, 'ask', '新问题'); await turn(); await fx.service().drain(); await fx.m.runLane(saved.id, 'questionJob');
  assert.equal(fx.m.load(saved.id).answers[1].answer, '新后台答案'); assert.equal(fx.prompts.length, 0);
});

test('旧预热问答终端精确关闭，错误指向主会话时仅清理引用', async t => {
  const fx = asideMeetingFixture(t, async () => ({ answer: 'unused' }));
  const saved = fx.m.load(fx.first.id), oldSession = randomUUID();
  saved.questionSessionId = oldSession; saved.questionPrimeRequested = true;
  saved.questionJob = { kind: 'prime', sessionId: oldSession, state: 'running' };
  fx.m.save(saved); await fx.m.runLane(saved.id, 'questionJob');
  assert.deepEqual(fx.closed, [oldSession]); assert.equal(fx.m.load(saved.id).questionJob, null);
  const corrupt = fx.m.load(saved.id); corrupt.questionSessionId = corrupt.sessionId; fx.m.save(corrupt);
  await fx.m.runLane(saved.id, 'questionJob');
  assert.deepEqual(fx.closed, [oldSession]); assert.equal(fx.m.load(saved.id).questionSessionId, null);
  assert.ok(fx.sessions.has(saved.sessionId)); assert.equal(fx.prompts.length, 0);
});

test('已结束会议重启时清理旧失败问答终端，保留失败问题并可后台重试', async t => {
  const fx = asideMeetingFixture(t, async () => ({ answer: '重试成功' }));
  const saved = fx.m.load(fx.first.id), oldSession = randomUUID(), q = { id: randomUUID(), q: '旧失败问题', state: 'error', error: '旧等待超时' };
  saved.state = 'ended'; saved.answers.push(q); saved.questionSessionId = oldSession;
  saved.questionJob = { kind: 'question', questionId: q.id, sessionId: oldSession, state: 'error' }; saved.questionError = q.error;
  fx.sessions.set(oldSession, { kind: 'codeagent' }); fx.m.save(saved);
  const restarted = fx.restart(); restarted.start(); clearInterval(restarted.timer); restarted.timer = 1;
  assert.ok(restarted.pending.has(saved.id)); await restarted.tick();
  const after = restarted.load(saved.id);
  assert.deepEqual(fx.closed, [oldSession]); assert.equal(after.questionSessionId, null);
  assert.equal(after.answers[0].state, 'error'); assert.equal(after.answers[0].error, '旧等待超时'); assert.equal(after.questionJob.state, 'error');
  assert.equal(restarted.pending.has(saved.id), false);
  restarted.control(saved.id, 'retry-question', q.id); await turn(); await fx.service().drain(); await restarted.tick();
  assert.equal(restarted.load(saved.id).answers[0].answer, '重试成功'); assert.equal(fx.prompts.length, 0);
});

test('旧预热关闭失败或缺服务保留编号并提示，仅用户重试后重新关闭', async t => {
  for (const mode of ['missing', 'false', 'throw', 'still-live']) {
    const fx = asideMeetingFixture(t, async () => ({ answer: '重试成功' }));
    const saved = fx.m.load(fx.first.id), oldSession = randomUUID(); let attempts = 0;
    saved.state = 'ended'; saved.questionSessionId = oldSession; saved.questionPrimeRequested = true;
    saved.questionJob = { kind: 'prime', sessionId: oldSession, state: 'running' }; fx.sessions.set(oldSession, { kind: 'codeagent' }); fx.m.save(saved);
    const realClose = fx.m.deps.closeSession;
    fx.m.deps.closeSession = mode === 'missing' ? undefined : async () => { attempts++; if (mode === 'throw') throw Error('模拟关闭失败'); return mode === 'false' ? { ok: false, error: '模拟关闭拒绝' } : undefined; };
    await fx.m.tick(); await fx.m.tick();
    const after = fx.m.load(saved.id);
    assert.equal(after.questionSessionId, oldSession, mode); assert.equal(after.questionJob.kind, 'prime');
    assert.match(after.questionError, /未关闭.*已保留会话编号.*再次提问/);
    assert.equal(attempts, mode === 'missing' ? 0 : 1); assert.equal(fx.m.pending.has(saved.id), false);
    fx.m.deps.closeSession = realClose;
    fx.m.control(saved.id, 'ask', '恢复后提问'); await turn(); await fx.service().drain(); await fx.m.tick();
    assert.deepEqual(fx.closed, [oldSession]); assert.equal(fx.m.load(saved.id).questionSessionId, null);
    assert.equal(fx.m.load(saved.id).answers[0].answer, '重试成功');
  }
});
