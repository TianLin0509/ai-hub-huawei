'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function fixture(t, options = {}) {
  const { createSidebarFolderStore } = require('../core/sidebar-folders');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-folders-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createSidebarFolderStore({ dataDir, ...options }), createSidebarFolderStore };
}
test('missing data means unclassified; folders and assignments survive reload, rename and deletion', async t => {
  const { dataDir, store, createSidebarFolderStore } = fixture(t);
  assert.deepEqual(await store.list(), { version: 1, folders: [], assignments: {} });
  let state = await store.create('  接口项目  '), id = state.folders[0].id;
  assert.equal(state.folders[0].name, '接口项目');
  await store.assign('session:lead-0001', id); await store.assign('meeting:group-0001', id);
  state = await createSidebarFolderStore({ dataDir }).rename(id, '已确认');
  assert.equal(state.folders[0].name, '已确认'); assert.equal(state.assignments['session:lead-0001'], id);
  state = await store.assign('session:lead-0001', null); assert.equal(state.assignments['session:lead-0001'], undefined);
  state = await store.remove(id); assert.deepEqual(state.folders, []); assert.deepEqual(state.assignments, {});
  assert.deepEqual(await createSidebarFolderStore({ dataDir }).list(), state);
});
test('separate instances serialize edits against newest disk data instead of overwriting unrelated folders', async t => {
  const { store, dataDir, createSidebarFolderStore } = fixture(t);
  const second = createSidebarFolderStore({ dataDir });
  const results = await Promise.all([store.create('甲'), second.create('乙')]);
  const state = await store.list(); assert.deepEqual(state.folders.map(f => f.name).sort(), ['乙', '甲']);
  const idA = results[0].folders.find(f => f.name === '甲').id, idB = state.folders.find(f => f.name === '乙').id;
  await Promise.all([store.assign('session:session-a', idA), second.assign('meeting:meeting-b', idB)]);
  assert.deepEqual((await second.list()).assignments, { 'session:session-a': idA, 'meeting:meeting-b': idB });
});
test('invalid names, invalid keys, unknown folders and built-in unclassified mutations cannot change disk', async t => {
  const { store, dataDir } = fixture(t);
  const state = await store.create('项目'), file = path.join(dataDir, 'sidebar-folders.json'), before = fs.readFileSync(file, 'utf8');
  for (const name of ['', '  ', 'x'.repeat(41), '项目', '未分类']) await assert.rejects(store.create(name));
  for (const key of ['__proto__', 'team:lead-0001', 'session:../outside', 'session:']) await assert.rejects(store.assign(key, state.folders[0].id));
  await assert.rejects(store.assign('session:session-a', 'unknown'));
  await assert.rejects(store.rename(null, '默认')); await assert.rejects(store.remove(null));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('corrupt or unsupported snapshots are never silently replaced by a mutation', async t => {
  const { store, dataDir } = fixture(t), file = path.join(dataDir, 'sidebar-folders.json');
  for (const contents of ['{broken', '{"version":99,"folders":[],"assignments":{}}', '{"version":1,"folders":{},"assignments":{}}']) {
    fs.writeFileSync(file, contents);
    await assert.rejects(store.list(), /目录数据/);
    await assert.rejects(store.create('安全项目'), /目录数据/);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
});
test('failed atomic replacement preserves previous snapshot and removes temporary files', async t => {
  const { store, dataDir, createSidebarFolderStore } = fixture(t);
  const old = await store.create('原有目录');
  const brokenFs = Object.create(fs); brokenFs.renameSync = () => { throw Object.assign(new Error('disk blocked'), { code: 'EIO' }); };
  await assert.rejects(createSidebarFolderStore({ dataDir, fsModule: brokenFs }).create('失败目录'), /disk blocked/);
  assert.deepEqual(await store.list(), old);
  assert.deepEqual(fs.readdirSync(dataDir), ['sidebar-folders.json']);
});
test('IPC validates entity existence and returns only durable snapshots; errors remain actionable', async t => {
  const { store } = fixture(t), handlers = new Map(), published = [];
  const { registerSidebarFoldersIpc } = require('../main/ipc/sidebar-folders-handlers');
  registerSidebarFoldersIpc({ handle: (name, fn) => handlers.set(name, fn) }, { store, entityExists: key => key === 'session:lead-0001', publish: state => published.push(state) });
  const invoke = (action, payload) => handlers.get('sidebar-folders:' + action)(null, payload);
  const created = await invoke('create', { name: '团队' }); assert.equal(created.ok, true);
  const id = created.state.folders[0].id;
  const rejected = await invoke('assign', { key: 'session:missing', folderId: id });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /不存在/); assert.equal(published.length, 1);
  const moved = await invoke('assign', { key: 'session:lead-0001', folderId: id }); assert.equal(moved.state.assignments['session:lead-0001'], id);
  assert.equal((await invoke('list')).ok, true);
});
