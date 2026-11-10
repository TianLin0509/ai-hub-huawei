'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { assistantChatPhase } = require('../renderer/wait-progress');
const { connectionState } = require('../renderer/company-assistant-connection');
const { sanitize } = require('../core/env-check');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
function section(file, start, end) {
  const text = source(file), a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${file}: ${start}`);
  return text.slice(a, b);
}
const assistant = 'renderer/company-assistant-page.js';
const rooms = 'renderer/company-rooms-page.js';
const ppt = 'renderer/company-ppt-page.js';
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('1 守护独立于助理启动，暂停助理保留已启用的守护，定时器不重复建立', () => {
  const boot = section('main.js', '    companyAssistantService.startTools();', '    const bridgeMcpPlan');
  for (const enabled of [false, true]) {
    let starts = 0;
    vm.runInNewContext(boot, { companyAssistantService: { startTools() {}, rooms: { start() { starts++; } }, start() {} }, optionalFeatures: { get: () => enabled } });
    assert.equal(starts, 1);
  }
  for (const enabled of [false, true]) {
    let closed = 0;
    CompanyAssistant.prototype.pause.call({ started: true, stopTimers() {}, meetings: {}, phone: { close() {} }, rooms: { settings: () => ({ enabled }), close() { closed++; } }, lanes: { ppt: { queue: [] } } });
    assert.equal(closed, enabled ? 0 : 1);
  }
  const code = section('core/company-assistant/rooms.js', '  start() {', '  close() {');
  let intervals = 0;
  const context = { setInterval() { intervals++; return intervals; } };
  const booking = vm.runInNewContext(`({ deps: {}, ${code} })`, context);
  booking.start(); booking.start(); assert.equal(intervals, 1);
});

test('2 首次未就绪立刻通知，重试保留起点，就绪后进入回答阶段', async () => {
  let clock = 1000, sends = 0, changes = 0; const patches = [];
  const a = { now: () => clock, deps: { notReadyRetryMs: 0, sendPrompt: async () => { sends++; clock += 1000; return sends < 3 ? { notSent: true, error: 'cli-not-ready' } : { ok: true }; } },
    patchChat: (id, patch) => patches.push({ id, ...patch }), changed() { changes++; }, sessionGone: () => '' };
  const job = { type: 'chat', chatId: 'q' };
  const receipt = await CompanyAssistant.prototype.sendWhenReady.call(a, job, 'session', '问题');
  assert.equal(receipt.ok, true); assert.equal(sends, 3); assert.equal(changes, 1);
  assert.deepEqual(patches, [{ id: 'q', notReadySince: 2000 }]);
  const row = { state: 'running', ...patches[0] };
  assert.match(assistantChatPhase(row).label, /会话还没就绪/);
  assert.equal(assistantChatPhase(row).from, 2000);
  assert.equal(assistantChatPhase({ ...row, answeringAt: 5000 }).label, '正在查…');
});

test('2 终端尾行移除颜色与密钥，最终失败保留可操作原因', async () => {
  const code = section('core/group-chat-watcher.js', '      const terminalLastLine =', '\n    }\n    sessionManager.setGroupChatReady');
  const receipt = vm.runInNewContext(`(function(buf) { ${code} })(buffer)`, { buffer: '旧行\r\n\u001b[31m请登录 Bearer secret-value\u001b[0m\r\n', stripAnsi: require('../core/ansi-utils').stripAnsi, require: () => ({ sanitize }) });
  assert.equal(receipt.terminalLastLine, '请登录 Bearer <密钥>');
  assert.ok(!JSON.stringify(receipt).includes('secret-value'));
  let clock = 1;
  const a = { now: () => clock, deps: { sendPrompt: async () => { clock += 30 * 60000; return receipt; } }, patchChat() {}, changed() {}, sessionGone: () => '' };
  await assert.rejects(CompanyAssistant.prototype.sendWhenReady.call(a, { type: 'chat' }, 's', 'q'), error => {
    assert.match(error.message, /打开助理会话.*可以重问.*终端最后一行：请登录 Bearer <密钥>/);
    assert.ok(!error.message.includes('secret-value')); return true;
  });
});

const DOMAIN = require('../core/company-domain').DEFAULT_DOMAIN;
test('3 Git 邮箱仅限已知公司域名，WeLink 与手填邮箱优先', async () => {
  for (const email of ['employee@' + DOMAIN, 'employee@' + DOMAIN.toUpperCase(), 'person' + '@gmail.com', 'person' + '@another.example', 'broken@@' + DOMAIN]) {
    let saved = {};
    const a = { deps: { dataDir: __dirname, gitGlobalEmail: () => email }, welink: async () => ({ stdout: '{}' }), setSettings(patch) { saved = { ...saved, ...patch }; } };
    const result = await CompanyAssistant.prototype.accountEmail.call(a, {});
    const match = /^employee@/i.test(email);
    assert.equal(result.email, match ? email : '');
    assert.equal(saved.emailFrom, match ? 'git' : undefined);
  }
  const a = { deps: { gitGlobalEmail() { throw Error('不应读取 Git'); } }, welink: async () => ({ stdout: '{"email":"welink@' + DOMAIN + '"}' }), setSettings() {} };
  assert.equal((await CompanyAssistant.prototype.accountEmail.call(a, {})).from, 'welink');
  assert.equal((await CompanyAssistant.prototype.accountEmail.call(a, { email: 'saved@' + DOMAIN })).email, 'saved@' + DOMAIN);
});

test('3 邮箱提示条直接配置，复用配置动作并转义输入', async () => {
  const context = { data: { calendarNeedsSetup: true, mailSetup: { reason: 'no-email', email: '"><img>' } }, connectionState: () => ({ kind: 'online' }), esc, onboardingShown: () => false };
  vm.createContext(context); vm.runInContext(section(assistant, '  function alerts() {', '  // welink-cli'), context);
  const html = context.alerts();
  assert.match(html, /data-ca-email/); assert.match(html, /保存并配置/); assert.ok(!html.includes('去设置'));
  assert.ok(html.includes('&quot;&gt;&lt;img&gt;'));
  const calls = [], input = { value: 'employee@' + DOMAIN }, msg = {};
  Object.assign(context, { call: async (op, args) => { calls.push({ op, args }); return {}; }, load: async () => {} });
  vm.runInContext(section(assistant, '  async function setupMail(', '  const TABS'), context);
  await context.setupMail(input, msg, {});
  assert.equal(calls[0].op, 'setup-calendar'); assert.equal(calls[0].args.email, input.value);
  assert.match(source(assistant), /verb === 'configure-mail'.*setupMail\(page.querySelector\('\[data-ca-email\]'/);
});

function roomContext() {
  const calls = [], message = {}, draft = { 会后动作: { 模式: '通知模式' }, 高级: { 'welink-cli路径': '' } };
  let installed = false;
  const context = { draft, changed: new Set(), copy: value => JSON.parse(JSON.stringify(value)), slot: () => message, updateControls() {}, refresh: async () => {},
    validate: () => context.draft, call: async op => { calls.push(op); if (op === 'status') return { cliPath: installed ? 'C:\\tools\\welink.exe' : '', cliInstallAvailable: true }; if (op === 'install-cli') { installed = true; return { ok: true }; } } };
  vm.createContext(context);
  vm.runInContext(section(rooms, '  async function save() {', '  async function act('), context);
  return { context, calls, message };
}
test('4 会议室会后动作一键安装后回填保存，保存时复用已发现路径', async () => {
  const { context, calls, message } = roomContext();
  await context.findCli();
  assert.deepEqual(calls, ['find-cli', 'status', 'install-cli', 'status', 'room-command']);
  assert.equal(context.draft.高级['welink-cli路径'], 'C:\\tools\\welink.exe');
  assert.match(message.textContent, /已找到/);
  context.draft.高级['welink-cli路径'] = ''; calls.length = 0;
  await context.save(); assert.deepEqual(calls, ['status', 'room-command']);
  assert.equal(context.draft.高级['welink-cli路径'], 'C:\\tools\\welink.exe');
});
test('4 无安装器或安装失败保留下一步，不报 npm 手工安装', async () => {
  const { context, calls, message } = roomContext();
  context.call = async op => { calls.push(op); return { cliInstallAvailable: false }; };
  await context.findCli(); assert.ok(!calls.includes('install-cli')); assert.match(message.textContent, /一键安装/);
  context.call = async op => op === 'status' ? { cliInstallAvailable: true } : { ok: false, error: '网络不可用，可重试' };
  await context.findCli(); assert.match(message.textContent, /网络不可用，可重试/);
  assert.ok(!source('core/company-assistant/welink.js').includes('公司电脑上需先安装'));
});

function pptContext() {
  const nodes = new Map(), notices = [], calls = [];
  const node = key => { if (!nodes.has(key)) nodes.set(key, { value: '', textContent: '', dataset: {}, style: {}, classList: { toggle() {} }, removeAttribute() {}, append(child) { this.child = child; } }); return nodes.get(key); };
  const context = { page: { querySelector: node }, esc, toolHint() {}, window: {}, notice: text => notices.push(text), call: async op => calls.push(op) };
  vm.createContext(context);
  vm.runInContext(section(ppt, '  function renderStatus(p) {', '  const folder ='), context);
  vm.runInContext(section(ppt, '  async function search(withAgent) {', '  const PHASES'), context);
  return { context, nodes, notices, calls };
}
test('5 Doctor 就绪但无索引：正文显示选素材按钮，检索不调用 AI', async () => {
  const { context, nodes, notices, calls } = pptContext();
  context.renderStatus({ available: true, pages: 0, roots: [] });
  const status = nodes.get('[data-ppt-status]');
  assert.equal(nodes.get('[data-ppt-guide-slot]').child, status);
  assert.match(status.innerHTML, /data-ppt="folders".*选择素材文件夹/);
  await context.search(true); await context.search(false);
  assert.equal(calls.length, 0); assert.match(notices[0], /选完会自动建立索引/);
  context.renderStatus({ available: true, pages: 0, indexing: { state: 'indexing', message: '正在读素材' } });
  assert.match(status.innerHTML, /disabled/); await context.search(true); assert.match(notices.at(-1), /正在建立/);
  context.renderStatus({ available: true, pages: 20, files: 2 });
  assert.equal(nodes.get('[data-ppt-head-slot]').child, status);
});

function chatContext(row) {
  const context = { data: { chat: [row] }, visibleChat: list => list, labelFor: () => () => '', dayOf: () => '', when: () => '', esc, body: esc, tagSources: text => text,
    USER_AVATAR_SRC: '', ASSISTANT_AVATAR_SRC: '', secondsText: () => '', waitPhase: assistantChatPhase, window: { HubErrorCard: { knownHtml: args => `<aside>${esc(args.area)}:${esc(args.details)}</aside>` } } };
  vm.createContext(context); vm.runInContext(section(assistant, '  function chatList() {', '  // 进行中的已用秒数'), context);
  return context;
}
test('2、6 等待可打开会话，失败显示 CodeAgent 修复卡，错误文本转义', () => {
  const context = chatContext({ state: 'running', id: 'q', q: '问题', notReadySince: 1000 });
  assert.match(context.chatList(), /data-ca="open-session">打开助理会话/);
  context.data.chat[0] = { state: 'error', error: '<img onerror=x>', id: 'q' };
  const html = context.chatList(); assert.match(html, /<aside>codeagent:/); assert.ok(!html.includes('<img onerror'));
  context.data.chat[0].stopped = true; assert.ok(!context.chatList().includes('<aside>'));
});
test('7 连接尚未确认时保留扫码按钮', () => {
  const context = { data: { cliFound: true, auth: { state: 'unknown' } }, connectionState, onboardingShown: () => true, esc, window: {} };
  vm.createContext(context); vm.runInContext(section(assistant, '  function onboarding() {', '\n  function '), context);
  assert.match(context.onboarding(), /data-ca="login">扫码登录/);
});

test('8 桌宠提示开启后复用按钮，点确认才开启并发送原问题', async () => {
  const nodes = new Map(), events = new Map(), sent = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', hidden: false, classList: { remove() {}, add() {} }, addEventListener(name, fn) { events.set(id + ':' + name, fn); }, focus() {} }); return nodes.get(id); };
  let onResult;
  const context = { $: node, api: { ask: (text, enable) => sent.push({ text, enable }), onAskOpen() {}, onAskResult: fn => { onResult = fn; } }, window: { addEventListener() {} }, setTimeout() {}, clearTimeout() {}, layoutOverlays() {}, setHit() {}, panelEl: {} };
  vm.runInNewContext(section('renderer/hub-pet/pet.js', "  const askEl = $('ask')", '  // ---------- 鼠标'), context);
  node('ask-input').value = '原问题'; events.get('ask:submit')({ preventDefault() {} });
  assert.deepEqual(sent, [{ text: '原问题', enable: false }]);
  onResult({ ok: false, enableAssistant: true, error: '助理未开启' });
  assert.equal(node('ask-send').textContent, '开启助理并发送');
  node('ask-input').value = '后改的内容'; events.get('ask:submit')({ preventDefault() {} });
  assert.deepEqual(sent[1], { text: '原问题', enable: true });
  const ask = section('main.js', '        askAssistant: (text,', '        getPages:');
  let enabled = false; const called = [];
  const callbacks = vm.runInNewContext(`({ ${ask} })`, { companyAssistantService: { start() { called.push('start'); }, ask(text) { called.push(text); } }, optionalFeatures: { get: () => enabled, set(_key, value) { enabled = value; } }, sendToRenderer() {}, optionalFeatureList: () => [] });
  assert.throws(() => callbacks.askAssistant('原问题'), error => error.code === 'ASSISTANT_DISABLED'); assert.equal(enabled, false);
  callbacks.askAssistant('原问题', { enableAssistant: true }); assert.equal(enabled, true); assert.deepEqual(called, ['start', '原问题']);
  const replies = [];
  const handler = section('main/hub-pet-controller.js', "    'hub-pet:ask': (event, payload) => {", "    'hub-pet:ask-close':");
  const handlers = vm.runInNewContext(`({ ${handler} })`, { fromPet: () => true, send: (_channel, result) => replies.push(result), askAssistant: callbacks.askAssistant, evaluate() {} });
  enabled = false;
  handlers['hub-pet:ask']({}, { text: '原问题' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].enableAssistant, true); assert.equal(enabled, false);
  handlers['hub-pet:ask']({}, { text: '原问题', enableAssistant: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[1].ok, true); assert.equal(enabled, true);
  let api, payload;
  vm.runInNewContext(source('renderer/hub-pet/pet-preload.js'), { require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: { send(_channel, value) { payload = value; } } }) });
  api.ask('原问题', true); assert.equal(payload.text, '原问题'); assert.equal(payload.enableAssistant, true);
});
