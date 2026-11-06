'use strict';
// 助理页 5.5.11 改版：卡片式对话里的纯函数——出处标签、旧格式查询范围剥离、PPT 入口过滤、「今天」栏折叠记忆。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const page = require('../renderer/company-assistant-page');

test('出处编号换成灰色小标签：文字用 sources 表，没有就写「出处」，点开走查看出处', () => {
  const labels = { 'msg:conv-1:k9': '周工 · 私聊 10:12' };
  const html = page.tagSources('<p>他在等你确认 [msg:conv-1:k9]，会议见 <code>[mtg:8f2a41c0]</code></p>', id => labels[id] || '出处');
  assert.match(html, /<button type="button" class="ca-src-tag" data-ca="source:msg:conv-1:k9" title="查看出处">周工 · 私聊 10:12<\/button>/);
  assert.match(html, /data-ca="source:mtg:8f2a41c0"[^>]*>出处<\/button>/);
  assert.ok(!html.includes('[msg:') && !html.includes('<code>'), 'bracket ids and their code wrapper are both replaced');
  // 一个方括号里多条出处，各自成一个标签；不是出处的方括号、markdown 链接原样保留。
  const many = page.tagSources('见 [cal:5d7e9a13, mail:AAMk&amp;x] 与 [备注] 和 [msg:a](https://x)', () => '出处');
  assert.equal((many.match(/class="ca-src-tag"/g) || []).length, 2);
  assert.match(many, /data-ca="source:mail:AAMk&amp;x"/, 'escaped ids are restored once, then escaped for the attribute');
  assert.match(many, /\[备注\]/); assert.match(many, /\[msg:a\]\(https:\/\/x\)/);
  assert.equal(page.tagSources('<a title="[msg:z]">x</a>'), '<a title="[msg:z]">x</a>', 'attribute values are untouched');
  const meeting = page.tagSources('<li>14:30 评审 [meeting:m-soon:r3f2a]</li>', id => ({ 'meeting:m-soon:r3f2a': 'SRS周期配置评审' })[id]);
  assert.match(meeting, /data-ca="source:meeting:m-soon:r3f2a"[^>]*>SRS周期配置评审<\/button>/, 'real meeting ids use the meeting: prefix');
  assert.deepEqual(page.sourceLabels([{ id: 'msg:1', label: 'A' }]), { 'msg:1': 'A' });
  assert.deepEqual(page.sourceLabels({ 'cal:2': 'B' }), { 'cal:2': 'B' });
});

test('旧格式回答：开头的「Hub 核实的查询范围」引用块剥成查询范围明细，正文不再带前缀', () => {
  const a = '> **Hub 核实的查询范围**\n> 覆盖：最近 24 小时；已查 14 个会话。\n>\n> 本次筛选已取到 38 条。\n\n周工在等你确认门限 `[msg:c:1]`\n\n> 草稿引用保留';
  const { body, coverage } = page.answerCoverage({ a });
  assert.equal(body, '周工在等你确认门限 `[msg:c:1]`\n\n> 草稿引用保留');
  assert.deepEqual(coverage, { ok: null, line: '查询范围', details: ['覆盖：最近 24 小时；已查 14 个会话。', '本次筛选已取到 38 条。'], legacy: true });
  // 结构化 coverage 优先；正文里残留的旧前缀同样剥掉。
  const fresh = page.answerCoverage({ a, coverage: { ok: false, line: '有 2 个群没取全', details: ['只取到 07:00 以后'] } });
  assert.equal(fresh.body.startsWith('周工'), true);
  assert.deepEqual(fresh.coverage, { ok: false, line: '有 2 个群没取全', details: ['只取到 07:00 以后'], legacy: false });
  assert.equal(page.answerCoverage({ a: '普通回答', coverage: { ok: true, line: '今天全天' } }).coverage.ok, true);
  assert.equal(page.answerCoverage({ a: '没有范围的回答' }).coverage, null);
  assert.deepEqual(page.answerCoverage({ a: '旧数据', queryCoverage: ['覆盖：今天'] }).coverage.details, ['覆盖：今天']);
  assert.equal(page.splitLegacyCoverage('> 普通引用\n正文'), null, 'only the Hub coverage header is stripped');
});

test('PPT 入口发起的问答不在助理页显示', () => {
  const chat = [{ id: 1, q: 'a' }, { id: 2, q: 'b', entry: 'ppt' }, { id: 3, q: 'c', via: 'phone' }, null];
  assert.deepEqual(page.visibleChat(chat).map(c => c.id), [1, 3]);
  assert.deepEqual(page.visibleChat(undefined), []);
});

test('「今天」栏折叠状态存 localStorage；没存过时窗口窄于 1100px 默认收起', () => {
  const store = new Map(), storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(page.todayFolded(storage, 1440), false);
  assert.equal(page.todayFolded(storage, 1099), true);
  page.saveTodayFolded(storage, true);
  assert.equal(store.get(page.TODAY_FOLD_KEY), '1');
  assert.equal(page.todayFolded(storage, 1440), true, 'an explicit fold survives a wide window');
  page.saveTodayFolded(storage, false);
  assert.equal(page.todayFolded(storage, 900), false, 'an explicit unfold survives a narrow window');
  const broken = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.equal(page.todayFolded(broken, 1000), true); assert.doesNotThrow(() => page.saveTodayFolded(broken, true));
});

test('改版删掉的旧入口不再出现在助理页（R1–R12），批注与常用删除保留', () => {
  const code = fs.readFileSync(path.join(__dirname, '../renderer/company-assistant-page.js'), 'utf8');
  for (const gone of ['toggle-brief', 'briefOpen', 'setup-mail', 'pptEntry', 'ppt-assist', "'starter'", 'STARTERS', 'nextBriefAt', 'coverageNote', 'capabilities()', "['ppt', 'PPT 素材库']", '存过的常用问题', 'data-chip=', '每 3 秒查一次群消息'])
    assert.ok(!code.includes(gone), 'removed: ' + gone);
  assert.match(code, /每 6 秒查一次群消息/);
  assert.match(code, /data-slot="brief-note"/, 'the brief note (助理批注) stays under the 今天 title');
  assert.match(code, /data-ca="del-chip:/);
  assert.match(code, /data-ca="ask-about:/); assert.match(code, /data-ca="done:/);
  assert.equal((code.match(/会话工具没接上/g) || []).length, 1, 'the tools warning appears in one place only');
});

test('今天栏的状态句：刷新中、分批更新、普通更新三种说法', () => {
  assert.equal(page.todayStatus({ refreshing: true }).up, '正在刷新数据…');
  assert.equal(page.todayStatus({ refreshedAt: 1 }, () => '15:20').up, '数据 15:20 更新');
  assert.equal(page.todayStatus({}).up, '还没取过数据');
  assert.equal(page.todayStatus({ brief: { organizing: true, sections: [{ items: [{}] }] } }).organizing, true);
  assert.equal(page.shortMeetingText('2026-11-06（周五）04:08 – 05:08（上海 UTC+08:00） 方案评审（占位） · 会议室A'), '04:08 – 05:08 方案评审（占位） · 会议室A');
  // 上海时间：UTC 2026-11-05 16:30 已是上海 11月6日 00:30，与电脑本地时区无关。
  const at = Date.UTC(2026, 10, 5, 16, 30);
  assert.equal(page.shanghaiClock(at), '00:30'); assert.equal(page.shanghaiDay(at), '2026-11-06');
  assert.equal(page.dayTitle('2026-11-05'), '11月5日 周四'); assert.equal(page.dayTitle(''), '');
  assert.equal(page.secondsText(12400), '12 秒'); assert.equal(page.secondsText(72000), '1 分 12 秒');
});
