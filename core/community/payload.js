'use strict';
// 社区心跳的内容（2026-11-24）：只用「个人」页已经在内存里的统计（core/profile/service.js 的 state）和 Token 账本的现成日合计，
// 不读盘、不扫描，单次构建是几百个日期键上的加法。字段见 core/community/schema.js 的白名单。
const R = require('../profile/rules');
const { ROLES } = require('../hub-pet/state');
const { cleanNick, sanitizePulse } = require('./schema');

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
// 本周一（本地日期，公司电脑即北京时间）。
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

// 只认内置形象；自己下载的、改过名字的都按默认小猫算（自定义名字不上传）。
function petOf(role) {
  const hit = ROLES.find(r => r.id === role) || ROLES[0];
  return { id: hit.id.replace(/^\d+-/, ''), name: hit.name };
}

// 本周经验：本周一到今天每天已入账的经验（每日封顶规则在入账时已经生效）。
function weekXp(days, now) {
  let sum = 0;
  for (let d = mondayOf(now); d <= now; d = addDays(d, 1)) sum += Number(days[dayKey(d)]?.xp) || 0;
  return sum;
}
function weekTokens(dayTokens, now) {
  let sum = 0;
  for (let d = mondayOf(now); d <= now; d = addDays(d, 1)) sum += Number(dayTokens?.[dayKey(d)]) || 0;
  return sum;
}
// 工作日连胜：从今天往回数连续用过的工作日，周末用没用都不打断也不加；今天还没用就从上一个工作日数起。
function workdayStreak(days, now) {
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()), n = 0, first = true;
  for (let guard = 0; guard < 4000; guard++, d = addDays(d, -1)) {
    const wd = d.getDay();
    if (wd === 0 || wd === 6) { first = false; continue; }
    if (days[dayKey(d)]) n++;
    else if (!first) break;
    first = false;
  }
  return n;
}
function activeDays7(days, now) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (days[dayKey(addDays(now, -i))]) n++;
  return n;
}

// 昵称：用户自己设过的就用；否则「桌宠名·编号前 4 位」。绝不回落到身份里的真名。
function nickOf(state, iid, petName) {
  return cleanNick(state && state.nickname) || `${petName}·${String(iid).slice(0, 4).toUpperCase()}`;
}

// state：Profile.state；dayTokens：{ 'YYYY-MM-DD': 当天 Token 合计 }；lastActiveAt：最近一次亲自发消息或开会话的时间戳。
// diag：「后台」自检的当天失败原因计数 { d, c }（main/community-service.js 记），没有就不带。
function buildPayload({ iid, edition, version, state, petRole, dayTokens, lastActiveAt = 0, now = new Date(), diag = null }) {
  const s = state || {}, days = s.days || {}, pet = petOf(petRole);
  const raw = {
    v: 1, iid, ed: edition === 'public' ? 'public' : 'member', ver: String(version || ''),
    nick: nickOf(s, iid, pet.name), pet: pet.id,
    lv: R.levelOf(Number(s.xp) || 0), ach: Object.keys(s.unlocked || {}).length,
    wxp: weekXp(days, now), wtok: weekTokens(dayTokens, now),
    streak: workdayStreak(days, now), act: now.getTime() - (Number(lastActiveAt) || 0) <= ACTIVE_WINDOW_MS ? 1 : 0,
    days7: activeDays7(days, now),
    ...(diag && diag.d === dayKey(now) ? { dg: diag } : {}),
  };
  // 发出去之前也过一遍白名单与钳制：发送端和接收端看到的是同一份。
  return sanitizePulse(raw);
}

module.exports = { buildPayload, petOf, nickOf, weekXp, weekTokens, workdayStreak, activeDays7, mondayOf, dayKey, ACTIVE_WINDOW_MS };
