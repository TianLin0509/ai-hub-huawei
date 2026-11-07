'use strict';

const D = require('./data');
const R = require('./reminders');
const DIGEST_HOURS = Object.freeze([0, 1, 2, 4]);
const PRIVATE_WAIT_MS = 30 * 60000;
const SOURCE_KEEP_MS = 7 * 86400000;
const SOURCE_LIMIT = 500;
const LABELS = { private: '条私聊未回', mention: '条 @你', commitment: '件答应的事', mail: '封重要邮件' };

function digestItems(snapshot, { settings, now, commitments = [], done = new Set() }) {
  const items = new Map(), day = D.dayKey(now), tomorrow = D.dayKey(now + 86400000);
  const add = item => { if (item.source && !done.has(item.source)) items.set(item.id, item); };
  for (const message of D.awaiting(snapshot, settings)) {
    if (message.group) {
      const rows = snapshot.messages?.[message.conv] || [];
      const index = rows.findIndex(row => row.sourceId === message.sourceId);
      if (index < 0 || rows.slice(index + 1).some(row => row.mine)) continue;
    } else if (!Number.isFinite(message.since) || now - message.since <= PRIVATE_WAIT_MS) continue;
    const kind = message.group ? 'mention' : 'private';
    add({ id: `${kind}:${message.sourceId}`, kind, source: message.sourceId, day: message.at ? D.dayKey(message.at) : day,
      text: D.short(message.text || message.preview || '非文字消息', 200), sourceLabel: message.group ? `群 ${message.convName} · ${message.sender}` : `私聊 · ${message.sender}` });
  }
  for (const item of commitments) {
    if (item.due !== day && item.due !== tomorrow) continue;
    add({ id: `commitment:${item.source}`, kind: 'commitment', source: item.source, day,
      text: item.text, due: item.due, sourceLabel: item.sourceLabel || '答应的事原文' });
  }
  // The existing snapshot.mails comes exclusively from mail list --is-read 0.
  // Reuse its normalized important flag; do not infer importance from subjects.
  for (const mail of snapshot.mails || []) if (mail.important === true) {
    add({ id: `mail:${mail.sourceId}`, kind: 'mail', source: mail.sourceId, day: mail.at ? D.dayKey(mail.at) : day,
      text: mail.subject, sourceLabel: mail.from ? `邮件 · ${mail.from}` : '邮件原文' });
  }
  return [...items.values()];
}

function digestText(items) {
  const fresh = items.filter(item => item.isNew), old = items.length - fresh.length;
  if (!items.length) return '这份清单已全部标记处理。';
  const counts = Object.keys(LABELS).map(kind => [kind, fresh.filter(item => item.kind === kind).length]).filter(([, n]) => n);
  return `本次新增：${counts.length ? counts.map(([kind, n]) => n + ' ' + LABELS[kind]).join('，') : '无'}${old ? `；另有 ${old} 件仍待处理` : ''}`;
}

function digestPlan({ snapshot, settings, now, state = {}, commitments = [], done = new Set(), sent = {} }) {
  const hours = Number(settings.digestHours), parts = D.dateParts(now);
  if (!DIGEST_HOURS.includes(hours) || !hours || !R.isWorkday(now, settings) || parts.hour < 9 || parts.hour >= 20
      || state.lastCheckedAt && now - state.lastCheckedAt < hours * 3600000) return null;
  const seen = new Set(state.seen || []);
  const commitmentSent = source => {
    const prefix = `commit:${source}:`;
    return Object.keys(sent).some(id => id.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}:(?:eve|day)$/.test(id.slice(prefix.length)));
  };
  const items = digestItems(snapshot, { settings, now, commitments, done }).map(item => ({ ...item,
    isNew: !seen.has(item.id) && !(item.kind === 'commitment' && commitmentSent(item.source)),
  }));
  const notice = items.some(item => item.isNew) ? { id: `digest:${now}`, kind: 'digest', at: now,
    title: `定时汇总：${items.length} 件待处理`, text: digestText(items), detail: { items }, sessionId: null } : null;
  return { checkedAt: now, items, notice };
}

function visibleDigest(notice, done) {
  if (notice.kind !== 'digest') return notice;
  const items = (notice.detail?.items || []).filter(item => !done.has(item.source));
  return { ...notice, title: items.length ? `定时汇总：${items.length} 件待处理` : '定时汇总：已全部处理',
    text: digestText(items), detail: { ...notice.detail, items } };
}

class AssistantDigest {
  constructor(service) {
    this.a = service;
    this.setTimer = service.deps.digestSetTimeout || setTimeout;
    this.clearTimer = service.deps.digestClearTimeout || clearTimeout;
    this.timer = null;
    // Expiry is local housekeeping, independent of the assistant refresh switch.
    this.pruneSources();
  }
  close() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  scheduleCleanup(records) {
    this.close();
    if (!records.length) return;
    const next = Math.min(...records.map(record => record.noticeAt + SOURCE_KEEP_MS + 1));
    this.timer = this.setTimer(() => {
      this.timer = null;
      try { this.pruneSources(); }
      catch { (this.a.deps.logger || console).warn?.('[assistant-digest] 本机汇总原文清理未完成'); }
    }, Math.min(SOURCE_KEEP_MS, Math.max(1, next - this.a.now())));
    this.timer?.unref?.();
  }
  state() { return { lastCheckedAt: 0, lastSentAt: 0, seen: [], ...this.a.read('digest.json', {}) }; }
  check(snapshot, settings, state) {
    const previous = this.state(), now = this.a.now();
    const plan = digestPlan({ snapshot, settings, now, state: previous, commitments: state.commitments, done: this.a.doneSet(), sent: state.sent });
    if (!plan) return null;
    // Reserve the interval before synchronous bus listeners run. Silent checks
    // change only this timestamp, never the notified IDs or last successful send.
    this.a.write('digest.json', { ...previous, lastCheckedAt: now });
    if (!plan.notice || !this.a.bus.publish(plan.notice)) return null;
    this.a.write('digest.json', { lastCheckedAt: now, lastSentAt: now, seen: plan.items.map(item => item.id) });
    const current = this.a.state();
    this.a.saveState({ notices: [plan.notice, ...current.notices].slice(0, 30) });
    this.retainSources(snapshot);
    this.a.changed();
    return plan.notice;
  }
  recentNotices() { return this.a.state().notices.filter(notice => notice.kind === 'digest' && this.a.now() - notice.at <= SOURCE_KEEP_MS); }
  pruneSources() {
    const saved = this.a.read('digest-sources.json', null);
    if (!saved) return;
    const refs = new Set(this.recentNotices().flatMap(notice => (notice.detail?.items || []).map(item => item.source)));
    const records = (saved.records || []).filter(record => this.a.now() - record.noticeAt <= SOURCE_KEEP_MS && refs.has(record.source))
      .sort((a, b) => b.noticeAt - a.noticeAt).slice(0, SOURCE_LIMIT);
    if (records.length !== (saved.records || []).length) this.a.write('digest-sources.json', { records });
    this.scheduleCleanup(records);
  }
  retainSources(snapshot) {
    const owner = snapshot.login?.uid, index = D.sourceIndex(snapshot), records = this.a.read('digest-sources.json', { records: [] }).records || [];
    const bySource = new Map(records.map(record => [JSON.stringify([record.owner, record.source]), record]));
    for (const notice of this.recentNotices()) for (const item of notice.detail.items) {
      const key = JSON.stringify([owner, item.source]);
      if (bySource.has(key)) { bySource.get(key).noticeAt = Math.max(bySource.get(key).noticeAt, notice.at); continue; }
      let entry = index.get(item.source), capturedAt = snapshot.at, coverage = null;
      if (entry?.kind === 'message') {
        coverage = snapshot.scope?.conversations?.find(conv => conv.id === entry.item.conv) || null;
        capturedAt = coverage?.capturedAt ?? (snapshot.scope?.stale ? snapshot.scope.capturedAt : null) ?? snapshot.at;
      }
      if (!entry) {
        try { const found = this.a.sourceContext(item.source, item.day); entry = found.entry; capturedAt = found.capturedAt; coverage = found.coverage; }
        catch { continue; } // An older commitment can outlive the local source window.
      }
      bySource.set(key, { owner, source: item.source, ...entry, capturedAt, coverage, noticeAt: notice.at });
    }
    const retained = [...bySource.values()].filter(record => this.a.now() - record.noticeAt <= SOURCE_KEEP_MS)
      .sort((a, b) => b.noticeAt - a.noticeAt).slice(0, SOURCE_LIMIT);
    this.a.write('digest-sources.json', { records: retained });
    this.scheduleCleanup(retained);
  }
  source(source, owner) {
    this.pruneSources();
    return this.a.read('digest-sources.json', { records: [] }).records.find(record => record.source === source && record.owner === owner) || null;
  }
}

module.exports = { AssistantDigest, DIGEST_HOURS, PRIVATE_WAIT_MS, SOURCE_KEEP_MS, SOURCE_LIMIT, digestItems, digestPlan, digestText, visibleDigest };
