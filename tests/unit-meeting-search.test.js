'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { searchMeetings, request, excerpt, safeText, atTime } = require('../core/company-assistant/meeting-search');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const { createMeetingHandlers } = require('../core/company-assistant/meeting-ipc');
const { HubTools } = require('../core/company-assistant/hub-tools');
const { allTools, toolsFor } = require('../core/company-assistant/mcp');
function meeting(fields = {}) {
  return { id: randomUUID(), title: 'L2 周会', startedAt: Date.parse('2026-11-24T09:00:00+08:00'), events: [], answers: [], summary: '', ...fields };
}
function store(rows) {
  return { list: () => rows.map(({ id, title, startedAt }) => ({ id, title, startedAt })), load: id => rows.find(m => m.id === id) };
}
test('空格多词AND、中文按子串、英文忽略大小写，去重复词', async () => {
  const m = meeting({ events: [{ kind: 'transcript', seq: 7, at: 75000, text: 'OLLA 步长由0.4改为0.3，切换次数增加' }] });
  const s = store([m]);
  const r = await searchMeetings(s, { query: 'olla 0.4 换 换' });
  assert.equal(r.total, 1); assert.equal(r.items[0].seq, 7); assert.equal(r.items[0].time, '01:15');
  assert.deepEqual(r.items[0].highlights.map(x => r.items[0].snippet.slice(x.start, x.end)), ['OLLA', '0.4', '换']);
  assert.equal((await searchMeetings(s, { query: '0.4 不存在' })).total, 0);
});
test('来源全覆盖，纪要>重点>问答>原话，独立命中标题', async () => {
  const m = meeting({ title: '只搜标题的会', summary: '## 决定\n- [D2] 关键结论123',
    events: [{ kind: 'transcript', seq: 1, at: 5000, text: '关键结论123' }, { kind: 'mark', seq: 2, at: 6000, text: '关键结论123' }],
    answers: [{ id: 'answer1', q: '关键问题', answer: '结论123', queuedAt: Date.parse('2026-11-24T09:00:07+08:00'), at: Date.parse('2026-11-24T09:00:12+08:00') }] });
  const r = await searchMeetings(store([m]), { query: '关键' });
  assert.deepEqual(r.items.map(x => x.sourceType), ['summary', 'mark', 'question', 'transcript']);
  assert.equal(r.items[0].itemId, 'D2'); assert.equal(r.items[1].seq, 2);
  assert.equal(r.items[2].time, '00:07');
  assert.equal((await searchMeetings(store([m]), { query: '标题' })).items[0].sourceType, 'title');
  assert.equal((await searchMeetings(store([m]), { query: '问题' })).items[0].sourceType, 'question');
});
test('日期按上海整天含末尾，支持ISO/毫秒、单场限定、无效范围就地报错', async () => {
  const a = meeting({ title: '测试', startedAt: Date.parse('2026-11-23T23:59:59+08:00') });
  const b = meeting({ title: '测试', startedAt: Date.parse('2026-11-24T23:59:59.999+08:00') });
  const c = meeting({ title: '测试', startedAt: Date.parse('2026-11-25T00:00:00+08:00') });
  const s = store([a, b, c]);
  assert.deepEqual((await searchMeetings(s, { query: '测试', from: '2026-11-24', to: '2026-11-24' })).items.map(x => x.meetingId), [b.id]);
  assert.equal((await searchMeetings(s, { query: '测试', from: b.startedAt, to: '2026-11-24T23:59:59.999+08:00' })).total, 1);
  assert.equal((await searchMeetings(s, { query: '测试', meetingId: c.id })).items[0].meetingId, c.id);
  assert.equal((await searchMeetings(s, { query: '测试', from: '2026-11-25', to: '2026-11-24' })).ok, false);
  assert.equal((await searchMeetings(s, { query: '测试', from: '2026-02-30' })).ok, false);
});
test('同来源按会议时间和事件时间倒序；分页总数稳定、默认20且无重复', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => meeting({ startedAt: 1000 + i, events: Array.from({ length: 12 }, (_, j) => ({ seq: j + 1, kind: 'transcript', text: '命中', at: j * 1000 })) }));
  const s = store(rows), first = await searchMeetings(s, { query: '命中' }), second = await searchMeetings(s, { query: '命中', offset: 20 });
  assert.equal(first.total, 36); assert.equal(first.items.length, 20); assert.equal(first.hasMore, true);
  assert.equal(first.items[0].meetingId, rows[2].id); assert.equal(first.items[0].seq, 12);
  assert.equal(second.items.length, 16); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(x => `${x.meetingId}:${x.seq}`)).size, 36);
  assert.equal((await searchMeetings(s, { query: '命中', offset: 50 })).items.length, 0);
});
test('片段有上下文、高亮相对片段、不拆表情，重叠关键词高亮合并', () => {
  const text = '前'.repeat(80) + '😀'.repeat(10) + '目标ABC' + '后'.repeat(100);
  const r = excerpt(text, ['目标', 'abc', 'bc']);
  assert.ok(Array.from(r.snippet).length <= 120); assert.ok(r.snippet.includes('😀'));
  assert.deepEqual(r.highlights.map(x => r.snippet.slice(x.start, x.end)), ['目标ABC']);
  assert.ok(!/[\ud800-\udbff]$/.test(r.snippet));
  const long = excerpt('前' + '词'.repeat(200), ['词'.repeat(200)]);
  assert.equal(Array.from(long.snippet).length, 120); assert.equal(long.highlights[0].end, 120);
});
test('返回值不含磁盘路径，调用者给任意meetingId也不越过列表读文件', async () => {
  const m = meeting({ title: '排查 C:\\Users\\alice\\config.json', events: [{ kind: 'transcript', seq: 1, text: '命中 文件 D:/Secret/token.txt 和 /home/private/auth.json 以及 \\\\server\\share\\password.txt' }] });
  const r = await searchMeetings(store([m]), { query: '命中' });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /Secret|alice|private|server|auth\.json|config\.json|password/);
  assert.match(text, /本地路径/);
  const calls = []; const s = { list: () => [], load: id => calls.push(id) };
  assert.equal((await searchMeetings(s, { query: 'x', meetingId: '../outside' })).ok, false);
  assert.equal((await searchMeetings(s, { query: 'x', meetingId: randomUUID() })).total, 0); assert.deepEqual(calls, []);
  assert.equal(safeText('正常 https://example.com/docs/a'), '正常 https://example.com/docs/a');
});
test('空查询不读存储，坏文件跳过；失败消息不泄露存储绝对路径', async () => {
  let calls = 0; const s = { list() { calls++; throw Error('C:\\Secret\\db.json'); } };
  assert.equal((await searchMeetings(s, { query: '   ' })).total, 0); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(await searchMeetings(s, { query: 'x' })), /Secret/);
  const bad = meeting(), good = meeting({ summary: '好的命中' });
  const broken = store([bad, good]), load = broken.load;
  broken.load = id => { if (id === bad.id) throw Error('bad JSON'); return load(id); };
  const r = await searchMeetings(broken, { query: '命中' }); assert.equal(r.skipped, 1); assert.equal(r.total, 1);
});
test('分片让出主线程、不改变输入或保存；有公开peek时优先用peek', async () => {
  const m = meeting({ events: Array.from({ length: 2000 }, (_, i) => ({ kind: 'transcript', seq: i + 1, text: '命中' })) });
  const before = JSON.stringify(m); let yielded = 0, loaded = 0;
  const s = { ...store([m]), peek: () => m, load() { loaded++; throw Error('不应load'); } };
  const r = await searchMeetings(s, { query: '命中', limit: 3 }, { sliceMs: 0, yieldTurn: async () => { yielded++; } });
  assert.equal(r.total, 2000); assert.equal(r.items.length, 3); assert.ok(yielded >= 2000); assert.equal(loaded, 0); assert.equal(JSON.stringify(m), before);
});
test('真实会议存储：保存后立即搜到新增纪要/转写，坏会议不拖垮；不启动采集或写搜索索引', async t => {
  const parent = path.join(__dirname, '..', 'artifacts'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, '20261124-search-unit-m2-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = { dir: root, workspace: root, changed() {} };
  const m = new MeetingCompanion(a, { powerSaveBlocker: false, meetingAsr: { close() {} } });
  const saved = meeting({ state: 'finished' });
  saved.answers.push({ id: randomUUID(), q: '谁负责核对', answer: '已保存回答：张工负责', queuedAt: saved.startedAt + 12000, at: saved.startedAt + 45000 }); m.save(saved);
  const qa = await searchMeetings(m, { query: '张工' }); assert.equal(qa.total, 1); assert.equal(qa.items[0].sourceType, 'question'); assert.equal(qa.items[0].time, '00:12');
  assert.equal((await searchMeetings(m, { query: '新增' })).total, 0);
  saved.summary = '- [A1] 新增行动项'; saved.events.push({ kind: 'transcript', seq: 1, text: '新增原话', at: 123000 }); m.save(saved);
  assert.equal((await searchMeetings(m, { query: '新增' })).total, 2);
  const badDir = path.join(m.root, randomUUID()); fs.mkdirSync(badDir); fs.writeFileSync(path.join(badDir, 'meeting.json'), '{bad');
  assert.equal((await searchMeetings(m, { query: '新增' })).total, 2);
  assert.equal(m.timer, undefined); assert.deepEqual(fs.readdirSync(m.dir(saved.id)).sort(), ['meeting.json', 'meeting.json.bak']);
});
test('IPC与只读助理工具共用检索，MCP可见且按原有身份/用途限制', async () => {
  const m = meeting({ summary: '- [D1] 本周结论' }), meetings = store([m]);
  const ipc = createMeetingHandlers({ meetings });
  const r = await ipc['meeting-search']({ query: '结论' }); assert.equal(r.total, 1);
  const a = { dir: __dirname, meetings, now: () => 1, changed() {}, state: () => ({ sessionId: 'legacy' }), toolsetFor: id => ({ desk: 'desk', ppt: 'ppt' })[id] };
  const tools = new HubTools(a);
  const result = await tools.invoke({ name: 'meeting_search', arguments: { query: '结论' }, callerSessionId: 'desk' });
  assert.deepEqual(result.items, r.items); assert.match(result.note, /meetingId.*seq/);
  await assert.rejects(tools.invoke({ name: 'meeting_search', arguments: { query: '结论' }, callerSessionId: 'stranger' }), /只有公司助理/);
  await assert.rejects(tools.invoke({ name: 'meeting_search', arguments: { query: '结论' }, callerSessionId: 'ppt' }), /没有挂/);
  assert.ok(toolsFor('desk').some(t => t.name === 'meeting_search')); assert.ok(toolsFor('phone').some(t => t.name === 'meeting_search'));
  assert.ok(!toolsFor('brief').some(t => t.name === 'meeting_search'));
  assert.equal(allTools.find(t => t.name === 'meeting_search').annotations.readOnlyHint, true);
});
test('参数上限与非文字查询，不让大分页撑爆候选堆', () => {
  assert.equal(request({ query: '字', offset: 999999, limit: 999 }).offset, 10000);
  assert.equal(request({ query: '字', limit: 999 }).limit, 100);
  assert.throws(() => request({ query: 'a'.repeat(257) }), /256/);
  assert.throws(() => request({ query: 123 }), /文字/);
});
test('纪要有事件锚时定位原话时间，没有锚不伪造00:00；来源权重优先于新旧', async () => {
  const old = meeting({ startedAt: 1000, summary: '- [D1] 命中结论 [事件 2]', events: [{ kind: 'slide', seq: 1, at: 0 }, { kind: 'transcript', seq: 2, at: 123000, text: '命中原话' }] });
  const newer = meeting({ startedAt: 2000, events: [{ kind: 'transcript', seq: 1, at: 0, text: '命中更新原话' }] });
  const r = await searchMeetings(store([newer, old]), { query: '命中' });
  assert.equal(r.items[0].sourceType, 'summary'); assert.equal(r.items[0].seq, 2); assert.equal(r.items[0].time, '02:03');
  assert.equal(r.items[1].meetingId, newer.id);
  old.summary = '- [D1] 命中没有时间';
  const noAnchor = await searchMeetings(store([old]), { query: '没有时间' }); assert.equal(noAnchor.items[0].time, null);
  assert.doesNotMatch(safeText('路径 /tmp 以及 C:\\'), /\/tmp|C:/);
});
test('changeMark投影缓存复用且保存/删除立即失效；只存文字，不改peek正本', async () => {
  const m = meeting({ summary: '- [D1] 原结论' }), rows = [m]; let version = 1, reads = 0;
  const s = { ...store(rows), listIds: () => rows.map(x => x.id), changeMark: () => String(version), peek: () => { reads++; return m; } };
  assert.equal((await searchMeetings(s, { query: '原结论' })).total, 1);
  assert.equal((await searchMeetings(s, { query: '原结论' })).total, 1); assert.equal(reads, 1);
  m.summary = '- [D1] 新结论'; version++;
  assert.equal((await searchMeetings(s, { query: '新结论' })).total, 1); assert.equal(reads, 2);
  assert.equal((await searchMeetings(s, { query: '原结论' })).total, 0);
  rows.length = 0; assert.equal((await searchMeetings(s, { query: '新结论' })).total, 0);
  rows.push(m); await searchMeetings(s, { query: '新结论' }); assert.equal(reads, 3);
});
test('投影构建中保存不把旧内容绑定到新版本，后续查询会重读', async () => {
  const m = meeting({ summary: '- [D1] 原结论' }); let version = 'v1', reads = 0, turns = 0;
  const s = { ...store([m]), changeMark: () => version, peek: () => { reads++; return m; } };
  await searchMeetings(s, { query: '原结论' }, { sliceMs: 0, yieldTurn: async () => { if (++turns === 3) { version = 'v2'; m.summary = '- [D1] 新结论'; } } });
  assert.equal((await searchMeetings(s, { query: '新结论' })).total, 1); assert.equal(reads, 2);
});
test('投影缓存最多64场，淘汰后仍完整重读，不截掉搜索范围', async () => {
  const rows = Array.from({ length: 65 }, () => meeting({ summary: '命中' })); let reads = 0;
  const s = { ...store(rows), changeMark: () => 'fixed', peek: id => { reads++; return rows.find(m => m.id === id); } };
  for (const m of rows) await searchMeetings(s, { query: '命中', meetingId: m.id });
  assert.equal(reads, 65);
  assert.equal((await searchMeetings(s, { query: '命中', meetingId: rows[0].id })).total, 1); assert.equal(reads, 66);
});
test('旧纪要混合编号和普通段落时均可检索，不丢未编号补充', async () => {
  const m = meeting({ summary: '## 决定\n- [D1] 采用门限0.4\n补充：张工负责核对32个用户' });
  const s = store([m]); assert.equal((await searchMeetings(s, { query: '门限' })).items[0].itemId, 'D1');
  assert.equal((await searchMeetings(s, { query: '张工 32' })).items[0].itemId, 'paragraph-1');
});
test('m4回归：斜杠词和URL保留，file URI/盘符/UNC/Unix路径脱敏', async () => {
  const text = 'A/B 支持上行/下行调度，王工/李工负责吞吐/时延权衡，纪要/重点/原话/问答';
  assert.equal(safeText(text), text);
  const s = store([meeting({ events: [{ kind: 'transcript', seq: 1, at: 0, text }] })]);
  for (const query of ['A/B', '下行', '李工', '吞吐/时延', '问答']) assert.equal((await searchMeetings(s, { query })).total, 1, query);
  const paths = ['file:///home/alice/secret.txt', 'FILE:///C:/Users/alice/auth.json', '/home/alice/key', '/Users/alice/auth', '/tmp/token', '/etc/passwd', '/custom-project/conf/key', 'C:\\Program Files\\MyApp\\secret.key', '"C:\\Project Notes\\file with spaces.txt"', '\\\\server\\share\\secret.txt'];
  for (const p of paths) assert.equal(safeText('文件 ' + p + '。结束'), '文件 〔本地路径〕。结束', p);
  assert.equal(safeText('正常 https://example.com/docs/a'), '正常 https://example.com/docs/a');
});
test('m4回归：偏后81到120码点的长词完整可见，保留非空高亮和表情边界', () => {
  for (const length of [81, 95, 120]) {
    const term = '词'.repeat(length), r = excerpt('前'.repeat(50) + term + '后'.repeat(70), [term]);
    assert.ok(r.snippet.includes(term), '完整保留' + length + '字词');
    assert.ok(Array.from(r.snippet).length <= 120);
    assert.equal(r.snippet.slice(r.highlights[0].start, r.highlights[0].end), term);
  }
  const term = '😀'.repeat(95), r = excerpt('甲😀'.repeat(25) + term + '后'.repeat(40), [term]);
  assert.ok(r.snippet.includes(term)); assert.ok(Array.from(r.snippet).length <= 120);
});
test('m4回归：缺会议开始时间不产生NaN偏移、Infinity或伪造00:00', async () => {
  const m = meeting({ startedAt: undefined, answers: [{ id: 'q1', q: '时间缺失', answer: '仍保留答案', queuedAt: 1795482000000 }] });
  const r = await searchMeetings(store([m]), { query: '保留答案' });
  assert.equal(r.total, 1); assert.equal(r.items[0].at, null); assert.equal(r.items[0].time, null);
  assert.equal(atTime(NaN), null); assert.equal(atTime(Infinity), null);
  assert.equal(request({ query: 'x', limit: '' }).limit, 20);
  assert.equal((await searchMeetings(store([m]), { query: 'x', from: '2026-02-30T10:00:00' })).ok, false);
});
test('m4回归：删除窗口不读不返回；扫描途中旧命中进入删除时能补齐页面及总数', async () => {
  const a = meeting({ summary: '命中决定' }), b = meeting({ summary: '命中另一条', startedAt: a.startedAt - 1000 });
  const removing = new Set([a.id]), base = store([a, b]), reads = [];
  const s = { ...base, removing, listIds: () => [a.id, b.id], load: id => { reads.push(id); return base.load(id); } };
  const initial = await searchMeetings(s, { query: '命中', limit: 1 });
  assert.equal(initial.total, 1); assert.equal(initial.items[0].meetingId, b.id); assert.ok(!reads.includes(a.id));
  removing.clear(); reads.length = 0;
  s.load = id => { if (id === b.id) removing.add(a.id); return base.load(id); };
  const mid = await searchMeetings(s, { query: '命中', limit: 1 });
  assert.equal(mid.total, 1); assert.equal(mid.items[0].meetingId, b.id); assert.equal(mid.hasMore, false);
});
test('m4顺手项：助理meeting_search空arguments不抛TypeError', async () => {
  const a = { dir: __dirname, meetings: store([]), now: () => 1, changed() {}, state: () => ({ sessionId: 'legacy' }), toolsetFor: () => 'desk' };
  const result = await new HubTools(a).invoke({ name: 'meeting_search', arguments: null, callerSessionId: 'desk' });
  assert.equal(result.ok, true); assert.equal(result.total, 0);
});
