'use strict';
// 蒸馏自己 · 三方审查修复回归（2026-11-28）：并发覆盖、失败即关、模型结果完整去敏、note 不带异常正文、英文姓名、
// 取样全局排序、口头禅排除占位、回复 <1 分钟、topics 白名单、画像变更事件、backendOk，以及真实 shape → 消费方的跨模块契约。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SD = require('../core/self-distill');
const svcMod = require('../main/self-distill-service');
const { createSelfDistillService } = svcMod;

const NOW = Date.UTC(2026, 10, 28, 4, 0);
const MINE = ['行', '好嘞', '我看下', '仿真结果出来了吗', '这个调度方案再对一下', '这周把仿真的结果整理成一页发给大家', '好嘞', '行'];

function assistantWith({ convs = null, loadIndexThrows = false, names = { u1: '张三', u2: 'Alice' } } = {}) {
  const rows = {};
  if (convs) Object.assign(rows, convs);
  else {
    rows.u1 = [];
    for (let i = 0; i < 40; i += 1) {
      const t = NOW - (i + 1) * 3 * 3600000;
      rows.u1.push({ id: 'a' + i, at: t, a: 'u1', t: '别人的话' + i });
      rows.u1.push({ id: 'b' + i, at: t + 120000, a: 'me', m: 1, t: MINE[i % MINE.length], ct: 'TEXT' });
    }
    rows.u1.push({ id: 'x', at: NOW - 3600000, a: 'me', m: 1, t: '和 Alice 对一下', ct: 'TEXT' });
  }
  return {
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fix-a-')),
    snapshot: () => ({ login: { ok: true, uid: 'me' }, conversations: [], messages: {} }),
    archive: {
      owner: () => 'me',
      status: () => ({ available: true, messages: 99 }),
      loadIndex: () => { if (loadIndexThrows) throw new Error('档案坏了'); return { convs: Object.fromEntries(Object.keys(rows).map(k => [k, { name: names[k] || k }])), names }; },
      read: (_o, conv) => (rows[conv] || []).slice(),
    },
  };
}
function setup(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fix-'));
  const a = opts.assistant || assistantWith(opts);
  const sent = [], prompts = [];
  const svc = createSelfDistillService({
    dataDir, now: () => NOW, getAssistant: () => a, sendToRenderer: (ch, ev) => sent.push([ch, ev]),
    resolveBackend: () => (opts.backend === undefined ? { kind: 'codeagent', model: 'm' } : opts.backend), findCommand: () => '',
    runModel: async p => { prompts.push(p); return opts.model ? opts.model(p) : JSON.stringify({ tone: ['先给判断'], examples: [{ cat: 'chat', text: '周末去哪玩' }] }); },
    logger: { warn() {} },
  });
  return { dataDir, svc, sent, prompts, a };
}

test('并发：蒸馏期间的锁定修改和开关不被冲掉；删除让在途蒸馏作废', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { svc } = setup({ model: async () => { await gate; return JSON.stringify({ tone: ['新口吻'], examples: [] }); } });
  svc.run({ statsOnly: true }); await svc.lastJob; // 先有一份画像
  svc.run({});
  await new Promise(r => setTimeout(r, 30)); // 进入等模型
  svc.save({ patch: { speak: { catchphrases: [{ id: 'mine', text: '冲', locked: true }] } } });
  svc.apply({ target: 'community', on: true });
  release(); await svc.lastJob;
  const p = svc.status().portrait;
  assert.equal(p.speak.catchphrases[0].text, '冲');
  assert.equal(p.apply.community, true);
  assert.ok(p.speak.tone.some(t => t.text === '新口吻'));

  let release2;
  const gate2 = new Promise(r => { release2 = r; });
  const s2 = setup({ model: async () => { await gate2; return JSON.stringify({ tone: ['x'], examples: [] }); } });
  s2.svc.run({ statsOnly: true }); await s2.svc.lastJob;
  s2.svc.run({});
  await new Promise(r => setTimeout(r, 30));
  s2.svc.remove();
  release2(); await s2.svc.lastJob;
  assert.equal(s2.svc.status().enabled, false, '删除后在途蒸馏不能把画像写回来');
  assert.equal(fs.existsSync(s2.svc.store.dirOf('me')), false);
});

test('note 只存固定原因：模型异常正文（可能带原话）不进画像', async () => {
  const { svc } = setup({ model: async () => { throw new Error('stderr: 这周把仿真的结果整理成一页发给大家'); } });
  svc.run({}); await svc.lastJob;
  const p = svc.status().portrait;
  assert.equal(p.noteCode, 'model-failed');
  assert.ok(!JSON.stringify(p).includes('整理成一页发给大家'), '画像里没有原话');
  const t = setup({ model: async () => { throw Object.assign(new Error('超时'), { timedOut: true }); } });
  t.svc.run({}); await t.svc.lastJob;
  assert.equal(t.svc.status().portrait.noteCode, 'model-timeout');
});

test('模型结果写入前完整去敏：电话、链接、长数字、敏感分类的句子删掉', async () => {
  const { svc } = setup({ model: async () => JSON.stringify({ tone: ['工资的事别问我'], examples: [
    { cat: 'chat', text: '打我电话 13812345678' }, { cat: 'fact', text: '看 https://x.example/a' }, { cat: 'fact', text: '单号 1234567 查一下' },
    { cat: 'chat', text: '周末去哪玩' }] }) });
  svc.run({}); await svc.lastJob;
  const p = svc.status().portrait;
  assert.deepEqual(p.speak.examples.map(e => e.text), ['周末去哪玩']);
  assert.ok(!p.speak.tone.some(t => /工资/.test(t.text)));
  assert.equal(p.noteCode, 'blocked');
  for (const t of ['13812345678', 'https://x.example', '1234567']) assert.equal(SD.verbatimGuard('x ' + t).ok, false, t);
});

test('姓名名单保留已解析的英文姓名，只排除账号标识', async () => {
  const { svc, prompts } = setup();
  svc.run({}); await svc.lastJob;
  assert.ok(!/Alice/.test(prompts[0]), '英文姓名也被替换');
  assert.match(prompts[0], /和 某同事 对一下/);
});

test('取样按全局时间排序取最近：最后遍历的长会话不挤掉别的会话里更新的消息', async () => {
  const convs = { recent: [], old: [] };
  for (let i = 0; i < 30; i += 1) convs.recent.push({ id: 'r' + i, at: NOW - i * 60000, m: 1, t: '最近的话' + i, ct: 'TEXT' });
  for (let i = 0; i < 400; i += 1) convs.old.push({ id: 'o' + i, at: NOW - 90 * 86400000 + i * 60000, m: 1, t: '很久以前' + i, ct: 'TEXT' });
  const { svc, prompts } = setup({ convs, names: {} });
  svc.run({}); await svc.lastJob;
  assert.match(prompts[0], /最近的话0/);
});

test('统计：「某同事」与占位不算口头禅；回复不到 1 分钟记 1', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) { rows.push({ at: i * 600000, c: 'p' }); rows.push({ at: i * 600000 + 20000, c: 'p', m: 1, t: i % 2 ? '某同事' : '[链接]' }); }
  const st = SD.computeStats(rows);
  assert.deepEqual(st.catchphrases, []);
  assert.equal(st.habits.replyMedianMin, 1);
  assert.equal(SD.computeStats([{ at: 0, m: 1, t: 'a' }]).habits.replyMedianMin, 0, '没有样本仍是 0');
});

test('topics：保存时只认白名单，不能改字，只能锁定和删除', async () => {
  const { svc } = setup();
  svc.run({ statsOnly: true }); await svc.lastJob;
  const before = svc.status().portrait.habits.topics;
  assert.ok(before.length >= 1);
  const r = svc.save({ patch: { habits: { topics: [{ ...before[0], text: '某星辰项目', locked: true }, { id: 'n', text: '某星辰项目' }] } } });
  assert.deepEqual(r.portrait.habits.topics.map(t => [t.text, t.locked]), [[before[0].text, true]]);
});

test('画像变更事件：保存、开关、删除、蒸馏完成都发 self-distill:changed，并通知主进程订阅方', async () => {
  const { svc, sent } = setup();
  const heard = [];
  const off = svcMod.onChanged(e => heard.push(e.why));
  svc.run({ statsOnly: true }); await svc.lastJob;
  svc.save({ patch: {} }); svc.apply({ target: 'pet', on: true }); svc.remove();
  off();
  assert.deepEqual(sent.filter(([ch]) => ch === 'self-distill:changed').map(([, e]) => e.why), ['distill', 'save', 'apply', 'delete']);
  assert.deepEqual(heard, ['distill', 'save', 'apply', 'delete']);
});

test('backendOk：没找到后端时为 false，只统计档和有后端时为 true', () => {
  assert.equal(setup({ backend: null }).svc.status().backendOk, false);
  assert.equal(setup({ backend: { kind: 'stats-only', model: '' } }).svc.status().backendOk, true);
  assert.equal(setup().svc.status().backendOk, true);
});

test('出口失败即关：原话索引建不起来、没登录都返回 ok:false', async () => {
  const bad = setup({ assistant: { ...assistantWith({ loadIndexThrows: true }) } });
  assert.deepEqual(await bad.svc.guard('看情况吧'), { ok: false, text: '', hit: 'unavailable' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fix-'));
  const none = createSelfDistillService({ dataDir, getAssistant: () => null, logger: { warn() {} } });
  assert.equal((await none.guard('看情况吧')).ok, false);
  // 某个会话读失败：索引不完整，同样失败即关
  const partial = assistantWith();
  partial.archive.read = (_o, conv) => { if (conv === 'u1') throw new Error('读不出'); return []; };
  assert.deepEqual(await setup({ assistant: partial }).svc.guard('看情况吧'), { ok: false, text: '', hit: 'unavailable' });
});

test('社区气泡：主进程先生成最终显示文本（去标签、截长）再检查，插标签绕不过原话拦截', async () => {
  const { svc } = setup();
  svc.run({ statsOnly: true }); await svc.lastJob;
  svc.save({ patch: { speak: { examples: [
    { id: 'e1', cat: 'chat', text: '这周把<b>仿真的</b>结果整理成一页发给大家' }, { id: 'e2', cat: 'chat', text: '<i>周末</i>去哪玩' }] } } });
  svc.apply({ target: 'community', on: true });
  const v = await svc.forTargetIpc({ target: 'community' });
  assert.deepEqual(v.examples, ['周末去哪玩']);
});

// ---- 跨模块契约：真实 shape 的输出直接交给消费方（不用手写对象） ----
test('契约：forTarget(pet) → 桌宠 selfLines；forTarget(community) → 社区 selfPlan，都按字符串数组读', async () => {
  const { svc } = setup();
  svc.run({}); await svc.lastJob;
  svc.save({ patch: { tags: [{ id: 'g', text: '话少直给', on: true }] } });
  svc.apply({ target: 'pet', on: true }); svc.apply({ target: 'community', on: true });
  const pet = svc.forTargetCurrent('pet');
  for (const k of ['catchphrases', 'examples']) assert.ok(pet[k].every(x => typeof x === 'string'), k);
  const lines = require('../core/hub-pet/talk').selfLines(pet);
  assert.ok(lines.some(l => l.s === '周末去哪玩'));
  assert.ok(lines.some(l => /「行」/.test(l.s)));
  const view = await svc.forTargetIpc({ target: 'community' });
  assert.ok(view.tags.every(x => typeof x === 'string') && view.examples.every(x => typeof x === 'string'));
  const plan = require('../renderer/community-scene').selfPlan(view);
  assert.equal(plan.tag, '话少直给');
  assert.deepEqual(plan.bubbles, ['周末去哪玩']);
  // 百分比是 0–100 整数
  const s = svc.status().portrait.speak.stats;
  for (const k of ['periodRate', 'emojiRate', 'burstRate', 'enMixRate']) assert.ok(Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 100, k);
});
