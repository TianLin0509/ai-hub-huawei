'use strict';
// 权限模式全 harness（2026-11-26）：DSH 三档真实接线、新用户默认最保守、老用户升级保留、完全放开一次确认的记录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modes = require('../core/permission-modes');

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return { data, getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}

test('档位表：DSH 3 档（完全放开/自动改文件/每步确认），pi 只有完全放开；不支持的档都有原因', () => {
  assert.deepEqual(modes.modesFor('deepseek-acp'), ['bypassPermissions', 'acceptEdits', 'default']);
  assert.deepEqual(modes.modesFor('deepseek-acp-resume'), modes.modesFor('deepseek-acp'));
  assert.equal(modes.supportsSwitch('deepseek-acp'), true);
  assert.equal(modes.supportsSwitch('pi'), false);
  for (const kind of ['claude', 'codex', 'codeagent', 'deepseek-acp', 'pi']) {
    const options = modes.optionsFor(kind);
    assert.deepEqual(options.map(o => o.id), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], kind + ' 五档全列、保守在前');
    for (const o of options.filter(o => !o.supported)) {
      assert.ok(o.desc.length > 6, `${kind}/${o.id} 灰掉要写原因`);
      assert.match(o.label, /（不支持）$/);
    }
  }
  assert.match(modes.unsupportedReason('deepseek-acp', 'plan'), /\/plan|Shift\+Tab/);
  assert.match(modes.unsupportedReason('pi', 'default'), /没有权限确认机制/);
  assert.match(modes.unsupportedReason('claude', 'auto'), /计费/);
  assert.equal(modes.unsupportedReason('codeagent', 'auto'), '');
});

test('新用户默认最保守：支持「每步确认」的工具默认它，只能完全放开的工具（pi）照旧；主进程缺省仍是完全放开', () => {
  for (const kind of ['claude', 'codex', 'codeagent', 'deepseek-acp']) assert.equal(modes.launchDefault(kind), 'default', kind);
  assert.equal(modes.launchDefault('pi'), 'bypassPermissions');
  assert.equal(modes.DEFAULT_MODE, 'bypassPermissions', '后台会话（组队、群聊、助理）靠它免确认，不能动');
  assert.match(modes.optionsFor('claude').find(o => o.id === 'default').label, /每步确认（默认）/);
  assert.match(modes.optionsFor('claude', { userDefault: 'plan' }).find(o => o.id === 'plan').label, /（默认）/);
});

test('DSH 映射：完全放开 = danger-full-access + 自动批准；其余档 = 沙箱 + 越界要用户点；轮换表所选档排第一、保守档不带完全放开', () => {
  const full = modes.dshPermission('bypassPermissions');
  assert.equal(full.sandbox, 'danger-full-access');
  assert.equal(full.policy, 'bypass');
  assert.equal(full.modes[0].approval, 'never');
  assert.equal(modes.dshPermission(undefined).sandbox, 'danger-full-access', '没传（后台会话）仍完全放开');
  assert.equal(modes.dshPermission('auto').sandbox, 'danger-full-access', '不认的值落回完全放开，与主进程缺省一致');
  const edit = modes.dshPermission('acceptEdits');
  assert.equal(edit.sandbox, 'workspace-write');
  assert.equal(edit.policy, 'ask');
  const ask = modes.dshPermission('default');
  assert.equal(ask.sandbox, 'read-only');
  assert.deepEqual(ask.modes.map(m => m.sandbox + '/' + m.approval + (m.plan ? '/plan' : '')),
    ['read-only/ask', 'workspace-write/ask', 'read-only/ask/plan'], '选了每步确认：Shift+Tab 只在保守档里轮换');
  assert.ok(ask.modes.every(m => m.approval === 'ask'));
  assert.equal(full.modes.length, 1, '完全放开沿用原来的单档配置（老用户启动参数不变）');
});

test('DSH 终端路线：环境变量与 dsh-tui 轮换表按所选档写；没选仍是完全放开', t => {
  const companyApi = require('../core/company-api-config');
  if (!companyApi.isCompany()) return;
  const hubProxy = require('../core/company-model-proxy');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-dsh-hub-'));
  hubProxy.ensureEndpoint(dataDir, { preferredPort: 18999 });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-dsh-rt-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true }); });
  for (const file of ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-harness-tui/dsh-tui/package.json']) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
    fs.writeFileSync(path.join(runtime, file), '{}');
  }
  const config = companyApi.applyCompanyConfig({ acp: { nodePath: process.execPath, providers: { 'deepseek-acp': { cliRoot: runtime } } } },
    { acp: { companyApi: { backend: 'proxy', model: 'deepseek-v4.1-flash-1017' } } });
  const build = (id, extra) => require('../core/dsh-cli-profile').buildDshCliOptions('deepseek-acp', { id, cwd: dataDir, ...extra }, config, dataDir, { PATH: process.env.PATH });
  const patchEntries = options => {
    const dir = path.dirname(options.home);
    const patch = fs.readdirSync(dir).find(name => /^cli-route.*\.yaml$/.test(name));
    return JSON.parse(fs.readFileSync(path.join(dir, patch), 'utf8'));
  };
  const tuiModes = options => patchEntries(options).find(e => e.id === 'dsh-tui').config.modes;
  // dsh-tui 在 Windows 上把沙箱钉成完全放开：保守档要由 Hub 补丁改回（开发机 dump-config 核对过补丁排在 dsh-tui 之后）。
  const override = options => patchEntries(options).filter(e => e.id === 'sandbox-policy' || e.id === 'approval').map(e => e.config.mode || e.config.policy);
  const plain = build('dsh-plain', {});
  assert.equal(plain.launch.env.DSH_PERMISSION_MODE, 'danger-full-access');
  assert.equal(plain.permissionPolicy, 'bypass');
  assert.deepEqual(tuiModes(plain).map(m => m.sandbox), ['danger-full-access']);
  const ask = build('dsh-ask', { permissionMode: 'default' });
  assert.equal(ask.launch.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(ask.permissionPolicy, 'ask');
  assert.deepEqual(tuiModes(ask).map(m => m.sandbox), ['read-only', 'workspace-write', 'read-only']);
  assert.deepEqual(override(ask), ['read-only', 'ask']);
  assert.deepEqual(override(plain), [], '完全放开不加覆盖行，老用户启动配置不变');
  const edit = build('dsh-edit', { permissionMode: 'acceptEdits' });
  assert.equal(edit.launch.env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.deepEqual(override(edit), ['workspace-write', 'ask']);
  const auto = build('dsh-auto', { permissionMode: 'default', autonomous: true });
  assert.equal(auto.launch.env.DSH_PERMISSION_MODE, 'danger-full-access', 'autonomous 始终完全放开');
});

test('DSH 卡片共享进程：不同权限档分开进程；完全放开的目录与以前相同', () => {
  const card = require('../core/card-run-mode');
  const config = { dshBackend: 'proxy', dshUpstream: '', dshApiModel: 'm' };
  const before = card.dshCardScope(config, {});
  assert.equal(card.dshCardScope(config, { permissionMode: 'bypassPermissions' }), before);
  assert.notEqual(card.dshCardScope(config, { permissionMode: 'default' }), before);
  assert.notEqual(card.dshCardScope(config, { permissionMode: 'default' }), card.dshCardScope(config, { permissionMode: 'acceptEdits' }));
});

test('DSH 终端会话：越界审批时侧栏显示等待输入，答完回到运行中', () => {
  const src = fs.readFileSync(path.join(__dirname, '../core/dsh-cli-session.js'), 'utf8');
  assert.match(src, /event\.type === 'approval\/asked'\) this\.apply\(\{ state: 'waiting'/);
  assert.match(src, /event\.type === 'approval\/decided' && this\.runtime\.state === 'waiting'\) this\.apply\(\{ state: 'running'/);
});

test('默认档存储：新用户默认每步确认；设为默认 / 恢复默认 / 本次覆盖不落盘；坏记录当没记过', () => {
  const last = require('../renderer/launch-last-permission');
  const storage = memoryStorage();
  assert.equal(last.recall(storage, 'claude'), 'default', '全新用户默认每步确认');
  assert.equal(last.recall(storage, 'deepseek-acp'), 'default');
  assert.equal(last.recall(storage, 'pi'), 'bypassPermissions');
  assert.equal(storage.getItem(last.MIGRATION_KEY), 'fresh');
  assert.equal(last.bypassAcknowledged(storage), false);
  assert.equal(last.setDefault(storage, 'claude', 'plan'), 'plan');
  assert.equal(last.setDefault(storage, 'codeagent', 'auto'), 'auto');
  assert.equal(last.setDefault(storage, 'claude', 'auto'), null, 'Claude 不记 auto');
  assert.equal(last.recall(storage, 'claude-resume'), 'plan');
  assert.equal(last.hasCustomDefault(storage, 'claude'), true);
  last.forget(storage, 'claude');
  assert.equal(last.recall(storage, 'claude'), 'default');
  assert.equal(last.recall(storage, 'codeagent'), 'auto', '恢复默认只清当前工具');
  last.setDefault(storage, 'codeagent', 'default');
  assert.equal(storage.data.has(last.STORAGE_KEY), false, '设回产品默认时不留记录');
  last.setDefault(storage, 'codex', 'bypassPermissions');
  assert.equal(last.recall(storage, 'codex'), 'bypassPermissions', '完全放开也能设为默认');
  storage.setItem(last.STORAGE_KEY, '{bad json');
  assert.equal(last.recall(storage, 'claude'), 'default');
  storage.setItem(last.STORAGE_KEY, JSON.stringify({ claude: 'dontAsk' }));
  assert.equal(last.recall(storage, 'claude'), 'default');
  last.acknowledgeBypass(storage);
  assert.equal(last.bypassAcknowledged(storage), true);
});

test('老用户升级：没选过的工具（含 DSH）保持完全放开，选过的保持原样，风险已确认；迁移只做一次', () => {
  const last = require('../renderer/launch-last-permission');
  // 旧版用过启动中心：有上次的目录 / 工具记录；Claude 以前选过每步确认，其余没选（= 完全放开，旧版不留记录）。
  const storage = memoryStorage({ 'hub.launch.lastWorkspace.v1': '{"mode":"default"}',
    [last.STORAGE_KEY]: JSON.stringify({ claude: 'default' }) });
  assert.equal(last.recall(storage, 'claude'), 'default');
  for (const kind of ['codex', 'codeagent', 'deepseek-acp']) assert.equal(last.recall(storage, kind), 'bypassPermissions', kind);
  assert.equal(storage.getItem(last.MIGRATION_KEY), 'legacy');
  assert.equal(last.bypassAcknowledged(storage), true, '老用户不弹完全放开的确认框');
  // 迁移后改了默认，再次打开不会被迁移覆盖。
  last.setDefault(storage, 'codex', 'default');
  assert.equal(last.migrate(storage), 'legacy');
  assert.equal(last.recall(storage, 'codex'), 'default');
  // 只用过「上次工具」记录的老用户也算。
  const other = memoryStorage({ 'hub:lastSessionKind': 'codeagent' });
  assert.equal(last.recall(other, 'codeagent'), 'bypassPermissions');
  // 全新用户本次第一次建会话后写了上次目录：已经判过是新用户，不会再被当成老用户。
  const fresh = memoryStorage();
  assert.equal(last.recall(fresh, 'codeagent'), 'default');
  fresh.setItem('hub.launch.lastWorkspace.v1', '{"mode":"default"}');
  assert.equal(last.recall(fresh, 'codeagent'), 'default');
});

test('启动中心：本次覆盖不自动记住；完全放开第一次要确认；有「设为默认」按钮', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const wc = read('renderer/workspace-controller.js');
  assert.doesNotMatch(wc, /lastPermission\.remember\(/, '建完会话不再把本次所选自动记成默认');
  assert.match(wc, /bypassAcknowledged\(localStorage\)/);
  assert.match(wc, /confirmHubAction\(/);
  assert.match(wc, /lastPermission\.setDefault\(localStorage, selectedKind, currentPermissionMode\(\)\)/);
  assert.match(read('renderer/index.html'), /id="new-session-permission-setdefault"/);
});

test('群聊「从已有会话加入」：保守档启动的 DSH 会话不分支（原生记录会继承确认档，群聊会卡住），完全放开的照常分支', async () => {
  const { registerGroupChatForkIpc } = require('../main/ipc/groupchat-fork-handlers');
  let forks = 0;
  const source = permissionMode => ({ id: 'dsh-src', kind: 'deepseek-acp', title: '源会话', cwd: os.tmpdir(), status: 'idle',
    acpSid: '8fc2f692-84b3-48fe-883e-d6cf86435feb', agentRuntime: 'pty', ...(permissionMode ? { permissionMode } : {}) });
  const api = registerGroupChatForkIpc({ handle() {} }, {
    sessionManager: { getAllSessions: () => [], getNativeSession: () => ({ fork: async () => { forks++; throw new Error('fork-probe'); } }) },
    sessionStore: { loadSessionFile: () => null }, meetingManager: {}, addMeetingSubInternal: async () => ({ session: { id: 'child' } }),
  });
  const blocked = await api.forkSessionIntoMeeting('m1', source('default'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'dsh-permission-inherited');
  assert.match(blocked.message, /每步确认.*完全放开/);
  assert.equal(forks, 0, '没去分支原生会话');
  const full = await api.forkSessionIntoMeeting('m1', source('bypassPermissions'));
  assert.notEqual(full.error, 'dsh-permission-inherited');
  const legacy = await api.forkSessionIntoMeeting('m1', source(undefined));
  assert.notEqual(legacy.error, 'dsh-permission-inherited', '没记权限档的老会话照旧');
});
