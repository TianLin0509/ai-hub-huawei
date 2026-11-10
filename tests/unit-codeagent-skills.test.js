'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../renderer/composer-codeagent-skills');
const { scanCodeAgentSkills, collectCapabilities } = require('../core/capability-catalog');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function isolateInputDiagnostics(t) {
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = temp(t);
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
}
function install(root, name, body) {
  const dir = path.join(root, 'skills', name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body || `---\nname: ${path.basename(name)}\ndescription: A test skill\nargument-hint: '[requirements]'\n---\nInstructions stay in the file.\n`);
  return dir;
}

test('session skill inventory reuses catalog metadata, supports marketplace nesting and missing optional fields', t => {
  const dir = temp(t), config = path.join(dir, 'fake-home', '.cac');
  const direct = install(config, 'insight-hub');
  const nested = install(config, 'market/report', '---\ndescription: >\n  Multi-line\n  description\n---\nbody');
  install(config, 'missing-description', '---\nname: brief\n---\nbody');
  install(config, 'no-frontmatter', '# not metadata');
  const result = scanCodeAgentSkills(config);
  assert.deepEqual(result.skills.map(skill => skill.name), ['brief', 'insight-hub', 'report']);
  assert.equal(result.skills.find(skill => skill.name === 'insight-hub')['argument-hint'], '[requirements]');
  assert.equal(result.skills.find(skill => skill.name === 'brief').description, '');
  assert.equal(result.skills.find(skill => skill.name === 'report').description, 'Multi-line description');
  assert.equal(result.skills.find(skill => skill.name === 'report').directory, nested);
  assert.equal(result.skills.find(skill => skill.name === 'insight-hub').installedAt, fs.statSync(direct).mtimeMs);
  assert.match(result.warnings.join('\n'), /缺少技能元数据/);
  const catalog = collectCapabilities({ homeDir: path.join(dir, 'fake-home'), dataDir: path.join(dir, 'data'), codeagentConfigDir: config });
  assert.equal(catalog.rows.find(row => row.type === 'skill' && row.name === 'report').description, result.skills.find(skill => skill.name === 'report').description);
});

test('missing skills is an empty inventory; unreadable or non-directory skills yields an explicit failure', t => {
  const dir = temp(t);
  assert.deepEqual(scanCodeAgentSkills(dir), { skills: [], warnings: [] });
  fs.writeFileSync(path.join(dir, 'skills'), 'not a directory');
  assert.throws(() => scanCodeAgentSkills(dir));
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  assert.throws(() => scanCodeAgentSkills(dir, { fsModule: { readdirSync: () => { throw denied; } } }), /permission denied/);
});

test('skills IPC reads the live session personal or pool directory and rescans each call', async t => {
  const dir = temp(t), personal = path.join(dir, 'personal-config');
  const before = { CLAUDE_HUB_DATA_DIR: process.env.CLAUDE_HUB_DATA_DIR, AI_HUB_CODEAGENT_CONFIG_DIR: process.env.AI_HUB_CODEAGENT_CONFIG_DIR };
  process.env.CLAUDE_HUB_DATA_DIR = dir; process.env.AI_HUB_CODEAGENT_CONFIG_DIR = personal;
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const poolDir = require('../core/codeagent-pool').accountDir(dir, 'testpool');
  install(personal, 'personal-only'); install(poolDir, 'pool-only');
  const sessions = new Map([
    ['personal', { kind: 'codeagent', codeagentConfigDir: personal }],
    ['pool', { kind: 'codeagent-resume', codeagentConfigDir: poolDir, codeagentPoolAccount: 'testpool' }],
    ['legacy-pool', { kind: 'codeagent', codeagentPoolAccount: 'testpool' }],
    ['legacy-personal', { kind: 'codeagent' }], ['other', { kind: 'claude' }],
  ]);
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getSession: id => sessions.get(id), codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [] }, sendToRenderer() {},
  });
  const read = sessionId => handlers.get('codeagent:skills')(null, { sessionId });
  assert.deepEqual((await read('personal')).commands, []);
  fs.mkdirSync(path.join(dir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codeagent-pool', 'codeagent-commands.json'), JSON.stringify({ version: 1, accounts: {
    personal: { version: 'fixture-version', commands: [{ name: 'cache-skill', kind: 'skill' }, { name: 'model', kind: 'command' }] },
    testpool: { version: 'fixture-version', commands: [{ name: 'pool-cache-skill', kind: 'skill' }] },
  } }));
  assert.deepEqual((await read('personal')).commands.filter(row => row.kind === 'skill').map(row => row.name), ['cache-skill']);
  assert.deepEqual((await read('pool')).commands.filter(row => row.kind === 'skill').map(row => row.name), ['pool-cache-skill']);
  assert.deepEqual((await read('personal')).skills.map(skill => skill.name), ['personal-only']);
  assert.deepEqual((await read('pool')).skills.map(skill => skill.name), ['pool-only']);
  assert.deepEqual((await read('legacy-pool')).skills.map(skill => skill.name), ['pool-only']);
  assert.deepEqual((await read('legacy-personal')).skills.map(skill => skill.name), ['personal-only']);
  install(personal, 'added-later');
  assert.deepEqual((await read('personal')).skills.map(skill => skill.name), ['added-later', 'personal-only']);
  assert.equal((await read('other')).ok, false);
  assert.equal((await read('nonexistent')).ok, false);
  sessions.set('broken', { kind: 'codeagent', codeagentConfigDir: path.join(dir, 'broken') });
  fs.mkdirSync(path.join(dir, 'broken')); fs.writeFileSync(path.join(dir, 'broken', 'skills'), 'not a directory');
  assert.match((await read('broken')).error, /读取技能失败/);
});

// Minimal DOM for the actual chip/controller code; no Electron or browser dependency.
class Node {
  constructor(document, tag, text = '') { this.ownerDocument = document; this.tagName = tag?.toUpperCase(); this.nodeType = tag ? 1 : 3; this.valueText = text; this.childNodes = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attributes = {}; }
  get textContent() { return this.nodeType === 3 ? this.valueText : this.valueText + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text) {
    if (this.nodeType === 3) this.valueText = String(text);
    else { this.replaceChildren(); if (String(text)) this.append(this.ownerDocument.createTextNode(String(text))); }
  }
  get innerText() { return this.textContent; }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  get nextSibling() { const nodes = this.parentNode?.childNodes || []; return nodes[nodes.indexOf(this) + 1] || null; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  append(...nodes) { for (let node of nodes) { if (typeof node === 'string') node = this.ownerDocument.createTextNode(node); node.remove(); node.parentNode = this; this.childNodes.push(node); } }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { for (const node of [...nodes].reverse()) this.insertBefore(node, this.childNodes[0] || null); }
  insertBefore(node, before) { node.remove(); const at = this.childNodes.indexOf(before); node.parentNode = this; this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node); }
  replaceWith(node) { const parent = this.parentNode; parent.insertBefore(node, this); this.remove(); }
  replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.valueText = ''; this.append(...nodes); }
  remove() { if (this.parentNode) { const list = this.parentNode.childNodes; list.splice(list.indexOf(this), 1); this.parentNode = null; } }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  matches(selector) { if (selector === '[data-codeagent-skill]') return !!this.dataset.codeagentSkill; if (selector.startsWith('.')) return this.className?.split(' ').includes(selector.slice(1)); return this.tagName === selector.toUpperCase(); }
  querySelectorAll(selector) { return this.childNodes.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }
  dispatchEvent(event) { event.target ||= this; for (const fn of this.listeners[event.type] || []) fn(event); return true; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 20, top: 500, width: 400, height: this.className === 'fi-skill-picker' ? 240 : 30 }; }
}
function dom() {
  const document = { createElement: tag => new Node(document, tag), createTextNode: text => new Node(document, null, text) };
  document.head = new Node(document, 'head'); document.body = new Node(document, 'body');
  document.getElementById = id => [...document.head.childNodes, ...document.body.childNodes].find(node => node.id === id);
  document.addEventListener = Node.prototype.addEventListener.bind(document); document.removeEventListener = Node.prototype.removeEventListener.bind(document); document.listeners = {};
  let caret = { startContainer: null, startOffset: 0 };
  const selection = { isCollapsed: true, rangeCount: 1, getRangeAt: () => caret, removeAllRanges() {}, addRange: range => { caret = range; } };
  document.createRange = () => ({ setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }, collapse() {},
    selectNodeContents(node) { this.root = node; }, setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }, toString() { return this.root.textContent.slice(0, this.endOffset); } });
  const window = { innerWidth: 1000, getSelection: () => selection, Event: class { constructor(type) { this.type = type; } } };
  const input = document.createElement('div'); document.body.append(input);
  return { document, window, input, caret: at => { caret = { startContainer: input, startOffset: at }; } };
}
function event(type, extra = {}) { return { type, ...extra, preventDefault() { this.prevented = true; }, stopPropagation() {} }; }
const session = { kind: 'codeagent', createdAt: 1000 };

test('a skill tag inserts, replaces, deletes, and sends exactly one slash command with or without requirements', () => {
  const f = dom(); f.input.textContent = '写一份总结';
  let changes = 0;
  const context = { ...f, session, onChange: () => { changes += 1; } };
  const first = skills.insertSkillTag(f.input, { name: 'insight-hub', installedAt: 1 }, context);
  assert.equal(first.contentEditable, 'false');
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/insight-hub 写一份总结');
  assert.equal(f.window.getSelection().getRangeAt(0).startOffset, 1);
  skills.insertSkillTag(f.input, { name: 'report', installedAt: 2 }, context);
  assert.equal(f.input.querySelectorAll('[data-codeagent-skill]').length, 1);
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/report 写一份总结');
  f.input.querySelector('.fi-skill-remove').dispatchEvent(event('click'));
  assert.equal(changes, 1);
  assert.equal(skills.selectedSkill(f.input), null);
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '写一份总结');
  f.input.textContent = '';
  skills.insertSkillTag(f.input, { name: 'report' }, context);
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/report');
  assert.equal(skills.skillPrompt(f.input, '/report   indented\n  second line', session), '/report   indented\n  second line');
});

test('command cache is account and version scoped; missing caches and mismatched versions have no commands', t => {
  const dir = temp(t), { readCommands } = require('../core/codeagent-command-cache');
  assert.deepEqual(readCommands(dir, session), []);
  fs.mkdirSync(path.join(dir, 'codeagent-pool'));
  fs.writeFileSync(path.join(dir, 'codeagent-pool/codeagent-commands.json'), JSON.stringify({ version: 1, accounts: {
    personal: { version: '1.26', commands: [{ name: '/model', aliases: ['m'], description: 'Choose model', kind: 'command' },
      { name: 'sdd:proposal', aliases: [], description: 'Proposal', kind: 'custom-command' }, { name: 'batch', aliases: [], description: 'Plan', kind: 'skill' }] },
    pool1: { version: '1.27', commands: [{ name: 'help', aliases: [], description: 'Help' }] },
  } }));
  assert.deepEqual(readCommands(dir, session).map(row => [row.name, row.kind]), [['model', 'command'], ['sdd:proposal', 'custom-command'], ['batch', 'skill']]);
  assert.deepEqual(readCommands(dir, { codeagentPoolAccount: 'pool1' }).map(row => row.name), ['help']);
  assert.deepEqual(readCommands(dir, { codeagentPoolAccount: 'pool1', codeagentVersion: '1.26' }), []);
  assert.deepEqual(readCommands(dir, { codeagentPoolAccount: 'missing' }), []);
});

test('slash popup groups skills and cached commands, searches aliases and descriptions, and completes commands', async () => {
  const commands = [{ name: 'help', aliases: ['assist'], description: 'Find answers' }, { name: 'model', aliases: ['m'], description: 'Choose model' }];
  assert.deepEqual(skills.commandChoices(commands, 'ASSIST').map(row => row.label), ['help']);
  assert.deepEqual(skills.commandChoices(commands, 'answers').map(row => row.label), ['help']);
  assert.equal(skills.commandName('/ASSIST text', commands), 'help');
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'report' }], commands }) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.deepEqual(popup.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 2', '技能 1']);
  assert.equal(popup.querySelector('.fi-skill-footer').hidden, true);
  assert.match(f.document.getElementById('fi-codeagent-skills-style').textContent, /\.fi-skill-footer\[hidden\]\s*\{\s*display:none/);
  f.input.textContent = '/assist'; f.caret(7); f.input.dispatchEvent(event('input'));
  f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  assert.equal(f.input.textContent, '/help '); assert.equal(skills.selectedSkill(f.input), null);
  assert.equal(f.controller.isCommand('/assist details'), 'help');
});

test('model and skills choices open Hub controls; absent commands show status without terminal fallback', async () => {
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [], commands: [{ name: 'model' }, { name: 'skills' }] }) });
  f.input.textContent = '/model'; f.caret(6); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.calls.at(-1), 'model'); assert.equal(f.input.textContent, '');
  f.input.textContent = '/skills'; f.caret(7); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  assert.equal(f.document.body.querySelector('.fi-skill-picker').hidden, false); assert.equal(f.input.textContent, '');
  const missing = pickerFixture(); missing.input.textContent = '/not-installed'; missing.caret(4); missing.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const popup = missing.document.body.querySelector('.fi-skill-picker');
  assert.equal(popup.querySelectorAll('.fi-skill-option').length, 0);
  assert.doesNotMatch(popup.textContent, /在终端执行|CodeAgent 内置命令|从 AgentCenter 添加/);
  assert.equal(popup.querySelector('.fi-command-probe-text').textContent, '尚未读取命令列表');
  assert.equal(popup.querySelector('.fi-command-probe-retry').textContent, '重试');
  assert.equal(missing.controller.onKeyDown(event('keydown', { key: 'Enter' })), false);
});

test('real command kinds merge scanned skills with full metadata and keep custom and built-in commands separate', async () => {
  const commands = [
    { name: 'model', aliases: [], description: '切换模型', kind: 'command' },
    { name: 'new', aliases: ['clear'], description: '新建会话', kind: 'command' },
    { name: 'sdd:proposal', aliases: [], description: '根据要求创建提案', kind: 'custom-command' },
    { name: 'developer-test-agent:dt', aliases: [], description: '生成单元测…', kind: 'custom-command' },
    { name: 'batch', aliases: [], description: 'Research and plan…', kind: 'skill' },
    { name: 'GIT-AI', aliases: [], description: 'Install, update…', kind: 'skill' },
  ];
  const installed = [{ name: 'git-ai', description: 'Full synthetic description', installedAt: 2000 }];
  const merged = skills.mergedSkills(installed, commands);
  assert.equal(merged.length, 2); assert.equal(merged.find(row => row.name === 'git-ai').description, installed[0].description);
  assert.equal(merged.find(row => row.name === 'git-ai').installedAt, 2000);
  assert.equal(skills.commandName('/batch request', commands), '');
  assert.equal(skills.commandName('/clear', commands), 'new');
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: installed, commands }) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  assert.deepEqual(f.document.body.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 2', '技能 2', '自定义命令 2']);
  f.input.textContent = '/batch'; f.caret(6); f.input.dispatchEvent(event('input'));
  f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  assert.equal(skills.selectedSkill(f.input).name, 'batch'); assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/batch');
});

test('the command producer cache reaches the actual inventory IPC and slash popup as three groups', async t => {
  const dir = temp(t), configDir = path.join(dir, 'personal'); install(configDir, 'local-skill');
  const variables = { CLAUDE_HUB_DATA_DIR: dir, AI_HUB_CODEAGENT_CONFIG_DIR: configDir };
  const before = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]])); Object.assign(process.env, variables);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const producer = require('../core/codeagent-commands-probe');
  producer.writeCommandCache(dir, 'personal', '1.26.15', ['/new (clear)    新建会话command', '/sdd:proposal    创建提案custom-command', '/batch    Plan…skill'].map(producer.parseCommandRow));
  const handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getSession: () => ({ kind: 'codeagent', codeagentVersion: '1.26.15', codeagentConfigDir: configDir }), getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) }, sendToRenderer() {},
  });
  const f = pickerFixture({ inventory: (channel, payload) => handlers.get(channel)(null, payload) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  assert.deepEqual(f.document.body.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 1', '技能 2', '自定义命令 1']);
  f.input.textContent = '/clear'; f.caret(6); f.input.dispatchEvent(event('input'));
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.input.textContent, '/new ');
});

test('opening slash requests one warm-up and automatically reads three groups when complete; failures cool down', async t => {
  const dir = temp(t), configDir = path.join(dir, 'personal'); install(configDir, 'local-skill');
  const before = { CLAUDE_HUB_DATA_DIR: process.env.CLAUDE_HUB_DATA_DIR, AI_HUB_CODEAGENT_CONFIG_DIR: process.env.AI_HUB_CODEAGENT_CONFIG_DIR };
  process.env.CLAUDE_HUB_DATA_DIR = dir; process.env.AI_HUB_CODEAGENT_CONFIG_DIR = configDir;
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  let release, version = '1.26.15', failed = false, probes = 0;
  const waitVersion = new Promise(resolve => { release = resolve; });
  const producer = require('../core/codeagent-commands-probe'), handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getSession: () => ({ kind: 'codeagent', codeagentConfigDir: configDir }), getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer() {}, codeagentCommandVersionProbe: async () => { await waitVersion; return version; },
    codeagentProbeModels: async options => {
      probes++; assert.equal(options.commandsOnly, true); assert.equal(options.configDir, configDir); assert.equal(options.accountKey, 'personal');
      if (failed) return { ok: false, commandsProbe: { ok: false, reason: 'list-unavailable' } };
      producer.writeCommandCache(dir, 'personal', version, ['/new (clear)    新建会话command', '/sdd:proposal    创建提案custom-command', '/batch    Plan…skill'].map(producer.parseCommandRow));
      return { ok: true, commandsProbe: { ok: true } };
    },
  });
  const timers = pickerTimers();
  const f = pickerFixture({ timers, inventory: (channel, payload) => handlers.get(channel)(null, payload) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input'));
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(probes, 0); assert.deepEqual(f.document.body.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['技能 1']);
  assert.equal(f.calls[0][1].probeCommands, true);
  release(); for (let i = 0; i < 10 && probes === 0; i++) await new Promise(setImmediate);
  await timers.advance(1000);
  assert.deepEqual(f.calls[1][1], { sessionId: 'test' });
  assert.equal(probes, 1); assert.deepEqual(f.document.body.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 1', '技能 2', '自定义命令 1']);
  const file = path.join(dir, 'codeagent-pool', 'codeagent-commands.json'), saved = fs.readFileSync(file, 'utf8');
  version = '1.26.16'; failed = true;
  await f.controller.refresh(); await new Promise(setImmediate); await f.controller.refresh();
  assert.equal(probes, 2); assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-model.log'), 'utf8'), /event=commands-probe result=failed reason=list-unavailable/);
  assert.match(fs.readFileSync(path.join(dir, 'logs', 'codeagent-commands-probe.log'), 'utf8'), /list-unavailable/);
  f.controller.dispose();
});

test('slash shows idle, reading and failed command states as plain text, then reads completed commands on reopening', async () => {
  let status = null, completed = false;
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'sample-skill' }], commandsProbe: status,
    commands: completed ? [{ name: 'help', kind: 'command' }] : [] }) });
  const open = async () => { f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate); };
  await open();
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.equal(popup.querySelector('.fi-command-probe-text').textContent, '尚未读取命令列表');
  f.controller.close(); status = { state: 'reading', at: Date.now() }; await open();
  assert.equal(popup.querySelector('.fi-command-probe-text').textContent, '正在读取 CodeAgent 命令…');
  assert.equal(popup.querySelector('.fi-command-probe-retry').disabled, true);
  f.controller.close(); status = { state: 'failed', reason: '<b>queue-timeout</b>', at: Date.now() }; await open();
  assert.match(popup.querySelector('.fi-command-probe-text').textContent, /^命令列表读取失败：<b>queue-timeout<\/b>（\d{2}:\d{2}）$/);
  assert.equal(popup.querySelector('.fi-command-probe-status').querySelector('b'), null);
  f.controller.close(); completed = true; status = { state: 'ready' }; await open();
  assert.equal(popup.querySelector('.fi-command-probe-status'), null);
  assert.deepEqual(popup.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 1', '技能 1']);
  f.controller.dispose();
});

test('command cooldown shows remaining minutes and its retry button forces a commands-only IPC read', async t => {
  const dir = temp(t), profile = path.join(dir, 'profile'); install(profile, 'local-skill');
  const before = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dir;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before; });
  const handlers = new Map(), producer = require('../core/codeagent-commands-probe'); let calls = 0;
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { getSession: () => ({ kind: 'codeagent', codeagentConfigDir: profile, codeagentVersion: '1.26.1' }), getAllSessions: () => [], codeagentPoolActiveCounts: () => ({}) },
    sendToRenderer() {}, codeagentProbeModels: async options => {
      calls++; assert.equal(options.commandsOnly, true);
      if (calls === 1) return { commandsProbe: { ok: false, reason: 'unrecognized-list' } };
      assert.equal(options.forceCommands, true);
      producer.writeCommandCache(dir, 'personal', '1.26.1', [{ name: 'help', kind: 'command' }]);
      return { commandsProbe: { ok: true } };
    },
  });
  const f = pickerFixture({ inventory: (channel, payload) => handlers.get(channel)(null, payload) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  await f.controller.refresh(); assert.equal(calls, 1);
  const status = f.document.body.querySelector('.fi-command-probe-status');
  assert.match(status.querySelector('.fi-command-probe-text').textContent, /unrecognized-list.*冷却剩余 30 分钟$/);
  assert.equal(status.querySelector('.fi-command-probe-retry').disabled, false);
  status.querySelector('.fi-command-probe-retry').dispatchEvent(event('click')); await new Promise(setImmediate);
  assert.equal(calls, 2); assert.ok(f.calls.some(row => row[1]?.retryCommands === true));
  await f.controller.refresh();
  assert.deepEqual(f.document.body.querySelectorAll('.fi-skill-group').map(row => row.textContent), ['内置命令 1', '技能 1']);
  assert.equal(f.document.body.querySelector('.fi-command-probe-status'), null);
  const now = Date.now();
  assert.match(skills.commandProbeText({ state: 'failed', reason: 'unrecognized-list', at: now, retryAt: now + 25 * 60000 }, now), /冷却剩余 25 分钟$/);
  assert.doesNotMatch(skills.commandProbeText({ state: 'failed', reason: 'unrecognized-list', at: now, retryAt: now }, now), /冷却/);
  f.controller.dispose();
});

test('an open slash popup polls read-only and automatically paints completion without losing query or selection', async () => {
  const timers = pickerTimers(); let ready = false;
  const f = pickerFixture({ timers, inventory: async () => ({ ok: true, skills: [{ name: 'target' }, { name: 'retarget' }],
    commandsProbe: { state: ready ? 'ready' : 'reading' }, commands: ready ? [{ name: 'task', kind: 'command' }, { name: 'custom:task', kind: 'custom-command' }] : [] }) });
  f.input.textContent = '/ta'; f.caret(3); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker'), list = popup.querySelector('.fi-skill-list');
  assert.equal(list.children[0].className, 'fi-command-probe-status'); assert.equal(timers.pending.size, 1);
  f.controller.onKeyDown(event('keydown', { key: 'ArrowDown' }));
  ready = true; await timers.advance(999); assert.equal(f.calls.length, 1);
  await timers.advance(1);
  assert.deepEqual(f.calls[1], ['codeagent:skills', { sessionId: 'test' }]);
  assert.equal(popup.hidden, false); assert.equal(popup.querySelector('.fi-skill-search').value, 'ta'); assert.equal(f.input.textContent, '/ta');
  assert.deepEqual(list.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['内置命令 1', '技能 2', '自定义命令 1']);
  assert.equal(list.querySelectorAll('.fi-skill-option').find(node => node.getAttribute('aria-selected') === 'true').querySelector('.fi-skill-name').textContent, '/retarget');
  assert.equal(list.querySelector('.fi-command-probe-status'), null); assert.equal(timers.pending.size, 0);
  await timers.advance(10000); assert.equal(f.calls.length, 2);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(skills.selectedSkill(f.input).name, 'retarget');
  f.controller.dispose();
});

test('polling stops on close, disposal, failure or completion without leaving timers', async () => {
  for (const stop of ['close', 'dispose', 'failed', 'ready']) {
    const timers = pickerTimers(); let state = 'reading';
    const f = pickerFixture({ timers, inventory: async () => ({ ok: true, skills: [], commands: [], commandsProbe: { state, reason: 'synthetic failure', at: 0 } }) });
    f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
    assert.equal(timers.pending.size, 1);
    if (stop === 'close' || stop === 'dispose') f.controller[stop]();
    else { state = stop; await timers.advance(1000); }
    assert.equal(timers.pending.size, 0);
    if (stop === 'failed') {
      const list = f.document.body.querySelector('.fi-skill-list'); assert.equal(list.children[0].className, 'fi-command-probe-status');
      assert.match(list.children[0].textContent, /synthetic failure/); assert.equal(list.children[0].querySelector('button').disabled, false);
    }
    const calls = f.calls.length; await timers.advance(100000); assert.equal(f.calls.length, calls);
    f.controller.dispose();
  }
});

test('polling is bounded to ninety seconds and retry starts a fresh single timer window', async () => {
  const timers = pickerTimers(); let state = 'reading';
  const f = pickerFixture({ timers, inventory: async (_channel, payload) => {
    if (payload.retryCommands) state = 'reading';
    return { ok: true, skills: [], commandsProbe: { state, reason: 'synthetic failure', at: 0 } };
  } });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  await timers.advance(90000); assert.equal(timers.pending.size, 0);
  const count = f.calls.length; await timers.advance(5000); assert.equal(f.calls.length, count);
  assert.ok(f.calls.slice(1).every(row => !('probeCommands' in row[1]) && !('retryCommands' in row[1])));
  state = 'failed'; await f.controller.refresh();
  f.document.body.querySelector('.fi-command-probe-retry').dispatchEvent(event('click')); await new Promise(setImmediate);
  assert.equal(f.calls.at(-1)[1].retryCommands, true); assert.equal(timers.pending.size, 1);
  await timers.advance(1000); assert.deepEqual(f.calls.at(-1)[1], { sessionId: 'test' }); assert.equal(timers.pending.size, 1);
  await timers.advance(89000); assert.equal(timers.pending.size, 0);
  const finished = f.calls.length; await timers.advance(1000); assert.equal(f.calls.length, finished);
  f.controller.dispose();
});

test('late polling responses cannot repaint a closed or reopened popup', async () => {
  const timers = pickerTimers(); let release, calls = 0;
  const f = pickerFixture({ timers, inventory: async () => {
    calls++;
    if (calls === 2) return new Promise(resolve => { release = resolve; });
    return { ok: true, skills: [{ name: calls === 1 ? 'old' : 'current' }], commandsProbe: { state: calls === 1 ? 'reading' : 'ready' } };
  } });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  await timers.advance(1000); f.controller.close();
  f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  release({ ok: true, skills: [{ name: 'late' }], commandsProbe: { state: 'reading' } }); await new Promise(setImmediate);
  assert.equal(f.document.body.querySelector('.fi-skill-name').textContent, '/current'); assert.equal(timers.pending.size, 0);
  f.controller.dispose();
});

test('slash group order and stable prefix ranking include aliases while empty queries retain recent skill priority', () => {
  const installed = [{ name: 'zeta', description: 'needle details' }, { name: 'pre-needle' }, { name: 'needle-skill' }];
  const commands = [{ name: 'help', description: 'needle help', kind: 'command' }, { name: 'pre-needle', kind: 'command' },
    { name: 'new', aliases: ['needle-alias'], kind: 'command' }, { name: 'needle-command', kind: 'command' },
    { name: 'custom:other', description: 'needle docs', kind: 'custom-command' }, { name: 'needle-custom', kind: 'custom-command' }];
  const recent = [{ name: 'zeta', at: 1 }];
  const rows = skills.slashChoices(installed, commands, 'NEEDLE', recent);
  assert.deepEqual(rows.map(row => row.label), ['new', 'needle-command', 'pre-needle', 'help', 'needle-skill', 'pre-needle', 'zeta', 'needle-custom', 'custom:other']);
  assert.deepEqual(skills.slashChoices(installed, commands, '', recent).map(row => row.label), ['help', 'pre-needle', 'new', 'needle-command', 'zeta', 'needle-skill', 'pre-needle', 'custom:other', 'needle-custom']);
});

test('compact rows align names and descriptions, show aliases and highlight text without parsing HTML', async () => {
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: '<b>-skill', description: 'plain', 'argument-hint': '[argument]' }],
    commands: [{ name: 'new', aliases: ['clear'], description: '<b>short description</b>', kind: 'command' }] }) });
  f.input.textContent = '/CLE'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker'), item = popup.querySelector('.fi-skill-option');
  assert.equal(item.querySelector('.fi-skill-name').textContent, '/new (clear)'); assert.equal(item.querySelector('mark').textContent, 'cle');
  assert.equal(item.querySelector('small').textContent, '<b>short description</b>'); assert.equal(item.querySelector('b'), null);
  const keys = popup.querySelector('.fi-skill-keys'); assert.equal(keys.hidden, false); assert.equal(keys.textContent, '↑↓ 选择 · Enter 确认 · Esc 关闭');
  assert.equal(popup.querySelector('.fi-skill-list').contains(keys), false);
  const style = f.document.getElementById('fi-codeagent-skills-style').textContent;
  assert.match(style, /grid-template-columns:minmax\(130px,40%\) minmax\(0,1fr\)/); assert.match(style, /height:28px/); assert.match(style, /max-height:360px/);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.input.textContent, '/new ');
  f.input.textContent = '/<b>'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const skill = popup.querySelectorAll('.fi-skill-option').find(row => row.querySelector('.fi-skill-name').textContent === '/<b>-skill');
  assert.equal(skill.querySelector('mark').textContent, '<b>'); assert.equal(skill.querySelector('b'), null);
  assert.equal(skill.title, 'plain\n[argument]'); assert.equal(skill.querySelectorAll('small').length, 1); assert.doesNotMatch(skill.textContent, /argument/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../renderer/composer-codeagent-skills.js'), 'utf8'), /\.innerHTML\b/);
  f.controller.close(); f.controller.open(); await new Promise(setImmediate); assert.equal(keys.hidden, true);
  f.controller.dispose();
});

test('sorted default selection and the skills special Enter branch retain explicit command choices', async () => {
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'local' }],
    commands: [{ name: 'help', description: 'skills help' }, { name: 'skills' }] }) });
  f.input.textContent = '/'; f.caret(1); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  assert.equal(f.document.body.querySelectorAll('.fi-skill-option')[0].getAttribute('aria-selected'), 'true');
  assert.equal(f.document.body.querySelector('.fi-skill-name').textContent, '/help');
  f.input.textContent = '/skills'; f.caret(7); f.input.dispatchEvent(event('input'));
  assert.equal(f.document.body.querySelector('.fi-skill-name').textContent, '/skills');
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); await new Promise(setImmediate); assert.equal(f.input.textContent, '');
  assert.equal(f.document.body.querySelector('.fi-skill-keys').hidden, true);
  f.controller.close(); f.input.textContent = '/skills'; f.caret(7); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'ArrowDown' })); f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  assert.equal(f.input.textContent, '/help '); f.controller.dispose();
});

test('search composition leaves filtering and Enter untouched until composition ends', async () => {
  const f = pickerFixture(); f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker'), search = popup.querySelector('.fi-skill-search');
  search.dispatchEvent(event('compositionstart')); search.value = 'no-match'; search.dispatchEvent(event('input'));
  const enter = event('keydown', { key: 'Enter' });
  assert.equal(f.controller.onKeyDown(enter), false); assert.equal(enter.prevented, undefined);
  assert.equal(popup.querySelectorAll('.fi-skill-option').length, 1);
  search.dispatchEvent(event('compositionend')); assert.equal(popup.querySelectorAll('.fi-skill-option').length, 0);
});

test('slash Enter waits for inventory and never executes a footer or a missing command', async () => {
  let resolve;
  const f = pickerFixture({ inventory: () => new Promise(done => { resolve = done; }) });
  f.input.textContent = '/unknown'; f.caret(8); f.input.dispatchEvent(event('input'));
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'Enter' })), true); assert.equal(f.calls.length, 1);
  resolve({ ok: true, skills: [] }); await new Promise(setImmediate);
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'Enter' })), false);
  assert.equal(f.calls.length, 1); assert.equal(f.input.textContent, '/unknown');
});


test('skill metadata and full text persist in localStorage and only restore for the matching session draft', () => {
  const f = dom(), data = new Map(), storage = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key), removeItem: key => data.delete(key) };
  skills.insertSkillTag(f.input, { name: 'insight-hub', installedAt: 2000 }, { ...f, session });
  f.input.append(f.document.createTextNode('写总结'));
  skills.saveSkillDraft(storage, 'a', f.input, f.input.textContent, session);
  assert.deepEqual(skills.readSkillDraft(storage, 'a', session), { skill: { name: 'insight-hub', installedAt: 2000 }, text: '/insight-hub 写总结' });
  assert.equal(skills.loadSkillDraft(storage, 'a', '/insight-hub 写总结', session).name, 'insight-hub');
  assert.equal(skills.loadSkillDraft(storage, 'a', '/insight-hub changed', session), null);
  assert.equal(skills.loadSkillDraft(storage, 'b', '/insight-hub 写总结', session), null);
  assert.equal(skills.loadSkillDraft(storage, 'a', '/insight-hub 写总结', { kind: 'claude' }), null);
  const restored = dom(); restored.input.textContent = '写总结';
  skills.insertSkillTag(restored.input, skills.loadSkillDraft(storage, 'a', '/insight-hub 写总结', session), { ...restored, session });
  assert.equal(restored.input.textContent, f.input.textContent);
  skills.removeSkillTag(f.input); skills.saveSkillDraft(storage, 'a', f.input, f.input.textContent, session);
  assert.equal(skills.readSkillDraft(storage, 'a', session), null);
});

test('slash detection requires the first word and ignores composition or an existing tag; choices match only skill names and descriptions', () => {
  assert.equal(skills.slashQuery('/insight details', 4), 'insight');
  assert.equal(skills.slashQuery('/insight details', 10), null);
  assert.equal(skills.slashQuery('text /insight', 8), null);
  assert.equal(skills.slashQuery('/insight', 3, { composing: true }), null);
  assert.equal(skills.slashQuery('/insight', 3, { hasSkill: true }), null);
  assert.equal(skills.slashQuery('/', 1), '');
  const all = [{ name: 'insight-hub', description: '报告', 'argument-hint': '[topic]' }, { name: 'review', description: 'review code' }];
  assert.deepEqual(skills.skillChoices(all, '报告').map(row => row.label), ['insight-hub']);
  assert.deepEqual(skills.skillChoices(all, 'INSIGHT').map(row => row.label), ['insight-hub']);
  assert.deepEqual(skills.skillChoices(all, 'topic'), []);
  assert.deepEqual(skills.skillChoices(all, 'model'), []);
  assert.deepEqual(skills.skillChoices([], ''), []);
});

function memoryStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
function pickerTimers() {
  let clock = 0, id = 0;
  const pending = new Map();
  return { now: () => clock, pending,
    setTimer: (fn, ms) => { const key = ++id; pending.set(key, { at: clock + ms, fn }); return key; },
    clearTimer: key => pending.delete(key),
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        clock = next[1].at; pending.delete(next[0]); next[1].fn(); await new Promise(setImmediate);
      }
      clock = end; await new Promise(setImmediate);
    },
  };
}
function pickerFixture({ kind = 'codeagent', storage = memoryStorage(), account = '', timers = {}, inventory = async () => ({ ok: true, skills: [{ name: 'insight-hub', description: '写总结', 'argument-hint': '[topic]', installedAt: 2000 }] }) } = {}) {
  const f = dom(), calls = [], host = f.document.createElement('div'); f.document.body.append(host);
  const controller = skills.mountCodeAgentSkillPicker({ ...f, ...timers, host, sessionId: 'test', storage, getSession: () => ({ ...session, kind, codeagentPoolAccount: account }),
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return inventory(...args); } },
    readText: () => f.input.textContent, replaceText: text => { f.input.textContent = text; }, saveDraft() {}, openModel: () => calls.push('model'), notify: (...args) => calls.push({ notice: args }),
  });
  return { ...f, controller, calls, storage };
}

test('the composer lists the automatically installed company-team skill and inserts its invocation', async t => {
  const configDir = temp(t);
  require('../core/codeagent-bundled-skills').syncCompanyTeamSkill(configDir);
  const f = pickerFixture({ inventory: async () => ({ ok: true, ...scanCodeAgentSkills(configDir) }) });
  t.after(() => f.controller.dispose());
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.match(popup.textContent, /company-team/);
  popup.querySelector('.fi-skill-option').dispatchEvent(event('click'));
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/company-team');
});


test('skill descriptions and argument hints use single-line ellipsis with full plain-text tooltips', async () => {
  const description = '很长的技能说明，'.repeat(40), hint = '[这是很长的参数提示]'.repeat(30);
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'long-skill', description, 'argument-hint': hint }] }) });
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const style = f.document.getElementById('fi-codeagent-skills-style').textContent;
  const detailStyle = style.match(/\.fi-skill-option small\s*\{([^}]+)\}/)[1];
  assert.match(detailStyle, /white-space:\s*nowrap/);
  assert.match(detailStyle, /overflow:\s*hidden/);
  assert.match(detailStyle, /text-overflow:\s*ellipsis/);
  const details = f.document.body.querySelector('.fi-skill-option').querySelectorAll('small');
  assert.deepEqual(details.map(node => node.title), [description + '\n' + hint]);
  assert.deepEqual(details.map(node => node.textContent), [description], 'CSS truncation must retain the original description; the hint is tooltip-only');
  f.document.body.querySelector('.fi-skill-option').dispatchEvent(event('click'));
  const chip = f.input.querySelector('[data-codeagent-skill]');
  assert.equal(chip.title, description); assert.equal(chip.textContent, '/long-skill');
  assert.equal(f.input.textContent.includes(description), false, 'tooltip text must never enlarge or become input content');
});

test('short descriptions stay unchanged and HTML-looking descriptions and hints remain text', async () => {
  const description = '<b>短说明</b>', hint = '<i>参数</i>';
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'plain', description, 'argument-hint': hint }] }) });
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const details = f.document.body.querySelector('.fi-skill-option').querySelectorAll('small');
  assert.equal(details.length, 1);
  for (const [node, text] of [[details[0], description]]) {
    assert.equal(node.textContent, text); assert.equal(node.title, description + '\n' + hint);
    assert.equal(node.children.length, 0);
    assert.equal(node.childNodes[0].nodeType, 3);
  }
});

test('slash popup filters and completes a skill via Enter; IME suppresses it and Esc preserves the input', async () => {
  const f = pickerFixture();
  f.input.textContent = '/ins'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.equal(popup.hidden, false);
  const enter = event('keydown', { key: 'Enter' }); assert.equal(f.controller.onKeyDown(enter), true); assert.equal(enter.prevented, true);
  assert.equal(skills.selectedSkill(f.input).name, 'insight-hub');
  skills.removeSkillTag(f.input); f.input.textContent = '/ins'; f.caret(4);
  f.input.dispatchEvent(event('compositionstart')); f.input.dispatchEvent(event('input'));
  assert.equal(popup.hidden, true);
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'Enter', isComposing: true })), false);
  f.input.dispatchEvent(event('compositionend')); await new Promise(setImmediate);
  assert.equal(popup.hidden, false);
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'Escape' })), true);
  assert.equal(popup.hidden, true); assert.equal(f.input.textContent, '/ins');
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'ArrowUp' })), false, 'closed popup must leave history keys alone');
});


test('empty and failed inventories have clear messages; other CLIs get no skill UI', async () => {
  for (const [inventory, message] of [
    [async () => ({ ok: true, skills: [] }), '本机还没有安装技能'],
    [async () => ({ ok: false, error: '读取技能失败：测试错误' }), '读取技能失败：测试错误'],
  ]) {
    const f = pickerFixture({ inventory }); f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
    assert.match(f.document.body.querySelector('.fi-skill-picker').textContent, new RegExp(message));
    assert.equal(f.input.textContent, '');
  }
  const other = pickerFixture({ kind: 'claude' });
  assert.equal(other.controller, null); assert.equal(other.document.body.querySelector('.fi-skill-picker'), null);
  assert.equal(skills.isSkillsMenuCommand({ kind: 'claude' }, '/skills'), false);
});

test('a skill installed after session start warns without blocking; old installs and unknown start time do not warn', () => {
  assert.equal(skills.installationWarning({ installedAt: 2000 }, session), '这个技能在本会话启动后才安装，若未生效请新开会话');
  assert.equal(skills.installationWarning({ installedAt: 500 }, session), '');
  assert.equal(skills.installationWarning({ installedAt: 2000 }, { kind: 'codeagent' }), '');
});


function rendererFunction(name) {
  const file = path.join(__dirname, '..', 'renderer', 'renderer.js'), source = fs.readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
}

test('actual renderer draft save/restore preserves the tag, localStorage metadata and existing pasted-text chips', () => {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const f = dom(), values = new Map(), storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key) };
  const paste = require('../renderer/composer-paste-chips'), rawDrafts = new Map(), drafts = new Map();
  const context = vm.createContext({ document: f.document, window: f.window, Event: f.window.Event, localStorage: storage,
    require: createRequire(path.join(__dirname, '..', 'renderer', 'renderer.js')), sessions: new Map([['test', session]]),
    pasteChips: paste, rawComposerDrafts: rawDrafts, floatingInputDrafts: drafts, attachNativeDraft: () => null,
    readContenteditableRawText: input => input.textContent,
    readContenteditablePlainText: input => paste.expandPasteMarkers(input.textContent), showToast: message => assert.fail(message),
  });
  const api = vm.runInContext(`${rendererFunction('restoreComposerText')}\n${rendererFunction('saveFloatingInputDraft')}\n({restoreComposerText,saveFloatingInputDraft})`, context);
  const body = 'line one\nline two';
  const marker = paste.MARK_START + paste.registerPaste(body) + paste.MARK_END;
  paste.renderComposerValue(f.input, marker, { document: f.document });
  skills.insertSkillTag(f.input, { name: 'insight-hub', installedAt: 500 }, { ...f, session });
  api.saveFloatingInputDraft('test', f.input);
  assert.equal(drafts.get('test'), '/insight-hub ' + body);
  const recreated = f.document.createElement('div');
  const previousFocus = f.document.activeElement;
  api.restoreComposerText('test', recreated, drafts.get('test'));
  assert.equal(f.document.activeElement, previousFocus, 'background draft restoration must not steal focus');
  assert.equal(skills.selectedSkill(recreated).name, 'insight-hub');
  assert.equal(recreated.querySelectorAll('.fi-paste-chip').length, 1);
  assert.equal(paste.expandPasteMarkers(recreated.textContent), drafts.get('test'));
  rawDrafts.clear(); // Simulate a renderer restart: only durable text + localStorage remain.
  const restarted = f.document.createElement('div');
  api.restoreComposerText('test', restarted, skills.readSkillDraft(storage, 'test', session).text);
  assert.equal(skills.selectedSkill(restarted).name, 'insight-hub');
  assert.equal(paste.expandPasteMarkers(restarted.textContent), '/insight-hub ' + body);
});

test('actual renderer key handler keeps IME, popup Enter/Esc, ordinary send and history keys separate', async () => {
  const vm = require('node:vm'), f = pickerFixture();
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const match = source.match(/inputBox\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(match);
  let sends = 0, focuses = 0;
  const handle = vm.runInNewContext(`(e) => {${match[1]}\n}`, {
    codeagentSkills: f.controller, sendInput: () => { sends += 1; }, inputHistory: null,
    isNativeAgent: () => false, sessions: new Map(), sessionId: 'test', terminal: { focus: () => { focuses += 1; } },
    focusAfterSend: () => { focuses += 1; },
    require: id => require(path.join(__dirname, '..', 'renderer', id)), localStorage: { getItem: () => null },
  });
  f.input.textContent = '/ins'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  handle(event('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(sends, 0); assert.equal(skills.selectedSkill(f.input), null);
  handle(event('keydown', { key: 'Enter' }));
  assert.equal(sends, 0); assert.equal(skills.selectedSkill(f.input).name, 'insight-hub');
  handle(event('keydown', { key: 'Enter' })); assert.equal(sends, 1);
  skills.removeSkillTag(f.input); f.input.textContent = '/ins'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  handle(event('keydown', { key: 'Escape' })); assert.equal(focuses, 0);
  handle(event('keydown', { key: 'Escape' })); assert.equal(focuses, 1);
  const arrow = event('keydown', { key: 'ArrowUp' }); handle(arrow); assert.equal(arrow.prevented, undefined);
});


test('actual queued PTY sender submits /skills once without turn-ack waits or menu keys; normal skills and other CLIs retain acknowledgements', async t => {
  isolateInputDiagnostics(t);
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const file = path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), localRequire = createRequire(file);
  const calls = [];
  const manager = { getSession: () => ({ kind: 'codeagent', createdAt: 1 }), getGroupChatReady: () => true,
    getSessionBuffer: () => '❯ \n? for shortcuts', getNativeClaude: () => null,
    getGroupChatLastActivity: () => 1, writeToSession: (_sid, data) => calls.push(data), getSessionOutputMark: () => 0 };
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer,
    setTimeout: (fn, _ms) => { fn(); return 1; }, clearTimeout() {},
    require: name => name === './pty-prompt-submit.js' ? { ...localRequire(name), waitForPasteSettled: async () => calls.push('settled') } : localRequire(name),
    testCalls: calls,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + `
    observeAgentTurnStart = () => ({ dispose() { testCalls.push('disposed'); } });
    waitForAgentWorkStart = async () => { throw new Error('ordinary-turn-ack'); };
  `, context);
  const sender = context.module.exports; sender.init({ sessionManager: manager });
  const result = await sender.sendToPty('test-session', '/skills', 'codeagent', { requireReady: true });
  assert.equal(result.ok, true); assert.equal(result.mode, 'interactive-command'); assert.equal(result.enterAttempts, 1);
  assert.deepEqual(calls, ['\x1b[200~/skills\x1b[201~', 'settled', '\r', 'disposed']);
  calls.length = 0;
  await assert.rejects(sender.sendToPty('test-session', '/insight-hub test', 'codeagent', { requireReady: true }), /ordinary-turn-ack/);
  assert.equal(calls.filter(value => value === '\r').length, 1);
  await assert.rejects(sender.sendToPty('test-session', '/skills', 'claude', { requireReady: true }), /ordinary-turn-ack/);
});

test('explicit terminal fallback submits once; the flag never bypasses normal skill, nonslash or other CLI acknowledgements', async t => {
  isolateInputDiagnostics(t);
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const file = path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), localRequire = createRequire(file), calls = [];
  const manager = { getSession: () => ({ kind: 'codeagent', createdAt: 1 }), getGroupChatReady: () => true,
    getSessionBuffer: () => '❯ \n? for shortcuts', getNativeClaude: () => null,
    getGroupChatLastActivity: () => 1, writeToSession: (_sid, data) => calls.push(data), getSessionOutputMark: () => 0 };
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer,
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    require: name => name === './pty-prompt-submit.js' ? { ...localRequire(name), waitForPasteSettled: async () => calls.push('settled') } : localRequire(name),
    testCalls: calls,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + `
    observeAgentTurnStart = () => ({ dispose() { testCalls.push('disposed'); } });
    waitForAgentWorkStart = async () => { throw new Error('ordinary-turn-ack'); };
  `, context);
  const sender = context.module.exports; sender.init({ sessionManager: manager });
  const result = await sender.sendToPty('test', '/unknown arguments', 'codeagent', { requireReady: true, codeagentInteractiveCommand: true });
  assert.equal(result.mode, 'interactive-command'); assert.equal(result.enterAttempts, 1);
  assert.deepEqual(calls, ['\x1b[200~/unknown arguments\x1b[201~', 'settled', '\r', 'disposed']);
  for (const [text, kind, flag] of [['/insight-hub test', 'codeagent', false], ['normal request', 'codeagent', true], ['/unknown', 'claude', true]]) {
    calls.length = 0;
    await assert.rejects(sender.sendToPty('test', text, kind, { requireReady: true, codeagentInteractiveCommand: flag }), /ordinary-turn-ack/);
    assert.equal(calls.filter(value => value === '\r').length, 1);
  }
});

test('prompt IPC forwards interactive mode only for explicitly requested CodeAgent slash commands', async () => {
  const vm = require('node:vm'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), localRequire = createRequire(file), calls = [];
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? { codeAgentInputAction: async () => ({ ok: true }), sendToPty: async (...args) => { calls.push(args); return { ok: true }; } } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const manager = new EventEmitter(); let kind = 'codeagent';
  manager.getSession = id => id === 'test' ? { kind } : null;
  const handlers = new Map();
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    sessionManager: manager, sendToRenderer() {}, logger: { warn() {} },
    commandTranscriptStore: { begin: () => ({ duplicate: false }), finish() {} },
  });
  try {
    for (const [nextKind, text, requested, expected] of [
      ['codeagent', '/unknown', true, true], ['codeagent', '/insight-hub test', false, false],
      ['claude', '/unknown', true, false], ['codeagent', 'normal request', true, false],
    ]) {
      kind = nextKind;
      const result = await handlers.get('session:send-prompt')(null, { sessionId: 'test', text, codeagentInteractiveCommand: requested });
      assert.equal(result.ok, true); assert.equal(calls.at(-1)[3].codeagentInteractiveCommand, expected);
    }
  } finally { registration.dispose(); }
});

test('prompt preflight rejections explicitly confirm nothing was sent', async t => {
  const vm = require('node:vm'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), localRequire = createRequire(file);
  let writes = 0;
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async () => ({ ok: true }),
      sendToPty: async () => { writes++; return { ok: true }; },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const manager = new EventEmitter();
  manager.getSession = id => id === 'live' ? { kind: 'codeagent' } : null;
  manager.writeToSession = () => { writes++; };
  const registration = context.module.exports.registerPromptSubmitIpc({ handle() {} }, { sessionManager: manager, sendToRenderer() {} });
  t.after(() => registration.dispose());
  for (const [request, error] of [
    [{ sessionId: 'closed', text: 'message' }, 'no-session'],
    [{ sessionId: '', text: 'message' }, 'bad-request'],
    [{ sessionId: 'live', text: '' }, 'bad-request'],
    [{ sessionId: 'live', text: 42 }, 'bad-request'],
  ]) {
    const result = await registration.submitPrompt(null, request);
    assert.equal(result.ok, false); assert.equal(result.error, error);
    assert.equal(result.notSent, true, error + ' must be a definite preflight rejection');
    assert.equal(writes, 0);
  }
});

test('team preservation reaches both the queued IPC input guard and the final PTY sender', async t => {
  const vm = require('node:vm'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), localRequire = createRequire(file), calls = [], checks = [];
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async (...args) => { checks.push(args); return { ok: true }; },
      sendToPty: async (...args) => { calls.push(args); return { ok: true }; },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const manager = new EventEmitter(); manager.getSession = () => ({ kind: 'codeagent' });
  const handlers = new Map();
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, { sessionManager: manager, sendToRenderer() {} });
  t.after(() => registration.dispose());
  for (const preserveInput of [true, false]) {
    checks.length = 0;
    const result = await registration.submitPrompt(null, { sessionId: 'test', text: 'notification', preserveInput, waitForCliReady: true });
    assert.equal(result.ok, true);
    assert.equal(checks.length, 2);
    assert.ok(checks.every(args => args[2].preserveInput === preserveInput));
    assert.ok(checks.every(args => args[2].allowUnready === true));
    assert.equal(calls.at(-1)[3].preserveInput, preserveInput);
    assert.equal(calls.at(-1)[3].requireReady, true);
  }
});

test('toolbar and slash skill popups share no-drag styles for the popup and every interactive descendant', async () => {
  const f = pickerFixture();
  const style = f.document.getElementById('fi-codeagent-skills-style');
  assert.match(style.textContent, /\.fi-skill-picker\s*,\s*\.fi-skill-picker\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/);
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.equal(popup.hidden, false);
  f.controller.close();
  f.input.textContent = '/ins'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  assert.equal(f.document.body.querySelector('.fi-skill-picker'), popup);
  assert.equal(popup.hidden, false);
});

test('recent skills are capped at five, newest first, account isolated and filtered against installed skills', () => {
  const storage = memoryStorage(), pool = { kind: 'codeagent', codeagentPoolAccount: 'testpool' };
  for (let n = 0; n < 7; n += 1) skills.recordSkillUse(storage, session, { name: 'skill-' + n }, { ok: true }, 100 + n);
  assert.deepEqual(skills.readRecentSkills(storage, session).map(row => row.name), ['skill-6', 'skill-5', 'skill-4', 'skill-3', 'skill-2']);
  skills.recordSkillUse(storage, session, { name: 'skill-4' }, { ok: true }, 200);
  assert.equal(skills.readRecentSkills(storage, session)[0].name, 'skill-4');
  assert.equal(skills.readRecentSkills(storage, session)[0].at, 200);
  skills.recordSkillUse(storage, pool, { name: 'pool-only' }, { ok: true }, 300);
  assert.deepEqual(skills.readRecentSkills(storage, pool), [{ name: 'pool-only', at: 300 }]);
  const installed = ['zeta', 'skill-3', 'alpha', 'skill-4'].map(name => ({ name, description: 'Description' }));
  const rows = skills.skillChoices(installed, '', skills.readRecentSkills(storage, session));
  assert.deepEqual(rows.map(row => row.label), ['skill-4', 'skill-3', 'alpha', 'zeta']);
  assert.deepEqual(rows.map(row => row.group), ['最近使用', '最近使用', '全部技能', '全部技能']);
  assert.deepEqual(skills.skillChoices(installed, 'ALPHA', skills.readRecentSkills(storage, session)).map(row => row.label), ['alpha']);
  assert.equal(skills.recordSkillUse(storage, session, { name: 'not-sent' }, { ok: true, notSent: true }), false);
  assert.equal(skills.recordSkillUse(storage, session, { name: 'unknown' }, { ok: true, receipt: { status: 'unconfirmed' } }), false);
});


test('recent groups appear before alphabetic remaining skills and never show an uninstalled skill', async () => {
  const storage = memoryStorage();
  skills.recordSkillUse(storage, session, { name: 'zeta' }, { ok: true }, 1);
  skills.recordSkillUse(storage, session, { name: 'removed' }, { ok: true }, 2);
  const f = pickerFixture({ storage, inventory: async () => ({ ok: true, skills: [{ name: 'zeta' }, { name: 'beta' }, { name: 'alpha' }] }) });
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const list = f.document.body.querySelector('.fi-skill-list');
  assert.deepEqual(list.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['最近使用 1', '全部技能 2']);
  assert.deepEqual(list.querySelectorAll('.fi-skill-option').map(node => node.textContent), ['/zeta', '/alpha', '/beta']);
  assert.doesNotMatch(list.textContent, /removed/);
});





test('terminal command success is silent while failures and busy refusals remain visible', async () => {
  const calls = [];
  const options = { session, state: 'idle', text: '/synthetic',
    openTerminal: async () => calls.push('terminal'), send: async text => { calls.push(text); return { ok: true }; },
    notify: message => calls.push(message) };
  assert.equal((await skills.openTerminalCommand(options)).ok, true);
  assert.deepEqual(calls, ['terminal', '/synthetic']);
  calls.length = 0;
  assert.equal((await skills.openTerminalCommand({ ...options, state: 'running' })).ok, false);
  assert.deepEqual(calls, ['请等当前回答结束后再执行终端命令']);
  calls.length = 0;
  assert.equal((await skills.openTerminalCommand({ ...options, send: async () => ({ ok: false, error: 'synthetic failure' }) })).ok, false);
  assert.match(calls.at(-1), /终端命令未发送：synthetic failure/);
});

function commandPrefixFixture(t) {
  const { EventEmitter } = require('node:events'), sender = require('../core/group-chat-watcher');
  const manager = new EventEmitter(), writes = [];
  const current = { kind: 'codeagent', status: 'idle', createdAt: 1 };
  let frame = [' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │'];
  manager.getSession = id => id === 'test' ? current : null;
  manager.getSessionBufferSnapshot = async () => ({ text: frame.join('\r\n'), cols: 120, rows: 30, seq: 0 });
  manager.writeToSession = (_sid, text) => { writes.push(text); frame = [' │ > ' + text + ' │', ' │ Bypass (Cycle shift+tab) | GLM │']; };
  sender.init({ sessionManager: manager }); t.after(() => sender.init(null));
  return { sender, manager, current, writes, setFrame: lines => { frame = lines; } };
}

test('real command-prefix writer uses the current screen and emits exactly one slash without Enter', async t => {
  const f = commandPrefixFixture(t);
  const result = await f.sender.openCodeAgentCommands('test');
  assert.equal(result.ok, true); assert.deepEqual(f.writes, ['/']);
  await assert.rejects(f.sender.openCodeAgentCommands('test'), /已有内容|空白/);
  assert.deepEqual(f.writes, ['/']);
});

test('command-prefix writer rejects nonempty, unknown, running, interactive and non-CodeAgent states', async t => {
  const f = commandPrefixFixture(t);
  for (const frame of [
    [' │ > existing draft │', ' │ Bypass (Cycle shift+tab) | GLM │'],
    ['not a recognized input frame'],
    ['版本更新提醒', 'Confirm Enter | 退出 Esc', ' │ > Anything I can assist you with? │'],
  ]) { f.setFrame(frame); await assert.rejects(f.sender.openCodeAgentCommands('test')); }
  for (const status of ['running', 'waiting']) { f.current.status = status; await assert.rejects(f.sender.openCodeAgentCommands('test'), /等当前回答或交互结束/); }
  f.current.status = 'idle'; f.current.kind = 'claude';
  await assert.rejects(f.sender.openCodeAgentCommands('test'), /CodeAgent/);
  await assert.rejects(f.sender.openCodeAgentCommands('missing'), /CodeAgent/);
  assert.deepEqual(f.writes, []);
});

test('command-prefix IPC is session limited and queued prefix attempts recheck the input after earlier writes', async t => {
  const f = commandPrefixFixture(t), handlers = new Map();
  require('../main/ipc/session-handlers').registerSessionIpc({ handle: (name, fn) => handlers.set(name, fn), on() {} }, {
    sessionManager: { ...f.manager, getSession: f.manager.getSession, codeagentPoolActiveCounts: () => ({}), getAllSessions: () => [] }, sendToRenderer() {},
  });
  assert.equal((await handlers.get('codeagent:commands-open')(null, { sessionId: 'missing' })).ok, false);
  const original = f.manager.getSessionBufferSnapshot;
  let release, snapshots = 0;
  const hold = new Promise(resolve => { release = resolve; });
  f.manager.getSessionBufferSnapshot = async () => { snapshots += 1; if (snapshots === 1) await hold; return original(); };
  const first = handlers.get('codeagent:commands-open')(null, { sessionId: 'test' });
  const second = handlers.get('codeagent:commands-open')(null, { sessionId: 'test' });
  assert.equal(snapshots, 1); assert.deepEqual(f.writes, []);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false);
  assert.deepEqual(f.writes, ['/']);
});

function inputGuardFixture({ text = '', status = 'running', failRead = false, screenRunning = true } = {}) {
  const api = require('../core/codeagent-input-guard'), current = { kind: 'codeagent', agentRuntime: 'pty', status };
  let clock = 1000, value = text, failed = failRead, running = screenRunning, customFrame = null;
  const writes = [], diagnostics = [], delays = [], stopDiagnostics = [];
  const manager = { getSession: id => id === 'test' ? current : null,
    writeToSession: (_id, data) => { writes.push({ data, at: clock }); if (data === '\x15') value = ''; } };
  const guard = api.createCodeAgentInputGuard(manager, {
    now: () => clock, sleep: async ms => { delays.push(ms); clock += ms; }, diagnose: event => diagnostics.push(event),
    stopDiagnose: row => stopDiagnostics.push(row),
    openScreen: async () => { if (failed) throw new Error('sensitive screen failure'); return { lines: async () => customFrame || [...(running ? ['⠋ Running…'] : []), ' │ > ' + (value || 'Anything I can assist you with?') + ' │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }; },
  });
  return { api, guard, current, manager, writes, delays, diagnostics, stopDiagnostics, setText: text => { value = text; }, fail: () => { failed = true; }, now: () => clock,
    setRunning: value => { running = value; }, setFrame: lines => { customFrame = lines; } };
}

test('team input preservation rejects drafts, menus and unknown screens without any terminal write', async () => {
  for (const mode of ['draft', 'menu', 'unknown', 'read-failed']) {
    const f = inputGuardFixture({ text: mode === 'draft' ? '正在编辑的草稿' : '', failRead: mode === 'read-failed' });
    if (mode === 'menu') f.setFrame(['Rewind to message', '❯ 1. Previous message', '  2. Current message', 'Enter to select · Esc to cancel']);
    if (mode === 'unknown') f.setFrame(['unrecognized frame']);
    const result = await f.guard.check('test', { preserveInput: true });
    assert.equal(result.ok, false, mode); assert.equal(result.notSent, true, mode);
    assert.equal(result.code, 'codeagent-input-residual', mode); assert.deepEqual(f.writes, [], mode);
  }
  const empty = inputGuardFixture({ screenRunning: false });
  assert.equal((await empty.guard.check('test', { preserveInput: true })).ok, true);
  assert.deepEqual(empty.writes, []);
});

test('ordinary manual send still clears residual input when team preservation is not requested', async () => {
  const f = inputGuardFixture({ text: '普通发送前残留', screenRunning: false });
  assert.equal((await f.guard.check('test')).ok, true);
  assert.deepEqual(f.writes.map(row => row.data), ['\x15']);
});

test('team cold launch reaches readiness wait but its final input check still rejects an unknown frame', async () => {
  const f = inputGuardFixture(); f.setFrame([]);
  assert.equal((await f.guard.check('test', { preserveInput: true, allowUnready: true })).pendingReady, true);
  assert.equal((await f.guard.check('test', { preserveInput: true })).notSent, true);
  f.setText('draft after launch'); f.setFrame(null);
  assert.equal((await f.guard.check('test', { preserveInput: true, allowUnready: true })).notSent, true);
  f.fail();
  assert.equal((await f.guard.check('test', { preserveInput: true, allowUnready: true })).notSent, true);
  assert.deepEqual(f.writes, []);
});

test('CodeAgent stop emits exactly two Esc at least 300ms apart and observes returned input for at most 3 seconds', async () => {
  const f = inputGuardFixture();
  const result = await f.guard.stop('test');
  assert.equal(result.ok, true); assert.equal(result.input, null);
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  assert.ok(f.writes[1].at - f.writes[0].at >= 300);
  assert.equal(f.now(), 1000 + f.api.CODEAGENT_STOP_ESC_GAP_MS + 3000);
});

test('stop checks the live screen even if the renderer still claims running', async () => {
  for (const lines of [[' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']]) {
    const f = inputGuardFixture(); f.setFrame(lines);
    const result = await f.guard.stop('test', { rendererState: 'running' });
    assert.equal(result.ok, false); assert.deepEqual(f.writes, []);
    assert.equal(f.stopDiagnostics.at(-1).escSent, 0);
    assert.equal(f.stopDiagnostics.at(-1).decision, 'screen-idle');
    assert.equal(result.message, lines.length > 1 ? '回答已结束' : '无法确认是否在回答，请到终端操作');
  }
});

const REWIND_MENU = ['Rewind to message', '❯ 1. Previous message', '  2. Current message', 'Enter to select · Esc to cancel'];
test('unknown stop screens fall back to current runtime truth and still close a Rewind menu', async () => {
  for (const connected of [true, false]) {
    const f = inputGuardFixture({ status: 'idle' }); f.setFrame(['unrecognized screen']);
    f.current.cliRuntime = { state: 'running', connection: connected ? 'connected' : 'disconnected' };
    let esc = 0;
    const write = f.manager.writeToSession;
    f.manager.writeToSession = (sid, data) => {
      write(sid, data);
      if (data === '\x1b') {
        esc++;
        if (esc === 2) f.setFrame(REWIND_MENU);
        if (esc === 3) f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
      }
    };
    const result = await f.guard.stop('test');
    assert.equal(result.ok, connected); assert.equal(esc, connected ? 3 : 0);
    const final = f.stopDiagnostics.at(-1);
    assert.equal(final.preRunning, 'unknown'); assert.equal(final.decision, 'runtime-fallback');
    assert.equal(final.escSent, connected ? 2 : 0); assert.equal(final.rewindMenuClosed, connected);
    if (connected) assert.equal(f.writes[1].at - f.writes[0].at, 300);
  }
});

test('a readable editor alone does not turn an unknown running screen into idle', async () => {
  const f = inputGuardFixture(); f.setFrame([' │ > private draft │']);
  assert.equal((await f.guard.stop('test')).ok, true);
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  assert.equal(f.stopDiagnostics.at(-1).decision, 'runtime-fallback');
});

test('unreadable stop screens can use running runtime without logging the read failure text', async () => {
  const f = inputGuardFixture({ failRead: true });
  assert.equal((await f.guard.stop('test')).ok, true);
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  assert.equal(f.stopDiagnostics.at(-1).decision, 'runtime-fallback');
  assert.doesNotMatch(JSON.stringify(f.stopDiagnostics), /sensitive|screen failure/);
});

test('stop log decision only accepts the three known levels', t => {
  const dir = temp(t), { recordCodeAgentStop } = require('../core/codeagent-stop-log');
  for (const decision of ['screen-running', 'screen-idle', 'runtime-fallback', 'private body']) {
    recordCodeAgentStop({ event: 'rejected', decision }, { dataDir: dir });
  }
  const rows = fs.readFileSync(path.join(dir, 'logs', 'codeagent-stop.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.decision), ['screen-running', 'screen-idle', 'runtime-fallback', undefined]);
});

test('a Rewind menu appearing after double Esc, including a delayed frame, is closed and diagnosed', async () => {
  for (const delayed of [false, true]) {
    const f = inputGuardFixture(); let esc = 0;
    const write = f.manager.writeToSession;
    f.manager.writeToSession = (sid, data) => {
      write(sid, data);
      if (data === '\x1b') {
        esc++;
        if (esc === 2 && !delayed) f.setFrame(REWIND_MENU);
        if (esc === 3) f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
      }
    };
    if (delayed) {
      const open = f.manager.getSession;
      f.manager.getSession = sid => { if (esc === 2 && f.now() >= 1600) f.setFrame(REWIND_MENU); return open(sid); };
    }
    assert.equal((await f.guard.stop('test')).ok, true);
    assert.equal(esc, 3); assert.ok(f.stopDiagnostics.some(row => row.rewindMenuClosed));
    const final = f.stopDiagnostics.at(-1); assert.equal(final.preRunning, 'running'); assert.equal(final.escSent, 2);
  }
});

test('ordinary send checks close a choice menu before clearing input; a stuck menu blocks sending', async () => {
  for (const closes of [true, false]) {
    const f = inputGuardFixture(); f.setFrame(REWIND_MENU);
    const write = f.manager.writeToSession;
    f.manager.writeToSession = (sid, data) => { write(sid, data); if (closes && data === '\x1b') f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']); };
    const result = await f.guard.check('test');
    assert.equal(result.ok, closes); assert.deepEqual(f.writes.map(row => row.data), ['\x1b']);
    if (!closes) { assert.equal(result.notSent, true); assert.equal(result.message, '终端里有未关闭的菜单，请到终端确认'); }
  }
  const picker = inputGuardFixture(); picker.setFrame(REWIND_MENU);
  await picker.guard.check('test', { skipMenuClose: true }); assert.deepEqual(picker.writes, []);
});

test('CodeAgent main stop refuses only a dormant or explicitly exited session', async () => {
  const f = inputGuardFixture({ text: 'keep terminal draft', status: 'dormant' });
  assert.equal((await f.guard.stop('test')).message, '回答已结束');
  assert.deepEqual(f.writes, []);
  f.current.status = 'running'; f.manager.sessions = new Map([['test', { confirmedExit: { exitCode: 0 } }]]);
  assert.equal((await f.guard.stop('test')).message, '回答已结束'); assert.deepEqual(f.writes, []);
  f.current.kind = 'claude';
  await assert.rejects(f.guard.stop('test'), /CodeAgent/);
  assert.deepEqual(f.writes, []);
});

test('missing main runtime never vetoes a renderer running stop; diagnostics contain only states', async () => {
  for (const status of ['idle', undefined]) {
    const f = inputGuardFixture({ status });
    delete f.current.status;
    if (status) f.current.status = status;
    assert.equal((await f.guard.stop('test', { branch: 'created', rendererState: 'running', queuePending: true })).ok, true);
    assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
    const rows = f.stopDiagnostics;
    assert.equal(rows[0].branch, 'created'); assert.equal(rows[0].rendererState, 'running');
    assert.equal(rows[0].queueWaitMs, 0); assert.equal(rows[0].queuePending, true);
    assert.equal(Date.parse(rows.find(row => row.event === 'esc-second').at) - Date.parse(rows.find(row => row.event === 'esc-first').at), 300);
    assert.equal(rows.at(-1).inputState, 'empty'); assert.equal(rows.at(-1).runtimeBecameNonRunning, false);
  }
});

test('stop diagnostics record runtime completion and bounded rotating logs are included in feedback', t => {
  const dir = temp(t), { recordCodeAgentStop } = require('../core/codeagent-stop-log');
  let clock = 1000;
  const current = { kind: 'codeagent', status: 'running' }, rows = [];
  const guard = require('../core/codeagent-input-guard').createCodeAgentInputGuard({ getSession: () => current, writeToSession() {} }, {
    now: () => clock, sleep: async ms => { clock += ms; if (clock >= 1800) current.status = 'idle'; },
    openScreen: async () => ({ lines: () => ['⠋ Running…', ' │ > private prompt body │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }),
    stopDiagnose: row => { rows.push(row); recordCodeAgentStop({ ...row, text: 'private prompt body', error: 'private account' }, { dataDir: dir, maxBytes: 1200 }); },
  });
  return guard.stop('abcdefgh-private-session', { branch: 'existing', rendererState: 'running' }).then(() => {
    assert.equal(rows.find(row => row.event === 'esc-second').preRunning, 'running');
    assert.equal(rows.find(row => row.event === 'esc-second').escSent, 2);
    assert.equal(rows.at(-1).runtimeBecameNonRunning, true);
    assert.equal(rows.at(-1).inputState, 'nonempty');
    for (let i = 0; i < 25; i++) recordCodeAgentStop({ ...rows[0], text: 'private prompt body' }, { dataDir: dir, maxBytes: 1200 });
    const file = path.join(dir, 'logs', 'codeagent-stop.log');
    assert.ok(fs.existsSync(file + '.1')); assert.ok(fs.statSync(file).size <= 1200); assert.ok(fs.statSync(file + '.1').size <= 1200);
    for (const target of [file, file + '.1']) {
      const text = fs.readFileSync(target, 'utf8');
      assert.doesNotMatch(text, /private|prompt body|account/); assert.equal(JSON.parse(text.trim().split('\n')[0]).sessionId, 'abcdefgh');
      const record = JSON.parse(text.trim().split('\n')[0]); assert.equal(record.preRunning, 'unknown'); assert.equal(record.escSent, 0); assert.equal(record.rewindMenuClosed, false);
    }
    assert.ok(require('../core/hub-feedback').collectBundle({ logsDir: path.dirname(file) }).items.some(item => item.name === '日志 codeagent-stop.log'));
  });
});

function stopSenderFixture({ phase = 'ack' } = {}) {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const file = path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), localRequire = createRequire(file);
  const f = inputGuardFixture();
  let release, entered = false, hold = true;
  const waiting = new Promise(resolve => { release = resolve; });
  Object.assign(f.manager, { getGroupChatReady: () => true, getGroupChatLastActivity: () => 1,
    getSessionBuffer: () => '', getSessionOutputMark: () => 0, getNativeClaude: () => null });
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    ack: async () => { entered = true; if (hold) await waiting; return null; },
    require: name => name === './codeagent-input-guard' ? { codeAgentInputGuard: () => f.guard }
      : name === './codeagent-model-picker' ? { isPicking: () => false, beforePrompt: async () => {} }
      : name === './pty-prompt-submit.js' ? { ...localRequire(name), waitForPasteSettled: async () => {},
        writeBracketedPaste: async (manager, sid, text) => {
          manager.writeToSession(sid, '\x1b[200~' + text.slice(0, 3));
          if (phase === 'paste' && hold) { entered = true; await waiting; }
          manager.writeToSession(sid, text.slice(3) + '\x1b[201~');
        } } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + `\nobserveAgentTurnStart = () => ({ dispose() {} });\ncreateLivePtyRuntimeObserver = () => null;\nwaitForAgentWorkStart = (...args) => ack(...args);`, context);
  const sender = context.module.exports; sender.init({ sessionManager: f.manager });
  return { ...f, sender, context, entered: () => entered, release() { hold = false; context.ack = async () => 'hook'; release(); } };
}

for (const phase of ['paste', 'ack']) test(`stop bypasses an unfinished ${phase}, cancels only that sender, and a new send succeeds`, async () => {
  const f = stopSenderFixture({ phase });
  const sending = f.sender.sendToPty('test', '/test-skill original body', 'codeagent', { requireReady: true });
  while (!f.entered()) await new Promise(setImmediate);
  const before = f.writes.length;
  const stopping = f.sender.codeAgentInputAction('test', 'stop', { branch: 'existing', rendererState: 'running' });
  if (phase === 'ack') { while (!f.writes.some(row => row.data === '\x1b')) await new Promise(setImmediate); }
  if (phase === 'paste') assert.equal(f.writes[before].data, '\x1b[201~', 'close the interrupted paste without Esc');
  f.release();
  const stopped = await sending;
  assert.equal(stopped.stopped, true); assert.equal(stopped.sendStatus, 'stopped');
  assert.equal(stopped.notSent, phase === 'paste'); assert.equal(stopped.enterAttempts, phase === 'paste' ? 0 : 1);
  const next = f.sender.sendToPty('test', 'next ordinary prompt', 'codeagent', { requireReady: true });
  assert.equal((await stopping).ok, true);
  assert.equal((await next).ok, true);
  assert.deepEqual(f.writes.slice(before).filter(row => row.data === '\x1b').map(row => row.data), phase === 'paste' ? [] : ['\x1b', '\x1b']);
  assert.equal(f.writes.filter(row => row.data === '\r').length, phase === 'paste' ? 1 : 2, 'no recovery Enter from the stopped send');
  assert.equal(f.stopDiagnostics[0].queuePending, true); assert.equal(f.stopDiagnostics[0].queueWaitMs, 0);
});

test('stopping a half-written paste clears the editor without Esc and restores the original Hub skill draft', async () => {
  const f = stopSenderFixture({ phase: 'paste' }), write = f.manager.writeToSession;
  let editor = '', menuOpened = false;
  f.manager.writeToSession = (sid, data) => {
    write(sid, data);
    if (data.startsWith('\x1b[200~')) { editor = data.slice(6); f.setText(editor); }
    if (data === '\x15') editor = '';
    if (data === '\x1b') menuOpened = true;
  };
  const original = '/test-skill complete original body';
  const sending = f.sender.sendToPty('test', original, 'codeagent', { requireReady: true });
  while (!f.entered()) await new Promise(setImmediate);
  const stopping = f.sender.codeAgentInputAction('test', 'stop'); f.release();
  const result = await sending; assert.equal(result.stopped, true); assert.equal(result.notSent, true);
  assert.equal((await stopping).cleared, true); assert.equal(editor, ''); assert.equal(menuOpened, false);
  assert.ok(f.writes.some(row => row.data === '\x15')); assert.ok(!f.writes.some(row => row.data === '\x1b'));
  const d = dom(); require('../renderer/composer-codeagent-input').restoreRecoveredPrompt(d.input,
    { text: original, skill: { name: 'test-skill' } }, { ...d, session, onChange() {} });
  assert.equal(skills.skillPrompt(d.input, d.input.textContent, session), original);
});

test('stopped receipt is terminal, removed from late matching and never becomes unconfirmed', () => {
  const { PromptSubmissionReceipts } = require('../core/prompt-submission-receipts');
  const updates = [], receipts = new PromptSubmissionReceipts(value => updates.push(value));
  const receipt = receipts.begin('test', 'stopped-send', 'original', 1000);
  receipts.finish(receipt, { ok: true, stopped: true, notSent: true, sendStatus: 'stopped' });
  assert.equal(receipt.status, 'stopped'); assert.deepEqual(receipts.unresolved.get('test'), []);
  assert.equal(updates.at(-1).status, 'stopped');
  const state = require('../renderer/prompt-delivery-state').beginPromptDelivery('stopped-send');
  assert.equal(require('../renderer/prompt-delivery-state').applyPromptReceipt(state, updates[0]), true);
  assert.equal(require('../renderer/prompt-delivery-state').applyPromptReceipt(state, { clientSubmissionId: 'stopped-send', status: 'unconfirmed' }), false);
});

test('a queued next submission is not cancelled by Stop on the active submission', async () => {
  const f = stopSenderFixture();
  const first = f.sender.sendToPty('test', 'active prompt', 'codeagent', { requireReady: true });
  while (!f.entered()) await new Promise(setImmediate);
  const second = f.sender.sendToPty('test', 'already queued next prompt', 'codeagent', { requireReady: true });
  const stopping = f.sender.codeAgentInputAction('test', 'stop');
  const repeated = f.sender.codeAgentInputAction('test', 'stop');
  f.release();
  assert.equal((await first).stopped, true);
  assert.equal((await stopping).ok, true); assert.equal((await repeated).ok, true);
  const result = await second;
  assert.equal(result.ok, true); assert.equal(result.stopped, undefined);
  const esc = f.writes.filter(row => row.data === '\x1b'); assert.equal(esc.length, 2);
  const lastPaste = f.writes.find(row => row.data.includes('eady queued'));
  assert.ok(lastPaste.at >= esc[1].at + 3000, 'no queued paste can interleave with the two Esc or recovery');
});

test('stop also bypasses a cold-start readiness wait without ever submitting its prompt', async () => {
  const f = stopSenderFixture();
  f.manager.getGroupChatReady = () => false;
  require('node:vm').runInContext('waitCliReady = () => ack();', f.context);
  const sending = f.sender.sendToPty('test', 'not yet ready prompt', 'codeagent', { requireReady: true });
  while (!f.entered()) await new Promise(setImmediate);
  const stopping = f.sender.codeAgentInputAction('test', 'stop');
  assert.deepEqual(f.writes, []);
  const stopped = await sending;
  assert.equal(stopped.stopped, true); assert.equal(stopped.notSent, true);
  f.release(); await stopping;
  assert.deepEqual(f.writes, []);
});

test('an unreadable pre-stop screen rejects Esc without logging the failure text', async () => {
  const f = inputGuardFixture({ failRead: true, status: 'idle' });
  const result = await f.guard.stop('test');
  assert.equal(result.ok, false); assert.equal(result.message, '无法确认是否在回答，请到终端操作');
  assert.equal(f.stopDiagnostics.at(-1).preRunning, 'unknown'); assert.equal(f.stopDiagnostics.at(-1).escSent, 0); assert.deepEqual(f.writes, []);
  assert.doesNotMatch(JSON.stringify(f.stopDiagnostics), /sensitive|screen failure/);
});

test('phone and HubTools stop callbacks write both Esc immediately even while a real sender awaits acknowledgement', async () => {
  const vm = require('node:vm'), main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const callbacks = [...main.matchAll(/interruptSession: (async id => \{[\s\S]*?^\s{4,6}\}),/gm)];
  assert.equal(callbacks.length, 2);
  for (const [, callback] of callbacks) {
    const f = stopSenderFixture();
    const sending = f.sender.sendToPty('test', 'body', 'codeagent', { requireReady: true });
    while (!f.entered()) await new Promise(setImmediate);
    const interrupt = vm.runInNewContext(`(${callback})`, { sessionManager: f.manager,
      require: name => name === './core/ai-kinds' ? require('../core/ai-kinds') : f.sender });
    const result = interrupt('test');
    while (!f.writes.some(row => row.data === '\x1b')) await new Promise(setImmediate); f.release();
    assert.equal((await sending).stopped, true); assert.equal((await result).ok, true);
    const esc = f.writes.filter(row => row.data === '\x1b'); assert.equal(esc.length, 2); assert.ok(esc[1].at - esc[0].at >= 300);
  }
});

test('manual terminal-input and guarded stop reach pty.write with identical raw Esc bytes', async () => {
  const vm = require('node:vm'), managerText = fs.readFileSync(path.join(__dirname, '..', 'core/session-manager.js'), 'utf8');
  const method = (name, next) => managerText.slice(managerText.indexOf('  ' + name + '('), managerText.indexOf('\n  ' + next + '(', managerText.indexOf('  ' + name + '('))).trim();
  const methods = vm.runInNewContext(`({${method('writeToSession', 'getLastWrite')},${method('_interceptBareCodexHostLaunch', 'writeToSession')}})`, {
    isCodexCliKind: require('../core/ai-kinds').isCodexCliKind,
  });
  const writes = [], entry = { info: { kind: 'codeagent', status: 'running' }, pty: { write: data => writes.push(data) } };
  const manager = { ...methods, sessions: new Map([['test', entry]]), getSession: () => ({ ...entry.info }) };
  const source = fs.readFileSync(path.join(__dirname, '..', 'main/ipc/session-handlers.js'), 'utf8');
  const at = source.indexOf("  ipcMain.on('terminal-input',"), end = source.indexOf('\n  });', at) + 6;
  let manual;
  vm.runInNewContext(source.slice(at, end), { ipcMain: { on: (_name, fn) => { manual = fn; } }, sessionManager: manager });
  manual(null, { sessionId: 'test', data: '\x1b' }); manual(null, { sessionId: 'test', data: '\x1b' });
  let clock = 1000;
  const guard = require('../core/codeagent-input-guard').createCodeAgentInputGuard(manager, {
    now: () => clock, sleep: async ms => { clock += ms; }, stopDiagnose() {},
    openScreen: async () => ({ lines: () => ['⠋ Running…', ' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }),
  });
  await guard.stop('test');
  assert.deepEqual(writes.slice(2), writes.slice(0, 2)); assert.deepEqual(writes, ['\x1b', '\x1b', '\x1b', '\x1b']);
});

test('real IPC and SQLite reopen keep stopped flags; a submitted CLI echo still reloads as one user card', async t => {
  const vm = require('node:vm'), { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
  const { CommandTranscriptStore, mergeCommandTurns } = require('../core/command-transcript-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-stop-journal-')), file = path.join(__dirname, '..', 'main/ipc/prompt-submit-handlers.js'), localRequire = createRequire(file);
  let store = new CommandTranscriptStore(root), notSent = true;
  const handlers = new Map(), updates = [], manager = new EventEmitter();
  manager.getSession = () => ({ kind: 'codeagent', agentRuntime: 'pty' });
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async () => ({ ok: true }),
      sendToPty: async () => ({ ok: true, stopped: true, notSent, sendStatus: 'stopped', enterAttempts: notSent ? 0 : 1 }),
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    sessionManager: manager, sendToRenderer: (...args) => updates.push(args), commandTranscriptStore: store,
  });
  t.after(() => { registration.dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ['pre-enter', 'post-enter']) {
    notSent = id === 'pre-enter';
    const result = await handlers.get('session:send-prompt')(null, { sessionId: id, text: '/TEST-SKILL original\nbody', clientSubmissionId: id });
    assert.equal(result.stopped, true); assert.equal(result.sendStatus, 'stopped'); assert.equal(result.notSent === true, notSent);
    assert.equal(result.unconfirmed, undefined);
  }
  const ordinary = await handlers.get('session:send-prompt')(null, { sessionId: 'ordinary', text: 'ordinary body', clientSubmissionId: 'ordinary' });
  assert.equal(ordinary.receipt.status, 'stopped');
  store.close(); store = new CommandTranscriptStore(root);
  const pre = store.read('pre-enter'), post = store.read('post-enter');
  assert.equal(pre[0].commandResult.notSent, true); assert.equal(post[0].commandResult.stopped, true);
  const echo = { id: 'cli', role: 'user', text: '/test-skill formatted body', ts: post[0].ts + 60000 };
  const answer = { id: 'answer', role: 'assistant', text: 'partial answer', ts: echo.ts + 1 };
  const merged = mergeCommandTurns([echo, answer], post, { codeagent: true });
  assert.equal(merged.filter(turn => turn.role === 'user').length, 1); assert.equal(merged[0].text, post[0].text); assert.equal(merged[1].text, 'partial answer');
  const unsent = mergeCommandTurns([{ ...echo, ts: pre[0].ts + 60000 }], pre, { codeagent: true });
  assert.equal(unsent.filter(turn => turn.role === 'user').length, 2, 'an unsent journal cannot steal a later terminal command echo');
  assert.ok(updates.some(([name, event]) => name === 'session:prompt-receipt' && event.status === 'stopped'));
});

test('fresh public session copies still support double Esc and recovery; a restarted PTY never borrows the old original', async () => {
  const f = inputGuardFixture({ text: '[Pasted text +10 lines]' });
  f.manager.getSession = id => id === 'test' ? { ...f.current } : null;
  f.manager.sessions = new Map([['test', { info: f.current }]]);
  f.guard.remember('test', 'original sent before pause');
  const stopped = await f.guard.stop('test');
  assert.equal(stopped.ok, true); assert.equal(stopped.input.text, 'original sent before pause');
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  f.manager.sessions.set('test', { info: { ...f.current } });
  assert.equal((await f.guard.clear('test', stopped.input.token)).ok, false);
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  const restarted = await f.guard.inspect('test');
  assert.equal(restarted.input.incomplete, true); assert.equal(restarted.input.text, '[Pasted text +10 lines]');
});

test('folded input uses the last successful original and preserves skill metadata; readable mismatches never borrow it', async () => {
  const f = inputGuardFixture({ text: '[Pasted text +20 lines]' });
  const original = '/test-skill line one\nline two';
  f.guard.remember('test', original, { name: 'test-skill', installedAt: 200 });
  let result = await f.guard.stop('test');
  assert.equal(result.input.text, original); assert.equal(result.input.incomplete, false);
  assert.equal(result.input.skill.name, 'test-skill');
  f.setText('terminal authored request'); result = await f.guard.inspect('test');
  assert.equal(result.input.text, 'terminal authored request'); assert.equal(result.input.incomplete, true); assert.equal(result.input.skill, null);
  f.setText('/test-skill line one…'); result = await f.guard.inspect('test');
  assert.equal(result.input.text, original); assert.equal(result.input.incomplete, false);
  f.setText('another request [Pasted text +10 lines]'); result = await f.guard.inspect('test');
  assert.equal(result.input.incomplete, true); assert.match(result.input.text, /^another request/);
});

test('without a Hub original recovery returns only readable input and marks it incomplete', async () => {
  const f = inputGuardFixture({ text: 'terminal request' }), result = await f.guard.inspect('test');
  assert.equal(result.input.text, 'terminal request'); assert.equal(result.input.incomplete, true);
  assert.deepEqual(f.writes, []);
});

test('residual check automatically clears and confirms; changed clear tokens still refuse writes', async () => {
  const f = inputGuardFixture({ text: 'old request' }), events = [];
  f.manager.emit = (...args) => events.push(args);
  assert.equal((await f.guard.check('test')).ok, true);
  assert.deepEqual(f.writes.map(row => row.data), ['\x15']);
  assert.deepEqual(events, [['codeagent-input-cleared', { sessionId: 'test', text: 'old request' }]]);
  f.setText('first'); const blocked = await f.guard.inspect('test'); f.setText('different');
  assert.equal((await f.guard.clear('test', blocked.input.token)).ok, false);
  assert.equal(f.writes.length, 1);
});

test('folded residual is cleared without saving unreadable text; failed clearing blocks the new prompt', async () => {
  const f = inputGuardFixture({ text: '[Pasted text +20 lines]' }), events = [];
  f.manager.emit = (...args) => events.push(args);
  assert.equal((await f.guard.check('test')).ok, true);
  assert.equal(events[0][1].text, '');
  f.setText('unclearable'); f.manager.writeToSession = (_sid, data) => f.writes.push({ data });
  const result = await f.guard.check('test');
  assert.equal(result.ok, false); assert.equal(result.notSent, true); assert.equal(result.code, 'codeagent-input-residual');
  assert.equal(result.message, '终端输入框未能清空，请到终端确认后再发送'); assert.equal(events.length, 1);
});

test('screen read failure is diagnostic and does not block a prompt', async () => {
  const f = inputGuardFixture({ failRead: true });
  const result = await f.guard.check('test');
  assert.equal(result.ok, true); assert.equal(result.readFailed, true);
  assert.deepEqual(f.diagnostics, ['input-read-failed']); assert.deepEqual(f.writes, []);
});

test('the current input snapshot excludes answer text, status and placeholder content', () => {
  const { inputSnapshot } = require('../core/codeagent-input-guard');
  const footer = ' │ Bypass (Cycle shift+tab) | GLM │';
  assert.deepEqual(inputSnapshot(['answer secret', ' │ > Anything I can assist you with? │', footer]), { state: 'empty', text: '' });
  assert.deepEqual(inputSnapshot(['answer', ' │ > first │', ' │ second │', footer]), { state: 'nonempty', text: 'first\nsecond' });
  assert.equal(inputSnapshot(['no input marker']).state, 'unknown');
});

function recoveryFixture({ draft = '', running = true } = {}) {
  const f = dom(), calls = [], notices = [];
  let value = draft, latest = { ok: false, input: { token: 'token', text: 'previous original', incomplete: false }, prompt: { text: 'previous original' }, cleared: true };
  const controller = require('../renderer/composer-codeagent-input').createCodeAgentInputRecovery({
    document: f.document, host: f.document.body, readDraft: () => value,
    restoreDraft: input => { calls.push(['restore', input]); value = value + (value ? '\n\n' : '') + input.text; }, notify: (...args) => notices.push(args),
    isRunning: () => running,
    invoke: async (channel, payload) => { calls.push([channel, payload]); return channel === 'codeagent:input-clear' ? { ok: true } : { ...latest, ok: true }; },
  });
  return { ...f, controller, calls, notices, latest, draft: () => value, setDraft: text => { value = text; } };
}

test('stop visibility is CodeAgent PTY running only, including low-confidence running states', () => {
  const { codeAgentCanStop } = require('../renderer/composer-codeagent-input');
  for (const kind of ['codeagent', 'codeagent-resume']) assert.equal(codeAgentCanStop({ kind, agentRuntime: 'pty' }, 'running'), true);
  for (const state of ['idle', 'completed', 'starting', 'waiting']) assert.equal(codeAgentCanStop({ kind: 'codeagent', agentRuntime: 'pty' }, state), false);
  assert.equal(codeAgentCanStop({ kind: 'claude', agentRuntime: 'pty' }, 'running'), false);
  assert.equal(codeAgentCanStop({ kind: 'codeagent', agentRuntime: 'native' }, 'running'), false);
});

function editFixture({ draft = '', previousSkill, kind = 'codeagent', inventory = { skills: [] } } = {}) {
  const f = dom(), values = new Map(), calls = [], notices = [];
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const session = { kind }, history = require('../renderer/floating-input-history').createFloatingInputHistory({ storage });
  const cursor = history.createCursor('test');
  f.input.textContent = draft;
  if (previousSkill) skills.insertSkillTag(f.input, previousSkill, { ...f, session });
  const options = { input: f.input, sessionId: 'test', session, document: f.document, window: f.window, storage,
    readText: input => input.textContent, replaceText: (input, text) => { input.textContent = text; },
    saveDraft: () => calls.push('saved'), historyChanged: () => { cursor.invalidate(); calls.push('invalidated'); },
    invoke: async (channel, payload) => { calls.push([channel, payload]); return inventory; }, notify: (...args) => notices.push(args) };
  return { ...f, options, calls, notices, storage, history, cursor,
    edit: text => require('../renderer/card-edit-resend').editResend({ ...options, text }) };
}

test('edit-resend replaces an empty composer and replaces a draft after saving it to ArrowUp history', async () => {
  for (const draft of ['', 'new draft']) {
    const f = editFixture({ draft }); f.cursor.older('');
    assert.equal(await f.edit('original prompt'), true);
    assert.equal(f.input.textContent, 'original prompt'); assert.ok(f.calls.includes('saved'));
    assert.equal(f.document.activeElement, f.input);
    assert.deepEqual(f.history.list('test'), draft ? [draft] : []);
    if (draft) {
      assert.equal(f.cursor.older(f.input.textContent).text, draft);
      assert.equal(f.notices[0][0], '原草稿已存入历史，按 ↑ 找回');
    } else assert.deepEqual(f.notices, []);
  }
});

test('edit-resend replaces old skill drafts and restores installed skills before cache-only skills', async () => {
  for (const cached of [false, true]) {
    const inventory = { skills: cached ? [] : [{ name: 'new-skill', installedAt: 123 }],
      commands: [{ name: 'new-skill', kind: 'skill', installedAt: 999 }, { name: 'local', kind: 'command' }] };
    const f = editFixture({ draft: 'old body', previousSkill: { name: 'old-skill' }, inventory });
    await f.edit('/new-skill original\nbody');
    assert.equal(skills.selectedSkill(f.input).name, 'new-skill');
    assert.equal(skills.selectedSkill(f.input).installedAt, cached ? 999 : 123);
    assert.equal(f.input.textContent, '/new-skill original\nbody');
    assert.equal(f.cursor.older('').text, '/old-skill old body');
    assert.equal(f.calls.filter(Array.isArray)[0][0], 'codeagent:skills');
    await f.edit('/local arguments'); assert.equal(skills.selectedSkill(f.input), null);
    assert.equal(f.input.textContent, '/local arguments');
  }
});

test('unknown skills and non-CodeAgent prompts stay plain; switching panes during lookup refuses replacement', async () => {
  const unknown = editFixture(); await unknown.edit('/unknown body'); assert.equal(skills.selectedSkill(unknown.input), null);
  const other = editFixture({ kind: 'claude', draft: 'old', inventory: { skills: [{ name: 'known' }] } });
  await other.edit('/known body'); assert.equal(skills.selectedSkill(other.input), null); assert.equal(other.calls.filter(Array.isArray).length, 0);
  const switched = editFixture({ draft: 'keep' }); switched.options.isCurrent = () => false;
  assert.equal(await switched.edit('/unknown body'), false); assert.equal(switched.input.textContent, 'keep');
  assert.deepEqual(switched.history.list('test'), []); assert.equal(switched.notices[0][0], '这条消息不属于当前会话');
});

test('stopped card IDs persist without text, obey per-session and total bounds, and clear on session deletion', () => {
  const api = require('../renderer/card-edit-resend'), values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const remember = (sid, i) => api.rememberStoppedTurn(storage, sid, { id: 'turn-' + i, clientSubmissionId: 'send-' + i, text: 'private prompt body' });
  for (let i = 0; i < 55; i++) remember('first', i);
  assert.equal(api.isStoppedUserTurn({ role: 'user', id: 'turn-0' }, storage, 'first'), false);
  assert.equal(api.isStoppedUserTurn({ role: 'user', id: 'turn-54' }, storage, 'first'), true);
  for (let account = 0; account < 12; account++) for (let i = 0; i < 50; i++) remember('session-' + account, i);
  const all = JSON.parse([...values.values()][0]);
  assert.equal(Object.values(all).flat().length, api.STOPPED_TOTAL_LIMIT);
  assert.ok(Object.values(all).every(rows => rows.length <= api.STOPPED_PER_SESSION_LIMIT));
  assert.equal(all.first, undefined); assert.equal(all['session-0'], undefined);
  assert.equal(api.isStoppedUserTurn({ role: 'user', clientSubmissionId: 'send-49' }, storage, 'session-11'), true);
  assert.doesNotMatch(JSON.stringify(all), /private|prompt body/);
  api.clearStoppedTurns(storage, 'session-11');
  assert.equal(api.isStoppedUserTurn({ role: 'user', id: 'turn-49' }, storage, 'session-11'), false);
});

test('stop clears only the terminal and emits a plain stopped toast without restoring the Hub draft', async () => {
  for (const draft of ['', 'new draft']) {
    const f = recoveryFixture({ draft }); await f.controller.stop();
    assert.equal(f.draft(), draft); assert.equal(f.document.body.querySelectorAll('section').length, 0);
    assert.deepEqual(f.calls.map(row => row[0]), ['codeagent:input-stop']);
    assert.equal(f.notices[0][0], '已停止'); assert.equal(f.notices[0][2], undefined);
    assert.equal(f.draft(), draft);
  }
  const idle = recoveryFixture({ running: false }); await idle.controller.stop();
  assert.deepEqual(idle.calls, []); assert.equal(idle.notices[0][0], '回答已结束');
});

test('the stopped toast stays outside the composer, has no action and disappears after three seconds', t => {
  const f = dom(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const toast = require('../renderer/composer-codeagent-input').showStopToast(f.document, '已停止');
  assert.equal(toast.parentNode, f.document.body); assert.equal(toast.children[0].textContent, '已停止');
  assert.equal(toast.querySelectorAll('button').length, 0); t.mock.timers.tick(3000); assert.equal(toast.parentNode, null);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer/renderer.js'), 'utf8');
  assert.doesNotMatch(renderer, /contentStack\.insertBefore\(bar\._codeagentInputRecovery/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'renderer/composer-codeagent-input.js'), 'utf8'), /confirmReplace|codeagent-input-recovery|discardToken/);
});

test('shared stop clears returned editor text after its cancelled sender settles', async () => {
  const f = stopSenderFixture(); f.setText('returned prompt');
  f.guard.remember('test', '/test-skill original', { name: 'test-skill' });
  const result = await f.sender.codeAgentInputAction('test', 'stop');
  assert.equal(result.cleared, true); assert.equal(result.prompt.text, '/test-skill original');
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b', '\x15']);
});

test('recovery restores the skill tag and body, and its normal draft persistence still works', () => {
  const f = dom(), storage = memoryStorage(), session = { kind: 'codeagent', createdAt: 1 };
  require('../renderer/composer-codeagent-input').restoreRecoveredPrompt(f.input, { text: '/test-skill first\nsecond', skill: { name: 'test-skill', installedAt: 1 } }, {
    ...f, session, onChange: () => skills.saveSkillDraft(storage, 'test', f.input, f.input.textContent, session),
  });
  assert.equal(f.input.querySelector('[data-codeagent-skill]').dataset.codeagentSkill, 'test-skill');
  assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), '/test-skill first\nsecond');
  assert.equal(skills.readSkillDraft(storage, 'test', session).skill.name, 'test-skill');
});

test('real PTY submission guards ordinary, skill and interactive prompts; non-CodeAgent sends are unchanged', async t => {
  isolateInputDiagnostics(t);
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const file = path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), localRequire = createRequire(file);
  const f = commandPrefixFixture(t); f.setFrame([' │ > old terminal draft │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  const originalWrite = f.manager.writeToSession;
  f.manager.writeToSession = (sid, data) => {
    originalWrite(sid, data);
    if (data === '\x15') f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
    if (data === '\x1b') f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  };
  Object.assign(f.manager, { getGroupChatReady: () => true, getGroupChatLastActivity: () => 1,
    getSessionBuffer: () => '❯ \n? for shortcuts', getSessionOutputMark: () => 0, getNativeClaude: () => null });
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    require: name => name === './pty-prompt-submit.js' ? { ...localRequire(name), waitForPasteSettled: async () => {} } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + `\nobserveAgentTurnStart = () => ({ dispose() {} });\nwaitForAgentWorkStart = async () => 'hook';`, context);
  const sender = context.module.exports; sender.init({ sessionManager: f.manager });
  for (const [text, interactive] of [['ordinary', false], ['/test-skill body', false], ['/unknown', true]]) {
    f.writes.length = 0; f.setFrame([' │ > old terminal draft │', ' │ Bypass (Cycle shift+tab) | GLM │']);
    const result = await sender.sendToPty('test', text, 'codeagent', { requireReady: true, codeagentInteractiveCommand: interactive });
    assert.equal(result.ok, true); assert.equal(f.writes[0], '\x15'); assert.equal(result.enterAttempts, 1);
  }
  for (const [text, interactive] of [['ordinary', false], ['/skills', true]]) {
    f.writes.length = 0; f.setFrame(REWIND_MENU);
    const result = await sender.sendToPty('test', text, 'codeagent', { requireReady: true, codeagentInteractiveCommand: interactive });
    assert.equal(result.ok, true); assert.equal(f.writes[0], '\x1b'); assert.equal(result.enterAttempts, 1);
    assert.equal(f.writes.filter(data => data === '\x1b').length, 1, 'close the old menu before the intentional command, never after opening it');
  }
  f.current.kind = 'claude'; f.writes.length = 0;
  await sender.sendToPty('test', 'ordinary', 'claude', { requireReady: true });
  assert.equal(f.writes.filter(data => data === '\r').length, 1);
  f.current.kind = 'codeagent'; f.writes.length = 0;
  f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  await sender.sendToPty('test', '/test-skill augmented prompt', 'codeagent', { requireReady: true, originalPrompt: '/test-skill original prompt', codeagentSkill: { name: 'test-skill' } });
  f.setFrame([' │ > [Pasted text +20 lines] │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  const saved = await sender.codeAgentInputAction('test', 'inspect');
  assert.equal(saved.input.text, '/test-skill original prompt'); assert.equal(saved.input.skill.name, 'test-skill');
  f.manager.getSessionBufferSnapshot = async () => { throw new Error('private account detail must not be logged'); };
  f.writes.length = 0;
  const unreadable = await sender.sendToPty('test', '/unknown', 'codeagent', { requireReady: true, codeagentInteractiveCommand: true });
  assert.equal(unreadable.ok, true); assert.equal(unreadable.enterAttempts, 1);
  assert.equal(f.writes.filter(data => data === '\r').length, 1);
  const diagnostic = fs.readFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR, 'logs', 'codeagent-input.log'), 'utf8');
  assert.match(diagnostic, /input-read-failed/); assert.doesNotMatch(diagnostic, /private|account|unknown|prompt/);
  const { reason, stage, sendBlocked } = JSON.parse(diagnostic.trim().split('\n').at(-1));
  assert.deepEqual({ reason, stage, sendBlocked }, { reason: 'target-check-failed', stage: 'before-send', sendBlocked: false });
  assert.equal((await require('../core/codeagent-input-guard').codeAgentInputGuard(f.manager).check('test', { preserveInput: true })).notSent, true);
  const denied = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR, 'logs', 'codeagent-input.log'), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([denied.reason, denied.stage, denied.sendBlocked], ['open-screen-failed', 'check-preserve-input', true]);
  assert.doesNotMatch(JSON.stringify(denied), /private|account|unknown|prompt/);
});

test('a stalled terminal screen read times out without blocking submission', async () => {
  let timer, wait, diagnosed = 0;
  const manager = { getSession: () => ({ kind: 'codeagent' }) };
  const guard = require('../core/codeagent-input-guard').createCodeAgentInputGuard(manager, {
    openScreen: () => new Promise(() => {}), diagnose: () => { diagnosed += 1; },
    setTimer: (fn, ms) => { timer = fn; wait = ms; return 1; }, clearTimer() {},
  });
  const checking = guard.check('test');
  assert.equal(wait, 1000); timer();
  assert.equal((await checking).ok, true); assert.equal(diagnosed, 1);
});

test('real prompt IPC auto-clears before receipts/journal; failed clear refuses dispatch', async t => {
  const { EventEmitter } = require('node:events'), { createRequire } = require('node:module'), vm = require('node:vm');
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), localRequire = createRequire(file);
  const handlers = new Map(), writes = [], journals = [], updates = [];
  const s = { kind: 'codeagent', agentRuntime: 'pty' }, manager = new EventEmitter(); manager.getSession = () => s;
  let residual = true, clearFailed = true;
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async () => { if (residual && !clearFailed) { writes.push('\x15'); residual = false; manager.emit('codeagent-input-cleared', { sessionId: 'test', text: 'old' }); } return residual ? { ok: false, notSent: true, code: 'codeagent-input-residual', input: { token: 'token', text: 'old' } } : { ok: true }; },
      sendToPty: async (...args) => { writes.push(args); return { ok: true, enterAttempts: 1 }; },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, { sessionManager: manager, sendToRenderer: (...args) => updates.push(args), commandTranscriptStore: { begin: (...args) => { journals.push(args); return { duplicate: false }; }, finish() {} } });
  t.after(() => registration.dispose());
  for (const text of ['ordinary', '/test-skill body', '/unknown']) {
    residual = true; clearFailed = true; const request = { sessionId: 'test', text, clientSubmissionId: 'test-' + text, codeagentInteractiveCommand: text === '/unknown' };
    const at = writes.length, journalAt = journals.length, updatesAt = updates.length;
    const blocked = await handlers.get('session:send-prompt')(null, request);
    assert.equal(blocked.code, 'codeagent-input-residual'); assert.equal(writes.length, at); assert.equal(journals.length, journalAt); assert.equal(updates.length, updatesAt);
    clearFailed = false;
    const result = await handlers.get('session:send-prompt')(null, request);
    assert.equal(result.ok, true); assert.equal(writes[at], '\x15');
    assert.equal(writes.at(-1)[3].clientSubmissionId, request.clientSubmissionId); assert.equal(writes.at(-1)[3].codeagentInteractiveCommand, request.codeagentInteractiveCommand);
    assert.equal(result.enterAttempts, 1);
    assert.ok(updates.some(([event, data]) => event === 'codeagent-input-cleared' && data.text === 'old'));
  }
});


test('restoring skill B preserves a draft and its skill A, and moves the caret to the end', () => {
  const { restoreRecoveredPrompt } = require('../renderer/composer-codeagent-input');
  for (const tagged of [false, true]) {
    const f = dom(); f.input.textContent = 'existing draft';
    if (tagged) skills.insertSkillTag(f.input, { name: 'skill-a' }, { ...f, session });
    restoreRecoveredPrompt(f.input, { text: '/skill-b body', skill: { name: 'skill-b' } }, { ...f, session, onChange() {} });
    assert.equal(skills.selectedSkill(f.input)?.name, tagged ? 'skill-a' : undefined);
    assert.equal(skills.skillPrompt(f.input, f.input.textContent, session), (tagged ? '/skill-a ' : '') + 'existing draft\n\n/skill-b body');
    assert.equal(f.window.getSelection().getRangeAt(0).root, f.input);
  }
});
