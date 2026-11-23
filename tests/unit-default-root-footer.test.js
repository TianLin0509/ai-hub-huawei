'use strict';
// 新建会话底栏：默认工作目录可点修改、所在盘快满时一行提示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diskHint, changeDefaultRoot, DISK_WARN_PCT } = require('../renderer/default-root-footer.js');
const { fullDrives } = require('../core/hub-pet/disk-watch.js');

test('盘使用率 ≥85% 才提示，写清盘符、比例和下一步', () => {
  assert.equal(DISK_WARN_PCT, 85);
  assert.equal(diskHint(null), '');
  assert.equal(diskHint({ root: 'C:\\', pct: 84, freeGb: 30 }), '');
  assert.equal(diskHint({ root: 'C:\\', pct: 85, freeGb: 20.5 }), 'C: 盘已用 85%，剩 20.5 GB，点上面的路径可改到别的盘。');
  assert.match(diskHint({ root: 'D:\\', pct: 97 }), /^D: 盘已用 97%，点上面/);
});

test('warnPct=0 时 fullDrives 照常返回所在盘读数（底栏靠它取使用率）', async () => {
  const statfs = async () => ({ bsize: 1024, blocks: 100, bavail: 10 });
  assert.deepEqual(await fullDrives(['C:\\'], { statfs, warnPct: 0 }), [{ root: 'C:\\', pct: 90, freeGb: 0 }]);
});

function fakeIpc(replies) {
  const calls = [];
  return { calls, invoke: async (ch, arg) => { calls.push([ch, arg]); const r = replies[ch]; return typeof r === 'function' ? r(arg) : r; } };
}

test('选好文件夹后保存为默认工作目录', async () => {
  global.document = { dispatchEvent() {} };
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  const ipc = fakeIpc({ 'get-hub-config-raw': {}, 'workspace:pick-default-root': 'D:\\Work', 'save-hub-config': { success: true } });
  assert.deepEqual(await changeDefaultRoot(ipc), { ok: true, root: 'D:\\Work' });
  assert.deepEqual(ipc.calls.at(-1), ['save-hub-config', { defaultWorkspaceRoot: 'D:\\Work' }]);
});

test('取消选择不报错；保存失败和环境变量锁定都给一行原因', async () => {
  assert.deepEqual(await changeDefaultRoot(fakeIpc({ 'get-hub-config-raw': {}, 'workspace:pick-default-root': null })), { ok: false, canceled: true });
  const failed = await changeDefaultRoot(fakeIpc({ 'get-hub-config-raw': {}, 'workspace:pick-default-root': 'Z:\\x', 'save-hub-config': { success: false, message: '盘不存在' } }));
  assert.equal(failed.ok, false); assert.match(failed.message, /盘不存在/);
  const ipc = fakeIpc({ 'get-hub-config-raw': { workspaceRootEnv: 'E:\\Env' } });
  const locked = await changeDefaultRoot(ipc);
  assert.match(locked.message, /AI_HUB_WORKSPACE_ROOT/);
  assert.equal(ipc.calls.length, 1, '环境变量锁定时不弹选择框');
});

test('读不到配置时一行说明原因，不弹选择框、不保存', async () => {
  for (const reply of [() => { throw new Error('IPC 断开'); }, null]) {
    const ipc = fakeIpc({ 'get-hub-config-raw': reply });
    const r = await changeDefaultRoot(ipc);
    assert.equal(r.ok, false); assert.ok(!r.canceled); assert.match(r.message, /读不到当前设置.*这次没改默认工作目录/);
    assert.deepEqual(ipc.calls.map(c => c[0]), ['get-hub-config-raw']);
  }
});

test('底栏有可点路径按钮、ⓘ 说明和磁盘提示行，控制器接了点击', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  for (const id of ['new-session-root-edit', 'new-session-root-info', 'new-session-root-disk']) assert.ok(html.includes(`id="${id}"`), id);
  const ctl = fs.readFileSync(path.join(__dirname, '../renderer/workspace-controller.js'), 'utf8');
  assert.match(ctl, /new-session-root-edit'\)\?\.addEventListener\('click'/);
  assert.match(ctl, /workspace:root-disk/);
});
