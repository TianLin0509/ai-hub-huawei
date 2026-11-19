'use strict';
// 会议室可选功能开关（2026-11-19 反馈 1b517a0b）：默认开；关着时不轮询、不拉起组件；有安排好的抢订时不让关；关掉时结束常驻组件。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const component = require('../core/company-assistant/room-component');
const { createOptionalFeatures } = require('../core/optional-features');
function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-switch-'));
  const now = Date.now();
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, powerSaveBlocker: {}, roomHome: root, now: () => now });
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { a, root, now };
}
test('会议室默认开着：老用户没有开关记录时行为不变', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-of-rooms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = createOptionalFeatures({ dataDir: root });
  assert.equal(f.get('rooms'), true);
  assert.equal(f.get('w3'), false, '其他可选功能仍默认关');
  f.set('rooms', false);
  assert.equal(createOptionalFeatures({ dataDir: root }).get('rooms'), false, '用户关掉后重启照样关');
  assert.equal(createOptionalFeatures({ dataDir: root }).navHidden('rooms'), true);
});
test('关着时 tick 不读历史、不开抢，接通组件直接拒绝', async t => {
  const { a, root } = rig(t);
  a.setSettings({ rooms: { enabled: true } });
  let starts = 0; a.rooms.command = async () => { starts++; };
  a.rooms.readHistory = () => { throw new Error('关着时不该读历史'); };
  a.rooms.setEnabled(false);
  a.rooms.start();
  assert.equal(a.rooms.timer, null);
  await a.rooms.tick();
  assert.equal(starts, 0);
  await assert.rejects(a.rooms.ensure({ user: true }), /可选功能.*关闭/);
  assert.ok(fs.existsSync(root));
});
test('自动抢订开着或正在跑时不让关，说清先暂停', async t => {
  const { a, root, now } = rig(t);
  assert.equal(a.rooms.offBlocker(), '');
  a.setSettings({ rooms: { enabled: true } });
  assert.match(a.rooms.offBlocker(), /先在会议室页点「暂停」/);
  a.setSettings({ rooms: { enabled: false } });
  fs.mkdirSync(path.join(root, 'hub-control'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, running: true }));
  assert.match(a.rooms.offBlocker(), /暂停/);
});
test('关掉时结束 Hub 拉起的常驻组件；组件没在跑就什么都不做', async t => {
  const { a, root, now } = rig(t);
  const orig = component.stopManagedHelper;
  const calls = [];
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* 已退 */ } });
  let kill = true;
  component.stopManagedHelper = async (helper, exe) => { calls.push([helper.pid, exe]); if (kill) process.kill(helper.pid); };
  t.after(() => { component.stopManagedHelper = orig; });
  assert.deepEqual(await a.rooms.shutdown(), { stopped: false });
  assert.equal(calls.length, 0);
  a.rooms.setEnabled(true);
  a.setSettings({ rooms: { exePath: process.execPath } });
  fs.mkdirSync(path.join(root, 'hub-control'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, pid: child.pid, running: false }));
  assert.deepEqual(await a.rooms.shutdown(), { stopped: true });
  assert.deepEqual(calls, [[child.pid, process.execPath]]);
  assert.equal(a.rooms.off, true);
});
test('还有会后动作等着执行、或组件正忙时也不让关', async t => {
  const { a, root, now } = rig(t);
  fs.mkdirSync(path.join(root, 'hub-control'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, running: false, pending: [{ id: 'p1' }] }));
  assert.match(a.rooms.offBlocker(), /1 个会后动作/);
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, running: false, controlBusy: 'read-rooms' }));
  assert.match(a.rooms.offBlocker(), /正在执行操作/);
});
test('结束命令返回了但进程还在：报错，不当成已关', async t => {
  const { a, root, now } = rig(t);
  const orig = component.stopManagedHelper;
  component.stopManagedHelper = async () => {};
  t.after(() => { component.stopManagedHelper = orig; });
  a.setSettings({ rooms: { exePath: process.execPath } });
  fs.mkdirSync(path.join(root, 'hub-control'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: now, pid: process.pid, running: false }));
  await assert.rejects(a.rooms.shutdown(), /没有结束/);
});
