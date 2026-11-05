'use strict';

// 右侧账号看板（2026-10-28 方案 C；10-29 扩到 Codex、Gemini）：按 Claude → Codex → Gemini 分段，
// 2026-10-31 用户选定 A：每号一行，只留编号 + 5h 已用/重置 + 7d 待恢复/重置；全名与详情放悬停。
// 2026-11-01 用户改选「填充胶囊」C：每号两行。第一行 5h、7d 两个按剩余量填色的胶囊（数字为剩余 %）+ 活跃会话数；
// 第二行灰字：邮箱名、出口 IP、推测续费日。没有 5h 的号（Codex）一个 7d 胶囊占满两格。
// 可收起成编号细栏。看板显示时，底栏里这三家的逐号格子各收成一格「可用/总数」，点它开关看板。
// 数据只读 accountUsageController 的快照，不另取额度；IP 地点经 main 的缓存查询（每个 IP 查一次）。

const { remainingPercent, formatResetCountdown } = require('./sidebar-account-usage.js');

const accountRisk = require('./account-risk-state');
const riskKind = provider => (provider === 'antigravity' ? 'gemini' : provider);
const STORAGE_KEY = 'hubClaudeQuotaPanel';
const USABLE_MIN = 15;
const PROVIDERS = [
  { id: 'claude', name: 'Claude', logo: 'claude' },
  { id: 'codex', name: 'Codex', logo: 'codex' },
  { id: 'antigravity', name: 'Gemini', logo: 'gemini' },
];

function panelAvailability({ kindAllowed, featureEnabled }) {
  const providers = featureEnabled('quotaBar')
    ? PROVIDERS.filter(provider => kindAllowed(riskKind(provider.id))).map(provider => provider.id) : [];
  const codeagent = kindAllowed('codeagent');
  return { enabled: codeagent || providers.length > 0, codeagent, providers };
}

function level(pct) {
  if (pct === null || pct === undefined) return 'off';
  if (pct < USABLE_MIN) return 'bad';
  if (pct <= 40) return 'warn';
  return 'ok';
}

// 有效剩余：5h 与 7d 里更紧的那个；两个都没有数据时为 null。
function effective(row) {
  const values = [row.remain5h, row.remain7d].filter(v => v !== null);
  return values.length ? Math.min(...values) : null;
}

const resetAt = window => (window?.resetsAt ? new Date(window.resetsAt).getTime() : NaN);

// 各家窗口的取法与底栏一致：Codex 订阅常没有 5h；Gemini 读 gemini 模型组。
function windowsOf(provider, row, now) {
  if (provider === 'antigravity') {
    const g = (row.groups || []).find(x => x.id === 'gemini') || null;
    return { w5h: g?.usage5h || null, w7d: g?.usage7d || null };
  }
  let w5h = row.usage5h || null;
  // 5h 窗口不可能在 5 小时以后才重置；旧缓存把 Codex 周窗口误记成 5h 时丢掉。
  if (provider === 'codex' && w5h && resetAt(w5h) > now + 5.5 * 3600_000) w5h = null;
  return { w5h, w7d: row.usage7d || null };
}

function wholePercent(window) {
  const pct = remainingPercent(window);
  return pct === null ? null : Math.round(pct);
}

// Claude 只在 Hub 里用（2026-10-30 用户确认）：Hub 每 2 分钟给有在线会话的号读一次额度，
// 过了重置时间记录仍没更新，说明重置后没在 Hub 用过，这个窗口就是满的，按 100% 算，不再写「待刷新」。
// 刷新报错的号（有在线会话却没读到）拿不准，Codex、Gemini 可能在 Hub 外用，都照旧写「待刷新」。
function windowView(provider, window, now, failed) {
  const pct = wholePercent(window), at = resetAt(window);
  const assumed = provider === 'claude' && !failed && pct !== null && Number.isFinite(at) && at <= now;
  return { pct: assumed ? 100 : pct, at, assumed };
}

function viewRows(provider, snapshot, currentProfileId, now) {
  const rows = snapshot?.accounts?.[provider];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const { w5h, w7d } = windowsOf(provider, row, now);
    const v5 = windowView(provider, w5h, now, !!row.error), v7 = windowView(provider, w7d, now, !!row.error);
    const view = {
      provider, no: index + 1, profileId: row.profileId || '',
      label: row.profileLabel || row.profileId || ('账号' + (index + 1)),
      // 看板只显示整数（2026-10-29 用户：Gemini 返回的是带小数的用量，显示成 60.1668…%）。
      remain5h: v5.pct, remain7d: v7.pct, reset5h: v5.at, reset7d: v7.at, assumed5h: v5.assumed, assumed7d: v7.assumed,
      has5h: provider === 'claude' || !!w5h,
      egress: provider === 'claude' ? (row.egressIp || '') : '', apiKey: !!row.apiKey,
      error: row.error || '', inFlight: !!row.inFlight, selected: !!row.selected,
      email: row.email || '', plan: row.plan || '', billing: row.billing || '', subscribedAt: row.subscribedAt || 0,
      subscriptionUntil: row.subscriptionUntil || 0, subscriptionChecked: row.subscriptionChecked || 0,
    };
    view.eff = effective(view);
    view.current = currentProfileId ? view.profileId === currentProfileId : view.selected;
    if (view.eff !== null && view.eff < USABLE_MIN) {
      const by5h = view.remain5h !== null && (view.remain7d === null || view.remain5h <= view.remain7d);
      view.blockedBy = by5h ? '5h' : '7d';
      const at = by5h ? view.reset5h : view.reset7d;
      view.backIn = Number.isFinite(at) && at > now ? formatResetCountdown(at, now) : '';
    }
    return view;
  });
}

const mmdd = ms => { const d = new Date(ms); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const ymd = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const PLAN_NAMES = { claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise', plus: 'Plus', pro: 'Pro', team: 'Team', free: 'Free' };
const BILLING_NAMES = { apple_subscription: 'Apple 订阅', stripe_subscription: '网页订阅', google_play_subscription: 'Google Play 订阅' };

// 按月订阅的下一个续费日：从订阅起始日每月同一天往后推，取第一个晚于现在的（月底日按当月最后一天）。
function nextMonthlyRenewal(startMs, now) {
  const start = new Date(startMs);
  for (let i = 1; i < 600; i++) {
    const y = start.getFullYear(), m = start.getMonth() + i;
    const last = new Date(y, m + 1, 0).getDate();
    const at = new Date(y, m, Math.min(start.getDate(), last), start.getHours(), start.getMinutes()).getTime();
    if (at > now) return at;
  }
  return 0;
}

// 推荐号（2026-11-01 用户）：三条同时满足才推荐，满足的号里只圈出 7d 余量最多的那一个（绿框）。
//   ① 活跃会话 ≤ 1；② 5h 剩余 > 70%；③ 7d 剩余高于「按节奏该剩的量」；标了风控、读取失败、API Key 的号不参与。
// 节奏（2026-11-01 用户改）：一周用满 WEEKLY_PLAN（100%），每天约 14%；离重置还有 d 天时该剩 100 - 100/7×(7-d)。
//   例：还有 2 天重置 → 该剩约 29%。7d 满额（100%）直接算满足；最后 RESERVE_7D（10%）是预留，剩 ≤ 10% 不推荐、节奏点直接红。
// 节奏公式与启动中心的推荐排序共用一份（core/claude-launch-recommend.js），两处结果不会不一致。
const { WEEKLY_PLAN, RESERVE_7D, expected7d: paceFor } = require('../core/claude-launch-recommend');
function expected7d(row, now) {
  return paceFor({ resetsAt: Number.isFinite(row.reset7d) ? row.reset7d : 0 }, now);
}
// 7d 用量节奏三档（2026-11-01 用户选定「三档圆点」）：和推荐号同一条节奏线（每天约 14%）；剩 ≤ 10% 预留线直接红。
//   实际剩余比该剩的多 ≥ 5% → 绿（用得慢）；少 ≥ 5% → 红（用得快）；±5% 以内 → 黄（刚好），避免在线附近红绿来回跳。
const PACE_BAND = 5;
function paceOf(row, now) {
  if (row.apiKey || row.remain7d === null || row.remain7d === undefined) return null;
  const expected = Math.round(expected7d(row, now)), margin = row.remain7d - expected;
  const level = row.remain7d <= RESERVE_7D ? 'fast' : row.remain7d >= 100 || margin >= PACE_BAND ? 'good' : margin <= -PACE_BAND ? 'fast' : 'even';
  return { expected, margin, level };
}
const PACE_WORDS = { good: '用得慢，余量足', even: '和节奏差不多', fast: '用得快，余量偏少', reserve: '只剩预留的 10%' };

function recommendClaude(rows, now) {
  let best = null;
  for (const r of rows) {
    r.recommended = false;
    if (r.apiKey || r.error || r.risky || r.remain5h === null || r.remain7d === null || !Number.isFinite(r.sessions)) continue;
    r.expected7d = Math.round(expected7d(r, now));
    const ok = r.sessions <= 1 && r.remain5h > 70 && r.remain7d > RESERVE_7D && (r.remain7d > r.expected7d || r.remain7d >= 100);
    if (!ok) continue;
    const margin = r.remain7d - r.expected7d;
    if (!best || margin > best.margin || (margin === best.margin && r.remain5h > best.row.remain5h)) best = { row: r, margin };
  }
  if (best) best.row.recommended = true;
  return best ? best.row : null;
}

// 第二行的推测续费日：Claude 从订阅起始日按月推；Codex 已付到期日还没过就用它，过了就从它按月往后推。
function renewalAt(row, now) {
  if (row.provider === 'claude') return row.subscribedAt ? nextMonthlyRenewal(row.subscribedAt, now) : 0;
  if (row.provider === 'codex' && row.subscriptionUntil) return row.subscriptionUntil > now ? row.subscriptionUntil : nextMonthlyRenewal(row.subscriptionUntil, now);
  return 0;
}

// 悬停里的套餐行。Claude 本地只记起始日，续费日按月推算；Codex 凭证里有已付到期日，但只在凭证刷新时更新。
function subscriptionText(row, now) {
  const plan = PLAN_NAMES[row.plan] || row.plan;
  if (row.provider === 'claude') {
    if (!plan && !row.subscribedAt) return '';
    const billing = BILLING_NAMES[row.billing] || '';
    const parts = ['套餐：' + (plan || '未知') + (billing ? '（' + billing + '）' : '')];
    if (row.subscribedAt) {
      const next = nextMonthlyRenewal(row.subscribedAt, now);
      parts.push('订阅始于 ' + ymd(row.subscribedAt) + (next ? '，按月推算下次续费约 ' + ymd(next) : ''));
    }
    return parts.join(' · ');
  }
  if (row.provider === 'codex') {
    if (!plan && !row.subscriptionUntil) return '';
    let text = '套餐：' + (plan || '未知');
    if (row.subscriptionUntil) {
      text += ' · 已付至 ' + ymd(row.subscriptionUntil) + (row.subscriptionChecked ? '（' + ymd(row.subscriptionChecked) + ' 核对）' : '');
      if (row.subscriptionUntil <= now) text += '，之后登录凭证没再核对，可能已自动续费';
    }
    return text;
  }
  return '';
}

function locationText(loc) {
  if (!loc) return '';
  return [loc.countryZh, loc.cityZh].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' ');
}

// 2026-11-01 用户：Claude 号显示活跃会话数 = 用这个号、没休眠的 Claude 会话（含群聊成员）。
// 和进度视图、会议室一样直接读 renderer 的全局会话表；读不到时返回 null，不显示。
function activeClaudeSessions(provider, profileId) {
  if (provider !== 'claude' || typeof sessions === 'undefined' || !sessions || typeof sessions.values !== 'function') return null;
  let n = 0;
  for (const s of sessions.values()) {
    if (String(s?.kind || '').replace(/-resume$/, '') !== 'claude' || s.status === 'dormant') continue;
    if ((s.claudeProfile || 'default') === profileId) n++;
  }
  return n;
}

function createAccountQuotaPanel({
  document, root, footerRoot = null, getSnapshot, getCurrentProfileId = () => '', refresh = async () => {},
  lookupLocations = async () => ({}), getActiveSessionCount = activeClaudeSessions, escapeHtml, storage = null, nowFn = Date.now, setIntervalFn = setInterval, setTimeoutFn = setTimeout,
  providers = PROVIDERS.map(provider => provider.id),
}) {
  if (!document || !root) throw new Error('account quota panel needs document and root');
  const esc = typeof escapeHtml === 'function' ? escapeHtml : s => String(s);
  const enabledProviders = PROVIDERS.filter(provider => providers.includes(provider.id));
  // 2026-10-29 用户：账号不排序，固定按编号 1、2、3… 正序。
  let state = { collapsed: false };
  try { state = { ...state, ...JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') }; } catch {}
  const save = () => { try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} };
  let lastHtml = '';
  const summaries = {};
  const lastSummary = {};
  const locations = {};
  const asked = new Set();

  function askLocations(ips) {
    const missing = [...new Set(ips)].filter(ip => ip && !asked.has(ip));
    if (!missing.length) return;
    missing.forEach(ip => asked.add(ip));
    Promise.resolve(lookupLocations(missing)).then(found => {
      let changed = false;
      for (const [ip, loc] of Object.entries(found || {})) if (loc) { locations[ip] = loc; changed = true; }
      if (changed) render();
    }).catch(() => {}).finally(() => {
      // 查不到的 IP（网络暂时不通）10 分钟后允许再问一次，不必等重启。
      const retry = missing.filter(ip => !locations[ip]);
      if (retry.length) { const t = setTimeoutFn(() => retry.forEach(ip => asked.delete(ip)), 10 * 60_000); t?.unref?.(); }
    });
  }

  function tooltip(row, now) {
    const p = PROVIDERS.find(x => x.id === row.provider);
    const lines = [p.name + ' ' + row.no + ' · ' + row.label + (row.current ? '（当前）' : '')];
    if (row.recommended) lines.push('★ 推荐使用：会话 ' + row.sessions + ' 个 · 5h 剩 ' + row.remain5h + '% · 7d 剩 ' + row.remain7d
      + '%，按每周用满、每天约 ' + Math.round(WEEKLY_PLAN / 7) + '% 的节奏此时该剩 ' + row.expected7d + '%，余量 ' + (row.remain7d - row.expected7d >= 0 ? '+' : '') + (row.remain7d - row.expected7d) + '%');
    if (row.email) lines.push('邮箱：' + row.email);
    const sub = subscriptionText(row, now);
    if (sub) lines.push(sub);
    if (row.renewAt) lines.push('推测续费：' + mmdd(row.renewAt) + (row.renewAt - now <= 3 * 86400_000 ? '（3 天内）' : ''));
    if (row.provider === 'claude') lines.push('出口：' + (row.egress ? row.egress + (locationText(locations[row.egress]) ? ' · ' + locationText(locations[row.egress]) : '') : '未知'));
    if (row.provider === 'claude' && Number.isFinite(row.sessions)) lines.push('活跃会话：' + row.sessions + ' 个');
    if (row.apiKey) lines.push('API Key 登录，没有订阅额度');
    const win = (name, pct, at, assumed) => name + (name === '5h' ? ' 已用 ' : ' 待恢复 ')
      + (pct === null ? '未知' : (100 - pct) + '%') + ' · 剩余 ' + (pct === null ? '未知' : pct + '%')
      + (assumed ? '（已过重置时间，重置后没在 Hub 用过，按满额算）'
        : Number.isFinite(at) ? (at > now ? ' · ' + formatResetCountdown(at, now) + ' 后重置' : ' · 待刷新') : '');
    if (row.has5h) lines.push(win('5h', row.remain5h, row.reset5h, row.assumed5h));
    lines.push(win('7d', row.remain7d, row.reset7d, row.assumed7d));
    const pace = paceOf(row, now);
    if (pace) lines.push('7d 节奏：每天约 ' + Math.round(WEEKLY_PLAN / 7) + '%，此时该剩 ' + pace.expected + '%，实际剩 ' + row.remain7d + '%，'
      + (pace.margin >= 0 ? '余量 +' + pace.margin : '超前 ' + (-pace.margin)) + '% → '
      + PACE_WORDS[row.remain7d <= RESERVE_7D ? 'reserve' : pace.level]);
    if (row.blockedBy) lines.push('现在被 ' + row.blockedBy + ' 卡住' + (row.backIn ? '，' + row.backIn + ' 后回血' : ''));
    if (row.error) lines.push('刷新失败：' + row.error);
    lines.push(row.inFlight ? '刷新中…' : '点击刷新这个账号的额度');
    return lines.join('\n');
  }

  // 2026-11-01 用户定稿「细线表」：不用色块底、不给每行套卡片。每格 = 剩余 %（半粗）+ 倒计时（浅灰）
  //   + 数字下面一根 2px 细线表示剩余量；只有接近耗尽（< 15%）的数字和细线变红。邮箱、IP、续费都进悬停。
  function cell(row, name, pct, at, now, wide = false) {
    const assumed = name === '5h' ? row.assumed5h : row.assumed7d;
    const wait = pct === null ? '' : pct >= 100 || assumed ? '已满' : !Number.isFinite(at) ? '' : at <= now ? '待刷新' : formatResetCountdown(at, now);
    const low = pct !== null && pct < USABLE_MIN;
    return `<span class="cq-cell${wide ? ' cq-wide' : ''}${low ? ' is-low' : ''}" data-cq-window="${name}"><b class="cq-value">${pct === null ? '—' : pct + '%'}</b>`
      + `<span class="cq-reset">${wait}</span><span class="cq-meter"><i style="width:${pct === null ? 0 : Math.max(pct, 2)}%"></i></span></span>`;
  }

  function card(r, now) {
    const empty = r.remain5h === null && r.remain7d === null;
    const quota = r.apiKey ? '<span class="cq-cell cq-wide cq-nodata">API Key 登录</span>'
      : empty ? `<span class="cq-cell cq-wide cq-nodata">${r.error ? '刷新失败，点击重试' : '暂无数据，点击刷新'}</span>`
        : r.has5h ? cell(r, '5h', r.remain5h, r.reset5h, now) + cell(r, '7d', r.remain7d, r.reset7d, now)
          : cell(r, '7d', r.remain7d, r.reset7d, now, true);
    const sessions = r.provider === 'claude' && Number.isFinite(r.sessions)
      ? `<span class="cq-sessions${r.sessions ? '' : ' is-zero'}" aria-hidden="true">${r.sessions}</span>` : r.provider === 'claude' ? '<span></span>' : '';
    const pace = paceOf(r, now);
    const paceDot = pace ? `<span class="cq-pace is-${pace.level}" aria-hidden="true"></span>` : '<span></span>';
    const risk = accountRisk.describe(riskKind(r.provider), r.profileId);
    const detail = esc((risk ? '⚠ ' + risk + '\n' : '') + tooltip(r, now));
    return `<button type="button" class="cq-card${risk ? ' has-account-risk' : ''}${r.provider === 'claude' ? '' : ' no-sessions'}${r.current ? ' is-current' : ''}${r.recommended ? ' is-recommended' : ''}${r.inFlight ? ' is-loading' : ''}${r.error ? ' is-error' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${detail}" aria-label="${detail}"${r.inFlight ? ' aria-busy="true"' : ''}>`
      + `<span class="cq-no">${r.no}${r.error ? '<span class="cq-error-mark" aria-hidden="true">!</span>' : ''}</span>${paceDot}${quota}${sessions}</button>`;
  }

  const usableOf = rows => rows.filter(r => r.eff !== null && r.eff >= USABLE_MIN).length;

  function html(groups, now) {
    if (state.collapsed) {
      return `<div class="cq-rail"><button type="button" class="cq-expand" data-cq-action="expand" title="展开账号看板" aria-label="展开账号看板">«</button>`
        + groups.map(g => `<div class="cq-rail-group"><span class="ai-logo logo-${g.logo} cq-logo" title="${g.name} ${usableOf(g.rows)}/${g.rows.length} 可用" aria-hidden="true"></span>`
          + g.rows.map(r => `<button type="button" class="cq-rail-item cq-${level(r.apiKey ? null : r.eff)}${r.current ? ' is-current' : ''}${r.recommended ? ' is-recommended' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${esc(tooltip(r, now))}">${r.no}</button>`).join('')
          + '</div>').join('') + '</div>';
    }
    return `<header class="cq-head"><strong>账号额度</strong>`
      + `<button type="button" class="cq-collapse" data-cq-action="collapse" title="收起成细栏" aria-label="收起账号看板">»</button></header>`
      + '<div class="cq-list">' + groups.map(g => `<section class="cq-group" data-cq-group="${g.id}">`
        + `<h3 title="${g.name} ${g.rows.length} 个账号，${usableOf(g.rows)} 个可用 · 数字为剩余额度，时间为距重置的倒计时"><span class="cq-provider">${g.name}</span><span class="cq-count"><b>${usableOf(g.rows)}</b> / ${g.rows.length} 可用</span></h3>`
        + `<div class="cq-columns${g.id === 'claude' ? '' : ' no-sessions'}"><span></span><span></span>${g.rows.some(r => r.has5h) ? '<span>5h 剩余</span><span>7d 剩余</span>' : '<span class="cq-wide">7d 剩余</span>'}${g.id === 'claude' ? '<span>会话</span>' : ''}</div>`
        + '<div class="cq-rows">' + g.rows.map(r => card(r, now)).join('') + '</div></section>').join('') + '</div>';
  }

  function ensureSummary(provider) {
    if (summaries[provider] || !footerRoot) return summaries[provider] || null;
    const quota = footerRoot.querySelector('.sidebar-quota');
    if (!quota) return null;
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'sidebar-quota-provider cq-footer-summary';
    s.dataset.provider = provider + '-summary';
    s.style.order = String(-3 + PROVIDERS.findIndex(p => p.id === provider));
    s.addEventListener('click', () => { state.collapsed = !state.collapsed; save(); render(); });
    quota.prepend(s);
    summaries[provider] = s;
    return s;
  }

  function render() {
    const now = nowFn();
    let snapshot = null;
    try { snapshot = getSnapshot(); } catch {}
    const groups = enabledProviders.map(p => {
      let rows = [];
      try { rows = viewRows(p.id, snapshot, getCurrentProfileId(p.id), now); } catch {}
      for (const r of rows) {
        r.renewAt = renewalAt(r, now);
        if (p.id === 'claude') { try { r.sessions = getActiveSessionCount(p.id, r.profileId); } catch { r.sessions = null; } }
      }
      if (p.id === 'claude') {
        // 标了风控的号不推荐（2026-11-01：避免绿框落在「⚠ 风控」的号上）。
        for (const r of rows) { try { r.risky = !!accountRisk.active(riskKind(p.id), r.profileId); } catch { r.risky = false; } }
        recommendClaude(rows, now);
      }
      return { ...p, rows };
    }).filter(g => g.rows.length);
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    const on = total >= 2;
    root.hidden = !on;
    root.classList.toggle('is-collapsed', !!state.collapsed);
    if (footerRoot) {
      footerRoot.dataset.accountPanel = on ? 'on' : 'off';
      // 只收看板里有的那几家；单号的 AI 在看板里也有卡片，底栏同样只留汇总。
      footerRoot.dataset.panelProviders = on ? groups.map(g => g.id).join(' ') : '';
    }
    for (const p of enabledProviders) {
      const s = ensureSummary(p.id);
      if (!s) continue;
      const g = groups.find(x => x.id === p.id);
      s.hidden = !on || !g;
      if (!g) continue;
      const usable = usableOf(g.rows);
      const text = `<span class="sidebar-quota-icon ai-logo logo-${p.logo}" aria-hidden="true"></span><span class="sidebar-quota-name">${p.name}</span><span class="cq-summary-text"><b>${usable}</b>/${g.rows.length}</span>`;
      if (text !== lastSummary[p.id]) { s.innerHTML = text; lastSummary[p.id] = text; }
      s.title = `${p.name} ${g.rows.length} 个账号，${usable} 个可用 · 点击${state.collapsed ? '展开' : '收起'}右侧账号看板`;
      s.setAttribute('aria-label', s.title);
    }
    if (!on) return;
    askLocations(groups.flatMap(g => g.rows.map(r => r.egress)));
    const next = html(groups, now);
    if (next !== lastHtml) { root.innerHTML = next; lastHtml = next; }
  }

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-cq-action]');
    if (action) { state.collapsed = action.dataset.cqAction === 'collapse'; save(); render(); return; }
    const card = event.target.closest('[data-cq-profile]');
    if (card) Promise.resolve(refresh(card.dataset.cqProvider || 'claude', card.dataset.cqProfile)).catch(() => {}).finally(render);
  });
  // 倒计时按分钟走；没有新数据时 html 不变，不重建 DOM。
  setIntervalFn(render, 60000);
  accountRisk.subscribe(render);
  return { render, getState: () => ({ ...state }) };
}

module.exports = { createAccountQuotaPanel, panelAvailability, viewRows, effective, locationText, nextMonthlyRenewal, renewalAt, recommendClaude, expected7d, paceOf, subscriptionText, PROVIDERS };
