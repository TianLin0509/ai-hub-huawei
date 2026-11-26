'use strict';

// 员工助手本机服务（3008 端口，无鉴权，7.9 起只听 ::1，所以用 localhost）带着本人的单点登录态：
//   POST /opencode/fetchWebPageContent {url, format, timeout} → {ok, url, finalUrl, title, content, format} 或 {ok:false, code, message}
//     公司真机实测（probe 29/30/33/34）：门户首页、心声首页、考勤页 2–4 秒拿到渲染后的页面；接口地址（JSON）回 EXTRACT_FAILED；
//     一次只处理一个，3 个并发依次在 2/5/8 秒完成——所以这里排队、一次一个，只低频用。
//   GET /v1/welinkcli/login → {ok, status:'success'|'skipped'|'failed', reason?} 约 1 秒：用员工助手的身份给 welink-cli 免密登录（不用扫码）。
//   GET /v1/health → {status:'ok', userId} 表示在线且已登录。
// 底线：没装、没开、没登录的人完全感觉不到——没装时一次网络都不发；装了也只做一次 ≤1.5 秒的自检（结果缓存）。
// 员工助手这条路单次最多 15 秒，超时立刻回到原来的取数路径；同一功能连续失败 2 次就停用这条路 30 分钟。
// 页面内容只交给调用方解析，这里不记日志、不落盘。
const link = require('./weclaw-link');

const BASES = ['http://localhost:3008'];
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_CACHE_MS = 60 * 1000;
const BUDGET_MS = 15 * 1000;
const BREAKER_FAILS = 2;
const BREAKER_MS = 30 * 60 * 1000;
const LOGIN_EVERY_MS = 30 * 60 * 1000;

function trimMsg(s, n = 120) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }

class WeclawFetch {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this.now = opts.now || (() => Date.now());
    this.installed = opts.installed || (() => !!link.findInstall());
    this.bases = opts.bases || (process.env.AI_HUB_WECLAW_BASE ? [String(process.env.AI_HUB_WECLAW_BASE).replace(/\/+$/, '')] : BASES);
    this.healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.healthCacheMs = opts.healthCacheMs ?? HEALTH_CACHE_MS;
    this.budgetMs = opts.budgetMs ?? BUDGET_MS;
    this.breakerFails = opts.breakerFails ?? BREAKER_FAILS;
    this.breakerMs = opts.breakerMs ?? BREAKER_MS;
    this.loginEveryMs = opts.loginEveryMs ?? LOGIN_EVERY_MS;
    this.health = null;        // { at, ok, base, reason }
    this.healthPending = null;
    this.breakers = {};        // feature → { fails, until, lastError }
    this.lastOk = {};          // feature → 时间
    this.queue = Promise.resolve();
    this.lastLoginAt = 0;
  }

  async request(url, { method = 'GET', body, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const res = await this.fetchImpl(url, { method, signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }) });
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.code = 'HTTP'; throw e; }
      return json;
    } catch (error) {
      if (error.name === 'AbortError') { const e = new Error('超时'); e.code = 'TIMEOUT'; throw e; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** 本机装了员工助手（只看安装位置，不发请求）。 */
  isInstalled() { try { return !!this.installed(); } catch { return false; } }

  /** 员工助手在线且已登录（缓存 60 秒）。没装时不发任何请求。 */
  async online() {
    const now = this.now();
    if (this.health && now - this.health.at < this.healthCacheMs) return this.health.ok;
    // 同时来的几个调用共用一次自检。
    if (!this.healthPending) this.healthPending = this.checkHealth().finally(() => { this.healthPending = null; });
    return this.healthPending;
  }
  async checkHealth() {
    let ok = false, base = '', reason = 'not-installed';
    if (this.isInstalled()) {
      reason = 'offline';
      for (const b of this.bases) {
        try {
          const h = await this.request(b + '/v1/health', { timeoutMs: this.healthTimeoutMs });
          if (h && h.status === 'ok') {
            if (typeof h.userId === 'string' && h.userId.trim()) { ok = true; base = b; reason = ''; } else reason = 'not-logged-in';
            break;
          }
        } catch { /* 下一个地址 */ }
      }
    }
    this.health = { at: this.now(), ok, base, reason };
    return ok;
  }

  /** 这个功能现在能不能走员工助手：在线、已登录、没被熔断。 */
  async usable(feature) {
    const b = this.breakers[feature];
    if (b && b.until > this.now()) return false;
    return this.online();
  }

  succeed(feature) { this.breakers[feature] = { fails: 0, until: 0, lastError: '' }; this.lastOk[feature] = this.now(); }
  fail(feature, why) {
    const b = this.breakers[feature] || { fails: 0, until: 0, lastError: '' };
    b.fails += 1;
    b.lastError = trimMsg(why, 80);
    if (b.fails >= this.breakerFails) { b.until = this.now() + this.breakerMs; b.fails = 0; }
    this.breakers[feature] = b;
    // 一次失败也可能是员工助手刚被关掉：下次重新自检。
    if (this.health) this.health.at = 0;
  }

  /**
   * 取一个页面（排队，一次一个；排队加取数合计不超过 budgetMs 减去自检的上限，
   * 所以「自检 + 排队 + 取数」整条员工助手路径不超过 budgetMs）。
   * 返回 {ok:true, content, finalUrl, title} 或 {ok:false, code, message}；不抛错。
   * feature 给了就不在这里记成败——调用方解析后自己 succeed / fail（解析不出也算失败）。
   */
  fetchPage(url, { format = 'text', timeoutMs } = {}) {
    const cap = Math.max(1000, this.budgetMs - this.healthTimeoutMs);
    const budget = Math.min(timeoutMs || cap, cap);
    const started = this.now();
    const run = async () => {
      const left = budget - (this.now() - started);
      if (left < Math.min(1000, budget * 0.2)) return { ok: false, code: 'TIMEOUT', message: '排队超时' };
      const base = this.health?.base || this.bases[0];
      try {
        const r = await this.request(base + '/opencode/fetchWebPageContent', { method: 'POST', timeoutMs: left,
          body: { url, format, timeout: Math.max(1000, left - 500) } });
        if (!r || r.ok !== true || typeof r.content !== 'string' || !r.content) return { ok: false, code: String(r?.code || 'EMPTY'), message: trimMsg(r?.message || '没有内容') };
        return { ok: true, content: r.content, finalUrl: String(r.finalUrl || r.url || url), title: String(r.title || '') };
      } catch (error) { return { ok: false, code: error.code || 'ERROR', message: trimMsg(error.message) }; }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(() => {}, () => {});
    return p;
  }

  /** welink-cli 免密登录（员工助手代办）：只在员工助手在线时、30 分钟最多一次。返回 {ok, status, reason}，不抛错。 */
  async welinkLogin({ canProceed } = {}) {
    if (this.now() - this.lastLoginAt < this.loginEveryMs) return { ok: false, status: 'throttled' };
    if (!(await this.online())) return { ok: false, status: 'unavailable', reason: this.health?.reason || 'offline' };
    // 等健康检查期间用户可能退出了 WeLink：发请求前再问一次调用方（审查复核 #2）。
    if (typeof canProceed === 'function' && !canProceed()) return { ok: false, status: 'cancelled' };
    this.lastLoginAt = this.now();
    try {
      const r = await this.request(this.health.base + '/v1/welinkcli/login', { timeoutMs: Math.max(1000, this.budgetMs - this.healthTimeoutMs) });
      return { ok: r?.ok === true && r?.status !== 'failed', status: String(r?.status || 'unknown'), reason: String(r?.reason || '') };
    } catch (error) { return { ok: false, status: 'error', reason: trimMsg(error.message) }; }
  }

  status() {
    const out = { online: !!this.health?.ok, reason: this.health?.reason || '', checkedAt: this.health?.at || 0, features: {} };
    for (const [k, b] of Object.entries(this.breakers)) out.features[k] = { pausedUntil: b.until > this.now() ? b.until : 0, lastError: b.lastError, lastOkAt: this.lastOk[k] || 0 };
    for (const [k, at] of Object.entries(this.lastOk)) if (!out.features[k]) out.features[k] = { pausedUntil: 0, lastError: '', lastOkAt: at };
    return out;
  }
}

let shared = null;
function sharedWeclawFetch() { return shared || (shared = new WeclawFetch()); }

// ---------------------------------------------------------------- 渲染后的 HTML → 论坛抽取用的「抓取结果」

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');
const textOf = s => decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** HTML 里全部链接：{href, text}（文字取不到时用 title 属性）。 */
function linksFromHtml(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs) || /\bhref\s*=\s*'([^']*)'/i.exec(attrs);
    if (!href) continue;
    const title = /\btitle\s*=\s*"([^"]*)"/i.exec(attrs);
    const text = textOf(m[2]) || (title ? decode(title[1]).trim() : '');
    out.push({ href: decode(href[1]), text, at: m.index });
  }
  return out;
}

/**
 * 把员工助手取回的渲染后 HTML 整理成论坛抽取（core/company-forum/extract.js postsForSite）认得的结构：
 *   { finalUrl, text, textLength, links, sections:[{heading, links, lines}], json:[] }
 * 板块按标题文字在 HTML 里的位置切：从本板块标题到下一个板块标题（最多 maxSection 个字符）。
 */
function captureFromHtml(html, { finalUrl = '', headings = [], maxSection = 6000 } = {}) {
  const src = String(html || '');
  const links = linksFromHtml(src);
  const text = textOf(src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '));
  const marks = headings.map(h => ({ heading: h, at: src.indexOf(h) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
  const sections = marks.map((x, i) => {
    const end = Math.min(i + 1 < marks.length ? marks[i + 1].at : src.length, x.at + maxSection);
    const inside = links.filter(l => l.at > x.at && l.at < end);
    return { heading: x.heading, links: inside.map(({ href, text: t }) => ({ href, text: t })), lines: inside.map(l => l.text).filter(Boolean) };
  });
  return { finalUrl, text: text.slice(0, 20000), textLength: text.length, links: links.map(({ href, text: t }) => ({ href, text: t })), sections, json: [] };
}

// ---------------------------------------------------------------- 考勤页文字 → 摘要（待处理异常数、月结截止提示）

/** 考勤首页渲染后的文字里认出「待处理考勤异常 N」和「…考勤数据处理将于…截止」那句；认不出返回 null。 */
function attendanceSummary(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const m = /待处理考勤异常\s*(\d{1,3})(?!\d)/.exec(t);
  if (!m) return null;
  const deadline = /(\d{4}年\d{1,2}月考勤数据处理将于[^。！!]{4,60}截止)/.exec(t);
  return { anomalies: Number(m[1]), deadline: deadline ? deadline[1] : '' };
}

module.exports = { WeclawFetch, sharedWeclawFetch, captureFromHtml, linksFromHtml, attendanceSummary,
  BUDGET_MS, BREAKER_FAILS, BREAKER_MS, HEALTH_TIMEOUT_MS };
