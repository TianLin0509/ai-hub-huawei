'use strict';
// 反馈收件机的地址从哪来（r42，2026-11-18）：开箱即用，不让同事填。
// 维护人把收件地址发在公司内源（openx 项目，见 app-update/openx-config.js）一个固定名称的小发布里：
//   版本名 feedback-receiver，附件 feedback-receiver.json，内容 {"urls":["http://<计算机名全称>:18767"]}
// 这里读出来缓存到数据目录；读不到（内源连不上、还没发布）就用上次缓存。地址不写进代码和提交。
// 顺带回答「内源连不连得上」：公开版据此判断用户在不在公司内（在公司内就走内网，不发阿里云）。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write');
const { acceptableIPv4 } = require('./intranet-address');

const RELEASE = 'feedback-receiver';
const FILE = 'feedback-receiver.json';
// 2026-11-19 黑洞复盘：版本列表约 45 KB，收件机本机实测 1.3–1.6 秒，离得远的同事很容易超过原来的 3 秒（正文也算在内），
// 超时就当「内源连不上」、没有地址只能排队。取地址在后台做、不挡界面，所以列表放宽到 10 秒，详情与附件 5 秒。
const TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 10000;
const MEMO_MS = 10 * 60 * 1000;
const MAX_URLS = 4;
// 版本列表按发布时间倒序分页；每版 Hub 都会新增 2 个以上版本，收件地址那一版迟早掉出第一页。最多翻 5 页（500 个版本）。
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

function openxConfig() { try { return require('./app-update/openx-config'); } catch { return null; } }

function cacheFile(dataDir) { return path.join(dataDir, 'hub-feedback-receiver.json'); }

// 只接受 http(s)://主机[:端口]，不带账号、路径、查询；主机只能是私网 IPv4（含回环）或与内源站点同一主域的公司内网域名
// （计算机名写全称）。公网 IP、其他域名、单段计算机名一律不认：
// 发布误填或缓存被改时，诊断包也不会被送到公司外（r42 返工）。
function allowedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  // IP 与收件机建议发布的地址用同一套内网判断（core/intranet-address.js）：私网或企业自用 /8（如 7.x）。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return acceptableIPv4(h);
  const suffix = companyDomain();
  return !!suffix && h.endsWith('.' + suffix) && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9.-]+$/.test(h);
}
// 公司主域取自内源站点地址的最后两段（openx-config.fileSite），代码里不写死。
function companyDomain() {
  try { return new URL(openxConfig().fileSite).hostname.toLowerCase().split('.').slice(-2).join('.'); } catch { return ''; }
}
function cleanUrl(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { return ''; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) return '';
  if (!allowedHost(u.hostname)) return '';
  return u.origin;
}
function cleanUrls(list) { return [...new Set((Array.isArray(list) ? list : []).map(cleanUrl).filter(Boolean))].slice(0, MAX_URLS); }
function cleanBoardReleaseId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 1e9 ? n : 0;
}

function readCache(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
    return { urls: cleanUrls(raw.urls), boardReleaseId: cleanBoardReleaseId(raw.boardReleaseId), at: Number(raw.at) || 0 };
  } catch { return { urls: [], boardReleaseId: 0, at: 0 }; }
}
function writeCache(dataDir, urls, at, boardReleaseId = 0) {
  try { writeFileAtomic(fs, cacheFile(dataDir), JSON.stringify({ urls, ...(boardReleaseId ? { boardReleaseId } : {}), at }) + '\n'); } catch { /* 存不下就下次再查 */ }
}

// 失败要说得出是哪一种：超时、被代理拦成网页、HTTP 错误、网络错误（带错误码），设置页和反馈窗口直接显示。
async function getJson(fetchImpl, url, timeoutMs, maxBytes = 64 * 1024) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try { res = await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'error' }); }
    catch (e) {
      if (ac.signal.aborted) throw new Error(`${timeoutMs / 1000} 秒内没有响应`);
      const code = e && e.cause && (e.cause.code || e.cause.message);
      throw new Error(`网络错误 ${code || (e && e.message) || ''}`.trim());
    }
    if (res && (res.status === 401 || res.status === 403)) {
      let t = ''; try { t = String(await res.text()); } catch {}
      throw new Error(/^\s*[{\[]/.test(t) ? `内源要求登录（HTTP ${res.status}）` : `HTTP ${res.status}`);
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    let text;
    try { text = String(await res.text()); } catch (e) { throw new Error(ac.signal.aborted ? `${timeoutMs / 1000} 秒内没收完内容` : `读内容出错 ${e && e.message}`); }
    if (text.length > maxBytes) throw new Error('内容过大');
    if (/^\s*</.test(text)) throw new Error('收到的是网页而不是数据（可能被公司代理拦截）');
    return JSON.parse(text.trim());
  } finally { clearTimeout(timer); }
}

function safeFileUrl(u, site) {
  try {
    const url = new URL(String(u || '')); const host = new URL(site).hostname.toLowerCase();
    return url.protocol === 'https:' && (url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : '';
  } catch { return ''; }
}

// 返回 { urls, from: 'openx' | 'cache' | 'none', openxReachable, reason }。
function createReceiverAddress({ dataDir, fetchImpl, config = openxConfig(), now = Date.now, timeoutMs = TIMEOUT_MS, listTimeoutMs = LIST_TIMEOUT_MS } = {}) {
  let memo = null, pending = null;

  async function lookup() {
    const cache = readCache(dataDir);
    const defaultBoardId = cleanBoardReleaseId(config && config.boardReleaseId);
    const fallback = (openxReachable, reason) => ({
      urls: cache.urls,
      boardReleaseId: cache.boardReleaseId || defaultBoardId,
      from: cache.urls.length ? 'cache' : 'none',
      openxReachable,
      reason,
    });
    if (!config || !config.api || !config.projectId || typeof fetchImpl !== 'function') return fallback(false, '没有内源配置');
    const norm = v => String(v || '').trim().toLowerCase();
    const isHit = r => r && r.id != null && (norm(r.version) === RELEASE || norm(r.version).startsWith(RELEASE + ' '));
    let hits = [];
    // R55（索引优先）：配了版本索引就先读索引（by_id 匿名可读、一次全量）；索引读不到或里面没有收件地址版本，再翻列表。
    const envIndex = require('./app-update/openx-source').indexOverrideFromEnv();   // 写 0 = 显式关掉索引
    const indexId = envIndex ?? (Number(config.indexReleaseId) || 0);
    let indexError = '';
    if (indexId) {
      try { hits = (await require('./app-update/openx-source').loadIndex({ fetchImpl, api: config.api, timeoutMs: Math.max(timeoutMs, listTimeoutMs), indexId })).filter(isHit); }
      catch (e) {
        // 审查 P1-3 ②：离线或超时就按连不上处理，不再向同一个站点翻列表（免得等两遍）。
        const ox = require('./app-update/openx-source');
        if (!ox.isAuthError(e) && (ox.isOfflineError(e) || /超时|timeout|abort/i.test(String(e && e.message)) || (e && e.name === 'AbortError'))) {
          return fallback(false, `内源连不上：${e && e.message ? e.message : e}`);
        }
        indexError = e && e.message ? e.message : String(e);
      }
    }
    // 索引读到了就以它为准（全量，发版流水线每次发布后更新），里面没有收件地址版本也不再翻列表。
    for (let page = 1; page <= MAX_PAGES && !hits.length && !(indexId && !indexError); page++) {
      let records;
      try {
        const list = await getJson(fetchImpl, `${config.api}by_project_id?projectId=${config.projectId}&currentPage=${page}&pageSize=${PAGE_SIZE}`,
          Math.max(timeoutMs, listTimeoutMs), 512 * 1024);
        // R55（2026-11-27）：列表接口要求登录（code 401/403）——如实说要求登录（附上索引为什么没读到）；索引读到了只是没有收件地址版本就不再翻页。
        if (list && /^(401|403)$/.test(String(list.code)) && page === 1) {
          if (!indexId) throw new Error(`内源要求登录（接口返回 ${list.code}），也没有配置版本索引`);
          if (indexError) throw new Error(`内源要求登录（接口返回 ${list.code}），版本索引也没读到：${indexError}`);
          break;   // 索引读到了但里面没有收件地址版本：按「还没有发布收件地址」处理
        }
        if (!list || String(list.code) !== '0' || !list.data || !Array.isArray(list.data.records)) throw new Error('版本列表格式不对');
        records = list.data.records;
      } catch (e) {
        // 第一页都取不到才算内源连不上；翻页中途出错按「没找到」处理。
        // 要求登录（R55）说明内源是连得上的（人在公司内），只是列表要登录。
        if (page === 1) return /要求登录/.test(String(e && e.message)) ? fallback(true, e.message) : fallback(false, `内源连不上：${e.message}`);
        break;
      }
      hits = records.filter(isHit);
      if (records.length < PAGE_SIZE) break;
    }
    hits = hits.sort((a, b) => (Date.parse(b.releaseTime || '') || 0) - (Date.parse(a.releaseTime || '') || 0)).slice(0, 3);
    for (const rec of hits) {
      try {
        const detail = await getJson(fetchImpl, `${config.api}by_id?id=${encodeURIComponent(rec.id)}`, timeoutMs);
        // 审查 P2-4：by_id 回的版本名不是收件地址版本（索引 id 填错）就跳过。
        if (detail && detail.data && detail.data.version != null && !isHit({ id: rec.id, version: detail.data.version })) continue;
        const pkgs = detail && detail.data && Array.isArray(detail.data.binaryPackages) ? detail.data.binaryPackages : [];
        const pkg = pkgs.find(p => p && String(p.originalFileName || '').toLowerCase() === FILE && safeFileUrl(p.url, config.fileSite));
        if (!pkg) continue;
        const parsed = await getJson(fetchImpl, safeFileUrl(pkg.url, config.fileSite), timeoutMs);
        const urls = cleanUrls(parsed && parsed.urls);
        const boardReleaseId = cleanBoardReleaseId(parsed && parsed.boardReleaseId) || defaultBoardId;
        if (!urls.length) continue;
        writeCache(dataDir, urls, now(), boardReleaseId);
        return { urls, boardReleaseId, from: 'openx', openxReachable: true, reason: '' };
      } catch (e) { return fallback(true, `读收件地址失败：${e.message}`); }
    }
    return fallback(true, '内源上还没有发布收件地址');
  }

  // 10 分钟内复用结果；同一时刻只查一次。force 用于补发前重新取地址。
  async function resolve({ force = false } = {}) {
    if (!force && memo && now() - memo.at < MEMO_MS) return memo.value;
    if (!pending) pending = lookup().then(value => { memo = { at: now(), value }; return value; }).finally(() => { pending = null; });
    return pending;
  }

  return { resolve, readCache: () => readCache(dataDir) };
}

module.exports = { TIMEOUT_MS, LIST_TIMEOUT_MS, PAGE_SIZE, MAX_PAGES, createReceiverAddress, cleanUrl, cleanUrls, allowedHost, readCache, cacheFile, RELEASE, FILE };
