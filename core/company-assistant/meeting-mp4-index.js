'use strict';
// ISO BMFF fragmented MP4 finalizer, no codecs or dependencies. tfra records are spooled
// to disk, so memory is bounded by the largest metadata box, never by recording length.
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { read, write, copy, replace } = require('./meeting-media-io');
const MAX_META = 16 * 1024 * 1024;
function box(type, body) { const b = Buffer.alloc(8); b.writeUInt32BE(body.length + 8); b.write(type, 4); return Buffer.concat([b, body]); }
function boxes(b, start = 0, end = b.length) {
  const out = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) throw Error('MP4 box 截断');
    let size = b.readUInt32BE(at), head = 8;
    if (size === 1) { if (at + 16 > end) throw Error('MP4 box 截断'); size = Number(b.readBigUInt64BE(at + 8)); head = 16; }
    if (size === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < head || at + size > end) throw Error('MP4 box 长度无效');
    out.push({ at, start: at + head, end: at + size, size, type: b.toString('ascii', at + 4, at + 8) }); at += size;
  }
  return out;
}
async function top(fd, at, end) {
  const h = await read(fd, at, Math.min(16, end - at));
  if (h.length < 8) throw Error('MP4 box 截断');
  let size = h.readUInt32BE(), head = 8;
  if (size === 1) { if (h.length < 16) throw Error('MP4 box 截断'); size = Number(h.readBigUInt64BE(8)); head = 16; }
  if (!size) size = end - at;
  if (!Number.isSafeInteger(size) || size < head || at + size > end) throw Error('MP4 box 长度无效或文件截断');
  return { at, start: at + head, end: at + size, size, type: h.toString('ascii', 4, 8) };
}
const children = (b, e) => boxes(b, e.start, e.end);
function child(b, e, type) { const c = children(b, e).find(x => x.type === type); if (!c) throw Error(`MP4 缺少 ${type}`); return c; }
function need(e, at, n) { if (at + n > e.end) throw Error(`MP4 ${e.type} 截断`); }
function field(b, e) {
  const v = b[e.start]; if (v > 1) throw Error('MP4 时间版本不支持');
  const scale = e.start + (v ? 20 : 12), duration = e.start + (v ? 24 : 16); need(e, duration, v ? 8 : 4);
  return { scale: b.readUInt32BE(scale), duration, v };
}
function setDuration(b, e, n, track = false) {
  const v = b[e.start], at = track ? e.start + (v ? 28 : 20) : field(b, e).duration;
  need(e, at, v ? 8 : 4);
  if (!Number.isSafeInteger(n) || n < 0 || (!v && n > 0xffffffff)) throw Error('MP4 时长超出文件头范围');
  if (v) b.writeBigUInt64BE(BigInt(n), at); else b.writeUInt32BE(n, at);
}
function parseMoov(b) {
  const root = boxes(b)[0], mvhd = child(b, root, 'mvhd'), movieScale = field(b, mvhd).scale, tracks = new Map();
  if (!movieScale) throw Error('MP4 时间刻度无效');
  for (const trak of children(b, root).filter(x => x.type === 'trak')) {
    const tkhd = child(b, trak, 'tkhd'), idAt = tkhd.start + (b[tkhd.start] ? 20 : 12); need(tkhd, idAt, 4);
    const id = b.readUInt32BE(idAt), mdia = child(b, trak, 'mdia'), mdhd = child(b, mdia, 'mdhd');
    const stbl = child(b, child(b, mdia, 'minf'), 'stbl');
    for (const e of children(b, stbl).filter(x => ['stco', 'co64'].includes(x.type))) { need(e, e.start, 8); if (b.readUInt32BE(e.start + 4)) throw Error('只支持 MediaRecorder 碎片化 MP4'); }
    const scale = field(b, mdhd).scale; if (!scale || tracks.has(id)) throw Error('MP4 轨道无效');
    tracks.set(id, { id, scale, tkhd, mdhd, end: 0, count: 0, duration: 0, flags: 0 });
  }
  const mvex = child(b, root, 'mvex');
  for (const e of children(b, mvex).filter(x => x.type === 'trex')) {
    need(e, e.start, 24); const t = tracks.get(b.readUInt32BE(e.start + 4)); if (!t) throw Error('MP4 轨道默认值无效');
    t.duration = b.readUInt32BE(e.start + 12); t.flags = b.readUInt32BE(e.start + 20);
  }
  return { b, root, mvhd, movieScale, tracks, mvex };
}
async function scanMoof(b, moofAt, info, emit, shift = null) {
  const root = boxes(b)[0]; let trafNo = 0;
  for (const traf of children(b, root).filter(x => x.type === 'traf')) {
    trafNo++; const tfhd = child(b, traf, 'tfhd'); need(tfhd, tfhd.start, 8);
    const f = b.readUInt32BE(tfhd.start) & 0xffffff, t = info.tracks.get(b.readUInt32BE(tfhd.start + 4));
    if (!t) throw Error('MP4 片段引用未知轨道');
    let p = tfhd.start + 8, duration = t.duration, flags = t.flags, oldBase = moofAt;
    if (f & 1) { need(tfhd, p, 8); oldBase = Number(b.readBigUInt64BE(p)); if (!Number.isSafeInteger(oldBase)) throw Error('MP4 基址无效'); if (shift) b.writeBigUInt64BE(BigInt(shift(oldBase)), p); p += 8; }
    if (f & 2) p += 4;
    if (f & 8) { need(tfhd, p, 4); duration = b.readUInt32BE(p); p += 4; }
    if (f & 16) p += 4;
    if (f & 32) { need(tfhd, p, 4); flags = b.readUInt32BE(p); p += 4; } need(tfhd, p, 0);
    if (shift) {
      if (!(f & 1) && !(f & 0x20000) && trafNo > 1) throw Error('MP4 隐式跨轨道基址未支持，保留原片');
      for (const run of children(b, traf).filter(x => x.type === 'trun')) {
        need(run, run.start, 8); const rf = b.readUInt32BE(run.start) & 0xffffff;
        if (rf & 1) {
          const at = run.start + 8; need(run, at, 4);
          const adjusted = shift(oldBase + b.readInt32BE(at)) - shift(oldBase);
          if (adjusted < -0x80000000 || adjusted > 0x7fffffff) throw Error('MP4 媒体偏移超出范围'); b.writeInt32BE(adjusted, at);
        }
      }
      continue;
    }
    const tfdt = children(b, traf).find(x => x.type === 'tfdt'); let time = t.decode || 0;
    if (tfdt) { need(tfdt, tfdt.start, b[tfdt.start] ? 12 : 8); time = b[tfdt.start] ? Number(b.readBigUInt64BE(tfdt.start + 4)) : b.readUInt32BE(tfdt.start + 4); }
    let runNo = 0;
    for (const run of children(b, traf).filter(x => x.type === 'trun')) {
      runNo++; need(run, run.start, 8); const rf = b.readUInt32BE(run.start) & 0xffffff, count = b.readUInt32BE(run.start + 4);
      let q = run.start + 8, firstFlags = flags; if (rf & 1) q += 4;
      if (rf & 4) { need(run, q, 4); firstFlags = b.readUInt32BE(q); q += 4; }
      const stride = [256, 512, 1024, 2048].filter(f => rf & f).length * 4;
      need(run, q, stride * count);
      if (count > 1000000) throw Error('MP4 片段样本数量过大');
      let indexedRun = false;
      for (let i = 0; i < count; i++) {
        const d = rf & 256 ? b.readUInt32BE(q) : duration; if (rf & 256) q += 4;
        if (rf & 512) q += 4;
        const sf = rf & 1024 ? b.readUInt32BE(q) : i === 0 ? firstFlags : flags; if (rf & 1024) q += 4;
        let cto = 0; if (rf & 2048) { cto = b[run.start] ? b.readInt32BE(q) : b.readUInt32BE(q); q += 4; }
        if (!Number.isSafeInteger(time + d + cto)) throw Error('MP4 片段时长无效');
        if (!indexedRun && !(sf & 0x10000) && ((sf >>> 24) & 3) !== 1) { await emit(t, time + cto, moofAt, trafNo, runNo, i + 1); t.count++; indexedRun = true; }
        t.end = Math.max(t.end, time + d + cto); time += d;
      }
      t.decode = time;
    }
  }
}
function rebuild(info) {
  const { b, root, tracks, movieScale, mvhd, mvex } = info;
  const duration = Math.ceil(Math.max(...[...tracks.values()].map(t => t.end / t.scale)) * movieScale);
  if (!duration) throw Error('MP4 没有完整媒体片段'); setDuration(b, mvhd, duration);
  for (const t of tracks.values()) { setDuration(b, t.mdhd, Math.ceil(t.end)); setDuration(b, t.tkhd, Math.ceil(t.end / t.scale * movieScale), true); }
  const mehd = Buffer.alloc(12); mehd[0] = 1; mehd.writeBigUInt64BE(BigInt(duration), 4);
  const mvexBody = Buffer.concat([box('mehd', mehd), ...children(b, mvex).filter(x => x.type !== 'mehd').map(x => b.subarray(x.at, x.end))]);
  return box('moov', Buffer.concat(children(b, root).map(x => x === mvex || x.type === 'mvex' ? box('mvex', mvexBody) : b.subarray(x.at, x.end))));
}
async function fixMp4Index(file) {
  const spools = new Map();
  try {
    return await replace(file, async (input, output, size) => {
      let info, moov, hasFtyp = false, fragments = 0, pendingMedia = false;
      for (let at = 0; at < size;) {
        const e = await top(input, at, size);
        if (e.type === 'ftyp') hasFtyp = true;
        if (e.type === 'sidx') throw Error('MP4 已有 sidx，保留原片');
        if (e.type === 'mfra' && e.end !== size) throw Error('MP4 随机访问索引必须位于文件尾');
        if (e.type === 'moov') { if (info || fragments || e.size > MAX_META) throw Error('MP4 文件头无效'); moov = e; info = parseMoov(await read(input, at, e.size)); }
        if (e.type === 'moof') {
          if (!info || e.size > MAX_META || pendingMedia) throw Error('MP4 片段文件头无效或缺少媒体数据'); fragments++; pendingMedia = true;
          await scanMoof(await read(input, at, e.size), at, info, async (t, time, offset, traf, trun, sample) => {
            if (!spools.has(t.id)) { const name = `${file}.tfra-${randomUUID()}.tmp`; spools.set(t.id, { name, fd: await fs.open(name, 'wx') }); }
            const row = Buffer.alloc(28); row.writeBigUInt64BE(BigInt(time)); row.writeBigUInt64BE(BigInt(offset), 8); row.writeUInt32BE(traf, 16); row.writeUInt32BE(trun, 20); row.writeUInt32BE(sample, 24);
            await write(spools.get(t.id).fd, row);
          });
        }
        if (e.type === 'mdat') {
          if ((await read(input, at, 4)).readUInt32BE() === 0) throw Error('MP4 媒体数据长度未封口，保留原片');
          if (!pendingMedia || e.size <= e.start - e.at) throw Error('MP4 媒体片段无效'); pendingMedia = false;
        }
        at = e.end;
      }
      if (!hasFtyp || !info || !fragments || pendingMedia) throw Error('MP4 缺少文件头或完整媒体片段');
      const updated = rebuild(info), delta = updated.length - moov.size;
      // Fragment-relative trun addresses remain unchanged; absolute tfhd addresses shift.
      const shift = old => old >= moov.end ? old + delta : old;
      for (let at = 0; at < size;) {
        const e = await top(input, at, size);
        if (e.type === 'moov') await write(output, updated);
        else if (e.type === 'moof') { const b = await read(input, at, e.size); await scanMoof(b, at, info, null, shift); await write(output, b); }
        else if (e.type !== 'mfra') await copy(input, output, at, e.end);
        at = e.end;
      }
      const indexed = [...info.tracks.values()].filter(t => t.count), mfraSize = 8 + 16 + indexed.reduce((n, t) => n + 24 + 28 * t.count, 0);
      if (!indexed.length || mfraSize > 0xffffffff) throw Error('MP4 随机访问索引无效');
      const head = Buffer.alloc(8); head.writeUInt32BE(mfraSize); head.write('mfra', 4); await write(output, head);
      for (const t of indexed) {
        const h = Buffer.alloc(24); h.writeUInt32BE(24 + 28 * t.count); h.write('tfra', 4); h[8] = 1; h.writeUInt32BE(t.id, 12); h.writeUInt32BE(63, 16); h.writeUInt32BE(t.count, 20); await write(output, h);
        const s = spools.get(t.id); await s.fd.close(); s.fd = null;
        const fd = await fs.open(s.name, 'r');
        try { for (let at = 0; at < t.count * 28;) { const b = await read(fd, at, Math.min(28 * 2048, t.count * 28 - at)); for (let p = 8; p < b.length; p += 28) b.writeBigUInt64BE(BigInt(shift(Number(b.readBigUInt64BE(p)))), p); await write(output, b); at += b.length; } } finally { await fd.close(); }
      }
      const tail = Buffer.alloc(8); tail.writeUInt32BE(mfraSize, 4); await write(output, box('mfro', tail));
    });
  } finally { for (const s of spools.values()) { await s.fd?.close().catch(() => {}); await fs.unlink(s.name).catch(() => {}); } }
}
module.exports = { fixMp4Index, boxes, box, parseMoov, top };
