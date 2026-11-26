'use strict';
// 会议室运行时按需下载（2026-10-22 用户：安装包别默认带 76.8MB 的秘书终结者，第一次用再下）。
// 机制照抄桌宠形象包（core/hub-pet/role-packs.js）与一键更新：多源依次试，每个源下完都核对字节数和
// SHA-256；期望值来自随包的签名清单 baseline.json —— 地址只是取件地点，换了文件也装不进去。
// 只下载这一个 exe，拷进数据目录缓存后由 room-component 再核一次，不在原地下运行任何东西。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadWithFallback, fmtBytes } = require('../app-update/downloader');
const { resolveFetch } = require('./fetch-util');

// 下载只走公司内源（openx）；内源不生效时（纯 Node 单测）由调用方注入源，默认不提供外网源。
const SOURCES = Object.freeze([]);

function verified(file, asset) {
  try {
    return fs.statSync(file).size === asset.size
      && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === asset.sha256;
  } catch (_) { return false; }
}

function attemptsText(attempts) {
  return (attempts || []).map(a => `${a.name}：${a.status === 'ok' ? '可用' : a.reason || '失败'}`).join('；');
}

// dataDir：Hub 数据目录；baseline：签名清单（manifest 校验过的那份）。
function createRuntimeDownload({ dataDir, baseline, sources = SOURCES, fetchImpl,
  idleTimeoutMs, connectTimeoutMs, onState = () => {} } = {}) {
  if (!baseline || !baseline.exe || !baseline.exe.file) throw new Error('会议室组件清单缺少运行时信息');
  const doFetch = resolveFetch(fetchImpl);
  const exe = path.join(dataDir, 'room-runtime', baseline.exe.sha256, baseline.exe.file);
  let state = { phase: 'idle', received: 0, total: baseline.exe.size, speed: 0, etaSec: null, sourceName: null, attempts: [], error: null };
  let inflight = null, abort = null;
  const notify = patch => {
    state = { ...state, ...patch };
    try { onState(snapshot()); } catch (_) {}
    return snapshot();
  };
  // 状态每几秒刷一次，不能每次都算 77MB 的哈希：先比字节数，哈希结果按 (大小, 修改时间) 记住。
  // 校验不过的结果也记：坏文件删不掉时（正被占用）不能每 3 秒再算一遍 77MB。
  let memo = null;
  const installed = () => {
    let st;
    try { st = fs.statSync(exe); } catch (_) { memo = null; return false; }
    if (st.size !== baseline.exe.size) { memo = null; return false; }
    if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.ok;
    const ok = verified(exe, baseline.exe);
    memo = { size: st.size, mtimeMs: st.mtimeMs, ok };
    return ok;
  };
  function snapshot() {
    const there = installed();
    return { installed: there, file: baseline.exe.file, bytes: baseline.exe.size, sha256: baseline.exe.sha256,
      exe: there ? exe : null, ...state };
  }
  function ensure() {
    if (installed()) return Promise.resolve(exe);
    if (inflight) return inflight;
    abort = new AbortController();
    const signal = abort.signal;
    inflight = (async () => {
      notify({ phase: 'downloading', received: 0, speed: 0, etaSec: null, sourceId: null, sourceName: null, error: null, attempts: [] });
      // 清单里是 size，下载器要的是 bytes；文件名、字节数、sha256 一个都不能少。
      const expect = { file: baseline.exe.file, bytes: baseline.exe.size, sha256: baseline.exe.sha256 };
      const result = await downloadWithFallback({ sources, version: baseline.version, expect, dest: exe,
        openx: { release: `room-runtime-${baseline.version}` },
        fetchImpl: doFetch, signal, idleTimeoutMs, connectTimeoutMs,
        onProgress: p => notify({ received: p.received, total: p.total, speed: p.speed, etaSec: p.etaSec, sourceId: p.sourceId, sourceName: p.sourceName }),
        // url 带上：界面据此显示每个来源的状态。
        onAttempt: attempts => notify({ attempts: attempts.map(a => ({ id: a.id, name: a.name, url: a.url, status: a.status, reason: a.reason, blocked: !!a.blocked })) }) });
      if (!result.ok) {
        const reason = result.cancelled ? '下载已取消' : `会议室组件没下载成功（${attemptsText(result.attempts)}）`;
        notify({ phase: result.cancelled ? 'cancelled' : 'error', error: reason, sourceName: null });
        throw Object.assign(new Error(reason), { code: 'runtime-download-failed', attempts: result.attempts, cancelled: !!result.cancelled });
      }
      // 下载器核过一遍，这里再核一次，确认落盘的就是签名清单上那个文件。
      if (!installed()) {
        try { fs.rmSync(exe, { force: true }); } catch (_) {}
        const reason = '会议室组件下载后校验失败，已删掉这个文件；请重试，或换一个网络再试';
        notify({ phase: 'error', error: reason });
        throw Object.assign(new Error(reason), { code: 'runtime-download-failed' });
      }
      notify({ phase: 'installed', received: baseline.exe.size, sourceName: result.source?.name || null, error: null });
      return exe;
    })().catch(error => {
      if (state.phase !== 'cancelled' && state.phase !== 'error') notify({ phase: 'error', error: error.message });
      throw error;
    }).finally(() => { inflight = null; abort = null; });
    return inflight;
  }
  return { snapshot, status: snapshot, ensure, installed, cancel: () => abort?.abort(), exe, bytes: baseline.exe.size };
}

module.exports = { SOURCES, createRuntimeDownload, resolveFetch, verified, fmtBytes };
