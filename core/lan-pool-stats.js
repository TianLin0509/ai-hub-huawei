'use strict';
// 号池主机端的使用统计：按同事、按天累计请求数、token、模型、工具，以及在线状态和最近事件。
// 只记元数据（次数、token 数、时间、来源 IP、工具名），不记对话正文。
// 统计落盘到 lan-pool/usage.json，Hub 重启后今天和最近 14 天的数据还在。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KEEP_DAYS = 14;
const ONLINE_MS = 150 * 1000; // 同事端在线时每 ~60 秒拉一次状态；两次没来才算离线。
const MAX_EVENTS = 60;
const SAVE_MS = 15 * 1000;
const file = dataDir => path.join(dataDir, 'lan-pool', 'usage.json');
// 北京时间的日期与小时：公司在上海，按本地日界线算「今天」。
const dayKey = t => new Date(t + 8 * 3600000).toISOString().slice(0, 10);
const hourOf = t => new Date(t + 8 * 3600000).getUTCHours();
const emptyDay = () => ({ requests: 0, succeeded: 0, failed: 0, limited: 0, tokensIn: 0, tokensOut: 0, hours: Array(24).fill(0), models: {}, tools: {} });
// 从 User-Agent 认出是哪个工具发的请求，便于主机看同事主要在用什么。
function toolOf(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (ua.includes('claude-cli') || ua.includes('claude-code')) return 'Claude Code';
  if (ua.includes('codex')) return 'Codex';
  if (ua.includes('deepseek') || ua.includes('dsh') || ua.includes('acp')) return 'DSH';
  if (ua.includes('ai-hub')) return 'AI Hub';
  return ua ? '其他' : '未知';
}
// 从模型响应里取 token 用量（三种协议各有写法）；取不到就记 0，不影响转发。
function usageOf(v) {
  if (!v || typeof v !== 'object') return null;
  const n = x => (Number.isFinite(x) && x > 0 ? x : 0);
  // Anthropic: message_start.message.usage / message_delta.usage / 非流式 body.usage
  const a = v.type === 'message_start' ? v.message?.usage : v.type === 'message_delta' ? v.usage : null;
  if (a) return { in: n(a.input_tokens) + n(a.cache_read_input_tokens) + n(a.cache_creation_input_tokens), out: n(a.output_tokens) };
  // OpenAI Responses: response.completed.response.usage
  const r = v.type === 'response.completed' ? v.response?.usage : null;
  if (r) return { in: n(r.input_tokens), out: n(r.output_tokens) };
  // Chat Completions / 非流式：顶层 usage
  const u = v.usage;
  if (u && typeof u === 'object') return { in: n(u.prompt_tokens) + n(u.input_tokens) + n(u.cache_read_input_tokens), out: n(u.completion_tokens) + n(u.output_tokens) };
  return null;
}

class LanPoolStats {
  constructor(dataDir, { now = Date.now } = {}) {
    this.dataDir = dataDir; this.now = now; this.dirty = false; this.timer = null;
    this.presence = new Map(); // id -> { lastSeenAt, ip, client, tool }
    this.events = [];
    this.data = this.load();
  }
  load() {
    try {
      const v = JSON.parse(fs.readFileSync(file(this.dataDir), 'utf8'));
      if (v && typeof v === 'object' && v.members && typeof v.members === 'object') {
        for (const [id, p] of Object.entries(v.presence || {})) this.presence.set(id, p);
        this.events = Array.isArray(v.events) ? v.events.slice(-MAX_EVENTS) : [];
        return { members: v.members };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[lan-pool] usage.json 无法读取，统计从零开始：' + error.message);
    }
    return { members: {} };
  }
  day(id, t = this.now()) {
    const m = this.data.members[id] ||= { days: {} };
    return m.days[dayKey(t)] ||= emptyDay();
  }
  touch() {
    this.dirty = true;
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.save(); }, SAVE_MS); this.timer.unref?.(); }
  }
  event(id, name, kind, text) {
    this.events.push({ at: this.now(), id, name, kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.touch();
  }
  seen(member, { ip = '', client = '', userAgent = '' } = {}) {
    const t = this.now(), prev = this.presence.get(member.id);
    const ipText = String(ip).replace(/^::ffff:/, '');
    const next = { lastSeenAt: t, ip: ipText || prev?.ip || '', client: client || prev?.client || '', tool: prev?.tool || '' };
    if (userAgent && !client) next.tool = toolOf(userAgent);
    this.presence.set(member.id, next);
    if (!prev || t - prev.lastSeenAt > ONLINE_MS) this.event(member.id, member.name, 'online', `上线 · ${next.ip || '未知地址'}${prev?.ip && prev.ip !== next.ip ? `（之前 ${prev.ip}）` : ''}`);
  }
  request(member, { model = '', userAgent = '' } = {}) {
    const d = this.day(member.id), t = this.now(), tool = toolOf(userAgent);
    d.requests++; d.hours[hourOf(t)]++; d.lastAt = t;
    const m = d.models[model] ||= { requests: 0, tokensIn: 0, tokensOut: 0 }; m.requests++;
    d.tools[tool] = (d.tools[tool] || 0) + 1;
    this.touch();
    return { model, day: dayKey(t) };
  }
  finish(member, ticket, { ok, tokensIn = 0, tokensOut = 0, status = 0 } = {}) {
    const d = this.data.members[member.id]?.days[ticket.day] || this.day(member.id);
    ok ? d.succeeded++ : d.failed++;
    d.tokensIn += tokensIn; d.tokensOut += tokensOut;
    const m = d.models[ticket.model]; if (m) { m.tokensIn += tokensIn; m.tokensOut += tokensOut; }
    if (!ok && status >= 500) this.event(member.id, member.name, 'error', `请求失败（${status === 504 ? '超时' : 'HTTP ' + status}）`);
    this.touch();
  }
  // 撞到每人上限或主机总上限：只记一次/分钟，避免刷屏。
  limited(member, why) {
    const d = this.day(member.id); d.limited++;
    const last = this.events.findLast(e => e.id === member.id && e.kind === 'limit');
    if (!last || this.now() - last.at > 60000) this.event(member.id, member.name, 'limit', why);
    else this.touch();
  }
  revoked(member) { this.event(member.id, member.name, 'revoke', '口令已撤销，在途请求已断开'); }
  // 给号池视图用：在线状态 + 今天 + 最近 7 天 + 事件。
  view(members = [], live = new Map()) {
    const t = this.now(), today = dayKey(t);
    const last7 = Array.from({ length: 7 }, (_, i) => dayKey(t - (6 - i) * 86400000));
    const rows = members.map(m => {
      const p = this.presence.get(m.id) || null, days = this.data.members[m.id]?.days || {};
      const d = days[today] || emptyDay(), l = live.get(m.id) || {};
      const week = last7.map(k => ({ day: k, requests: days[k]?.requests || 0, tokens: (days[k]?.tokensIn || 0) + (days[k]?.tokensOut || 0) }));
      const lastUsedAt = Math.max(l.lastAt || 0, ...Object.values(days).map(x => x.lastAt || 0));
      return { id: m.id, name: m.name, revokedAt: m.revokedAt || null, maxConcurrent: m.maxConcurrent, rpm: m.rpm,
        online: !!p && !m.revokedAt && t - p.lastSeenAt <= ONLINE_MS, lastSeenAt: p?.lastSeenAt || null, ip: p?.ip || '', client: p?.client || '',
        active: l.active || 0, minuteRequests: l.minuteRequests || 0, lastUsedAt: lastUsedAt || null,
        today: { requests: d.requests, succeeded: d.succeeded, failed: d.failed, limited: d.limited, tokensIn: d.tokensIn, tokensOut: d.tokensOut, hours: d.hours, models: d.models, tools: d.tools },
        week, weekRequests: week.reduce((s, x) => s + x.requests, 0), weekTokens: week.reduce((s, x) => s + x.tokens, 0) };
    });
    const hours = Array(24).fill(0); for (const r of rows) r.today.hours.forEach((n, i) => { hours[i] += n; });
    const sum = k => rows.reduce((s, r) => s + (r.today[k] || 0), 0);
    return { at: t, today, onlineMs: ONLINE_MS, keepDays: KEEP_DAYS, rows,
      totals: { members: rows.filter(r => !r.revokedAt).length, online: rows.filter(r => r.online).length, active: rows.reduce((s, r) => s + r.active, 0),
        requests: sum('requests'), succeeded: sum('succeeded'), failed: sum('failed'), limited: sum('limited'), tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut') },
      hours, events: this.events.slice(-30).reverse() };
  }
  prune() {
    const cutoff = dayKey(this.now() - (KEEP_DAYS - 1) * 86400000);
    for (const m of Object.values(this.data.members)) for (const k of Object.keys(m.days)) if (k < cutoff) delete m.days[k];
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false; this.prune();
    try {
      fs.mkdirSync(path.dirname(file(this.dataDir)), { recursive: true });
      const tmp = file(this.dataDir) + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, members: this.data.members, presence: Object.fromEntries(this.presence), events: this.events }));
      fs.renameSync(tmp, file(this.dataDir));
    } catch (error) { this.dirty = true; console.warn('[lan-pool] 统计保存失败：' + error.message); }
  }
  flush() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.save(); }
}
module.exports = { LanPoolStats, toolOf, usageOf, dayKey, ONLINE_MS };
