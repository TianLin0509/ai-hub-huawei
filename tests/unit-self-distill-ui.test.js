'use strict';
// 蒸馏自己 · 分身页「我的画像」（2026-11-28）：顶栏按钮进页签、空状态就地提示与一键继续、后端未配就地选、三栏渲染、翻页、
// self-distill:* 由 m1 的主进程服务提供；这里是只放在测试里的假实现。
const assert = require('node:assert/strict');
const test = require('node:test');
const { createAvatarPage } = require('../renderer/avatar-page.js');
const sp = require('../renderer/self-portrait.js');

function fakeDom() {
  const el = tag => {
    const node = { tagName: tag.toUpperCase(), hidden: false, style: {}, dataset: {}, children: [], listeners: {}, html: '',
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, [Symbol.iterator]() { return this.set.values(); } },
      setAttribute() {}, addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); }, querySelectorAll: () => [], querySelector: () => null,
      append(child) { node.children.push(child); }, remove() {}, getBoundingClientRect: () => ({ width: 0, height: 0, right: 0, bottom: 0 }), contains: () => false };
    Object.defineProperty(node, 'innerHTML', { get: () => node.html, set: v => { node.html = v; if (/^<div class="avx-root">/.test(v)) node.firstChild = el('div'); } });
    return node;
  };
  const body = el('body');
  return { document: { body, createElement: el, getElementById: () => null, activeElement: null }, window: { innerHeight: 900, addEventListener() {}, removeEventListener() {} }, body };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
const mkAv = (id, name) => ({ id, name, tpl: 'draft', kind: 'all', action: 'draft', targets: [], owners: {}, only: [], skip: [], state: { code: 'on', text: '运行中' }, pending: 0, stats: { model: 0 }, enabled: true,
  backend: { account: 'auto', model: '', effort: '' }, prefix: 'p', persona: '', examples: 0, memoryLines: 0, session: { alive: false }, log: [] });

function portraitFixture(extra = {}) {
  const ex = Array.from({ length: 9 }, (_, i) => ({ id: 'e' + i, cat: ['chat', 'fact', 'decline', 'chase'][i % 4], text: `例句${i}：我先看下再说`, locked: false }));
  return {
    v: 1, createdAt: 1, updatedAt: 1,
    source: { kind: 'archive', msgs: 1500, kept: 1240, dropped: { sensitive: 30, long: 5 }, days: 30 },
    backend: { kind: 'codeagent', model: '' },
    speak: {
      stats: { median: 8, p90: 21, periodRate: 12, emojiRate: 5, burstRate: 31, enMixRate: 22 },
      catchphrases: [{ id: 'c1', text: '我看下', n: 62, locked: false }, { id: 'c2', text: '行', n: 40, locked: true }],
      tone: [{ id: 't1', text: '先给判断再说理由', basis: '模型归纳', locked: false }],
      examples: ex,
    },
    habits: { hours: Array.from({ length: 24 }, (_, h) => (h >= 22 || h < 2 ? 30 : 3)), activeFrom: 22, activeTo: 2, replyMedianMin: 3, dailyMsgs: 45,
      style: { conclusion: 50, ask: 30, decline: 10, forward: 10 }, topics: [{ id: 'p1', text: '仿真', n: 80, locked: false }, { id: 'p2', text: 'PPT', n: 30, locked: false }] },
    tags: [{ id: 'g1', text: '话少直给', on: false }],
    apply: { assistant: false, avatar: false, pet: false, community: false, ppt: false },
    ...extra,
  };
}

function harness({ portrait = null, archiveReady = true, backendLabel = 'CodeAgent · 助理模型', backendOk, reason, handlers = {} } = {}) {
  const { document, window, body } = fakeDom();
  const calls = [], on = {};
  const st = { portrait };
  const ipcRenderer = { on(n, fn) { (on[n] ||= []).push(fn); }, removeListener() {}, invoke: async (name, payload) => {
    calls.push([name, payload]);
    if (handlers[name]) return handlers[name](payload, st);
    if (name === 'self-distill:status') return { ok: true, enabled: !!st.portrait, portrait: st.portrait, archiveReady, backendLabel, ...(backendOk === undefined ? {} : { backendOk }), ...(reason ? { reason } : {}), running: false };
    if (name === 'self-distill:run') return { ok: true, started: true };
    if (name === 'self-distill:save') { st.portrait = sp.applyPatch(st.portrait, payload.patch); return { ok: true, portrait: st.portrait }; }
    if (name === 'self-distill:apply') { st.portrait = { ...st.portrait, apply: { ...st.portrait.apply, [payload.target]: payload.on } }; return { ok: true, apply: st.portrait.apply }; }
    if (name === 'self-distill:delete') { st.portrait = null; return { ok: true }; }
    if (name === 'feature-agents:set') return { ok: true };
    if (name === 'avatar:targets') return { groups: [], people: [], ready: true };
    return { ok: true, available: true, login: { ok: true }, paused: false, avatars: [mkAv('av1', '甲')], items: [], backends: { rows: [] } };
  } };
  const page = createAvatarPage({ document, window, ipcRenderer });
  const section = () => body.children[0];
  const click = async dataset => { for (const fn of section().listeners.click) fn({ target: { closest: () => ({ dataset, disabled: false, closest: () => null }) } }); await settle(); };
  const change = async (dataset, checked) => { for (const fn of section().listeners.change) fn({ target: { dataset, checked, value: '' } }); await settle(); };
  const type = (dataset, value) => { for (const fn of section().listeners.input) fn({ target: { dataset, value } }); };
  const emit = async (name, ev) => { for (const fn of on[name] || []) fn({}, ev); await settle(); };
  const of = name => calls.filter(c => c[0] === name);
  return { page, calls, of, click, change, type, emit, st, html: () => section().firstChild.innerHTML };
}

test('分身页顶栏常驻「蒸馏自己」，点开进「我的画像」（左列表同级一项），点分身回去', async () => {
  const h = harness();
  h.page.open(); await settle();
  assert.match(h.html(), /data-av="self-open"[^>]*>蒸馏自己</);
  await h.click({ av: 'self-open' });
  assert.equal(h.of('self-distill:status').length, 1);
  assert.match(h.html(), /<h2>我的画像<\/h2>/);
  assert.match(h.html(), /class="avx-row on" data-av="self-open"/, '左列表「我的画像」高亮');
  await h.click({ av: 'sel', id: 'av1' });
  assert.doesNotMatch(h.html(), /data-self-portrait/);
});

test('空状态：档案没建好时就地提示 36 小时初版，一键继续直接开蒸馏；只统计档带 statsOnly', async () => {
  const h = harness({ archiveReady: false });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  assert.ok(h.html().includes(sp.FIRST_HINT));
  assert.match(h.html(), /data-av="sd-run" >一键继续</);
  await h.click({ av: 'sd-run' });
  assert.deepEqual(h.of('self-distill:run')[0][1], {});
  await h.emit('self-distill:progress', { step: 'error', text: '本人消息只有 12 条，只出了统计' });
  await h.click({ av: 'sd-run', stats: '1' });
  assert.deepEqual(h.of('self-distill:run')[1][1], { statsOnly: true });
});

test('后端没配：就地二选一，选 CodeAgent 先存功能模型再开蒸馏，不让用户去设置页', async () => {
  const h = harness({ backendLabel: '', backendOk: false });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  assert.match(h.html(), /还没选蒸馏用的模型/);
  await h.click({ av: 'sd-backend', k: 'codeagent' });
  assert.deepEqual(h.of('feature-agents:set')[0][1], { feature: 'distill', choice: { kind: 'codeagent', model: '' } });
  assert.equal(h.of('self-distill:run').length, 1);
});

test('有画像：三栏（说话 / 习性 / 应用到），五个开关各带一句说明，PPT 注明不带聊天语气；例句 4 条一页翻页', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  const html = h.html();
  for (const c of ['speak', 'habits', 'apply']) assert.match(html, new RegExp(`data-col="${c}"`));
  for (const [k] of sp.APPLY) assert.match(html, new RegExp(`data-chg="sd-apply" data-k="${k}"`));
  assert.match(html, /只用于讲稿和用词：用词偏好、句子长短，不带聊天语气/);
  assert.match(html, /本人 1240 条消息 · 近 30 天/);
  assert.match(html, /<b>8<\/b> 字<small>一条的中位长度/);
  assert.match(html, /22:00–2:00 最活跃/);
  assert.match(html, /秒回型/);
  assert.equal((html.match(/<i style="height:/g) || []).length, 24, '24 小时作息条');
  assert.ok(html.includes('例句0') && html.includes('例句3') && !html.includes('例句4'));
  assert.match(html, /1 \/ 3/);
  await h.click({ av: 'sd-page', sec: 'examples', d: '1' });
  assert.ok(h.html().includes('例句4') && !h.html().includes('例句0'));
  await h.click({ av: 'sd-page', sec: 'examples', d: '9' });
  assert.ok(h.html().includes('例句8') && h.html().includes('3 / 3'), '翻过头停在最后一页');
});

test('应用开关：勾桌宠 → self-distill:apply {pet,true}，画面显示已应用；再关', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  await h.change({ chg: 'sd-apply', k: 'pet' }, true);
  assert.deepEqual(h.of('self-distill:apply')[0][1], { target: 'pet', on: true });
  assert.match(h.html(), /data-k="pet" checked/);
  assert.match(h.html(), /<b>桌宠<\/b><span class="avx-ch g">已应用/);
  await h.change({ chg: 'sd-apply', k: 'pet' }, false);
  assert.deepEqual(h.of('self-distill:apply')[1][1], { target: 'pet', on: false });
});

test('逐条改 / 锁 / 删：patch 是局部对象、数组整段替换；改过的自动锁住；性格标签可勾', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  await h.click({ av: 'sd-edit', sec: 'tone', id: 't1' });
  assert.match(h.html(), /data-sd-edit="tone"[^>]*value="先给判断再说理由"/);
  h.type({ sdEdit: 'tone' }, '先给结论');
  await h.click({ av: 'sd-ok', sec: 'tone' });
  assert.deepEqual(h.of('self-distill:save')[0][1], { patch: { speak: { tone: [{ id: 't1', text: '先给结论', basis: '模型归纳', locked: true }] } } });
  await h.click({ av: 'sd-del', sec: 'catchphrases', id: 'c1' });
  assert.deepEqual(h.of('self-distill:save')[1][1].patch.speak.catchphrases.map(x => x.id), ['c2']);
  await h.click({ av: 'sd-lock', sec: 'topics', id: 'p2' });
  assert.deepEqual(h.of('self-distill:save')[2][1], { patch: { habits: { topics: [{ id: 'p1', text: '仿真', n: 80, locked: false }, { id: 'p2', text: 'PPT', n: 30, locked: true }] } } });
  assert.equal(h.st.portrait.habits.hours.length, 24, '局部 patch 不冲掉别的字段');
  await h.click({ av: 'sd-tag', id: 'g1' });
  assert.deepEqual(h.of('self-distill:save')[3][1], { patch: { tags: [{ id: 'g1', text: '话少直给', on: true }] } });
  // 编辑清空再保存：不发 patch。
  await h.click({ av: 'sd-edit', sec: 'examples', id: 'e1' }); h.type({ sdEdit: 'examples' }, '  ');
  await h.click({ av: 'sd-ok', sec: 'examples' });
  assert.equal(h.of('self-distill:save').length, 4);
});

test('全部删除要二次确认；确认后回到空状态', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  await h.click({ av: 'sd-delete' });
  assert.match(h.html(), /删除全部画像？/);
  assert.equal(h.of('self-distill:delete').length, 0);
  await h.click({ av: 'confirm-yes' });
  assert.equal(h.of('self-distill:delete').length, 1);
  assert.match(h.html(), /把你自己的说话和习性蒸馏成一张画像/);
});

test('进度逐步用人话显示：已完成打勾、当前步高亮、条数；done 后重新读画像', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  await h.click({ av: 'sd-run' });
  await h.emit('self-distill:progress', { step: 'collect', text: '取到本人 1240 条消息', n: 1240 });
  await h.emit('self-distill:progress', { step: 'stats', text: '正在统计长短和作息' });
  const html = h.html();
  assert.match(html, /<span class="ok"><i>✓<\/i>取材 <small>1240 条<\/small>/);
  assert.match(html, /<span class="now"><i>3<\/i>统计/);
  assert.match(html, /正在统计长短和作息/);
  assert.match(html, /data-av="sd-run" disabled>重新蒸馏/);
  const before = h.of('self-distill:status').length;
  await h.emit('self-distill:progress', { step: 'done', text: '画像已更新' });
  assert.equal(h.of('self-distill:status').length, before + 1);
  assert.doesNotMatch(h.html(), /sd-prog/);
});

test('转义：画像里的文字不会变成标签；旧主进程没有接口时如实说明', async () => {
  const bad = portraitFixture();
  bad.speak.catchphrases = [{ id: 'x"1', text: '<img src=x onerror=1>', n: 1, locked: false }];
  const h = harness({ portrait: bad });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  assert.ok(!h.html().includes('<img src=x'));
  assert.ok(h.html().includes('&lt;img src=x onerror=1&gt;'));
  const old = harness({ handlers: { 'self-distill:status': () => { throw new Error("No handler registered for 'self-distill:status'"); } } });
  old.page.open(); await settle(); await old.click({ av: 'self-open' });
  assert.match(old.html(), /这个版本还没装好「蒸馏自己」/);
});

test('纯函数：翻页夹边、人话分级、patch 合并', () => {
  assert.deepEqual(sp.paginate([1, 2, 3, 4, 5], 9, 2), { rows: [5], at: 2, pages: 3 });
  assert.equal(sp.talkLevel(100), '话多'); assert.equal(sp.talkLevel(30), '适中'); assert.equal(sp.talkLevel(3), '话少');
  assert.equal(sp.replyLevel(2), '秒回型'); assert.equal(sp.replyLevel(200), '回得慢'); assert.equal(sp.replyLevel(0), '—');
  assert.deepEqual(sp.applyPatch({ speak: { a: 1, b: [1] }, x: 1 }, { speak: { b: [] }, tags: [] }), { speak: { a: 1, b: [] }, x: 1, tags: [] });
});

test('审查修复：百分比是 0–100 整数直接加 %；回复不到 1 分钟写「1 分钟内」；关心的领域没有「改」只能锁、删', async () => {
  const p = portraitFixture();
  p.habits.replyMedianMin = 1;
  const h = harness({ portrait: p });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  const html = h.html();
  assert.match(html, /<b>12%<\/b><small>带句号/);
  assert.match(html, /<b>31%<\/b><small>连发几条/);
  assert.doesNotMatch(html, /1200%|3100%/);
  assert.match(html, /<b>1<\/b> 分钟内<small>回复中位 · 秒回型/);
  assert.doesNotMatch(html, /data-av="sd-edit" data-sec="topics"/);
  assert.match(html, /data-av="sd-lock" data-sec="topics" data-id="p1"/);
  assert.match(html, /data-av="sd-del" data-sec="topics" data-id="p1"/);
  await h.click({ av: 'sd-edit', sec: 'topics', id: 'p1' });
  assert.doesNotMatch(h.html(), /data-sd-edit="topics"/, '直接发来的改字操作也不接');
});

test('审查修复：画像 note 常驻页头；后端缺失（backendOk:false）就地给选后端，哪怕有 backendLabel', async () => {
  const note = '没找到可用的模型后端，先只出统计';
  const h = harness({ portrait: portraitFixture({ note }), backendOk: false, backendLabel: '没找到可用后端' });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  assert.ok(h.html().includes(`class="avx-ch w sd-note" title="${note}">${note}</span>`));
  assert.match(h.html(), /还没选蒸馏用的模型。<button class="avx-btn s p" data-av="sd-backend"/);
});

test('审查修复：status.reason（如没登录）就地写原因、给扫码和重新检查，不给「一键继续」；有画像时「重新蒸馏」不可点', async () => {
  const reason = '还没确认 WeLink 登录：先在「助理」页完成登录和取数';
  const h = harness({ archiveReady: false, reason });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  assert.ok(h.html().includes(reason));
  assert.match(h.html(), /data-av="scan">就地扫码登录/);
  assert.doesNotMatch(h.html(), /一键继续|开始蒸馏/);
  const n = h.of('self-distill:status').length;
  await h.click({ av: 'sd-reload' });
  assert.equal(h.of('self-distill:status').length, n + 1);
  const g = harness({ portrait: portraitFixture(), reason });
  g.page.open(); await settle(); await g.click({ av: 'self-open' });
  assert.match(g.html(), /data-av="sd-run" disabled>重新蒸馏/);
});

test('审查修复：收到 self-distill:changed（别处改了画像）已打开时立即重读', async () => {
  const h = harness({ portrait: portraitFixture() });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  const n = h.of('self-distill:status').length;
  h.st.portrait = null;
  await h.emit('self-distill:changed', {});
  assert.equal(h.of('self-distill:status').length, n + 1);
  assert.match(h.html(), /把你自己的说话和习性蒸馏成一张画像/);
});

test('真实画像（核心 distill 产出）在界面三栏里正常显示，数字不放大', async () => {
  const SD = require('../core/self-distill');
  const base = Date.UTC(2026, 10, 10, 15);
  const rows = Array.from({ length: 60 }, (_, i) => ({ at: base + i * 300000, c: 'c1', m: 1, t: ['我看下', '行', '仿真跑完了吗'][i % 3] }));
  const { portrait } = await SD.distill({ rows, source: { kind: 'snapshot' } });
  const h = harness({ portrait });
  h.page.open(); await settle(); await h.click({ av: 'self-open' });
  const html = h.html();
  for (const c of ['speak', 'habits', 'apply']) assert.match(html, new RegExp(`data-col="${c}"`));
  assert.ok(html.includes(`<b>${portrait.speak.stats.periodRate}%</b>`));
  assert.ok(html.includes('我看下'));
  assert.match(html, /初版 · 最近 36 小时 60 条/);
});
