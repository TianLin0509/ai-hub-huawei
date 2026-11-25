'use strict';
// 阶段 2 第 2 批前端：试答页签、扫码报错人话化、人设未归纳说明。纯函数直接测；页面结构按源码核对契约要点（真实交互由无头夹具实测）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { humanScanError, tryoutLow } = require('../renderer/avatar-page.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');

test('扫码报错：命令行崩溃或纯英文换成人话，原文进折叠区；中文人话原样保留', () => {
  const crash = 'node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module x\n\nNode.js v24.14.0';
  assert.deepEqual(humanScanError(crash), { head: '扫码登录没成功，请重新获取二维码或到助理页扫码', raw: crash });
  assert.equal(humanScanError('ETIMEDOUT').raw, 'ETIMEDOUT');
  assert.equal(humanScanError('登录失败：Error: spawn welink ENOENT').head, '扫码登录没成功，请重新获取二维码或到助理页扫码');
  assert.deepEqual(humanScanError('二维码已过期，请换一张'), { head: '二维码已过期，请换一张', raw: '' });
  assert.deepEqual(humanScanError(''), { head: '', raw: '' });
});

test('低把握口径与第 1 批一致：标了 lowConfidenceFallback，或把握 0 且没有依据', () => {
  assert.equal(tryoutLow({ lowConfidenceFallback: true, confidence: 80, basis: ['x'] }), true);
  assert.equal(tryoutLow({ confidence: 0, basis: [] }), true);
  assert.equal(tryoutLow({ confidence: 0, basis: ['群历史问答'] }), false);
  assert.equal(tryoutLow({ confidence: 60, basis: [] }), false);
});

test('页签顺序：待确认 | 试答 | 它学到的 | 运行记录 | 生效范围 | 上下文 | 后端与前缀（第 3 批加「它学到的」）；新建后仍默认选中待确认', () => {
  assert.match(src, /\[\['inbox', '待确认'\], \['try', '试答'\], \['learn', '它学到的'\], \['log', '运行记录'\], \['scope', '生效范围'\], \['ctx', '上下文'\], \['back', '后端与前缀'\]\]/);
  assert.match(src, /accept\(r\); sel = r\.createdId; tab = 'inbox'; wiz = null;/);
  assert.match(src, /先试答几道题看看效果/);
});

test('私聊闸门：没勾选同意不调模型，送模型时显式带 explicitPrivateConsent', () => {
  assert.match(src, /if \(q\.kind === 'dm' && !t\.consent\[q\.sampleId\]\) \{ t\.hint = TRY_CONSENT_HINT; render\(\); return; \}/);
  assert.match(src, /explicitPrivateConsent: q\.kind === 'dm' && !!t\.consent\[q\.sampleId\]/);
});

test('失败复用 failureBox、不伪造答案；边界说明常驻', () => {
  assert.ok(src.includes(`<div data-tryout="1">\${failureBox({ ...t.failure, retryAfterMs: 0 }, 'try:' + a.id, true)}</div>`));
  assert.match(src, /试答会调用所选模型推理，但绝不发到群、不改游标、不进发送队列。/);
  assert.match(src, /已存入分身本地范例（现有 \$\{now\} 条）/);
});

test('人设没归纳出来时按钮旁留灰色说明', () => {
  assert.match(src, /personaNotes\[id\] = String\(r\.personaNote \|\| '近期发言较少，暂未能自动归纳，可直接手写'\)/);
  assert.match(src, /id="avx-persona-note"/);
});

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
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
function harness(handlers = {}) {
  const { createAvatarPage } = require('../renderer/avatar-page');
  const { document, window, body } = fakeDom();
  const calls = [];
  const mk = (id, name) => ({ id, name, kind: 'pick', action: 'draft', targets: [], owners: {}, only: [], skip: [], state: { code: 'on', text: '运行中' }, pending: 0, stats: { model: 0 }, enabled: true,
    backend: { account: 'auto', model: '', effort: '' }, prefix: 'p', hideModel: false, persona: '', notes: '', authorities: [], sources: [], examples: 2, memoryLines: 0, session: { alive: false, questions: 0 }, log: [] });
  const st = { avatars: [mk('av1', '甲'), mk('av2', '乙')] };
  const status = () => ({ ok: true, available: true, login: { ok: true }, paused: false, avatars: st.avatars, items: [], backends: { rows: [] } });
  const ipcRenderer = { on() {}, removeListener() {}, invoke: async (name, payload) => {
    calls.push([name, payload]);
    if (handlers[name]) return handlers[name](payload, st, status);
    if (name === 'avatar:targets') return { groups: [], people: [], ready: true };
    return status();
  } };
  const page = createAvatarPage({ document, window, ipcRenderer });
  const section = () => body.children[0];
  const click = async (dataset, inTryout = false) => { for (const fn of section().listeners.click) fn({ target: { closest: () => ({ dataset, disabled: false, closest: sel => (sel === '[data-tryout]' && inTryout ? {} : null) }) } }); await settle(); };
  const typeNote = v => { for (const fn of section().listeners.input) fn({ target: { dataset: { tryNote: '' }, value: v } }); };
  return { page, calls, click, typeNote, html: () => section().firstChild.innerHTML, st };
}
const SAMPLES = { ok: true, samples: [{ id: 's1', kind: 'group', convName: '群', question: '怎么导出？' }], history: [] };
const RETRY_FAIL = { ok: false, error: '限流', failure: { code: 'rate', severity: 'warn', headline: '模型限流了', retryable: true, retryAfterMs: 30000, actions: [{ kind: 'retry_tick', label: '重试这条任务', payload: {} }] } };

test('P0：试答区报错点「重试」只重跑 tryout-run，绝不调用 avatar:recheck；正式报错的重试照旧走 recheck', async () => {
  const h = harness({ 'avatar:tryout-samples': () => SAMPLES, 'avatar:tryout-run': () => RETRY_FAIL });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'tab', k: 'try' });
  await h.click({ av: 'try-run', id: 's1' });
  assert.match(h.html(), /data-tryout="1"/);
  assert.doesNotMatch(h.html(), /秒后自动重试/, '试答失败不会自动重试，不写这句');
  const rechecks = () => h.calls.filter(c => c[0] === 'avatar:recheck').length, runs = () => h.calls.filter(c => c[0] === 'avatar:tryout-run');
  const before = rechecks();
  await h.click({ av: 'fix', kind: 'retry_tick', payload: '{}' }, true);
  assert.equal(runs().length, 2);
  assert.deepEqual(runs()[1][1], runs()[0][1], '原问题、样本、同意态原样重发');
  assert.equal(rechecks(), before, '试答重试没碰正式巡检');
  await h.click({ av: 'fix', kind: 'retry_tick', payload: '{}' }, false);
  assert.equal(rechecks(), before + 1, '非试答区仍走原路');
  assert.equal(h.calls.filter(c => c[0] === 'avatar:recheck').at(-1)[1].retryTick, true);
  h.page.destroy();
});

test('P1-1：评价后范例数没变多，不说「已存入」；变多才说', async () => {
  let n = 2;
  const h = harness({ 'avatar:tryout-samples': () => SAMPLES,
    'avatar:tryout-run': p => ({ ok: true, result: { id: 'tr1', question: p.question, answer: '在右上角', confidence: 80, basis: ['x'], action: 'draft' } }),
    'avatar:tryout-rate': p => ({ ok: true, entry: { id: p.tryoutId, verdict: p.verdict }, examples: n }) });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'tab', k: 'try' }); await h.click({ av: 'try-run', id: 's1' });
  await h.click({ av: 'try-verdict', k: 'unlike' }); h.typeNote('短'); await h.click({ av: 'try-rate' });
  assert.match(h.html(), /已记录这次评价（参考范例仍为 2 条，补充一句具体改法后会记进范例）/);
  assert.doesNotMatch(h.html(), /已存入分身本地范例/);
  n = 3; await h.click({ av: 'try-verdict', k: 'like' }); await h.click({ av: 'try-rate' });
  assert.match(h.html(), /已存入分身本地范例（现有 3 条）/);
  h.page.destroy();
});

test('P1-2：人设生成途中切到别的分身，说明只写回发起的那个分身', async () => {
  let release;
  const h = harness({ 'avatar:persona': (p, st, status) => new Promise(r => { release = () => r({ ...status(), personaNote: '近期发言较少' }); }) });
  h.page.open(); await settle();
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'tab', k: 'ctx' });
  const pending = h.click({ av: 'persona' });
  await settle(); await h.click({ av: 'sel', id: 'av2' }); await h.click({ av: 'tab', k: 'ctx' });
  release(); await pending; await settle();
  assert.doesNotMatch(h.html(), /avx-persona-note/, '分身乙不显示甲的说明');
  await h.click({ av: 'sel', id: 'av1' }); await h.click({ av: 'tab', k: 'ctx' });
  assert.match(h.html(), /id="avx-persona-note">近期发言较少/);
  h.page.destroy();
});
