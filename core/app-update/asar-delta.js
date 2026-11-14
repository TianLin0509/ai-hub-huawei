'use strict';
// Preserve the exact target ASAR header and byte order. Unchanged packed files
// become bounded copy ranges into the verified base; changed files are literals.
// No extraction, native module or ASAR writer is needed on the client.
const { createHash } = require('crypto');
const hash = b => createHash('sha256').update(b).digest('hex');
const MAX_BYTES = 600 * 1024 * 1024;
const MAX_HEADER = 2 * 1024 * 1024;
const MAX_PARTS = 50000;

function asarTable(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw Error('ASAR header is invalid');
  const start = 8 + buf.readUInt32LE(4), length = buf.readUInt32LE(12);
  if (start > buf.length || start > MAX_HEADER || length > start - 16) throw Error('ASAR header is out of bounds');
  const header = JSON.parse(buf.subarray(16, 16 + length).toString('utf8'));
  const rows = [];
  function walk(dir, prefix = '', depth = 0) {
    if (depth > 100 || !dir.files || typeof dir.files !== 'object') throw Error('ASAR file table is invalid');
    for (const [name, entry] of Object.entries(dir.files)) {
      const key = prefix + name;
      if (entry.files) walk(entry, key + '/', depth + 1);
      else if (!entry.unpacked && !entry.link) {
        const bytes = entry.size, offset = start + Number(entry.offset);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(offset) || offset < start || offset + bytes > buf.length) throw Error('ASAR file range is invalid');
        rows.push({ key, offset, bytes });
        if (rows.length > MAX_PARTS) throw Error('ASAR contains too many files');
      }
    }
  }
  walk(header);
  return { start, rows: rows.sort((a, b) => a.offset - b.offset) };
}

function createAsarDelta(base, target) {
  if (base.length > MAX_BYTES || target.length > MAX_BYTES) throw Error('ASAR exceeds size limit');
  const previous = new Map(asarTable(base).rows.map(row => [row.key, row]));
  const next = asarTable(target), parts = [], literals = [];
  const literal = (offset, bytes) => { if (bytes) { parts.push({ bytes }); literals.push(target.subarray(offset, offset + bytes)); } };
  literal(0, next.start);
  let cursor = next.start;
  for (const row of next.rows) {
    if (row.offset < cursor) { if (row.bytes === 0) continue; throw Error('Overlapping ASAR file ranges'); }
    literal(cursor, row.offset - cursor);
    const old = previous.get(row.key);
    if (old && old.bytes === row.bytes && base.subarray(old.offset, old.offset + old.bytes).equals(target.subarray(row.offset, row.offset + row.bytes))) {
      if (row.bytes) parts.push({ offset: old.offset, bytes: row.bytes });
    } else literal(row.offset, row.bytes);
    cursor = row.offset + row.bytes;
  }
  literal(cursor, target.length - cursor);
  const header = { schema: 1, baseSha256: hash(base), targetSha256: hash(target), targetBytes: target.length, parts };
  const line = Buffer.from(JSON.stringify(header) + '\n');
  if (line.length > MAX_HEADER || parts.length > MAX_PARTS) throw Error('ASAR delta directory exceeds limit');
  return Buffer.concat([line, ...literals]);
}

function applyAsarDelta(base, patch) {
  const nl = patch.indexOf(10);
  if (nl < 0 || nl > MAX_HEADER) throw Error('ASAR delta directory is invalid');
  const h = JSON.parse(patch.subarray(0, nl).toString('utf8'));
  if (!h || h.schema !== 1 || !Array.isArray(h.parts) || h.parts.length > MAX_PARTS
    || !Number.isSafeInteger(h.targetBytes) || h.targetBytes < 16 || h.targetBytes > MAX_BYTES) throw Error('ASAR delta format is invalid');
  if (hash(base) !== h.baseSha256) throw Error('ASAR delta base checksum mismatch');
  const target = Buffer.alloc(h.targetBytes);
  let out = 0, input = nl + 1;
  for (const part of h.parts) {
    if (!Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > h.targetBytes - out) throw Error('ASAR delta range is invalid');
    const copy = Object.hasOwn(part, 'offset');
    const offset = copy ? part.offset : input, source = copy ? base : patch;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length - part.bytes) throw Error('ASAR delta source range is invalid');
    source.copy(target, out, offset, offset + part.bytes);
    out += part.bytes;
    if (!copy) input += part.bytes;
  }
  if (out !== target.length || input !== patch.length || hash(target) !== h.targetSha256) throw Error('ASAR delta reconstructed checksum mismatch');
  return target;
}

module.exports = { createAsarDelta, applyAsarDelta };
