'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serve = require('../core/codeagent-serve');
const usage = require('../core/codeagent-usage-menu');
const { usageDetailsHtml, createCodeAgentUsagePanel } = require('../renderer/codeagent-usage-panel');
const { createCodeAgentQuotaBar } = require('../renderer/codeagent-quota-bar');

test('Token bar always uses Day and warns only for short windows at or above 80 percent', () => {
  const { tokenUsage, TOKEN_WARN_PERCENT, TOKEN_DANGER_PERCENT } = require('../renderer/codeagent-quota-bar');
  assert.equal(TOKEN_WARN_PERCENT, 50); assert.equal(TOKEN_DANGER_PERCENT, 80);
  const model = { name: 'GLM-5.2-WX-Auto', day: { pct: 1.7 }, hour: { pct: 0.21 }, min: { pct: 31.33 } };
  const entry = { models: [model] };
  assert.equal(tokenUsage(entry, model.name).window, 'day');
  assert.equal(tokenUsage(entry, model.name).pct, 1.7); assert.equal(tokenUsage(entry, model.name).shortWarning, null);
  assert.equal(tokenUsage(entry, model.name).level, '');
  model.day.pct = 50; assert.equal(tokenUsage(entry, model.name).level, 'warn');
  model.min.pct = 79.99; assert.equal(tokenUsage(entry, model.name).shortWarning, null);
  model.min.pct = 80; assert.equal(tokenUsage(entry, model.name).shortWarning.window, 'min');
  model.hour.pct = 90; assert.equal(tokenUsage(entry, model.name).shortWarning.window, 'hour');
  model.day.pct = 80; assert.equal(tokenUsage(entry, model.name).level, 'danger');
  delete model.day; assert.equal(tokenUsage(entry, model.name), null);
  assert.equal(tokenUsage(entry, 'another-model'), null, 'never substitute another model for an explicit selection');
  assert.equal(tokenUsage(null, ''), null);
});

test('Token account selection uses the active session model, otherwise its account default or first Day model', () => {
  const { tokenModelForAccount, tokenUsage } = require('../renderer/codeagent-quota-bar');
  const defaults = { personal: 'personal-default', pool1: 'pool-default' };
  const session = { kind: 'codeagent-resume', codeagentPoolAccount: 'pool1', currentModel: { id: 'session-model' } };
  assert.equal(tokenModelForAccount('pool1', session, defaults), 'session-model');
  assert.equal(tokenModelForAccount('personal', session, defaults), 'personal-default');
  assert.equal(tokenModelForAccount('pool1', null, defaults), 'pool-default');
  assert.equal(tokenModelForAccount('personal', { kind: 'claude', currentModel: { id: 'ignored' } }, defaults), 'personal-default');
  assert.equal(tokenUsage({ models: [{ name: 'no-Day' }, { name: 'first-Day', day: { pct: 2 } }] }, '').name, 'first-Day');
});

test('quota shows only Token and truncates long names with a full tooltip', () => {
  const document = fakeDocument(); const host = document.createElement('div'); host.id = 'rail-codeagent-quota';
  let active = null;
  const bar = createCodeAgentQuotaBar({ document, getActiveSession: () => active, now: () => 1000 });
  const model = 'A-very-long-model-name-that-must-fit-in-a-narrow-sidebar';
  const accounts = { personal: { label: '个人账号', at: 1000, models: [{ name: model, day: { pct: 1.7 }, min: { pct: 80 } }], credit: { monthly: { used: '2', total: '100', pct: 2 } } } };
  bar.setUsage(accounts, { personal: model });
  assert.match(host.innerHTML, /Token<\/span><span class="ca-token-model" title="A-very-long-model-name/);
  assert.match(host.innerHTML, /今日 1.7%/); assert.match(host.innerHTML, /width:1.7%/); assert.match(host.innerHTML, /data-level=""/);
  assert.match(host.innerHTML, /ca-token-alert">⚠ 本分钟 80%/);
  assert.match(host.innerHTML, /个人账号 · 更新于 [^\n]+\n今日 1.7% · 本小时 未读取 · 本分钟 80%\n点击查看详情/);
  accounts.personal.models[0].min.pct = 79; bar.setUsage(accounts); assert.doesNotMatch(host.innerHTML, /ca-token-alert/);
  assert.doesNotMatch(host.innerHTML, /ca-quota-credit|Credit|98%/);
  active = { kind: 'codeagent', currentModel: { id: 'unread-model' } }; bar.render();
  assert.match(host.innerHTML, /Token 未读取/); assert.doesNotMatch(host.innerHTML, /Credit/);
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles/compact-status-shell.css'), 'utf8');
  assert.match(css, /\.ca-token-model\s*\{[^}]*min-width:0;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/);
  assert.match(css, /grid-template-rows:18px/);
  assert.doesNotMatch(css, /ca-quota-credit|grid-row:1 \/ 3/);
});

// Real user-copied /model text. Preserve its original spaces (not a synthetic table).
const REAL_USAGE = [
  'Credit用量shift + ↓ to detail',
  '月度: 402.74/400000,已用0.1%   每天(忙时): 55.7/20000,已用0.27%   每天(平时,闲时): 25.18/20000,已用0.12%    闲时2折进行中 ',
  '      模型名称                          Credit消耗系数  Token用量/配额             闲时2折● 负载      模型描述',
  'Built-in',
  '❯  1. GLM-5.2-WX-Auto default ✓         0-1x  0-1x      Day 6.78M/400M (1.7%)             ● 低负载    型，强大逻辑',
  'Hour 415.29K/200M (0.21%)  ',
  'Min 313.29K/1M (31.33%)',
];
const MENU_FOOTER = 'Navigate ↑ ↓ | Select enter | Back esc';
const EARLY_USAGE = REAL_USAGE.slice(0, 5).map(line => line.replace(/Day .*$/, ''));

// Synthetic values in the documented API shape, not a captured quota response.
function servedRead() {
  const parsed = serve.parseProviders({ providers: [{ id: 'example', models: {
    'Example-V4.1-Flash-128K': { id: 'Example-V4.1-Flash-128K', originCoefficient: '0x', load: '低负载' },
  } }], creditUsage: { quotas: [
    { type: 'CPD_Peak', used: '0.76', total: '12345' },
    { type: 'CPD_Valley', used: '1.25', total: '23456' },
    { type: 'CPM', used: '9.5', total: '345678' },
  ] } });
  return { ok: true, models: parsed.models.map(m => m.id), details: parsed.models, credit: parsed.credit,
    quotas: { 'Example-V4.1-Flash-128K': serve.parseQuota({ quotas: [
      { type: 'TPD', used_quota: '35440000', total_quota: '400000000' },
      { type: 'TPH', used_quota: '75000', total_quota: '2000000' },
    ] }) } };
}

function tempData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-usage-test-'));
  t.after(() => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('hub-usage-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return dir;
}

test('serve snapshot keeps all three API Credit limits separate from model Token windows', () => {
  const snapshot = serve.toUsageSnapshot(servedRead());
  assert.deepEqual(snapshot.credit.busyDay, { used: '0.76', total: '12345', pct: 0.01 });
  assert.deepEqual(snapshot.credit.idleDay, { used: '1.25', total: '23456', pct: 0.01 });
  assert.deepEqual(snapshot.credit.monthly, { used: '9.5', total: '345678', pct: 0 });
  assert.deepEqual(snapshot.models[0].day, { used: '35.44M', total: '400M', pct: 8.86 });
  assert.deepEqual(snapshot.models[0].hour, { used: '75K', total: '2M', pct: 3.75 });
  assert.equal(snapshot.models[0].factor, '0x');
  assert.equal(snapshot.models[0].load, '低负载');
  assert.equal(snapshot.credit.idleDiscountIn, null);
});

test('missing API used values remain unknown rather than becoming zero Credit or Token', () => {
  const read = servedRead();
  read.credit = serve.parseProviders({ creditUsage: { quotas: [{ type: 'CPM', used: null, total: 99 }] } }).credit;
  read.quotas[read.models[0]] = serve.parseQuota({ quotas: [{ type: 'TPD', used_quota: null, total_quota: 100 }] });
  const snapshot = serve.toUsageSnapshot(read);
  assert.equal(snapshot.credit.monthly.used, null);
  assert.equal(snapshot.credit.monthly.pct, null);
  assert.equal(snapshot.models[0].day.used, '');
  assert.equal(snapshot.models[0].day.pct, null);
  assert.match(usageDetailsHtml({ ...snapshot, source: 'serve', at: 1000 }), /未读取 \/ 99/);
});

test('model usage matches explicit truncation prefixes but does not conflate V4 and V4.1', () => {
  const v4 = { name: 'DeepSeek-V4...' };
  const v41 = { name: 'DeepSeek-V4.1-Flash-1...' };
  const entry = { models: [v4, v41] };
  assert.equal(usage.modelUsage(entry, 'DeepSeek-V4.1-Flash-128K'), v41);
  assert.equal(usage.modelUsage(entry, 'deepseek-v4-flash'), v4);
  assert.equal(usage.modelUsage({ models: [v4] }, 'DeepSeek-V4.1-Flash'), null);
  assert.equal(usage.modelUsage({ models: [v4] }, 'DeepSeekV4.1-Flash'), null);
  assert.equal(usage.modelUsage({ models: [v41] }, 'DeepSeek-V4-Flash-128K'), null);
  assert.equal(usage.modelUsage({ models: [{ name: 'DeepSeek-V4' }] }, 'DeepSeek-V4.1'), null);
  assert.equal(usage.modelUsage({ models: [{ name: 'DeepSeek-V4.1-Flash-1…' }] }, 'DeepSeek-V4.1-Flash-128K').name, 'DeepSeek-V4.1-Flash-1…');
  assert.equal(usage.modelUsage({ models: [{ name: 'GLM-5...' }] }, 'GLM-5.2'), null);
  assert.equal(usage.modelUsage({ models: [{ name: 'Example...' }] }, 'Example-V4.1'), null);
});

test('exact model names win; ambiguous or unmarked partial names never match', () => {
  const exact = { name: 'Example-V4.1-Flash-128K' };
  assert.equal(usage.modelUsage({ models: [{ name: 'Example-V4.1...' }, exact] }, exact.name), exact);
  assert.equal(usage.modelUsage({ models: [{ name: 'Example-V4.1-Flash-1' }] }, exact.name), null);
  assert.equal(usage.modelUsage({ models: [{ name: 'Example-V4.1...' }, { name: 'Example-V4.1-Flash...' }] }, exact.name), null);
});

test('serve updates preserve the menu countdown deadline without restarting it, and expire it', t => {
  const dir = tempData(t), start = 1000000;
  const snapshot = serve.toUsageSnapshot(servedRead());
  const menu = { ...snapshot, credit: { ...snapshot.credit, idleDiscountIn: '1小时', idleDiscount: '2折' } };
  const first = usage.recordUsage(dir, 'personal', menu, { source: 'screen', now: start });
  assert.equal(first.credit.idleDiscountUntil, start + 3600000);
  const second = usage.recordUsage(dir, 'personal', snapshot, { source: 'serve', now: start + 600000 });
  assert.equal(second.credit.idleDiscountIn, '1小时');
  assert.equal(second.credit.idleDiscount, '2折');
  assert.equal(second.credit.idleDiscountUntil, first.credit.idleDiscountUntil);
  const third = usage.recordUsage(dir, 'personal', snapshot, { source: 'serve', now: start + 1200000 });
  assert.equal(third.credit.idleDiscountUntil, first.credit.idleDiscountUntil);
  const expired = usage.recordUsage(dir, 'personal', snapshot, { source: 'serve', now: start + 3600000 });
  assert.equal(expired.credit.idleDiscountIn, null);
  assert.equal(expired.credit.idleDiscountUntil, null);
});

test('legacy countdowns use their original observation time; partial reads retain section times and sources', t => {
  const dir = tempData(t), start = 1000000;
  const file = usage.usageFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { personal: {
    credit: { idleDiscountIn: '30分钟', idleDiscount: '2折' }, models: [], at: start, source: 'screen',
  } } }));
  const entry = usage.recordUsage(dir, 'personal', { models: [{ name: 'Example' }] }, { now: start + 600000, source: 'serve' });
  assert.equal(entry.credit.idleDiscountUntil, start + 1800000);
  assert.equal(entry.creditAt, start);
  assert.equal(entry.creditSource, 'screen');
  assert.equal(entry.modelsAt, null);
  assert.equal(entry.modelsSource, null);
  assert.deepEqual(entry.models, [{ name: 'Example' }]);
  const html = usageDetailsHtml(entry);
  assert.match(html, /CodeAgent \/model 菜单/);
  assert.doesNotMatch(html, /CodeAgent serve 接口/);
});

test('usage refresh coalesces concurrent opens and throttles each account for ten minutes with a fake clock', async () => {
  let clock = 1000000, calls = [];
  const accounts = {};
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const refresher = usage.createUsageRefresher({ now: () => clock, read: key => accounts[key], probe: async key => {
    calls.push(key); await wait; accounts[key] = { at: clock, source: 'serve' };
  } });
  const first = refresher.refresh('personal');
  assert.equal(refresher.refresh('personal'), first);
  release(); await first;
  clock += usage.CODEAGENT_SERVE_MAX_AGE_MS - 1;
  assert.equal((await refresher.refresh('personal')).cached, true);
  assert.deepEqual(calls, ['personal']);
  await refresher.refresh('pool-example');
  clock += 1;
  assert.equal((await refresher.refresh('personal')).ok, true);
  assert.deepEqual(calls, ['personal', 'pool-example', 'personal']);
});

test('failed refreshes retain the exact prior menu snapshot and error throughout the cooldown', async () => {
  let clock = 1000000, calls = 0;
  const old = { at: 123, source: 'screen', models: [{ name: 'Example' }] };
  const refresher = usage.createUsageRefresher({ now: () => clock, read: () => old, probe: async () => { calls += 1; throw new Error('serve 与菜单均不可用'); } });
  const result = await refresher.refresh('personal');
  assert.equal(result.ok, false);
  assert.equal(result.entry, old);
  assert.equal(result.entry.at, 123);
  clock += 1000;
  const cached = await refresher.refresh('personal');
  assert.equal(cached.ok, false);
  assert.equal(cached.error, 'serve 与菜单均不可用');
  assert.equal(cached.entry, old);
  assert.equal(calls, 1);
});

test('a recent persisted serve snapshot or another probe attempt prevents an early panel refresh', async () => {
  let calls = 0;
  const refresher = usage.createUsageRefresher({ now: () => 1000000, read: key => key === 'personal' ? { at: 999999, source: 'serve' } : null,
    probe: async () => { calls += 1; } });
  assert.equal((await refresher.refresh('personal')).cached, true);
  refresher.noteAttempt('pool-example');
  assert.equal((await refresher.refresh('pool-example')).cached, true);
  assert.equal(calls, 0);
});

test('a model-only probe that yields no usage cannot relabel an old snapshot as refreshed', async () => {
  const old = { at: 100, source: 'screen' };
  const refresher = usage.createUsageRefresher({ now: () => 1000000, read: () => old, probe: async () => ['Example'] });
  const result = await refresher.refresh('personal');
  assert.equal(result.ok, false);
  assert.equal(result.entry, old);
  assert.match(result.error, /未读到新的模型用量/);
});

function fakeDocument() {
  const doc = { elements: [], getElementById(id) { return this.elements.find(el => el.id === id); } };
  doc.createElement = tag => {
    const el = { tagName: tag.toUpperCase(), children: [], dataset: {}, listeners: {},
      append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
      addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(name, value) { this[name] = value; },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
    doc.elements.push(el);
    return el;
  };
  doc.head = doc.createElement('head'); doc.body = doc.createElement('body');
  return doc;
}

test('quota row is a keyboard-accessible panel entry without Credit countdown text', () => {
  const document = fakeDocument();
  const host = document.createElement('div'); host.id = 'rail-codeagent-quota';
  let clock = 1000000;
  const bar = createCodeAgentQuotaBar({ document, now: () => clock });
  bar.setUsage({ personal: { ...serve.toUsageSnapshot(servedRead()), label: '个人账号', at: clock + 600000,
    credit: { busyDay: { used: '1', total: '99', pct: 1 }, idleDiscountIn: '1小时', idleDiscount: '2折', idleDiscountUntil: clock + 1800000 } } });
  assert.match(host.innerHTML, /role="button" tabindex="0" aria-haspopup="dialog"/);
  assert.match(host.innerHTML, /data-usage-key="personal"/);
  assert.doesNotMatch(host.innerHTML, /还有30分|Credit/);
  assert.equal(typeof host.listeners.click, 'function');
  assert.equal(typeof host.listeners.keydown, 'function');
  clock += 1800000;
  bar.render();
  assert.doesNotMatch(host.innerHTML, /还有/);
});

test('panel separates Credit and Token, shows observed source/time, and escapes model data', () => {
  const snapshot = serve.toUsageSnapshot(servedRead());
  snapshot.models[0].name = '<Example>';
  const html = usageDetailsHtml({ ...snapshot, at: 1000000, source: 'serve' });
  assert.match(html, /<h3>Credit<\/h3>/);
  assert.match(html, /<h3>Token<\/h3>/);
  assert.match(html, /今日忙时.*0\.76 \/ 12345/);
  assert.match(html, /今日闲时.*1\.25 \/ 23456/);
  assert.match(html, /本月.*9\.5 \/ 345678/);
  assert.match(html, /35\.44M \/ 400M/);
  assert.match(html, /75K \/ 2M/);
  assert.match(html, /title="CodeAgent serve 接口">更新于 \d{2}:\d{2}/);
  assert.match(html, /&lt;Example&gt;/);
  assert.doesNotMatch(html, /<Example>|共用配额/);
});

test('opening the panel immediately paints cached data, refreshes, and retains original readings on IPC failure', async () => {
  const document = fakeDocument();
  const entry = { ...serve.toUsageSnapshot(servedRead()), at: 1000000, source: 'screen' };
  let fail = false;
  const requests = [];
  const panel = createCodeAgentUsagePanel({ document, usageFor: () => entry, ipcRenderer: { invoke: async (channel, payload) => {
    requests.push([channel, payload]); if (fail) throw new Error('连接中断'); return { ok: false, error: 'serve 与菜单均不可用', entry };
  } } });
  const opening = panel.open({ key: 'personal', label: '个人账号' });
  const body = document.elements.find(el => el.innerHTML?.includes('<h3>Credit</h3>'));
  assert.match(body.innerHTML, /35\.44M \/ 400M/);
  await opening;
  const status = document.elements.find(el => el.role === 'status');
  assert.equal(status.textContent, '刷新失败：serve 与菜单均不可用');
  assert.match(body.innerHTML, /CodeAgent \/model 菜单/);
  const oldHtml = body.innerHTML;
  fail = true;
  await panel.open({ key: 'personal', label: '个人账号' });
  assert.equal(body.innerHTML, oldHtml);
  assert.match(status.textContent, /连接中断/);
  assert.deepEqual(requests[0], ['codeagent:usage-refresh', { key: 'personal', label: '个人账号' }]);
  assert.equal(document.elements.filter(el => el.tagName === 'DIALOG').length, 1);
});

test('clicking a quota row or pressing Enter opens the panel for that row account', async () => {
  const document = fakeDocument();
  const host = document.createElement('div'); host.id = 'rail-codeagent-quota';
  const snapshot = { ...serve.toUsageSnapshot(servedRead()), label: '测试账号', at: 1000000, source: 'screen' };
  const requests = [];
  const bar = createCodeAgentQuotaBar({ document, ipcRenderer: { invoke: async (channel, payload) => {
    requests.push([channel, payload]); return { ok: true, cached: true, entry: snapshot };
  } } });
  bar.setUsage({ 'pool-example': snapshot });
  const row = { dataset: { usageKey: 'pool-example', usageLabel: '测试账号' } };
  host.contains = node => node === row;
  const target = { closest: () => row };
  host.listeners.click({ type: 'click', target, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(document.elements.find(el => el.tagName === 'DIALOG').open, true);
  host.listeners.keydown({ type: 'keydown', key: 'ArrowDown', target, preventDefault() {} });
  assert.equal(requests.length, 1);
  host.listeners.keydown({ type: 'keydown', key: 'Enter', target, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], ['codeagent:usage-refresh', { key: 'pool-example', label: '测试账号' }]);
});

test('a late refresh for the previous account never overwrites a newly opened account', async () => {
  const document = fakeDocument(), pending = new Map();
  const panel = createCodeAgentUsagePanel({ document, ipcRenderer: { invoke: (_channel, payload) => new Promise(resolve => pending.set(payload.key, resolve)) } });
  const first = panel.open({ key: 'first', label: '第一个测试账号' });
  const second = panel.open({ key: 'second', label: '第二个测试账号' });
  const nextEntry = { models: [{ name: 'Second-Model', day: { used: '1', total: '100', pct: 1 } }], at: 1000, source: 'screen' };
  pending.get('second')({ ok: true, entry: nextEntry });
  await second;
  pending.get('first')({ ok: true, entry: { models: [{ name: 'First-Model', day: { used: '1', total: '100', pct: 1 } }], at: 2000, source: 'serve' } });
  await first;
  const body = document.elements.find(el => el.innerHTML?.includes('<h3>Credit</h3>'));
  assert.match(body.innerHTML, /Second-Model/);
  assert.doesNotMatch(body.innerHTML, /First-Model/);
});

function ipcFixture(t, { serveRead, menuRead }) {
  const dir = tempData(t);
  const vars = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: path.join(dir, 'fake-cli'), AI_HUB_CODEAGENT_SERVE: '1' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const handlers = new Map(), events = [];
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [] },
    sendToRenderer: (...args) => events.push(args), codeagentServeRead: serveRead, codeagentProbeModels: menuRead,
  });
  return { dir, handlers, events };
}

test('quota IPC reads account defaults from local configuration once per cache window without probing', async t => {
  let reads = 0;
  const fixture = ipcFixture(t, {
    serveRead: async () => { reads += 1; throw new Error('unexpected serve'); },
    menuRead: async () => { reads += 1; throw new Error('unexpected menu'); },
  });
  const cfg = process.env.AI_HUB_CODEAGENT_CONFIG_DIR;
  fs.mkdirSync(cfg, { recursive: true });
  const config = id => fs.writeFileSync(path.join(cfg, '.cac.json'), JSON.stringify({ enterpriseModelOptionsCache: [id] }));
  config('GLM-5.2');
  usage.recordUsage(fixture.dir, 'personal', { models: [{ name: 'GLM-5.2', day: { pct: 2 } }] }, { label: '个人账号' });
  const read = () => fixture.handlers.get('codeagent:usage')(null);
  const first = read(); assert.equal(first.defaultModels.personal, 'GLM-5.2');
  config('DeepSeek-V4.1');
  const cached = read(); assert.equal(cached.defaultModels.personal, 'GLM-5.2'); assert.equal(cached.defaultModels, first.defaultModels);
  await new Promise(setImmediate); assert.equal(reads, 0);
});

test('real usage-refresh IPC falls back from an unavailable serve to menu usage and retains per-account throttling', async t => {
  let serves = 0, menus = 0;
  const snapshot = serve.toUsageSnapshot(servedRead());
  const fixture = ipcFixture(t, {
    serveRead: async () => { serves += 1; return { ok: false, error: 'serve 不可用' }; },
    menuRead: async () => { menus += 1; return { ok: true, models: ['Example-V4.1-Flash-128K'], usage: snapshot }; },
  });
  const refresh = payload => fixture.handlers.get('codeagent:usage-refresh')(null, payload);
  const first = await refresh({ label: '个人账号' });
  assert.equal(first.ok, true);
  assert.equal(first.key, 'personal');
  assert.equal(first.entry.source, 'probe');
  assert.equal(first.entry.models[0].day.used, '35.44M');
  assert.equal(first.entry.label, '个人账号');
  const second = await refresh({ key: 'personal' });
  assert.equal(second.cached, true);
  assert.equal(second.entry.at, first.entry.at);
  assert.equal(serves, 1); assert.equal(menus, 1);
  assert.ok(fixture.events.some(([name]) => name === 'codeagent-usage-changed'));
  const invalid = await refresh({ key: 'missing-account' });
  assert.equal(invalid.ok, false);
  assert.equal(serves, 1);
});

test('real usage-refresh IPC keeps the previous data/time if serve and menu both fail', async t => {
  const fixture = ipcFixture(t, {
    serveRead: async () => ({ ok: false, error: 'serve 不可用' }),
    menuRead: async () => ({ ok: false, error: '菜单无法读取' }),
  });
  usage.recordUsage(fixture.dir, 'personal', serve.toUsageSnapshot(servedRead()), { now: 123, source: 'screen', label: '个人账号' });
  const refresh = fixture.handlers.get('codeagent:usage-refresh');
  const result = await refresh(null, { key: 'personal' });
  assert.equal(result.ok, false);
  assert.equal(result.entry.at, 123);
  assert.equal(result.entry.source, 'screen');
  assert.equal(result.entry.credit.busyDay.total, '12345');
  assert.match(result.error, /菜单无法读取/);
  assert.equal((await refresh(null, { key: 'personal' })).ok, false);
});

test('opening the model menu after a failed panel refresh cannot bypass its ten-minute cooldown', async t => {
  let calls = 0;
  const fixture = ipcFixture(t, {
    serveRead: async () => { calls += 1; return { ok: false, error: 'serve 不可用' }; },
    menuRead: async () => ({ ok: false, error: '菜单无法读取' }),
  });
  const file = require('../core/codeagent-pool').personalModelsFile(fixture.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ models: ['Example-V4.1-Flash-128K'], source: 'serve', at: '2000-01-01T00:00:00.000Z' }));
  await fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal' });
  const models = fixture.handlers.get('codeagent:models')(null, { account: 'personal' });
  assert.ok(models.options.some(option => option.id === 'Example-V4.1-Flash-128K'));
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});

test('panel and existing model probe share one in-flight account probe and serve snapshot conversion', async t => {
  let calls = 0;
  const fixture = ipcFixture(t, {
    serveRead: async () => { calls += 1; return servedRead(); },
    menuRead: async () => { throw new Error('不应回退到菜单'); },
  });
  const probe = fixture.handlers.get('codeagent-pool:probe')(null, { id: 'personal' });
  const panel = fixture.handlers.get('codeagent:usage-refresh')(null, { key: 'personal' });
  await probe;
  const result = await panel;
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.entry.source, 'serve');
  assert.equal(result.entry.credit.monthly.total, '345678');
});

test('real copied menu parses Token windows, range coefficient, load and an active idle discount', () => {
  const parsed = usage.parseCodeAgentUsageMenu(REAL_USAGE);
  assert.equal(parsed.models.length, 1);
  assert.deepEqual(parsed.models[0], { name: 'GLM-5.2-WX-Auto', factor: '0-1x',
    day: { used: '6.78M', total: '400M', pct: 1.7 }, hour: { used: '415.29K', total: '200M', pct: 0.21 },
    min: { used: '313.29K', total: '1M', pct: 31.33 }, load: '低负载' });
  assert.equal(parsed.credit.idleDiscount, '2折');
  assert.equal(parsed.credit.idleDiscountIn, null);
  assert.equal(parsed.credit.idleDiscountActive, true);
});

test('usage wait reads later frames without writes, and skips waiting when Token is already visible', async () => {
  let clock = 1000, reads = 0;
  const result = await usage.readUsageMenu(EARLY_USAGE, { timeoutMs: usage.PICKER_USAGE_WAIT_MS,
    now: () => clock, sleep: async ms => { clock += ms; }, readLines: async () => { reads += 1; return clock >= 1240 ? REAL_USAGE : EARLY_USAGE; } });
  assert.equal(clock, 1240);
  assert.equal(reads, 3);
  assert.equal(result.usage.models[0].day.used, '6.78M');
  assert.equal(result.usage.modelsRead.status, 'read');
  await usage.readUsageMenu(REAL_USAGE, { readLines: () => { throw new Error('must not read or wait'); }, sleep: () => { throw new Error('must not wait'); } });
});

test('picker timeout diagnoses only the menu and retains previous Token data and its observation time', async t => {
  const dir = tempData(t);
  const old = usage.recordUsage(dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'screen', now: 100 });
  let clock = 1000;
  const result = await usage.readUsageMenu(['private prompt', ...EARLY_USAGE, MENU_FOOTER, 'private answer'], {
    dataDir: dir, source: 'picker', timeoutMs: usage.PICKER_USAGE_WAIT_MS, now: () => clock,
    sleep: async ms => { clock += ms; }, readLines: async () => ['private prompt', ...EARLY_USAGE, MENU_FOOTER, 'private answer'],
  });
  assert.equal(clock, 2500);
  assert.equal(result.usage.modelsRead.diagnostic, true);
  const entry = usage.recordUsage(dir, 'personal', result.usage, { source: 'picker:launch', now: clock });
  assert.deepEqual(entry.models, old.models);
  assert.equal(entry.modelsAt, 100);
  assert.equal(entry.creditAt, 2500);
  assert.equal(entry.modelsRead.status, 'unrecognized');
  const nameOnly = usage.recordUsage(dir, 'personal', { models: [{ name: 'Incomplete' }] }, { now: 3000 });
  assert.deepEqual(nameOnly.models, old.models);
  assert.equal(nameOnly.modelsAt, 100);
  const diagnostic = fs.readFileSync(path.join(dir, 'logs', 'codeagent-usage-menu.log'), 'utf8');
  assert.doesNotMatch(diagnostic, /private prompt|private answer|Navigate/);
  const [header, ...rawLines] = diagnostic.split('\n').slice(0, -1);
  const row = JSON.parse(header);
  assert.deepEqual(rawLines, EARLY_USAGE);
  assert.equal(row.lineCount, EARLY_USAGE.length);
  assert.equal(row.at, new Date(2500).toISOString());
  assert.equal(row.source, 'picker');
});

test('probe Token wait is capped at five seconds and a first unreadable menu differs from never read', async t => {
  const dir = tempData(t);
  let clock = 0;
  const result = await usage.readUsageMenu(EARLY_USAGE, { dataDir: dir, source: 'probe', timeoutMs: usage.PROBE_USAGE_WAIT_MS,
    now: () => clock, sleep: async ms => { clock += ms; }, readLines: async () => EARLY_USAGE });
  assert.equal(clock, 5000);
  const first = usage.recordUsage(dir, 'personal', result.usage, { source: 'probe', now: clock });
  assert.equal(first.modelsAt, null);
  assert.equal(first.modelsRead.at, 5000);
  assert.match(usageDetailsHtml(first), /<td colspan="5">未读取<\/td>/);
  assert.match(usageDetailsHtml(null), /<td colspan="5">未读取<\/td>/);
});

test('usage diagnostic deduplicates across sources, caps lines, rotates, and is included by one-click feedback', t => {
  const dir = tempData(t), file = path.join(dir, 'logs', 'codeagent-usage-menu.log');
  const lines = ['outside', ...EARLY_USAGE, MENU_FOOTER, 'outside again'];
  assert.equal(usage.appendUsageDiagnostic(dir, lines, { source: 'picker', now: 1 }), true);
  const once = fs.readFileSync(file, 'utf8');
  assert.equal(usage.appendUsageDiagnostic(dir, lines, { source: 'screen', now: 2 }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  assert.equal(usage.usageMenuLines(['outside', ...Array.from({ length: 60 }, (_, i) => i ? `row ${i}` : 'Credit用量')]).length, 40);
  fs.writeFileSync(file, 'x'.repeat(usage.USAGE_LOG_MAX_BYTES - 1));
  assert.equal(usage.appendUsageDiagnostic(dir, [...EARLY_USAGE, 'new menu format', MENU_FOOTER], { source: 'probe', now: 3 }), true);
  assert.ok(fs.statSync(file).size < usage.USAGE_LOG_MAX_BYTES);
  assert.equal(fs.statSync(file + '.1').size, usage.USAGE_LOG_MAX_BYTES - 1);
  const bundle = require('../core/hub-feedback').collectBundle({ logsDir: path.join(dir, 'logs') });
  assert.match(bundle.text, /codeagent-usage-menu.log/);
  assert.match(bundle.text, /new menu format/);
  assert.doesNotMatch(bundle.text, /outside/);
});

test('active idle discount clears the former countdown and remains in the full panel only', t => {
  const dir = tempData(t);
  usage.recordUsage(dir, 'personal', { credit: { idleDiscountIn: '1小时', idleDiscount: '2折' } }, { now: 1000 });
  const entry = usage.recordUsage(dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'picker:launch', label: '个人账号', now: 2000 });
  assert.equal(entry.credit.idleDiscountUntil, null);
  assert.equal(entry.credit.idleDiscountIn, null);
  assert.match(usageDetailsHtml(entry), /闲时2折进行中/);
  assert.match(usageDetailsHtml(entry), /title="CodeAgent \/model 菜单">更新于 \d{2}:\d{2}/);
  const document = fakeDocument(), host = document.createElement('div'); host.id = 'rail-codeagent-quota';
  const bar = createCodeAgentQuotaBar({ document, now: () => 2000 });
  bar.setUsage({ personal: entry });
  assert.doesNotMatch(host.innerHTML, /闲时2折进行中|Credit/);
});

test('every panel refresh logs read, cooldown skip, or failure without needing serve enabled', async t => {
  let calls = 0;
  const fixture = ipcFixture(t, { serveRead: async () => { throw new Error('serve must stay disabled'); },
    menuRead: async () => { calls += 1; return { ok: true, models: ['GLM-5.2-WX-Auto'], usage: usage.parseCodeAgentUsageMenu(REAL_USAGE) }; } });
  process.env.AI_HUB_CODEAGENT_SERVE = '0';
  const refresh = fixture.handlers.get('codeagent:usage-refresh');
  const read = await refresh(null, { key: 'personal' });
  assert.equal(read.outcome, 'read');
  assert.equal((await refresh(null, { key: 'personal' })).outcome, 'skipped');
  assert.equal((await refresh(null, { key: 'nonexistent' })).outcome, 'failed');
  assert.equal(calls, 1);
  const rows = fs.readFileSync(path.join(fixture.dir, 'logs', 'codeagent-model.log'), 'utf8').trim().split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[0], /event=usage-refresh result=read/);
  assert.match(rows[1], /result=skipped reason=10 分钟冷却/);
  assert.match(rows[2], /result=failed reason=找不到/);
});

test('panel reports a fresh read, cooldown skip and a diagnosed unrecognized menu', async () => {
  const document = fakeDocument();
  let result = { ok: true, outcome: 'read', entry: { ...usage.parseCodeAgentUsageMenu(REAL_USAGE), at: 1000, source: 'probe' } };
  const panel = createCodeAgentUsagePanel({ document, ipcRenderer: { invoke: async () => result }, now: () => 1000 });
  const opening = panel.open({ key: 'personal' });
  const status = document.elements.find(el => el.role === 'status');
  assert.equal(status.textContent, '刷新中…');
  await opening;
  assert.equal(status.textContent, '');
  result = { ...result, outcome: 'skipped', cached: true, reason: '10 分钟冷却' };
  await panel.open({ key: 'personal' });
  assert.equal(status.textContent, '10 分钟内已刷新');
  result = { ok: false, outcome: 'failed', entry: { ...result.entry, modelsRead: { status: 'unrecognized', diagnostic: true } } };
  await panel.open({ key: 'personal' });
  assert.equal(status.textContent, '未识别到 Token，已记录诊断');
  result.entry.modelsRead.diagnostic = false;
  await panel.open({ key: 'personal' });
  assert.equal(status.textContent, '未识别到 Token');
});

test('usage panel keeps short headings and times, with source and Stats details only on hover', async () => {
  const entry = { ...usage.parseCodeAgentUsageMenu(REAL_USAGE), at: 1000, source: 'screen' };
  const html = usageDetailsHtml(entry);
  const visible = html.replace(/<[^>]*>/g, '');
  assert.match(html, /<th>用量<\/th>/);
  assert.match(html, /<th>今日<\/th><th>本小时<\/th>/);
  assert.match(visible, /更新于 \d{2}:\d{2}/);
  assert.doesNotMatch(visible, /读取时间：|来源：|CodeAgent \/model 菜单|计费额度|模型用量|已用 \/ 上限/);
  const document = fakeDocument();
  const panel = createCodeAgentUsagePanel({ document, ipcRenderer: { invoke: async () => ({ ok: true }) } });
  await panel.open({ key: 'personal', stats: { bucket: '月度', remaining: 80, total: 100, at: 1000 } });
  const body = document.elements.find(el => el.innerHTML?.includes('<h3>Credit</h3>'));
  assert.match(body.title, /上次 Stats 面板读数：月度剩余 80 \/ 100/);
  assert.equal(body.children.length, 0, 'the Stats reading must not add a visible paragraph');
  assert.equal(document.elements.find(el => el.role === 'status').textContent, '');
  const allVisible = document.elements.map(el => el.textContent || '').join('\n') + body.innerHTML.replace(/<[^>]*>/g, '');
  assert.doesNotMatch(allVisible, /Credit 是计费额度|三档 Credit|不相加|保留上次|尚无用量快照|显示上次读数|下次可刷新|已读取最新|尚未读取到|上次 Stats/);
});

test('missing usage source omits the title attribute instead of showing a placeholder', () => {
  for (const source of [undefined, '', 'unknown']) {
    const html = usageDetailsHtml({ ...usage.parseCodeAgentUsageMenu(REAL_USAGE), at: 1000, source });
    const captions = html.match(/<p class="ca-usage-meta"[^>]*>[^<]*<\/p>/g);
    assert.equal(captions.length, 2);
    for (const caption of captions) {
      assert.match(caption, /更新于 \d{2}:\d{2}/);
      assert.doesNotMatch(caption, /title=/);
    }
    assert.doesNotMatch(html, /来源未记录/);
  }
});

test('quota hover contains only account, update time and details entry; no Credit countdown remains', () => {
  const document = fakeDocument(), host = document.createElement('div'); host.id = 'rail-codeagent-quota';
  const at = 1000000;
  const bar = createCodeAgentQuotaBar({ document, now: () => at });
  bar.update({ bucket: '月度', remaining: 80, total: 100, pct: 80 });
  bar.setUsage({ personal: { label: '个人账号', at, source: 'screen', credit: { idleDay: { used: '1', total: '100', pct: 1 }, idleDiscount: '2折', idleDiscountIn: '1小时' } } });
  const title = /aria-label="[^"]*" title="([^"]*)"/.exec(host.innerHTML)[1];
  assert.match(title, /^个人账号 · 更新于 \d{2}:\d{2}\n点击查看详情$/);
  assert.doesNotMatch(title, /读自 CodeAgent 界面|Stats 面板|\/model 菜单|来源|剩余/);
  assert.doesNotMatch(host.innerHTML, /还有|Credit|ca-quota-credit/);
  assert.match(host.innerHTML, /Token 未读取/);
});

function menuVm(file, extraRequire = {}, appended = '') {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, '..', 'core', file), localRequire = createRequire(filename);
  const state = { clock: 1000, timers: [] };
  const DateClock = class extends Date { static now() { return state.clock; } };
  const watchdogs = new Map(); let timerId = 0;
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, Date: DateClock,
    setTimeout: (fn, ms) => {
      const id = ++timerId; state.timers.push(ms);
      if (ms >= require('../core/codeagent-model-probe').COMMANDS_ONLY_TIMEOUT_MS) { watchdogs.set(id, { at: state.clock + ms, fn }); return id; }
      state.clock += ms;
      for (const [key, timer] of watchdogs) if (timer.at <= state.clock) { watchdogs.delete(key); timer.fn(); }
      fn(); return id;
    }, clearTimeout: id => watchdogs.delete(id),
    require: name => name === './codeagent-usage-menu' ? { ...usage, readUsageMenu: (lines, options) => usage.readUsageMenu(lines,
      { ...options, now: () => state.clock, sleep: async ms => { state.clock += ms; } }) } : extraRequire[name] || localRequire(name),
    ...extraRequire.globals,
  });
  new vm.Script(fs.readFileSync(filename, 'utf8') + appended, { filename }).runInContext(context);
  return { api: context.module.exports, state };
}

test('actual picker waits for the Day frame before selecting, with the original cursor movement preserved', async t => {
  const dir = tempData(t), writes = [];
  let selected = false, vmFixture;
  const menu = complete => ['Select model', ...(complete ? REAL_USAGE : EARLY_USAGE),
    '   2. DeepSeek-V4.1-Flash', MENU_FOOTER];
  const screen = { lines: async () => selected ? ['❯ ', '? for shortcuts'] : menu(vmFixture.state.clock >= 1240), dispose() {} };
  vmFixture = menuVm('codeagent-model-picker.js', { globals: { testScreen: screen } }, '\nopenSessionScreen = async () => testScreen;');
  const manager = { writeToSession: (_sid, key) => { writes.push([key, vmFixture.state.clock]); if (key === '\r') selected = true; } };
  const result = await vmFixture.api.pickModel({ manager, sid: 'fake-session', kind: 'codeagent', modelId: 'DeepSeek-V4.1-Flash', dataDir: dir,
    sendToPty: () => { throw new Error('menu already open'); } });
  assert.equal(result.ok, true);
  assert.equal(result.usage.models[0].day.used, '6.78M');
  assert.deepEqual(writes.map(([key]) => key), ['\x1b[B', '\r']);
  assert.equal(writes[0][1], 1240);
});

test('actual probe waits the five-second window before closing its menu and records failure diagnostics', async t => {
  const dir = tempData(t), writes = [];
  let opened = false, exit;
  const screen = { write() {}, lines: async () => opened ? ['Select model', ...EARLY_USAGE, MENU_FOOTER] : ['❯ ', '? for shortcuts'], dispose() {} };
  const proc = { onData: () => ({ dispose() {} }), onExit: fn => { exit = fn; },
    write: text => { writes.push([text, fixture.state.clock]); if (text === '\r') opened = true; }, kill: () => exit() };
  const fixture = menuVm('codeagent-model-probe.js', { './claude-trust-dialog': { createTrustScreen: () => screen } });
  const result = await fixture.api.probeModels({ command: 'fake-codeagent', configDirEnv: 'FAKE_CONFIG_DIR', configDir: path.join(dir, 'config'),
    cwd: path.join(dir, 'cwd'), dataDir: dir, ptyModule: { spawn: () => proc } });
  assert.equal(result.ok, true);
  assert.equal(result.usage.modelsRead.status, 'unrecognized');
  assert.equal(result.usage.modelsRead.diagnostic, true);
  assert.equal(writes.find(([text]) => text === '\x1b')[1] - writes.find(([text]) => text === '\r')[1], 5000);
});

test('a new Day snapshot updates model data, time and source after an incomplete name-only read', t => {
  const dir = tempData(t);
  const first = usage.recordUsage(dir, 'personal', { models: [{ name: 'GLM-5.2-WX-Auto', factor: '0-1x', load: '低负载' }] }, { source: 'picker:launch', now: 1 });
  assert.equal(first.modelsAt, null);
  assert.equal(first.modelsSource, null);
  assert.equal(first.models[0].factor, '0-1x');
  assert.match(usageDetailsHtml(first), /<td colspan="5">未读取<\/td>/);
  const second = usage.recordUsage(dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'probe', now: 2 });
  assert.equal(second.modelsAt, 2);
  assert.equal(second.modelsSource, 'probe');
  assert.equal(second.modelsRead.status, 'read');
  assert.equal(second.models[0].day.used, '6.78M');
});

test('actual picker timeout still selects normally, records diagnostics and retains the previous picker Token snapshot', async t => {
  const dir = tempData(t);
  const old = usage.recordUsage(dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'picker:launch', now: 1 });
  let selected = false, fixture;
  const writes = [];
  const screen = { lines: async () => selected ? ['❯ ', '? for shortcuts'] : ['Select model', ...EARLY_USAGE, MENU_FOOTER], dispose() {} };
  fixture = menuVm('codeagent-model-picker.js', { globals: { testScreen: screen } }, '\nopenSessionScreen = async () => testScreen;');
  const result = await fixture.api.pickModel({ manager: { writeToSession: (_sid, key) => { writes.push([key, fixture.state.clock]); selected = true; } },
    sid: 'test-session', kind: 'codeagent', modelId: 'GLM-5.2-WX-Auto', dataDir: dir });
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [['\r', 2800]]); // 1500 ms usage wait, then the existing 300 ms selection pause
  const next = usage.recordUsage(dir, 'personal', result.usage, { source: 'picker:launch', now: fixture.state.clock });
  assert.deepEqual(next.models, old.models);
  assert.equal(next.modelsAt, 1);
  assert.equal(next.modelsRead.diagnostic, true);
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-usage-menu.log'), 'utf8'), /"source":"picker"/);
});

test('screen recording sends only the menu section to diagnostics and leaves existing Tokens intact', async t => {
  const fixture = ipcFixture(t, { serveRead: async () => { throw new Error('not used'); }, menuRead: async () => { throw new Error('not used'); } });
  usage.recordUsage(fixture.dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'probe', now: 1 });
  const result = fixture.handlers.get('codeagent:usage-record')(null, { key: 'personal', usage: usage.parseCodeAgentUsageMenu(EARLY_USAGE),
    menuLines: usage.usageMenuLines(['secret previous message', ...EARLY_USAGE, MENU_FOOTER, 'secret following message']) });
  assert.equal(result.ok, true);
  const entry = usage.readUsage(fixture.dir).personal;
  assert.equal(entry.modelsAt, 1);
  assert.equal(entry.modelsRead.diagnostic, true);
  const raw = fs.readFileSync(path.join(fixture.dir, 'logs', 'codeagent-usage-menu.log'), 'utf8');
  assert.match(raw, /"source":"screen"/);
  assert.doesNotMatch(raw, /secret/);
});

test('an unrecognized fresh probe is a visible failure, not success with preserved old Token data', async t => {
  const fixture = ipcFixture(t, { menuRead: async options => {
    const result = await usage.readUsageMenu(EARLY_USAGE, { dataDir: options.dataDir, source: 'probe' });
    return { ok: true, models: ['GLM-5.2-WX-Auto'], usage: result.usage };
  }, serveRead: async () => { throw new Error('not enabled'); } });
  process.env.AI_HUB_CODEAGENT_SERVE = '0';
  usage.recordUsage(fixture.dir, 'personal', usage.parseCodeAgentUsageMenu(REAL_USAGE), { source: 'screen', now: 1 });
  const refresh = fixture.handlers.get('codeagent:usage-refresh');
  const result = await refresh(null, { key: 'personal' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.entry.modelsAt, 1);
  assert.equal(result.entry.modelsRead.diagnostic, true);
  const second = await refresh(null, { key: 'personal' });
  assert.equal(second.outcome, 'skipped');
  assert.equal(second.ok, false);
  assert.match(fs.readFileSync(path.join(fixture.dir, 'logs', 'codeagent-model.log'), 'utf8'), /result=failed reason=菜单格式未能识别/);
});

test('usage diagnostic refuses an oversized entry and stops at a following prompt without a footer', t => {
  const dir = tempData(t);
  assert.deepEqual(usage.usageMenuLines([...EARLY_USAGE, '❯ private input', 'private answer']), EARLY_USAGE);
  assert.equal(usage.appendUsageDiagnostic(dir, ['Credit用量', 'x'.repeat(usage.USAGE_LOG_MAX_BYTES)]), false);
  assert.equal(fs.existsSync(path.join(dir, 'logs', 'codeagent-usage-menu.log')), false);
});

test('legacy name-only model timestamps are not reported as successful Token observations', t => {
  const dir = tempData(t), file = usage.usageFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ accounts: { personal: { models: [{ name: 'Example', factor: '0x' }], modelsAt: 100, modelsSource: 'screen', at: 100 } } }));
  const entry = usage.recordUsage(dir, 'personal', { credit: { idleDay: { used: '1', total: '100', pct: 1 } } }, { now: 200, source: 'picker:launch' });
  assert.deepEqual(entry.models, [{ name: 'Example', factor: '0x' }]);
  assert.equal(entry.modelsAt, null);
  assert.equal(entry.modelsSource, null);
  assert.match(usageDetailsHtml(entry), /<h3>Token<\/h3><div class="ca-usage-table">/);
});

test('usage dialog and all its controls explicitly exclude window dragging', async () => {
  const document = fakeDocument();
  const panel = createCodeAgentUsagePanel({ document, ipcRenderer: { invoke: async () => ({ ok: true }) } });
  await panel.open({ key: 'personal' });
  const style = document.elements.find(element => element.tagName === 'STYLE');
  assert.match(style.textContent, /\.ca-usage-dialog\s*,\s*\.ca-usage-dialog\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/);
  const dialog = document.elements.find(element => element.tagName === 'DIALOG');
  const close = document.elements.find(element => element.tagName === 'BUTTON' && element.textContent === '关闭');
  close.listeners.click();
  assert.equal(dialog.open, false);
});
