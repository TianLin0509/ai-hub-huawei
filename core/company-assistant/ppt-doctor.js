'use strict';
// PPT Doctor owns its runtime. The Hub never invokes a system Python fallback.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { API_VERSION, DOWNLOAD_URL, READ_ONLY, failure, readJson, matchEnvelope, validateResult } = require('./ppt-doctor-protocol');
// 第一版带 --hub 联动入口的 PPT Doctor（2026-11-02 起，v2.0.7 是首个发布版）。
const MIN_HUB_DOCTOR = '2.0.7';
// 这些失败说明「回执本身不对」（协议不通、没启动、没回结果）；其余失败都是信封对上之后的业务失败。
const PROTOCOL_BROKEN = new Set(['DOCTOR_UPGRADE_REQUIRED', 'DOCTOR_INVALID_RESPONSE', 'DOCTOR_WRONG_RESPONSE', 'DOCTOR_TIMEOUT', 'DOCTOR_START_FAILED', 'DOCTOR_RESULT_TOO_LARGE']);
const ACTIONS = new Set(['status', 'catalog', 'search', 'read', 'report', 'index', 'imgtext-seed', 'imgtext-build', 'imgtext']);

class PptDoctor {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.env = deps.pptEnv || process.env;
    this.children = new Set(); this.closed = false;
    this.cached = null; this.checking = null;
    this.server = new (require('./ppt-doctor-server').PptDoctorServer)(this);
  }
  config() { return this.a.settings().ppt || {}; }
  runtimeEnv(root) {
    if (root === this.a.dir) return { ...this.env };
    const temp = path.join(root, 'ppt-temp'); fs.mkdirSync(temp, { recursive: true });
    return { ...this.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  }
  // 2026-11-07：装了多份时由自动发现（core/tool-discovery）按版本选；用户指定的程序被卸载 / 移动时不再一直报错，回到扫描。
  async discover() {
    const override = this.config().doctorExe || this.env.PPT_DOCTOR_EXE;
    const usable = override && path.isAbsolute(override) && fs.existsSync(override);
    const hubOwned = usable && require('./ppt-doctor-discovery').isHubInstall(override);
    if (usable && !hubOwned) return path.resolve(override);
    const discovery = this.deps.toolDiscovery;
    if (discovery?.has?.('ppt-doctor')) {
      const summary = await discovery.list('ppt-doctor');
      if (summary.current?.path) return summary.current.path;
    }
    if (hubOwned) return path.resolve(override);
    // 自动发现只选择兼容版本；没有兼容项时仍找出旧安装，交给能力检查提示升级。
    {
      const candidates = await require('./ppt-doctor-discovery').candidates(this.env, this.deps);
      const found = candidates.find(file => path.isAbsolute(file) && fs.existsSync(file));
      if (found) return found;
    }
    if (override) throw failure('DOCTOR_NOT_FOUND', '之前指定的 PPT Doctor 程序已经不在了，也没在常见位置找到新的；请重新安装或手动指定', { downloadUrl: DOWNLOAD_URL });
    throw failure('DOCTOR_NOT_FOUND', '请安装 PPT Doctor 后使用 PPT 素材库与图片转可编辑，无需另装 Python', { downloadUrl: DOWNLOAD_URL });
  }
  // R31：一键安装 / 升级前读本机已装的版本，安装器据此绝不装回更旧的版本。
  // 主程序文件版本、安装清单 manifest.json、联动标记三处取最高：装了一半（主程序没换掉）时按已经到手的新版本算，宁可多装不回退。
  async installedVersion() {
    let exe;
    try { exe = await this.discover(); } catch { return ''; }
    const dir = path.dirname(exe), read = name => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
    const found = [read('manifest.json')?.version, read('hub-api.json')?.doctorVersion,
      await Promise.resolve().then(() => (this.deps.pptDoctorExeVersion || require('../tool-discovery/tools').exeFileVersion)(exe)).catch(() => null)];
    const { compareVersions, parseVersion } = require('../tool-discovery/candidates');
    return found.map(v => String(v || '').slice(0, 32)).filter(v => parseVersion(v)).sort((a, b) => compareVersions(b, a))[0] || '';
  }
  async status({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < 60000) return this.cached;
    if (this.checking) return this.checking;
    this.checking = this.call('status', { ...(this.config().db ? { db: this.config().db } : {}), includePaths: true }).then(result => (this.cached = { ...result, installed: true, state: result.available === false ? 'empty' : 'ready', checkedAt: Date.now() }))
      .catch(error => (this.cached = { ok: false, available: false, installed: error.code === 'DOCTOR_UPGRADE_REQUIRED', state: error.code === 'DOCTOR_NOT_FOUND' ? 'missing' : error.code === 'DOCTOR_UPGRADE_REQUIRED' ? 'upgrade' : 'error', code: error.code || 'DOCTOR_ERROR', error: error.message, installedVersion: error.installedVersion || '', incomplete: !!error.incomplete, downloadUrl: error.downloadUrl || DOWNLOAD_URL, checkedAt: Date.now() }))
      .finally(() => { this.checking = null; });
    return this.checking;
  }
  async call(action, request = {}, options = {}) {
    if (!ACTIONS.has(action)) throw failure('DOCTOR_ACTION', '不支持的 PPT Doctor 操作');
    if (this.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    // 调用开始时固定路径；修改设置不会把已经入队的任务转到别的盘。
    options = { ...options, workRoot: require('./ppt-work-dir').workDir(this.a, { writable: true }) };
    const exe = await this.discover();
    let marker = this.deps.pptDoctorTrustedExecutable ? this.deps.pptDoctorCapability : await require('./ppt-doctor-discovery').capability(exe);
    if (!this.deps.pptDoctorTrustedExecutable && marker?.exeHashMismatch) marker = await this.confirmMismatch(exe, marker, options);
    if (!this.deps.pptDoctorTrustedExecutable && !marker) {
      let installedVersion = '';
      try { installedVersion = String(JSON.parse(fs.readFileSync(path.join(path.dirname(exe), 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')).version || '').slice(0, 32); } catch { /* 读不到版本号时只提示升级 */ }
      if (!installedVersion) installedVersion = await require('../tool-discovery/tools').exeFileVersion(exe) || '';
      throw failure('DOCTOR_UPGRADE_REQUIRED', `已检测到 PPT Doctor${installedVersion ? ' ' + installedVersion : ''}，版本太旧，和 Hub 联动不上，点一键升级即可`, { downloadUrl: DOWNLOAD_URL, installedVersion });
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
  // R31：标记和主程序哈希对不上（覆盖安装时主程序被占用没换掉最常见）。不凭哈希判死：
  //   1) 主程序自身的文件版本 ≥ 2.0.7（第一版带 --hub 的 PPT Doctor），保证不会把不认识 --hub 的老程序当界面打开；
  //   2) 实际调一次 status，回执的协议版本对得上就照常用。常驻服务能力按标记是新版写的，主程序可能更旧，这时只走单次调用。
  // 同一个程序文件只确认一次；对不上就提示一键升级，安装器保证不装回比已装更旧的版本。
  async confirmMismatch(exe, marker, options) {
    let key = exe;
    try { const st = fs.statSync(exe); key = `${exe}:${st.size}:${st.mtimeMs}:${marker.exeSha256}`; } catch { /* 读不到状态就每次都确认 */ }
    if (this.mismatchOk?.key === key) return this.mismatchOk.marker;
    const { compareVersions } = require('../tool-discovery/candidates');
    const exeVersion = String(await (this.deps.pptDoctorExeVersion || require('../tool-discovery/tools').exeFileVersion)(exe) || '').slice(0, 32);
    const markerVersion = String(marker.doctorVersion || '').slice(0, 32);
    const installedVersion = [exeVersion, markerVersion].filter(Boolean).sort((a, b) => compareVersions(b, a))[0] || '';
    const broken = () => failure('DOCTOR_UPGRADE_REQUIRED', `PPT Doctor 安装不完整：主程序是 ${exeVersion ? 'v' + exeVersion : '未知版本'}，其余文件是 ${markerVersion ? 'v' + markerVersion : '未知版本'}，多半是更新时 PPT Doctor 正在运行、主程序没换掉，点一键升级即可`, { downloadUrl: DOWNLOAD_URL, installedVersion, exeVersion, incomplete: true });
    if (!exeVersion || compareVersions(exeVersion, MIN_HUB_DOCTOR) < 0) throw broken();
    const safe = { ...marker, capabilities: marker.capabilities.filter(c => c !== 'serve') };
    try { await this.callOnce(exe, 'status', {}, { ...options, onProgress: undefined, timeoutMs: this.deps.pptDoctorTimeoutMs ?? 20000 }); }
    catch (error) {
      if (error.code === 'DOCTOR_CLOSED') throw error;
      // 回执信封对得上、只是业务上失败（如还没建索引），说明协议是通的。
      if (PROTOCOL_BROKEN.has(error.code)) throw broken();
    }
    console.warn(`[ppt-doctor] 联动标记与主程序哈希不一致（主程序 v${exeVersion}，标记 v${markerVersion || '?'}），实测 status 协议兼容，按单次调用继续`);
    this.mismatchOk = { key, marker: safe };
    return safe;
  }
  async callOnce(exe, action, request, options) {
    if (this.closed) throw failure('DOCTOR_CLOSED', 'PPT Doctor 调用已关闭');
    const root = path.join(options.workRoot || require('./ppt-work-dir').workDir(this.a, { writable: true }), 'ppt-doctor', 'requests');
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
        try { child = (this.deps.pptDoctorSpawn || spawn)(exe, args, { windowsHide: true, shell: false, cwd: options.workRoot && options.workRoot !== this.a.dir ? options.workRoot : undefined, env: this.runtimeEnv(options.workRoot || this.a.dir), stdio: 'ignore' }); }
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
