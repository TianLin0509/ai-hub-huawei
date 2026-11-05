'use strict';

const { CODEAGENT_SERVE_MAX_AGE_MS } = require('./codeagent-usage-menu');
const { QUOTA_AUTO_INTERVAL_MS } = require('./codeagent-quota-auto-refresh');

const MAX_BACKOFF_MS = 6 * 3600 * 1000;

// The side panel reads existing account/usage stores. Refreshing this view must
// not fall back to opening a model menu or change any account pause decision.
function readAt(value) {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

function accountRows(status) {
  if (!status || status.ok === false) throw new Error(status?.error || '读取账号列表失败');
  const rows = [{ ...(status.personal || {}), id: 'personal', personal: true },
    ...(status.accounts || []).map(account => ({ ...account, personal: false }))];
  return rows.map(account => ({
    id: account.id, personal: account.personal,
    label: account.personal ? '个人账号' : account.note || account.accountLabel || account.id,
    present: account.personal ? account.present !== false : true,
    note: account.note || '', accountLabel: account.accountLabel || '', state: account.state || 'login-required',
    activeSessions: Number.isFinite(account.activeSessions) ? account.activeSessions : 0,
    sameAsPersonal: !!account.sameAsPersonal, duplicateOf: account.duplicateOf || null,
    avoid: account.avoid || null, paused: !!account.avoid, creditReading: account.credit || null,
  }));
}

// 同一账号只算一个：和个人账号相同、或和别的号重复的不单独显示，也不单独读。
const isDistinct = row => !row.sameAsPersonal && !row.duplicateOf;
const isReadable = row => isDistinct(row) && row.state === 'ready';

function createCodeAgentQuotaPanel({ getStatus, readUsage, serveEnabled, refreshAccount, getDefaultModels = () => ({}),
  now = Date.now, describeError = error => error?.message || String(error) }) {
  const pending = new Map();
  const lastRefresh = new Map();
  const autoFailures = new Map(); // 号 → { count, retryAt }：自动读取连续失败时拉长间隔，手动刷新不受影响

  function nextRefreshAt(key, entry) {
    const attempt = lastRefresh.get(key)?.attemptedAt || 0;
    const cachedAt = ['serve', 'probe'].includes(entry?.source) ? readAt(entry.at) || 0 : 0;
    const last = Math.max(attempt, cachedAt);
    return last ? last + CODEAGENT_SERVE_MAX_AGE_MS : 0;
  }

  function refresh(key, entry) {
    if (pending.has(key)) return pending.get(key);
    if (now() < nextRefreshAt(key, entry)) {
      const previous = lastRefresh.get(key);
      return Promise.resolve({ status: 'cooldown', attemptedAt: previous?.attemptedAt || null,
        error: previous?.status === 'failed' ? previous.error : null });
    }
    const attemptedAt = now();
    const task = Promise.resolve().then(async () => {
      try {
        await refreshAccount(key);
        const result = { status: 'updated', attemptedAt, error: null };
        lastRefresh.set(key, result);
        return result;
      } catch (error) {
        const result = { status: 'failed', attemptedAt, error: describeError(error) };
        lastRefresh.set(key, result);
        return result;
      } finally { pending.delete(key); }
    });
    pending.set(key, task);
    return task;
  }

  async function snapshot(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('额度请求无效');
    let rows = accountRows(getStatus());
    const on = !!serveEnabled();
    const requested = payload.refresh === true;
    if (Object.hasOwn(payload, 'key') && (typeof payload.key !== 'string' || !rows.some(row => row.id === payload.key))) {
      throw new Error('找不到这个 CodeAgent 账号');
    }
    const keys = requested ? rows.filter(row => payload.key ? row.id === payload.key : isDistinct(row)).map(row => row.id) : [];
    const results = new Map();
    if (requested && on) {
      const before = readUsage() || {};
      await Promise.all(keys.map(async key => results.set(key, await refresh(key, before[key]))));
      rows = accountRows(getStatus());
    }
    const cached = readUsage() || {};
    const usage = {}, creditReadings = {};
    let defaults = {};
    try { defaults = getDefaultModels(rows.map(row => row.id)) || {}; } catch { /* 读不到默认模型时取第一个有读数的模型 */ }
    for (const row of rows) {
      const entry = cached[row.id] || null;
      const creditAt = readAt(entry?.creditAt ?? entry?.at);
      row.usage = entry;
      row.defaultModel = defaults[row.id] || '';
      row.credit = entry?.credit || null;
      row.usageAt = readAt(entry?.at);
      row.creditAt = entry?.credit ? creditAt : null;
      row.creditReadingAt = readAt(row.creditReading?.observedAt ?? row.creditReading?.at);
      row.nextRefreshAt = nextRefreshAt(row.id, entry);
      const previous = lastRefresh.get(row.id);
      row.refresh = results.get(row.id) || (requested && keys.includes(row.id) && !on
        ? { status: 'disabled', attemptedAt: null, error: null }
        : pending.has(row.id) ? { status: 'in-flight', attemptedAt: null, error: null }
          : previous?.status === 'failed' ? previous : { status: 'idle', attemptedAt: null, error: null });
      row.cached = row.refresh.status !== 'updated';
      row.hasReading = !!(row.credit || row.creditReading || entry?.models?.length);
      if (entry) usage[row.id] = entry;
      if (row.creditReading) creditReadings[row.id] = row.creditReading;
    }
    return { ok: true, checkedAt: now(), serveEnabled: on, rows, usage, creditReadings };
  }
  // 自动读取：只读可读的号，一个读完再读下一个；只有一个号时不显示额度栏，也就不读。
  async function refreshDue() {
    if (!serveEnabled()) return { skipped: 'disabled' };
    const rows = accountRows(getStatus()), distinct = rows.filter(row => isDistinct(row) && row.present);
    if (distinct.length < 2) return { skipped: 'single-account' };
    const out = { read: 0, failed: 0, waiting: 0 };
    for (const row of rows.filter(isReadable)) {
      const failure = autoFailures.get(row.id);
      if (failure && now() < failure.retryAt) { out.waiting += 1; continue; }
      const result = await refresh(row.id, (readUsage() || {})[row.id]);
      if (result.status === 'failed') {
        const count = (failure?.count || 0) + 1;
        autoFailures.set(row.id, { count, retryAt: now() + Math.min(MAX_BACKOFF_MS, QUOTA_AUTO_INTERVAL_MS * 2 ** count) });
        out.failed += 1;
      } else if (result.status === 'updated') { autoFailures.delete(row.id); out.read += 1; }
      else out.waiting += 1;
    }
    return out;
  }
  return { snapshot, refreshDue };
}

module.exports = { createCodeAgentQuotaPanel, accountRows, readAt };
