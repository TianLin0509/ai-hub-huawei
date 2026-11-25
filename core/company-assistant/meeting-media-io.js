'use strict';
// Bounded reads/copies shared by the two container finalizers. Never buffer media payloads.
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
async function checkSpace(file, size) {
  let stat;
  try { stat = await fs.statfs(path.dirname(file), { bigint: true }); }
  catch {
    // Network/virtual filesystems may not expose statfs (ENOSYS/ENOTSUP/EINVAL).
    // An unavailable capacity probe cannot establish low space. The actual I/O
    // still reports failures and keeps the original through atomic replacement.
    return;
  }
  const available = BigInt(stat.bavail) * BigInt(stat.bsize), required = BigInt(Math.ceil(size * 1.1)) + 512n * 1024n ** 2n;
  if (available < required) throw Object.assign(Error('磁盘空间不足，录像未补索引，原片可正常播放'), { code: 'ENOSPC' });
}
async function cleanup(file, olderThan) {
  const prefix = path.basename(file) + '.', dir = path.dirname(file);
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.startsWith(prefix) || !/^(index|tfra|cues)-[0-9a-f-]{36}\.tmp$/.test(item.name.slice(prefix.length))) continue;
    const target = path.join(dir, item.name), stat = await fs.stat(target);
    if (stat.birthtimeMs < olderThan) await fs.unlink(target);
  }
}
async function read(fd, at, size) {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || size < 0) throw Error('录像位置无效');
  const b = Buffer.alloc(size); let done = 0;
  while (done < size) { const r = await fd.read(b, done, size - done, at + done); if (!r.bytesRead) throw Error('录像文件截断'); done += r.bytesRead; }
  return b;
}
async function write(fd, b) {
  let done = 0;
  while (done < b.length) { const r = await fd.write(b, done, b.length - done); if (!r.bytesWritten) throw Error('录像写入失败'); done += r.bytesWritten; }
}
async function copy(input, output, start, end) {
  const b = Buffer.alloc(Math.min(1024 * 1024, end - start));
  for (let at = start; at < end;) {
    const n = Math.min(b.length, end - at), r = await input.read(b, 0, n, at);
    if (!r.bytesRead) throw Error('录像文件截断'); await write(output, b.subarray(0, r.bytesRead)); at += r.bytesRead;
  }
}
async function replace(file, build) {
  const temp = `${file}.index-${randomUUID()}.tmp`; let input, output;
  try {
    input = await fs.open(file, 'r'); const before = await input.stat();
    await checkSpace(file, before.size);
    output = await fs.open(temp, 'wx', before.mode); await build(input, output, before.size);
    await output.sync(); const size = (await output.stat()).size; await output.close(); output = null;
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(Error('录像仍在写入，稍后再修复'), { code: 'EBUSY' });
    await input.close(); input = null;
    await fs.rename(temp, file); return size;
  } finally { await input?.close().catch(() => {}); await output?.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
}
module.exports = { read, write, copy, replace, checkSpace, cleanup };
