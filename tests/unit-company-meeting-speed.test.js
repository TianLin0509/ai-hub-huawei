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
  const deps = { dataDir: root, now: () => now, meetingModels: () => [{ id: 'GLM-5.2-WX-Auto' }, { id: 'DeepSeek-Flash-1017', fast: true }], getSession: id => sessions.get(id), createSession: async (_, opts) => { sessions.set(opts.id, opts); }, closeSession: async id => { retired.push(id); sessions.delete(id); },
    sendPrompt: async (id, prompt, token) => { prompts.push({ id, prompt, token }); if (id === blockedSid) await new Promise(r => { release = r; }); if (rejectQuestion && /用户在会议中提问/.test(prompt)) return { notSent: true, error: 'test send failure' }; return { ok: true }; }, meetingAsr: { status: () => ({ ready: false }), close() {} } };
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: id => finals.get(id) }, deps);
  m.tools = { start: async () => {}, bind() {}, close() {} };
  try {
    const first = m.create({ speed: 'fast' }); clearInterval(m.timer); m.timer = 1;
    async function finish(slot, text = '总结 [事件 1]') { const state = m.load(first.id), job = state[slot]; finals.set(job.sessionId, { id: randomUUID(), text: `${text}\n[会议回执:${job.token}]` }); await m.collect(m.load(first.id), slot); }
    await m.tick(); assert.equal(m.load(first.id).job.kind, 'prime'); assert.equal(m.load(first.id).questionJob.kind, 'prime', 'parallel warmups persist both jobs');
    assert.equal(sessions.get(first.sessionId).model, 'DeepSeek-Flash-1017'); assert.equal(sessions.get(first.questionSessionId).model, 'DeepSeek-Flash-1017');
    await finish('job', '已就绪'); await finish('questionJob', '已就绪');
    let state = m.load(first.id); state.autoUnderstand = false; state.requested = true;
    m.event(state, 'transcript', { at: 100, end: 2000, track: 'system', text: '先固定信道参数，再比较候选算法。' });
    m.event(state, 'transcript', { at: 120, end: 2010, track: 'mic', text: '先固定信道参数，再比较候选算法！' }); m.save(state);
    blockedSid = first.sessionId; const understanding = m.tick(); await turn();
    assert.ok(release, 'understanding send is deliberately blocked');
    m.control(first.id, 'ask', '当前结论？'); await turn(); await turn();
    state = m.load(first.id); assert.equal(state.questionJob.kind, 'question'); assert.equal(state.job.state, 'sending'); assert.notEqual(state.questionJob.sessionId, state.job.sessionId);
    const askPrompt = prompts.at(-1).prompt; assert.match(askPrompt, /当前会议理解/); assert.match(askPrompt, /\[1,2\] 00:00 系统声音/);
    await finish('questionJob', '先固定参数'); assert.equal(m.load(first.id).cursor, 0); assert.equal(m.load(first.id).summary, '');
    release(); blockedSid = null; await understanding;
    const file = prompts.find(p => p.id === first.sessionId && /input-/.test(p.prompt)).prompt.match(/input-[\w-]+\.txt/)[0];
    const input = fs.readFileSync(path.join(m.dir(first.id), file), 'utf8'); assert.equal((input.match(/先固定信道参数/g) || []).length, 1); assert.doesNotMatch(input, /audioSeq|recentContext|previousSummary/);
    await finish('job');
    // Three completed understanding turns retire only that lane, then read the skill once in its new session.
    for (let i = 0; i < 2; i++) { state = m.load(first.id); state.requested = true; m.save(state); await m.tick(); await finish('job'); }
    state = m.load(first.id); state.requested = true; m.save(state); await m.tick();
    state = m.load(first.id); assert.equal(state.job.kind, 'prime'); assert.notEqual(state.sessionId, first.sessionId); assert.deepEqual(retired, [first.sessionId]); assert.equal(state.questionSessionId, first.questionSessionId);
    assert.ok(prompts.filter(p => /input-/.test(p.prompt)).every(p => !p.prompt.includes('SKILL.md')), 'skill only read during warmup'); await finish('job', '已就绪');
    rejectQuestion = true; m.control(first.id, 'ask', '故障问题'); await turn(); await turn(); state = m.load(first.id); const failed = state.answers.at(-1); assert.equal(failed.state, 'error'); assert.match(state.questionError, /test send failure/);
    rejectQuestion = false; m.control(first.id, 'ask', '新问题'); await turn(); await turn(); state = m.load(first.id); const runningToken = state.questionJob.token;
    m.control(first.id, 'retry-question', failed.id); await turn(); assert.equal(m.load(first.id).questionJob.token, runningToken, 'retry never replaces a newer active question');
    await finish('questionJob'); await m.tick(); await finish('questionJob');
    await m.tick(); state = m.load(first.id);
    assert.equal(state.questionJob.kind, 'prime', 'third completed answer prewarms its successor before another question');
    assert.notEqual(state.questionSessionId, first.questionSessionId); assert.ok(retired.includes(first.questionSessionId));
    await finish('questionJob', '已就绪');
    m.control(first.id, 'ask', '第四个问题'); await turn(); await turn();
    assert.equal(m.load(first.id).questionJob.kind, 'question', 'next question uses the already-warm successor');
    assert.throws(() => selectedModel({ speed: 'fast', fastModel: 'Absent-1' }, deps), /不在可用/);
    assert.equal(similar('嗯先固定信道参数再比较', '先固定信道参数再比较啊'), true);
    assert.equal(similar('本轮算法收益为15后续保持同样种子验证', '本轮算法收益为16后续保持同样种子验证'), false, 'changed numbers cannot disappear through fuzzy dedupe');
    assert.equal(similar('本轮暂不采用算法a后续固定种子验证', '本轮采用算法a后续固定种子验证'), false, 'changed decisions remain separate');
    const text = compactEvents([{ seq: 1, kind: 'transcript', at: 0, end: 1000, track: 'mic', text: '同一句' }, { seq: 2, kind: 'transcript', at: 0, end: 1000, track: 'mic', text: '同一句' }, { seq: 3, kind: 'transcript', at: 9000, end: 10000, track: 'system', text: '同一句' }]); assert.equal(text.split('\n').length, 3, 'same-track and distant repetitions remain evidence');
    now += 13 * 60000; await m.collect(m.load(first.id), 'questionJob'); assert.equal(m.load(first.id).questionJob.state, 'error');
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
      const job = restarted.load(oldId).questionJob; finals.set(job.sessionId, { id: randomUUID(), text: `[会议回执:${job.token}]` });
      await restarted.collect(restarted.load(oldId), 'questionJob'); assert.match(restarted.load(oldId).questionError, /空回复/, 'receipt without content fails immediately');
    } finally { restarted.close(); }
    console.log('meeting speed: parallel lanes, bounded context, compact evidence, model choice and failure recovery PASS');
  } finally { m.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
