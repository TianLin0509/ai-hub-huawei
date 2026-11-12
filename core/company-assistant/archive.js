'use strict';

// WeLink 长期档案（2026-11-12）：每晚把全部会话的新消息增量存到这台电脑，第一次往回补到服务器还留着的最早一天（约 100 天）。
// 为什么要有：助理的快照只回看 36 小时、按天留 14 天，可人物卡、承诺账本、项目时间线都要跨几周到几个月的数据；服务器只留约 100 天，过期就没了。
// 依据：2026-11-11 公司真机全量导出 100 个会话、1659 次调用、约 40 分钟、文本 355 万字；之后每晚只需 100–300 次调用。
// 只存本机（公司电脑），不上传、不调模型。会话目录每次取最近 100 个并入「见过的全部会话」，掉出最近 100 的会话照样接着存。
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const D = require('./data');
const { readJson } = require('./queries');
const Identity = require('./identity');

const DAY = 86400000, PAGE = 100;
const BACKFILL_DAYS = 100;       // 服务器保留约 100 天，再往前取不到
const MAX_PAGES = 80;            // 单个会话单次最多翻 80 页（8000 条），防翻页游标异常时空转
const START_MINUTE = 23 * 60 + 10; // 每晚 23:10 起跑；Hub 当时没开，就在第二天 07:30 前或周末补跑
const IDLE_DAYS = 45, IDLE_RECHECK_DAYS = 7; // 45 天没动静的会话每 7 天才看一次
const RETRY_MS = 30 * 60000, FAIL_STREAK = 4;
const TEXT_MAX = 4000;

const h16 = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const big = id => { try { return BigInt(String(id)); } catch { return null; } };
const minBig = ids => ids.reduce((a, b) => (a === null || b < a ? b : a), null);
const pad = n => String(n).padStart(2, '0');

// 存档前抹掉明文凭据（2026-11-12：100 天真实聊天里扫出 4 处 sk-ant 会话密钥、8 处「邮箱----密码」账号和若干 2FA 密钥）。
// 档案会长期留在本机，还会整段交给模型写人物卡，凭据不该跟着进去。
const SECRETS = [
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[已隐去:密钥]'],
  [/[\w.+-]+@[\w-]+\.[\w.]+----\S+/g, '[已隐去:账号密码]'],
  [/(?<![A-Za-z0-9])[A-Z2-7]{32}(?![A-Za-z0-9])/g, '[已隐去:2FA]'],
  [/((?:password|密码)\s*[:：=]\s*)\S{6,}/gi, '$1[已隐去]'],
];
const scrub = text => SECRETS.reduce((t, [re, to]) => t.replace(re, to), String(text || ''));

// 非文字消息也留一行可检索的字：卡片留标题、文件留文件名（以前只有占位符，事后搜不到）。
function textOf(raw, normalized) {
  const type = String(raw?.contentType ?? normalized?.contentType ?? '');
  let content = raw?.content ?? normalized?.content;
  if (typeof content === 'string' && /^\s*[{[]/.test(content)) { try { content = JSON.parse(content); } catch { /* 原样 */ } }
  if (content && typeof content === 'object') {
    const pick = keys => { for (const k of keys) { const v = content[k]; if (typeof v === 'string' && v.trim()) return v.trim(); } return ''; };
    const file = pick(['fileName', 'file_name', 'name']), title = pick(['title', 'cardTitle', 'subject']), body = pick(['text', 'content', 'msg', 'body', 'desc', 'digest']);
    if (file) return `[文件] ${file}`;
    if (title || body) return (type && type !== 'TEXT_MSG' ? '[卡片] ' : '') + [title, body].filter(Boolean).join('｜');
  }
  const text = String(normalized?.text ?? (typeof content === 'string' ? content : '')).trim();
  if (text) return text;
  return type ? `[${/IMAGE|PIC/i.test(type) ? '图片' : /FILE/i.test(type) ? '文件' : /VOICE|AUDIO/i.test(type) ? '语音' : '非文字消息'}]` : '';
}

class WelinkArchive {
  constructor(assistant, { now, run } = {}) {
    this.a = assistant;
    this.now = now || (() => assistant.now());
    this.run = run || ((args, opts = {}) => assistant.welink(args, { priority: 'background', timeoutMs: 30000, ...opts }));
    this.job = null;
    this.cache = new Map(); // owner|convId → { ids:Set, size }
  }
  owner() {
    const auth = this.a.auth?.status?.();
    return auth?.state === 'online' && auth.login?.ok === true && typeof auth.login.uid === 'string' && auth.login.uid ? auth.login.uid : null;
  }
  root(owner) { return path.join(this.a.dir, 'archive', h16(owner)); }
  file(owner, convId) { return path.join(this.root(owner), 'msgs', h16(convId) + '.jsonl'); }
  loadIndex(owner) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.root(owner), 'index.json'), 'utf8'));
      if (value.owner !== owner) throw new Error('长期档案的账号不匹配');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, owner, createdAt: this.now(), convs: {}, names: {}, runs: [], lastDay: '', lastAttemptAt: 0 };
      throw error;
    }
  }
  saveIndex(owner, idx) {
    const dir = this.root(owner); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.json'), tmp = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8'); fs.renameSync(tmp, file);
  }
  // 归档日：23:10 之前算前一天。每个归档日自动跑一次。
  archiveDay(at) { return D.dayKey(at - START_MINUTE * 60000); }
  enabled() { return this.a.settings?.().archive !== false; }

  // 定时器每分钟调一次：到点、没跑过、上次失败已过 30 分钟，才在后台起跑；工作日白天不自动跑，免得和快照抢 WeLink 额度。
  maybeRun() {
    if (this.job || !this.enabled()) return false;
    const owner = this.owner(); if (!owner) return false;
    const now = this.now(), p = D.dateParts(now), minute = p.hour * 60 + p.minute;
    const weekend = [0, 6].includes(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay());
    if (!(minute >= START_MINUTE || minute < 7 * 60 + 30 || weekend)) return false;
    let idx; try { idx = this.loadIndex(owner); } catch { return false; }
    if (idx.lastDay === this.archiveDay(now) || now - (idx.lastAttemptAt || 0) < RETRY_MS) return false;
    void this.start({ trigger: 'timer' }).catch(() => {});
    return true;
  }
  start({ trigger = 'manual' } = {}) {
    if (this.job) return this.job.promise;
    if (!this.enabled()) return Promise.reject(new Error('长期档案已在设置里关闭'));
    const owner = this.owner();
    if (!owner) return Promise.reject(new Error('请先在助理页确认 WeLink 登录，再补档。'));
    const job = this.job = { owner, trigger, phase: '准备', done: 0, total: 0, added: 0, calls: 0, startedAt: this.now(), abort: new AbortController() };
    job.promise = this.runJob(job).finally(() => { if (this.job === job) this.job = null; this.a.changed?.(); });
    this.a.changed?.();
    return job.promise;
  }
  stop() { this.job?.abort.abort(); }

  async call(job, args) {
    if (job.abort.signal.aborted) throw Object.assign(new Error('已停止'), { code: 'STOPPED' });
    job.calls += 1;
    const raw = await readJson(a => this.run(a), args);
    if (this.owner() !== job.owner) throw Object.assign(new Error('补档期间 WeLink 账号变了，已停止'), { code: 'STOPPED' });
    return raw;
  }
  known(owner, convId) {
    const key = owner + '|' + convId; let entry = this.cache.get(key);
    if (!entry) {
      const ids = new Set();
      try { for (const line of fs.readFileSync(this.file(owner, convId), 'utf8').split('\n')) if (line) { try { ids.add(JSON.parse(line).id); } catch { /* 坏行跳过 */ } } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      entry = { ids }; this.cache.set(key, entry);
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    }
    return entry.ids;
  }
  append(owner, conv, rows) {
    const ids = this.known(owner, conv.id), fresh = rows.filter(r => !ids.has(r.id));
    if (!fresh.length) return 0;
    fs.mkdirSync(path.dirname(this.file(owner, conv.id)), { recursive: true });
    fs.appendFileSync(this.file(owner, conv.id), fresh.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    for (const r of fresh) ids.add(r.id);
    return fresh.length;
  }
  rows(raw, conv, owner) {
    const records = D.messageRecords(raw);
    if (records === null) return null;
    const normalized = D.messages(raw, conv, owner);
    return normalized.map((m, i) => {
      const source = records.find(r => String(D.messageId(r)) === m.key) || records[i];
      const row = { id: m.key, at: m.at || 0, a: m.account, t: scrub(textOf(source, m).replace(/\r/g, '')).slice(0, TEXT_MAX), ct: m.contentType || '' };
      if (m.mine) row.m = 1;
      if (m.mentionEvidence?.atAccountList?.length) row.at2 = m.mentionEvidence.atAccountList.slice(0, 20);
      if (m.atAll) row.all = 1;
      return row;
    }).filter(r => r.id);
  }
  // 一个会话：先从最新往回翻到「上次连续存到的位置」（水位）；接上了才把水位提到这次看到的最新一条。
  // 中途断了（失败、一晚上新消息超过 80 页）就记下断点，下次先翻到断点顶端、再从断点接着往回，直到接上旧水位，中间不留缺口。
  // 没补完历史的，再从存过的最早一条往回翻到 100 天前或会话开头。
  async syncConv(job, idx, conv) {
    const owner = job.owner, meta = idx.convs[conv.id], cutoff = (idx.createdAt || this.now()) - BACKFILL_DAYS * DAY;
    const base = ['im', 'query-history-message', conv.group ? '--group-id' : '--user-account', conv.id, '--query-count', String(PAGE)];
    let added = 0, top = null, topAt = 0;
    const walk = async (cursor, stopAt) => {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const raw = await this.call(job, cursor ? [...base, '--message-id', cursor, '--query-direction', '0'] : base);
        const rows = this.rows(raw, conv, owner);
        if (rows === null) return { status: 'bad', error: 'WeLink 返回的格式不认识' };
        added += this.append(owner, conv, rows);
        for (const r of rows) {
          const id = big(r.id); if (id === null) continue;
          if (top === null || id > top) { top = id; topAt = r.at; }
          if (!meta.oldestId || id < big(meta.oldestId)) { meta.oldestId = r.id; meta.oldestAt = r.at; }
        }
        if (stopAt !== null && rows.some(r => { const id = big(r.id); return id !== null && id <= stopAt; })) return { status: 'joined' };
        if (rows.length < PAGE) return { status: 'end' };
        if (rows.some(r => r.at && r.at < cutoff)) return { status: 'cutoff' };
        const next = minBig(rows.map(r => big(r.id)).filter(x => x !== null));
        if (next === null || String(next) === cursor) return { status: 'stuck', error: '翻页游标没有前进' };
        cursor = String(next);
      }
      return { status: 'max', cursor };
    };
    const committed = meta.newestId ? big(meta.newestId) : null, resume = meta.resume || null;
    const done = s => ['joined', 'end', 'cutoff'].includes(s);
    const raise = (id, at) => { if (id !== null && (!meta.newestId || id > big(meta.newestId))) { meta.newestId = String(id); meta.newestAt = at; } };
    let head = await walk(null, resume ? big(resume.top) : committed);
    if (resume && head.status === 'joined') {
      if (big(resume.top) > (top ?? -1n)) { top = big(resume.top); topAt = resume.topAt; }
      const keepTop = top, keepAt = topAt;
      head = await walk(resume.cursor, committed);
      top = keepTop; topAt = keepAt;
    }
    if (done(head.status) || (head.status === 'max' && committed === null)) { raise(top, topAt); delete meta.resume; }
    else if (head.status === 'max') meta.resume = { cursor: head.cursor, top: String(top ?? resume?.top ?? meta.newestId), topAt: topAt || resume?.topAt || 0 };
    if (head.status === 'end' || head.status === 'cutoff') meta.backfill = 'done';
    let tail = { status: 'skip' };
    if (meta.backfill !== 'done' && meta.oldestId && !['bad', 'stuck'].includes(head.status)) {
      tail = await walk(meta.oldestId, null);
      if (tail.status === 'end' || tail.status === 'cutoff') meta.backfill = 'done';
    }
    meta.count = this.known(owner, conv.id).size;
    meta.checkedAt = this.now();
    const error = head.error || tail.error || (meta.resume ? '新消息太多，这次没接上，下次接着补' : '');
    if (error) meta.lastError = error; else delete meta.lastError;
    return { added, ok: !error };
  }
  async runJob(job) {
    const owner = job.owner, started = this.now();
    let idx = this.loadIndex(owner);
    idx.lastAttemptAt = started; this.saveIndex(owner, idx);
    const result = { at: started, trigger: job.trigger, ok: false, calls: 0, added: 0, convs: 0, failed: 0, error: '' };
    try {
      job.phase = '读会话目录'; this.a.changed?.();
      const recents = D.conversations(await this.call(job, ['im', 'query-recent-conversation', '--count', '100']));
      for (const c of recents) {
        const meta = idx.convs[c.id] ||= { name: c.name, group: c.group, firstSeen: started };
        meta.name = c.name || meta.name; meta.group = c.group; meta.lastSeen = started;
        if (!c.group && c.name && c.name !== c.id) idx.names[c.id] = c.name;
      }
      const recentIds = new Set(recents.map(c => c.id));
      const targets = Object.entries(idx.convs).filter(([id, m]) => recentIds.has(id) || !m.newestAt || started - m.newestAt < IDLE_DAYS * DAY || started - (m.checkedAt || 0) > IDLE_RECHECK_DAYS * DAY)
        .map(([id, m]) => ({ id, name: m.name, group: m.group }));
      job.total = targets.length; job.phase = '存消息';
      let streak = 0; const touched = new Set();
      for (const conv of targets) {
        try {
          const r = await this.syncConv(job, idx, conv); job.added += r.added; streak = 0;
          if (r.added) touched.add(conv.id);
          if (!r.ok) result.failed += 1;
        }
        catch (error) {
          if (error.code === 'STOPPED') throw error;
          idx.convs[conv.id].lastError = String(error.message || error).slice(0, 200); result.failed += 1; streak += 1;
          if (streak >= FAIL_STREAK) throw new Error('连续 ' + FAIL_STREAK + ' 个会话取不到（可能是限流或掉线），下次接着补：' + String(error.message || '').slice(0, 120));
        }
        job.done += 1; result.convs += 1;
        if (job.done % 5 === 0) this.saveIndex(owner, idx);
        this.a.changed?.();
      }
      job.phase = '认人名';
      const missing = new Set();
      for (const conv of targets) {
        if (!idx.convs[conv.id].group || !touched.has(conv.id)) continue;
        for (const r of this.read(owner, conv.id)) if (r.a && !r.m && !idx.names[r.a]) missing.add(r.a);
      }
      if (missing.size) {
        const resolution = await Identity.resolveNames({ run: (args, opts) => this.run(args, opts), cacheDir: this.a.dir, identity: owner, accounts: [...missing], maxCalls: 16, budgetMs: 60000, now: this.now() }).catch(() => null);
        for (const [account, entry] of resolution?.entries || []) if (entry.name) idx.names[account] = entry.name;
      }
      // 有会话没取全：本归档日 30 分钟后再试，最多 3 次，之后等下一晚（免得一个坏会话整夜重试）。
      const day = this.archiveDay(started);
      if (result.failed) idx.retry = idx.retry?.day === day ? { day, n: idx.retry.n + 1 } : { day, n: 1 }; else delete idx.retry;
      idx.lastDay = !result.failed || idx.retry.n >= 3 ? day : ''; // 没取全就清掉，好让定时器 30 分钟后再补
      result.ok = !result.failed;
      if (result.failed) result.error = `${result.failed} 个会话没取全${idx.lastDay === day ? '，明晚接着补' : '，30 分钟后重试'}`;
    } catch (error) {
      result.error = String(error.message || error).slice(0, 300);
    } finally {
      result.calls = job.calls; result.added = job.added; result.ms = this.now() - started;
      idx.runs = [...(idx.runs || []), result].slice(-30);
      try { this.saveIndex(owner, idx); } catch { /* 写不进去下次重跑 */ }
    }
    return result;
  }

  // ---- 读 ----
  read(owner, convId, { since = 0 } = {}) {
    let text = '';
    try { text = fs.readFileSync(this.file(owner, convId), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const out = [];
    for (const line of text.split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (!since || r.at >= since) out.push(r); } catch { /* 坏行跳过 */ } }
    return out.sort((a, b) => a.at - b.at || (big(a.id) < big(b.id) ? -1 : 1));
  }
  status(owner = this.owner()) {
    if (!owner) return { available: false, reason: '没有确认 WeLink 登录' };
    let idx; try { idx = this.loadIndex(owner); } catch (error) { return { available: false, reason: '档案读不出来：' + error.message }; }
    const convs = Object.values(idx.convs);
    const job = this.job && this.job.owner === owner ? { phase: this.job.phase, done: this.job.done, total: this.job.total, added: this.job.added, startedAt: this.job.startedAt } : null;
    return { available: true, enabled: this.enabled(), convs: convs.length, messages: convs.reduce((s, c) => s + (c.count || 0), 0),
      oldestAt: convs.reduce((m, c) => (c.oldestAt && (!m || c.oldestAt < m) ? c.oldestAt : m), 0) || null,
      backfillPending: convs.filter(c => c.backfill !== 'done').length, lastRun: (idx.runs || []).slice(-1)[0] || null, job };
  }
  nameOf(idx, account, owner) { return account === owner ? '我' : idx.names[account] || account; }
  line(idx, owner, r, { withDate = true } = {}) {
    const p = D.dateParts(r.at), when = p ? `${withDate ? `${pad(p.month)}-${pad(p.day)} ` : ''}${pad(p.hour)}:${pad(p.minute)}` : '时间未知';
    const at = (r.at2 || []).slice(0, 4).map(a => this.nameOf(idx, a, owner));
    return `${when} ${r.m ? '我' : this.nameOf(idx, r.a, owner)}${at.length ? ' @' + at.join(',') : ''}: ${String(r.t || '').replace(/\n/g, ' ⏎ ').slice(0, 800)}`;
  }
  // 人物材料（人物卡用）：我和此人的私聊 + 共同群里此人的发言、@此人、提到此人（各带前后一条）。
  // 超长时私聊和群各自截尾、分别保留最近的部分（私聊占 55%）：2026-11-12 试点里整体只留末尾，把私聊整段截掉了。
  personMaterial(owner, { account, name = '', days = 60, maxChars = 90000 } = {}) {
    const idx = this.loadIndex(owner), since = this.now() - days * DAY;
    const display = name || idx.names[account] || account;
    const pm = idx.convs[account] && !idx.convs[account].group ? this.read(owner, account, { since }) : [];
    const pmLines = pm.map(r => this.line(idx, owner, r));
    // 群里相关的消息先跨群按时间挑最近的、塞进预算，再按群分组输出（每个群带标题），不让排在前面的群把别的群今天的新消息挤掉。
    const entries = []; let groups = 0;
    for (const [id, meta] of Object.entries(idx.convs)) {
      if (!meta.group || (meta.newestAt && meta.newestAt < since)) continue;
      const list = this.read(owner, id, { since }), keep = new Set();
      list.forEach((r, i) => {
        if (r.a === account || (r.at2 || []).includes(account) || (display.length >= 2 && String(r.t || '').includes(display))) for (const j of [i - 1, i, i + 1]) if (list[j]) keep.add(j);
      });
      if (!keep.size) continue;
      groups += 1;
      for (const i of keep) entries.push({ conv: id, name: meta.name, at: list[i].at, order: i, line: this.line(idx, owner, list[i]) });
    }
    const groupHits = entries.length;
    const tail = (lines, budget) => { const out = []; let n = 0; for (let i = lines.length - 1; i >= 0; i -= 1) { if (n + lines[i].length + 1 > budget) break; out.unshift(lines[i]); n += lines[i].length + 1; } return out; };
    const pmKeep = tail(pmLines, entries.length ? Math.floor(maxChars * 0.55) : maxChars);
    let budget = maxChars - pmKeep.reduce((s, l) => s + l.length + 1, 0);
    const chosen = [], heads = new Set();
    for (const e of [...entries].sort((a, b) => b.at - a.at)) {
      const cost = e.line.length + 1 + (heads.has(e.conv) ? 0 : e.name.length + 20);
      if (cost > budget) break;
      budget -= cost; heads.add(e.conv); chosen.push(e);
    }
    const byConv = new Map();
    for (const e of chosen) { if (!byConv.has(e.conv)) byConv.set(e.conv, []); byConv.get(e.conv).push(e); }
    const total = new Map(); for (const e of entries) total.set(e.conv, (total.get(e.conv) || 0) + 1);
    const grpKeep = [];
    for (const list of [...byConv.values()].sort((a, b) => Math.max(...a.map(e => e.at)) - Math.max(...b.map(e => e.at)))) {
      list.sort((a, b) => a.order - b.order);
      const all = total.get(list[0].conv);
      grpKeep.push(`\n## 群「${list[0].name}」（相关 ${all} 条${list.length < all ? `，下面只是最近的 ${list.length} 条` : ''}）`, ...list.map(e => e.line));
    }
    const parts = [`# 人物材料：${display}｜最近 ${days} 天｜行格式：月-日 时:分 发言人 [@被@的人]: 内容；「我」是本机用户`, '',
      `## 私聊（${pm.length} 条${pmKeep.length < pmLines.length ? `，较长，只保留最近 ${pmKeep.length} 条` : ''}）`, ...(pmKeep.length ? pmKeep : ['（档案里没有这段时间的私聊）']),
      ...(chosen.length < entries.length ? [`\n（群聊相关较长，跨群只保留最近的 ${chosen.length} 条）`] : []), ...grpKeep];
    const text = parts.join('\n');
    return { text, lines: text.split('\n').length, stats: { private: pm.length, privateKept: pmKeep.length, groups, groupHits, since } };
  }
  // 助理问答用：按人或关键词跨月检索。只返回匹配的若干行，不整段搬。
  search(owner, { keyword = '', account = '', days = 30, limit = 60 } = {}) {
    const idx = this.loadIndex(owner), since = this.now() - Math.max(1, Math.min(365, days)) * DAY, word = String(keyword || '').trim();
    if (!word && !account) throw new Error('请给关键词或人');
    const hits = []; let total = 0;
    for (const [id, meta] of Object.entries(idx.convs)) {
      if (meta.newestAt && meta.newestAt < since) continue;
      if (hits.length > 2000) { hits.sort((a, b) => b.at - a.at); hits.length = 200; } // 只留最新的，结果集有界
      const privateWith = !meta.group && id === account;
      for (const r of this.read(owner, id, { since })) {
        const byPerson = !account || privateWith || r.a === account || (r.at2 || []).includes(account);
        if (byPerson && (!word || String(r.t || '').includes(word))) { total += 1; hits.push({ conv: meta.group ? meta.name : '私聊·' + (meta.name || id), at: r.at, r }); }
      }
    }
    hits.sort((a, b) => b.at - a.at);
    return { total, rows: hits.slice(0, Math.max(1, Math.min(200, limit))).map(h => `〔${h.conv}〕${this.line(idx, owner, h.r)}`) };
  }
  // MCP 工具 welink_history：人名对不上唯一账号时把候选列出来，不猜。
  tool(args = {}) {
    const owner = this.owner();
    if (!owner) return { ok: false, error: 'WeLink 登录还没确认，长期档案暂时不能查' };
    const st = this.status(owner);
    if (!st.messages) return { ok: false, error: '长期档案还是空的：第一次补档在每晚 23:10 后自动进行（约 1 小时）' };
    let account = '';
    if (args.person) {
      const found = this.findPerson(owner, args.person);
      if (!found.length) return { ok: false, error: `档案里没有叫「${String(args.person).slice(0, 20)}」的人，换个写法或只用关键词查` };
      if (found.length > 1 && !found.some(f => f.name === args.person)) return { ok: false, error: '对上了多个人，请用全名再查', candidates: found.map(f => f.name) };
      account = (found.find(f => f.name === args.person) || found[0]).account;
    }
    const r = this.search(owner, { keyword: args.keyword, account, days: args.days || 30, limit: args.limit || 60 });
    return { ok: true, total: r.total, shown: r.rows.length, rows: r.rows, coverage: `档案共 ${st.messages} 条，最早到 ${st.oldestAt ? D.dayKey(st.oldestAt) : '未知'}；上次补档 ${st.lastRun ? D.dayKey(st.lastRun.at) : '未进行'}` };
  }
  findPerson(owner, text) {
    const idx = this.loadIndex(owner), q = String(text || '').trim();
    if (!q) return [];
    if (idx.names[q] || idx.convs[q]) return [{ account: q, name: idx.names[q] || idx.convs[q]?.name || q }];
    return Object.entries(idx.names).filter(([, n]) => n === q || n.includes(q)).slice(0, 8).map(([account, name]) => ({ account, name }));
  }
}

module.exports = { WelinkArchive, archiveTextOf: textOf, scrub, START_MINUTE, BACKFILL_DAYS };
