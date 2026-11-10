// Company-model proxy process (started and stopped by Hub; loopback only, no window).
//   node server.mjs --data-dir <Hub data> [--port 18765] [--parent-pid N] [--mock-upstream]
// The local key arrives in AI_HUB_COMPANY_PROXY_KEY. Each Hub session authenticates
// with "<key>.<session tag>"; the tag keeps that session on one company account. A tag ending in
// "__pin_<account id | personal>" pins the session to that account (launch center account choice).
// Endpoints:
//   POST /v1/messages (+ /v1/messages/count_tokens)  Claude Code
//   POST /v1/responses                               Codex
//   POST /v1/chat/completions                        DSH
//   GET  /health (public, minimal), GET /admin/status, POST /admin/shutdown (key required)
// Logs carry client kind, model id, status, timing, account id and fixed error codes only.
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { createProxy, OWN_RESPONSE_HEADER } from './transport.mjs';
import { createCompanyPersonalProvider } from './signed-provider.mjs';
import { readPersonalAccessToken } from './personal-token.mjs';
import { readPoolAccessToken } from './pool-token.mjs';
import { createAccountRouter, PERSONAL } from './account-router.mjs';
import { resolveUpstreamProfile, loadSigner, ProfileError, zoneFromLetter } from './upstream-profile.mjs';
import { MODELS, MODEL_GLM, KIND, createClaudeAdapter, createCodexAdapter, createDshAdapter, collectAnthropicMessage } from './adapters.mjs';

export const VERSION = 'company-model-proxy 1.0';
const SAFE_CODE = /^[A-Za-z0-9_ .:\-]{1,120}$/;
const TAG = /^[A-Za-z0-9_-]{1,64}$/;
const PIN_SUFFIX = /^(.+?)__pin_([a-z0-9]{6,16}|personal)$/;

// "<session tag>[__pin_<id>]" -> { sessionTag, pin } (pin '' = automatic), or null when malformed.
// Sticky assignments and the session card alias stay keyed by the plain session tag.
export function parseTag(raw) {
  const value = String(raw ?? '');
  const match = PIN_SUFFIX.exec(value);
  const sessionTag = match ? match[1] : value;
  if (!TAG.test(sessionTag)) return null;
  return { sessionTag, pin: match ? match[2] : '' };
}

// Account alias for plain-words errors (个人 / 号 N, the numbering of Hub's account page), never the id.
export function accountAlias(dataDir, id) {
  if (id === PERSONAL) return '个人账号';
  const n = readJsonSync(join(dataDir, 'codeagent-pool', 'quota-aliases.json'))?.map?.[id];
  return Number.isInteger(n) ? `号 ${n}` : '所选的号';
}

// Plain words for a pinned session whose account cannot answer now (the session never switches accounts).
export function pinnedMessage(error, alias) {
  const fresh = '要自动换号请新建会话、账号选「自动挑号」';
  switch (error?.code) {
    case 'COMPANY_PINNED_RATE_LIMITED':
      return `${alias}被限流，本会话固定用它，约 ${Number(error.retryAfterSeconds) || 60} 秒后恢复；${fresh}`;
    case 'COMPANY_PINNED_PAUSED':
      return `${alias}已暂停（账号页里手动暂停或额度用完），本会话固定用它；请到 Hub 账号页恢复这个号，或${fresh}`;
    case 'COMPANY_PINNED_MISSING':
      return `本会话固定用的${alias}已不在号池里；请新建会话重新选择账号`;
    case 'COMPANY_PINNED_NO_MODEL':
      return `${alias}没有 ${String(error.model || '这个模型').slice(0, 60)} 的权限，本会话固定用它；请新建会话换一个有权限的号，或选「自动挑号」`;
    default: return '';
  }
}
const stamp = () => new Date().toISOString();

function parseArgs(argv) {
  const o = { port: 18765, dataDir: '', parentPid: 0, mock: false, maxConcurrent: 4, timeoutMs: 15 * 60 * 1000, maxTokensCap: 32768 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--port') { o.port = Number(v); i++; }
    else if (k === '--data-dir') { o.dataDir = resolve(v); i++; }
    else if (k === '--parent-pid') { o.parentPid = Number(v); i++; }
    else if (k === '--max-concurrent') { o.maxConcurrent = Number(v); i++; }
    else if (k === '--mock-upstream') o.mock = true;
    else throw new Error('Unknown argument: ' + k);
  }
  if (!o.dataDir) throw new Error('--data-dir is required');
  if (!Number.isSafeInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  if (!Number.isSafeInteger(o.maxConcurrent) || o.maxConcurrent < 1 || o.maxConcurrent > 16) throw new Error('--max-concurrent must be 1..16');
  return o;
}

// Company HTTPS endpoints use company roots that live only in the Windows certificate store.
// Hub starts this process with --use-system-ca; when the runtime ignored or lacks the flag the
// system roots are merged into the default store here. Returns what is in effect (for status/tests).
export function ensureSystemCa(api = tls) {
  try {
    if (typeof api.getCACertificates !== 'function') return { mode: 'unavailable', system: 0 };
    const system = api.getCACertificates('system');
    const current = api.getCACertificates('default');
    const have = new Set(current);
    const absent = system.filter(cert => !have.has(cert));
    if (!absent.length) return { mode: system.length ? 'flag' : 'none', system: system.length, total: current.length };
    if (typeof api.setDefaultCACertificates !== 'function') return { mode: 'unavailable', system: system.length };
    api.setDefaultCACertificates([...current, ...absent]);
    return { mode: 'runtime', system: system.length, total: current.length + absent.length };
  } catch { return { mode: 'unavailable', system: 0 }; }
}

function readJsonSync(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// Each pool account's model permission list, read the same way Hub's account page reads it
// (core/codeagent-pool.js accountModels). Packaged builds run this file from app.asar.unpacked;
// the Hub module itself stays inside app.asar, which Electron's Node can read.
let poolModule;
function accountModelsReader() {
  if (poolModule === undefined) {
    poolModule = null;
    const here = fileURLToPath(import.meta.url);
    for (const file of [here, here.replace(/app\.asar\.unpacked([\\/])/, 'app.asar$1')]) {
      try { poolModule = createRequire(file)('../codeagent-pool.js'); break; } catch { /* try the next location */ }
    }
  }
  return poolModule && typeof poolModule.accountModels === 'function' ? poolModule : null;
}
// -> { models, modelsAuthoritative } like Hub's account page, or undefined when unknown. Hub only refuses a model
// outside an authoritative list; a list never probed, empty, or unreadable is "unknown" and allows any model.
function modelsOf(dataDir, id) {
  const pool = accountModelsReader();
  if (!pool) return undefined; // unknown: the router then does not filter by model
  try {
    const info = pool.accountModels(pool.accountDir(dataDir, id)) || {};
    const models = Array.isArray(info.models) ? info.models.filter(m => typeof m === 'string' && m) : [];
    return { models, modelsAuthoritative: info.authoritative === true && models.length > 0 };
  } catch { return undefined; }
}

// Pool registry, manual/automatic pauses kept by Hub's account page and each account's models.
export function poolAccounts(dataDir, now = Date.now(), personalCredential = '') {
  const root = join(dataDir, 'codeagent-pool');
  const registry = readJsonSync(join(root, 'pool.json'));
  const avoid = readJsonSync(join(root, 'quota-avoid.json'))?.accounts || {};
  const paused = id => {
    const entry = avoid[id];
    return !!entry && (entry.until == null ? entry.source === 'manual' : Number(entry.until) > now);
  };
  const list = (Array.isArray(registry?.accounts) ? registry.accounts : [])
    .filter(a => a && typeof a.id === 'string' && /^[a-z0-9]{6,16}$/.test(a.id))
    .map(a => {
      const models = modelsOf(dataDir, a.id);
      return { id: a.id, kind: 'pool', paused: paused(a.id), credentialFile: join(root, 'accounts', a.id, '.credentials.json'), ...(models || {}) };
    });
  list.push({ id: PERSONAL, kind: 'personal', paused: paused(PERSONAL), ...(personalCredential ? { credentialFile: personalCredential } : {}) });
  return list;
}

// One identity POST with the personal login, only to read data.region (one letter). Nothing else of the answer
// is kept; no signature, no generation. -> 'y' | 'g' | 'b' | ''.
export async function identityRegion({ identityUrl, credential }, { readToken, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (typeof identityUrl !== 'string' || !identityUrl.startsWith('https://') || !credential) return '';
  const token = await readToken({ credentialPath: credential, expiryUnit: 'milliseconds', minValidityMs: 60_000, timeoutMs: 10_000 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(identityUrl, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token, Accept: 'application/json' }, body: '{}' });
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return ''; }
    const text = await response.text();
    if (text.length > 256 * 1024) return '';
    const region = JSON.parse(text)?.data?.region;
    return typeof region === 'string' && /^[ygb]$/i.test(region) ? region.toLowerCase() : '';
  } finally { clearTimeout(timer); }
}

// Plain words for "no usable login": which login and what to do. Logging in again clears it without a restart.
export function loginNeededMessage({ personal = false, poolAccounts = 0 } = {}) {
  const what = [personal ? '你自己的 CodeAgent 登录' : '', poolAccounts ? `号池里 ${poolAccounts} 个号的登录` : ''].filter(Boolean).join('和') || '公司账号的登录';
  const how = [personal ? '到 Hub「账号」页点击个人账号的「登录」' : '', poolAccounts ? '到 Hub 账号页把这些号重新登录' : ''].filter(Boolean).join('；') || '到 Hub「账号」页点击个人账号的「登录」';
  return `公司模型需要重新登录：${what}过期了或读不出来（不是限流）。请${how}，登录后会自动恢复，不用重启 Hub。`;
}

// Same response, but onEnd runs once when its body is fully read, fails, or is cancelled.
export function releaseOnEnd(response, onEnd) {
  const reader = response.body.getReader();
  let ended = false;
  const end = () => { if (!ended) { ended = true; try { onEnd(); } catch { /* bookkeeping only */ } } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { controller.close(); end(); } else controller.enqueue(value);
      } catch (error) { end(); controller.error(error); }
    },
    cancel(reason) { end(); return reader.cancel(reason).catch(() => {}); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const uuidFrom = value => {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const opts = parseArgs(argv);
  const key = env.AI_HUB_COMPANY_PROXY_KEY || '';
  if (!/^[A-Za-z0-9]{32,128}$/.test(key)) throw new Error('AI_HUB_COMPANY_PROXY_KEY is missing or invalid');
  const workDir = join(opts.dataDir, 'company-model-proxy');
  await mkdir(workDir, { recursive: true });
  const log = line => { try { process.stdout.write(`${stamp()} ${line}\n`); } catch { /* log only */ } };
  const diag = event => log(`provider diagnostic ${SAFE_CODE.test(event?.code || '') ? event.code : 'UNKNOWN'}`);
  log(`${VERSION} starting (${opts.mock ? 'MOCK upstream' : 'company upstream'}) pid ${process.pid}`);
  const systemCa = ensureSystemCa();
  log(`system certificates: ${systemCa.mode} (${systemCa.system} roots from the Windows store)`);
  if (!accountModelsReader()) log('pool model lists unavailable: pool accounts are not filtered by model');

  // ---------- upstream ----------
  // The real upstream is prepared after the port is open: a first-time signer initialization can take
  // longer than Hub waits for the port (it runs the CodeAgent CLI once). Until then requests get 503 with
  // the plain-words state, and /admin/status reports code INITIALIZING.
  const startup = { ready: false, code: 'INITIALIZING', message: '公司模型反代正在准备公司上游…', missing: [], zone: null, firstInit: null };
  let upstream = null; // { signer, profile, tokenFor(account), testOrigin }
  let mock = null;
  const prepareUpstream = async () => { try {
    if (opts.mock) {
      const { startMockUpstream, createMockSigner, MOCK_IDENTITY_PATH, MOCK_IDENTITY_FIELDS } = await import('./mock-upstream.mjs');
      mock = await startMockUpstream({ controlFile: join(workDir, 'mock-control.json') });
      const signer = createMockSigner();
      upstream = { signer, testOrigin: mock.origin,
        profile: { appId: 'mock-client', codeagentVersion: signer.codeagentVersion(), personalCredential: 'C:\\mock\\.credentials.json',
          identityAccountField: MOCK_IDENTITY_FIELDS.account, identityDeptField: MOCK_IDENTITY_FIELDS.dept, testOnlyIdentityPath: MOCK_IDENTITY_PATH },
        token: async account => {
          const control = readJsonSync(join(workDir, 'mock-control.json')) || {};
          if ((control.brokenCredentials || []).includes(account.id)) throw Object.assign(new Error('mock credential'), { code: 'MOCK_CREDENTIAL' });
          return 'mock-token-' + account.id;
        } };
    } else {
      let profile;
      try { profile = await resolveUpstreamProfile({ dataDir: opts.dataDir, env }); }
      catch (error) {
        // Zone still unknown: ask the company identity service (the same answer CodeAgent takes its region from).
        if (!(error instanceof ProfileError) || error.code !== 'ZONE_UNKNOWN' || !error.identityProbe) throw error;
        const letter = await identityRegion(error.identityProbe, { readToken: readPersonalAccessToken }).catch(() => '');
        const zone = zoneFromLetter(letter);
        log(`zone from the identity answer: ${zone ? 'region letter found' : 'not available'}`);
        if (!zone) throw error;
        profile = await resolveUpstreamProfile({ dataDir: opts.dataDir, env, zoneOverride: { zone } });
      }
      startup.zone = profile.zoneInfo || null;
      if (profile.signerInit?.needed) {
        startup.message = `公司模型反代正在做首次签名初始化（${profile.signerInit.text}；后台跑一次 CodeAgent 命令行，不弹窗，约 10–20 秒）…`;
        log(`signer first-time initialization: ${profile.signerInit.reason} (tried ${profile.signerInit.tried.map(t => t.source + ':' + t.state).join(',')})`);
      }
      const { signer, adapterSha256, firstInit } = await loadSigner(profile, { workDir });
      startup.firstInit = firstInit;
      log(`signer ready (CodeAgent ${profile.codeagentVersion}; adapter ${adapterSha256.slice(0, 12)}; first-init ${firstInit.ran ? `ran ${firstInit.ms} ms, cli runs ${firstInit.cliRuns}` : 'not needed'}; sources ${JSON.stringify(profile.sources)})`);
      upstream = { signer, profile, token: null };
    }
    startup.ready = true; startup.code = null; startup.message = null;
  } catch (error) {
    startup.code = error instanceof ProfileError ? error.code : 'STARTUP_FAILED';
    startup.message = error instanceof ProfileError ? error.message : '公司模型反代启动失败：' + String(error?.code || error?.message || 'unknown').slice(0, 120);
    startup.missing = error?.missing || [];
    if (error?.diagnostics) startup.diagnostics = error.diagnostics; // categories and file names only
    if (error?.zone) startup.zone = error.zone;
    if (error?.firstInit) startup.firstInit = error.firstInit;
    log(`upstream not ready: ${startup.code}${startup.missing.length ? ' missing=' + startup.missing.join(',') : ''}${error?.diagnostics ? ' diagnostics=' + JSON.stringify(error.diagnostics) : ''}${error?.firstInit ? ' first-init=' + JSON.stringify(error.firstInit) : ''}`);
  } };
  const upstreamReady = prepareUpstream();
  if (opts.mock) await upstreamReady; // the mock is instant; tests see ready as soon as the port is open

  const makeProvider = (account, { sessionTag, kind, onCredentialFailure }) => {
    const p = upstream.profile;
    let readAccessToken;
    if (upstream.token) readAccessToken = async () => { try { return await upstream.token(account); } catch (e) { onCredentialFailure(); throw e; } };
    else if (account.kind === 'personal') readAccessToken = async args => { try { return await readPersonalAccessToken(args); } catch (e) { onCredentialFailure(); throw e; } };
    else readAccessToken = async ({ signal } = {}) => {
      try { return await readPoolAccessToken({ poolRoot: join(opts.dataDir, 'codeagent-pool'), accountId: account.id, minValidityMs: 120000, timeoutMs: 10000, signal }); }
      catch (e) { onCredentialFailure(); throw e; }
    };
    return createCompanyPersonalProvider({ signer: upstream.signer, readAccessToken, onDiagnostic: diag,
      appId: p.appId, expectedVersion: p.codeagentVersion, identityUrl: p.identityUrl, chatUrl: p.chatUrl, credentialPath: p.personalCredential,
      identityAccountField: p.identityAccountField, identityDeptField: p.identityDeptField || '',
      ...(p.testOnlyIdentityPath ? { testOnlyIdentityPath: p.testOnlyIdentityPath } : {}),
      upstreamSessionId: uuidFrom(sessionTag + ':' + account.id),
      experimentalNativeThinking: true, experimentalCodexControls: kind === 'codex',
      ...(upstream.testOrigin ? { testOnlyLoopbackOrigin: upstream.testOrigin } : {}) });
  };
  const router = createAccountRouter({ listAccounts: () => poolAccounts(opts.dataDir, Date.now(), upstream?.profile?.personalCredential), makeProvider, statSync: opts.mock ? null : statSync,
    onEvent: e => log(`account ${e.type} session=${String(e.session).slice(0, 8)} ${e.account || ''}${e.from ? ' from=' + e.from : ''}${e.to ? ' to=' + e.to : ''}${e.reason ? ' reason=' + e.reason : ''}`) });

  // ---------- request gate ----------
  const als = new AsyncLocalStorage();
  const stats = { started: stamp(), requests: 0, ok: 0, failed: 0, inFlight: 0, queued: 0, byKind: { claude: 0, codex: 0, dsh: 0 }, byModel: {}, lastError: null };
  let active = 0; const waiters = [];
  const acquire = () => active < opts.maxConcurrent ? (active++, Promise.resolve()) : new Promise(r => { stats.queued++; waiters.push(r); });
  const release = () => { const next = waiters.shift(); if (next) { stats.queued--; next(); } else active--; };
  const errorResponse = (status, message, extra = {}) => new Response(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', [OWN_RESPONSE_HEADER]: '1', ...extra } });
  const gated = {
    listModels: async () => [...MODELS],
    async complete(body, { signal } = {}) {
      const kind = body[KIND] || 'dsh', started = Date.now(), sessionTag = als.getStore()?.sessionTag || 'default', pin = als.getStore()?.pin || '';
      stats.requests++; stats.byKind[kind]++; stats.byModel[body.model] = (stats.byModel[body.model] || 0) + 1;
      if (!startup.ready) { stats.failed++; stats.lastError = startup.code; return errorResponse(503, startup.message); }
      await acquire(); stats.inFlight++;
      // The slot is held until the response body has been read to its end (or cancelled), not just until headers.
      let held = true, handedOff = false;
      const done = () => { if (held) { held = false; stats.inFlight--; release(); } };
      try {
        const response = await router.complete(body, { signal, sessionTag, kind, pin });
        if (response.ok) stats.ok++; else { stats.failed++; stats.lastError = `upstream HTTP ${response.status}`; }
        log(`${kind} ${body.model} -> HTTP ${response.status} via ${router.accountFor(sessionTag) || '-'} in ${Date.now() - started}ms`);
        if (!response.body) return response;
        handedOff = true; // the body now releases the slot
        return releaseOnEnd(response, done);
      } catch (error) {
        stats.failed++;
        const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'UPSTREAM_CALL_FAILED';
        stats.lastError = code; log(`${kind} ${body.model} -> FAILED ${code} after ${Date.now() - started}ms`);
        const pinned = pinnedMessage(error, accountAlias(opts.dataDir, error?.account));
        if (pinned) return errorResponse(error.status, pinned, code === 'COMPANY_PINNED_RATE_LIMITED' ? { 'retry-after': String(error.retryAfterSeconds || 60) } : {});
        if (code === 'COMPANY_LOGIN_NEEDED' && error.pinned) return errorResponse(401, loginNeededMessage(error) + `（本会话固定用${accountAlias(opts.dataDir, error.account)}，不会换号）`);
        if (code === 'COMPANY_NO_ACCOUNT_AVAILABLE') return errorResponse(429, '公司模型的所有账号都在限流冷却中，请稍后再试', { 'retry-after': String(error.retryAfterSeconds || 60) });
        if (code === 'COMPANY_LOGIN_NEEDED') return errorResponse(401, loginNeededMessage(error));
        if (code === 'COMPANY_ACCOUNTS_PAUSED') return errorResponse(503, '公司模型的号都被暂停了（账号页里手动暂停或额度用完），请到 Hub 账号页恢复一个号');
        throw error;
      } finally { if (!handedOff) done(); }
    },
  };

  // ---------- HTTP ----------
  const common = { maxTokensCap: opts.maxTokensCap, defaultModel: MODEL_GLM };
  const claude = createClaudeAdapter(common), codex = createCodexAdapter(common), dsh = createDshAdapter(common);
  const logged = (name, adapter) => ({ ...adapter, convertRequest(body) {
    try { return adapter.convertRequest(body); }
    catch (error) { const msg = String(error?.message || 'conversion failed').slice(0, 160); log(`${name} request rejected before upstream: ${msg}`); stats.failed++; stats.lastError = `${name}: ${msg}`; throw error; }
  } });
  const proxy = createProxy({ provider: gated, accessKey: key, timeoutMs: opts.timeoutMs, maxBodyBytes: 64 * 1024 * 1024,
    onEvent: e => { if (e.type !== 'request_finished') log(`proxy event ${e.type}`); },
    protocolAdapters: { '/v1/messages': logged('claude', claude), '/v1/responses': logged('codex', codex), '/v1/chat/completions': logged('dsh', dsh) } });
  const keyBytes = Buffer.from(key);
  // Returns { sessionTag, pin } for a valid "<key>[.<tag>]" credential, otherwise null.
  const credential = req => {
    const a = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '';
    const raw = a || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');
    const dot = raw.indexOf('.');
    const head = Buffer.from(dot < 0 ? raw : raw.slice(0, dot));
    if (head.length !== keyBytes.length || !timingSafeEqual(head, keyBytes)) return null;
    return dot < 0 ? { sessionTag: 'default', pin: '' } : parseTag(raw.slice(dot + 1));
  };
  const readJson = async req => { const c = []; let n = 0; for await (const x of req) { n += x.length; if (n > 64 * 1024 * 1024) throw new Error('too large'); c.push(x); } return JSON.parse(Buffer.concat(c).toString('utf8')); };
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const status = () => ({ ok: true, ready: startup.ready, code: startup.code, message: startup.message, missing: startup.missing, diagnostics: startup.diagnostics || null,
    zone: startup.zone, firstInit: startup.firstInit,
    version: VERSION, mock: opts.mock, pid: process.pid, port: opts.port, models: MODELS, systemCa, stats, router: router.snapshot(),
    ...(mock ? { mockUpstream: mock.stats } : {}) });
  let stop; const stopped = new Promise(r => { stop = r; });
  const inner = proxy.server.listeners('request')[0];
  proxy.server.removeAllListeners('request');
  proxy.server.on('request', async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/health' || path === '/')) {
        return json(res, 200, { ok: true, ready: startup.ready, version: VERSION, pid: process.pid });
      }
      const tag = credential(req);
      if (tag === null) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'A valid local proxy key is required' } });
      // The shared transport checks the plain key; the tag travels in async context.
      req.headers.authorization = `Bearer ${key}`; delete req.headers['x-api-key'];
      if (req.method === 'GET' && path === '/admin/status') return json(res, 200, status());
      if (req.method === 'POST' && path === '/admin/shutdown') { json(res, 200, { ok: true, stopping: true }); log('shutdown requested'); setTimeout(() => stop('shutdown'), 50); return; }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const body = await readJson(req);
        return json(res, 200, { input_tokens: Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 3) });
      }
      return await als.run(tag, async () => {
        if (req.method === 'POST' && path === '/v1/messages' && String(req.headers['content-type'] || '').startsWith('application/json')) {
          // Non-streaming Claude calls: the shared transport is stream-only, so stream upstream and collect here.
          const body = await readJson(req);
          if (body.stream === true) {
            const replay = Readable.from([Buffer.from(JSON.stringify(body))]);
            Object.assign(replay, { headers: req.headers, method: req.method, url: req.url, httpVersion: req.httpVersion, complete: true, socket: req.socket });
            req.once('aborted', () => replay.emit('aborted'));
            return inner(replay, res);
          }
          const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
          const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
          try {
            body.stream = true;
            const original = { ...body };
            const converted = logged('claude', claude).convertRequest(body);
            const upstreamResponse = await gated.complete(converted, { signal: controller.signal });
            if (!upstreamResponse.ok) { res.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await upstreamResponse.arrayBuffer())); return; }
            const message = await collectAnthropicMessage(await claude.convertResponse(upstreamResponse, { signal: controller.signal, request: original }));
            return json(res, 200, message);
          } catch (error) {
            if (!res.headersSent) {
              const code = error?.code === 'unsupported_protocol' && error.status >= 400 && error.status < 500 ? error.status : 502;
              return json(res, code, { type: 'error', error: { type: code === 502 ? 'api_error' : 'invalid_request_error', message: code === 502 ? 'The request did not complete' : String(error.message).slice(0, 300) } });
            }
            res.destroy(); return;
          } finally { clearTimeout(timer); }
        }
        return inner(req, res);
      });
    } catch {
      if (!res.headersSent) json(res, 400, { error: { type: 'invalid_request_error', message: 'Malformed request' } }); else res.destroy();
    }
  });
  let address;
  try { address = await proxy.listen(opts.port); }
  catch (error) {
    if (opts.port && error?.code === 'EADDRINUSE') { log(`port ${opts.port} busy, using a free port`); address = await proxy.listen(0); }
    else throw error;
  }
  opts.port = address.port;
  const statePath = join(workDir, 'proxy-state.json');
  await writeFile(statePath, JSON.stringify({ version: VERSION, pid: process.pid, port: address.port, mock: opts.mock, ready: startup.ready, started: stats.started }, null, 2), 'utf8');
  log(`listening on http://127.0.0.1:${address.port} (ready=${startup.ready}; max ${opts.maxConcurrent} concurrent)`);
  process.once('SIGINT', () => stop('SIGINT')); process.once('SIGTERM', () => stop('SIGTERM'));
  const forgetTimer = setInterval(() => router.forget(), 10 * 60_000); forgetTimer.unref();
  if (opts.parentPid > 0) {
    const watch = setInterval(() => { try { process.kill(opts.parentPid, 0); } catch (e) { if (e?.code === 'ESRCH') stop('parent exited'); } }, 3000);
    watch.unref();
  }
  const reason = await stopped;
  try { proxy.server.closeAllConnections(); await Promise.race([proxy.close(), new Promise(r => setTimeout(r, 2000))]); } catch { /* closing */ }
  await mock?.close();
  try { const state = JSON.parse(await readFile(statePath, 'utf8')); if (state.pid === process.pid) await rm(statePath, { force: true }); } catch { /* already gone */ }
  log(`stopped (${reason})`);
  return { ok: true, stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), error => {
    process.stderr.write('company model proxy failed: ' + String(error?.message || error).slice(0, 200) + '\n');
    process.exit(1);
  });
}
