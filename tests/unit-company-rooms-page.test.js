'use strict';
const { roomReadiness } = require('../renderer/company-rooms-page');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const component = require('../core/company-assistant/room-component');
const { RoomBooking } = require('../core/company-assistant/rooms');
const { registerCompanyAssistantIpc } = require('../main/ipc/company-assistant-handlers');
const bundle = path.resolve(__dirname, '../core/company-assistant/room-component');

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-page-unit-'));
  const now = Date.UTC(2026, 10, 3, 12);
  let state = {}, settings = { rooms: { enabled: false } };
  const assistant = { dir: root, now: () => now, changed() {}, state: () => state,
    settings: () => settings, saveState: patch => { state = { ...state, ...patch }; },
    setSettings: patch => { settings = { ...settings, rooms: { ...settings.rooms, ...patch.rooms } }; } };
  const rooms = new RoomBooking(assistant, { roomHome: root, roomDownloader: null, noTimer: true });
  assistant.rooms = rooms;
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8'); return file;
  };
  t.after(() => {
    rooms.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('room-page-unit-'));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, now, assistant, rooms, write };
}

test('signed room adapter is version 2.1.2 and the shipped payload matches its hash', () => {
  const manifest = component.manifest(path.join(bundle, 'control.json'));
  assert.equal(manifest.version, '2.1.2');
  assert.ok(component.verified(path.join(bundle, manifest.code.file), manifest.code));
});

test('modified control manifest fails signature verification', t => {
  const f = rig(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'control.json'), 'utf8'));
  manifest.version = '2.1.99';
  assert.throws(() => component.manifest(f.write('tampered.json', manifest)), /签名/);
});

test('details preserve original history and never claim an unchecked login is valid', t => {
  const f = rig(t);
  const history = Array.from({ length: 60 }, (_, i) => ({ id: i, 状态: '成功' }));
  f.write('booking_history.json', history);
  f.write('hub-control/status.json', { protocol: 1, at: f.now, running: false, loginState: 'unknown',
    preferences: { 抢订设置: { 最大重试次数: 6 } }, logs: ['ready'], version: '2.1.2' });
  const detail = f.rooms.details();
  assert.equal(detail.connected, true);
  assert.equal(detail.loginState, 'unknown');
  assert.equal(detail.history.length, 50);
  assert.deepEqual(detail.history[0], history[10]);
  assert.deepEqual(detail.preferences, { 抢订设置: { 最大重试次数: 6 } });
  assert.deepEqual(detail.logs, ['ready']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'booking_history.json'), 'utf8')), history);
});

test('malformed original history reports failure and preserves the file', t => {
  const f = rig(t), file = f.write('booking_history.json', { unexpected: 'keep me' });
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => f.rooms.details(), /历史格式/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('stale helper status cannot keep the page in a busy or running state', t => {
  const f = rig(t);
  f.write('hub-control/status.json', { protocol: 1, at: f.now - 31000, running: true,
    controlBusy: 'read-rooms', loginState: 'unknown', history: [] });
  const detail = f.rooms.details();
  assert.equal(detail.connected, false);
  assert.equal(detail.running, false);
  assert.equal(detail.controlBusy, null);
});

test('booking once, test messages and pending removal require a user action before starting any helper', async t => {
  const f = rig(t); let started = false;
  f.rooms.ensure = async () => { started = true; };
  for (const op of ['once', 'test-message', 'remove-pending']) {
    await assert.rejects(f.rooms.command(op), /亲自执行/);
  }
  assert.equal(started, false);
});

test('advanced settings cannot be changed by a background caller', async t => {
  const f = rig(t); let started = false;
  f.rooms.ensure = async () => { started = true; };
  for (const field of ['抢订设置', '会后动作', '系统', '高级']) {
    await assert.rejects(f.rooms.command('configure', { [field]: {} }), /亲自修改/);
  }
  assert.equal(started, false);
});

test('an explicit user action sends one request and matches its reply without replay', async t => {
  const f = rig(t); let prepared = 0, requests = [];
  f.rooms.ensure = async ({ user }) => { assert.equal(user, true); prepared++; };
  const timer = setInterval(() => {
    const dir = path.join(f.root, 'hub-control/requests');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (requests.some(x => x.id === request.id)) continue;
      requests.push(request);
      f.write('hub-control/replies/' + name, { requestId: request.id, ok: true, receipt: 'local fixture' });
    }
  }, 10);
  try {
    const result = await f.rooms.command('once', {}, { user: true });
    assert.equal(result.ok, true); assert.equal(result.receipt, 'local fixture');
    assert.equal(prepared, 1); assert.equal(requests.length, 1); assert.equal(requests[0].op, 'once');
  } finally { clearInterval(timer); }
});

test('busy helpers are never terminated during reconnect', async () => {
  for (const flags of [{ running: true }, { loginBusy: true }, { controlBusy: 'read-rooms' }]) {
    await assert.rejects(component.stopManagedHelper({ pid: process.pid, ...flags }, process.execPath), /先停止/);
  }
});

test('a newer connected helper is preserved instead of being downgraded', async t => {
  const f = rig(t); let started = false;
  f.write('hub-control/status.json', { protocol: 1, at: f.now, version: '2.2.0', running: false });
  f.rooms.ensure = async () => { started = true; };
  await assert.rejects(f.rooms.reconnect(), /较新/);
  assert.equal(started, false);
});

test('room page IPC keeps explicit user intent and the original command payload', async t => {
  const f = rig(t), handlers = new Map(); let received;
  f.rooms.command = async (...args) => { received = args; return { ok: true }; };
  registerCompanyAssistantIpc({ handle: (name, fn) => handlers.set(name, fn) }, f.assistant);
  const request = { op: 'configure', rules: { 优先会议室: [], 高级: { 浏览器: 'Edge' } } };
  const callback = handlers.get('company-assistant:room-command');
  assert.equal(typeof callback, 'function');
  assert.deepEqual(await callback(null, request), { ok: true });
  assert.deepEqual(received, [request.op, request.rules, { user: true }]);
});

test('空计划或明确登录失效不可启动，重启后的未检查状态允许组件自动预检', () => {
  assert.deepEqual(roomReadiness({}, {}), { plan: false, login: false, missing: 2, ready: false });
  assert.deepEqual(roomReadiness({ 优先会议室: ['会议室 A'] }, {}), { plan: true, login: false, missing: 1, ready: true });
  assert.equal(roomReadiness({ 优先会议室: ['会议室 A'] }, { loginState: null, loginNeeded: false }).ready, true);
  assert.equal(roomReadiness({ 优先会议室: ['会议室 A'] }, { loginState: false }).ready, false);
  assert.equal(roomReadiness({ 优先会议室: ['会议室 A'] }, { loginState: null, loginNeeded: true }).ready, false);
  assert.equal(roomReadiness({ 优先会议室: ['会议室 A'] }, { loginState: true }).ready, true);
  assert.equal(roomReadiness({ 优先会议室: ['  '] }, { loginState: true }).ready, false);
  assert.equal(roomReadiness({ 优先会议室: ['会议室 A'] }, { loginState: true, loginNeeded: true }).ready, false);
});
