'use strict';
// 公司版「帖子」服务（原「论坛」，2026-10-18；2026-11-12 加公司发文）：每天同步公司发文、稼先社区、心声社区，附 AI 摘要。数据只留在这台电脑。
//         不行再用 Hub 自己的隐藏窗口；哪条通了记下来，下次先走它。进站一律先过公司统一登录入口（sites.entryUrl）。
//   发文：白天每隔一段时间（默认 60 分钟）只重看公司发文，有新的就发一条提醒（桌宠或通知卡）。
//   取数：Hub 自己的隐藏浏览器窗口打开两站首页（main/company-forum-browser.js），截下页面取数据的 JSON 响应和帖子链接，
//         按 extract.js 认出各排行榜；再打开排在前面的帖子读正文摘录。登录状态存在 Hub 自己的浏览器分区里，
//         没登录时页面上点「登录」弹出同一分区的窗口，登录一次以后都能用。
//         回来的每条都要指回真实帖子编号（summary.js），指不回的删掉。
//   定时：工作日到点（默认 08:30）同步一次；打开帖子页时当天还没有就当场同步；可手动刷新。历史留 7 天。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const S = require('./sites');
const X = require('./extract');
const M = require('./summary');

const PURPOSE = 'company-forum';
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, syncTime: '08:30', workdays: [1, 2, 3, 4, 5], domain: '', perList: 20, summarize: 10, docsEveryMin: 60, docsNotify: true });
const INSTRUCTIONS = [
  '你在公司电脑上帮我整理公司发文和内部论坛（稼先社区、心声社区）今天的内容。请遵守：',
  '1. 只依据提问里给出的帖子标题和正文摘录写，不调用工具、不访问网络、不在当前目录以外写文件。',
  '2. 每条看点和摘要都写清依据的帖子编号（P1、P2……），不编造帖子里没有的内容。',
  '3. 按提问要求只输出 JSON。',
].join('\n');
const JOB_TIMEOUT_MS = 10 * 60000;
const EXCERPT_CHARS = 3000;
const KEEP_DAYS = 7;
const SEEN_KEEP = 600;
const ROUTE_NAME = { edge: 'Edge', hub: 'Hub 窗口' };
const pad = n => String(n).padStart(2, '0');
const dayKey = (at = Date.now()) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const minutesOf = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

class CompanyForum {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
    this.dir = path.join(deps.dataDir, 'company-forum');
    this.workspace = path.join(this.dir, 'workspace');
    this.job = null;
    this.syncing = null;
    this.pendingLoginSites = new Set();
    this.progress = '';
    this.syncError = '';
    this.logins = {};
    this.loginErrors = {};
    this.timers = [];
  }

  // ---- 本地文件（只在这台电脑的 Hub 数据目录里） ----
  file(name) { return path.join(this.dir, name); }
  read(name, fallback) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; } }
  write(name, value) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(name) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, this.file(name));
  }
  settings() { return { ...DEFAULT_SETTINGS, ...this.read('settings.json', {}) }; }
  setSettings(patch = {}) {
    const next = { ...this.settings() };
    if ('enabled' in patch) next.enabled = !!patch.enabled;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.syncTime || ''))) next.syncTime = String(patch.syncTime);
    if (Array.isArray(patch.workdays)) next.workdays = [...new Set(patch.workdays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    if ('domain' in patch) { const d = S.normalizeDomain(patch.domain); if (patch.domain && !d) throw new Error('域名格式不对，例如 corp.example.com'); next.domain = d; }
    if ('docsNotify' in patch) next.docsNotify = !!patch.docsNotify;
    if ('docsEveryMin' in patch && Number.isFinite(Number(patch.docsEveryMin))) { const n = Math.round(Number(patch.docsEveryMin)); next.docsEveryMin = n <= 0 ? 0 : Math.min(240, Math.max(15, n)); }
    for (const [k, lo, hi] of [['perList', 5, 30], ['summarize', 0, 20]]) if (k in patch && Number.isFinite(Number(patch[k]))) next[k] = Math.min(hi, Math.max(lo, Math.round(Number(patch[k]))));
    this.write('settings.json', next);
    this.changed();
    return next;
  }
  state() { return { ...this.read('state.json', {}) }; }
  saveState(patch) { const s = { ...this.state(), ...patch }; this.write('state.json', s); return s; }
  snapshot(day = dayKey(this.now())) { return this.read(`forum-${day}.json`, null); }
  latest() {
    const today = this.snapshot();
    if (today) return today;
    try {
      const days = fs.readdirSync(this.dir).map(f => /^forum-(\d{4}-\d\d-\d\d)\.json$/.exec(f)).filter(Boolean).map(m => m[1]).sort();
      return days.length ? this.snapshot(days[days.length - 1]) : null;
    } catch { return null; }
  }
  changed() { try { this.deps.onChanged?.(); } catch { /* 界面没开 */ } }

  // 站点域名：设置里填的优先；否则用本人公司邮箱的域名（助理页已从 WeLink 账号读到）。
  domain() {
    const s = this.settings();
    if (s.domain) return { domain: s.domain, from: 'settings' };
    const email = (() => { try { return this.deps.accountEmail?.() || ''; } catch { return ''; } })();
    const d = S.domainFromEmail(email);
    if (d) return { domain: d, from: 'email' };
    // 考勤等功能自动找到并记下的公司域名（core/company-domain.js）。
    return require('../company-domain').knownDomain(this.deps.dataDir);
  }
  bases() { return S.siteBases(this.domain().domain, this.deps.env || process.env); }
  // 只放行这几个站点的网址（点帖子用系统浏览器打开）。
  allowedUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    return Object.values(this.bases()).some(b => { try { return new URL(b).host === u.host; } catch { return false; } });
  }

  // 可选功能开关（core/optional-features.js）：关着时 main.js 不调 start()；用到一半关掉走 close()，再开再 start()。
  start() {
    if (this.timers.length) return;
    if (!this.domain().domain) void require('../company-domain').resolveDomain(this.deps.dataDir, { lookupEmail: this.deps.lookupEmail || null, gitEmail: this.deps.gitEmail || null }).then(r => { if (r.domain) this.changed(); }).catch(() => {});
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.writeFileSync(path.join(this.workspace, 'CLAUDE.md'), '# 公司论坛热帖整理\n\n' + INSTRUCTIONS + '\n', 'utf8');
    // 重启前没写完的摘要：标出来，下次同步或点「重新整理」再来。
    const snap = this.snapshot();
    if (snap && snap.summarizing) this.write(`forum-${snap.day}.json`, { ...snap, summarizing: false, summaryNote: 'Hub 重启前摘要没写完，点「重新整理」再来。' });
    // 收 AI 回答的循环一直要跑；noTimer（单测、或 CLAUDE_HUB_FORUM_TIMER=0）只关掉定时同步。noCollect 只给单测用。
    if (!this.deps.noCollect) this.timers.push(setInterval(() => { void this.collectJob().catch(e => console.warn('[company-forum] collect', e.message)); }, 4000));
    if (this.deps.noTimer) return;
    this.timers.push(setInterval(() => { void this.tick().catch(e => console.warn('[company-forum] tick', e.message)); }, 60000));
    const first = setTimeout(() => { void this.tick().catch(() => {}); }, 20000); this.timers.push(first);
  }
  close() { for (const t of this.timers) { clearInterval(t); clearTimeout(t); } this.timers = []; }

  nextSyncAt(s = this.settings(), now = this.now()) {
    const at = new Date(now), [h, m] = s.syncTime.split(':').map(Number);
    for (let i = 0; i < 8; i += 1) {
      const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() + i, h, m);
      if (d.getTime() > now && (s.workdays || []).includes(d.getDay())) return d.getTime();
    }
    return null;
  }
  async tick() {
    const s = this.settings(), now = this.now(), d = new Date(now), minute = d.getHours() * 60 + d.getMinutes();
    if (!s.enabled || !(s.workdays || []).includes(d.getDay()) || minute < minutesOf(s.syncTime) || minute >= 21 * 60) return;
    const snap = this.snapshot();
    // 当天还没同步；或上次有站点没登录 / 没取到，30 分钟后再试（每天最多 6 次）。
    const failed = snap && snap.sites.some(x => !x.ok) && (snap.attempts || 1) < 6 && now - (snap.at || 0) >= 30 * 60000;
    if (!snap || failed) { await this.sync({ reason: 'timer' }).catch(() => {}); return; }
    // 公司发文要及时：当天已同步过之后，每隔 docsEveryMin 分钟只重看发文这一站。
    const docs = snap.sites.find(x => S.siteById(x.id)?.docs);
    if (s.docsEveryMin > 0 && docs && now - (docs.at || 0) >= s.docsEveryMin * 60000) await this.sync({ sites: [docs.id], reason: 'docs' }).catch(() => {});
  }

  routes() {
    const list = [['edge', this.deps.edgeBrowser], ['hub', this.deps.browser]].filter(r => r[1]);
    const prefer = this.state().route;
    return prefer ? list.sort((a, b) => (b[0] === prefer) - (a[0] === prefer)) : list;
  }
  async open(kind, opts) {
    let login = null;
    const errors = [];
    for (const [name, browser] of this.routes()) {
      if (typeof browser[kind] !== 'function') continue;
      try {
        const r = await browser[kind](opts);
        if (r && !r.needsLogin && !X.looksLikeLogin(r, opts.base)) { if (this.state().route !== name) this.saveState({ route: name }); return { ...r, via: name }; }
        login = { ...(r || {}), needsLogin: true, via: name };
      } catch (error) { errors.push(`${ROUTE_NAME[name]}：${short(error.message, 80)}`); }
    }
    if (login) return login;
    throw new Error(errors.join('；') || '浏览器窗口不可用');
  }

  // ---- 同步 ----
  sync({ sites = null, reason = 'manual' } = {}) {
    if (this.syncing) {
      // 多个登录回执只合并到下一次同步，不为每个回执另排一个任务。
      if (reason === 'login') for (const id of sites || []) this.pendingLoginSites.add(id);
      return this.syncing;
    }
    this.syncError = '';
    this.syncing = this.collect({ only: sites, reason }).catch(error => {
      const why = error.code === 'EISDIR' ? '保存位置被同名文件夹占用（EISDIR）' : short(error.message, 120);
      this.syncError = `帖子同步失败：${why}。点「刷新」重试。`;
      throw error;
    }).finally(() => {
      this.syncing = null;
      this.progress = '';
      const pending = [...this.pendingLoginSites];
      this.pendingLoginSites.clear();
      if (pending.length) void this.sync({ sites: pending, reason: 'login' }).catch(error => console.warn('[company-forum] login sync', error.message));
      this.changed();
    });
    this.changed();
    return this.syncing;
  }
  setProgress(text) { this.progress = text; this.changed(); }
  async collect({ only = null, reason = 'manual' } = {}) {
    const now = this.now(), day = dayKey(now), s = this.settings(), bases = this.bases(), prev = this.snapshot(day);
    // 只重看发文（reason=docs）不算一次整体同步：同步时间、重试次数、AI 看点都沿用当天已有的。
    const light = reason === 'docs' && !!prev;
    const snap = { day, at: light ? prev.at : now, reason: light ? prev.reason : reason, extractionVersion: X.EXTRACTION_VERSION, attempts: light ? prev.attempts || 1 : (prev?.attempts || 0) + 1, domain: this.domain(), sites: [], overview: prev?.overview || [],
      summaryNote: light ? prev.summaryNote || '' : '', summarizing: light ? !!prev.summarizing : false, ...(light && prev.summaryAt ? { summaryAt: prev.summaryAt } : {}) };
    const haveRoute = this.routes().length > 0;
    const fresh = [];
    for (const site of S.SITES) {
      const old = prev?.sites?.find(x => x.id === site.id);
      if (only && !only.includes(site.id) && old) {
        // 局部重抓不能让另一站仍旧的抽取结果也变成新版。
        if (prev.extractionVersion !== X.EXTRACTION_VERSION) snap.extractionVersion = prev.extractionVersion || 0;
        snap.sites.push(old); continue;
      }
      const base = bases[site.id], home = S.homeUrl(site, base);
      const entry = { id: site.id, name: site.name, short: site.short, base: base || '', home, ok: false, needsLogin: false, error: '', lists: [], at: this.now() };
      if (!base) { entry.error = '还不知道公司站点的域名：在「设置」里填一次（一般就是公司邮箱 @ 后面那段）。'; snap.sites.push(entry); continue; }
      if (!haveRoute) { entry.error = '浏览器窗口不可用'; snap.sites.push(entry); continue; }
      this.setProgress(`正在打开${site.name}…`);
      try {
        const cap = await this.open('capture', { url: S.entryUrl(site, base, snap.domain.domain, this.deps.env || process.env), base, clickText: site.clickText, clickUnless: site.clickUnless || null, sections: site.lists.map(l => l.heading), api: site.api, loginGraceMs: 25000, until: site.docsApi || null });
        entry.via = cap.via || '';
        if (cap.needsLogin) { entry.needsLogin = true; entry.error = `${site.name}没能自动登录：点「登录」在弹出的窗口里登录一次，以后自动同步（平时用 Edge 打开过公司网页的话，一般不用这一步）。`; }
        else {
          entry.lists = X.postsForSite(site, cap, { base, limit: s.perList });
          entry.ok = entry.lists.some(l => l.posts.length);
          if (entry.ok && site.docs) fresh.push(...this.markNewDocs(entry));
          if (!entry.ok) entry.error = `${site.name}打开了，但没认出热帖（页面可能改版了）。诊断信息存在本机，可以让 CodeAgent 帮忙看。`;
        }
        this.writeDiagnostic(site, cap, entry);
      } catch (error) { entry.error = `${site.name}没打开：${short(error.message, 120)}`; }
      snap.sites.push(entry);
    }
    // 排在前面的帖子读正文摘录（给摘要用）；上一次同步读过的不重读。
    const picked = M.pickForSummary(snap, s.summarize);
    const oldPosts = new Map((prev?.sites || []).flatMap(x => x.lists.flatMap(l => l.posts)).map(p => [p.url || p.title, p]));
    const oldExcerpt = new Map([...oldPosts].filter(([, p]) => p.excerpt).map(([k, p]) => [k, p.excerpt]));
    // 重抓的站点：同一帖已写好的一句话摘要接着用（重新整理时再覆盖）。
    for (const p of snap.sites.flatMap(x => x.lists.flatMap(l => l.posts))) { const old = oldPosts.get(p.url || p.title); if (old?.summary && !p.summary) p.summary = old.summary; }
    if (light) {
      for (const p of snap.sites.flatMap(x => x.lists.flatMap(l => l.posts))) { const old = oldPosts.get(p.url || p.title); if (old?.excerpt && !p.excerpt) p.excerpt = old.excerpt; }
      // 取数这几十秒里快照可能被别处改过（AI 摘要写完）：以磁盘上最新的为底，只换掉这次重看的站点。
      const cur = this.snapshot(day) || prev;
      const curPosts = new Map(cur.sites.flatMap(x => x.lists.flatMap(l => l.posts)).map(p => [p.url || p.title, p]));
      const refreshed = snap.sites.filter(e => !only || only.includes(e.id) || !cur.sites.some(x => x.id === e.id));
      for (const p of refreshed.flatMap(x => x.lists.flatMap(l => l.posts))) { const old = curPosts.get(p.url || p.title); if (old?.summary) p.summary = old.summary; }
      Object.assign(snap, { ...cur, extractionVersion: snap.extractionVersion, sites: snap.sites.map(e => refreshed.includes(e) ? e : cur.sites.find(x => x.id === e.id) || e) });
      this.write(`forum-${day}.json`, snap);
      this.notifyDocs(fresh);
      this.changed();
      return snap;
    }
    let n = 0;
    for (const x of picked) {
      const p = x.post, key = p.url || p.title;
      n += 1;
      if (oldExcerpt.has(key)) { p.excerpt = oldExcerpt.get(key); continue; }
      if (!p.url) { if (p.abstract) p.excerpt = p.abstract; continue; }
      this.setProgress(`正在读帖子正文 ${n}/${picked.length}…`);
      try {
        const d = await this.open('detail', { url: p.url, base: snap.sites.find(e => e.id === x.site)?.base, api: S.siteById(x.site).api });
        if (d && !d.needsLogin) {
          p.excerpt = short(d.text, EXCERPT_CHARS);
          // 排行里没有的数字（心声只有标题和链接）从详情页的接口数据补上。
          const extra = X.countsFromJson((d.json || []).map(r => r.json));
          for (const k of ['views', 'replies', 'likes', 'favs', 'time']) if (p[k] == null && extra[k] != null) p[k] = extra[k];
        }
      } catch { /* 读不到正文就只按标题写 */ }
      if (!p.excerpt && p.abstract) p.excerpt = p.abstract; // 发文接口自带的摘要
    }
    snap.picked = picked.map(x => ({ source: x.source, site: x.site, title: x.post.title }));
    this.write(`forum-${day}.json`, snap);
    this.prune();
    this.notifyDocs(fresh);
    if (picked.length) this.summarize(day, picked); else this.changed();
    return snap;
  }
  // 发文是否新出现：记下每条第一次看到的时间（state.seenDocs）。第一次同步只打底，不算新；返回这次新出现的几条。
  markNewDocs(entry) {
    const st = this.state(), first = !st.seenDocs, seen = { ...(st.seenDocs || {}) }, now = this.now(), fresh = [];
    for (const list of entry.lists) for (const p of list.posts) {
      const key = p.id || p.url;
      if (!(key in seen)) { seen[key] = first ? 0 : now; if (!first) fresh.push({ list: list.label, title: p.title }); }
      if (seen[key]) p.firstSeen = seen[key];
    }
    const keep = Object.entries(seen).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).slice(0, SEEN_KEEP);
    this.saveState({ seenDocs: Object.fromEntries(keep) });
    return fresh;
  }
  // 有新发文：交给提醒总线（开着桌宠时桌宠说，没开时右下角通知卡），点开到帖子页。
  notifyDocs(fresh) {
    if (!fresh.length || !this.settings().docsNotify || typeof this.deps.publish !== 'function') return;
    try {
      this.deps.publish({ id: `docs:${this.now()}`, kind: 'docs', notify: true, page: 'forum', cta: '打开帖子',
        title: `公司发文上新 ${fresh.length} 条`, text: fresh.slice(0, 3).map(x => `【${x.list}】${short(x.title, 40)}`).join('\n') + (fresh.length > 3 ? `\n……共 ${fresh.length} 条` : '') });
    } catch { /* 提醒发不出去不影响同步 */ }
  }
  // 本机诊断：页面认帖失败时，看截到了哪些接口、什么字段（只存结构和前几条标题，不出这台电脑）。
  writeDiagnostic(site, cap, entry) {
    try {
      const keys = v => v && typeof v === 'object' ? Object.keys(Array.isArray(v) ? (v[0] || {}) : v).slice(0, 30) : [];
      this.write(`diagnostic-${site.id}.json`, { at: this.now(), finalUrl: cap.finalUrl, title: cap.title, textLength: cap.textLength, needsLogin: entry.needsLogin, ok: entry.ok,
        lists: entry.lists.map(l => ({ key: l.key, from: l.from, count: l.posts.length })),
        sections: (cap.sections || []).map(x => ({ heading: x.heading, found: !!x.found, links: (x.links || []).length, lines: (x.lines || []).slice(0, 12) })),
        links: (cap.links || []).length, sampleLinks: (cap.links || []).slice(0, 15),
        json: (cap.json || []).map(r => ({ url: String(r.url).replace(/\?.*$/, ''), status: r.status, keys: keys(r.json), arrays: X.postArrays(r.json).map(a => a.length) })) });
    } catch { /* 诊断写不了不要紧 */ }
  }
  prune() {
    try {
      const keep = dayKey(this.now() - KEEP_DAYS * 86400000);
      for (const f of fs.readdirSync(this.dir)) { const m = /^forum-(\d{4}-\d\d-\d\d)\.json$/.exec(f); if (m && m[1] < keep) fs.unlinkSync(this.file(f)); }
    } catch { /* 清理失败不要紧 */ }
  }

  // ---- 摘要（CodeAgent） ----
  summarize(day, picked = null) {
    const snap = this.snapshot(day);
    if (!snap) throw new Error('今天还没同步');
    const list = picked || M.pickForSummary(snap, this.settings().summarize);
    if (!list.length) throw new Error('没有可整理的帖子');
    // 摘录在 picked 的帖子对象上；重新整理时从快照里找回来。
    const posts = new Map(snap.sites.flatMap(x => x.lists.flatMap(l => l.posts.map(p => [x.id + '|' + p.title, p]))));
    const items = list.map(x => ({ ...x, post: posts.get(x.site + '|' + x.post.title) || x.post }));
    this.write(`forum-${day}.json`, { ...snap, summarizing: true, summaryNote: 'AI 正在写摘要，先看热帖列表。' });
    this.job = { id: randomUUID(), day, picked: items.map(x => ({ source: x.source, site: x.site, title: x.post.title })), prompt: M.summaryPrompt(items, { day }) };
    this.changed();
    void this.pump();
    return { ok: true };
  }
  sessionBusy(id) {
    const s = id && this.deps.getSession(id);
    if (!s) return false;
    return !!this.deps.isAgentTurnActive?.(id) || s.status === 'running';
  }
  lastFinal(id) {
    const meta = this.deps.getSession(id) || this.deps.getSessionMetadata?.(id);
    const records = meta && this.deps.readFinals ? this.deps.readFinals(meta) : [];
    return records && records.length ? records[records.length - 1] : null;
  }
  async ensureSession() {
    let id = this.state().sessionId;
    if (id && this.deps.getSession(id)) return id;
    if (id && this.deps.getSessionMetadata?.(id)) {
      try { await this.deps.resumeSession(id); } catch { /* 恢复不了就新开 */ }
      if (this.deps.getSession(id)) return id;
    }
    id = randomUUID();
    const created = await this.deps.createSession('codeagent', { id, cwd: this.workspace, title: '论坛热帖整理', purpose: PURPOSE, autonomous: true, noInheritCursor: true });
    if (!created || created.id !== id) throw new Error('整理会话没能打开');
    this.saveState({ sessionId: id, primed: null });
    return id;
  }
  async pump() {
    const job = this.job;
    if (!job || job.sentAt || this.pumping) return;
    this.pumping = true;
    try {
      const id = await this.ensureSession();
      if (this.sessionBusy(id)) return; // 会话还在忙上一件事：下一轮再发
      const st = this.state();
      const prompt = st.primed === id ? job.prompt : INSTRUCTIONS + '\n\n---\n\n' + job.prompt;
      job.baseline = this.lastFinal(id)?.id || null;
      job.sessionId = id;
      job.sentAt = this.now();
      const receipt = await this.deps.sendPrompt(id, prompt, randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '没有发进整理会话');
      this.saveState({ primed: id });
    } catch (error) {
      this.finishSummary(job, '', error.message);
    } finally { this.pumping = false; this.changed(); }
  }
  async collectJob() {
    const job = this.job;
    if (!job) return;
    if (!job.sentAt) { void this.pump(); return; }
    if (this.sessionBusy(job.sessionId)) { if (this.now() - job.sentAt > JOB_TIMEOUT_MS * 2) this.finishSummary(job, '', '整理会话忙了太久'); return; }
    const final = this.lastFinal(job.sessionId);
    if (final && final.id !== job.baseline && String(final.text || '').trim()) { this.finishSummary(job, final.text, null); return; }
    if (this.now() - job.sentAt > JOB_TIMEOUT_MS) this.finishSummary(job, '', `整理会话 ${Math.round(JOB_TIMEOUT_MS / 60000)} 分钟没给出回答`);
  }
  finishSummary(job, text, error) {
    if (this.job === job) this.job = null;
    const snap = this.snapshot(job.day);
    if (!snap) { this.changed(); return; }
    const parsed = error ? null : M.parseSummary(text, job.picked);
    const next = { ...snap, summarizing: false };
    if (parsed) {
      const bySource = new Map(job.picked.map(x => [x.source, x]));
      for (const site of next.sites) for (const list of site.lists) for (const p of list.posts) {
        const hit = job.picked.find(x => x.site === site.id && x.title === p.title);
        if (hit && parsed.items[hit.source]) p.summary = parsed.items[hit.source];
      }
      next.overview = parsed.overview.map(o => ({ text: o.text, refs: o.sources.map(src => bySource.get(src)).filter(Boolean).map(x => ({ site: x.site, title: x.title })) }));
      next.summaryAt = this.now();
      next.summaryNote = parsed.dropped ? `AI 写的内容里有 ${parsed.dropped} 条对不上帖子，已删掉。` : '';
    } else {
      next.summaryNote = error ? `AI 摘要没写完（${short(error, 80)}），下面是热帖列表。` : 'AI 的回答读不出来，下面是热帖列表。';
    }
    this.write(`forum-${job.day}.json`, next);
    this.changed();
  }

  // ---- 登录（只在用户点按钮时）：弹出 Hub 自己浏览器分区的窗口，登录好了自动关掉并重新同步这个站 ----
  async login(siteId) {
    const site = S.siteById(siteId);
    if (!site) throw new Error('不认识这个站点');
    const base = this.bases()[site.id];
    if (!base) throw new Error('还不知道公司站点的域名：先在「设置」里填');
    if (this.logins[site.id] === 'waiting') return { ok: true, state: 'waiting' };
    if (!this.deps.browser?.login) throw new Error('浏览器窗口不可用');
    const entry = S.entryUrl(site, base, this.domain().domain, this.deps.env || process.env);
    this.logins[site.id] = 'waiting';
    this.loginErrors[site.id] = '';
    this.changed();
    void Promise.resolve().then(() => this.deps.browser.login({ url: entry, base, site: site.id, title: `登录${site.name}（AI Hub 帖子）` }))
      .then(r => {
        this.logins[site.id] = r && r.ok ? 'ok' : 'closed';
        this.loginErrors[site.id] = r?.error || '';
        if (r?.reason === 'already-open') {
          const other = S.siteById(r.site)?.short || '另一个站点';
          this.loginErrors[site.id] = `${other}的登录窗口还开着，先在那边登录或关掉，再试一次。`;
        }
        // 手动登录的是 Hub 窗口：下次先走它。
        if (r && r.ok) { this.saveState({ route: 'hub' }); return this.sync({ sites: [site.id], reason: 'login' }); }
        return null;
      })
      .catch(error => { this.logins[site.id] = 'closed'; this.loginErrors[site.id] = error.message; })
      .finally(() => this.changed());
    return { ok: true, state: 'waiting' };
  }

  status() {
    const s = this.settings(), snap = this.latest(), dom = this.domain();
    return { ok: true, now: this.now(), day: dayKey(this.now()), settings: s, domain: dom.domain, domainFrom: dom.from,
      sites: S.SITES.map(x => ({ id: x.id, name: x.name, short: x.short, base: this.bases()[x.id] || '', login: this.logins[x.id] || null, loginError: this.loginErrors[x.id] || '' })),
      snapshot: snap, today: !!(snap && snap.day === dayKey(this.now())), needsRefresh: !!(snap && snap.day === dayKey(this.now()) && snap.extractionVersion !== X.EXTRACTION_VERSION), syncing: !!this.syncing, progress: this.progress, syncError: this.syncError,
      route: this.state().route || '', job: this.job ? { sentAt: this.job.sentAt || null } : null, nextSyncAt: this.nextSyncAt(s), session: this.state().sessionId || null };
  }
}

module.exports = { CompanyForum, PURPOSE, DEFAULT_SETTINGS, INSTRUCTIONS, dayKey };
