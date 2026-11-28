'use strict';
// 借本人 Edge 登录读取内源社区黑板（2026-11-28，对照 main/openx-login-list.js R63）：
// query/by_id 接口要求登录（code 401）时，在绿区等隔离环境下无头复制 Edge 登录态读一次 community-board 描述。
const openxSource = require('../core/app-update/openx-source');
const openxConfig = require('../core/app-update/openx-config');
const capture = require('./company-edge-capture');
const { findEdge } = require('./edge-headless');
const { BOARD_RELEASE_NAME } = require('../core/community/openx-board');

const BUDGET_MS = 20000;
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

function buildBoardReadScript({ apiPath, releaseId }) {
  const cfg = JSON.stringify({
    apiPath: String(apiPath || ''),
    id: Number(releaseId) || 0,
    expectedVersion: BOARD_RELEASE_NAME,
  });
  return `(async () => {
    const cfg = ${cfg};
    let token = '';
    try { token = localStorage.getItem('token') || sessionStorage.getItem('token') || ''; } catch (_) {}
    if (!token) return { needsLogin: true, reason: 'no-token' };
    const r = await fetch(cfg.apiPath + 'by_id?id=' + encodeURIComponent(cfg.id), {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => null);
    const code = j && String(j.code);
    if (r.status === 401 || r.status === 403 || code === '401' || code === '403') {
      return { needsLogin: true, reason: 'auth-' + (code || r.status) };
    }
    if (!r.ok || code !== '0' || !j.data) return { ok: false, reason: 'read-' + (code || r.status) };
    if (String(j.data.version || '').trim() !== cfg.expectedVersion) {
      return { ok: false, reason: 'version-mismatch' };
    }
    return { ok: true, description: String(j.data.description || '') };
  })()`;
}

function loginBoardEnabled(env = process.env, versions = process.versions) {
  const v = String(env.AI_HUB_OPENX_LOGIN_BOARD || '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return openxSource.active(env, versions);
}

function createOpenxBoardReader({
  env = process.env,
  logger = console,
  runInEdge = capture.runInEdge,
  findEdgeFn = findEdge,
  pageUrl = () => openxSource.downloadPageUrl(),
  apiUrl = openxConfig.api,
  now = Date.now,
} = {}) {
  let cooldownUntil = 0;
  let inFlight = null;

  return async ({ releaseId, signal = null } = {}) => {
    if (!loginBoardEnabled(env)) return { ok: false, error: '未启用 Edge 读取黑板' };
    if (signal && signal.aborted) return { ok: false, error: '已取消' };
    if (now() < cooldownUntil) return { ok: false, error: 'Edge 读取黑板冷却中' };
    if (!findEdgeFn(env)) { cooldownUntil = now() + FAIL_COOLDOWN_MS; return { ok: false, error: '本机没有找到 Edge' }; }
    const url = String(pageUrl() || '');
    let host = '', apiPath = '';
    try { host = new URL(url).host; apiPath = new URL(apiUrl).pathname; } catch (_) {}
    if (!host || !apiPath || !releaseId) return { ok: false, error: '缺少内源黑板配置' };
    if (inFlight) return inFlight;

    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    inFlight = (async () => {
      try {
        const res = await runInEdge({
          url,
          readyUrl: new RegExp('^https://' + escaped + '/', 'i'),
          script: buildBoardReadScript({ apiPath, releaseId }),
          accept: v => !!v && !v.needsLogin,
          signal,
          timeoutMs: BUDGET_MS,
          loginGraceMs: Math.max(4000, BUDGET_MS - 4000),
          tag: 'hub-edge-community-board-read',
          logger,
          env,
        });
        const v = res && res.ok ? res.value : null;
        if (v && v.ok) return { ok: true, description: v.description };
        if (!(signal && signal.aborted)) cooldownUntil = now() + FAIL_COOLDOWN_MS;
        return { ok: false, error: (v && v.reason) || (res && res.error) || 'Edge 读取黑板失败' };
      } catch (e) {
        if (!(signal && signal.aborted)) cooldownUntil = now() + FAIL_COOLDOWN_MS;
        return { ok: false, error: e && e.message ? e.message : String(e) };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

module.exports = { createOpenxBoardReader, buildBoardReadScript, loginBoardEnabled, BUDGET_MS, FAIL_COOLDOWN_MS };
