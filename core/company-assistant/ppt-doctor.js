'use strict';
// PPT Doctor owns its runtime. The Hub never invokes a system Python fallback.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { API_VERSION, DOWNLOAD_URL, READ_ONLY, failure, readJson, matchEnvelope, validateResult } = require('./ppt-doctor-protocol');
const ACTIONS = new Set(['status', 'catalog', 'search', 'read', 'report', 'index', 'imgtext-seed', 'imgtext-build', 'imgtext']);

class PptDoctor {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.env = deps.pptEnv || process.env;
    this.children = new Set(); this.closed = false;
    this.cached = null; this.checking = null;
    this.server = new (require('./ppt-doctor-server').PptDoctorServer)(this);
  }
  config() { return this.a.settings().ppt || {}; }
  // 2026-11-07：装了多份时由自动发现（core/tool-discovery）按版本选；用户指定的程序被卸载 / 移动时不再一直报错，回到扫描。
  async discover() {
    const override = this.config().doctorExe || this.env.PPT_DOCTOR_EXE;
    if (override && path.isAbsolute(override) && fs.existsSync(override)) return path.resolve(override);
    const discovery = this.deps.toolDiscovery;
    if (discovery?.has?.('ppt-doctor')) {
      const summary = await discovery.list('ppt-doctor');
      if (summary.current?.path) return summary.current.path;
    } else {
      const candidates = await require('./ppt-doctor-discovery').candidates(this.env, this.deps);
      const found = candidates.find(file => path.isAbsolute(file) && fs.existsSync(file));
      if (found) return found;
    }
    if (override) throw failure('DOCTOR_NOT_FOUND', '之前指定的 PPT Doctor 程序已经不在了，也没在常见位置找到新的；请重新安装或手动指定', { downloadUrl: DOWNLOAD_URL });
    throw failure('DOCTOR_NOT_FOUND', '请安装 PPT Doctor 后使用 PPT 素材库与图片转可编辑，无需另装 Python', { downloadUrl: DOWNLOAD_URL });
  }
  async status({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < 60000) return this.cached;
    if (this.checking) return this.checking;
    this.checking = this.call('status', { ...(this.config().db ? { db: this.config().db } : {}), includePaths: true }).then(result => (this.cached = { ...result, installed: true, state: result.available === false ? 'empty' : 'ready', checkedAt: Date.now() }))
      .catch(error => (this.cached = { ok: false, available: false, state: error.code === 'DOCTOR_NOT_FOUND' ? 'missing' : error.code === 'DOCTOR_UPGRADE_REQUIRED' ? 'upgrade' : 'error', code: error.code || 'DOCTOR_ERROR', error: error.message, downloadUrl: error.downloadUrl || DOWNLOAD_URL, checkedAt: Date.now() }))
      .finally(() => { this.checking = null; });
    return this.checking;
  }
  async call(action, request = {}, options = {}) {
    if (!ACTIONS.has(action)) throw failure('DOCTOR_ACTION', '不支持的 PPT Doctor 操作');
    if (this.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    const exe = await this.discover();
    const marker = this.deps.pptDoctorTrustedExecutable ? this.deps.pptDoctorCapability : await require('./ppt-doctor-discovery').capability(exe);
    if (!this.deps.pptDoctorTrustedExecutable && !marker) {
      throw failure('DOCTOR_UPGRADE_REQUIRED', '请升级 PPT Doctor：安装目录缺少兼容的 Hub 联动能力标记，未启动旧程序', { downloadUrl: DOWNLOAD_URL });
    }
    if (this.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    options = { ...options, timeoutMs: options.timeoutMs ?? this.deps.pptDoctorTimeoutMs ?? (action === 'index' ? 1800000 : action.startsWith('imgtext') ? 180000 : 30000) };
    // Indexing can run for minutes; do not put it ahead of interactive reads in
    // the Doctor's serial resident queue. The same runtime owns both processes.
    if (action !== 'index' && marker?.capabilities?.includes('serve')) {
      try { return await this.server.call(exe, marker, action, request, options); }
      catch (error) {
        if (!error.beforeEnqueue || error.requestQueued || this.closed) throw error;
        console.warn('[ppt-doctor] 常驻服务未提交任务，改用单次调用：', error.message);
      }
    }
    return this.callOnce(exe, action, request, options);
  }
  async callOnce(exe, action, request, options) {
    if (this.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    const root = path.join(this.a.dir, 'ppt-doctor', 'requests');
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, randomUUID()); fs.mkdirSync(dir);
    const input = path.join(dir, 'request.json'), output = path.join(dir, 'response.json'), progress = path.join(dir, 'progress.json');
    const requestId = randomUUID();
    fs.writeFileSync(input, JSON.stringify({ ...request, apiVersion: API_VERSION, requestId }), { encoding: 'utf8', mode: 0o600 });
    const args = [...(this.deps.pptDoctorArgs || []), '--hub', action, '--in', input, '--out', output];
    if (options.onProgress) args.push('--progress', progress);
    const timeoutMs = options.timeoutMs;
    let child, responseConfirmed = false;
    try {
      const exit = await new Promise((resolve, reject) => {
        let settled = false, timer, poll, previous = '';
        const finish = (error, code) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); error ? reject(error) : resolve(code); };
        const abort = error => {
          if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll);
          void this.kill(child).then(() => reject(error), killError => reject(failure(error.code, error.message + '；结束进程失败：' + killError.message)));
        };
        try { child = (this.deps.pptDoctorSpawn || spawn)(exe, args, { windowsHide: true, shell: false, env: { ...this.env }, stdio: 'ignore' }); }
        catch (error) { finish(error); return; }
        this.children.add(child);
        child.once('error', error => finish(failure('DOCTOR_START_FAILED', 'PPT Doctor 未能启动：' + error.message)));
        child.once('close', code => finish(null, code));
        timer = setTimeout(() => abort(failure('DOCTOR_TIMEOUT', `PPT Doctor ${Math.round(timeoutMs / 1000)} 秒内没有完成，请重试；本次未交付截断结果`)), timeoutMs);
        if (options.onProgress) poll = setInterval(() => {
          try {
            const value = readJson(progress, 65536), text = JSON.stringify(value); if (text === previous) return;
            matchEnvelope(value, requestId, action);
            previous = text; options.onProgress(value);
          } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) abort(failure('DOCTOR_PROGRESS_ERROR', '读取索引进度失败：' + error.message)); }
        }, 500);
      });
      let result;
      try {
        result = readJson(output); matchEnvelope(result, requestId, action);
        responseConfirmed = typeof result.ok === 'boolean';
        result = validateResult(result, requestId, action, exit);
      }
      catch (error) {
        if (error.code === 'ENOENT') throw failure('DOCTOR_INVALID_RESPONSE', 'PPT Doctor 没有返回结果文件，请升级 PPT Doctor 后重试', { downloadUrl: DOWNLOAD_URL, exitCode: exit });
        throw error;
      }
      return { ...result, executable: exe };
    } catch (error) {
      // A killed/crashed one-shot writer can also have produced files. Keep the
      // same manual recovery boundary as an interrupted resident request.
      if (child?.pid && !READ_ONLY.has(action) && !responseConfirmed) {
        error.resultMayBePartial = true; error.retryable = false;
      }
      throw error;
    } finally {
      this.children.delete(child);
      // Only these unique request files belong to this call. Keep OCR artifacts.
      for (const file of [input, output, progress]) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') console.warn('[ppt-doctor] 临时文件未清理', e.message); } }
      try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') console.warn('[ppt-doctor] 临时请求目录未清理', e.message); }
    }
  }
  kill(child) {
    if (!child?.pid || child.exitCode != null) return Promise.resolve();
    if (this.deps.pptDoctorKill) return Promise.resolve(this.deps.pptDoctorKill(child));
    if (process.platform !== 'win32') { child.kill('SIGKILL'); return Promise.resolve(); }
    return new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
      if (error && child.exitCode == null) reject(error); else resolve();
    }));
  }
  close() {
    this.closed = true; void this.server.close();
    for (const child of this.children) void this.kill(child).catch(error => console.warn('[ppt-doctor] 结束本次调用失败', error.message));
  }
}

module.exports = { PptDoctor, API_VERSION, DOWNLOAD_URL, ACTIONS };
