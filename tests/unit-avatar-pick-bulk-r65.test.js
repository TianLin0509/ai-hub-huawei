'use strict';
// R65（2026-11-28 群反馈「不想让它看的群太多，能否切成想让它看的群，或者加全选 / 取消全选」）：
// 选群名单加全选 / 取消全选 / 反选（作用于当前搜索结果、含没翻到的页）；「帮我起草回复」也能切「全部，排除几个 / 只看选中的群」；
// 只看选中的模式不带排除名单，范围页选中时把它从「不看」里拿掉（排除优先于选中，否则选了也不生效）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../core/avatar/fleet-rules');
const { bulkPick } = require('../renderer/avatar-page');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
const rows = [{ id: 'g1', name: '项目群', type: 'group' }, { id: 'g2', name: '周报群', type: 'group' }, { id: 'g3', name: '闲聊群', type: 'group' }];

test('全选：把名单里的都选上，名单外已选的保持不动，不重复', () => {
  const out = bulkPick([{ id: 'u9', name: '张三', type: 'user', action: 'draft' }, { id: 'g1', name: '项目群', type: 'group', action: 'remind' }], rows, 'all');
  assert.deepEqual(out.map(x => x.id), ['u9', 'g1', 'g2', 'g3']);
  // 原来选中的保留原有动作。
  assert.equal(out.find(x => x.id === 'g1').action, 'remind');
});

test('取消全选：只取消名单里的（如当前搜索结果），名单外的保留', () => {
  assert.deepEqual(bulkPick([{ id: 'g1' }, { id: 'g2' }, { id: 'u9' }], rows.slice(0, 2), 'none').map(x => x.id), ['u9']);
});

test('反选：名单里选中的取消、没选的选上', () => {
  assert.deepEqual(bulkPick([{ id: 'g1' }], rows, 'invert').map(x => x.id), ['g2', 'g3']);
  assert.deepEqual(bulkPick([], [], 'invert'), []);
});

test('两种模式的过滤语义：只看选中的，新进的群默认不看；全部排除几个，新进的群默认会看', () => {
  const pick = F.newAvatar({ id: 'd1', tpl: 'draft', now: 1 }, { kind: 'pick', targets: [{ id: 'g1', name: '项目群', type: 'group' }], skip: [] });
  assert.equal(pick.kind, 'pick');
  assert.equal(pick.atOnly, true);
  assert.ok(F.matchAvatar(pick, { conv: 'g1', group: true, atMe: true, account: 'x' }));
  assert.equal(F.matchAvatar(pick, { conv: 'g1', group: true, atMe: false, account: 'x' }), null, '起草模板选中的群里仍只处理 @我');
  assert.equal(F.matchAvatar(pick, { conv: 'gNew', group: true, atMe: true, account: 'x' }), null, '新进的群默认不看');
  const wide = F.newAvatar({ id: 'd2', tpl: 'draft', now: 1 }, { kind: 'all', targets: [], skip: [{ id: 'g3', name: '闲聊群', type: 'group' }] });
  assert.ok(F.matchAvatar(wide, { conv: 'gNew', group: true, atMe: true, account: 'x' }), '新进的群默认会看');
  assert.equal(F.matchAvatar(wide, { conv: 'g3', group: true, atMe: true, account: 'x' }), null);
});

test('已建分身的旧配置不用迁移：老的全部 + 排除名单原样生效', () => {
  const old = { id: 'a1', tpl: 'draft', name: '帮我起草回复', enabled: true, kind: 'all', action: 'draft', atOnly: true, targets: [], only: [], skip: [{ id: 'g3', name: '闲聊群', type: 'group' }] };
  const next = F.applyPatch(old, { notes: 'x' });
  assert.equal(next.kind, 'all');
  assert.deepEqual(next.skip.map(x => x.id), ['g3']);
  assert.equal(F.matchAvatar(next, { conv: 'g3', group: true, atMe: true, account: 'x' }), null);
});

test('页面：批量按钮、起草模板两种模式、已选数量；只看选中的模式不带排除名单；范围页选中时从不看里拿掉', () => {
  assert.match(src, /data-av="pick-bulk" data-key="\$\{key\}" data-m="\$\{m\}"/);
  assert.match(src, /\['all', q \? '全选搜到的' : '全选'\], \['none', q \? '取消搜到的' : '取消全选'\], \['invert', '反选'\]/);
  assert.match(src, /\['all', '全部，排除几个'\], \['pick', '只看选中的群'\]/);
  assert.match(src, /已排除 \$\{wiz\.skip\.length\} 个/);
  assert.match(src, /skip: dual && !wide \? \[\] : w\.skip/);
  assert.match(src, /skip: av\.skip\.filter\(y => y\.id !== x\.id\)/);
  assert.match(src, /if \(op === 'pick-bulk'\) \{ await pickBulk\(b\.dataset\.key, b\.dataset\.m\); return; \}/);
});

test('Antigravity 审查 P1：全选上百个群不被截断；P2：只盯选中时同一个群两边都在以选中为准，全部模式不受影响', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: 'g' + i, name: '群' + i, type: 'group' }));
  const base = F.newAvatar({ id: 'x', tpl: 'draft', now: 1 }, {});
  assert.equal(F.applyPatch(base, { kind: 'pick', targets: many }).targets.length, 120);
  assert.equal(F.applyPatch(base, { skip: many }).skip.length, 120);
  const pick = F.applyPatch(base, { kind: 'pick', targets: [many[1]], skip: [many[1], many[2]] });
  assert.deepEqual(pick.skip.map(x => x.id), ['g2']);
  assert.ok(F.matchAvatar(pick, { conv: 'g1', group: true, atMe: true, account: 'a' }));
  const wide = F.applyPatch({ ...base, kind: 'all', targets: [many[1]] }, { skip: [many[1]] });
  assert.deepEqual(wide.skip.map(x => x.id), ['g1'], '全部模式下排除名单原样保留');
});

test('页面：范围页「全部」模式也能搜索、批量改不看的群；长名单只列前几个', () => {
  assert.match(src, /picker\('scope-skip', groups, a\.skip \|\| \[\], 'scope-skip', '搜索群名'\)/);
  assert.match(src, /if \(key === 'scope-skip'\)/);
  assert.match(src, /const namesBrief = /);
});
