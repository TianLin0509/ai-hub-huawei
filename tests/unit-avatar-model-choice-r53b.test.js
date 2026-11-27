'use strict';
// R53b：分身选型收尾。
// - 「账号即模型」（默认模型必须就是指定模型）不管分身：分身按会话在 /model 菜单里选，个人账号与号池号都只核登录与权限；
// - 分身模型卡点名的供应商不被助理同名模型的供应商盖掉；
// - 启动没选上的提示：后台下拉能选、选上（含后台终端手动 /model）后撤掉、选型跑完通知分身页；
// - 账号卡计数、顶栏「模型不可用」可点、试答只核当前分身、设置页覆盖提示（含 Claude Code 外壳线路）。
// R53b: avatar model choice wrap-up.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r53b-avatar-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const DETAILS = [
  { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2-WX-Auto', provider: 'w3', providerLabel: 'Built-in' },
  { id: 'GLM-5.3', label: 'GLM-5.3', provider: 'cannbotprovider', providerLabel: 'cannbotprovider' },
];
function personalFixture(t) {
  const root = temp(t), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(data, 'codeagent-pool', 'personal-models.json'),
    { models: DETAILS.map(d => d.id), details: DETAILS, defaultModel: 'GLM-5.2-WX-Auto', source: 'serve' });
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = data;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
  return { data, personal };
}

test('P0: a personal-account avatar may start on a non-default model', t => {
  const { personal } = personalFixture(t);
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  const base = { codeagentConfigDir: personal, codeagentRouteModel: 'GLM-5.3' };
  const avatar = manager._resolveCodeAgentLaunchAccount('codeagent', { ...base, purpose: 'avatar-agent' }, { id: 'av-1', freshLaunch: true });
  assert.equal(avatar.codeagentPool, null, 'stays on the personal account');
  // 权限照核：清单里没有的模型分身也起不来。
  assert.throws(() => manager._resolveCodeAgentLaunchAccount('codeagent', { ...base, codeagentRouteModel: 'Kimi-K9', purpose: 'avatar-agent' }, { id: 'av-2', freshLaunch: true }), /没有 Kimi-K9 的权限/);
});

test('P0: pool rule, launch target and provider are avatar-aware in session-manager', () => {
  const src = read('core/session-manager.js');
  // 号池号：分身只核权限，不要求默认模型就是指定模型。
  assert.match(src, /if \(routeModel && !routeSwitch && !opts\.codeagentPoolAccount && !routeModelIsAccountDefault\(opts\)\) \{[\s\S]{0,700}没有 \$\{routeModel\} 的权限/);
  // 个人账号分身也选指定的模型，不落回账号默认。
  assert.match(src, /const defaultTarget = hubDefaultTarget \|\| \(opts\.purpose === 'avatar-agent' \? codeAgentRouteModel\(opts\) : ''\) \|\|/);
  // 模型卡点名了供应商时不经助理同名线路改写。
  assert.match(src, /inheritsAssistantChoice\(opts\.featureAgentChoice\)\s*&& !\(opts\.purpose === 'avatar-agent' && opts\.codeagentModelProvider\)/);
});

test('P0: an avatar session started on the card provider is reused, a different provider starts fresh', async t => {
  const dir = temp(t);
  const { AgentSessions } = require('../core/avatar/agent-session');
  const meta = { id: 's1', status: 'running', currentModel: { id: 'GLM-5.3' }, codeagentModelProvider: 'cannbotprovider' };
  // 助理设置里同名模型选的是另一组（w3）：以前 ensure 会按 w3 核对，每问都重开。
  require('../core/codeagent-assistant-route').setFeaturePreference?.(dir, 'assistant', { kind: 'codeagent', model: 'GLM-5.3', codeagentModelProvider: 'w3' });
  let created = 0, closed = false;
  const sessions = new AgentSessions({ dataDir: dir, getSession: id => (id === 's1' && !closed ? meta : null), createSession: async () => { created += 1; return { ok: true }; }, closeSession: async () => { closed = true; } });
  const av = { id: 'a1', name: 'x', backend: { account: 'personal', model: 'GLM-5.3', provider: 'cannbotprovider' }, rulesVersion: 0 };
  const same = await sessions.ensure(av, { id: 's1', questions: 0, rulesVersion: 0 }, dir);
  assert.equal(same.id, 's1');
  assert.equal(created, 0);
  const other = await sessions.ensure({ ...av, backend: { ...av.backend, provider: 'w3' } }, { id: 's1', questions: 0, rulesVersion: 0 }, dir);
  assert.notEqual(other.id, 's1');
  assert.equal(created, 1);
});

test('review P1: when the settings page overrides the avatar model, a stale card provider does not restart the session every turn', async t => {
  const dir = temp(t);
  const choice = require('../core/feature-agent-choice'), keep = choice.stale;
  t.after(() => { choice.stale = keep; });
  choice.stale = () => false;
  const { AgentSessions } = require('../core/avatar/agent-session');
  // 设置页选了 DeepSeek（会话按它跑），模型卡还存着以前选的 GLM-5.3 · cannbotprovider。
  const meta = { id: 's1', status: 'running', currentModel: { id: 'DeepSeek-V4.1-Flash-1017' }, codeagentModelProvider: 'w3',
    featureAgentChoice: JSON.stringify({ kind: 'codeagent', model: 'DeepSeek-V4.1-Flash-1017', codeagentModelProvider: 'w3' }) };
  let created = 0, closed = false;
  const sessions = new AgentSessions({ dataDir: dir, getSession: id => (id === 's1' && !closed ? meta : null), createSession: async () => { created += 1; return { ok: true }; }, closeSession: async () => { closed = true; } });
  const av = { id: 'a1', name: 'x', backend: { account: 'personal', model: 'GLM-5.3', provider: 'cannbotprovider' }, rulesVersion: 0 };
  const again = await sessions.ensure(av, { id: 's1', questions: 1, rulesVersion: 0 }, dir);
  assert.equal(again.id, 's1', 'reused');
  assert.equal(closed, false);
  assert.equal(created, 0);
});

test('review P2-2: a model from settings.json enterprise.providers starts for an avatar (other routed sessions still need the permission list)', t => {
  const { data, personal } = personalFixture(t);
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto', enterprise: { providers: { cannbotprovider: { mainModel: 'Qwen3.8-27B' } } } }));
  const { SessionManager } = require('../core/session-manager');
  const manager = new SessionManager();
  const base = { codeagentConfigDir: personal, codeagentRouteModel: 'Qwen3.8-27B' };
  manager._resolveCodeAgentLaunchAccount('codeagent', { ...base, purpose: 'avatar-agent' }, { id: 'av-q', freshLaunch: true });
  // 固定会话模型：权威清单里没有，但自配供应商有，不判「没有使用权限」。
  const pin = require('../core/session-model-pin').resolveCodeAgentPin({ fixedModel: 'Qwen3.8-27B' }, { dataDir: data, configDir: personal, command: '' });
  assert.equal(pin.fixedModel, 'Qwen3.8-27B');
  assert.equal(pin.modelChanged, false);
  assert.match(read('core/session-manager.js'), /!account\.models\.some\(m => m\.toLowerCase\(\) === routeModel\.toLowerCase\(\)\)\s*&& !require\('\.\/codeagent-models'\)\.settingsProviderModels\(account\.dir\)/);
});

test('P0: avatar personal row lists every model as selectable; falls back to the account list before any probe', t => {
  const { data, personal } = personalFixture(t);
  const { listAvatarBackends } = require('../main/ipc/avatar-handlers');
  const env = { ...process.env, AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(data, 'scan') };
  const sm = { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) };
  const me = listAvatarBackends({ dataDir: data, env, sessionManager: sm }).rows.find(r => r.id === 'personal');
  assert.equal(me.options.some(o => o.unavailable), false, 'no grey-out');
  assert.deepEqual(me.models.slice().sort(), ['GLM-5.2-WX-Auto', 'GLM-5.3']);
  // 没探测过目录（带供应商的选项为空）时按号自己的模型清单兜底，不只剩默认模型一个。
  const routes = require('../core/codeagent-assistant-route'), route = require('../core/codeagent-model-route');
  const keep = { modelOptions: routes.modelOptions, personalAccount: route.personalAccount };
  t.after(() => { routes.modelOptions = keep.modelOptions; route.personalAccount = keep.personalAccount; });
  routes.modelOptions = () => [];
  route.personalAccount = () => ({ models: ['GLM-5.2-WX-Auto', 'DeepSeek-V4.1-Flash-1017'], defaultModel: 'GLM-5.2-WX-Auto' });
  const bare = listAvatarBackends({ dataDir: data, env, sessionManager: sm }).rows.find(r => r.id === 'personal');
  assert.deepEqual(bare.models, ['GLM-5.2-WX-Auto', 'DeepSeek-V4.1-Flash-1017']);
});

test('P1: a pick miss clears once the wanted model answers; provider misses need a different model than the fallback', () => {
  const { pickMissResolved } = require('../core/avatar/agent-session');
  const plain = { codeagentPickMiss: { want: 'GLM-5.3', model: 'GLM-5.3', using: 'GLM-5.2-WX-Auto' } };
  assert.equal(pickMissResolved(plain, 'glm-5.3'), true);
  assert.equal(pickMissResolved(plain, 'GLM-5.2-WX-Auto'), false);
  assert.equal(pickMissResolved({}, 'GLM-5.3'), false);
  const grouped = { codeagentPickMiss: { want: 'GLM-5.3 · cannbotprovider', model: 'GLM-5.3', provider: 'cannbotprovider', using: 'GLM-5.3' } };
  assert.equal(pickMissResolved(grouped, 'GLM-5.3'), false, 'same name from the other group is not proof');
  assert.equal(pickMissResolved({ codeagentPickMiss: { ...grouped.codeagentPickMiss, using: 'GLM-5.2-WX-Auto' } }, 'GLM-5.3'), true);
});

test('P1: backstage dropdown is open for a missed avatar session; every successful pick clears the miss and refreshes the avatar page', () => {
  const src = read('main/ipc/session-handlers.js');
  assert.match(src, /const automatic = isAutomaticCodeAgent\(session\) && !session\.modelConfirmationRequired && !session\.codeagentPickMiss;/);
  assert.match(src, /reason === 'switch' && \(session\.codeagentModelPick === true \|\| selection\.recovery === true \|\| !!session\.codeagentPickMiss\)/);
  // runCodeAgentPick、fixCodeAgentModel、serve 切换、settings-only 四处成功都清。
  assert.ok((src.match(/codeagentPickMiss: null/g) || []).length >= 4, 'cleared on every success path');
  assert.match(src, /codeagentPickFallback: undefined, codeagentModelPick: false, codeagentPickMiss: null/);
  // 同名不同组不算选上；提示带供应商；写完通知分身页。
  assert.match(src, /result\.ok && using && !session\.codeagentModelProvider && using\.toLowerCase\(\)/);
  assert.match(src, /want: providerLabel \? `\$\{modelId\} · \$\{providerLabel\}` : modelId/);
  assert.match(src, /if \(missed \|\| session\.codeagentPickMiss\) sendToRenderer\('avatar:changed', \{\}\);/);
  const main = read('main.js');
  assert.match(main, /pickMissResolvedByAnswer\(session, modelId,\s*\{ observedModel: observed\?\.fields\?\.currentModel\?\.id \|\| '', resolveSwitch \}\)\) \{\s*sessionManager\.updateSessionMeta\(hubSessionId, \{ codeagentPickMiss: null \}\);\s*sendToRenderer\('avatar:changed', \{\}\);/);
});

test('P1: the avatar page strings added in R53 have English entries', () => {
  const i18n = require('../core/i18n');
  const before = i18n.getLanguage();
  i18n.setLanguage('en');
  try {
    for (const zh of ['选的 GLM-5.3 没选上，现在用的是 GLM-5.2-WX-Auto。', 'CodeAgent 当前的模型', '去改那一项',
      '当前生效的是「设置 → 功能使用的 Agent → 分身」选的 GLM-5.3 · Built-in（所有分身共用），这里的模型选择暂不生效。',
      '当前生效的是「设置 → 功能使用的 Agent → 分身」：Claude Code · 自有接口（所有分身共用），这里的账号和模型选择暂不生效。',
      '没检测到可用 CodeAgent，自动用 Claude Code · 自有接口（所有分身共用），这里的账号和模型选择暂不生效。']) {
      const en = i18n.translate(zh);
      assert.equal(/[一-鿿]/.test(en), false, `${zh} -> ${en}`);
    }
  } finally { i18n.setLanguage(before); }
});

test('P2: preflight can check just one avatar, and try-out / re-draft use it', () => {
  const { FleetService } = require('../core/avatar/fleet');
  const avatars = [{ id: 'bad', name: '坏', enabled: true, backend: { account: 'personal', model: 'Nope' } }, { id: 'good', name: '好', enabled: true, backend: { account: 'personal', model: 'GLM-5.3' } }];
  const fake = { assistant: () => null, login: () => ({ ok: true }), fleet: () => ({ avatars }), snapshot: () => null, targetSnapshot: null };
  const backends = { codeagentAvailable: true, featureChoice: null, rows: [{ id: 'personal', usable: true, models: ['GLM-5.3'], label: '个人账号' }] };
  const all = FleetService.prototype.preflight.call(fake, 'me', backends).agent;
  assert.equal(all.ok, false);
  assert.equal(all.avatarId, 'bad', 'chip can jump to the broken avatar');
  assert.equal(FleetService.prototype.preflight.call(fake, 'me', backends, { only: 'good' }).agent.ok, true);
  assert.match(read('core/avatar/tryout.js'), /f\.preflight\(owner, f\.backends\(\), \{ only: av\.id \}\)/);
  assert.match(read('core/avatar/fleet.js'), /this\.preflight\(owner, this\.backends\(\), \{ only: id \}\)\.agent/);
});

test('P2: avatar page — count, clickable chip, override note under the heading, Claude Code harness override text', () => {
  const page = read('renderer/avatar-page.js');
  assert.match(page, /\(r\.options\?\.length \? r\.options : r\.models \|\| \[\]\)\.length\} 个模型/);
  assert.match(page, /<button class="avx-ch r" data-av="fix" data-kind="open_account_card" data-hl="model" data-avatar=/);
  assert.match(page, /<h3>模型<\/h3>\$\{overrideNote\}<button/);
  assert.match(page, /picked\.kind === 'claude' && picked\.source/);
  assert.match(page, /没检测到可用 CodeAgent，自动用 \$\{line\}/);
  assert.match(page, /当前生效的是「设置 → 功能使用的 Agent → 分身」：\$\{line\}/);
});

test('merge P2-2: feature-agent-choice passes options (env, findCommand) to every catalog() it builds', () => {
  const src = read('core/feature-agent-choice.js');
  // 手里有 options 的地方都要带上（resolve、set、choiceFromUi、setFromUi、state、applyPreset）。
  assert.equal(/options\??\.backends \|\| catalog\(dataDir\)/.test(src), false);
  assert.ok((src.match(/options\??\.backends \|\| catalog\(dataDir, options\)/g) || []).length >= 6);
});

test('review P2-3: a backstage pick on an automatic (avatar) session is not remembered as the account "last model"', async t => {
  const dir = temp(t);
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
  const sessions = {
    av: { id: 'av', kind: 'codeagent', purpose: 'avatar-agent', autonomous: true, status: 'idle', codeagentRunMode: 'serve', codeagentPickMiss: { want: 'GLM-5.3', model: 'GLM-5.3' } },
    me: { id: 'me', kind: 'codeagent', status: 'idle', codeagentRunMode: 'serve' },
  };
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sendToRenderer() {},
    sessionManager: { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}), getSession: id => sessions[id] || null, isAgentTurnActive: () => false,
      getNativeSession: () => ({ configure: async ({ model }) => ({ modelId: model, provider: 'w3', providerLabel: 'Built-in' }) }),
      updateSessionMeta: (id, fields) => Object.assign(sessions[id], fields) },
  });
  const last = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, require('../core/codeagent-launch-model').FILE), 'utf8')).personal?.model || ''; } catch { return ''; } };
  const switched = await handlers.get('codeagent:switch-model')(null, { sessionId: 'av', modelId: 'GLM-5.3' });
  assert.equal(switched.ok, true);
  assert.equal(sessions.av.codeagentPickMiss, null, 'the miss is cleared');
  assert.equal(last(), '', 'avatar pick not remembered');
  await handlers.get('codeagent:switch-model')(null, { sessionId: 'me', modelId: 'GLM-5.3' });
  assert.equal(last(), 'GLM-5.3', 'a manual session still remembers');
  // 终端（菜单）路径同一把尺。
  assert.match(read('main/ipc/session-handlers.js'), /if \(result\.mode !== 'settings-only' && !isAutomaticCodeAgent\(session\)\) require\('\.\.\/\.\.\/core\/codeagent-launch-model'\)\.rememberModel\(/);
});

test('review 2 P2-1: after a manual /model in the backstage terminal, a backend model id (maas-*) clears the pick miss', t => {
  const { data, personal } = personalFixture(t);
  const { pickMissResolvedByAnswer } = require('../core/avatar/agent-session');
  const models = require('../core/codeagent-models');
  // 和 main.js observeCodeAgentModel 同一条：真实的 observeModel + 按号清单对回模型名。
  const resolveSwitch = actual => require('../core/codeagent-resume-model').resolveAccountModel(actual, { dataDir: data, configDir: personal, accountKey: 'personal' });
  const judge = session => {
    const observed = models.observeModel(session, 'maas-glm-5-3-260814', { at: Date.now(), resolveSwitch, followActual: true });
    return { observedModel: observed?.fields?.currentModel?.id || '', cleared: pickMissResolvedByAnswer(session, 'maas-glm-5-3-260814', { observedModel: observed?.fields?.currentModel?.id || '', resolveSwitch }) };
  };
  const miss = { want: 'GLM-5.3', model: 'GLM-5.3', using: 'GLM-5.2-WX-Auto', pickFailure: 'absent', at: 1 };
  const base = { id: 's', kind: 'codeagent', purpose: 'avatar-agent', autonomous: true, codeagentConfigDir: personal, codeagentPickMiss: miss };
  // 场景 1：回退时会话模型仍记着所选的 GLM-5.3，观察不改写会话模型。
  const one = judge({ ...base, currentModel: { id: 'GLM-5.3' }, fixedModel: 'GLM-5.3' });
  assert.equal(one.observedModel, '', 'observation alone gives nothing here');
  assert.equal(one.cleared, true);
  // 场景 2：第一轮已按 GLM-5.2-WX-Auto 回答过，之后手动切到 GLM-5.3（Auto 允许分流，观察同样不改写）。
  const two = judge({ ...base, currentModel: { id: 'GLM-5.2-WX-Auto' }, fixedModel: 'GLM-5.2-WX-Auto' });
  assert.equal(two.cleared, true);
  // 回答还是回退模型的后端名：不撤。
  assert.equal(pickMissResolvedByAnswer({ ...base, currentModel: { id: 'GLM-5.2-WX-Auto' } }, 'maas-glm-5-2-260601', { resolveSwitch }), false);
  assert.match(read('main.js'), /pickMissResolvedByAnswer\(session, modelId,\s*\{ observedModel: observed\?\.fields\?\.currentModel\?\.id \|\| '', resolveSwitch \}\)/);
});
