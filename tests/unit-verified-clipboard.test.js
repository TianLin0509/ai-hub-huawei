'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerifiedClipboardWriter } = require('../core/verified-clipboard');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('clipboard held for 500 ms recovers without another user copy', async () => {
  let elapsed = 0; let stored = 'old';
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { if (elapsed < 500) throw new Error('clipboard busy'); stored = text; }, readText: () => stored },
    wait: async ms => { elapsed += ms; },
  });
  const result = await write('remote copy');
  assert.equal(result.ok, true);
  assert.equal(stored, 'remote copy');
  assert.ok(elapsed < 2000, 'recovery must remain bounded');
});

test('main writer retries busy and silently dropped writes before acknowledging', async () => {
  let stored = 'old'; let writes = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: {
      writeText(text) { if (++writes === 1) throw new Error('busy'); if (writes === 3) stored = text; },
      readText: () => stored,
    }, wait: async () => {},
  });
  const result = await write('中文\r\n🙂');
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(stored, '中文\r\n🙂');
});

test('all callers share latest-copy priority, including during readback', async () => {
  let stored = ''; const pending = [];
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { stored = text; }, readText: () => stored },
    wait: () => new Promise(resolve => pending.push(resolve)),
  });
  const first = write('older window');
  const last = write('latest window');
  pending.shift()();
  assert.equal((await first).reason, 'superseded');
  pending.shift()();
  assert.equal((await last).ok, true);
  assert.equal(stored, 'latest window');
});

test('a late retry cannot overwrite a newer copy from another caller', async () => {
  let stored = 'before'; let resume; let oldWrites = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { if (text !== 'old' || ++oldWrites > 1) stored = text; }, readText: () => stored },
    wait: ms => ms ? new Promise(resolve => { resume = resolve; }) : Promise.resolve(),
    retryDelaysMs: [0, 1],
  });
  const first = write('old'); await tick();
  assert.equal((await write('new')).ok, true);
  resume();
  assert.equal((await first).reason, 'superseded');
  assert.equal(stored, 'new');
  assert.equal(oldWrites, 1);
});

test('permanent failure and missing readback never claim success', async () => {
  for (const clipboard of [{ writeText() {} }, { writeText() {}, readText: () => 'wrong' }]) {
    const write = createVerifiedClipboardWriter({ clipboard, wait: async () => {} });
    assert.equal((await write('wanted')).ok, false);
  }
});

test('screenshot invalidates old text retries and yields to newer text copies', async () => {
  let stored = ''; const pending = [];
  const write = createVerifiedClipboardWriter({ clipboard: { writeText(text) { stored = text; }, readText: () => stored },
    wait: () => new Promise(resolve => pending.push(resolve)) });
  const old = write('old');
  const screenshotIsCurrent = write.beginExternalWrite();
  pending.shift()();
  assert.equal((await old).reason, 'superseded');
  assert.equal(screenshotIsCurrent(), true);
  const next = write('new');
  assert.equal(screenshotIsCurrent(), false);
  pending.shift()();
  assert.equal((await next).ok, true);
});

test('native copy preserves HTML alongside the verified plain text', async () => {
  let payload;
  const write = createVerifiedClipboardWriter({ clipboard: {
    writeText() { assert.fail('rich copy must preserve both formats'); },
    write(value) { payload = value; }, readText: () => payload.text,
  }, wait: async () => {} });
  assert.equal((await write('bold', { html: '<strong>bold</strong>' })).ok, true);
  assert.deepEqual(payload, { text: 'bold', html: '<strong>bold</strong>' });
});

test('a manual copy keeps retrying for seconds while another program holds the clipboard', async () => {
  let elapsed = 0; let stored = 'old';
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { if (elapsed < 4000) throw new Error('clipboard busy'); stored = text; }, readText: () => stored },
    wait: async ms => { elapsed += ms; },
  });
  const result = await write('held by remote desktop');
  assert.equal(result.ok, true);
  assert.equal(stored, 'held by remote desktop');
  assert.ok(elapsed < 6000, 'still bounded; never locks the clipboard');
});

test('a newer copy from another program during readback is never overwritten', async () => {
  let stored = 'before'; let writes = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: {
      // Our write is silently dropped, and meanwhile the user copies something else elsewhere.
      writeText() { writes++; stored = 'copied in another app'; },
      readText: () => stored,
    }, wait: async () => {},
  });
  const result = await write('hub copy');
  assert.equal(result.reason, 'superseded');
  assert.equal(result.external, true);
  assert.equal(writes, 1, 'no retry after a newer external copy');
  assert.equal(stored, 'copied in another app');
});

test('image writes share the retry rhythm and yield to newer copies', async () => {
  let tries = 0;
  const write = createVerifiedClipboardWriter({ clipboard: { writeText() {}, readText: () => '' }, wait: async () => {} });
  assert.deepEqual(await write.retry(() => ++tries >= 3), { ok: true });
  const isCurrent = write.beginExternalWrite();
  write('newer text');
  assert.equal((await write.retry(() => false, isCurrent)).reason, 'superseded');
});

test('empty reads while another program holds the clipboard are not mistaken for a newer copy', async () => {
  let locked = true; let stored = 'old content'; let ticks = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: {
      writeText(text) { if (!locked) stored = text; },
      readText: () => (locked ? '' : stored),
    },
    wait: async () => { if (++ticks > 4) locked = false; },
  });
  const result = await write('manual copy');
  assert.equal(result.ok, true);
  assert.equal(stored, 'manual copy');
});

// 2026-10-26 实测：ToDesk 在用户按 Ctrl+C 后约 0.3 秒把剪贴板改回复制前的旧内容。
test('a revert to the pre-copy content right after a copy is repaired', async () => {
  let stored = 'previous copy'; const repaired = [];
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { stored = text; }, readText: () => stored },
    wait: async () => {}, guardWait: async () => {}, revertGuardDelaysMs: [1, 1, 1],
    onRevertRepaired: info => repaired.push(info),
  });
  assert.equal((await write('selected text')).ok, true);
  stored = 'previous copy'; // 外部程序改回旧内容
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(stored, 'selected text');
  assert.equal(repaired.length, 1);
});

test('a genuinely new copy from another program still wins over the guard', async () => {
  let stored = 'previous copy';
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { stored = text; }, readText: () => stored },
    wait: async () => {}, guardWait: async () => {}, revertGuardDelaysMs: [1, 1, 1],
  });
  assert.equal((await write('selected text')).ok, true);
  stored = 'copied in another app';
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(stored, 'copied in another app');
});

test('the revert guard gives up after a bounded number of repairs', async () => {
  let stored = 'previous copy'; let writes = 0;
  const write = createVerifiedClipboardWriter({
    clipboard: { writeText(text) { writes++; stored = text; }, readText: () => { const v = stored; if (v === 'selected text' && writes > 1) stored = 'previous copy'; return v; } },
    wait: async () => {}, guardWait: async () => {}, revertGuardDelaysMs: Array(20).fill(1),
  });
  assert.equal((await write('selected text')).ok, true);
  stored = 'previous copy';
  for (let i = 0; i < 60; i++) await tick();
  assert.ok(writes <= 1 + 3, `writes=${writes}`);
});
