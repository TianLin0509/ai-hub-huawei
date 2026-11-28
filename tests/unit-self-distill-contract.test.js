'use strict';
// 蒸馏自己 · 跨模块契约（2026-11-28 三方审查后补）：用核心真实产出的画像（distill + shape），喂给界面、桌宠、社区场景这些消费方，
// 不再用手写的对象当测试数据。负责人定的口径：forTarget 的 catchphrases / examples / tags / topics 一律是字符串数组；
// 百分比核心存 0–100 整数，界面只加 %；回复中位有样本不到 1 分钟时核心记 1，界面写「1 分钟内」。
const test = require('node:test');
const assert = require('node:assert/strict');
const SD = require('../core/self-distill');
const talk = require('../core/hub-pet/talk');
const { decidePose } = require('../core/hub-pet/state');
const scene = require('../renderer/community-scene');
const sp = require('../renderer/self-portrait');

// 合成的 10 天聊天：本人深夜 23 点前后最活跃，短句、口头禅、领域词；对方先发、本人 30 秒内回。
const DAY = 86400000, BASE = Date.UTC(2026, 10, 10, 15, 0, 0); // 上海时间 11-10 23:00
const SAY = ['我看下', '行', '好嘞', '仿真结果出来了吗', 'PPT 明早再改', '这个先放放', '我看下', '行'];
function rows() {
  const out = [];
  for (let d = 0; d < 10; d++) for (let i = 0; i < 12; i++) {
    const at = BASE + d * DAY + i * 5 * 60000;
    out.push({ at: at - 30000, c: 'c' + (i % 3) });
    out.push({ at, c: 'c' + (i % 3), m: 1, t: SAY[(d + i) % SAY.length] });
  }
  return out;
}
const MODEL = JSON.stringify({ tone: ['先给判断再说理由'], examples: [{ cat: 'chat', text: '今天这锅先放放，明早再看' }, { cat: 'fact', text: '结论先给，细节晚点补' }, { cat: 'chat', text: '辛苦，早点休息' }] });

async function real() {
  const { portrait } = await SD.distill({ rows: rows(), source: { kind: 'archive' }, backend: { kind: 'codeagent', model: '' }, runModel: async () => MODEL });
  portrait.apply = { assistant: true, avatar: true, pet: true, community: true, ppt: true };
  portrait.tags = portrait.tags.map((t, i) => ({ ...t, on: i === 0 }));
  return portrait;
}

test('契约：核心产出的 pet / community 视图里 catchphrases、examples、tags、topics 都是字符串数组', async () => {
  const p = await real();
  const pet = SD.shape(p, 'pet'), com = SD.shape(p, 'community');
  for (const list of [pet.catchphrases, pet.examples, pet.habits.topics, com.examples, com.tags, com.habits.topics]) {
    assert.ok(Array.isArray(list) && list.length, JSON.stringify(list));
    assert.ok(list.every(x => typeof x === 'string'), JSON.stringify(list));
  }
  for (const k of ['periodRate', 'emojiRate', 'burstRate', 'enMixRate']) assert.ok(Number.isInteger(p.speak.stats[k]) && p.speak.stats[k] >= 0 && p.speak.stats[k] <= 100, k);
});

test('桌宠吃真实 pet 视图：像我句来自本人口头禅和闲聊例句；作息按上海时间（深夜陪着、上午打盹）', async () => {
  const pet = SD.shape(await real(), 'pet');
  const lines = talk.selfLines(pet).map(l => l.s);
  assert.ok(lines.includes('今天这锅先放放，明早再看'), lines.join('|'));
  assert.ok(lines.includes('「我看下」——跟你学的'), lines.join('|'));
  assert.ok(!lines.some(l => l.includes('结论先给')), '答事实类例句不进桌宠');
  const said = talk.pickLine('afternoon', { now: BASE, rng: () => 0.01, self: pet });
  assert.equal(said.me, true);
  // 上海 23:10 停手 5 分钟：主人常在 → 不睡；上海 10:00 停手 150 秒：主人通常不在 → 打盹。
  assert.equal(decidePose({ now: BASE + 10 * 60000, idleSec: 300, habits: pet.habits }), 'idle');
  assert.equal(decidePose({ now: BASE + 11 * 3600000, idleSec: 150, habits: pet.habits }), 'sleep');
});

test('社区场景吃真实 community 视图：气泡原样用主进程给的例句，道具按领域，名牌用勾选的标签', async () => {
  const p = await real();
  const com = SD.shape(p, 'community');
  const plan = scene.selfPlan(com);
  assert.deepEqual(plan.bubbles, com.examples, '不改写主进程检查过的文本');
  assert.ok(['🖥', '📊'].includes(plan.prop), plan.prop);
  assert.equal(plan.tag, p.tags[0].text);
  const viaIpc = await scene.loadSelfPlan({ invoke: async () => com });
  assert.deepEqual(viaIpc, plan);
});

test('界面吃真实画像：百分比直接加 %（不再 ×100）；回复不到 1 分钟写「1 分钟内」', async () => {
  const p = await real();
  assert.equal(p.habits.replyMedianMin, 1, '30 秒回复，核心记 1');
  assert.equal(sp.replyValue(p.habits.replyMedianMin), '<b>1</b> 分钟内');
  assert.equal(sp.replyValue(0), '<b>—</b> 分钟');
  assert.equal(sp.pct(p.speak.stats.burstRate), `${p.speak.stats.burstRate}%`);
  assert.equal(sp.pct(12), '12%');
});
