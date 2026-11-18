'use strict';
// 会议伴侣按本机装了的终端和接上的模型挑默认组合；手选生效并换会话；三档的输入不同。
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const engine = require('../core/company-assistant/meeting-engine');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { sidePrompt } = require('../core/ask-aside-codex');

const GLM = { id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }, DS = { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' };

test('自动档尊重已配置的账号模型，未配置和手选保持原行为', () => {
  const available = { codeagent: [GLM, DS], claude: [GLM, DS], codex: [GLM, DS] };
  const preferred = `codeagent|${DS.id}`;
  for (const speed of ['fast', 'normal', 'deep']) {
    assert.equal(engine.choose({ speed }, available, speed, preferred).id, preferred);
    assert.equal(engine.recommended(available, speed, preferred).id, preferred);
    assert.equal(engine.choose({ speed }, available).id, 'claude|GLM-5.2-WX');
    assert.equal(engine.choose({ speed, engine: 'claude|GLM-5.2-WX' }, available, speed, preferred).harness, 'claude');
  }
  assert.equal(engine.choose({ speed: 'fast', fastModel: GLM.id }, available, 'fast', preferred).model, GLM.id);
  assert.equal(engine.recommended({ claude: [GLM, DS] }, 'normal', preferred).model, GLM.id);
  assert.equal(engine.recommended(available, 'normal', 'codeagent|missing').model, GLM.id);
  assert.equal(engine.recommended(available, 'normal', preferred.toUpperCase()).id, preferred);
});

test('读取账号默认值不写配置，权威清单不包含的模型不作为会议偏好', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-default-'));
  const personalDir = path.join(root, 'personal'), dataDir = path.join(root, 'hub');
  fs.mkdirSync(personalDir, { recursive: true });
  const file = require('../core/codeagent-pool').personalModelsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), source: 'serve', models: [DS.id], defaultModel: DS.id }));
  const settings = path.join(personalDir, 'settings.json');
  for (const [model, expected] of [[DS.id, `codeagent|${DS.id}`], [GLM.id, ''], ['', '']]) {
    const original = JSON.stringify({ model, other: 'preserve' });
    fs.writeFileSync(settings, original);
    assert.equal(engine.accountDefault({ dataDir, personalDir }), expected);
    assert.equal(fs.readFileSync(settings, 'utf8'), original);
  }
  assert.equal(engine.accountDefault({}), '');
});

test('真实会议create→ensureLane：自动推荐、理解与问答会话都使用账号DeepSeek', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-default-lane-'));
  const sessions = new Map(), created = [];
  const deps = { dataDir: root, powerSaveBlocker: null, now: () => 100000,
    meetingModels: () => [GLM, DS], meetingTerminals: () => ({ codeagent: true, claude: [GLM, DS] }),
    meetingDefaultEngine: () => `codeagent|${DS.id}`, getSession: id => sessions.get(id),
    createSession: async (kind, opts) => { created.push({ kind, ...opts }); sessions.set(opts.id, { kind, ...opts }); },
    closeSession: async id => sessions.delete(id) };
  const companion = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false }, deps);
  companion.timer = 1; companion.tools = { start: async () => {}, bind() {}, close() {} };
  try {
    for (const speed of ['fast', 'normal', 'deep']) {
      const m = companion.create({ speed, audio: [] });
      await companion.ensureLane(m.id, 'job');
      await companion.ensureLane(m.id, 'questionJob');
      const status = companion.status(m.id);
      assert.equal(status.recommendedEngine, `codeagent|${DS.id}`);
      assert.equal(status.engines[0].id, status.recommendedEngine);
      assert.equal(status.meeting.understandingModel, status.recommendedEngine);
      for (const s of created.slice(-2)) { assert.equal(s.kind, 'codeagent'); assert.equal(s.model, DS.id); }
      const ended = companion.load(m.id); ended.state = 'ended'; companion.save(ended);
    }
    const manual = companion.create({ audio: [] });
    const m = companion.load(manual.id); m.engine = `claude|${GLM.id}`; companion.save(m);
    await companion.ensureLane(m.id, 'job');
    assert.equal(created.at(-1).kind, 'claude'); assert.equal(created.at(-1).model, GLM.id);
  } finally { companion.close(); }
});

test('新数据根没有模型菜单：已确认的账号默认仍胜过Claude GLM，且按实际参数建会话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-no-menu-'));
  const personal = path.join(root, 'personal'); fs.mkdirSync(personal);
  const oldConfigDir = process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
  process.env.AI_HUB_CODEAGENT_CONFIG_DIR = personal;
  let preferred = `codeagent|${DS.id}`, installed = true;
  const sessions = new Map(), created = [];
  const deps = { dataDir: root, powerSaveBlocker: null,
    meetingDefaultEngine: () => preferred, // 已由账号解析器验证的契约，菜单读取走真实实现。
    meetingTerminals: () => ({ codeagent: installed, claude: [GLM] }),
    getSession: id => sessions.get(id),
    createSession: async (kind, opts) => { created.push({ kind, ...opts }); sessions.set(opts.id, { kind, ...opts }); },
    closeSession: async id => sessions.delete(id) };
  const c = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false }, deps);
  c.timer = 1; c.tools = { start: async () => {}, bind() {}, close() {} };
  try {
    assert.deepEqual(require('../core/company-assistant/meeting-context').modelOptions(deps), []);
    const m = c.create({ audio: [] });
    assert.equal(c.status(m.id).recommendedEngine, preferred);
    await c.ensureLane(m.id, 'job');
    assert.equal(created.at(-1).kind, 'codeagent'); assert.equal(created.at(-1).model, DS.id);
    assert.equal(c.engineFor({ engine: `claude|${GLM.id}` }).model, GLM.id);
    const probe = require('../core/codeagent-model-probe');
    const menuFile = require('../core/codeagent-pool').personalModelsFile(root);
    probe.writeProbed(menuFile, { models: [DS.id, 'glm-4.7-w8a8', 'qwen3.8-27b'], source: 'serve' });
    const expanded = c.status(m.id);
    assert.deepEqual(expanded.engines.filter(e => e.id.startsWith('codeagent|')).map(e => e.id).sort(),
      [DS.id, 'glm-4.7-w8a8', 'qwen3.8-27b'].map(id => 'codeagent|' + id).sort(), '无需等一分钟，真实缓存到达立即补齐模型');
    assert.equal(expanded.recommendedEngine, preferred);
    c.control(m.id, 'engine', 'codeagent|qwen3.8-27b');
    await c.ensureLane(m.id, 'job');
    assert.equal(created.at(-1).model, 'qwen3.8-27b');
    assert.equal(c.load(m.id).engine, 'codeagent|qwen3.8-27b');
    probe.writeProbed(menuFile, { models: [DS.id, 'qwen3.8-27b'], source: 'serve' });
    assert.ok(!c.status(m.id).engines.some(e => e.id === 'codeagent|glm-4.7-w8a8'), '撤去权限也立即刷新，不保留旧清单');
    assert.equal(c.load(m.id).engine, 'codeagent|qwen3.8-27b', '清单刷新不改变手选');
    preferred = ''; // 账号默认改变时，不能保留先前缓存出的模型。
    assert.equal(c.status(m.id).recommendedEngine, `claude|${GLM.id}`);
    preferred = `codeagent|${DS.id}`; installed = false;
    assert.equal(c.status(m.id).recommendedEngine, `claude|${GLM.id}`);
  } finally {
    c.close();
    if (oldConfigDir === undefined) delete process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
    else process.env.AI_HUB_CODEAGENT_CONFIG_DIR = oldConfigDir;
  }
});

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
