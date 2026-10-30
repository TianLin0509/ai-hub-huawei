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

function createCodeAgentQuotaBar({ document, storage = null, now = () => Date.now(), escapeHtml = s => String(s) } = {}) {
  let readings = {};
  let usage = {}; // personal / 号池编号 → recordUsage 的快照（主进程 codeagent:usage 取回）
  try { readings = JSON.parse(storage?.getItem(STORE_KEY) || '{}') || {}; } catch { readings = {}; }
  const el = () => document.getElementById('rail-codeagent-quota');
  function save() { try { storage?.setItem(STORE_KEY, JSON.stringify(readings)); } catch { /* 存不了只影响重启后的显示 */ } }
  // 「距离闲时 2 折还有 1小时56分钟」按读到之后过去的时间往下减；减到 0 就不再提示（闲时已开始，或数据太旧）。
  function idleHint(u) {
    const c = u && u.credit;
    if (!c || !c.idleDiscountIn) return null;
    const { durationMinutes, formatMinutes } = require('../core/codeagent-usage-menu.js');
    const total = durationMinutes(c.idleDiscountIn);
    if (total == null) return null;
    const left = total - (now() - u.at) / 60000;
    if (!(left > 0)) return null;
    const discount = c.idleDiscount ? String(c.idleDiscount).replace(/折$/, ' 折') : '优惠';
    return { full: `距离闲时 ${discount}还有${formatMinutes(left)}`, short: `${c.idleDiscount || ''}还有${shortDuration(left)}` };
  }
  // 一行里的读数：菜单读到的三档 + Stats 面板的当前档（同一档以较新的为准）。
  function metricsFor(r, u) {
    const out = [];
    const fromStats = () => ({ bucket: r.bucket, short: r.bucket, pct: r.pct, detail: `${fmt(r.remaining)}${r.total ? ' / ' + fmt(r.total) : ''}`, stale: now() - r.at > STALE_MS, at: r.at });
    if (u && u.credit) {
      const usageStale = now() - u.at > USAGE_STALE_MS;
      for (const [bucket, field, short] of CREDIT_BUCKETS) {
        const f = u.credit[field];
        if (!f || !Number.isFinite(f.pct)) continue;
        if (r && r.bucket === bucket && r.at >= u.at) out.push({ ...fromStats(), short });
        else out.push({ bucket, short, pct: round1(100 - f.pct), detail: `已用 ${f.used} / ${f.total}`, stale: usageStale, at: u.at });
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
    if (!host) return;
    // 按界面上的账号名对行：Stats 读数按账号名记，菜单快照里带同样的账号名（label）
    const byAccount = new Map();
    for (const r of Object.values(readings)) byAccount.set(r.account, { account: r.account, r, u: null });
    for (const u of Object.values(usage)) {
      if (!u || !u.label || !u.credit) continue;
      const row = byAccount.get(u.label) || { account: u.label, r: null, u: null };
      row.u = u;
      byAccount.set(u.label, row);
    }
    const rows = [...byAccount.values()].map(row => ({ ...row, at: Math.max(row.r?.at || 0, row.u?.at || 0) }))
      .sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
    host.hidden = rows.length === 0;
    // 结构与「余量」各家的行一致（底栏的紧凑/摘要排版、「⋯」全部状态弹窗都按这套类名读）：
    // 读数格只放百分比，底栏摘要按它挑「最紧张」的一家；剩余点数和总额放在悬停说明里。
    host.innerHTML = rows.length ? `<div class="sidebar-quota">${rows.map(({ account, r, u }) => {
      const metrics = metricsFor(r, u);
      const hint = idleHint(u);
      const stale = metrics.every(m => m.stale);
      const name = rows.length > 1 ? `CA ${account}` : 'CodeAgent';
      const label = metrics.map((m, i) => `${i ? '' : `CodeAgent ${account} `}${m.bucket}剩余 ${m.pct}%（${m.detail}）`).join(' · ')
        + (hint ? ` · ${hint.full}` : '');
      const sources = [r ? `Stats 面板 · ${ago(now() - r.at)}` : '', u && u.credit ? `/model 菜单 · ${ago(now() - u.at)}` : ''].filter(Boolean);
      const title = `${label}\n读自 CodeAgent 界面 ${sources.join('；')}`;
      return `<div class="sidebar-quota-provider" data-provider="codeagent" data-freshness="${stale ? 'stale' : 'fresh'}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}">`
        + '<span class="sidebar-quota-icon ai-logo logo-codeagent" aria-hidden="true"></span>'
        + `<span class="sidebar-quota-name">${escapeHtml(name)}</span>`
        + `<span class="sidebar-quota-metrics">${metrics.map(m => {
          const period = (metrics.length > 1 ? m.short : m.bucket)
            + (m.bucket === '闲时' && hint ? ` · ${hint.short}` : '')
            + (m.stale ? ' · ' + ago(now() - m.at) : '');
          return `<span class="sidebar-quota-metric" data-level="${levelFor(m.pct)}" data-window="${escapeHtml(m.bucket)}">`
            + `<span class="sidebar-quota-reading"><b class="sidebar-quota-value">${m.pct}%</b>`
            + `<span class="sidebar-quota-period">${escapeHtml(period)}</span></span>`
            + `<span class="sidebar-quota-track" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, m.pct))}%"></i></span></span>`;
        }).join('')}</span></div>`;
    }).join('')}</div>` : '';
  }
  // reading：parseCodeAgentCredit 的结果 + { account }（个人账号 / 号池账号的脱敏名）。
  function update(reading, { account = '个人账号' } = {}) {
    if (!reading || !Number.isFinite(reading.remaining) || !Number.isFinite(reading.pct)) return;
    readings[account] = { ...reading, account, at: now() };
    save(); render();
    try { document.dispatchEvent?.(new (document.defaultView?.CustomEvent || CustomEvent)('codeagent-quota', { detail: readings[account] })); } catch { /* 桌宠等订阅方可选 */ }
  }
  // accounts：core/codeagent-usage-menu.js readUsage 的结果（主进程 codeagent:usage 取回）。
  function setUsage(accounts) {
    usage = accounts && typeof accounts === 'object' ? { ...accounts } : {};
    render();
  }
  // 模型下拉用：这个号（personal / 号池编号）最近一次菜单快照，没有返回 null。
  function usageFor(key) { return (key && usage[key]) || null; }
  return { update, render, setUsage, usageFor, readings: () => ({ ...readings }) };
}

module.exports = { createCodeAgentQuotaBar };
