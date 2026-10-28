'use strict';

// Reference: realiti4/claude-swap (MIT), reviewed at 042a36b. Each original
// account directory remains the canonical refresh-token owner. Running Hub
// sessions receive access-only projections, never a second refresh owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_LEAD_MS = 120_000;
const PREFRESH_MIN_MS = 30 * 60_000;
const PREFRESH_SPAN_MS = 30 * 60_000;
const PREFRESH_GAP_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function readJson(file, optional = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw fail('CLAUDE_AUTH_READ', 'Claude 登录或配置文件无法读取'); }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const previous = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    // Claude invalidates its token cache by mtime, including fast back-to-back swaps.
    if (fs.statSync(file).mtimeMs <= previous) {
      const next = new Date(previous + 1); fs.utimesSync(file, next, next);
    }
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function fingerprint(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function accessOnly(credentials) {
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken || oauth.refreshToken === '') throw fail('CLAUDE_RELOGIN_REQUIRED', '此 Claude 账号需要重新登录');
  const { refreshToken, ...access } = oauth;
  return { ...credentials, claudeAiOauth: access };
}
function globalConfigPath(home) {
  const legacy = path.join(home, '.config.json');
  if (fs.existsSync(legacy) && fs.statSync(legacy).size > 0) return legacy;
  return path.basename(home).toLowerCase() === '.claude'
    ? path.join(path.dirname(home), '.claude.json') : path.join(home, '.claude.json');
}

// Claude 2.1.310's two proper-lockfile directory names. Never steal a lock;
// timeout is recoverable and cannot revoke the other process's credential.
async function withDirectoryLocks(names, work, { timeoutMs = 9000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (true) {
    const acquired = [];
    let heartbeat;
    let compromised = false;
    try {
      for (const name of names) { fs.mkdirSync(name); acquired.push({ name, ino: fs.statSync(name).ino }); }
      heartbeat = setInterval(() => {
        for (const lock of acquired) {
          try {
            if (fs.statSync(lock.name).ino !== lock.ino) { compromised = true; continue; }
            const time = new Date(); fs.utimesSync(lock.name, time, time);
          } catch { compromised = true; }
        }
      }, 3000);
      heartbeat.unref?.();
      return await work(() => {
        if (compromised || acquired.some(lock => !fs.existsSync(lock.name) || fs.statSync(lock.name).ino !== lock.ino)) {
          throw fail('CLAUDE_AUTH_LOCK_LOST', 'Claude 登录刷新锁已变化，未覆盖凭据');
        }
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= until) throw fail('CLAUDE_AUTH_BUSY', 'Claude 正在刷新登录，稍后再试');
    } finally {
      clearInterval(heartbeat);
      for (const lock of acquired.reverse()) {
        try { if (fs.statSync(lock.name).ino === lock.ino) fs.rmdirSync(lock.name); }
        catch (error) { if (error.code !== 'ENOENT') throw fail('CLAUDE_AUTH_UNLOCK', 'Claude 登录锁释放失败'); }
      }
    }
    await delay(100);
  }
}

function withCredentialLocks(home, work, options) {
  return withDirectoryLocks([path.join(home, '.oauth_refresh.lock'), fs.realpathSync(home) + '.lock'], work, options);
}

function createClaudeCredentialBroker({ request, stateDir, now = Date.now, onUsage = () => {} }) {
  const pending = new Map();
  const usageBlockedUntil = new Map();
  async function call(profile, url, options) {
    if (typeof request !== 'function') throw fail('CLAUDE_AUTH_OFFLINE', 'Claude 账号服务尚未就绪');
    try { return await request(url, options, profile); }
    catch (error) { throw Object.assign(fail('CLAUDE_AUTH_NETWORK', 'Claude 账号服务连接失败，本次未换号'), { notSent: error?.notSent === true }); }
  }
  const markerFor = profile => path.join(stateDir, fingerprint(profile.home) + '.refresh.json');
  // One line per token request, so a future 429 can be explained by counting
  // what Hub actually sent instead of guessing.
  function logRefresh(profile, reason, outcome) {
    try {
      const file = stateDir + '-log.jsonl'; // sibling: the state dir holds only per-account markers
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({ at: new Date(now()).toISOString(), profile: profile.id, reason, ...outcome }) + '\n');
    } catch {}
  }
  async function fresh(profile, leadMs = REFRESH_LEAD_MS, reason = 'on-demand') {
    const file = path.join(profile.home, '.credentials.json');
    let credentials = readJson(file);
    accessOnly(credentials);
    if (Number(credentials.claudeAiOauth.expiresAt) > now() + leadMs) return credentials;
    return withCredentialLocks(profile.home, async assertLock => {
      credentials = readJson(file); // Another Claude may have refreshed while we waited.
      const oauth = credentials.claudeAiOauth;
      accessOnly(credentials);
      if (Number(oauth.expiresAt) > now() + leadMs) return credentials;
      if (!oauth.refreshToken) throw fail('CLAUDE_RELOGIN_REQUIRED', 'Claude 登录已过期，请重新登录该账号');
      const marker = markerFor(profile);
      const previous = readJson(marker, true);
      const tokenHash = fingerprint(oauth.refreshToken);
      if (Number(previous?.retryAfterAt) > now()) {
        // Backing off must not block work while the current access token still works.
        if (Number(oauth.expiresAt) > now()) return credentials;
        throw fail('CLAUDE_AUTH_RATE_LIMIT', 'Claude 登录刷新正在退避，稍后再试');
      }
      if (previous?.tokenHash === tokenHash) throw fail('CLAUDE_REFRESH_UNCONFIRMED', '上次登录刷新结果未确认，请先重新登录该账号');
      const failures = Number(previous?.failures) || 0;
      // Persist uncertainty BEFORE issuing a rotating grant. A timeout/crash
      // must not repeatedly consume the same possibly superseded grant.
      atomicJson(marker, { tokenHash, startedAt: now(), failures });
      let response;
      try {
        response = await call(profile, 'https://platform.claude.com/v1/oauth/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID }),
        });
      } catch (error) {
        logRefresh(profile, reason, { status: error.notSent ? 'not-sent' : 'network' });
        // The grant provably never left this machine (proxy/DNS/offline), so it
        // is still unused: wait a fixed minute instead of demanding a fresh login.
        // Not exponential, so a recovered network is usable again right away.
        if (error.notSent) atomicJson(marker, { retryAfterAt: now() + 60_000, failures });
        throw error;
      }
      logRefresh(profile, reason, { status: response.status, ...(response.retryAfterMs ? { retryAfterMs: response.retryAfterMs } : {}) });
      if (response.status !== 200) {
        if (response.status === 429) {
          // Exponential: a fixed 60 s retry keeps knocking during a long limit window.
          const wait = Math.max(Math.min(60_000 * 2 ** failures, MAX_BACKOFF_MS), Number(response.retryAfterMs) || 0);
          atomicJson(marker, { retryAfterAt: now() + wait, failures: failures + 1 });
          throw fail('CLAUDE_AUTH_RATE_LIMIT', 'Claude 登录刷新暂时限流，稍后再试');
        }
        throw fail('CLAUDE_RELOGIN_REQUIRED', 'Claude 登录刷新未成功，请核对该账号登录');
      }
      const data = response.data;
      if (!data?.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw fail('CLAUDE_REFRESH_UNCONFIRMED', 'Claude 登录刷新返回不完整，未继续切换');
      }
      assertLock();
      const current = readJson(file);
      if (current.claudeAiOauth?.refreshToken !== oauth.refreshToken) {
        throw fail('CLAUDE_AUTH_CHANGED', '账号登录已在其他位置改变，未覆盖');
      }
      const next = { ...current, claudeAiOauth: { ...oauth, accessToken: data.access_token,
        refreshToken: data.refresh_token || oauth.refreshToken, expiresAt: now() + data.expires_in * 1000,
        ...(typeof data.scope === 'string' ? { scopes: data.scope.split(' ') } : {}) } };
      atomicJson(file, next);
      fs.unlinkSync(marker);
      return next;
    });
  }
  function getCredentials(profile, leadMs, reason) {
    const key = path.resolve(profile.home).toLowerCase();
    if (!pending.has(key)) {
      const task = fresh(profile, leadMs, reason).finally(() => { if (pending.get(key) === task) pending.delete(key); });
      pending.set(key, task);
    }
    return pending.get(key);
  }
  // Each account gets its own fixed lead inside [30, 60) min, so accounts that
  // logged in together drift apart instead of refreshing in the same minute.
  const prefreshLead = profile => PREFRESH_MIN_MS + parseInt(fingerprint(path.resolve(profile.home).toLowerCase()).slice(0, 8), 16) % PREFRESH_SPAN_MS;
  let lastPrefreshAt = -Infinity;
  // Background renewal: at most one token request per PREFRESH_GAP_MS across
  // all accounts. Failures are only logged; the still-valid token keeps working.
  async function prefresh(profiles) {
    if (now() - lastPrefreshAt < PREFRESH_GAP_MS) return null;
    for (const profile of profiles) {
      let oauth;
      try { oauth = readJson(path.join(profile.home, '.credentials.json'), true)?.claudeAiOauth; } catch { continue; }
      if (!oauth?.refreshToken) continue;
      const lead = prefreshLead(profile);
      if (Number(oauth.expiresAt) > now() + lead) continue;
      const marker = readJson(markerFor(profile), true);
      // An unconfirmed marker only blocks the grant it was written for; a new login clears it.
      if (Number(marker?.retryAfterAt) > now() || marker?.tokenHash === fingerprint(oauth.refreshToken)) continue;
      lastPrefreshAt = now();
      try { await getCredentials(profile, lead, 'background'); return { id: profile.id, ok: true }; }
      catch (error) { return { id: profile.id, ok: false, code: error.code }; }
    }
    return null;
  }
  return {
    getCredentials,
    prefresh,
    prefreshLead,
    async usage(profile) {
      if ((usageBlockedUntil.get(profile.id) || 0) > now()) throw fail('CLAUDE_USAGE_RATE_LIMIT', 'Claude 额度查询正在退避，稍后再试');
      const credentials = await getCredentials(profile);
      const response = await call(profile, 'https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      });
      if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
        if (response.status === 429) usageBlockedUntil.set(profile.id, now() + Math.max(60_000, Number(response.retryAfterMs) || 0));
        throw fail(response.status === 429 ? 'CLAUDE_USAGE_RATE_LIMIT' : 'CLAUDE_USAGE_UNAVAILABLE', '暂时无法确认 Claude 账号额度，本次未换号');
      }
      const snapshot = { id: profile.id, ready: true, usage: response.data, observedAt: now() };
      onUsage(profile, snapshot);
      return snapshot;
    },
  };
}

module.exports = { accessOnly, atomicJson, readJson, globalConfigPath, withDirectoryLocks, withCredentialLocks, createClaudeCredentialBroker, fail };
