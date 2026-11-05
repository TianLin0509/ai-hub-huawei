'use strict';
// CodeAgent 额度条（2026-10-16 用户：额度条可以补）。数据来自每轮回答结束时读到的 CodeAgent 屏幕 Stats 面板
// 「Credit 剩余 (百分比)」（core/codeagent-screen-stats.js parseCodeAgentCredit）——CodeAgent 没有查额度的命令。
// 每个账号（个人账号、号池里的号）各一行，显示最近一次读数和它是哪一档（今日忙时 / 月度）；读数过旧时标出来。
// 有 /model 菜单读数时（core/codeagent-usage-menu.js）一行显示三档（忙时 / 闲时 / 月度剩余），并提示「距离闲时 N 折还有…」（2026-10-29）。
// 样式沿用左下角「用量与系统状态」里各家额度的行（renderer/styles/sidebar-v2.css）。
const STORE_KEY = 'hub.codeagentQuota.v1';
const STALE_MS = 3 * 3600 * 1000;
const MAX_ROWS = 4;
// 菜单用量表只在 Hub 选模型或用户自己开菜单时才读得到，超过 6 小时标出「x 小时前」。
const USAGE_STALE_MS = 6 * 3600 * 1000;
const TOKEN_WARN_PERCENT = 50;
const TOKEN_DANGER_PERCENT = 80;

function tokenModelForAccount(key, session, defaults) {
  return require('../core/ai-kinds').isCodeAgentKind(session?.kind) && (session.codeagentPoolAccount || 'personal') === key
    ? session.currentModel?.id || defaults[key] || '' : defaults[key] || '';
}
function tokenUsage(entry, modelId) {
  const model = modelId ? require('../core/codeagent-usage-menu').modelUsage(entry, modelId)
    : entry?.models?.find(item => Number.isFinite(item.day?.pct));
  if (!Number.isFinite(model?.day?.pct)) return null;
  const pct = model.day.pct;
  const shortWarning = [['hour', '本小时'], ['min', '本分钟']]
    .map(([window, label]) => ({ window, label, pct: model[window]?.pct }))
    .filter(item => Number.isFinite(item.pct) && item.pct >= TOKEN_DANGER_PERCENT)
    .sort((a, b) => b.pct - a.pct)[0] || null;
  return { window: 'day', label: '今日', pct, name: modelId || model.name, shortWarning,
    periods: { day: pct, hour: model.hour?.pct, min: model.min?.pct },
    level: pct >= TOKEN_DANGER_PERCENT ? 'danger' : pct >= TOKEN_WARN_PERCENT ? 'warn' : '' };
}
const CREDIT_BUCKETS = [['今日忙时', 'busyDay', '忙时'], ['闲时', 'idleDay', '闲时'], ['月度', 'monthly', '月度']];

const levelFor = pct => pct < 10 ? 'danger' : pct < 20 ? 'warn' : '';
function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}
function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }); }
const round1 = n => Math.round(n * 10) / 10;
const shortDuration = min => {
  const m = Math.max(0, Math.round(min)), h = Math.floor(m / 60);
  return h ? `${h}时${m % 60 ? (m % 60) + '分' : ''}` : `${m}分`;
};

function createCodeAgentQuotaBar({ document, ipcRenderer, storage = null, now = () => Date.now(), escapeHtml = s => String(s), getActiveSession = () => null } = {}) {
  let readings = {};
  let usage = {}; // personal / 号池编号 → recordUsage 的快照（主进程 codeagent:usage 取回）
  let usagePanel = null;
  let allowed = true; // 有号池额度栏时为 false：底栏这一块由额度栏自己画（renderer/codeagent-quota-panel.js）
  let defaults = {};
  function openUsage(key, label) {
    usagePanel ||= require('./codeagent-usage-panel').createCodeAgentUsagePanel({ document, ipcRenderer, usageFor, now, escapeHtml });
    return usagePanel.open({ key, label, stats: readings[label] });
  }
  try { readings = JSON.parse(storage?.getItem(STORE_KEY) || '{}') || {}; } catch { readings = {}; }
  const el = () => document.getElementById('rail-codeagent-quota');
  function save() { try { storage?.setItem(STORE_KEY, JSON.stringify(readings)); } catch { /* 存不了只影响重启后的显示 */ } }
  // 「距离闲时 2 折还有 1小时56分钟」按读到之后过去的时间往下减；减到 0 就不再提示（闲时已开始，或数据太旧）。
  function idleHint(u) {
    const c = u && u.credit;
    if (c?.idleDiscountActive && c.idleDiscount) return { full: `闲时${c.idleDiscount}进行中`, short: `闲时${c.idleDiscount}进行中` };
    if (!c || !c.idleDiscountIn) return null;
    const { durationMinutes, formatMinutes } = require('../core/codeagent-usage-menu.js');
    const total = durationMinutes(c.idleDiscountIn);
    if (total == null) return null;
    const left = Number.isFinite(c.idleDiscountUntil) ? (c.idleDiscountUntil - now()) / 60000
      : total - (now() - (u.creditAt ?? u.at)) / 60000;
    if (!(left > 0)) return null;
    const discount = c.idleDiscount ? String(c.idleDiscount).replace(/折$/, ' 折') : '优惠';
    return { full: `距离闲时 ${discount}还有${formatMinutes(left)}`, short: `${c.idleDiscount || ''}还有${shortDuration(left)}` };
  }
  // 一行里的读数：菜单读到的三档 + Stats 面板的当前档（同一档以较新的为准）。
  function metricsFor(r, u) {
    const out = [];
    const fromStats = () => ({ bucket: r.bucket, short: r.bucket, pct: r.pct, detail: `${fmt(r.remaining)}${r.total ? ' / ' + fmt(r.total) : ''}`, stale: now() - r.at > STALE_MS, at: r.at });
    if (u && u.credit) {
      const creditAt = u.creditAt ?? u.at;
      const usageStale = now() - creditAt > USAGE_STALE_MS;
      for (const [bucket, field, short] of CREDIT_BUCKETS) {
        const f = u.credit[field];
        if (!f || !Number.isFinite(f.pct)) continue;
        if (r && r.bucket === bucket && r.at >= creditAt) out.push({ ...fromStats(), short });
        else out.push({ bucket, short, pct: round1(100 - f.pct), detail: `已用 ${f.used} / ${f.total}`, stale: usageStale, at: creditAt });
      }
      // 当前生效那一档放第一格（底栏摘要按第一格的读数挑最紧张的一家）
      const first = r ? out.findIndex(m => m.bucket === r.bucket) : -1;
      if (first > 0) out.unshift(out.splice(first, 1)[0]);
    }
    if (!out.length && r) out.push(fromStats());
    return out;
  }
  function render() {
    const host = el();
    if (!host || !allowed) return;
    // 按界面上的账号名对行：Stats 读数按账号名记，菜单快照里带同样的账号名（label）
    const byAccount = new Map();
    for (const r of Object.values(readings)) byAccount.set(r.account, { account: r.account, key: '', r, u: null });
    for (const [key, u] of Object.entries(usage)) {
      if (!u || !u.label || (!u.credit && !u.models?.length)) continue;
      const row = byAccount.get(u.label) || { account: u.label, r: null, u: null };
      row.u = u; row.key = key;
      byAccount.set(u.label, row);
    }
    const rows = [...byAccount.values()].map(row => ({ ...row, at: Math.max(row.r?.at || 0, row.u?.at || 0) }))
      .sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
    host.hidden = !allowed || rows.length === 0;
    // 保留额度行的面板入口；底栏只展示 Token，Credit 在完整面板内查看。
    const html = rows.length ? `<div class="sidebar-quota">${rows.map(({ account, key, r, u, at }) => {
      const metrics = metricsFor(r, u);
      const token = tokenUsage(u, tokenModelForAccount(key || 'personal', getActiveSession(), defaults));
      const tokenHtml = '<span class="ca-quota-token" data-level="' + (token?.level || '') + '">'
        + (token ? '<span class="ca-token-reading"><span>Token</span><span class="ca-token-model" title="' + escapeHtml(token.name) + '">' + escapeHtml(token.name) + '</span><span>' + token.label + ' ' + round1(token.pct) + '%</span>'
          + (token.shortWarning ? '<span class="ca-token-alert">⚠ ' + token.shortWarning.label + ' ' + round1(token.shortWarning.pct) + '%</span>' : '')
          + '</span><span class="ca-token-track"><i style="width:' + Math.max(0, Math.min(100, token.pct)) + '%"></i></span>' : 'Token 未读取') + '</span>';
      const stale = metrics.every(m => m.stale);
      const label = `${account} Token ${token ? `${token.name} ${token.label} ${round1(token.pct)}%` : '未读取'}`;
      const updated = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const periods = token ? ['今日', '本小时', '本分钟'].map((label, i) => {
        const value = token.periods[['day', 'hour', 'min'][i]];
        return label + ' ' + (Number.isFinite(value) ? round1(value) + '%' : '未读取');
      }).join(' · ') : '';
      const title = `${account} · 更新于 ${updated}\n${periods ? periods + '\n' : ''}点击查看详情`;
      return `<div class="sidebar-quota-provider ca-quota-account" data-provider="codeagent" data-usage-key="${escapeHtml(key)}" data-usage-label="${escapeHtml(account)}" role="button" tabindex="0" aria-haspopup="dialog" style="cursor:pointer" data-freshness="${stale ? 'stale' : 'fresh'}" aria-label="${escapeHtml(label || 'CodeAgent ' + account)}，查看模型用量" title="${escapeHtml(title)}">`
        + '<span class="sidebar-quota-icon ai-logo logo-codeagent" aria-hidden="true"></span>'
        + tokenHtml + '</div>';
    }).join('')}</div>` : '';
    if (host.innerHTML !== html) host.innerHTML = html;
    if (!host._usagePanelBound) {
      host._usagePanelBound = true;
      const activate = event => {
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        const row = event.target.closest('[data-usage-label]');
        if (!row || !host.contains(row)) return;
        event.preventDefault();
        void openUsage(row.dataset.usageKey, row.dataset.usageLabel);
      };
      host.addEventListener('click', activate);
      host.addEventListener('keydown', activate);
    }
  }
  // reading：parseCodeAgentCredit 的结果 + { account }（个人账号 / 号池账号的脱敏名）。
  function update(reading, { account = '个人账号' } = {}) {
    if (!reading || !Number.isFinite(reading.remaining) || !Number.isFinite(reading.pct)) return;
    readings[account] = { ...reading, account, at: now() };
    save(); render();
    try { document.dispatchEvent?.(new (document.defaultView?.CustomEvent || CustomEvent)('codeagent-quota', { detail: readings[account] })); } catch { /* 桌宠等订阅方可选 */ }
  }
  // accounts：core/codeagent-usage-menu.js readUsage 的结果（主进程 codeagent:usage 取回）。
  function setUsage(accounts, defaultModels = defaults) {
    defaults = defaultModels && typeof defaultModels === 'object' ? { ...defaultModels } : {};
    usage = accounts && typeof accounts === 'object' ? { ...accounts } : {};
    render();
    usagePanel?.update();
  }
  // 模型下拉用：这个号（personal / 号池编号）最近一次菜单快照，没有返回 null。
  function usageFor(key) { return (key && usage[key]) || null; }
  function setAllowed(next) { if (allowed !== !!next) { allowed = !!next; render(); } }
  return { update, render, setUsage, setAllowed, usageFor, openUsage, readings: () => ({ ...readings }) };
}

module.exports = { createCodeAgentQuotaBar, tokenModelForAccount, tokenUsage, TOKEN_WARN_PERCENT, TOKEN_DANGER_PERCENT };
