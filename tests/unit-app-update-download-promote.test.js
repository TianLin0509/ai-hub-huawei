'use strict';
// 2026-11-16 用户反馈：更新包下好后改名报 EPERM（安全软件扫描新 exe 或旧同名安装包被占用）。
// 只在失败时重试；本机已有完整同名文件时直接用，不再下载。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { downloadWithFallback, promote, alreadyComplete } = require('../core/app-update/downloader.js');

const body = Buffer.from('x'.repeat(5000));
const expect = { file: 'AIHubHuawei-Setup-9.9.9.exe', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dl-promote-'));
const okFetch = calls => async () => { calls.push(1); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); };
const sources = [{ id: 'a', name: '源A', files: 'https://example.invalid/v{version}/' }];

test('本机已有大小和校验都对的同名文件：不再下载', async () => {
  const dir = tmp(), dest = path.join(dir, expect.file); fs.writeFileSync(dest, body);
  const calls = [];
  const r = await downloadWithFallback({ sources, version: '9.9.9', expect, dest, fetchImpl: okFetch(calls) });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.reused, true); assert.strictEqual(calls.length, 0);
});

test('同名文件内容不对：照常重新下载并覆盖', async () => {
  const dir = tmp(), dest = path.join(dir, expect.file); fs.writeFileSync(dest, 'old');
  const calls = [];
  const r = await downloadWithFallback({ sources, version: '9.9.9', expect, dest, fetchImpl: okFetch(calls) });
  assert.strictEqual(r.ok, true); assert.strictEqual(calls.length, 1); assert.ok(alreadyComplete(dest, expect));
});

test('改名第一次 EPERM、之后放开：重试成功', async () => {
  const dir = tmp(), dest = path.join(dir, expect.file), part = dest + '.part'; fs.writeFileSync(part, body);
  const real = fs.renameSync; let n = 0;
  fs.renameSync = (a, b) => { if (n++ === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return real(a, b); };
  try { await promote(part, dest, expect, { waitMs: 1 }); } finally { fs.renameSync = real; }
  assert.ok(alreadyComplete(dest, expect)); assert.ok(!fs.existsSync(part));
});

test('一直 EPERM：给出用户能照做的提示，不卡死', async () => {
  const dir = tmp(), dest = path.join(dir, expect.file), part = dest + '.part'; fs.writeFileSync(part, body);
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try { await assert.rejects(promote(part, dest, expect, { waitMs: 1 }), /安全软件|被占用/); } finally { fs.renameSync = real; }
});

test('其他错误（比如磁盘满）不重试，原样抛出', async () => {
  const dir = tmp(), dest = path.join(dir, expect.file), part = dest + '.part'; fs.writeFileSync(part, body);
  const real = fs.renameSync; let n = 0;
  fs.renameSync = () => { n++; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };
  try { await assert.rejects(promote(part, dest, expect, { waitMs: 1 }), /ENOSPC/); } finally { fs.renameSync = real; }
  assert.strictEqual(n, 1);
});
