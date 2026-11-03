'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const D = require('./data');

const FILE = 'pet-reminders.json';
const MAX_PENDING = 50;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_HOURLY_LIMIT = 5;
const ORDINARY_HOURLY_LIMIT = 20;
const SESSION_PENDING_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;

class PetReminders {
  constructor(assistant) {
    this.a = assistant;
    this.timer = null;
    this.running = false;
    this.createdInProcess = new Set();
    this.setTimer = assistant.deps.reminderSetTimeout || setTimeout;
    this.clearTimer = assistant.deps.reminderClearTimeout || clearTimeout;
    this.a.bus.setReminderSource?.(this);
  }
  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.a.file(FILE), 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.items) || data.items.some(item => !item || typeof item.id !== 'string' || !item.id
        || typeof item.title !== 'string' || !Number.isFinite(item.at) || !['pending', 'acknowledged', 'cancelled', 'delivered'].includes(item.state)
        || item.deliveredAt != null && !Number.isFinite(item.deliveredAt))) throw new Error('不支持的提醒文件结构');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, items: [] };
      throw new Error('提醒文件读取失败，请修复或恢复 pet-reminders.json 后重试');
    }
  }
  warn() {
    if (this.warned) return;
    this.warned = true;
    (this.a.deps.logger || console).warn?.('[pet-reminder] 提醒文件不可用，已暂停后台提醒；请检查 pet-reminders.json');
  }
  write(data) { this.a.write(FILE, { ...data, items: data.items.filter(item => item.state === 'pending' || !Number.isFinite(item.completedAt) || item.completedAt >= this.a.now() - RETAIN_MS) }); }
  changed() { this.a.bus.emit?.('reminders-changed'); this.a.changed(); }
  view(item) { return { ...item, atDisplay: D.displayTime(item.at) }; }
  list() { return this.read().items.filter(item => item.state === 'pending').sort((a, b) => a.at - b.at).map(item => this.view(item)); }
  notice(item) {
    return { id: item.id, kind: 'reminder', title: item.missed ? '错过的提醒：' + item.title : item.title,
      text: [item.missed ? `Hub 关闭期间错过，原定 ${D.displayTime(item.at)}` : '', item.detail].filter(Boolean).join('\n'),
      sticky: item.sticky, at: item.deliveredAt, scheduledAt: item.at, detail: { reminderId: item.id }, sessionId: this.a.state().sessionId || null };
  }
  notices() {
    try { return this.read().items.filter(item => item.state === 'pending' && item.deliveredAt != null && item.at <= this.a.now()).map(item => this.notice(item)); }
    catch { this.warn(); return []; }
  }
  execute(args = {}, source = null) {
    if (args.op === 'list') return { reminders: this.list() };
    if (args.op === 'cancel') {
      if (typeof args.id !== 'string' || !args.id) throw new Error('取消提醒需要 list 返回的 id');
      const data = this.read(), item = data.items.find(item => item.id === args.id);
      if (!item) throw new Error('找不到这条提醒');
      if (item.state !== 'pending') return { cancelled: false, reminder: this.view(item), message: '这条提醒已完成或取消' };
      item.state = 'cancelled'; item.completedAt = this.a.now();
      this.write(data); this.schedule(); this.changed();
      return { cancelled: true, reminder: this.view(item) };
    }
    if (args.op !== 'add') throw new Error('op 只能为 add、list 或 cancel');
    if (typeof args.title !== 'string' || !args.title.trim() || [...args.title.trim()].length > 80 || /[\u0000-\u001f\u007f]/.test(args.title)) throw new Error('提醒标题不能为空、不能含控制字符，且最多 80 字');
    if (args.detail !== undefined && (typeof args.detail !== 'string' || args.detail.length > 4000)) throw new Error('提醒详情必须是最多 4000 字的文本');
    if (args.sticky !== undefined && typeof args.sticky !== 'boolean') throw new Error('sticky 必须是布尔值');
    const now = this.a.now();
    let at = now;
    if (args.at !== undefined) {
      if (typeof args.at !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(args.at)) throw new Error('提醒时间请用上海时间 YYYY-MM-DDTHH:mm:ss，可带时区偏移');
      at = D.timeValue(args.at, 'Asia/Shanghai').at;
      if (!Number.isFinite(at)) throw new Error('提醒时间无效，请核对日期和时区');
      if (at <= now) throw new Error('提醒时间已过去；立即提醒请省略 at');
    }
    const data = this.read();
    if (source) {
      const recent = data.items.filter(item => item.sourceSessionId && item.createdAt > now - HOUR_MS);
      if (recent.filter(item => item.sourceSessionId === source.id).length >= SESSION_HOURLY_LIMIT) throw new Error(`每个会话每小时最多创建 ${SESSION_HOURLY_LIMIT} 条提醒，请稍后重试`);
      if (recent.length >= ORDINARY_HOURLY_LIMIT) throw new Error(`全部普通会话每小时最多创建 ${ORDINARY_HOURLY_LIMIT} 条提醒，请稍后重试`);
      if (data.items.filter(item => item.sourceSessionId === source.id && item.state === 'pending').length >= SESSION_PENDING_LIMIT) throw new Error(`这个会话的未完成提醒已达 ${SESSION_PENDING_LIMIT} 条，请先确认一些提醒`);
      if ((args.detail || '').length + '\n\n来自会话：'.length + source.title.length > 4000) throw new Error('提醒详情加上来源会话说明后不能超过 4000 字');
    }
    if (data.items.filter(item => item.state === 'pending').length >= MAX_PENDING) throw new Error('未完成提醒已达 50 条，请先确认或取消一些提醒');
    const item = { id: 'pet-reminder:' + randomUUID(), title: args.title.trim(), detail: args.detail || '', at,
      sticky: args.sticky !== false, state: 'pending', createdAt: now, deliveredAt: null, missed: false };
    if (source) {
      item.sourceSessionId = source.id; item.sourceSessionTitle = source.title;
      item.detail = [item.detail, '来自会话：' + source.title].filter(Boolean).join('\n\n');
    }
    data.items.push(item); this.write(data); this.createdInProcess.add(item.id);
    this.tick();
    const petEnabled = this.a.deps.isPetEnabled?.() === true;
    const saved = this.read().items.find(row => row.id === item.id);
    return { reminder: this.view(saved), delivery: at > now ? 'scheduled' : saved.deliveredAt == null ? 'queued' : saved.state === 'delivered' ? 'desktop-only' : 'pet-and-desktop',
      message: at > now ? `已安排 ${D.displayTime(at)} 的提醒；${petEnabled ? '到时交给桌宠并发送桌面通知' : '桌宠未开启，到时只发送桌面通知'}`
        : saved.deliveredAt == null ? '提醒已保存，通知通道就绪后发送'
          : saved.state !== 'delivered' ? '已发送桌面通知，并交给桌宠保留在气泡或小圆点中，点击后确认' : '已发送桌面通知；桌宠未开启，未通过桌宠显示，本次提醒已完成' };
  }
  acknowledge(ids) {
    const wanted = new Set(ids), data = this.read(), completed = [];
    for (const item of data.items) if (wanted.has(item.id) && item.state === 'pending') {
      item.state = 'acknowledged'; item.completedAt = this.a.now(); completed.push(item.id);
    }
    if (completed.length) { this.write(data); this.schedule(); this.changed(); }
    return completed;
  }
  tick({ startup = false } = {}) {
    if (!this.running) return;
    try {
      const data = this.read(), now = this.a.now(), due = data.items.filter(item => item.state === 'pending' && item.deliveredAt == null && item.at <= now);
      const petEnabled = this.a.deps.isPetEnabled?.() === true;
      for (const item of due) {
        item.missed = startup && item.at < now && !this.createdInProcess.has(item.id); item.deliveredAt = now;
        if (!petEnabled) { item.state = 'delivered'; item.completedAt = now; }
      }
      if (due.length) this.write(data);
      for (const item of due) this.a.bus.publish(this.notice(item));
      this.schedule(); this.changed();
    } catch { this.warn(); }
  }
  schedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.running) return;
    try {
      const next = this.read().items.filter(item => item.state === 'pending' && item.deliveredAt == null).reduce((at, item) => Math.min(at, item.at), Infinity);
      if (!Number.isFinite(next)) return;
      this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, Math.max(1, Math.min(MAX_TIMER_MS, next - this.a.now())));
      this.timer?.unref?.();
    } catch { this.warn(); }
  }
  start() { if (this.running) return; this.running = true; this.tick({ startup: true }); }
  close() {
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.a.bus.reminderSource === this) this.a.bus.setReminderSource(null);
  }
}

module.exports = { PetReminders, MAX_PENDING, MAX_TIMER_MS, RETAIN_MS, SESSION_HOURLY_LIMIT, ORDINARY_HOURLY_LIMIT, SESSION_PENDING_LIMIT };
