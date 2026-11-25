'use strict';
// MediaRecorder streaming WebM has no Duration. Rewrite only its small Info header,
// then stream-copy the payload to a sibling file; the original survives a failed repair.
// EBML: https://www.matroska.org/technical/elements.html (Duration uses TimestampScale).
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const io = require('./meeting-media-io');
function vint(b, at, id = false) {
  if (at >= b.length || !b[at]) throw new Error('WebM 文件头未完整写入');
  let n = 1; while (n <= 8 && !(b[at] & (0x80 >> (n - 1)))) n++;
  if (n > (id ? 4 : 8) || at + n > b.length) throw new Error('WebM 元素长度无效');
  let value = BigInt(id ? b[at] : b[at] & (0xff >> n));
  for (let i = 1; i < n; i++) value = value * 256n + BigInt(b[at + i]);
  const unknown = !id && value === (1n << BigInt(n * 7)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebM 元素过大');
  return { n, value: unknown ? Infinity : Number(value) };
}
function element(b, at) {
  const id = vint(b, at, true), size = vint(b, at + id.n), start = at + id.n + size.n;
  return { at, id: id.value, idBytes: id.n, sizeBytes: size.n, size: size.value, start, end: start + size.value };
}
function sizeBytes(value, n) {
  if (!n) { n = 1; while (BigInt(value) >= (1n << BigInt(n * 7)) - 1n) n++; }
  if (n > 8 || BigInt(value) >= (1n << BigInt(n * 7)) - 1n) throw new Error('WebM 文件头空间不足');
  const out = Buffer.alloc(n); let v = BigInt(value) | (1n << BigInt(n * 7));
  for (let i = n - 1; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; } return out;
}
function durationHeader(b, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('录像有效时长无效');
  let seg, info;
  for (let at = 0; at < b.length;) { const e = element(b, at); if (e.id === 0x18538067) { seg = e; break; } if (!Number.isFinite(e.end) || e.end > b.length) break; at = e.end; }
  if (!seg) throw new Error('WebM 缺少 Segment');
  for (let at = seg.start; at < Math.min(seg.end, b.length);) {
    const e = element(b, at);
    if (e.id === 0x114d9b74 || e.id === 0x1c53bb6b) throw new Error('录像包含位置索引，保留原片等待专用修复');
    if (e.id === 0x1549a966) info = e;
    if (e.id === 0x1f43b675) break;
    if (!Number.isFinite(e.end) || e.end > b.length) break;
    at = e.end;
  }
  if (!info || info.end > b.length) throw new Error('WebM Info 文件头未完整写入');
  const fields = []; let scale = 1000000;
  for (let at = info.start; at < info.end;) {
    const e = element(b, at); if (e.end > info.end || !Number.isFinite(e.end)) throw new Error('WebM Info 元素损坏');
    if (e.id === 0x2ad7b1) { if (e.size < 1 || e.size > 6) throw new Error('WebM 时间刻度无效'); scale = b.readUIntBE(e.start, e.size); }
    if (e.id !== 0x4489 && e.id !== 0xbf) fields.push(b.subarray(at, e.end)); // Rebuilt Info cannot retain its old CRC.
    at = e.end;
  }
  if (!scale) throw new Error('WebM 时间刻度无效');
  const duration = Buffer.alloc(11); duration.set([0x44, 0x89, 0x88]); duration.writeDoubleBE(durationMs * 1000000 / scale, 3);
  const body = Buffer.concat([...fields, duration]);
  const replacement = Buffer.concat([b.subarray(info.at, info.at + info.idBytes), sizeBytes(body.length), body]);
  const prefix = Buffer.concat([b.subarray(0, info.at), replacement]);
  if (Number.isFinite(seg.size)) sizeBytes(seg.size + replacement.length - (info.end - info.at), seg.sizeBytes).copy(prefix, seg.at + seg.idBytes);
  return { prefix, offset: info.end };
}
async function fixWebmDuration(file, durationMs) {
  // CuePoints are spooled, not collected in RAM. All offsets are Segment-relative.
  const spool = `${file}.cues-${randomUUID()}.tmp`; let cues;
  try {
    return await io.replace(file, async (input, output, size) => {
      cues = await fs.promises.open(spool, 'wx');
      const reader = new Reader(input, size), ebml = await reader.element(0);
      if (ebml.id !== 0x1a45dfa3) throw Error('WebM 缺少 EBML 文件头');
      const seg = await reader.element(ebml.end); if (seg.id !== 0x18538067) throw Error('WebM 缺少 Segment');
      const end = Number.isFinite(seg.end) ? seg.end : size;
      if (end !== size) throw Error('WebM Segment 长度无效');
      const metadata = []; let firstCluster = null, track, info, tracks;
      for (let at = seg.start; at < end;) {
        const e = await reader.element(at);
        if (e.id === CLUSTER) { firstCluster = at; break; }
        if (!Number.isFinite(e.end) || e.end > end) throw Error('WebM 文件头未完整写入');
        if (![SEEK, CUES, 0xbf, 0xec].includes(e.id)) {
          if (e.size > 1024 * 1024) throw Error('WebM 文件头过大');
          let b = await io.read(input, at, e.end - at);
          if (e.id === INFO) {
            if (info) throw Error('WebM Info 重复');
            // Reuse the duration writer on a minimal, unindexed header.
            const minimal = Buffer.concat([Buffer.from('1a45dfa3801853806701ffffffffffffff', 'hex'), b]);
            b = durationHeader(minimal, durationMs).prefix.subarray(17); info = b;
          }
          if (e.id === TRACKS) { if (tracks) throw Error('WebM Tracks 重复'); tracks = b; track = cueTrack(b); }
          metadata.push({ id: e.id, b });
        }
        at = e.end;
      }
      if (firstCluster == null || !info || !track) throw Error('WebM 缺少 Info、视频轨道或 Cluster');
      const placeholder = seekHead(0, 0, 0), prefixSize = placeholder.length + metadata.reduce((n, x) => n + x.b.length, 0);
      let infoPos, tracksPos, pos = placeholder.length;
      for (const x of metadata) { if (x.id === INFO) infoPos = pos; if (x.id === TRACKS) tracksPos = pos; pos += x.b.length; }
      const lead = await io.read(input, 0, seg.at), segmentHeader = Buffer.from('1853806701ffffffffffffff', 'hex');
      await io.write(output, Buffer.concat([lead, segmentHeader, placeholder, ...metadata.map(x => x.b)]));
      let count = 0;
      for (let at = firstCluster; at < end;) {
        const e = await reader.element(at);
        if (e.id !== CLUSTER) {
          if (!Number.isFinite(e.end) || e.end > end) throw Error('WebM 元素截断');
          if (![CUES, SEEK, 0xbf, 0xec].includes(e.id)) throw Error('WebM 含未支持的尾部元素，保留原片');
          at = e.end; continue;
        }
        const parsed = await cluster(reader, e, end, track, async (time, relative) => {
          await io.write(cues, ebmlElement(0xbb, Buffer.concat([uintElement(0xb3, time), ebmlElement(0xb7, Buffer.concat([uintElement(0xf7, track), uintElement(0xf1, pos, 8), uintElement(0xf0, relative)]))]))); count++;
        }), clusterSize = parsed.end - e.start;
        // Close unknown-size Clusters explicitly so appended Cues remain Segment children.
        const h = Buffer.concat([Buffer.from('1f43b675', 'hex'), sizeBytes(clusterSize, 8)]);
        await io.write(output, h); await io.copy(input, output, e.start, parsed.end); pos += h.length + clusterSize; at = parsed.end;
      }
      if (!count) throw Error('WebM 没有可索引的关键帧');
      const cuesSize = (await cues.stat()).size; await cues.close(); cues = null;
      await io.write(output, Buffer.concat([Buffer.from('1c53bb6b', 'hex'), sizeBytes(cuesSize)]));
      const cueInput = await fs.promises.open(spool, 'r'); try { await io.copy(cueInput, output, 0, cuesSize); } finally { await cueInput.close(); }
      const head = seekHead(infoPos, tracksPos, pos);
      await output.write(head, 0, head.length, lead.length + segmentHeader.length);
      // Finite Segment sizes keep Shell/demuxers from scanning past the final index.
      const total = (await output.stat()).size, bytes = sizeBytes(total - lead.length - segmentHeader.length, 8);
      await output.write(bytes, 0, 8, lead.length + 4);
    });
  } finally { await cues?.close().catch(() => {}); await fs.promises.unlink(spool).catch(() => {}); }
}
const INFO = 0x1549a966, TRACKS = 0x1654ae6b, CLUSTER = 0x1f43b675, CUES = 0x1c53bb6b, SEEK = 0x114d9b74;
const LEVEL1 = new Set([INFO, TRACKS, CLUSTER, CUES, SEEK, 0x1254c367, 0x1043a770, 0x1941a469]);
function idBytes(id) { let s = id.toString(16); if (s.length % 2) s = '0' + s; return Buffer.from(s, 'hex'); }
function ebmlElement(id, body) { return Buffer.concat([idBytes(id), sizeBytes(body.length), body]); }
function uintElement(id, value, n) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('WebM 索引时间或位置无效');
  if (!n) { n = 1; while (BigInt(value) >= 1n << BigInt(8 * n)) n++; }
  const b = Buffer.alloc(n); let v = BigInt(value); for (let i = n - 1; i >= 0; i--) { b[i] = Number(v & 255n); v >>= 8n; } return ebmlElement(id, b);
}
function seekHead(info, tracks, cues) {
  return ebmlElement(SEEK, Buffer.concat([[INFO, info], [TRACKS, tracks], [CUES, cues]].map(([id, pos]) => ebmlElement(0x4dbb, Buffer.concat([ebmlElement(0x53ab, idBytes(id)), uintElement(0x53ac, pos, 8)])))));
}
function cueTrack(b) {
  const root = element(b, 0), found = [];
  for (let at = root.start; at < root.end;) {
    const e = element(b, at); if (e.end > root.end) throw Error('WebM Tracks 截断');
    if (e.id === 0xae) {
      let number, type;
      for (let p = e.start; p < e.end;) { const f = element(b, p); if (f.end > e.end) throw Error('WebM TrackEntry 截断'); if ([0xd7, 0x83].includes(f.id)) { if (f.size < 1 || f.size > 6) throw Error('WebM 轨道无效'); const v = b.readUIntBE(f.start, f.size); if (f.id === 0xd7) number = v; else type = v; } p = f.end; }
      if (number > 0) found.push({ number, type });
    }
    at = e.end;
  }
  return (found.find(x => x.type === 1) || found.find(x => x.type === 2))?.number;
}
class Reader {
  constructor(fd, size) { this.fd = fd; this.size = size; this.at = -1; this.b = Buffer.alloc(0); }
  async bytes(at, n) {
    if (at + n > this.size) throw Error('WebM 文件截断');
    if (at < this.at || at + n > this.at + this.b.length) { this.at = at; this.b = await io.read(this.fd, at, Math.min(65536, this.size - at)); }
    return this.b.subarray(at - this.at, at - this.at + n);
  }
  async element(at) { const b = await this.bytes(at, Math.min(12, this.size - at)), e = element(b, 0); return { ...e, at, start: at + e.start, end: at + e.end }; }
}
async function cluster(reader, e, limit, track, emit) {
  const finite = Number.isFinite(e.end), end = finite ? e.end : limit; if (end > limit) throw Error('WebM Cluster 截断');
  let stamp, at = e.start;
  for (; at < end;) {
    const f = await reader.element(at); if (LEVEL1.has(f.id)) { if (finite) throw Error('WebM Cluster 层级损坏'); break; }
    if (!Number.isFinite(f.end) || f.end > end) throw Error('WebM Cluster 元素截断');
    if (f.id === 0xe7) { if (f.size < 1 || f.size > 6) throw Error('WebM Cluster 时间无效'); stamp = (await reader.bytes(f.start, f.size)).readUIntBE(0, f.size); }
    if (f.id === 0xa3) {
      const b = await reader.bytes(f.start, Math.min(f.size, 12)), t = vint(b, 0); if (t.n + 3 >= f.size) throw Error('WebM Block 截断');
      if (t.value === track && b[t.n + 2] & 0x80) { if (stamp == null) throw Error('WebM Cluster 缺少时间戳'); await emit(stamp + b.readInt16BE(t.n), at - e.start); }
    }
    if (f.id === 0xa0) {
      let block, reference = false;
      for (let p = f.start; p < f.end;) { const g = await reader.element(p); if (!Number.isFinite(g.end) || g.end > f.end) throw Error('WebM BlockGroup 截断'); if (g.id === 0xa1) block = g; if (g.id === 0xfb) reference = true; p = g.end; }
      if (block) {
        const b = await reader.bytes(block.start, Math.min(block.size, 12)), t = vint(b, 0); if (t.n + 3 >= block.size) throw Error('WebM Block 截断');
        if (t.value === track && !reference) { if (stamp == null) throw Error('WebM Cluster 缺少时间戳'); await emit(stamp + b.readInt16BE(t.n), at - e.start); }
      }
    }
    at = f.end;
  }
  return { end: at };
}
module.exports = { fixWebmDuration, durationHeader, element, sizeBytes, ebmlElement, uintElement };
