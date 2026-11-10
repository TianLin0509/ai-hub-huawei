'use strict';
// 号池视图（成员版专属，公开版裁掉）：纯渲染检查。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboard, order, hourChart } = require('../renderer/lan-pool-dashboard-view');
const now = Date.UTC(2026, 10, 7, 6, 30); // 北京时间 14:30
const day = (requests, extra = {}) => ({ requests, succeeded: requests, failed: 0, limited: 0, tokensIn: requests * 1000, tokensOut: requests * 200,
  hours: Array.from({ length: 24 }, (_, i) => (i === 14 ? requests : 0)), models: requests ? { 'GLM-5.2-WX': { requests, tokensIn: requests * 1000, tokensOut: requests * 200 } } : {},
  tools: requests ? { 'Claude Code': requests } : {}, ...extra });
const row = (id, name, o = {}) => ({ id, name, revokedAt: null, maxConcurrent: 2, rpm: 60, online: false, lastSeenAt: null, ip: '', client: '', active: 0, minuteRequests: 0,
  lastUsedAt: null, today: day(0), week: Array.from({ length: 7 }, (_, i) => ({ day: '2026-11-0' + (i + 1), requests: 0, tokens: 0 })), weekRequests: 0, weekTokens: 0, ...o });
function data() {
  const rows = [row('a', '张工', { online: true, ip: '10.1.2.3', client: 'AI Hub 5.5.18', active: 1, minuteRequests: 3, lastUsedAt: now - 30000, lastSeenAt: now - 20000, today: day(12, { failed: 1, succeeded: 11, limited: 2 }) }),
    row('b', '李工', { lastSeenAt: now - 3 * 3600000, today: day(4) }), row('c', '王工', { revokedAt: now - 1000 })];
  return { ok: true, enabled: true, address: 'http://10.1.2.9:18766', health: { phase: 'serving' },
    quota: { rows: [{ id: 'x', label: '共享号 1', state: 'ready', usage: { at: now, models: [{ name: 'GLM-5.2-WX', day: { pct: 30 } }] } }] },
    stats: { at: now, today: '2026-11-07', onlineMs: 150000, keepDays: 14, rows,
      totals: { members: 2, online: 1, active: 1, requests: 16, succeeded: 15, failed: 1, limited: 2, tokensIn: 16000, tokensOut: 3200 },
      hours: day(16).hours, events: [{ at: now - 60000, id: 'a', name: '张工', kind: 'limit', text: '每分钟请求达到上限 60' }, { at: now - 120000, id: 'a', name: '张工', kind: 'online', text: '上线 · 10.1.2.3' }] } };
}
test('pool view shows presence, today usage, quota and events; revoked colleagues are folded', () => {
  const html = dashboard(data(), { now });
  for (const text of ['在线同事', '1<small>/2</small>', '成功率 94%', '1.9 万', '使用中', '10.1.2.3', 'AI Hub 5.5.18', '最后在线 3 小时前', '限流 2', '共享号 1', '70% 剩余', '每分钟请求达到上限 60', '显示已撤销 1 位'])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('王工'), 'revoked hidden by default');
  assert.ok(dashboard(data(), { now, showRevoked: true }).includes('王工'));
  assert.ok(!html.includes('class="pd-detail"'), 'detail collapsed');
  const open = dashboard(data(), { now, open: 'a' });
  assert.ok(open.includes('按模型') && open.includes('GLM-5.2-WX') && open.includes('按工具'));
});
test('active colleagues sort first, then online, offline, revoked', () => {
  assert.deepEqual(order(data().stats.rows.slice().reverse()).map(r => r.id), ['a', 'b', 'c']);
});
test('pool view guides the host when sharing is off, and escapes colleague names', () => {
  assert.ok(dashboard({ ok: true, enabled: false }).includes('去开启共享'));
  const d = data(); d.stats.rows[0].name = '<img src=x>';
  assert.ok(!dashboard(d, { now }).includes('<img src=x>'));
  assert.ok(hourChart(Array(24).fill(0), now).includes('<svg'));
});
