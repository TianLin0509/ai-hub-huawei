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
  const m = A.monthReport(days, '2026-11', '2026-11-07');
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
  const y = A.yearReport(A.buildDays(RAW), 2026, '2026-11-07');
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
