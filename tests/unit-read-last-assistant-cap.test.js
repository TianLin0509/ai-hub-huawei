'use strict';
// 2026-11-06 CodeAgent 性能盘点「读最后一条回答加上限」：异步版照同步版只读文件尾部 4MB，超长行不再按平方变慢；
// 同一回合 Stop hook 和回合结束事件各读一次时，文件没变就共用一次读取。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLastAssistantMessage, readLastAssistantModelSync, MAX_TAIL_BYTES } = require('../core/read-last-assistant');

const assistant = (text, model = 'glm-5') => JSON.stringify({ type: 'assistant', uuid: 'a-' + text.length, timestamp: '2026-11-07T08:00:00Z',
  message: { model, stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n';
const user = text => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-last-assistant-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

test('汉字跨 64KB 读块边界时仍能读出完整的最后一条回答', async t => {
  const answer = '结论：' + '调度权重按比例公平'.repeat(12000);
  const file = tempFile(t, user('问') + assistant(answer) + user('x'.repeat(70000)));
  const last = await readLastAssistantMessage(file);
  assert.equal(last.text, answer);
  assert.equal(last.model, 'glm-5');
  assert.equal(readLastAssistantModelSync(file), 'glm-5');
});

test('只读文件尾部 4MB：再往前的回答不读（异步版与同步版一致）', async t => {
  const filler = user('y'.repeat(1024 * 1024)).repeat(5);
  const file = tempFile(t, assistant('很早的回答') + filler);
  assert.equal(MAX_TAIL_BYTES, 4 * 1024 * 1024);
  assert.equal(await readLastAssistantMessage(file), null);
  assert.equal(readLastAssistantModelSync(file), '');
  const wide = await readLastAssistantMessage(file, { maxBytes: 8 * 1024 * 1024 });
  assert.equal(wide.text, '很早的回答');
});

test('尾部一整行 3MB 的工具输出：不按平方变慢', async t => {
  const file = tempFile(t, assistant('工具前的回答') + user('z'.repeat(3 * 1024 * 1024)));
  const started = Date.now();
  const last = await readLastAssistantMessage(file);
  assert.equal(last.text, '工具前的回答');
  assert.ok(Date.now() - started < 2000, `用了 ${Date.now() - started}ms`);
});

test('同一回合读两次：文件没变就共用一次读取，文件变了才重读', async t => {
  const file = tempFile(t, user('问') + assistant('第一版'));
  const realOpen = fs.promises.open;
  let opens = 0;
  fs.promises.open = (...args) => { opens += 1; return realOpen.apply(fs.promises, args); };
  t.after(() => { fs.promises.open = realOpen; });
  const [a, b] = await Promise.all([readLastAssistantMessage(file), readLastAssistantMessage(file)]);
  assert.equal(a.text, '第一版');
  assert.equal(b.text, '第一版');
  assert.notEqual(a, b, '各拿一份，互不影响');
  assert.equal((await readLastAssistantMessage(file)).text, '第一版');
  assert.equal(opens, 1);
  fs.appendFileSync(file, assistant('第二版，更长一些'));
  assert.equal((await readLastAssistantMessage(file)).text, '第二版，更长一些');
  assert.equal(opens, 2);
});
