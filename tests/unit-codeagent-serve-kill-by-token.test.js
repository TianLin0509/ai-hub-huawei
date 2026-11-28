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

test('killByTokenInBackground: hidden powershell, exact token, refuses bad tokens', { skip: process.platform !== 'win32' }, () => {
  const spawned = [];
  const spawnImpl = (file, args, opts) => { spawned.push({ file, args, opts }); return { unref() {} }; };
  assert.equal(serve.killByTokenInBackground(TOKEN, { spawnImpl }), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, 'powershell.exe');
  assert.equal(spawned[0].opts.windowsHide, true);
  assert.ok(spawned[0].args.at(-1).includes(`--token ${TOKEN}`));
  assert.match(spawned[0].args.at(-1), /Name <> 'powershell\.exe'/);
  for (const bad of ['', 'abc', "x' OR 1=1"]) assert.equal(serve.killByTokenInBackground(bad, { spawnImpl }), false);
  assert.equal(spawned.length, 1);
});

test('shared serve host: stop / stopSync also clean up by its own token (outer cmd already gone)', async () => {
  const { ServeHost } = require('../core/codeagent-serve-host');
  const orig = { killTree: serve.killTree, portOwner: serve.portOwner, killServeSync: serve.killServeSync, killByToken: serve.killByToken, killByTokenInBackground: serve.killByTokenInBackground };
  const seen = [];
  Object.assign(serve, {
    killTree: async () => {}, portOwner: async () => null, killServeSync: () => {},
    killByToken: async t => { seen.push(['async', t]); return []; },
    killByTokenInBackground: t => { seen.push(['bg', t]); return true; },
  });
  try {
    const mk = token => Object.assign(new ServeHost({ configDir: 'x', jobQos: () => ({ terminate: async () => null }) }), { proc: { pid: 1 }, port: 2, token });
    await mk(TOKEN).stop();
    mk('cd'.repeat(32)).stopSync();
    const idle = mk(TOKEN); idle.proc = null; idle.stopSync();
    assert.deepEqual(seen, [['async', TOKEN], ['bg', 'cd'.repeat(32)]]);
  } finally { Object.assign(serve, orig); }
});

test('different tokens never match each other', { skip: process.platform !== 'win32' }, async () => {
  const a = 'ab'.repeat(32), b = 'cd'.repeat(32), queries = [];
  const runner = async (_file, args) => { queries.push(args.at(-1)); return { stdout: '' }; };
  await serve.killByToken(a, { runner, kill: async () => {} });
  await serve.killByToken(b, { runner, kill: async () => {} });
  assert.ok(queries[0].includes(`--token ${a}`) && !queries[0].includes(b));
  assert.ok(queries[1].includes(`--token ${b}`) && !queries[1].includes(a));
});
