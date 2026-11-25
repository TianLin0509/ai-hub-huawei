'use strict';
const { box } = require('../../core/company-assistant/meeting-mp4-index');
const { ebmlElement: e, uintElement: u } = require('../../core/company-assistant/meeting-webm-duration');
function mp4Fixture({ version = 0, absolute = false, baseZero = false } = {}) {
  const mvhd = Buffer.alloc(version ? 112 : 100); mvhd[0] = version; mvhd.writeUInt32BE(1000, version ? 20 : 12);
  const tkhd = Buffer.alloc(version ? 96 : 84); tkhd[0] = version; tkhd.writeUInt32BE(1, version ? 20 : 12);
  const mdhd = Buffer.alloc(version ? 36 : 24); mdhd[0] = version; mdhd.writeUInt32BE(1000, version ? 20 : 12);
  const trex = Buffer.alloc(24); trex.writeUInt32BE(1, 4);
  const stbl = box('stbl', box('stco', Buffer.alloc(8)));
  const head = Buffer.concat([box('ftyp', Buffer.from('isom0000isom')), box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', Buffer.concat([box('mdhd', mdhd), box('minf', stbl)]))])), box('mvex', box('trex', trex))]))]);
  const fragments = []; let at = head.length;
  for (let n = 0; n < 3; n++) {
    const tfhd = Buffer.alloc(absolute ? 16 : 8); tfhd.writeUInt32BE(absolute ? 1 : 0x20000); tfhd.writeUInt32BE(1, 4); if (absolute) tfhd.writeBigUInt64BE(BigInt(baseZero ? 0 : at), 8);
    const tfdt = Buffer.alloc(version ? 12 : 8); tfdt[0] = version; if (version) tfdt.writeBigUInt64BE(BigInt(n * 1000), 4); else tfdt.writeUInt32BE(n * 1000, 4);
    const trun = Buffer.alloc(12 + 24); trun.writeUInt32BE(0x701); trun.writeUInt32BE(2, 4);
    for (let i = 0; i < 2; i++) { trun.writeUInt32BE(500, 12 + i * 12); trun.writeUInt32BE(4, 16 + i * 12); trun.writeUInt32BE(i ? 0x1010000 : 0x2000000, 20 + i * 12); }
    let moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt), box('trun', trun)])));
    trun.writeInt32BE(moof.length + 8 + (baseZero ? at : 0), 8); moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt), box('trun', trun)])));
    const data = Buffer.concat([moof, box('mdat', Buffer.alloc(8, n + 1))]); fragments.push(data); at += data.length;
  }
  return Buffer.concat([head, ...fragments]);
}
function webmFixture({ group = false, finite = false, scale = 1000000 } = {}) {
  const info = e(0x1549a966, u(0x2ad7b1, scale)), tracks = e(0x1654ae6b, e(0xae, Buffer.concat([u(0xd7, 1), u(0x83, 1)])));
  const clusters = [];
  for (let n = 0; n < 3; n++) {
    const block = Buffer.from([0x81, 0, 0, group ? 0 : 0x80, 1, 2, 3]);
    const body = Buffer.concat([u(0xe7, n * 1000), group ? e(0xa0, e(0xa1, block)) : e(0xa3, block)]);
    clusters.push(finite ? e(0x1f43b675, body) : Buffer.concat([Buffer.from('1f43b67501ffffffffffffff', 'hex'), body]));
  }
  const body = Buffer.concat([info, tracks, ...clusters]);
  return Buffer.concat([e(0x1a45dfa3, Buffer.alloc(0)), finite ? e(0x18538067, body) : Buffer.concat([Buffer.from('1853806701ffffffffffffff', 'hex'), body])]);
}
module.exports = { mp4Fixture, webmFixture };
