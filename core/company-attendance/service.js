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
const companyDomain = require('../company-domain');

const RETRY_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 45 * 1000;
const TICK_MS = 10 * 60 * 1000;
const LOG_KEEP = 30;
const CARD_API = /queryCardRecord/;
const HOLIDAY_API = /queryHolidayCalendarDetails/;
const DNS_FAIL = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/;
// 连接层失败（浏览器原始报错，如 ERR_CONNECTION_CLOSED (-100) loading '…'）：翻成人话并给下一步，原始代码留在括号里方便排查（11-21 深查 #11）。
const NET_FAIL = /\b(ERR_(?:CONNECTION_(?:CLOSED|REFUSED|RESET|TIMED_OUT|ABORTED|FAILED)|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SSL_PROTOCOL_ERROR|EMPTY_RESPONSE))\b/;
function netFailMessage(domain, error) {
  const code = (String(error || '').match(NET_FAIL) || [])[1];
  if (!code) return '';
  return `连不上考勤页 hr.${domain}（网络报错 ${code}）：多半是这台电脑现在没连公司内网（在外面先连 VPN 或回到公司网络），也可能是网络刚好抖了一下。连上内网后点「现在读取」重试；一直这样就点「一键反馈」。`;
}

function hostOf(u) { try { return u ? `（停在 ${new URL(u).host}）` : ''; } catch { return ''; } }

// 考勤页有两种（2026-11-17 同事反馈）：正式员工用 attendanceflow；OD 员工用 servicetimeflow，前一个页读不到他们的打卡。
// 默认先试正式员工页，没截到打卡数据（不是要登录）再试 OD 页；哪页读成功就记下，以后先用它。也可以在考勤设置里指定。
const PAGES = Object.freeze({
  attendance: { label: '正式员工考勤页', path: '/apps/attendanceflow/#/myAttendance' },
  servicetime: { label: 'OD 考勤页', path: '/apps/servicetimeflow/#/myServicetime' },
});
const PAGE_ORDER = Object.freeze(['attendance', 'servicetime']);
const normalizePage = (v) => (PAGES[v] ? v : 'auto');

function attendanceUrl(domain, env = process.env, page = 'attendance') {
  if (env.CLAUDE_HUB_ATTENDANCE_URL && env.CLAUDE_HUB_DATA_DIR) {
    // 测试替身：OD 页另给一个地址（CLAUDE_HUB_SERVICETIME_URL），没给就沿用同一个。
    return page === 'servicetime' && env.CLAUDE_HUB_SERVICETIME_URL ? env.CLAUDE_HUB_SERVICETIME_URL : env.CLAUDE_HUB_ATTENDANCE_URL;
  }
  const def = PAGES[page] || PAGES.attendance;
  return domain ? `https://hr.${domain}${def.path}` : '';
}

// 要试的页：用户指定了就只试那一页；自动时上次成功的页排第一，其余按默认顺序。
function pagesToTry(settings = {}) {
  if (PAGES[settings.page]) return [settings.page];
  const last = PAGES[settings.lastPage] ? [settings.lastPage] : [];
  return [...last, ...PAGE_ORDER.filter((p) => !last.includes(p))];
}

// OD 考勤页的接口名和字段名没在真机上核对过：不认接口名，在页面返回的 JSON 里找「一组带日期和打卡时刻的记录」。
// 2026-11-18 审查返工：只认明确表示「实际打卡」的字段（card/clock/punch/sign），startTime/endTime、onDuty/offDuty 这类
// 排班也会用的通用字段一律不认；排班、日历类接口整段跳过；认出不止一组且内容不一致时宁可报「读不到」，不写错考勤。
const DATE_KEYS = ['attendanceDate', 'clockInDate', 'workDate', 'cardDate', 'serviceDate', 'recordDate', 'punchDate', 'signDate', 'date', 'day'];
const FIRST_KEYS = ['earlyClockInTime', 'firstCardTime', 'firstClockTime', 'firstPunchTime', 'clockInTime', 'signInTime', 'firstSignTime', 'punchInTime', 'cardInTime'];
const LAST_KEYS = ['lateClockInTime', 'lastCardTime', 'lastClockTime', 'lastPunchTime', 'clockOutTime', 'signOutTime', 'lastSignTime', 'punchOutTime', 'cardOutTime'];
// 排班 / 日历 / 计划类：接口路径或外层字段名带这些词的，里面的时段不是打卡。
const SCHEDULE_WORD = /shift|schedul|calendar|roster|plan|duty|holiday|排班|班次|日历|计划/i;
const pickKey = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const clockOf = (v) => { const m = /(?:^|\D)(\d{1,2}):(\d{2})(?!\d)/.exec(String(v ?? '')); return m && Number(m[1]) < 24 ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
const dayOf = (v) => { const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(v ?? '')); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
function guessRecord(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const first = pickKey(o, FIRST_KEYS), last = pickKey(o, LAST_KEYS);
  const date = dayOf(pickKey(o, DATE_KEYS) || first || last);
  const a = clockOf(first), b = clockOf(last);
  if (!date || (!a && !b)) return null;
  return { attendanceDate: date, earlyClockInTime: a || b, lateClockInTime: b || a, earlyClockTag: o.earlyClockTag || '', lateClockTag: o.lateClockTag || '' };
}
function guessRecords(captured) {
  const found = [];
  const visit = (v, depth, key) => {
    if (depth > 5 || v == null || typeof v !== 'object') return;
    if (key && SCHEDULE_WORD.test(key)) return;
    if (Array.isArray(v)) {
      const recs = v.map(guessRecord).filter(Boolean);
      if (recs.length && recs.length * 2 >= v.length) found.push(recs);
      for (const x of v.slice(0, 50)) visit(x, depth + 1, '');
      return;
    }
    for (const [k, x] of Object.entries(v)) visit(x, depth + 1, k);
  };
  for (const r of captured || []) {
    let p = '';
    try { p = new URL(String(r.url)).pathname; } catch { p = String(r.url || ''); }
    if (SCHEDULE_WORD.test(p)) continue;
    visit(r.json, 0, '');
  }
  if (!found.length) return null;
  // 多组候选：同一份数据重复出现可以，内容互相矛盾就拿不准，按读不到处理。
  const sig = (recs) => JSON.stringify(recs.map((x) => [x.attendanceDate, x.earlyClockInTime, x.lateClockInTime]).sort());
  return found.every((x) => sig(x) === sig(found[0])) ? found[0] : null;
}
// 没认出数据时记下页面调过哪些接口（只留路径末两段，不带参数和内容），下次反馈里就能看到 OD 页实际用的接口名。
// 路径里可能夹着工号、姓名拼音、会话号、令牌，单看字符种类分不出来（纯字母的令牌也有），所以按路径结构处理：
// 1. 紧跟在 profile、session、user、token 这类「身份名词」后面的那一段是取值，一律换成 *；
// 2. 其余段只有能整段拆成常见接口用词（query、attendance、clock、record、list 等）才原样保留，拆不开的都换成 *。
const API_WORDS = new Set(('api apis rest service services servicetime time times flow flows attend attendance attendances companion document documents '
  + 'clock clockin clockout card cards punch record records list lists query get fetch load search find detail details info data page pages paging '
  + 'month monthly day daily week weekly date dates holiday holidays calendar calendars shift shifts schedule schedules work workday workdays '
  + 'user users profile profiles session sessions account accounts employee employees person staff member members auth login logout token tokens '
  + 'config configs setting settings menu menus home index common base public portal ess self current sign signin signout checkin checkout '
  + 'duty overtime leave leaves apply approval approve process task tasks todo message messages notice notices count summary stat stats statistics '
  + 'report reports export sync check status type types dict dictionary enum enums org orgs dept department unit lang resource resources permission '
  + 'permissions role roles batch history absence exception exceptions abnormal rule rules result results view views init item items location area '
  + 'zone timezone team group project version upload file image log logs event events health ping refresh mobile web app front gateway open inner '
  + 'internal external hr pc h5 by of for to in on all new my').split(' '));
const SHORT_OK = new Set(['hr', 'pc', 'h5', 'by', 'of', 'to', 'in', 'on', 'my']);
const ID_NOUNS = new Set('user users profile profiles session sessions employee employees emp person persons people staff member members account accounts token tokens uid id ids key keys ticket tickets sid auth'.split(' '));
const VERSION_SEG = /^v\d{1,2}$/i;
function splitsIntoWords(word) {
  // 小写串能否整段拆成 API_WORDS 里的词（动态规划），短词只认白名单里的几个，避免随便拼出人名或令牌。
  const ok = [true];
  for (let i = 1; i <= word.length; i++) {
    ok[i] = false;
    for (let j = Math.max(0, i - 16); j < i && !ok[i]; j++) {
      const w = word.slice(j, i);
      ok[i] = ok[j] && API_WORDS.has(w) && (w.length >= 3 || SHORT_OK.has(w));
    }
  }
  return ok[word.length];
}
function isStaticApiSegment(seg) {
  if (VERSION_SEG.test(seg)) return true;
  if (!/^[A-Za-z][A-Za-z_-]{0,39}$/.test(seg)) return false;
  // 驼峰和下划线、连字符都拆开逐个看：queryAttendList → query attend list。
  const parts = seg.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean);
  return parts.length > 0 && parts.every((x) => splitsIntoWords(x.toLowerCase()));
}
function maskPath(segments) {
  return segments.map((x, i) => {
    const prev = i > 0 ? segments[i - 1].toLowerCase() : '';
    return ID_NOUNS.has(prev) || !isStaticApiSegment(x) ? '*' : x;
  });
}
function apiPaths(captured) {
  const out = [];
  for (const r of captured || []) {
    try {
      const p = maskPath(new URL(r.url).pathname.split('/').filter(Boolean)).slice(-2).join('/');
      if (p && /[A-Za-z]/.test(p) && !out.includes(p)) out.push(p);
    } catch { /* 不是完整网址 */ }
  }
  return out.slice(0, 8);
}
// 写进错误、日志前：网址只留主机名（路径和参数里可能有身份信息），邮箱打码。
function scrubError(text) {
  return String(text || '')
    .replace(/\b(?:https?|wss?):\/\/([A-Za-z0-9.:-]+)[\x21-\x7e]*/gi, (_, host) => host)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
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
    const own = companyDomain.siteDomain(s.domain || '');
    const fromEmail = companyDomain.companyDomainOf((() => { try { return this.deps.accountEmail?.() || ''; } catch { return ''; } })());
    const known = own || fromEmail ? null : companyDomain.knownDomain(this.deps.dataDir);
    return { domain: own || fromEmail || known.domain, domainFrom: own ? 'settings' : fromEmail ? 'assistant-email' : known.from, autoDaily: s.autoDaily !== false, workTime: calc.normalizeWorkTime(s.workTime).workTime, flex: calc.normalizeFlex(s.flex).flex,
      page: normalizePage(s.page), lastPage: PAGES[s.lastPage] ? s.lastPage : '' };
  }
  // 设置里没有时自动找（内置默认、WeLink 账号），找到就记下，用户不用手填。
  async ensureDomain() {
    const cur = this.settings();
    if (cur.domain) return cur.domain;
    const r = await companyDomain.resolveDomain(this.deps.dataDir, { lookupEmail: this.deps.lookupEmail || null, gitEmail: this.deps.gitEmail || null });
    if (r.domain) this.changed();
    return r.domain;
  }
  setSettings(patch = {}) {
    const s = this.read('settings', {});
    // 填公司邮箱或域名都行。
    if (patch.domain !== undefined) s.domain = String(patch.domain).includes('@') ? domainFromEmail(patch.domain) : normalizeDomain(patch.domain);
    if (patch.autoDaily !== undefined) s.autoDaily = !!patch.autoDaily;
    if (patch.page !== undefined) s.page = normalizePage(patch.page);
    if (patch.workTime !== undefined) {
      if (patch.workTime === null) delete s.workTime;
      else {
        const n = calc.normalizeWorkTime(patch.workTime);
        if (!n.ok) throw new Error('核心工作时间不对：' + n.error);
        s.workTime = n.workTime;
      }
    }
    if (patch.flex !== undefined) {
      if (patch.flex === null) delete s.flex;
      else {
        const n = calc.normalizeFlex({ ...calc.normalizeFlex(s.flex).flex, ...patch.flex });
        if (!n.ok) throw new Error('弹性工作制设置不对：' + n.error);
        s.flex = n.flex;
      }
    }
    this.write('settings', s);
    this.changed();
    return this.settings();
  }

  start() {
    this.stop();
    void this.ensureDomain().catch(() => {});
    if (this.deps.noTimer) return;
    this.timers.push(setTimeout(() => { void this.tick().catch(() => {}); }, FIRST_DELAY_MS));
    this.timers.push(setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS));
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
  close() { this.stop(); }

  // 今天还没成功、距上次尝试超过 1 小时、不在 0–6 点：才去访问。
  // allowNight：用户此刻打开了考勤页，不受夜间限制；后台定时仍然避开 0–6 点。
  shouldRun({ allowNight = false } = {}) {
    const st = this.read('state', {});
    const now = this.now();
    if (!this.settings().autoDaily) return false;
    if (st.lastSuccessDay === this.todayKey()) return false;
    // 上次因为没找到域名失败、现在找到了：不用等 1 小时。
    // （旧版本的这类失败没有 needsDomain 标记，按报错文字认。）
    const domainFail = st.lastResult && !st.lastResult.ok && (st.lastResult.needsDomain || (!st.lastResult.dnsFail && /公司域名/.test(String(st.lastResult.error || ''))));
    if (domainFail && this.settings().domain) return allowNight || now.getHours() >= 6;
    if (!allowNight && now.getHours() < 6) return false;
    return !st.lastAttemptAt || now.getTime() - Date.parse(st.lastAttemptAt) >= RETRY_MS;
  }
  async tick() { if (this.shouldRun()) await this.sync({ reason: 'daily' }); this.redLine(); }

  // 加班红线提醒（2026-11-09，交给桌宠说）：按本月节奏会超 80 小时时，每天说两次——
  // 取到当天数据后说一次「今天约几点前走」，快到那个时刻（前 20 分钟内）再提醒一次。数据只用本机记录，不额外访问考勤系统。
  redLine() {
    const publish = this.deps.publish;
    if (typeof publish !== 'function') return null;
    try {
      const status = this.status();
      const holidays = {};
      for (const k of Object.keys(status.holidays || {})) holidays[k] = true;
      const r = status.rules || calc.rulesFromWorkTime({});
      const opts = { holidays, rules: calc.calcRules(r) };
      const today = status.today, days = calc.buildDays(status.records || [], opts);
      const m = calc.monthReport(days, today.slice(0, 7), today, opts);
      if (!(m.willExceed || m.over) || m.workdays < 2 || !calc.isWorkKind(calc.dayKind(today, opts))) return null;
      const st = this.read('state', {}), told = st.redLineTold || {};
      const projected = Math.round(m.projected / 60), leave = m.leaveBy != null && m.perDayAllowance >= 0 ? calc.fmtClock(m.leaveBy) : '';
      const base = { kind: 'attendance', notify: true, page: 'attendance', tone: 'bad', cta: '打开考勤' };
      let notice = null;
      const now = this.now(), minute = now.getHours() * 60 + now.getMinutes();
      if (told.day !== today) {
        notice = { ...base, id: 'attendance-redline:' + today, title: m.over ? '本月加班已过 80 小时红线' : `本月加班预计 ${projected} 小时，会超红线`,
          text: leave ? `想守住 80 小时：剩 ${m.leftWorkdays} 个工作日，今天约 ${leave} 前走。` : '本月净加班已超过红线，后面几天尽量早点走、周末别来。' };
        this.write('state', { ...st, redLineTold: { day: today, evening: false } });
      } else if (!told.evening && leave && m.leaveBy - minute <= 20 && m.leaveBy - minute >= 0) {
        notice = { ...base, id: 'attendance-leave:' + today, title: `该准备走了：约 ${leave} 前离开`, text: `按 80 小时红线算的今天离开时间；本月预计 ${projected} 小时。` };
        this.write('state', { ...st, redLineTold: { ...told, evening: true } });
      }
      if (notice) publish(notice);
      return notice;
    } catch { return null; }
  }

  async capture(url, page = 'attendance') {
    const tries = [];
    const od = page === 'servicetime';
    if (this.deps.browser) {
      // OD 页的接口名还不知道：收下页面全部 JSON 响应，再按内容认。
      const cap = await this.deps.browser.capture({ url, clickText: '打卡记录', clickUnless: CARD_API, api: od ? null : /attendanceCompanion|attendanceDocument/, maxMs: 30000, loginGraceMs: 25000 });
      const card = (cap.json || []).find((r) => CARD_API.test(String(r.url)) && (Array.isArray(r.json) || Array.isArray(r.json?.data)));
      const hol = (cap.json || []).find((r) => HOLIDAY_API.test(String(r.url)));
      const pick = (r) => (r ? (Array.isArray(r.json) ? r.json : r.json?.data) : null);
      if (card) return { ok: true, via: 'hub', records: pick(card), holidays: pick(hol) };
      const guessed = od && !cap.needsLogin ? guessRecords(cap.json) : null;
      if (guessed) return { ok: true, via: 'hub', records: guessed, holidays: pick(hol) };
      const seen = od && !cap.needsLogin ? apiPaths(cap.json) : [];
      tries.push({ via: 'hub', needsLogin: !!cap.needsLogin, error: cap.needsLogin ? `需要登录${hostOf(cap.finalUrl)}` : '没截到打卡记录' + (seen.length ? `（页面接口：${seen.join('、')}）` : '') });
    }
    // 无头 Edge 只认正式员工页的打卡接口；OD 页只用 Hub 窗口。
    if (this.deps.edgeCapture && !od) {
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
      const domain = await this.ensureDomain().catch(() => '');
      let entry;
      if (!attendanceUrl(domain)) entry = { at, reason, ok: false, needsDomain: true, error: '没能自动找到公司域名（助理设置、WeLink 账号里都没有公司邮箱）：在下面填一下你的公司邮箱就行' };
      else {
        // 依次试各考勤页，读到就停；要登录时不换页（各页是同一个登录）。
        let r, page;
        const fails = [];
        for (page of pagesToTry(this.settings())) {
          try { r = await this.capture(attendanceUrl(domain, process.env, page), page); } catch (e) { r = { ok: false, error: e.message }; }
          if (r.ok || r.needsLogin) break;
          fails.push(`${PAGES[page].label}：${r.error || '失败'}`);
        }
        if (!r.ok && !r.needsLogin && fails.length > 1) r = { ...r, error: fails.join('；'), triedPages: true };
        // 地址解析不到（ERR_NAME_NOT_RESOLVED）：换哪个考勤页都没用，说清两种可能，界面就地给改域名的输入框。
        if (!r.ok && !r.needsLogin && DNS_FAIL.test(String(r.error || ''))) {
          r = { ...r, dnsFail: true, triedPages: false, error: `打不开 hr.${domain}（这个地址解析不到）：多半是这台电脑现在没连公司内网（在外面先连 VPN 或回到公司网络），或者公司域名不对。连上内网后点「现在读取」；域名不对就在下面改成公司主域名再读。` };
        }
        else if (!r.ok && !r.needsLogin && NET_FAIL.test(String(r.error || ''))) {
          r = { ...r, netFail: true, triedPages: false, error: netFailMessage(domain, r.error) };
        }
        if (r.ok && Array.isArray(r.records)) {
          const merged = calc.mergeRecords(this.read('records', []), r.records, at);
          this.write('records', merged.list);
          const hol = holidaysFrom(r.holidays);
          if (Object.keys(hol).length) this.write('holidays', { ...this.read('holidays', {}), ...hol });
          entry = { at, reason, ok: true, via: r.via, page, got: r.records.length, added: merged.added, updated: merged.updated };
          const saved = this.read('settings', {});
          if (saved.lastPage !== page) this.write('settings', { ...saved, lastPage: page });
          st.lastSuccessAt = at;
          st.lastSuccessDay = this.todayKey();
        } else entry = { at, reason, ok: false, needsLogin: !!r.needsLogin, triedPages: !!r.triedPages, ...(r.dnsFail ? { dnsFail: true } : {}), ...(r.netFail ? { netFail: true } : {}), error: scrubError(r.error) || '失败' };
      }
      st.log = [entry, ...(st.log || [])].slice(0, LOG_KEEP);
      st.lastResult = entry;
      this.write('state', st);
      return entry;
    })().finally(() => { this.syncing = null; this.changed(); });
    return this.syncing;
  }

  async login() {
    const url = attendanceUrl(await this.ensureDomain().catch(() => ''), process.env, pagesToTry(this.settings())[0]);
    if (!url) return { ok: false, error: '没能自动找到公司域名：在考勤设置里填一下你的公司邮箱就行' };
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
      ok: true, today: this.todayKey(), syncing: !!this.syncing, settings, rules: calc.rulesFromWorkTime(settings.workTime, settings.flex),
      url: attendanceUrl(settings.domain, process.env, pagesToTry(settings)[0]), pages: Object.entries(PAGES).map(([id, p]) => ({ id, label: p.label })), records, holidays: this.read('holidays', {}),
      lastResult: st.lastResult || null, lastSuccessAt: st.lastSuccessAt || null, lastAttemptAt: st.lastAttemptAt || null,
      log: (st.log || []).slice(0, 10), staleDays, gapRisk: staleDays != null && staleDays >= 6,
      firstDate: records.length ? records[0].date : null,
    };
  }
  changed() { try { this.deps.onChanged?.(); } catch { /* 界面没开 */ } }
}

module.exports = { CompanyAttendance, attendanceUrl, holidaysFrom, guessRecords, pagesToTry, apiPaths, scrubError, netFailMessage };
