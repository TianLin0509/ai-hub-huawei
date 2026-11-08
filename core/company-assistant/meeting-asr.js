'use strict';
// 会议本地转写（2026-11-07 改）：识别引擎换成 SenseVoice（sherpa-onnx，CPU），整套运行环境打成分片离线包放在自家两台下载服务器上。
// 原因：旧安装要现场 pip、连 Hugging Face 和 python.org，公司代理下装不上；旧引擎 Whisper-small 在 2 个 CPU 线程上比实时还慢
// （90 秒录音要 134 秒，带噪声要 299 秒），长会议转写会越积越多。新引擎同一段 7 秒，中文噪声下错字率 32% → 9%（静音处切段后）。
// 每个分片 16 MB 单独核 SHA-256，下好的不再下：公司代理下老服务器约 170 KB/s，断一次不用从头来。期望值随程序发布（meeting-speech-pack.json），
// 服务器上的文件被换掉也装不进去。已经装好旧引擎（Whisper）的机器在新包装好前继续用旧的。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const readline = require('node:readline');
const { downloadWithFallback, fmtBytes } = require('../app-update/downloader');
const { resolveFetch } = require('./fetch-util');

const PACK = require('./meeting-speech-pack.json');
const SOURCES = Object.freeze([
  { id: 'aliyun-fast', name: '高速下载服务器', files: 'https://dl.lt-stockpartner.tech/hub-update/meeting-speech/{version}/' },
  { id: 'aliyun', name: '阿里云', files: 'https://me.lt-stockpartner.tech/hub-update/meeting-speech/{version}/' },
]);
const WORKER = path.join(__dirname, '../../scripts/meeting-speech-worker.py');
const LEGACY_WORKER = path.join(__dirname, '../../scripts/meeting-asr-worker.py');
const READY_TIMEOUT_MS = 120000;

const sha256File = file => new Promise((resolve, reject) => {
  const h = createHash('sha256'); fs.createReadStream(file).on('error', reject).on('data', b => h.update(b)).on('end', () => resolve(h.digest('hex')));
});
const minutes = sec => sec == null ? '' : sec < 90 ? `约 ${Math.max(1, Math.round(sec))} 秒` : `约 ${Math.round(sec / 60)} 分钟`;

class MeetingAsr {
  constructor(root, { pack = PACK, sources = SOURCES, fetchImpl, spawnImpl = spawn, worker = WORKER, threads = 2 } = {}) {
    Object.assign(this, { root, pack, sources, fetchImpl, spawnImpl, worker, threads });
    this.phase = ''; this.error = ''; this.blocked = false; this.child = null; this.pending = new Map(); this.seq = 0;
  }
  get home() { return path.join(this.root, 'sv', this.pack.version); }
  get readyFile() { return path.join(this.home, 'ready.json'); }
  get downloads() { return path.join(this.root, 'download', this.pack.version); }
  get total() { return this.pack.files.reduce((n, f) => n + f.size, 0); }
  // 旧引擎：Hub 5.5.31 及以前用 pip 装的 Whisper。新包没装好前继续能用。
  get legacyPython() { const portable = path.join(this.root, 'python', 'python.exe'); return fs.existsSync(path.join(this.root, 'portable-ready')) ? portable : path.join(this.root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  engine() { return fs.existsSync(this.readyFile) ? 'sensevoice' : fs.existsSync(path.join(this.root, 'ready.json')) ? 'whisper' : ''; }
  status() {
    const engine = this.engine();
    return { ready: !!engine, engine, phase: this.phase, error: this.error, blocked: this.blocked, sizeText: fmtBytes(this.total),
      upgrade: engine === 'whisper', voiceprint: engine === 'sensevoice' && fs.existsSync(path.join(this.home, 'model', 'voiceprint.onnx')) };
  }
  // 新包装好之前，旧引擎照常可用；install() 总是装新包（「重新安装」也走这里）。
  install() {
    if (this.installing) return this.status();
    if (this.engine() === 'sensevoice') return this.status();
    this.closed = false; this.error = ''; this.blocked = false; this.phase = '准备下载本地转写组件';
    this.installing = this.installPack()
      .then(() => { this.phase = ''; })
      .catch(e => { this.phase = ''; this.error = e.blocked ? '下载被公司网络拦下了：先点下面「放行下载服务器」，放行后再点「重新安装」。' : '安装未完成，可重试：' + e.message; this.blocked = !!e.blocked; })
      .finally(() => { this.installing = null; });
    return this.status();
  }
  async partReady(file, part) {
    try { if (fs.statSync(file).size !== part.size) return false; } catch { return false; }
    return await sha256File(file) === part.sha256;
  }
  async installPack() {
    fs.mkdirSync(this.downloads, { recursive: true });
    const doFetch = resolveFetch(this.fetchImpl), parts = this.pack.files.flatMap(f => f.parts), total = this.total;
    // 剩余时间按这次安装的平均速度估：单片的瞬时速度在代理下忽高忽低，估出来在 9 到 48 分钟间乱跳。
    let done = 0, fetched = 0; const started = Date.now();
    for (const part of parts) {
      const file = path.join(this.downloads, part.file);
      if (!await this.partReady(file, part)) {
        if (this.closed) throw new Error('Hub 已关闭，安装已中断');
        this.abort = new AbortController();
        const result = await downloadWithFallback({ sources: this.sources, version: this.pack.version, dest: file, fetchImpl: doFetch, signal: this.abort.signal,
          expect: { file: part.file, bytes: part.size, sha256: part.sha256 },
          onProgress: p => { const got = done + p.received, rate = (fetched + p.received) / Math.max(1, (Date.now() - started) / 1000); this.phase = `下载本地转写组件 ${fmtBytes(got)} / ${fmtBytes(total)}${fetched + p.received > 2 * 1024 * 1024 ? ' · 还要' + minutes((total - got) / rate) : ''} · ${p.sourceName}`; } });
        fetched += part.size;
        if (!result.ok) {
          const blocked = result.attempts.some(a => a.blocked);
          throw Object.assign(new Error(result.attempts.map(a => `${a.name}：${a.reason || '失败'}`).join('；') || '下载失败'), { blocked });
        }
      }
      done += part.size;
    }
    this.phase = '校验并解压组件';
    const stage = this.home + '.staging';
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(path.join(stage, 'model'), { recursive: true });
    for (const f of this.pack.files) {
      const out = path.join(stage, f.extract ? f.name : path.join('model', f.name));
      const fd = fs.openSync(out, 'w');
      try { for (const p of f.parts) fs.writeSync(fd, fs.readFileSync(path.join(this.downloads, p.file))); } finally { fs.closeSync(fd); }
      if (await sha256File(out) !== f.sha256) throw new Error(`${f.name} 拼合后校验不一致，请重试`);
      if (f.extract) { await this.unzip(out, path.join(stage, f.extract)); fs.rmSync(out, { force: true }); }
    }
    this.phase = '试运行本地识别';
    await this.smoke(stage);
    fs.rmSync(this.home, { recursive: true, force: true }); fs.renameSync(stage, this.home);
    fs.writeFileSync(this.readyFile, JSON.stringify({ version: this.pack.version, engine: this.pack.engine, at: Date.now() }));
    fs.rmSync(path.join(this.root, 'download'), { recursive: true, force: true });
  }
  run(exe, args) {
    return new Promise((resolve, reject) => {
      const p = this.spawnImpl(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.installChild = p; let tail = '';
      for (const s of [p.stdout, p.stderr]) s?.on('data', b => { tail = (tail + b.toString()).slice(-1500); });
      p.on('error', reject); p.on('close', code => { this.installChild = null; code === 0 ? resolve() : reject(new Error(tail.trim() || `退出码 ${code}`)); });
    });
  }
  // Windows 10 1803 起自带 tar.exe；没有时用 PowerShell 解压。
  async unzip(zip, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { await this.run(tar, ['-x', '-f', zip, '-C', dir]); return; } catch (e) { if (process.platform !== 'win32') throw e; }
    const q = p => "'" + p.replace(/'/g, "''") + "'";
    const cmd = `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`;
    await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')]);
  }
  smoke(home) {
    return new Promise((resolve, reject) => {
      const p = this.spawnWorker(home); let tail = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('识别组件启动超时')); }, READY_TIMEOUT_MS);
      p.stderr?.on('data', b => { tail = (tail + b.toString()).slice(-800); });
      readline.createInterface({ input: p.stdout }).on('line', line => { try { if (JSON.parse(line).event === 'ready') { clearTimeout(timer); resolve(); p.kill(); } } catch {} });
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('exit', code => { clearTimeout(timer); reject(new Error(`识别组件没能启动（${code}）：${tail.trim().split('\n').slice(-2).join(' ')}`)); });
    });
  }
  // 脚本在 app.asar 里，Python 读不到，先拷进组件目录。
  spawnWorker(home = this.home) {
    const script = path.join(home, 'worker.py'); fs.writeFileSync(script, fs.readFileSync(this.worker));
    return this.spawnImpl(path.join(home, 'python', 'python.exe'), ['-u', '-I', script, path.join(home, 'model')],
      { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', MEETING_ASR_THREADS: String(this.threads), OMP_NUM_THREADS: String(this.threads) }, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  ensureWorker() {
    if (this.child) return;
    const engine = this.engine();
    if (!engine) throw new Error('本地语音组件尚未准备好；音频已保存，安装后可补转写');
    let p;
    if (engine === 'sensevoice') p = this.spawnWorker();
    else {
      const script = path.join(this.root, 'worker.py'); fs.copyFileSync(LEGACY_WORKER, script);
      p = this.spawnImpl(this.legacyPython, ['-u', script, path.join(this.root, 'model')], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '2' }, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    this.child = p; this.childEngine = engine;
    const rejectAll = e => { if (this.child === p) this.child = null; for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(e); } this.pending.clear(); };
    p.on('error', rejectAll); p.on('exit', () => rejectAll(new Error('本地识别进程已停止，音频保留，可重试')));
    p.stderr.on('data', b => { this.workerLog = ((this.workerLog || '') + b.toString()).slice(-2000); });
    readline.createInterface({ input: p.stdout }).on('line', line => {
      let r; try { r = JSON.parse(line); } catch { return; }
      const q = this.pending.get(r.id); if (!q) return;
      this.pending.delete(r.id); clearTimeout(q.timer); r.error ? q.reject(new Error(r.error)) : q.resolve(r.segments);
    });
  }
  // 新包装好后，正在跑的旧引擎进程在下一段时换掉。
  transcribe(file, { voiceprint = false } = {}) {
    if (this.child && this.childEngine !== this.engine()) { this.child.kill(); this.child = null; }
    this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = ++this.seq, timer = setTimeout(() => { this.child?.kill(); }, 10 * 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, file, voiceprint }) + '\n');
    });
  }
  close() { this.closed = true; this.abort?.abort(); if (this.child) this.child.kill(); this.child = null; if (this.installChild) this.installChild.kill(); }
}
module.exports = { MeetingAsr, SOURCES, PACK };
