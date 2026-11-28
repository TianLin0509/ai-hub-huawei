'use strict';
// 公司内源优先（r21，2026-11-16）：在公司电脑上，各组件的大文件先试公司内源（openx 社区上本产品的项目）
// （黄区实测约 24 MB/s，阿里云约 1.2 MB/s）。版本清单照旧从 GitHub / 阿里云取，这里只换「字节从哪儿来」：
// 按文件名在内源的发布版本里找同名附件，下载后仍按清单的大小和 sha256 核对（downloader.js 的 downloadOne）。
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
const signing = require('./manifest-signing');
const DEFAULT_API = CONFIG ? CONFIG.api : '';
const PROJECT_ID = CONFIG ? CONFIG.projectId : 0;
// 只接受内源自己域名下的 https 附件地址：防止接口返回的地址把下载带到别处（内容另有 sha256 兜底）。
// R55（2026-11-27）：内源「版本列表」接口（by_project_id）改为要求登录，匿名请求回 HTTP 200 + {code:"401",message:"未认证的请求"}（全站所有项目都这样），
// 而「单个版本详情」（by_id）和附件下载匿名照常。列表拿不到时，改读一个固定的「版本索引」发布（indexReleaseId，按 by_id 匿名可读）：
// 它的描述里在「#hub-index v1」一行之后每行一个版本「<id> <版本名> [发布时间]」，由发版流水线每次发布后更新（新的在前）。
// 没配置索引、索引也读不到时，如实说「内源要求登录」，不再说成连不上、也不让用户去查网络。
const INDEX_RELEASE_ID = CONFIG && Number(CONFIG.indexReleaseId) > 0 ? Number(CONFIG.indexReleaseId) : 0;
// 测试与排查用（R55）：AI_HUB_OPENX_INDEX_ID 换成别的索引 id（如 E2E 的本机假内源）；正式运行不设。
const indexIdFromEnv = (env = process.env) => (Number(env.AI_HUB_OPENX_INDEX_ID) > 0 ? Number(env.AI_HUB_OPENX_INDEX_ID) : 0);
// 显式覆盖：没设或写错返回 null（用配置里的 id）；写 0 表示关掉索引（E2E 测「无索引 → 列表要求登录」用）。
const indexOverrideFromEnv = (env = process.env) => {
  const raw = String(env.AI_HUB_OPENX_INDEX_ID == null ? '' : env.AI_HUB_OPENX_INDEX_ID).trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
};
const INDEX_MARK = '#hub-index v1';
const ALLOWED_HOST = (() => { try { return CONFIG ? new URL(CONFIG.fileSite).hostname.toLowerCase() : ''; } catch (_) { return ''; } })();
// 本版本是否启用内源：公开版 true，成员版 false（见 openx-config.js）。
const EDITION_ON = !!(CONFIG && CONFIG.enabledInEdition);
const REACH_TIMEOUT_MS = 3000;
// 列表都取不到才算「连不上」；一次慢响应不该让内源停用太久（r44 审查）：5 分钟后再试。
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
const LIST_TTL_MS = 10 * 60 * 1000;
// 版本列表分页取（R44，2026-11-25）：公司电脑实测一页 100 条要 2.6–3.5 秒（11-18 还约 1 秒，版本越发越多）、一页 20 条约 0.6 秒，
// 而且列表已有 104 条，原来只取 1 页 100 条会漏掉最老的几版（组件版本可能就在里面）。改为：
//   第 1 页 20 条单独缓存（state.head）——查清单、探测、程序更新包在这一页里就能命中；
//   要完整列表时（组件版本、找完整安装包、版本回退）先拿第 1 页知道总数，其余各页（每页 20 条）小并发一起取，拼成全量。
const LIST_PAGE_SIZE = 20;
const LIST_MAX_PAGES = 30;
const LIST_CONCURRENCY = 6;
const LIST_TIMEOUT_MS = 8000;
const MAX_DETAIL_QUERIES = 8;
// 状态未知（还没探测过，或上次探测已过 10 分钟）时，下载最多等内源这么久；没结果就先走原源，探测在后台继续，供下一次下载用。
// 2026-11-18 公司电脑实测：内源版本列表一次约 0.9–1.05 秒、详情约 0.12 秒。原来只等 0.5 秒，在公司里几乎总是等不到，
// 组件下载于是落回 GitHub（同事反馈「还是优先 GitHub」）。改为与探测超时相同的 3 秒：公司里稳定命中内源；
// 公司外最多多等一次 3 秒，随后标记连不上 5 分钟，期间直接走原源。
const UNKNOWN_BUDGET_MS = REACH_TIMEOUT_MS;

let state = freshState();
function freshState() {
  return { unreachableUntil: 0, list: null, listAt: 0, listing: null, head: null, headTotal: 0, headAt: 0, heading: null, okAt: 0, listPartialReason: '',
    projectName: '', details: new Map(), bad: new Set(), lastReason: '', indexMode: false, indexId: indexOverrideFromEnv() ?? INDEX_RELEASE_ID, localVersion: '',
    loginMode: false, loginTry: null, loginInfo: null, loginWants: new Set(), detailTries: new Map() };
}

// R63（2026-11-28）：第三条路——版本索引读不到（或过期）、匿名列表又要求登录时，借本人 Edge 的登录查一次版本列表。
// 真正开无头 Edge 的实现在 main/openx-login-list.js（Hub 主进程注入，见 setLoginLister）；这里只管什么时候用、结果怎么并进现有的列表处理。
// 平时不开 Edge；同一轮检查只开一次（loginTry 共用一个结果）：查到了的 10 分钟（LIST_TTL_MS）、没查到的 LOGIN_REUSE_MS 内复用，
// 用户手动「检查更新」时（clearDown({ relogin:true })）作废已结束的那次、真的再试；本机没有 Edge 这类重试也没用的失败，一直复用到下次手动检查。
const LOGIN_REUSE_MS = 2 * 60 * 1000;
const LOGIN_BUDGET_MS = 15000;
const LOGIN_TAIL_MS = 5000;
let loginLister = null;
function setLoginLister(fn) { loginLister = typeof fn === 'function' ? fn : null; }
function listViaLogin({ projectId, onLogin, now = Date.now }) {
  const t = state.loginTry;
  // 审查 P2：查到了的按列表缓存时长（10 分钟）复用，查到新版后过几分钟再点下载不用再开一次；没查到的 2 分钟。
  const reusable = !!t && (!t.settled || t.permanent || now() - t.at <= (t.ok ? LIST_TTL_MS : LOGIN_REUSE_MS));
  if (!reusable && !loginLister) return Promise.resolve({ ok: false, reason: '没有可用的 Edge 登录查询' });
  // 要等登录这一步（新开或在途）时告诉调用方加预算；已有结果直接复用，不加。
  if (!(reusable && t.settled) && typeof onLogin === 'function') { try { onLogin(LOGIN_BUDGET_MS); } catch (_) {} }
  if (reusable) return t.promise;
  const lister = loginLister;
  const startedAt = now();
  const entry = { at: startedAt, settled: false, ok: false, permanent: false, promise: null };
  // P0（2026-11-28 黄区实测）：内源 by_id 也要求登录后，组件（ppt-doctor-*、room-runtime-* 等）的附件详情匿名拿不到。
  // 同一轮里正在找的组件版本名（find 记下的 want）一并交给页面脚本，在同一个无头 Edge 会话里顺带取它们的详情。
  const want = [...state.loginWants].slice(0, 8);
  entry.promise = Promise.resolve()
    .then(() => lister({ projectId, timeoutMs: LOGIN_BUDGET_MS, want }))
    .then(normalizeLoginResult, error => ({ ok: false, reason: errText(error) || '借 Edge 登录查询出错' }))
    .then(r => {
      entry.settled = true; entry.at = now(); entry.ok = !!r.ok; entry.permanent = !r.ok && !!r.permanent;
      state.loginInfo = { ok: r.ok, at: new Date(now()).toISOString(), tookMs: now() - startedAt, records: r.ok ? r.records.length : 0, reason: r.ok ? '' : r.reason };
      return r;
    });
  state.loginTry = entry;
  return entry.promise;
}
function normalizeLoginResult(r) {
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || '没查到').slice(0, 120), permanent: !!(r && r.permanent) };
  const records = (Array.isArray(r.records) ? r.records : []).filter(x => x && x.id != null)
    .map(x => ({ id: x.id, version: String(x.version || ''), releaseTime: String(x.releaseTime || '') }));
  if (!records.length) return { ok: false, reason: '登录后的版本列表是空的' };
  const details = (Array.isArray(r.details) ? r.details : []).filter(d => d && d.id != null && Array.isArray(d.binaryPackages));
  return { ok: true, records, details, name: typeof r.name === 'string' ? r.name.trim() : '' };
}
// 登录查到的列表当全量用（一次取够，像版本索引一样之后不再翻页）；顺带取回的版本详情放进详情缓存，by_id 也被收紧时照样能找附件。
function useLoginList(r) {
  state.loginMode = true; state.indexMode = false;
  if (r.name) state.projectName = r.name; else if (!state.projectName) state.projectName = projectSlugFromConfig();
  for (const d of r.details) {
    const rec = r.records.find(x => String(x.id) === String(d.id));
    state.details.set(rec ? rec.id : d.id, packagesOf(d, rec || d));
  }
  return { records: r.records, total: r.records.length, login: true };
}
// 已有的登录结果里没有这一版的详情（例如 10 分钟内先查过程序更新、再装组件），匿名 by_id 又要求登录：
// 再借一次 Edge 登录只取这一版的详情。同一个版本同一时刻只开一次，结果按 LOGIN_REUSE_MS 复用（没取到的也是，免得反复开 Edge）。
function detailViaLogin({ projectId, rec, now = Date.now }) {
  const key = String(rec.id), t = state.detailTries.get(key);
  if (t && (!t.settled || now() - t.at <= LOGIN_REUSE_MS)) return t.promise;
  if (!loginLister) return Promise.resolve(null);
  const lister = loginLister;
  const entry = { at: now(), settled: false, promise: null };
  entry.promise = Promise.resolve()
    .then(() => lister({ projectId, timeoutMs: LOGIN_BUDGET_MS, want: [normVersion(rec.version)], detailIds: [rec.id] }))
    .then(normalizeLoginResult, error => ({ ok: false, reason: errText(error) || '借 Edge 登录查询出错' }))
    .then(r => {
      entry.settled = true; entry.at = now();
      if (!r.ok) return null;
      const d = r.details.find(x => String(x.id) === key);
      if (!d) return null;
      const packages = packagesOf(d, rec);
      state.details.set(rec.id, packages);
      return packages;
    });
  state.detailTries.set(key, entry);
  return entry.promise;
}
function loginFailedError(base, reason) {
  const error = new Error(`${errText(base)}；借 Edge 登录也没查到：${reason}`);
  error.authRequired = true; error.loginTried = true;
  return error;
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
// 内源没有、连不上都直接报原因。不生效只有两种测试情形：纯 Node 跑的单测与脚本（enabled 为假），
// 以及测试用 AI_HUB_UPDATE_SOURCES 把源换成本机服务——这时按测试给的源走。
function active(env = process.env, versions = process.versions) {
  return !env.AI_HUB_UPDATE_SOURCES && enabled(env, versions);
}
// 只走内源时给用户看的失败原因：写清是哪种问题、下一步做什么（不再建议去别处下载）。
const NETWORK_HINT = '请确认电脑连着公司网络（公司内网或 VPN）后重试';
// R55：内源接口要求登录（不是网络问题，重试也没用）——给用户的一句话和下一步。
const AUTH_TEXT = what => `公司内源的版本查询接口现在要求登录，Hub 暂时自动查不到${what}（内源返回「未认证的请求」，不是网络问题，重试也没用）。可以先在浏览器里打开内源项目页手动下载安装；请点「一键反馈」告诉维护人`;
function userReason(reason, { file = '', what = '' } = {}) {
  const raw = String(reason || '').trim();
  if (/已取消/.test(raw)) return '已取消';
  if (/要求登录|未认证/.test(raw)) {
    const base = AUTH_TEXT(what || (file === '版本清单' ? '新版本' : file ? `「${file}」` : '这个包'));
    // R63：借 Edge 登录也试过了还没查到——补一句用户下一步能做的事。
    const m = /借 Edge 登录也没查到：(.+)$/.exec(raw);
    return m ? `${base}。Hub 也试过借本机 Edge 的登录去查，没成（${m[1].replace(/（5 分钟内自动重试）$/, '')}）：请在 Edge 里登录一次内源（打开内源项目页能看到自己的名字即可），再点「检查更新」` : base;
  }
  // 清单读到了但签名缺失 / 不对 / 版本对不上：内源是连着的，不提示查网络（R29 审查 #3）。
  if (/没有签名|签名不对|没有通过签名校验|附带的清单|主版本跳得太多/.test(raw)) return `公司内源上的版本清单还在同步签名或没通过校验（${raw}），请稍后再试，或点下方「下载完整安装包」；一直如此请点「一键反馈」`;
  // 2026-11-28 黄区压测：公司安全网关（HIS）拦截时内源接口回的是 HTML 确认页，JSON 解析报「Unexpected token '<'」，
  // 原来落到「连不上…请确认连着公司网络」，用户网络其实是通的。
  if (/<!DOCTYPE|<html|Unexpected token '?<|is not valid JSON|网络确认页/i.test(raw)) return `公司内源的请求被公司网络安全网关（HIS）拦下了，返回的是一张确认页。请在浏览器打开公司内源项目页${CONFIG && CONFIG.projectPage ? `（${CONFIG.projectPage}）` : ''}，按页面提示确认访问后，回到这里点重试`;
  if (/未启用|已关闭/.test(raw)) return '公司内源已关闭（排查开关 AI_HUB_OPENX=0），去掉这个开关后重启 Hub 再试';
  if (/没有这个文件|没有该版本|HTTP 404|还没有附带版本清单|还没有程序版本|没找到|没有比当前更新/.test(raw)) return `公司内源上暂时没有${file ? `「${file}」` : '这个包'}，可能还在同步，请过几分钟再试；一直没有请点「一键反馈」告诉维护人`;
  if (/校验/.test(raw)) return `从公司内源下载的${file ? `「${file}」` : '文件'}校验没通过，已丢弃，请重试；反复出现请点「一键反馈」`;
  if (/连不上|超时|没响应|HTTP|ENOTFOUND|ECONN|net::ERR_|网络|DNS|fetch failed|证书|代理|秒内/.test(raw) || !raw) return `连不上公司内源${raw ? `（${raw.replace(/^内源连不上[：:]?/, '').replace(/（5 分钟内自动重试）$/, '')}）` : ''}。${NETWORK_HINT}`;
  return `从公司内源下载没有完成（${raw}）。${NETWORK_HINT}`;
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
    // HTTP 401/403：只有回的是内源自己的 JSON 才算「要求登录」；公司代理的拦截 / 确认页也可能是 403（网页），按原来的 HTTP 错误处理。
    if (response && (response.status === 401 || response.status === 403)) {
      let body = null;
      try { body = JSON.parse(String(await response.text()).trim()); } catch (_) {}
      if (body && typeof body === 'object') throw authError(response.status, body.message);
      throw new Error(`openx 返回 HTTP ${response.status}`);
    }
    if (!response || !response.ok) throw new Error(`openx 返回 HTTP ${response && response.status}`);
    const body = JSON.parse(String(await response.text()).trim());
    // R55：接口回 code 401/403（未认证 / 无权限）时内源是连得上的，单独标出来，界面不说「连不上」。
    if (body && /^(401|403)$/.test(String(body.code))) throw authError(body.code, body.message);
    if (!body || String(body.code) !== '0' || !body.data) throw new Error('openx 返回内容不对');
    return body.data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function authError(code, message) {
  const msg = String(message || '').trim().slice(0, 60);
  const error = new Error(`内源要求登录（接口返回 ${code}${msg ? ' ' + msg : ''}）`);
  error.authRequired = true;
  return error;
}
const isAuthError = error => !!(error && error.authRequired);
// 失败原因的统一写法：要求登录的照实说，其余才是「连不上」。
const failText = error => (isAuthError(error) ? errText(error) : `内源连不上：${errText(error)}`);

// 版本索引（R55）：描述里「#hub-index v1」之后每行「<id> <版本名> [ISO 发布时间]」，新的在前；版本名可以带空格（如「v5.6.34 更新包」）。
function parseIndex(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex(l => l.trim() === INDEX_MARK);
  if (at < 0) return [];
  const seen = new Set();
  const out = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^\s*(\d+)\s+(.+?)(?:\s+(\d{4}-\d\d-\d\d(?:[T ][\d:.]+)?(?:Z|[+-]\d\d:?\d\d)?))?\s*$/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: Number(m[1]), version: m[2], releaseTime: m[3] || '' });
  }
  return out;
}
async function loadIndex({ fetchImpl, api, timeoutMs, signal = null, indexId = INDEX_RELEASE_ID }) {
  const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(indexId)}`, signal, timeoutMs);
  const records = parseIndex(data.description);
  if (!records.length) throw new Error('内源版本索引是空的或格式不对');
  return records;
}

// 审查 P2-4：by_id 回的版本名和索引 / 列表里的对不上（索引 id 填错、串到别的版本或 member-*）就当这一版没有附件，不串版。
// by_id 没回版本名时（旧接口、测试夹具）不核对。
function packagesOf(data, rec) {
  const got = data && data.version != null ? normVersion(data.version).toLowerCase() : '';
  if (got && rec && rec.version != null && got !== normVersion(rec.version).toLowerCase()) return [];
  return Array.isArray(data && data.binaryPackages) ? data.binaryPackages : [];
}

function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' && ALLOWED_HOST && (url.hostname === ALLOWED_HOST || url.hostname.endsWith('.' + ALLOWED_HOST)) ? url.href : '';
  } catch (_) { return ''; }
}

// 在 openx 上按文件名找附件。找到返回 { url, releaseId, releaseVersion }，否则返回 null（原因记在 lastReason）。
// timeoutMs 不传时：列表 8 秒（LIST_TIMEOUT_MS）、单个详情 3 秒；传了（单测、排查）就都按传的来。
async function find({ file, version, release, strict = false, fetchImpl, signal, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs: givenTimeoutMs, env = process.env, now = Date.now } = {}) {
  const timeoutMs = givenTimeoutMs || REACH_TIMEOUT_MS;
  const listTimeoutMs = givenTimeoutMs || LIST_TIMEOUT_MS;
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
    return miss(failText(error));
  };
  const want = normVersion(release || version);
  if (want) state.loginWants.add(want);   // 要借 Edge 登录查列表时，在同一个会话里顺带取这一版的详情
  let records;
  try { records = await loadHead({ fetchImpl, api, projectId, timeoutMs: listTimeoutMs, now }); } catch (error) { return unreachable(error); }

  // 版本名对得上的先查，其余按发布时间从新到旧；最多再查 MAX_DETAIL_QUERIES 个没缓存过的版本。
  // release（r24）：组件在内源上的专属版本名（如 room-runtime-2.1.0，见 releaseName），优先于组件自身的版本号；
  // 「<版本名> 后缀」（如 r21 的「v5.6.34 更新包」、日后重发）也算对得上。
  const same = r => { const n = normVersion(r.version); return n === want || n.startsWith(want + ' '); };
  const time = r => Date.parse(r.releaseTime || '') || 0;
  // 成员版程序包（r56，2026-11-19）：内源上以 member-v<版本> 单独成版（文件名与公开版相同、内容不同），
  // strict 时只查这一个版本，不往别的版本里找；不带 strict 的查找（公开版程序包、各组件）永远跳过 member-* 版本。
  // R44：先只看第 1 页（最近 20 个版本）；里面没有版本名对得上的（组件的老版本等），再取完整列表。
  if (state.list && now() - state.listAt <= LIST_TTL_MS) records = state.list;
  else if (!records.some(r => same(r) && (strict || !isMemberRelease(r.version)))) {
    try { records = await loadList({ fetchImpl, api, projectId, timeoutMs: listTimeoutMs, now }); }
    catch (error) {
      if (signal && signal.aborted) return miss('已取消');
      // 第 1 页刚取到，说明内源是通的：其余页没取到只放弃这一次查找，不标成连不上。
      return miss(`内源版本列表没取全：${errText(error)}`);
    }
    // 有几页没取到、取到的部分里又没有这个版本：如实说「没取全」，不去盲查无关版本、也不报「内源上没有这个文件」（R44 审查 P1-2）。
    if (state.listPartialReason && !records.some(r => same(r) && (strict || !isMemberRelease(r.version)))) {
      return miss(`内源版本列表没取全：${state.listPartialReason}`);
    }
  }
  const ordered = [...records].filter(r => strict ? same(r) : !isMemberRelease(r.version))
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
        packages = packagesOf(data, rec);
        state.details.set(rec.id, packages);
      } catch (error) {
        // 列表能取到说明内源是通的：单个版本详情超时或出错只放弃这一次查找，不把整个内源标成连不上（r44 审查）。
        if (signal && signal.aborted) return miss('已取消');
        // P0：by_id 要求登录时借 Edge 登录取这一版的详情（组件首装与更新；程序版本的详情 R63 已在列表那一趟取过）。
        if (isAuthError(error) && loginLister) packages = await detailViaLogin({ projectId, rec, now }).catch(() => null);
        if (!packages) {
          const tail = isAuthError(error) && loginLister ? '；借 Edge 登录也没取到这一版的详情' : '';
          return miss(`内源版本详情没取到：${error && error.message ? error.message : error}${tail}`);
        }
      }
    }
    const hit = packages.find(p => p && String(p.originalFileName || '').toLowerCase() === key && safeUrl(p.url));
    if (hit) {
      return {
        url: safeUrl(hit.url),
        projectId,
        releaseId: rec.id,
        releaseVersion: String(rec.version || ''),
        packageId: hit.id != null ? hit.id : null,
        packageTag: String(hit.tag || ''),
        urlSource: hit.urlSource != null ? hit.urlSource : null,
        projectName: state.projectName || '',
      };
    }
    // 分片（r24）：内源单个附件有大小上限（600 MB 的 PPT Doctor 被拒），大文件按 <文件名>.000、.001… 放在同一个版本里。
    const parts = [];
    let firstPart = null;
    for (let i = 0; i < 100; i++) {
      const name = `${key}.${String(i).padStart(3, '0')}`;
      const p = packages.find(x => x && String(x.originalFileName || '').toLowerCase() === name && safeUrl(x.url));
      if (!p) break;
      if (!firstPart) firstPart = p;
      parts.push(safeUrl(p.url));
    }
    if (parts.length) {
      return {
        url: parts[0],
        urls: parts,
        projectId,
        releaseId: rec.id,
        releaseVersion: String(rec.version || ''),
        packageId: firstPart && firstPart.id != null ? firstPart.id : null,
        packageTag: String((firstPart && firstPart.tag) || ''),
        urlSource: firstPart && firstPart.urlSource != null ? firstPart.urlSource : null,
        projectName: state.projectName || '',
      };
    }
  }
  return miss('内源上没有这个文件');
}

// 版本列表的一页（接口按发布时间从新到旧）。返回 { records, total }。
// R55（2026-11-27 负责人定「索引优先」）：第 1 页先读版本索引（一次 by_id 就是全量，state.indexMode 置位，之后不再翻页）。
//   索引读不到 → 照旧读匿名列表；列表也要求登录 → 报「要求登录 + 索引为什么没读到」；列表是网络错误 → 按网络错误报（不在公司网络照常快判）。
//   索引读到了、但里面最新的程序版本比本机还旧或没有程序版本（防索引没跟上发版）→ 顺手再试一次匿名列表，列表拿不到（401 等）就以索引为准。
// 没配索引（id 为 0）时只读列表，列表要求登录照实报。
const appVersionOf = r => /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(normVersion(r && r.version))?.[1] || '';
function indexLooksStale(records) {
  const { compareVersions } = require('./manifest');
  const apps = records.map(appVersionOf).filter(Boolean);
  if (!apps.length) return true;
  const top = apps.sort((a, b) => compareVersions(b, a))[0];
  // 审查 P1-3 ①：索引里没有比本机更新的版本（<=）就顺手试一次列表——发版漏更索引、列表又恢复匿名时也能查到新版。
  return !!state.localVersion && compareVersions(top, normVersion(state.localVersion)) <= 0;
}
function projectSlugFromConfig() {
  try { return decodeURIComponent(new URL(CONFIG.projectPage).pathname.split('/').filter(Boolean)[0] || ''); } catch (_) { return ''; }
}
async function listPage({ fetchImpl, api, projectId, page, timeoutMs, signal = null, indexId = state.indexId, onLogin = null, now = Date.now }) {
  if ((state.indexMode || state.loginMode) && page > 1) return { records: [], total: 0 };
  let indexError = null;
  if (page === 1 && indexId) {
    try {
      const records = await loadIndex({ fetchImpl, api, timeoutMs, signal, indexId });
      const useIndex = () => {
        state.indexMode = true;
        if (!state.projectName) state.projectName = projectSlugFromConfig();
        return { records, total: records.length, index: true };
      };
      if (!indexLooksStale(records)) return useIndex();
      try { return await listOnly({ fetchImpl, api, projectId, page, timeoutMs, signal }); }
      catch (error) {
        // R63：索引里一个程序版本都没有（明显不对）、列表又要求登录 → 借 Edge 登录查一次；没查到就以索引为准。
        // 审查 P1：索引里有程序版本、只是不比本机新（本机已是最新版的常态）时不开 Edge，直接以索引为准。
        if (isAuthError(error) && !records.some(appVersionOf) && !(signal && signal.aborted) && (loginLister || state.loginTry)) {
          const r = await listViaLogin({ projectId, onLogin, now });
          if (r.ok) return useLoginList(r);
        }
        return useIndex();
      }
    } catch (error) {
      // 审查 P1-3 ②：外部取消、离线（域名解析不到、连接被拒等）、超时都直接按原样报，不再向同一个站点请求列表（免得等两遍）。
      if ((signal && signal.aborted) || isOfflineError(error) || isTimeoutError(error) || (error && error.name === 'AbortError')) throw error;
      indexError = error;
    }
  }
  try { return await listOnly({ fetchImpl, api, projectId, page, timeoutMs, signal }); }
  catch (error) {
    const base = indexError && isAuthError(error) && !isAuthError(indexError) ? authError('401', `未认证的请求；版本索引也没读到：${errText(indexError)}`) : error;
    // R63：索引读不到、匿名列表要求登录 → 第三步借 Edge 登录查列表（没注入时，如纯 Node 单测与脚本，照旧报原因）。
    if (page === 1 && isAuthError(error) && !(signal && signal.aborted) && (loginLister || state.loginTry)) {
      const r = await listViaLogin({ projectId, onLogin, now });
      if (r.ok) return useLoginList(r);
      throw loginFailedError(base, r.reason);
    }
    throw base;
  }
}
async function listOnly({ fetchImpl, api, projectId, page, timeoutMs, signal }) {
  const data = await getJson(fetchImpl, `${api}by_project_id?projectId=${projectId}&currentPage=${page}&pageSize=${LIST_PAGE_SIZE}`, signal, timeoutMs);
  if (page === 1) { state.indexMode = false; state.loginMode = false; }
  if (!Array.isArray(data.records)) throw new Error('openx 版本列表格式不对');
  if (typeof data.name === 'string' && data.name.trim()) state.projectName = data.name.trim();
  return { records: data.records.filter(r => r && r.id != null), total: Number(data.total) || 0 };
}
// 本机版本（控制器创建时告诉这里），用来判断索引是不是没跟上。
function setLocalVersion(version) { state.localVersion = normVersion(version); }
function keepHead(page, now) {
  state.head = page.records; state.headTotal = page.total; state.headAt = now(); state.okAt = now();
  return state.head;
}
// 第 1 页（最近 20 个版本）：同一时刻只发一次请求，成功后 10 分钟内复用；完整列表还新鲜时直接用完整列表。
async function loadHead({ fetchImpl, api, projectId, timeoutMs, now }) {
  if (state.list && now() - state.listAt <= LIST_TTL_MS) return state.list;
  if (state.head && now() - state.headAt <= LIST_TTL_MS) return state.head;
  if (!state.heading) {
    state.heading = listPage({ fetchImpl, api, projectId, page: 1, timeoutMs, now }).then(p => keepHead(p, now))
      .finally(() => { state.heading = null; });
  }
  return state.heading;
}
// 第 1 页之后可能还有：有总数按总数判断；接口没给总数时，第 1 页满一页就当可能还有。
const moreAfterHead = head => (state.headTotal ? state.headTotal > head.length : head.length >= LIST_PAGE_SIZE);
// 完整版本列表：第 1 页拿到总数后，其余各页小并发一起取（R44）；同一时刻只发一次，取齐后 10 分钟内复用（预热、下载、回退共用）。
// 接口没给总数（data.total）时逐页往后翻，直到某页不满 LIST_PAGE_SIZE 条。
// 某几页没取到（R44 审查 P1-2）：这一次照样返回已取到的部分，原因记在 state.listPartialReason 给调用方判断；不写进共享缓存，下次重取。
async function loadList({ fetchImpl, api, projectId, timeoutMs, now }) {
  if (state.list && now() - state.listAt <= LIST_TTL_MS) return state.list;
  if (!state.listing) {
    state.listing = (async () => {
      const first = state.head && now() - state.headAt <= LIST_TTL_MS ? state.head
        : keepHead(await listPage({ fetchImpl, api, projectId, page: 1, timeoutMs, now }), now);
      const got = new Map();
      let partial = '';
      if (state.indexMode || state.loginMode) { /* 版本索引、借 Edge 登录查到的列表一次就是全量（R55 / R63），不再翻页 */ }
      else if (state.headTotal) {
        const pages = Math.min(LIST_MAX_PAGES, Math.ceil(state.headTotal / LIST_PAGE_SIZE));
        const queue = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2);
        await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, queue.length) }, async () => {
          while (queue.length) {
            const n = queue.shift();
            try { got.set(n, (await listPage({ fetchImpl, api, projectId, page: n, timeoutMs })).records); }
            catch (error) { partial = partial || `第 ${n} 页：${errText(error)}`; }
          }
        }));
      } else if (first.length >= LIST_PAGE_SIZE) {
        for (let n = 2; n <= LIST_MAX_PAGES; n++) {
          let records;
          try { records = (await listPage({ fetchImpl, api, projectId, page: n, timeoutMs })).records; }
          catch (error) { partial = `第 ${n} 页：${errText(error)}`; break; }
          got.set(n, records);
          if (records.length < LIST_PAGE_SIZE) break;
        }
      }
      const seen = new Set();
      const all = [first, ...[...got.keys()].sort((a, b) => a - b).map(n => got.get(n))].flat()
        .filter(r => !seen.has(String(r.id)) && seen.add(String(r.id)));
      state.listPartialReason = partial;
      state.okAt = now();
      if (!partial) { state.list = all; state.listAt = now(); }
      return all;
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
// R44（2026-11-25）：明显不在公司网络的失败——域名解析不到、连接立刻被拒 / 被关 / 被重置、代理建不起隧道、本机断网。
// 这类失败界面用灰色说明「不在公司网络」，不当成故障；超时、HTTP 错误、证书问题不算（可能是在公司但内源慢或出错）。
const OFFLINE_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_CONNECTION_(CLOSED|REFUSED|RESET|FAILED)|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NETWORK_CHANGED/;
// 代理类（本机代理连不上、代理不给建隧道、连接被拒）：同样按「不在公司网络」显示，但提示里补一句可能是本机代理没放行公司内网。
const PROXY_RE = /ERR_PROXY_|ERR_TUNNEL_|ECONNREFUSED/;
function errCodes(error) {
  const code = error.code || (error.cause && error.cause.code) || '';
  return `${code} ${error.message || ''} ${error.cause && error.cause.message ? error.cause.message : ''}`;
}
const TIMEOUT_RE = /ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|TimeoutError/;
function isTimeoutError(error) { return !!error && (error.name === 'TimeoutError' || TIMEOUT_RE.test(errCodes(error))); }
function isProxyError(error) { return !!error && PROXY_RE.test(errCodes(error)); }
function isOfflineError(error) {
  if (!error) return false;
  const code = error.code || (error.cause && error.cause.code) || '';
  return OFFLINE_RE.test(`${code} ${error.message || ''} ${error.cause && error.cause.message ? error.cause.message : ''}`);
}
function markDown(error, now = Date.now) {
  state.unreachableUntil = now() + UNREACHABLE_TTL_MS;
  state.down = { reason: errText(error), at: now(), offline: isOfflineError(error), proxy: isProxyError(error), auth: isAuthError(error) };
}
function downText() {
  if (state.down && state.down.auth) return `${state.down.reason}（5 分钟内自动重试）`;
  return state.down && state.down.reason ? `内源连不上：${state.down.reason}（5 分钟内自动重试）` : '内源连不上（稍后再试）';
}
// 排错信息（给界面「复制排错信息」用）：状态、最近一次失败原因和时间。不含地址与凭据。
function diagnostics({ now = Date.now } = {}) {
  return { reachability: reachability({ now }), down: state.down || null,
    listAgeSec: state.okAt ? Math.round((now() - state.okAt) / 1000) : null, lastReason: state.lastReason || '', login: state.loginInfo || null };
}
// 用户点「重测」：清掉「5 分钟内不再试」和「这个文件上次校验没过」的标记，马上真的去连一次。
// 2026-11-25：用户手动「检查更新」时同时作废版本列表缓存（原先要等 10 分钟，补传清单后仍查不到新版）。
// R63：relogin（用户手动检查更新）时也作废已结束的那次 Edge 登录查询、真的再试；在途的那次不打断，接着用它的结果。
function clearDown({ relogin = false } = {}) {
  state.unreachableUntil = 0; state.bad.clear(); state.listAt = 0; state.headAt = 0; state.okAt = 0;
  if (relogin && state.loginTry && state.loginTry.settled) state.loginTry = null;
  if (relogin) for (const [k, t] of state.detailTries) if (t.settled) state.detailTries.delete(k);
}

// 内源现在的状态：up（10 分钟内连上过）/ down（5 分钟内连不上过）/ unknown（还没探测）。
function reachability({ now = Date.now } = {}) {
  if (now() < state.unreachableUntil) return 'down';
  if (state.okAt && now() - state.okAt <= LIST_TTL_MS) return 'up';
  return 'unknown';
}

// 预热：查版本清单时顺手在后台探测内源（不等结果、不报错），真正下载时状态已知，公司外不用再等。
function prewarm({ fetchImpl, api = DEFAULT_API, projectId = PROJECT_ID, timeoutMs = LIST_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  if (!enabled(env) || !api || !projectId || typeof fetchImpl !== 'function' || reachability({ now }) !== 'unknown') return null;
  return loadHead({ fetchImpl, api, projectId, timeoutMs, now }).catch(error => {
    markDown(error, now);
    state.lastReason = failText(error);
    return null;
  });
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
// 更新窗和环境体检共用的只读探测：复用下载器的列表/详情缓存，整体最多等 8 秒（R44：原 3 秒，公司里光列表常常就要 3 秒）。
// 只查目标版本，避免「没有该版本」时逐个查询无关组件的版本详情。
// strict（r56）：成员版只看 member-v<版本>（release 给了就只认这个版本名）；非 strict 的版本名必须以数字开头，member-* 自然排除。
async function probe({ version, file, release, strict = false, fetchImpl, env = process.env, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs = LIST_TIMEOUT_MS, now = Date.now } = {}) {
  const row = { id: 'openx', name: '内源（公司内网）', informational: true, ok: false, version: version || null };
  const fail = reason => ({ ...row, status: 'failed', reason });
  if (!enabled(env)) return { ...row, status: 'off', reason: '内源已关闭' };
  if (!api || !projectId || typeof fetchImpl !== 'function') return fail('未配置内源或网络');
  if (reachability({ now }) === 'down') return fail(state.lastReason.replace(/^内源连不上[：]?/, '') || '稍后再试');
  const budget = Math.min(timeoutMs, LIST_TIMEOUT_MS);
  const deadline = now() + budget;
  let timer;
  const pending = (async () => {
    let list;
    try { list = await loadHead({ fetchImpl, api, projectId, timeoutMs: budget, now }); }
    catch (error) {
      markDown(error, now);
      state.lastReason = failText(error);
      return fail(errText(error));
    }
    const want = normVersion(version);
    const pattern = strict ? /^member-v(\d+\.\d+\.\d+)(?:\s|$)/i : /^(\d+\.\d+\.\d+)(?:\s|$)/;
    const wantRelease = release ? normVersion(release).toLowerCase() : '';
    const pickFrom = records => records.map(r => ({ ...r, appVersion: pattern.exec(normVersion(r.version))?.[1] }))
      .filter(r => r.appVersion && (!want || r.appVersion === want))
      .filter(r => !strict || !wantRelease || (n => n === wantRelease || n.startsWith(wantRelease + ' '))(normVersion(r.version).toLowerCase()))
      .sort((a, b) => require('./manifest').compareVersions(b.appVersion, a.appVersion));
    let candidates = pickFrom(list);
    // 第 1 页里没有（要看的是较老的版本）再取完整列表（R44）。
    if (!candidates.length && list !== state.list && moreAfterHead(list)) {
      // 共享的完整列表按正常的 8 秒取（外层另有整体预算兜底），不按剩下的几百毫秒取，免得取出残缺列表（R44 审查 P1-2）。
      try { candidates = pickFrom(await loadList({ fetchImpl, api, projectId, timeoutMs: LIST_TIMEOUT_MS, now })); }
      catch (error) { return fail(`版本列表没取全：${errText(error)}`); }
      if (!candidates.length && state.listPartialReason) return fail(`版本列表没取全：${state.listPartialReason}`);
    }
    if (!candidates.length) return { ...row, status: 'missing' };
    if (!file) return { ...row, status: 'ok', ok: true, version: candidates[0].appVersion };
    for (const rec of candidates.slice(0, MAX_DETAIL_QUERIES)) {
      if (now() >= deadline) break;
      let packages = state.details.get(rec.id);
      if (!packages) {
        const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, null, Math.max(1, deadline - now()));
        packages = packagesOf(data, rec);
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
// 版本清单兜底（rsi-e，2026-11-20；返工 2026-11-21）：公司网络拦了阿里云、又没有外网权限的同事，GitHub 和阿里云的 latest.json 都读不到，
// 「检查更新」永远报错、一直停在旧版（11-20 群里两位同事）。发版时内源每个程序版本（v<版本>）附带同一份 latest.json
// 和它的离线签名 latest.json.sig，外网清单全部失败时从这里读：取内源上版本号最高、带 latest.json 的程序版本。采信条件（缺一条都当内源没有清单）：
//   1. 签名用 Hub 内置公钥验过（manifest-signing.js）——内源谁都能传文件，不验签等于把升级交给任何能上传的人；
//   2. 清单里的版本号和内源版本名一致；3. 版本不低于当前版本（防回退），主版本最多比当前高 1（防一次跳到离谱版本）。
// 整个过程（列表、详情、清单、签名）后台检查不超过 8 秒、用户手动检查不超过 20 秒（R44）；内源 5 分钟内刚连不上过就直接跳过。之后照常按清单的大小和 sha256 核对下载的文件。
// member-* 版本不看（与程序包下载同一口径）。
const MANIFEST_FILE = 'latest.json';
const MANIFEST_BUDGET_MS = 8000;
// R44（2026-11-25）：用户手动「检查更新」给 20 秒（与 R42 回退页同一预算）；后台定时检查仍是 8 秒。
const MANUAL_MANIFEST_BUDGET_MS = 20000;
// 查清单只需要最近几个程序版本：只取列表第 1 页（接口按发布时间从新到旧），并留作第 1 页缓存给探测和下载复用。
// 给用户看的两种平静说明（R44）：不在公司网络 / 在公司但内源慢。
const OFFLINE_TEXT = '现在不在公司网络，查不了更新。连上公司内网或 VPN 后 Hub 会自动再查，不用操作';
const OFFLINE_PROXY_TEXT = '现在不在公司网络（或本机代理没放行公司内网），查不了更新。连上公司内网或 VPN 后 Hub 会自动再查，不用操作';
const slowText = sec => `公司内源响应太慢，${sec} 秒内没查完版本信息（内源可能正忙），稍后点旁边的「重试」再查一次`;
async function fetchManifest({ fetchImpl, validate, signal, currentVersion, publicKey, api = DEFAULT_API, projectId = PROJECT_ID, env = process.env,
  timeoutMs = MANIFEST_BUDGET_MS, now = Date.now } = {}) {
  const startedAt = now();
  const result = (ok, extra) => ({ id: 'openx-manifest', name: '公司内源 · 版本清单', ok, ms: now() - startedAt, ...extra });
  if (!enabled(env)) return result(false, { reason: '内源已关闭' });
  if (!api || !projectId || typeof fetchImpl !== 'function' || typeof validate !== 'function') return result(false, { reason: '未配置内源' });
  if (reachability({ now }) === 'down') return result(false, { reason: downText(), offline: !!(state.down && state.down.offline), proxy: !!(state.down && state.down.proxy), auth: !!(state.down && state.down.auth) });
  const budget = Math.max(0, Math.min(Number(timeoutMs) || 0, MANUAL_MANIFEST_BUDGET_MS));
  const slow = () => result(false, { reason: `${budget / 1000} 秒内没读完内源版本清单`, slow: true });
  if (budget <= 0) return result(false, { reason: '没有剩余时间读内源版本清单' });
  const { compareVersions } = require('./manifest');
  let deadline = startedAt + budget;
  const left = () => Math.max(1, deadline - now());
  // 总预算：到点或外部取消时一起中断所有在途请求。
  const ac = new AbortController();
  let timer, stop;
  const overBudget = new Promise(resolve => { stop = resolve; timer = setTimeout(() => { ac.abort(); resolve('timeout'); }, budget); });
  // R63：走到「借 Edge 登录查列表」时，在剩余预算上再加登录这一步的时间（只加一次），不让后台 8 秒预算把登录截断。
  let extended = false;
  // 审查 P2：从现在起算，登录预算取 AI_HUB_OPENX_LOGIN_MS 与默认值的较大者，再留 5 秒给关 Edge 和读清单、验签。
  const extend = ms => {
    if (extended || ac.signal.aborted) return;
    extended = true;
    deadline = Math.max(deadline, now() + Math.max(ms, Number(env.AI_HUB_OPENX_LOGIN_MS) || 0) + LOGIN_TAIL_MS);
    clearTimeout(timer);
    timer = setTimeout(() => { ac.abort(); stop('timeout'); }, Math.max(1, deadline - now()));
  };
  // 外部取消（用户点了取消、体检到点）：立刻返回，不等列表请求自己超时。
  const onAbort = () => { ac.abort(); stop('cancel'); };
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const getText = async url => {
    const res = await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'error' });
    if (res && res.status >= 300 && res.status < 400) throw new Error(`内源要求跳转（HTTP ${res.status}），不跟随`);
    if (!res || !res.ok) throw new Error(`内源返回 HTTP ${res && res.status}`);
    return typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(String(await res.text()), 'utf8');
  };
  const work = (async () => {
    let list;
    try {
      // 单次请求的超时比总预算多 1 秒：到点由总预算统一中断，结果归为「内源慢」，不会被当成连不上。
      // 10 分钟内的完整列表或第 1 页缓存能用就用；否则只取第 1 页。
      if (state.list && now() - state.listAt <= LIST_TTL_MS) list = state.list;
      else if (state.head && now() - state.headAt <= LIST_TTL_MS) list = state.head;
      else list = keepHead(await listPage({ fetchImpl, api, projectId, page: 1, timeoutMs: left() + 1000, signal: ac.signal, onLogin: extend, now }), now);
    }
    catch (error) {
      // 外部取消（用户点取消、体检到点）不算连不上，不标 down（R44 审查 P1-3）。
      if (signal && signal.aborted) return result(false, { reason: '已取消' });
      // 网络栈自己报的超时（Chromium net::ERR_TIMED_OUT 等，可能比总预算早一点到）也归为「内源慢」，不标连不上。
      if (ac.signal.aborted || isTimeoutError(error)) return slow();
      markDown(error, now); state.lastReason = failText(error);
      return result(false, { reason: failText(error), offline: isOfflineError(error), proxy: isProxyError(error), auth: isAuthError(error) });
    }
    const releases = list.map(r => ({ ...r, appVersion: /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(normVersion(r.version))?.[1] }))
      .filter(r => r.appVersion)
      .sort((a, b) => compareVersions(b.appVersion, a.appVersion));
    // 某一版清单没签名、签名不对或版本对不上（如发版中途只传了一半）：记下原因，接着看更早的一版（R29 审查 #4）。
    let skipped = '';
    // 2026-11-25：某几版的清单漏传时（104–107 实际发生过）往前多看几版，最多 6 个程序版本；详情有缓存，耗时仍受 8 秒总预算约束。
    for (const rec of releases.slice(0, 6)) {
      if (ac.signal.aborted) break;
      let packages = state.details.get(rec.id);
      if (!packages) {
        const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, ac.signal, left());
        packages = packagesOf(data, rec);
        state.details.set(rec.id, packages);
      }
      const pick = name => packages.find(p => p && String(p.originalFileName || '').toLowerCase() === name && safeUrl(p.url));
      const hit = pick(MANIFEST_FILE);
      if (!hit) continue;
      const sigHit = pick(MANIFEST_FILE + signing.SIG_FILE_SUFFIX);
      if (!sigHit) { skipped = skipped || `内源 v${rec.appVersion} 的版本清单没有签名，不采用`; continue; }
      const [raw, sig] = await Promise.all([getText(safeUrl(hit.url)), getText(safeUrl(sigHit.url))]);
      if (!signing.verifyManifest(raw, sig.toString('utf8'), publicKey)) { skipped = skipped || `内源 v${rec.appVersion} 的版本清单签名不对，不采用`; continue; }
      const manifest = await validate(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      const v = normVersion(manifest.version);
      if (v !== rec.appVersion) { skipped = skipped || `内源 v${rec.appVersion} 附带的清单写的是 v${manifest.version}，不采用`; continue; }
      if (currentVersion) {
        const cur = normVersion(currentVersion);
        // older：内源上最新的有效清单比本机还旧（本机装了更新的测试包等）——只走内源时按「已是最新」处理。
        if (compareVersions(v, cur) < 0) return result(false, { reason: `内源清单 v${v} 比当前 v${cur} 还旧，不采用`, older: true, version: v });
        if (Number(v.split('.')[0]) > Number(cur.split('.')[0]) + 1) return result(false, { reason: `内源清单 v${v} 主版本跳得太多（当前 v${cur}），不采用` });
      }
      return result(true, { manifest, releaseVersion: String(rec.version || '') });
    }
    if (ac.signal.aborted) return signal && signal.aborted ? result(false, { reason: '已取消' }) : slow();
    // pending：内源连得上，只是新版的清单还没上来——不是用户能处理的故障，界面按「暂无可装的新版本」平静显示。
    return result(false, skipped ? { reason: skipped } : { reason: '内源上的程序版本还没有附带版本清单', pending: true });
  })().catch(error => {
    if (signal && signal.aborted) return result(false, { reason: '已取消' });
    if (ac.signal.aborted) return slow();
    return result(false, { reason: `内源版本清单没读到：${error && error.message ? error.message : error}` });
  });
  try {
    const first = await Promise.race([work, overBudget]);
    if (first === 'cancel') return result(false, { reason: '已取消' });
    return first === 'timeout' ? slow() : first;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 可回退的历史版本（R42，2026-11-25 用户定「版本与回退只走内源」）：内源上每个程序版本（v<版本>，发版同步 openx_sync.py 每版一个）
// 都附带那一版自己的 latest.json 和离线签名 latest.json.sig。逐版读出来、用 Hub 内置公钥验签，签名对、版本名与清单一致、
// 同一版本里确实有清单写的完整更新包，才列为可回退版本；完整更新包的大小与 sha256 就取自这份签过名的清单，下载后照常核对。
// 没签名的早期版本（R29 之前发的）、签名不对、缺包的版本不列，原因记进 skipped 给界面一行说明。
// 已验过的版本按内源版本 id 缓存（发出去的版本内容不变），再次打开只查新增的版本。member-* 不看。
const RELEASES_BUDGET_MS = 20000;
const RELEASES_MAX = 20;
const verifiedReleases = new Map();
async function listAppReleases({ fetchImpl, validate, publicKey, signal, env = process.env, api = DEFAULT_API, projectId = PROJECT_ID,
  max = RELEASES_MAX, timeoutMs = RELEASES_BUDGET_MS, concurrency = 4, now = Date.now } = {}) {
  const fail = reason => ({ ok: false, reason, versions: [], skipped: [] });
  if (!enabled(env)) return fail('内源已关闭');
  if (!api || !projectId || typeof fetchImpl !== 'function' || typeof validate !== 'function') return fail('未配置内源');
  const { compareVersions } = require('./manifest');
  const deadline = now() + Math.max(1, Number(timeoutMs) || RELEASES_BUDGET_MS);
  const left = () => Math.max(1, Math.min(REACH_TIMEOUT_MS * 2, deadline - now()));
  let list;
  try { list = await loadList({ fetchImpl, api, projectId, timeoutMs: Math.min(LIST_TIMEOUT_MS, Math.max(1, deadline - now())), now }); }
  catch (error) {
    if (signal && signal.aborted) return fail('已取消');
    markDown(error, now); state.lastReason = failText(error);
    return fail(failText(error));
  }
  const seen = new Set();
  const releases = list.filter(r => !isMemberRelease(r.version))
    .map(r => ({ ...r, appVersion: /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(normVersion(r.version))?.[1] }))
    .filter(r => r.appVersion)
    .sort((a, b) => compareVersions(b.appVersion, a.appVersion) || (Date.parse(b.releaseTime || '') || 0) - (Date.parse(a.releaseTime || '') || 0))
    .filter(r => (seen.has(r.appVersion) ? false : (seen.add(r.appVersion), true)))
    .slice(0, Math.max(1, max));
  const getBuf = async url => {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ac.abort(), left());
    try {
      const res = await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'error' });
      if (res && res.status >= 300 && res.status < 400) throw new Error(`内源要求跳转（HTTP ${res.status}），不跟随`);
      if (!res || !res.ok) throw new Error(`内源返回 HTTP ${res && res.status}`);
      return typeof res.arrayBuffer === 'function' ? Buffer.from(await res.arrayBuffer()) : Buffer.from(String(await res.text()), 'utf8');
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  };
  const one = async rec => {
    const cacheKey = `${rec.id}:${rec.appVersion}`;
    if (verifiedReleases.has(cacheKey)) return verifiedReleases.get(cacheKey);
    let packages = state.details.get(rec.id);
    if (!packages) {
      const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, signal, left());
      packages = packagesOf(data, rec);
      state.details.set(rec.id, packages);
    }
    const pick = name => packages.find(p => p && String(p.originalFileName || '').toLowerCase() === String(name).toLowerCase() && safeUrl(p.url));
    const hit = pick(MANIFEST_FILE);
    if (!hit) return { skip: '没有附带版本清单' };
    const sigHit = pick(MANIFEST_FILE + signing.SIG_FILE_SUFFIX);
    if (!sigHit) return { skip: '版本清单没有签名' };
    const [raw, sig] = await Promise.all([getBuf(safeUrl(hit.url)), getBuf(safeUrl(sigHit.url))]);
    if (!signing.verifyManifest(raw, sig.toString('utf8'), publicKey)) return { skip: '版本清单签名不对' };
    const manifest = await validate(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    if (normVersion(manifest.version) !== rec.appVersion) return { skip: `附带的清单写的是 v${manifest.version}` };
    if (!manifest.incremental) return { skip: '这一版没有完整更新包' };
    const file = manifest.incremental.file;
    if (!pick(file) && !pick(`${file}.000`)) return { skip: `内源上缺完整更新包 ${file}` };
    const entry = { version: rec.appVersion, publishedAt: manifest.publishedAt || String(rec.releaseTime || ''), runtime: manifest.runtime,
      incremental: { ...manifest.incremental }, notes: manifest.notes || [], releaseVersion: String(rec.version || ''), releaseId: rec.id };
    const out = { entry };
    verifiedReleases.set(cacheKey, out);
    return out;
  };
  const versions = [], skipped = [];
  let timedOut = false;
  // 小并发逐版核验：每版一次详情 + 两个小文件；到总预算就停，已核验的照常列出，界面说明「还有更早的版本没读完」。
  const queue = releases.slice();
  const worker = async () => {
    while (queue.length) {
      if (signal && signal.aborted) return;
      if (now() >= deadline) { timedOut = true; return; }
      const rec = queue.shift();
      try {
        const r = await one(rec);
        if (r.entry) versions.push(r.entry);
        // 没通过的版本可能是发版同步到一半：丢掉它的详情缓存，下次重查附件列表（R42 审查 P2-4）。
        else { state.details.delete(rec.id); skipped.push({ version: rec.appVersion, why: r.skip }); }
      } catch (error) {
        if (signal && signal.aborted) return;
        state.details.delete(rec.id);
        skipped.push({ version: rec.appVersion, why: `没读到：${error && error.message ? error.message : error}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, releases.length || 1)) }, worker));
  // 最后几版在预算到点时被中断（队列已空、错误记进 skipped）也算没读完（R42 审查 P2-3）。
  if (now() >= deadline) timedOut = true;
  if (signal && signal.aborted) return fail('已取消');
  versions.sort((a, b) => compareVersions(b.version, a.version));
  skipped.sort((a, b) => compareVersions(b.version, a.version));
  if (!versions.length) {
    if (!releases.length) return { ...fail(state.listPartialReason ? `版本列表没取全：${state.listPartialReason}` : '内源上还没有程序版本'), skipped };
    return { ...fail(timedOut ? `${Math.round((Number(timeoutMs) || RELEASES_BUDGET_MS) / 1000)} 秒内没读完内源上的版本清单` : '内源上的版本都没有通过签名校验的清单'), skipped };
  }
  return { ok: true, versions, skipped, partial: timedOut || queue.length > 0 || !!state.listPartialReason };
}

// 内源上最近的完整安装包（r27，2026-11-24）：不依赖版本清单，直接在内源的程序版本里找 <名>-Setup-<版本>.exe
// （免安装版找 <名>-<版本>-win-x64.zip）。版本清单读不到、增量包装不上、本机太老时，更新窗用它给「下载完整安装包」按钮。
// 内源上多数版本只有增量包，完整包隔几版才发一次，所以按版本从新到旧逐个查详情，最多 MAX_DETAIL_QUERIES 个、总共约 6 秒。
// 只给比当前版本新的包（给旧的等于让人降级）；member-* 版本不看；地址只取白名单域名内的 https 地址。
const FULL_PACKAGE_RE = /^.+-Setup-(\d+\.\d+\.\d+)\.exe$/i;
const PORTABLE_PACKAGE_RE = /^.+-(\d+\.\d+\.\d+)-win-x64\.zip$/i;
async function findLatestFull({ fetchImpl, portable = false, currentVersion = '', env = process.env, api = DEFAULT_API, projectId = PROJECT_ID,
  timeoutMs: givenTimeoutMs, now = Date.now } = {}) {
  const timeoutMs = givenTimeoutMs || REACH_TIMEOUT_MS;
  const miss = reason => ({ ok: false, reason });
  if (!enabled(env)) return miss('内源已关闭');
  if (!api || !projectId || typeof fetchImpl !== 'function') return miss('未配置内源');
  if (reachability({ now }) === 'down') return miss(downText());
  const { compareVersions } = require('./manifest');
  let list;
  try { list = await loadList({ fetchImpl, api, projectId, timeoutMs: givenTimeoutMs || LIST_TIMEOUT_MS, now }); }
  catch (error) { markDown(error, now); state.lastReason = failText(error); return miss(failText(error)); }
  const deadline = now() + timeoutMs * 2;   // 逐个查详情的预算从列表取到之后算起（R44）
  const cur = normVersion(currentVersion);
  const releases = list.filter(r => !isMemberRelease(r.version))
    .map(r => ({ ...r, appVersion: /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(normVersion(r.version))?.[1] }))
    .filter(r => r.appVersion && (!cur || compareVersions(r.appVersion, cur) > 0))
    .sort((a, b) => compareVersions(b.appVersion, a.appVersion));
  const pattern = portable ? PORTABLE_PACKAGE_RE : FULL_PACKAGE_RE;
  let queries = 0;
  for (const rec of releases) {
    let packages = state.details.get(rec.id);
    if (!packages) {
      if (queries >= MAX_DETAIL_QUERIES || now() > deadline) break;
      queries += 1;
      try {
        const data = await getJson(fetchImpl, `${api}by_id?id=${encodeURIComponent(rec.id)}`, null, Math.max(1, Math.min(timeoutMs, deadline - now())));
        packages = packagesOf(data, rec);
        state.details.set(rec.id, packages);
      } catch (error) { return miss(`内源版本详情没取到：${error && error.message ? error.message : error}`); }
    }
    for (const p of packages) {
      const file = String((p && p.originalFileName) || '');
      const m = pattern.exec(file);
      const url = m && m[1] === rec.appVersion ? safeUrl(p.url) : '';
      if (url) {
        return {
          ok: true, url, file, version: m[1], projectId, releaseId: rec.id, releaseVersion: String(rec.version || ''),
          packageId: p.id != null ? p.id : null, packageTag: String(p.tag || ''),
          urlSource: p.urlSource != null ? p.urlSource : null, projectName: state.projectName || '',
        };
      }
    }
  }
  return miss(releases.length ? '内源上较新的版本里没找到完整安装包' : '内源上没有比当前更新的版本');
}

const releaseName = (kind, version) => `${kind}-${normVersion(version)}`;
const MEMBER_PREFIX = 'member-';
const memberReleaseName = version => `${MEMBER_PREFIX}v${normVersion(version)}`;
const isMemberRelease = name => String(name || '').trim().toLowerCase().startsWith(MEMBER_PREFIX);
// 内源项目下载页地址：项目名从 by_project_id 返回的 data.name 动态取得，不写死。
// 审查 P1-2：列表读不到（要求登录、索引模式）时项目名为空，回落 openx-config.projectPage 的路径，下载页地址和下载量记录照常可用。
function projectName() { return state.projectName || projectSlugFromConfig(); }
function downloadPageUrl(name = state.projectName || projectSlugFromConfig()) {
  const slug = String(name || '').trim();
  if (!slug || !CONFIG || !CONFIG.fileSite) return '';
  try { return safeUrl(new URL(`${encodeURIComponent(slug)}/download`, CONFIG.fileSite).href); } catch (_) { return ''; }
}
async function resolveDownloadPageUrl({ fetchImpl, api = DEFAULT_API, projectId = PROJECT_ID, timeoutMs = LIST_TIMEOUT_MS, env = process.env, now = Date.now } = {}) {
  const existing = downloadPageUrl(state.projectName);
  if (existing) return existing;
  if (!enabled(env) || !api || !projectId || typeof fetchImpl !== 'function') return '';
  try { await loadHead({ fetchImpl, api, projectId, timeoutMs, now }); } catch (_) { return ''; }
  return downloadPageUrl(state.projectName);
}

function _reset({ indexId, localVersion } = {}) {
  state = freshState();
  loginLister = null;
  if (indexId !== undefined) state.indexId = Number(indexId) || 0;
  if (localVersion !== undefined) state.localVersion = normVersion(localVersion);
  verifiedReleases.clear();
}

module.exports = { isTimeoutError, setLoginLister, LOGIN_BUDGET_MS, LOGIN_REUSE_MS, isAuthError, parseIndex, INDEX_MARK, INDEX_RELEASE_ID, indexIdFromEnv, indexOverrideFromEnv, loadIndex, setLocalVersion, AUTH_TEXT, active, userReason, NETWORK_HINT, findLatestFull, listAppReleases, RELEASES_MAX, fetchManifest, MANIFEST_BUDGET_MS, MANUAL_MANIFEST_BUDGET_MS, OFFLINE_TEXT, OFFLINE_PROXY_TEXT, slowText, isOfflineError, isProxyError, diagnostics, clearDown, EDITION_ON, releaseName, memberReleaseName, isMemberRelease, find, headSize, prewarm, probe, reachability, safeUrl, markBad, lastReason, enabled, normVersion, projectName, downloadPageUrl, resolveDownloadPageUrl, _reset, DEFAULT_API, PROJECT_ID, REACH_TIMEOUT_MS, UNKNOWN_BUDGET_MS, LIST_TIMEOUT_MS, LIST_PAGE_SIZE };
