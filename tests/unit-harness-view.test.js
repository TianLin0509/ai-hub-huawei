'use strict';
// 本机 CLI 结论卡与启动中心徽标的画法（2026-11-20，renderer/harness-view.js）：五种结论、多候选、手动路径、借用 Node、反馈附带诊断。
const test = require('node:test'), assert = require('node:assert/strict');
const view = require('../renderer/harness-view');
const fake = require('./fixtures/harness-locate-fake');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('五种结论各有同事能懂的叫法、配色和徽标，界面上不出现内部代码名', () => {
  const r = fake.results();
  const cases = { claude: ['能用', 'ok', ''], codeagent: ['暂时不可用', 'warn', '暂时不可用'], codex: ['版本太低', 'warn', '版本太低'], kimi: ['跑不起来', 'bad', '跑不起来'], pi: ['没找到', 'bad', '未安装'] };
  for (const [id, [label, tone, badge]] of Object.entries(cases)) {
    const head = view.headHtml(r[id]);
    assert.match(head, new RegExp(`hx-verdict hx-${tone}">${label}<`), id);
    assert.equal(view.badge(r[id]).text, badge, id);
    assert.equal(view.badge(r[id]).title, r[id].reason, id);
    const all = head + view.reasonText(r[id]) + view.panelHtml(r[id], { checkedOpen: true });
    assert.doesNotMatch(all, /reasonCode|missing-tui|node-too-old|manual-path-failed|timeout|not-found|too-old/, id + ' 不出现代码名');
  }
  assert.deepEqual(view.badge(null), { text: '', tone: '', title: '' });
});

test('首行写清来源、版本、用哪份 Node；借用的 Node 原样写出', () => {
  const r = fake.results();
  assert.equal(text(view.headHtml(r.dsh)), '能用 DSH 桌面版自带命令 · v0.2.2');
  assert.equal(text(view.headHtml(r.kimi)), '跑不起来 npm 全局目录 · v1.4.0 · 用 Node 22.11.0（本机 PATH 上的 Node）');
  const ok = fake.pickOk('pi');
  assert.match(text(view.headHtml(ok)), /你手动指定的 · v0\.9\.3 · 用 Node 24\.12\.0（借用 CodeAgent 自带的 Node）/);
  // 没找到：只有结论，不编造来源。
  assert.equal(text(view.headHtml(r.pi)), '没找到');
});

test('暂时不可用时说明先沿用上次能用的版本', () => {
  assert.match(view.reasonText(fake.results().codeagent), /可能电脑正忙；先沿用上次能用的 v3\.1\.0$/);
});

test('多个候选：一句概括「找到 2 处，1 处能用」，列出各自结论，标出 Hub 将用哪一个', () => {
  const dsh = fake.results().dsh;
  assert.match(view.reasonText(dsh), /；找到 2 处，1 处能用$/);
  const html = view.panelHtml(dsh);
  const items = html.match(/<li class="hx-cand[^"]*">.*?<\/li>/g);
  assert.equal(items.length, 2);
  assert.match(items[0], /hx-chosen/); assert.match(items[0], /Hub 将用这个/); assert.match(items[0], /DSH Desktop/);
  assert.doesNotMatch(items[1], /Hub 将用这个/);
  assert.match(text(items[1]), /跑不起来 .*缺界面包 @dsh\/tui/);
  // 只有一个候选时不出概括。
  assert.equal(view.candidateSummary(fake.results().claude), '');
});

test('查过的位置默认折叠成「展开查过的 N 处」，展开后逐条列出结果', () => {
  const pi = fake.results().pi;
  const closed = view.panelHtml(pi);
  assert.match(closed, /展开查过的 6 处/); assert.doesNotMatch(closed, /hx-checked"/);
  const open = view.panelHtml(pi, { checkedOpen: true });
  const rows = open.match(/<li class="hx-r-[a-z]+">/g);
  assert.equal(rows.length, 6);
  assert.match(text(open), /没有 npm 全局目录 %APPDATA%\\npm/);
  assert.match(text(open), /跳过 Volta 没装 Volta/);
});

test('手动路径：行上已画出「选择文件」才不重复；「改回自动查找」每张卡都有，没手动路径时不可点；复制诊断每张卡都有', () => {
  const r = fake.results();
  const count = (html, act) => (html.match(new RegExp(`data-hx-act="${act}"`, 'g')) || []).length;
  assert.equal(count(view.panelHtml(r.pi, { rowActs: ['pi-install', 'harness-pick'] }), 'pick'), 0, 'pi 行上已有「选择文件」');
  assert.equal(count(view.panelHtml(r.pi), 'pick'), 1, '行上没画出来（如组件中心只画安装按钮）时结论卡里补上');
  assert.equal(count(view.panelHtml(r.claude), 'pick'), 1);
  assert.match(view.panelHtml(r.claude), /data-hx-act="clear"[^>]*disabled/);
  assert.doesNotMatch(view.panelHtml(r.codeagent), /data-hx-act="clear"[^>]*disabled/, 'CodeAgent 用的是手动指定的');
  for (const id of Object.keys(r)) { assert.equal(count(view.panelHtml(r[id]), 'copy'), 1, id); assert.equal(count(view.panelHtml(r[id]), 'clear'), 1, id); }
});

test('选完文件：成功写清用上了哪份；失败原样给原因并说明原设置没变', () => {
  const ok = view.pickMessage(fake.pickOk('pi'));
  assert.equal(ok.bad, false); assert.equal(ok.text, '已改用你选的文件（v0.9.3）：你选的 pi 试跑通过，以后就用它');
  const fail = view.pickMessage(fake.pickFail('pi'));
  assert.equal(fail.bad, true);
  assert.equal(fail.text, '没用上你选的文件：你选的 notepad.exe 不是 pi，试跑输出看不出版本号。原来的设置没有改动。');
  // 试跑结果是「能用」但不是手动那份（被悄悄换成别的）也按失败报。
  assert.equal(view.pickMessage({ ...fake.results().claude, reason: '试跑通过' }).bad, true);
});

test('路径和人话里的 HTML 特殊字符被转义', () => {
  const r = { ...fake.results().pi, id: 'pi', reason: '<b>x</b>', checked: [{ label: 'a&b', path: 'C:\\<x>', result: 'missing' }] };
  const html = view.panelHtml(r, { checkedOpen: true }) + view.headHtml(r);
  assert.doesNotMatch(html, /<b>x<\/b>|C:\\<x>/); assert.match(html, /a&amp;b/);
});

test('启动中心卡片到定位中心的对应：DeepSeek 卡是 DSH，Antigravity 卡是 antigravity', () => {
  assert.equal(view.KIND_TO_ID.deepseek, 'dsh'); assert.equal(view.KIND_TO_ID.gemini, 'antigravity'); assert.equal(view.KIND_TO_ID.pi, 'pi');
});

test('一键反馈附带诊断：接在描述后面，没有诊断时描述原样', () => {
  assert.equal(view.appendDiagnosis('打不开 DSH', ''), '打不开 DSH');
  assert.equal(view.appendDiagnosis('打不开 DSH\n', 'DSH：能用\n  查过 4 处'), `打不开 DSH\n\n${view.FEEDBACK_HEAD}\nDSH：能用\n  查过 4 处`);
});
