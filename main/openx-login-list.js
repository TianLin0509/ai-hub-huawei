'use strict';
// 借本人 Edge 登录查内源版本列表（R63，2026-11-28）：检查更新的第三条路。
// 背景：内源「版本列表」接口（by_project_id）11-27 起匿名回「未认证的请求」，客户端改读版本索引（by_id 匿名可读）；
// 索引也读不到（by_id 被收紧、索引过期）时，这里复用公司页面取数那套无头 Edge（main/company-edge-capture.js runInEdge：
// 以 Authorization: Bearer 头发出；只带 cookie 不行）调同源的版本列表接口，并顺带取最近几个程序版本的详情（附件列表）。
// 什么时候调用由 core/app-update/openx-source.js 决定（listViaLogin：索引和匿名列表都不行时，同一轮只开一次）。
const openxSource = require('../core/app-update/openx-source');
const openxConfig = require('../core/app-update/openx-config');
const capture = require('./company-edge-capture');
const { findEdge } = require('./edge-headless');

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DETAIL_COUNT = 8;
// 页面里点一次顶栏「登录」前先等这么久（下载页允许匿名浏览、没自动跳单点登录时；与下载记账同一做法）。
const CLICK_LOGIN_AFTER_MS = 4000;

function buildLoginListScript({ apiPath, projectId, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, detailCount = DETAIL_COUNT, clickLoginAfterMs = CLICK_LOGIN_AFTER_MS } = {}) {
  const cfg = JSON.stringify({ apiPath: String(apiPath || ''), projectId: Number(projectId) || 0, pageSize, maxPages, detailCount, clickLoginAfterMs });
  return `(async () => {
    const cfg = ${cfg};
    let token = '';
    try { token = localStorage.getItem('token') || sessionStorage.getItem('token') || ''; } catch (_) {}
    if (!token) {
      // 停在匿名浏览：过一会儿点一次顶栏「登录」触发单点登录（每个页面只点一次）。
      window.__hubLoginSeenAt = window.__hubLoginSeenAt || Date.now();
      if (!window.__hubLoginClicked && Date.now() - window.__hubLoginSeenAt >= cfg.clickLoginAfterMs) {
        window.__hubLoginClicked = true;
        for (const el of Array.from(document.querySelectorAll('a, button, span, div'))) {
          const r = el.getBoundingClientRect();
          if (!r || r.width < 16 || r.height < 12 || r.top > 120) continue;
          const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text === '登录' || text === '立即登录') { el.click(); break; }
        }
      }
      return { needsLogin: true, reason: 'no-token' };
    }
    const headers = { Authorization: 'Bearer ' + token };
    const get = async url => {
      const r = await fetch(url, { headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
      let body = null;
      try { body = await r.json(); } catch (_) {}
      return { status: r.status, body };
    };
    const unauth = r => r.status === 401 || r.status === 403 || !!(r.body && /^(401|403)$/.test(String(r.body.code)));
    const good = r => !!(r.body && String(r.body.code) === '0' && r.body.data);
    const listUrl = n => cfg.apiPath + 'by_project_id?projectId=' + cfg.projectId + '&currentPage=' + n + '&pageSize=' + cfg.pageSize;
    const trim = x => ({ id: x.id, version: String(x.version == null ? '' : x.version), releaseTime: String(x.releaseTime || '') });
    let first;
    try { first = await get(listUrl(1)); } catch (e) { return { ok: false, reason: 'list-fetch-' + String(e && e.name || 'error') }; }
    if (unauth(first)) return { needsLogin: true, reason: 'list-unauth' };
    if (!good(first) || !Array.isArray(first.body.data.records)) return { ok: false, reason: 'list-bad-' + first.status };
    const data = first.body.data;
    const total = Number(data.total) || 0;
    const pages = Math.min(cfg.maxPages, total ? Math.ceil(total / cfg.pageSize) : 1);
    let partial = false;
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => get(listUrl(i + 2))
      .then(r => (good(r) && Array.isArray(r.body.data.records) ? r.body.data.records : (partial = true, [])), () => (partial = true, []))));
    const records = [data.records, ...rest].flat().filter(x => x && x.id != null).map(trim);
    // 最近几个程序版本（版本名以数字版本号开头，不含 member-*）的附件列表；by_id 匿名可读时这些是多取的，被收紧时靠它找清单和更新包。
    const apps = records.filter(x => /^v?\\d+\\.\\d+\\.\\d+(?:\\s|$)/i.test(x.version.trim())).slice(0, cfg.detailCount);
    const details = (await Promise.all(apps.map(x => get(cfg.apiPath + 'by_id?id=' + encodeURIComponent(x.id)).then(r => {
      if (!good(r)) return null;
      const d = r.body.data;
      const pkgs = Array.isArray(d.binaryPackages) ? d.binaryPackages : [];
      return { id: x.id, version: d.version != null ? String(d.version) : x.version,
        binaryPackages: pkgs.filter(Boolean).map(p => ({ id: p.id, originalFileName: String(p.originalFileName || ''), url: String(p.url || ''), tag: String(p.tag || ''), urlSource: p.urlSource })) };
    }, () => null)))).filter(Boolean);
    return { ok: true, records, total, name: typeof data.name === 'string' ? data.name : '', details, partial };
  })()`;
}

// 给用户看的失败原因（短句，会接在「借 Edge 登录也没查到：」后面）。permanent：重试也没用，同一进程里到下次手动检查前不再开 Edge。
function reasonOf(r) {
  const e = String((r && r.error) || '');
  if (/没有找到 Edge/.test(e)) return { reason: '本机没有找到 Edge 浏览器', permanent: true };
  if (r && r.needsLogin) return { reason: 'Edge 里还没登录内源' };
  if (/还没登录好/.test(e)) return { reason: 'Edge 里还没登录内源，或登录已过期' };
  if (/已取消/.test(e)) return { reason: '已超时取消' };
  return { reason: e ? e.slice(0, 80) : '没查到' };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 返回注入给 openx-source.setLoginLister 的函数：({ projectId, timeoutMs }) → { ok, records, details, name } 或 { ok:false, reason, permanent }。
function createOpenxLoginLister({ env = process.env, logger = console, runInEdge = capture.runInEdge, findEdgeFn = findEdge,
  pageUrl = () => openxSource.downloadPageUrl(), apiUrl = openxConfig.api } = {}) {
  return async ({ projectId = openxSource.PROJECT_ID, timeoutMs = openxSource.LOGIN_BUDGET_MS } = {}) => {
    if (!openxSource.active(env)) return { ok: false, reason: '不是公司版，不借 Edge 登录', permanent: true };
    if (!findEdgeFn(env)) return { ok: false, reason: '本机没有找到 Edge 浏览器', permanent: true };
    const url = String(pageUrl() || '');
    let host = '', apiPath = '';
    try { host = new URL(url).host; apiPath = new URL(apiUrl).pathname; } catch (_) {}
    if (!host || !apiPath) return { ok: false, reason: '没有内源页面地址', permanent: true };
    const budget = Math.max(1000, Number(env.AI_HUB_OPENX_LOGIN_MS) || Number(timeoutMs) || openxSource.LOGIN_BUDGET_MS);
    // 整体（含起 Edge）不超过 budget；页面里的等待比整体少 2 秒，给起停留余量。
    const signal = AbortSignal.timeout(budget);
    const startedAt = Date.now();
    let r;
    try {
      r = await runInEdge({ url, readyUrl: new RegExp('^https://' + escapeRe(host) + '/', 'i'), script: buildLoginListScript({ apiPath, projectId }),
        accept: v => !!v && !v.needsLogin, signal, timeoutMs: Math.max(1000, budget - 2000), loginGraceMs: Math.max(1000, budget - 3000),
        tag: 'hub-edge-openx-list', logger, env });
    } catch (error) { r = { ok: false, error: error && error.message ? error.message : String(error) }; }
    const tookMs = Date.now() - startedAt;
    const v = r && r.ok ? r.value : null;
    if (v && v.ok) {
      logger.info?.(`[app-update] 借 Edge 登录查到内源版本 ${Array.isArray(v.records) ? v.records.length : 0} 个（${tookMs} ms）`);
      return { ok: true, records: v.records, details: v.details, name: v.name, partial: !!v.partial, tookMs };
    }
    const why = v ? { reason: `登录后版本列表接口没给结果（${String(v.reason || '').slice(0, 40)}）` } : reasonOf(r);
    logger.info?.(`[app-update] 借 Edge 登录查内源版本没成：${why.reason}（${tookMs} ms）`);
    return { ok: false, ...why, tookMs };
  };
}

// 只在 Hub 程序（Electron）里默认开；纯 Node 跑的单测和脚本不开（免得测试在本机真的拉起 Edge）。
// AI_HUB_OPENX_LOGIN_LIST=0 关掉（排查用），=1 强制开（隔离验证用）。
function loginListEnabled(env = process.env, versions = process.versions) {
  const v = String(env.AI_HUB_OPENX_LOGIN_LIST || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !!(versions && versions.electron);
}

module.exports = { createOpenxLoginLister, buildLoginListScript, loginListEnabled, PAGE_SIZE, DETAIL_COUNT };
