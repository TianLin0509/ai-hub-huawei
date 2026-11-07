'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { metric, idleView, quotaView, readTime, renderQuota, renderQuotaFooter, metricTitle, wholePct, tipHtml } = require('../renderer/codeagent-quota-panel-view');
const now = Date.parse('2026-11-04T06:05:00Z');
const row = overrides => ({ id: 'pool-a', state: 'ready', personal: false, label: '研发号', activeSessions: 2, ...overrides });

test('未安装时额度栏统一指向安装说明，安装后恢复登录状态与读数', () => {
  const snapshot = { rows: [row({ state: 'login-required', personal: true })] };
  const missing = renderQuota(quotaView(snapshot, { installed: false }));
  assert.match(missing, /CodeAgent 未安装/); assert.match(missing, /data-qp-action="install-guide"/);
  assert.doesNotMatch(missing, /需登录|未读取/);
  assert.match(renderQuota(quotaView(snapshot, { installed: true })), /需登录/);
});

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
  const unknown = renderQuota(quotaView({ rows: [row()] }));
  assert.match(unknown, /qp-cap none[^>]*>未读取/); assert.doesNotMatch(unknown, /qp-cap[^>]*--v:0/);
  assert.match(unknown, /下次读取后显示/);
});

test('pause and login take precedence over loading while account counts exclude personal and duplicates', () => {
  const accounts = [row({ id: 'personal', personal: true }), row(), row({ id: 'paused', avoid: { source: 'quota', until: now + 60000 } }),
    row({ id: 'expired', state: 'expired' }), row({ id: 'duplicate', duplicateOf: 'pool-a' })];
  const view = quotaView({ rows: accounts }, { now, currentAccountId: 'pool-a', loadingKeys: new Set(['paused', 'expired']) });
  assert.equal(view.total, 4); assert.equal(view.usable, 2);
  assert.deepEqual(view.rows.map(a => a.id), ['personal', 'pool-a', 'paused', 'expired']);
  assert.deepEqual(view.rows.filter(a => a.current).map(a => a.id), ['pool-a']);
  assert.equal(view.rows[2].detail, '额度用完 · 约 14:06 恢复');
  assert.equal(view.rows[3].detail, '登录已过期'); assert.equal(view.rows[3].needsLogin, true);
  assert.ok(view.rows.slice(2).every(a => a.dim));
});

test('failures keep original reading time and take precedence over cooldown without inventing a reading', () => {
  const view = quotaView({ rows: [row({ credit: { busyDay: { pct: 20 } }, creditAt: now - 60000,
    refresh: { status: 'failed', error: 'serve failed' }, nextRefreshAt: now + 600000 }), row({ id: 'none', refresh: { status: 'failed' } })] }, { now });
  assert.equal(view.rows[0].at, now - 60000); assert.match(view.rows[0].detail, /保留上次读数/);
  assert.equal(view.rows[1].at, 0); assert.match(view.rows[1].detail, /暂未读到额度/);
});

test('current session attribution is exact, including personal; absent session marks no account', () => {
  const rows = [row({ id: 'personal', personal: true, credit: { busyDay: { pct: 10 } } }), row()];
  assert.equal(quotaView({ rows }, { currentAccountId: '' }).rows.some(a => a.current), false);
  const view = quotaView({ rows }, { currentAccountId: 'personal' });
  assert.equal(view.rows[0].current, true); assert.equal(view.rows[1].current, false);
  assert.match(renderQuota(view, { now }), /qp-row is-current/);
});

// 用户复制的 /model 原文里的读数（tests/unit-codeagent-usage.test.js REAL_USAGE）。
const REAL = { credit: { monthly: { used: '402.74', total: '400000', pct: 0.1 }, busyDay: { used: '55.7', total: '20000', pct: 0.27 }, idleDay: { used: '25.18', total: '20000', pct: 0.12 } },
  models: [{ name: 'GLM-5.2-WX-Auto', day: { used: '6.78M', total: '400M', pct: 1.7 }, hour: { used: '415.29K', total: '200M', pct: 0.21 }, min: { used: '313.29K', total: '1M', pct: 31.33 } }], modelsAt: now };
const withUsage = (usage, extra = {}) => row({ usage, credit: usage.credit, creditAt: now - 60000, defaultModel: 'GLM-5.2-WX-Auto', ...extra });

test('the main number is today\'s Token remaining for the current model, not the near-full Credit', () => {
  const html = renderQuota(quotaView({ rows: [withUsage(REAL), row({ id: 'b' })] }, { now }), { now });
  assert.match(html, /data-qp-bucket="token"[^>]*><span>98%<\/span>/);
  assert.doesNotMatch(html, />100%</);
  assert.match(html, /今日 Token/); assert.doesNotMatch(html, /<span>月度<\/span>/);
  // Credit 只在悬停卡
  const tip = tipHtml(quotaView({ rows: [withUsage(REAL), row({ id: 'b' })] }, { now }).rows[0], now);
  assert.match(tip, /Credit 今日忙时<\/span><em>19,944\.3 \/ 20,000<\/em><span>剩 99%/); assert.match(tip, /Credit 闲时/); assert.match(tip, /Credit 月度/);
  assert.match(tip, /今日<\/span><em>6\.78M \/ 400M<\/em><span>剩 98%/); assert.match(tip, /本分钟<\/span><em>313\.29K \/ 1M<\/em><span>已用 31\.3%/);
  assert.doesNotMatch(tip, /自动避开/);
});

test('a session on another model shows that model; a model without a reading stays unread instead of borrowing', () => {
  const usage = { ...REAL, models: [...REAL.models, { name: 'other-model', day: { pct: 40 }, hour: null, min: null }] };
  const rows = [withUsage(usage), row({ id: 'b' })];
  const view = quotaView({ rows }, { now, currentAccountId: 'pool-a', currentModel: 'other-model' });
  assert.equal(view.rows[0].token.name, 'other-model'); assert.equal(view.rows[0].token.pct, 60);
  assert.equal(quotaView({ rows }, { now }).rows[0].token.name, 'GLM-5.2-WX-Auto');
  assert.equal(quotaView({ rows }, { now, currentAccountId: 'pool-a', currentModel: 'unread' }).rows[0].token, null);
});

test('hour or minute at 80% warns; rounding never claims full or empty wrongly', () => {
  const hot = { ...REAL, models: [{ ...REAL.models[0], min: { pct: 85 } }] };
  const view = quotaView({ rows: [withUsage(hot), row({ id: 'b' })] }, { now });
  assert.equal(view.rows[0].alert, '分钟窗 85%'); assert.equal(view.rows[0].detail, 'GLM-5.2-WX-Auto');
  // 右侧栏由「1 分钟」小胶囊变琥珀表达（剩 15%），第二行不再写「已用 85%」免得和胶囊打架
  assert.match(renderQuota(view, { now }), /class="qp-win low" data-qp-window="min"[^>]*>.*?<span>15%<\/span>/);
  assert.doesNotMatch(renderQuota(view, { now }), /class="warn">分钟窗 85%/);
  const calm = quotaView({ rows: [withUsage(REAL), row({ id: 'b' })] }, { now });
  assert.equal(calm.rows[0].alert, ''); assert.equal(calm.rows[0].detail, 'GLM-5.2-WX-Auto');
  assert.deepEqual([100, 99.9, 98.3, 0.2, 0].map(wholePct), [100, 99, 98, 1, 0]);
  const out = { ...REAL, models: [{ ...REAL.models[0], day: { pct: 100 } }] };
  const outHtml = renderQuota(quotaView({ rows: [withUsage(out), row({ id: 'b' })] }, { now }), { now });
  assert.match(outHtml, /class="qp-cap out"[^>]*><span>用完/); assert.match(outHtml, /约 00:00 恢复/); assert.match(outHtml, /通常每日 00:00 重置/);
  // 需登录：不画条，第二行没有空 span
  const login = renderQuota(quotaView({ rows: [row({ state: 'expired' }), row({ id: 'b' })] }, { now }), { now });
  assert.match(login, /qp-cap none[^>]*>需登录/);
  assert.match(renderQuotaFooter(quotaView({ rows: [row({ state: 'expired' }), row({ id: 'b' })] }, { now }), { now }), /<b>需登录<\/b>/); assert.doesNotMatch(login, /<span><\/span><span class="warn"/);
  assert.match(renderQuota(quotaView({ rows: [row({ id: 'personal', personal: true, present: true }), row()] }, { now }), { now }), /<i class="qp-tag">个人<\/i>/);
});

// 公司真机缓存（Q-1105-04）：号 4 是旧结构，没有 modelsAt / modelsRead，deepseek 今日已用 56.51%，Credit 月度只用 0.4%，旧面板显示 96%。
test('acceptance: the old structure account shows its real 43% instead of 96%, on right and bottom', () => {
  const legacy = { at: now - 60000, credit: { monthly: { used: '1600', total: '400000', pct: 0.4 }, busyDay: { used: '0', total: '20000', pct: 0 } },
    models: [{ name: 'deepseek-v4.1-flash-1017', factor: '0.2x', load: 'low', day: { used: '226.06M', total: '400M', pct: 56.51 }, hour: { used: '1M', total: '200M', pct: 0.5 }, min: { used: '0', total: '5M', pct: 0 } }] };
  const view = quotaView({ rows: [row({ usage: legacy, credit: legacy.credit, creditAt: legacy.at, defaultModel: 'deepseek-v4.1-flash-1017' }), row({ id: 'b' })] }, { now });
  assert.equal(view.rows[0].token.expired, false);
  assert.match(renderQuota(view, { now }), /data-qp-bucket="token"[^>]*><span>43%<\/span>/);
  assert.match(renderQuotaFooter(view, { now }), /<b>43%<\/b>/);
  assert.doesNotMatch(renderQuotaFooter(view, { now }), /96%/);
});

test('without a reset time, windows are inferred: yesterday is not today, an old hour or minute does not warn', () => {
  const hot = { ...REAL, models: [{ ...REAL.models[0], hour: { pct: 90 }, min: { pct: 95 } }] };
  const at = offset => quotaView({ rows: [withUsage({ ...hot, modelsAt: now - offset }), row({ id: 'b' })] }, { now });
  assert.equal(at(0).rows[0].alert, '分钟窗 95%');
  // now 是 14:05:00（北京时间）：1 分钟前换了分钟，10 分钟前换了小时
  assert.equal(at(60000).rows[0].alert, '小时窗 90%');
  assert.equal(at(600000).rows[0].alert, '');
  const stale = tipHtml(at(600000).rows[0], now);
  assert.match(stale, /上次 90%/); assert.match(stale, /CodeAgent 不告诉重置时间/); assert.doesNotMatch(stale, /tk warn/);
  const yesterday = at(24 * 3600000);
  assert.equal(yesterday.rows[0].token.expired, true);
  const html = renderQuota(yesterday, { now });
  assert.match(html, />待读取</); assert.doesNotMatch(html, /qp-cap low/); assert.match(html, /24 小时前/); assert.match(html, /qp-at warn/);
  assert.match(renderQuotaFooter(yesterday, { now }), /<b>待读取<\/b>/);
});

test('one list with personal first; more than one distinct account is needed to show the panel', () => {
  const personal = row({ id: 'personal', personal: true, present: true });
  const html = renderQuota(quotaView({ rows: [personal, row()] }, { now }), { now });
  assert.doesNotMatch(html, /qp-g"/); assert.ok(html.indexOf('data-qp-account="personal"') < html.indexOf('data-qp-account="pool-a"'));
  assert.equal(quotaView({ rows: [personal, row()] }).visible, true);
  assert.equal(quotaView({ rows: [personal, row({ sameAsPersonal: true })] }).visible, false);
  assert.equal(quotaView({ rows: [personal, row({ id: 'x', duplicateOf: 'personal' })] }).visible, false);
  assert.equal(quotaView({ rows: [{ ...personal, present: false }, row()] }).visible, false);
  assert.equal(quotaView({ rows: [] }).visible, false);
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

// 配额按北京时间换日。下面两组时刻都故意跨 UTC 或北京时间的日界，判断改用 UTC 时一定变红。
test('the day boundary is Beijing time: 00:10 does not count 23:50 as today, 08:10 still counts 07:50', () => {
  const beijing = text => Date.parse(`${text}+08:00`);
  const metricAt = (read, current) => quotaView({ rows: [withUsage({ ...REAL, modelsAt: beijing(read) }), row({ id: 'b' })] }, { now: beijing(current) }).rows[0].token;
  // 同一个 UTC 日（15:50Z、16:10Z），北京时间已换日
  assert.equal(metricAt('2026-11-05T23:50:00', '2026-11-06T00:10:00').expired, true);
  assert.equal(metricAt('2026-11-05T23:59:59', '2026-11-06T00:00:00').expired, true);
  // 0–8 点内任何时刻，昨天的读数都不当今天
  for (const hour of ['00', '03', '07']) assert.equal(metricAt('2026-11-05T22:00:00', `2026-11-06T${hour}:30:00`).expired, true, hour);
  // 跨 UTC 日（23:50Z、00:10Z），北京时间还是同一天
  const sameDay = metricAt('2026-11-06T07:50:00', '2026-11-06T08:10:00');
  assert.equal(sameDay.expired, false); assert.equal(sameDay.pct, 98.3);
  // 小时窗也按北京时间：换了小时不算当前窗口
  assert.equal(metricAt('2026-11-06T07:59:00', '2026-11-06T08:00:00').fresh.hour, false);
  assert.equal(metricAt('2026-11-06T08:01:00', '2026-11-06T08:59:00').fresh.hour, true);
});
