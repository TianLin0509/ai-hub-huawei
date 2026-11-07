'use strict';
// One recorder writes the one video people watch. Time-slice blobs are appended to it, never kept as separate videos.
// MP4 first: it opens in ordinary players. WebM stays as the fallback for machines whose encoder refuses MP4.
const MIMES = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'];
class MeetingRecorder {
  constructor({ window, streams, elapsed, save, onError, waitMs = 10000 }) {
    Object.assign(this, { w: window, streams, elapsed, save, onError, waitMs }); this.active = new Set(); this.mimes = []; this.queue = []; this.pending = Promise.resolve(); this.error = ''; this.running = false;
  }
  async wait(promise, message, progressAt) {
    let timer;
    const startedAt = performance.now();
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        const check = () => {
          const remaining = this.waitMs - (performance.now() - Math.max(startedAt, progressAt?.() || 0));
          if (remaining > 0) { timer = setTimeout(check, remaining); return; }
          this.lifecycleError = message;
          reject(Object.assign(new Error(message), { code: 'MEETING_RECORDING_TIMEOUT' }));
        };
        timer = setTimeout(check, this.waitMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  progressAt(stage) { return Math.max(stage?.at || 0, stage?.phase === 'saving' ? this.lastSavedAt || 0 : 0); }
  async open() {
    const MR = this.w.MediaRecorder;
    this.mimes = MIMES.filter(x => MR?.isTypeSupported(x)); this.mime = this.mimes[0];
    if (!this.mime) throw new Error('本机不支持会议视频编码，无法开始连续录制');
    const tracks = this.streams[0].getVideoTracks();
    this.ctx = new this.w.AudioContext(); this.destination = this.ctx.createMediaStreamDestination(); this.sources = [];
    for (const stream of this.streams) if (stream.getAudioTracks().length) {
      const source = this.ctx.createMediaStreamSource(stream), gain = this.ctx.createGain(); gain.gain.value = this.streams.filter(s => s.getAudioTracks().length).length > 1 ? 0.5 : 1;
      source.connect(gain); gain.connect(this.destination); this.sources.push({ source, gain });
    }
    this.stream = new this.w.MediaStream([...tracks, ...(this.sources.length ? this.destination.stream.getAudioTracks() : [])]);
    await this.ctx.resume();
  }
  push(item) { this.queue.push(item); if (this.queue.length > 45) this.fail(new Error('录屏保存积压，已暂停；请重试保存')); void this.drain(); }
  fail(e) { if (!this.error) { this.error = e.message; this.running = false; this.onError(e.message); } }
  drain() {
    if (this.saving) return this.saveTask;
    if (this.error) return Promise.resolve();
    this.saving = true;
    this.saveTask = Promise.resolve().then(async () => {
      try { while (this.queue.length) { await this.save(this.queue[0]); this.queue.shift(); this.lastSavedAt = performance.now(); } }
      catch (e) { this.fail(e); } finally { this.saving = false; }
    });
    return this.saveTask;
  }
  // recording-start is sent with the first bytes, so an encoder that fails before producing any can
  // still fall back to the next format without leaving a file of the wrong type behind.
  // MP4 only reaches disk at key frames. Without a short interval a still slide stays in memory until stop,
  // so a crash would lose it; 2 s keeps the possible loss near 2 s (measured on a still window).
  part() {
    const recorder = new this.w.MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000, videoKeyFrameIntervalDuration: 2000 });
    const key = this.w.crypto.randomUUID(), at = this.elapsed(), mime = this.mime; let offset = 0, finish, announced = false;
    const settings = this.stream.getVideoTracks()[0].getSettings();
    const part = { recorder, full: true, key, mediaMs: 0, resumedAt: at, done: new Promise(r => { finish = r; }) }; this.active.add(part);
    const duration = () => part.mediaMs + (part.resumedAt == null ? 0 : Math.max(0, this.elapsed() - part.resumedAt));
    const announce = () => { if (!announced) { announced = true; this.push({ kind: 'recording-start', key, full: true, at, mime, width: settings.width, height: settings.height }); } };
    recorder.ondataavailable = event => {
      if (part.abandoned) return;
      const end = this.elapsed();
      const durationMs = duration();
      if (event.data.size) part.hasData = true;
      this.pending = this.pending.then(async () => { if (event.data.size) { const b = Buffer.from(await event.data.arrayBuffer()); announce(); this.push({ kind: 'recording-chunk', key, at: end, durationMs, offset, data: b.toString('base64') }); offset += b.length; } }).catch(e => this.fail(e));
    };
    recorder.onerror = e => {
      if (!part.hasData && this.fallback(part)) return;
      this.fail(new Error(e.error?.message || '视频编码失败'));
    };
    recorder.onstop = () => {
      if (part.finished) return;
      part.finished = true;
      const end = this.elapsed(), durationMs = duration(); this.active.delete(part);
      if (!part.abandoned) this.pending = this.pending.then(() => { announce(); this.push({ kind: 'recording-finish', key, at: end, durationMs }); });
      part.paused?.(); finish();
    };
    try { recorder.start(1000); } catch(e) { this.active.delete(part); part.finished = true; finish(); throw e; } return part;
  }
  fallback(part) {
    const next = this.mimes[this.mimes.indexOf(this.mime) + 1];
    if (!next || this.full !== part) return false;
    part.abandoned = true; part.paused?.();
    try { if (part.recorder.state !== 'inactive') part.recorder.stop(); } catch {}
    this.mime = next;
    try { this.full = this.firstPart(); } catch (e) { this.fail(e); }
    return true;
  }
  firstPart() {
    for (;;) {
      try { return this.part(); }
      catch (e) { const next = this.mimes[this.mimes.indexOf(this.mime) + 1]; if (!next) throw e; this.mime = next; }
    }
  }
  assertCanStart() {
    if (this.full?.recorder.state === 'inactive') throw new Error('录像已中断，已录的内容都在。请点「结束会议」，再新开一场。');
    if (this.closing) throw new Error('结束会议还没完成，请再点一次「结束会议」。这场不能再继续录了。');
    if (this.error || this.lifecycleError || this.pauseTask) throw new Error(this.error || this.lifecycleError || '暂停没能完成，录制已停下，已录的内容都在。请点「结束会议」。');
  }
  start() {
    this.assertCanStart();
    if (this.running) return;
    if (this.error) throw new Error(this.error); this.running = true;
    try {
      if (!this.full) this.full = this.firstPart();
      else if (this.full.recorder.state === 'paused') { this.full.pauseDone = null; this.full.resumedAt = this.elapsed(); this.full.recorder.resume(); }
    } catch(e) { this.fail(e); throw e; }
  }
  async pauseRecording(stage) {
    this.running = false;
    const full = this.full;
    if (full?.recorder.state === 'recording') {
      full.mediaMs += Math.max(0, this.elapsed() - full.resumedAt); full.resumedAt = null;
      full.pauseDone = new Promise(resolve => { full.paused = resolve; full.recorder.onpause = resolve; });
      full.recorder.requestData(); full.recorder.pause();
    }
    await full?.pauseDone;
    Object.assign(stage, { phase: 'pending', at: performance.now() }); await this.pending;
    Object.assign(stage, { phase: 'saving', at: performance.now() }); await this.flush();
  }
  async pause() {
    if (!this.pauseTask) {
      this.pauseStage = { phase: 'native', at: performance.now() };
      const task = this.pauseRecording(this.pauseStage); this.pauseTask = task;
      const clear = () => { if (this.pauseTask === task) this.pauseTask = null; };
      task.then(clear, clear);
    }
    const stage = this.pauseStage;
    await this.wait(this.pauseTask, '已停止录制，但暂停没能完成，已录的内容都在。请点「结束会议」。', () => this.progressAt(stage));
    this.lifecycleError = '';
  }
  async flush() { await this.drain(); if (this.queue.length || this.error) throw new Error(this.error || '视频尚未保存'); }
  async retry() {
    this.error = '';
    const message = '录像还没存完，已录的内容都在。请稍后点「重试保存」，先别关 Hub。';
    const pauseStage = this.pauseStage, closeStage = this.closeStage;
    await this.wait(this.pauseTask?.catch(() => {}), message, () => this.progressAt(pauseStage));
    await this.wait(this.closeTask?.catch(() => {}), message, () => this.progressAt(closeStage));
    await this.wait(this.pending, message);
    await this.wait(this.flush(), message, () => this.lastSavedAt);
    this.lifecycleError = '';
  }
  async finishRecording(stage) {
    let stopError;
    for (const p of this.active) if (p.recorder.state !== 'inactive') {
      try { p.recorder.stop(); } catch (error) { stopError ||= error; }
    }
    if (stopError) throw stopError;
    await Promise.all([...this.active].map(p => p.done));
    Object.assign(stage, { phase: 'pending', at: performance.now() }); await this.pending;
    Object.assign(stage, { phase: 'saving', at: performance.now() }); await this.flush();
  }
  async close() {
    this.running = false; this.closing = true;
    if (!this.closeTask) {
      this.closeStage = { phase: 'native', at: performance.now() };
      const task = this.finishRecording(this.closeStage); this.closeTask = task;
      const clear = () => { if (this.closeTask === task) this.closeTask = null; };
      task.then(clear, clear);
    }
    let error;
    const stage = this.closeStage;
    try { await this.wait(this.closeTask, '录像还没收尾，已录的内容都在。请再点一次「结束会议」，先别关 Hub。', () => this.progressAt(stage)); this.lifecycleError = ''; }
    catch (e) { error = e; }
    finally {
      this.detachedNodes ||= new WeakSet();
      for (const n of this.sources || []) for (const node of [n.source, n.gain]) {
        if (this.detachedNodes.has(node)) continue;
        try { node.disconnect(); this.detachedNodes.add(node); } catch (e) { error ||= e; }
      }
      this.sources = (this.sources || []).filter(n => !this.detachedNodes.has(n.source) || !this.detachedNodes.has(n.gain));
      this.stoppedTracks ||= new WeakSet();
      for (const track of this.destination?.stream.getTracks() || []) {
        if (this.stoppedTracks.has(track)) continue;
        try { track.stop(); this.stoppedTracks.add(track); } catch (e) { error ||= e; }
      }
      if (this.ctx && this.ctx.state !== 'closed') {
        try {
          this.contextClosing ||= Promise.resolve().then(() => this.ctx.close()).catch(e => { this.contextClosing = null; throw e; });
          await this.wait(this.contextClosing, '录音设备还没关好，请稍后再点一次「结束会议」。');
        }
        catch (e) { error ||= e; }
      }
    }
    if (error) throw error;
  }
}
module.exports = { MeetingRecorder };
