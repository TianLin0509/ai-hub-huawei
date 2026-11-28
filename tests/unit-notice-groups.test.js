'use strict';
// 相邻团队消息合并成组（来源 3dea7fba、bd8ba8a0）：摘要写条数、几方和最新一句结论；接入点在卡片挂载、原位更新、整列加载与「简洁」切换。
// 真实界面里的分组、展开、重画不跳由 tests/e2e-notice-group-cdp.js 在隔离实例里验证。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { summarize } = require('../renderer/notice-groups');

const card = (kind, from, line) => ({ dataset: { noticeKind: kind, noticeFrom: from, noticeLine: line } });

test('group summary states the count, how many senders and the latest one-line conclusion', () => {
  const mixed = [card('notice', 'm1 消息合并', '第一条'), card('notice', 'm2 重绘减负', '第二条'), card('notice', 'm1 消息合并', '📌 **第三条：截图已交**')];
  assert.deepEqual(summarize(mixed), { count: 3, label: '团队消息', senders: 'm1 消息合并×2、m2 重绘减负',
    text: '3 条团队消息（2 方） · 最新 m1 消息合并：第三条：截图已交' });
  // 只有一位发送方时写出名字；纯 Hub 发的不列发送方。
  assert.equal(summarize([card('notice', 'm1 实现', 'a'), card('notice', 'm1 实现', 'b')]).text, '2 条团队消息（m1 实现） · 最新：b');
  assert.equal(summarize([card('notice', 'Hub', '计划已批准'), card('notice', 'Hub', '名额已释放')]).text, '2 条团队消息 · 最新：名额已释放');
  // 组队开工 / 返工叫回和团队消息混在一起时统称团队消息，保留最新那条自带的前缀。
  assert.equal(summarize([card('notice', 'Hub', 'x'), card('kickoff', '负责人', '返工叫回：改审查意见')]).text, '2 条团队消息（2 方） · 最新 负责人：返工叫回：改审查意见');
});

test('grouper is wired into mount, live patch, full load and concise toggle; folded cards carry kind, sender and line', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const renderer = read('renderer/turn-card-renderer.js');
  assert.match(renderer, /data-notice-kind="\$\{escapeHtml\(teamFold\.kind\)\}" data-notice-from="\$\{escapeHtml\(who\)\}" data-notice-line=/);
  assert.match(renderer, /noticeGroups\.schedule\(container\);/, '新挂卡片重算');
  assert.match(renderer, /restore\(existing\);\s*\/\/[^\n]*\n\s*noticeGroups\.schedule\(existing\.parentElement\);/, '所有原位重绘路径（含 rerenderTurn）都重算');
  // 分组不能放进公开版裁剪段：公开版也带这个功能。
  // 成员版和公开版都要有分组；公开版生成时裁剪段已删掉，只在成员版里再查裁剪段内没有它。
  assert.match(renderer, /createNoticeGrouper/);
  const mark = name => '// @' + 'public-' + name; // 拆开写：公开版生成器会把整行标记当成残留
  const from = renderer.indexOf(mark('strip'));
  if (from >= 0) assert.doesNotMatch(renderer.slice(from, renderer.indexOf(mark('end'), from)), /createNoticeGrouper/);
  assert.match(read('renderer/renderer.js'), /window\._noticeGroups\?\.apply\(container\);\s*cardContentSkip\(\)\.sweep\(\);/, '整列加载先分组再量高度、恢复滚动');
  assert.match(read('renderer/concise-view.js'), /hub:concise-changed/);
  assert.match(read('renderer/card-follow-scroll.js'), /\.notice-group-bar'\)\) pause\(\)/);
  assert.match(read('renderer/message-disclosure-state.js'), /details\.team-notice-fold/, '单条团队消息的展开选择重画后保留');
  const css = read('renderer/styles/card-view.css');
  assert.match(css, /\.msg-overlay > \.turn-card\.notice-group-member:not\(\.notice-group-open\) \{ display: none; \}/);
});

test('no-update replies render one plain line instead of the raw marker', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/turn-card-renderer.js'), 'utf8');
  assert.match(renderer, /const emptyNative = noUpdate \? '无新进展' :/);
});
