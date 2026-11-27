'use strict';
// 模型名统一对照（core/model-name-match.js）及其接入点：CodeAgent 模型菜单选择、启动前固定模型、组队招成员。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const match = require('../core/model-name-match');

const MENU = ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)', 'DeepSeek-V4.1-Flash-1017', 'MiniMax-M2.7'];
const MENU_LINES = ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2(Tencent-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)', 'MiniMax-M2.7'];
const FOOTER = 'Navigate ↑ ↓ | Select enter | Back esc';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('三种写法都对到菜单上的同一行：线路前缀、内部 id、菜单显示名', () => {
  for (const want of ['GLM-5.2(Volcano-MaaS)', 'ascend/GLM-5.2(Volcano-MaaS)', 'maas-glm-5.2-volcengine-codeagent', 'glm-5.2 （volcano-maas）']) {
    const hit = match.resolveName(want, MENU);
    assert.equal(hit.index, 0, want);
    assert.equal(hit.name, 'GLM-5.2(Volcano-MaaS)');
    assert.notEqual(hit.kind, 'similar', `${want} 是同一模型，不该算相近替代`);
  }
  assert.equal(match.sameModel('maas-glm-5.2-volcengine-codeagent', 'GLM-5.2(Volcano-MaaS)'), true);
  assert.equal(match.sameModel('ascend/GLM-5.2-WX-Auto', 'GLM-5.2-WX-Auto'), true);
});

test('不同模型不会被当成同一个：Auto 与非 Auto、不同线路、不同版本', () => {
  assert.equal(match.sameModel('GLM-5.2-WX', 'GLM-5.2-WX-Auto'), false);
  assert.equal(match.sameModel('GLM-5.2(Volcano-MaaS)', 'GLM-5.2(Tencent-MaaS)'), false);
  assert.equal(match.sameModel('GLM-5.2', 'GLM-5.3'), false);
  assert.equal(match.resolveName('GLM-5.3-Auto(Volcano-MaaS)', MENU).index, -1, '不开相近替代时查不到就是查不到');
});

test('已知目录（内部 id ↔ 显示名）优先于词元推导', () => {
  const catalog = [{ id: 'maas-zhipu-next-codeagent', label: 'GLM-5.2(Volcano-MaaS)' }];
  const hit = match.resolveName('maas-zhipu-next-codeagent', MENU, { catalog });
  assert.deepEqual([hit.index, hit.kind], [0, 'catalog']);
  assert.deepEqual(match.spellings('GLM-5.2(Volcano-MaaS)', catalog), ['GLM-5.2(Volcano-MaaS)', 'maas-zhipu-next-codeagent']);
});

test('前几个字母相同不算同一模型，只认明确列出的供应商别名', () => {
  assert.equal(match.sameModel('Qwen3-Coder', 'Qwen3-Code'), false);
  assert.equal(match.sameModel('DeepSeek-V4', 'DeepSpeed-V4'), false);
  assert.equal(match.sameModel('GLM-5.2(Volcano-MaaS)', 'GLM-5.2(Volcengine)'), true);
  assert.equal(match.sameModel('GLM-5.2(Tencent-MaaS)', 'GLM-5.2(TencentCloud)'), true);
});

test('相近替代只在同家族、同版本、Auto 一致且唯一最接近时成立', () => {
  const menu = ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)'];
  const hit = match.resolveName('GLM-5.2-WX', menu, { allowSimilar: true });
  assert.deepEqual([hit.kind, hit.name], ['similar', 'GLM-5.2(Volcano-MaaS)'], '同版本、都不是 Auto 的唯一一行');
  assert.match(match.substitutionNote('GLM-5.2-WX', hit.name), /已改用最接近的 GLM-5\.2\(Volcano-MaaS\)/);
  assert.equal(match.resolveName('GLM-5.2-Auto', menu, { allowSimilar: true }).name, 'GLM-5.2-Auto(Tencent-MaaS)');
});

test('跨版本、Auto 与非 Auto 不自动替换，带回同家族清单供说明', () => {
  const cross = match.resolveName('GLM-5.3-Auto(Volcano-MaaS)', MENU, { allowSimilar: true });
  assert.equal(cross.index, -1); assert.equal(cross.kind, 'none');
  assert.deepEqual(cross.sameFamily, ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2-Auto(Tencent-MaaS)']);
  assert.match(match.fallbackNote('GLM-5.3-Auto(Volcano-MaaS)', cross), /版本或 Auto 不同，不自动替换.*沿用账号默认模型/);
  assert.equal(match.resolveName('GLM-5.2', ['GLM-6-Chat'], { allowSimilar: true }).index, -1);
  assert.equal(match.resolveName('Qwen3-Coder', ['Qwen2-Chat'], { allowSimilar: true }).index, -1);
  assert.equal(match.resolveName('GLM-5.2-WX-Auto', ['GLM-5.2(Volcano-MaaS)'], { allowSimilar: true }).index, -1, 'Auto 不换成非 Auto');
  assert.equal(match.resolveName('GLM-5.2-WX', ['GLM-5.2-Auto(Tencent-MaaS)'], { allowSimilar: true }).index, -1, '非 Auto 不换成 Auto');
});

test('同版本多条线路同分且没指定线路时不取第一项', () => {
  const lines = ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2(Tencent-MaaS)'];
  const tie = match.resolveName('GLM-5.2-WX', lines, { allowSimilar: true });
  assert.deepEqual([tie.index, tie.kind], [-1, 'ambiguous']);
  assert.deepEqual(tie.candidates, lines);
  assert.match(match.fallbackNote('GLM-5.2-WX', tie), /多条线路.*没指定线路，沿用账号默认模型/);
  assert.equal(match.resolveName('GLM-5.2-WX(Tencent)', lines, { allowSimilar: true }).name, 'GLM-5.2(Tencent-MaaS)', '指定了线路就按线路选');
});

test('完全没有同家族候选时不替代，并带回可选项', () => {
  const none = match.resolveName('Qwen3-Coder', MENU, { allowSimilar: true });
  assert.equal(none.index, -1);
  assert.equal(none.kind, 'none');
  assert.deepEqual(none.options, MENU);
  assert.equal(match.findSame('', MENU), '');
});

// ---- 接入点：CodeAgent 模型菜单 ----
function menu(ids, cursor = 1) {
  const lines = ['Select model', 'Credit用量', '月度: 1/400000,已用0.1%', '模型名称  Credit消耗系数  Token用量/配额  负载  模型描述', 'Built-in'];
  ids.forEach((id, index) => lines.push(`${cursor === index + 1 ? '❯' : ' '} ${index + 1}. ${id}   0-1x   Day 1M/400M (0.25%)   ● 低负载   description`,
    'Hour 100K/200M (0.05%)', 'Min 1K/1M (0.1%)'));
  return [...lines, FOOTER];
}
function pickerVm(screen) {
  const file = path.join(__dirname, '..', 'core', 'codeagent-model-picker.js'), localRequire = createRequire(file);
  const usage = require('../core/codeagent-usage-menu');
  const state = { clock: 1000 };
  const DateClock = class extends Date { static now() { return state.clock; } };
  const context = vm.createContext({ module: { exports: {} }, process, Buffer, Date: DateClock, screen,
    setTimeout: (fn, ms) => { state.clock += ms; fn(); return 0; }, clearTimeout: () => {},
    require: name => name === './codeagent-usage-menu' ? { ...usage, readUsageMenu: (lines, options) => usage.readUsageMenu(lines,
      { ...options, now: () => state.clock, sleep: async ms => { state.clock += ms; } }) } : localRequire(name) });
  new vm.Script(fs.readFileSync(file, 'utf8') + '\nopenSessionScreen = async () => screen;', { filename: file }).runInContext(context);
  return context.module.exports;
}
async function drive(t, modelId, ids = MENU_LINES) {
  const dir = temp(t); let closed = false, cursor = 1; const writes = [];
  const screen = { lines: async () => closed ? ['❯ ', '? for shortcuts'] : menu(ids, cursor), dispose() {} };
  const result = await pickerVm(screen).pickModel({ manager: { writeToSession: (_sid, key) => {
    writes.push(key);
    if (key === '\x1b[B') cursor = Math.min(ids.length, cursor + 1); if (key === '\x1b[A') cursor = Math.max(1, cursor - 1);
    if (key === '\r' || key === '\x1b') closed = true;
  } }, sid: 'synthetic', kind: 'codeagent', modelId, dataDir: dir });
  return { result, cursor, writes };
}

test('菜单选择：内部 id 选中显示名那一行，不算替代', async t => {
  const { result, cursor } = await drive(t, 'maas-glm-5.2-volcengine-codeagent', MENU);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(cursor, 1);
  assert.equal(result.substituted, undefined);
});

test('菜单选择：带前缀的写法照样选中', async t => {
  const { result, cursor } = await drive(t, 'ascend/MiniMax-M2.7', ['GLM-5.2(Volcano-MaaS)', 'MiniMax-M2.7']);
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(cursor, 2);
});

test('菜单选择：同版本、指定线路的唯一一行时改选它并带回替代说明', async t => {
  const { result, cursor } = await drive(t, 'GLM-5.2-WX(Tencent)');
  assert.equal(result.ok, true, result.technicalReason || result.message);
  assert.equal(cursor, 2);
  assert.equal(result.substituted.from, 'GLM-5.2-WX(Tencent)');
  assert.equal(result.substituted.to, 'GLM-5.2(Tencent-MaaS)');
});

for (const [name, want] of [['跨版本', 'GLM-5.3(Volcano-MaaS)'], ['同版本多条线路没指定线路', 'GLM-5.2-WX']]) test(`菜单选择：${name}时不选，回报沿用账号默认模型`, async t => {
  const { result, writes } = await drive(t, want);
  assert.equal(result.ok, false);
  assert.equal(writes.includes('\r'), false, '没有按回车选任何一行');
  assert.match(result.nameFallback, /沿用账号默认模型/);
  assert.equal(result.message, result.nameFallback);
});

test('菜单选择：没有同家族候选时报错并列出菜单里的可选项', async t => {
  const { result } = await drive(t, 'Qwen3-Coder', MENU);
  assert.equal(result.ok, false);
  assert.match(result.message, /菜单里没有 Qwen3-Coder，这个账号可能没开通它/);
  assert.match(result.technicalReason, /模型菜单里没有 Qwen3-Coder（菜单里有：GLM-5\.2\(Volcano-MaaS\)、/);
});

// ---- 接入点：启动前固定模型、组队招成员 ----
test('启动前固定模型：显示名写法认成账号清单里的内部 id，不再判成「没有权限」', () => {
  const pin = require('../core/session-model-pin');
  const pool = { account: { models: ['maas-glm-5.2-volcengine-codeagent', 'MiniMax-M2.7'], modelsAuthoritative: true } };
  const result = pin.resolveCodeAgentPin({ model: 'GLM-5.2(Volcano-MaaS)', codeagentModelPick: true }, { dataDir: '', configDir: '', command: '', pool });
  assert.equal(result.fixedModel, 'maas-glm-5.2-volcengine-codeagent');
  assert.equal(result.modelChanged, false);
});

function team(t, createSession) {
  const { createTeamService } = require('../main/team/service');
  const dir = temp(t), notices = [];
  const rows = [{ id: 'pool-a', usable: true, models: ['maas-glm-5.2-volcengine-codeagent'], modelsAuthoritative: true }];
  const sessions = new Map([['lead-0001', { id: 'lead-0001', kind: 'codeagent', cwd: dir }]]), created = [];
  const service = createTeamService({ company: true, getHubDataDir: () => dir, getConfig: () => ({}), listAccounts: () => ({ recommendedId: 'pool-a', rows }),
    sessionManager: { getSession: id => sessions.get(id), isAgentTurnActive: () => false }, commandPath: () => path.join(dir, 'hub-team.cmd'),
    sendToRenderer: (channel, payload) => notices.push({ channel, payload }),
    createSession: async request => { created.push(request); const s = await createSession(request); if (s) sessions.set(s.id, s); return s; },
    submitPrompt: async () => ({ ok: true }) });
  t.after(() => { service.freeze(); service.stop(); });
  return { service, created, notices };
}
const plan = model => ({ goal: '目标', members: [{ role: '实现', task: '在临时目录实现', account: 'pool-a', model }] });

test('组队：显示名写法在计划里换成账号清单的写法', async t => {
  const h = team(t, async request => ({ id: 'member-1xxx', kind: request.kind }));
  const p = await h.service.invoke('lead-0001', 'propose', plan('GLM-5.2(Volcano-MaaS)'));
  await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(h.created[0].opts.model, 'maas-glm-5.2-volcengine-codeagent');
});

test('组队：模型没选上时退回账号默认模型建会话，成员照常出现并给一行说明', async t => {
  const h = team(t, async request => {
    if (request.opts.model) throw Object.assign(new Error('原模型 X 不可用'), { code: 'SESSION_MODEL_UNAVAILABLE' });
    return { id: 'member-2xxx', kind: request.kind };
  });
  const p = await h.service.invoke('lead-0001', 'propose', plan('maas-glm-5.2-volcengine-codeagent'));
  const approved = await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(approved.created.length, 1);
  assert.deepEqual(approved.failed, []);
  assert.equal(h.created.length, 2);
  assert.equal(Object.hasOwn(h.created[1].opts, 'model'), false);
  assert.notEqual(h.created[1].opts.codeagentModelPick, true);
  assert.match(approved.modelFallbacks[0], /没选上.*已用账号默认模型建会话/);
  const notice = h.notices.find(n => n.channel === 'session-notice' && n.payload.sessionId === 'member-2xxx');
  assert.ok(notice); assert.notEqual(notice.payload.persistent, true, '一行 toast，不是常驻提示条');
});

for (const message of ['号池账号需要重新登录', 'CodeAgent 启动失败：spawn ENOENT', '工作目录没有写权限']) test(`组队：非模型错误（${message}）原样报出，不退回默认模型重试`, async t => {
  const h = team(t, async () => { throw new Error(message); });
  const p = await h.service.invoke('lead-0001', 'propose', plan('maas-glm-5.2-volcengine-codeagent'));
  const approved = await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(h.created.length, 1, '只建了一次');
  assert.equal(approved.created.length, 0);
  assert.ok(approved.failed[0].includes(message));
  assert.equal(approved.modelFallbacks, undefined);
});

test('组队：模型不可用后默认模型也建不成时才算失败', async t => {
  const h = team(t, async request => {
    if (request.opts.model) throw Object.assign(new Error('原模型 X 不可用'), { code: 'SESSION_MODEL_UNAVAILABLE' });
    throw new Error('号池账号需要重新登录');
  });
  const p = await h.service.invoke('lead-0001', 'propose', plan('maas-glm-5.2-volcengine-codeagent'));
  const approved = await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(approved.created.length, 0);
  assert.match(approved.failed[0], /重新登录/);
});

// ---- 复审补充：启动前自动换模型不自取第一条、熔断不算模型不可用、同一次回退只发一条提示 ----
function pinWith(t, { list, fixed, settingsModel = '' }) {
  const dir = temp(t);
  if (settingsModel) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: settingsModel }));
  const pool = { account: { models: list, modelsAuthoritative: true } };
  return () => require('../core/session-model-pin').resolveCodeAgentPin({ fixedModel: fixed }, { dataDir: '', configDir: dir, command: '', pool });
}
const LINES = ['GLM-5.2(Volcano-MaaS)', 'GLM-5.2(Tencent-MaaS)', 'MiniMax-M2.7'];

test('启动前固定模型：跨版本或多条线路同分且没有默认模型时停下让用户选，不取清单第一条', t => {
  for (const fixed of ['GLM-5.3(Volcano-MaaS)', 'GLM-5.2-WX']) {
    assert.throws(pinWith(t, { list: LINES, fixed }), error => error.code === 'SESSION_MODEL_UNAVAILABLE' && /请选一个模型后继续/.test(error.message), fixed);
  }
});

test('启动前固定模型：有同家族的已确认默认模型时用它；有唯一同版本替代时用替代', t => {
  const viaDefault = pinWith(t, { list: LINES, fixed: 'GLM-5.3(Volcano-MaaS)', settingsModel: 'GLM-5.2(Tencent-MaaS)' })();
  assert.deepEqual([viaDefault.fixedModel, viaDefault.modelChanged], ['GLM-5.2(Tencent-MaaS)', true]);
  const sameVersion = pinWith(t, { list: ['GLM-5.2(Volcano-MaaS)', 'MiniMax-M2.7'], fixed: 'GLM-5.2-WX' })();
  assert.deepEqual([sameVersion.fixedModel, sameVersion.modelChanged], ['GLM-5.2(Volcano-MaaS)', true]);
  assert.throws(pinWith(t, { list: LINES, fixed: 'GLM-5.3(Volcano-MaaS)', settingsModel: 'MiniMax-M2.7' }), /跨家族切换需要手动确认/, '默认模型跨家族不自动换');
});

test('组队：选模型熔断不算模型不可用，原样报出不退回', async t => {
  const h = team(t, async () => { throw Object.assign(new Error('这个账号自动选择模型已暂停'), { code: 'CODEAGENT_MODEL_PICK_BREAKER_OPEN' }); });
  const p = await h.service.invoke('lead-0001', 'propose', plan('maas-glm-5.2-volcengine-codeagent'));
  const approved = await h.service.decide({ leadSid: 'lead-0001', planId: p.planId, approve: true });
  assert.equal(h.created.length, 1);
  assert.equal(approved.created.length, 0);
  assert.match(approved.failed[0], /自动选择模型已暂停/);
});

test('同一次启动回退只由启动选模型的调用方发一条提示', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('async function runCodeAgentPick('), end = source.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start);
  assert.equal(/message: result\.nameFallback/.test(source.slice(start, end)), false, 'runCodeAgentPick 不再自己发回退提示');
  assert.equal((source.match(/result\.nameFallback \?/g) || []).length, 1, '回退提示只在调用方一处拼');
  assert.match(source, /!result\.fallbackNoticed/);
});
