'use strict';
// 一键反馈里点名要的三件小事：回车键行为、启动中心记住上次目录、历史会议改名。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enterKey = require('../renderer/composer-enter-key');
const lastWorkspace = require('../renderer/launch-last-workspace');
const { MeetingCompanion } = require('../core/company-assistant/meeting');

function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}
const key = (extra = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, ...extra });

test('默认：回车发送，Shift+回车换行，老用户行为不变', () => {
  const storage = memoryStorage();
  const mode = enterKey.readMode(storage);
  assert.equal(mode, 'send');
  assert.equal(enterKey.isSendKey(key(), mode), true);
  assert.equal(enterKey.isSendKey(key({ shiftKey: true }), mode), false);
  assert.equal(enterKey.isNewlineKey(key(), mode), false);
  assert.match(enterKey.placeholderFor(mode), /Enter 发送，Shift\+Enter 换行/);
});

test('改成回车换行后：回车只换行，Ctrl+回车才发送', () => {
  const storage = memoryStorage();
  enterKey.writeMode(storage, 'newline');
  const mode = enterKey.readMode(storage);
  assert.equal(mode, 'newline');
  assert.equal(enterKey.isSendKey(key(), mode), false);
  assert.equal(enterKey.isNewlineKey(key(), mode), true);
  assert.equal(enterKey.isSendKey(key({ ctrlKey: true }), mode), true);
  assert.equal(enterKey.isNewlineKey(key({ ctrlKey: true }), mode), false);
  assert.equal(enterKey.isNewlineKey(key({ shiftKey: true }), mode), false, 'Shift+回车交给浏览器默认换行');
  assert.match(enterKey.placeholderFor(mode), /Enter 换行，Ctrl\+Enter 发送/);
});

test('存储坏了或值不认识时退回默认', () => {
  assert.equal(enterKey.readMode({ getItem: () => { throw new Error('denied'); } }), 'send');
  assert.equal(enterKey.readMode({ getItem: () => 'whatever' }), 'send');
  assert.equal(enterKey.readMode(null), 'send');
});

test('启动中心记住上次目录：已有目录记路径，默认目录不算记忆，写坏了当没记过', () => {
  const storage = memoryStorage();
  assert.equal(lastWorkspace.recall(storage), null);
  lastWorkspace.remember(storage, { mode: 'existing', workspace: { path: 'D:/work/a', name: 'a', extra: 1 } });
  assert.deepEqual(lastWorkspace.recall(storage), { mode: 'existing', workspace: { path: 'D:/work/a', name: 'a' } });
  lastWorkspace.remember(storage, { mode: 'scratch', workspace: { path: 'D:/tmp/x' } });
  assert.deepEqual(lastWorkspace.recall(storage), { mode: 'scratch' });
  lastWorkspace.remember(storage, { mode: 'default', workspace: { path: 'C:/Users/x/Workspaces/y' } });
  assert.equal(lastWorkspace.recall(storage), null, '用默认目录时下次还是默认目录');
  storage.setItem(lastWorkspace.STORAGE_KEY, '{ not json');
  assert.equal(lastWorkspace.recall(storage), null);
  lastWorkspace.remember(storage, { mode: 'existing', workspace: { path: 'D:/work/a' } });
  lastWorkspace.forget(storage);
  assert.equal(lastWorkspace.recall(storage), null);
});

test('历史会议可以改名：名字存盘，内容不变，空名字报错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-rename-'));
  try {
    const companion = new MeetingCompanion({ dir: root, workspace: root, changed() {}, sessionBusy: () => false, lastFinal: () => '' }, { dataDir: root, now: () => 1000 });
    const created = companion.create({ title: '旧名字', sourceName: 'PowerPoint' });
    const before = companion.load(created.id);
    companion.rename(created.id, '  SRS 周期\n评审  ');
    const after = companion.load(created.id);
    assert.equal(after.title, 'SRS 周期 评审');
    assert.deepEqual({ ...after, title: '' }, { ...before, title: '' });
    assert.equal(companion.list().find(x => x.id === created.id).title, 'SRS 周期 评审');
    assert.throws(() => companion.rename(created.id, '   '), /不能为空/);
    assert.equal(companion.load(created.id).title, 'SRS 周期 评审');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
