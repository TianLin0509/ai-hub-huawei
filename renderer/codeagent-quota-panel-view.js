'use strict';

const { accountState, pauseReason } = require('./codeagent-account-state');
const { durationMinutes } = require('../core/codeagent-usage-menu');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = value => Math.max(0, Math.min(100, value));
const BUCKETS = { busyDay: ['busyDay', '今日忙时', '忙时'], monthly: ['monthly', '月度'] };
const LABELS = { busyDay: '今日忙时', monthly: '月度' };
const fmt = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });

function readTime(at, now = Date.now()) {
  if (!(number(at) > 0)) return '';
  const date = new Date(Number(at) + 8 * 3600000).toISOString();
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  return date.slice(0, 10) === today ? date.slice(11, 16) : date.slice(5, 16).replace('T', ' ');
}

function metric(row, bucket) {
  const usage = row.credit?.[bucket];
  const stats = row.creditReading;
  const usedPct = number(usage?.pct);
  const statsPct = stats && BUCKETS[bucket].includes(stats.bucket) ? number(stats.pct) : null;
  const usageAt = number(row.creditAt) || 0, statsAt = number(row.creditReadingAt) || 0;
  if (statsPct !== null && (usedPct === null || statsAt >= usageAt)) {
    return { pct: clamp(statsPct), remaining: number(stats.remaining), total: number(stats.total), at: statsAt, source: 'stats' };
  }
  if (usedPct === null) return null;
  const total = number(usage.total), used = number(usage.used);
  return { pct: clamp(100 - usedPct), remaining: total !== null && used !== null ? Math.max(0, total - used) : null,
    total, at: usageAt, source: 'usage' };
}

function idleView(rows, now) {
  const source = rows.filter(row => row.credit && (row.credit.idleDiscountActive || row.credit.idleDiscountIn || row.credit.idleDiscountUntil))
    .sort((a, b) => (b.creditAt || 0) - (a.creditAt || 0))[0];
  if (!source) return null;
  const credit = source.credit;
  const discount = credit.idleDiscount ? String(credit.idleDiscount).replace(/\s*折$/, ' 折') : '优惠';
  const minutes = durationMinutes(credit.idleDiscountIn);
  const until = number(credit.idleDiscountUntil) || (minutes !== null && source.creditAt ? source.creditAt + minutes * 60000 : 0);
  if (credit.idleDiscountActive || (until > 0 && now >= until)) return { active: true, text: `闲时 ${discount}进行中`, at: source.creditAt };
  if (!(until > now)) return null;
  const left = Math.ceil((until - now) / 60000), hours = Math.floor(left / 60);
  const time = hours ? `${hours} 时${left % 60 ? ` ${left % 60} 分` : ''}` : `${left} 分`;
  return { active: false, text: `闲时 ${discount}还有 ${time}`, at: source.creditAt };
}

function quotaView(snapshot, { now = Date.now(), currentAccountId = '', loadingKeys = new Set() } = {}) {
  const rows = (snapshot?.rows || []).map((account, index) => {
    const health = accountState(account, { personal: account.personal });
    const busy = metric(account, 'busyDay'), month = metric(account, 'monthly');
    const current = !!currentAccountId && account.id === currentAccountId;
    const loading = loadingKeys.has(account.id) || account.refresh?.status === 'in-flight';
    const count = Number(account.activeSessions) || 0;
    let detail = current ? `本会话 · 共 ${count} 个会话` : count ? `${count} 个会话` : '无会话';
    let warning = false;
    if (account.avoid) { detail = pauseReason(account.avoid, now); warning = true; }
    else if (!health.usable) { detail = [health.label, health.detail].filter(Boolean).join(' · '); warning = true; }
    else if (loading) detail = '读取中…';
    else if (account.refresh?.status === 'failed' || account.refresh?.error) { detail = busy || month ? '读取失败，保留上次读数' : '读取失败，暂未读到额度'; warning = true; }
    else if (account.refresh?.status === 'disabled') detail = busy || month ? '暂未开启额度读取 · 显示上次读数' : '暂未开启额度读取';
    else if (account.nextRefreshAt > now) detail = `10 分钟内读过 · ${readTime(account.nextRefreshAt, now)} 后可再读`;
    else if (!busy && !month) detail = '会话运行后显示';
    const at = Math.max(busy?.at || 0, month?.at || 0);
    const name = account.personal ? '我的个人账号' : account.label || account.note || account.accountLabel || '未备注账号';
    return { ...account, name, busy, month, at, current, loading, warning, detail,
      usable: health.usable, dim: !health.usable || busy?.pct === 0 || month?.pct === 0,
      avatar: account.personal ? '我' : [...name][0],
      tint: account.personal ? 'brand' : ['tint-room', 'tint-assist', 'tint-meet', 'tint-room', 'tint-forum'][(index - 1 + 5) % 5] };
  });
  const pool = rows.filter(row => !row.personal);
  return { rows, pool: pool.length, usable: pool.filter(row => row.usable).length,
    idle: idleView(snapshot?.rows || [], now), at: Math.max(0, ...rows.map(row => row.at)) };
}

const ICON_PATHS = {
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  fold: '<path d="m7 7 5 5-5 5m6-10 5 5-5 5"/>',
  unfold: '<path d="m11 7-5 5 5 5m6-10-5 5 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 3 3"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
function metricTitle(value, bucket, now) {
  if (!value) return `${LABELS[bucket]}：未读取`;
  const quantity = value.remaining !== null ? `剩 ${fmt(value.remaining)}${value.total !== null ? ` / ${fmt(value.total)}` : ''} · ` : '';
  return `${LABELS[bucket]}：${quantity}${Math.round(value.pct)}%${value.at ? ` · ${readTime(value.at, now)} 读取` : ' · 读取时间未记录'}`;
}
function capsule(value, bucket, now) {
  if (!value) return `<span class="qp-cap none" data-qp-bucket="${bucket}" title="${metricTitle(null, bucket, now)}">未读取</span>`;
  const classes = value.pct === 0 ? ' out' : value.pct < 20 ? ' low' : '';
  return `<span class="qp-cap${classes}" data-qp-bucket="${bucket}" style="--v:${value.pct}" title="${esc(metricTitle(value, bucket, now))}"><span>${value.pct === 0 ? '用完' : Math.round(value.pct) + '%'}</span></span>`;
}
function rowHtml(row, now) {
  const detail = row.warning ? `<span class="warn">${esc(row.detail)}</span>` : row.current && row.detail.startsWith('本会话')
    ? '<span><span class="cur">本会话</span>' + esc(row.detail.slice(3)) + '</span>' : `<span>${esc(row.detail)}</span>`;
  return `<div class="qp-row${row.current ? ' is-current' : ''}${row.dim ? ' dim' : ''}${row.loading ? ' is-loading' : ''}" data-qp-account="${esc(row.id)}" role="button" tabindex="0" title="${esc(`打开账号页并定位到「${row.name}」`)}">
    <span class="qp-av" style="--av:var(--hw-${row.tint})">${esc(row.avatar)}</span><span class="qp-name">${esc(row.name)}</span>
    ${!row.busy && !row.month ? '<span class="qp-none">未读取</span>' : capsule(row.busy, 'busyDay', now) + capsule(row.month, 'monthly', now)}
    <div class="qp-sub" title="${esc(row.refresh?.error || row.detail)}">${detail}${row.at && !row.loading ? `<span class="qp-at">${readTime(row.at, now)}</span>` : ''}</div></div>`;
}
function ringHtml(row, now) {
  const cls = row.dim ? 'off' : !row.busy ? 'none' : row.busy.pct < 20 ? 'low' : '';
  const title = [row.name, metricTitle(row.busy, 'busyDay', now), metricTitle(row.month, 'monthly', now), row.detail].join('\n');
  return `<button type="button" class="qp-ring ${cls}${row.current ? ' is-current' : ''}" data-qp-account="${esc(row.id)}" style="--v:${row.busy?.pct || 0}" aria-label="${esc(title)}"><span class="qp-av" style="--av:var(--hw-${row.tint})">${esc(row.avatar)}</span></button>`;
}
function renderQuota(view, { now = Date.now(), refreshing = false, loadingCount = 0, message = '' } = {}) {
  const note = refreshing ? `正在读取 ${loadingCount} 个号…` : message;
  const group = personal => `<div class="qp-g">${personal ? '个人账号' : `号池 · ${view.usable}/${view.pool} 可用`}</div>`
    + view.rows.filter(row => row.personal === personal).map(row => rowHtml(row, now)).join('');
  return `<div class="qp-h"><h3>号池额度</h3><span class="qp-n"><b>${view.usable}</b>/${view.pool} 可用</span><span class="sp"></span>
    <button type="button" class="icon-btn qp-refresh" data-qp-action="refresh" title="刷新全部号的读数（同一个号 10 分钟内只读一次）" aria-label="刷新全部额度"${refreshing ? ' disabled' : ''}>${icon('refresh')}</button>
    <button type="button" class="icon-btn qp-fold" data-qp-action="collapse" title="收起成细栏" aria-label="收起额度栏">${icon('fold')}</button></div>
    ${note ? `<div class="qp-note" role="status"><i class="d"></i><span>${esc(note)}</span></div>` : ''}
    ${view.idle ? `<div class="qp-idle${view.idle.active ? ' on' : ''}" title="${esc(`按最近读数计算 · ${readTime(view.idle.at, now) || '读取时间未知'}`)}">${icon('clock')}<span>${esc(view.idle.text)}</span></div>` : ''}
    <div class="qp-cols"><span></span><span>今日忙时</span><span>月度</span></div><div class="qp-list">${group(true)}${group(false)}${view.pool ? '' : '<div class="qp-empty">号池暂无账号</div>'}</div>
    <div class="qp-f"><button type="button" class="btn btn-ghost btn-sm" data-qp-action="accounts">${icon('key')}打开账号页</button><small>剩余比例${view.at ? ` · ${readTime(view.at, now)} 读取` : ''}</small></div>
    <div class="qp-rail"><button type="button" class="icon-btn" data-qp-action="expand" title="展开号池额度" aria-label="展开号池额度">${icon('unfold')}</button>
    <div class="qp-rail-sum"><b>${view.usable}</b>/${view.pool}</div><span class="qp-rail-line"></span>${view.rows.map(row => ringHtml(row, now)).join('')}
    <span class="sp"></span><button type="button" class="icon-btn" data-qp-action="accounts" title="打开账号页" aria-label="打开账号页">${icon('key')}</button></div>`;
}

module.exports = { metric, idleView, quotaView, readTime, renderQuota, metricTitle };
