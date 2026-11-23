'use strict';

// 多个 Hub 窗口共用一个数据目录，但各自的会话只在自己内存里。「释放内存」面板要看全
// 所有窗口的会话，所以每个 Hub 定时把自己的会话清单写成一个小文件；别的窗口要休眠
//
//   <dataDir>/diagnostics/session-manifest-<pid>.json   会话清单（每 10 秒刷新）
//   <dataDir>/diagnostics/memory-release-inbox/<pid>/    发给某个 Hub 的休眠请求
//   <dataDir>/diagnostics/memory-release-inbox/results/  执行结果

const fs = require('fs');
const path = require('path');

const MANIFEST_PREFIX = 'session-manifest-';
const MANIFEST_FRESH_MS = 35_000;
const REQUEST_FRESH_MS = 30_000;

function manifestPath(diagnosticsDir, pid) {
  return path.join(diagnosticsDir, `${MANIFEST_PREFIX}${pid}.json`);
}

function readManifests(diagnosticsDir, { now = Date.now(), fsApi = fs } = {}) {
  const manifests = new Map();
  let entries = [];
  try { entries = fsApi.readdirSync(diagnosticsDir); } catch { return manifests; }
  for (const name of entries) {
    const match = name.match(/^session-manifest-(\d+)\.json$/);
    if (!match) continue;
    try {
      const data = JSON.parse(fsApi.readFileSync(path.join(diagnosticsDir, name), 'utf8'));
      const pid = Number(data && data.pid);
      if (pid !== Number(match[1]) || !Array.isArray(data.sessions)) continue;
      if (now - (Number(data.writtenAt) || 0) > MANIFEST_FRESH_MS) continue;
      manifests.set(pid, data);
    } catch { /* 正好读到写一半，跳过这轮 */ }
  }
  return manifests;
}

function createSessionManifestExchange(options = {}) {
  const diagnosticsDir = options.diagnosticsDir;
  if (!diagnosticsDir) throw new Error('diagnosticsDir required');
  const fsApi = options.fs || fs;
  const pid = Number(options.pid) || process.pid;
  const now = options.now || Date.now;
  const appVersion = String(options.appVersion || '');
  const describeSessions = options.describeSessions || (() => []);
  const suspendSession = options.suspendSession || (() => ({ ok: false, error: 'unsupported' }));
  const manifestMs = Math.max(1_000, Number(options.manifestMs) || 10_000);
  const inboxMs = Math.max(250, Number(options.inboxMs) || 2_000);
  const inboxRoot = path.join(diagnosticsDir, 'memory-release-inbox');
  const ownInbox = path.join(inboxRoot, String(pid));
  const resultsDir = path.join(inboxRoot, 'results');
  let manifestTimer = null;
  let inboxTimer = null;

  function writeAtomic(file, text) {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${pid}.tmp`;
    fsApi.writeFileSync(tmp, text);
    fsApi.renameSync(tmp, file);
  }

  function snapshot() {
    return { pid, appVersion, writtenAt: now(), sessions: describeSessions() };
  }

  // 代次：每次即时同步写加一。在途的定时异步写看到代次变了就不再改名；改名已发出则用即时写的内容补写回去，
  // 点按钮时写下的最新清单不会被更早开始的定时写盖掉（2026-11-23 复审）。
  let manifestGeneration = 0, lastSyncManifest = null;
  function writeManifest() {
    manifestGeneration += 1;
    try { lastSyncManifest = JSON.stringify(snapshot()); writeAtomic(manifestPath(diagnosticsDir, pid), lastSyncManifest); } catch { /* 下一轮再写 */ }
  }

  // 定时轮询走异步读写（2026-11-23）：每 10 秒一次的清单改名替换、每 2 秒一次的收件目录检查原来都是同步的，
  // 文件被杀毒或索引短暂占用时，改名重试会把主进程卡住数百毫秒到数秒。点按钮时的即时写入仍用同步版本。
  let manifestWriting = false, stopped = false;
  async function writeManifestAsync() {
    if (manifestWriting) return;
    manifestWriting = true;
    try {
      const generation = manifestGeneration;
      const file = manifestPath(diagnosticsDir, pid), tmp = `${file}.${pid}.async.tmp`;
      await fsApi.promises.mkdir(path.dirname(file), { recursive: true });
      await fsApi.promises.writeFile(tmp, JSON.stringify(snapshot()));
      // 已停止：不再发布清单（停止时删掉的文件不能被这次在途的写复活）。
      if (stopped || generation !== manifestGeneration) { await fsApi.promises.unlink(tmp).catch(() => {}); return; }
      await fsApi.promises.rename(tmp, file);
      if (!stopped && generation !== manifestGeneration && lastSyncManifest != null) {
        try { writeAtomic(file, lastSyncManifest); } catch { /* 下一轮再写 */ }
      }
      // 改名发出后才停止：停止时的删除可能先于这次改名完成，补删一次。
      if (stopped) { try { fsApi.unlinkSync(file); } catch { /* 已删 */ } }
    } catch { /* 下一轮再写 */ }
    finally { manifestWriting = false; }
  }

  let inboxChecking = false;
  async function pollInbox() {
    if (inboxChecking) return;
    inboxChecking = true;
    try {
      // 收件目录平时不存在或为空，异步看一眼；真有请求才进入同步处理（很少发生）。
      const entries = await fsApi.promises.readdir(ownInbox).catch(() => []);
      if (!stopped && entries.some(name => name.endsWith('.json'))) processInbox();
    } finally { inboxChecking = false; }
  }

  function processInbox() {
    let entries = [];
    try { entries = fsApi.readdirSync(ownInbox); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(ownInbox, name);
      let request = null;
      try { request = JSON.parse(fsApi.readFileSync(file, 'utf8')); } catch { /* 写一半或损坏 */ }
      try { fsApi.unlinkSync(file); } catch { /* 另一轮已处理 */ }
      if (!request || !request.requestId || !request.sessionId) continue;
      let result;
      if (now() - (Number(request.requestedAt) || 0) > REQUEST_FRESH_MS) result = { ok: false, error: 'request-expired', message: '请求已过期' };
      else {
        try { result = suspendSession(String(request.sessionId)) || { ok: false, error: 'unknown' }; }
        catch (error) { result = { ok: false, error: 'suspend-threw', message: error.message }; }
      }
      try {
        writeAtomic(path.join(resultsDir, `${String(request.requestId).replace(/[^\w-]/g, '')}.json`),
          JSON.stringify({ ...result, sessionId: request.sessionId, handledBy: pid, handledAt: now() }));
      } catch { /* 请求方会超时 */ }
    }
    if (entries.length) writeManifest();
  }

  async function requestRemoteSuspend(targetPid, sessionId, { timeoutMs = 8_000, pollMs = 250 } = {}) {
    const requestId = `${pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeAtomic(path.join(inboxRoot, String(targetPid), `${requestId}.json`),
        JSON.stringify({ requestId, sessionId, fromPid: pid, requestedAt: now() }));
    } catch (error) { return { ok: false, error: 'request-write-failed', message: error.message }; }
    const resultFile = path.join(resultsDir, `${requestId}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      try {
        const result = JSON.parse(fsApi.readFileSync(resultFile, 'utf8'));
        try { fsApi.unlinkSync(resultFile); } catch { /* ignore */ }
        return result;
      } catch { /* 还没处理 */ }
    }
    return { ok: false, error: 'remote-timeout', message: '另一个 Hub 窗口没有响应' };
  }

  function start() {
    stopped = false;
    void writeManifestAsync();
    manifestTimer = setInterval(() => void writeManifestAsync(), manifestMs);
    inboxTimer = setInterval(() => void pollInbox(), inboxMs);
    manifestTimer.unref?.();
    inboxTimer.unref?.();
  }

  function stop() {
    stopped = true;
    clearInterval(manifestTimer);
    clearInterval(inboxTimer);
    try { fsApi.unlinkSync(manifestPath(diagnosticsDir, pid)); } catch { /* ignore */ }
  }

  return { start, stop, snapshot, writeManifest, processInbox, requestRemoteSuspend, readManifests: () => readManifests(diagnosticsDir, { now: now(), fsApi }) };
}

module.exports = { createSessionManifestExchange, readManifests, manifestPath, MANIFEST_FRESH_MS };
