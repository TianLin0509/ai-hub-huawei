'use strict';
// 账号页「Token 开销」：只负责把账本算成页面，统计本身在 core/token-usage。

const PROVIDERS = [
  { id: 'codeagent', name: 'CodeAgent', color: '#3478f6' },
  { id: 'claude', name: 'Claude', color: '#14b8a6' },
  { id: 'codex', name: 'Codex', color: '#a78bfa' },
  { id: 'dsh', name: 'DSH', color: '#f97316' },
];
const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const shortDay = day => { const [, m, d] = day.split('-'); return `${+m}-${+d}`; };
const rowValue = (r, metric) => r[3] + r[5] + r[6] + (metric === 'net' ? 0 : r[4]);

function formatTokens(n) {
  if (!n) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e10 ? 0 : 1) + ' 亿';
  if (n >= 1e4) return Math.round(n / 1e4).toLocaleString('en-US') + ' 万';
  return n.toLocaleString('en-US');
}
// 窗口按「今天往前数」，避免页面停在昨天的账本上时少算一天。
function windowDays(now, count) { return Array.from({ length: count }, (_, i) => dayKey(now - (count - 1 - i) * DAY_MS)); }

function aggregate(data, metric = 'total', now = data?.now || Date.now()) {
  const days = windowDays(now, 30), last7 = new Set(days.slice(-7)), today = days[days.length - 1];
  const byDay = {}, models = {}, accounts = {};
  const providers = Object.fromEntries(PROVIDERS.map(p => [p.id, { today: 0, week: 0, month: 0 }]));
  for (const day of days) {
    byDay[day] = {};
    for (const r of data?.days?.[day] || []) {
      const [provider, model, account] = r, v = rowValue(r, metric);
      if (!providers[provider]) continue;
      byDay[day][provider] = (byDay[day][provider] || 0) + v;
      providers[provider].month += v;
      if (last7.has(day)) providers[provider].week += v;
      if (day === today) providers[provider].today += v;
      const modelKey = provider + '\u0000' + model, accountKey = provider + '\u0000' + account;
      models[modelKey] = (models[modelKey] || 0) + v;
      accounts[accountKey] = (accounts[accountKey] || 0) + v;
    }
  }
  const sum = key => PROVIDERS.reduce((s, p) => s + providers[p.id][key], 0);
  return { days, byDay, providers, models, accounts, totals: { today: sum('today'), week: sum('week'), month: sum('month') } };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => m <= s) * p;
}
const providerName = id => PROVIDERS.find(p => p.id === id)?.name || id;
const active = a => PROVIDERS.filter(p => a.providers[p.id].month > 0);

function chartHtml(a, esc) {
  const totals = a.days.map(d => Object.values(a.byDay[d]).reduce((s, v) => s + v, 0));
  const max = niceMax(Math.max(...totals, 0));
  const grid = [1, 0.75, 0.5, 0.25, 0].map(f => `<div class="atk-grid" style="bottom:${f * 100}%"><span>${f ? esc(formatTokens(max * f)) : '0'}</span></div>`).join('');
  const bars = a.days.map((day, i) => {
    const rows = PROVIDERS.filter(p => a.byDay[day][p.id] > 0);
    const tip = [shortDay(day) + (i === a.days.length - 1 ? '（今天，未结束）' : ''), ...rows.map(p => p.name + '：' + formatTokens(a.byDay[day][p.id])), '合计：' + formatTokens(totals[i])].join('\n');
    // 从上往下排，第一家排在最底；顶上那段圆角由 CSS 的 first-child 给。
    const parts = rows.slice().reverse().map(p => `<i style="height:${(a.byDay[day][p.id] / max * 100).toFixed(2)}%;background:${p.color}"></i>`).join('');
    return `<div class="atk-day" title="${esc(tip)}"><div class="atk-stack">${parts}</div>${i % 5 === 0 || i === a.days.length - 1 ? `<span>${esc(shortDay(day))}</span>` : ''}</div>`;
  }).join('');
  return `<div class="atk-chart" role="img" aria-label="近 30 天每日 token，下方表格有明细">${grid}<div class="atk-bars">${bars}</div></div>`;
}

function syncLine(data) {
  if (data.running) return `正在后台统计 ${data.stage || ''}…${data.syncedAt ? '约半分钟' : '第一次约 1–2 分钟'}，不影响使用`;
  const when = data.syncedAt ? (() => { const d = new Date(data.syncedAt); return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 已统计`; })() : '还没有统计';
  return `${when} · 每天 12:30、23:30 自动`;
}

function tokenPageHtml(data, { metric = 'total', accountName = (_provider, id) => id }, esc) {
  if (!data) return '<p class="atk-empty" role="status">正在读取 Token 账本…</p>';
  const a = aggregate(data, metric), list = active(a), hasData = a.totals.month > 0;
  const top = list.slice().sort((x, y) => a.providers[y.id].month - a.providers[x.id].month)[0];
  const lead = hasData ? `近 30 天共 ${formatTokens(a.totals.month)} token，${top.name} 占 ${Math.round(a.providers[top.id].month / a.totals.month * 100)}%` : 'Token 开销';
  const head = `<div class="atk-top"><h2>${esc(lead)}</h2><div class="atk-sync"><span role="status">${esc(syncLine(data))}</span><button class="caa-btn caa-btn-secondary caa-btn-sm" data-ca="token-sync" ${data.running ? 'disabled' : ''}>立即统计</button></div></div>`;
  const problems = (data.error ? `<p class="atk-error" role="alert">${esc('这次统计没完成，页面显示的是上次结果：' + data.error)}</p>` : '')
    + (data.errors ? `<p class="atk-note">${esc(data.errors + ' 个记录文件读取失败，已跳过，其余数字不受影响')}</p>` : '');
  if (!hasData) return head + problems + `<p class="atk-empty">${data.running ? '第一次统计完成后，这里会显示各工具的用量。' : '最近 30 天没有统计到用量，可以点「立即统计」。'}</p>`;
  const toggle = `<div class="atk-seg" title="缓存读取是重复读取上下文，通常占总量九成以上；切换后只看实际新增的部分"><button data-ca="token-metric" data-v="total" aria-pressed="${metric !== 'net'}">总量</button><button data-ca="token-metric" data-v="net" aria-pressed="${metric === 'net'}">不含缓存读取</button></div>`;
  const legend = `<div class="atk-legend">${list.map(p => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')}</div>`;
  const stats = [['今天（未结束）', 'today'], ['近 7 天', 'week'], ['近 30 天', 'month']].map(([label, key]) =>
    `<div><small>${label}</small><strong>${esc(formatTokens(a.totals[key]))}</strong><p>${esc(list.filter(p => a.providers[p.id][key] > 0).map(p => p.name + ' ' + formatTokens(a.providers[p.id][key])).join(' · ') || '—')}</p></div>`).join('');
  const providerRows = list.map(p => { const v = a.providers[p.id]; return `<tr${v.month ? '' : ' class="atk-zero"'}><td><i class="atk-dot" style="background:${p.color}"></i>${esc(p.name)}</td><td>${esc(formatTokens(v.today))}</td><td>${esc(formatTokens(v.week))}</td><td>${esc(formatTokens(v.month))}</td><td>${v.month ? Math.round(v.month / a.totals.month * 100) + '%' : '—'}</td></tr>`; }).join('');
  const sorted = obj => Object.entries(obj).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
  const modelRows = sorted(a.models).slice(0, 10).map(([key, v]) => { const [p, model] = key.split('\u0000'); return `<tr><td>${esc(model === 'unknown' ? '未分模型' : model)}</td><td>${esc(providerName(p))}</td><td>${esc(formatTokens(v))}</td></tr>`; }).join('');
  const accountLabel = (p, id) => id ? accountName(p, id) : '未归属账号';
  const accountRows = sorted(a.accounts).slice(0, 12).map(([key, v]) => { const [p, id] = key.split('\u0000'); return `<tr><td>${esc(accountLabel(p, id))}</td><td>${esc(providerName(p))}</td><td>${esc(formatTokens(v))}</td></tr>`; }).join('');
  return head + problems + `<div class="atk-tool">${toggle}${legend}</div><div class="atk-stats">${stats}</div>${chartHtml(a, esc)}
    <div class="atk-tables"><table class="atk-table"><thead><tr><th>工具</th><th>今天</th><th>近 7 天</th><th>近 30 天</th><th>占比</th></tr></thead><tbody>${providerRows}</tbody></table>
    <table class="atk-table"><thead><tr><th>模型（近 30 天）</th><th>工具</th><th>token</th></tr></thead><tbody>${modelRows}</tbody></table></div>
    <table class="atk-table atk-accounts"><thead><tr><th>账号（近 30 天，前 12）</th><th>工具</th><th>token</th></tr></thead><tbody>${accountRows}</tbody></table>
    <p class="atk-note">来自本机各 AI 的会话记录，只在本机统计，不调用模型，也不上传。账号按会话记录所在的账号目录计算。</p>`;
}

module.exports = { PROVIDERS, formatTokens, aggregate, tokenPageHtml };
