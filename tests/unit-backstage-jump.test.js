'use strict';
// 跳转后台（renderer/backstage-jump.js，2026-11-26）：状态点含义、按钮与链接的渲染、跳转成功/失败/没有会话三条路。
const assert = require('node:assert/strict');
const test = require('node:test');
const bs = require('../renderer/backstage-jump');

const NOW = 1_800_000_000_000;

test('状态点：没有会话、已关闭、运行中、卡住、等待、报错、休眠、空闲', () => {
  assert.equal(bs.backstageStatus('', null, NOW).tone, 'none');
  assert.equal(bs.backstageStatus('s1', null, NOW).tone, 'closed');
  assert.equal(bs.backstageStatus('s1', { state: 'running', meta: '12s', lastOutputAt: NOW - 5000 }, NOW).tone, 'running');
  assert.match(bs.backstageStatus('s1', { state: 'running', meta: '12s', lastOutputAt: NOW - 5000 }, NOW).text, /运行中 · 12s/);
  const stuck = bs.backstageStatus('s1', { state: 'running', lastOutputAt: NOW - bs.STUCK_MS - 15000 }, NOW);
  assert.equal(stuck.tone, 'stuck');
  assert.match(stuck.text, /可能卡住 · 1 分 45 秒没有新输出/);
  assert.equal(stuck.short, '1 分 45 秒');
  // 启动阶段不算卡住；没有任何输出时间也不算卡住
  assert.equal(bs.backstageStatus('s1', { state: 'starting', lastOutputAt: NOW - 10 * 60000 }, NOW).tone, 'running');
  assert.equal(bs.backstageStatus('s1', { state: 'running', lastOutputAt: 0 }, NOW).tone, 'running');
  assert.equal(bs.backstageStatus('s1', { state: 'waiting', detail: '要你选' }, NOW).tone, 'waiting');
  assert.equal(bs.backstageStatus('s1', { state: 'failed', detail: '额度不足' }, NOW).tone, 'error');
  // 报错原文、等待说明不进按钮的提示属性（隐私底线）
  assert.equal(bs.backstageStatus('s1', { state: 'failed', detail: 'C:/Users/x/secret token=abc' }, NOW).text, '报错');
  assert.equal(bs.backstageStatus('s1', { state: 'waiting', detail: '业务原文' }, NOW).text, '等待操作');
  assert.doesNotMatch(bs.backstageButtonHtml({ sessionId: 's1', from: 'x', runtime: { state: 'failed', detail: 'FAKE_PRIVATE_TOKEN' } }), /FAKE_PRIVATE_TOKEN/);
  assert.equal(bs.backstageStatus('s1', { state: 'interrupted' }, NOW).tone, 'error');
  assert.equal(bs.backstageStatus('s1', { state: 'dormant' }, NOW).tone, 'dormant');
  for (const state of ['idle', 'completed']) assert.equal(bs.backstageStatus('s1', { state }, NOW).tone, 'idle', state);
  // 断连、状态过期（unknown）不能显示成绿色「空闲」
  assert.equal(bs.backstageStatus('s1', { state: 'unknown' }, NOW).tone, 'unknown');
  assert.match(bs.backstageStatus('s1', { state: 'unknown' }, NOW).text, /状态待确认/);
});

test('按钮：总是渲染（灰点也渲染），带来源与会话 id，内容转义', () => {
  bs._reset();
  bs.registerBackstageSource('assistant', { label: '助理' });
  const html = bs.backstageButtonHtml({ sessionId: 'a"b<c', from: 'assistant', runtime: { state: 'running' } });
  assert.match(html, /class="hub-bs-btn"/);
  assert.match(html, /data-hub-backstage="a&quot;b&lt;c"/);
  assert.match(html, /data-hub-backstage-from="assistant"/);
  assert.match(html, /data-tone="running"/);
  assert.match(html, /助理的后台会话：运行中/);
  assert.doesNotMatch(html, /a"b<c/);
  const empty = bs.backstageButtonHtml({ sessionId: '', from: 'assistant' });
  assert.match(empty, /data-tone="none"/);
  assert.match(empty, /当前没有后台会话/);
});

test('报错旁的「查看后台」：没有会话 id 时不出', () => {
  assert.equal(bs.backstageLinkHtml({ sessionId: '', from: 'avatar' }), '');
  assert.match(bs.backstageLinkHtml({ sessionId: 's9', from: 'avatar' }), /class="hub-bs-link" data-hub-backstage="s9"[^>]*>.*查看后台/);
});

// 最小假 DOM：只覆盖 jump 用到的几处（建元素、挂到 body、按 id 找、移除）。
function fakeDom() {
  const byId = new Map();
  const el = tag => {
    const node = { tag, id: '', className: '', style: {}, dataset: {}, innerHTML: '', isConnected: false, offsetWidth: 280, listeners: {},
      setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, matches: () => false,
      querySelector: () => ({ textContent: '' }),
      remove() { this.isConnected = false; if (byId.get(this.id) === this) byId.delete(this.id); } };
    return node;
  };
  const body = { append(node) { node.isConnected = true; if (node.id) byId.set(node.id, node); } };
  const doc = { body, hidden: false, createElement: el, getElementById: id => byId.get(id) || null, addEventListener() {}, querySelectorAll: () => [] };
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: 12, bottom: 40, right: 600 }), closest: () => null };
  return { doc, byId, anchor };
}

test('跳转：成功时收起原入口并出返回条，点返回回到原入口', async () => {
  bs._reset();
  const { doc, byId, anchor } = fakeDom();
  const opened = [], calls = [];
  const win = { innerWidth: 1440, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, __hubOpenBackstage: async id => { opened.push(id); return { ok: true }; } };
  bs.installBackstageJump({ document: doc, window: win });
  bs.registerBackstageSource('dream', { label: '造梦', reopen: () => calls.push('reopen'), leave: () => calls.push('leave') });
  const r = await bs.jumpDirect(anchor, 'sess-1', 'dream');
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(opened, ['sess-1']);
  assert.deepEqual(calls, ['leave']);
  const bar = byId.get('hub-bs-return');
  assert.ok(bar, '返回条出现');
  assert.match(bar.innerHTML, /返回造梦/);
  await bar.listeners.click({ target: { closest: sel => (sel === '[data-hub-bs-back]' ? {} : null) } });
  assert.deepEqual(calls, ['leave', 'reopen']);
  assert.equal(byId.get('hub-bs-return'), undefined, '点返回后返回条收起');
});

test('跳转：没有会话、会话已关闭都就地说明，能重开的给「重新打开」', async () => {
  bs._reset();
  const { doc, byId, anchor } = fakeDom();
  const win = { innerWidth: 1440, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, __hubOpenBackstage: async () => ({ ok: false }) };
  bs.installBackstageJump({ document: doc, window: win });
  bs.registerBackstageSource('forum', { label: '帖子', emptyText: '还没有整理会话', recreate: async () => 'new-id' });
  let r = await bs.jumpDirect(anchor, '', 'forum');
  assert.equal(r.reason, 'none');
  let pop = byId.get('hub-bs-pop');
  assert.match(pop.innerHTML, /还没有整理会话/);
  assert.match(pop.innerHTML, /重新打开/);
  r = await bs.jumpDirect(anchor, 'gone', 'forum');
  assert.equal(r.reason, 'closed');
  pop = byId.get('hub-bs-pop');
  assert.match(pop.innerHTML, /已关闭/);
  assert.equal(byId.get('hub-bs-return'), undefined, '没跳成功不出返回条');
  // 没注册 recreate 的来源不给「重新打开」
  bs.registerBackstageSource('meeting', { label: '会议', closedText: '理解会话已休眠或已关闭' });
  await bs.jumpDirect(anchor, 'gone', 'meeting');
  pop = byId.get('hub-bs-pop');
  assert.match(pop.innerHTML, /理解会话已休眠或已关闭/);
  assert.doesNotMatch(pop.innerHTML, /重新打开/);
});

test('先诊断：点按钮先出自检弹层（结论、你可以这样做、进入后台、复制诊断信息），点「进入后台」才跳', async () => {
  bs._reset();
  const { doc, byId, anchor } = fakeDom();
  const opened = [];
  const win = { innerWidth: 1440, innerHeight: 900, setInterval: () => 1, clearInterval() {}, localStorage: null,
    __hubSessionRuntime: id => (id === 's-run' ? { state: 'running', lastOutputAt: Date.now() - 200000 } : null),
    __hubOpenBackstage: async id => { opened.push(id); return { ok: true }; } };
  bs.installBackstageJump({ document: doc, window: win });
  bs.registerBackstageSource('assistant', { label: '助理', reopen() {}, diagnose: () => ({ error: '', capability: { codeagent: true, api: false } }) });
  const { result, text } = await bs.jumpToBackstage(anchor, 's-run', 'assistant');
  assert.equal(result.cause, 'stuck');
  assert.deepEqual(opened, [], '自检阶段不跳');
  const pop = byId.get('hub-bs-pop');
  assert.match(pop.innerHTML, /后台可能卡住了/);
  assert.match(pop.innerHTML, /你可以这样做/);
  assert.match(pop.innerHTML, /data-hub-err-act="known:session-restart"/);
  assert.match(pop.innerHTML, /data-hub-bs-enter/);
  assert.match(pop.innerHTML, /复制诊断信息/);
  assert.equal(pop.dataset.sessionId, 's-run', '重启后台会话按弹层上的会话编号找会话');
  assert.match(text, /入口：助理/);
  await pop.listeners.click({ target: { closest: sel => (sel === '[data-hub-bs-enter]' ? {} : null) } });
  assert.deepEqual(opened, ['s-run']);
  // 需要先配置：按钮写「需配置」，弹层标「需要配置，不是故障」，不给进入后台
  bs.registerBackstageSource('assistant', { label: '助理', diagnose: () => ({ capability: { codeagent: false, api: false } }) });
  assert.match(bs.backstageButtonHtml({ sessionId: '', from: 'assistant', needsSetup: true }), /data-tone="setup"[\s\S]*需配置/);
  const r2 = await bs.jumpToBackstage(anchor, '', 'assistant');
  assert.equal(r2.result.cause, 'no-engine');
  const pop2 = byId.get('hub-bs-pop');
  assert.match(pop2.innerHTML, /需要配置，不是故障/);
  assert.doesNotMatch(pop2.innerHTML, /data-hub-bs-enter/);
});
