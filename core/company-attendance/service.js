'use strict';
// 公司版「考勤」（2026-11-07）：每天在后台无头打开一次考勤页，截下「打卡记录」接口返回的最近 8 天，
// 按日期并进本地记录（同一天以最新为准），界面据此算加班、80 小时红线和年度统计。数据只留在本机 Hub 数据目录。
//   - 默认关闭，用户在可选功能里手动开启；关着时不访问考勤系统（main.js 不调 start()）；
//   - 取数先用 Hub 自己的隐藏浏览器窗口（和「论坛」共用登录分区，公司电脑一般经安全终端免密登录），
//     拿不到再用本机 Edge 的登录状态在无头 Edge 里打开（公司真机探针 Q-1107-25 两轮验证）；
//   - 一天成功一次就不再访问；失败隔 1 小时再试；漏几天没关系，8 天窗口内抓到一次就连得上。
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const calc = require('../attendance-calc');
const { domainFromEmail, normalizeDomain } = require('../company-forum/sites');

const RETRY_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 45 * 1000;
const TICK_MS = 10 * 60 * 1000;
const LOG_KEEP = 30;
const CARD_API = /queryCardRecord/;
const HOLIDAY_API = /queryHolidayCalendarDetails/;

function hostOf(u) { try { return u ? `（停在 ${new URL(u).host}）` : ''; } catch { return ''; } }

function attendanceUrl(domain, env = process.env) {
  if (env.CLAUDE_HUB_ATTENDANCE_URL && env.CLAUDE_HUB_DATA_DIR) return env.CLAUDE_HUB_ATTENDANCE_URL;
  return domain ? `https://hr.${domain}/apps/attendanceflow/#/myAttendance` : '';
}

function holidaysFrom(list) {
  const out = {};
  for (const h of Array.isArray(list) ? list : []) {
    const d = String(h?.holidayDate || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out[d] = String(h.holidayName || h.holidayType || '假期').slice(0, 40);
  }
  return out;
}

class CompanyAttendance {
  constructor(deps = {}) {
    this.deps = deps;
    this.dir = path.join(deps.dataDir, 'company-attendance');
    this.timers = [];
    this.syncing = null;
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  read(name, fallback) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; } }
  write(name, value) { fs.mkdirSync(this.dir, { recursive: true }); writeFileAtomic(fs, this.file(name), JSON.stringify(value, null, 1)); }
  now() { return this.deps.now ? this.deps.now() : new Date(); }
  todayKey() { return calc.dateKey(this.now()); }

  settings() {
    const s = this.read('settings', {});
    return { domain: normalizeDomain(s.domain || '') || domainFromEmail(this.deps.accountEmail?.() || ''), autoDaily: s.autoDaily !== false };
  }
  setSettings(patch = {}) {
    const s = this.read('settings', {});
    if (patch.domain !== undefined) s.domain = normalizeDomain(patch.domain);
    if (patch.autoDaily !== undefined) s.autoDaily = !!patch.autoDaily;
    this.write('settings', s);
    this.changed();
    return this.settings();
  }

  start() {
    this.stop();
    if (this.deps.noTimer) return;
    this.timers.push(setTimeout(() => { void this.tick().catch(() => {}); }, FIRST_DELAY_MS));
    this.timers.push(setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS));
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
  close() { this.stop(); }

  // 今天还没成功、距上次尝试超过 1 小时、不在 0–6 点：才去访问。
  shouldRun() {
    const st = this.read('state', {});
    const now = this.now();
    if (!this.settings().autoDaily) return false;
    if (st.lastSuccessDay === this.todayKey()) return false;
    if (now.getHours() < 6) return false;
    return !st.lastAttemptAt || now.getTime() - Date.parse(st.lastAttemptAt) >= RETRY_MS;
  }
  async tick() { if (this.shouldRun()) await this.sync({ reason: 'daily' }); }

  async capture(url) {
    const tries = [];
    if (this.deps.browser) {
      const cap = await this.deps.browser.capture({ url, clickText: '打卡记录', clickUnless: CARD_API, api: /attendanceCompanion|attendanceDocument/, maxMs: 30000, loginGraceMs: 25000 });
      const card = (cap.json || []).find((r) => CARD_API.test(String(r.url)) && (Array.isArray(r.json) || Array.isArray(r.json?.data)));
      const hol = (cap.json || []).find((r) => HOLIDAY_API.test(String(r.url)));
      const pick = (r) => (r ? (Array.isArray(r.json) ? r.json : r.json?.data) : null);
      if (card) return { ok: true, via: 'hub', records: pick(card), holidays: pick(hol) };
      tries.push({ via: 'hub', needsLogin: !!cap.needsLogin, error: cap.needsLogin ? `需要登录${hostOf(cap.finalUrl)}` : '没截到打卡记录' });
    }
    if (this.deps.edgeCapture) {
      const r = await this.deps.edgeCapture({ url });
      if (r.ok) return r;
      tries.push({ via: 'edge', needsLogin: !!r.needsLogin, error: r.error || (r.needsLogin ? '需要登录' : '失败') });
    }
    return { ok: false, needsLogin: tries.length > 0 && tries.every((t) => t.needsLogin), error: tries.map((t) => (t.via === 'hub' ? 'Hub 窗口：' : 'Edge：') + t.error).join('；') || '没有可用的取数方式' };
  }

  sync({ reason = 'manual' } = {}) {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const st = this.read('state', {});
      const at = this.now().toISOString();
      st.lastAttemptAt = at;
      this.write('state', st);
      this.changed();
      const url = attendanceUrl(this.settings().domain);
      let entry;
      if (!url) entry = { at, reason, ok: false, error: '还不知道公司域名：请在考勤设置里填写，或先在助理页登录 WeLink' };
      else {
        let r;
        try { r = await this.capture(url); } catch (e) { r = { ok: false, error: e.message }; }
        if (r.ok && Array.isArray(r.records)) {
          const merged = calc.mergeRecords(this.read('records', []), r.records, at);
          this.write('records', merged.list);
          const hol = holidaysFrom(r.holidays);
          if (Object.keys(hol).length) this.write('holidays', { ...this.read('holidays', {}), ...hol });
          entry = { at, reason, ok: true, via: r.via, got: r.records.length, added: merged.added, updated: merged.updated };
          st.lastSuccessAt = at;
          st.lastSuccessDay = this.todayKey();
        } else entry = { at, reason, ok: false, needsLogin: !!r.needsLogin, error: r.error || '失败' };
      }
      st.log = [entry, ...(st.log || [])].slice(0, LOG_KEEP);
      st.lastResult = entry;
      this.write('state', st);
      return entry;
    })().finally(() => { this.syncing = null; this.changed(); });
    return this.syncing;
  }

  login() {
    const url = attendanceUrl(this.settings().domain);
    if (!url) return Promise.resolve({ ok: false, error: '还不知道公司域名' });
    if (!this.deps.browser?.login) return Promise.resolve({ ok: false, error: '登录窗口不可用' });
    return this.deps.browser.login({ url, base: url, title: '登录（AI Hub 考勤）' });
  }

  status() {
    const st = this.read('state', {});
    const records = this.read('records', []);
    const settings = this.settings();
    const lastSuccess = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : 0;
    const staleDays = lastSuccess ? Math.floor((this.now().getTime() - lastSuccess) / 86400000) : null;
    return {
      ok: true, today: this.todayKey(), syncing: !!this.syncing, settings,
      url: attendanceUrl(settings.domain), records, holidays: this.read('holidays', {}),
      lastResult: st.lastResult || null, lastSuccessAt: st.lastSuccessAt || null, lastAttemptAt: st.lastAttemptAt || null,
      log: (st.log || []).slice(0, 10), staleDays, gapRisk: staleDays != null && staleDays >= 6,
      firstDate: records.length ? records[0].date : null,
    };
  }
  changed() { try { this.deps.onChanged?.(); } catch { /* 界面没开 */ } }
}

module.exports = { CompanyAttendance, attendanceUrl, holidaysFrom };
