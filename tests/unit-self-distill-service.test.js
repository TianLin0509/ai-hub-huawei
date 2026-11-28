'use strict';
// 蒸馏自己 · 主进程服务（假档案、假模型）：进度顺序、档案没建好退回快照、消息不足只出统计、删除后文件全无、审计不含原话、IPC。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSelfDistillService } = require('../main/self-distill-service');

const NOW = Date.UTC(2026, 10, 28, 4, 0);
const MINE = ['行', '好嘞', '我看下', '仿真结果出来了吗', '这个调度方案再对一下', '张三那边怎么说', '这周把仿真的结果整理成一页发给大家', '好嘞', '行', '我看下'];

function fakeAssistant({ dir, archive = true, mineCount = 40, snapshotMine = 25 } = {}) {
  const convRows = [];
  for (let i = 0; i < mineCount; i += 1) {
    const t = NOW - (i + 1) * 3 * 3600000;
    convRows.push({ id: 'a' + i, at: t, a: 'u1', t: '别人的原话不能出现' + i });
    convRows.push({ id: 'b' + i, at: t + 120000, a: 'me', m: 1, t: MINE[i % MINE.length], ct: 'TEXT' });
  }
  const snapMsgs = [];
  for (let i = 0; i < snapshotMine; i += 1) {
    snapMsgs.push({ key: 's' + i, at: NOW - i * 3600000, account: 'u1', sender: '张三', text: '别人的快照话' });
    snapMsgs.push({ key: 'm' + i, at: NOW - i * 3600000 + 60000, account: 'me', mine: true, text: MINE[i % MINE.length] });
  }
  snapMsgs.push({ key: 'old', at: NOW - 40 * 3600000, account: 'me', mine: true, text: '超过36小时的不要' });
  return {
    dir,
    snapshot: () => ({ login: { ok: true, uid: 'me' }, conversations: [{ id: 'u1', name: '张三' }], messages: { u1: snapMsgs } }),
    archive: {
      owner: () => 'me',
      status: () => (archive ? { available: true, messages: convRows.length } : { available: true, messages: 0 }),
      loadIndex: () => ({ convs: { u1: { name: '张三', group: false } }, names: { u1: '张三' } }),
      read: () => convRows.slice(),
    },
  };
}
function setup({ archive = true, mineCount = 40, snapshotMine = 25, model } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-svc-'));
  const a = fakeAssistant({ dir: dataDir, archive, mineCount, snapshotMine });
  const events = [], prompts = [];
  const svc = createSelfDistillService({
    dataDir, now: () => NOW, getAssistant: () => a,
    sendToRenderer: (ch, ev) => { assert.equal(ch, 'self-distill:progress'); events.push(ev); },
    resolveBackend: () => ({ kind: 'codeagent', model: 'fake-model' }),
    runModel: async prompt => { prompts.push(prompt); return model || JSON.stringify({ tone: ['先给判断再说理由'], examples: [{ cat: 'chat', text: '周末去哪玩' }, { cat: 'fact', text: '这周把仿真的结果整理成一页发给你' }] }); },
    logger: { warn() {} },
  });
  return { dataDir, svc, events, prompts };
}

test('进度事件按 collect → scrub → stats → model → save → done 的顺序', async () => {
  const { svc, events, prompts } = setup();
  assert.deepEqual(svc.run({}), { ok: true, started: true });
  assert.equal(svc.run({}).started, false, '在跑时不重复开');
  await svc.lastJob;
  const order = [...new Set(events.map(e => e.step))];
  assert.deepEqual(order, ['collect', 'scrub', 'stats', 'model', 'save', 'done']);
  assert.equal(prompts.length, 1);
  assert.ok(!/别人的原话/.test(prompts[0]), '别人的话不送模型');
  assert.ok(!/张三/.test(prompts[0]), '人名已去敏');
  const st = svc.status();
  assert.equal(st.enabled, true);
  assert.equal(st.archiveReady, true);
  assert.equal(st.running, false);
  assert.equal(st.portrait.source.kind, 'archive');
  assert.equal(st.portrait.backend.kind, 'codeagent');
  assert.ok(st.portrait.speak.examples.some(e => e.text === '周末去哪玩'));
  assert.ok(!st.portrait.speak.examples.some(e => /整理成一页/.test(e.text)), '和原话重合 ≥12 字的例句被删');
  assert.deepEqual(Object.values(st.portrait.apply), [false, false, false, false, false], '默认全关');
});

test('档案没建好：退回快照里最近 36 小时的本人消息，source.kind=snapshot', async () => {
  const { svc, events } = setup({ archive: false });
  svc.run({}); await svc.lastJob;
  assert.match(events[0].text, /36 小时/);
  const p = svc.status().portrait;
  assert.equal(p.source.kind, 'snapshot');
  assert.equal(p.source.msgs, 25, '超过 36 小时的那条不算');
  assert.equal(svc.status().archiveReady, false);
});

test('本人消息 <20 条：只出统计、不调模型，并说清原因', async () => {
  const { svc, prompts, events } = setup({ archive: false, snapshotMine: 8 });
  svc.run({}); await svc.lastJob;
  assert.equal(prompts.length, 0);
  assert.ok(!events.some(e => e.step === 'model'));
  const p = svc.status().portrait;
  assert.equal(p.backend.kind, 'stats-only');
  assert.match(p.note, /不到 20 条/);
  assert.match(events.at(-1).text, /不到 20 条/);
});

test('只统计：run({statsOnly}) 不调模型', async () => {
  const { svc, prompts } = setup();
  svc.run({ statsOnly: true }); await svc.lastJob;
  assert.equal(prompts.length, 0);
  assert.equal(svc.status().portrait.backend.kind, 'stats-only');
});

test('保存、应用开关、删除：删除后画像目录全无；审计日志不含原话', async () => {
  const { svc, dataDir } = setup();
  svc.run({}); await svc.lastJob;
  let p = svc.status().portrait;
  const r = svc.save({ patch: { speak: { catchphrases: [{ id: 'x', text: '冲', locked: true }] } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.portrait.speak.catchphrases.map(c => c.text), ['冲']);
  assert.deepEqual(svc.apply({ target: 'assistant', on: true }), { ok: true, apply: { assistant: true, avatar: false, pet: false, community: false, ppt: false } });
  assert.match(svc.forTarget('assistant'), /「冲」/);
  // 出口拦截：原话、人名、应承词
  assert.equal((await svc.guard('这周把仿真的结果整理成一页发给大家吧')).hit, 'verbatim');
  assert.equal((await svc.guard('问问张三吧')).hit, 'name');
  assert.equal((await svc.guard('我来搞定')).hit, 'commit');
  assert.equal((await svc.guard('看情况吧')).ok, true);
  const dir = svc.store.dirOf('me');
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');
  for (const op of ['distill', 'save', 'apply', 'guard-block']) assert.match(audit, new RegExp(`"op":"${op}"`));
  for (const t of MINE.filter(t => t.length > 2)) assert.ok(!audit.includes(t), '审计不含原话：' + t);
  assert.ok(!audit.includes('别人的原话'));
  assert.deepEqual(svc.remove(), { ok: true });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(svc.status().enabled, false);
  assert.equal(svc.forTarget('assistant'), null);
  const left = fs.readdirSync(path.join(dataDir, 'self-distill'));
  assert.deepEqual(left, ['audit.jsonl'], '只剩记了「删除」这件事的总审计');
  p = null;
});

test('IPC：六个通道都注册；出错返回 ok:false；for-target 只给社区/桌宠且社区例句先过闸', async () => {
  const { svc } = setup();
  const handlers = {};
  svc.registerIpc({ handle: (ch, fn) => { handlers[ch] = fn; } });
  assert.deepEqual(Object.keys(handlers).sort(), ['self-distill:apply', 'self-distill:delete', 'self-distill:for-target', 'self-distill:run', 'self-distill:save', 'self-distill:status'].sort());
  assert.equal((await handlers['self-distill:save']({}, { patch: {} })).ok, false, '没有画像时报人话');
  await handlers['self-distill:run']({}, {}); await svc.lastJob;
  assert.equal(await handlers['self-distill:for-target']({}, { target: 'community' }), null, '没开时 null');
  svc.save({ patch: { speak: { examples: [{ id: 'e1', cat: 'chat', text: '周末去哪玩' }, { id: 'e2', cat: 'chat', text: '张三说周末去哪玩' }] } } });
  svc.apply({ target: 'community', on: true });
  const cm = await handlers['self-distill:for-target']({}, { target: 'community' });
  assert.deepEqual(cm.examples, ['周末去哪玩']);
  assert.equal(await handlers['self-distill:for-target']({}, { target: 'assistant' }), null);
  assert.equal((await handlers['self-distill:apply']({}, { target: 'nope', on: true })).ok, false);
});

test('没有 WeLink 登录：status 给出原因，run 报错误事件', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-svc-'));
  const events = [];
  const svc = createSelfDistillService({ dataDir, getAssistant: () => null, sendToRenderer: (_c, e) => events.push(e), resolveBackend: () => null, findCommand: () => '' });
  const st = svc.status();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /登录/);
  assert.match(st.backendLabel, /只统计/);
  svc.run({}); await svc.lastJob;
  assert.equal(events.at(-1).step, 'error');
});

test('forTargetCurrent：同步取当前账号画像；没登录、没画像、关着都返回 null', async () => {
  const mod = require('../main/self-distill-service');
  const { svc } = setup();
  assert.equal(mod.forTargetCurrent('pet'), null, '没画像');
  svc.run({ statsOnly: true }); await svc.lastJob;
  assert.equal(svc.forTargetCurrent('pet'), null, '没打开');
  svc.apply({ target: 'pet', on: true });
  const pet = mod.forTargetCurrent('pet');
  assert.equal(pet.habits.hours.length, 24);
  assert.equal(mod.forTargetCurrent('nope'), null);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-svc-'));
  createSelfDistillService({ dataDir, getAssistant: () => null });
  assert.equal(mod.forTargetCurrent('pet'), null, '没登录');
});
