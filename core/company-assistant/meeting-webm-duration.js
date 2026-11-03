'use strict';
// MediaRecorder streaming WebM has no Duration. Rewrite only its small Info header,
// then stream-copy the payload to a sibling file; the original survives a failed repair.
// EBML: https://www.matroska.org/technical/elements.html (Duration uses TimestampScale).
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
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
  const input = await fs.promises.open(file, 'r'); let header;
  try { const b = Buffer.alloc(Math.min(1024 * 1024, (await input.stat()).size)); const { bytesRead } = await input.read(b, 0, b.length, 0); header = durationHeader(b.subarray(0, bytesRead), durationMs); }
  finally { await input.close(); }
  const temp = `${file}.duration-${randomUUID()}.tmp`;
  try {
    await pipeline((async function* () { yield header.prefix; yield* fs.createReadStream(file, { start: header.offset }); })(), fs.createWriteStream(temp, { flags: 'wx' }));
    const fd = await fs.promises.open(temp, 'r+'); try { await fd.sync(); } finally { await fd.close(); }
    await fs.promises.rename(temp, file);
    return (await fs.promises.stat(file)).size;
  } catch (e) { await fs.promises.unlink(temp).catch(() => {}); throw e; }
}
module.exports = { fixWebmDuration, durationHeader, element };
