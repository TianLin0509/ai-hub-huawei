'use strict';
// 公司内源优先（r21，2026-11-16）：在公司电脑上，各组件的大文件先试公司内源（openx 社区上本产品的项目）
// （黄区实测约 24 MB/s，阿里云约 1.2 MB/s）。版本清单照旧从 GitHub / 阿里云取，这里只换「字节从哪儿来」：
// 按文件名在内源的发布版本里找同名附件，下载后仍按清单的大小和 sha256 核对（downloader.js 的 downloadOne）。
// 公司外（在家、外网）连不上内源：3 秒内没回就记下「连不上」，5 分钟内不再试，所以外网用户每 5 分钟最多多等一次 3 秒。
// 找不到、校验不对、连不上都静默回到原来的下载源，不报错。
//
// 内源地址与开关在 openx-config.js。成员版组件（11-18）和成员版程序包（r56，11-19）也先走内源；
// 成员版程序包只认内源上的 member-v<版本> 版本，公开版永远不碰 member-* 版本。
// 接口（匿名可用，2026-11-16 黄区实测）：
//   版本列表 GET {api}by_project_id?projectId=<id>&currentPage=1&pageSize=N → { code:"0", data:{ records:[{ id, version, releaseTime }] } }
//   单个版本 GET {api}by_id?id=<id> → { data:{ binaryPackages:[{ originalFileName, url }] } }（列表里 url 可能为空，必须逐个查）
//   附件支持 Range。

function loadConfig() {
  try { return require('./openx-config'); } catch (_) { return null; }
}
const CONFIG = loadConfig();
const DEFAULT_API = CONFIG ? CONFIG.api : '';
const PROJECT_ID = CONFIG ? CONFIG.projectId : 0;
// 只接受内源自己域名下的 https 附件地址：防止接口返回的地址把下载带到别处（内容另有 sha256 兜底）。
const ALLOWED_HOST = (() => { try { return CONFIG ? new URL(CONFIG.fileSite).hostname.toLowerCase() : ''; } catch (_) { return ''; } })();
// 本版本是否启用内源：公开版 true，成员版 false（见 openx-config.js）。
const EDITION_ON = !!(CONFIG && CONFIG.enabledInEdition);
const REACH_TIMEOUT_MS = 3000;
// 列表都取不到才算「连不上」；一次慢响应不该让内源停用太久（r44 审查）：5 分钟后再试。
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
const LIST_TTL_MS = 10 * 60 * 1000;
// r24：组件包发一次能用很久，期间 Hub 每版都会新增内源版本；列表多取一些，组件版本靠版本名直接命中（只查 1 次详情）。
const LIST_PAGE_SIZE = 100;
const MAX_DETAIL_QUERIES = 8;
// 状态未知（还没探测过，或上次探测已过 10 分钟）时，下载最多等内源这么久；没结果就先走原源，探测在后台继续，供下一次下载用。
// 2026-11-18 公司电脑实测：内源版本列表一次约 0.9–1.05 秒、详情约 0.12 秒。原来只等 0.5 秒，在公司里几乎总是等不到，
// 组件下载于是落回 GitHub（同事反馈「还是优先 GitHub」）。改为与探测超时相同的 3 秒：公司里稳定命中内源；
// 公司外最多多等一次 3 秒，随后标记连不上 5 分钟，期间直接走原源。
const UNKNOWN_BUDGET_MS = REACH_TIMEOUT_MS;

let state = freshState();
function freshState() {
  return { unreachableUntil: 0, list: null, listAt: 0, listing: null, details: new Map(), bad: new Set(), lastReason: '' };
}

// 2026-11-18 用户定：成员版下载组件也优先走内源（只下载、按 sha256 核对，不上传任何东西）。
// 所以 Hub 程序（Electron）里两个版本都默认开；纯 Node 跑的单测和脚本不碰。
// AI_HUB_OPENX=0 任何版本都关（排查用）；=1 强制开（单测与排查用）。
function enabled(env = process.env, versions = process.versions) {
  const v = String(env.AI_HUB_OPENX || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !!(versions && versions.electron);
}
// 内源之后的外网源要不要改顺序（GitHub 提到阿里云前）：只按发行版本定——公开版改，成员版保持原顺序（阿里云高速在前）。
// AI_HUB_OPENX=1 只管开内源，不改顺序；AI_HUB_TEST_EDITION=public 仅供单测模拟公开版。
function publicOrder(env = process.env, editionOn = EDITION_ON) {
  return !!editionOn || String(env.AI_HUB_TEST_EDITION || '').trim() === 'public';
}

const normVersion = v => String(v || '').trim().replace(/^v/i, '');

async function getJson(fetchImpl, url, signal, timeoutMs) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // 正文也算在 3 秒里：公司代理的确认页、半开连接都在这里被截断。
    // 不跟随重定向（2026-11-16 黄区实测内源接口与附件都是 200 直出）：一旦跳转就当失败，不会被带到白名单外或 http 地址。
    const response = await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'error' });
    if (response && response.status >= 300 && response.status < 400) throw new Error(`openx 要求跳转（HTTP ${response.status}），不跟随`);
    if (!response || !response.ok) throw new Error(`openx 返回 HTTP ${response && response.status}`);
    const body = JSON.parse(String(await response.text()).trim());
    if (!body || String(body.code) !== '0' || !body.data) throw new Error('openx 返回内容不对');
    return body.data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' && ALLOWED_HOST && (url.hostname === ALLOWED_HOST || url.hostname.endsWith('.' + ALLOWED_HOST)) ? url.href : '';
  } catch (_) { return ''; }
}

// 在 openx 上按文件名找附件。找到返回 { url, releaseId, releaseVersion }，否则返回 null（原因记在 lastReason）。
async function find({ file, version, release, strict = false, fetchImpl, signal, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs = REACH_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  const miss = reason => { state.lastReason = reason; return null; };
  if (!enabled(env)) return miss('未启用');
  if (!api || !projectId) return miss('未配置内源');
  if (!file || typeof fetchImpl !== 'function') return miss('没有文件名或网络');
  const key = String(file).toLowerCase();
  if (state.bad.has(key)) return miss('这个文件上次在内源校验没过');
  if (now() < state.unreachableUntil) return miss(downText());
  const unreachable = error => {
    if (signal && signal.aborted) return miss('已取消');
    markDown(error, now);
    return miss(`内源连不上：${errText(error)}`);
  };
  try { await loadList({ fetchImpl, api, projectId, timeoutMs, now }); } catch (error) { return unreachable(error); }

  // 版本名对得上的先查，其余按发布时间从新到旧；最多再查 MAX_DETAIL_QUERIES 个没缓存过的版本。
  // release（r24）：组件在内源上的专属版本名（如 room-runtime-2.1.0，见 releaseName），优先于组件自身的版本号；
  // 「<版本名> 后缀」（如 r21 的「v5.6.34 更新包」、日后重发）也算对得上。
  const want = normVersion(release || version);
  const same = r => { const n = normVersion(r.version); return n === want || n.startsWith(want + ' '); };
  const time = r => Date.parse(r.releaseTime || '') || 0;
  // 成员版程序包（r56，2026-11-19）：内源上以 member-v<版本> 单独成版（文件名与公开版相同、内容不同），
  // strict 时只查这一个版本，不往别的版本里找；不带 strict 的查找（公开版程序包、各组件）永远跳过 member-* 版本。
  const ordered = [...state.list].filter(r => strict ? same(r) : !isMemberRelease(r.version))
    .sort((a, b) => same(b) - same(a) || time(b) - time(a));
  let queries = 0;
  const deadline = now() + timeoutMs * 2;   // 逐个查版本详情的总预算（约 6 秒），不让找不到的文件拖太久
  for (const rec of ordered) {
    let packages = state.details.get(rec.id);
    if (!packages) {
      if (queries >= MAX_DETAIL_QUERIES || now() > deadline) break;
      queries += 1;
      try {
        const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, signal, timeoutMs);
        packages = Array.isArray(data.binaryPackages) ? data.binaryPackages : [];
        state.details.set(rec.id, packages);
      } catch (error) {
        // 列表能取到说明内源是通的：单个版本详情超时或出错只放弃这一次查找，不把整个内源标成连不上（r44 审查）。
        if (signal && signal.aborted) return miss('已取消');
        return miss(`内源版本详情没取到：${error && error.message ? error.message : error}`);
      }
    }
    const hit = packages.find(p => p && String(p.originalFileName || '').toLowerCase() === key && safeUrl(p.url));
    if (hit) return { url: safeUrl(hit.url), releaseId: rec.id, releaseVersion: String(rec.version || '') };
    // 分片（r24）：内源单个附件有大小上限（600 MB 的 PPT Doctor 被拒），大文件按 <文件名>.000、.001… 放在同一个版本里。
    const parts = [];
    for (let i = 0; i < 100; i++) {
      const name = `${key}.${String(i).padStart(3, '0')}`;
      const p = packages.find(x => x && String(x.originalFileName || '').toLowerCase() === name && safeUrl(x.url));
      if (!p) break;
      parts.push(safeUrl(p.url));
    }
    if (parts.length) return { url: parts[0], urls: parts, releaseId: rec.id, releaseVersion: String(rec.version || '') };
  }
  return miss('内源上没有这个文件');
}

// 版本列表：同一时刻只发一次请求（预热和下载共用），成功后 10 分钟内复用。
async function loadList({ fetchImpl, api, projectId, timeoutMs, now }) {
  if (state.list && now() - state.listAt <= LIST_TTL_MS) return state.list;
  if (!state.listing) {
    state.listing = (async () => {
      const data = await getJson(fetchImpl, `${api}by_project_id?projectId=${projectId}&currentPage=1&pageSize=${LIST_PAGE_SIZE}`, null, timeoutMs);
      if (!Array.isArray(data.records)) throw new Error('openx 版本列表格式不对');
      state.list = data.records.filter(r => r && r.id != null);
      state.listAt = now();
      return state.list;
    })().finally(() => { state.listing = null; });
  }
  return state.listing;
}

// r60：记住「为什么连不上」（第一次失败的真实原因与时间），之后 5 分钟内跳过时也照实说，不再只写「稍后再试」。
function errText(error) {
  const msg = error && error.message ? error.message : String(error || '');
  const code = error && error.cause && error.cause.code ? `（${error.cause.code}）` : '';
  if (error && (error.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(msg))) return `超时没响应${code}`;
  return msg + code;
}
function markDown(error, now = Date.now) {
  state.unreachableUntil = now() + UNREACHABLE_TTL_MS;
  state.down = { reason: errText(error), at: now() };
}
function downText() {
  return state.down && state.down.reason ? `内源连不上：${state.down.reason}（5 分钟内自动重试）` : '内源连不上（稍后再试）';
}
// 排错信息（给界面「复制排错信息」用）：状态、最近一次失败原因和时间。不含地址与凭据。
function diagnostics({ now = Date.now } = {}) {
  return { reachability: reachability({ now }), down: state.down || null,
    listAgeSec: state.list ? Math.round((now() - state.listAt) / 1000) : null, lastReason: state.lastReason || '' };
}
// 用户点「重测」：清掉「5 分钟内不再试」和「这个文件上次校验没过」的标记，马上真的去连一次。
function clearDown() { state.unreachableUntil = 0; state.bad.clear(); }

// 内源现在的状态：up（10 分钟内连上过）/ down（5 分钟内连不上过）/ unknown（还没探测）。
function reachability({ now = Date.now } = {}) {
  if (now() < state.unreachableUntil) return 'down';
  if (state.list && now() - state.listAt <= LIST_TTL_MS) return 'up';
  return 'unknown';
}

// 预热：查版本清单时顺手在后台探测内源（不等结果、不报错），真正下载时状态已知，公司外不用再等。
function prewarm({ fetchImpl, api = DEFAULT_API, projectId = PROJECT_ID, timeoutMs = REACH_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  if (!enabled(env) || !api || !projectId || typeof fetchImpl !== 'function' || reachability({ now }) !== 'unknown') return null;
  return loadList({ fetchImpl, api, projectId, timeoutMs, now }).catch(error => {
    markDown(error, now);
    state.lastReason = `内源连不上：${errText(error)}`;
    return null;
  });
}

// 下载用：已知连得上就完整查找；已知连不上直接跳过；未知时最多等 UNKNOWN_BUDGET_MS，没结果先走原源（查找在后台继续）。
// maxMs（r24 审查）：调用方给了总上限时，不论状态已知还是未知，整个查找（列表 + 逐个详情）最多等这么久。
async function findForDownload(args = {}) {
  const now = args.now || Date.now;
  const r = reachability({ now });
  if (r === 'down') { state.lastReason = downText(); return null; }
  const pending = find(args);
  if (r === 'up' && args.maxMs == null) return pending;
  const budget = r === 'up' ? args.maxMs : Math.min(args.unknownBudgetMs ?? UNKNOWN_BUDGET_MS, args.maxMs ?? Infinity);
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), budget); });
  const first = await Promise.race([pending, late]);
  clearTimeout(timer);
  if (first === 'late') {
    pending.catch(() => {});
    state.lastReason = r === 'up' ? `内源 ${budget} 毫秒内没找完，先走原下载源` : `内源状态未知，${budget} 毫秒内没探测完，先走原下载源`;
    return null;
  }
  return first;
}

// 内源附件的大小（r24 审查）：清单没给大小、外网又 HEAD 不到时，用找到的内源附件（含分片）的 Content-Length 之和。
// 这个数只当下载上限，内容最终仍按清单的 sha256 核对。拿不到返回 NaN。
async function headSize(hit, { fetchImpl, signal, timeoutMs = REACH_TIMEOUT_MS } = {}) {
  let total = 0;
  for (const url of (hit && (hit.urls || [hit.url])) || []) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'HEAD', signal: ac.signal, redirect: 'error' });
      const n = Number(res && res.ok && res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
      if (!Number.isSafeInteger(n) || n < 1) return NaN;
      total += n;
    } catch (_) { return NaN; } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  return total || NaN;
}

// 下载或校验没过：本进程内这个文件不再走内源（避免重试时重复下一遍坏文件）。
function markBad(file) { if (file) state.bad.add(String(file).toLowerCase()); }
function lastReason() { return state.lastReason; }
// 更新窗和环境体检共用的只读探测：复用下载器的列表/详情缓存，整体最多等 3 秒。
// 只查目标版本，避免「没有该版本」时逐个查询无关组件的版本详情。
// strict（r56）：成员版只看 member-v<版本>（release 给了就只认这个版本名）；非 strict 的版本名必须以数字开头，member-* 自然排除。
async function probe({ version, file, release, strict = false, fetchImpl, env = process.env, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs = REACH_TIMEOUT_MS, now = Date.now } = {}) {
  const row = { id: 'openx', name: '内源（公司内网）', informational: true, ok: false, version: version || null };
  const fail = reason => ({ ...row, status: 'failed', reason });
  if (!enabled(env)) return { ...row, status: 'off', reason: '内源已关闭' };
  if (!api || !projectId || typeof fetchImpl !== 'function') return fail('未配置内源或网络');
  if (reachability({ now }) === 'down') return fail(state.lastReason.replace(/^内源连不上[：]?/, '') || '稍后再试');
  const budget = Math.min(timeoutMs, REACH_TIMEOUT_MS);
  const deadline = now() + budget;
  let timer;
  const pending = (async () => {
    let list;
    try { list = await loadList({ fetchImpl, api, projectId, timeoutMs: budget, now }); }
    catch (error) {
      markDown(error, now);
      state.lastReason = `内源连不上：${errText(error)}`;
      return fail(errText(error));
    }
    const want = normVersion(version);
    const pattern = strict ? /^member-v(\d+\.\d+\.\d+)(?:\s|$)/i : /^(\d+\.\d+\.\d+)(?:\s|$)/;
    const wantRelease = release ? normVersion(release).toLowerCase() : '';
    const candidates = list.map(r => ({ ...r, appVersion: pattern.exec(normVersion(r.version))?.[1] }))
      .filter(r => r.appVersion && (!want || r.appVersion === want))
      .filter(r => !strict || !wantRelease || (n => n === wantRelease || n.startsWith(wantRelease + ' '))(normVersion(r.version).toLowerCase()))
      .sort((a, b) => require('./manifest').compareVersions(b.appVersion, a.appVersion));
    if (!candidates.length) return { ...row, status: 'missing' };
    if (!file) return { ...row, status: 'ok', ok: true, version: candidates[0].appVersion };
    for (const rec of candidates.slice(0, MAX_DETAIL_QUERIES)) {
      if (now() >= deadline) break;
      let packages = state.details.get(rec.id);
      if (!packages) {
        const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, null, Math.max(1, deadline - now()));
        packages = Array.isArray(data.binaryPackages) ? data.binaryPackages : [];
        state.details.set(rec.id, packages);
      }
      const names = (Array.isArray(file) ? file : [file]).map(f => String(f).toLowerCase());
      if (packages.some(p => p && names.includes(String(p.originalFileName || '').toLowerCase()) && safeUrl(p.url))) {
        return { ...row, status: 'ok', ok: true, version: rec.appVersion };
      }
    }
    return now() >= deadline ? fail(`${budget / 1000} 秒内未完成探测`) : { ...row, status: 'missing' };
  })().catch(error => fail(`版本详情没取到：${error.message}`));
  try {
    return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(fail(`${budget / 1000} 秒内未完成探测`)), budget); })]);
  } finally { clearTimeout(timer); }
}
const releaseName = (kind, version) => `${kind}-${normVersion(version)}`;
const MEMBER_PREFIX = 'member-';
const memberReleaseName = version => `${MEMBER_PREFIX}v${normVersion(version)}`;
const isMemberRelease = name => String(name || '').trim().toLowerCase().startsWith(MEMBER_PREFIX);
function _reset() { state = freshState(); }

module.exports = { diagnostics, clearDown, EDITION_ON, publicOrder, releaseName, memberReleaseName, isMemberRelease, find, findForDownload, headSize, prewarm, probe, reachability, safeUrl, markBad, lastReason, enabled, normVersion, _reset, DEFAULT_API, PROJECT_ID, REACH_TIMEOUT_MS, UNKNOWN_BUDGET_MS };
