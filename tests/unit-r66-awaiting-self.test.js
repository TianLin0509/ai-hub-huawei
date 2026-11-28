'use strict';
// R66（2026-11-27 一键反馈）：「等你回复」把本人账号当成别人、已经回过的群消息还一直提醒。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../core/company-assistant/data');
const R = require('../core/company-assistant/reminders');

const NOW = Date.parse('2026-11-16T15:00:00+08:00');
const H = 3600000;
const settings = { waitHours: 1, workdays: [0, 1, 2, 3, 4, 5, 6] };
const raw = rows => ({ chatInfo: rows.map((r, i) => ({ msgId: String(1000 + i), sender: r[0], content: r[1], contentType: 'TEXT_MSG', serverSendTime: NOW - r[2] * 60000, ...(r[3] || {}) })) });

test('本人账号换一种写法（带字母前缀 / 不带）发的消息认作「我」，私聊里不再「等你回复」', () => {
  const conv = { id: 'p1', name: '周工', group: false };
  for (const [uid, sender] of [['00200002', 'x00200002'], ['x00200002', '00200002'], ['wx1234567', 'lwx1234567'], ['X00200002', 'x00200002']]) {
    const rows = D.messages(raw([['z1', '材料你确认一下？', 300], [sender, '已确认，没问题', 200]]), conv, uid);
    assert.equal(rows[1].mine, true, `${uid} vs ${sender}`);
    assert.equal(rows[1].sender, '我');
    const snap = { at: NOW, login: { uid }, conversations: [conv], messages: { p1: rows } };
    assert.equal(D.awaiting(snap, settings, { now: NOW }).length, 0, '最后一句是我说的');
  }
  // 别人的工号数字不同：仍是别人
  const other = D.messages(raw([['00200003', '你确认一下？', 300]]), conv, '00200002');
  assert.equal(other[0].mine, false);
});

test('手机设置里加的额外工号（本人第二个号）发的也算我；@ 到它也算 @我', () => {
  const conv = { id: 'p1', name: '周工', group: false };
  const rows = D.messages(raw([['z1', '材料你确认一下？', 300], ['00300003', '好的我看', 200]]), conv, ['00200002', '00300003']);
  assert.equal(rows[1].mine, true);
  const g = { id: 'g1', name: '联调群', group: true };
  const hit = D.messages(raw([['l1', '@某人 帮看下', 100, { at: true, atAccountList: ['x00200002'] }]]), g, '00200002');
  assert.equal(hit[0].atMe, true, '被 @ 的账号写法不同也认');
});

test('旧缓存里认错的行（当时按别的写法比对）按当前本人账号重认：快照里的本人回复不再被当成别人在等我', () => {
  const conv = { id: 'p1', name: '周工', group: false };
  const stale = [
    { sourceId: 'msg:p1:1', conv: 'p1', convName: '周工', group: false, key: '1', at: NOW - 5 * H, sender: '周工', account: 'z1', mine: false, text: '你确认一下？' },
    { sourceId: 'msg:p1:2', conv: 'p1', convName: '周工', group: false, key: '2', at: NOW - 4 * H, sender: '林某', account: 'x00200002', mine: false, text: '已确认' },
  ];
  const snap = { at: NOW, login: { uid: '00200002' }, conversations: [conv], messages: { p1: stale } };
  assert.equal(D.awaiting(snap, settings, { now: NOW }).length, 0);
  const fixed = D.markSelf(stale, ['00200002']);
  assert.equal(fixed[1].mine, true); assert.equal(fixed[1].sender, '我');
  assert.equal(fixed[0].mine, false, '别人的不动');
  // 额外工号来自手机设置
  const snap2 = { ...snap, messages: { p1: [stale[0], { ...stale[1], account: '00300003' }] } };
  assert.equal(D.awaiting(snap2, settings, { now: NOW }).length, 1, '没配额外工号时仍当别人');
  assert.equal(D.awaiting(snap2, { ...settings, phone: { extraIds: ['00300003'] } }, { now: NOW }).length, 0);
});

test('群里 @我 之后我在群里接过话：今天栏仍列着，不再弹「@你的消息已过」提醒；我只引用回复了别人那条的不算', () => {
  const conv = { id: 'g1', name: '联调群', group: true };
  const row = (key, who, text, agoH, extra = {}) => ({ sourceId: `msg:g1:${key}`, conv: 'g1', convName: '联调群', group: true, key, at: NOW - agoH * H, sender: who === '我' ? '我' : who, account: who === '我' ? '00200002' : who, mine: who === '我', text, ...extra });
  const replied = { at: NOW, login: { ok: true, uid: '00200002' }, conversations: [conv], messages: { g1: [row('1', '甲', '明天联调谁来搭环境？', 5, { atMe: true }), row('2', '我', '我来搭，上午搞定', 4)] } };
  assert.equal(D.awaiting(replied, settings, { now: NOW }).length, 1, '今天栏照样列出待核对');
  const pushed = R.dueNotices({ snapshot: replied, settings, now: NOW }).filter(n => n.kind === 'awaiting-reply');
  assert.equal(pushed.length, 0, '接过话的不再推送');
  // 本人用另一种写法发的接话，同样算
  const variant = { ...replied, messages: { g1: [replied.messages.g1[0], { ...replied.messages.g1[1], mine: false, sender: '林某', account: 'x00200002' }] } };
  assert.equal(R.dueNotices({ snapshot: variant, settings, now: NOW }).filter(n => n.kind === 'awaiting-reply').length, 0);
  // 甲、乙都 @我，我只引用回复了甲：乙仍提醒
  const two = { ...replied, messages: { g1: [row('1', '甲', '材料确认了吗？', 6, { atMe: true }), row('2', '乙', '评审几点？', 5, { atMe: true }), row('3', '我', '确认了', 4, { replyTo: '1' })] } };
  const notices = R.dueNotices({ snapshot: two, settings, now: NOW }).filter(n => n.kind === 'awaiting-reply');
  assert.deepEqual(notices.map(n => n.detail.source), ['msg:g1:2']);
  // 没接过话的照常提醒
  const silent = { ...replied, messages: { g1: [replied.messages.g1[0]] } };
  assert.equal(R.dueNotices({ snapshot: silent, settings, now: NOW }).filter(n => n.kind === 'awaiting-reply').length, 1);
});
