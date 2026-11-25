'use strict';
// 2026-11-25 同事反馈（v5.6.105）：模型菜单明明有 GLM-5.3-CodeAgent-Auto，助理带着供应商去选时判「菜单里没有」，
// 连续 3 次触发 4 小时熔断，助理整段用不了。这里用日志原文里的菜单复现，并锁住：唯一同名行直接选、多条同名仍按分组挑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const picker = require('../core/codeagent-model-picker');

const FOOTER = 'Navigate ↑ ↓ | Select enter | Back esc';
const TARGET = 'GLM-5.3-CodeAgent-Auto';
// 同事日志里的菜单：三行、没有分组标题。
const flat = cursor => ['Select model', '模型名称  Credit消耗系数  Token用量/配额',
  `${cursor === 1 ? '❯' : ' '} 1. Glm-5.3   0x   Day 1M/100M`,
  `${cursor === 2 ? '❯' : ' '} 2. ${TARGET}   0x   Day 1M/100M`,
  `${cursor === 3 ? '❯' : ' '} 3. DeepSeek-V4.1-Flash-1017-CodeAg…   0x   Day 1M/100M`, FOOTER];
// 分组标题和供应商 id 写法不同（菜单写「公司模型」，供应商 id 是 w3）。
const headed = cursor => { const lines = flat(cursor); lines.splice(2, 0, '公司模型'); return lines; };
// 两个分组都有同名行：必须按分组挑，对不上就不选。
const twoGroups = cursor => ['Select model', '模型名称  Credit消耗系数  Token用量/配额', 'max',
  `${cursor === 1 ? '❯' : ' '} 1. ${TARGET}   0x   Day 1M/100M`, 'free',
  `${cursor === 2 ? '❯' : ' '} 2. ${TARGET}   0x   Day 1M/100M`, FOOTER];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-picker-relax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}

async function runPick(t, menu, { provider = 'w3', rows = 3, seed = null } = {}) {
  let clock = 1000, cursor = 1, selected = null, closed = false;
  const file = path.join(__dirname, '../core/codeagent-model-picker.js'), localRequire = createRequire(file), writes = [];
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : menu(cursor), dispose() {} };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, screen,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: fn => { clock += 400; fn(); return 1; }, clearTimeout() {},
    require: name => name === './codeagent-usage-menu' ? { readUsageMenu: async lines => ({ lines, usage: null }), parseCodeAgentUsageMenu: () => null, truncatedNameMatches: localRequire('./codeagent-usage-menu').truncatedNameMatches } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', context);
  const manager = { getSession: () => ({}), writeToSession: (_sid, key) => {
    writes.push(key);
    if (key === '\x1b[B') cursor = Math.min(rows, cursor + 1);
    if (key === '\x1b[A') cursor = Math.max(1, cursor - 1);
    if (key === '\r') { selected = cursor; closed = true; }
    if (key === '\x1b') closed = true;
  } };
  const dataDir = temp(t);
  if (seed) seed(dataDir);
  const result = await context.module.exports.pickModel({ manager, sid: 'relax', kind: 'codeagent', modelId: TARGET,
    provider, providerLabel: provider, dataDir, sendToPty: async () => ({ ok: true }) });
  let log = '';
  try { log = fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8'); } catch { /* 没写日志 */ }
  return { result, selected, writes, log };
}

test('同事日志原样：菜单没有分组、带供应商 w3 也选中唯一同名行', async t => {
  const parsed = picker.parsePicker(flat(1));
  assert.deepEqual(parsed.rows.map(row => row.label), ['Glm-5.3', TARGET, 'DeepSeek-V4.1-Flash-1017-CodeAg…']);
  assert.equal(parsed.rows.some(row => row.group), false);
  // 修复前的判定：带供应商时分组对不上就是 -1（报「菜单里没有」）。
  assert.equal(picker.findTarget(parsed, TARGET, { provider: 'w3' }), -1);
  const { result, selected, log } = await runPick(t, flat);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(selected, 2);
  assert.match(log, /group-relaxed/);
});

test('分组标题写法和供应商 id 不同：完整菜单里唯一同名行照样选中', async t => {
  assert.equal(picker.parsePicker(headed(1)).rows[1].group, '公司模型');
  const { result, selected } = await runPick(t, headed);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(selected, 2);
});

test('两个分组都有同名行而供应商对不上：仍然不选，并标成匹配失败（不计熔断）', async t => {
  const { result, selected, writes } = await runPick(t, twoGroups, { provider: 'missing', rows: 2 });
  assert.equal(result.ok, false);
  assert.equal(selected, null);
  assert.equal(writes.includes('\r'), false);
  assert.equal(result.menuMiss, true);
});

test('两个分组都有同名行、供应商对得上：按分组选', async t => {
  const { result, selected } = await runPick(t, twoGroups, { provider: 'free', rows: 2 });
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(selected, 2);
});

test('匹配失败不计熔断、自动会话照常用当前模型发出；熔断中带供应商的助理会话不再起不来', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  assert.match(handlers, /const matchFailure = !result\.ok && !!\(result\.menuMiss \|\| result\.requiresGroupSelection\);/);
  assert.match(handlers, /if \(\(result\.ok \|\| automatic \|\| pickFirst\) && !matchFailure\) \{/);
  // 自动会话带供应商启动时选不上也照常发，并对带线路的会话说一行没切到哪个模型。
  assert.match(handlers, /isAutomaticCodeAgent\(session\) \|\| session\.codeagentModelProvider\)/);
  // 回退条件按源码原样求值：带供应商的自动会话只在启动/重拉时回退；从错误卡片恢复、切换线路（switch）选不上不能当成功。
  const line = handlers.split(/\r?\n/).find(text => text.trimStart().startsWith('let fallback = ('));
  const expr = line.trim().replace(/^let fallback = /, '').replace(/;$/, '');
  const fallbackFor = ({ reason, automatic = true, selectedProvider = 'w3', pickFirst = false, requiresGroupSelection = false }) => vm.runInNewContext(expr, {
    automatic, pickFirst, selectedProvider, startupPick: reason === 'launch' || reason === 'relaunch',
    result: { ok: false, inputReady: true, inputUsable: true, requiresGroupSelection } });
  assert.equal(fallbackFor({ reason: 'launch' }), true);
  assert.equal(fallbackFor({ reason: 'relaunch' }), true);
  assert.equal(fallbackFor({ reason: 'switch' }), false, '恢复或切换线路选不上不能报成功');
  assert.equal(fallbackFor({ reason: 'model-config-fix' }), false);
  assert.equal(fallbackFor({ reason: 'switch', selectedProvider: '' }), false, '没指定线路的切换选不上也不能报成功');
  assert.equal(fallbackFor({ reason: 'model-config-fix', selectedProvider: '' }), false);
  assert.equal(fallbackFor({ reason: 'launch', selectedProvider: '' }), true, '没指定线路的自动会话启动时照旧能发');
  assert.equal(fallbackFor({ reason: 'switch', selectedProvider: '', automatic: false, pickFirst: true }), true, '选菜单第一个照旧能发');
  assert.equal((handlers.match(/if \(!result \|\| !result\.ok \|\| result\.fallback\) \{/g) || []).length, 2, '切换模型与按清单修复都把回退判成失败');
  assert.equal(fallbackFor({ reason: 'launch', automatic: false }), false, '用户会话指定线路选不上不回退');
  const manager = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  assert.doesNotMatch(manager, /throw Object\.assign\(new Error\(`这个账号自动选择模型已暂停/);
  assert.match(manager, /breaker-open-provider-dropped/);
  assert.match(manager, /自动选模型暂停到 \$\{until\}，这次没切到/);
});

test('搜索结果里唯一同名行分组对不上：直接选，不再按 Esc 清搜索（同事日志 clear-failed）', async t => {
  const DS = 'DeepSeek-V4.1-Flash-1017-CodeAgent';
  let clock = 1000, query = '', cursor = 1, selected = null, closed = false;
  const all = ['Glm-5.3', TARGET, DS];
  const visible = () => query ? all.filter(name => name.toLowerCase().includes(query.toLowerCase())) : all.slice(0, 2);
  const lines = () => ['Select model', `⌕ ${query || 'Search…'}`, '模型名称  Credit消耗系数  Token用量/配额',
    ...visible().map((name, i) => `${cursor === i + 1 ? '❯' : ' '} ${i + 1}. ${name}   0x   Day 1M/100M`), FOOTER];
  const file = path.join(__dirname, '../core/codeagent-model-picker.js'), localRequire = createRequire(file), writes = [];
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : lines(), dispose() {} };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, screen,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: fn => { clock += 400; fn(); return 1; }, clearTimeout() {},
    require: name => name === './codeagent-usage-menu' ? { readUsageMenu: async l => ({ lines: l, usage: null }), parseCodeAgentUsageMenu: () => null, truncatedNameMatches: localRequire('./codeagent-usage-menu').truncatedNameMatches } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', context);
  const manager = { getSession: () => ({}), writeToSession: (_sid, key) => {
    writes.push(key);
    if (key === '\x1b[B') cursor = Math.min(visible().length, cursor + 1);
    else if (key === '\x1b[A') cursor = Math.max(1, cursor - 1);
    else if (key === '\r') { selected = visible()[cursor - 1]; closed = true; }
    else if (key === '\x1b') { if (query) query = ''; else closed = true; cursor = 1; }
    else if (/^\x7f+$/.test(key)) query = query.slice(0, -key.length);
    else { query += key; cursor = 1; }
  } };
  const dataDir = temp(t);
  const result = await context.module.exports.pickModel({ manager, sid: 'search', kind: 'codeagent', modelId: DS,
    provider: 'w3', providerLabel: 'w3', dataDir, sendToPty: async () => ({ ok: true }) });
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(selected, DS);
  assert.equal(writes.includes('\x1b'), false, '找到后不应再按 Esc 清搜索');
  assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-model.log'), 'utf8'), /stage=search/);
});

// 账号清单里这个模型有两个供应商（good / bad）：审查 P1-2 的保护场景。
function seedTwoProviders(dataDir) {
  const serve = require('../core/codeagent-serve'), probe = require('../core/codeagent-model-probe');
  const parsed = serve.parseProviders({ providers: ['good', 'bad'].map(id => ({ id, status: 'available', models: { [TARGET]: { id: TARGET } } })) });
  probe.writeProbed(require('../core/codeagent-pool').personalModelsFile(dataDir), { source: 'serve', models: [TARGET], details: parsed.models });
}
// 滚动过的菜单：带总数提示，只露出前三行。
const scrolled = cursor => { const lines = flat(cursor); lines.splice(lines.length - 1, 0, '3 of 6 models'); return lines; };

test('分组标题写法不同时选中后仍报入参供应商，不把菜单标题写回会话', async t => {
  const { result } = await runPick(t, headed);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(result.provider, 'w3');
});

test('菜单没看全且账号里这个模型有两个供应商：不按唯一可见行选', async t => {
  assert.equal(picker.parsePicker(scrolled(1)).complete, false);
  const { result, selected } = await runPick(t, scrolled, { provider: 'good', seed: seedTwoProviders });
  assert.equal(result.ok, false);
  assert.equal(selected, null);
});

test('唯一同名行的分组是另一个已知供应商：不放宽', async t => {
  const other = cursor => { const lines = flat(cursor); lines.splice(2, 0, 'bad'); return lines; };
  const { result, selected } = await runPick(t, other, { provider: 'good', seed: seedTwoProviders });
  assert.equal(result.ok, false);
  assert.equal(selected, null);
});

test('菜单里确实没有这个模型名：不标匹配失败，照常计入熔断', async t => {
  const without = cursor => flat(cursor).map(line => line.replace(TARGET, 'MiniMax-M3'));
  const { result } = await runPick(t, without);
  assert.equal(result.ok, false);
  assert.equal(result.menuMiss, undefined);
});

test('熔断期暂缓的线路仍算同一条线路，预热与分身不每问重开；自动会话回退后不再核固定模型', t => {
  const route = require('../core/codeagent-assistant-route'), breaker = require('../core/codeagent-auto-pick');
  const dataDir = temp(t), closedDir = temp(t);
  for (let i = 0; i < breaker.THRESHOLD; i += 1) breaker.record(dataDir, 'personal', false, { error: 'x' });
  assert.ok(breaker.openFor(dataDir, 'personal'));
  const wanted = { model: TARGET, codeagentModelProvider: 'w3' };
  const deferred = { codeagentRouteDeferred: route.routeKey(wanted), fixedModel: 'Glm-5.3', modelPinSource: 'created' };
  assert.equal(route.deferredModel(deferred), TARGET.toLowerCase());
  assert.equal(route.matchesSession(deferred, wanted, { dataDir }), true, '熔断开着、线路一致、没换过模型：仍算同一条');
  assert.equal(route.matchesSession(deferred, wanted, { dataDir: closedDir }), false, '熔断解除后换回真实线路');
  assert.equal(route.matchesSession(deferred, wanted), false, '查不到熔断状态时不认暂缓记录');
  assert.equal(route.matchesSession(deferred, null, { dataDir }), false, '线路被清掉不认');
  assert.equal(route.matchesSession(deferred, { model: TARGET, codeagentModelProvider: 'free' }, { dataDir }), false);
  assert.equal(route.matchesSession({ ...deferred, codeagentUserModel: 'Glm-5.3' }, wanted, { dataDir }), false, '会话里真换过模型不认');
  assert.equal(route.matchesSession({ ...deferred, modelPinSource: 'user' }, wanted, { dataDir }), false);
  assert.equal(route.matchesSession({ ...deferred, codeagentBackendSwitch: { from: 'a', actual: 'b' } }, wanted, { dataDir }), false);
  assert.equal(route.matchesSession({}, wanted), false);
  assert.equal(route.matchesSession({}, null), true, '没有暂缓记录、也没有线路的普通会话照旧算匹配');
  const handlersSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  assert.equal((handlersSrc.match(/codeagentRouteDeferred: undefined/g) || []).length, 2, '选上模型、按清单修复模型两处都清掉暂缓记录');
  const manager = fs.readFileSync(path.join(__dirname, '../core/session-manager.js'), 'utf8');
  assert.ok(manager.includes('if (info.codeagentPickFallback) return;'));
  assert.ok(manager.includes('.routeKey({ model: target, codeagentModelProvider: opts.codeagentModelProvider })'));
  const handlers = fs.readFileSync(path.join(__dirname, '../main/ipc/session-handlers.js'), 'utf8');
  assert.ok(handlers.includes('sessionManager.updateSessionMeta(sessionId, { codeagentModelPick: false, codeagentPickFallback: true });'));
});
