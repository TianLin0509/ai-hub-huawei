'use strict';
/* 考勤统计：纯函数，不碰文件和网络，主进程与界面共用。
 * 加班口径（默认值，可由设置覆盖）：
 *   - 一天从 05:00 算起，05:00 前的打卡归前一天；
 *   - 额定上班 09:00–12:30、13:30–17:30，共 7.5 小时；
 *   - 工作日 09:00 前（05:00 起）和 18:00 后算加班；
 *   - 规定每天 8 小时，比额定多 0.5 小时，每个出勤工作日扣 0.5 小时，按月统计；
 *   - 周末、法定节假日整段在岗都算加班；月末周六是正常上班日，按工作日算；
 *   - 只算有打卡的时段，同一天离开后又回来，中间不算。
 * 时间统一用「当天 00:00 起的分钟数」，次日凌晨为 1440 以上。 */

const DEFAULT_RULES = Object.freeze({
  dayStart: 300,          // 05:00
  amEnd: 540,             // 09:00 前算早上加班
  pmStart: 1080,          // 18:00 后算晚上加班
  owePerWorkday: 30,      // 每个出勤工作日扣 0.5 小时
  monthCap: 80 * 60,      // 月净加班红线 80 小时
  lastSaturdayIsWorkday: true,
});

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function toMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseDate(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(k || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDay(k, n) {
  const d = parseDate(k);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

function lastSaturday(year, monthIndex) {
  const d = new Date(year, monthIndex + 1, 0);
  while (d.getDay() !== 6) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

/* 日子类型：工作日 / 周末 / 月末周六 / 节假日。holidays、extraWorkdays 为 { 'YYYY-MM-DD': true } */
function dayKind(k, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
  if (opts.extraWorkdays && opts.extraWorkdays[k]) return 'workday';
  const d = parseDate(k);
  const w = d.getDay();
  // 公司假期日历把周末也列成休息日（11-08 真机：31 条里含 11/07 周六）。周末一律按周末 / 月末周六规则算，
  // 假期日历只用来认出落在周一到周五的法定假，免得月末周六被当成假日、整天算加班。
  if (w >= 1 && w <= 5 && opts.holidays && opts.holidays[k]) return 'holiday';
  if (w === 6 && rules.lastSaturdayIsWorkday && k === lastSaturday(d.getFullYear(), d.getMonth())) return 'lastSaturday';
  return w === 0 || w === 6 ? 'weekend' : 'workday';
}

function isWorkKind(kind) { return kind === 'workday' || kind === 'lastSaturday'; }

/* 把系统返回的一条打卡记录统一成 { date, first, last, firstTag, lastTag } */
function normalizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const date = String(r.attendanceDate || r.clockInDate || r.date || '').slice(0, 10);
  if (!parseDate(date)) return null;
  const first = String(r.earlyClockInTime || r.first || '').slice(0, 5);
  const last = String(r.lateClockInTime || r.last || '').slice(0, 5);
  if (toMinutes(first) == null && toMinutes(last) == null) return null;
  const tag = (v) => String(v || '').split(',')[0].trim().slice(0, 1);
  return {
    date,
    first: toMinutes(first) == null ? last : first,
    last: toMinutes(last) == null ? first : last,
    firstTag: tag(r.earlyClockTag || r.firstTag),
    lastTag: tag(r.lateClockTag || r.lastTag),
  };
}

/* 合并：同一天以新抓到的为准（早上抓到的「今天」只有上班卡，第二天会被完整记录覆盖） */
function mergeRecords(existing, incoming, fetchedAt) {
  const by = new Map();
  for (const r of existing || []) if (r && r.date) by.set(r.date, r);
  let added = 0, updated = 0;
  for (const raw of incoming || []) {
    const r = normalizeRecord(raw);
    if (!r) continue;
    const old = by.get(r.date);
    const next = { ...r, fetchedAt: fetchedAt || old?.fetchedAt || null };
    if (!old) added += 1;
    else if (old.first !== r.first || old.last !== r.last || old.firstTag !== r.firstTag || old.lastTag !== r.lastTag) updated += 1;
    else next.fetchedAt = old.fetchedAt || next.fetchedAt;
    by.set(r.date, next);
  }
  const list = [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { list, added, updated };
}

function overlap(a, b, c, d) { return Math.max(0, Math.min(b, d) - Math.max(a, c)); }

/* 逐日计算：05:00 切日后，每天若干段在岗时段，再按口径算加班 */
function buildDays(records, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
  const by = new Map();
  for (const raw of records || []) {
    const r = normalizeRecord(raw);
    if (!r) continue;
    let a = toMinutes(r.first);
    let b = toMinutes(r.last);
    let k = r.date;
    if (b < a) b += 1440;
    if (a < rules.dayStart) { k = shiftDay(k, -1); a += 1440; b += 1440; }
    if (!by.has(k)) by.set(k, { date: k, segs: [] });
    by.get(k).segs.push({ a, b, ta: r.firstTag, tb: r.lastTag, moved: k !== r.date });
  }
  const days = [];
  for (const x of by.values()) {
    x.segs.sort((p, q) => p.a - q.a);
    const kind = dayKind(x.date, opts);
    let span = 0, otAm = 0, otPm = 0, otRest = 0;
    for (const s of x.segs) {
      span += s.b - s.a;
      if (!isWorkKind(kind)) otRest += s.b - s.a;
      else {
        otAm += overlap(s.a, s.b, rules.dayStart, rules.amEnd);
        otPm += overlap(s.a, s.b, rules.pmStart, rules.dayStart + 1440);
      }
    }
    const d = parseDate(x.date);
    const first = x.segs[0];
    const last = x.segs[x.segs.length - 1];
    const ot = otAm + otPm + otRest;
    const owe = isWorkKind(kind) ? rules.owePerWorkday : 0;
    days.push({
      date: x.date, weekday: d.getDay(), weekdayName: WEEK[d.getDay()], kind, segs: x.segs,
      arrive: first.a, leave: last.b, arriveTag: first.ta, leaveTag: last.tb,
      span, otAm, otPm, otRest, ot, owe, net: ot - owe,
      singlePunch: x.segs.length === 1 && first.a === first.b,
      nightReturn: x.segs.some((s) => s.moved),
      manual: x.segs.some((s) => s.ta === '手' || s.tb === '手'),
    });
  }
  return days.sort((p, q) => (p.date < q.date ? 1 : -1));
}

/* 某月应出勤的工作日数（周一到周五 + 月末周六 − 节假日 + 调休上班日） */
function monthWorkdays(year, monthIndex, opts = {}) {
  let n = 0;
  const d = new Date(year, monthIndex, 1);
  while (d.getMonth() === monthIndex) {
    if (isWorkKind(dayKind(dateKey(d), opts))) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

function remainingWorkdays(todayKey, opts = {}) {
  const t = parseDate(todayKey);
  let n = 0;
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  while (d.getMonth() === t.getMonth()) {
    if (isWorkKind(dayKind(dateKey(d), opts))) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

function summarize(days) {
  const r = { days: days.length, workdays: 0, restDays: 0, span: 0, am: 0, pm: 0, rest: 0, gross: 0, owe: 0, net: 0, late22: 0, leaveSum: 0, arriveSum: 0 };
  for (const x of days) {
    r.span += x.span; r.am += x.otAm; r.pm += x.otPm; r.rest += x.otRest; r.gross += x.ot; r.owe += x.owe;
    if (isWorkKind(x.kind)) {
      r.workdays += 1; r.leaveSum += x.leave; r.arriveSum += x.arrive;
      if (x.leave >= 22 * 60) r.late22 += 1;
    } else r.restDays += 1;
  }
  r.net = r.gross - r.owe;
  r.avgLeave = r.workdays ? r.leaveSum / r.workdays : null;
  r.avgArrive = r.workdays ? r.arriveSum / r.workdays : null;
  r.avgNetPerWorkday = r.workdays ? r.net / r.workdays : 0;
  r.convertedDaily = r.workdays ? 8 * 60 + r.avgNetPerWorkday : 0;
  r.equivalentDays = r.net / 480;
  return r;
}

/* 当月统计 + 80 小时红线推算 */
function monthReport(days, ym, todayKey, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
  const list = days.filter((x) => x.date.slice(0, 7) === ym);
  const s = summarize(list);
  const [y, m] = ym.split('-').map(Number);
  const total = monthWorkdays(y, m - 1, opts);
  const isCurrent = todayKey && todayKey.slice(0, 7) === ym;
  const left = isCurrent ? remainingWorkdays(todayKey, opts) : 0;
  const projected = isCurrent ? s.net + s.avgNetPerWorkday * left : s.net;
  const budget = rules.monthCap - s.net;
  const perDay = left > 0 ? budget / left : null;
  const amAvg = s.workdays ? s.am / s.workdays : 0;
  const leaveBy = perDay != null && perDay >= 0 ? rules.pmStart + perDay + rules.owePerWorkday - amAvg : null;
  return {
    ym, ...s, monthWorkdays: total, leftWorkdays: left, projected, cap: rules.monthCap,
    over: s.net > rules.monthCap, willExceed: projected > rules.monthCap,
    budget, perDayAllowance: perDay, leaveBy, days: list,
  };
}

/* 年度统计：逐月净加班、超红线月份、全年合计和几个「有意思」的数 */
function yearReport(days, year, todayKey, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
  const list = days.filter((x) => x.date.slice(0, 4) === String(year));
  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const md = list.filter((x) => x.date.slice(0, 7) === ym);
    if (!md.length) { months.push({ ym, month: m, hasData: false }); continue; }
    const s = summarize(md);
    months.push({ ym, month: m, hasData: true, net: s.net, gross: s.gross, workdays: s.workdays, coveredDays: md.length, over: s.net > rules.monthCap });
  }
  const s = summarize(list);
  const withData = months.filter((m) => m.hasData);
  const peak = withData.reduce((a, m) => (!a || m.net > a.net ? m : a), null);
  const latest = list.reduce((a, x) => (!a || x.leave > a.leave ? x : a), null);
  const weekdayLeave = [0, 0, 0, 0, 0, 0, 0].map(() => ({ n: 0, sum: 0 }));
  for (const x of list) if (x.kind === 'workday') { weekdayLeave[x.weekday].n += 1; weekdayLeave[x.weekday].sum += x.leave; }
  let busiestWeekday = null;
  weekdayLeave.forEach((v, i) => { if (v.n >= 2 && (!busiestWeekday || v.sum / v.n > busiestWeekday.avgLeave)) busiestWeekday = { weekday: i, name: WEEK[i], avgLeave: v.sum / v.n }; });
  return {
    year: Number(year), ...s, months, monthsWithData: withData.length,
    overMonths: withData.filter((m) => m.over).length,
    peakMonth: peak, latestLeave: latest ? { date: latest.date, leave: latest.leave } : null,
    busiestWeekday, firstDate: list.length ? list[list.length - 1].date : null,
  };
}

function fmtHours(min, digits = 1) { return (min / 60).toFixed(digits); }
function fmtHm(min) {
  const v = Math.round(Math.abs(min));
  return `${min < 0 ? '−' : ''}${Math.floor(v / 60)}h${String(v % 60).padStart(2, '0')}`;
}
function fmtClock(min) {
  if (min == null) return '—';
  const v = Math.round(min) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

module.exports = {
  DEFAULT_RULES, WEEK, toMinutes, parseDate, dateKey, shiftDay, lastSaturday, dayKind, isWorkKind,
  normalizeRecord, mergeRecords, buildDays, monthWorkdays, remainingWorkdays, summarize,
  monthReport, yearReport, fmtHours, fmtHm, fmtClock,
};
