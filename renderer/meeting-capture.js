'use strict';
const { MeetingRecorder } = require('./meeting-recorder');
function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b.toString('base64');
}
function distance(a, b) { if (!a || !b || a.length !== b.length) return Infinity; let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; }
// 同一页上的小变化（PPT 逐条出现、批注、高亮）：变化像素少于 3%、平均差也小，服务端会用它覆盖上一张而不是新增（2026-10-25）。
function minorChange(a, b) { if (!a || !b || a.length !== b.length) return false; let pixels = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) pixels++; return pixels / a.length < 0.03 && distance(a, b) < 6; }
function changed(a, b) { if (!a || !b) return true; let pixels = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) pixels++; return distance(a, b) >= 3 || pixels / a.length > 0.002; }
// 语音分段：在说话停顿处切（2026-11-07）。原来固定 15 秒硬切会把一个词切成两半，两边都识别错；
// 合成会议音频上，噪声条件下错字率 18% → 9%。8 秒后遇到安静的 256 毫秒就切，最长 20 秒（识别模型一次最好不超过 30 秒）。
// 「安静」相对本路的底噪判断：底噪取最近的最小音量，慢慢回升，适应开着空调或风扇的会议室。
const CUT_MIN_S = 8, CUT_MAX_S = 20;
function cutHere(n, buffer, rate) {
  let sum = 0; for (const v of buffer) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, buffer.length));
  n.floor = n.floor == null ? rms : Math.min(rms, n.floor * 1.01 + 1e-5);
  const len = n.length / rate;
  return len >= CUT_MAX_S || (len >= CUT_MIN_S && rms <= Math.max(0.004, n.floor * 2));
}
class MeetingCapture {
  constructor({ document, window, save, status, waitMs = 10000 }) { this.d = document; this.w = window; this.save = save; this.status = status; this.waitMs = waitMs; this.streams = []; this.nodes = []; this.queue = []; this.levels = {}; }
  async wait(promise, message, progressAt) {
    let timer;
    const startedAt = performance.now();
    try { return await Promise.race([promise, new Promise((_, reject) => {
      const check = () => {
        const remaining = this.waitMs - (performance.now() - Math.max(startedAt, progressAt?.() || 0));
        if (remaining > 0) { timer = setTimeout(check, remaining); return; }
        reject(Object.assign(new Error(message), { code: 'MEETING_RECORDING_TIMEOUT' }));
      };
      timer = setTimeout(check, this.waitMs);
    })]); }
    finally { clearTimeout(timer); }
  }
  async open(sourceId, audio) {
    try {
      const stream = await this.w.navigator.mediaDevices.getUserMedia({ audio: audio.system ? { mandatory: { chromeMediaSource: 'desktop' } } : false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 15 } } });
      this.streams.push(stream);
      if (audio.system && !stream.getAudioTracks().length) throw new Error('未获取系统声音，请换为整个屏幕或关闭系统声音后重试');
      this.video = this.d.createElement('video'); this.video.muted = true; this.video.srcObject = stream; await this.video.play();
      for (const t of stream.getVideoTracks()) t.onended = () => { this.disconnected = true; void this.pause('共享画面断开').catch(e => this.status(e.message)); this.status('共享画面已断开，请结束会议并重新选择窗口'); };
      if (audio.system) this.audio(stream, 'system');
      if (audio.mic) {
        let mic;
        try { mic = await this.w.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
        catch (e) {
          audio.mic = false;
          const reason = { NotAllowedError: '麦克风权限被拒绝', NotFoundError: '没找到麦克风', NotReadableError: '麦克风被占用或无法读取' }[e.name] || '麦克风暂时不可用';
          this.warning = reason + (audio.system ? '，本场只录电脑声音' : '，本场只录画面'); this.status(this.warning);
        }
        if (mic) { this.streams.push(mic); this.audio(mic, 'mic'); }
      }
      this.recorder = new MeetingRecorder({ window: this.w, streams: this.streams, elapsed: () => this.elapsed(), save: this.save, waitMs: this.waitMs, onError: message => { void this.pause('录屏保存异常').catch(() => {}); this.status('录像出错：' + message + '。已录的内容都在，请先点「重试保存」。'); } });
      await this.recorder.open();
    } catch (e) {
      const message = { NotAllowedError: '采集权限被拒绝，请在系统隐私设置中允许访问后重试', NotFoundError: '未找到共享设备，请刷新并重新选择窗口或屏幕', NotReadableError: '共享设备被占用或无法读取，请关闭占用程序后重试' }[e.name];
      if (message) e = new Error(message);
      await this.dispose(); throw e;
    }
  }
  audio(stream, track) {
    const ctx = new this.w.AudioContext({ sampleRate: 16000 }), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
    const n = { ctx, src, proc, mute, track, samples: [], length: 0, at: null }; this.nodes.push(n);
    proc.onaudioprocess = e => {
      if (!this.running || this.paused) return;
      const copy = new Float32Array(e.inputBuffer.getChannelData(0));
      if (n.at === null) n.at = this.elapsed();
      n.samples.push(copy); n.length += copy.length; let peak = 0; for (const v of copy) peak = Math.max(peak, Math.abs(v)); this.levels[track] = peak;
      if (cutHere(n, copy, ctx.sampleRate)) this.flush(n);
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    stream.getAudioTracks().forEach(t => { t.onended = () => { this.disconnected = true; void this.pause((track === 'mic' ? '麦克风' : '系统声音') + '断开').catch(e => this.status(e.message)); this.status('声音来源已断开，已暂停采集，请结束并重新选择设备'); }; });
  }
  elapsed() { return Math.max(0, Math.round(this.w.performance.now() - this.started)); }
  // 界面时钟：暂停期间停在暂停那一刻。elapsed() 是墙上时钟，录像时间轴靠它记录暂停缺口，不能改。
  displayMs() { return this.paused && this.gapAt != null ? this.gapAt : this.elapsed(); }
  start(crop) { this.crop = crop; this.started = this.w.performance.now(); this.running = true; this.paused = false; this.recorder?.start(); this.timer = setInterval(() => { if (!this.paused) { void this.frame().catch(e => this.status(e.message)); this.enqueue({ kind: 'heartbeat', at: this.elapsed() }); } }, 1000); void this.frame(true).catch(e => this.status(e.message)); }
  enqueue(item) { this.queue.push(item); if (this.queue.length > 30) { this.suspendForError('材料保存积压'); this.status('保存积压，已暂停采集；点击重试保存后继续。尚未写入的片段保留在内存中。'); } void this.drain(); }
  suspendForError(reason) { if (this.paused) return; this.paused = true; this.openGap(reason); this.pausing = this.recorder?.pause(); void this.pausing?.catch(() => {}); }
  openGap(reason) { if(this.gapAt==null){this.gapAt=this.elapsed();this.gapReason=reason;this.enqueue({kind:'recording-gap-open',at:this.gapAt,reason});} }
  drain() {
    if (this.saving) return this.saveTask;
    if (this.saveError) return Promise.resolve();
    this.saving = true;
    this.saveTask = Promise.resolve().then(async () => {
      try { while (this.queue.length) { await this.save(this.queue[0]); this.queue.shift(); this.lastSavedAt = performance.now(); } }
      catch (e) { this.saveError = e.message; this.suspendForError('材料保存失败'); this.status('材料保存失败，已暂停：' + e.message + '。请重试保存，暂勿关闭 Hub。'); }
      finally { this.saving = false; }
    });
    return this.saveTask;
  }
  async retry() {
    await this.pausing?.catch(()=>{}); this.saveError = '';
    await this.wait(this.drain(), '会议内容还没存完，已录的都在。请稍后点「重试保存」，先别关 Hub。', () => this.lastSavedAt);
    await this.recorder?.retry(); if (this.paused) await this.flushAll();
  }
  flush(n) {
    if (!n.length) return;
    const samples = new Float32Array(n.length); let i = 0; for (const b of n.samples) { samples.set(b, i); i += b.length; }
    this.enqueue({ kind: 'audio', track: n.track, at: n.at, end: n.at + Math.round(n.length / n.ctx.sampleRate * 1000), data: wav(samples, n.ctx.sampleRate) });
    n.samples = []; n.length = 0; n.at = null;
  }
  async frame(force = false) {
    if (this.paused) throw new Error('请先继续采集再截图');
    const v = this.video; if (!v?.videoWidth || this.drawing) return; this.drawing = true;
    try {
      const c = this.crop, x = v.videoWidth * c.x, y = v.videoHeight * c.y, width = v.videoWidth * c.w, height = v.videoHeight * c.h;
      const small = this.d.createElement('canvas'); small.width = 160; small.height = 90;
      const ctx = small.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, x, y, width, height, 0, 0, 160, 90);
      const rgba = ctx.getImageData(0, 0, 160, 90).data, sig = new Uint8Array(160 * 90); for (let i = 0; i < sig.length; i++) sig[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
      const stable = distance(sig, this.previous) < 1.5; this.previous = sig;
      if (!force && (!stable || !changed(sig, this.saved))) return;
      const canvas = this.d.createElement('canvas'); canvas.width = Math.round(width); canvas.height = Math.round(height); canvas.getContext('2d').drawImage(v, x, y, width, height, 0, 0, width, height);
      this.enqueue({ kind: 'slide', at: this.elapsed(), data: canvas.toDataURL('image/jpeg', 0.9).split(',')[1], forced: force, minor: !force && minorChange(sig, this.saved) }); this.saved = sig;
    } finally { this.drawing = false; }
  }
  async flushAll() { for (const n of this.nodes) this.flush(n); await this.wait(this.drain(), '会议内容还没存完，已录的都在。请稍后点「重试保存」，先别关 Hub。', () => this.lastSavedAt); if (this.queue.length) throw new Error('还有材料未保存，请重试保存'); }
  async pause(reason = '用户暂停') {
    this.paused = true; this.openGap(reason); this.pausing=this.recorder?.pause();
    try { await this.pausing; await this.flushAll(); }
    catch (error) {
      if (error.code === 'MEETING_RECORDING_TIMEOUT') { try { await this.dispose(); } catch (_) { /* A timeout never discards the original pending data. */ } }
      throw error;
    }
  }
  assertCanResume() {
    if (this.ending || this.released) throw new Error('本场已停止录制，请再点一次「结束会议」。这场不能再继续录了。');
    if (this.disconnected) throw new Error('共享来源已断开，请结束会议后重新选择');
    if (this.queue.length || this.recorder?.queue.length) throw new Error('请先重试保存');
    this.recorder?.assertCanStart();
  }
  resume() { this.assertCanResume(); if (this.gapAt != null) { this.enqueue({ kind: 'recording-gap', at: this.gapAt, end: this.elapsed(), reason: this.gapReason }); this.gapAt = null; } this.recorder?.start(); this.paused = false; }
  async stop() {
    this.paused = true; this.ending = true; clearInterval(this.timer);
    try {
      await this.recorder?.pause();
      if (this.gapAt != null) { this.enqueue({ kind: 'recording-gap', at: this.gapAt, end: this.elapsed(), reason: this.gapReason }); this.gapAt = null; }
      await this.flushAll(); await this.dispose(); this.running = false;
    } catch (error) {
      try { await this.dispose(); } catch (_) { /* Preserve the original unresolved operation and its queued data. */ }
      throw error;
    }
  }
  async dispose() {
    clearInterval(this.timer); this.paused = true; this.released = true;
    let error;
    try { await this.recorder?.close(); } catch (e) { error = e; }
    finally {
      this.stoppedTracks ||= new WeakSet();
      for (const s of this.streams) for (const track of s.getTracks()) {
        if (this.stoppedTracks.has(track)) continue;
        try { track.onended = null; track.stop(); this.stoppedTracks.add(track); } catch (e) { error ||= e; }
      }
      const nodes = this.nodes;
      this.streams = this.streams.filter(s => s.getTracks().some(track => !this.stoppedTracks.has(track)));
      if (this.video) this.video.srcObject = null;
      // Keep flushed and pending data owned by this capture even when the devices have been released.
      this.detachedNodes ||= new WeakSet();
      for (const n of nodes) {
        try { this.flush(n); } catch (e) { error ||= e; }
        for (const node of [n.proc, n.src]) {
          if (this.detachedNodes.has(node)) continue;
          try { node.disconnect(); this.detachedNodes.add(node); } catch (e) { error ||= e; }
        }
      }
      try {
        const results = await this.wait(Promise.allSettled(nodes.map(n => {
          if (n.closed) return Promise.resolve();
          return n.closeTask ||= Promise.resolve().then(() => n.ctx.close()).then(() => { n.closed = true; }, e => { n.closeTask = null; throw e; });
        })), '录音设备还没关好，请稍后再点一次「结束会议」。');
        for (const result of results) if (result.status === 'rejected') error ||= result.reason;
      }
      catch (e) { error ||= e; }
      this.nodes = this.nodes.filter(n => !n.closed || n.length);
    }
    if (error) throw error;
  }
}
module.exports = { MeetingCapture, wav, distance, changed, minorChange, cutHere };
