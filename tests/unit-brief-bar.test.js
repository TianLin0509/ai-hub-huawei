'use strict';
// 交卷 / 请拍板简述条（来源 b7819bfc、4651d056 的界面部分；数据改用进展卡快照）：
// 什么时候出卡、什么时候不出，以及和右下角回执的分工（同一会话已有简述卡时回执不再弹）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { planItems, kindOf, createBriefBar } = require('../renderer/brief-bar');
const { createSessionReadyNotifier } = require('../renderer/session-ready-notifier');

const NOW = Date.UTC(2026, 10, 28, 12);
const card = (sid, plain, extra = {}) => ({ sessionId: sid, title: '任务 ' + sid, cardPath: `D:/w/${sid}/进展卡.md`, mtimeMs: NOW - 60_000, plain, ...extra });
const decide = { status: '有风险', line: '跑到一半', decision: { question: '要不要换方案 B', recommendation: '换 B，省一天' } };
const done = { status: '已完成', line: '全部 5 项做完，回执在 D:/w/回执.md', decision: null };

test('pending decision shows a two-line card at once, even on the first snapshot', () => {
  const { items } = planItems({ cards: [card('a', decide)], now: NOW });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].lines], ['decide', ['要不要换方案 B', '推荐：换 B，省一天']]);
});

test('answered, marked handled, member and stale cards do not show', () => {
  assert.equal(kindOf(card('a', decide, { decisionAnsweredAt: NOW })), null);
  const c = card('a', decide);
  assert.equal(kindOf(c, { [c.cardPath]: { decision: true, mtimeMs: c.mtimeMs } }), null, '进展条点过「已处理」');
  assert.equal(kindOf(c, { [c.cardPath]: { decision: true, mtimeMs: c.mtimeMs - 1 } }), 'decide', '卡更新后「已处理」失效');
  assert.equal(planItems({ cards: [card('m', decide)], isMember: id => id === 'm', now: NOW }).items.length, 0, '组队成员不出卡');
  assert.equal(planItems({ cards: [card('a', decide, { mtimeMs: NOW - 25 * 3600_000 })], now: NOW }).items.length, 0, '超过 24 小时不出');
});

test('handoff only for a change seen while Hub is open', () => {
  const since = NOW - 10 * 60_000;
  // 启动时第一份快照里已经是「已完成」的旧卡不补弹。
  const first = planItems({ cards: [card('a', done)], now: NOW, since });
  assert.equal(first.items.length, 0);
  // 同一版卡下一份快照里仍不算新的。
  assert.equal(planItems({ cards: [card('a', done)], prev: first.kinds, now: NOW, since }).items.length, 0);
  // 从「顺利」变成「已完成」：出交卷卡，一行结论。
  const running = planItems({ cards: [card('a', { status: '顺利', line: 'x' })], now: NOW, since });
  const next = planItems({ cards: [card('a', done, { mtimeMs: NOW - 1000 })], prev: running.kinds, now: NOW, since });
  assert.deepEqual(next.items.map(x => [x.kind, x.lines.length]), [['handoff', 1]]);
  // 打开 Hub 之后才第一次读到的卡：比打开时间早写成的不弹，之后写成的弹。
  assert.equal(planItems({ cards: [card('b', done, { mtimeMs: NOW - 20 * 60_000 })], prev: new Map(), now: NOW, since }).items.length, 0);
  assert.equal(planItems({ cards: [card('b', done, { mtimeMs: NOW - 1000 })], prev: new Map(), now: NOW, since }).items.length, 1);
});

test('bar keeps a handoff until handled, drops a decision once answered, remembers dismissals', () => {
  const nodes = [];
  const el = () => ({ className: '', id: '', innerHTML: '', setAttribute() {}, addEventListener() {}, remove() { nodes.splice(nodes.indexOf(this), 1); } });
  const doc = { createElement: el, body: { append: n => nodes.push(n) } };
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let t = NOW - 5 * 60_000;
  const bar = createBriefBar({ document: doc, storage, now: () => t });
  bar.accept([card('a', decide), card('b', { status: '顺利', line: 'x' })]);
  assert.deepEqual(bar.items().map(x => x.kind), ['decide']);
  assert.ok(bar.covers('a') && !bar.covers('b'));
  t = NOW;
  bar.accept([card('a', decide, { decisionAnsweredAt: NOW }), card('b', done, { mtimeMs: NOW - 1000 })]);
  assert.deepEqual(bar.items().map(x => [x.sessionId, x.kind]), [['b', 'handoff']], '拍板回复了就消失，交卷出现');
  bar.accept([card('a', { status: '顺利', line: 'y' }), card('b', done, { mtimeMs: NOW - 1000 })]);
  assert.deepEqual(bar.items().map(x => x.sessionId), ['b'], '交卷留到处理');
  assert.ok(nodes.length === 1 && /交卷/.test(nodes[0].innerHTML));
  // 新开 Hub：交卷不补弹；拍板仍在等的照样出，点过 × 的不再出。
  const again = createBriefBar({ document: doc, storage, now: () => NOW });
  again.accept([card('c', decide)]);
  const id = again.items()[0].id;
  store.set('hub.briefBar.dismissed.v1', JSON.stringify([id]));
  const third = createBriefBar({ document: doc, storage, now: () => NOW });
  third.accept([card('c', decide)]);
  assert.equal(third.items().length, 0);
});

// 审查阻断 2：收起后，Agent 只是更新卡上别的段落（修改时间变了），同一件事不再弹；问题或状态真变了才弹。
test('dismissed card stays dismissed when the agent only touches the card again', () => {
  const doc = { createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() {} }), body: { append() {} } };
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let t = NOW - 5 * 60_000;
  const bar = createBriefBar({ document: doc, storage, now: () => t });
  bar.accept([card('a', decide, { mtimeMs: t - 1000 }), card('b', { status: '顺利', line: 'x' }, { mtimeMs: t - 1000 })]);
  t = NOW;
  bar.accept([card('a', decide, { mtimeMs: t - 900 }), card('b', done, { mtimeMs: t - 800 })]);
  assert.deepEqual(bar.items().map(x => x.kind).sort(), ['decide', 'handoff']);
  // 两张都点 ×（收起记录按「这件事」记）。
  const ids = bar.items().map(x => x.id);
  // 直接用纯函数核对三种情形。
  const prev = new Map([['a', { kind: 'decide' }], ['b', { kind: 'handoff', handoffAt: t - 800 }]]);
  const dismissed = new Set(ids);
  assert.equal(planItems({ cards: [card('a', decide, { mtimeMs: t - 5 }), card('b', done, { mtimeMs: t - 5 })], prev, dismissed, now: NOW, since: NOW - 10 * 60_000 }).items.length, 0, '只改了卡的别处：不再弹');
  const newQ = { ...decide, decision: { question: '要不要先发灰度', recommendation: '先发 10%' } };
  assert.deepEqual(planItems({ cards: [card('a', newQ, { mtimeMs: t - 5 })], prev, dismissed, now: NOW, since: NOW - 10 * 60_000 }).items.map(x => x.kind), ['decide'], '拍板问题变了：新的一件，弹');
  const left = planItems({ cards: [card('b', { status: '顺利', line: '返工' }, { mtimeMs: t - 4 })], prev, dismissed, now: NOW, since: NOW - 10 * 60_000 });
  assert.deepEqual(planItems({ cards: [card('b', done, { mtimeMs: t - 2 })], prev: left.kinds, dismissed, now: NOW, since: NOW - 10 * 60_000 }).items.map(x => x.kind), ['handoff'], '返工后再次完成：新的一次交卷，弹');
});

// 审查阻断 1：停在主页、PPT、WeLink 等应用页时不算在看会话，简述卡不能被当成「已看到」吞掉。
test('only sessions actually on screen count as seen', () => {
  const doc = { createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() {} }), body: { append() {} } };
  let visible = [];
  const bar = createBriefBar({ document: doc, storage: null, now: () => NOW, getVisibleSessionIds: () => visible });
  bar.accept([card('a', decide)]);
  assert.equal(bar.items().length, 1, '在应用页：卡留着');
  visible = ['a'];
  bar.syncActive();
  assert.equal(bar.items().length, 0, '切到这个会话：收起');
  const src = fs.readFileSync(path.join(__dirname, '../renderer/brief-bar.js'), 'utf8');
  assert.match(src, /__hubPageOpen\?\.\(\)/, '应用页判断接入');
});

test('a session already shown in the brief bar does not also pop a desktop receipt', () => {
  const sent = [];
  const ready = id => ({ id, title: id, status: 'idle', unreadCount: 1, lastCompletedAt: NOW, replyReadyText: '完成', attentionState: 'reply-ready' });
  let list = [];
  const n = createSessionReadyNotifier({ ipcRenderer: { send: (_c, p) => sent.push(p.sessionId) }, getSessions: () => list, isCovered: id => id === 'a' });
  n.prime();
  list = [ready('a')];
  const r = n.scan();
  assert.equal(r.readyCount, 1);
  assert.equal(r.notified, false, '被简述卡覆盖的会话不弹回执');
  list = [ready('a'), ready('b')];
  assert.equal(n.scan().notified, true, '别的会话照常弹');
  assert.deepEqual(sent, ['b']);
  const src = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(src, /isCovered: id => !!window\.__briefBar\?\.covers\(id\)/);
});

// 负责人 11-28 定：「桌宠与回执」提醒选了「关」时，简述条也静音；静音时回执那边不因简述条少提醒。
test('muted by the reminder setting: nothing shown, receipts not suppressed', () => {
  const nodes = [];
  const doc = { createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() { nodes.pop(); } }), body: { append: n => nodes.push(n) } };
  let muted = true;
  const bar = createBriefBar({ document: doc, storage: null, now: () => NOW, isMuted: () => muted });
  bar.accept([card('a', decide)]);
  assert.equal(nodes.length, 0, '静音：不显示');
  assert.equal(bar.covers('a'), false, '静音：回执照常按用户设置处理');
  muted = false; bar.paint();
  assert.equal(nodes.length, 1, '改回后还在等的拍板出现');
  assert.equal(bar.covers('a'), true);
});
