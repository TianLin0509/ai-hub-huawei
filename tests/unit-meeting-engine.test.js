'use strict';
// 会议伴侣按本机装了的终端和接上的模型挑默认组合；手选生效并换会话；三档的输入不同。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const engine = require('../core/company-assistant/meeting-engine');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { sidePrompt } = require('../core/ask-aside-codex');

const GLM = { id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, DS = { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' };

test('只装了 Codex（接公司模型）：默认 Codex + 优先级里排前面的模型', () => {
  const pick = engine.recommended({ codeagent: null, claude: null, codex: [GLM, DS] }, 'normal');
  assert.equal(pick.harness, 'codex'); assert.equal(pick.family, engine.PRIORITY.normal.find(k => k.startsWith('codex:')).split(':')[1]);
});

test('什么都没接上：退回 CodeAgent + 账号默认模型（老行为）', () => {
  assert.deepEqual(engine.choose({}, {}).harness, 'codeagent');
  assert.equal(engine.choose({}, {}).model, '');
});

test('手选的组合不在了就报错，不悄悄换成别的', () => {
  assert.throws(() => engine.choose({ engine: 'claude|GLM-5.2-WX' }, { codex: [GLM] }), /已不可用/);
  assert.equal(engine.choose({ engine: 'codex|GLM-5.2-WX' }, { codex: [GLM] }).model, 'GLM-5.2-WX');
});

test('每档的排序都把所有组合排进去，不漏', () => {
  const all = engine.engines({ codeagent: [{ id: 'GLM-5.2-WX-Auto' }, { id: 'deepseek-v4.1-flash-1017' }], claude: [GLM, DS], codex: [GLM, DS] });
  for (const speed of ['fast', 'normal', 'deep']) assert.equal(engine.rank(all, speed).length, 6);
});

test('Codex 会议问答带上材料和答复要求', () => {
  const text = sidePrompt('步长定了多少', { context: '[30] 01:00 发言人1 步长定 0.4', responseHint: '先给结论' });
  assert.match(text, /问题：步长定了多少/); assert.match(text, /【答复要求】\n先给结论/); assert.match(text, /\[30\] 01:00 发言人1 步长定 0.4/);
  assert.doesNotMatch(sidePrompt('x'), /会议材料/);
});

test('会议用挑中的终端建会话；改选后换会话；深入档写全部原话；快速档问答只带 20 条', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-engine-'));
  const sessions = new Map(), finals = new Map(), prompts = [], asks = [];
  const deps = { dataDir: root, now: () => 100000, meetingModels: () => [], meetingTerminals: () => ({ codeagent: false, claude: [GLM], codex: [GLM, DS] }),
    getSession: id => sessions.get(id), createSession: async (kind, opts) => { sessions.set(opts.id, { kind, ...opts }); }, closeSession: async id => { sessions.delete(id); return { ok: true }; },
    getMeetingAskAside: () => ({ askMeeting: r => { asks.push(r); return { id: randomUUID(), status: 'queued' }; }, meetingResult: () => null }),
    sendPrompt: async (id, prompt) => { prompts.push({ id, prompt }); return { ok: true }; } };
  const m = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: id => finals.get(id) }, deps);
  m.tools = { start: async () => {}, bind() {}, close() {} };
  const done = (sid, text) => finals.set(sid, { id: randomUUID(), text: text + `\n[会议回执:${m.load(first.id).job.token}]` });
  const first = m.create({ speed: 'deep' }); clearInterval(m.timer); m.timer = 1;
  try {
    await m.tick();
    const s1 = sessions.get(m.load(first.id).sessionId), want = engine.recommended(deps.meetingTerminals(), 'deep');
    assert.equal(s1.kind, want.harness); assert.equal(s1.model, want.model);
    assert.equal(m.status(first.id).engines.length, 3); assert.equal(m.status(first.id).recommendedEngine, want.id);
    done(s1.id, '已就绪'); await m.tick();
    let state = m.load(first.id); assert.equal(state.engineLabel, want.label);
    for (let i = 1; i <= 50; i++) m.event(state, 'transcript', { at: i * 1000, end: i * 1000 + 800, track: 'system', text: `第${i}句原话` });
    state.requested = true; m.save(state); await m.tick();
    assert.match(fs.readFileSync(path.join(m.dir(first.id), 'transcript-all.txt'), 'utf8'), /第50句原话/);
    assert.match(prompts.at(-1).prompt, /transcript-all\.txt/);
    done(s1.id, '- [T1] 议题'); await m.tick();
    m.control(first.id, 'speed', 'fast'); m.control(first.id, 'ask', '第3句说了什么'); for (let i = 0; i < 6 && !asks.length; i++) { await m.tick(); await new Promise(r => setImmediate(r)); }
    const ctx = asks.at(-1).context; assert.match(ctx, /最近 20 条/); assert.doesNotMatch(ctx, /第30句原话/); assert.match(ctx, /第50句原话/);
    m.control(first.id, 'engine', 'codex|deepseek-v4.1-flash-1017'); state = m.load(first.id); state.requested = true; m.save(state); await m.tick();
    for (let i = 0; i < 6 && m.load(first.id).sessionId === s1.id; i++) { await m.tick(); await new Promise(r => setImmediate(r)); }
    const s2 = sessions.get(m.load(first.id).sessionId); assert.notEqual(s2.id, s1.id); assert.equal(s2.kind, 'codex'); assert.equal(s2.model, 'deepseek-v4.1-flash-1017');
    assert.throws(() => m.control(first.id, 'engine', 'codeagent|GLM-5.2-WX-Auto'), /不在可用清单/);
  } finally { m.close?.(); clearInterval(m.timer); }
});
