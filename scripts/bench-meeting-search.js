'use strict';
// node scripts/bench-meeting-search.js [--events 6000] [--meetings 30] [--output artifacts/...] [--reuse-data <本输出目录内的合成data>]
// 合成会议、真实存储公开API；不启动Hub、不使用模型或账号、不读取生产数据。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { searchMeetings } = require('../core/company-assistant/meeting-search');
const { MeetingCompanion } = require('../core/company-assistant/meeting');
const args = process.argv.slice(2), arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const count = Math.max(1, Math.min(100, Number(arg('meetings', 30)) || 30));
const eventCount = Math.max(1, Math.min(50000, Number(arg('events', 6000)) || 6000));
const output = path.resolve(arg('output', path.join(__dirname, '..', 'artifacts', '20261124-meeting-search-perf-m2')));
const reuse = arg('reuse-data', ''), data = reuse ? path.resolve(reuse) : path.join(output, 'data-' + randomUUID());
fs.mkdirSync(output, { recursive: true });
if (reuse) {
  const relative = path.relative(fs.realpathSync(output), fs.realpathSync(data));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('只可复用本输出目录内的合成会议');
} else fs.mkdirSync(data, { recursive: true });
const rows = [];
const measuredStores = new WeakMap();
function companion() { return new MeetingCompanion({ dir: data, workspace: data, changed() {} }, { powerSaveBlocker: false, meetingAsr: { close() {} } }); }
async function measure(store, label, query) {
  const timings = { listMs: 0, readMs: 0, listCalls: 0, readCalls: 0 };
  let state = measuredStores.get(store);
  if (!state) {
    state = { timings };
    state.wrapped = { list: async () => { const t = performance.now(); try { state.timings.listCalls++; return await store.list(); } finally { state.timings.listMs += performance.now() - t; } },
      load: async id => { const t = performance.now(); try { state.timings.readCalls++; return await (store.peek ? store.peek(id) : store.load(id)); } finally { state.timings.readMs += performance.now() - t; } } };
    if (store.changeMark) state.wrapped.changeMark = id => store.changeMark(id);
    if (store.listIds) state.wrapped.listIds = () => { const t = performance.now(); try { state.timings.listCalls++; return store.listIds(); } finally { state.timings.listMs += performance.now() - t; } };
    measuredStores.set(store, state);
  }
  state.timings = timings;
  const wrapped = state.wrapped;
  let last = performance.now(), maxHeartbeatGapMs = 0;
  const heartbeat = setInterval(() => { const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last); last = now; }, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  const start = performance.now(); let resumedAt = start, maxWorkSliceMs = 0;
  const yieldTurn = async () => {
    maxWorkSliceMs = Math.max(maxWorkSliceMs, performance.now() - resumedAt);
    await new Promise(resolve => setImmediate(resolve)); resumedAt = performance.now();
  };
  const result = await searchMeetings(wrapped, { query }, { yieldTurn }); const elapsedMs = performance.now() - start;
  const expected = query === 'OLLA 0.4' ? count * (1 + Math.ceil(eventCount / 307)) : count * (eventCount + 1);
  if (!result.ok || result.total !== expected) throw new Error(`${label}: 搜索范围不完整，预期${expected}实际${result.total}`);
  maxWorkSliceMs = Math.max(maxWorkSliceMs, performance.now() - resumedAt);
  await new Promise(resolve => setTimeout(resolve, 10)); clearInterval(heartbeat);
  const row = { label, query, elapsedMs, maxHeartbeatGapMs, maxWorkSliceMs, ...timings, total: result.total, returned: result.items.length, ok: result.ok };
  rows.push(row); return row;
}
async function main() {
  const writer = companion();
  for (let i = 0; !reuse && i < count; i++) {
    const m = { id: randomUUID(), title: `合成算法周会 ${i + 1}`, state: 'finished', startedAt: Date.parse('2026-11-24T09:00:00+08:00') - i * 86400000,
      summary: '- [D1] OLLA 步长0.4，切换门限待确认\n- [A1] 张工周五核对120兆降至110兆的原因', answers: [], events: [] };
    for (let j = 0; j < eventCount; j++) m.events.push({ kind: j % 1000 === 0 ? 'mark' : 'transcript', seq: j + 1, at: j * 500,
      text: `算法周会第${i + 1}场事件${j + 1}：核对业务吞吐与用户体验，本轮保留32个用户和3小区的配置，后续对照调度参数。${j % 307 === 0 ? ' OLLA 步长0.4，张工确认。' : ''}` });
    writer.save(m);
  }
  const cold = companion();
  await measure(cold, 'disk-cold-selective', 'OLLA 0.4');
  for (let i = 0; i < 3; i++) await measure(cold, `disk-warm-selective-${i + 1}`, 'OLLA 0.4');
  for (let i = 0; i < 3; i++) await measure(cold, `disk-warm-broad-${i + 1}`, '算法');
  const memory = { list: () => [...cold.list()], load: id => writer.load(id) };
  // 分离扫描成本：只从刚生成的独立存储加载一次到测试内存，绝不接触生产。
  const all = cold.list().map(row => cold.load(row.id)), byId = new Map(all.map(m => [m.id, m]));
  memory.load = id => byId.get(id);
  memory.changeMark = () => 'immutable-synthetic-fixture';
  for (let i = 0; i < 3; i++) await measure(memory, `memory-selective-${i + 1}`, 'OLLA 0.4');
  for (let i = 0; i < 3; i++) await measure(memory, `memory-broad-${i + 1}`, '算法');
  const report = { fixture: 'synthetic, real MeetingCompanion public list/load; no Hub/model', meetings: count, eventsPerMeeting: eventCount,
    cacheDefinition: 'cold = fresh MeetingCompanion and empty search projections; OS filesystem cache is not flushed',
    sourceSha: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    productHashes: Object.fromEntries(['core/company-assistant/meeting-search.js', 'core/company-assistant/meeting.js', 'core/company-assistant/hub-tools.js', 'core/company-assistant/mcp.js'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex')])),
    runtimeStoreMethods: ['listIds', 'peek', 'changeMark'].filter(key => typeof cold[key] === 'function'), rows, data };
  const file = path.join(output, '20261124-meeting-search-performance-m2.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ file, rows }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
