'use strict';
// 助理桌宠的纯逻辑（2026-10-16 用户选定设计稿 D:\AI-Artifacts\20261016-助理桌宠设计-claude1.html）。
// 这里只决定「现在摆什么姿态」「这句话说不说、什么时候收」，不碰窗口和动画，方便单测。
// 姿态优先级借鉴 WorkMate 的 PetStateMachine：全屏躲边 > 开口欢呼 > 助理干活敲键盘 > 打盹 > 有点累 > 待机。

const POSES = Object.freeze(['idle', 'typing', 'happy', 'sleep', 'peek', 'tired']);
const MODES = Object.freeze(['lively', 'gentle', 'quiet']);
const ROLES = Object.freeze([
  { id: '01-cat', name: '小猫' },
  { id: '03-penguin', name: '企鹅' },
  { id: '05-rabbit', name: '兔子' },
  { id: '07-shiba', name: '柴犬' },
  { id: '09-hamster', name: '仓鼠' },
  { id: '11-cockatiel', name: '玄凤' },
]);

const SHOW_MS = 8000;           // 气泡停留 8 秒后收成小圆点
const MAX_PER_HOUR = 3;         // 每小时主动开口最多 3 次
const IDLE_SLEEP_SEC = 600;     // 10 分钟没操作就打盹
const NIGHT_FROM = 19;          // 19:00 后打盹
const NIGHT_UNTIL = 7;
const NIGHT_IDLE_SLEEP_SEC = 120; // 夜里还在操作电脑就陪着不睡，停手 2 分钟才打盹（2026-11-12：加班到深夜时桌宠整晚在睡，提醒都说不出来）
const PETTED_AWAKE_MS = 60000;  // 夜里被点一下，醒一分钟
const SIT_LONG_MS = 90 * 60000; // 活泼档：连续坐 90 分钟提醒起来走走
const AWAY_BACK_SEC = 1800;     // 活泼档：离开 30 分钟回来打个招呼
// 通知卡片（2026-11-09）：开着桌宠时，会话完成、联动消息、助理提醒等原来弹在右下角的通知卡，改由桌宠举着卡片说。
// 停留时间和原通知卡一致；鼠标停在卡片上时不收。
const NOTIFY_SHOW_MS = 9000;

// 右键菜单里交给助理办的事。prompt 是发给助理页的默认问题，助理页可以按 action 换成自己的流程。
const ASSISTANT_ACTIONS = Object.freeze([
  { action: 'meetings-today', label: '今天的会', prompt: '今天有哪些会？按时间列出来，标出需要我提前准备的。' },
  { action: 'meeting-prep', label: '下午会前准备', prompt: '帮我准备下午的会：每个会的材料要点、上次讨论到哪、我该问什么。' },
  { action: 'awaiting-reply', label: '谁在等我回', prompt: '谁在等我回复？按等待时间从长到短排。' },
  { action: 'group-summary', label: '汇总某个群', prompt: '帮我汇总一个群今天的讨论。' },
  { action: 'mail-triage', label: '未读邮件分拣', prompt: '把未读邮件分拣一下：要我处理的、知会我的、可以忽略的。' },
  { action: 'weekly-report', label: '起草周报', prompt: '根据本周的会、邮件和群消息起草一份周报。' },
]);

function localDateKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isNight(ms) {
  const h = new Date(ms).getHours();
  return h >= NIGHT_FROM || h < NIGHT_UNTIL;
}

// ctx：{ now, fullscreen, speaking, speakingTone, assistantBusy, sessionsBusy, idleSec, quotaLow, pettedAt }
// sessionsBusy（2026-11-09）：有会话正在跑时桌宠陪着敲键盘，看一眼就知道活还没干完。
function decidePose(ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  if (ctx.fullscreen) return 'peek';
  if (ctx.speaking) return ctx.speakingTone === 'bad' ? 'tired' : 'happy';
  if (ctx.assistantBusy || Number(ctx.sessionsBusy) > 0) return 'typing';
  const petted = Number(ctx.pettedAt) > 0 && now - Number(ctx.pettedAt) < PETTED_AWAKE_MS;
  const idle = Number(ctx.idleSec) || 0;
  if (idle >= IDLE_SLEEP_SEC || (isNight(now) && !petted && idle >= NIGHT_IDLE_SLEEP_SEC)) return 'sleep';
  if (ctx.quotaLow) return 'tired';
  return 'idle';
}

// 现在能不能开口；不能就只亮小圆点。返回 { ok, reason }。
// settings：{ mode, quietUntil, silentDate }；ctx：{ now, pose, fullscreen }
function speakGate(settings = {}, ctx = {}, spokenAt = [], item = null) {
  const now = Number(ctx.now) || Date.now();
  if (settings.mode === 'quiet') return { ok: false, reason: 'quiet-mode' };
  if (Number(settings.quietUntil) > now) return { ok: false, reason: 'quiet-hour' };
  if (settings.silentDate && settings.silentDate === localDateKey(now)) return { ok: false, reason: 'silent-today' };
  if (ctx.fullscreen) return { ok: false, reason: 'fullscreen' };
  // 开会录制中（2026-11-09）：屏幕可能正在共享，任何卡片都只亮小圆点，散会后点开看。
  if (ctx.meeting) return { ok: false, reason: 'meeting' };
  // 通知卡片是用户在等的结果（会话答完、抢到会议室、助理答好了）：不受打盹和每小时上限约束，桌宠会被叫醒来说。
  if (item?.notify) return { ok: true, reason: '' };
  if (ctx.pose === 'sleep' && !item?.sticky) return { ok: false, reason: 'sleeping' };
  const recent = spokenAt.filter(t => now - t < 3600000).length;
  if (recent >= MAX_PER_HOUR && !item?.sticky && item?.kind !== 'digest') return { ok: false, reason: 'hourly-cap' };
  return { ok: true, reason: '' };
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 一次一句的气泡队列。提醒先排队；轮到时能开口就说 8 秒，再收进小圆点；不能开口直接进小圆点。
class SpeechQueue {
  constructor({ now = () => Date.now(), showMs = SHOW_MS, notifyMs = NOTIFY_SHOW_MS, keepDots = 20 } = {}) {
    this.now = now;
    this.showMs = showMs;
    this.notifyMs = notifyMs;
    this.held = null;
    this.keepDots = keepDots;
    this.pending = [];
    this.current = null;
    this.dots = [];
    this.spokenAt = [];
    this.seen = new Set();
  }

  // item：{ id, kind, title, text, sessionId?, sticky?, notify?, tone?, page?, noticeId?, count? }。同一 id 只收一次。
  // notify：通知卡片（会话完成等）。它插到队首，正在说的话先收进小圆点，让最新的结果马上出来（连续完成几个会话时不排队干等）。
  push(item) {
    const id = cleanText(item && item.id, 160);
    const title = cleanText(item && item.title, 80);
    if (!id || !title || this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    const entry = { id, kind: cleanText(item.kind, 32), title, text: String(item.text == null ? '' : item.text).slice(0, 4000), sessionId: cleanText(item.sessionId, 160) || null, sticky: item.sticky === true };
    if (item.notify === true) {
      entry.notify = true;
      entry.at = this.now();
      for (const key of ['tone', 'page', 'noticeId', 'cta']) { const v = cleanText(item[key], key === 'cta' ? 20 : 160); if (v) entry[key] = v; }
      const count = Math.round(Number(item.count) || 0);
      if (count > 1) entry.count = Math.min(99, count);
      if (/^(?:(?:rank|badge)-\d{1,2}|evolve-[2-6])$/.test(String(item.art || ''))) entry.art = String(item.art);
      if (this.current) { this.toDot(this.current); this.current = null; this.held = null; }
      this.pending.unshift(entry);
    } else this.pending.push(entry);
    return true;
  }

  // 鼠标停在通知卡片上：暂停倒计时；移开后至少再留 2.5 秒。
  hold(on) {
    const cur = this.current;
    if (!cur || cur.sticky) return false;
    const now = this.now();
    if (on && !this.held) { this.held = { id: cur.id, left: Math.max(0, cur.until - now) }; cur.until = Infinity; return true; }
    if (!on && this.held && this.held.id === cur.id) { cur.until = now + Math.max(2500, this.held.left); this.held = null; return true; }
    return false;
  }

  // 每次状态变化或定时器到点调用；gate(spokenAt) 返回 speakGate 的结果。返回是否有可见变化。
  tick(gate) {
    const now = this.now();
    let changed = false;
    if (this.current && (!this.current.sticky && now >= this.current.until || this.current.sticky && typeof gate === 'function' && !gate(this.spokenAt, this.current)?.ok)) {
      this.toDot(this.current);
      this.current = null;
      changed = true;
    }
    while (!this.current && this.pending.length) {
      const next = this.pending.shift();
      const verdict = typeof gate === 'function' ? gate(this.spokenAt, next) : { ok: true };
      if (verdict && verdict.ok) {
        if (!next.sticky && !next.notify && next.kind !== 'digest') this.spokenAt.push(now);
        this.spokenAt = this.spokenAt.filter(t => now - t < 3600000);
        this.current = { ...next, at: now, until: next.sticky ? null : now + (next.notify ? this.notifyMs : this.showMs) };
      } else {
        this.toDot(next);
      }
      changed = true;
    }
    // 常驻气泡挡住队列时，后续提醒保留在圆点中，不丢弃也不忙等。
    if (this.current?.sticky) while (this.pending.length) { this.toDot(this.pending.shift()); changed = true; }
    return changed;
  }

  toDot(item) {
    if (this.held && this.held.id === item.id) this.held = null;
    const { until, at, ...rest } = item;
    this.dots.push(item.notify ? { ...rest, at } : rest);   // 通知卡片收进小圆点后，面板里要显示几点到的
    while (this.dots.filter(item => item.kind !== 'reminder').length > this.keepDots) this.dots.splice(this.dots.findIndex(item => item.kind !== 'reminder'), 1);
  }

  // 持久化存储是提醒的事实来源：取消/确认后移除；窗口重建或错过总线事件时补回。
  syncReminders(items) {
    const active = new Map(items.map(item => [item.id, item]));
    const keep = item => item.kind !== 'reminder' || active.has(item.id);
    this.pending = this.pending.filter(keep); this.dots = this.dots.filter(keep);
    if (this.current && !keep(this.current)) this.current = null;
    const present = new Set([...this.pending, ...this.dots, ...(this.current ? [this.current] : [])].map(item => item.id));
    for (const item of active.values()) if (!present.has(item.id)) { this.seen.delete(item.id); this.push(item); }
  }

  // 用户点了气泡：提前收起，内容交给展开面板；不算进小圆点。
  takeCurrent() {
    const item = this.current;
    this.current = null;
    this.held = null;
    if (!item) return null;
    const { until, at, ...rest } = item;
    return item.notify ? { ...rest, at } : rest;
  }

  // 用户点了小圆点：取走全部，最新的在前。
  takeDots() {
    const items = this.dots.slice().reverse();
    this.dots = [];
    return items;
  }

  // 用户已经在 Hub 里看过的会话：从小圆点里拿掉（不然点开小圆点还是一堆早看过的「已完成」）。
  dropSession(sessionId) {
    const sid = cleanText(sessionId, 160);
    if (!sid) return false;
    const before = this.dots.length;
    this.dots = this.dots.filter(item => !(item.notify && item.sessionId === sid));
    return this.dots.length !== before;
  }

  nextDeadline() {
    if (this.current) return this.current.sticky || !Number.isFinite(this.current.until) ? null : this.current.until;
    return this.pending.length ? this.now() : null;
  }

  snapshot() {
    return {
      bubble: this.current ? { id: this.current.id, kind: this.current.kind, title: this.current.title, until: Number.isFinite(this.current.until) ? this.current.until : null, sticky: this.current.sticky,
        ...(this.current.notify ? { notify: true, text: this.current.text.slice(0, 400), tone: this.current.tone || '', cta: this.current.cta || '', count: this.current.count || 0, sessionId: this.current.sessionId,
          held: !!this.held, ms: this.notifyMs, at: this.current.at, ...(this.current.art ? { art: String(this.current.art) } : {}) } : {}) } : null,
      dots: this.dots.length,
      pending: this.pending.length,
    };
  }
}

// 活泼档的闲聊（温和档只说助理的提醒，安静档什么都不说）。返回要说的话或 null。
// track：调用方保存的 { greetedDate, activeSince, sitRemindedAt, lastIdleSec }，本函数会更新它。
function chatterFor(mode, ctx = {}, track = {}) {
  if (mode !== 'lively') return null;
  const now = Number(ctx.now) || Date.now();
  const idleSec = Number(ctx.idleSec) || 0;
  const hour = new Date(now).getHours();
  const prevIdle = Number(track.lastIdleSec) || 0;
  track.lastIdleSec = idleSec;
  if (idleSec >= 300) { track.activeSince = 0; return null; }
  if (!track.activeSince) track.activeSince = now;
  const today = localDateKey(now);
  if (track.greetedDate !== today && hour >= NIGHT_UNTIL && hour < 11) {
    track.greetedDate = today;
    const greets = ['早上好！今天也一起加油。', '早呀，新的一天开始了。', '早上好，先喝口水再开工。'];
    return { id: 'chatter-greet-' + today, kind: 'chatter', title: greets[new Date(now).getDate() % greets.length] };
  }
  // 2026-11-12：午饭和深夜各说一句，每天各一次。
  if (track.lunchDate !== today && hour === 12 && new Date(now).getMinutes() < 30) {
    track.lunchDate = today;
    return { id: 'chatter-lunch-' + today, kind: 'chatter', title: '到饭点了，先去吃饭吧。' };
  }
  if (track.lateDate !== today && hour >= 23) {
    track.lateDate = today;
    return { id: 'chatter-late-' + today, kind: 'chatter', title: '夜深了，忙完这点早些休息。' };
  }
  if (prevIdle >= AWAY_BACK_SEC && idleSec < 60) {
    return { id: 'chatter-back-' + now, kind: 'chatter', title: '欢迎回来～有新提醒我会叫你。' };
  }
  if (now - track.activeSince >= SIT_LONG_MS && now - (Number(track.sitRemindedAt) || 0) >= SIT_LONG_MS) {
    track.sitRemindedAt = now;
    track.activeSince = now;
    return { id: 'chatter-sit-' + now, kind: 'chatter', title: '坐了一个半小时啦，起来走走、喝口水？' };
  }
  return null;
}

// 周五下午问一句要不要让助理起草周报（2026-11-09）：温和、活泼档都说，每周一次；人不在电脑前时不说。
// 点卡片 → 助理页按「起草周报」开问。
function weeklyNudge(mode, ctx = {}, track = {}) {
  if (mode === 'quiet') return null;
  const now = Number(ctx.now) || Date.now();
  const d = new Date(now), today = localDateKey(now);
  if (d.getDay() !== 5 || d.getHours() < 15 || d.getHours() >= 18 || (Number(ctx.idleSec) || 0) >= 300 || track.weeklyDate === today) return null;
  track.weeklyDate = today;
  return { id: 'weekly-' + today, kind: 'weekly', notify: true, action: 'weekly-report', cta: '让助理起草',
    title: '周五了，周报要不要让助理先起个草？', text: '助理按本周的会、邮件和群消息起草，你改改就能交。' };
}

module.exports = {
  ASSISTANT_ACTIONS,
  IDLE_SLEEP_SEC,
  MAX_PER_HOUR,
  MODES,
  NOTIFY_SHOW_MS,
  POSES,
  ROLES,
  SHOW_MS,
  SpeechQueue,
  chatterFor,
  decidePose,
  isNight,
  localDateKey,
  speakGate,
  weeklyNudge,
};
