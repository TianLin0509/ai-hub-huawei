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
import { KIND, createClaudeAdapter, createCodexAdapter, createDshAdapter, collectAnthropicMessage } from './adapters.mjs';
import { createGatewayProvider } from './gateway-provider.mjs';
import { completeWithRetry } from './upstream-retry.mjs';
// 公司模型目录（和 CodeAgent 同一个目录接口，按账号拉）：CommonJS，Hub 主进程也用同一份解析与匹配规则。
const modelCatalog = createRequire(import.meta.url)('./model-catalog.cjs');
const { listenWithPortFallback } = createRequire(import.meta.url)('./port-fallback.cjs');

export const VERSION = 'company-model-proxy 1.0';
const SAFE_CODE = /^[A-Za-z0-9_ .:\-]{1,120}$/;
const TAG = /^[A-Za-z0-9_-]{1,64}$/;
const PIN_SUFFIX = /^(.+?)__pin_([a-z0-9]{6,16}|personal)$/;
// API 网关会话（部门 API key）：会话标识末尾带 "__gw"，请求转给网关，不经 CodeAgent 账号（gateway-provider.mjs）。
const GATEWAY_SUFFIX = '__gw';

// "<session tag>[__pin_<id>|__gw]" -> { sessionTag, pin, gateway } (pin '' = automatic), or null when malformed.
// Sticky assignments and the session card alias stay keyed by the plain session tag.
export function parseTag(raw) {
  let value = String(raw ?? '');
  const gateway = value.endsWith(GATEWAY_SUFFIX) && value.length > GATEWAY_SUFFIX.length;
  if (gateway) value = value.slice(0, -GATEWAY_SUFFIX.length);
  const match = gateway ? null : PIN_SUFFIX.exec(value);
  const sessionTag = match ? match[1] : value;
  if (!TAG.test(sessionTag)) return null;
  return gateway ? { sessionTag, pin: '', gateway: true } : { sessionTag, pin: match ? match[2] : '' };
}

// 网关配置来自 Hub（main/company-proxy-service.js 启动反代时经环境变量给；Key 只在内存）。
export function gatewayFromEnv(env = process.env) {
  const baseURL = String(env.AI_HUB_API_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.AI_HUB_API_GATEWAY_KEY || '').trim();
  if (!/^https?:\/\//.test(baseURL) || !apiKey) return null;
  const models = String(env.AI_HUB_API_GATEWAY_MODELS || '').split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(x));
  const preferred = String(env.AI_HUB_API_GATEWAY_MODEL || '').trim();
  const defaultModel = models.includes(preferred) ? preferred : (models[0] || preferred || 'deepseek-v4.1-flash');
  // 首包等待：环境变量给了就固定用它；不给（默认）按模型自适应（gateway-provider.mjs）。
  const headerTimeoutMs = Number(env.AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS) > 0 ? Number(env.AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS) : 0;
  // 一键体检测到的各模型首字毫秒（JSON），和 key 所在分组（报错时说「不对你的 free 分组开放」用）。
  let firstTokenMs = {};
  try {
    const parsed = JSON.parse(String(env.AI_HUB_API_GATEWAY_FIRST_MS || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      firstTokenMs = Object.fromEntries(Object.entries(parsed).filter(([id, ms]) => models.includes(id) && Number(ms) > 0).map(([id, ms]) => [id, Number(ms)]));
    }
  } catch { firstTokenMs = {}; }
  const group = /^[A-Za-z0-9_-]{1,32}$/.test(String(env.AI_HUB_API_GATEWAY_GROUP || '')) ? String(env.AI_HUB_API_GATEWAY_GROUP) : '';
  // 用户「对这个模型关闭思考」的模型（逗号分隔）：反代给它们的请求注入 enable_thinking=false。
  const noThinking = String(env.AI_HUB_API_GATEWAY_NO_THINK || '').split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(x));
  return { baseURL, apiKey, models, defaultModel, headerTimeoutMs, firstTokenMs, group, noThinking };
}
// 网关会话的模型名：网关表里有就原样用；别的名字（Claude Code 后台的 haiku 名、旧的公司模型名）落到默认模型。
export function gatewayModel(gateway, name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (value && (gateway.models.includes(value) || !gateway.models.length)) return value;
  return gateway.defaultModel;
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

// 这个号在公司模型目录里能用的模型（上游模型名）：目录拉到过就以它为准（权威），比 Hub 账号页读的 CodeAgent 菜单名更准——
// 菜单名「GLM-5.3-Auto(Volcano-MaaS)」和实际发给上游的模型名不是同一个字串。
function catalogModelsOf(catalog, id) {
  const entry = catalog && catalog.accounts && catalog.accounts[id];
  const models = entry && Array.isArray(entry.models) ? entry.models.map(m => m && m.id).filter(Boolean) : [];
  return models.length ? { models, modelsAuthoritative: true, catalogAuthoritative: true } : null;
}

// Pool registry, manual/automatic pauses kept by Hub's account page and each account's models.
export function poolAccounts(dataDir, now = Date.now(), personalCredential = '', catalog = null) {
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
      const models = catalogModelsOf(catalog, a.id) || modelsOf(dataDir, a.id);
      return { id: a.id, kind: 'pool', paused: paused(a.id), credentialFile: join(root, 'accounts', a.id, '.credentials.json'), ...(models || {}) };
    });
  list.push({ id: PERSONAL, kind: 'personal', paused: paused(PERSONAL), ...(personalCredential ? { credentialFile: personalCredential } : {}),
    ...(catalogModelsOf(catalog, PERSONAL) || {}) });
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
// onEnd receives { chunks, firstMs, lastMs } (ms since the body was handed over): lets the log show whether the
// upstream streamed (many chunks spread over time) or answered in one burst at the end (2026-11-17 feedback:
// "DSH 回答不是流式的，执行完才一次显示").
export function releaseOnEnd(response, onEnd) {
  const reader = response.body.getReader();
  const began = Date.now();
  let ended = false, chunks = 0, firstMs = null, lastMs = null;
  const end = () => { if (!ended) { ended = true; try { onEnd({ chunks, firstMs, lastMs }); } catch { /* bookkeeping only */ } } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { controller.close(); end(); return; }
        chunks++; lastMs = Date.now() - began; if (firstMs === null) firstMs = lastMs;
        controller.enqueue(value);
      } catch (error) { end(); controller.error(error); }
    },
    cancel(reason) { end(); return reader.cancel(reason).catch(() => {}); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// 非流式 Claude 调用的时限（2026-11-21）：跟流式路径（transport.mjs）一样按「空闲」计——上游每来一块数据就重新计时，
// 连续 timeoutMs 没数据才断；另有 maxDurationMs 绝对上限（缺省 60 分钟）防挂死。以前这里是 15 分钟总时限，
// 上游一直在正常出数据的长回答也会在第 900 秒被掐断。
export function idleDeadline({ timeoutMs, maxDurationMs = Math.max(timeoutMs, 60 * 60 * 1000) }) {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < timeoutMs) throw new Error('maxDurationMs must be an integer not below timeoutMs');
  const controller = new AbortController();
  let idle = null, done = false;
  const abort = () => { if (done) return; done = true; clearTimeout(idle); clearTimeout(hard); controller.abort(new Error('Request deadline exceeded')); };
  const arm = () => { clearTimeout(idle); idle = setTimeout(abort, timeoutMs); idle.unref?.(); };
  const hard = setTimeout(abort, maxDurationMs); hard.unref?.();
  arm();
  return { signal: controller.signal, abort, touch: () => { if (!done) arm(); },
    clear: () => { done = true; clearTimeout(idle); clearTimeout(hard); } };
}

// 同一个上游回复，但每读到一块就续一次命（deadline.touch）。
export function touchOnEachChunk(response, touch) {
  if (!response.body) return response;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { touch(); controller.enqueue(chunk); } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// 非流式 Claude 请求：上游按流式拉，攒成一条 Message；上游非 2xx 原样交回（passthrough）。
export async function completeNonStreamingMessage({ complete, adapter, converted, original, deadline }) {
  const upstreamResponse = await complete(converted, { signal: deadline.signal });
  if (!upstreamResponse.ok) return { passthrough: upstreamResponse };
  deadline.touch();
  const live = touchOnEachChunk(upstreamResponse, deadline.touch);
  return { message: await collectAnthropicMessage(await adapter.convertResponse(live, { signal: deadline.signal, request: original })) };
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
        startup.message = `公司模型反代正在做首次签名初始化（${profile.signerInit.text}；后台运行 CodeAgent 命令行，不弹窗，通常 10–20 秒，重试时最多约 2 分钟）…`;
        log(`signer first-time initialization: ${profile.signerInit.reason} (tried ${profile.signerInit.tried.map(t => t.source + ':' + t.state).join(',')})`);
      }
      const { signer, adapterSha256, firstInit } = await loadSigner(profile, { workDir });
      startup.firstInit = firstInit;
      log(`signer ready (CodeAgent ${profile.codeagentVersion}; adapter ${adapterSha256.slice(0, 12)}; first-init ${firstInit.ran ? `ran ${firstInit.ms} ms, cli runs ${firstInit.cliRuns}` : 'not needed'}; sources ${JSON.stringify(profile.sources)})`);
      if (firstInit.probe?.attempts?.some(attempt => attempt.error)) {
        log(`signer recovered after retry: first-init=${JSON.stringify(firstInit)}`);
      }
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

  // ---------- company model catalog ----------
  // 反代可用的模型 = 各账号 CodeAgent 模型目录的并集（model-catalog.cjs）。模型很少变（2026-11-20 定）：打开 Hub、反代上游准备好后拉一次；
  // 启动中心「刷新模型」按钮手动拉（POST /admin/refresh-models）；客户端要了目录里没有的版本时补拉一次（最快 1 分钟一次）。
  // 拉不到就用上次存的，都没有用内置的两个。
  const catalog = { cache: modelCatalog.readCache(opts.dataDir), models: [], source: 'builtin', refreshedAt: null, lastError: null, running: null, lastAttempt: 0 };
  const applyCatalog = () => {
    catalog.models = modelCatalog.unionModels(catalog.cache);
    catalog.source = catalog.cache && Object.keys(catalog.cache.accounts || {}).length ? 'catalog' : 'builtin';
  };
  applyCatalog();
  const CATALOG_RETRY_MS = 60 * 1000;
  const fetchAccountCatalog = async account => {
    const p = upstream.profile;
    const token = account.kind === 'personal'
      ? await readPersonalAccessToken({ credentialPath: p.personalCredential, expiryUnit: 'milliseconds', minValidityMs: 60000, timeoutMs: 10000 })
      : await readPoolAccessToken({ poolRoot: join(opts.dataDir, 'codeagent-pool'), accountId: account.id, minValidityMs: 60000, timeoutMs: 10000 });
    const idRes = await fetch(p.identityUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token, Accept: 'application/json' }, body: '{}' });
    if (idRes.status !== 200) { await idRes.body?.cancel().catch(() => {}); throw Object.assign(new Error('identity'), { code: `IDENTITY_HTTP_${idRes.status}` }); }
    const detail = await idRes.json();
    const user = (p.identityAccountField ? detail?.data?.[p.identityAccountField] : ''), dept = p.identityDeptField ? detail?.data?.[p.identityDeptField] || '' : '';
    if (typeof user !== 'string' || !user) throw Object.assign(new Error('identity'), { code: 'IDENTITY_UNVERIFIED' });
    const headers = { 'Content-Type': 'application/json', 'X-AUTH-TOKEN': token, 'Agent-Type': 'AgentCenter', area: p.zone,
      'plugin-version': `cli-${p.codeagentVersion}`, 'x-error-propagation': 'true', 'app-id': p.appId, 'x-agent-client-version': p.codeagentVersion,
      'x-agent-user-account': user, ...(dept ? { depart: dept, 'x-agent-user-department': dept } : {}) };
    const res = await fetch(new URL(modelCatalog.CATALOG_PATH, p.identityUrl).href, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(15000) });
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); throw Object.assign(new Error('catalog'), { code: `CATALOG_HTTP_${res.status}` }); }
    const raw = await res.text();
    if (raw.length > 2 * 1024 * 1024) throw Object.assign(new Error('catalog'), { code: 'CATALOG_TOO_LARGE' });
    return modelCatalog.parseCatalog(JSON.parse(raw));
  };
  const refreshCatalog = why => {
    if (opts.mock || !upstream?.profile?.identityUrl) return Promise.resolve(false);
    if (catalog.running) return catalog.running;
    if (why === 'miss' && Date.now() - catalog.lastAttempt < CATALOG_RETRY_MS) return Promise.resolve(false);
    catalog.lastAttempt = Date.now();
    catalog.running = (async () => {
      const before = catalog.models.map(m => m.id).join(',');
      const next = { schema: 1, at: Date.now(), accounts: { ...(catalog.cache?.accounts || {}) } };
      const accounts = poolAccounts(opts.dataDir, Date.now(), upstream.profile.personalCredential);
      for (const id of Object.keys(next.accounts)) if (!accounts.some(a => a.id === id)) delete next.accounts[id]; // 号已移出号池
      const failed = [];
      for (const account of accounts) {
        try {
          const models = await fetchAccountCatalog(account);
          if (models.length) next.accounts[account.id] = { at: Date.now(), models }; else failed.push(`${account.id}:EMPTY`);
        } catch (error) { failed.push(`${account.id}:${SAFE_CODE.test(String(error?.code || '')) ? error.code : (error?.name || 'FAILED')}`); }
      }
      catalog.cache = next; applyCatalog();
      catalog.refreshedAt = stamp(); catalog.lastError = failed.length ? failed.join(' ') : null; catalog.lastOk = accounts.length - failed.length;
      const after = catalog.models.map(m => m.id).join(',');
      try { modelCatalog.writeCache(opts.dataDir, next); } catch (error) { log(`model catalog not saved: ${error?.code || 'write failed'}`); }
      log(`model catalog ${why}: ${catalog.models.length} models [${after}]${after !== before ? ` (was [${before}])` : ''}; accounts ok ${accounts.length - failed.length}/${accounts.length}${failed.length ? ' failed ' + failed.join(' ') : ''}`);
      return after !== before;
    })().catch(error => { catalog.lastError = String(error?.code || 'REFRESH_FAILED'); log(`model catalog ${why} failed: ${catalog.lastError}`); return false; })
      .finally(() => { catalog.running = null; });
    return catalog.running;
  };
  upstreamReady.then(() => {
    if (!startup.ready) return;
    refreshCatalog('start');
  });
  // 客户端给的模型名 → 上游模型名（规则见 model-catalog.cjs resolveModel）。
  const resolveCompanyModel = name => {
    try {
      const hit = modelCatalog.resolveModel(name, catalog.models);
      if (hit.how === 'retired-upgrade') log(`model ${String(name).slice(0, 80)} not in catalog any more; using newer ${hit.id}`);
      return hit.id;
    } catch (error) {
      if (error?.code !== 'MODEL_NOT_IN_CATALOG') throw error;
      refreshCatalog('miss').catch(() => {});
      throw Object.assign(new Error(error.message + '。如果 CodeAgent 里刚出现这个模型，等 1 分钟再试'), { code: 'unsupported_protocol', status: 422 });
    }
  };
  const catalogModelMap = () => Object.fromEntries(catalog.models.map(m => [m.id, m.id]));
  const thinkingModel = id => modelCatalog.capabilities(id).thinking;

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
      experimentalNativeThinking: true, experimentalCodexControls: kind === 'codex', modelMap: catalogModelMap, thinkingModel,
      ...(upstream.testOrigin ? { testOnlyLoopbackOrigin: upstream.testOrigin } : {}) });
  };
  const router = createAccountRouter({ listAccounts: () => poolAccounts(opts.dataDir, Date.now(), upstream?.profile?.personalCredential, catalog.cache), makeProvider, statSync: opts.mock ? null : statSync,
    onEvent: e => log(`account ${e.type} session=${String(e.session).slice(0, 8)} ${e.account || ''}${e.from ? ' from=' + e.from : ''}${e.to ? ' to=' + e.to : ''}${e.reason ? ' reason=' + e.reason : ''}`) });

  // ---------- request gate ----------
  const als = new AsyncLocalStorage();
  // ---------- API gateway (部门 API key 会话) ----------
  // 首包前排队中的网关请求（按请求记：同一会话常有两个并发请求，先回的那个不能把另一个的排队状态清掉——11-19 黄区实测发现），
  // 给 Hub 显示「网关排队中」：每个会话报等得最久的那个。
  const gatewayWaiting = new Map(); // request -> { tag, since, attempt }
  const waitingByTag = () => { const out = {};
    for (const w of gatewayWaiting.values()) { const cur = out[w.tag];
      if (!cur || Date.now() - w.since > cur.waitedMs) out[w.tag] = { waitedMs: Date.now() - w.since, attempt: Math.max(w.attempt, cur?.attempt || 1) }; }
    return out; };
  let gatewayConfig = null, gatewayProvider = null;
  // 换 key / 模型 / 地址时 Hub 经 POST /admin/gateway 热更新，不重启反代：同一反代上的公司会话和正在回答的网关请求都不受影响
  // （在途请求继续用旧的 provider 跑完）。11-19 换模型审查发现原来的「重启反代」会打断别的会话。
  const configureGateway = (config, why = 'start') => {
    gatewayConfig = config;
    gatewayProvider = config ? createGatewayProvider({ baseURL: config.baseURL, apiKey: config.apiKey, headerTimeoutMs: config.headerTimeoutMs,
      firstTokenMs: config.firstTokenMs, models: config.models, group: config.group, noThinking: config.noThinking,
      ownError: (...args) => errorResponse(...args), log,
      onWait: ({ request, sessionTag, waiting, since, attempt }) => { if (waiting) gatewayWaiting.set(request, { tag: sessionTag, since, attempt }); else gatewayWaiting.delete(request); } }) : null;
    if (config) log(`API gateway configured (${config.models.length} models, default ${config.defaultModel}, ${why})`);
    else if (why !== 'start') log(`API gateway cleared (${why})`);
  };
  const gatewayTimeoutEnv = env.AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS;
  configureGateway(gatewayFromEnv(env));
  // Key 读进内存后就从环境里删掉，之后反代再起的子进程（如签名初始化用的 CodeAgent CLI）不会继承它。
  delete env.AI_HUB_API_GATEWAY_KEY; delete process.env.AI_HUB_API_GATEWAY_KEY;
  const stats = { started: stamp(), requests: 0, ok: 0, failed: 0, retries: 0, inFlight: 0, queued: 0, byKind: { claude: 0, codex: 0, dsh: 0 }, byModel: {}, lastError: null,
    gateway: { requests: 0, ok: 0, failed: 0, inFlight: 0, lastFirstMs: null } };
  let active = 0; const waiters = [];
  const acquire = () => active < opts.maxConcurrent ? (active++, Promise.resolve()) : new Promise(r => { stats.queued++; waiters.push(r); });
  const release = () => { const next = waiters.shift(); if (next) { stats.queued--; next(); } else active--; };
  const errorResponse = (status, message, extra = {}) => new Response(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error', message } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', [OWN_RESPONSE_HEADER]: '1', ...extra } });
  const gated = {
    listModels: async () => catalog.models.map(m => m.id),
    async complete(body, { signal } = {}) {
      const kind = body[KIND] || 'dsh', started = Date.now(), sessionTag = als.getStore()?.sessionTag || 'default', pin = als.getStore()?.pin || '';
      stats.requests++; stats.byKind[kind]++; stats.byModel[body.model] = (stats.byModel[body.model] || 0) + 1;
      if (als.getStore()?.gateway) {
        // 网关会话：不占公司上游的并发名额（网关自己排队），也不受公司上游是否准备好影响。
        stats.gateway.requests++;
        if (!gatewayProvider) { stats.failed++; stats.lastError = 'GATEWAY_NOT_CONFIGURED'; return errorResponse(503, 'API 网关还没配置好：请到「设置 → 自有 API → API 网关」粘贴 key 并保存。'); }
        // 在途计数：Hub 停反代前（最后一个工具不再用反代）等它们回答完。
        stats.gateway.inFlight++;
        let handed = false;
        try {
          // 「网关排队中」只跟用户真正在等的回答：Claude Code 不带工具的请求是后台小请求（起标题、判断话题），它们排队不提示，
          // 否则回答已经出来了标题栏还显示排队（11-19 黄区实测）。
          const track = !(kind === 'claude' && !(Array.isArray(body.tools) && body.tools.length));
          const response = await gatewayProvider.complete(body, { signal, sessionTag, track });
          const firstMs = Date.now() - started;
          if (response.ok) { stats.ok++; stats.gateway.ok++; stats.gateway.lastFirstMs = firstMs; } else { stats.failed++; stats.gateway.failed++; stats.lastError = `gateway HTTP ${response.status}`; }
          log(`${kind} ${body.model} -> gateway HTTP ${response.status} in ${firstMs}ms`);
          if (!response.ok || !response.body) return response;
          handed = true;
          return releaseOnEnd(response, timing => {
            stats.gateway.inFlight--;
            if (timing?.chunks) log(`${kind} ${body.model} gateway stream: ${timing.chunks} chunks, last +${timing.lastMs}ms after headers (${firstMs}ms)`);
          });
        } finally { if (!handed) stats.gateway.inFlight--; }
      }
      if (!startup.ready) { stats.failed++; stats.lastError = startup.code; return errorResponse(503, startup.message); }
      // 输出长度按目录给这个模型的上限截（目录里有的才截；没写的照旧只受全局上限约束）。
      const outputCap = catalog.models.find(m => m.id === body.model)?.output;
      if (Number.isSafeInteger(outputCap) && outputCap > 0 && Number.isSafeInteger(body.max_tokens) && body.max_tokens > outputCap) body.max_tokens = outputCap;
      await acquire(); stats.inFlight++;
      // The slot is held until the response body has been read to its end (or cancelled), not just until headers.
      let held = true, handedOff = false;
      const done = () => { if (held) { held = false; stats.inFlight--; release(); } };
      try {
        // 短暂失败（连不上、5xx、首帧前断流或假死）在这里重试，客户端看不到（upstream-retry.mjs）。
        // 每次尝试用自己的 attemptSignal：首帧超时只中止这一次，用户取消照样传到底。
        const response = await completeWithRetry(attemptSignal => router.complete(body, { signal: attemptSignal, sessionTag, kind, pin }), { signal,
          onRetry: r => { stats.retries++; log(`${kind} ${body.model} upstream ${r.reason}; retry ${r.attempt} in ${r.delayMs}ms`); } });
        if (response.ok) stats.ok++; else { stats.failed++; stats.lastError = `upstream HTTP ${response.status}`; }
        log(`${kind} ${body.model} -> HTTP ${response.status} via ${router.accountFor(sessionTag) || '-'} in ${Date.now() - started}ms`);
        if (!response.body) return response;
        handedOff = true; // the body now releases the slot
        const headersMs = Date.now() - started;
        return releaseOnEnd(response, timing => {
          done();
          if (response.ok && timing?.chunks) log(`${kind} ${body.model} stream: ${timing.chunks} chunks, first +${timing.firstMs}ms, last +${timing.lastMs}ms after headers (${headersMs}ms)`);
        });
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
  const common = { maxTokensCap: opts.maxTokensCap, defaultModel: modelCatalog.defaultModel(catalog.models).id,
    resolve: name => als.getStore()?.gateway && gatewayConfig ? gatewayModel(gatewayConfig, name) : resolveCompanyModel(name) };
  const claude = createClaudeAdapter(common), codex = createCodexAdapter(common), dsh = createDshAdapter(common);
  const logged = (name, adapter) => ({ ...adapter, convertRequest(body) {
    try { return adapter.convertRequest(body); }
    catch (error) { const msg = String(error?.message || 'conversion failed').slice(0, 160); log(`${name} request rejected before upstream: ${msg}`); stats.failed++; stats.lastError = `${name}: ${msg}`; throw error; }
  } });
  const proxy = createProxy({ provider: gated, accessKey: key, timeoutMs: opts.timeoutMs, maxBodyBytes: 64 * 1024 * 1024,
    onEvent: e => { if (e.type !== 'request_finished') log(`proxy event ${e.type}`); else if (e.detail) log(`upstream HTTP ${e.status} reason: ${e.detail}`); },
    protocolAdapters: { '/v1/messages': logged('claude', claude), '/v1/responses': logged('codex', codex), '/v1/chat/completions': logged('dsh', dsh) },
    // DSH 走公司模型：出字前的失败反代已经重试过，交回时用 DSH 不会再重试的状态码（transport.mjs clientStatus）。
    // 网关会话不动：网关有自己的首包等待和重试，DSH 网关路线的客户端重试是 0 次。
    noClientRetry: pathname => pathname === '/v1/chat/completions' && !als.getStore()?.gateway });
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
    version: VERSION, mock: opts.mock, pid: process.pid, port: opts.port, models: catalog.models.map(m => m.id),
    modelCatalog: { source: catalog.source, refreshedAt: catalog.refreshedAt, lastError: catalog.lastError, models: catalog.models.map(m => ({ id: m.id, label: m.label })) }, systemCa, stats, router: router.snapshot(),
    gateway: gatewayConfig ? { configured: true, models: gatewayConfig.models, defaultModel: gatewayConfig.defaultModel,
      waiting: waitingByTag() } : { configured: false, waiting: {} },
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
      if (req.method === 'POST' && path === '/admin/gateway') {
        const b = await readJson(req);
        configureGateway(b?.baseURL ? gatewayFromEnv({ AI_HUB_API_GATEWAY_URL: b.baseURL, AI_HUB_API_GATEWAY_KEY: b.apiKey,
          AI_HUB_API_GATEWAY_MODELS: Array.isArray(b.models) ? b.models.join(',') : '', AI_HUB_API_GATEWAY_MODEL: b.model,
          AI_HUB_API_GATEWAY_FIRST_MS: b.firstTokenMs && typeof b.firstTokenMs === 'object' ? JSON.stringify(b.firstTokenMs) : '', AI_HUB_API_GATEWAY_GROUP: b.group || '',
          AI_HUB_API_GATEWAY_NO_THINK: Array.isArray(b.noThinking) ? b.noThinking.join(',') : '',
          AI_HUB_API_GATEWAY_HEADER_TIMEOUT_MS: gatewayTimeoutEnv }) : null, 'updated by Hub');
        return json(res, 200, { ok: true, gateway: status().gateway });
      }
      if (req.method === 'POST' && path === '/admin/refresh-models') {
        if (!opts.mock && !startup.ready) return json(res, 409, { ok: false, error: '公司模型还没准备好，稍后再刷新', modelCatalog: status().modelCatalog });
        if (!opts.mock && !upstream?.profile?.identityUrl) return json(res, 200, { ok: false, error: '公司上游信息不全，取不到模型目录', modelCatalog: status().modelCatalog });
        catalog.lastOk = null;
        const changed = await refreshCatalog('manual');
        // 一个号都没取到（登录过期、断网等）：报没刷新成功，不拿旧缓存冒充（独立审查 2026-11-20）。合成上游不连 CodeAgent，按成功算。
        if (!opts.mock && catalog.lastOk === 0) return json(res, 200, { ok: false, error: `一个号都没取到模型目录（${catalog.lastError || '原因不明'}）`, modelCatalog: status().modelCatalog });
        if (!opts.mock && catalog.lastOk === null) return json(res, 200, { ok: false, error: catalog.lastError || '这次没取成', modelCatalog: status().modelCatalog });
        return json(res, 200, { ok: true, changed, modelCatalog: status().modelCatalog });
      }
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
          const deadline = idleDeadline({ timeoutMs: opts.timeoutMs }); res.once('close', () => { if (!res.writableEnded) deadline.abort(); });
          try {
            body.stream = true;
            const original = { ...body };
            const converted = logged('claude', claude).convertRequest(body);
            const result = await completeNonStreamingMessage({ complete: (b, o) => gated.complete(b, o), adapter: claude, converted, original, deadline });
            if (result.passthrough) { const up = result.passthrough; res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await up.arrayBuffer())); return; }
            return json(res, 200, result.message);
          } catch (error) {
            if (!res.headersSent) {
              const code = error?.code === 'unsupported_protocol' && error.status >= 400 && error.status < 500 ? error.status : 502;
              return json(res, code, { type: 'error', error: { type: code === 502 ? 'api_error' : 'invalid_request_error', message: code === 502 ? 'The request did not complete' : String(error.message).slice(0, 300) } });
            }
            res.destroy(); return;
          } finally { deadline.clear(); }
        }
        return inner(req, res);
      });
    } catch {
      if (!res.headersSent) json(res, 400, { error: { type: 'invalid_request_error', message: 'Malformed request' } }); else res.destroy();
    }
  });
  const binding = await listenWithPortFallback(proxy.server, { ports: [opts.port] });
  const address = { port: binding.port };
  if (binding.fallback) log(binding.message);
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
