'use strict';
// 会议室抢订节奏按园区：规则推断、生效规则合成、开抢时刻与目标日期、自动拉起时间窗，以及接到抢订流程里的行为。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const S = require('../core/company-assistant/room-schedule');
const { CompanyAssistant } = require('../core/company-assistant/service');

test('园区推断：会议室名称优先，日程地点兜底，认不出返回 null', () => {
  assert.equal(S.inferCampus({ rooms: ['成都研究所 Z3-2F-08'] }).id, 'chengdu');
  assert.equal(S.inferCampus({ rooms: ['成都研究所 Z3-2F-08'] }).from, 'rooms');
  assert.equal(S.inferCampus({ locations: ['Chengdu R&D Center B1'] }).id, 'chengdu');
  assert.equal(S.inferCampus({ rooms: ['上海研究所 H3-1'] }).id, 'shanghai');
  // 会议室名称每条 3 票，多于零星的日程地点
  assert.equal(S.inferCampus({ rooms: ['上海 J2-301'], locations: ['成都 A', '成都 B'] }).id, 'shanghai');
  assert.equal(S.inferCampus({ rooms: ['Z3-2F-08'], locations: ['线上会议'] }), null);
  assert.equal(S.inferCampus(), null);
});
test('生效规则：成都 3 天 08:30；其他已知园区默认 7 天并沿用组件开放时刻；认不出要就地确认', () => {
  const cd = S.resolveSchedule({ inferred: { id: 'chengdu', name: '成都', from: 'rooms' }, componentOpenTime: '12:00:00' });
  assert.deepEqual([cd.advanceDays, cd.openTime, cd.source, cd.campus, cd.needsConfirm], [3, '08:30:00', 'campus', '成都', false]);
  const sh = S.resolveSchedule({ inferred: { id: 'shanghai', name: '上海', from: 'rooms' }, componentOpenTime: '12:00:00' });
  assert.deepEqual([sh.advanceDays, sh.openTime, sh.source, sh.needsConfirm], [7, '12:00:00', 'campus', false]);
  const none = S.resolveSchedule({ componentOpenTime: '12:00' });
  assert.deepEqual([none.advanceDays, none.openTime, none.source, none.needsConfirm], [7, '12:00:00', 'default', true]);
  assert.equal(S.resolveSchedule({}).openTime, '12:00:00');
  // 用户确认过的优先于园区规则；没确认或数值不合法的不算
  const manual = S.resolveSchedule({ saved: { advanceDays: 5, openTime: '09:00', confirmed: true }, inferred: { id: 'chengdu', name: '成都' } });
  assert.deepEqual([manual.advanceDays, manual.openTime, manual.source, manual.needsConfirm], [5, '09:00:00', 'manual', false]);
  assert.equal(S.resolveSchedule({ saved: { advanceDays: 5, openTime: '09:00' } }).source, 'default');
  assert.equal(S.resolveSchedule({ saved: { advanceDays: 0, openTime: '09:00', confirmed: true } }).source, 'default');
  assert.equal(S.describe(cd), '按成都园区规则：每天 08:30 放号，抢 3 天后的会议室');
});
test('开抢时刻与目标日期：开放前是今天、过了是明天；按日历日加天数，跨月跨年正确', () => {
  const before = new Date(2026, 10, 14, 8, 0).getTime(), after = new Date(2026, 10, 14, 9, 0).getTime();
  assert.equal(S.nextOpenAt(before, '08:30:00').getTime(), new Date(2026, 10, 14, 8, 30).getTime());
  assert.equal(S.nextOpenAt(after, '08:30:00').getTime(), new Date(2026, 10, 15, 8, 30).getTime());
  assert.equal(S.targetDateFor(S.nextOpenAt(before, '08:30:00'), 3), '2026-11-17');
  assert.equal(S.targetDateFor(S.nextOpenAt(after, '08:30:00'), 3), '2026-11-18');
  assert.equal(S.targetDateFor(new Date(2026, 10, 14, 12), 7), '2026-11-21');
  assert.equal(S.targetDateFor(new Date(2026, 10, 29, 8, 30), 3), '2026-12-02');
  assert.equal(S.targetDateFor(new Date(2026, 11, 30, 12), 7), '2027-01-06');
  assert.equal(S.targetDateFor(new Date(2028, 1, 27, 12), 3), '2028-03-01'); // 闰年 2 月
});
test('提前天数范围 1–120，默认仍 7；120 天跨 4 个月跨年', () => {
  assert.deepEqual([S.MIN_DAYS, S.MAX_DAYS, S.DEFAULT_ADVANCE_DAYS], [1, 120, 7]);
  for (const ok of [1, 7, 14, 15, 120]) assert.equal(S.validDays(ok), true, ok);
  for (const bad of [0, 121, -1, 7.5, '7', null, undefined, NaN]) assert.equal(S.validDays(bad), false, String(bad));
  assert.equal(S.resolveSchedule({}).advanceDays, 7);
  const far = S.resolveSchedule({ saved: { advanceDays: 120, openTime: '12:00', confirmed: true } });
  assert.deepEqual([far.advanceDays, far.source], [120, 'manual']);
  assert.equal(S.resolveSchedule({ saved: { advanceDays: 121, openTime: '12:00', confirmed: true } }).source, 'default');
  assert.equal(S.targetDateFor(new Date(2026, 10, 28, 12), 120), '2027-03-28');
  assert.equal(S.targetDateFor(new Date(2026, 10, 28, 12), 34), '2027-01-01');
  assert.equal(S.targetDateFor(new Date(2027, 11, 1, 12), 90), '2028-02-29'); // 跨年落在闰日
});
test('自动拉起时间窗跟着开放时刻走：12:00 是 11:30–12:00，08:30 是 08:00–08:30', () => {
  assert.deepEqual(S.autoStartWindow('12:00:00'), { from: 690, to: 720 });
  assert.deepEqual(S.autoStartWindow('08:30:00'), { from: 480, to: 510 });
  assert.deepEqual(S.autoStartWindow('00:10:00'), { from: 0, to: 10 });
  assert.equal(S.normalizeOpenTime('8:30'), null);
  assert.equal(S.normalizeOpenTime('08:30'), '08:30:00');
});

function rig(t, { at = new Date(2026, 10, 14, 8, 10).getTime(), helper = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-sched-'));
  const a = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, powerSaveBlocker: {}, roomHome: root, now: () => at });
  t.after(() => a.close());
  fs.mkdirSync(path.join(root, 'hub-control'));
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at, running: false, capabilities: ['full-ui'], version: '2.1.2',
    rules: { 优先会议室: [] }, preferences: { 抢订设置: { 开放时间: '12:00:00' } }, ...helper }));
  return { a, root, at };
}
test('接入抢订：成都会议室推出 3 天 08:30，组件不支持非 7 天时拒绝启动且不写请求', async t => {
  const { a, root } = rig(t, { helper: { rules: { 优先会议室: ['成都研究所 Z3-2F-08'] } } });
  const st = a.rooms.status();
  assert.deepEqual([st.schedule.advanceDays, st.schedule.openTime, st.schedule.campus, st.targetOffsetDays], [3, '08:30:00', '成都', 3]);
  assert.equal(st.schedule.hubTargetDate, '2026-11-17'); // 08:10 还没到 08:30，今天开放，抢 17 日
  // 拒绝发生在准备组件之前：不下载、不拉起组件
  let prepared = 0; a.rooms.ensure = async () => { prepared++; return {}; };
  await assert.rejects(a.rooms.command('start', {}, { user: true }), /成都园区是提前 3 天放号.*只会抢 7 天后.*本次未启动/);
  await assert.rejects(a.rooms.command('once', {}, { user: true }), /本次未启动/);
  assert.equal(prepared, 0);
  assert.equal(fs.existsSync(path.join(root, 'hub-control', 'requests')), false);
});
test('接入抢订：组件声明支持提前天数时，开抢前一起下发开放时刻与天数', async t => {
  const { a } = rig(t, { helper: { capabilities: ['full-ui', 'advance-days'], rules: { 优先会议室: ['成都研究所 Z3-2F-08'] } } });
  const calls = [], orig = a.rooms.command.bind(a.rooms);
  a.rooms.ensure = async () => ({});
  a.rooms.command = async (op, args, opts = {}) => { if (opts.internal) { calls.push([op, args]); return {}; } return orig(op, args, opts); };
  await a.rooms.applySchedule();
  assert.deepEqual(calls, [['configure', { 抢订设置: { 开放时间: '08:30:00', 提前天数: 3 } }]]);
});
test('接入抢订：认出非成都园区按 7 天，开放时刻一致时不多发设置', async t => {
  const { a } = rig(t, { helper: { rules: { 优先会议室: ['上海研究所 H3-1'] } } });
  const calls = [];
  a.rooms.command = async (op, args) => { calls.push([op, args]); return {}; };
  await a.rooms.applySchedule();
  assert.deepEqual(calls, []);
  assert.equal(a.rooms.status().schedule.needsConfirm, false);
});
test('提前天数超过组件上限：旧组件（没报上限）最多 14 天，超出拒绝启动且不下发；新组件按自报上限放行', async t => {
  const saved = { advanceDays: 30, openTime: '12:00:00', confirmed: true, at: 1 };
  const legacy = rig(t, { helper: { capabilities: ['full-ui', 'advance-days'], rules: { 优先会议室: ['上海研究所 H3-1'] } } });
  legacy.a.setSettings({ rooms: { schedule: saved } });
  const st = legacy.a.rooms.status().schedule;
  assert.deepEqual([st.advanceDays, st.componentMaxDays, st.componentOk, st.maxDays], [30, 14, false, 120]);
  let prepared = 0; legacy.a.rooms.ensure = async () => { prepared++; return {}; };
  await assert.rejects(legacy.a.rooms.command('start', {}, { user: true }), /你设置的是提前 30 天.*最多只能抢 14 天后.*本次未启动.*14 天以内/);
  await assert.rejects(legacy.a.rooms.command('once', {}, { user: true }), /本次未启动/);
  assert.equal(prepared, 0);
  const calls = [];
  legacy.a.rooms.command = async (op, args) => { calls.push([op, args]); return {}; };
  await legacy.a.rooms.applySchedule();
  assert.deepEqual(calls, []); // 30 天不下发给只认 14 天的组件；开放时刻一致也不多发
  const fresh = rig(t, { helper: { capabilities: ['full-ui', 'advance-days'], advanceDaysMax: 120, rules: { 优先会议室: ['上海研究所 H3-1'] } } });
  fresh.a.setSettings({ rooms: { schedule: { ...saved, advanceDays: 120 } } });
  const ok = fresh.a.rooms.status().schedule;
  assert.deepEqual([ok.componentMaxDays, ok.componentOk], [120, true]);
  assert.equal(fresh.a.rooms.checkSchedule('start').advanceDays, 120);
  const sent = [];
  fresh.a.rooms.command = async (op, args) => { sent.push([op, args]); return {}; };
  await fresh.a.rooms.applySchedule();
  assert.deepEqual(sent, [['configure', { 抢订设置: { 提前天数: 120 } }]]);
});
test('保存提前天数：120 合法、121 和 0 拒绝并提示 1–120', t => {
  const { a } = rig(t);
  assert.throws(() => a.rooms.saveSchedule({ advanceDays: 121, openTime: '12:00' }), /提前天数请填 1–120 的整数/);
  assert.throws(() => a.rooms.saveSchedule({ advanceDays: 0, openTime: '12:00' }), /提前天数请填 1–120 的整数/);
  assert.equal(a.rooms.saveSchedule({ advanceDays: 120, openTime: '12:00' }).schedule.advanceDays, 120);
});
test('就地确认：保存后按用户的两项生效，非法值拒绝', t => {
  const { a } = rig(t);
  assert.equal(a.rooms.status().schedule.needsConfirm, true);
  assert.throws(() => a.rooms.saveSchedule({ advanceDays: 0, openTime: '08:30' }), /提前天数/);
  assert.throws(() => a.rooms.saveSchedule({ advanceDays: 7, openTime: '25:00' }), /开放时刻/);
  const st = a.rooms.saveSchedule({ advanceDays: 7, openTime: '12:00' });
  assert.deepEqual([st.schedule.source, st.schedule.needsConfirm, st.schedule.openTime], ['manual', false, '12:00:00']);
  assert.equal(a.settings().rooms.schedule.advanceDays, 7);
});
test('自动拉起守护按生效的开放时刻提前 30 分钟，不再固定在 11:30–12:00', async t => {
  const { a, root, at } = rig(t, { helper: { rules: { 优先会议室: ['成都研究所 Z3-2F-08'] } } });
  // 组件已退出（状态文件过期），但规则留在文件里
  fs.writeFileSync(path.join(root, 'hub-control', 'status.json'), JSON.stringify({ protocol: 1, at: at - 5 * 60000, rules: { 优先会议室: ['成都研究所 Z3-2F-08'] } }));
  a.setSettings({ rooms: { enabled: true } });
  const ops = []; a.rooms.command = async op => { ops.push(op); };
  await a.rooms.tick();
  assert.deepEqual(ops, ['start']);
});
