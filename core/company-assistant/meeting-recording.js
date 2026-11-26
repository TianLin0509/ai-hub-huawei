'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { fixWebmDuration } = require('./meeting-webm-duration');
const { fixMp4Index } = require('./meeting-mp4-index');
const { cleanup } = require('./meeting-media-io');
const LOW_DISK_BYTES = 3 * 1024 ** 3;
const SYNC_MS = 10000;
const syncFile = async file => { const h = await fs.promises.open(file, 'r+'); try { await h.sync(); } finally { await h.close(); } }; // 出错如实抛出，由调用方记录并重试
const keyOK = key => /^[a-f0-9-]{36}$/.test(String(key));
const hash = b => createHash('sha256').update(b).digest('hex');
// 能回放的分段：正常结束的，或续录中途中断但已有内容的（R51）。
const playable = s => !!s && s.bytes > 0 && (s.status === 'ready' || (s.status === 'interrupted' && isMp4(s)));
const isMp4 = s => /^video\/mp4/.test(s.mime || '');
// 续录片段（2026-11-27 R51「继续录制」）按编码取扩展名；更早的分段一律是 .webm，照旧认。
const fileName = s => s.full ? `recording-full.${isMp4(s) ? 'mp4' : 'webm'}` : `recording-${s.key}.${isMp4(s) ? 'mp4' : 'webm'}`;
const nameOK = s => s.file === fileName(s) || (!s.full && s.file === `recording-${s.key}.webm`);
// First bytes a container must start with; MP4 has a 4-byte box size first, then "ftyp".
function headerOK(segment, offset, bytes) {
  const [at, magic] = isMp4(segment) ? [4, Buffer.from('ftyp')] : [0, Buffer.from([0x1a, 0x45, 0xdf, 0xa3])];
  for (let i = Math.max(at, offset); i < Math.min(at + magic.length, offset + bytes.length); i++) if (bytes[i - offset] !== magic[i - at]) return false;
  return true;
}
class MeetingRecording {
  constructor(meetings) {
    this.m = meetings; this.repairs = new Map(); this.errors = new Map(); this.attempted = new Set();
    this.retryTimers = new Map(); this.failures = new Map(); this.retryDelays = [30000, 120000, 600000]; this.startedAt = Date.now();
    this.syncs = new Map(); this.syncedAt = new Map();
  }
  // 录像块落盘（2026-11-24 主进程性能）：原来每块都在主线程 fsyncSync，录像越大、杀毒扫描时越卡事件循环。
  // 现在块照常同步追加（写进系统缓存，进程崩溃不丢），同步到磁盘改成后台线程做、同一文件最多每 SYNC_MS 一次，最后一块之后也会补一次；
  // 只有整机断电时可能丢最近约 10 秒录像。
  // syncs：文件 → { id, timer, inflight 在途同步, again 期间又有新块, failures, error }。同步成功且没有新块才移除；上次同步时间单独记在 syncedAt，限频不因移除而失效。
  syncLater(file, id) {
    const s = this.syncs.get(file) || { id, timer: null, inflight: null, again: false, failures: 0, error: '' }; this.syncs.set(file, s);
    if (s.timer || s.inflight) { s.again = true; return; }
    const backoff = s.failures ? Math.min(60000, 1000 * 2 ** (s.failures - 1)) : 0;
    const wait = Math.max(backoff, (this.syncedAt.get(file) || 0) + SYNC_MS - Date.now(), 0);
    s.timer = setTimeout(() => { s.timer = null; void this.runSync(file, s).catch(() => {}); }, wait); s.timer.unref?.();
  }
  // 做一次同步（后台低频和 drain 共用同一个在途 Promise）。失败：记进状态、按退避再试；成功：清掉自己记下的错误。
  runSync(file, s) {
    if (s.inflight) return s.inflight;
    s.again = false; this.syncedAt.set(file, Date.now());
    s.inflight = syncFile(file).then(() => {
      s.failures = 0;
      if (s.error && this.errors.get(s.id) === s.error) this.errors.delete(s.id);
      s.error = '';
    }, err => {
      s.failures++; s.error = `录像同步到磁盘失败（第 ${s.failures} 次：${err.message}），录像仍在写，稍后自动重试`;
      if (!this.errors.has(s.id) || /^录像同步到磁盘失败/.test(this.errors.get(s.id))) this.errors.set(s.id, s.error);
      s.again = true; throw err;
    }).finally(() => {
      s.inflight = null;
      if (s.draining) return; // drain 期间记录由 drain 收尾时统一处理（复核 #144）
      if (s.again) this.syncLater(file, s.id); else if (!s.timer && this.syncs.get(file) === s) this.syncs.delete(file);
    });
    return s.inflight;
  }
  // 退出时：还排着或在途的同步就地同步做完（一次性，退出路径上可以接受）。失败的如实返回 [{ id, file, error }]、记日志，
  // 由会议存储写进这场会议（recording.syncError），下次启动恢复时再同步一次并提示（复核 #144）。
  syncAllNow() {
    const failed = [];
    for (const [file, s] of [...this.syncs]) {
      clearTimeout(s.timer); s.timer = null; s.again = false;
      try { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } this.syncs.delete(file); }
      catch (e) {
        if (e.code === 'ENOENT') { this.syncs.delete(file); continue; } // 文件已删
        failed.push({ id: s.id, file, error: e.message }); console.warn('[meeting] 退出时录像没能同步到磁盘：' + file + '：' + e.message);
      }
    }
    return failed;
  }
  // 分段结束：就地同步一次。成功且没有在途同步就移除记录；失败或有在途的留给 drain 处理（它会等在途那次并如实报错）。
  syncNow(file) {
    const s = this.syncs.get(file); if (!s) return;
    clearTimeout(s.timer); s.timer = null; s.again = false;
    try { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } this.syncedAt.set(file, Date.now()); if (!s.inflight && !s.draining) this.syncs.delete(file); }
    catch { this.syncLater(file, s.id); } // 失败：按原逻辑排后台重试，drain 会如实报错
  }
  // 启动恢复：上次退出时没同步成功的录像，再同步一次；仍失败就在状态里提示。返回是否已解决。
  recoverSync(m) {
    const bad = m.recording?.syncError; if (!bad) return true;
    try {
      for (const s of [m.recording.full, ...(m.recording.segments || [])].filter(x => x?.file && x.status !== 'empty')) {
        const fd = fs.openSync(this.file(m.id, s), 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      delete m.recording.syncError; return true;
    } catch (e) { this.errors.set(m.id, `上次退出时录像没能同步到磁盘（${bad.error}），这次启动再试仍失败：${e.message}。录像文件仍在，整机断电前请先保存一份。`); return false; }
  }
  // 等这场会议的录像都同步到磁盘（补索引、暂停、结束、删除、退出前调用）。块写入本身是同步追加的，没有写队列：
  // 取消排着的低频同步，等在途的那次结束，再对每个文件 open→sync→close 一次；全程记录不移除，并发的 drain 共用同一个在途同步。
  // 任一文件同步失败就 reject（调用方：删除时提示、补索引时不补），失败的记录留着按退避重试。
  async drain(id) {
    const files = [...this.syncs].filter(([, s]) => s.id === id).map(([f]) => f); // 按记录里的会议编号筛：目录改选后原目录的待同步录像也算（复核 #144）
    const results = await Promise.allSettled(files.map(file => {
      const s = this.syncs.get(file); if (!s) return null;
      if (!s.draining) s.draining = (async () => {
        clearTimeout(s.timer); s.timer = null;
        if (s.inflight) await s.inflight.catch(() => {});
        s.again = false; await this.runSync(file, s);
      })().finally(() => {
        s.draining = null; // 最终 sync→close 收尾后统一处理记录：成功且期间没有新块才移除，否则按原逻辑排下一次
        if (s.again) this.syncLater(file, s.id); else if (!s.timer && !s.inflight && this.syncs.get(file) === s) this.syncs.delete(file);
      });
      return s.draining;
    }));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) { // 保留原错误码（EIO 等）：补索引链按它判断瞬时失败、安排重试（复核 #182）
      const cause = failed.reason, err = new Error('录像还没同步到磁盘：' + (cause?.message || cause), { cause });
      if (cause?.code) err.code = cause.code; throw err;
    }
  }
  // 只读看会议：会议存储有内存正本时直接看（不复制不读盘），老接线或测试夹具只有 load 时退回 load。
  view(id) { return typeof this.m.peek === 'function' ? this.m.peek(id) : this.m.load(id); }
  state(m) { return m.recording ||= { segments: [], gaps: [], bytes: 0, savedThrough: 0 }; }
  file(id, segment) {
    if (!keyOK(segment.key) || !nameOK(segment)) throw new Error('录制文件无效');
    return path.join(this.m.dir(id), segment.file);
  }
  accept(m, r) {
    const rec = this.state(m), at = this.m.time(r.at);
    if (r.kind === 'recording-gap-open') { rec.openGap = { at, reason: String(r.reason || '暂停').slice(0,250) }; return; }
    if (r.kind === 'recording-gap') {
      const end = this.m.time(r.end); if (end < at) throw new Error('缺口时间无效');
      rec.gaps.push({ at, end, reason: String(r.reason || '暂停').slice(0, 250) }); delete rec.openGap; return;
    }
    if (!keyOK(r.key)) throw new Error('录制分段编号无效');
    let segment = rec.full?.key === r.key ? rec.full : rec.segments.find(s => s.key === r.key);
    if (r.kind === 'recording-start') {
      if (segment) return;
      if (!/^video\/webm(?:;codecs=(?:vp8|vp9)(?:,opus)?)?$|^video\/mp4;codecs=avc1\.[0-9a-fA-F]{6},mp4a\.40\.2$/.test(r.mime)) throw new Error('录制编码不支持');
      if (r.full && rec.full) throw new Error('本场会议已有完整录像');
      segment = { key: r.key, full: !!r.full, at, end: at, mime: r.mime, bytes: 0, status: 'writing', width: r.width, height: r.height }; segment.file = fileName(segment);
      const file = this.file(m.id, segment);
      if (fs.existsSync(file)) { if (fs.statSync(file).size !== 0) throw new Error('录制分段已有未登记内容'); }
      else fs.writeFileSync(file, Buffer.alloc(0), { flag: 'wx' }); if (r.full) rec.full = segment; else rec.segments.push(segment); return;
    }
    if (!segment) throw new Error('录制分段尚未开始');
    if (r.kind === 'recording-chunk') {
      const bytes = Buffer.from(String(r.data || ''), 'base64');
      if (!bytes.length || bytes.length > 32 * 1024 * 1024 || !Number.isSafeInteger(r.offset) || r.offset < 0) throw new Error('录制数据无效');
      const file = this.file(m.id, segment), size = fs.statSync(file).size;
      if (size >= r.offset && size < r.offset + bytes.length) {
        if (segment.status !== 'writing') throw new Error('录制分段已结束');
        // MediaRecorder may split the 4-byte EBML magic across its first blobs (seen: a 1-byte first chunk).
        if (!headerOK(segment, r.offset, bytes)) throw new Error('缺少视频文件头');
        const written = size - r.offset;
        if (written) {
          const fd=fs.openSync(file,'r'),prefix=Buffer.alloc(written);try{fs.readSync(fd,prefix,0,written,r.offset);}finally{fs.closeSync(fd);}
          if(!prefix.equals(bytes.subarray(0,written)))throw new Error('录制部分写入内容不一致');
        }
        const fd = fs.openSync(file, 'a'); try { fs.writeFileSync(fd, bytes.subarray(written)); } finally { fs.closeSync(fd); }
        this.syncLater(file, m.id);
      } else if (size >= r.offset + bytes.length) {
        // A save acknowledgement can be lost after durable append. Retry must not duplicate bytes.
        const fd = fs.openSync(file, 'r'), old = Buffer.alloc(bytes.length);
        try { fs.readSync(fd, old, 0, old.length, r.offset); } finally { fs.closeSync(fd); }
        if (hash(old) !== hash(bytes)) throw new Error('录制重试数据不一致');
      } else throw new Error('录制数据顺序不连续');
      segment.bytes = fs.statSync(file).size; segment.end = Math.max(segment.end, at);
      if (segment.full && r.durationMs != null) segment.durationMs = this.m.time(r.durationMs);
      rec.bytes = rec.segments.reduce((n, s) => n + s.bytes, rec.full?.bytes || 0);
      rec.savedThrough = Math.max(rec.savedThrough, at); return;
    }
    if (r.kind === 'recording-finish') {
      if (at < segment.at) throw new Error('录制分段未完整保存');
      this.syncNow(this.file(m.id, segment)); // 分段结束时就地同步一次（每段一次），收尾链路里的 drain 就不用再等后台线程
      if (segment.full) {
        segment.end = at; segment.durationMs = this.m.time(r.durationMs ?? segment.durationMs ?? at - segment.at);
        // accept/capture stay synchronous. The registered Promise includes drain,
        // final metadata and repair; open/save waits for that same Promise.
        this.repair(m.id, { finishKey: segment.key }); return;
      }
      if (!segment.bytes) {
        // 编码器一个字节都没吐出就结束（刚切分段、刚开始就停）：重试多少次都不会变，不能卡死结束流程。
        // 标记为 empty（不进回放列表），记一条缺口，正常结束。
        segment.end = at; segment.status = 'empty'; rec.savedThrough = Math.max(rec.savedThrough, at);
        rec.gaps.push({ at: segment.at, end: Math.max(at, segment.at), reason: segment.full ? '完整录像没有录到内容' : '该分段没有录到内容' });
        return;
      }
      segment.end = at; segment.status = 'ready'; rec.savedThrough = Math.max(rec.savedThrough, at);
      if (isMp4(segment)) this.repairSegment(m.id, segment.key);
      return;
    }
    throw new Error('录制操作无效');
  }
  recover(m) {
    const rec = this.state(m);
    if (rec.full?.status === 'writing') {
      rec.full.status = 'interrupted';
      try { rec.full.bytes = fs.statSync(this.file(m.id, rec.full)).size; }
      catch (e) { rec.full.bytes = 0; rec.full.durationError = '完整录像文件未能恢复：' + e.message; }
    }
    this.ensureRepair(m.id, rec.full);
    if(rec.openGap) { rec.gaps.push({...rec.openGap,end:Math.max(rec.openGap.at,m.capturedMs),open:true,reason:rec.openGap.reason+'后中断，缺口结束时间未知'}); delete rec.openGap; }
    // 续录片段（.mp4，R51）在续录中途又崩溃时，已写进文件的部分照样能放：记下实际字节、补索引，不整段记成缺口。
    for (const s of rec.segments) if (s.status === 'writing' && isMp4(s)) {
      s.status = 'interrupted';
      try { s.bytes = fs.statSync(this.file(m.id, s)).size; } catch { s.bytes = 0; }
      if (s.bytes > 0) { this.repairSegment(m.id, s.key); continue; }
      rec.gaps.push({ at: s.at, end: Math.max(s.end, s.at), reason: '续录片段没有录到内容' });
    }
    for (const s of rec.segments) if (s.status === 'writing') { const next = rec.segments.filter(x => x.at > s.at).sort((a,b)=>a.at-b.at)[0]; s.status = 'interrupted'; rec.gaps.push({ at: s.at, end: Math.min(Math.max(s.end, m.capturedMs), next?.at ?? Infinity), reason: '异常退出：此分段可能不完整，已写入文件保留' }); }
  }
  failure(id, full) {
    const saved = this.failures.get(id + ':' + full.key) || full.repairFailure;
    if (saved) return saved;
    if (!full.durationError || full.repairing || /索引还在补/.test(full.durationError)) return null;
    const retryable = /EPERM|EACCES|EBUSY|ENOSPC|EMFILE|ENFILE|EIO|EAGAIN|ENOENT|仍在写入|磁盘空间不足/.test(full.durationError);
    return { kind: retryable ? 'transient' : 'permanent', attempts: 1, nextAt: null };
  }
  armRetry(id, full, options = {}) {
    const failure = this.failure(id, full); if (failure?.kind !== 'transient' || failure.nextAt == null || this.retryTimers.has(id) || this.m.closed) return;
    const timer = setTimeout(() => { this.retryTimers.delete(id); if (!this.m.closed) void this.repair(id, options); }, Math.max(1, failure.nextAt - Date.now()));
    timer.unref?.(); this.retryTimers.set(id, timer);
  }
  repair(id, options = {}) {
    if (this.repairs.has(id)) return this.repairs.get(id);
    // Defer until capture/recovery has persisted the latest state; never overwrite newer events.
    const task = Promise.resolve().then(async () => {
      try {
        // m3 owns drain(): await the append/sync queue and close its descriptors.
        if (typeof this.drain === 'function') await this.drain(id);
        const initial = this.m.load(id), full = initial.recording?.full; if (!full) return;
        if (options.finishKey && full.key === options.finishKey) {
          full.bytes = fs.statSync(this.file(id, full)).size; full.status = full.bytes ? 'ready' : 'empty';
          initial.recording.savedThrough = Math.max(initial.recording.savedThrough || 0, full.end);
          if (!full.bytes) initial.recording.gaps.push({ at: full.at, end: full.end, reason: '完整录像没有录到内容' });
          this.m.save(initial);
        }
        if (!full.bytes || full.status === 'writing') return;
        if (options.finishKey && full.seekIndexVersion === 1 && full.durationFixed && !full.durationError) return;
        const failure = this.failure(id, full);
        if (failure?.kind === 'permanent') return;
        if (failure?.kind === 'transient' && !options.userRetry && (failure.nextAt == null || failure.nextAt > Date.now())) { this.armRetry(id, full, options); return; }
        clearTimeout(this.retryTimers.get(id)); this.retryTimers.delete(id);
        this.attempted.add(id + ':' + full.key);
        full.repairing = { startedAt: Date.now(), bytesTotal: full.bytes }; full.durationError = ''; delete full.repairPending; this.m.save(initial);
        await cleanup(this.file(id, full), this.startedAt);
        const file = this.file(id, full), bytes = isMp4(full) ? await fixMp4Index(file) : await fixWebmDuration(file, full.durationMs || full.end - full.at);
        const latest = this.m.load(id); if (latest.recording?.full?.key !== full.key) return;
        Object.assign(latest.recording.full, { bytes, durationFixed: true, seekIndexVersion: 1, durationError: '' });
        for (const field of ['repairing', 'repairPending', 'repairFailure']) delete latest.recording.full[field]; this.failures.delete(id + ':' + full.key);
        latest.recording.bytes = latest.recording.segments.reduce((n, s) => n + s.bytes, bytes); this.m.save(latest); this.errors.delete(id);
      }
      catch (e) {
        const latest = this.m.load(id), full = latest.recording?.full; if (!full || options.finishKey && options.finishKey !== full.key) return;
        const attempts = (this.failure(id, full)?.attempts || 0) + 1;
        const transient = ['EPERM','EACCES','EBUSY','ENOSPC','EMFILE','ENFILE','EIO','EAGAIN','ENOENT'].includes(e.code) || /仍在写入/.test(e.message);
        full.repairFailure = { kind: transient ? 'transient' : 'permanent', code: e.code || 'INVALID_MEDIA', attempts, nextAt: transient && attempts <= this.retryDelays.length ? Date.now() + this.retryDelays[attempts - 1] : null };
        this.failures.set(id + ':' + full.key, full.repairFailure);
        delete full.repairing; delete full.repairPending;
        full.durationError = e.code === 'ENOSPC' ? '磁盘空间不足，录像未补索引，原片可正常播放' : '录像已保留，补写时长和索引失败：' + e.message;
        if (transient) full.durationError += full.repairFailure.nextAt == null ? '；可点打开或保存再试。' : `；将在${Math.round(this.retryDelays[attempts - 1] / 1000)}秒后重试。`;
        this.errors.set(id, full.durationError); this.armRetry(id, full, options); this.m.save(latest);
      }
    }).catch(e => {
      // Even the error status can fail to persist on a full disk. Surface it through status polling;
      // never leave an unobserved rejection that could terminate the recording process.
      this.errors.set(id, (this.errors.get(id) || '完整录像收尾未完成') + '；状态保存失败：' + e.message);
    }).finally(() => this.repairs.delete(id));
    this.repairs.set(id, task); return task;
  }
  ensureRepair(id, full, options = {}) {
    if (full?.bytes && full.status !== 'writing' && (!full.durationFixed || full.seekIndexVersion !== 1)) {
      const failure = this.failure(id, full);
      if (!failure || failure.kind === 'transient' && options.userRetry) return this.repair(id, options);
      if (failure.kind === 'transient') this.armRetry(id, full);
    }
    return this.repairs.get(id);
  }
  async prepareFull(id, waitMs = 60000) {
    const m = this.m.load(id), full = this.state(m).full; this.ensureRepair(id, full, { userRetry: true });
    const task = this.repairs.get(id); if (!task) return this.full(id);
    let timer;
    try {
      const done = await Promise.race([task.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
      if (!done) {
        const latest = this.m.load(id); if (latest.recording?.full?.key === full?.key) { latest.recording.full.repairPending = '索引还在补，先打开原片；稍后再试可拖动。'; this.m.save(latest); }
      }
    } finally { clearTimeout(timer); }
    return this.full(id);
  }
  full(id) {
    const m = this.view(id), full = m.recording?.full;
    if (!full?.bytes || full.status === 'writing') throw new Error('完整录像仍在保存，结束会议后可打开');
    this.ensureRepair(id, full);
    return { file: this.file(id, full), url: pathToFileURL(this.file(id, full)).href, recording: full };
  }
  // Only the video goes; minutes, transcript, screenshots and audio stay, so the meeting remains readable.
  deleteVideo(id) {
    const m = this.m.load(id), rec = this.state(m);
    if (['recording', 'paused'].includes(m.state)) throw new Error('会议还没结束，不能删录像');
    if (rec.full?.status === 'writing') throw new Error('录像还在保存，稍后再删');
    if (this.repairs.has(id)) throw new Error('录像正在补索引，完成后再删');
    const files = [...(rec.full ? [rec.full] : []), ...rec.segments].filter(s => s.status !== 'empty');
    if (!files.length) throw new Error('这场会议没有录像');
    for (const s of files) fs.rmSync(this.file(id, s), { force: true });
    const freed = rec.bytes; rec.full = null; rec.segments = []; rec.bytes = 0; rec.deleted = { at: Date.now(), bytes: freed };
    this.m.save(m); return { freed };
  }
  // A warning, not a gate: a meeting that cannot be recorded in full is still worth recording.
  async diskWarning() {
    try {
      const { bavail, bsize } = await fs.promises.statfs(this.m.root), free = bavail * bsize;
      return free < LOW_DISK_BYTES ? `硬盘只剩 ${(free / 1024 ** 3).toFixed(1)} GB，录一小时大约要 0.5 GB。可在「更多」里删掉旧录像。` : '';
    } catch { return ''; }
  }
  exportName(id) {
    const m = this.view(id), d = new Date(m.startedAt), pad = n => String(n).padStart(2, '0');
    const title = String(m.title || '会议').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '会议';
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${title}${path.extname(m.recording.full.file)}`;
  }
  // 续录片段收尾后补 MP4 索引（和整场录像同一套，补了才能拖动进度条）。补不成只记一条提示，原片照常可播。
  repairSegment(id, key) {
    const task = Promise.resolve().then(async () => {
      if (typeof this.drain === 'function') await this.drain(id);
      const s = this.m.load(id).recording?.segments?.find(x => x.key === key); if (!s || !playable(s) || s.durationFixed) return;
      const bytes = await fixMp4Index(this.file(id, s));
      const latest = this.m.load(id), seg = latest.recording?.segments?.find(x => x.key === key); if (!seg) return;
      Object.assign(seg, { bytes, durationFixed: true });
      latest.recording.bytes = latest.recording.segments.reduce((n, x) => n + x.bytes, latest.recording.full?.bytes || 0); this.m.save(latest);
    }).catch(e => { this.errors.set(id, '续录片段已保存，补写索引失败（原片可播放，拖动可能不准）：' + e.message); });
    (this.segmentRepairs ||= new Map()).set(id + ':' + key, task); void task.finally(() => this.segmentRepairs.delete(id + ':' + key));
    return task;
  }
  // 只读：录像索引直接看会议正本（不复制、不读盘），调用方不改它。
  index(id) {
    const m = this.m.load(id), rec = this.state(m);
    this.ensureRepair(id, rec.full);
    return { title: m.title, durationMs: m.capturedMs, recording: rec, note: '暂停和异常缺口见gaps。录像只供人回看，不提供给模型。' };
  }
  spans(full, gaps) {
    const spans = [{ at: full.at, mediaAt: 0 }]; let skipped = 0;
    for (const g of [...gaps].filter(g => !g.open && g.end > g.at && g.at >= full.at).sort((a, b) => a.at - b.at)) { skipped += g.end - g.at; spans.push({ at: g.end, mediaAt: g.end - full.at - skipped }); }
    return spans;
  }
  locate(id, at) {
    at = this.m.time(at); const m = this.view(id), rec = m.recording || { segments: [], gaps: [], bytes: 0, savedThrough: 0 };
    if (rec.openGap && at >= rec.openGap.at || rec.gaps.some(g=>at>=g.at&&(g.open||at<g.end))) throw new Error('此时间位于暂停或中断缺口，没有完整录像');
    const full = rec.full;
    // 续录片段：时间落在整场录像结束之后、又有片段覆盖时，放续录片段（整场录像只录到中断那一刻）。
    const seg = rec.segments.filter(s => playable(s) && s.at <= at && s.end > at).sort((a,b) => b.at - a.at)[0];
    if (seg && (!full || at >= (full.end || 0))) return { segment: seg, url: pathToFileURL(this.file(id, seg)).href, offsetMs: at - seg.at };
    // 整场录像中断过（或后面接了续录）时只录到 full.end，之后的时间不能拿整场录像去放。
    const capped = full && (full.status === 'interrupted' || rec.segments.length > 0) && at > (full.end || 0);
    if (full?.bytes && full.status !== 'writing' && !capped) {
      this.ensureRepair(id, full);
      // Pausing leaves no gap in the video, so meeting time and video time drift apart at every pause.
      const spans = this.spans(full, rec.gaps), span = [...spans].reverse().find(x => x.at <= at) || spans[0];
      return { segment: full, spans, url: pathToFileURL(this.file(id, full)).href, offsetMs: span.mediaAt + Math.max(0, at - span.at) };
    }
    if (full?.status === 'writing') throw new Error('录像还在保存，结束会议后可回放');
    const s = rec.segments.filter(s => playable(s) && s.at <= at && s.end > at).sort((a,b) => b.at - a.at)[0];
    if (!s) throw new Error('此时间没有已完成的录制片段：可能正在保存、曾暂停或录制中断');
    return { segment: s, url: pathToFileURL(this.file(id, s)).href, offsetMs: at - s.at };
  }
}
module.exports = { MeetingRecording };
