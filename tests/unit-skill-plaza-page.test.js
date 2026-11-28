'use strict';
// 技能广场界面的纯函数：卡片按钮随档位变、分类/来源/搜索筛选。
const test = require('node:test');
const assert = require('node:assert/strict');
const { cardAction, filterItems } = require('../renderer/skill-plaza-page');

test('卡片按钮随档位与来源变', () => {
  assert.deepEqual(cardAction({ use: 'ok', source: 'weclaw' }), { op: 'import', label: '导入', primary: true });
  assert.equal(cardAction({ use: 'fix', source: 'weclaw' }).op, 'detail');
  assert.equal(cardAction({ use: 'delegate', source: 'weclaw' }).op, 'delegate');
  assert.equal(cardAction({ use: 'installed', source: 'weclaw' }).op, 'remove');
  assert.equal(cardAction({ use: 'installed', source: 'local' }).op, 'manage');
});

test('分类、来源勾选、搜索三者叠加筛选', () => {
  const items = [
    { id: 1, source: 'weclaw', name: 'a-doc', displayName: '文档校对', description: '查错别字', category: 'office', use: 'ok' },
    { id: 2, source: 'weclaw', name: 'b-ppt', displayName: '汇报页', description: '排版', category: 'ppt', use: 'fix' },
    { id: 3, source: 'local', name: 'c-sim', displayName: '仿真', description: '提交作业', category: 'dev', use: 'installed' },
  ];
  assert.equal(filterItems(items).length, 3);
  assert.deepEqual(filterItems(items, { category: 'ppt' }).map(i => i.id), [2]);
  assert.deepEqual(filterItems(items, { category: 'mine' }).map(i => i.id), [3]);
  assert.deepEqual(filterItems(items, { sources: new Set(['local']) }).map(i => i.id), [3]);
  assert.deepEqual(filterItems(items, { query: '错别' }).map(i => i.id), [1]);
  assert.deepEqual(filterItems(items, { query: 'B-PPT' }).map(i => i.id), [2]);
  assert.deepEqual(filterItems(items, { category: 'office', query: '仿真' }), []);
});

test('来源状态行：没装、某一路失败、员工助手没技能，各给一行原因和重试', () => {
  const { sourceNotices } = require('../renderer/skill-plaza-page');
  assert.deepEqual(sourceNotices({ weclaw: { present: true, count: 3 }, local: { count: 2 }, agentcenter: { present: false, reason: 'x' } }), [], '都好、只是没装 CodeAgent：不打扰');
  const none = sourceNotices({ weclaw: { present: false } });
  assert.equal(none.length, 1);
  assert.equal(none[0].retry, '重新查找');
  const bad = sourceNotices({ weclaw: { present: true, error: '超时' }, local: { error: '没读完' }, agentcenter: { present: true, error: '坏了' } });
  assert.deepEqual(bad.map(b => [b.key, b.bad]), [['weclaw', true], ['local', true], ['agentcenter', true]]);
  assert.match(bad[0].text, /超时/);
  assert.equal(sourceNotices({ weclaw: { present: true, count: 0, reason: '登录一次' } })[0].bad, false);
});
