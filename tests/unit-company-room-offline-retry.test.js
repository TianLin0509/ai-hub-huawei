'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { RoomBooking } = require('../core/company-assistant/rooms');
const { networkError } = require('../core/company-assistant/room-offline-retry');
const stamp = n => { const d = new Date(n), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
function rig(t, { minutes = 1, daemon = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-retry-'));
  let now = new Date(2026, 10, 16, 12, minutes).getTime(), probes = 0;
  const deps = { dataDir: root, noTimer: true, noTools: true, powerSaveBlocker: {}, roomHome: root, roomDownloader: null, now: () => now,
    roomNetworkProbe: async () => { probes++; return true; } };
  const a = new CompanyAssistant(deps), ops = [];
  t.after(() => { a.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'hub-control'));
  const helper = { protocol: 1, at: now, running: daemon, mode: daemon ? 'daemon' : null, rules: { 优先会议室: ['上海 R1'] }, preferences: { 抢订设置: { 开放时间: '12:00:00' } } };
  const history = [];
  const write = () => { helper.at = now; helper.history = history; fs.writeFileSync(path.join(root, 'hub-control/status.json'), JSON.stringify(helper)); fs.writeFileSync(path.join(root, 'booking_history.json'), JSON.stringify(history)); };
  const command = async (op, args, opts) => { ops.push({ op, opts }); helper.running = op !== 'pause'; helper.mode = op === 'start' ? 'daemon' : op === 'once' ? 'once' : null; write(); return {}; };
  a.rooms.command = command;
  a.setSettings({ rooms: { enabled: daemon } });
  a.saveState({ roomSeen: [] });
  const add = (状态 = '错误', 备注 = 'Page.goto: net::ERR_INTERNET_DISCONNECTED', extra = {}) => {
    history.push({ 日期: '2026-11-23', 时间: '14:00 起 1h0m', 时间戳: stamp(now), 状态, 备注, ...extra }); write(); return history.at(-1);
  };
  write();
  return { a, ops, helper, history, deps, add, write, probes: () => probes, advance: ms => { now += ms; write(); }, setNow: at => { now = at; write(); }, idle: () => { helper.running = false; helper.mode = null; write(); }, replaceRooms: () => { a.rooms.close(); a.rooms = new RoomBooking(a, deps); a.rooms.command = command; } };
}

test('断网后仅在恢复可达时补抢，组件回报成功后不再触发，历史显示人话和真实结果', async t => {
  const r = rig(t); r.add(); let connected = false;
  r.deps.roomNetworkProbe = async () => connected;
  await r.a.rooms.tick(); assert.equal(r.ops.length, 0);
  assert.match(r.a.rooms.details().history[0].备注, /正在等待网络恢复/);
  connected = true; r.advance(10000); await r.a.rooms.tick();
  assert.deepEqual(r.ops.map(x => x.op), ['once']);
  r.idle(); r.add('成功', '已订到 R1'); r.advance(10000); await r.a.rooms.tick();
  await r.a.rooms.tick(); assert.equal(r.ops.length, 1);
  assert.match(r.a.rooms.details().history[0].备注, /已在网络恢复后自动重试.*重试结果：成功/);
  assert.equal(r.a.rooms.details().history[1].状态, '成功');
});

test('持续网络错误最多补三次，重建 RoomBooking 后也不清零次数', async t => {
  const r = rig(t); r.add();
  for (let n = 1; n <= 3; n++) {
    await r.a.rooms.tick();
    assert.equal(r.ops.filter(x => x.op === 'once').length, n);
    r.idle(); r.advance(10000); r.add('错误', `net::ERR_CONNECTION_RESET #${n}`);
    if (n === 1) r.replaceRooms();
  }
  await r.a.rooms.tick(); r.advance(10000); await r.a.rooms.tick();
  assert.equal(r.ops.filter(x => x.op === 'once').length, 3);
  assert.match(r.a.rooms.details().history[0].备注, /已补抢 3 次/);
});

test('非网络错误、登录失效、满员、默认成功均不探测网络也不发补抢命令', async t => {
  for (const [state, note] of [['错误','selector not found'], ['错误','登录失效：net::ERR_TIMED_OUT'], ['满员','候选全部被占'], ['成功','']]) {
    const r = rig(t); r.add(state, note); await r.a.rooms.tick();
    assert.equal(r.probes(), 0); assert.equal(r.ops.length, 0);
    assert.equal(r.a.rooms.details().history[0].备注, note);
  }
});

test('超过开放后15分钟不触发补抢，追加当天失败提示且重扫不重复', async t => {
  const r = rig(t, { minutes: 16 }); r.add(); await r.a.rooms.tick(); await r.a.rooms.tick();
  assert.equal(r.ops.length, 0); assert.equal(r.probes(), 0);
  const history = r.a.rooms.details().history;
  assert.equal(history.filter(x => x.状态 === '提示').length, 1);
  assert.equal(history.find(x => x.状态 === '提示').备注, '开抢时没联网，今天没抢到；明天照常');
});

test('等网络超过窗口停止探测；已成功的同一目标日不补抢', async t => {
  const offline = rig(t); offline.add(); offline.deps.roomNetworkProbe = async () => false;
  await offline.a.rooms.tick(); offline.advance(15*60000); await offline.a.rooms.tick();
  assert.equal(offline.ops.length, 0); assert.equal(offline.a.rooms.details().history.at(-1).状态, '提示');
  const won = rig(t); won.add('成功', ''); won.add(); await won.a.rooms.tick();
  assert.equal(won.ops.length, 0); assert.equal(won.probes(), 0);
});

test('昨天、错误目标日、缺少时间戳均不触发；开放前准备阶段断网在开放后可恢复', async t => {
  for (const extra of [{ 时间戳: '2026-11-15 12:00:00' }, { 日期: '2026-11-24' }, { 时间戳: '' }]) {
    const r = rig(t); r.add('错误', 'net::ERR_NETWORK_CHANGED', extra); await r.a.rooms.tick(); assert.equal(r.ops.length, 0);
  }
  const r = rig(t); r.add('错误', 'net::ERR_NAME_NOT_RESOLVED', { 时间戳: '2026-11-16 11:59:30' });
  await r.a.rooms.tick(); assert.deepEqual(r.ops.map(x => x.op), ['once']);
});

test('补抢暂停原守护、等待退出，确认结果后恢复每日守护且不改 enabled', async t => {
  const r = rig(t, { daemon: true }); r.add(); await r.a.rooms.tick();
  assert.deepEqual(r.ops.map(x => x.op), ['pause']); assert.equal(r.a.rooms.settings().enabled, true);
  r.advance(10000); await r.a.rooms.tick();
  assert.deepEqual(r.ops.map(x => x.op), ['pause', 'once']);
  r.idle(); r.add('成功', ''); r.advance(10000); await r.a.rooms.tick();
  assert.deepEqual(r.ops.map(x => x.op), ['pause', 'once', 'start']);
  assert.equal(r.a.rooms.settings().enabled, true);
  assert.ok(r.ops.every(x => x.opts.internal));
});

test('实际发请求时 internal pause/start 保持每日开关，自动 once 仍需用户来源授权', async t => {
  const r = rig(t, { daemon: true }); r.a.rooms.command = RoomBooking.prototype.command.bind(r.a.rooms);
  const requests = path.join(r.a.rooms.home(), 'hub-control/requests'), replies = path.join(r.a.rooms.home(), 'hub-control/replies');
  fs.mkdirSync(replies, { recursive: true });
  const responder = setInterval(() => {
    if (!fs.existsSync(requests)) return;
    for (const name of fs.readdirSync(requests).filter(n => n.endsWith('.json'))) {
      const req = JSON.parse(fs.readFileSync(path.join(requests, name)));
      fs.writeFileSync(path.join(replies, name), JSON.stringify({ requestId: req.id, ok: true })); fs.unlinkSync(path.join(requests, name));
    }
  }, 5); t.after(() => clearInterval(responder));
  await r.a.rooms.command('pause', {}, { internal: true }); assert.equal(r.a.rooms.settings().enabled, true);
  await assert.rejects(r.a.rooms.command('once', {}, { internal: true }), /亲自执行/);
});

test('补抢后登录失效或满员立即停止，不继续消耗网络重试次数', async t => {
  for (const [state, note] of [['错误', '登录失效'], ['满员', '候选全部被占']]) {
    const r = rig(t); r.add(); await r.a.rooms.tick(); r.idle(); r.advance(10000); r.add(state, note);
    await r.a.rooms.tick(); r.advance(10000); await r.a.rooms.tick(); assert.equal(r.ops.length, 1);
    assert.match(r.a.rooms.details().history[0].备注, /重试结果：/);
  }
});

test('探测中用户停止、探测期间过期或已有成功，均不会发补抢请求', async t => {
  for (const action of ['cancel', 'expire', 'success']) {
    const r = rig(t); r.add(); r.deps.roomNetworkProbe = async () => {
      if (action === 'cancel') r.a.rooms.offlineRetry.cancel();
      if (action === 'expire') r.advance(15*60000);
      if (action === 'success') r.add('成功', '');
      return true;
    };
    await r.a.rooms.tick(); assert.equal(r.ops.length, 0);
  }
});

test('once 回执只表示启动：结果未知时不重复补抢，单次慢任务和读取会议室不被打断', async t => {
  const r = rig(t); r.add(); await r.a.rooms.tick(); r.idle();
  r.advance(10000); await r.a.rooms.tick(); assert.equal(r.ops.length, 1);
  for (const busy of [{ running: true, mode: 'test' }, { controlBusy: 'read-rooms' }, { loginNeeded: true }]) {
    const other = rig(t); Object.assign(other.helper, busy); other.write(); other.add();
    await other.a.rooms.tick(); assert.equal(other.ops.length, 0);
  }
});

test('支持各种浏览器网络错误，状态为错误以外一律不重试', () => {
  for (const code of ['INTERNET_DISCONNECTED','NETWORK_CHANGED','NAME_NOT_RESOLVED','CONNECTION_RESET','CONNECTION_REFUSED','TIMED_OUT','ADDRESS_UNREACHABLE']) {
    assert.equal(networkError({ 状态: '错误', 备注: 'Page.goto: net::ERR_' + code }), true);
    assert.equal(networkError({ 状态: '失败', 备注: 'net::ERR_' + code }), false);
  }
});

test('默认历史的顺序、原备注、原始文件均保持不变；补抢提示只存在 Hub 状态', async t => {
  const r = rig(t); r.add('成功', '较新的原备注'); r.add('测试', '较旧的原备注', { 时间戳: '2026-11-15 10:00:00' });
  const file = path.join(r.a.rooms.home(), 'booking_history.json'), before = fs.readFileSync(file, 'utf8');
  await r.a.rooms.tick(); assert.deepEqual(r.a.rooms.details().history, r.history); assert.equal(fs.readFileSync(file, 'utf8'), before);
  const other = rig(t, { minutes: 16 }); other.add(); const original = fs.readFileSync(path.join(other.a.rooms.home(), 'booking_history.json'), 'utf8');
  await other.a.rooms.tick(); assert.equal(other.a.rooms.details().history.length, 2);
  assert.equal(fs.readFileSync(path.join(other.a.rooms.home(), 'booking_history.json'), 'utf8'), original);
});
