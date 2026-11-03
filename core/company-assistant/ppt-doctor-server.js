'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { API_VERSION, READ_ONLY, failure, readJson, matchEnvelope, validateResult } = require('./ppt-doctor-protocol');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The queue lives only below this Hub's data directory. Refuse junctions and
// network paths rather than letting a queue consume unrelated directory data.
function ensureLocalDirectory(dir) {
  if (!path.isAbsolute(dir) || /^[/\\]{2}/.test(dir)) throw failure('DOCTOR_SPOOL_PATH', 'PPT Doctor 工作目录必须位于本机真实目录');
  const resolved = path.resolve(dir), parts = [];
  for (let current = resolved; ; current = path.dirname(current)) { parts.push(current); if (path.dirname(current) === current) break; }
  for (const current of parts.reverse()) {
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('DOCTOR_SPOOL_PATH', 'PPT Doctor 工作目录不能经过目录链接');
  }
}
function atomicWrite(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') console.warn('[ppt-doctor] 队列临时文件未清理', error.message); } }
}
async function executableMatches(pid, exe) {
  if (!alive(pid)) return false;
  if (process.platform !== 'win32') {
    try { return normalize(fs.realpathSync(`/proc/${pid}/exe`)) === normalize(fs.realpathSync(exe)); } catch { return false; }
  }
  // pid is validated as an integer; no user path is interpolated into shell code.
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`;
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 6000, encoding: 'utf8', maxBuffer: 16384 }, (error, output) => resolve(!error && output.trim() && normalize(output.trim()) === normalize(exe))));
}

class PptDoctorServer {
  constructor(owner) { this.owner = owner; this.deps = owner.deps; this.sessions = new Map(); this.closed = false; }
  session(exe, marker) {
    const key = createHash('sha256').update(`${normalize(exe)}:${marker.exeSha256}`).digest('hex');
    if (!this.sessions.has(key)) this.sessions.set(key, { exe, spool: path.join(this.owner.a.dir, 'ppt-doctor', 'servers', key), child: null, server: null, starting: null, verified: null, abandoned: new Map(), cleanupTimer: null, cleanupLoaded: false });
    return this.sessions.get(key);
  }
  loadAbandoned(s) {
    if (s.cleanupLoaded) return;
    for (const name of fs.readdirSync(path.join(s.spool, 'abandoned'))) {
      if (!/^[a-f\d]{32}\.json$/.test(name)) continue;
      try {
        const item = readJson(path.join(s.spool, 'abandoned', name), 4096);
        if (item.apiVersion !== API_VERSION || `${item.jobId}.json` !== name || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item.requestId || '')
          || !/^(status|catalog|search|read|report|index|imgtext-seed|imgtext-build|imgtext)$/.test(item.action || '')) continue;
        s.abandoned.set(item.jobId, item);
      } catch (error) { console.warn('[ppt-doctor] 未完成请求清理记录读取失败', error.message); }
    }
    s.cleanupLoaded = true; this.cleanAbandoned(s);
  }
  abandon(s, jobId, requestId, action) {
    const item = { apiVersion: API_VERSION, jobId, requestId, action };
    s.abandoned.set(jobId, item);
    try { atomicWrite(path.join(s.spool, 'abandoned', `${jobId}.json`), item); }
    catch (error) { console.warn('[ppt-doctor] 未完成请求清理记录保存失败', error.message); }
    if (!this.closed) this.cleanAbandoned(s);
  }
  cleanAbandoned(s) {
    for (const [jobId, item] of s.abandoned) {
      const response = path.join(s.spool, 'responses', `${jobId}.json`), progress = path.join(s.spool, 'progress', `${jobId}.json`);
      try {
        if (!item.consumed) {
          let result;
          try { result = readJson(response); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          matchEnvelope(result, item.requestId, item.action);
          // A timeout abandons the reply, never the task's PPT/OCR output. Also
          // preserve mismatched envelopes as evidence instead of deleting them.
          try { matchEnvelope(readJson(progress, 65536), item.requestId, item.action); fs.unlinkSync(progress); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { fs.unlinkSync(response); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          item.consumed = true;
        }
        try { fs.unlinkSync(path.join(s.spool, 'abandoned', `${jobId}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        s.abandoned.delete(jobId);
      } catch (error) {
        if (item.cleanupError !== error.message) console.warn('[ppt-doctor] 迟到结果暂未清理', error.message);
        item.cleanupError = error.message;
      }
    }
    if (s.abandoned.size && !this.closed && !s.cleanupTimer) {
      s.cleanupTimer = setTimeout(() => { s.cleanupTimer = null; this.cleanAbandoned(s); }, this.deps.pptDoctorCleanupMs ?? 1000);
      s.cleanupTimer.unref?.();
    }
  }
  async inspect(s) {
    let info;
    try { info = readJson(path.join(s.spool, 'server.json'), 65536); } catch { return null; }
    if (!info || typeof info !== 'object') return null;
    const heartbeat = Date.parse(info.heartbeatAt), now = Date.now();
    if (info.apiVersion !== API_VERSION || !Number.isSafeInteger(info.pid) || info.pid <= 0 || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(info.instanceId || '')
      || !['ready', 'busy', 'stopping'].includes(info.state) || !Number.isFinite(Date.parse(info.startedAt))
      || !Number.isFinite(heartbeat) || now - heartbeat > (this.deps.pptDoctorHeartbeatMs ?? 15000) || heartbeat - now > 5000 || !alive(info.pid)) return null;
    const owned = s.child && !s.child.done && s.child.process.pid === info.pid;
    const identity = `${info.instanceId}:${info.pid}:${info.startedAt}`;
    // Own children retain their executable identity until the exit event. For an
    // attached instance, recheck its path periodically as well as each heartbeat.
    if (!owned && (!s.verified || s.verified.identity !== identity || now - s.verified.at > 5000)) {
      if (!(await (this.deps.pptDoctorVerifyProcess || executableMatches)(info.pid, s.exe))) return null;
      s.verified = { identity, at: Date.now() };
    }
    s.server = info;
    return info;
  }
  async ensureStarted(s) {
    if (this.closed || this.owner.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    if (s.starting) return s.starting;
    s.starting = this.start(s).finally(() => { s.starting = null; });
    return s.starting;
  }
  async start(s) {
    ensureLocalDirectory(s.spool);
    for (const name of ['requests', 'working', 'responses', 'progress', 'abandoned']) ensureLocalDirectory(path.join(s.spool, name));
    this.loadAbandoned(s);
    let spawned = false;
    const startChild = () => {
      let process;
      try { process = (this.deps.pptDoctorSpawn || spawn)(s.exe, [...(this.deps.pptDoctorArgs || []), '--hub', 'serve', '--spool', s.spool], { windowsHide: true, shell: false, env: { ...this.owner.env }, stdio: 'ignore' }); }
      catch (error) { throw failure('DOCTOR_SERVER_START_FAILED', 'PPT Doctor 常驻服务启动失败：' + error.message); }
      const child = { process, done: false, error: null }; s.child = child;
      process.once('error', error => { child.done = true; child.error = error; });
      process.once('exit', () => { child.done = true; });
      process.once('close', () => { child.done = true; });
      spawned = true;
    };
    const deadline = Date.now() + (this.deps.pptDoctorServerStartMs ?? 12000);
    while (Date.now() < deadline) {
      if (this.closed || this.owner.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
      const info = await this.inspect(s);
      if (this.closed || this.owner.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
      if (info && info.state !== 'stopping') return info;
      if (!info && (!s.child || s.child.done || (s.child.process.pid && !alive(s.child.process.pid)))) {
        if (spawned) throw failure('DOCTOR_SERVER_START_FAILED', 'PPT Doctor 常驻服务未就绪就退出了' + (s.child?.error ? '：' + s.child.error.message : ''));
        startChild();
      }
      await pause(this.deps.pptDoctorPollMs ?? 150);
    }
    throw failure('DOCTOR_SERVER_START_FAILED', 'PPT Doctor 常驻服务尚未就绪');
  }
  async call(exe, marker, action, request, options) {
    const s = this.session(exe, marker);
    // Only failure before atomic enqueue may fall back to the one-shot protocol.
    try { await this.ensureStarted(s); }
    catch (error) { error.beforeEnqueue = true; throw error; }
    for (let attempt = 0; ; attempt++) {
      try { return await this.enqueue(s, action, request, options); }
      catch (error) {
        if (attempt === 0 && READ_ONLY.has(action) && error.code === 'REQUEST_INTERRUPTED' && error.retryable === true && !this.closed) {
          await this.ensureStarted(s); continue;
        }
        throw error;
      }
    }
  }
  async enqueue(s, action, request, options) {
    if (this.closed || this.owner.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    const jobId = randomUUID().replace(/-/g, ''), requestId = randomUUID();
    const response = path.join(s.spool, 'responses', `${jobId}.json`), progress = path.join(s.spool, 'progress', `${jobId}.json`);
    try { atomicWrite(path.join(s.spool, 'requests', `${jobId}.json`), { ...request, apiVersion: API_VERSION, requestId, action }); }
    catch (error) { error.beforeEnqueue = true; throw error; }
    const write = !READ_ONLY.has(action), deadline = Date.now() + options.timeoutMs;
    let lastCheck = 0, previous = '', restarted = false;
    try {
      while (true) {
        if (fs.existsSync(response)) {
          const result = readJson(response); matchEnvelope(result, requestId, action);
          // Never remove an uncorrelated result; only reclaim this matched job.
          for (const file of [response, progress]) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.warn('[ppt-doctor] 队列结果未清理', error.message); } }
          return { ...validateResult(result, requestId, action), executable: s.exe };
        }
        if (this.closed || this.owner.closed) throw failure('DOCTOR_CLOSED', 'Hub 已关闭；已提交的 PPT Doctor 任务可能仍在完成，请检查结果后重试');
        if (Date.now() >= deadline) throw failure('DOCTOR_TIMEOUT', write ? 'PPT Doctor 尚未完成；已提交的任务可能仍在运行，请检查输出后重试' : 'PPT Doctor 尚未返回完整结果，请稍后重试');
        if (options.onProgress && fs.existsSync(progress)) {
          const value = readJson(progress, 65536); matchEnvelope(value, requestId, action);
          const text = JSON.stringify(value);
          if (text !== previous) { previous = text; options.onProgress(value); }
        }
        if (Date.now() - lastCheck >= (this.deps.pptDoctorHealthPollMs ?? 1000)) {
          lastCheck = Date.now(); const info = await this.inspect(s);
          if (!info || info.state === 'stopping') {
            if (restarted) throw failure('DOCTOR_SERVER_INTERRUPTED', 'PPT Doctor 服务再次中断；请检查任务结果后重试');
            restarted = true;
            // Restart the server, keeping this job ID in place. The server alone
            // recovers queued/working requests; a write is never resubmitted.
            await this.ensureStarted(s);
          }
        }
        await pause(this.deps.pptDoctorPollMs ?? 150);
      }
    } catch (error) {
      if (['DOCTOR_TIMEOUT', 'DOCTOR_CLOSED', 'DOCTOR_SERVER_INTERRUPTED', 'DOCTOR_SERVER_START_FAILED'].includes(error.code)) this.abandon(s, jobId, requestId, action);
      error.requestQueued = true; error.jobId = jobId;
      if (write && error.code !== 'REQUEST_INTERRUPTED') { error.resultMayBePartial = true; error.retryable = false; }
      throw error;
    }
  }
  close() {
    this.closed = true;
    for (const s of this.sessions.values()) { clearTimeout(s.cleanupTimer); s.cleanupTimer = null; }
    if (this.closing) return this.closing;
    this.closing = Promise.allSettled([...this.sessions.values()].map(async s => {
      // If close races startup, give our own process time to publish its identity.
      const deadline = Date.now() + (this.deps.pptDoctorServerStartMs ?? 12000);
      do {
        const info = await this.inspect(s);
        if (info) { atomicWrite(path.join(s.spool, 'stop.json'), { instanceId: info.instanceId }); return; }
        if (!s.child || s.child.done) return;
        await pause(this.deps.pptDoctorPollMs ?? 150);
      } while (Date.now() < deadline);
    })).then(results => { for (const result of results) if (result.status === 'rejected') console.warn('[ppt-doctor] 常驻服务关闭请求失败', result.reason.message); });
    return this.closing;
  }
}
module.exports = { PptDoctorServer, ensureLocalDirectory, executableMatches };
