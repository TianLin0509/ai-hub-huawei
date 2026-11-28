'use strict';
// 会议室抢订节奏（2026-11-14）：不同园区放号规则不同——多数园区提前 7 天放号，
// 成都园区提前 3 天、08:30 放号。这里只做纯计算：推断园区、合出生效规则、算开抢时刻与目标日期。
// 开箱即用：默认 7 天、沿用组件里的开放时刻；能从会议室名称或日程地点认出园区就套用已知规则；
// 都认不出才请用户在抢订页就地确认两项。

const DEFAULT_ADVANCE_DAYS = 7;
const DEFAULT_OPEN_TIME = '12:00:00';
// 提前天数上限（2026-11-28 放宽到 120，约 4 个月）：Hub 里唯一的取值来源，界面输入框的上限由状态带过去；
// 会议室组件 hub_control.py 里的 ADVANCE_DAYS_MAX 必须与它一致（单测核对）。
const MIN_DAYS = 1, MAX_DAYS = 120;
// 只报「advance-days」、没报自己上限的旧组件（2.1.6 及以前）只认 1–14 天。
const LEGACY_COMPONENT_MAX_DAYS = 14;
// 已知园区规则；没列出的园区按默认 7 天、沿用组件里的开放时刻。
const CAMPUS_RULES = [
  { id: 'chengdu', name: '成都', advanceDays: 3, openTime: '08:30:00', match: /成都|chengdu/i },
];
// 认得出名字、但按默认规则抢的园区：用来判断「认出了园区」，不必再请用户确认。
const KNOWN_DEFAULT = [
  { id: 'shanghai', name: '上海', match: /上海|shanghai/i },
  { id: 'shenzhen', name: '深圳', match: /深圳|坂田|shenzhen/i },
  { id: 'dongguan', name: '东莞', match: /东莞|松山湖|dongguan/i },
  { id: 'beijing', name: '北京', match: /北京|beijing/i },
  { id: 'hangzhou', name: '杭州', match: /杭州|hangzhou/i },
  { id: 'nanjing', name: '南京', match: /南京|nanjing/i },
  { id: 'xian', name: '西安', match: /西安|xi'?an/i },
  { id: 'wuhan', name: '武汉', match: /武汉|wuhan/i },
];

const pad = n => String(n).padStart(2, '0');
function normalizeOpenTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value || '').trim());
  return m ? `${m[1]}:${m[2]}:${m[3] || '00'}` : null;
}
function validDays(value) { return Number.isInteger(value) && value >= MIN_DAYS && value <= MAX_DAYS; }

// 从已有资料推断园区：优先会议室名称最可靠（就是要抢的那几间），其次是近期日程的会议地点。
// 多个园区都出现时取出现次数最多的；会议室名称每条按 3 票计。
function inferCampus({ rooms = [], locations = [] } = {}) {
  const all = [...CAMPUS_RULES, ...KNOWN_DEFAULT], votes = new Map();
  const add = (text, weight, from) => {
    for (const c of all) if (c.match.test(String(text || ''))) {
      const v = votes.get(c.id) || { campus: c, score: 0, from };
      v.score += weight; votes.set(c.id, v);
    }
  };
  for (const r of rooms) add(r, 3, 'rooms');
  for (const l of locations) add(l, 1, 'meetings');
  const best = [...votes.values()].sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return { id: best.campus.id, name: best.campus.name, from: best.from };
}

function campusRule(id) { return CAMPUS_RULES.find(c => c.id === id) || null; }

// 合出生效规则：用户自己设过的优先，其次是认出的园区，最后是默认。
// saved：settings.rooms.schedule = { advanceDays, openTime, confirmed }
function resolveSchedule({ saved = {}, inferred = null, componentOpenTime = null } = {}) {
  const fallbackOpen = normalizeOpenTime(componentOpenTime) || DEFAULT_OPEN_TIME;
  const rule = inferred ? campusRule(inferred.id) : null;
  const base = rule ? { advanceDays: rule.advanceDays, openTime: rule.openTime }
    : { advanceDays: DEFAULT_ADVANCE_DAYS, openTime: fallbackOpen };
  const manual = saved && saved.confirmed && validDays(saved.advanceDays) && normalizeOpenTime(saved.openTime);
  const out = manual ? { advanceDays: saved.advanceDays, openTime: normalizeOpenTime(saved.openTime), source: 'manual' }
    : { ...base, source: inferred ? 'campus' : 'default' };
  return { ...out, campus: inferred ? inferred.name : '', campusFrom: inferred ? inferred.from : '',
    // 认不出园区、用户也没确认过：照默认能跑，但开抢前请用户就地确认一次。
    needsConfirm: !manual && !inferred };
}

// 下一次开抢时刻（本地时间）：今天的开放时刻还没到就是今天，否则明天。
function nextOpenAt(now, openTime) {
  const t = normalizeOpenTime(openTime) || DEFAULT_OPEN_TIME, [h, m, s] = t.split(':').map(Number);
  const d = new Date(now), today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s);
  return now < today.getTime() ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, s);
}
// 开放日 + 提前天数 = 目标日期（按日历日加，跨月跨年由 Date 处理）。
function targetDateFor(openAt, advanceDays) {
  const d = new Date(openAt);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + advanceDays);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
// Hub 自动拉起守护的时间窗：开放前 30 分钟到开放时刻。
function autoStartWindow(openTime) {
  const [h, m] = (normalizeOpenTime(openTime) || DEFAULT_OPEN_TIME).split(':').map(Number), open = h * 60 + m;
  return { from: Math.max(0, open - 30), to: open };
}
function describe(schedule) {
  const open = String(schedule.openTime || '').slice(0, 5);
  const who = schedule.source === 'manual' ? '按你设置的规则' : schedule.source === 'campus' ? `按${schedule.campus}园区规则` : '按默认规则';
  return `${who}：每天 ${open} 放号，抢 ${schedule.advanceDays} 天后的会议室`;
}

module.exports = { DEFAULT_ADVANCE_DAYS, DEFAULT_OPEN_TIME, MIN_DAYS, MAX_DAYS, LEGACY_COMPONENT_MAX_DAYS, CAMPUS_RULES,
  normalizeOpenTime, validDays, inferCampus, resolveSchedule, nextOpenAt, targetDateFor, autoStartWindow, describe };
