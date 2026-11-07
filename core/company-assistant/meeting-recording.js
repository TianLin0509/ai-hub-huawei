'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { fixWebmDuration } = require('./meeting-webm-duration');
const keyOK = key => /^[a-f0-9-]{36}$/.test(String(key));
const hash = b => createHash('sha256').update(b).digest('hex');
const isMp4 = s => /^video\/mp4/.test(s.mime || '');
const fileName = s => s.full ? `recording-full.${isMp4(s) ? 'mp4' : 'webm'}` : `recording-${s.key}.webm`;
// First bytes a container must start with; MP4 has a 4-byte box size first, then "ftyp".
function headerOK(segment, offset, bytes) {
  const [at, magic] = isMp4(segment) ? [4, Buffer.from('ftyp')] : [0, Buffer.from([0x1a, 0x45, 0xdf, 0xa3])];
  for (let i = Math.max(at, offset); i < Math.min(at + magic.length, offset + bytes.length); i++) if (bytes[i - offset] !== magic[i - at]) return false;
  return true;
}
class MeetingRecording {
  constructor(meetings) { this.m = meetings; this.repairs = new Map(); this.errors = new Map(); }
  state(m) { return m.recording ||= { segments: [], gaps: [], bytes: 0, savedThrough: 0 }; }
  file(id, segment) {
    if (!keyOK(segment.key) || segment.file !== fileName(segment)) throw new Error('录制文件无效');
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
        const fd = fs.openSync(file, 'a'); try { fs.writeFileSync(fd, bytes.subarray(written)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
      if (!segment.bytes) {
        // 编码器一个字节都没吐出就结束（刚切分段、刚开始就停）：重试多少次都不会变，不能卡死结束流程。
        // 标记为 empty（不进回放列表），记一条缺口，正常结束。
        segment.end = at; segment.status = 'empty'; rec.savedThrough = Math.max(rec.savedThrough, at);
        rec.gaps.push({ at: segment.at, end: Math.max(at, segment.at), reason: segment.full ? '完整录像没有录到内容' : '该分段没有录到内容' });
        return;
      }
      segment.end = at; segment.status = 'ready'; rec.savedThrough = Math.max(rec.savedThrough, at);
      if (segment.full && !isMp4(segment) && !segment.durationFixed && !this.repairs.has(m.id)) { segment.durationMs = this.m.time(r.durationMs ?? segment.durationMs ?? at - segment.at); this.repair(m.id); }
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
    if (rec.full?.bytes && !isMp4(rec.full) && !rec.full.durationFixed && rec.full.durationMs > 0) this.repair(m.id);
    if(rec.openGap) { rec.gaps.push({...rec.openGap,end:Math.max(rec.openGap.at,m.capturedMs),open:true,reason:rec.openGap.reason+'后中断，缺口结束时间未知'}); delete rec.openGap; }
    for (const s of rec.segments) if (s.status === 'writing') { const next = rec.segments.filter(x => x.at > s.at).sort((a,b)=>a.at-b.at)[0]; s.status = 'interrupted'; rec.gaps.push({ at: s.at, end: Math.min(Math.max(s.end, m.capturedMs), next?.at ?? Infinity), reason: '异常退出：此分段可能不完整，已写入文件保留' }); }
  }
  repair(id) {
    if (this.repairs.has(id)) return this.repairs.get(id);
    // Defer until capture/recovery has persisted the latest state; never overwrite newer events.
    const task = Promise.resolve().then(async () => {
      const full = this.m.load(id).recording?.full; if (!full?.bytes || isMp4(full) || full.durationMs <= 0) return;
      try { const bytes = await fixWebmDuration(this.file(id, full), full.durationMs); const latest = this.m.load(id); Object.assign(latest.recording.full, { bytes, durationFixed: true, durationError: '' }); latest.recording.bytes = latest.recording.segments.reduce((n, s) => n + s.bytes, bytes); this.m.save(latest); this.errors.delete(id); }
      catch (e) { const latest = this.m.load(id); latest.recording.full.durationError = '录像已保留，补写时长失败：' + e.message; this.errors.set(id, latest.recording.full.durationError); this.m.save(latest); }
    }).catch(e => {
      // Even the error status can fail to persist on a full disk. Surface it through status polling;
      // never leave an unobserved rejection that could terminate the recording process.
      this.errors.set(id, (this.errors.get(id) || '完整录像收尾未完成') + '；状态保存失败：' + e.message);
    }).finally(() => this.repairs.delete(id));
    this.repairs.set(id, task); return task;
  }
  full(id) {
    const m = this.m.load(id), full = this.state(m).full;
    if (!full?.bytes || full.status === 'writing') throw new Error('完整录像仍在保存，结束会议后可打开');
    return { file: this.file(id, full), url: pathToFileURL(this.file(id, full)).href, recording: full };
  }
  exportName(id) {
    const m = this.m.load(id), d = new Date(m.startedAt), pad = n => String(n).padStart(2, '0');
    const title = String(m.title || '会议').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '会议';
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${title}${path.extname(this.state(m).full.file)}`;
  }
  index(id) {
    const m = this.m.load(id), rec = this.state(m);
    return { title: m.title, durationMs: m.capturedMs, recording: rec, note: '暂停和异常缺口见gaps。录像只供人回看，不提供给模型。' };
  }
  spans(full, gaps) {
    const spans = [{ at: full.at, mediaAt: 0 }]; let skipped = 0;
    for (const g of [...gaps].filter(g => !g.open && g.end > g.at && g.at >= full.at).sort((a, b) => a.at - b.at)) { skipped += g.end - g.at; spans.push({ at: g.end, mediaAt: g.end - full.at - skipped }); }
    return spans;
  }
  locate(id, at) {
    at = this.m.time(at); const m = this.m.load(id), rec = this.state(m);
    if (rec.openGap && at >= rec.openGap.at || rec.gaps.some(g=>at>=g.at&&(g.open||at<g.end))) throw new Error('此时间位于暂停或中断缺口，没有完整录像');
    const full = rec.full;
    if (full?.bytes && full.status !== 'writing') {
      // Pausing leaves no gap in the video, so meeting time and video time drift apart at every pause.
      const spans = this.spans(full, rec.gaps), span = [...spans].reverse().find(x => x.at <= at) || spans[0];
      return { segment: full, spans, url: pathToFileURL(this.file(id, full)).href, offsetMs: span.mediaAt + Math.max(0, at - span.at) };
    }
    if (full?.status === 'writing') throw new Error('录像还在保存，结束会议后可回放');
    const s = rec.segments.filter(s => s.status === 'ready' && s.at <= at && s.end > at).sort((a,b) => b.at - a.at)[0];
    if (!s) throw new Error('此时间没有已完成的录制片段：可能正在保存、曾暂停或录制中断');
    return { segment: s, url: pathToFileURL(this.file(id, s)).href, offsetMs: at - s.at };
  }
}
module.exports = { MeetingRecording };
