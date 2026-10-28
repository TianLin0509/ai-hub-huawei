'use strict';

// Reactive subscription-account selection. Unlike proactive cswap thresholds,
// an exhausted, freshly observed window must corroborate a quota failure.
// Nothing here reads credentials or changes the native conversation.
const MAX_USAGE_AGE_MS = 60_000;
// Neutral on purpose (2026-10-28): this text is sent by the new account, so it
// must not announce that another account's quota ran out.
const CONTINUE_AFTER_SWITCH = '继续刚才中断的任务。保留已经完成的工作，先核对上一项工具操作的结果，只继续尚未完成的部分。';

function windowsForModel(usage, model = '') {
  if (!usage || typeof usage !== 'object') return [];
  const windows = ['five_hour', 'seven_day'].map(key => ({ key, value: usage[key] }));
  const name = String(model).toLowerCase();
  for (const [key, value] of Object.entries(usage)) {
    if (!key.startsWith('seven_day_') || !value) continue;
    const family = key.slice('seven_day_'.length);
    const display = String(value.display_name || '').toLowerCase();
    if (name.includes(family) || (display && name.includes(display))) windows.push({ key, value });
  }
  return windows;
}

function quotaReading(snapshot, model, now = Date.now()) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now
      || now - snapshot.observedAt > MAX_USAGE_AGE_MS) return null;
  const windows = windowsForModel(snapshot.usage, model);
  // Unknown is not spare quota. A missing account-wide cycle cannot qualify a
  // candidate. Enterprise-specific window schemes need their own adapter.
  if (windows.length < 2 || windows.some(({ value }) => !value
      || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)
      || value.utilization < 0 || value.utilization > 100)) return null;
  return { exhausted: windows.some(w => w.value.utilization >= 100),
    headroom: Math.min(...windows.map(w => 100 - w.value.utilization)) };
}

function isConfirmedQuotaWall({ error, errorDetails, snapshot, model, now = Date.now() }) {
  const text = [error, typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails || {})].join(' ');
  // A rejected credential, safety/verification prompt or transport fault must
  // never turn into account rotation, even when the account is also exhausted.
  if (/invalid_grant|authentication|unauthorized|\b401\b|\b403\b|verification|suspend|banned|overloaded|ECONN|timeout|network/i.test(text)) return false;
  const quotaError = /rate[_ -]?limit|usage[_ -]?limit|quota|额度|用量.*上限/i.test(text);
  return quotaError && quotaReading(snapshot, model, now)?.exhausted === true;
}

function selectQuotaAccount({ currentId, candidates, model, attempted = [], now = Date.now() }) {
  const excluded = new Set([currentId, ...attempted]);
  return (candidates || []).filter(row => row && !excluded.has(row.id) && row.ready === true)
    .map(row => ({ ...row, reading: quotaReading(row, model, now) }))
    .filter(row => row.reading && !row.reading.exhausted)
    .sort((a, b) => b.reading.headroom - a.reading.headroom || a.id.localeCompare(b.id))[0] || null;
}

module.exports = { MAX_USAGE_AGE_MS, CONTINUE_AFTER_SWITCH, windowsForModel, quotaReading, isConfirmedQuotaWall, selectQuotaAccount };
