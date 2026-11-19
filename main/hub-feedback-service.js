'use strict';
// 一键反馈的主进程部分（2026-10-29）：界面点「一键反馈」→ 预览要发哪些内容 → 发送。
// r42（2026-11-18）起发到哪儿：
//   成员版：只经公司内网发到维护人黄区电脑上的「反馈收件机」（main/feedback-receiver.js），彻底不再发阿里云。
//   公开版：能读到公司内源（= 在公司内）时与成员版相同；读不到内源（公司外用户）才照旧提交到阿里云。
// 收件地址从内源的固定小发布读（core/feedback-receiver-address.js）。内网发不到就进本地「待发队列」（hub-feedback-outbox/），
// 后台每 10 分钟补发、最多 30 天；同时照旧存一份到「下载」，界面给「复制内容」，用户可以贴到 WeLink 发给维护人。
// 阿里云路径被公司网络放行页拦住时，自动在看不见的窗口里放行一次再重发（core/net-unblock.js，只对自家地址）；内网路径不需要。
const fs = require('node:fs');
const path = require('node:path');
const { collectBundle } = require('../core/hub-feedback');
const { looksLikeWebPage } = require('../core/app-update/downloader');
const { writeFileAtomic } = require('../core/atomic-write');

const SEND_TIMEOUT_MS = 30000;
const INTRANET_TIMEOUT_MS = 8000;
const SUBMIT_PATH = '/feedback/v1/submit';
const PING_PATH = '/feedback/v1/ping';
const PING_TIMEOUT_MS = 5000;
// 收件机单条上限 96 KB（按请求体字节算，见 core/feedback-receiver-store.js）；JSON 转义会让正文变长，留 2 KB 余量。
const INTRANET_MAX_BODY = 94 * 1024;
const OUTBOX_RETRY_MS = 10 * 60 * 1000;
// 30 天（2026-11-19 由 7 天放宽）：收件机一旦像 11-18 那样整体收不到，7 天内修不好就会把同事的反馈静默丢掉；队列本身最多 50 条，占不了多少地方。
const OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OUTBOX_MAX_ITEMS = 50;
const OUTBOX_NAME = /^\d{8}T\d{9}Z-[a-f0-9]{6}\.json$/;
let outboxSeq = 0;
// 发送端生成的提交编号：32 位十六进制随机数（收件机按同一格式校验，见 core/feedback-receiver-store.js）。
const SUBMIT_ID_RE = /^[a-f0-9]{32}$/;
const newSubmitId = () => require('node:crypto').randomBytes(16).toString('hex');

// 同一张页常要点 2–3 次、隔 20–30 秒才通过。所以点一次后按这个间隔重发，还被拦就再点，最多点 3 次（约 2 分钟）。
const RETRY_AFTER_CLICK_MS = [2000, 6000, 15000];
const MAX_CLICKS = 3;

function createHubFeedbackService({ endpoint, info, logsDir, fetchImpl, unblock = null, onPassed = () => {}, downloadsDir, now = () => Date.now(), logger = console,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {}, windowPost = null,
  edition = null, receiverAddress = null, intranetFetch = null, outboxDir = null }) {
  // edition：'member' 只走内网；'public' 按内源是否连得上分流；不给（主仓库与旧单测）= 只走阿里云，与以前一样。
  // receiverAddress：{ resolve() → { urls, openxReachable } }；intranetFetch：直连内网用的 fetch（不走系统代理）。
  const fetchFn = fetchImpl || ((...args) => require('electron').net.fetch(...args));
  const dataDir = path.dirname(logsDir);
  const outDir = outboxDir || path.join(dataDir, 'hub-feedback-outbox');
  const directFetch = intranetFetch || ((...args) => globalThis.fetch(...args));
  const contactFile = path.join(dataDir, 'hub-feedback-contact.json');
  const contactText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';

  // Reuse the existing local WeLink/profile identity; opening feedback neither
  // starts WeLink nor asks for a login. This preference stays outside logs.
  function defaultContact() {
    try {
      const saved = JSON.parse(fs.readFileSync(contactFile, 'utf8'));
      if (typeof saved.contact === 'string') return contactText(saved.contact);
    } catch { /* No saved preference yet. */ }
    return contactText(require('../core/welink-account').localWelinkAccount(dataDir));
  }

  function saveContact({ contact } = {}) {
    const value = contactText(contact);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      writeFileAtomic(fs, contactFile, JSON.stringify({ contact: value }) + '\n');
      return { ok: true };
    } catch { return { ok: false }; }
  }

  // 发送过程记在 logs/hub-feedback.log，被拦时的页面存成 hub-feedback-<途径>-sample.html（只留前 200 KB），下次一键反馈会随诊断包带上。
  function logEvent(entry) {
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(path.join(logsDir, 'hub-feedback.log'), JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n'); } catch {}
  }
  function saveSample(via, html) {
    try { fs.mkdirSync(logsDir, { recursive: true }); fs.writeFileSync(path.join(logsDir, `hub-feedback-${via}-sample.html`), Buffer.from(String(html), 'utf8').subarray(0, 200 * 1024)); } catch {}
  }

  function preview({ description = '', contact = '' } = {}) {
    const b = collectBundle({ info: info(), description, contact, logsDir, dataDir: path.dirname(logsDir), now: now() });
    return { ok: true, available: edition === 'member' || !!endpoint || !!receiverAddress, pending: outboxItems().length, items: b.items, chars: b.chars, contact: defaultContact() };
  }

  // 这次发到哪儿：'intranet'（公司内网收件机）或 'aliyun'。
  // 成员版：最先判断，永远是内网——缺地址服务、缺地址等任何缺参都只会进待发队列，绝不走阿里云（r42 返工）。
  // 公开版：内源连得上，或以前拿到过有效的收件地址（缓存），都按公司内走内网；发不出就进队列。
  //   只有从没拿到过地址、且这次内源也连不上，才按公司外用户发阿里云。
  async function route() {
    if (edition === 'member') return 'intranet';
    if (!receiverAddress || edition !== 'public') return 'aliyun';
    try {
      const addr = await receiverAddress.resolve();
      if (addr && (addr.openxReachable || (Array.isArray(addr.urls) && addr.urls.length))) return 'intranet';
    } catch { /* 查不到地址：看下面的缓存 */ }
    try { if (receiverAddress.readCache && receiverAddress.readCache().urls.length) return 'intranet'; } catch { /* 没缓存 */ }
    return 'aliyun';
  }

  // ---- 内网收件机 ----
  // 2026-11-19 反馈黑洞复盘：成员版 5.6.48 起的反馈约 36 小时一条都没送到，发送端只说「维护人电脑暂时不在线」，
  // 卡在取地址、被拒收还是网络不通谁也看不出。下面把每一步的结果记下来，反馈窗口和底栏都能看到原因、一键重试。
  let lastAddress = null, lastDelivery = null, lastDiag = null, lastFlush = null;
  async function resolveAddress(opts) {
    if (!receiverAddress) return { urls: [] };
    try {
      const a = await receiverAddress.resolve(opts);
      lastAddress = { at: now(), from: (a && a.from) || '', reason: (a && a.reason) || '', urls: (a && a.urls ? a.urls.length : 0), openxReachable: !!(a && a.openxReachable) };
      return a || { urls: [] };
    } catch (error) {
      lastAddress = { at: now(), from: 'none', reason: error.message, urls: 0, openxReachable: false };
      return { urls: [] };
    }
  }
  // 网络错误码 → 人话（Node fetch 的 error.cause.code）。
  function netReason(error) {
    const code = String((error && error.cause && error.cause.code) || (error && error.code) || '');
    if (code === 'ECONNREFUSED') return '连不上维护人电脑：电脑在线，但收件机没有在监听（可能被暂停或程序没在运行）';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '连不上维护人电脑：找不到这台电脑（域名解析失败）';
    if (/^(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return `连不上维护人电脑（网络不通或端口被隔离，${code}）`;
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return `连不上维护人电脑：连接被中途断开（${code}）`;
    return `连不上维护人电脑（${code || (error && error.message) || '未知错误'}）`;
  }
  // 收件机回 403 = 这台电脑的网段不在放行名单里（新版收件机已记下网段，维护人在收件列表里点一下就能放行）。
  function rejectReason(json) {
    const source = json && typeof json.source === 'string' && /^[\d.]+\/\d+$/.test(json.source) ? json.source : '';
    return `维护人电脑拒收了这台电脑${source ? `（来源网段 ${source}）` : ''}：网段不在收件机的放行名单里，需要维护人在收件列表里点「放行」`;
  }

  async function postIntranet(url, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), INTRANET_TIMEOUT_MS);
    try {
      const res = await directFetch(url + SUBMIT_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
      let json = null; try { json = JSON.parse(await res.text()); } catch { /* 不是 JSON */ }
      if (res.ok && json && json.ok && typeof json.id === 'string') return { ok: true, id: json.id };
      // 拒收：同一轮里其余的也会被拒，和「不在线」一样停下，等维护人放行后的下一轮。
      if (res.status === 403) return { ok: false, offline: true, rejected: true, reason: rejectReason(json) };
      return { ok: false, offline: false, reason: (json && json.error) || `收件机返回 ${res.status}` };
    } catch (error) {
      return { ok: false, offline: true, reason: ctl.signal.aborted ? `${INTRANET_TIMEOUT_MS / 1000} 秒内没连上维护人电脑（网络不通或端口被隔离）` : netReason(error) };
    } finally { clearTimeout(timer); }
  }

  // 依次试内源上发布的每个收件地址，有一个收下就算送到。
  async function sendIntranet(body) {
    const addr = await resolveAddress();
    if (!addr || !addr.urls || !addr.urls.length) {
      const why = lastAddress && lastAddress.reason ? `：${lastAddress.reason}` : '';
      lastDelivery = { at: now(), ok: false, step: 'address', reason: `还没拿到维护人电脑的地址${why}` };
      return { ok: false, offline: true, reason: lastDelivery.reason };
    }
    let last = null;
    for (const url of addr.urls) {
      last = await postIntranet(url, body);
      if (last.ok) break;
    }
    lastDelivery = { at: now(), ok: !!last.ok, step: last.ok ? 'sent' : last.rejected ? 'rejected' : 'deliver', reason: last.ok ? '' : last.reason };
    return last;
  }

  // 正文经 JSON 转义后可能超过收件机的单条上限：从末尾裁掉超出的部分并注明。
  function fitIntranet(body) {
    const size = b => Buffer.byteLength(JSON.stringify(b), 'utf8');
    if (size(body) <= INTRANET_MAX_BODY) return body;
    const note = '\n\n## 已裁剪\n超出内网单条上限，末尾已裁掉。\n';
    let text = body.text;
    for (let i = 0; i < 40 && size({ ...body, text: text + note }) > INTRANET_MAX_BODY; i++) {
      const over = size({ ...body, text: text + note }) - INTRANET_MAX_BODY;
      text = text.slice(0, Math.max(0, text.length - Math.max(256, Math.ceil(over / 2))));
    }
    return { ...body, text: text + note };
  }

  // ---- 待发队列：hub-feedback-outbox/<时间>-<随机>.json ----
  function outboxItems() {
    let names = [];
    try { names = fs.readdirSync(outDir).filter(n => OUTBOX_NAME.test(n)).sort(); } catch { return []; }
    return names.map(n => path.join(outDir, n));
  }
  function enqueue(body, reason) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const items = outboxItems();
      for (const old of items.slice(0, Math.max(0, items.length - OUTBOX_MAX_ITEMS + 1))) { try { fs.rmSync(old, { force: true }); } catch { /* 下次再删 */ } }
      // 文件名按字典序即先后：<UTC 时间到毫秒>Z-<2 位序号><4 位随机>，补发时先发早的。
      const stamp = new Date(now()).toISOString().replace(/[-:.]/g, '');
      outboxSeq = (outboxSeq + 1) % 256;
      const file = path.join(outDir, `${stamp}-${outboxSeq.toString(16).padStart(2, '0')}${require('node:crypto').randomBytes(2).toString('hex')}.json`);
      writeFileAtomic(fs, file, JSON.stringify({ queuedAt: now(), attempts: 1, lastError: reason || '', body }) + '\n');
      logEvent({ via: 'outbox', queued: path.basename(file), reason });
      return file;
    } catch (error) { logger.warn?.('[hub-feedback] 存进待发队列失败：', error.message); return null; }
  }

  // ---- 我的反馈（2026-11-19 用户体验第 9 项）：本机记下自己提交过的每一条，设置里能看到已送达 / 排队中（原因）/ 已修于哪个版本 ----
  // 只存摘要（问题描述第一行，≤80 字）、时间、状态和收件编号，不存诊断包正文；最多 200 条，旧的先删。
  const historyFile = path.join(dataDir, 'hub-feedback-history.json');
  const HISTORY_MAX = 200;
  function readHistory() {
    try { const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8')); return Array.isArray(raw.items) ? raw.items.filter(x => x && x.key) : []; }
    catch { return []; }
  }
  function recordHistory(key, patch) {
    if (!key) return;
    try {
      const items = readHistory();
      const at = items.findIndex(x => x.key === key);
      const next = { ...(at >= 0 ? items[at] : { key, createdAt: now() }), ...patch, updatedAt: now() };
      if (at >= 0) items[at] = next; else items.push(next);
      items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      fs.mkdirSync(dataDir, { recursive: true });
      writeFileAtomic(fs, historyFile, JSON.stringify({ items: items.slice(-HISTORY_MAX) }) + '\n');
    } catch (error) { logger.warn?.('[hub-feedback] 记录「我的反馈」失败：', error.message); }
  }
  const firstLine = text => String(text || '').trim().split(/\r?\n/)[0].slice(0, 80);
  // 「已修于」：更新日志里引用了这条反馈的收件编号（完整编号或末尾 8 位）就算，取最早的那个版本；没引用就不显示。
  function fixedInFor(receiptId, history) {
    const id = String(receiptId || '');
    if (!id) return '';
    const tail = /-([a-f0-9]{8})$/.exec(id)?.[1] || '';
    let hit = '';
    for (const e of history) {
      const text = (e.notes || []).join('\n');
      if (text.includes(id) || (tail && new RegExp(`(^|[^a-f0-9])${tail}([^a-f0-9]|$)`).test(text))) hit = e.version;
    }
    return hit;
  }
  function releaseHistory() {
    // loadHistory 返回按版本从新到旧排好的数组；fixedInFor 取最后一个命中 = 最早修好的版本。
    try { const h = require('../core/app-update/release-history').loadHistory(); return Array.isArray(h) ? h : []; } catch { return []; }
  }
  function mine({ page = 1, pageSize = 8 } = {}) {
    const items = readHistory();
    // 早于这个功能、还在待发队列里的：按排队中补进来（只有摘要和时间）。
    const known = new Set(items.map(x => x.submitId).filter(Boolean));
    for (const file of outboxItems()) {
      try {
        const it = JSON.parse(fs.readFileSync(file, 'utf8'));
        const sid = it.body && it.body.submitId;
        if (sid && known.has(sid)) continue;
        items.push({ key: 'outbox:' + path.basename(file), createdAt: Number(it.queuedAt) || 0, summary: firstLine(it.body && it.body.summary), status: 'queued', reason: String(it.lastError || '') });
      } catch { /* 坏文件补发时会删 */ }
    }
    // 排队中的原因跟着待发队列最新一次失败走。
    const queueReason = {};
    for (const file of outboxItems()) {
      try { const it = JSON.parse(fs.readFileSync(file, 'utf8')); if (it.body && it.body.submitId) queueReason[it.body.submitId] = String(it.lastError || ''); } catch { /* 略 */ }
    }
    const history = releaseHistory();
    const list = items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(x => ({
      key: x.key, createdAt: x.createdAt || null, summary: x.summary || '', via: x.via || '', status: x.status || 'queued',
      receiptId: x.receiptId || '', deliveredAt: x.deliveredAt || null,
      reason: x.status === 'queued' ? (queueReason[x.submitId] || x.reason || '') : (x.reason || ''),
      fixedIn: x.receiptId ? fixedInFor(x.receiptId, history) : '' }));
    const size = Math.max(1, Math.min(30, Math.floor(Number(pageSize)) || 8));
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
    return { ok: true, total: list.length, page: p, pageSize: size, items: list.slice((p - 1) * size, p * size),
      counts: { delivered: list.filter(x => x.status === 'delivered').length, queued: list.filter(x => x.status === 'queued').length, fixed: list.filter(x => x.fixedIn).length } };
  }

  // 补发一轮：送到的删掉，超过 30 天的放弃（「下载」里那份还在），其余记下次数和原因等下一轮。
  let flushing = null;
  function flushOutbox() {
    if (flushing) return flushing;
    flushing = (async () => {
      const result = { sent: 0, expired: 0, left: 0 };
      const items = outboxItems();
      if (!items.length || !receiverAddress) { result.left = items.length; return result; }
      await resolveAddress({ force: true });
      for (let k = 0; k < items.length; k++) {
        const file = items[k];
        let item = null;
        try { item = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 坏文件按过期删 */ }
        if (!item || !item.body || now() - Number(item.queuedAt || 0) > OUTBOX_MAX_AGE_MS) {
          try { fs.rmSync(file, { force: true }); } catch { /* 下次再删 */ }
          result.expired++; logEvent({ via: 'outbox', expired: path.basename(file) });
          if (item && item.body && item.body.submitId) recordHistory('s:' + item.body.submitId, { status: 'expired', reason: `排队超过 ${Math.round(OUTBOX_MAX_AGE_MS / 86400000)} 天没送到，已放弃（「下载」里的副本还在）` });
          continue;
        }
        // 早于幂等改动入队的条目没有提交编号：先补一个并写回，之后每次补发都用它。
        if (!SUBMIT_ID_RE.test(String(item.body.submitId || ''))) {
          item.body = { ...item.body, submitId: newSubmitId() };
          try { writeFileAtomic(fs, file, JSON.stringify(item) + '\n'); } catch { /* 写不回也照发，下轮再补 */ }
        }
        const r = await sendIntranet(item.body);
        if (r.ok) {
          try { fs.rmSync(file, { force: true }); } catch { /* 下次再删 */ }
          result.sent++; logEvent({ via: 'outbox', sent: path.basename(file), id: r.id });
          recordHistory('s:' + item.body.submitId, { submitId: item.body.submitId, summary: firstLine(item.body.summary), via: 'intranet', status: 'delivered', receiptId: r.id, deliveredAt: now(), reason: '' });
          continue;
        }
        result.left++;
        try { writeFileAtomic(fs, file, JSON.stringify({ ...item, attempts: Number(item.attempts || 0) + 1, lastError: r.reason, lastTryAt: now() }) + '\n'); } catch { /* 计数丢了不影响补发 */ }
        // 收件机不在线：这一轮其余的也不用试了，等下一轮。
        if (r.offline) { result.left += items.length - k - 1; break; }
      }
      lastFlush = { at: now(), ...result };
      return result;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // 一步步查发不出去卡在哪：① 读收件地址 ② 逐个地址 ping（GET /feedback/v1/ping，不提交任何内容）。只读、不排队、不落盘。
  async function diagnose() {
    const addr = await resolveAddress({ force: true });
    if (!addr.urls || !addr.urls.length) {
      lastDiag = { at: now(), ok: false, step: 'address', reason: `还没拿到维护人电脑的地址：${(lastAddress && lastAddress.reason) || '内源上没有可用的收件地址'}` };
      return lastDiag;
    }
    let last = null;
    for (const url of addr.urls) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
      try {
        const res = await directFetch(url + PING_PATH, { method: 'GET', signal: ctl.signal, redirect: 'error' });
        let json = null; try { json = JSON.parse(await res.text()); } catch { /* 不是 JSON */ }
        if (res.ok && json && json.ok) { lastDiag = { at: now(), ok: true, step: 'ping', reason: '' }; return lastDiag; }
        last = res.status === 403 ? { step: 'rejected', reason: rejectReason(json) } : { step: 'ping', reason: `收件机返回 ${res.status}` };
      } catch (error) {
        last = { step: 'network', reason: ctl.signal.aborted ? `${PING_TIMEOUT_MS / 1000} 秒内没连上维护人电脑（网络不通或端口被隔离）` : netReason(error) };
      } finally { clearTimeout(timer); }
    }
    lastDiag = { at: now(), ok: false, ...last };
    return lastDiag;
  }

  // 待发队列的状态：几条、最早一条什么时候存的、最近一次失败原因。
  function status() {
    const items = outboxItems();
    let oldest = 0, lastError = '', lastTryAt = 0;
    for (const file of items) {
      try {
        const item = JSON.parse(fs.readFileSync(file, 'utf8'));
        const q = Number(item.queuedAt) || 0;
        if (q && (!oldest || q < oldest)) oldest = q;
        const t = Number(item.lastTryAt || item.queuedAt) || 0;
        if (t >= lastTryAt) { lastTryAt = t; lastError = String(item.lastError || ''); }
      } catch { /* 坏文件补发时会删 */ }
    }
    const reason = (lastDiag && !lastDiag.ok && lastDiag.reason) || (lastDelivery && !lastDelivery.ok && lastDelivery.reason) || lastError;
    return { ok: true, pending: items.length, oldestQueuedAt: oldest || null, lastTryAt: lastTryAt || null, reason: items.length ? reason : '',
      address: lastAddress, delivery: lastDelivery, diag: lastDiag, flush: lastFlush,
      retryEveryMin: Math.round(OUTBOX_RETRY_MS / 60000), maxAgeDays: Math.round(OUTBOX_MAX_AGE_MS / 86400000) };
  }

  // 「立即重试」：先查一遍卡在哪，通了就马上补发整个队列（每条带固定提交编号，收件机按编号去重，重复点不会存两份）。
  async function retryNow() {
    const diag = await diagnose();
    const flushResult = diag.ok ? await flushOutbox() : { sent: 0, expired: 0, left: outboxItems().length };
    return { ...status(), diag, flushResult };
  }

  let retryTimer = null, firstTimer = null;
  function startRetry({ intervalMs = OUTBOX_RETRY_MS, firstDelayMs = 60 * 1000 } = {}) {
    if (retryTimer || !receiverAddress) return;
    const tick = () => { flushOutbox().catch(error => logger.warn?.('[hub-feedback] 补发出错：', error.message)); };
    firstTimer = setTimeout(tick, firstDelayMs); firstTimer.unref?.();
    retryTimer = setInterval(tick, intervalMs); retryTimer.unref?.();
  }
  function stopRetry() { clearTimeout(firstTimer); clearInterval(retryTimer); firstTimer = retryTimer = null; }

  async function post(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetchFn(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      const type = res.headers && res.headers.get ? res.headers.get('content-type') : '';
      const raw = await res.text();
      if (looksLikeWebPage(type, Buffer.from(raw.slice(0, 256)))) {
        // 被拦时返回的是什么页，存一份样本、记一行日志（之前只知道「是网页」，查不出是放行页还是别的拦截）。
        const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1];
        logEvent({ via: 'fetch', status: res.status, type: String(type || ''), bytes: raw.length, title: title ? title.trim().slice(0, 120) : null, sent: JSON.stringify(body).length });
        saveSample('fetch', raw);
        return { ok: false, blocked: true, reason: '被公司网络的放行页拦住' };
      }
      let json = null; try { json = JSON.parse(raw); } catch {}
      if (res.ok && json && json.ok) return { ok: true, id: json.id };
      return { ok: false, reason: (json && json.error && json.error.message) || `服务器返回 ${res.status}` };
    } catch (error) {
      return { ok: false, reason: ctl.signal.aborted ? `${SEND_TIMEOUT_MS / 1000} 秒内没发出去` : error.message };
    } finally { clearTimeout(timer); }
  }

  function saveLocal(text) {
    try {
      const dir = downloadsDir();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15);
      const file = path.join(dir, `AIHub-反馈-${stamp}.txt`);
      fs.writeFileSync(file, text, 'utf8');
      return file;
    } catch (error) { logger.warn?.('[hub-feedback] 本地保存失败：', error.message); return null; }
  }

  async function send({ description = '', contact = '', onProgress: progress = onProgress } = {}) {
    if (!String(description).trim()) return { ok: false, reason: '请先写一句遇到了什么问题' };
    saveContact({ contact });
    const i = info();
    const b = collectBundle({ info: i, description, contact, logsDir, dataDir: path.dirname(logsDir), now: now() });
    const body = { text: b.text, summary: b.summary, version: String(i.version || ''), edition: String(i.edition || ''), platform: String(i.platform || ''), contact: String(contact || ''), ...(i.target ? { target: String(i.target) } : {}) };
    if (await route() === 'intranet') {
      progress({ phase: 'intranet' });
      // 提交编号在第一次发送前生成，随待发队列一起落盘：回执丢了、重启后补发都用同一个编号，收件机据此认出是同一条，
      // 原样返回第一次的收据，不会存两份。用户再点一次「发送」是新的一条，编号不同。
      const inBody = fitIntranet({ ...body, submitId: newSubmitId() });
      const r = await sendIntranet(inBody);
      const hkey = 's:' + inBody.submitId, hbase = { submitId: inBody.submitId, summary: firstLine(description), via: 'intranet' };
      if (r.ok) {
        logEvent({ via: 'intranet', id: r.id });
        recordHistory(hkey, { ...hbase, status: 'delivered', receiptId: r.id, deliveredAt: now(), reason: '' });
        return { ok: true, id: r.id, chars: b.chars, via: 'intranet' };
      }
      logEvent({ via: 'intranet', error: r.reason });
      const queued = enqueue(inBody, r.reason);
      recordHistory(hkey, { ...hbase, status: queued ? 'queued' : 'failed', reason: r.reason });
      return { ok: false, via: 'intranet', queued: !!queued, reason: r.reason, savedTo: saveLocal(b.text), text: b.text };
    }
    if (!endpoint) return { ok: false, reason: '这个版本没有配置反馈地址', savedTo: saveLocal(b.text), text: b.text };
    let r = await post(body);
    for (let click = 1; !r.ok && r.blocked && unblock && click <= MAX_CLICKS; click++) {
      progress({ phase: 'unblocking', click, maxClicks: MAX_CLICKS });
      let passed = false;
      try { passed = await unblock(endpoint); } catch (error) { logger.warn?.('[hub-feedback] 自动放行出错：', error.message); }
      if (!passed) break; // 没点到按钮（或放行器在冷却）：再点也没用
      for (const wait of RETRY_AFTER_CLICK_MS) {
        await sleep(wait);
        progress({ phase: 'retrying', click, maxClicks: MAX_CLICKS });
        r = await post(body);
        if (r.ok || !r.blocked) break;
      }
    }
    // 还被拦：改在看不见的窗口里直接提交（2026-10-30 公司真机：放行页的 GET 已放行、只拿到自家页面，提交的 POST 仍被拦成网页）。
    // 拦截页就出现在这个窗口里：点了放行就隔一会儿再交，最多点 MAX_CLICKS 次。
    for (let click = 1; !r.ok && r.blocked && windowPost && click <= MAX_CLICKS + 1; click++) {
      progress({ phase: 'window', click, maxClicks: MAX_CLICKS });
      let w;
      try { w = await windowPost(endpoint, body); } catch (error) { w = { error: error.message }; }
      logEvent({ via: 'window', try: click, status: w?.status ?? null, title: w?.title || null, clicked: !!w?.clicked, button: w?.text || null,
        ok: !!(w?.json && w.json.ok), error: w?.error || (w?.json && !w.json.ok ? (w.json.error && w.json.error.message) || 'not-ok' : null),
        candidates: w?.json || w?.clicked ? undefined : (w?.candidates || []).slice(0, 10) });
      if (w?.json) {
        r = w.json.ok ? { ok: true, id: w.json.id } : { ok: false, reason: (w.json.error && w.json.error.message) || '服务器没收下' };
        break;
      }
      if (w?.html) saveSample('window', w.html);
      if (!w?.clicked) break; // 窗口里也没有放行按钮：再试没用
      if (click <= MAX_CLICKS) await sleep(RETRY_AFTER_CLICK_MS[Math.min(click, RETRY_AFTER_CLICK_MS.length) - 1]);
    }
    if (r.ok) { try { onPassed(); } catch {} }
    const akey = 'a:' + now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (r.ok) {
      recordHistory(akey, { summary: firstLine(description), via: 'aliyun', status: 'delivered', receiptId: r.id, deliveredAt: now(), reason: '' });
      return { ok: true, id: r.id, chars: b.chars };
    }
    recordHistory(akey, { summary: firstLine(description), via: 'aliyun', status: 'failed', reason: r.reason || '没发出去' });
    // blocked：仍被放行页拦着，界面据此给「打开放行页」让用户自己点（公开版不在后台自动点）。
    return { ok: false, reason: r.reason, savedTo: saveLocal(b.text), ...(r.blocked ? { blocked: true, url: endpoint } : {}) };
  }

  return { preview, send, saveContact, route, flushOutbox, startRetry, stopRetry, outboxItems, diagnose, status, retryNow, mine, fixedInFor };
}

function registerHubFeedbackIpc(ipcMain, service) {
  ipcMain.handle('hub-feedback:preview', (_e, payload) => service.preview(payload || {}));
  ipcMain.handle('hub-feedback:route', async () => ({ ok: true, via: await service.route() }));
  ipcMain.handle('hub-feedback:status', () => service.status());
  ipcMain.handle('hub-feedback:mine', (_e, payload) => service.mine(payload || {}));
  ipcMain.handle('hub-feedback:retry', async () => { try { return await service.retryNow(); } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('hub-feedback:save-contact', (_e, payload) => service.saveContact(payload || {}));
  ipcMain.handle('hub-feedback:send', (e, payload) => service.send({ ...(payload || {}), onProgress: p => { try { e.sender.send('hub-feedback:progress', p); } catch {} } }));
}

module.exports = { createHubFeedbackService, registerHubFeedbackIpc };
