'use strict';
// 临时 serve 没按时就绪时，外层 cmd 已断开、serve 还没监听端口：按启动时的随机 token 兜底找到并结束它
// （2026-11-28 黄区真机：Hub 退出后残留 codeagentcli.exe serve 约 400 MB，1/4 次）。
const test = require('node:test');
const assert = require('node:assert/strict');
const serve = require('../core/codeagent-serve');

const TOKEN = 'ab'.repeat(32);

test('killByToken queries by the exact token, skips its own shell, and kills every match', { skip: process.platform !== 'win32' }, async () => {
  const calls = [], killed = [];
  const runner = async (file, args) => { calls.push([file, args]); return { stdout: '1234\r\n5678\r\n' }; };
  const pids = await serve.killByToken(TOKEN, { runner, kill: async pid => { killed.push(pid); } });
  assert.deepEqual(pids, [1234, 5678]);
  assert.deepEqual(killed, [1234, 5678]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  const query = calls[0][1].at(-1);
  assert.match(query, new RegExp(`--token ${TOKEN}`));
  assert.match(query, /Name <> 'powershell\.exe'/);
});

test('killByToken refuses anything that is not a long hex token (never a broad match)', async () => {
  let ran = false;
  const runner = async () => { ran = true; return { stdout: '1' }; };
  for (const bad of ['', 'abc', '*', "x' OR 1=1", 'g'.repeat(64)]) {
    assert.deepEqual(await serve.killByToken(bad, { runner, kill: async () => {} }), []);
  }
  assert.equal(ran, false);
});

test('no matches: nothing is killed', { skip: process.platform !== 'win32' }, async () => {
  const killed = [];
  const pids = await serve.killByToken(TOKEN, { runner: async () => ({ stdout: '' }), kill: async pid => killed.push(pid) });
  assert.deepEqual(pids, []);
  assert.deepEqual(killed, []);
});
