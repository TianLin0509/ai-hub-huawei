'use strict';
// 社区页（renderer/community-page.js，按确认过的 mock 布局）纯函数：领奖台与列表、等级榜右列、我的位置、收件机本机、各状态、隐私。
const test = require('node:test');
const assert = require('node:assert');
const { viewModel, pageHtml, entryValue, tokenText, petThumb, BOARDS } = require('../renderer/community-page');
const mock = require('./fixtures/community-board-mock');
const count = (html, re) => (html.match(re) || []).length;

test('正常状态：四格带同比、领奖台 3 人、列表 4–20 名、我的位置五项名次', () => {
  const vm = viewModel(mock.board(), 'level');
  const html = pageHtml(vm);
  assert.deepStrictEqual([vm.stats.online, vm.stats.activeNow, vm.stats.today, vm.stats.week], ['42', '17', '68', '115']);
  assert.match(html, /比上周同日<\/span> <b>\+12<\/b>/);
  assert.strictEqual(count(html, /class="pd p\d/g), 3);
  assert.strictEqual(vm.rows.length, 17);
  assert.strictEqual(vm.rows[0].rank, 4);
  assert.strictEqual(count(html, /<div data-cmy-board="/g), 5);
  assert.match(html, /共 69 人参与/);
  assert.ok(!html.includes('cmy-host'), '普通同事看不到趋势和版本');
});

test('等级榜：右列显示本周活力，不重复 Lv；其他榜显示各自数值', () => {
  const vm = viewModel(mock.board(), 'level');
  const first = vm.rows[0];
  assert.strictEqual(first.text, first.wxp.toLocaleString('en-US'));
  assert.ok(!first.text.startsWith('Lv.'));
  assert.strictEqual(vm.podium[0].big, 'Lv.' + vm.podium[0].lv, '领奖台大字仍是等级');
  assert.strictEqual(entryValue('wtok', { value: 6120000 }), '6.1M');
  assert.strictEqual(entryValue('streak', { value: 9 }), '9 天');
  assert.match(entryValue('ach', { value: 13 }), /^13 \/ \d+$/);
});

test('我不在前 20：列表末尾「· · ·」后接我的一行，带我的数值', () => {
  const data = mock.board();
  const board = Object.keys(data.me.ranks).find(b => data.me.ranks[b] > 20);
  assert.ok(board, 'mock 里至少一张榜我在 20 名外');
  const vm = viewModel(data, board);
  assert.ok(vm.meRow);
  assert.strictEqual(vm.meRow.rank, data.me.ranks[board]);
  assert.ok(vm.meRow.text, '我的数值不为空');
  const html = pageHtml(vm);
  assert.match(html, /cmy-gap/);
  assert.strictEqual(count(html, /class="cmy-row me"/g), 1);
});

test('等级超过了多少位同事 = 总人数 − 我的等级名次', () => {
  const data = mock.board();
  const vm = viewModel(data);
  assert.strictEqual(vm.beat, data.total - data.me.ranks.level);
  assert.match(pageHtml(vm), new RegExp(`等级超过了</span> <b>${vm.beat}</b>`));
});

test('收件机本机：30 天趋势、版本含「其他」、收件机状态与暂停按钮', () => {
  const html = pageHtml(viewModel(mock.hostBoard()));
  assert.match(html, /cmy-trend-svg/);
  assert.strictEqual(count(html, /仅收件机本机可见/g), 2);
  assert.strictEqual(count(html, /class="cmy-vbar"/g), 6);
  assert.match(html, /<span class="n">其他<\/span>/);
  assert.match(html, /今日收到心跳 61 次/);
  assert.match(html, /data-cmy="host-pause">暂停收集/);
});

test('人数不足、公司外、已关闭、取不到', () => {
  const few = pageHtml(viewModel(mock.STATES.few()));
  assert.match(few, /参与人数不足 5 人，暂不显示排行榜/);
  assert.ok(!few.includes('cmy-podium'));
  const out = pageHtml(viewModel(mock.STATES.outside()));
  assert.match(out, /社区仅在公司内网可用/);
  assert.ok(!out.includes('cmy-stats'));
  assert.match(pageHtml(viewModel({ state: 'error' })), /暂时没有数据/);
  assert.match(pageHtml(viewModel(mock.STATES.offline())), /暂时连不上社区/);
});

test('只有第 5 节契约字段时：不报错，缺的小字不显示', () => {
  const vm = viewModel(mock.STATES.bare(), 'level');
  const html = pageHtml(vm);
  assert.ok(!html.includes('比上周'));
  assert.ok(!html.includes('人参与'));
  assert.ok(!html.includes('等级超过了'));
  assert.strictEqual(vm.rows[0].text, '', '没有 wxp 时等级榜右列留空');
  assert.ok(!/undefined|NaN/.test(html));
});

test('昵称一律转义；页面不出现姓名、工号字段', () => {
  const data = mock.board();
  data.boards.level[0].nick = '<img src=x onerror=alert(1)>';
  const html = pageHtml(viewModel(data));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(!/工号：|部门：|姓名：/.test(html));
});

test('格式与桌宠映射', () => {
  assert.strictEqual(tokenText(350000), '350K');
  assert.strictEqual(tokenText(48000000), '48.0M');
  assert.strictEqual(BOARDS.length, 5);
  assert.strictEqual(petThumb('shiba'), 'assets/hub-pet/thumbs/07-shiba.webp');
  assert.strictEqual(petThumb('dragon'), '');
});

test('纯离线模式：社区页只剩一行锁定说明，不给数字、榜单，也没有重新加入按钮', () => {
  const html = pageHtml(viewModel(mock.STATES.disabled()));
  assert.match(html, /已开启纯离线模式，社区页不可用。可在 设置 › 高级 中关闭/);
  assert.ok(!/cmy-stats|cmy-podium|cmy-rows|cmy-nickpill|data-cmy=/.test(html));
  assert.ok(!/<button/.test(html), '锁定页不提供任何按钮');
  assert.ok(!/\d/.test(html.replace(/<[^>]+>/g, '').replace('AI HUB', '')), '锁定页不出现任何数字');
});

test('Beta：页标题带 Beta 标；隐私说明指向设置里的纯离线模式', () => {
  const html = pageHtml(viewModel(mock.board()));
  assert.match(html, /<h1>AI HUB 社区<span class="cmy-beta">Beta<\/span><\/h1>/);
  assert.match(html, /纯离线模式/);
  assert.ok(!html.includes('参与社区统计，可随时关闭'));
});

test('纯离线（开关关）时客户端零网络请求：不发心跳、不拉榜单、启动缓存也不触网', async () => {
  const { createCommunityClient } = require('../core/community/client');
  let calls = 0, enabled = true, resolves = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, boards: {} }), text: async () => '{}' }; };
  const client = createCommunityClient({ isEnabled: () => enabled, fetchImpl, timeoutMs: 50,
    receiverAddress: { resolve: async () => { resolves++; return { urls: ['http://10.0.0.1:1'] }; } }, buildPayload: () => ({ v: 1 }),
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} } });
  enabled = false; client.setEnabled(false);
  const r1 = await client.pulse();
  const r2 = await client.getBoard({ force: true });
  const r3 = await client.getBoard({ cachedOnly: true });
  const r4 = client.getOnline();
  assert.strictEqual(r1.state, 'disabled');
  assert.deepStrictEqual([r2.state, r3.state, r4.state], ['disabled', 'disabled', 'disabled']);
  assert.strictEqual(calls, 0, '纯离线时一次网络请求都不发');
  assert.strictEqual(resolves, 0, '纯离线时连收件地址都不去解析');
  assert.strictEqual(r2.boards.level.length, 0);
});

test('设置里的纯离线开关：在「高级」页、默认不勾；社区不在可选功能清单里', () => {
  const fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /<details class="config-privacy-fold" id="cfg-community-offline-field" hidden>/);
  assert.match(html, /<input type="checkbox" id="cfg-community-offline">/, '默认不勾＝参与社区');
  assert.match(html, /纯离线模式：不向社区同步状态（同时停用社区页）/);
  assert.match(fs.readFileSync(path.join(__dirname, '../renderer/config-settings-tabs.js'), 'utf8'), /'advanced', '[^']*#cfg-community-offline-field/);
  const { CATALOG } = require('../core/optional-features');
  assert.strictEqual(CATALOG.community.settingsOnly, true);
  assert.ok(!/out\.push\(\{ id: 'community'/.test(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')), '可选功能清单不再列出社区');
});
