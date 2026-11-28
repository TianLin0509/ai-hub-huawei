'use strict';
// 公司网页登录体检（2026-11-27 R60）：考勤、论坛、门户用同一个 Hub 浏览器分区（persist:company-forum），
// 同事反馈「每天要重新登录」。分区本身是持久的、程序也不会自动清，剩下的嫌疑是公司统一登录的关键 cookie
// 是「关浏览器就失效」的会话级 cookie（Electron 不把它写盘，Hub 重启就丢），或服务端给的有效期本身就短。
// 这里在两个时刻各记一行，供一键反馈带回、用真实样本定根因：
//   - login-ok：用户在登录窗口登好的那一刻；
//   - needs-login：取数时发现要登录的那一刻（看重启后还剩什么）。
// 只记个数、会话级/持久、持久 cookie 的最短与最长剩余小时数，按「根域 / 登录站 / 目标站 / 其他」四类分组；
// 不记 cookie 的名字和值，也不记域名本身。同一时刻类型 30 分钟最多记一次。
// Login cookie health for the company-web partition: counts only (session vs persistent, hours left), no names/values/domains.
const fs = require('fs');
const path = require('path');

const LOG_FILE = 'company-login-check.log';
const LOG_MAX_BYTES = 128 * 1024;
const THROTTLE_MS = 30 * 60000;

const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
// 根域取主机名最后两段（公司站点都是「子域.公司域」两段根域）。
const rootOf = host => host.split('.').filter(Boolean).slice(-2).join('.');

// 登录站先于目标站判断：即使传进来的目标页恰好是登录入口，登录站的 cookie 也归「登录站」（审查 P2）。
function bucketOf(domain, target, root) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  if (d === root) return 'root';
  if (d.startsWith('login.') || d.startsWith('login1.') || d.startsWith('sso.') || d.startsWith('uniportal.')) return 'login';
  if (d === target) return 'site';
  return 'other';
}
const hours = s => Math.round(s / 360) / 10;

// cookies：Electron session.cookies.get({}) 的结果；url：本次的目标页（决定根域和目标站）。
function summarize(cookies, url, nowSec = Date.now() / 1000) {
  const target = hostOf(url), root = rootOf(target);
  const out = { total: 0, session: 0, persistent: 0, minLeftH: null, maxLeftH: null, groups: {} };
  if (!root) return out;
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const d = String(c?.domain || '').toLowerCase().replace(/^\./, '');
    if (d !== root && !d.endsWith('.' + root)) continue;
    const g = out.groups[bucketOf(d, target, root)] ||= { session: 0, persistent: 0, minLeftH: null };
    out.total += 1;
    const exp = Number(c.expirationDate);
    if (c.session || !Number.isFinite(exp)) { out.session += 1; g.session += 1; continue; }
    const left = hours(exp - nowSec);
    out.persistent += 1; g.persistent += 1;
    if (out.minLeftH === null || left < out.minLeftH) out.minLeftH = left;
    if (out.maxLeftH === null || left > out.maxLeftH) out.maxLeftH = left;
    if (g.minLeftH === null || left < g.minLeftH) g.minLeftH = left;
  }
  return out;
}

function createLoginCheck({ dataDir = '', now = () => Date.now(), throttleMs = THROTTLE_MS, logger = console } = {}) {
  const last = {};
  function write(entry) {
    if (!dataDir) return false;
    try {
      const dir = path.join(dataDir, 'logs'), file = path.join(dir, LOG_FILE);
      fs.mkdirSync(dir, { recursive: true });
      try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-LOG_MAX_BYTES / 2).replace(/^[^\n]*\n/, ''), 'utf8'); } catch { /* 还没有日志 */ }
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      return true;
    } catch { return false; }
  }
  // ses：Electron Session；stage：'login-ok' | 'needs-login'。返回写下的那一行（被节流或出错时返回 null），从不抛错。
  async function record(ses, stage, url, { flush = false } = {}) {
    try {
      if (!ses?.cookies) return null;
      const at = now();
      if (last[stage] && at - last[stage] < throttleMs) return null;
      last[stage] = at;
      // 登好那一刻先把 cookie 写盘，排除「刚登完 Hub 就被关、还没来得及写」。
      if (flush) { try { await ses.cookies.flushStore(); } catch { /* 写盘失败不影响体检 */ } }
      const entry = { at: new Date(at).toISOString(), stage, ...summarize(await ses.cookies.get({}), url, at / 1000) };
      write(entry);
      logger.info?.(`[company-login-check] ${stage} 会话级 ${entry.session} 个、持久 ${entry.persistent} 个` + (entry.minLeftH === null ? '' : `，持久最短剩 ${entry.minLeftH} 小时`));
      return entry;
    } catch { return null; }
  }
  return { record };
}

// 一键反馈（精简版只带报错行，这类记录会被全部滤掉——审查 P1）：取最近一条 login-ok 和一条 needs-login，各压成一段，
// 由 core/hub-feedback-slim.js 放进「当时的状态」。只看最近 7 天；没有记录返回空串。
const GROUP_NAMES = { root: '根域', login: '登录站', site: '目标站', other: '其他' };
const STAGE_NAMES = { 'login-ok': '登好时', 'needs-login': '要登录时' };
function feedbackSummary({ dataDir = '', now = Date.now(), fsModule = fs, maxAgeMs = 7 * 24 * 3600000 } = {}) {
  let lines = [];
  try { lines = String(fsModule.readFileSync(path.join(dataDir, 'logs', LOG_FILE), 'utf8')).trim().split(/\r?\n/).slice(-200); } catch { return ''; }
  const latest = {};
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e?.at);
    if (!STAGE_NAMES[e?.stage] || !Number.isFinite(at) || now - at > maxAgeMs) continue;
    latest[e.stage] = { ...e, atMs: at };
  }
  const pad = n => String(n).padStart(2, '0');
  const when = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const part = e => {
    const groups = Object.entries(e.groups || {}).map(([k, g]) => `${GROUP_NAMES[k] || k} 会话${g.session}/持久${g.persistent}${g.minLeftH == null ? '' : `（剩${g.minLeftH}h）`}`).join('、');
    return `${STAGE_NAMES[e.stage]}（${when(e.atMs)}）会话级 ${e.session} 个、持久 ${e.persistent} 个${e.minLeftH == null ? '' : `、持久最短剩 ${e.minLeftH}h`}${groups ? `：${groups}` : ''}`;
  };
  return ['login-ok', 'needs-login'].filter(k => latest[k]).map(k => part(latest[k])).join('；');
}

module.exports = { summarize, createLoginCheck, feedbackSummary, LOG_FILE };
