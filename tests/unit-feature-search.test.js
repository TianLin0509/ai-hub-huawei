'use strict';
// 设置页搜索 + Ctrl+K 命令面板共用的功能索引（2026-11-20 体验 1、2）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { loadFeatureIndex, searchFeatures, initials, availability } = require(path.join(ROOT, 'renderer', 'feature-search.js'));
const GENERATOR = path.join(ROOT, 'tools', 'help-manual', 'build-help-manual.js');

const top = q => (searchFeatures(q)[0] || {});

test('群里找不到的几项，一搜第一条就是', () => {
  assert.equal(top('考勤').name, '考勤');
  assert.equal(top('考勤').kind, 'page');
  assert.equal(top('回车').name, '回车键');
  assert.equal(top('工作目录').name, '新建会话默认工作目录');
  assert.equal(top('OD').name, '考勤页');
  assert.equal(top('考勤 域名').name, '公司域名');
  assert.match(top('考勤 域名').where, /考勤 → 设置/);
  assert.equal(top('自动休眠').kind, 'menu');
});

test('纯字母按拼音首字母也能搜到', () => {
  assert.equal(initials('考勤'), 'kq');
  assert.equal(initials('回车键'), 'hcj');
  assert.equal(top('kq').name, '考勤');
  assert.equal(top('hcj').name, '回车键');
});

test('没命中返回空，多词要全部命中', () => {
  assert.deepEqual(searchFeatures(''), []);
  assert.deepEqual(searchFeatures('完全不存在的设置项xyz'), []);
  assert.ok(searchFeatures('考勤 回车').length === 0);
});

test('每条都带可执行的步骤，选择器在界面代码里确实存在', () => {
  const items = loadFeatureIndex();
  assert.ok(items.length >= 40, '索引条数太少：' + items.length);
  const src = ['renderer/index.html', ...fs.readdirSync(path.join(ROOT, 'renderer')).filter(f => f.endsWith('.js')).map(f => 'renderer/' + f), 'renderer/hub-pet/hub-settings.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  for (const item of items) {
    assert.ok(item.name && item.where && Array.isArray(item.steps) && item.steps.length, `条目不完整：${JSON.stringify(item)}`);
    for (const step of [...item.steps, ...(item.fallback || [])]) {
      const sel = step.click || (typeof step.highlight === 'string' ? step.highlight : step.highlight && step.highlight.selector);
      assert.ok(sel, `${item.name} 有空步骤`);
      for (const id of sel.match(/#[\w-]+/g) || []) assert.ok(src.includes(id.slice(1)), `${item.name}：界面代码里没有 ${id}`);
    }
    if (item.fallback) assert.ok(item.optional, `${item.name} 有可选功能兜底却没标 optional`);
  }
});

test('可选功能没开时改去「可选功能」，这个版本没有的入口不显示', () => {
  const item = top('考勤');
  const doc = btn => ({ querySelector: () => btn });
  const btn = { hidden: false, style: { display: '' } };
  const win = on => ({ __optionalFeatures: { get: () => ({ on }) } });
  assert.equal(availability(doc(btn), win(true), item), 'go');
  assert.equal(availability(doc(btn), win(false), item), 'go', '左侧按钮还在：去页面，页面自己有「开启」');
  assert.equal(availability(doc(null), win(false), item), 'enable', '左侧按钮收起了：去可选功能');
  const setting = top('考勤 域名');
  assert.equal(availability(doc(btn), win(false), setting), 'enable', '页面里的设置项：先去开功能');
  assert.equal(availability(doc(btn), win(true), setting), 'go');
  const noFallback = { name: 'x', where: '左侧导航', steps: [{ click: '#nope' }] };
  assert.equal(availability(doc(null), null, noFallback), null);
  assert.equal(availability(doc({ hidden: true, style: {} }), null, noFallback), null);
});

test('功能索引与界面代码同步（改了设置要重跑 tools/help-manual/build-help-manual.js）', { skip: !fs.existsSync(GENERATOR) && '公开版没有生成脚本' }, () => {
  const { buildFeatureIndex } = require(GENERATOR);
  const fresh = JSON.parse(JSON.stringify(buildFeatureIndex()));
  assert.deepEqual(loadFeatureIndex(), fresh);
});
