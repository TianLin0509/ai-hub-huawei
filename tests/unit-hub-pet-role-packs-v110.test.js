'use strict';
// r27i：下载形象 1.1.0（兔子、柴犬、仓鼠、玄凤补打字与待机小动作帧）。发布前逐个核对：
// 目录与包的字节数、SHA-256 一致；包能过客户端校验；帧规格（5×5、每帧 400 像素、打字只播前 5 帧）；每个包不超过约 1 MB。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../core/hub-pet/role-packs');
const { compareVersion } = require('../core/appearance-packs');

const DIR = path.join(__dirname, '..', 'tools', 'hub-pet-packs');
const IDS = ['05-rabbit', '07-shiba', '09-hamster', '11-cockatiel'];
const FRAME = 400;

// 读 WebP 画布尺寸（VP8X / VP8 / VP8L 三种头）。
function webpSize(buf) {
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  throw new Error('未知 WebP 头 ' + kind);
}

const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));

// 目录顶层版本随后续新形象升高（r49b 加拟人形象后为 1.2.0），这里只核对这 4 个形象仍在、仍是 1.1.0。
test('目录能过客户端校验，4 个形象都在且是 1.1.0，顶层版本不低于 1.1.0', () => {
  R.validateCatalog(catalog);
  assert.ok(compareVersion(catalog.version, '1.1.0') >= 0);
  for (const id of IDS) assert.equal(catalog.packs.find(p => p.id === id)?.version, '1.1.0', id);
});

for (const id of IDS) {
  test(`${id} 1.1.0：字节数与哈希对得上，带打字与待机小动作序列，帧 400 像素`, () => {
    const entry = catalog.packs.find(p => p.id === id);
    const raw = fs.readFileSync(path.join(DIR, entry.file));
    assert.equal(raw.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), entry.sha256);
    assert.ok(raw.length <= 1.1 * 1024 * 1024, '单包不超过约 1 MB');
    const p = R.validatePack(JSON.parse(raw.toString('utf8')));
    assert.equal(p.id, id);
    assert.equal(p.version, '1.1.0');
    assert.deepEqual(p.meta.sequences, ['typing', 'idle-life']);
    assert.deepEqual(p.meta.clipped, { typing: Array.from({ length: 20 }, (_, i) => i + 5) });
    for (const pose of ['idle', 'typing', 'happy', 'sleep']) assert.deepEqual(webpSize(p.buffers[pose + '.webp']), [FRAME, FRAME], pose);
    for (const seq of ['typing', 'idle-life']) assert.deepEqual(webpSize(p.buffers[`seq-${seq}.webp`]), [FRAME * 5, FRAME * 5], seq);
  });
}
