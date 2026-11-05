'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createSessionListRenderer, sessionFamilies, getSidebarSearchEntries } = require('../renderer/session-list-renderer');
function treeHtml(el) { return [el.innerHTML || '', ...(el.children || []).map(treeHtml)].join('\n'); }
// Minimal DOM fixture for the real sidebar renderer and team UI.
function makeEl() {
  const el = {
    children: [],
    _attrs: {},
    setAttribute(name, value) { this._attrs[name] = String(value); },
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html || ''; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
    setProperty() {},
  };
  el.style.setProperty = () => {};
  return el;
}
function mockDoc() {
  return {
    createElement: () => makeEl(),
    getElementById: () => null,
    head: makeEl(),
    documentElement: makeEl(),
  };
}
function pctClass(pct) {
  if (pct >= 80) return 'danger';
  if (pct >= 50) return 'warn';
  return 'ok';
}
function makeRenderer({ sessions, meetings, activeMeetingId = null, extraOptions = {} }) {
  const sessionListEl = makeEl();
  const document = mockDoc();
  const r = createSessionListRenderer({
    document,
    localStorage: { getItem: () => '[]', setItem: () => {} },
    sessionListEl,
    getSessions: () => sessions,
    getMeetings: () => meetings,
    getActiveSessionId: () => null,
    getActiveMeetingId: () => activeMeetingId,
    isAiKind: (k) => ['codeagent'].includes(k),
    modelShort: (m) => m && m.displayName || '',
    modelClass: () => 'codeagent',
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])),
    formatTime: () => '00:00',
    pctClass,
    sessionBurnRate: () => null,
    selectSession: () => {},
    selectMeeting: () => {},
    openContextMenu: () => {},
    ...extraOptions,
  });
  return { ...r, sessionListEl, document };
}

function setup(t, { meetingMode = '', modelFilter = 'all', storage = new Map() } = {}) {
  const previousWindow = global.window;
  const window = {};
  const listeners = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/team-ui.js'), 'utf8'), {
    window, document: { addEventListener() {} }, console,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    require: () => ({ ipcRenderer: { on: (name, fn) => { listeners[name] = fn; }, invoke: async () => ({ ok: false }) } }),
  });
  global.window = window;
  t.after(() => { global.window = previousWindow; });
  const now = Date.now();
  const lead = { id: 'lead-0001', kind: 'codeagent', title: '负责人', status: 'idle', lastMessageTime: now };
  if (meetingMode === 'meetingId') lead.meetingId = 'group-1';
  const member = { id: 'member-1xx', kind: 'codeagent', title: '成员旧标题', status: 'idle', lastMessageTime: now };
  const sessions = new Map([[lead.id, lead], [member.id, member]]);
  const meetings = meetingMode === 'subSessions' ? { 'group-1': { id: 'group-1', title: '群聊', subSessions: [lead.id], status: 'idle', groupChat: true, lastMessageTime: now } } : {};
  listeners['team:changed'](null, { leadSid: lead.id, team: { leadSid: lead.id, members: [{ sid: member.id, memberId: 'm1', status: 'active' }], plans: [] } });
  const renderer = makeRenderer({ sessions, meetings, extraOptions: {
    localStorage: { getItem: key => key === 'hubSidebarModelFilter' ? modelFilter : '[]', setItem() {} },
  } });
  return { ...renderer, lead, member, sessions, meetings, teamUi: window.__teamUi, listeners, storage };
}
function row(root, id) {
  if (root.dataset?.sessionId === id) return root;
  for (const child of root.children || []) { const found = row(child, id); if (found) return found; }
  return null;
}

test('F2: unchanged team keeps DOM; member-only status, title, unread and removal invalidate presentation', t => {
  const h = setup(t);
  h.renderSessionList();
  const first = row(h.sessionListEl, h.member.id); assert.ok(first);
  h.renderSessionList(); assert.equal(row(h.sessionListEl, h.member.id), first);
  h.member.status = 'running'; h.member.runStartedAt = Date.now();
  h.renderSessionList();
  const running = row(h.sessionListEl, h.member.id);
  assert.notEqual(running, first); assert.match(running._attrs['aria-label'], /工作中/);
  h.member.title = '成员更新标题'; h.member.userRenamed = true;
  h.renderSessionList(); assert.match(treeHtml(h.sessionListEl), /成员更新标题/);
  const titled = row(h.sessionListEl, h.member.id);
  h.member.unreadCount = 2;
  h.renderSessionList(); assert.notEqual(row(h.sessionListEl, h.member.id), titled);
  h.sessions.delete(h.member.id);
  h.renderSessionList(); assert.equal(row(h.sessionListEl, h.member.id), null);
  h.sessions.set(h.member.id, h.member);
  h.renderSessionList(); assert.ok(row(h.sessionListEl, h.member.id));
});

test('F3: CodeAgent filter retains parent and its matching member', t => {
  const h = setup(t, { modelFilter: 'codeagent' });
  assert.deepEqual([...sessionFamilies(h.lead, h.sessions)].sort(), ['codeagent']);
  h.renderSessionList();
  assert.ok(row(h.sessionListEl, h.lead.id)); assert.ok(row(h.sessionListEl, h.member.id));
});

for (const meetingMode of ['meetingId', 'subSessions']) test(`F4: group lead identified by ${meetingMode} leaves team members accessible at top level`, t => {
  const h = setup(t, { meetingMode });
  assert.equal(h.teamUi.memberIdSet(h.sessions, h.meetings).has(h.member.id), false);
  h.renderSessionList();
  assert.ok(h.sessionListEl.children.find(el => el.dataset.sessionId === h.member.id));
  assert.equal(h.sessionListEl.children.some(el => el.className?.includes('team-group')), false);
});

test('F4: closing a standalone lead returns its member to the top level', t => {
  const h = setup(t); h.renderSessionList();
  h.sessions.delete(h.lead.id); h.renderSessionList();
  assert.ok(h.sessionListEl.children.find(el => el.dataset.sessionId === h.member.id));
});

test('team collapse hides only member rows, survives updates and renderer reload, and search reveals a member', t => {
  const h = setup(t);
  h.member.status = 'running';
  h.renderSessionList();
  assert.ok(row(h.sessionListEl, h.member.id));
  const expanded = h.teamUi.signature(h.lead.id, h.sessions, h.meetings);
  h.teamUi.setCollapsed(h.lead.id, true);
  h.renderSessionList();
  assert.ok(row(h.sessionListEl, h.lead.id));
  assert.equal(row(h.sessionListEl, h.member.id), null);
  assert.equal(h.member.status, 'running');
  assert.equal(getSidebarSearchEntries(h.document).filter(s => s.id === h.member.id).length, 1);
  assert.notEqual(h.teamUi.signature(h.lead.id, h.sessions, h.meetings), expanded);
  h.listeners['team:changed'](null, { leadSid: h.lead.id, team: { leadSid: h.lead.id,
    members: [{ sid: h.member.id, memberId: 'm1', status: 'active' }], plans: [] } });
  h.renderSessionList();
  assert.equal(row(h.sessionListEl, h.member.id), null);
  const reloaded = setup(t, { storage: h.storage, modelFilter: 'codeagent' });
  reloaded.renderSessionList();
  assert.equal(row(reloaded.sessionListEl, reloaded.member.id), null);
  reloaded.revealSearchItem(reloaded.member.id, reloaded.member.id);
  assert.equal(reloaded.teamUi.isCollapsed(reloaded.lead.id), false);
  assert.ok(row(reloaded.sessionListEl, reloaded.member.id));
});

test('collapse preferences are per team and keep approval and fallback rows accessible', t => {
  const h = setup(t);
  h.teamUi.setCollapsed(h.lead.id, true);
  assert.equal(h.teamUi.isCollapsed('another-lead'), false);
  h.listeners['team:changed'](null, { leadSid: h.lead.id, team: { leadSid: h.lead.id,
    members: [{ sid: h.member.id, memberId: 'm1', status: 'active' }],
    plans: [{ status: 'pending', members: [{}] }] } });
  assert.match(h.teamUi.rowTagHtml(h.lead.id, h.sessions, h.meetings), /data-team-approve/);
  assert.match(h.teamUi.rowTagHtml(h.lead.id, h.sessions, h.meetings), /aria-expanded="false"/);
  h.lead.meetingId = 'meeting';
  assert.doesNotMatch(h.teamUi.rowTagHtml(h.lead.id, h.sessions, h.meetings), /data-team-toggle/);
  h.renderSessionList();
  assert.ok(h.sessionListEl.children.find(el => el.dataset.sessionId === h.member.id));
});
