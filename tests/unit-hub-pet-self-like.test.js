'use strict';
// 蒸馏自己 › 应用到桌宠（2026-11-28）：没勾时选句与作息与以前逐字一致（回归）；勾了闲聊混进「像我」句、作息按主人习惯定打盹。
const test = require('node:test');
const assert = require('node:assert/strict');
const talk = require('../core/hub-pet/talk');
const { LINES } = require('../core/hub-pet/talk-lines');
const { chatterFor, decidePose, ownerAway } = require('../core/hub-pet/state');

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
const lcg = (seed = 7) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
// forTarget(pet) 的真实形状：字符串数组，examples 已只剩闲聊类（核心 shape 里筛过）。真实产出的端到端见 unit-self-distill-contract。
const SELF = {
  catchphrases: ['我看下', '行'],
  examples: ['今天这锅先放放，明早再看', '<b>收工</b>', { text: '旧形状的对象不读' }],
};
// 夜猫子作息（上海时间钟点）：22 点到次日 2 点最活跃，白天很少。sh()＝上海时间，和核心统计口径一致，不受跑测试机器的时区影响。
const sh = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 8, m);
const OWL = { hours: Array.from({ length: 24 }, (_, h) => (h >= 22 || h < 2 ? 40 : h >= 9 && h < 18 ? 3 : 0)), activeFrom: 22, activeTo: 2 };

test('回归：不给 self、self 为 null、self 里没内容时，每个情境每个时刻挑出的句子逐字一致（随机数序列也一致）', () => {
  for (const ctx of Object.keys(LINES)) {
    for (const d of [16, 18, 20, 21]) for (const h of [8, 12, 15, 18, 23]) {
      const base = { now: at(d, h), name: '团子', prefs: { chat: { up: 1, down: 0 } }, recent: [] };
      const a = talk.pickLine(ctx, { ...base, rng: lcg(d * 100 + h) });
      for (const self of [undefined, null, { catchphrases: [], examples: [] }, { examples: [{ text: '对象不读' }], catchphrases: [{ text: '对象不读' }] }]) {
        const b = talk.pickLine(ctx, { ...base, rng: lcg(d * 100 + h), self });
        assert.deepEqual(b, a, `${ctx} ${d}日${h}点 self=${JSON.stringify(self)}`);
      }
    }
  }
});

test('勾了：约三成闲聊换成像我句（闲聊例句 + 口头禅），只取 chat 类、去掉标签，说过的不重复；久坐提醒不混', () => {
  const pool = talk.selfLines(SELF).map(l => l.s);
  assert.deepEqual(pool, ['今天这锅先放放，明早再看', '收工', '「我看下」——跟你学的', '「行」——跟你学的']);
  const rng = lcg(11);
  let mine = 0, recent = [];
  const N = 400;
  for (let i = 0; i < N; i++) {
    const l = talk.pickLine('afternoon', { now: at(18, 15), rng, recent: [], self: SELF });
    if (l.me) { mine++; assert.equal(l.type, 'chat'); assert.ok(pool.includes(l.text)); assert.match(l.id, /^me-/); }
  }
  assert.ok(mine > N * 0.2 && mine < N * 0.4, `像我句 ${mine}/${N}`);
  // 说过的记进 recent 后不再挑：4 句轮完就只出原句库。
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const l = talk.pickLine('back', { now: at(18, 10), rng: () => 0.01, recent, self: SELF });
    recent = talk.noteSpoken(recent, l.id);
    if (l.me) { assert.ok(!seen.has(l.id), '重复：' + l.text); seen.add(l.id); }
  }
  assert.equal(seen.size, 4);
  for (const ctx of ['sit', 'sitAgain']) assert.ok(!talk.pickLine(ctx, { now: at(18, 15), rng: () => 0.01, self: SELF }).me, ctx);
});

test('勾了：闲聊被点「少说」越多，像我句也越少；chatterFor 把 self 带到选句', () => {
  const count = prefs => { const rng = lcg(5); let n = 0; for (let i = 0; i < 300; i++) if (talk.pickLine('afternoon', { now: at(18, 15), rng, prefs, self: SELF })?.me) n++; return n; };
  assert.ok(count({ chat: { up: 0, down: 1 } }) < count(null));
  const track = {};
  const said = chatterFor('lively', { now: at(18, 8, 30), idleSec: 0 }, track, { rng: () => 0.01, self: SELF });
  assert.equal(said.kind, 'chatter');
  assert.match(said.talk.line, /^me-/);
});

test('作息回归：不给 habits（或作息全是 0）时，24 小时 × 各种停手时长的姿态与以前一致', () => {
  for (let h = 0; h < 24; h++) for (const idleSec of [0, 60, 130, 300, 700]) for (const pettedAt of [0, at(18, h) - 1000]) {
    const ctx = { now: at(18, h, 10), idleSec, pettedAt };
    const want = decidePose(ctx);
    assert.equal(decidePose({ ...ctx, habits: null }), want);
    assert.equal(decidePose({ ...ctx, habits: { hours: new Array(24).fill(0) } }), want);
    assert.equal(decidePose({ ...ctx, habits: { hours: [1, 2] } }), want, '格式不对的作息不生效');
  }
});

test('作息像主人：夜猫子深夜停手 5 分钟仍陪着；上午主人通常不在，停手 2 分钟就打盹；10 分钟没操作照旧睡', () => {
  assert.equal(decidePose({ now: at(18, 23), idleSec: 300 }), 'sleep', '以前：夜里停手 2 分钟就睡');
  assert.equal(decidePose({ now: sh(18, 23), idleSec: 300, habits: OWL }), 'idle', '夜猫子：深夜是主人的活跃时段');
  assert.equal(decidePose({ now: at(18, 7, 30), idleSec: 150 }), 'idle', '以前：早上 7 点半停手 150 秒不睡');
  assert.equal(decidePose({ now: sh(18, 7, 30), idleSec: 150, habits: OWL }), 'sleep', '夜猫子：早上还在打盹');
  assert.equal(decidePose({ now: sh(18, 23), idleSec: 700, habits: OWL }), 'sleep');
  assert.equal(decidePose({ now: sh(18, 7, 30), idleSec: 150, habits: OWL, pettedAt: sh(18, 7, 30) - 1000 }), 'idle', '摸一下照样醒一分钟');
  assert.equal(ownerAway(sh(18, 10), OWL), true);
  assert.equal(ownerAway(sh(18, 1), OWL), false);
  // 作息按上海钟点取：上海 01:00 = UTC 17:00，按 UTC 取会错成「不在」。
  assert.equal(ownerAway(Date.UTC(2026, 10, 17, 17), OWL), false);
});
