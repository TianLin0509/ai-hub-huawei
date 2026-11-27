'use strict';
// R53 第 4 件：分身页模型卡和会话下拉同一份带供应商的清单；选的供应商一路带到启动；
// 启动没选上时分身页能就地说出来；设置页的分身选型盖过模型卡时，不把模型卡的供应商挂到别的模型上。
// R53 item 4: provider-aware avatar model card, provider carried to launch, launch pick miss surfaced, settings override kept consistent.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r53-avatar-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
// 形状同公司 CodeAgent 1.2615.02.05 的清单：Built-in（w3）与 cannbotprovider 两组，GLM-5.3 两组都有。
const DETAILS = [
  { id: 'GLM-5.2-WX-Auto', label: 'GLM-5.2-WX-Auto', provider: 'w3', providerLabel: 'Built-in' },
  { id: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek-V4.1-Flash-1017', provider: 'w3', providerLabel: 'Built-in' },
  { id: 'GLM-5.3', label: 'GLM-5.3', provider: 'cannbotprovider', providerLabel: 'cannbotprovider' },
  { id: 'GLM-5.3', label: 'GLM-5.3', provider: 'w3', providerLabel: 'Built-in' },
];

test('avatar model card: the personal account lists every model with its provider, not only the default', t => {
  const root = temp(t), data = path.join(root, 'data'), personal = path.join(root, 'personal');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, '.credentials.json'), JSON.stringify({ idaasOAuth: { xAuthToken: 'local-fixture-only', accountId: 'a00000001', expiresAt: Date.now() + 72 * 3600e3 } }));
  fs.writeFileSync(path.join(personal, 'settings.json'), JSON.stringify({ model: 'GLM-5.2-WX-Auto' }));
  require('../core/codeagent-model-probe').writeProbed(path.join(data, 'codeagent-pool', 'personal-models.json'),
    { models: [...new Set(DETAILS.map(d => d.id))], details: DETAILS, defaultModel: 'GLM-5.2-WX-Auto', source: 'serve' });
  const env = { ...process.env, AI_HUB_CODEAGENT_CONFIG_DIR: personal, AI_HUB_CODEAGENT_POOL_SCAN_ROOT: path.join(root, 'scan') };
  const { listAvatarBackends } = require('../main/ipc/avatar-handlers');
  const backends = listAvatarBackends({ dataDir: data, env, sessionManager: { getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) } });
  const me = backends.rows.find(row => row.id === 'personal');
  assert.ok(me, 'personal account row');
  assert.equal(me.options.length, 4);
  assert.deepEqual(me.options.filter(o => o.id === 'GLM-5.3').map(o => o.provider).sort(), ['cannbotprovider', 'w3']);
  // R53b：分身按会话在 /model 菜单里选，不改账号默认——个人账号列全且都可选，models 是全集（预检按它核）。
  assert.deepEqual(me.models.slice().sort(), ['DeepSeek-V4.1-Flash-1017', 'GLM-5.2-WX-Auto', 'GLM-5.3']);
  assert.equal(me.options.some(o => o.unavailable), false);
});

test('avatar backend keeps the picked provider and passes it to the launch', () => {
  const rules = require('../core/avatar/fleet-rules');
  const next = rules.applyPatch({ backend: { account: 'auto', model: '' } }, { backend: { account: 'personal', model: 'GLM-5.3', provider: 'cannbotprovider', providerLabel: 'cannbotprovider', menuLabel: 'GLM-5.3' } });
  assert.deepEqual(next.backend, { account: 'personal', model: 'GLM-5.3', effort: '', provider: 'cannbotprovider', providerLabel: 'cannbotprovider', menuLabel: 'GLM-5.3' });
  const cleared = rules.applyPatch(next, { backend: { ...next.backend, account: 'auto', model: '' } });
  assert.equal(cleared.backend.provider, undefined, 'no model, no provider');
  const opts = require('../core/avatar/agent-session').backendOptions(next.backend);
  assert.equal(opts.codeagentRouteModel, 'GLM-5.3');
  assert.equal(opts.codeagentModelProvider, 'cannbotprovider');
});

test('a settings-page avatar model replaces the model card provider instead of inheriting it', t => {
  const dir = temp(t), choice = require('../core/feature-agent-choice');
  const models = DETAILS.map(d => ({ id: d.id, provider: d.provider, providerLabel: d.providerLabel, menuLabel: d.label }));
  const backends = [{ kind: 'codeagent', available: true, models }, { kind: 'codeagent-lite', available: true, models }];
  choice.set(dir, 'avatar', { kind: 'codeagent', model: 'DeepSeek-V4.1-Flash-1017', provider: 'w3', providerLabel: 'Built-in', menuLabel: 'DeepSeek-V4.1-Flash-1017' }, { backends });
  const fromCard = { purpose: 'avatar-agent', codeagentRouteModel: 'GLM-5.3', codeagentModelProvider: 'cannbotprovider', codeagentModelProviderLabel: 'cannbotprovider', codeagentModelMenuLabel: 'GLM-5.3' };
  const picked = choice.session(dir, 'avatar', 'codeagent', fromCard, { backends });
  assert.equal(picked.opts.codeagentRouteModel, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(picked.opts.codeagentModelProvider, 'w3');
  assert.equal(picked.opts.codeagentModelMenuLabel, 'DeepSeek-V4.1-Flash-1017');
  // 设置页存的是不带供应商的老选择：模型卡的 cannbotprovider 不能挂到它头上。
  require('../core/codeagent-assistant-route').setFeaturePreference(dir, 'avatar', { kind: 'codeagent', model: 'GLM-5.2-WX-Auto' });
  const legacy = choice.session(dir, 'avatar', 'codeagent', fromCard, { backends });
  assert.equal(legacy.opts.codeagentRouteModel, 'GLM-5.2-WX-Auto');
  assert.equal(legacy.opts.codeagentModelProvider, undefined);
});

test('a launch pick miss recorded on a live avatar session is reported to the avatar page', () => {
  const { AgentSessions } = require('../core/avatar/agent-session');
  const meta = { status: 'running', codeagentPickMiss: { want: 'DeepSeek-V4.1-Flash-1017', using: 'GLM-5.2-WX-Auto', pickFailure: 'mismatch', at: 5 } };
  const sessions = new AgentSessions({ getSession: id => id === 'live' ? meta : id === 'gone' ? { ...meta, status: 'closed' } : null });
  assert.deepEqual(sessions.pickMiss('live'), { want: 'DeepSeek-V4.1-Flash-1017', using: 'GLM-5.2-WX-Auto', pickFailure: 'mismatch', at: 5 });
  assert.equal(sessions.pickMiss('gone'), null);
  assert.equal(sessions.pickMiss(''), null);
});

test('the launch pick result is written on avatar sessions (main process wiring)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'session-handlers.js'), 'utf8');
  assert.match(src, /session\.purpose === 'avatar-agent'[\s\S]{0,1500}codeagentPickMiss: missed \?/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'avatar-page.js'), 'utf8');
  assert.match(page, /data-avx-pick-miss/);
  assert.match(page, /data-avx-override[\s\S]{0,300}data-feature-agent="avatar"/);
});
