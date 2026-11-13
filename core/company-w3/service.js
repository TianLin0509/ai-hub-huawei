'use strict';
// 公司版「门户待办」（2026-11-12）：每天早上 6 点后在后台无头打开一次公司门户首页（同考勤），读回
// 待办、我的申请、任务数和公司文件各栏目，和上一次比出「新来的」「办完的」，交给桌宠提醒、助理简报和助理问答用。
//   - 默认关闭，用户在可选功能里手动开启；关着时不访问门户（main.js 不调 start()）；
//   - 取数只走无头 Edge（main/company-edge-capture.js）：公司电脑的安全客户端会自动完成单点登录，不用用户登录或填任何东西；
//   - 只读：只发首页自己会发的查询，不点审批、不提交表单；数据只留在本机 Hub 数据目录；
//   - 当天成功一次就不再自动访问，失败隔 1 小时再试；页面上的「刷新」随时手动取。
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../atomic-write');
const { normalizeDomain } = require('../company-forum/sites');
const companyDomain = require('../company-domain');
const { collectScript } = require('./collect-script');
const model = require('./model');

const RETRY_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 60 * 1000;
const TICK_MS = 5 * 60 * 1000;
const LOG_KEEP = 30;
const DAY_START_HOUR = 6;

function portalUrl(domain, env = process.env) {
  if (env.CLAUDE_HUB_W3_URL && env.CLAUDE_HUB_DATA_DIR) return env.CLAUDE_HUB_W3_URL;
  return domain ? `https://w3.${domain}/` : '';
}
// 首页最终落在 /next/index*.html；登录跳转途中会短暂经过同一类地址，由页面内的账号查询判定是否真的登录好了。
function readyUrlOf(url) {
  let origin = '';
  try { origin = new URL(url).origin; } catch { return /^$/; }
  return new RegExp('^' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(next/index\\w*\\.html)?$');
}
function dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

class CompanyW3 {
  constructor(deps = {}) {
    this.deps = deps;
    this.dir = path.join(deps.dataDir, 'company-w3');
    this.timers = [];
    this.syncing = null;
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  read(name, fallback) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return fallback; } }
  write(name, value) { fs.mkdirSync(this.dir, { recursive: true }); writeFileAtomic(fs, this.file(name), JSON.stringify(value, null, 1)); }
  now() { return this.deps.now ? this.deps.now() : new Date(); }

  settings() {
    const s = this.read('settings', {});
    const own = normalizeDomain(s.domain || '');
    const known = own ? null : companyDomain.knownDomain(this.deps.dataDir);
    return { domain: own || known.domain, domainFrom: own ? 'settings' : known.from, auto: s.auto !== false, remind: s.remind !== false };
  }
  setSettings(patch = {}) {
    const s = this.read('settings', {});
    if (patch.domain !== undefined) s.domain = normalizeDomain(String(patch.domain).includes('@') ? String(patch.domain).split('@').pop() : patch.domain);
    if (patch.auto !== undefined) s.auto = !!patch.auto;
    if (patch.remind !== undefined) s.remind = !!patch.remind;
    this.write('settings', s);
    this.changed();
    return this.settings();
  }

  start() {
    this.stop();
    this.closed = false;
    if (this.deps.noTimer) return;
    this.timers.push(setTimeout(() => { void this.tick().catch(() => {}); }, FIRST_DELAY_MS));
    this.timers.push(setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS));
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
  // 关掉功能：停定时器，并取消正在进行的取数（结果不写、不提醒）。
  close() { this.stop(); this.closed = true; this.abort?.abort(); }

  // 今天还没成功、已过早上 6 点、距上次尝试超过 1 小时：才自动访问（同考勤）。
  shouldRun() {
    if (!this.settings().auto) return false;
    const st = this.read('state', {});
    const now = this.now();
    if (now.getHours() < DAY_START_HOUR) return false;
    if (st.lastSuccessAt && dayKey(new Date(st.lastSuccessAt)) === dayKey(now)) return false;
    return !st.lastAttemptAt || now.getTime() - Date.parse(st.lastAttemptAt) >= RETRY_MS;
  }
  async tick() { if (this.shouldRun()) await this.sync({ reason: 'auto' }); }

  sync({ reason = 'manual' } = {}) {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const st = this.read('state', {});
      const at = this.now().toISOString();
      st.lastAttemptAt = at;
      this.write('state', st);
      this.changed();
      const url = portalUrl(this.settings().domain);
      let entry;
      if (!url) entry = { at, reason, ok: false, needsDomain: true, error: '没能自动找到公司域名：在设置里填一下你的公司邮箱就行' };
      else if (typeof this.deps.edgeRun !== 'function') entry = { at, reason, ok: false, error: '没有可用的取数方式' };
      else {
        let r;
        this.abort = new AbortController();
        try { r = await this.deps.edgeRun({ url, readyUrl: readyUrlOf(url), script: collectScript(), accept: (v) => !!v?.login, signal: this.abort.signal, tag: 'hub-w3' }); } catch (e) { r = { ok: false, error: e.message }; }
        if (this.closed) return { at, reason, ok: false, error: '功能已关闭，这次结果不保存' };
        const cur = r.ok ? model.normalize(r.value, at) : null;
        if (cur?.ok) {
          const snap = model.merge(this.read('snapshot', null), cur);
          const notices = this.settings().remind ? model.noticesFor(snap, this.now().getTime()) : [];
          this.write('snapshot', snap);
          if (typeof this.deps.publish === 'function') for (const n of notices) { try { this.deps.publish(n); } catch { /* 提醒发不出不影响取数 */ } }
          // 待办或申请没取全：快照照常并入（没取全的那类保留旧条目），但不算当天成功，1 小时后再取一次。
          const complete = !cur.partial.some((p) => /^(todo|apply)(:|$)/.test(p));
          entry = { at, reason, ok: true, complete, tookMs: r.tookMs || 0, todo: snap.todo.length, apply: snap.apply.length, added: snap.added.todo.length, done: snap.done.todo.length, newDocs: snap.added.docs.length, partial: snap.partial, notices: notices.length };
          if (complete) st.lastSuccessAt = at;
          else st.lastPartialAt = at;
        } else entry = { at, reason, ok: false, needsLogin: !!r.needsLogin, tookMs: r.tookMs || 0, error: r.error || '门户没有返回账号信息' };
      }
      st.log = [entry, ...(st.log || [])].slice(0, LOG_KEEP);
      st.lastResult = entry;
      this.write('state', st);
      return entry;
    })().finally(() => { this.syncing = null; this.changed(); });
    return this.syncing;
  }

  snapshot() { return this.read('snapshot', null); }
  status() {
    const st = this.read('state', {});
    const snap = this.snapshot();
    const now = this.now().getTime();
    const withAge = (list) => (list || []).map((x) => ({ ...x, ageDays: model.ageDays(x.time, now) }));
    return {
      ok: true, syncing: !!this.syncing, settings: this.settings(), url: portalUrl(this.settings().domain),
      lastResult: st.lastResult || null, lastSuccessAt: st.lastSuccessAt || null, lastAttemptAt: st.lastAttemptAt || null, log: (st.log || []).slice(0, 10),
      me: snap?.me ? { name: snap.me.name, deptCode: snap.me.deptCode, area: snap.me.area } : null,
      counts: snap?.counts || null, todo: withAge(snap?.todo), apply: withAge(snap?.apply), docs: snap?.docs || {}, docLabels: model.DOC_LABELS,
      added: snap?.added || null, done: snap?.done || null,
    };
  }
  briefLines() { return model.briefLines(this.snapshot(), this.now().getTime()); }
  // 给助理问答用的纯文字：待办、申请、近期讲话各列几条，带链接。
  digestText({ max = 12 } = {}) {
    const s = this.status();
    if (!s.lastSuccessAt) return '还没有读到门户数据（功能刚开启，或公司网络暂时打不开门户）。';
    const at = new Date(s.lastSuccessAt), two = (n) => String(n).padStart(2, '0');
    const lines = [`门户数据读取于 ${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}。`, `待办 ${s.todo.length} 条：`];
    for (const x of s.todo.slice(0, max)) lines.push(`- [${x.app}] ${x.title.slice(0, 120)}（${x.time.slice(0, 10)}，已挂 ${x.ageDays ?? '?'} 天${x.from ? '，来自 ' + x.from : ''}）${x.url}`);
    lines.push(`我提的申请 ${s.apply.length} 条：`);
    for (const x of s.apply.slice(0, max)) lines.push(`- [${x.app}] ${x.title.slice(0, 120)}（${x.time.slice(0, 10)} 提交，${x.ageDays ?? '?'} 天${x.handler ? '，当前处理人 ' + x.handler : ''}）${x.url}`);
    const sp = (s.docs.policy || []).slice(0, 5);
    if (sp.length) { lines.push('近期公司讲话：'); for (const d of sp) lines.push(`- ${d.date.slice(0, 10)} ${d.title.slice(0, 80)} ${d.url}`); }
    return lines.join('\n');
  }
  changed() { try { this.deps.onChanged?.(); } catch { /* 界面没开 */ } }
}

module.exports = { CompanyW3, portalUrl, readyUrlOf, DAY_START_HOUR };
