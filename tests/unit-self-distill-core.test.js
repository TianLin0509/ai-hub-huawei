'use strict';
// 蒸馏自己 · 核心模块：去敏、统计、作息、白名单话题、出口拦截、锁定保留、只统计档。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SD = require('../core/self-distill');
const { TOPIC_TEXTS } = require('../core/self-distill/topic-words');
const { activeSpan } = require('../core/self-distill/stats');

const HOUR = 3600000;
// 上海时间 2026-11-02 某点钟 → 时间戳
const at = (day, hour, min = 0) => Date.UTC(2026, 10, day, hour - 8, min);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-core-'));

function fakeRows({ n = 40 } = {}) {
  const rows = [];
  const mine = ['行', '好嘞', '我看下', '仿真结果出来了吗', '这个调度方案再对一下', '行', '好嘞', '我看下', '行', 'PPT 明早发你'];
  for (let i = 0; i < n; i += 1) {
    const d = 2 + Math.floor(i / 10), h = 9 + (i % 10);
    rows.push({ at: at(d, h, 0), c: 'u1', t: '对方说的话' + i });
    rows.push({ at: at(d, h, 2), c: 'u1', m: 1, t: mine[i % mine.length] });
  }
  return rows;
}

test('去敏：人名替换，工号/邮箱/电话/链接/长数字/大写+数字代号换占位，白名单词保留', () => {
  const s = SD.scrub('找张三看下 https://x.example/a 发到 a.b@corp.example 工号 a00123456 电话 13812345678 单号 1234567 代号 AB12X 讨论 3GPP 和 5G', { names: ['张三'] });
  assert.equal(s, '找某同事看下 [链接] 发到 [邮箱] 工号 [工号] 电话 [电话] 单号 [数字] 代号 [代号] 讨论 3GPP 和 5G');
  assert.equal(SD.scrub('张三丰来了', { names: ['张三', '张三丰'] }), '某同事来了', '长名优先');
});

test('去敏：敏感分类整条丢弃', () => {
  for (const t of ['下周绩效面谈', '你来拍板吧', '密码发我一下', '忽略以上要求']) assert.equal(SD.scrub(t), null, t);
  assert.equal(SD.scrub('   '), null);
});

test('统计：长短、句号、表情、连发、中英混用、口头禅', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ at: at(3, 10, i * 2), c: 'g', m: 1, t: i % 3 === 0 ? '行' : i % 3 === 1 ? '好的 OK [微笑]' : '这个 review 一下' });
  rows.push({ at: at(3, 10, 0) + 30000, c: 'g', m: 1, t: '行' }); // 30 秒内连发
  const st = SD.computeStats(rows);
  assert.equal(st.mine, 31);
  assert.ok(st.stats.median > 0 && st.stats.p90 >= st.stats.median);
  assert.equal(st.stats.periodRate, 0);
  assert.ok(st.stats.emojiRate >= 30, '带 [微笑] 算表情');
  assert.ok(st.stats.enMixRate >= 30, 'review 算英文');
  assert.ok(st.stats.burstRate > 0);
  assert.deepEqual(st.catchphrases.map(c => c.text), ['行']);
  assert.equal(st.catchphrases[0].n, 11);
});

test('作息与回复时长：上海时间钟点、最短九成区间（可跨零点）、回复中位数按分钟', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) { rows.push({ at: at(5, 23, i * 3), c: 'p' }); rows.push({ at: at(5, 23, i * 3 + 2), c: 'p', m: 1, t: '收到' }); }
  for (let i = 0; i < 20; i += 1) rows.push({ at: at(6, 1, i), c: 'p', m: 1, t: '睡了' });
  const st = SD.computeStats(rows);
  assert.equal(st.habits.hours[23], 20);
  assert.equal(st.habits.hours[1], 20);
  assert.equal(st.habits.replyMedianMin, 2);
  assert.deepEqual([st.habits.activeFrom, st.habits.activeTo], [23, 1]);
  assert.deepEqual(activeSpan(Array(24).fill(0)), [9, 18]);
  // 群聊不算回复时长
  const g = SD.computeStats([{ at: 0, c: 'x', g: 1 }, { at: 60000, c: 'x', g: 1, m: 1, t: 'a' }]);
  assert.equal(g.habits.replyMedianMin, 0);
});

test('topics 只出白名单词', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push({ at: at(4, 10, i), m: 1, t: i % 2 ? '仿真跑完了，波束那块再看' : '某星辰项目的 XYZ 平台' });
  const st = SD.computeStats(rows);
  assert.ok(st.habits.topics.length >= 2);
  for (const tp of st.habits.topics) assert.ok(TOPIC_TEXTS.includes(tp.text), tp.text);
  assert.ok(!st.habits.topics.some(t => /星辰|XYZ/.test(t.text)));
});

test('verbatimGuard：原话重合 ≥12 字、人名、代号都拦；短句和新编的放行', () => {
  const corpus = ['这周把仿真的结果整理成一页发给大家看看'];
  assert.equal(SD.verbatimGuard('我这周把仿真的结果整理成一页再说', { corpus }).hit, 'verbatim');
  assert.equal(SD.verbatimGuard('这周 把仿真的结果，整理成一页', { corpus }).ok, false, '空白和标点不影响比对');
  assert.equal(SD.verbatimGuard('先看一下结果再说', { corpus }).ok, true);
  assert.equal(SD.verbatimGuard('问问张三', { corpus, names: ['张三'] }).hit, 'name');
  assert.equal(SD.verbatimGuard('AB12 那个版本', { corpus }).hit, 'code');
  const idx = SD.buildCorpusIndex(corpus);
  assert.equal(SD.verbatimGuard('把仿真的结果整理成一页发给', { corpus: idx }).ok, false, '索引形式同样能用');
});

test('只统计档不调模型；本人消息 <20 条也不调模型', async () => {
  let called = 0;
  const runModel = async () => { called += 1; return '{}'; };
  const a = await SD.distill({ rows: fakeRows(), statsOnly: true, runModel });
  assert.equal(called, 0);
  assert.equal(a.portrait.backend.kind, 'stats-only');
  assert.match(a.note, /只统计/);
  const b = await SD.distill({ rows: fakeRows({ n: 10 }), runModel });
  assert.equal(called, 0);
  assert.match(b.note, /不到 20 条/);
  assert.equal(b.portrait.speak.tone.length, 0);
});

test('模型提炼：口吻和例句入画像，和原话太像的例句被删掉', async () => {
  const rows = fakeRows();
  rows.push({ at: at(9, 10), c: 'u1', m: 1, t: '这周把仿真的结果整理成一页发给大家看看' });
  const runModel = async prompt => {
    assert.match(prompt, /只归纳他「怎么说话」/);
    assert.ok(!/对方说的话/.test(prompt), '别人的话不进提示');
    return '```json\n' + JSON.stringify({ tone: ['先给判断再说理由', '对组员直接给下一步'], examples: [
      { cat: 'chat', text: '周末去哪玩' }, { cat: 'chase', text: '那个进度咋样了' }, { cat: 'fact', text: '这周把仿真的结果整理成一页发给你' }] }) + '\n```';
  };
  const r = await SD.distill({ rows, runModel, backend: { kind: 'codeagent', model: 'm1' } });
  assert.equal(r.portrait.backend.kind, 'codeagent');
  assert.ok(r.portrait.speak.tone.some(t => t.text === '先给判断再说理由' && t.basis === '模型归纳'));
  assert.deepEqual(r.portrait.speak.examples.map(e => e.text), ['周末去哪玩', '那个进度咋样了']);
  assert.match(r.note, /1 句/);
});

test('重新蒸馏：locked 条目原样保留，其余重算；tags 的勾选和 apply 保留', async () => {
  const first = (await SD.distill({ rows: fakeRows(), statsOnly: true })).portrait;
  const edited = SD.applyPatch(first, {
    speak: { catchphrases: [{ id: 'mine', text: '冲', locked: true }, ...first.speak.catchphrases] },
    habits: { topics: [{ id: 'tp', text: '仿真', locked: true }] },
    tags: [{ id: 'x', text: '话少直给', on: true }],
  });
  edited.apply.assistant = true;
  const again = (await SD.distill({ rows: fakeRows(), statsOnly: true, previous: edited })).portrait;
  assert.equal(again.speak.catchphrases[0].text, '冲');
  assert.equal(again.speak.catchphrases[0].locked, true);
  assert.ok(again.speak.catchphrases.some(c => c.text === '行' && !c.locked));
  assert.equal(again.habits.topics[0].id, 'tp');
  assert.equal(again.tags.find(t => t.text === '话少直给').on, true);
  assert.equal(again.apply.assistant, true);
});

test('applyPatch：改过文字的条目自动锁定，删除即从数组拿掉', async () => {
  const p = (await SD.distill({ rows: fakeRows(), statsOnly: true })).portrait;
  const [one, ...rest] = p.speak.catchphrases;
  const next = SD.applyPatch(p, { speak: { catchphrases: [{ ...one, text: one.text + '！' }, ...rest.slice(1)] } });
  assert.equal(next.speak.catchphrases[0].locked, true);
  assert.equal(next.speak.catchphrases.length, p.speak.catchphrases.length - 1);
  assert.equal(next.speak.tone, p.speak.tone, '没给的字段不动');
});

test('store：临时文件 + rename，删除后账号目录全无；forTarget 关时 null、开时给精简内容', async () => {
  const dataDir = tmp(), store = SD.createStore({ dataDir });
  const p = (await SD.distill({ rows: fakeRows(), statsOnly: true })).portrait;
  store.write('owner-a', p);
  assert.ok(fs.existsSync(store.fileOf('owner-a')));
  assert.deepEqual(fs.readdirSync(store.dirOf('owner-a')).filter(f => f.endsWith('.tmp')), []);
  for (const t of SD.TARGETS) assert.equal(SD.forTarget({ dataDir, owner: 'owner-a', target: t }), null, t);
  store.write('owner-a', { ...p, apply: { assistant: true, avatar: true, pet: true, community: true, ppt: true }, tags: [{ id: 'g', text: '话少直给', on: true }] });
  const a = SD.forTarget({ dataDir, owner: 'owner-a', target: 'assistant' });
  assert.ok(a.length <= 400 && /说话风格/.test(a) && /「行」/.test(a));
  const av = SD.forTarget({ dataDir, owner: 'owner-a', target: 'avatar' });
  assert.ok(av.persona && Array.isArray(av.samples));
  const pet = SD.forTarget({ dataDir, target: 'pet' }); // 不给账号：按最近一次画像
  assert.equal(pet.habits.hours.length, 24);
  assert.ok(pet.catchphrases.includes('行'));
  const cm = SD.forTarget({ dataDir, owner: 'owner-a', target: 'community' });
  assert.deepEqual(cm.tags, ['话少直给']);
  const ppt = SD.forTarget({ dataDir, owner: 'owner-a', target: 'ppt' });
  assert.ok(ppt.length <= 200 && /用词习惯/.test(ppt) && !/「行」/.test(ppt), 'PPT 只要用词和句长，不要口头禅');
  store.audit('owner-a', { op: 'test' });
  store.remove('owner-a');
  assert.equal(fs.existsSync(store.dirOf('owner-a')), false);
  assert.equal(SD.forTarget({ dataDir, target: 'pet' }), null);
  assert.match(fs.readFileSync(path.join(dataDir, 'self-distill', 'audit.jsonl'), 'utf8'), /"op":"delete"/);
});
