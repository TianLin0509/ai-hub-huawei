'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FleetService } = require('../core/avatar/fleet');
const { registerAvatarIpc } = require('../main/ipc/avatar-handlers');
const F = require('../core/avatar/fleet-rules');
const NOW = Date.UTC(2026, 10, 26), GROUP = { id: 'group-test', name: '合成群', group: true }, DM = { id: 'peer-test', name: '合成联系人', group: false };
const message = (key, text, extra = {}) => ({ key, account: 'question-test', sender: '合成提问者', text, at: NOW - 1000, contentType: 'TEXT_MSG', ...extra });
function setup(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-b2-'));
  const world = { now: NOW, owner: 'owner-test', messages: {}, archive: {}, sessions: new Map(), creates: [], sends: [], closed: [], finals: new Map(), response: {} };
  const assistant = { settings: () => ({ myName: '合成用户' }),
    snapshot: () => ({ at: world.now, login: { ok: true, uid: world.owner }, conversations: [GROUP, DM], messages: world.messages }),
    auth: { status: () => ({ state: 'online', login: { ok: true, uid: world.owner } }) },
    archive: { owner: () => world.owner, loadIndex: () => ({ names: {} }), read: (_owner, conv) => world.archive[conv] || [] },
    welink: async () => { throw new Error('试答不能调用 WeLink 发送或取数'); } };
  const f = new FleetService({ dataDir: dir, getAssistant: () => assistant, noTimer: true, pollMs: 1, now: () => world.now,
    listBackends: () => ({ rows: [{ id: 'personal', usable: true, label: '个人账号', models: ['actual-model'], defaultModel: 'actual-model' }] }),
    createSession: async (kind, opts) => { world.creates.push({ kind, opts }); world.sessions.set(opts.id, { ...opts, kind, status: 'idle', fixedModel: 'actual-model' }); return { id: opts.id }; },
    getSession: id => world.sessions.get(id), closeSession: async id => { world.closed.push(id); world.sessions.delete(id); },
    sendPrompt: async (id, prompt) => {
      if (world.sendError) throw world.sendError;
      const meta = world.sessions.get(id), file = /再处理 (task-[\w-]+\.json)/.exec(prompt)[1];
      const material = JSON.parse(fs.readFileSync(path.join(meta.cwd, file), 'utf8'));
      const rules = fs.readFileSync(path.join(meta.cwd, 'rules.md'), 'utf8'), marker = /\[分身回执:[^\]]+\]/.exec(prompt)[0];
      world.sends.push({ id, prompt, material, rules, cwd: meta.cwd });
      if (world.hold) await world.hold;
      const row = { id: material.items[0].id, action: 'draft', reply: '请在导出格式菜单选择所需格式。', confidence: 85, basis: '合成操作说明', ...world.response };
      world.finals.set(id, { text: JSON.stringify([row]) + '\n' + marker });
      return { ok: true };
    },
    lastFinal: id => world.finals.get(id),
  });
  f.owner();
  const av = F.newAvatar({ id: 'avatar-test', tpl: 'blank', now: NOW }, { kind: 'all', atOnly: false, persona: '语气简短，不替本人承诺', ...patch });
  f.saveFleet(world.owner, { avatars: [av], paused: false });
  f.saveState(world.owner, av.id, { items: { formal: { id: 'formal', state: 'ready', draft: '正式草稿' } }, cursor: { 'group-test': { at: NOW - 100, id: 'formal' } }, session: { id: 'formal-session', questions: 12 }, stats: { model: 9 } });
  const stateFile = f.legacy.file(world.owner, path.join('agents', av.id, 'state.json'));
  t.after(() => { f.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { f, world, av, assistant, dir, stateFile };
}

test('四模板新号立即补足3道明确示例题，不调用模型/WeLink且保留正式状态', t => {
  for (const tpl of ['watch', 'draft', 'qa', 'blank']) {
    const { f, av, world, stateFile } = setup(t, { tpl }); const before = fs.readFileSync(stateFile, 'utf8');
    const out = f.tryoutSamples(av.id);
    assert.equal(out.samples.length, 3); assert.ok(out.samples.every(s => s.kind === 'example' && !s.requiresConsent && /示例/.test(s.convName)));
    assert.deepEqual(out.history, []); assert.equal(world.creates.length, 0); assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  }
});

test('抽题遵守范围与过滤，群优先且至多6条，归档也能抽题', t => {
  const { f, world, av } = setup(t, { kind: 'groups' });
  world.messages[GROUP.id] = [message('noise', '午饭拼单请到另一个群登记。'), message('bot', '🤖导出格式怎么选择？'), message('secret', '验证码应该如何获取？'),
    message('mine', '导出格式怎么选择？', { mine: true }), message('old', '导出格式怎么选择？', { at: NOW - 20 * 86400000 }),
    ...Array.from({ length: 8 }, (_, i) => message('q' + i, `导出格式${i}应该怎么选择？`, { at: NOW - i }))];
  world.messages[DM.id] = [message('dm', '安装目录应该怎么选择？')];
  const out = f.tryoutSamples(av.id); assert.equal(out.samples.length, 6); assert.ok(out.samples.every(s => s.kind === 'group' && s.convId === GROUP.id));
  world.messages = {}; world.archive[GROUP.id] = [{ id: 'archived', a: 'question-test', at: NOW - 1, t: '归档里的导出格式应该怎么选择？' }];
  assert.equal(f.tryoutSamples(av.id).samples[0].question, '归档里的导出格式应该怎么选择？');
});

test('私聊必须本次明确同意，篡改kind或省略sampleId不能绕过，未授权不发模型', async t => {
  const { f, world, av } = setup(t); world.messages[DM.id] = [message('private', '安装目录应该怎么选择？')];
  const dm = f.tryoutSamples(av.id).samples.find(s => s.kind === 'dm'); assert.equal(dm.requiresConsent, true);
  for (const opts of [{ sampleId: dm.id }, { sampleId: dm.id, kind: 'group', question: '改写后的试题应该怎么处理？' }, { kind: 'group', question: dm.question }, { kind: 'dm', question: '自填题应该怎么处理？', explicitPrivateConsent: 'true' }]) {
    const r = await f.runTryout(av.id, opts); assert.equal(r.ok, false); assert.equal(r.failure.code, 'private_consent_required');
  }
  assert.equal(world.creates.length, 0); assert.equal(world.sends.length, 0);
  const yes = await f.runTryout(av.id, { sampleId: dm.id, explicitPrivateConsent: true }); assert.equal(yes.ok, true); assert.equal(world.sends.length, 1);
});

test('真实AgentSessions独立回执试答使用实际规则资料，正式inbox/游标/计数/会话文件逐字不变', async t => {
  const { f, world, av, stateFile, dir } = setup(t); const before = fs.readFileSync(stateFile, 'utf8');
  const source = path.join(dir, 'instructions.txt'); fs.writeFileSync(source, '导出格式操作说明：在菜单里选择对应格式。');
  f.mutateFleet(world.owner, fleet => { fleet.avatars[0].sources = [{ type: 'file', path: source, name: '操作说明' }]; });
  const memory = path.join(f.work(world.owner, av.id), 'memory.md'); fs.writeFileSync(memory, '- 群问答：导出格式在右上角菜单里选择。');
  const r = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(r.ok, true); assert.equal(r.result.action, 'draft'); assert.ok(Array.isArray(r.result.basis)); assert.match(r.result.modelLabel, /actual-model/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before); assert.equal(world.creates.length, 1); assert.equal(world.closed.length, 1);
  assert.notEqual(world.closed[0], 'formal-session'); assert.equal(world.sessions.size, 0);
  const sent = world.sends[0]; assert.equal(sent.material.tryout, true); assert.match(sent.rules, /语气简短/); assert.match(sent.rules, /试答，不发送/);
  assert.ok(sent.material.items[0].related.some(x => /操作说明|群问答/.test(x))); assert.equal(fs.existsSync(sent.cwd), false);
  assert.equal(f.tryoutSamples(av.id).history[0].id, r.result.id);
});

test('模型未就绪和供应商405复用结构化动作，不生成虚假成功历史', async t => {
  const { f, world, av } = setup(t); const list = f.d.listBackends;
  f.d.listBackends = () => ({ rows: [] }); const unavailable = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(unavailable.ok, false); assert.equal(unavailable.failure.code, 'model_unavailable'); assert.ok(unavailable.failure.actions.length);
  assert.equal(world.creates.length, 0); f.d.listBackends = list;
  world.sendError = Object.assign(new Error('405 Method Not Allowed'), { providerRepair: { canUseManual: true, account: 'synthetic-pool' } });
  const failed = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' }); assert.equal(failed.ok, false);
  assert.equal(failed.failure.code, 'provider_405'); assert.equal(failed.failure.actions[0].kind, 'provider_repair');
  assert.deepEqual(f.tryoutSamples(av.id).history, []); assert.equal(world.sessions.size, 0);
});

test('选题后范围变化或伪造sampleId不会使用旧会话题，示例明确标记非真实消息', async t => {
  const { f, world, av } = setup(t); world.messages[GROUP.id] = [message('group-q', '导出格式应该怎么选择？')];
  const sample = f.tryoutSamples(av.id).samples[0];
  f.mutateFleet(world.owner, fleet => { fleet.avatars[0].kind = 'dm'; });
  const stale = await f.runTryout(av.id, { sampleId: sample.id }); assert.equal(stale.ok, false); assert.match(stale.error, /范围已变化/);
  assert.equal((await f.runTryout(av.id, { sampleId: 'forged' })).ok, false); assert.equal(world.creates.length, 0);
  const example = f.tryoutSamples(av.id).samples.find(s => s.kind === 'example');
  assert.equal((await f.runTryout(av.id, { sampleId: example.id })).ok, true);
  assert.equal(world.sends[0].material.items[0].where, '示例题（非真实消息）');
});

test('会话创建到一半失败也回收已分配会话；试答不占正式AgentSessions启动表', async t => {
  const { f, world, av } = setup(t), create = f.sessions.d.createSession;
  f.sessions.d.createSession = async (...args) => { await create(...args); assert.equal(f.sessions.starting.size, 0); throw new Error('synthetic launch failed'); };
  const r = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(r.ok, false); assert.ok(r.failure); assert.equal(world.sessions.size, 0); assert.equal(world.closed.length, 1);
  assert.equal(fs.existsSync(world.creates[0].opts.cwd), false); assert.deepEqual(f.tryoutSamples(av.id).history, []);
});

test('零把握空依据转本人提醒，敏感试题不送模型，敏感生成不进入可用草稿', async t => {
  const { f, world, av } = setup(t); world.response = { confidence: 0, basis: [] };
  const zero = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(zero.ok, true); assert.equal(zero.result.action, 'remind'); assert.equal(zero.result.lowConfidenceFallback, true); assert.equal(zero.result.answer, '');
  world.response = { action: 'skip', confidence: 0, basis: ['验证码字段'] };
  const skip = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(skip.result.action, 'remind'); assert.equal(skip.result.lowConfidenceFallback, true); assert.deepEqual(skip.result.basis, []);
  const before = world.sends.length; assert.equal((await f.runTryout(av.id, { question: '验证码应该如何获取？' })).ok, false); assert.equal(world.sends.length, before);
  world.response = { reply: '请核对验证码后继续导出。' };
  const sensitive = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' }); assert.equal(sensitive.result.action, 'remind'); assert.equal(sensitive.result.answer, '');
});

test('并发重复点击不串题，切号后的模型回执不落任何账号历史并关闭试答会话', async t => {
  const { f, world, av } = setup(t); let resolve; world.hold = new Promise(r => { resolve = r; });
  const first = f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  for (let i = 0; i < 50 && !world.sends.length; i++) await new Promise(r => setTimeout(r, 1));
  const busy = await f.runTryout(av.id, { question: '安装目录应该怎么选择？' }); assert.equal(busy.failure.code, 'tryout_busy');
  world.owner = 'owner-other'; f.onAuthChanged(); resolve(); const stale = await first;
  assert.equal(stale.ok, false); assert.match(stale.error, /账号/); assert.equal(world.sessions.size, 0);
  assert.deepEqual(f.tryouts.history('owner-test', av.id), []); assert.deepEqual(f.tryouts.history(world.owner, av.id), []);
});

test('同会话出现错误回执marker也不能提前交付，必须等本次唯一marker', { timeout: 3000 }, async t => {
  const { f, world, av } = setup(t), send = f.d.sendPrompt;
  f.d.sendPrompt = async (...args) => {
    const result = await send(...args), id = args[0], correct = world.finals.get(id), item = world.sends.at(-1).material.items[0];
    world.finals.set(id, { text: JSON.stringify([{ id: item.id, action: 'draft', reply: '错误回执内容', confidence: 90, basis: '错误试题' }]) + '\n[分身回执:wrong-task]' });
    setTimeout(() => world.finals.set(id, correct), 15); return result;
  };
  const r = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  assert.equal(r.ok, true); assert.doesNotMatch(r.result.answer, /错误回执/); assert.match(r.result.answer, /导出格式菜单/);
});

test('在途删除分身不会写入迟到试答历史，会话和任务目录仍清理', async t => {
  const { f, world, av } = setup(t); let resolve; world.hold = new Promise(r => { resolve = r; });
  const running = f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  for (let i = 0; i < 50 && !world.sends.length; i++) await new Promise(r => setTimeout(r, 1));
  f.mutateFleet(world.owner, fleet => { fleet.avatars = []; }); resolve();
  const r = await running; assert.equal(r.ok, false); assert.match(r.error, /删除/);
  assert.deepEqual(f.tryouts.history(world.owner, av.id), []); assert.equal(world.sessions.size, 0); assert.equal(fs.existsSync(world.sends[0].cwd), false);
});

test('评价落本地且纠偏进入真实knowledge，重复评价不重复范例，敏感备注不入范例', async t => {
  const { f, av, world } = setup(t), r = await f.runTryout(av.id, { question: '导出格式应该怎么选择？' });
  const no = f.rateTryout(av.id, { tryoutId: r.result.id, verdict: 'unlike' }); assert.equal(no.examples, 0);
  const yes = f.rateTryout(av.id, { tryoutId: r.result.id, verdict: 'like' }); assert.equal(yes.examples, 1);
  assert.equal(f.rateTryout(av.id, { tryoutId: r.result.id, verdict: 'like' }).examples, 1);
  const note = '导出格式的回复请简短，并说明资料不足时需要确认';
  const corrected = f.rateTryout(av.id, { tryoutId: r.result.id, verdict: 'issue', note }); assert.equal(corrected.examples, 1);
  assert.ok(f.knowledge(world.owner, av).some(x => x.includes(note)));
  const bad = f.rateTryout(av.id, { tryoutId: r.result.id, verdict: 'issue', note: '导出流程需要核对验证码后继续' });
  assert.equal(bad.examples, 0); assert.ok(!JSON.stringify(f.tryouts.history(world.owner, av.id)).includes('验证码'));
  assert.equal(world.sends.length, 1); assert.equal(world.sessions.size, 0);
});

test('试答历史只留最近30条，正式状态保持不变', async t => {
  const { f, av, stateFile } = setup(t), before = fs.readFileSync(stateFile, 'utf8'), ids = [];
  for (let i = 0; i < 32; i++) { const r = await f.runTryout(av.id, { question: `导出格式${i}应该怎么选择？` }); assert.equal(r.ok, true); ids.push(r.result.id); }
  const rows = f.tryoutSamples(av.id).history; assert.equal(rows.length, 30); assert.equal(rows[0].id, ids[2]); assert.equal(rows.at(-1).id, ids.at(-1));
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.throws(() => f.rateTryout(av.id, { tryoutId: ids[0], verdict: 'like' }), /最近历史/);
});

test('人设材料少或读取失败返回personaNote并保留手写内容；3个IPC可直接使用', async t => {
  const { f, av } = setup(t); f.legacy.myTexts = () => [];
  const empty = f.regeneratePersona(av.id); assert.match(empty.personaNote, /发言较少/); assert.equal(empty.avatars[0].persona, '语气简短，不替本人承诺');
  f.legacy.myTexts = () => { throw new Error('synthetic read failure'); }; assert.match(f.regeneratePersona(av.id).personaNote, /读不到/);
  const handlers = {}; registerAvatarIpc({ handle: (k, fn) => { handlers[k] = fn; } }, () => f);
  const samples = await handlers['avatar:tryout-samples']({}, { avatarId: av.id }); assert.equal(samples.ok, true);
  const run = await handlers['avatar:tryout-run']({}, { avatarId: av.id, sampleId: samples.samples[0].id }); assert.equal(run.ok, true);
  const rated = await handlers['avatar:tryout-rate']({}, { avatarId: av.id, tryoutId: run.result.id, verdict: 'like' }); assert.equal(rated.examples, 1);
});
