'use strict';
// 反馈收件机的地址从哪来（r42，2026-11-18）：开箱即用，不让同事填。
// 维护人把收件地址发在公司内源（openx 项目，见 app-update/openx-config.js）一个固定名称的小发布里：
//   版本名 feedback-receiver，附件 feedback-receiver.json，内容 {"urls":["http://<计算机名全称>:18767"]}
// 这里读出来缓存到数据目录；读不到（内源连不上、还没发布）就用上次缓存。地址不写进代码和提交。
// 顺带回答「内源连不连得上」：公开版据此判断用户在不在公司内（在公司内就走内网，不发阿里云）。
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write');
const { isPrivateAddress } = require('./lan-pool');

const RELEASE = 'feedback-receiver';
const FILE = 'feedback-receiver.json';
const TIMEOUT_MS = 3000;
const MEMO_MS = 10 * 60 * 1000;
const MAX_URLS = 4;

function openxConfig() { try { return require('./app-update/openx-config'); } catch { return null; } }

function cacheFile(dataDir) { return path.join(dataDir, 'hub-feedback-receiver.json'); }

// 只接受 http(s)://主机[:端口]，不带账号、路径、查询；主机只能是私网 IPv4（含回环）或与内源站点同一主域的公司内网域名
// （计算机名写全称）。公网 IP、其他域名、单段计算机名一律不认：
// 发布误填或缓存被改时，诊断包也不会被送到公司外（r42 返工）。
function allowedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateAddress(h);
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

function readCache(dataDir) {
  try { const raw = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8')); return { urls: cleanUrls(raw.urls), at: Number(raw.at) || 0 }; }
  catch { return { urls: [], at: 0 }; }
}
function writeCache(dataDir, urls, at) {
  try { writeFileAtomic(fs, cacheFile(dataDir), JSON.stringify({ urls, at }) + '\n'); } catch { /* 存不下就下次再查 */ }
}

async function getJson(fetchImpl, url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'error' });
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    const text = String(await res.text());
    if (text.length > 64 * 1024) throw new Error('内容过大');
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
function createReceiverAddress({ dataDir, fetchImpl, config = openxConfig(), now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  let memo = null, pending = null;

  async function lookup() {
    const cache = readCache(dataDir);
    const fallback = (openxReachable, reason) => ({ urls: cache.urls, from: cache.urls.length ? 'cache' : 'none', openxReachable, reason });
    if (!config || !config.api || !config.projectId || typeof fetchImpl !== 'function') return fallback(false, '没有内源配置');
    let records;
    try {
      const list = await getJson(fetchImpl, `${config.api}by_project_id?projectId=${config.projectId}&currentPage=1&pageSize=100`, timeoutMs);
      if (!list || String(list.code) !== '0' || !list.data || !Array.isArray(list.data.records)) throw new Error('版本列表格式不对');
      records = list.data.records;
    } catch (e) { return fallback(false, `内源连不上：${e.message}`); }
    const norm = v => String(v || '').trim().toLowerCase();
    const hits = records.filter(r => r && r.id != null && (norm(r.version) === RELEASE || norm(r.version).startsWith(RELEASE + ' ')))
      .sort((a, b) => (Date.parse(b.releaseTime || '') || 0) - (Date.parse(a.releaseTime || '') || 0)).slice(0, 3);
    for (const rec of hits) {
      try {
        const detail = await getJson(fetchImpl, `${config.api}by_id?id=${encodeURIComponent(rec.id)}`, timeoutMs);
        const pkgs = detail && detail.data && Array.isArray(detail.data.binaryPackages) ? detail.data.binaryPackages : [];
        const pkg = pkgs.find(p => p && String(p.originalFileName || '').toLowerCase() === FILE && safeFileUrl(p.url, config.fileSite));
        if (!pkg) continue;
        const urls = cleanUrls((await getJson(fetchImpl, safeFileUrl(pkg.url, config.fileSite), timeoutMs)).urls);
        if (!urls.length) continue;
        writeCache(dataDir, urls, now());
        return { urls, from: 'openx', openxReachable: true, reason: '' };
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

module.exports = { createReceiverAddress, cleanUrl, cleanUrls, allowedHost, readCache, cacheFile, RELEASE, FILE };
