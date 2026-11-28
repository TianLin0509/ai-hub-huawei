'use strict';
// 设置里点「下载」形象：下好就直接换上，不用再点一次卡片（2026-11-28 黄区真机）。
// 但下载晚到不能覆盖用户之后亲手的选择；下载没成功时也不能凭旧的「已装」换形象（Codex 审查复现：选了 Dog、下完又变回 Whale）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountPetSettingsTab } = require('../renderer/hub-pet/pet-settings-tab');

function rig() {
  let onClick = null, finishDownload = null;
  const saves = [];
  const settings = { enabled: true, mode: 'gentle', role: '01-cat' };
  const roles = [{ id: '01-cat', name: 'Cat', installed: true, bundled: true }, { id: '07-shiba', name: 'Dog', installed: true },
    { id: '19-whale-maid', name: 'Whale', installed: true, update: true }];
  const state = () => ({ available: true, settings: { ...settings }, roles, modes: [] });
  const container = { innerHTML: '', classList: { add() {} }, isConnected: true, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(k, f) { if (k === 'click') onClick = f; } };
  const ipc = { on() {}, invoke: async (ch, arg) => {
    if (ch === 'hub-pet:get-settings') return state();
    if (ch === 'hub-pet:set-settings') { saves.push(arg); if (arg.role) settings.role = arg.role; return state(); }
    if (ch === 'hub-pet:role-download') return new Promise(resolve => { finishDownload = resolve; });
    return { roles, state: { phase: 'idle' } };
  } };
  const tab = mountPetSettingsTab(container, { ipcRenderer: ipc, window: {}, document: { activeElement: null } });
  const tick = () => new Promise(r => setTimeout(r, 5));
  return {
    tab, saves, settings,
    download: id => onClick({ target: { closest: s => (s === '[data-pet]' ? { dataset: { pet: 'download', id }, disabled: false } : null) } }),
    pick: id => onClick({ target: { closest: s => (s === '[data-pet]' ? null : s.startsWith('.pet-tab-card') ? { dataset: { role: id } } : null) } }),
    finish: snap => finishDownload({ roles, ...snap }),
    tick,
  };
}

test('下载成功、期间没换过：自动换上刚下好的形象', async () => {
  const r = rig(); await r.tab.refresh();
  r.download('19-whale-maid'); await r.tick();
  r.finish({ state: { phase: 'installed', installedId: '19-whale-maid' } }); await r.tick();
  assert.equal(r.settings.role, '19-whale-maid');
});

test('下载中途用户亲手选了 Dog：下载完成后不再换回 Whale', async () => {
  const r = rig(); await r.tab.refresh();
  r.download('19-whale-maid'); await r.tick();
  r.pick('07-shiba'); await r.tick();
  assert.equal(r.settings.role, '07-shiba');
  r.finish({ state: { phase: 'installed', installedId: '19-whale-maid' } }); await r.tick();
  assert.equal(r.settings.role, '07-shiba', '晚到的下载不覆盖之后的选择');
});

test('下载（更新）失败：旧版虽仍算已装，也不换形象', async () => {
  const r = rig(); await r.tab.refresh();
  r.download('19-whale-maid'); await r.tick();
  r.finish({ state: { phase: 'error', failedId: '19-whale-maid', error: 'net' } }); await r.tick();
  assert.equal(r.settings.role, '01-cat');
  assert.deepEqual(r.saves, []);
});
