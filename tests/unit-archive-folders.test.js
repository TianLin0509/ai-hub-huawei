'use strict';
// Archive keeps the original folder: grouping, deleted-folder memory, restore cleanup, survival across reload.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createSidebarFolderStore } = require('../core/sidebar-folders');
const { groupArchiveHits } = require('../renderer/global-session-search');
const { createSidebarFoldersController } = require('../renderer/sidebar-folders');

function tempDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-folders-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('deleting a folder remembers its name only for archived entries; reassign or forget clears it; survives reload', async t => {
  const dataDir = tempDir(t), store = createSidebarFolderStore({ dataDir });
  const id = (await store.create('接口项目')).folders[0].id;
  await store.assign('session:archived-1', id); await store.assign('session:active-1', id); await store.assign('meeting:archived-2', id);
  let state = await store.remove(id, ['session:archived-1', 'meeting:archived-2', 'session:unrelated']);
  assert.deepEqual(state.assignments, {});
  assert.deepEqual(Object.keys(state.removed).sort(), ['meeting:archived-2', 'session:archived-1']);
  assert.equal(state.removed['session:archived-1'].name, '接口项目');
  state = await createSidebarFolderStore({ dataDir }).list();
  assert.equal(state.removed['meeting:archived-2'].name, '接口项目', 'record survives restart');
  const other = (await store.create('新目录')).folders[0].id;
  state = await store.assign('meeting:archived-2', other);
  assert.equal(state.removed['meeting:archived-2'], undefined, 'moving to a folder drops the old-folder memory');
  state = await store.forget(['session:archived-1']);
  assert.deepEqual(state.removed, {});
});

test('old data without removed records stays valid; a bad removed record is rejected without touching disk', async t => {
  const dataDir = tempDir(t), file = path.join(dataDir, 'sidebar-folders.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, folders: [], assignments: {} }));
  assert.deepEqual(await createSidebarFolderStore({ dataDir }).list(), { version: 1, folders: [], assignments: {} });
  fs.writeFileSync(file, JSON.stringify({ version: 1, folders: [], assignments: {}, removed: { 'session:x': { name: '' } } }));
  await assert.rejects(createSidebarFolderStore({ dataDir }).list(), /原目录记录/);
});

test('archive hits group by live folder order, then deleted folders, then unclassified; empty groups never appear', () => {
  const origins = {
    'session:a': { id: 'folder-b', name: '乙', deleted: false },
    'session:b': { id: 'folder-a', name: '甲', deleted: false },
    'session:c': { id: null, name: '旧目录', deleted: true },
    'session:d': { id: null, name: '未分类', deleted: false },
    'session:e': { id: 'folder-b', name: '乙', deleted: false },
  };
  const hits = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ hubSessionId: id }));
  const groups = groupArchiveHits(hits, {
    folderKeyOf: hit => hit.hubSessionId === 'f' ? null : 'session:' + hit.hubSessionId,
    originOf: key => origins[key],
    folderOrder: ['folder-a', 'folder-b', 'folder-empty'],
  });
  assert.deepEqual(groups.map(g => [g.name, g.deleted, g.hits.map(h => h.hubSessionId).join('')]),
    [['甲', false, 'b'], ['乙', false, 'ae'], ['旧目录', true, 'c'], ['未分类', false, 'df']]);
});

test('renderer controller reports live folder, remembered deleted folder, or unclassified', () => {
  const listeners = new Map();
  const controller = createSidebarFoldersController({ document: {}, storage: { getItem: () => null, setItem() {} },
    ipcRenderer: { invoke: async () => ({ ok: true }), on: (name, fn) => listeners.set(name, fn) } });
  listeners.get('sidebar-folders:changed')(null, { state: { version: 1, folders: [{ id: 'folder-x', name: '项目' }],
    assignments: { 'session:a': 'folder-x' }, removed: { 'session:b': { name: '旧目录', at: 1 } } } });
  assert.deepEqual(controller.originOf('session:a'), { id: 'folder-x', name: '项目', deleted: false });
  assert.deepEqual(controller.originOf('session:b'), { id: null, name: '旧目录', deleted: true });
  assert.deepEqual(controller.originOf('session:c'), { id: null, name: '未分类', deleted: false });
  assert.equal(controller.removedOrigin('session:b'), '旧目录');
});
