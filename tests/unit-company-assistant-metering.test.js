'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeUsageLedger } = require('../core/session-token-usage');
const { TaskMetering, usageDelta, creditDelta, readLedger, cleanup } = require('../core/company-assistant/metering');
const { summarize } = require('../scripts/company-assistant-metering-summary');
const row = (id, n) => ({ type: 'assistant', message: { id, usage: { input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n } } });
function usage(...rows) { const ledger = new ClaudeUsageLedger(); rows.forEach(r => ledger.accept(r)); return { ledger, compact: 0 }; }
test('累计所有响应，重复和旧快照不重复计数', () => {
  assert.deepEqual(usageDelta(usage(row('old', 4)), usage(row('old', 4), row('a', 2), row('a', 1), row('b', 3))).value,
    { input: 15, output: 5, cached: 5, cacheWrite: 5, total: 20 });
});
test('全零或混有零 usage 不作为零消耗', () => {
  assert.equal(usageDelta(usage(), usage(row('a', 0))).reason, 'usage-zero');
  assert.equal(usageDelta(usage(), usage(row('a', 0), row('b', 2))).value, null);
});
test('Credit 换档和重置不可归属', () => {
  assert.equal(creditDelta({ bucket: '月度', total: 20000, remaining: 3 }, { bucket: '今日忙时', total: 2500, remaining: 2 }).reason, 'credit-tier-changed');
  assert.equal(creditDelta(null, null).value, null);
});
test('读取失败、压缩标记、14 个日期清理和只读汇总', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-meter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(readLedger(path.join(dir, 'missing'), 10));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, JSON.stringify(row('old', 1)) + '\n');
  const meter = new TaskMetering(dir, { getSession: () => ({ transcriptPath: file, currentModel: { id: 'test-model' } }), readTerminalScreen: () => { throw new Error('private'); } }, () => Date.parse('2026-11-03T12:00:00+08:00'));
  const job = { id: 'task', type: 'chat', sessionId: 'session' };
  meter.begin(job);
  await job.meterBefore;
  fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n' + JSON.stringify(row('new', 2)) + '\n');
  await meter.finish(job, 'success'); meter.finish(job, 'failure');
  const report = await summarize(dir);
  assert.equal(report.groups[0].tasks, 1);
  assert.equal(report.groups[0].compacted, 1);
  assert.equal(report.groups[0].total, 8);
  assert.equal(report.groups[0].contextChange, null);
  fs.writeFileSync(path.join(dir, 'metering-2026-10-20.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'metering-2026-10-21.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'brief-2026-10-20.json'), '{}');
  await cleanup(dir, Date.parse('2026-11-03T12:00:00+08:00'));
  assert.equal(fs.existsSync(path.join(dir, 'metering-2026-10-20.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dir, 'metering-2026-10-21.jsonl')), true);
  assert.equal(fs.existsSync(path.join(dir, 'brief-2026-10-20.json')), true);
});
test('读取失败仍写失败任务和不可得原因，不泄漏异常内容', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-meter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meter = new TaskMetering(dir, { getSession: () => { throw new Error('private secret'); } }, () => Date.parse('2026-11-03T12:00:00+08:00'));
  const job = { id: 'failed', type: 'brief' };
  await meter.finish(job, 'failure');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'metering-2026-11-03.jsonl'), 'utf8'));
  assert.equal(record.result, 'failure');
  assert.equal(record.tokens, null);
  assert.equal(record.compacted, null);
  assert.equal(record.reasons.tokens, 'transcript-unavailable');
  assert.equal(JSON.stringify(record).includes('secret'), false);
});
test('顶层 hook 证据在历史不可读时仍标记压缩', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-meter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meter = new TaskMetering(dir, { getSession: () => null }, () => Date.parse('2026-11-03T12:00:00+08:00'));
  await meter.finish({ id: 'compact', type: 'chat', meterCompacted: true }, 'success');
  const report = await summarize(dir);
  assert.equal(report.groups[0].compacted, 1);
  assert.equal(report.groups[0].total, null);
});

async function scenario(t, initial, change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-incremental-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  const meta = { transcriptPath: file };
  if (initial !== null) fs.writeFileSync(file, initial);
  const meter = new TaskMetering(dir, { getSession: () => meta }, () => Date.parse('2026-11-03T04:00:00Z'));
  const job = { id: 'incremental', type: 'brief', sessionId: 'session' };
  meter.begin(job);
  await job.meterBefore;
  await change(file, meta, meter, job);
  await meter.finish(job, 'success');
  return JSON.parse(fs.readFileSync(path.join(dir, 'metering-2026-11-03.jsonl'), 'utf8'));
}
const jsonl = r => JSON.stringify(r) + '\n';

test('large history is read once and only appended bytes are parsed, with cross-task ID deduplication', async t => {
  const history = jsonl({ type: 'user', text: 'x'.repeat(1024) }).repeat(32768) + jsonl(row('shared', 3));
  let bytes = 0;
  const record = await scenario(t, history, async file => {
    const original = fs.createReadStream;
    fs.createReadStream = (...args) => {
      const stream = original(...args);
      stream.on('data', chunk => { bytes += chunk.length; });
      return stream;
    };
    t.after(() => { fs.createReadStream = original; });
    fs.appendFileSync(file, jsonl(row('shared', 3)) + jsonl(row('shared', 5)) + jsonl(row('new', 2)));
  });
  assert.equal(record.tokens.total, 16);
  assert.equal(record.reasons.tokens, null);
  assert.ok(bytes < 2048, `incremental bytes: ${bytes}`);
});

test('first task uses an empty baseline when transcript does not exist', async t => {
  const record = await scenario(t, null, file => fs.writeFileSync(file, jsonl(row('first', 2))));
  assert.equal(record.tokens.total, 8);
});

test('first task uses an empty baseline when transcript is not bound', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-unbound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = {};
  const meter = new TaskMetering(dir, { getSession: () => meta }, () => Date.parse('2026-11-03T04:00:00Z'));
  const job = { id: 'first', sessionId: 'session', type: 'brief' };
  meter.begin(job);
  meta.transcriptPath = path.join(dir, 'new.jsonl');
  fs.writeFileSync(meta.transcriptPath, jsonl(row('first', 2)));
  await meter.finish(job, 'success');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'metering-2026-11-03.jsonl'), 'utf8'));
  assert.equal(record.tokens.total, 8);
});

test('replaced transcript is incomparable even at the same path', async t => {
  const record = await scenario(t, jsonl(row('old', 1)), file => {
    fs.renameSync(file, file + '.old');
    fs.writeFileSync(file, jsonl(row('new', 4)));
  });
  assert.equal(record.tokens, null);
  assert.equal(record.reasons.tokens, 'transcript-unavailable');
});

test('changing transcript path is incomparable', async t => {
  const record = await scenario(t, jsonl(row('old', 1)), (file, meta) => {
    meta.transcriptPath = file + '.new';
    fs.writeFileSync(meta.transcriptPath, jsonl(row('new', 4)));
  });
  assert.equal(record.tokens, null);
  assert.equal(record.reasons.tokens, 'transcript-unavailable');
});


test('stalled reads retain an explicit timeout reason in the task record', async t => {
  const record = await scenario(t, '', file => {
    fs.appendFileSync(file, jsonl(row('new', 1)));
    const original = fs.createReadStream;
    fs.createReadStream = () => new (require('node:stream').PassThrough)();
    t.after(() => { fs.createReadStream = original; });
  });
  assert.equal(record.tokens, null);
  assert.equal(record.reasons.tokens, 'transcript-read-timeout');
});
