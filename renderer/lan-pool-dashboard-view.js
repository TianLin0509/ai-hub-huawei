'use strict';
// 号池视图（成员版专属）：主机端看所有同事的在线、用量和事件。只做字符串渲染，便于单测。
const { esc, clock, ago, fmtTokens, dot, clientSummary } = require('./lan-pool-view');

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const top = obj => Object.entries(obj || {}).sort((a, b) => (b[1].requests ?? b[1]) - (a[1].requests ?? a[1]));
// 7 天小柱图：最后一根是今天，用强调色。
function spark(week) {
  const max = Math.max(1, ...week.map(d => d.requests));
  const bars = week.map((d, i) => { const h = d.requests ? Math.max(2, Math.round((d.requests / max) * 18)) : 1;
    return `<rect x="${i * 8}" y="${20 - h}" width="6" height="${h}" rx="1" class="${i === week.length - 1 ? 'pd-today' : ''}"><title>${esc(d.day.slice(5))} · ${d.requests} 次</title></rect>`; }).join('');
  return `<svg class="pd-spark" viewBox="0 0 56 20" width="56" height="20" aria-hidden="true">${bars}</svg>`;
}
// 今天 24 小时请求分布：当前小时之后的柱子留空。
function hourChart(hours, now = Date.now(), { height = 96 } = {}) {
  const max = Math.max(1, ...hours), cur = new Date(now + 8 * 3600000).getUTCHours();
  const w = 24 * 22;
  const bars = hours.map((n, i) => { const h = n ? Math.max(2, Math.round((n / max) * (height - 32))) : 0;
    return `<g><rect x="${i * 22 + 3}" y="${height - 16 - h}" width="16" height="${h}" rx="2" class="${i === cur ? 'pd-now' : ''}"><title>${i}:00–${i + 1}:00 · ${n} 次</title></rect>${n && n === max ? `<text x="${i * 22 + 11}" y="${height - 20 - h}" text-anchor="middle" class="pd-peak">${n}</text>` : ''}</g>`; }).join('');
  const ticks = [0, 6, 12, 18, 23].map(i => `<text x="${i * 22 + 11}" y="${height - 2}" text-anchor="middle">${i}</text>`).join('');
  return `<svg class="pd-hours" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img" aria-label="今天每小时请求数"><line x1="0" x2="${w}" y1="${height - 16}" y2="${height - 16}" />${bars}${ticks}</svg>`;
}
function presence(r, now) {
  if (r.revokedAt) return { tone: 'mute', label: '已撤销', sub: '' };
  if (r.online) return { tone: 'ok', label: r.active ? '使用中' : '在线', sub: r.ip };
  return { tone: 'mute', label: '离线', sub: r.lastSeenAt ? '最后在线 ' + ago(r.lastSeenAt, now) : '还没连过' };
}
function kpis(v, quota, now = Date.now()) {
  const t = v.totals, ok = pct(t.succeeded, t.succeeded + t.failed);
  const q = quota?.rows?.length ? clientSummary({ ...quota, connection: 'online' }, now) : null;
  const cells = [
    ['在线同事', `${t.online}<small>/${t.members}</small>`, t.active ? `${t.active} 个请求进行中` : '当前没有进行中的请求'],
    ['今天请求', `${t.requests}`, ok == null ? '还没有完成的请求' : `成功率 ${ok}%${t.failed ? ` · 失败 ${t.failed}` : ''}`],
    ['今天 token', fmtTokens(t.tokensIn + t.tokensOut), `输入 ${fmtTokens(t.tokensIn)} · 输出 ${fmtTokens(t.tokensOut)}`],
    ['触发上限', `${t.limited}`, t.limited ? '有同事被限流，可考虑调高上限' : '没有同事被限流'],
    ['可用共享号', q ? `${q.ready}<small>/${q.total}</small>` : '—', q ? '主机号池，你和同事共同消耗' : '还没有额度读数'],
  ];
  return `<div class="pd-kpis">${cells.map(([k, n, s]) => `<div class="pd-kpi"><span>${k}</span><b>${n}</b><p>${esc(s)}</p></div>`).join('')}</div>`;
}
function memberRow(r, { now, open }) {
  const p = presence(r, now), d = r.today, tools = top(d.tools), models = top(d.models);
  const done = d.succeeded + d.failed, ok = pct(d.succeeded, done);
  const main = `<tr class="pd-row${r.revokedAt ? ' pd-revoked' : ''}${open ? ' pd-open' : ''}" data-pd-member="${esc(r.id)}" tabindex="0" aria-expanded="${open}">
    <td><span class="pd-state">${dot(p.tone)}<span><b>${esc(p.label)}</b><small>${esc(p.sub)}</small></span></span></td>
    <td><strong>${esc(r.name)}</strong><small>${esc(r.client || '')}</small></td>
    <td class="pd-num">${r.active ? `<span class="lp-live">${r.active}</span>` : '0'}<small>/${r.maxConcurrent}</small></td>
    <td class="pd-num">${r.minuteRequests}<small>/${r.rpm}</small></td>
    <td class="pd-num"><b>${d.requests}</b><small>${ok == null ? '' : `成功 ${ok}%`}${d.limited ? ` · 限流 ${d.limited}` : ''}</small></td>
    <td class="pd-num">${fmtTokens(d.tokensIn + d.tokensOut)}</td>
    <td>${tools.length ? esc(tools[0][0]) : '—'}<small>${models.length ? esc(models[0][0]) : ''}</small></td>
    <td>${spark(r.week)}<small>7 天 ${r.weekRequests} 次</small></td>
    <td>${esc(ago(r.lastUsedAt, now))}</td></tr>`;
  if (!open) return main;
  const list = (rows, unit) => rows.length ? rows.map(([k, x]) => `<li><span>${esc(k)}</span><b>${x.requests ?? x} 次</b>${x.tokensIn != null ? `<small>${fmtTokens(x.tokensIn + x.tokensOut)} token</small>` : ''}</li>`).join('') : `<li class="lp-muted">今天还没有${unit}</li>`;
  return main + `<tr class="pd-detail"><td colspan="9"><div class="pd-detail-grid">
    <section><h4>今天每小时</h4>${hourChart(d.hours, now, { height: 72 })}</section>
    <section><h4>按模型</h4><ul class="pd-list">${list(models, '模型请求')}</ul></section>
    <section><h4>按工具</h4><ul class="pd-list">${list(tools, '工具请求')}</ul><p class="pd-meta">来源地址 ${esc(r.ip || '—')} · 最后在线 ${esc(r.lastSeenAt ? clock(r.lastSeenAt) : '—')}</p></section>
  </div></td></tr>`;
}
const EVENT = { online: ['ok', '上线'], limit: ['warn', '限流'], error: ['bad', '失败'], revoke: ['mute', '撤销'] };
function events(list, now) {
  if (!list.length) return '<p class="lp-muted">还没有事件。同事上线、被限流、请求失败或口令撤销时会记在这里。</p>';
  return `<ol class="pd-events">${list.map(e => { const [tone, tag] = EVENT[e.kind] || ['mute', '事件'];
    return `<li><time title="${esc(new Date(e.at).toLocaleString('zh-CN', { hour12: false }))}">${esc(ago(e.at, now))}</time><span class="pd-tag pd-${tone}">${tag}</span><b>${esc(e.name)}</b><span>${esc(e.text)}</span></li>`; }).join('')}</ol>`;
}
function quotaBlock(quota, now = Date.now()) {
  if (!quota?.rows?.length) return `<p class="lp-muted">${esc(quota?.error || '主机还没有账号额度读数。')}</p>`;
  const v = clientSummary({ ...quota, connection: 'online' }, now);
  return `<ul class="lp-quota">${v.rows.map(r => `<li class="lp-q-${r.quota.tone}"><span class="lp-q-name">${esc(r.label)}</span><span class="lp-q-model">${esc(r.quota.model || '—')}</span>${r.quota.left == null ? '<span class="lp-bar lp-empty"><i></i></span>' : `<span class="lp-bar lp-${r.quota.tone}"><i style="width:${Math.max(2, r.quota.left)}%"></i></span>`}<b>${esc(r.quota.text)}</b></li>`).join('')}</ul>`;
}
const PHASE = { serving: ['ok', '正在共享'], 'waiting-model': ['warn', '模型服务准备中'], starting: ['warn', '正在启动'], error: ['bad', '共享暂停'], off: ['mute', '未开启'] };
// 排序：使用中 > 在线 > 离线 > 已撤销；同组按今天请求数。
function order(rows) {
  const rank = r => (r.revokedAt ? 3 : r.active ? 0 : r.online ? 1 : 2);
  return rows.slice().sort((a, b) => rank(a) - rank(b) || b.today.requests - a.today.requests || String(a.name).localeCompare(String(b.name), 'zh'));
}
function dashboard(data, { now = Date.now(), open = '', showRevoked = false } = {}) {
  if (!data?.enabled) {
    return `<div class="pd-empty"><h3>本机还没有开启内网共享</h3><p>开启共享并给同事生成口令后，这里会显示每位同事的在线状态、用量和事件。</p><button type="button" class="primary" data-pd-settings>去开启共享</button></div>`;
  }
  const v = data.stats, [tone, label] = PHASE[data.health?.phase] || PHASE.off;
  const rows = order(v.rows), live = rows.filter(r => !r.revokedAt), revoked = rows.filter(r => r.revokedAt);
  const shown = showRevoked ? rows : live;
  const banner = data.health?.error ? `<div class="lp-banner lp-${data.health.phase === 'error' ? 'bad' : 'warn'}">${esc(data.health.error)}</div>` : '';
  const table = shown.length ? `<table class="pd-table"><thead><tr><th>状态</th><th>同事</th><th class="pd-num">进行中</th><th class="pd-num">本分钟</th><th class="pd-num">今天请求</th><th class="pd-num">今天 token</th><th>主要工具</th><th>近 7 天</th><th>最近使用</th></tr></thead>
    <tbody>${shown.map(r => memberRow(r, { now, open: open === r.id })).join('')}</tbody></table>` : '<p class="lp-muted">还没有同事。在「管理共享」里给同事生成口令。</p>';
  return `<div class="pd-status"><span class="lp-pill lp-${tone}">${dot(tone)} ${esc(label)}</span><span class="pd-addr">同事地址 <code class="lp-mono">${esc(data.address || '—')}</code></span><span class="pd-at">更新于 ${esc(clock(v.at))} · 每 5 秒自动刷新</span></div>
    ${banner}${kpis(v, data.quota, now)}
    <section class="pd-block"><header><h3>同事</h3><small>点一行看今天每小时、按模型和按工具的明细</small><span class="lp-grow"></span>${revoked.length ? `<button type="button" class="lp-quiet lp-sm" data-pd-revoked>${showRevoked ? '隐藏' : '显示'}已撤销 ${revoked.length} 位</button>` : ''}</header>${table}</section>
    <div class="pd-cols">
      <section class="pd-block"><header><h3>今天每小时请求</h3><small>全部同事合计，不含你自己</small></header>${hourChart(v.hours, now)}</section>
      <section class="pd-block"><header><h3>主机各号今日额度</h3><small>你和同事共同消耗</small></header>${quotaBlock(data.quota, now)}</section>
    </div>
    <section class="pd-block"><header><h3>最近事件</h3><small>最近 30 条</small></header>${events(v.events, now)}</section>
    <p class="lp-foot">「在线」指同事的 Hub 正连着本机（约每分钟报到一次，超过 ${Math.round(v.onlineMs / 60000 * 10) / 10} 分钟没报到算离线）。统计按天保留 ${v.keepDays} 天，只记次数、token 数、模型和工具名，不记录对话内容。</p>`;
}
module.exports = { dashboard, hourChart, spark, order, presence };
