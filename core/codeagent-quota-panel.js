'use strict';

const { CODEAGENT_SERVE_MAX_AGE_MS } = require('./codeagent-usage-menu');

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
    note: account.note || '', accountLabel: account.accountLabel || '', state: account.state || 'login-required',
    activeSessions: Number.isFinite(account.activeSessions) ? account.activeSessions : 0,
    sameAsPersonal: !!account.sameAsPersonal, duplicateOf: account.duplicateOf || null,
    avoid: account.avoid || null, paused: !!account.avoid, creditReading: account.credit || null,
  }));
}

function createCodeAgentQuotaPanel({ getStatus, readUsage, serveEnabled, refreshAccount,
  now = Date.now, describeError = error => error?.message || String(error) }) {
  const pending = new Map();
  const lastRefresh = new Map();

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
    const keys = requested ? rows.filter(row => !payload.key || row.id === payload.key).map(row => row.id) : [];
    const results = new Map();
    if (requested && on) {
      const before = readUsage() || {};
      await Promise.all(keys.map(async key => results.set(key, await refresh(key, before[key]))));
      rows = accountRows(getStatus());
    }
    const cached = readUsage() || {};
    const usage = {}, creditReadings = {};
    for (const row of rows) {
      const entry = cached[row.id] || null;
      const creditAt = readAt(entry?.creditAt ?? entry?.at);
      row.usage = entry;
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
      row.hasReading = !!(row.credit || row.creditReading);
      if (entry) usage[row.id] = entry;
      if (row.creditReading) creditReadings[row.id] = row.creditReading;
    }
    return { ok: true, checkedAt: now(), serveEnabled: on, rows, usage, creditReadings };
  }
  return { snapshot };
}

module.exports = { createCodeAgentQuotaPanel, accountRows, readAt };
