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
function pickerFixture({ kind = 'codeagent', storage = memoryStorage(), account = '', inventory = async () => ({ ok: true, skills: [{ name: 'insight-hub', description: '写总结', 'argument-hint': '[topic]', installedAt: 2000 }] }) } = {}) {
  const f = dom(), calls = [], host = f.document.createElement('div'); f.document.body.append(host);
  const controller = skills.mountCodeAgentSkillPicker({ ...f, host, sessionId: 'test', storage, getSession: () => ({ ...session, kind, codeagentPoolAccount: account }),
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return inventory(); } },
    readText: () => f.input.textContent, replaceText: text => { f.input.textContent = text; }, saveDraft() {}, openMenu: async () => { calls.push('open-menu'); return { ok: true }; },
    openCommands: async () => { calls.push('commands'); return { ok: true }; },
    openCommand: async text => { calls.push({ terminalCommand: text }); return { ok: true }; },
  });
  return { ...f, controller, calls, storage };
}

test('toolbar list rescans each open, shows descriptions/hints, replaces the tag and keeps the AgentCenter entry', async () => {
  const f = pickerFixture();
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker');
  assert.match(popup.textContent, /insight-hub.*写总结.*\[topic\].*从 AgentCenter 添加/);
  popup.querySelector('.fi-skill-option').dispatchEvent(event('click'));
  assert.equal(skills.selectedSkill(f.input).name, 'insight-hub');
  assert.equal(popup.hidden, true);
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2);
  popup.querySelector('.fi-skill-add').dispatchEvent(event('click'));
  assert.equal(f.calls.at(-1), 'open-menu');
  f.controller.dispose();
  assert.equal(f.document.body.querySelector('.fi-skill-picker'), null);
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
  assert.deepEqual(details.map(node => node.title), [description, hint]);
  assert.deepEqual(details.map(node => node.textContent), [description, hint], 'CSS truncation must retain the original text');
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
  for (const [node, text] of [[details[0], description], [details[1], hint]]) {
    assert.equal(node.textContent, text); assert.equal(node.title, text);
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

test('no matching skill offers a terminal command, while /skills still opens the AgentCenter menu action', async () => {
  const f = pickerFixture();
  f.input.textContent = '/mod'; f.caret(4); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  await new Promise(setImmediate);
  assert.deepEqual(f.calls.at(-1), { terminalCommand: '/mod' });
  assert.equal(f.input.textContent, ''); assert.equal(skills.selectedSkill(f.input), null);
  f.input.textContent = '/skills'; f.caret(7); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' }));
  await new Promise(setImmediate);
  assert.equal(f.calls.at(-1), 'open-menu');
  assert.equal(f.input.textContent, '');
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

test('AgentCenter action switches terminal before the existing send path and refuses running sessions', async () => {
  const calls = [], notify = (message, level) => calls.push({ message, level });
  const result = await skills.openSkillsMenu({ session, state: 'idle', openTerminal: async () => calls.push('terminal'),
    send: async text => { calls.push(text); return { ok: true }; }, notify });
  assert.equal(result.ok, true); assert.deepEqual(calls.slice(0, 2), ['terminal', '/skills']);
  assert.match(calls[2].message, /Add from AgentCenter/);
  calls.length = 0;
  const busy = await skills.openSkillsMenu({ session, state: 'running', openTerminal: () => calls.push('terminal'), send: () => calls.push('send'), notify });
  assert.equal(busy.ok, false); assert.equal(calls.length, 1); assert.match(calls[0].message, /等当前回答结束/);
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

test('typing the full /skills command takes precedence over incidental skill description matches', async () => {
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: [{ name: 'report', description: 'skills report' }] }) });
  f.input.textContent = '/skills'; f.caret(7); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); await new Promise(setImmediate);
  assert.equal(f.calls.at(-1), 'open-menu'); assert.equal(skills.selectedSkill(f.input), null); assert.equal(f.input.textContent, '');
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

test('search and footer stay outside a long scroll list; keyboard navigation reaches both fixed actions', async () => {
  const f = pickerFixture({ inventory: async () => ({ ok: true, skills: Array.from({ length: 50 }, (_, n) => ({ name: 'skill-' + String(n).padStart(2, '0'), description: 'test' })) }) });
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker'), list = popup.querySelector('.fi-skill-list');
  const footer = popup.querySelector('.fi-skill-footer'), search = popup.querySelector('.fi-skill-search');
  assert.equal(list.querySelectorAll('.fi-skill-option').length, 50);
  assert.equal(footer.parentNode, popup); assert.equal(search.parentNode, popup);
  assert.equal(list.contains(footer), false); assert.equal(list.contains(search), false);
  assert.equal(footer.children.length, 2);
  for (let n = 0; n < 50; n += 1) f.controller.onKeyDown(event('keydown', { key: 'ArrowDown' }));
  assert.equal(footer.querySelector('.fi-skill-commands').getAttribute('aria-selected'), 'true');
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.calls.at(-1), 'commands');
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'ArrowUp' }));
  assert.equal(footer.querySelector('.fi-skill-add').getAttribute('aria-selected'), 'true');
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.calls.at(-1), 'open-menu');
});

test('recent groups appear before alphabetic remaining skills and never show an uninstalled skill', async () => {
  const storage = memoryStorage();
  skills.recordSkillUse(storage, session, { name: 'zeta' }, { ok: true }, 1);
  skills.recordSkillUse(storage, session, { name: 'removed' }, { ok: true }, 2);
  const f = pickerFixture({ storage, inventory: async () => ({ ok: true, skills: [{ name: 'zeta' }, { name: 'beta' }, { name: 'alpha' }] }) });
  f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const list = f.document.body.querySelector('.fi-skill-list');
  assert.deepEqual(list.querySelectorAll('.fi-skill-group').map(node => node.textContent), ['最近使用', '全部技能']);
  assert.deepEqual(list.querySelectorAll('.fi-skill-option').map(node => node.textContent), ['/zeta', '/alpha', '/beta']);
  assert.doesNotMatch(list.textContent, /removed/);
});

test('search composition leaves filtering and navigation untouched until commit; focused footer actions follow keyboard selection', async () => {
  const f = pickerFixture(); f.controller.button.dispatchEvent(event('click')); await new Promise(setImmediate);
  const popup = f.document.body.querySelector('.fi-skill-picker'), search = popup.querySelector('.fi-skill-search');
  search.dispatchEvent(event('compositionstart')); search.value = 'no-match'; search.dispatchEvent(event('input'));
  const enter = event('keydown', { key: 'Enter' });
  assert.equal(f.controller.onKeyDown(enter), false); assert.equal(enter.prevented, undefined);
  assert.equal(popup.querySelectorAll('.fi-skill-option').length, 1);
  search.dispatchEvent(event('compositionend'));
  assert.equal(popup.querySelectorAll('.fi-skill-option').length, 0);
  popup.querySelector('.fi-skill-add').dispatchEvent(event('focus'));
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); assert.equal(f.calls.at(-1), 'open-menu');
});

test('slash Enter during inventory loading cannot accidentally execute a footer action', async () => {
  let resolve;
  const f = pickerFixture({ inventory: () => new Promise(done => { resolve = done; }) });
  f.input.textContent = '/unknown'; f.caret(8); f.input.dispatchEvent(event('input'));
  assert.equal(f.controller.onKeyDown(event('keydown', { key: 'Enter' })), true);
  assert.equal(f.calls.length, 1);
  resolve({ ok: true, skills: [] }); await new Promise(setImmediate);
  f.controller.onKeyDown(event('keydown', { key: 'Enter' })); await new Promise(setImmediate);
  assert.deepEqual(f.calls.at(-1), { terminalCommand: '/unknown' });
});

test('unmatched slash shows an explicit terminal action, including click and complete arguments', async () => {
  const f = pickerFixture();
  f.input.textContent = '/new-command arguments'; f.caret(5); f.input.dispatchEvent(event('input')); await new Promise(setImmediate);
  const list = f.document.body.querySelector('.fi-skill-list');
  assert.match(list.querySelector('.fi-skill-option').textContent, /^在终端执行 \/new-command$/);
  list.querySelector('.fi-skill-option').dispatchEvent(event('click')); await new Promise(setImmediate);
  assert.deepEqual(f.calls.at(-1), { terminalCommand: '/new-command arguments' });
  assert.equal(f.input.textContent, '');
});

test('command list action only invokes prefix typing after switching terminal, and never writes while busy', async () => {
  const calls = [];
  const options = { session, state: 'idle', openTerminal: async () => calls.push('terminal'),
    writePrefix: async () => { calls.push('prefix'); return { ok: true }; }, notify: message => calls.push(message) };
  assert.equal((await skills.openCommandList(options)).ok, true);
  assert.deepEqual(calls.slice(0, 2), ['terminal', 'prefix']);
  for (const state of ['starting', 'running', 'waiting']) {
    calls.length = 0;
    assert.equal((await skills.openCommandList({ ...options, state })).ok, false);
    assert.equal(calls.includes('prefix'), false); assert.equal(calls.includes('terminal'), false);
  }
  calls.length = 0;
  await skills.openCommandList({ ...options, writePrefix: async () => ({ ok: false, error: '输入行已有内容' }) });
  assert.match(calls.at(-1), /输入行已有内容/);
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

function inputGuardFixture({ text = '', status = 'running', failRead = false } = {}) {
  const api = require('../core/codeagent-input-guard'), current = { kind: 'codeagent', agentRuntime: 'pty', status };
  let clock = 1000, value = text, failed = failRead;
  const writes = [], diagnostics = [], delays = [], stopDiagnostics = [];
  const manager = { getSession: id => id === 'test' ? current : null,
    writeToSession: (_id, data) => { writes.push({ data, at: clock }); if (data === '\x15') value = ''; } };
  const guard = api.createCodeAgentInputGuard(manager, {
    now: () => clock, sleep: async ms => { delays.push(ms); clock += ms; }, diagnose: event => diagnostics.push(event),
    stopDiagnose: row => stopDiagnostics.push(row),
    openScreen: async () => { if (failed) throw new Error('sensitive screen failure'); return { lines: async () => [' │ > ' + (value || 'Anything I can assist you with?') + ' │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }; },
  });
  return { api, guard, current, manager, writes, delays, diagnostics, stopDiagnostics, setText: text => { value = text; }, fail: () => { failed = true; }, now: () => clock };
}

test('CodeAgent stop emits exactly two Esc at least 300ms apart and observes returned input for at most 3 seconds', async () => {
  const f = inputGuardFixture();
  const result = await f.guard.stop('test');
  assert.equal(result.ok, true); assert.equal(result.input, null);
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
  assert.ok(f.writes[1].at - f.writes[0].at >= 300);
  assert.equal(f.now(), 1000 + f.api.CODEAGENT_STOP_ESC_GAP_MS + 3000);
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
    openScreen: async () => ({ lines: () => [' │ > private prompt body │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }),
    stopDiagnose: row => { rows.push(row); recordCodeAgentStop({ ...row, text: 'private prompt body', error: 'private account' }, { dataDir: dir, maxBytes: 1200 }); },
  });
  return guard.stop('abcdefgh-private-session', { branch: 'existing', rendererState: 'running' }).then(() => {
    assert.equal(rows.at(-1).runtimeBecameNonRunning, true);
    assert.equal(rows.at(-1).inputState, 'nonempty');
    for (let i = 0; i < 25; i++) recordCodeAgentStop({ ...rows[0], text: 'private prompt body' }, { dataDir: dir, maxBytes: 1200 });
    const file = path.join(dir, 'logs', 'codeagent-stop.log');
    assert.ok(fs.existsSync(file + '.1')); assert.ok(fs.statSync(file).size <= 1200); assert.ok(fs.statSync(file + '.1').size <= 1200);
    for (const target of [file, file + '.1']) {
      const text = fs.readFileSync(target, 'utf8');
      assert.doesNotMatch(text, /private|prompt body|account/); assert.equal(JSON.parse(text.trim().split('\n')[0]).sessionId, 'abcdefgh');
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
  assert.equal(f.writes.at(-1).data, '\x1b', 'first Esc is synchronous, before the blocked sender resolves');
  if (phase === 'paste') assert.equal(f.writes[before].data, '\x1b[201~', 'close the interrupted paste before Esc');
  f.release();
  const stopped = await sending;
  assert.equal(stopped.stopped, true); assert.equal(stopped.sendStatus, 'stopped');
  assert.equal(stopped.notSent, phase === 'paste'); assert.equal(stopped.enterAttempts, phase === 'paste' ? 0 : 1);
  const next = f.sender.sendToPty('test', 'next ordinary prompt', 'codeagent', { requireReady: true });
  assert.equal((await stopping).ok, true);
  assert.equal((await next).ok, true);
  assert.deepEqual(f.writes.slice(before).filter(row => row.data === '\x1b').map(row => row.data), ['\x1b', '\x1b']);
  assert.equal(f.writes.filter(row => row.data === '\r').length, phase === 'paste' ? 1 : 2, 'no recovery Enter from the stopped send');
  assert.equal(f.stopDiagnostics[0].queuePending, true); assert.equal(f.stopDiagnostics[0].queueWaitMs, 0);
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
  assert.equal(f.writes[0].data, '\x1b');
  const stopped = await sending;
  assert.equal(stopped.stopped, true); assert.equal(stopped.notSent, true);
  f.release(); await stopping;
  assert.deepEqual(f.writes.map(row => row.data), ['\x1b', '\x1b']);
});

test('an unreadable post-stop input is logged as unknown without logging the failure text', async () => {
  const f = inputGuardFixture({ failRead: true });
  const result = await f.guard.stop('test');
  assert.equal(result.ok, true); assert.equal(result.readFailed, true);
  assert.equal(f.stopDiagnostics.at(-1).inputState, 'unknown');
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
    assert.equal(f.writes.at(-1).data, '\x1b'); f.release();
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
    openScreen: async () => ({ lines: () => [' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │'], dispose() {} }),
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

test('residual check blocks without writes; discard uses Ctrl+U and rechecks; a changed residual is never erased', async () => {
  const f = inputGuardFixture({ text: 'old request' });
  const blocked = await f.guard.check('test');
  assert.equal(blocked.code, 'codeagent-input-residual'); assert.equal(blocked.notSent, true); assert.deepEqual(f.writes, []);
  f.setText('different request');
  assert.equal((await f.guard.clear('test', blocked.input.token)).ok, false); assert.deepEqual(f.writes, []);
  const latest = await f.guard.inspect('test');
  assert.equal((await f.guard.check('test', { discardToken: latest.input.token })).ok, true);
  assert.deepEqual(f.writes.map(row => row.data), ['\x15']);
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

function recoveryFixture({ draft = '', replace = true, running = true } = {}) {
  const f = dom(), calls = [], notices = [];
  let value = draft, latest = { ok: false, input: { token: 'token', text: 'previous original', incomplete: false } };
  const controller = require('../renderer/composer-codeagent-input').createCodeAgentInputRecovery({
    document: f.document, host: f.document.body, readDraft: () => value,
    restoreDraft: input => { calls.push(['restore', input]); value = input.text; }, notify: (...args) => notices.push(args),
    isRunning: () => running, confirmReplace: async () => { calls.push(['confirm']); return replace; },
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

test('stop auto-recovers an empty Hub draft before Ctrl+U; idle click sends nothing', async () => {
  const f = recoveryFixture(); await f.controller.stop();
  assert.equal(f.draft(), 'previous original');
  assert.deepEqual(f.calls.map(row => row[0]), ['codeagent:input-stop', 'restore', 'codeagent:input-clear']);
  const idle = recoveryFixture({ running: false }); await idle.controller.stop();
  assert.deepEqual(idle.calls, []); assert.equal(idle.notices[0][0], '回答已结束');
});

test('stop keeps an existing draft and terminal editor untouched until the user chooses', async () => {
  const f = recoveryFixture({ draft: 'new draft', replace: false }); await f.controller.stop();
  assert.equal(f.draft(), 'new draft'); assert.equal(f.controller.panel.hidden, false);
  assert.equal(f.calls.some(row => row[0] === 'codeagent:input-clear'), false);
  await f.controller.takeBack(f.latest);
  assert.equal(f.draft(), 'new draft'); assert.equal(f.calls.some(row => row[0] === 'codeagent:input-clear'), false);
  const yes = recoveryFixture({ draft: 'new draft' }); await yes.controller.takeBack(yes.latest);
  assert.equal(yes.draft(), 'previous original'); assert.equal(yes.calls.at(-1)[0], 'codeagent:input-clear');
});

test('incomplete recovery says so; discard delegates once with the original residual token', async () => {
  const f = recoveryFixture(); f.latest.input.incomplete = true;
  await f.controller.takeBack(f.latest); assert.match(f.notices.at(-1)[0], /可能不完整/);
  const tokens = []; f.controller.show(f.latest, async token => tokens.push(token));
  f.controller.panel.children[2].dispatchEvent(event('click')); await new Promise(setImmediate);
  assert.deepEqual(tokens, ['token']);
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
  Object.assign(f.manager, { getGroupChatReady: () => true, getGroupChatLastActivity: () => 1,
    getSessionBuffer: () => '❯ \n? for shortcuts', getSessionOutputMark: () => 0, getNativeClaude: () => null });
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    require: name => name === './pty-prompt-submit.js' ? { ...localRequire(name), waitForPasteSettled: async () => {} } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + `\nobserveAgentTurnStart = () => ({ dispose() {} });\nwaitForAgentWorkStart = async () => 'hook';`, context);
  const sender = context.module.exports; sender.init({ sessionManager: f.manager });
  for (const [text, interactive] of [['ordinary', false], ['/test-skill body', false], ['/unknown', true]]) {
    const result = await sender.sendToPty('test', text, 'codeagent', { requireReady: true, codeagentInteractiveCommand: interactive });
    assert.equal(result.code, 'codeagent-input-residual'); assert.deepEqual(f.writes, []);
  }
  f.current.kind = 'claude';
  await sender.sendToPty('test', 'ordinary', 'claude', { requireReady: true });
  assert.equal(f.writes.filter(data => data === '\r').length, 1);
  f.current.kind = 'codeagent'; f.writes.length = 0;
  f.setFrame([' │ > Anything I can assist you with? │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  await sender.sendToPty('test', '/test-skill augmented prompt', 'codeagent', { requireReady: true, originalPrompt: '/test-skill original prompt', codeagentSkill: { name: 'test-skill' } });
  f.setFrame([' │ > [Pasted text +20 lines] │', ' │ Bypass (Cycle shift+tab) | GLM │']);
  await sender.sendToPty('test', '/test-skill newer unsent prompt', 'codeagent', { requireReady: true });
  const saved = await sender.codeAgentInputAction('test', 'inspect');
  assert.equal(saved.input.text, '/test-skill original prompt'); assert.equal(saved.input.skill.name, 'test-skill');
  f.manager.getSessionBufferSnapshot = async () => { throw new Error('private account detail must not be logged'); };
  f.writes.length = 0;
  const unreadable = await sender.sendToPty('test', '/unknown', 'codeagent', { requireReady: true, codeagentInteractiveCommand: true });
  assert.equal(unreadable.ok, true); assert.equal(unreadable.enterAttempts, 1);
  assert.equal(f.writes.filter(data => data === '\r').length, 1);
  const diagnostic = fs.readFileSync(path.join(process.env.CLAUDE_HUB_DATA_DIR, 'logs', 'codeagent-input.log'), 'utf8');
  assert.match(diagnostic, /input-read-failed/); assert.doesNotMatch(diagnostic, /private|account|unknown|prompt/);
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

test('real prompt IPC rejects residual before receipts/journal and discards with the same submission id', async t => {
  const { EventEmitter } = require('node:events'), { createRequire } = require('node:module'), vm = require('node:vm');
  const file = path.join(__dirname, '..', 'main', 'ipc', 'prompt-submit-handlers.js'), localRequire = createRequire(file);
  const handlers = new Map(), writes = [], journals = [], updates = [];
  const s = { kind: 'codeagent', agentRuntime: 'pty' }, manager = new EventEmitter(); manager.getSession = () => s;
  let residual = true;
  const context = vm.createContext({ module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    require: name => name === '../../core/group-chat-watcher.js' ? {
      codeAgentInputAction: async (_sid, _action, options) => { if (options.discardToken) { writes.push('\x15'); residual = false; } return residual ? { ok: false, notSent: true, code: 'codeagent-input-residual', input: { token: 'token', text: 'old' } } : { ok: true }; },
      sendToPty: async (...args) => { writes.push(args); return { ok: true, enterAttempts: 1 }; },
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const registration = context.module.exports.registerPromptSubmitIpc({ handle: (name, fn) => handlers.set(name, fn) }, { sessionManager: manager, sendToRenderer: (...args) => updates.push(args), commandTranscriptStore: { begin: (...args) => { journals.push(args); return { duplicate: false }; }, finish() {} } });
  t.after(() => registration.dispose());
  for (const text of ['ordinary', '/test-skill body', '/unknown']) {
    residual = true; const request = { sessionId: 'test', text, clientSubmissionId: 'test-' + text, codeagentInteractiveCommand: text === '/unknown' };
    const at = writes.length, journalAt = journals.length, updatesAt = updates.length;
    const blocked = await handlers.get('session:send-prompt')(null, request);
    assert.equal(blocked.code, 'codeagent-input-residual'); assert.equal(writes.length, at); assert.equal(journals.length, journalAt); assert.equal(updates.length, updatesAt);
    const result = await handlers.get('session:send-prompt')(null, { ...request, codeagentDiscardToken: blocked.input.token });
    assert.equal(result.ok, true); assert.equal(writes[at], '\x15');
    assert.equal(writes.at(-1)[3].clientSubmissionId, request.clientSubmissionId); assert.equal(writes.at(-1)[3].codeagentInteractiveCommand, request.codeagentInteractiveCommand);
    assert.equal(result.enterAttempts, 1);
  }
});
