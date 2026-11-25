'use strict';
// 公司内源下载记录器（2026-11-25）：
// 背景：Hub 自动更新直连对象存储文件，速度快且稳定，但匿名直连不会计入内源社区的实名下载统计。
// 做法（双轨无感）：
//   1. 主轨下载与 SHA-256 校验完全不变，零额外等待；
//   2. 真正下载并校验通过后（大版本与小版本/静默更新均触发；「检查更新」永不触发），在后台拉起无头 Edge，
//      借本机 Edge 登录态打开内源项目下载页，等单点登录就绪后定位对应版本与附件并触发一次真实下载动作，
//      确认下载/接口请求已发出后立即取消大文件传输并回收临时目录，不弹窗、不抢焦点、不写盘残留；
//   3. 任意一步失败静默降级，绝不影响正常更新流程；同时持久化待补记任务，若用户点「立即重启」打断了
//      后台记录，新版启动后延迟补记一次，避免「全回退」。
const fs = require('fs');
const path = require('path');
const openxSource = require('../core/app-update/openx-source');
const { launchHeadlessEdge, connectCdp, findEdge } = require('./edge-headless');
const { copyLogin, looksLikeLogin } = require('./company-edge-capture');

const RECORD_FILE = 'openx-download-record.json';
const OFF_FLAG_FILE = 'openx-record-off.flag';
const MAX_RECORDED_VERSIONS = 200;
const MAX_PENDING_ATTEMPTS = 2;
const MAX_PENDING_QUEUE = 5;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESUME_DELAY_MS = 45000;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_LOGIN_GRACE_MS = 45000;
const START_WAIT_MS = 45000;
const ERROR_PAGE_MS = 8000;
const ERROR_PAGE_RETRIES = 1;
const MAX_PAGES = 10;

const delay = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
const normVersion = v => openxSource.normVersion(v);
const netCode = t => String(t || '').replace(/^net::/, '').trim();

// 模块级正在运行的无头 Edge 集合，供 Hub 退出时同步收尾。
const running = new Set();
function killAll() {
  for (const h of running) {
    try { h.closeSync(); } catch (_) { /* 已退出 */ }
  }
  running.clear();
}

function recordKeyOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return normVersion(item);
  if (item.kind === 'component') {
    const rel = String(item.releaseVersion || item.file || item.version || '').trim().toLowerCase();
    return rel ? `rel:${rel}` : '';
  }
  return normVersion(item.version || item.releaseVersion || '');
}

function emptyStore() {
  return {
    version: 1,
    recorded: {},
    pending: null,
    pendingQueue: [],
    stats: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      lastStatus: '',
      lastReason: '',
      lastVersion: '',
      lastAt: '',
      lastTookMs: 0,
      lastApiPaths: [],
      lastApiRequests: [],
    },
  };
}

function loadStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    const base = emptyStore();
    const pq = Array.isArray(raw.pendingQueue)
      ? raw.pendingQueue.filter(x => x && typeof x === 'object').slice(0, MAX_PENDING_QUEUE)
      : (raw.pending && typeof raw.pending === 'object' ? [{ ...raw.pending }] : []);
    return {
      version: 1,
      recorded: raw.recorded && typeof raw.recorded === 'object' ? { ...raw.recorded } : {},
      pending: pq[0] || null,
      pendingQueue: pq,
      stats: { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
    };
  } catch (_) {
    return emptyStore();
  }
}

function pruneRecorded(recorded) {
  const entries = Object.entries(recorded || {});
  if (entries.length <= MAX_RECORDED_VERSIONS) return recorded;
  entries.sort((a, b) => Date.parse(b[1]?.at || '') - Date.parse(a[1]?.at || ''));
  return Object.fromEntries(entries.slice(0, MAX_RECORDED_VERSIONS));
}

function saveStore(file, data) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const next = { ...data, recorded: pruneRecorded(data.recorded) };
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    try { fs.renameSync(tmp, file); }
    catch (_) {
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
  } catch (_) { /* 写盘失败不影响主流程 */ }
}

// 仅保留非敏感的路径片段用于排错观察，去掉查询参数、令牌和纯数字 ID。
function sanitizeApiPath(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const p = u.pathname || '';
    if (!/\/openxApi\//i.test(p)) return '';
    return p.replace(/\/\d{3,}(?=\/|$)/g, '/:id').slice(0, 140);
  } catch (_) {
    return '';
  }
}

function isDownloadLikeUrl(rawUrl, targetFile = '') {
  try {
    const u = new URL(String(rawUrl || ''));
    const host = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();
    if (/\/visitopenxrecord\/|\/index\/admin\//i.test(p)) return false;
    if (targetFile && p.includes(String(targetFile).toLowerCase())) return true;
    if (host.startsWith('file.') || p.includes('/openx-file/')) return true;
    if (/\.(?:gz|exe|zip|7z|msi|bin)(?:$|\?)/i.test(p)) return true;
    if (/\/openxApi\/.*(?:download|record|count|binary|attach)/i.test(p)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

// 页面状态与实名登录就绪探针：必须确认已实名登录（token 或退出入口或 admin/info code=0）才点击下载。
const AUTH_PAGE_STATE_SCRIPT = `(async () => {
  const t = document.body ? document.body.innerText : '';
  const head = t.slice(0, 3000);
  const errorPage = location.protocol === 'chrome-error:' || location.host === 'chromewebdata';
  const netError = errorPage ? ((t.match(/(?:^|[^A-Z_])((?:ERR|DNS_PROBE)_[A-Z_]+)/) || [])[1] || '') : '';
  const hasPassword = !!document.querySelector('input[type=password]');
  const hasQr = /扫码登录|二维码/.test(head);
  let hasToken = false;
  try { hasToken = !!(localStorage.getItem('token') || sessionStorage.getItem('token')); } catch (_) {}
  const hasLogout = /(?:^|\\s|，|,)退出(?:\\s|$)/.test(head.slice(0, 500));
  const hasReleases = t.includes('二进制下载') || t.includes('发布时间');
  let authOk = false;
  if (!errorPage && document.readyState === 'complete') {
    if (hasToken || hasLogout) {
      authOk = true;
    } else {
      try {
        const res = await fetch('/openxApi/index/admin/info', { credentials: 'include', cache: 'no-store' });
        if (res && res.ok) {
          const body = await res.json().catch(() => null);
          if (body && (String(body.code) === '0' || body.code === 200) && body.data) authOk = true;
        }
      } catch (_) {}
    }
  }
  return {
    host: location.host,
    pathname: location.pathname,
    href: location.origin + location.pathname,
    ready: document.readyState,
    errorPage,
    netError,
    hasPassword,
    hasQr,
    hasToken,
    hasLogout,
    authOk,
    hasReleases,
  };
})()`;

// 若下载页允许匿名浏览且未自动跳转单点登录，尝试点一次顶栏「登录」触发单点登录。
const CLICK_LOGIN_SCRIPT = `(() => {
  const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (!r || r.width < 16 || r.height < 12 || r.top > 120) continue;
    const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text === '登录' || text === '立即登录') {
      el.click();
      return true;
    }
  }
  return false;
})()`;

// 在真实内源下载页 DOM 里定位目标版本卡片和目标附件的可点击坐标（支持按 packageTag、文件名、文件类型逐级兜底）。
function buildLocateScript(target = {}) {
  const payload = JSON.stringify({
    releaseVersion: String(target.releaseVersion || '').trim(),
    version: normVersion(target.version || ''),
    packageTag: String(target.packageTag || '').trim(),
    file: String(target.file || '').trim(),
  });
  return `(() => {
    const cfg = ${payload};
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const visible = el => {
      if (!el || el.nodeType !== 1) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const centerOf = el => {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    const findNextBtn = () => {
      const sels = ['.btn-next', '[aria-label*="next" i]', '[title*="下一页"]', '.el-pagination .btn-next', '.ant-pagination-next'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(String(el.className || ''))) return el;
      }
      for (const el of document.querySelectorAll('button, a, li')) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const t = norm(el.innerText || el.textContent);
        if (t === '下一页' || t === '>') return el;
      }
      return null;
    };

    const rv = norm(cfg.releaseVersion);
    const rvLower = rv.toLowerCase();
    const ver = cfg.version;
    const verV = ver ? ('v' + ver).toLowerCase() : '';
    const verPlain = ver.toLowerCase();
    const releaseScore = text => {
      const t = norm(text);
      if (!t || t.length > 90) return 0;
      const tl = t.toLowerCase();
      if (rvLower && tl === rvLower) return 3;
      if (verV && (tl === verV || tl.startsWith(verV + ' '))) return 2;
      if (verPlain && (tl === verPlain || tl.startsWith(verPlain + ' '))) return 2;
      return 0;
    };

    const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, span, div, p, a, strong, b, li'));
    const headings = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const score = releaseScore(el.innerText || el.textContent);
      if (!score) continue;
      const hasChildHit = Array.from(el.children || []).some(ch => releaseScore(ch.innerText || ch.textContent) >= score);
      if (hasChildHit) continue;
      headings.push({ el, score, len: norm(el.innerText || el.textContent).length });
    }
    headings.sort((a, b) => b.score - a.score || a.len - b.len);
    if (!headings.length) {
      return { found: false, reason: 'release-not-found', hasNext: !!findNextBtn() };
    }

    // 向上找到包含本版本和「二进制下载」的最小单个版本卡片。
    let card = null;
    for (const h of headings) {
      let cur = h.el.parentElement;
      for (let depth = 0; cur && cur !== document.body && depth < 12; depth += 1) {
        const txt = String(cur.innerText || '');
        if (txt.includes('二进制下载') || cur.querySelector('a[href*="/openx-file/"], a[download]')) {
          const releasesInBox = (txt.match(/发布时间/g) || []).length;
          if (releasesInBox <= 1) { card = cur; break; }
          if (!card && releasesInBox <= 2) card = cur;
        }
        cur = cur.parentElement;
      }
      if (card) break;
    }
    if (!card) card = headings[0].el.parentElement || document.body;

    const wantTag = norm(cfg.packageTag);
    const wantTagLower = wantTag.toLowerCase();
    const wantFile = norm(cfg.file);
    const wantFileLower = wantFile.toLowerCase();
    const isDelta = /-update-delta\\.gz$/i.test(wantFile);
    const isCompleteGz = /-update\\.gz$/i.test(wantFile) && !isDelta;
    const isExe = /\\.exe$/i.test(wantFile);
    const isPortable = /-win-x64\\.zip$/i.test(wantFile);

    const scoreItem = el => {
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 260) return 0;
      const tl = t.toLowerCase();
      const title = norm(el.getAttribute('title') || '').toLowerCase();
      const href = String(el.getAttribute('href') || '').toLowerCase();
      const dl = String(el.getAttribute('download') || '').toLowerCase();
      if (t === '二进制下载' || t === '修改' || t === '删除') return 0;
      if (wantTagLower && (tl === wantTagLower || title === wantTagLower)) return 100;
      if (wantTagLower && wantTagLower.length >= 6 && tl.includes(wantTagLower) && t.length <= wantTag.length + 40) return 90;
      if (wantFileLower && (tl.includes(wantFileLower) || title.includes(wantFileLower) || href.includes(wantFileLower) || dl.includes(wantFileLower))) return 80;
      if (isDelta && (tl.includes('update-delta.gz') || t.includes('增量小包'))) return 70;
      if (isCompleteGz && ((tl.includes('update.gz') && !tl.includes('delta')) || t.includes('完整更新包'))) return 70;
      if (isExe && t.includes('安装版') && !t.includes('免安装')) return 70;
      if (isPortable && t.includes('免安装')) return 70;
      return 0;
    };

    const items = [];
    for (const el of card.querySelectorAll('a, button, span, div, li, p')) {
      if (!visible(el)) continue;
      const sc = scoreItem(el);
      if (!sc) continue;
      const childHasSame = Array.from(el.children || []).some(ch => visible(ch) && scoreItem(ch) >= sc);
      if (childHasSame) continue;
      const interactive = el.matches('a, button, [role="button"]') ? 1 : 0;
      items.push({ el, score: sc, interactive, len: norm(el.innerText || el.textContent).length });
    }

    // 兜底：若该版本卡片里没按标签/文件名匹配到，找「二进制下载」下的第一个附件项。
    if (!items.length) {
      const binHeader = Array.from(card.querySelectorAll('span, div, p, button, a, h4, h5'))
        .find(el => visible(el) && norm(el.innerText || el.textContent) === '二进制下载');
      for (const el of card.querySelectorAll('a, button, li, span, div')) {
        if (!visible(el) || el === binHeader) continue;
        const t = norm(el.innerText || el.textContent);
        const href = String(el.getAttribute('href') || '');
        if (!t || t.length > 220) continue;
        if (binHeader && !(binHeader.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (/\\.(?:gz|exe|zip)/i.test(t) || /\\/openx-file\\//i.test(href) || /安装版/.test(t)) {
          const childMatch = Array.from(el.children || []).some(ch => visible(ch) && (/\\.(?:gz|exe|zip)/i.test(norm(ch.innerText || ch.textContent)) || /安装版/.test(norm(ch.innerText || ch.textContent))));
          if (!childMatch) items.push({ el, score: 40, interactive: el.matches('a, button') ? 1 : 0, len: t.length });
        }
      }
      if (!items.length && binHeader) {
        return { found: false, reason: 'package-collapsed-or-missing', needsExpand: true, expandPoint: centerOf(binHeader) };
      }
    }

    if (!items.length) {
      return { found: false, reason: 'package-not-found', hasNext: false };
    }

    items.sort((a, b) => b.score - a.score || b.interactive - a.interactive || a.len - b.len);
    const chosen = items[0];
    const primaryEl = chosen.el.closest('a, button, [role="button"]') || chosen.el;
    const primaryPoint = centerOf(primaryEl);
    const altPoints = [];
    const seenPt = new Set([primaryPoint.x + ',' + primaryPoint.y]);
    let row = chosen.el.closest('li, tr, [class*="item"], [class*="row"], [class*="file"], [class*="binary"], [class*="package"]') || chosen.el.parentElement;
    const collectAlts = container => {
      if (!container || container === card) return;
      for (const cand of container.querySelectorAll('a, button, [role="button"], svg, i, [class*="download"], [class*="icon"]')) {
        if (!visible(cand) || cand === primaryEl) continue;
        const pt = centerOf(cand);
        const key = pt.x + ',' + pt.y;
        if (seenPt.has(key)) continue;
        if (Math.hypot(pt.x - primaryPoint.x, pt.y - primaryPoint.y) < 8) continue;
        seenPt.add(key);
        altPoints.push(pt);
        if (altPoints.length >= 2) break;
      }
    };
    collectAlts(row);
    if (!altPoints.length && row && row.parentElement && row.parentElement !== card && norm(row.parentElement.innerText || '').length < 320) {
      collectAlts(row.parentElement);
    }
    return {
      found: true,
      score: chosen.score,
      matchedText: norm(chosen.el.innerText || chosen.el.textContent).slice(0, 100),
      point: primaryPoint,
      altPoints,
    };
  })()`;
}

const CLICK_NEXT_PAGE_SCRIPT = `(() => {
  const sels = ['.btn-next', '[aria-label*="next" i]', '[title*="下一页"]', '.el-pagination .btn-next', '.ant-pagination-next'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/disabled/i.test(String(el.className || ''))) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
  }
  for (const el of document.querySelectorAll('button, a, li')) {
    const t = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if ((t === '下一页' || t === '>') && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
  }
  return false;
})()`;

async function clickPoint(cdp, pt) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: pt.x, y: pt.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: pt.x, y: pt.y });
}

// 真实无头 Edge 会话：登录内源下载页 → 定位版本与附件 → 点击触发真实下载记录 → 确认后取消大文件并回收。
async function defaultRunSession(target, {
  env = process.env,
  logger = console,
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loginGraceMs = DEFAULT_LOGIN_GRACE_MS,
  pollMs = 700,
  launchEdge = launchHeadlessEdge,
  connect = connectCdp,
  findEdgeFn = findEdge,
} = {}) {
  const started = Date.now();
  const pageUrl = String(target.pageUrl || '').trim();
  if (!pageUrl) return { ok: false, reason: '无可用内源下载页地址', transient: false, tookMs: 0 };
  let targetHost = '';
  try { targetHost = new URL(pageUrl).host.toLowerCase(); }
  catch (_) { return { ok: false, reason: '内源下载页地址无效', transient: false, tookMs: 0 }; }
  if (!findEdgeFn(env)) return { ok: false, reason: '本机没有找到 Edge', transient: false, tookMs: 0 };

  let edge = null;
  let cdp = null;
  let loginCopy = null;
  const observedApi = new Set();
  const observedReq = new Set();
  const inflightApi = new Set();
  const dlEvents = [];
  let clickAt = 0;
  let postClickDownloadHit = false;

  const onEvent = msg => {
    if (!msg || !msg.method) return;
    const p = msg.params || {};
    if (msg.method === 'Browser.downloadWillBegin' || msg.method === 'Page.downloadWillBegin') {
      dlEvents.push({ guid: p.guid || '', url: p.url || '', file: p.suggestedFilename || '', at: Date.now() });
      if (clickAt) postClickDownloadHit = true;
      return;
    }
    if (msg.method === 'Target.targetCreated') {
      const u = p.targetInfo?.url || '';
      if (clickAt && isDownloadLikeUrl(u, target.file)) postClickDownloadHit = true;
      return;
    }
    if (msg.method === 'Network.requestWillBeSent') {
      const u = p.request?.url || '';
      if (clickAt) {
        const apiPath = sanitizeApiPath(u);
        if (apiPath) {
          const verb = String(p.request?.method || 'GET').toUpperCase();
          observedApi.add(apiPath);
          observedReq.add(`${verb} ${apiPath}`);
          if (p.requestId) inflightApi.add(p.requestId);
        }
        if (isDownloadLikeUrl(u, target.file)) postClickDownloadHit = true;
      }
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const headers = p.response?.headers || {};
      const disp = String(headers['content-disposition'] || headers['Content-Disposition'] || '');
      if (clickAt && /attachment/i.test(disp)) postClickDownloadHit = true;
      return;
    }
    if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      if (p.requestId) inflightApi.delete(p.requestId);
    }
  };

  try {
    edge = await launchEdge({
      startWaitMs: START_WAIT_MS,
      purpose: '内源下载记录',
      tag: 'hub-edge-openx',
      env,
      logger,
      signal,
      maxLifeMs: timeoutMs + 60000,
      prepare: tmp => { loginCopy = copyLogin(tmp, env); },
    });
    running.add(edge);
    const deadline = Date.now() + timeoutMs;

    let page = null;
    for (let i = 0; i < 20 && !page; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        page = Array.isArray(list) ? list.find(t => t && t.type === 'page') : null;
      } catch (_) { /* 还没起来 */ }
      if (!page) await delay(300);
    }
    if (!page || !page.webSocketDebuggerUrl) throw new Error('无头 Edge 没有启动');

    cdp = await connect(page.webSocketDebuggerUrl, { openMs: 10000, sendMs: 15000, onEvent });
    const dlDir = path.join(edge.tmp, 'dl');
    fs.mkdirSync(dlDir, { recursive: true });
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch?.(() => {});
    const dlBeh = await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
    if (dlBeh && dlBeh.error) {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    }

    const nav = await cdp.send('Page.navigate', { url: pageUrl });
    let lastNetError = netCode(nav?.result?.errorText);
    let st = {};
    let loginSince = 0;
    let anonSince = 0;
    let clickedLogin = false;
    let errorSince = 0;
    let renav = 0;
    let ready = false;
    let failReason = '';

    // 1. 等单点登录与下载页渲染就绪。
    while (Date.now() < deadline && !ready) {
      await delay(pollMs);
      if (signal?.aborted) { failReason = '已取消'; break; }
      if (cdp.closed || edge.closed) { failReason = '和无头 Edge 的连接断了'; break; }
      const ev = await cdp.send('Runtime.evaluate', { expression: AUTH_PAGE_STATE_SCRIPT, returnByValue: true, awaitPromise: true });
      st = ev?.result?.result?.value || {};
      if (st.errorPage) {
        if (st.netError) lastNetError = st.netError;
        errorSince = errorSince || Date.now();
        if (Date.now() - errorSince < ERROR_PAGE_MS) continue;
        if (renav < ERROR_PAGE_RETRIES) {
          renav += 1; errorSince = 0;
          await cdp.send('Page.navigate', { url: pageUrl });
          continue;
        }
        failReason = `页面没有打开（${lastNetError || '网络错误'}）`;
        break;
      }
      errorSince = 0;
      const onTarget = String(st.host || '').toLowerCase() === targetHost;
      if (looksLikeLogin(st, onTarget)) {
        loginSince = loginSince || Date.now();
        if (Date.now() - loginSince >= loginGraceMs) {
          failReason = `需要登录（停在 ${st.host || '登录页'}）`;
          break;
        }
        continue;
      }
      loginSince = 0;
      if (!onTarget || st.ready !== 'complete') continue;
      if (!st.authOk) {
        anonSince = anonSince || Date.now();
        if (!clickedLogin && Date.now() - anonSince >= 4000) {
          clickedLogin = true;
          await cdp.send('Runtime.evaluate', { expression: CLICK_LOGIN_SCRIPT, returnByValue: true });
          continue;
        }
        if (Date.now() - anonSince >= loginGraceMs) {
          failReason = '内源下载页未完成实名登录';
          break;
        }
        continue;
      }
      // 已实名登录且在目标主机，但若登录回调落回项目首页而非 /download，主动跳去下载页。
      if (!String(st.pathname || '').toLowerCase().includes('/download')) {
        await cdp.send('Page.navigate', { url: pageUrl });
        await delay(1000);
        continue;
      }
      if (!st.hasReleases) continue;
      ready = true;
    }

    if (!ready) {
      return {
        ok: false,
        needsLogin: !!loginSince || !!anonSince,
        transient: !signal?.aborted,
        reason: failReason || '内源下载页打开超时',
        loginCopy,
        tookMs: Date.now() - started,
      };
    }

    // 2. 在下载页定位版本与附件（支持展开折叠区、最多翻 3 页）。
    let located = null;
    for (let pageNo = 1; pageNo <= MAX_PAGES && Date.now() < deadline; pageNo += 1) {
      let loc = (await cdp.send('Runtime.evaluate', { expression: buildLocateScript(target), returnByValue: true }))?.result?.result?.value;
      if (loc && loc.needsExpand && loc.expandPoint) {
        await clickPoint(cdp, loc.expandPoint);
        await delay(1200);
        loc = (await cdp.send('Runtime.evaluate', { expression: buildLocateScript(target), returnByValue: true }))?.result?.result?.value;
      }
      if (loc && loc.found) { located = loc; break; }
      if (!loc || !loc.hasNext || pageNo >= MAX_PAGES) break;
      const moved = (await cdp.send('Runtime.evaluate', { expression: CLICK_NEXT_PAGE_SCRIPT, returnByValue: true }))?.result?.result?.value;
      if (!moved) break;
      await delay(1800);
    }

    if (!located || !located.found || !located.point) {
      return {
        ok: false,
        needsLogin: false,
        transient: false,
        reason: '内源下载页未找到目标版本或附件',
        loginCopy,
        tookMs: Date.now() - started,
      };
    }

    // 3. 点击附件并等待下载或接口信号确认（不触发则试同行备用图标一次）。
    const points = [located.point, ...(Array.isArray(located.altPoints) ? located.altPoints : [])];
    for (const pt of points) {
      clickAt = Date.now();
      await clickPoint(cdp, pt);
      const waitUntil = Math.min(deadline, Date.now() + 3500);
      while (Date.now() < waitUntil && !postClickDownloadHit && !dlEvents.length) {
        if (signal?.aborted || cdp.closed || edge.closed) break;
        await delay(200);
      }
      if (postClickDownloadHit || dlEvents.length) break;
    }

    if (!postClickDownloadHit && !dlEvents.length) {
      return {
        ok: false,
        needsLogin: false,
        transient: true,
        reason: '点击附件后未观测到下载请求',
        matchedText: located.matchedText || '',
        apiPaths: [...observedApi].slice(0, 12),
        loginCopy,
        tookMs: Date.now() - started,
      };
    }

    // 4. 等点击后的业务统计请求落地（至少 1.2 秒、最多 2.5 秒），随后取消大文件下载并回收。
    const settleMin = Date.now() + 1200;
    const settleMax = Math.min(deadline, Date.now() + 2500);
    while (Date.now() < settleMax) {
      if (Date.now() >= settleMin && inflightApi.size === 0) break;
      await delay(150);
    }
    for (const ev of dlEvents) {
      if (ev.guid) {
        try { await cdp.send('Browser.cancelDownload', { guid: ev.guid }, 2000); } catch (_) {}
      }
    }

    return {
      ok: true,
      method: 'dom-click',
      matchedText: located.matchedText || '',
      downloadTriggered: dlEvents.length > 0 || postClickDownloadHit,
      apiPaths: [...observedApi].slice(0, 12),
      apiRequests: [...observedReq].slice(0, 12),
      loginCopy,
      tookMs: Date.now() - started,
    };
  } catch (error) {
    const msg = error && error.message ? error.message : String(error || '未知错误');
    return {
      ok: false,
      needsLogin: false,
      transient: !/没有找到 Edge|已取消/.test(msg),
      reason: msg,
      loginCopy,
      tookMs: Date.now() - started,
    };
  } finally {
    try { cdp?.close(); } catch (_) {}
    if (edge) {
      running.delete(edge);
      await edge.close();
    }
  }
}

function createOpenxDownloadRecorder({
  dataDir,
  env = process.env,
  fetchImpl = null,
  logger = console,
  onChange = () => {},
  runSession = null,
  now = Date.now,
  resumeDelayMs = Number(env.AI_HUB_OPENX_RECORD_RESUME_DELAY_MS) || DEFAULT_RESUME_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  loginGraceMs = DEFAULT_LOGIN_GRACE_MS,
} = {}) {
  const baseDir = dataDir ? path.join(dataDir, 'app-update') : '';
  const stateFile = baseDir ? path.join(baseDir, RECORD_FILE) : '';
  const offFlagFile = baseDir ? path.join(baseDir, OFF_FLAG_FILE) : '';
  const hasInjectedRunner = typeof runSession === 'function';
  const sessionRunner = hasInjectedRunner ? runSession : defaultRunSession;

  let store = stateFile ? loadStore(stateFile) : emptyStore();
  let queue = Promise.resolve();
  let resumeTimer = null;
  let activeAbort = null;
  let disposed = false;

  const isFeatureActive = () => {
    if (env.AI_HUB_OPENX_RECORD === '0') return false;
    return hasInjectedRunner || openxSource.active(env);
  };

  const isEnabled = () => {
    if (!isFeatureActive()) return false;
    if (!offFlagFile) return true;
    try { return !fs.existsSync(offFlagFile); } catch (_) { return true; }
  };

  const persist = () => { if (stateFile) saveStore(stateFile, store); };

  const notify = info => {
    try { onChange(info); } catch (_) {}
  };

  const syncPendingHead = () => {
    store.pendingQueue = (store.pendingQueue || []).slice(0, MAX_PENDING_QUEUE);
    store.pending = store.pendingQueue[0] || null;
  };
  const upsertPending = entry => {
    const key = recordKeyOf(entry);
    if (!key) return;
    const idx = (store.pendingQueue || []).findIndex(x => recordKeyOf(x) === key);
    if (idx >= 0) store.pendingQueue[idx] = entry;
    else store.pendingQueue.push(entry);
    if (store.pendingQueue.length > MAX_PENDING_QUEUE) {
      store.pendingQueue = store.pendingQueue.slice(-MAX_PENDING_QUEUE);
    }
    syncPendingHead();
  };
  const removePending = key => {
    if (!key) return;
    store.pendingQueue = (store.pendingQueue || []).filter(x => recordKeyOf(x) !== key);
    syncPendingHead();
  };

  function setEnabled(on) {
    if (!offFlagFile) return isEnabled();
    try {
      if (on) {
        fs.rmSync(offFlagFile, { force: true });
      } else {
        fs.mkdirSync(path.dirname(offFlagFile), { recursive: true });
        fs.writeFileSync(offFlagFile, new Date(now()).toISOString(), 'utf8');
        if (store.pendingQueue.length || store.pending) {
          store.pendingQueue = [];
          syncPendingHead();
          persist();
        }
      }
    } catch (error) {
      logger.warn?.('[openx-record] 保存内源下载记录开关失败：', error.message);
    }
    return isEnabled();
  }

  function isRecorded(targetOrVersion) {
    const key = recordKeyOf(targetOrVersion);
    return !!(key && store.recorded && store.recorded[key]);
  }

  function statusFor(targetOrVersion) {
    const key = recordKeyOf(targetOrVersion);
    if (!key) return null;
    if (store.recorded && store.recorded[key]) {
      return { version: typeof targetOrVersion === 'string' ? normVersion(targetOrVersion) : (targetOrVersion.version || key), key, status: 'recorded', at: store.recorded[key].at, cached: true };
    }
    const p = (store.pendingQueue || []).find(x => recordKeyOf(x) === key);
    if (p) {
      return { version: p.version || key, key, status: 'pending', at: new Date(p.queuedAt || now()).toISOString() };
    }
    return null;
  }

  function normalizeTarget(raw = {}) {
    const kind = String(raw.kind || 'update').trim();
    const version = normVersion(raw.version || (kind === 'component' ? '' : raw.releaseVersion) || '');
    const releaseVersion = String(raw.releaseVersion || (version ? `v${version}` : '')).trim();
    const projectName = String(raw.projectName || openxSource.projectName() || '').trim();
    const pageUrl = String(raw.pageUrl || (projectName ? openxSource.downloadPageUrl(projectName) : '') || openxSource.downloadPageUrl() || '').trim();
    return {
      version,
      releaseId: raw.releaseId != null ? raw.releaseId : null,
      releaseVersion,
      packageId: raw.packageId != null ? raw.packageId : null,
      packageTag: String(raw.packageTag || '').trim(),
      file: String(raw.file || '').trim(),
      projectName,
      pageUrl,
      kind,
    };
  }

  async function executeRecord(item, { fromPending = false } = {}) {
    const key = recordKeyOf(item);
    const label = item.releaseVersion || item.version || key;
    if (disposed) return { version: item.version, key, status: 'skipped', reason: '已停止' };
    if (!isEnabled()) return { version: item.version, key, status: 'skipped', reason: '已关闭' };
    if (!key) return { version: '', key: '', status: 'skipped', reason: '无版本或发布标识' };
    if (isRecorded(item)) {
      removePending(key);
      persist();
      const rec = { version: item.version, key, status: 'recorded', at: store.recorded[key].at, cached: true };
      notify(rec);
      return rec;
    }

    // 解析下载页地址：优先用已保存的 pageUrl，否则从匿名 by_project_id 现取 data.name。
    let pageUrl = item.pageUrl;
    if (!pageUrl && fetchImpl) {
      pageUrl = await openxSource.resolveDownloadPageUrl({ fetchImpl, env, now });
    }
    if (!pageUrl) {
      store.stats.attempted += 1;
      store.stats.failed += 1;
      store.stats.lastStatus = 'failed';
      store.stats.lastReason = '无可用内源下载页地址';
      store.stats.lastVersion = label;
      store.stats.lastAt = new Date(now()).toISOString();
      removePending(key);
      persist();
      const out = { version: item.version, key, status: 'failed', reason: store.stats.lastReason };
      notify(out);
      return out;
    }

    const attempts = fromPending ? Number(item.attempts || 0) : 0;
    const nextPending = { ...item, pageUrl, queuedAt: item.queuedAt || now(), attempts };
    upsertPending(nextPending);
    persist();
    notify({ version: item.version, key, status: 'pending', at: new Date(now()).toISOString() });

    activeAbort = new AbortController();
    const signal = activeAbort.signal;
    let res;
    try {
      res = await sessionRunner({ ...item, pageUrl }, { env, logger, signal, timeoutMs, loginGraceMs });
    } catch (error) {
      res = { ok: false, transient: true, reason: error && error.message ? error.message : String(error) };
    } finally {
      activeAbort = null;
    }

    // Hub 正在退出（例如用户秒点「立即重启」）：保留已落盘的 pending，留给新版本启动后补记，不覆盖也不计失败。
    if (disposed) {
      return { version: item.version, key, status: 'skipped', reason: '进程退出待下次补记' };
    }

    const atIso = new Date(now()).toISOString();
    store.stats.attempted += 1;
    store.stats.lastVersion = item.kind === 'component' ? label : (item.version || label);
    store.stats.lastAt = atIso;
    store.stats.lastTookMs = Number(res?.tookMs || 0);
    if (Array.isArray(res?.apiPaths) && res.apiPaths.length) store.stats.lastApiPaths = res.apiPaths.slice(0, 12);
    if (Array.isArray(res?.apiRequests) && res.apiRequests.length) store.stats.lastApiRequests = res.apiRequests.slice(0, 12);

    if (res && res.ok) {
      store.recorded[key] = {
        at: atIso,
        version: item.version,
        releaseVersion: item.releaseVersion,
        file: item.file,
        kind: item.kind,
        method: res.method || 'dom-click',
        apiPaths: Array.isArray(res.apiPaths) ? res.apiPaths.slice(0, 12) : [],
        apiRequests: Array.isArray(res.apiRequests) ? res.apiRequests.slice(0, 12) : [],
      };
      removePending(key);
      store.stats.succeeded += 1;
      store.stats.lastStatus = 'recorded';
      store.stats.lastReason = '';
      persist();
      const out = { version: item.version, key, status: 'recorded', at: atIso, method: res.method || 'dom-click' };
      notify(out);
      logger.info?.(`[openx-record] 已计入内源下载记录 ${label}（${res.tookMs || 0}ms）`);
      return out;
    }

    const reason = String(res?.reason || '后台记录未完成');
    store.stats.failed += 1;
    store.stats.lastStatus = 'failed';
    store.stats.lastReason = reason;
    const nextAttempts = attempts + 1;
    if (res?.transient !== false && nextAttempts < MAX_PENDING_ATTEMPTS && !disposed) {
      upsertPending({ ...nextPending, attempts: nextAttempts });
    } else {
      removePending(key);
    }
    persist();
    logger.warn?.(`[openx-record] 后台计入内源下载未完成（不影响本次更新）${label}：${reason}`);
    const out = { version: item.version, key, status: 'failed', reason };
    notify(out);
    return out;
  }

  // 非阻塞入队：调用前立刻落盘 pending，确保用户秒点「立即重启」后新版仍能补记。
  function record(rawTarget) {
    if (disposed || !isEnabled()) {
      return Promise.resolve({ version: normVersion(rawTarget?.version || ''), status: 'skipped', reason: '已关闭' });
    }
    const item = normalizeTarget(rawTarget);
    const key = recordKeyOf(item);
    if (!key) return Promise.resolve({ version: '', key: '', status: 'skipped', reason: '无版本或发布标识' });
    if (isRecorded(item)) {
      const rec = { version: item.version, key, status: 'recorded', at: store.recorded[key].at, cached: true };
      notify(rec);
      return Promise.resolve(rec);
    }
    upsertPending({ ...item, queuedAt: now(), attempts: 0 });
    persist();
    const run = () => executeRecord(item, { fromPending: false });
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  // 启动补记：若上次更新或组件下载后立即退出导致后台记录中断，延迟一段时间逐条补记。
  function resumePending({ delayMs = resumeDelayMs } = {}) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
    if (disposed || !isEnabled()) return null;
    const valid = [];
    for (const p of (store.pendingQueue || [])) {
      const key = recordKeyOf(p);
      if (!key || isRecorded(p)) continue;
      if (Number(p.attempts || 0) >= MAX_PENDING_ATTEMPTS || (now() - Number(p.queuedAt || 0) > PENDING_MAX_AGE_MS)) continue;
      valid.push(p);
    }
    if (valid.length !== (store.pendingQueue || []).length) {
      store.pendingQueue = valid;
      syncPendingHead();
      persist();
    }
    if (!valid.length) return null;
    const wait = Math.max(0, Number(delayMs) || 0);
    const task = new Promise(resolve => {
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (disposed || !isEnabled() || !store.pendingQueue.length) { resolve(null); return; }
        const batch = store.pendingQueue.map(x => ({ ...x }));
        const drain = async () => {
          let last = null;
          for (const cur of batch) {
            if (disposed || !isEnabled()) break;
            last = await executeRecord(cur, { fromPending: true });
          }
          return last;
        };
        const q = queue.then(drain, drain);
        queue = q.catch(() => {});
        q.then(resolve, () => resolve(null));
      }, wait);
      resumeTimer.unref?.();
    });
    return task;
  }

  function diagnostics() {
    return {
      active: isFeatureActive(),
      enabled: isEnabled(),
      recordedCount: Object.keys(store.recorded || {}).length,
      pendingCount: (store.pendingQueue || []).length,
      pending: store.pending ? { version: store.pending.version || store.pending.releaseVersion, attempts: store.pending.attempts || 0, queuedAt: store.pending.queuedAt || 0 } : null,
      stats: { ...store.stats },
    };
  }

  function dispose() {
    disposed = true;
    clearTimeout(resumeTimer);
    resumeTimer = null;
    try { activeAbort?.abort(); } catch (_) {}
    killAll();
  }

  return {
    isActive: isFeatureActive,
    isEnabled,
    setEnabled,
    isRecorded,
    statusFor,
    record,
    resumePending,
    diagnostics,
    dispose,
    killAll,
  };
}

module.exports = {
  createOpenxDownloadRecorder,
  defaultRunSession,
  buildLocateScript,
  sanitizeApiPath,
  isDownloadLikeUrl,
  recordKeyOf,
  killAll,
  RECORD_FILE,
  OFF_FLAG_FILE,
  MAX_PENDING_ATTEMPTS,
};
