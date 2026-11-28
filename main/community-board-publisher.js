'use strict';
// 社区只读黑板发布器（2026-11-28，仅在维护人黄区收件机本机运行）：
// 每小时用本机 Edge 的内源登录态把全局榜单原地更新到 OpenX 的 community-board 发布描述里，供绿区匿名读取。
const openxConfig = require('../core/app-update/openx-config');
const capture = require('./company-edge-capture');
const { findEdge } = require('./edge-headless');
const { BOARD_RELEASE_NAME, cleanBoardReleaseId, boardSignature, serializeBoard } = require('../core/community/openx-board');

const FIRST_DELAY_MS = 3 * 60 * 1000;
const PERIOD_MS = 60 * 60 * 1000;
const UNCHANGED_MAX_MS = 2 * 60 * 60 * 1000;
const EDGE_TIMEOUT_MS = 45000;

function buildPublishScript({ boardReleaseId, projectId, description }) {
  const cfg = JSON.stringify({
    id: Number(boardReleaseId),
    projectId: Number(projectId),
    expectedVersion: BOARD_RELEASE_NAME,
    description: String(description || ''),
  });
  return `(async () => {
    const cfg = ${cfg};
    let token = '';
    try { token = localStorage.getItem('token') || sessionStorage.getItem('token') || ''; } catch (_) {}
    if (!token) return { needsLogin: true, reason: 'no-token' };
    const H = { Authorization: 'Bearer ' + token };
    const detail = async () => {
      const r = await fetch('/openxApi/project/version/release/query/by_id?id=' + encodeURIComponent(cfg.id),
        { headers: H, cache: 'no-store' });
      const j = await r.json();
      return { code: String(j && j.code), data: (j && j.data) || null };
    };
    const d = await detail();
    if (d.code === '401' || d.code === '403') return { needsLogin: true, reason: 'auth-' + d.code };
    if (d.code !== '0' || !d.data) return { ok: false, stage: 'read', code: d.code };
    if (String(d.data.version || '').trim() !== cfg.expectedVersion) {
      return { ok: false, stage: 'guard', actualVersion: String(d.data.version || '') };
    }
    if (String(d.data.description || '') === cfg.description) return { ok: true, unchanged: true };
    const pk = (d.data.binaryPackages || []).map(p => { const { file, ...o } = p; return o; });
    const body = {
      id: cfg.id,
      version: d.data.version,
      description: cfg.description,
      lifeCycle: d.data.lifeCycle || '',
      versionCode: d.data.versionCode || undefined,
      projectId: cfg.projectId,
      sourcePackages: d.data.sourcePackages || [],
      binaryPackages: pk,
      swbomPackage: d.data.swbomPackage || null,
      reportPackage: d.data.reportPackage || null,
      mainComponents: d.data.mainComponents || [],
    };
    const r = await fetch('/openxApi/project/version/release/edit', {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || String(j.code) !== '0') return { ok: false, stage: 'edit', http: r.status, code: j && j.code };
    const verify = await detail();
    if (verify.code !== '0' || !verify.data || String(verify.data.description || '') !== cfg.description) {
      return { ok: false, stage: 'verify', code: verify.code };
    }
    return { ok: true, verified: true };
  })()`;
}

function createBoardPublisher({
  host,
  receiverAddress = null,
  openx = openxConfig,
  runInEdge = capture.runInEdge,
  findEdgeFn = findEdge,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  logger = console,
  firstDelayMs = FIRST_DELAY_MS,
  periodMs = PERIOD_MS,
  unchangedMaxMs = UNCHANGED_MAX_MS,
  timeoutMs = EDGE_TIMEOUT_MS,
  env = process.env,
} = {}) {
  let timer = null, running = false, stopped = false, inFlight = null, epoch = 0;
  const controllers = new Set();
  let lastSig = '', lastSuccessAt = 0;
  let lastStatus = { ok: false, at: 0, reason: '未运行', boardReleaseId: 0 };

  const activeOk = (my, ctl) => my === epoch && !(ctl && ctl.signal.aborted) && !!(host && host.isHost()) && !host.store.readSettings().paused;

  async function resolveReleaseId() {
    let fromAddr = 0;
    if (receiverAddress && typeof receiverAddress.resolve === 'function') {
      try {
        const res = await receiverAddress.resolve();
        fromAddr = cleanBoardReleaseId(res && res.boardReleaseId);
      } catch { /* 回退到静态配置 */ }
    }
    return fromAddr || cleanBoardReleaseId(openx && openx.boardReleaseId);
  }

  async function runPublish({ force = false } = {}) {
    const my = epoch;
    if (!host || !host.isHost()) return { ok: false, skipped: true, reason: '非收件机' };
    if (host.store.readSettings().paused) return { ok: false, skipped: true, reason: '社区收集已暂停' };
    const ctl = new AbortController();
    controllers.add(ctl);
    try {
      const boardReleaseId = await resolveReleaseId();
      if (!activeOk(my, ctl)) return { ok: false, skipped: true, reason: '发布已取消或暂停' };
      if (!boardReleaseId) {
        lastStatus = { ok: false, at: now(), reason: '未配置黑板发布编号', boardReleaseId: 0 };
        return { ok: false, skipped: true, reason: lastStatus.reason };
      }
      if (!openx || !openx.projectPage || !openx.projectId) {
        lastStatus = { ok: false, at: now(), reason: '缺少内源配置', boardReleaseId };
        return { ok: false, skipped: true, reason: lastStatus.reason };
      }
      const board = host.store.board('', { includeDaily: false });
      const sig = boardSignature(board);
      const description = serializeBoard(board);
      if (!description) {
        lastStatus = { ok: false, at: now(), reason: '榜单为空或序列化失败', boardReleaseId };
        return { ok: false, skipped: true, reason: lastStatus.reason };
      }
      if (!force && sig && sig === lastSig && now() - lastSuccessAt < unchangedMaxMs) {
        return { ok: true, skipped: true, reason: '榜单无变化' };
      }
      if (findEdgeFn && !findEdgeFn(env)) {
        lastStatus = { ok: false, at: now(), reason: '本机未找到 Edge', boardReleaseId };
        return { ok: false, reason: lastStatus.reason };
      }
      const pageUrl = String(openx.projectPage).replace(/\/+$/, '') + '/download';
      let readyHost = '';
      try { readyHost = new URL(pageUrl).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } catch { readyHost = ''; }
      if (!readyHost) return { ok: false, reason: '内源页面地址无效' };
      if (!activeOk(my, ctl)) return { ok: false, skipped: true, reason: '发布已取消或暂停' };
      const res = await runInEdge({
        url: pageUrl,
        readyUrl: new RegExp('^https://' + readyHost + '/', 'i'),
        script: buildPublishScript({ boardReleaseId, projectId: openx.projectId, description }),
        accept: v => !!v && !v.needsLogin,
        signal: ctl.signal,
        timeoutMs,
        loginGraceMs: Math.max(5000, timeoutMs - 5000),
        tag: 'hub-edge-community-board',
        logger,
        env,
      }).catch(e => ({ ok: false, error: e && e.message ? e.message : String(e) }));

      if (!activeOk(my, ctl)) return { ok: false, skipped: true, reason: '发布已取消或暂停' };
      const v = res && res.ok ? res.value : null;
      if (v && v.ok) {
        lastSig = sig;
        lastSuccessAt = now();
        lastStatus = { ok: true, at: lastSuccessAt, reason: v.unchanged ? '黑板已是最新' : '已同步到内源黑板', boardReleaseId };
        logger.info?.(`[community-board] ${lastStatus.reason}（release ${boardReleaseId}）`);
        return { ok: true, boardReleaseId, unchanged: !!v.unchanged };
      }
      const reason = (v && (v.stage ? `${v.stage}:${v.code || v.http || v.actualVersion || ''}` : v.reason))
        || (res && res.error) || '更新内源黑板失败';
      lastStatus = { ok: false, at: now(), reason, boardReleaseId };
      logger.warn?.('[community-board] 更新失败：', reason);
      return { ok: false, reason, boardReleaseId };
    } finally {
      controllers.delete(ctl);
    }
  }

  // 互斥：在途发布未结束时直接复用同一个 Promise，绝不并发启动两个 Edge。
  function publishOnce(opts = {}) {
    if (inFlight) return inFlight;
    inFlight = runPublish(opts).finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(ms) {
    if (!running || stopped) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(async () => {
      timer = null;
      try { await publishOnce(); } catch (e) { logger.warn?.('[community-board] 定时发布出错：', e.message); }
      if (running && !stopped) schedule(periodMs);
    }, ms);
    timer?.unref?.();
  }

  function abortActive() {
    epoch++;
    for (const ctl of controllers) ctl.abort();
  }
  function start() {
    if (running || stopped) return;
    running = true;
    schedule(firstDelayMs);
  }
  function stop() {
    stopped = true;
    running = false;
    if (timer) { timers.clearTimeout(timer); timer = null; }
    abortActive();
  }

  return { start, stop, abortActive, publishOnce, status: () => ({ ...lastStatus }), _inFlight: () => inFlight };
}

module.exports = { createBoardPublisher, buildPublishScript, FIRST_DELAY_MS, PERIOD_MS, UNCHANGED_MAX_MS };
