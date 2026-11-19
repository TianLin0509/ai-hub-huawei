'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../core/attendance-calc.js');

/* 2026-10-31 至 11-07 的 8 天打卡（形状与考勤系统返回一致） */
const RAW = [
  ['2026-11-07', '16:03', '22:26', '智,S', '智,S'], ['2026-11-06', '08:53', '19:36', '智,S', '智,S'],
  ['2026-11-05', '08:47', '22:54', '智,S', '手,S'], ['2026-11-04', '08:43', '20:54', '智,S', '智,S'],
  ['2026-11-03', '09:29', '23:03', '手,S', '手,S'], ['2026-11-02', '08:42', '22:41', '智,S', '智,S'],
  ['2026-11-01', '01:29', '01:51', '手,S', '智,S'], ['2026-10-31', '08:42', '19:20', '智,S', '智,S'],
].map(([d, a, b, ta, tb]) => ({ attendanceDate: d, earlyClockInTime: a, lateClockInTime: b, earlyClockTag: ta, lateClockTag: tb }));

test('月末周六按工作日，普通周六按周末', () => {
  assert.equal(A.dayKind('2026-10-31'), 'lastSaturday');
  assert.equal(A.dayKind('2026-11-07'), 'weekend');
  assert.equal(A.lastSaturday(2026, 10), '2026-11-28');
});

test('05:00 前的打卡归前一天，中间离开的空档不算', () => {
  const days = A.buildDays(RAW);
  assert.equal(days.find((x) => x.date === '2026-11-01'), undefined);
  const d = days.find((x) => x.date === '2026-10-31');
  assert.equal(d.segs.length, 2);
  assert.equal(d.nightReturn, true);
  assert.equal(d.otAm, 18);
  assert.equal(d.otPm, 80 + 22);
  assert.equal(d.leave, 1440 + 111);
});

test('逐日加班与 11 月净加班', () => {
  const days = A.buildDays(RAW);
  const by = Object.fromEntries(days.map((x) => [x.date, x]));
  assert.equal(by['2026-11-02'].ot, 18 + 281);
  assert.equal(by['2026-11-03'].ot, 303);
  assert.equal(by['2026-11-07'].ot, 383);
  assert.equal(by['2026-11-07'].owe, 0);
  assert.equal(by['2026-11-05'].manual, true);
  const m = A.monthReport(days, '2026-11', '2026-11-08');
  assert.equal(m.gross, 1586);
  assert.equal(m.owe, 150);
  assert.equal(m.net, 1436);
  assert.equal(m.workdays, 5);
  assert.equal(m.monthWorkdays, 22);
  assert.equal(m.leftWorkdays, 17);
  assert.equal(m.late22, 3);
  assert.ok(m.willExceed);
  assert.equal(Math.round(m.projected / 60), 105);
  assert.equal(A.fmtClock(m.leaveBy), '21:37');
});

test('合并：同一天以新抓到的为准，并统计新增与更新', () => {
  const morning = [{ attendanceDate: '2026-11-06', earlyClockInTime: '08:53', lateClockInTime: '08:53', earlyClockTag: '智', lateClockTag: '智' }];
  const r1 = A.mergeRecords([], morning, 't1');
  assert.equal(r1.added, 1);
  const r2 = A.mergeRecords(r1.list, RAW, 't2');
  assert.equal(r2.updated, 1);
  assert.equal(r2.added, 7);
  assert.equal(r2.list.find((x) => x.date === '2026-11-06').last, '19:36');
  const r3 = A.mergeRecords(r2.list, RAW, 't3');
  assert.equal(r3.added + r3.updated, 0);
});

test('坏数据被跳过，不抛错', () => {
  const r = A.mergeRecords([], [null, {}, { attendanceDate: 'x' }, { attendanceDate: '2026-11-01' }], 't');
  assert.equal(r.list.length, 0);
});

test('节假日整段算加班', () => {
  const days = A.buildDays([{ attendanceDate: '2026-10-02', earlyClockInTime: '10:00', lateClockInTime: '15:00' }], { holidays: { '2026-10-02': true } });
  assert.equal(days[0].kind, 'holiday');
  assert.equal(days[0].ot, 300);
  assert.equal(days[0].owe, 0);
});

test('年度统计', () => {
  const y = A.yearReport(A.buildDays(RAW), 2026, '2026-11-08');
  assert.equal(y.monthsWithData, 2);
  assert.equal(y.months[10].net, 1436);
  assert.equal(y.months[9].net, 120 - 30);
  assert.equal(y.overMonths, 0);
  assert.equal(y.peakMonth.month, 11);
});

test('公司假期日历把周末也列进来时：周末仍按周末 / 月末周六规则，只有工作日上的才算法定假', () => {
  const holidays = { '2026-10-31': '休息日', '2026-11-07': '休息日', '2026-10-01': '法定假 国庆' };
  assert.equal(A.dayKind('2026-10-31', { holidays }), 'lastSaturday');
  assert.equal(A.dayKind('2026-11-07', { holidays }), 'weekend');
  assert.equal(A.dayKind('2026-10-01', { holidays }), 'holiday');
});

test('核心工作时间可自定义：默认口径不变，改时间后扣时与加班起点跟着变', () => {
  const def = A.rulesFromWorkTime({});
  assert.deepEqual([def.amEnd, def.pmStart, def.owePerWorkday, def.ratedMinutes], [540, 1080, 30, 450]);
  // 08:30–12:00、13:00–17:30 = 8 小时：不扣；晚上默认跟着下班后 30 分钟
  const r = A.rulesFromWorkTime({ amStart: '08:30', amEnd: '12:00', pmStart: '13:00', pmEnd: '17:30' });
  assert.deepEqual([r.amEnd, r.pmStart, r.owePerWorkday], [510, 1080, 0]);
  const late = A.rulesFromWorkTime({ amStart: '10:00', amEnd: '12:30', pmStart: '13:30', pmEnd: '19:00' });
  assert.equal(late.pmStart, 19 * 60 + 30);
  const days = A.buildDays([{ attendanceDate: '2026-11-04', earlyClockInTime: '08:00', lateClockInTime: '20:00' }], { rules: late });
  assert.equal(days[0].otAm, 120);
  assert.equal(days[0].otPm, 30);
  assert.equal(days[0].owe, late.owePerWorkday);
  // 不合理的时间给出说明，不静默乱算
  assert.equal(A.normalizeWorkTime({ amStart: '12:00', amEnd: '09:00' }).ok, false);
  assert.match(A.normalizeWorkTime({ pmEnd: '18:00', eveningFrom: '17:00' }).error, /晚上加班/);
  assert.equal(A.rulesFromWorkTime({ amStart: '12:00', amEnd: '09:00' }).amEnd, 540);
});

const card = (date, first, last = first) => ({ attendanceDate: date, earlyClockInTime: first, lateClockInTime: last });

for (const [label, last] of [['只有上班卡', '08:40'], ['已有离开卡', '22:30']]) {
  test(`今天${label}：月报、年报及明细都只统计昨天以前`, () => {
    const records = [card('2026-11-09', '08:40', '20:00'), card('2026-11-10', '08:40', last)];
    const days = A.buildDays(records);
    const expected = A.summarize(days.filter(x => x.date < '2026-11-10'));
    const m = A.monthReport(days, '2026-11', '2026-11-10');
    const y = A.yearReport(days, 2026, '2026-11-10');
    for (const r of [m, y]) for (const key of ['workdays', 'span', 'gross', 'owe', 'net', 'avgLeave', 'avgArrive', 'convertedDaily', 'late22']) {
      assert.equal(r[key], expected[key], key);
    }
    assert.equal(y.months[10].net, expected.net);
    assert.equal(y.latestLeave.date, '2026-11-09');
    assert.deepEqual(m.days.map(x => x.date), ['2026-11-09']);
    const { viewModel } = require('../renderer/company-attendance-page');
    const vm = viewModel({ records, today: '2026-11-10' });
    assert.deepEqual(vm.days.map(x => x.date), ['2026-11-09']);
    assert.equal(A.summarize(vm.days).net, m.net);
    assert.equal(records.length, 2); // 原始打卡不删除，第二天可以补全。
  });
}

test('工作日今天尚未结算：剩余天数和红线预测包含今天', () => {
  const m = A.monthReport(A.buildDays([card('2026-11-09', '09:00', '20:00')]), '2026-11', '2026-11-10');
  assert.equal(m.leftWorkdays, 16);
  assert.equal(m.projected, 90 + 90 * 16);
  assert.equal(m.perDayAllowance, (4800 - 90) / 16);
});

test('月末工作日今天仍有预算，次日自动结算；未传今天时仍可统计历史全集', () => {
  const days = A.buildDays([card('2026-11-30', '08:40', '20:00')]);
  const current = A.monthReport(days, '2026-11', '2026-11-30');
  assert.equal(current.workdays, 0);
  assert.equal(current.leftWorkdays, 1);
  assert.equal(A.monthReport(days, '2026-11', '2026-12-01').net, 110);
  assert.equal(A.monthReport(days, '2026-11').net, 110);
  assert.equal(A.yearReport(days, 2026).net, 110);
});

test('今天是周末、节假日或月末周六：不结算，历史分类和加班不变', () => {
  const cases = [
    ['2026-11-07', {}, 'weekend', 300],
    ['2026-10-02', { holidays: { '2026-10-02': true } }, 'holiday', 300],
    ['2026-10-31', {}, 'lastSaturday', -30],
  ];
  for (const [today, opts, kind, net] of cases) {
    const days = A.buildDays([card(today, '10:00', '15:00')], opts);
    assert.equal(days[0].kind, kind);
    assert.equal(A.monthReport(days, today.slice(0, 7), today, opts).net, 0);
    const past = A.monthReport(days, today.slice(0, 7), A.shiftDay(today, 1), opts);
    assert.equal(past.net, net);
  }
});

test('周一凌晨跨零点打卡仍归周日，周一上班卡不进入汇总', () => {
  const days = A.buildDays([card('2026-11-08', '22:00', '01:00'), card('2026-11-09', '02:00', '03:00'), card('2026-11-09', '08:40')]);
  const m = A.monthReport(days, '2026-11', '2026-11-09');
  assert.deepEqual(m.days.map(x => x.date), ['2026-11-08']);
  assert.equal(m.rest, 240);
  assert.equal(m.owe, 0);
  assert.equal(m.days[0].leave, 1620);
});

test('只有今天或未来记录：年度不产生已出勤月份、峰值和最晚离开', () => {
  const days = A.buildDays([card('2026-01-01', '09:00', '23:00'), card('2026-01-02', '09:00', '23:00')]);
  const y = A.yearReport(days, 2026, '2026-01-01');
  assert.equal(y.monthsWithData, 0);
  assert.equal(y.peakMonth, null);
  assert.equal(y.latestLeave, null);
  assert.equal(y.firstDate, null);
});

/* 弹性工作制（2026-11-20）：默认关；开启后工作日按「在岗 − 午休 − 晚饭段 − 规定工时」算 */
test('弹性工作制默认关：口径与原来完全一致', () => {
  const r = A.rulesFromWorkTime({});
  assert.equal(r.flex, undefined);
  assert.deepEqual(A.calcRules(r), { amEnd: 540, pmStart: 1080, owePerWorkday: 30 });
  assert.deepEqual(A.rulesFromWorkTime({}, { on: false, coreStart: '08:00' }), r);
});

test('弹性工作制：按在岗时长算，准点上班的人结果与固定制相同，晚到的人不再白得加班', () => {
  const fixed = { rules: A.calcRules(A.rulesFromWorkTime({})) };
  const flex = { rules: A.calcRules(A.rulesFromWorkTime({}, { on: true })) };
  const net = (o, a, b) => A.buildDays([card('2026-11-16', a, b)], o)[0].net;
  assert.equal(net(fixed, '09:00', '20:00'), 90);
  assert.equal(net(flex, '09:00', '20:00'), 90);            // 660 − 午休 60 − 晚饭 30 − 480
  assert.equal(net(fixed, '08:00', '17:00'), 30);           // 固定制：08–09 算早上加班
  assert.equal(net(flex, '08:00', '17:00'), 0);             // 弹性：正好 8 小时
  assert.equal(net(fixed, '10:00', '19:30'), 60);           // 固定制：晚到 1 小时不扣，18 点后照算
  assert.equal(net(flex, '10:00', '19:30'), 0);
  const noDinner = { rules: A.calcRules(A.rulesFromWorkTime({}, { on: true, dinnerBreak: false })) };
  assert.equal(net(noDinner, '10:00', '19:00'), 0);         // 不扣晚饭段时 10–19 正好 8 小时
  const d = A.buildDays([card('2026-11-16', '10:30', '15:00')], flex)[0];
  assert.equal(d.coreLate, true); assert.equal(d.coreEarly, true); assert.equal(d.net, -270);
});

test('弹性工作制：只有一次打卡标缺卡不扣，周末仍整段算加班', () => {
  const flex = { rules: A.calcRules(A.rulesFromWorkTime({}, { on: true })) };
  const one = A.buildDays([card('2026-11-16', '09:00')], flex)[0];
  assert.equal(one.singlePunch, true); assert.equal(one.net, 0); assert.equal(one.owe, 0);
  const sat = A.buildDays([card('2026-11-21', '10:00', '14:00')], flex)[0];
  assert.equal(sat.kind, 'weekend'); assert.equal(sat.net, 240); assert.equal(sat.flex, undefined);
  const s = A.summarize(A.buildDays([card('2026-11-16', '09:00'), card('2026-11-17', '10:30', '20:00')], flex));
  assert.equal(s.singlePunchDays, 1); assert.equal(s.coreMiss, 1);
});

test('弹性工作制：几点能走按今天上班卡累计工时并跳过休息段', () => {
  assert.equal(A.leaveAfterCounted(600, 480, [[750, 810], [1050, 1080]]), 1170);
  assert.equal(A.leaveAfterCounted(800, 60, [[750, 810]]), 870);
  const flex = { rules: A.calcRules(A.rulesFromWorkTime({}, { on: true })) };
  const days = A.buildDays([card('2026-11-16', '09:00', '18:00'), card('2026-11-17', '10:00')], flex);
  const m = A.monthReport(days, '2026-11', '2026-11-17', flex);
  // 今天 10:00 到；每天可加班 = (80h − 已净加班) / 剩余工作日，走的时间 = 10:00 起累计 8h + 可加班
  assert.equal(m.leaveBy, A.leaveAfterCounted(600, 480 + m.perDayAllowance, flex.rules.breaks));
});

test('弹性工作制设置校验', () => {
  assert.equal(A.normalizeFlex({ on: true, coreStart: '16:00', coreEnd: '10:00' }).ok, false);
  assert.equal(A.normalizeFlex({ dailyHours: 0 }).ok, false);
  assert.deepEqual(A.normalizeFlex(undefined).flex, { ...A.DEFAULT_FLEX });
  assert.equal(A.normalizeFlex({ on: true, dailyHours: '7.5' }).flex.dailyHours, 7.5);
});
