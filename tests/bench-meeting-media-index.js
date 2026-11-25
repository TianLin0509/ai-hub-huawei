'use strict';
// Optional 1-hour, 1+ GB structural fixtures (not encoded video). No codec execution.
// Run as a separate Node process so maxRSS measures the repair rather than the test runner.
const fs = require('node:fs/promises'), path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { mp4Fixture, webmFixture } = require('./helpers/meeting-media-fixtures');
const { boxes, fixMp4Index } = require('../core/company-assistant/meeting-mp4-index');
const { fixWebmDuration, element, ebmlElement: e, uintElement: u, sizeBytes } = require('../core/company-assistant/meeting-webm-duration');
const io = require('../core/company-assistant/meeting-media-io');
async function build(file, type, count, payload) {
  const fd = await fs.open(file, 'w'); let at = 0;
  try {
    if (type === 'mp4') {
      const b = mp4Fixture(), fields = boxes(b), first = fields.find(x => x.type === 'moof'), head = b.subarray(0, first.at), original = b.subarray(first.at, first.end); await io.write(fd, head); at = head.length;
      for (let n = 0; n < count; n++) {
        const moof = Buffer.from(original), traf = boxes(moof, 8, moof.length)[0], tfdt = boxes(moof, traf.start, traf.end).find(x => x.type === 'tfdt'); moof.writeUInt32BE(n * 1000, tfdt.start + 4);
        await fd.write(moof, 0, moof.length, at); at += moof.length;
        const h = Buffer.alloc(8); h.writeUInt32BE(payload + 8); h.write('mdat', 4); await fd.write(h, 0, 8, at); at += payload + 8;
      }
    } else {
      const b = webmFixture(), seg = element(b, element(b, 0).end); let end = seg.start; while (element(b, end).id !== 0x1f43b675) end = element(b, end).end;
      const head = b.subarray(0, end); await io.write(fd, head); at = head.length;
      for (let n = 0; n < count; n++) {
        const time = u(0xe7, n * 1000), block = e(0xa3, Buffer.from([0x81, 0, 0, 0x80, 1, 2, 3])), padding = Buffer.concat([Buffer.from([0xec]), sizeBytes(payload, 8)]);
        const h = Buffer.concat([Buffer.from('1f43b675', 'hex'), sizeBytes(time.length + block.length + padding.length + payload, 8), time, block, padding]);
        await fd.write(h, 0, h.length, at); at += h.length + payload;
      }
    }
    await fd.truncate(at); await fd.sync(); return at;
  } finally { await fd.close(); }
}
(async () => {
  const out = path.resolve(process.argv[2] || 'artifacts/20261124-media-bench-m6'), type = process.argv[3] || 'mp4', count = 3600, payload = 320 * 1024; await fs.mkdir(out, { recursive: true });
  const file = path.join(out, '20261124-one-hour-m6.' + type), bytes = await build(file, type, count, payload), delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const initial = process.memoryUsage(), begin = performance.now(); let peak = initial.rss; const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  try {
    const resultBytes = type === 'mp4' ? await fixMp4Index(file) : await fixWebmDuration(file, 3600000);
    const result = { type, simulatedDurationSeconds: 3600, inputBytes: bytes, resultBytes, elapsedMs: performance.now() - begin, initialRss: initial.rss, peakRss: Math.max(peak, process.memoryUsage().rss), maxRssKiB: process.resourceUsage().maxRSS, heapUsed: process.memoryUsage().heapUsed, eventLoopP99Ms: delay.percentile(99) / 1e6 };
    await fs.writeFile(path.join(out, '20261124-benchmark-m6-' + type + '.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { clearInterval(timer); delay.disable(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
