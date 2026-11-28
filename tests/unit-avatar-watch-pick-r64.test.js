'use strict';
// R64（2026-11-28 群反馈「盯消息为啥先全选」「要盯的就是那几个重要的群」「群太多了」）：
// 「帮我盯消息」新建默认只盯选中的群和人（白名单），替本人先选几个最近 @过他、消息多的群；
// 已建的「全部会话」分身原样保留；范围页能一键改成只盯几个，群多时搜索 + 翻页，不出滚动条。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('../core/avatar/fleet-rules');
const { FleetService } = require('../core/avatar/fleet');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');

test('新建「帮我盯消息」默认只盯选中的群或人，目标动作是提醒', () => {
  assert.equal(F.TEMPLATES.watch.kind, 'pick');
  assert.equal(F.TEMPLATES.watch.action, 'remind');
  const av = F.newAvatar({ id: 'w', tpl: 'watch', now: 1 }, { targets: [{ id: 'g1', name: '项目群', type: 'group' }] });
  assert.equal(av.kind, 'pick');
  assert.deepEqual(av.targets, [{ id: 'g1', name: '项目群', type: 'group', action: 'remind' }]);
  // 只盯选中的：没选的群不归它。
  assert.equal(F.matchAvatar(av, { conv: 'g9', group: true, account: 'x' }), null);
  assert.equal(F.matchAvatar(av, { conv: 'g1', group: true, account: 'x' }).action, 'remind');
});

test('本人在向导里选「全部会话」时仍可建全部范围（和升级前一样）', () => {
  const av = F.newAvatar({ id: 'w', tpl: 'watch', now: 1 }, { kind: 'all', skip: [{ id: 'g2', name: '闲聊群', type: 'group' }] });
  assert.equal(av.kind, 'all');
  assert.equal(F.matchAvatar(av, { conv: 'g9', group: true, account: 'x' }).action, 'remind');
  assert.equal(F.matchAvatar(av, { conv: 'g2', group: true, account: 'x' }), null);
});

test('已建的「全部会话」分身升级后不变：改动只影响新建', () => {
  const old = { id: 'a1', tpl: 'watch', name: '帮我盯消息', enabled: true, kind: 'all', action: 'remind', atOnly: false, targets: [], only: [], skip: [], persona: '', notes: '', authorities: [], sources: [], prefix: 'x', backend: { account: 'auto', model: '' }, hideModel: true, createdAt: 1 };
  const next = F.applyPatch(old, { notes: '涉及排期的转给我' });
  assert.equal(next.kind, 'all');
  assert.deepEqual(next.targets, []);
});

test('默认起点：最近 @过本人的群优先，其次消息多的，再按最近顺序；只给 3 个群，去掉不看的、不选私聊', () => {
  const rows = [
    { id: 'g1', name: '闲聊', type: 'group', count: 30, atMe: 0 },
    { id: 'u1', name: '张三', type: 'user', count: 50, atMe: 5 },
    { id: 'g2', name: '项目', type: 'group', count: 3, atMe: 2 },
    { id: 'g3', name: '周报', type: 'group', count: 0, atMe: 0 },
    { id: 'g4', name: '答疑', type: 'group', count: 12, atMe: 1 },
    { id: 'g5', name: '通知', type: 'group', count: 40, atMe: 0 },
  ];
  assert.deepEqual(F.suggestTargets(rows).map(x => x.id), ['g2', 'g4', 'g5']);
  assert.deepEqual(F.suggestTargets(rows, { exclude: [{ id: 'g2' }] }).map(x => x.id), ['g4', 'g5', 'g1']);
  // 全都没有动静时按最近会话顺序给前几个，不至于一个都不选。
  assert.deepEqual(F.suggestTargets([{ id: 'a', type: 'group' }, { id: 'b', type: 'group' }]).map(x => x.id), ['a', 'b']);
  assert.deepEqual(F.suggestTargets([]), []);
  assert.deepEqual(F.suggestTargets(rows)[0], { id: 'g2', name: '项目', type: 'group' });
});

test('名单接口带上 @我 次数和建议的起点', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-r64-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snap = { at: 5, login: { ok: true, uid: 'a00000001' }, conversations: [{ id: 'g1', name: '闲聊', group: true }, { id: 'g2', name: '项目', group: true }, { id: 'u1', name: '张三' }],
    messages: { g1: [{ key: '1', text: 'a' }, { key: '2', text: 'b' }], g2: [{ key: '3', text: '@你 看下', atMe: true }, { key: '4', text: '我自己', atMe: true, mine: true }] } };
  const assistant = { settings: () => ({ myName: '测试员' }), welink: async () => ({ code: 0, stdout: '{}', stderr: '' }), snapshot: () => snap,
    auth: { status: () => ({ state: 'online', login: { ok: true } }) }, archive: { owner: () => 'a00000001', read: () => [], loadIndex: () => ({ names: {} }) } };
  const s = new FleetService({ dataDir: dir, getAssistant: () => assistant, noTimer: true, now: () => 10, pollMs: 1,
    listBackends: () => ({ rows: [] }), createSession: async () => ({}), getSession: () => null, closeSession: async () => {}, sendPrompt: async () => ({}), lastFinal: () => null });
  const r = s.targets();
  assert.equal(r.groups.find(g => g.id === 'g2').atMe, 1);
  assert.deepEqual(r.suggested.map(x => x.id), ['g2', 'g1']);
});

test('页面：向导默认「只盯选中的」并替本人先选、可切回全部；搜索只改列表不整页重画；范围页可一键改成只盯几个', () => {
  assert.match(src, /kind: tpl === 'watch' \? 'pick' : ''/);
  assert.match(src, /\['pick', '只盯选中的（推荐）'\], \['all', '全部会话'\]/);
  assert.match(src, /function seedWizard\(\)/);
  assert.match(src, /kind: wide \? 'all' : 'pick'/);
  assert.match(src, /data-pick-q=/);
  assert.match(src, /if \(t\.dataset\.pickQ && !event\.isComposing\) onPickQuery\(t\)/);
  assert.match(src, /addEventListener\('compositionend'/);
  assert.match(src, /data-av="kind" data-k="pick">改成只盯几个群/);
  assert.doesNotMatch(src, /'全部会话 · 只提醒'/);
  // 一屏：选群的卡片不再靠滚动条，改成翻页。
  assert.doesNotMatch(src, /avx-card scroll" data-sc="pk"/);
  assert.match(src, /const PICK_SIZE = \d+;/);
  // 页面去掉本人不看的之后还剩 3 个：主进程多给候选。
  assert.match(src, /filter\(x => !skip\.some\(y => y\.id === x\.id\)\)\.slice\(0, 3\)/);
});
