'use strict';
// 多源下载（2026-10-13，公司版一键更新）：按顺序一个源一个源地试，每个源下完都核对大小和 sha256，
// 不对就写明原因、换下一个源。公司实测：阿里云上的大文件会被公司代理换成 3.5 KB 的拦截网页，
// GitHub 能直下约 2 MB/s；所以拦截页要能认出来并说人话。网络走调用方给的 fetch（Electron 的
// net.fetch 跟系统代理）。
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { retryOnce } = require('../transient-retry');
const ownGate = require('../own-gate');
const openxSource = require('./openx-source');

const IDLE_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 15000;
const MANIFEST_TIMEOUT_MS = 10000;

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fileUrl(source, version, file) {
  return String(source.files || '').replace('{version}', version) + encodeURIComponent(file);
}

function looksLikeWebPage(contentType, head) {
  if (/text\/html|text\/plain|application\/xhtml/i.test(String(contentType || ''))) return true;
  const s = head ? head.toString('utf8', 0, Math.min(head.length, 256)).trimStart().toLowerCase() : '';
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.startsWith('<?xml') || s.startsWith('<head');
}

function reasonOf(error) {
  if (!error) return '未知错误';
  if (error.reason) return error.reason;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '连接超时';
  const msg = String(error.message || error);
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(msg)) return '找不到服务器（域名解析失败），可能需要代理或网络不通';
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(msg)) return '服务器拒绝连接';
  if (/ECONNRESET|ERR_CONNECTION_RESET|socket hang up/i.test(msg)) return '连接被中断（可能被代理或防火墙重置）';
  if (/certificate|CERT_|SSL/i.test(msg)) return '证书校验失败（可能被公司代理拦截了加密连接）';
  if (/ERR_PROXY|proxy/i.test(msg)) return '代理连接失败';
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH/i.test(msg)) return '网络不通';
  return msg.slice(0, 160);
}

const fail = reason => Object.assign(new Error(reason), { reason });
// 收到的是代理的拦截网页：公司代理第一次访问某个网址时先出确认页，用户在浏览器里点「允许」后就放行
// （2026-10-14 用户）。标上 blocked，界面据此给出网址让用户自己去放行。
const blockedFail = reason => Object.assign(new Error(reason), { reason, blocked: true });

// 带「连接超时」：拿到响应头之前最多等 CONNECT_TIMEOUT_MS。
async function openResponse(fetchImpl, url, signal, timeoutMs, redirect = 'follow') {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
  try {
    return { response: await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect }), controller: ac };
  } catch (error) {
    if (signal && signal.aborted) throw fail('已取消');
    throw fail(error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? `${Math.round(timeoutMs / 1000)} 秒内没有连上服务器` : reasonOf(error));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 查版本：各源并行取清单，返回每个源的结果和版本最高的那份。
// gate（5.6.2）：true / 'auto' 时，全部源都失败就问一次统一放行入口（core/own-gate.js），哪台自家主机被拦就放行，然后再取一遍；
// 'auto' 只做后台自动放行、不弹窗。一键更新和命令行工具安装自己处理放行，不传。
async function checkManifests({ gate = false, ...args }) {
  // 查清单时顺手在后台探测公司内源（不等、不报错），到下载时内源状态已知，公司外不会因此多等。
  if (args.fetchImpl && args.openx !== false) openxSource.prewarm({ ...(args.openx || {}), fetchImpl: args.fetchImpl });
  const results = await checkManifestsOnce(args);
  if (!gate || args.signal?.aborted || results.some(r => r.ok)) return results;
  for (const r of results) if (await ownGate.pass(r.url, { interactive: gate !== 'auto' }) === 'passed') return checkManifestsOnce(args);
  return results;
}
async function checkManifestsOnce({ sources, fetchImpl, validate, timeoutMs = MANIFEST_TIMEOUT_MS, signal, retry = null }) {
  const results = await Promise.all(sources.map(async source => {
    const startedAt = Date.now(), controller = new AbortController();
    let response, timer, timedOut = false, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const onAbort = () => { controller.abort(); rejectStop(fail('已取消')); };
    const assertActive = () => {
      if (signal?.aborted) throw fail('已取消');
      if (timedOut || Date.now() - startedAt >= timeoutMs) throw fail(`版本清单读取超时（${timeoutMs / 1000} 秒内未完成）`);
    };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    timer = setTimeout(() => {
      timedOut = true; controller.abort();
      rejectStop(fail(`版本清单读取超时（${timeoutMs / 1000} 秒内未完成）`));
    }, timeoutMs);
    try {
      // 清单期限覆盖响应头、正文和校验；不能在刚收到响应头时就撤掉计时器。
      // 偶发错误（连接被重置、HTTP 502/503/504/429）在同一期限内自动再取一次（core/transient-retry.js）：
      // 取清单是只读 GET，重复取没有副作用；404、拦截网页、清单无效都不重试。
      const manifest = await Promise.race([stopped, retryOnce(async () => {
        assertActive();
        response = await fetchImpl(source.manifest, { signal: controller.signal, cache: 'no-store', redirect: 'follow' });
        if (!response.ok) {
          try { void response.body?.cancel().catch(() => {}); } catch (_) {}
          throw Object.assign(fail(response.status === 404 ? '源上还没有版本清单（HTTP 404）' : `服务器返回 HTTP ${response.status}`), { status: response.status });
        }
        const text = await response.text();
        assertActive();
        if (looksLikeWebPage(response.headers && response.headers.get && response.headers.get('content-type'), Buffer.from(text.slice(0, 256)))) throw blockedFail(`收到的是网页（${fmtBytes(Buffer.byteLength(text))}）而不是版本清单，可能被公司代理拦截`);
        let checked;
        try { checked = await validate(JSON.parse(text)); } catch (error) { throw fail(`版本清单无效：${error.message}`); }
        assertActive();
        return checked;
      }, { label: 'manifest:' + source.id, budgetMs: timeoutMs, signal: controller.signal, ...(retry || {}) })]);
      return { id: source.id, name: source.name, ok: true, manifest, ms: Date.now() - startedAt };
    } catch (error) {
      return { id: source.id, name: source.name, ok: false, reason: signal?.aborted ? '已取消' : timedOut ? `版本清单读取超时（${timeoutMs / 1000} 秒内未完成）` : reasonOf(error), blocked: !!error.blocked, url: source.manifest, ms: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      controller.abort();
      // 非成功 HTTP 或校验失败也要关流；取消本身不能再把源的期限拖住。
      try { void response?.body?.cancel().catch(() => {}); } catch (_) {}
    }
  }));
  return results;
}

// 本机已经有一份大小和 sha256 都对得上的同名文件：直接用，不再下（2026-11-16：上次下好后改名失败、
// 或安装包已下好但还没装，重试时不用再下 90 多 MB）。
function alreadyComplete(dest, expect) {
  try {
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== expect.bytes) return false;
    return createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === expect.sha256;
  } catch (_) { return false; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
// .part 核对通过后改名为正式文件。个别电脑上安全软件会在新写好的 exe 上短暂持有句柄，或同名旧安装包
// 还被占用，改名报 EPERM（2026-11-16 用户反馈）。只在失败时才等一等重试、清掉旧的同名文件，正常情况一次就过。
async function promote(part, dest, expect, { tries = 6, waitMs = 300 } = {}) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(part, dest); return; }
    catch (error) {
      if (!LOCKED.has(error.code)) throw error;
      if (alreadyComplete(dest, expect)) { try { fs.rmSync(part, { force: true }); } catch (_) {} return; }
      if (i >= tries - 1) throw fail('文件已下好并核对无误，但没法放到位（多半是安全软件正在扫描，或旧的同名安装包还被占用）。请稍等一分钟再点更新；仍不行可重启电脑后再试');
      try { fs.rmSync(dest, { force: true }); } catch (_) {}
      await sleep(waitMs * (i + 1));
    }
  }
}

// 打开一个地址并检查状态码（分片下载时每片都走这里）。
async function openChecked(fetchImpl, url, signal, connectTimeoutMs, redirect) {
  const opened = await openResponse(fetchImpl, url, signal, connectTimeoutMs, redirect);
  const { response } = opened;
  if (redirect !== 'follow' && response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch (_) {}
    throw fail(`服务器要求跳转（HTTP ${response.status}），这个源不跟随跳转`);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_) {}
    throw fail(response.status === 404 ? '源上没有这个文件（HTTP 404）' : `服务器返回 HTTP ${response.status}`);
  }
  return opened;
}

// 从一个源下一个文件到 dest（先写 .part，核对通过才改名）。
// url 可以是地址数组（r24：公司内源单个附件有大小上限，大文件拆成 <文件名>.000/.001… 上传）：按顺序接成一个文件，
// 整体仍按清单核对大小和 sha256，分片本身不需要单独的校验值。
async function downloadOne({ source, url, expect, dest, fetchImpl, signal, onProgress, idleTimeoutMs, connectTimeoutMs, redirect = 'follow' }) {
  const part = dest + '.part';
  const urls = Array.isArray(url) ? url : [url];
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let { response, controller } = await openChecked(fetchImpl, urls[0], signal, connectTimeoutMs, redirect);
  const contentType = response.headers && response.headers.get ? response.headers.get('content-type') : '';
  const declared = urls.length > 1 ? NaN : Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  const hash = createHash('sha256');
  const out = fs.openSync(part, 'w');
  let received = 0, head = null, idleTimer = null, idleHit = false, reader = null, renamed = false, closed = false;
  // openResponse 只把取消信号接到「拿到响应头」为止；下载正文期间也要能取消（2026-10-22 修：
  // 会议室运行时 77MB，用户点取消后原来还会把整个文件收完）。
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const startedAt = Date.now();
  let lastTick = startedAt, lastBytes = 0, speed = 0;
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idleHit = true; controller.abort(); }, idleTimeoutMs); };
  try {
    if (Number.isFinite(declared) && declared > 0 && declared !== expect.bytes && (declared < 64 * 1024 || looksLikeWebPage(contentType, null))) {
      // 不读完也知道不对：大小差得多且像网页，多半是代理返回的拦截页。顺手读一点内容判断。
      const text = Buffer.from(await response.arrayBuffer());
      if (looksLikeWebPage(contentType, text)) throw blockedFail(`收到 ${fmtBytes(text.length)} 的网页而不是更新包，可能被公司代理拦截`);
      throw fail(`文件大小不对：应为 ${fmtBytes(expect.bytes)}，服务器给的是 ${fmtBytes(declared)}`);
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw fail('服务器没有返回文件内容');
    reader = response.body.getReader();
    armIdle();
    for (let next = 1; ;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal && signal.aborted) throw fail('已取消');
        if (idleHit) throw fail(`连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据`);
        throw fail(`下载中断：${reasonOf(error)}`);
      }
      if (chunk.done) {
        if (next >= urls.length) break;
        // 下一片：换连接继续写同一个文件、同一个 sha256。
        clearTimeout(idleTimer);
        ({ response, controller } = await openChecked(fetchImpl, urls[next++], signal, connectTimeoutMs, redirect));
        if (signal && signal.aborted) controller.abort();
        if (!response.body || typeof response.body.getReader !== 'function') throw fail('服务器没有返回文件内容');
        reader = response.body.getReader();
        armIdle();
        continue;
      }
      const buf = Buffer.from(chunk.value);
      if (!head) head = buf.subarray(0, 256);
      received += buf.length;
      if (received > expect.bytes) throw fail(`收到的内容比应有的 ${fmtBytes(expect.bytes)} 还大，已停止`);
      hash.update(buf);
      fs.writeSync(out, buf);
      armIdle();
      const now = Date.now();
      if (now - lastTick >= 250 || received === expect.bytes) {
        const inst = (received - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        lastTick = now; lastBytes = received;
        onProgress && onProgress({ sourceId: source.id, sourceName: source.name, received, total: expect.bytes, speed,
          etaSec: speed > 0 ? Math.max(0, Math.round((expect.bytes - received) / speed)) : null });
      }
    }
    // 取消信号落在「读完最后一块」之后也不能转正：用户点了取消就当这次没下过。
    if (signal && signal.aborted) throw fail('已取消');
    if (received !== expect.bytes) {
      if (received < 64 * 1024 && looksLikeWebPage(contentType, head)) throw blockedFail(`收到 ${fmtBytes(received)} 的网页而不是更新包，可能被公司代理拦截`);
      throw fail(`文件不完整：应为 ${fmtBytes(expect.bytes)}，只收到 ${fmtBytes(received)}`);
    }
    if (hash.digest('hex') !== expect.sha256) throw fail('文件校验不一致（内容在传输中被改动或源上的文件不对）');
    fs.closeSync(out); closed = true;
    await promote(part, dest, expect);
    renamed = true;
    return { bytes: received, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 没读完的响应体要显式取消，否则连接会挂到回收（换源重试时叠加）。
    try { await reader?.cancel(); } catch (_) {}
    if (!closed) fs.closeSync(out);
    // 取消、20 秒没数据、写盘失败、校验不过都走这里：一律不留 .part。
    // 77MB 的半个文件既占盘，也会让下次重试从脏状态开始。
    if (!renamed) { try { fs.rmSync(part, { force: true }); } catch (_) {} }
  }
}

// 按顺序逐个源下载，任何一个成功就停。attempts 记下每个源的结果（成功/失败 + 原因），给界面显示。
// gate：同 checkManifests——全部源都失败时放行被拦的自家主机，再下一遍。
async function downloadWithFallback({ gate = false, ...args }) {
  const result = await downloadAll(args);
  if (!gate || result.ok || result.cancelled) return result;
  for (const a of result.attempts) if (await ownGate.pass(a.url, { interactive: gate !== 'auto' }) === 'passed') return downloadAll(args);
  return result;
}
async function downloadAll({ sources, version, expect, dest, fetchImpl, signal, onProgress, onAttempt,
  idleTimeoutMs = IDLE_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, openx = {} }) {
  const attempts = [];
  if (alreadyComplete(dest, expect)) return { ok: true, reused: true, source: { id: 'local', name: '本机已下好的文件' }, attempts };
  // 公司内源优先（r21）：先按文件名去 openx 找同名附件，找到就先从那里下，仍按清单核对大小和 sha256。
  // 内源没有、连不上、校验不对都静默落回下面的原下载源：失败的内源尝试不留在 attempts 里，
  // 界面和「全部 404 就重查清单」「被拦就放行」这些判断看到的和以前完全一样。openx:false 关掉（单测用）。
  let openxNote = null;
  // 成员版（内源不生效）：不探测、不改源顺序，和以前完全一样；公开版：内源 → GitHub → 阿里云。
  const openxOn = openx !== false && openxSource.enabled((openx && openx.env) || process.env);
  // 从内源下一次：成功返回结果；失败记下原因返回 null（取消时返回取消结果）。
  const viaOpenx = async hit => {
    const source = { id: 'openx', name: '公司内源' };
    const attempt = { ...source, url: hit.url, status: 'downloading', startedAt: Date.now() };
    attempts.push(attempt);
    onAttempt && onAttempt(attempts.map(a => ({ ...a })));
    try {
      // 内源附件不跟随重定向：入口地址已核过白名单，跳转目标不再放行。
      const r = await downloadOne({ source, url: hit.urls || hit.url, expect, dest, fetchImpl, signal, onProgress, idleTimeoutMs,
        connectTimeoutMs: Math.min(connectTimeoutMs, openxSource.REACH_TIMEOUT_MS), redirect: 'error' });
      Object.assign(attempt, { status: 'ok', bytes: r.bytes, ms: r.ms });
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      return { ok: true, source, attempts, openx: { status: 'ok', releaseVersion: hit.releaseVersion, ms: r.ms } };
    } catch (error) {
      attempts.pop();
      if (signal && signal.aborted) return { ok: false, cancelled: true, attempts };
      openxSource.markBad(expect.file);
      openxNote = { status: 'failed', reason: reasonOf(error) };
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      return null;
    }
  };
  if (openxOn && openxSource.onlyChannel((openx && openx.env) || process.env)) {
    const failed = (reason, extra = {}) => {
      const attempt = { id: 'openx', name: '公司内源', status: 'failed', reason: openxSource.userReason(reason, { file: expect.file }), ms: 0, ...extra };
      attempts.push(attempt);
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      return { ok: false, cancelled: false, attempts, openxOnly: true, openx: { status: 'failed', reason } };
    };
    // 没有别的源可退：每次下载都真的再连一次，不沿用「5 分钟内不再试」和「上次校验没过」（那次多半是传输中断）。
    openxSource.clearDown();
    const hit = await openxSource.find({ ...openx, file: expect.file, version, fetchImpl, signal }).catch(error => { openxNote = { reason: reasonOf(error) }; return null; });
    if (signal && signal.aborted) return { ok: false, cancelled: true, attempts, openxOnly: true };
    if (!hit) return failed(openxNote ? openxNote.reason : openxSource.lastReason());
    const r = await viaOpenx(hit);
    if (r) return { ...r, openxOnly: true };
    if (signal && signal.aborted) return { ok: false, cancelled: true, attempts, openxOnly: true };
    return failed(openxNote && openxNote.reason ? `内源下载失败：${openxNote.reason}` : '内源下载失败', { url: hit.url });
  }
  if (openxOn) {
    const hit = await openxSource.findForDownload({ ...openx, file: expect.file, version, fetchImpl, signal });
    if (!hit) openxNote = { status: 'skipped', reason: openxSource.lastReason() };
    else {
      const r = await viaOpenx(hit);
      if (r) return r;
    }
  }
  // r59：内源没命中时，后面各源的进度带上 openxMiss（原因），统一进度条把来源标成「备用」并写明为什么没走内源。
  const fallbackProgress = openxNote && onProgress ? p => onProgress({ ...p, openxMiss: openxNote.reason || (openxNote.status === 'failed' ? '内源下载失败' : '内源没有这个包') }) : onProgress;
  const result = await downloadFromSources({ sources: openxOn && openxSource.publicOrder((openx && openx.env) || process.env) ? orderSources(sources) : sources, version, expect, dest, fetchImpl, signal, onProgress: fallbackProgress, onAttempt, idleTimeoutMs, connectTimeoutMs, attempts });
  // r60：内源当时只是没在几秒内查完（不是连不上），备用源又全失败（如公司网络拦了阿里云）：等内源查完再试一次。
  if (!result.ok && !result.cancelled && openxOn && openxNote && openxNote.status === 'skipped' && openxSource.reachability() !== 'down') {
    const hit = await openxSource.find({ ...openx, file: expect.file, version, fetchImpl, signal }).catch(() => null);
    if (hit) {
      const before = attempts.length;
      const r = await viaOpenx(hit);
      // 成功时只留内源这一条（与内源第一次就命中时一致），前面失败的备用源记录不带出去。
      if (r && r.ok) { attempts.splice(0, before); return { ...r, attempts: attempts.slice() }; }
      if (r) return r;
    } else openxNote = { status: 'skipped', reason: openxSource.lastReason() };
  }
  return openxNote ? { ...result, openx: openxNote } : result;
}
// 公开版下载源顺序（2026-11-16 定）：公司内源 openx → GitHub → 其他官方源 → 阿里云（自家服务器只做最后兜底）。
// 内源在 downloadAll 里单独先试；这里把调用方给的源按 GitHub / 其他 / 阿里云 三档稳定排序，同档保持原顺序。成员版不排序（内源照样先试）。
// 自家阿里云服务器上的下载目录（和各组件源列表里的地址同一组前缀）。
const OWN_MIRROR_PREFIXES = ['https://dl.lt-stockpartner.tech/hub-update/', 'https://dl.lt-stockpartner.tech/pptutor/',
  'https://me.lt-stockpartner.tech/hub-update/', 'https://me.lt-stockpartner.tech/pptutor/'];
const GITHUB_HOST = /(^|\.)(github\.com|githubusercontent\.com)$/i;
function sourceHost(source) {
  for (const u of [source.url, source.files, source.manifest]) {
    try { if (u) return new URL(String(u).replace('{version}', '0')).hostname; } catch (_) {}
  }
  return '';
}
function sourceRank(source) {
  const id = String(source.id || ''), host = sourceHost(source);
  if (id === 'github' || GITHUB_HOST.test(host)) return 0;
  if (/^aliyun/.test(id) || [source.url, source.files, source.manifest].some(u => u && OWN_MIRROR_PREFIXES.some(p => String(u).startsWith(p)))) return 2;
  return 1;
}
// 下载源的人话名（r59 统一进度条用）：自家下载服务器 → 阿里云，GitHub → GitHub，其余用主机名。
function friendlySourceName(url) {
  const u = String(url || '');
  if (OWN_MIRROR_PREFIXES.some(p => u.startsWith(p))) return '阿里云';
  let host = ''; try { host = new URL(u).hostname; } catch (_) { return ''; }
  return GITHUB_HOST.test(host) ? 'GitHub' : host;
}
function orderSources(sources) {
  return (sources || []).map((s, i) => ({ s, i, r: sourceRank(s) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.s);
}
async function downloadFromSources({ sources, version, expect, dest, fetchImpl, signal, onProgress, onAttempt, idleTimeoutMs, connectTimeoutMs, attempts }) {
  for (const source of sources) {
    if (signal && signal.aborted) break;
    // source.url：直接给出完整地址（CLI 组件的官方下载地址，core/cli-tools/catalog.js），不按目录拼。
    const url = source.url || fileUrl(source, version, expect.file);
    const attempt = { id: source.id, name: source.name, url, status: 'downloading', startedAt: Date.now() };
    attempts.push(attempt);
    onAttempt && onAttempt(attempts.map(a => ({ ...a })));
    try {
      const r = await downloadOne({ source, url, expect, dest, fetchImpl, signal, onProgress, idleTimeoutMs, connectTimeoutMs });
      Object.assign(attempt, { status: 'ok', bytes: r.bytes, ms: r.ms });
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      return { ok: true, source: { id: source.id, name: source.name }, attempts };
    } catch (error) {
      Object.assign(attempt, { status: signal && signal.aborted ? 'cancelled' : 'failed', reason: reasonOf(error), blocked: !!error.blocked, ms: Date.now() - attempt.startedAt });
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      if (signal && signal.aborted) break;
    }
  }
  return { ok: false, cancelled: !!(signal && signal.aborted), attempts };
}

module.exports = { friendlySourceName, orderSources, alreadyComplete, promote, checkManifests, downloadWithFallback, fileUrl, looksLikeWebPage, reasonOf, fmtBytes };
