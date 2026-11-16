'use strict';
// 公司内源优先（r21，2026-11-16）：在公司电脑上，各组件的大文件先试公司内源（openx 社区上本产品的项目）
// （黄区实测约 24 MB/s，阿里云约 1.2 MB/s）。版本清单照旧从 GitHub / 阿里云取，这里只换「字节从哪儿来」：
// 按文件名在内源的发布版本里找同名附件，下载后仍按清单的大小和 sha256 核对（downloader.js 的 downloadOne）。
// 公司外（在家、外网）连不上内源：3 秒内没回就记下「连不上」，30 分钟内不再试，所以外网用户最多多等一次 3 秒。
// 找不到、校验不对、连不上都静默回到原来的下载源，不报错。
//
// 内源地址与开关在 openx-config.js：只在公开版生效（2026-11-16 定）；成员版关闭，不探测、不下载、不改源顺序，行为和以前完全一样。
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
const UNREACHABLE_TTL_MS = 30 * 60 * 1000;
const LIST_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 30;
const MAX_DETAIL_QUERIES = 8;
// 状态未知（还没探测过）时，下载最多等内源这么久；没结果就先走原源，探测在后台继续，供下一次下载用。
const UNKNOWN_BUDGET_MS = 500;

let state = freshState();
function freshState() {
  return { unreachableUntil: 0, list: null, listAt: 0, listing: null, details: new Map(), bad: new Set(), lastReason: '' };
}

// 只在公开版的 Hub 程序（Electron）里默认开；成员版默认关（只走外网），纯 Node 跑的单测和脚本也不碰。
// AI_HUB_OPENX=0 任何版本都关（排查用）；=1 强制开（单测与排查用）。
function enabled(env = process.env, versions = process.versions, editionOn = EDITION_ON) {
  const v = String(env.AI_HUB_OPENX || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !!editionOn && !!(versions && versions.electron);
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
async function find({ file, version, fetchImpl, signal, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs = REACH_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  const miss = reason => { state.lastReason = reason; return null; };
  if (!enabled(env)) return miss('未启用');
  if (!api || !projectId) return miss('未配置内源');
  if (!file || typeof fetchImpl !== 'function') return miss('没有文件名或网络');
  const key = String(file).toLowerCase();
  if (state.bad.has(key)) return miss('这个文件上次在内源校验没过');
  if (now() < state.unreachableUntil) return miss('内源连不上（稍后再试）');
  const unreachable = error => {
    if (signal && signal.aborted) return miss('已取消');
    state.unreachableUntil = now() + UNREACHABLE_TTL_MS;
    return miss(`内源连不上：${error && error.message ? error.message : error}`);
  };
  try { await loadList({ fetchImpl, api, projectId, timeoutMs, now }); } catch (error) { return unreachable(error); }

  // 版本号对得上的先查，其余按发布时间从新到旧；最多再查 MAX_DETAIL_QUERIES 个没缓存过的版本。
  const want = normVersion(version);
  const time = r => Date.parse(r.releaseTime || '') || 0;
  const ordered = [...state.list].sort((a, b) =>
    (normVersion(b.version) === want) - (normVersion(a.version) === want) || time(b) - time(a));
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
      } catch (error) { return unreachable(error); }
    }
    const hit = packages.find(p => p && String(p.originalFileName || '').toLowerCase() === key && safeUrl(p.url));
    if (hit) return { url: safeUrl(hit.url), releaseId: rec.id, releaseVersion: String(rec.version || '') };
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

// 内源现在的状态：up（10 分钟内连上过）/ down（30 分钟内连不上过）/ unknown（还没探测）。
function reachability({ now = Date.now } = {}) {
  if (now() < state.unreachableUntil) return 'down';
  if (state.list && now() - state.listAt <= LIST_TTL_MS) return 'up';
  return 'unknown';
}

// 预热：查版本清单时顺手在后台探测内源（不等结果、不报错），真正下载时状态已知，公司外不用再等。
function prewarm({ fetchImpl, api = DEFAULT_API, projectId = PROJECT_ID, timeoutMs = REACH_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  if (!enabled(env) || !api || !projectId || typeof fetchImpl !== 'function' || reachability({ now }) !== 'unknown') return null;
  return loadList({ fetchImpl, api, projectId, timeoutMs, now }).catch(error => {
    state.unreachableUntil = now() + UNREACHABLE_TTL_MS;
    state.lastReason = `内源连不上：${error && error.message ? error.message : error}`;
    return null;
  });
}

// 下载用：已知连得上就完整查找；已知连不上直接跳过；未知时最多等 UNKNOWN_BUDGET_MS，没结果先走原源（查找在后台继续）。
async function findForDownload(args = {}) {
  const now = args.now || Date.now;
  const r = reachability({ now });
  if (r === 'down') { state.lastReason = '内源连不上（稍后再试）'; return null; }
  const pending = find(args);
  if (r === 'up') return pending;
  const budget = args.unknownBudgetMs ?? UNKNOWN_BUDGET_MS;
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve('late'), budget); });
  const first = await Promise.race([pending, late]);
  clearTimeout(timer);
  if (first === 'late') {
    pending.catch(() => {});
    state.lastReason = `内源状态未知，${budget} 毫秒内没探测完，先走原下载源`;
    return null;
  }
  return first;
}

// 下载或校验没过：本进程内这个文件不再走内源（避免重试时重复下一遍坏文件）。
function markBad(file) { if (file) state.bad.add(String(file).toLowerCase()); }
function lastReason() { return state.lastReason; }
function _reset() { state = freshState(); }

module.exports = { EDITION_ON, find, findForDownload, prewarm, reachability, safeUrl, markBad, lastReason, enabled, normVersion, _reset, DEFAULT_API, PROJECT_ID, REACH_TIMEOUT_MS, UNKNOWN_BUDGET_MS };
