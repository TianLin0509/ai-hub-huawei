'use strict';
/* 考勤统计：纯函数，不碰文件和网络，主进程与界面共用。
 * 加班口径（默认值，可由设置覆盖）：
 *   - 一天从 05:00 算起，05:00 前的打卡归前一天；
 *   - 额定上班 09:00–12:30、13:30–17:30，共 7.5 小时；
 *   - 工作日 09:00 前（05:00 起）和 18:00 后算加班；
 *   - 规定每天 8 小时，比额定多 0.5 小时，每个出勤工作日扣 0.5 小时，按月统计；
 *   - 周末、法定节假日在岗都算加班，但扣掉午休（12:30–13:30）和晚饭（17:30–18:00）时段，和公司考勤系统一致；
 *     月末周六是正常上班日，按工作日算；
 *   - 只算有打卡的时段，同一天离开后又回来，中间不算。
 * 弹性工作制（可选，默认关）见 DEFAULT_FLEX 处说明。
 * 时间统一用「当天 00:00 起的分钟数」，次日凌晨为 1440 以上。 */

const DEFAULT_RULES = Object.freeze({
  dayStart: 300,          // 05:00
  amEnd: 540,             // 09:00 前算早上加班
  pmStart: 1080,          // 18:00 后算晚上加班
  owePerWorkday: 30,      // 每个出勤工作日扣 0.5 小时
  monthCap: 80 * 60,      // 月净加班红线 80 小时
  lastSaturdayIsWorkday: true,
  restBreaks: [[750, 810], [1050, 1080]], // 周末、节假日不计加班的休息段：午休、晚饭
});

// 核心工作时间（用户可在考勤设置里改，各公司、各人不一样）。加班口径由它推出：
//   上班前算早上加班；「晚上加班起算」之后算晚上加班（默认下班后 30 分钟）；
//   规定每天 8 小时，额定上班不足 8 小时的差额每个出勤工作日扣掉。
const DEFAULT_WORK_TIME = Object.freeze({ amStart: '09:00', amEnd: '12:30', pmStart: '13:30', pmEnd: '17:30', eveningFrom: '18:00' });
const REQUIRED_DAILY = 8 * 60;

function clockText(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
// 校验并补齐；不合理时 ok=false 并说明哪里不对。
function normalizeWorkTime(w = {}) {
  const t = {};
  for (const key of Object.keys(DEFAULT_WORK_TIME)) {
    const m = toMinutes(w[key] ?? DEFAULT_WORK_TIME[key]);
    t[key] = m == null || m >= 1440 ? toMinutes(DEFAULT_WORK_TIME[key]) : m;
  }
  // 没单独填晚上加班起算时，跟着下班时间走：下班后 30 分钟。
  if (w.eveningFrom == null || w.eveningFrom === '') t.eveningFrom = Math.min(1439, t.pmEnd + 30);
  const order = [['amStart', 'amEnd', '上午上班要早于上午下班'], ['amEnd', 'pmStart', '午休结束不能早于午休开始'], ['pmStart', 'pmEnd', '下午上班要早于下午下班'], ['pmEnd', 'eveningFrom', '晚上加班起算不能早于下班']];
  let error = '';
  if (t.amStart < 300) error = '上班时间不能早于 05:00（05:00 前算前一天）';
  for (const [a, b, msg] of order) if (!error && (a === 'amEnd' || a === 'pmEnd' ? t[a] > t[b] : t[a] >= t[b])) error = msg;
  const text = {};
  for (const key of Object.keys(t)) text[key] = clockText(t[key]);
  return { ok: !error, error, workTime: text, minutes: t };
}
// 弹性工作制（2026-11-20，反馈「考勤不适用弹性工作制」）：默认关。开启后工作日不再看「几点前 / 几点后」，
// 而是「当天在岗时长 − 不计工时的休息段 − 每日规定工时」= 当天净加班（可为负）；核心时段只用来标出没覆盖到的日子。
// 休息段：午休（核心工作时间里的上午下班–下午上班）一律不计；晚饭段（下午下班–晚上加班起算）可选，默认也不计，
// 这样按 09:00 准点上班的人，开不开弹性结果一样。周末、节假日仍整段算加班。
const DEFAULT_FLEX = Object.freeze({ on: false, coreStart: '10:00', coreEnd: '16:00', dailyHours: 8, dinnerBreak: true });
function normalizeFlex(f = {}) {
  const src = f && typeof f === 'object' ? f : {};
  const cs = toMinutes(src.coreStart ?? DEFAULT_FLEX.coreStart), ce = toMinutes(src.coreEnd ?? DEFAULT_FLEX.coreEnd);
  const hours = Number(src.dailyHours ?? DEFAULT_FLEX.dailyHours);
  let error = '';
  if (cs == null || ce == null || cs >= 1440 || ce >= 1440) error = '核心时段要填成 时:分';
  else if (cs >= ce) error = '核心时段的开始要早于结束';
  else if (cs < 300) error = '核心时段不能早于 05:00（05:00 前算前一天）';
  else if (!Number.isFinite(hours) || hours < 1 || hours > 16) error = '每日工时要在 1 到 16 小时之间';
  const okVals = !error;
  const flex = {
    on: !!src.on,
    coreStart: okVals ? clockText(cs) : DEFAULT_FLEX.coreStart,
    coreEnd: okVals ? clockText(ce) : DEFAULT_FLEX.coreEnd,
    dailyHours: okVals ? Math.round(hours * 4) / 4 : DEFAULT_FLEX.dailyHours,
    dinnerBreak: src.dinnerBreak === undefined ? DEFAULT_FLEX.dinnerBreak : !!src.dinnerBreak,
  };
  return { ok: okVals, error, flex };
}

function rulesFromWorkTime(w, flexIn) {
  const n = normalizeWorkTime(w);
  const t = n.ok ? n.minutes : normalizeWorkTime(DEFAULT_WORK_TIME).minutes;
  const rated = (t.amEnd - t.amStart) + (t.pmEnd - t.pmStart);
  // 周末、节假日加班扣掉的休息段（2026-11-20 反馈：加班日 09:06–18:08，公司考勤系统算 7.53 小时 = 9h02 − 午休 1h − 晚饭 0.5h）。
  // 跟着核心工作时间走：午休 = 上午下班–下午上班，晚饭 = 下午下班–晚上加班起算。
  const restBreaks = [[t.amEnd, t.pmStart], [t.pmEnd, t.eveningFrom]].filter(([a, b]) => b > a);
  const base = { amEnd: t.amStart, pmStart: t.eveningFrom, owePerWorkday: Math.max(0, REQUIRED_DAILY - rated), ratedMinutes: rated, restBreaks, workTime: n.ok ? n.workTime : { ...DEFAULT_WORK_TIME } };
  const f = normalizeFlex(flexIn).flex;
  if (!f.on) return base;
  const breaks = [[t.amEnd, t.pmStart]];
  if (f.dinnerBreak && t.eveningFrom > t.pmEnd) breaks.push([t.pmEnd, t.eveningFrom]);
  return { ...base, flex: true, flexSettings: f, coreStart: toMinutes(f.coreStart), coreEnd: toMinutes(f.coreEnd), dailyRequired: Math.round(f.dailyHours * 60), breaks: breaks.filter(([a, b]) => b > a) };
}
// 计算用的口径子集（界面和后台红线提醒共用，免得两处各拼一份漏掉弹性字段）。
function calcRules(r = {}) {
  const out = { amEnd: r.amEnd, pmStart: r.pmStart, owePerWorkday: r.owePerWorkday };
  if (Array.isArray(r.restBreaks)) out.restBreaks = r.restBreaks;
  if (r.flex) Object.assign(out, { flex: true, coreStart: r.coreStart, coreEnd: r.coreEnd, dailyRequired: r.dailyRequired, breaks: r.breaks || [] });
  return out;
}
// 某段在岗时间里扣掉休息段后实际计工时的分钟数。
function countedMinutes(a, b, breaks = []) {
  let v = Math.max(0, b - a);
  for (const [p, q] of breaks) v -= overlap(a, b, p, q);
  return Math.max(0, v);
}
// 从 start 起要累计 need 分钟计工时，跳过休息段，最早几点能走。
function leaveAfterCounted(start, need, breaks = []) {
  let t = start, left = Math.max(0, need);
  const bs = breaks.slice().sort((x, y) => x[0] - y[0]);
  for (const [p, q] of bs) {
    if (q <= t) continue;
    if (p > t) { const run = p - t; if (run >= left) return t + left; left -= run; }
    t = Math.max(t, q);
  }
  return t + left;
}

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
    const first = x.segs[0];
    const last = x.segs[x.segs.length - 1];
    const singlePunch = x.segs.length === 1 && first.a === first.b;
    const flexDay = !!rules.flex && isWorkKind(kind);
    let span = 0, otAm = 0, otPm = 0, otRest = 0, worked = 0;
    for (const s of x.segs) {
      span += s.b - s.a;
      if (!isWorkKind(kind)) otRest += countedMinutes(s.a, s.b, rules.restBreaks);
      else if (flexDay) worked += countedMinutes(s.a, s.b, rules.breaks);
      else {
        otAm += overlap(s.a, s.b, rules.dayStart, rules.amEnd);
        otPm += overlap(s.a, s.b, rules.pmStart, rules.dayStart + 1440);
      }
    }
    const d = parseDate(x.date);
    let ot, owe, extra = {};
    if (flexDay) {
      // 只有一次打卡时算不出在岗时长：不计加班也不扣，单独标「缺卡」，免得一天扣满 8 小时。
      const diff = singlePunch ? 0 : worked - rules.dailyRequired;
      ot = Math.max(0, diff); owe = Math.max(0, -diff);
      extra = { worked, required: singlePunch ? 0 : rules.dailyRequired, flex: true,
        coreLate: !singlePunch && first.a > rules.coreStart, coreEarly: !singlePunch && last.b < rules.coreEnd };
    } else {
      ot = otAm + otPm + otRest;
      owe = isWorkKind(kind) ? rules.owePerWorkday : 0;
    }
    days.push({
      date: x.date, weekday: d.getDay(), weekdayName: WEEK[d.getDay()], kind, segs: x.segs,
      arrive: first.a, leave: last.b, arriveTag: first.ta, leaveTag: last.tb,
      span, otAm, otPm, otRest, ot, owe, net: ot - owe,
      singlePunch,
      nightReturn: x.segs.some((s) => s.moved),
      manual: x.segs.some((s) => s.ta === '手' || s.tb === '手'),
      ...extra,
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
  // 汇总尚未结算今天，剩余预算也要包含今天。
  while (d.getMonth() === t.getMonth()) {
    if (isWorkKind(dayKind(dateKey(d), opts))) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

// 先按 05:00 规则归属日期，再排除今天及未来；原始打卡保留供后续补全。
function completedDays(days, todayKey) {
  return todayKey ? days.filter((x) => x.date < todayKey) : days;
}

function summarize(days) {
  const r = { days: days.length, workdays: 0, restDays: 0, span: 0, am: 0, pm: 0, rest: 0, gross: 0, owe: 0, net: 0, late22: 0, leaveSum: 0, arriveSum: 0, worked: 0, coreMiss: 0, singlePunchDays: 0 };
  for (const x of days) {
    r.span += x.span; r.am += x.otAm; r.pm += x.otPm; r.rest += x.otRest; r.gross += x.ot; r.owe += x.owe;
    if (isWorkKind(x.kind)) {
      r.workdays += 1; r.leaveSum += x.leave; r.arriveSum += x.arrive;
      if (x.leave >= 22 * 60) r.late22 += 1;
      if (x.flex) { r.worked += x.worked || 0; if (x.coreLate || x.coreEarly) r.coreMiss += 1; if (x.singlePunch) r.singlePunchDays += 1; }
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
  const list = completedDays(days, todayKey).filter((x) => x.date.slice(0, 7) === ym);
  const s = summarize(list);
  const [y, m] = ym.split('-').map(Number);
  const total = monthWorkdays(y, m - 1, opts);
  const isCurrent = todayKey && todayKey.slice(0, 7) === ym;
  const left = isCurrent ? remainingWorkdays(todayKey, opts) : 0;
  const projected = isCurrent ? s.net + s.avgNetPerWorkday * left : s.net;
  const budget = rules.monthCap - s.net;
  const perDay = left > 0 ? budget / left : null;
  const amAvg = s.workdays ? s.am / s.workdays : 0;
  let leaveBy = perDay != null && perDay >= 0 ? rules.pmStart + perDay + rules.owePerWorkday - amAvg : null;
  // 弹性制：今天几点走取决于几点到。今天已有上班卡就按它，没有就按本月平均到岗，再累计「规定工时 + 每天可加班」并跳过休息段。
  if (rules.flex && leaveBy != null) {
    const todayRec = isCurrent ? (days || []).find((x) => x.date === todayKey) : null;
    const arrive = todayRec ? todayRec.arrive : s.avgArrive;
    leaveBy = arrive == null ? null : leaveAfterCounted(arrive, rules.dailyRequired + perDay, rules.breaks);
  }
  return {
    ym, ...s, monthWorkdays: total, leftWorkdays: left, projected, cap: rules.monthCap,
    over: s.net > rules.monthCap, willExceed: projected > rules.monthCap,
    budget, perDayAllowance: perDay, leaveBy, days: list,
  };
}

/* 年度统计：逐月净加班、超红线月份、全年合计和几个「有意思」的数 */
function yearReport(days, year, todayKey, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
  const list = completedDays(days, todayKey).filter((x) => x.date.slice(0, 4) === String(year));
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
  DEFAULT_RULES, DEFAULT_WORK_TIME, DEFAULT_FLEX, normalizeWorkTime, normalizeFlex, rulesFromWorkTime, calcRules, countedMinutes, leaveAfterCounted, WEEK, toMinutes, parseDate, dateKey, shiftDay, lastSaturday, dayKind, isWorkKind,
  normalizeRecord, mergeRecords, buildDays, monthWorkdays, remainingWorkdays, completedDays, summarize,
  monthReport, yearReport, fmtHours, fmtHm, fmtClock,
};
