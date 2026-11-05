'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { metric, idleView, quotaView, readTime, renderQuota, metricTitle } = require('../renderer/codeagent-quota-panel-view');
const now = Date.parse('2026-11-04T06:05:00Z');
const row = overrides => ({ id: 'pool-a', state: 'ready', personal: false, label: '研发号', activeSessions: 2, ...overrides });

test('usage percentages are used while Stats percentages are remaining, and buckets stay separate', () => {
  const a = row({ credit: { busyDay: { pct: 38, used: 38, total: 100 }, monthly: { pct: 12, used: 60, total: 500 } },
    creditAt: now - 1000, creditReading: { bucket: '今日忙时', pct: 45, remaining: 45, total: 100 }, creditReadingAt: now });
  assert.deepEqual(metric(a, 'busyDay'), { pct: 45, remaining: 45, total: 100, at: now, source: 'stats' });
  assert.deepEqual(metric(a, 'monthly'), { pct: 88, remaining: 440, total: 500, at: now - 1000, source: 'usage' });
});

test('newer models or snapshot timestamp cannot make stale Credit override a newer screen reading', () => {
  const a = row({ usageAt: now + 1000, creditAt: now - 10000, credit: { busyDay: { pct: 10 } },
    creditReadingAt: now, creditReading: { bucket: 'busyDay', pct: 22 } });
  assert.equal(metric(a, 'busyDay').pct, 22);
  a.creditAt = now + 2000;
  assert.equal(metric(a, 'busyDay').pct, 90);
  assert.equal(metric(a, 'busyDay').at, now + 2000);
});

test('missing quantities remain unknown, zero remains exhausted, and out-of-range ratios clamp', () => {
  for (const pct of [undefined, null, '', 'bad']) assert.equal(metric(row({ credit: { busyDay: { pct } } }), 'busyDay'), null);
  const view = quotaView({ rows: [row({ credit: { busyDay: { pct: 100 }, monthly: { pct: -12 } }, creditAt: now })] }, { now });
  assert.equal(view.rows[0].busy.pct, 0); assert.equal(view.rows[0].month.pct, 100);
  assert.match(renderQuota(view), /class="qp-cap out"/); assert.match(renderQuota(view), /用完/);
  const unknown = renderQuota(quotaView({ rows: [row()] }));
  assert.match(unknown, /qp-none">未读取/); assert.doesNotMatch(unknown, /qp-cap[^>]*--v:0/);
  assert.match(unknown, /会话运行后显示/);
});

test('pause and login take precedence over loading while account counts exclude personal and duplicates', () => {
  const accounts = [row({ id: 'personal', personal: true }), row(), row({ id: 'paused', avoid: { source: 'quota', until: now + 60000 } }),
    row({ id: 'expired', state: 'expired' }), row({ id: 'duplicate', duplicateOf: 'pool-a' })];
  const view = quotaView({ rows: accounts }, { now, currentAccountId: 'pool-a', loadingKeys: new Set(['paused', 'expired']) });
  assert.equal(view.pool, 4); assert.equal(view.usable, 1);
  assert.deepEqual(view.rows.filter(a => a.current).map(a => a.id), ['pool-a']);
  assert.equal(view.rows[2].detail, '额度用完 · 约 14:06 恢复');
  assert.match(view.rows[3].detail, /需登录 · 登录已过期/);
  assert.ok(view.rows.slice(2).every(a => a.dim));
});

test('failures keep original reading time and take precedence over cooldown without inventing a reading', () => {
  const view = quotaView({ rows: [row({ credit: { busyDay: { pct: 20 } }, creditAt: now - 60000,
    refresh: { status: 'failed', error: 'serve failed' }, nextRefreshAt: now + 600000 }), row({ id: 'none', refresh: { status: 'failed' } })] }, { now });
  assert.equal(view.rows[0].at, now - 60000); assert.match(view.rows[0].detail, /保留上次读数/);
  assert.equal(view.rows[1].at, 0); assert.match(view.rows[1].detail, /暂未读到额度/);
  const cool = quotaView({ rows: [row({ nextRefreshAt: now + 600000 })] }, { now });
  assert.equal(cool.rows[0].detail, '10 分钟内读过 · 14:15 后可再读');
});

test('current session attribution is exact, including personal; absent session marks no account', () => {
  const rows = [row({ id: 'personal', personal: true, credit: { busyDay: { pct: 10 } } }), row()];
  assert.equal(quotaView({ rows }, { currentAccountId: '' }).rows.some(a => a.current), false);
  const view = quotaView({ rows }, { currentAccountId: 'personal' });
  assert.equal(view.rows[0].current, true); assert.equal(view.rows[1].current, false);
  assert.equal(view.rows[0].detail, '本会话 · 共 2 个会话');
});

test('idle countdown chooses newest applicable reading, turns active at deadline, and is omitted without fields', () => {
  assert.equal(idleView([row({ credit: { busyDay: { pct: 20 } } })], now), null);
  const rows = [row({ creditAt: now - 60000, credit: { idleDiscountActive: true, idleDiscount: '5折' } }),
    row({ creditAt: now, credit: { idleDiscountIn: '1h 56m', idleDiscount: '2折', idleDiscountUntil: now + 116 * 60000 } })];
  assert.match(idleView(rows, now).text, /2 折还有 1 时 56 分/);
  assert.equal(idleView(rows, now + 116 * 60000).active, true);
  assert.equal((renderQuota(quotaView({ rows }, { now }), { now }).match(/class="qp-idle/g) || []).length, 1);
});

test('timestamps use the account page timezone and show the date only across days', () => {
  assert.equal(readTime(now, now), '14:05');
  assert.equal(readTime(now - 86400000, now), '11-03 14:05');
  assert.equal(readTime(null, now), '');
  assert.equal(metricTitle({ pct: 62, remaining: null, total: 100, at: 0 }, 'busyDay', now), '今日忙时：62% · 读取时间未记录');
});

test('account labels, IDs and errors are escaped in expanded rows and collapsed tooltips', () => {
  const html = renderQuota(quotaView({ rows: [row({ id: '\" onclick=\"x', label: '<img src=x onerror=x>', refresh: { status: 'failed', error: '<script>x</script>' } })] }));
  assert.doesNotMatch(html, /<img|<script|data-qp-account="" onclick=/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
});
