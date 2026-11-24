'use strict';
// 全新用户被误导的 7 处（2026-11-21 隔离 Hub 深查 #6 #7 #8 #9 #11 #12 #13）。每条撤掉修复都会在这里失败。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('#6 没有 CodeAgent 时启动中心不默认选公司模型，也不因此把设置改写成公司模型', () => {
  const cards = require('../renderer/launch-model-cards');
  const fresh = { backend: 'local', companyDefault: true, model: '', own: { backend: 'local', model: '' }, companyModels: [{ id: 'GLM-5.2-WX', label: 'GLM-5.2-WX' }] };
  const pick = cards.defaultPick('claude', fresh, { codeagentInstalled: false });
  assert.equal(pick.source, 'own', '没装 CodeAgent 时默认选本工具自己的来源');
  const req = cards.saveRequest('claude', fresh, pick);
  assert.ok(!req || req.backend !== 'proxy', '创建时不能把设置写成公司模型');
  // 配过部门 API key：按能用的网关选
  const withGw = { ...fresh, gatewayModels: [{ id: 'glm-5', label: 'glm-5' }] };
  assert.deepEqual(cards.defaultPick('claude', withGw, { codeagentInstalled: false }), { source: 'gateway', model: 'glm-5' });
  assert.equal(cards.defaultPick('deepseek-acp', withGw, { codeagentInstalled: false }).source, 'gateway');
  // 装了 CodeAgent / 还没测完：行为不变，仍默认公司模型
  assert.equal(cards.defaultPick('claude', fresh, { codeagentInstalled: true }).source, 'company');
  assert.equal(cards.defaultPick('claude', fresh).source, 'company');
  // 用户自己存过公司模型：照旧尊重
  assert.equal(cards.defaultPick('claude', { ...fresh, backend: 'proxy', companyDefault: false, model: 'GLM-5.2-WX' }, { codeagentInstalled: false }).source, 'company');
  // 启动中心真把检测结果传进来
  const wc = read('renderer/workspace-controller.js');
  assert.match(wc, /modelCards\.defaultPick\(kind, provider, \{ codeagentInstalled \}\)/);
});

test('#7 报错、说明书、生成模板和英文词典里的按钮名与界面一致', () => {
  const hits = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!['node_modules', 'vendor'].includes(ent.name)) walk(rel); continue; }
      if (!/\.(m?js|html|json|md)$/.test(ent.name)) continue;
      if (read(rel).includes(['重新启动', '反代'].join(''))) hits.push(rel);
    }
  };
  // 公开版不带 tools/help-manual，缺的目录跳过
  for (const dir of ['core', 'main', 'renderer', 'tools/help-manual']) if (fs.existsSync(path.join(root, dir))) walk(dir);
  assert.deepEqual(hits, []);
  assert.match(read('renderer/company-api-settings.js'), /'重新启动模型通道'/, '设置页按钮名就是「重新启动模型通道」');
  assert.match(read('core/company-proxy/upstream-profile.mjs'), /点「重新启动模型通道」/);
  assert.match(read('core/env-check.js'), /label: '重新启动模型通道'/);
});

test('#8 启动中心之上的安装弹窗里按 Esc、点遮罩，只关弹窗不关启动中心', () => {
  const { eventFromLayerAbove } = require('../renderer/launch-center-controller');
  const wrapper = { contains: node => node && node.inWrapper === true };
  const dialog = { inWrapper: false, matches: sel => sel === ':modal' };
  const inDialog = { closest: sel => (sel === 'dialog[open]' ? dialog : null) };
  const outside = { closest: () => null };
  const doc = open => ({ querySelectorAll: () => (open ? [dialog] : []) });
  assert.equal(eventFromLayerAbove({ type: 'mousedown', target: inDialog }, wrapper, doc(true)), true, '点在弹窗（含遮罩）上');
  assert.equal(eventFromLayerAbove({ type: 'keydown', key: 'Escape', target: outside }, wrapper, doc(true)), true, '弹窗开着时的 Esc');
  assert.equal(eventFromLayerAbove({ type: 'mousedown', target: outside }, wrapper, doc(false)), false, '没有弹窗时点外面照常关启动中心');
  assert.equal(eventFromLayerAbove({ type: 'keydown', key: 'Escape', target: outside }, wrapper, doc(false)), false, '没有弹窗时 Esc 照常关');
  const src = read('renderer/renderer.js');
  const mouse = src.slice(src.indexOf("document.addEventListener('mousedown', (e) => {"), src.indexOf('menuEl.addEventListener(\'mousedown\''));
  assert.match(mouse, /eventFromLayerAbove\(e, wrapperEl, document\)/);
  const esc = src.slice(src.indexOf('// ESC 关闭任意打开的侧栏 modal'), src.indexOf('// ESC 关闭任意打开的侧栏 modal') + 300);
  assert.match(esc, /eventFromLayerAbove\(e, wrapperEl, document\)/);
});

test('#9 新建 AI 群聊的默认成员按本机能用的 AI 选，一个都没有时就地说明', () => {
  const pref = require('../renderer/codeagent-preference');
  const kinds = ['codeagent', 'claude', 'codex', 'deepseek-acp'];
  const fallback = [{ kind: 'claude' }, { kind: 'codex' }];
  const avail = map => kind => (kind in map ? map[kind] : null);
  assert.deepEqual(pref.groupMembersFor(kinds, avail({ codeagent: true }), fallback).members.map(m => m.kind), ['codeagent', 'codeagent']);
  const onlyClaude = pref.groupMembersFor(kinds, avail({ codeagent: false, claude: true, codex: false, 'deepseek-acp': false }), fallback);
  assert.deepEqual(onlyClaude.members.map(m => m.kind), ['claude', 'claude']);
  assert.equal(onlyClaude.missing, false);
  assert.deepEqual(pref.groupMembersFor(kinds, avail({ codeagent: false, codex: true, 'deepseek-acp': true }), fallback).members.map(m => m.kind), ['codex', 'deepseek-acp']);
  const none = pref.groupMembersFor(kinds, avail({ codeagent: false, claude: false, codex: false, 'deepseek-acp': false }), fallback);
  assert.equal(none.missing, true, '全都没装要就地说明');
  const modal = read('renderer/meeting-create-modal.js');
  assert.match(modal, /groupMembersFor\(kinds, _kindAvailable, DEFAULT_GROUP_MEMBERS\)/);
  assert.match(modal, /id="mcm-members-missing"/);
  assert.match(modal, /id="mcm-members-missing-go"/);
});

// 运行真实弹窗的打开、关闭、默认成员初始化和事件绑定；仅替换排版与 DOM 读取。
function pendingGroupModal(available = {}) {
  const vm = require('node:vm');
  const localRequire = require('node:module').createRequire(path.join(root, 'renderer/meeting-create-modal.js'));
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      style: {}, classList: { toggle() {} }, value: '', listeners: {},
      setAttribute() {}, removeAttribute() {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
    });
    return nodes.get(selector);
  };
  const modal = { style: {}, classList: { toggle() {} }, addEventListener() {},
    querySelector: node, querySelectorAll: () => [] };
  const body = { appendChild() {} };
  modal.parentElement = body;
  const document = { body, addEventListener() {}, removeEventListener() {},
    querySelector: selector => ({ dataset: { installed: available[selector.match(/data-kind="([^"]+)"/)[1]] ? '1' : '0' } }) };
  const ipcRenderer = { invoke: () => detection };
  let finish;
  const detection = new Promise(resolve => { finish = resolve; });
  // 使用独立的真实 preference 模块，避免别的测试留下 installed 缓存。
  const preference = { exports: {} };
  vm.runInNewContext(read('renderer/codeagent-preference.js'), {
    module: preference, require: localRequire,
  });
  const window = { WorkspaceController: { loadSessionDefaults: async () => {} } };
  const source = read('renderer/meeting-create-modal.js').replace(/\}\)\(\);\s*$/, `
    _modalEl = testModal;
    _ensureModal = _setOrchestration = _paintWorkspace = _clearError = () => {};
    _loadSceneHints = _loadProjectLibrary = async () => {};
    _renderSlots = _syncGroupSlotsFromDom = () => {};
    _normalizeSlotSpec = spec => ({ ...spec });
    _bindEvents();
    window.inspectMembers = () => JSON.parse(JSON.stringify({ slots: _groupSlots, missing: _membersMissing }));
    window.seedMembers = () => { _groupSlots = [{ kind: 'codex', model: 'custom' }]; };
    window.membersReady = () => _membersReady;
  })();`);
  vm.runInNewContext(source, { window, document, testModal: modal,
    require: id => id === 'electron' ? { ipcRenderer }
      : id === './codeagent-preference' ? preference.exports : localRequire(id),
  });
  const inspect = window.inspectMembers;
  window.inspectMembers = () => JSON.parse(JSON.stringify(inspect()));
  return { window, node, finish, async settle(installed) {
    finish({ installed });
    await window.membersReady();
  } };
}

test('#9 CLI 检测未完成就打开群聊：等待检测再初始化，未安装时显示就地说明', async () => {
  const modal = pendingGroupModal();
  modal.window.openMeetingCreateModal();
  assert.equal(modal.window.inspectMembers().slots.length, 0, '检测前不预填 CodeAgent');
  await modal.settle(false);
  assert.deepEqual(modal.window.inspectMembers(), {
    slots: [{ kind: 'claude' }, { kind: 'codex' }], missing: true,
  });
});

test('#9 检测确认 CodeAgent 已安装：保留原有两名默认成员和模型', async () => {
  const modal = pendingGroupModal();
  modal.window.openMeetingCreateModal();
  await modal.settle(true);
  assert.deepEqual(modal.window.inspectMembers().slots, [
    { kind: 'codeagent', model: 'GLM-5.2-WX-Auto' },
    { kind: 'codeagent', model: 'MiniMax-M2.7' },
  ]);
});

test('#9 检测确认没有 CodeAgent、只有 Claude 时选两名 Claude', async () => {
  const modal = pendingGroupModal({ claude: true });
  modal.window.openMeetingCreateModal();
  await modal.settle(false);
  assert.deepEqual(modal.window.inspectMembers(), {
    slots: [{ kind: 'claude' }, { kind: 'claude' }], missing: false,
  });
});

for (const action of ['add', 'change', 'remove']) {
  test(`#9 检测期间手动编辑成员（${action}），检测完成后不覆盖`, async () => {
    const modal = pendingGroupModal();
    modal.window.openMeetingCreateModal();
    if (action === 'add') modal.node('#mcm-add-member').listeners.click();
    else modal.window.seedMembers();
    if (action === 'change') modal.node('.mcm-slots').listeners.change();
    if (action === 'remove') modal.node('.mcm-slots').listeners.click({ target: { closest: () => ({}) } });
    const edited = modal.window.inspectMembers();
    await modal.settle(false);
    assert.deepEqual(modal.window.inspectMembers(), edited);
  });
}

test('#9 关掉或重新打开群聊后，旧检测回调不能写回上一次成员', async () => {
  const modal = pendingGroupModal();
  modal.window.openMeetingCreateModal();
  modal.window.closeMeetingCreateModal();
  await modal.settle(true);
  assert.equal(modal.window.inspectMembers().slots.length, 0);
  modal.window.openMeetingCreateModal();
  await modal.window.membersReady();
  assert.equal(modal.window.inspectMembers().slots.length, 2);
});

test('#11 考勤读取中按钮置灰显示「读取中…」；连不上时报错是人话', async () => {
  const page = read('renderer/company-attendance-page.js');
  assert.match(page, /data-att="sync"\$\{status\.syncing \? ' disabled aria-busy="true"' : ''\}>\$\{status\.syncing \? '读取中…' : '现在读取'\}/);
  assert.match(page, /querySelectorAll\('\[data-att="sync"\]'\)\.forEach\(b => \{ b\.disabled = !!status\.syncing; \}\)/);
  const { CompanyAttendance } = require('../core/company-attendance/service');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsit-att-'));
  const svc = new CompanyAttendance({ dataDir, noTimer: true, now: () => new Date('2026-11-21T09:00:00'), accountEmail: () => 'someone@corp.example',
    browser: { capture: async ({ url }) => { throw new Error(`ERR_CONNECTION_CLOSED (-100) loading '${url}'`); }, login: async () => ({ ok: true }) } });
  const e = await svc.sync();
  assert.equal(e.ok, false);
  assert.equal(e.netFail, true);
  assert.match(e.error, /^连不上考勤页 hr\.corp\.example（网络报错 ERR_CONNECTION_CLOSED）：多半是这台电脑现在没连公司内网/);
  assert.doesNotMatch(e.error, /loading '/, '不再露出浏览器原始报错');
  assert.equal(e.triedPages, false, '网络问题换考勤页没用，不给换页选项');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('#12 助理输入框按实际情况显示状态，不在什么都没接时写「已就绪」', () => {
  const { composerState } = require('../renderer/company-assistant-connection');
  const offline = { cliFound: false, cliInstallAvailable: true, cliSearch: { state: 'done' } };
  const noAi = composerState(offline, { codeagentInstalled: false });
  assert.doesNotMatch(noAi.text, /已就绪/);
  assert.match(noAi.text, /没找到 CodeAgent/);
  assert.equal(noAi.action, 'install-codeagent');
  const noWelink = composerState(offline, { codeagentInstalled: true });
  assert.match(noWelink.text, /WeLink 还没接上/);
  assert.equal(noWelink.action, 'install-cli', '就地给 WeLink 的接入入口');
  const online = { cliFound: true, auth: { state: 'online', login: { ok: true } } };
  assert.equal(composerState(online, { codeagentInstalled: true }).text, '已就绪 · 只读，草稿你自己发');
  assert.equal(composerState({ ...online, job: { type: 'ask' } }, { codeagentInstalled: false }).busy, true);
  const pageSrc = read('renderer/company-assistant-page.js');
  assert.match(pageSrc, /composerState\(data, \{ codeagentInstalled: codeagentPref\.detectedInstalled\(\) \}\)/);
  assert.match(pageSrc, /verb === 'install-codeagent'/);
  // 引导卡上「接通前也可以直接提问」在没装 CodeAgent 时改口，和输入框状态一致
  assert.match(pageSrc, /codeagentPref\.detectedInstalled\(\) === false(?: && !data\.answerRoute)? \? '提问要靠本机 CodeAgent 回答/);
});

test('#13 主页「连接你的 AI」不再让人去设置页，和下面的 API key 卡说法一致', () => {
  const src = read('renderer/community-welcome.js');
  assert.doesNotMatch(src, /在设置中配置自有 API/);
  assert.match(src, /直接用下面的部门 API key/);
  assert.match(read('renderer/api-gateway-welcome.js'), /不用去设置页/);
  assert.ok(read('core/i18n/locales/en/launch.json').includes('直接用下面的部门 API key'), '英文译文要跟着改');
});
