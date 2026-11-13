'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { attachSidebarFolderDrag, DRAG_TYPE } = require('../renderer/sidebar-folder-drag');

function classes() { const set = new Set(); return { add: n => set.add(n), remove: n => set.delete(n), has: n => set.has(n) }; }
// 假节点：closest 只认本测试用到的三种选择器。
function node(kind, dataset = {}) {
  return { dataset, classList: classes(), closest: selector => ({ '.session-item': 'row', '.sidebar-folder': 'folder', '[data-folder-create]': 'create' })[selector] === kind ? self(kind, dataset) : null };
  function self() { return cache.get(dataset) || (cache.set(dataset, { dataset, classList: classes() }), cache.get(dataset)); }
}
const cache = new Map();
function setup({ assignments = {}, error = '', created = null } = {}) {
  const listeners = new Map(), calls = [], notices = [];
  const state = { version: 1, folders: [{ id: 'folder-a', name: '甲' }, { id: 'folder-b', name: '乙' }], assignments: { ...assignments } };
  const listEl = { classList: classes(), contains: () => true, addEventListener: (name, fn) => listeners.set(name, fn) };
  const sidebarFolders = {
    error: () => error, getState: () => state,
    assign: async (key, folderId) => { calls.push(['assign', key, folderId]); if (folderId === 'folder-broken') throw new Error('目录不存在'); },
    showCreate: async () => { calls.push(['create']); if (created) state.folders.push({ id: created, name: '新目录' }); },
  };
  attachSidebarFolderDrag({ listEl, sidebarFolders, notify: m => notices.push(m),
    folderEntityKey: id => id === 'member' ? null : (id.startsWith('m-') ? 'meeting:' : 'session:') + id });
  const fire = (name, target, extra = {}) => {
    const event = { target, prevented: false, preventDefault() { this.prevented = true; }, dataTransfer: { data: {}, setData(type, value) { this.data[type] = value; } }, ...extra };
    listeners.get(name)(event); return event;
  };
  return { fire, calls, notices, listEl, state };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('dragging a session row onto another folder moves it there, same path as the context menu', async () => {
  const { fire, calls, listEl } = setup({ assignments: { 'session:s1': 'folder-a' } });
  const start = fire('dragstart', node('row', { sessionId: 's1' }));
  assert.equal(start.prevented, false);
  assert.equal(start.dataTransfer.data[DRAG_TYPE], 'session:s1');
  assert.equal(listEl.classList.has('folder-dragging'), true);
  const folder = node('folder', { sidebarFolder: 'folder-b' });
  const over = fire('dragover', folder);
  assert.equal(over.prevented, true);
  assert.equal(folder.closest('.sidebar-folder').classList.has('drop-target'), true);
  fire('drop', folder); await settle();
  assert.deepEqual(calls, [['assign', 'session:s1', 'folder-b']]);
  assert.equal(folder.closest('.sidebar-folder').classList.has('drop-target'), false);
  assert.equal(listEl.classList.has('folder-dragging'), false);
});

test('group rows move too; dropping on 未分类 clears the folder; the current folder is not a target', async () => {
  const { fire, calls } = setup({ assignments: { 'meeting:m-1': 'folder-a' } });
  fire('dragstart', node('row', { meetingId: 'm-1' }));
  assert.equal(fire('dragover', node('folder', { sidebarFolder: 'folder-a' })).prevented, false);
  fire('drop', node('folder', { sidebarFolder: 'folder-a' })); await settle();
  assert.deepEqual(calls, []);
  fire('dragstart', node('row', { meetingId: 'm-1' }));
  fire('drop', node('folder', { sidebarFolder: 'unclassified' })); await settle();
  assert.deepEqual(calls, [['assign', 'meeting:m-1', null]]);
});

test('members, broken folder data and unrelated drags are left alone', async () => {
  const members = setup();
  assert.equal(members.fire('dragstart', node('row', { sessionId: 'member' })).prevented, true);
  assert.equal(members.fire('dragover', node('folder', { sidebarFolder: 'folder-a' })).prevented, false);
  members.fire('drop', node('folder', { sidebarFolder: 'folder-a' })); await settle();
  assert.deepEqual(members.calls, []);
  const broken = setup({ error: '目录数据损坏' });
  assert.equal(broken.fire('dragstart', node('row', { sessionId: 's1' })).prevented, true);
});

test('dropping on 新建目录 creates a folder and puts the session in it; cancelling the name leaves it where it was', async () => {
  const made = setup({ created: 'folder-new' });
  made.fire('dragstart', node('row', { sessionId: 's1' }));
  assert.equal(made.fire('dragover', node('create')).prevented, true);
  made.fire('drop', node('create')); await settle();
  assert.deepEqual(made.calls, [['create'], ['assign', 's1'.replace(/^/, 'session:'), 'folder-new']]);
  const cancelled = setup();
  cancelled.fire('dragstart', node('row', { sessionId: 's1' }));
  cancelled.fire('drop', node('create')); await settle();
  assert.deepEqual(cancelled.calls, [['create']]);
});

test('a failed save is shown to the user and a drag that ends elsewhere cleans up', async () => {
  const { fire, notices, listEl } = setup();
  fire('dragstart', node('row', { sessionId: 's1' }));
  fire('drop', node('folder', { sidebarFolder: 'folder-broken' })); await settle();
  assert.deepEqual(notices, ['目录不存在']);
  fire('dragstart', node('row', { sessionId: 's1' }));
  fire('dragend', node('row', { sessionId: 's1' }));
  assert.equal(listEl.classList.has('folder-dragging'), false);
  assert.equal(fire('dragover', node('folder', { sidebarFolder: 'folder-a' })).prevented, false);
});
