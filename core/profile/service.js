'use strict';
// 「个人」页的数据内核（2026-11-12）：把每天的使用记成经验，算等级、成就、连续天数与桌宠亲密度。
// 数据只存本机 <数据目录>/profile/profile.json，不上传、不做排行。主进程在各功能入口调 record()，页面读 snapshot()。
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { writeFileAtomic } = require('../atomic-write');
const R = require('./rules');

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const keyToDate = k => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
const shiftKey = (k, delta) => { const d = keyToDate(k); d.setDate(d.getDate() + delta); return dayKey(d); };
const blank = () => ({ v: 1, firstDay: '', xp: 0, days: {}, features: {}, unlocked: {}, fresh: {}, pet: { pets: 0, days: 0, lastDay: '' }, tokens: 0, nickname: '', identity: null, backfill: null, lastLevel: 1 });

const clone = o => JSON.parse(JSON.stringify(o));
const hydrate = s => ({ ...blank(), ...s, pet: { ...blank().pet, ...(s.pet || {}) } });

// 多个 Hub 窗口共用一份数据（产品约定）：存盘前重读文件，把本窗口自上次同步以来的增量加到文件里的最新值上，不整份覆盖。
// disk 是文件里的最新状态，mine 是本窗口内存里的，base 是本窗口上次读到或写下的。
function mergeState(disk, mine, base) {
  const out = clone(disk);
  const add = (a, b, c) => (Number(a) || 0) + ((Number(b) || 0) - (Number(c) || 0));
  for (const [k, d] of Object.entries(mine.days)) {
    const b = base.days[k] || {};
    // 两个窗口各自回溯了同一天：只留一份
    if (d.back && disk.days[k] && !base.days[k]) continue;
    const o = out.days[k] || (out.days[k] = {});
    for (const f of ['xp', 'p', 't', 's', 'pet']) { const v = add(o[f], d[f], b[f]); if (v) o[f] = v; }
    for (const f of ['open', 'night', 'early', 'back']) if (d[f]) o[f] = 1;
    if (d.f) { o.f = o.f || {}; for (const [id, n] of Object.entries(d.f)) o.f[id] = add(o.f[id], n, b.f && b.f[id]); }
  }
  for (const [id, f] of Object.entries(mine.features)) {
    const o = out.features[id] || (out.features[id] = { first: f.first, count: 0 }), b = base.features[id] || {};
    o.count = add(o.count, f.count, b.count);
    if (f.first && (!o.first || f.first < o.first)) o.first = f.first;
  }
  for (const [id, at] of Object.entries(mine.unlocked)) {
    if (base.unlocked[id]) continue;
    if (out.unlocked[id]) {
      // 两个窗口都解锁了同一枚：成就经验只算一次，把本窗口多拿的那份退掉
      const a = R.ACHIEVEMENTS.find(x => x.id === id), day = out.days[dayKey(new Date(at))];
      if (a && day) day.xp = Math.max(0, (day.xp || 0) - R.TIER_XP[a.tier]);
      out.unlocked[id] = Math.min(out.unlocked[id], at);
    } else out.unlocked[id] = at;
  }
  for (const id of Object.keys(mine.fresh)) if (!base.fresh[id]) out.fresh[id] = 1;
  for (const id of Object.keys(base.fresh)) if (!mine.fresh[id]) delete out.fresh[id];
  out.pet.pets = add(out.pet.pets, mine.pet.pets, base.pet.pets);
  out.pet.days = add(out.pet.days, mine.pet.days, base.pet.days);
  if ((mine.pet.lastDay || '') > (out.pet.lastDay || '')) out.pet.lastDay = mine.pet.lastDay;
  out.tokens = Math.max(out.tokens || 0, mine.tokens || 0);
  for (const key of ['nickname', 'identity']) if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) out[key] = mine[key];
  if (mine.backfill) out.backfill = { ...(out.backfill || {}), ...mine.backfill, ledger: !!(mine.backfill.ledger || (out.backfill && out.backfill.ledger)) };
  if (mine.firstDay && (!out.firstDay || mine.firstDay < out.firstDay)) out.firstDay = mine.firstDay;
  out.lastLevel = Math.max(out.lastLevel || 1, mine.lastLevel || 1);
  out.xp = Object.values(out.days).reduce((sum, d) => sum + (d.xp || 0), 0);
  return out;
}

class Profile extends EventEmitter {
  constructor({ dataDir, now = () => new Date(), saveDelayMs = 1500 } = {}) {
    super();
    this.dir = path.join(dataDir, 'profile');
    this.file = path.join(this.dir, 'profile.json');
    this.now = now; this.saveDelayMs = saveDelayMs; this.saveTimer = null;
    this.available = new Set(['chat']);
    this.state = this.load();
    this.base = clone(this.state); this.baseText = JSON.stringify(this.state);
  }

  load() {
    for (const file of [this.file, this.file + '.bak']) {
      try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && typeof s === 'object' && s.days) return hydrate(s); } catch { /* 没有或损坏：试备份，再不行从头记 */ }
    }
    return blank();
  }
  save() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    // 别的窗口这期间写过：把本窗口的增量并到文件里的最新状态上
    let merged = false;
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      if (text !== this.baseText) { const disk = JSON.parse(text); if (disk && typeof disk === 'object' && disk.days) { this.state = mergeState(hydrate(disk), this.state, this.base); merged = true; } }
    } catch { /* 还没有文件，或读到一半：按本窗口的写 */ }
    const text = JSON.stringify(this.state);
    if (merged || text !== this.baseText) writeFileAtomic(fs, this.file, text, { backup: true });
    this.base = clone(this.state); this.baseText = text;
    if (merged) this.emit('changed');
  }
  touch() {
    if (this.saveDelayMs <= 0) { this.save(); return; }
    if (!this.saveTimer) { this.saveTimer = setTimeout(() => { try { this.save(); } catch (error) { console.error('[profile] 保存失败：', error.message); } }, this.saveDelayMs); this.saveTimer.unref?.(); }
  }
  flush() { if (this.saveTimer) this.save(); }

  // 本版本接上了哪些功能：决定「用过的功能 n/N」的 N，以及哪些成就显示。
  registerFeature(id) { if (R.FEATURES[id]) this.available.add(id); }

  today() {
    const key = dayKey(this.now()), s = this.state;
    if (!s.days[key]) s.days[key] = { xp: 0 };
    if (!s.firstDay || key < s.firstDay) s.firstDay = key;
    return s.days[key];
  }
  gain(day, amount) { if (amount > 0) { day.xp = (day.xp || 0) + amount; this.state.xp += amount; } return amount; }

  // 记一次使用。type：open / prompt / turn / session / feature / pet。返回这次拿到的经验。
  record(type, meta = {}) {
    const s = this.state, at = this.now(), key = dayKey(at);
    const isNewDay = !s.days[key] || !s.days[key].open;
    const day = this.today();
    let got = 0;
    if (isNewDay) {
      day.open = 1;
      got += this.gain(day, R.XP.open.each + R.XP.streak.each * Math.min(R.XP.streak.cap, this.streak(key)));
    }
    const hour = at.getHours();
    const capped = (field, rule) => { day[field] = (day[field] || 0) + 1; return day[field] <= rule.cap ? this.gain(day, rule.each) : 0; };
    if (type === 'prompt') {
      got += capped('p', R.XP.prompt);
      if (hour >= 23 || hour < 4) day.night = 1;
      if (hour >= 6 && hour < 8) day.early = 1;
      got += this.useFeature(day, 'chat');
      if (meta.skill) got += this.useFeature(day, 'skill');
    } else if (type === 'turn') got += capped('t', R.XP.turn);
    else if (type === 'session') got += capped('s', R.XP.session);
    else if (type === 'feature') got += this.useFeature(day, meta.id);
    else if (type === 'pet') {
      got += capped('pet', R.XP.pet); s.pet.pets += 1;
      got += this.useFeature(day, 'pet');
    }
    this.settle();
    this.touch();
    this.emit('changed');
    return got;
  }
  useFeature(day, id) {
    if (!R.FEATURES[id]) return 0;
    const s = this.state; let got = 0;
    this.available.add(id);
    const rec = s.features[id] || (s.features[id] = { first: dayKey(this.now()), count: 0 });
    if (rec.count === 0) got += this.gain(day, R.XP.featureFirst.each);
    rec.count += 1;
    day.f = day.f || {};
    if (!day.f[id]) got += this.gain(day, R.XP.feature.each);
    day.f[id] = (day.f[id] || 0) + 1;
    return got;
  }
  // 桌宠今天在桌面上陪着：每天记一次，算进亲密度。
  petCompany() {
    const key = dayKey(this.now()), pet = this.state.pet;
    if (pet.lastDay === key) return;
    pet.lastDay = key; pet.days += 1; this.touch();
  }

  // 到 key 这天为止的连续使用天数（当天没用过就从前一天算起）。
  streak(key = dayKey(this.now())) {
    const days = this.state.days; let k = days[key] ? key : shiftKey(key, -1), n = 0;
    while (days[k]) { n++; k = shiftKey(k, -1); }
    return n;
  }

  stats() {
    const s = this.state, days = s.days, keys = Object.keys(days).sort();
    const out = { prompts: 0, turns: 0, sessions: 0, activeDays: keys.length, nightDays: 0, earlyDays: 0, weekendDays: 0, maxDayPrompts: 0, maxDaySessions: 0, bestStreak: 0 };
    let run = 0, prev = '';
    for (const k of keys) {
      const d = days[k];
      out.prompts += d.p || 0; out.turns += d.t || 0; out.sessions += d.s || 0;
      if (d.night) out.nightDays++;
      if (d.early) out.earlyDays++;
      const wd = keyToDate(k).getDay(); if (wd === 0 || wd === 6) out.weekendDays++;
      if (!d.back) { out.maxDayPrompts = Math.max(out.maxDayPrompts, d.p || 0); out.maxDaySessions = Math.max(out.maxDaySessions, d.s || 0); }
      run = prev && shiftKey(prev, 1) === k ? run + 1 : 1; prev = k;
      out.bestStreak = Math.max(out.bestStreak, run);
    }
    out.streak = this.streak();
    out.tokens = s.tokens || 0;
    out.features = Object.fromEntries(Object.entries(s.features).map(([id, v]) => [id, v.count || 0]));
    out.featuresUsed = Object.keys(s.features).filter(id => s.features[id].count > 0 && this.available.has(id)).length;
    out.featuresAvail = this.available.size;
    out.petPets = s.pet.pets || 0; out.petDays = s.pet.days || 0;
    out.level = R.levelOf(s.xp);
    out.joinDays = s.firstDay ? Math.round((keyToDate(dayKey(this.now())) - keyToDate(s.firstDay)) / 86400000) + 1 : 1;
    return out;
  }

  // 结算成就与升级。silent 时只入账、不发庆祝事件（历史回溯用）。
  settle({ silent = false } = {}) {
    const s = this.state, got = [];
    for (let round = 0; round < 4; round++) {
      const stats = this.stats(); let any = false;
      for (const a of R.ACHIEVEMENTS) {
        if (s.unlocked[a.id] || (a.need && !this.available.has(a.need))) continue;
        if (a.metric(stats) >= R.goalOf(a, stats)) {
          s.unlocked[a.id] = this.now().getTime(); s.fresh[a.id] = 1;
          this.gain(this.today(), R.TIER_XP[a.tier]);
          got.push({ id: a.id, name: a.name, desc: a.desc, tier: a.tier, icon: a.icon }); any = true;
        }
      }
      if (!any) break;
    }
    const level = R.levelOf(s.xp), from = s.lastLevel || 1;
    s.lastLevel = level;
    if (silent) return;
    if (got.length) this.emit('achievement', { list: got });
    if (level > from) {
      const rank = R.rankOf(level), before = R.rankOf(from);
      const perks = R.PET_PERKS.filter(p => p.level > from && p.level <= level);
      this.emit('level-up', { from, to: level, rank, rankUp: rank.n > before.n, perks });
    }
  }

  // 历史回溯：把装这个功能之前的活跃日补记成经验（只做一次）。activeDays 是有用量的日期，sessionDays 是每天新建的会话数。
  backfill({ activeDays = [], sessionDays = {}, ledger = false } = {}) {
    const s = this.state, first = !s.backfill;
    // Token 账本可能比会话文件晚几分钟才有：账本到了再补一次，已经记过的日子不重复
    if (!first && (s.backfill.ledger || !ledger)) return s.backfill;
    const todayK = dayKey(this.now()); let days = 0, sessions = 0;
    // 装上这个功能的当天、在它启动之前已经建的会话：补进今天的会话数（只在第一次回溯时补，不给经验）
    if (first && sessionDays[todayK] > 0) { const day = this.today(); day.s = Math.max(day.s || 0, Number(sessionDays[todayK]) || 0); }
    for (const key of new Set([...activeDays, ...Object.keys(sessionDays)])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key >= todayK || s.days[key]) continue;
      const n = Math.max(0, Number(sessionDays[key]) || 0);
      const xp = R.XP.backfillDay.each + R.XP.session.each * Math.min(n, R.XP.session.cap);
      s.days[key] = { xp, s: n, back: 1 }; s.xp += xp; days++; sessions += n;
      if (!s.firstDay || key < s.firstDay) s.firstDay = key;
    }
    s.backfill = { at: this.now().getTime(), days: (s.backfill ? s.backfill.days : 0) + days, sessions: (s.backfill ? s.backfill.sessions : 0) + sessions, ledger: !!ledger };
    this.settle({ silent: true });
    this.save();
    this.emit('changed');
    return s.backfill;
  }
  setTokens(total) { const n = Math.max(0, Number(total) || 0); if (n !== this.state.tokens) { this.state.tokens = n; this.settle(); this.touch(); } }
  setIdentity(identity) { this.state.identity = identity || null; this.touch(); this.emit('changed'); }
  setNickname(name) { this.state.nickname = String(name || '').trim().slice(0, 20); this.touch(); this.emit('changed'); }
  markSeen() { if (Object.keys(this.state.fresh).length) { this.state.fresh = {}; this.touch(); this.emit('changed'); } }

  // 给入口按钮和桌宠用的精简状态。
  brief() {
    const s = this.state, level = R.levelOf(s.xp), rank = R.rankOf(level);
    return { name: s.nickname || s.identity?.name || '', level, rank: rank.n, rankName: rank.name, fresh: Object.keys(s.fresh).length, perks: R.perksOf(level) };
  }

  snapshot() {
    const s = this.state, stats = this.stats(), level = stats.level, rank = R.rankOf(level);
    const floor = R.xpForLevel(level), ceil = level >= R.MAX_LEVEL ? null : R.xpForLevel(level + 1);
    // 预计升级天数：按最近 7 个活跃日的日均经验估。
    const recent = Object.keys(s.days).sort().slice(-7).map(k => s.days[k].xp || 0);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const etaDays = ceil != null && avg > 0 ? Math.max(1, Math.ceil((ceil - s.xp) / avg)) : null;
    const todayK = dayKey(this.now()), heat = [];
    // 热力图：从 11 周前的周一到今天，一共 12 列。
    const end = keyToDate(todayK), start = new Date(end); start.setDate(end.getDate() - ((end.getDay() + 6) % 7) - 77);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) { const k = dayKey(d); heat.push({ day: k, xp: s.days[k]?.xp || 0 }); }
    const achievements = R.ACHIEVEMENTS.filter(a => !a.need || this.available.has(a.need)).map(a => {
      const goal = R.goalOf(a, stats), value = Math.min(goal, a.metric(stats));
      return { id: a.id, group: a.group, icon: a.icon, tier: a.tier, name: a.name, desc: a.desc, goal, value, unlockedAt: s.unlocked[a.id] || 0, fresh: !!s.fresh[a.id], xp: R.TIER_XP[a.tier] };
    });
    // 足迹页：最近 14 天每天的经验与消息数；全年热力图（53 周，周一开头）。
    const daily = [];
    for (let i = 13; i >= 0; i--) { const k = shiftKey(todayK, -i), d = s.days[k] || {}; daily.push({ day: k, xp: d.xp || 0, prompts: d.p || 0, sessions: d.s || 0 }); }
    const year = [], yStart = new Date(end); yStart.setDate(end.getDate() - ((end.getDay() + 6) % 7) - 52 * 7);
    for (let d = new Date(yStart); d <= end; d.setDate(d.getDate() + 1)) { const k = dayKey(d); year.push({ day: k, xp: s.days[k]?.xp || 0 }); }
    const bond = R.bondOf((s.pet.pets || 0) + (s.pet.days || 0) * 5);
    return {
      identity: { ...(s.identity || {}), nickname: s.nickname, display: s.nickname || s.identity?.name || '' },
      level, maxLevel: R.MAX_LEVEL, xp: s.xp, floor, ceil, etaDays,
      rank: { n: rank.n, name: rank.name, metal: rank.metal, nextAt: R.RANKS[rank.n]?.from || null, nextName: R.RANKS[rank.n]?.name || '' },
      today: { xp: s.days[todayK]?.xp || 0, prompts: s.days[todayK]?.p || 0 },
      stats: { sessions: stats.sessions, prompts: stats.prompts, turns: stats.turns, activeDays: stats.activeDays, streak: stats.streak, bestStreak: stats.bestStreak, joinDays: stats.joinDays, tokens: stats.tokens, featuresUsed: stats.featuresUsed, featuresAvail: stats.featuresAvail },
      features: [...this.available].map(id => ({ id, name: R.FEATURES[id], count: s.features[id]?.count || 0, first: s.features[id]?.first || '' })),
      daily, year, groups: R.GROUPS, ranks: R.RANKS,
      achievements, unlocked: achievements.filter(a => a.unlockedAt).length,
      heat, firstDay: s.firstDay, backfill: s.backfill,
      pet: { pets: s.pet.pets || 0, days: s.pet.days || 0, bond, perks: R.PET_PERKS.map(p => ({ ...p, unlocked: level >= p.level })) },
      rules: Object.values(R.XP).map(r => ({ label: r.label, each: r.each, cap: r.cap || null })), tierXp: R.TIER_XP,
    };
  }
}

module.exports = { Profile, dayKey, mergeState };
