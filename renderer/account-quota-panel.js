'use strict';

// 右侧账号看板（2026-10-28 方案 C；10-29 扩到 Codex、Gemini）：按 Claude → Codex → Gemini 分段，
// 每个号一张紧凑卡片：状态色编号 + 名字（Claude 另写出口 IP 与地点）+ 5h/7d 余量与倒计时；被卡住的窗口标红写「回血」。
// 可收起成编号细栏。看板显示时，底栏里这三家的逐号格子各收成一格「可用/总数」，点它开关看板。
// 数据只读 accountUsageController 的快照，不另取额度；IP 地点经 main 的缓存查询（每个 IP 查一次）。

const { remainingPercent, formatResetCountdown } = require('./sidebar-account-usage.js');

const STORAGE_KEY = 'hubClaudeQuotaPanel';
const USABLE_MIN = 15;
const PROVIDERS = [
  { id: 'claude', name: 'Claude', logo: 'claude' },
  { id: 'codex', name: 'Codex', logo: 'codex' },
  { id: 'antigravity', name: 'Gemini', logo: 'gemini' },
];

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

function createAccountQuotaPanel({
  document, root, footerRoot = null, getSnapshot, getCurrentProfileId = () => '', refresh = async () => {},
  lookupLocations = async () => ({}), escapeHtml, storage = null, nowFn = Date.now, setIntervalFn = setInterval, setTimeoutFn = setTimeout,
}) {
  if (!document || !root) throw new Error('account quota panel needs document and root');
  const esc = typeof escapeHtml === 'function' ? escapeHtml : s => String(s);
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
    if (row.email) lines.push('邮箱：' + row.email);
    const sub = subscriptionText(row, now);
    if (sub) lines.push(sub);
    if (row.provider === 'claude') lines.push('出口：' + (row.egress ? row.egress + (locationText(locations[row.egress]) ? ' · ' + locationText(locations[row.egress]) : '') : '未知'));
    const win = (name, pct, at, assumed) => name + ' 剩余 ' + (pct === null ? '未知' : pct + '%')
      + (assumed ? '（已过重置时间，重置后没在 Hub 用过，按满额算）'
        : Number.isFinite(at) ? (at > now ? ' · ' + formatResetCountdown(at, now) + ' 后重置' : ' · 待刷新') : '');
    if (row.has5h) lines.push(win('5h', row.remain5h, row.reset5h, row.assumed5h));
    lines.push(win('7d', row.remain7d, row.reset7d, row.assumed7d));
    if (row.blockedBy) lines.push('现在被 ' + row.blockedBy + ' 卡住' + (row.backIn ? '，' + row.backIn + ' 后回血' : ''));
    if (row.error) lines.push('刷新失败：' + row.error);
    lines.push(row.inFlight ? '刷新中…' : '点击刷新这个账号的额度');
    return lines.join('\n');
  }

  function bar(row, name, pct, at, now) {
    const blocked = row.blockedBy === name;
    const assumed = name === '5h' ? row.assumed5h : row.assumed7d;
    const reset = !Number.isFinite(at) ? '' : assumed ? '已重置' : at <= now ? '待刷新' : formatResetCountdown(at, now) + (blocked ? ' 回血' : '');
    return `<div class="cq-bar cq-${level(pct)}"><span class="cq-win">${name}</span><i><u style="width:${pct ?? 0}%"></u></i>`
      + `<b>${pct === null ? '—' : pct + '%'}</b><span class="cq-reset${blocked ? ' is-back' : ''}">${reset}</span></div>`;
  }

  function card(r, now) {
    let meta = '';
    if (r.provider === 'claude' && r.egress) {
      const loc = locationText(locations[r.egress]);
      meta = `<span class="cq-ip">${esc(r.egress)}</span>${loc ? `<span class="cq-loc">${esc(loc)}</span>` : ''}`;
    }
    const empty = r.remain5h === null && r.remain7d === null;
    const body = r.apiKey ? '<div class="cq-nodata">API Key 登录，没有订阅额度</div>'
      : empty ? `<div class="cq-nodata">${r.error ? '刷新失败，点击重试' : '暂无额度数据，点击刷新'}</div>`
        : (r.has5h ? bar(r, '5h', r.remain5h, r.reset5h, now) : '') + bar(r, '7d', r.remain7d, r.reset7d, now);
    return `<button type="button" class="cq-card${r.current ? ' is-current' : ''}${r.inFlight ? ' is-loading' : ''}${r.error ? ' is-error' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${esc(tooltip(r, now))}">`
      + `<span class="cq-no cq-${level(r.apiKey ? null : r.eff)}">${r.no}</span>`
      + `<span class="cq-main"><span class="cq-title"><span class="cq-name">${esc(r.label)}</span>${r.current ? '<span class="cq-cur">当前</span>' : ''}${meta}</span>${body}</span></button>`;
  }

  const usableOf = rows => rows.filter(r => r.eff !== null && r.eff >= USABLE_MIN).length;

  function html(groups, now) {
    if (state.collapsed) {
      return `<div class="cq-rail"><button type="button" class="cq-expand" data-cq-action="expand" title="展开账号看板" aria-label="展开账号看板">«</button>`
        + groups.map(g => `<div class="cq-rail-group"><span class="ai-logo logo-${g.logo} cq-logo" title="${g.name} ${usableOf(g.rows)}/${g.rows.length} 可用" aria-hidden="true"></span>`
          + g.rows.map(r => `<button type="button" class="cq-rail-item cq-${level(r.apiKey ? null : r.eff)}${r.current ? ' is-current' : ''}" data-cq-provider="${r.provider}" data-cq-profile="${esc(r.profileId)}" title="${esc(tooltip(r, now))}">${r.no}</button>`).join('')
          + '</div>').join('') + '</div>';
    }
    return `<header class="cq-head"><strong>账号额度</strong>`
      + `<button type="button" class="cq-collapse" data-cq-action="collapse" title="收起成细栏" aria-label="收起账号看板">»</button></header>`
      + '<div class="cq-list">' + groups.map(g => `<section class="cq-group" data-cq-group="${g.id}"><h3><span class="ai-logo logo-${g.logo} cq-logo" aria-hidden="true"></span>${g.name}<span class="cq-count"><b>${usableOf(g.rows)}</b>/${g.rows.length} 可用</span></h3>`
        + g.rows.map(r => card(r, now)).join('') + '</section>').join('') + '</div>';
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
    const groups = PROVIDERS.map(p => {
      let rows = [];
      try { rows = viewRows(p.id, snapshot, getCurrentProfileId(p.id), now); } catch {}
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
    for (const p of PROVIDERS) {
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
  return { render, getState: () => ({ ...state }) };
}

module.exports = { createAccountQuotaPanel, viewRows, effective, locationText, nextMonthlyRenewal, subscriptionText, PROVIDERS };
