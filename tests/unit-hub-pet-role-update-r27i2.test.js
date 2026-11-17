'use strict';
// r27i2：使用中的下载形象也能更新；同一形象换版本后，桌宠窗口拿到的版本号与图片网址随之变化（审查第 1、2 项）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../core/hub-pet/role-packs');
const { mountPetSettingsTab } = require('../renderer/hub-pet/pet-settings-tab');

const WEBP = 'data:image/webp;base64,' + Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64').toString('base64');
const pack = version => ({ schema: 1, id: '05-rabbit', version, name: '兔子', meta: { poses: ['idle', 'typing', 'happy', 'sleep'] },
  files: { 'idle.webp': WEBP, 'typing.webp': WEBP, 'happy.webp': WEBP, 'sleep.webp': WEBP } });

async function mountWith(role, roles) {
  const container = { innerHTML: '', classList: { add() {} }, isConnected: true, addEventListener() {}, querySelector: () => null };
  const data = { available: true, settings: { enabled: true, mode: 'gentle', role }, roles, modes: [] };
  const ipc = { on() {}, invoke: async ch => (ch === 'hub-pet:get-settings' ? data : { roles, state: { phase: 'available' } }) };
  const tab = mountPetSettingsTab(container, { ipcRenderer: ipc, window: {}, document: { activeElement: null } });
  await tab.refresh?.();
  await new Promise(r => setTimeout(r, 5));
  return container.innerHTML;
}
const rabbit = { id: '05-rabbit', name: '兔子', installed: true, update: true, version: '1.0.0', available: true };
const cardOf = (html, id) => html.split('class="pet-tab-card').find(x => x.includes(`data-role="${id}"`)) || '';

test('审查第 1 项：使用中的形象检查到新版本时，卡片仍标「使用中」并给出「更新」按钮', async () => {
  const card = cardOf(await mountWith('05-rabbit', [rabbit]), '05-rabbit');
  assert.match(card, /使用中/);
  assert.match(card, /data-pet="download" data-id="05-rabbit"[^>]*>更新</);
  assert.match(card, /^ current/, '仍是当前形象，点卡片本身不触发换形象');
});

test('使用中且没有新版本：只显示「使用中」，没有更新按钮；非当前形象的更新按钮照旧', async () => {
  const cur = cardOf(await mountWith('05-rabbit', [{ ...rabbit, update: false }]), '05-rabbit');
  assert.match(cur, /使用中/);
  assert.doesNotMatch(cur, /data-pet="download"/);
  const other = cardOf(await mountWith('01-cat', [rabbit]), '05-rabbit');
  assert.match(other, /有新版本/);
  assert.match(other, />更新</);
});

test('审查第 2 项：下载形象的 version() 与预览网址随包版本变化，自带形象没有版本号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r27i2-'));
  try {
    const assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(path.join(assetsDir, '01-cat'), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, '01-cat', 'idle.webp'), Buffer.from(WEBP.split(',')[1], 'base64'));
    const store = R.createRolePackStore({ assetsDir, dataDir: path.join(dir, 'data'), logger: { warn() {} } });
    assert.equal(store.version('01-cat'), null);
    assert.equal(store.version('05-rabbit'), null);
    store.install(pack('1.0.0'));
    assert.equal(store.version('05-rabbit'), '1.0.0');
    const before = store.listRoles().find(r => r.id === '05-rabbit').preview;
    assert.match(before, /idle\.webp\?v=1\.0\.0$/);
    store.install(pack('1.1.0'));
    assert.equal(store.version('05-rabbit'), '1.1.0');
    const after = store.listRoles().find(r => r.id === '05-rabbit').preview;
    assert.match(after, /idle\.webp\?v=1\.1\.0$/);
    assert.notEqual(before, after, '同一形象换版本后预览网址变化，旧图缓存失效');
    assert.ok(!/\?v=/.test(store.listRoles().find(r => r.id === '01-cat').preview || ''), '自带形象网址不变');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('审查第 2 项：桌宠主进程推给窗口的状态带包版本（源码约束）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/hub-pet-controller.js'), 'utf8');
  assert.match(src, /roleVersion: \(typeof roles\.version === 'function' && roles\.version\(role\)\) \|\| null/);
  const pet = fs.readFileSync(path.join(__dirname, '../renderer/hub-pet/pet.js'), 'utf8');
  assert.match(pet, /next\.roleVersion \|\| null\) !== \(state\.roleVersion \|\| null\)/, '版本变化按换形象处理');
  assert.match(pet, /\?v=' \+ encodeURIComponent\(state\.roleVersion\)/, '图片网址带版本');
  assert.match(pet, /visual\.url === urlOf\(spec\)/, '同姿态但网址变了也要换图');
});
