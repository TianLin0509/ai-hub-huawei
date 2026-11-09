'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { logStartupBlock } = require('../core/group-chat-watcher.js');

test('启动被挡住时把屏幕文字记进本地日志，路径打码', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-block-'));
  const makeScreen = () => ({ write() {}, dispose() {}, lines: async () => ['Some new prompt at D:/work/x', '', '> Accept'] });
  await logStartupBlock('abcdefghijkl', 'cli-not-ready', 'x', { dataDir, makeScreen });
  const row = JSON.parse(fs.readFileSync(path.join(dataDir, 'logs', 'codeagent-startup-blocks.log'), 'utf8'));
  assert.equal(row.session, 'abcdefgh');
  assert.deepEqual(row.lines, ['Some new prompt at <PATH>', '> Accept']);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('记录失败不抛错，不影响发送结果', async () => {
  await assert.doesNotReject(logStartupBlock('a', 'r', 'x', { dataDir: 'unused', makeScreen: () => { throw new Error('boom'); } }));
});
