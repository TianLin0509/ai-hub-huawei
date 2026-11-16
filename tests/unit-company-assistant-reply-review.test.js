'use strict';
// 规则分 strong 该回 / weak 可能要回 / settled 像是已说完 三档，条目一律不删、已说完的排到栏末；
// 公司助理 CodeAgent 工作日 9/13/19 点复核（reply/maybe/no），结论只对「锚」有效；简报「等你回复」一键全部处理了、可撤销。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RJ = require('../core/reply-judge');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const R = require('../core/company-assistant/reminders');
const G = require('../core/company-assistant/digest');
const RR = require('../core/company-assistant/reply-review');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');

const NOW = Date.parse('2026-11-16T10:00:00+08:00');
const H = 3600000;
const talk = (lines, lastAgoH = 2) => lines.map(([who, text], i) => ({ mine: who === '我', kind: text ? 'text' : 'other', text, at: NOW - lastAgoH * H - (lines.length - 1 - i) * 60000 }));
const judge = (lines, h) => RJ.judgeDirect(talk(lines, h));

test('WeLink 已核对的文本表情编码与 Unicode 点赞识别为收尾', () => {
  for (const text of ['\u2060/CY', '\u2060/ZB', '\u2060/OK', '\u2060/GO\u2060/GO', '\u2060[强]', '👍']) {
    assert.equal(RJ.isAck({ kind: 'text', text }), true, JSON.stringify(text));
    assert.equal(judge([['他', text]]).closed, 'ack');
  }
  assert.equal(RJ.isAck({ kind: 'text', text: '明天请确认\u2060/OK' }), false);
});

test('群里紧接点名消息的本人纯表情回应停止提醒，闲聊及后来的新问题仍提醒', () => {
  for (const emoji of ['👍', '[强]', '\u2060/OK']) {
    const s = snap([['g', true, [['甲', '请确认材料', 300, { atMe: true }], ['我', emoji, 290]]]]);
    const settings = { waitHours: 1, workdays: [0, 1, 2, 3, 4, 5, 6], replyReview: { items: { g: { lastKey: 'k1', verdict: 'reply' } } } };
    assert.equal(D.awaiting(s, settings, { now: NOW })[0].level, 'settled', emoji);
    assert.equal(R.dueNotices({ snapshot: s, settings, now: NOW }).some(n => n.kind === 'awaiting-reply'), false);
    s.messages.g.push({ ...s.messages.g[0], key: 'k2', sourceId: 'msg:g:k2', at: NOW - 120 * 60000 });
    const later = D.awaiting(s, settings, { now: NOW });
    assert.equal(later.find(m => m.key === 'k2').level, 'strong', '后来的新问题恢复提醒');
  }
  for (const text of ['无关的进展', '稍后确认👍', '？', '👍？', '[强]？', '\u2060/OK?']) {
    const s = snap([['g', true, [['甲', '请确认材料', 300, { atMe: true }], ['我', text, 290]]]]);
    assert.equal(D.awaiting(s, {}, { now: NOW })[0].level, 'strong', text);
  }
  const unrelated = snap([['g', true, [['甲', '请确认材料', 300, { atMe: true }], ['乙', '我分享个消息', 299], ['我', '👍', 290]]]]);
  assert.equal(D.awaiting(unrelated, {}, { now: NOW })[0].level, 'strong', '回应别人的消息不能结案');
});

test('规则：收尾话、只回答了我的问题、群发通知识别为已说完', () => {
  assert.equal(judge([['我', '材料发你了'], ['他', '好的 收到']]).closed, 'ack');
  assert.equal(judge([['我', '方案改好了'], ['他', '辛苦了[强]']]).closed, 'ack');
  assert.equal(judge([['我', '周会几点开？'], ['他', '下午三点']]).closed, 'answered');
  assert.equal(judge([['他', '【温馨提示】本周五 18:00 起办公区网络维护，活动时间另行通知，请提前报名团购']]).closed, 'notice');
});

test('群里附件、状态与未知方括号标签不能冒充本人表情回复', () => {
  for (const text of ['[图片]', '[文件]', '[链接]', '[语音]', '[位置]', '[已处理]', '[已完成]', '[新标签]', '[图片]👍', '[微笑][文件]']) {
    const s = snap([['g', true, [['甲', '请确认材料', 300, { atMe: true }], ['我', text, 290]]]]);
    assert.equal(D.awaiting(s, {}, { now: NOW })[0].level, 'strong', text);
  }
  for (const text of ['[微笑]', '[强][鼓掌]', '\u2060[强]', '[微笑]👍']) {
    const s = snap([['g', true, [['甲', '请确认材料', 300, { atMe: true }], ['我', text, 290]]]]);
    assert.equal(D.awaiting(s, {}, { now: NOW })[0].level, 'settled', text);
  }
});

test('规则：提问、请求、「请……」祈使句算该回；陈述算可能要回', () => {
  for (const s of ['评审材料能先帮我看一下吗？', '请核对材料', '方案已上传，请审核', '麻烦看下这个接口', '明天几点对齐', '这个需不需要上会']) {
    assert.equal(judge([['他', s]]).level, 'strong', s);
  }
  assert.equal(judge([['他', '下午的对齐会挪到 4 点了']]).level, 'weak');
  assert.equal(judge([['他', '不知道啥时候能定下来']]).level, 'weak');
});

function snap(convs) {
  const conversations = [], messages = {};
  for (const [id, group, rows] of convs) {
    conversations.push({ id, name: id, group });
    messages[id] = rows.map(([who, text, agoMin, extra = {}], i) => ({ sourceId: `msg:${id}:k${i}`, conv: id, convName: id, group, key: `k${i}`, at: NOW - agoMin * 60000,
      sender: who === '我' ? '我' : who, account: who, mine: who === '我', atMe: false, atAll: false, text, preview: text, ...extra }));
  }
  return { day: D.dayKey(NOW), at: NOW, login: { ok: true, uid: 'me' }, meetings: [], calendar: [], mails: [], conversations, messages };
}

test('等你回复（公司版）：不删条目，分三档；已说完的排到最后；超过 24 小时的陈述算已说完', () => {
  const s = snap([
    ['ask', false, [['甲', '材料能帮我看一下吗', 120]]],
    ['ack', false, [['我', '发你了', 200], ['乙', '好的', 190]]],
    ['info', false, [['丙', '下午会挪到 4 点了', 90]]],
    ['old', false, [['丁', '我先回去了', 30 * 60]]],
    ['g', true, [['戊', '@我 周报请今天更新', 100, { atMe: true }], ['我', '收到', 10]]],
  ]);
  const got = D.awaiting(s, {}, { now: NOW });
  assert.deepEqual(got.map(m => [m.conv, m.level]), [['ask', 'strong'], ['g', 'strong'], ['info', 'weak'], ['old', 'settled'], ['ack', 'settled']]);
  const brief = B.fallbackBrief(s, { day: D.dayKey(NOW), now: NOW, settings: {} });
  const items = brief.sections.find(x => x.key === 'awaiting').items;
  assert.equal(items.length, 5, '一条不少');
  assert.deepEqual(items.slice(-2).map(i => i.settledLabel), ['像是已说完', '像是已说完'], '已说完的排在最后');
  assert.ok(items.find(i => i.source === 'msg:info:k0').maybe);
});

test('AI 复核：no → 排到最后并标「AI：不用回」；reply/maybe 定档带理由；锚变了就失效（群里别人闲聊不算）', () => {
  const s = snap([
    ['ask', false, [['甲', '材料能帮我看一下吗', 120]]],
    ['ack', false, [['我', '发你了', 200], ['乙', '好的', 190]]],
    ['g', true, [['戊', '@我 周报请今天更新', 100, { atMe: true }], ['己', '闲聊', 20]]],
  ]);
  const review = { items: {
    ask: { lastKey: 'k0', verdict: 'no', reason: '电话里说过' },
    ack: { lastKey: 'k1', verdict: 'reply', reason: '确认方案细节' },
    g: { lastKey: 'k0', verdict: 'maybe', reason: '回个收到' },
  } };
  const got = D.awaiting(s, { replyReview: review }, { now: NOW });
  assert.deepEqual(got.map(m => [m.conv, m.level, m.aiReason]), [['ack', 'strong', '确认方案细节'], ['g', 'weak', '回个收到'], ['ask', 'settled', '电话里说过']]);
  const items = B.fallbackBrief(s, { day: D.dayKey(NOW), now: NOW, settings: { replyReview: review } }).sections.find(x => x.key === 'awaiting').items;
  assert.equal(items[items.length - 1].settledLabel, 'AI：不用回');
  assert.match(items.find(i => i.source === 'msg:ack:k1').text, /AI：确认方案细节/);
  s.messages.g.push({ ...s.messages.g[1], key: 'k2', sourceId: 'msg:g:k2', at: NOW - 5 * 60000 });
  assert.equal(D.awaiting(s, { replyReview: review }, { now: NOW }).find(m => m.conv === 'g').aiReason, '回个收到', '别人闲聊不让结论失效');
  s.messages.ask.push({ ...s.messages.ask[0], key: 'k1', sourceId: 'msg:ask:k1', text: '在吗', at: NOW - 60 * 60000 });
  assert.ok(!D.awaiting(s, { replyReview: review }, { now: NOW }).find(m => m.conv === 'ask').aiReason, '对方又说话 → 退回规则');
});

test('提醒、定时汇总、下班小结：像是已说完 / AI 判不用回的不推送不计数；可能要回照常（公司版口径）', () => {
  const s = snap([['ask', false, [['甲', '材料能帮我看一下吗', 300]]], ['info', false, [['丙', '下午会挪到 4 点了', 300]]], ['ack', false, [['我', '发你了', 400], ['乙', '好的', 300]]]]);
  const settings = { waitHours: 4, workdays: [0, 1, 2, 3, 4, 5, 6], summaryTime: '09:00' };
  const notices = R.dueNotices({ snapshot: s, settings, now: NOW });
  assert.deepEqual(notices.filter(n => n.kind === 'awaiting-reply').map(n => n.id).sort(), ['await:ask:k0', 'await:info:k0']);
  assert.match(notices.find(n => n.kind === 'day-summary').text, /还有 2 条/);
  assert.deepEqual(G.digestItems(s, { settings, now: NOW }).filter(i => i.kind === 'private').map(i => i.source).sort(), ['msg:ask:k0', 'msg:info:k0']);
});

test('复核时段与解析', () => {
  assert.equal(RR.slotOf(Date.parse('2026-11-16T08:59:00+08:00')), '');
  assert.equal(RR.slotOf(Date.parse('2026-11-16T13:00:00+08:00')), '2026-11-16@780');
  assert.equal(RR.nextSlotAt(Date.parse('2026-11-16T19:30:00+08:00')), Date.parse('2026-11-17T09:00:00+08:00'));
  const cands = [{ c: 'c1', conv: 'a', lastKey: 'k1' }];
  assert.deepEqual(RR.parse('```json\n{"items":[{"c":"c1","verdict":"maybe","reason":"可回"},{"c":"c2","verdict":"no"}]}\n```', cands), { a: { lastKey: 'k1', verdict: 'maybe', reason: '可回' } });
  assert.equal(RR.parse('做不了', cands), null);
});

test('服务：复核任务进简报通道、提问含候选；收尾存结论并重算简报；全部处理了可撤销；同一时段只排一次', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-rr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, now: () => NOW, bus: new NoticeBus({ now: () => NOW }), getSession: () => null, resolveCli: () => null });
  a.cli = () => null; a.pump = async () => {};
  t.after(() => a.digest.close());
  const s = snap([['ask', false, [['甲', '材料能帮我看一下吗', 120]]], ['info', false, [['丙', '下午会挪到 4 点了', 90]]]]);
  a.write('raw-' + D.dayKey(NOW) + '.json', s);
  a.write('brief-' + D.dayKey(NOW) + '.json', B.fallbackBrief(s, { day: D.dayKey(NOW), now: NOW, settings: {} }));
  assert.equal(a.maybeReviewReplies(NOW), true);
  assert.equal(a.maybeReviewReplies(NOW), false);
  const job = a.lanes.brief.queue.find(j => j.type === 'reply-review');
  assert.ok(job, '排进简报通道');
  assert.match(job.prompt, /## c\d｜私聊「info」[\s\S]*下午会挪到 4 点了/);
  assert.equal(a.status().replyReview.running, true);
  const c = Object.fromEntries(job.candidates.map(x => [x.conv, x.c]));
  a.lanes.brief.queue = [];
  a.finishReplyReview(job, '```json\n' + JSON.stringify({ items: [{ c: c.info, verdict: 'no', reason: '通知改时间' }, { c: c.ask, verdict: 'reply', reason: '今天看材料' }] }) + '\n```', null);
  assert.deepEqual(a.status().replyReview.counts, { reply: 1, maybe: 0, no: 1 });
  const items = a.brief(D.dayKey(NOW)).sections.find(x => x.key === 'awaiting').items;
  assert.equal(items[items.length - 1].source, 'msg:info:k0');
  assert.equal(items[items.length - 1].settledLabel, 'AI：不用回');
  assert.match(items.find(i => i.source === 'msg:ask:k0').text, /AI：今天看材料/);
  const before = items.map(i => i.source).sort();
  const done = a.markAwaitingDone();
  assert.equal(done.count, 2);
  assert.equal(a.brief(D.dayKey(NOW)).sections.some(x => x.key === 'awaiting'), false);
  a.restoreAwaiting(done.items);
  assert.deepEqual(a.brief(D.dayKey(NOW)).sections.find(x => x.key === 'awaiting').items.map(i => i.source).sort(), before);
  a.finishReplyReview(job, '', '会话没能打开');
  assert.match(a.status().replyReview.error, /会话没能打开/);
});

// ---- Codex 第二轮审查（公司版移植）回归 ----
test('审查回归：带通知字样但明确冲着我的请求仍算该回', () => {
  assert.equal(judge([['他', '【评审】温馨提示：请你今天十八点之前确认这份方案，并直接回复我修改意见，我等你的答复。']]).level, 'strong');
  assert.equal(judge([['他', '【温馨提示】本周五 18:00 起办公区网络维护，活动时间另行通知，请提前报名团购']]).closed, 'notice');
});
test('审查回归：锚失效后，旧条目的「AI：不用回」标签和理由被清掉', () => {
  const s = snap([['p', false, [['甲', '下午会挪到 4 点了', 120]]]]);
  const review = { items: { p: { lastKey: 'k0', verdict: 'no', reason: '已知悉' } } };
  const day = D.dayKey(NOW);
  const brief = B.fallbackBrief(s, { day, now: NOW, settings: { replyReview: review } });
  assert.equal(brief.sections.find(x => x.key === 'awaiting').items[0].settledLabel, 'AI：不用回');
  s.messages.p.push({ ...s.messages.p[0], key: 'k1', sourceId: 'msg:p:k1', text: '今天能给个结论吗', at: NOW - 40 * 60000 });
  const next = B.refreshAwaiting(brief, s, { now: NOW, settings: { replyReview: review } });
  const items = next.sections.find(x => x.key === 'awaiting').items;
  const old = items.find(i => i.source === 'msg:p:k0');
  assert.ok(!old || (!old.settledLabel && !old.aiReason && !/AI：/.test(old.text)), JSON.stringify(old));
  assert.ok(items.some(i => i.source === 'msg:p:k1' && !i.settledLabel));
});
test('审查回归：全部处理了再撤销，其他栏里同出处的条目也回来', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-rr2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, now: () => NOW, bus: new NoticeBus({ now: () => NOW }), getSession: () => null, resolveCli: () => null });
  a.cli = () => null; a.pump = async () => {};
  t.after(() => a.digest.close());
  const day = D.dayKey(NOW);
  const s = snap([['p', false, [['甲', '材料能帮我看一下吗', 120]]]]);
  a.write('raw-' + day + '.json', s);
  const brief = B.fallbackBrief(s, { day, now: NOW, settings: {} });
  brief.sections.push({ key: 'commitments', title: '你答应过的事', items: [{ source: 'msg:p:k0', text: '今天看材料', id: 'commitments|msg:p:k0', top: true }] });
  a.write('brief-' + day + '.json', brief);
  const snapshotOf = () => JSON.stringify(a.brief(day).sections.map(x => [x.key, x.items.map(i => i.source)]));
  const before = snapshotOf();
  const r = a.markAwaitingDone();
  assert.equal(a.brief(day).sections.length, 0, '同出处的承诺也被一起拿掉');
  a.restoreAwaiting(r.items);
  assert.equal(snapshotOf(), before);
  assert.ok(!a.doneSet().has('msg:p:k0'));
});

test('群 @所有人：10 人以下小群才算等我回复；点名 @我 的 AI 不能判不用回（2026-11-16 定）', () => {
  const all = { atAll: true };
  const s = snap([
    ['big', true, [['甲', '@所有人 明早九点开会', 100, all]]],
    ['small', true, [['乙', '@所有人 周报今天交一下', 100, all]]],
    ['small2', true, [['丙', '@所有人 下午对一下进度', 100, all], ['我', '好的我来', 50]]],
    ['named', true, [['丁', '@我 这个方案你看下', 100, { atMe: true }]]],
  ]);
  const settings = { groupSizes: { big: { count: 40, at: NOW }, small: { count: 6, at: NOW }, small2: { count: 6, at: NOW } } };
  const review = { at: NOW, items: { named: { lastKey: 'k0', verdict: 'no', reason: '已在别处回复' } } };
  const got = D.awaiting(s, settings, { now: NOW, review });
  assert.deepEqual(got.map(m => [m.conv, m.level]), [['small', 'strong'], ['named', 'weak'], ['small2', 'settled']]);
  assert.ok(got.find(m => m.conv === 'small').atAllSmallGroup);
  assert.equal(got.find(m => m.conv === 'named').aiReason, '已在别处回复');
  assert.deepEqual(D.awaiting(s, {}, { now: NOW }).map(m => m.conv), ['named'], '没查到人数的群按大群处理');
});
test('服务：只给出现 @所有人 的群查人数，7 天内不重复查', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const svc = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, now: () => NOW, bus: new NoticeBus({ now: () => NOW }), getSession: () => null, resolveCli: () => null });
  svc.cli = () => null; svc.pump = async () => {};
  t.after(() => svc.digest.close());
  const day = D.dayKey(NOW);
  const s = snap([['g1', true, [['甲', '@所有人 开会', 30, { atAll: true }]]], ['g2', true, [['乙', '闲聊', 30]]]]);
  svc.write('raw-' + day + '.json', s);
  const calls = [];
  svc.welink = async args => { calls.push(args.join(' ')); return { code: 0, stdout: JSON.stringify({ data: { members: [{ account: 'a' }, { account: 'b' }, { account: 'c' }] } }) }; };
  assert.equal(await svc.maybeSizeGroups(NOW), 1);
  assert.deepEqual(calls, ['im query-group-member --group-id g1']);
  assert.equal(svc.state().groupSizes.g1.count, 3);
  assert.equal(svc.judgeSettings().groupSizes.g1.count, 3);
  assert.equal(await svc.maybeSizeGroups(NOW + 3600e3), 0);
  assert.equal(calls.length, 1);
});

test('审查回归：小群新来 @所有人，旧的 AI 结论失效；人数查询失败记时间、1 天内不重查', async t => {
  const s = snap([['small', true, [['丁', '@我 这个方案你看下', 100, { atMe: true }], ['乙', '@所有人 周报今天交一下', 30, { atAll: true }]]]]);
  const settings = { groupSizes: { small: { count: 6, at: NOW } } };
  const review = { at: NOW, items: { small: { lastKey: 'k0', verdict: 'no', reason: '旧结论' } } };
  const got = D.awaiting(s, settings, { now: NOW, review });
  assert.ok(got.length === 2 && got.every(m => m.level === 'strong' && !m.aiReason), JSON.stringify(got.map(m => [m.key, m.level, m.aiReason])));
  assert.equal(D.reviewAnchor(s.conversations[0], s.messages.small, '', settings), 'k1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-size2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const svc = new CompanyAssistant({ dataDir: root, noTools: true, noTimer: true, now: () => NOW, bus: new NoticeBus({ now: () => NOW }), getSession: () => null, resolveCli: () => null });
  svc.cli = () => null; svc.pump = async () => {};
  t.after(() => svc.digest.close());
  svc.write('raw-' + D.dayKey(NOW) + '.json', s);
  let calls = 0;
  svc.welink = async () => { calls += 1; throw new Error('超时'); };
  await svc.maybeSizeGroups(NOW);
  await svc.maybeSizeGroups(NOW + 60000);
  assert.equal(calls, 1);
  assert.deepEqual(svc.judgeSettings().groupSizes, {}, '失败记录不当作人数');
  svc.write('raw-' + D.dayKey(NOW + 25 * 3600e3) + '.json', s);
  await svc.maybeSizeGroups(NOW + 25 * 3600e3);
  assert.equal(calls, 2);
});
