'use strict';
// CodeAgent-Lite（2026-11-23）：启动中心的显式入口 + 各功能可选的省内存驱动。
// 底层仍是 codeagent 会话、走共享 serve；默认（没选）时一切与原 CodeAgent 相同。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const choice = require('../core/feature-agent-choice');
const runMode = require('../core/codeagent-run-mode');
const routes = require('../core/codeagent-assistant-route');

const backends = [
  { kind: 'codeagent', label: 'CodeAgent', available: true, defaultModel: 'glm-test', models: [{ id: 'glm-test', provider: 'builtin' }, { id: 'glm-alt', provider: 'builtin' }] },
  { kind: 'codeagent-lite', label: 'CodeAgent-Lite（省内存）', available: true, defaultModel: 'glm-test', models: [{ id: 'glm-test', provider: 'builtin' }, { id: 'glm-alt', provider: 'builtin' }] },
  { kind: 'claude', label: 'Claude', available: true, models: [{ id: 'haiku' }] },
];
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-lite-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const SESSION_FEATURES = ['assistant', 'avatar', 'forum', 'ppt', 'pptMake', 'pptImgtext', 'meeting', 'text'];
// 各功能建会话时用的 purpose（见各 service 的 createSession 调用）。
const PURPOSE_OF = { assistant: 'company-assistant', ppt: 'company-assistant', pptMake: 'company-assistant', pptImgtext: 'company-assistant',
  meeting: 'company-assistant', avatar: 'avatar-agent', forum: 'company-forum', text: 'company-ai' };

test('发行版过滤：-lite 跟随本体，只留 CodeAgent 的发行版也保留 Lite', () => {
  const { makeKindFilter } = require('../core/distribution');
  const only = makeKindFilter(['codeagent']);
  assert.equal(only.kindAllowed('codeagent-lite'), true);
  assert.equal(only.kindAllowed('codeagent-resume'), true);
  assert.equal(only.kindAllowed('claude'), false);
  assert.equal(makeKindFilter(['claude']).kindAllowed('codeagent-lite'), false);
  assert.equal(makeKindFilter(null).kindAllowed('codeagent-lite'), true);
});

test('公司策略与 CLI 检测把 codeagent-lite 当 codeagent', () => {
  const policy = require('../core/company-ai-policy');
  assert.equal(policy.taskKindAllowed('codeagent-lite'), policy.taskKindAllowed('codeagent'));
  assert.equal(policy.groupKindAllowed('codeagent-lite'), policy.groupKindAllowed('codeagent'));
  assert.doesNotThrow(() => policy.assertKind('codeagent-lite'));
  const provider = read('core/community-provider.js');
  assert.match(provider, /replace\(\/-\(\?:resume\|lite\)\$\/, ''\)/);
  assert.match(provider, /if \(provider === 'codeagent-lite'\) provider = 'codeagent';/);
  // 缺 CLI 时报的是 CodeAgent 的名字，不是一个不存在的 provider。
  const { requireCommand } = require('../core/community-provider');
  try { requireCommand('codeagent-lite', { PATH: '', Path: '', AI_HUB_CODEAGENT_COMMAND: path.join(os.tmpdir(), 'no-such-codeagent.cmd') }); }
  catch (error) { assert.doesNotMatch(error.message, /codeagent-lite/); }
});

test('界面裁剪：只留 CodeAgent 时 Lite 按钮保留、其他按钮去掉', () => {
  const removed = [];
  const button = kind => ({ dataset: { kind }, remove() { removed.push(kind); }, lastChild: {} });
  const buttons = [button('codeagent'), button('codeagent-lite'), button('claude'), button('deepseek')];
  const document = {
    querySelectorAll: sel => (sel === '.new-session-option[data-kind]' ? buttons : []),
    querySelector: () => null, getElementById: () => null, createElement: () => ({ setAttribute() {} }), head: { append() {} }, body: { append() {} },
  };
  const filter = require('../core/distribution').makeKindFilter(['codeagent']);
  const fakeDistribution = { ...require('../core/distribution'), ...filter, featureEnabled: () => true, productName: '', editionBadge: '' };
  const sandbox = { document, console, require: name => (name === '../core/distribution' ? fakeDistribution : require(path.join(root, 'renderer', name))) };
  try { vm.runInNewContext(read('renderer/edition-trim.js'), sandbox); } catch { /* 后半段操作别的界面元素，本用例只看会话类型按钮 */ }
  assert.ok(!removed.includes('codeagent'));
  assert.ok(!removed.includes('codeagent-lite'));
  assert.ok(removed.includes('claude'));
});

test('运行方式：默认对后台功能仍排除 serve；codeagentLiteFeature 显式放行', () => {
  for (const purpose of runMode.EXCLUDED_PURPOSES) {
    assert.equal(runMode.usesServeRuntime('codeagent', { purpose, codeagentRunMode: 'serve' }), false, purpose);
  }
  for (const purpose of [...runMode.EXCLUDED_PURPOSES]) {
    assert.equal(runMode.usesServeRuntime('codeagent', { purpose, codeagentRunMode: 'serve', codeagentLiteFeature: true }), true, purpose);
    // 只有标记、没选 serve：仍是 PTY。
    assert.equal(runMode.usesServeRuntime('codeagent', { purpose, codeagentLiteFeature: true }), false, purpose);
  }
  // 恢复选择器、组队、会议室会话不受 Lite 标记影响。
  for (const extra of [{ resumePicker: true }, { teamId: 't' }, { teamRole: 'member' }, { meetingId: 'm' }]) {
    assert.equal(runMode.usesServeRuntime('codeagent', { purpose: 'company-assistant', codeagentRunMode: 'serve', codeagentLiteFeature: true, ...extra }), false);
  }
  assert.equal(runMode.usesServeRuntime('claude', { codeagentRunMode: 'serve', codeagentLiteFeature: true }), false);
  // 启动中心的普通会话照旧。
  assert.equal(runMode.usesServeRuntime('codeagent', { codeagentRunMode: 'serve' }), true);
  assert.equal(runMode.usesServeRuntime('codeagent', {}), false);
});

test('功能选型：8 个会话功能都可选 Lite，单次功能不可选', () => {
  for (const id of SESSION_FEATURES) {
    const f = choice.FEATURES.find(x => x.id === id);
    assert.ok(f.kinds.includes('codeagent') && f.kinds.includes('codeagent-lite'), id);
  }
  for (const id of ['help', 'pptMap', 'progress']) assert.ok(!choice.FEATURES.find(x => x.id === id).kinds.includes('codeagent-lite'), id);
  assert.equal(choice.LABELS['codeagent-lite'], 'CodeAgent-Lite（省内存）');
});

test('功能选型：没选时与原 CodeAgent 完全一致（同一 kind、同一 opts 对象）', t => {
  const dir = temp(t), opts = { model: 'x', codeagentPoolPick: 'acc', effort: 'high' };
  for (const id of SESSION_FEATURES) {
    const r = choice.session(dir, id, 'codeagent', opts, { backends });
    assert.equal(r.kind, 'codeagent'); assert.equal(r.opts, opts); assert.equal(r.warning, '');
  }
});

test('功能选型：选 Lite 后建 codeagent + serve + Lite 标记，保留 codeagent* 字段、去掉思考强度，且后台走共享 serve', t => {
  const dir = temp(t);
  for (const id of SESSION_FEATURES) {
    choice.set(dir, id, { kind: 'codeagent-lite', model: '' }, { backends });
    const opts = { id: 's-' + id, purpose: PURPOSE_OF[id], codeagentPoolPick: 'acc', codeagentAccount: 'pool', effort: 'high' };
    const r = choice.session(dir, id, 'codeagent', opts, { backends });
    assert.equal(r.kind, 'codeagent', id);
    assert.equal(r.opts.codeagentRunMode, 'serve', id);
    assert.equal(r.opts.codeagentLiteFeature, true, id);
    assert.equal(r.opts.codeagentPoolPick, 'acc', id);
    assert.equal(r.opts.codeagentAccount, 'pool', id);
    assert.equal('effort' in r.opts, false, id);
    assert.equal(r.opts.featureAgent, id);
    assert.deepEqual(JSON.parse(r.opts.featureAgentChoice).kind, 'codeagent-lite');
    assert.doesNotThrow(() => choice.assertSessionKind(r.kind, r.opts));
    assert.equal(runMode.usesServeRuntime(r.kind, r.opts), true, id);
    assert.notEqual(opts.codeagentRunMode, 'serve', '不改调用方的 opts');
  }
});

test('功能选型：Lite 选具体模型时与 CodeAgent 同样钉模型和供应商', t => {
  const dir = temp(t);
  choice.set(dir, 'assistant', { kind: 'codeagent-lite', model: 'glm-alt', codeagentModelProvider: 'builtin' }, { backends });
  const r = choice.session(dir, 'assistant', 'codeagent', { purpose: 'company-assistant' }, { backends });
  assert.equal(r.opts.model, 'glm-alt'); assert.equal(r.opts.fixedModel, 'glm-alt'); assert.equal(r.opts.codeagentRouteModel, 'glm-alt');
  assert.equal(r.opts.codeagentModelProvider, 'builtin');
});

test('功能选型：CodeAgent ↔ Lite ↔ 默认 来回切换时 stale 准确判定需要换后台会话', t => {
  const dir = temp(t);
  choice.set(dir, 'forum', { kind: 'codeagent', model: '' }, { backends });
  const classic = choice.session(dir, 'forum', 'codeagent', {}, { backends }).opts;
  assert.equal(choice.stale(dir, 'forum', classic, { backends }), false);
  choice.set(dir, 'forum', { kind: 'codeagent-lite', model: '' }, { backends });
  assert.equal(choice.stale(dir, 'forum', classic, { backends }), true);
  const lite = choice.session(dir, 'forum', 'codeagent', {}, { backends }).opts;
  assert.equal(choice.stale(dir, 'forum', lite, { backends }), false);
  choice.set(dir, 'forum', null, { backends });
  assert.equal(choice.stale(dir, 'forum', lite, { backends }), true);
  assert.equal(choice.stale(dir, 'forum', {}, { backends }), false);
});

test('功能选型：Lite 不可用（CodeAgent 不可用）时沿用默认并提示', t => {
  const dir = temp(t);
  choice.set(dir, 'text', { kind: 'codeagent-lite', model: '' }, { backends });
  const broken = backends.map(b => (b.kind === 'codeagent-lite' ? { ...b, available: false } : b));
  const opts = { purpose: 'company-ai' };
  const r = choice.session(dir, 'text', 'codeagent', opts, { backends: broken });
  assert.equal(r.kind, 'codeagent'); assert.equal(r.opts, opts); assert.match(r.warning, /不可用/);
});

test('模型目录：Lite 紧跟 CodeAgent，可用性、默认模型与模型清单完全复用', t => {
  const dir = temp(t);
  const rows = choice.catalog(dir, { env: { ...process.env, AI_HUB_CODEAGENT_COMMAND: path.join(root, 'tests', 'fixtures', 'codeagent-standin', 'codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: dir } });
  const kinds = rows.map(r => r.kind);
  assert.equal(kinds.indexOf('codeagent-lite'), kinds.indexOf('codeagent') + 1);
  const base = rows.find(r => r.kind === 'codeagent'), lite = rows.find(r => r.kind === 'codeagent-lite');
  assert.equal(lite.available, base.available);
  assert.equal(lite.defaultModel, base.defaultModel);
  assert.deepEqual(lite.models, base.models);
  assert.equal(lite.label, 'CodeAgent-Lite（省内存）');
});

test('会议：选 Lite 时引擎标签为 CodeAgent-Lite，建的是 codeagent + serve 会话', t => {
  const dir = temp(t);
  routes.setFeaturePreference(dir, 'meeting', { kind: 'codeagent-lite', model: '' });
  const { MeetingCompanion } = require('../core/company-assistant/meeting');
  const original = choice.resolve;
  choice.resolve = (d, id, o) => original(d, id, { ...o, backends });
  t.after(() => { choice.resolve = original; });
  const picked = MeetingCompanion.prototype.engineFor.call({ a: { deps: { dataDir: dir } }, deps: {} }, { id: 'm' });
  assert.equal(picked.label, 'CodeAgent-Lite');
  assert.equal(picked.harness, 'codeagent-lite');
  const chosen = choice.session(dir, 'meeting', picked.harness, { id: 'x', purpose: 'company-assistant' }, { backends });
  assert.equal(chosen.kind, 'codeagent');
  assert.equal(chosen.opts.codeagentRunMode, 'serve');
  assert.equal(chosen.opts.codeagentLiteFeature, true);
  assert.equal(runMode.usesServeRuntime(chosen.kind, chosen.opts), true);
});

test('助理预热：serve 会话不拿卡片文字认 PowerShell 提示符，会话没了仍判不可用', () => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const make = session => ({ now: () => 1e12, pool: new Map([['id', { createdAt: 0 }]]),
    sessionGone: id => (session ? '' : 'gone'),
    deps: { getSession: () => session, readTerminalScreen: () => ({ text: 'PS C:\\Users\\x> ' }) } });
  const warm = CompanyAssistant.prototype.warmUnavailable;
  assert.equal(warm.call(make({ codeagentRunMode: 'serve' }), 'id'), false);
  assert.equal(warm.call(make({ codeagentRunMode: 'serve', nativeRuntime: { connection: 'connected' } }), 'id'), false);
  // 过了启动宽限期仍断开：判不可用，换新会话。
  assert.equal(warm.call(make({ codeagentRunMode: 'serve', nativeRuntime: { connection: 'disconnected' } }), 'id'), true);
  assert.equal(warm.call(make(null), 'id'), true);
  // 启动宽限期内即使断开也先等。
  const young = make({ codeagentRunMode: 'serve', nativeRuntime: { connection: 'disconnected' } });
  young.pool = new Map([['id', { createdAt: 1e12 }]]);
  assert.equal(warm.call(young, 'id'), false);
});

test('后台功能失败快报：serve 运行时字段里的鉴权与限流错误立即报出，不空等超时', () => {
  const reader = require('../core/feature-agent-session-failure').createReader;
  const read = meta => reader({ getSession: () => meta, readTurnApiError: () => null }).read('id');
  assert.match(read({ codeagentRunMode: 'serve', nativeRuntime: { reason: 'not logged in' } }), /登录/);
  assert.match(read({ codeagentRunMode: 'serve', nativeRuntime: { error: { message: 'HTTP 401 Unauthorized' } } }), /登录/);
  assert.match(read({ codeagentRunMode: 'serve', nativeRuntime: { error: 'HTTP 429 Too Many Requests' } }), /429/);
  assert.equal(read({ codeagentRunMode: 'serve', nativeRuntime: { connection: 'connected' } }), '');
});

test('serve 模型与供应商：分组后缀拆掉，连接上确定的模型回填为当前模型', () => {
  const { CodeAgentServeClient } = require('../core/codeagent-serve-client');
  const client = new CodeAgentServeClient({ host: {}, cwd: process.cwd(), model: 'glm', provider: 'team/group-a' });
  assert.equal(client.provider, 'team');
  assert.match(read('core/session-manager.js'), /provider: String\(opts\.codeagentModelProvider \|\| ''\)\.split\('\/'\)\[0\]/);
  assert.match(read('core/acp-session.js'), /if \(!this\.currentModel && this\.options\.profileId === 'codeagent-serve' && typeof client\?\.model === 'string' && client\.model\) this\.currentModel = client\.model;/);
});

test('终态读取：serve 会话走原生记录（getNativeSession.readTranscript）', () => {
  const finals = require('../core/feature-agent-finals');
  const manager = { getNativeSession: () => ({ readTranscript: () => [{ role: 'assistant', stopReason: 'completed', text: '答复' }, { role: 'user', text: 'q' }] }) };
  assert.deepEqual(finals.read({ id: 'a', kind: 'codeagent', codeagentRunMode: 'serve' }, manager, { read: () => ({ available: false }) }).map(c => c.text), ['答复']);
});

test('会话构建、持久化与恢复：Lite 标记随 serve 会话保存，恢复时仍走共享 serve', () => {
  const sm = read('core/session-manager.js');
  assert.match(sm, /model: launch\.fixedModel \|\| launch\.model \|\| opts\.codeagentRouteModel \|\| opts\.model \|\| ''/);
  assert.match(sm, /isCodeAgentServe \? \{ codeagentRunMode: 'serve', \.\.\.\(opts\.codeagentLiteFeature === true \? \{ codeagentLiteFeature: true \} : \{\}\) \}/);
  assert.match(read('core/session-store.js'), /data\.codeagentLiteFeature === true \? \{ codeagentLiteFeature: true \}/);
  assert.match(read('main/ipc/persistence-handlers.js'), /'codeagentLiteFeature',/);
  assert.match(read('main/ipc/resume-session-handlers.js'), /meta\.codeagentLiteFeature === true \? \{ codeagentLiteFeature: true \}/);
  const meta = require('../core/session-capabilities').buildSessionResumeMeta({ id: 'a', kind: 'codeagent', codeagentRunMode: 'serve', codeagentLiteFeature: true });
  assert.equal(meta.codeagentRunMode, 'serve'); assert.equal(meta.codeagentLiteFeature, true);
  const plain = require('../core/session-capabilities').buildSessionResumeMeta({ id: 'b', kind: 'codeagent', codeagentRunMode: 'serve' });
  assert.equal('codeagentLiteFeature' in plain, false);
});

test('显示名：serve 会话显示 CodeAgent-Lite，不再出现旧试点名', () => {
  const { nativeUiLabel } = require('../core/native-ui-labels');
  assert.equal(nativeUiLabel({ kind: 'codeagent', runtimeBackend: 'acp', codeagentRunMode: 'serve' }), 'CodeAgent-Lite');
  const html = read('renderer/index.html');
  assert.match(html, /<option value="serve">轻量共享（CodeAgent-Lite）<\/option>/);
  const js = read('renderer/workspace-controller.js');
  // CodeAgent 的运行方式说明改叫轻量共享；Claude / DSH 卡片试点保持原「ACP 试点」说明。
  assert.match(js, /'轻量共享（CodeAgent-Lite）：平时看卡片/);
  assert.match(js, /\? `ACP 试点：平时看卡片，点「后台」时同一会话切到真实终端/);
  assert.equal((js.match(/ACP 试点/g) || []).length, 1);
  // Lite 的底栏摘要不拼思考强度，配置说明不提模型菜单。
  assert.match(js, /const effortTag = EFFORT_PICKER && !\(selectedKind === 'codeagent' && codeagentLite\)/);
  assert.match(js, /if \(selectedKind === 'codeagent' && codeagentLite\) lines\.push\(modelTouchedByUser\r?\n\s*\? '新会话直接用所选模型，不经过模型菜单。'/);
});

test('启动中心：Lite 按钮紧跟 CodeAgent；选中时提交 codeagent + serve、不带思考强度、隐藏运行方式、单独记住入口', () => {
  const html = read('renderer/index.html');
  const ca = html.indexOf('data-kind="codeagent"'), lite = html.indexOf('data-kind="codeagent-lite"');
  assert.ok(ca > 0 && lite > ca, 'Lite 按钮在 CodeAgent 之后');
  assert.match(html, /data-kind="codeagent-lite"[^>]*>.*CodeAgent-Lite · 省内存<\/button>/);
  const js = read('renderer/workspace-controller.js');
  assert.match(js, /'codeagent-lite': 'CodeAgent-Lite · 省内存'/);
  assert.match(js, /const isCodeagentPanelKind = kind => kind === 'codeagent' \|\| kind === 'codeagent-lite';/);
  // 选中 Lite 时 selectedKind 仍为 codeagent：账号、号池、模型目录、权限、安装检测全部共用同一套分支。
  assert.match(js, /selectedKind = codeagentLite \? 'codeagent' : key;/);
  assert.match(js, /if \(selectedKind === 'codeagent' && codeagentLite\) \{ opts\.codeagentRunMode = 'serve'; delete opts\.effort; \}/);
  assert.match(js, /showEffort = EFFORT_KINDS\.has\(selectedKind\) && EFFORT_PICKER && !\(selectedKind === 'codeagent' && codeagentLite\)/);
  assert.match(js, /if \(selectedKind === 'codeagent' && codeagentLite\) \{\r?\n\s*\/\/[^\n]*\r?\n\s*field\.hidden = true;/);
  assert.match(js, /rememberKind\(launchKindKey\(\)\)/);
  assert.match(js, /const EFFORT_KINDS = new Set\(\['claude', 'codex', 'deepseek', 'codeagent', 'deepseek-claude'\]\);/);
  assert.match(js, /if \(button && lite && button\.nextElementSibling !== lite\) button\.after\(lite\);/);
  assert.match(read('renderer/launch-config-layout.js'), /lastCtx\?\.kind === 'codeagent' \|\| lastCtx\?\.kind === 'codeagent-lite'/);
});

test('启动中心默认：没有记住过 Lite 时默认仍是 CodeAgent；用过 Lite 后回到 Lite', () => {
  const store = new Map();
  global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    delete require.cache[require.resolve('../renderer/codeagent-preference')];
    const pref = require('../renderer/codeagent-preference');
    const valid = ['claude', 'codeagent', 'codeagent-lite'];
    const first = pref.preferredKind(valid);
    assert.notEqual(first, 'codeagent-lite');
    pref.rememberKind('codeagent-lite');
    assert.equal(pref.preferredKind(valid), 'codeagent-lite');
    pref.rememberKind('codeagent');
    assert.equal(pref.preferredKind(valid), 'codeagent');
  } finally { delete global.localStorage; }
});
