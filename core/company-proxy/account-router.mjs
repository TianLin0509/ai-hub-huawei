// Account routing for the company-model proxy.
//
// - Each Hub session (identified by the suffix of its local key) sticks to one account.
// - An account that answers 429 cools down (Retry-After, or 60 s) and the request is
//   retried at once on another account: a 429 means the upstream did not process it.
// - An account whose cached login cannot be read (expired, unreadable, decryption timed out) is set aside
//   for 5 minutes, or until its login file changes (a fresh login clears it at once), and the request moves
//   on; when no pool account is usable the personal account is used. When only such accounts are left the
//   request fails as "login needed" (COMPANY_LOGIN_NEEDED, 401), never as a rate limit.
// - A pool account whose permission list is authoritative (account.modelsAuthoritative, as Hub's account
//   page decides it) only serves models in that list: a GLM session never goes to a DeepSeek-only account.
//   A list that is not authoritative (never probed, empty, unreadable) is unknown and refuses nothing, as in
//   Hub; accounts that list the model explicitly are preferred over unknown ones. When no pool account may
//   serve the model the personal account answers and the event says why (reason 'model').
// - A session pinned to one account (the launch center's account choice; the key tag carries it, see
//   server.mjs parseTag) only ever uses that account: no spreading, no switching, no personal fallback.
//   A 429 still cools the account down (auto sessions then avoid it) but the pinned session gets the 429
//   back (COMPANY_PINNED_RATE_LIMITED) and every request during the cooldown fails at once the same way.
//   Missing, paused, login-unreadable or model-not-allowed pinned accounts fail with their own codes.
// - Only cached CodeAgent logins are read. Nothing here logs in, refreshes a token or
//   records request content; events carry account ids, codes and times only.

const RATE_LIMIT_FALLBACK_MS = 60_000;
const CREDENTIAL_COOLDOWN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const MAX_EVENTS = 40;
export const PERSONAL = 'personal';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function retryAfterMs(header, now = Date.now()) {
  if (typeof header === 'string' && /^\s*\d+\s*$/.test(header)) {
    const seconds = Number(header.trim());
    if (Number.isSafeInteger(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  } else if (typeof header === 'string' && header.trim()) {
    const at = Date.parse(header);
    if (Number.isFinite(at) && at > now) return Math.min(at - now, MAX_RETRY_AFTER_MS);
  }
  return RATE_LIMIT_FALLBACK_MS;
}

// Same model id, ignoring case and CodeAgent's "-Auto" tier suffix.
const baseModel = value => String(value || '').trim().toLowerCase().replace(/-auto$/, '');
const listsModel = (account, model) => Array.isArray(account.models) && account.models.some(m => baseModel(m) === baseModel(model));
// true when the account may serve the model; only an authoritative list refuses.
export function accountHasModel(account, model) {
  if (!model || account.kind === 'personal') return true;
  if (account.modelsAuthoritative !== true || !Array.isArray(account.models) || !account.models.length) return true;
  return listsModel(account, model);
}
// 0: listed explicitly, 1: unknown list (allowed). Used to prefer known accounts.
const modelFit = (account, model) => (!model || listsModel(account, model) ? 0 : 1);

/**
 * listAccounts(): [{ id, kind: 'pool' | 'personal', paused?: boolean, models?: string[] }] in preference order.
 * makeProvider(account, { onCredentialFailure, sessionTag, kind }) -> { complete(body, { signal }) }
 */
// Changes whenever the login file is rewritten (size + modification time); '' when unknown.
export function fileStamp(file, statSync) {
  if (typeof file !== 'string' || !file) return '';
  try { const s = statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; }
}

/**
 * credentialStamp(account) -> string identifying the current login file (default: stat of account.credentialFile
 * through options.statSync). A login cooldown ends as soon as it changes.
 */
export function createAccountRouter({ listAccounts, makeProvider, now = Date.now, onEvent = () => {}, statSync = null,
  credentialStamp = account => (statSync ? fileStamp(account?.credentialFile, statSync) : '') }) {
  if (typeof listAccounts !== 'function' || typeof makeProvider !== 'function') throw new Error('Account router needs listAccounts and makeProvider');
  const cooldowns = new Map(); // id -> { until, reason }
  const sticky = new Map(); // sessionTag -> id
  const lastUsed = new Map(); // sessionTag -> time
  const counters = new Map(); // id -> { requests, ok, rateLimited, credentialFailures }
  const events = [];
  const count = (id, key) => {
    const entry = counters.get(id) || { requests: 0, ok: 0, rateLimited: 0, credentialFailures: 0 };
    entry[key]++; counters.set(id, entry);
  };
  const emit = event => {
    const record = Object.freeze({ at: now(), ...event });
    events.push(record); if (events.length > MAX_EVENTS) events.shift();
    try { onEvent(record); } catch { /* observers never break routing */ }
  };
  const stampOf = account => { try { return String(credentialStamp(account) ?? ''); } catch { return ''; } };
  const cooling = (id, time = now(), account = null) => {
    const entry = cooldowns.get(id);
    if (!entry) return null;
    if (entry.until <= time) { cooldowns.delete(id); return null; }
    // A new login (the login file was rewritten) ends a login cooldown at once.
    if (entry.reason === 'credential' && account && entry.stamp && stampOf(account) !== entry.stamp) {
      cooldowns.delete(id); emit({ type: 'credential_renewed', account: id }); return null;
    }
    return entry;
  };
  const accounts = () => {
    let list = [];
    try { list = listAccounts(); } catch { list = []; }
    list = (Array.isArray(list) ? list : []).filter(a => object(a) && typeof a.id === 'string' && a.id);
    if (!list.some(a => a.id === PERSONAL)) list.push({ id: PERSONAL, kind: 'personal' });
    return list;
  };
  const usable = account => !account.paused && stampOf(account) !== 'missing' && !cooling(account.id, now(), account);
  const load = id => { let n = 0; for (const value of sticky.values()) if (value === id) n++; return n; };

  const pinError = (code, status, message, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });
  // Pinned session: the pinned account or an error, never another account.
  function pickPinned(sessionTag, pin, exclude, model) {
    const account = accounts().find(a => a.id === pin);
    if (!account) throw pinError('COMPANY_PINNED_MISSING', 503, 'Pinned account is not in the pool', { account: pin });
    if (account.paused) throw pinError('COMPANY_PINNED_PAUSED', 503, 'Pinned account is paused', { account: pin });
    if (!accountHasModel(account, model)) throw pinError('COMPANY_PINNED_NO_MODEL', 400, 'Pinned account may not use this model', { account: pin, model });
    const c = cooling(pin, now(), account);
    if (c?.reason === 'rate_limit') {
      throw pinError('COMPANY_PINNED_RATE_LIMITED', 429, 'Pinned account is rate limited', { account: pin,
        retryAfterSeconds: Math.max(1, Math.ceil((c.until - now()) / 1000)) });
    }
    if (c?.reason === 'credential') {
      throw pinError('COMPANY_LOGIN_NEEDED', 401, 'Company login needed', { account: pin, pinned: true,
        personal: pin === PERSONAL, poolAccounts: pin === PERSONAL ? 0 : 1 });
    }
    if (exclude.has(pin)) return null;
    // Still recorded per session: the account load (auto sessions spread around it) and the session card alias.
    if (sticky.get(sessionTag) !== pin) sticky.set(sessionTag, pin);
    lastUsed.set(sessionTag, now());
    return account;
  }

  function pick(sessionTag, exclude = new Set(), model = '', pin = '') {
    if (pin) return pickPinned(sessionTag, pin, exclude, model);
    const list = accounts();
    const current = sticky.get(sessionTag);
    const currentAccount = list.find(a => a.id === current);
    const allowed = a => accountHasModel(a, model);
    if (currentAccount && usable(currentAccount) && !exclude.has(current) && allowed(currentAccount)) return currentAccount;
    const pool = list.filter(a => a.kind !== 'personal' && usable(a) && !exclude.has(a.id) && allowed(a));
    // No pool account has this model at all (not merely cooling or failed): say so.
    const noModel = !!model && list.some(a => a.kind !== 'personal') && !list.some(a => a.kind !== 'personal' && allowed(a));
    let chosen = null;
    if (pool.length) {
      chosen = pool.map((a, index) => ({ a, index, load: load(a.id), fit: modelFit(a, model) }))
        .sort((x, y) => x.fit - y.fit || x.load - y.load || x.index - y.index)[0].a;
    } else {
      const personal = list.find(a => a.id === PERSONAL);
      if (personal && usable(personal) && !exclude.has(PERSONAL)) chosen = personal;
    }
    if (!chosen) return null;
    if (current !== chosen.id) {
      sticky.set(sessionTag, chosen.id);
      if (current) {
        const reason = chosen.id === PERSONAL && noModel ? 'model' : cooling(current)?.reason
          || (currentAccount?.paused ? 'paused' : exclude.has(current) ? 'failed' : currentAccount && !allowed(currentAccount) ? 'model' : 'removed');
        emit({ type: chosen.id === PERSONAL && list.some(a => a.kind !== 'personal') ? 'fallback_personal' : 'switch',
          session: sessionTag, from: current, to: chosen.id, reason, ...(model ? { model } : {}) });
      } else if (chosen.id === PERSONAL && list.some(a => a.kind !== 'personal')) {
        emit({ type: 'fallback_personal', session: sessionTag, from: null, to: PERSONAL, reason: noModel ? 'model' : 'pool_unavailable', ...(model ? { model } : {}) });
      }
    }
    lastUsed.set(sessionTag, now());
    return chosen;
  }

  async function complete(body, { signal, sessionTag = 'default', kind, pin = '' } = {}) {
    const tried = new Set();
    let lastRateLimited = null;
    const dropStashed = async () => { if (lastRateLimited) { const r = lastRateLimited; lastRateLimited = null; try { await r.body?.cancel(); } catch { /* cleanup only */ } } };
    for (;;) {
      if (signal?.aborted) { await dropStashed(); throw Object.assign(new Error('aborted'), { code: 'ROUTER_ABORTED', status: 499 }); }
      let account;
      try { account = pick(sessionTag, tried, typeof body?.model === 'string' ? body.model : '', pin); }
      catch (error) { await dropStashed(); throw error; }
      if (!account) {
        if (lastRateLimited) return lastRateLimited;
        const active = accounts().map(a => ({ a, c: cooling(a.id, now(), a) || (!a.paused && stampOf(a) === 'missing' ? { reason: 'credential' } : null) })).filter(x => x.c);
        const limited = active.filter(x => x.c.reason === 'rate_limit');
        if (limited.length) {
          const soonest = limited.reduce((m, x) => Math.min(m, x.c.until), Infinity);
          throw Object.assign(new Error('No company account is available'), { code: 'COMPANY_NO_ACCOUNT_AVAILABLE', status: 429,
            retryAfterSeconds: Math.max(1, Math.ceil((soonest - now()) / 1000)) });
        }
        const login = active.filter(x => x.c.reason === 'credential');
        if (login.length) {
          throw Object.assign(new Error('Company login needed'), { code: 'COMPANY_LOGIN_NEEDED', status: 401,
            personal: login.some(x => x.a.id === PERSONAL), poolAccounts: login.filter(x => x.a.id !== PERSONAL).length });
        }
        throw Object.assign(new Error('No company account is available'), { code: 'COMPANY_ACCOUNTS_PAUSED', status: 503 });
      }
      tried.add(account.id);
      count(account.id, 'requests');
      let credentialFailed = false;
      const provider = makeProvider(account, { sessionTag, kind, onCredentialFailure: () => { credentialFailed = true; } });
      let response;
      try {
        response = await provider.complete(body, { signal });
      } catch (error) {
        if (credentialFailed && !signal?.aborted) {
          count(account.id, 'credentialFailures');
          cooldowns.set(account.id, { until: now() + CREDENTIAL_COOLDOWN_MS, reason: 'credential', stamp: stampOf(account) });
          emit({ type: 'credential_failed', session: sessionTag, account: account.id });
          continue;
        }
        await dropStashed();
        throw error;
      }
      if (response?.status === 429) {
        count(account.id, 'rateLimited');
        const wait = retryAfterMs(response.headers?.get?.('retry-after'), now());
        cooldowns.set(account.id, { until: now() + wait, reason: 'rate_limit' });
        emit({ type: 'rate_limited', session: sessionTag, account: account.id, until: now() + wait, ...(pin ? { pinned: true } : {}) });
        if (lastRateLimited) { try { await lastRateLimited.body?.cancel(); } catch { /* cleanup only */ } }
        lastRateLimited = response;
        continue;
      }
      if (lastRateLimited) { try { await lastRateLimited.body?.cancel(); } catch { /* cleanup only */ } }
      if (response?.ok) count(account.id, 'ok');
      return response;
    }
  }

  function forget(maxIdleMs = 6 * 60 * 60_000) {
    const limit = now() - maxIdleMs;
    for (const [tag, at] of lastUsed) if (at < limit) { lastUsed.delete(tag); sticky.delete(tag); }
  }

  function snapshot() {
    const time = now();
    return {
      accounts: accounts().map(a => {
        const c = cooling(a.id, time);
        return { id: a.id, kind: a.kind || 'pool', paused: !!a.paused, sessions: load(a.id),
          ...(Array.isArray(a.models) ? { models: a.models.slice(), modelsAuthoritative: a.modelsAuthoritative === true } : {}),
          coolingUntil: c ? c.until : null, coolingReason: c ? c.reason : null, ...(counters.get(a.id) || {}) };
      }),
      sessions: sticky.size,
      // session tag -> account id, newest 200 (the launch center and session cards show the account per session)
      assignments: Object.fromEntries([...sticky].slice(-200)),
      events: events.slice(),
    };
  }

  return Object.freeze({ complete, pick, snapshot, forget, accountFor: tag => sticky.get(tag) || null });
}
