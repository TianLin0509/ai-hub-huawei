'use strict';
// 无头 Edge 的登录状态副本（含 Cookie）不留在临时目录：退出时同步删，陈旧的下次启动前回收（2026-11-17 反馈）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sweepStale, STALE_PREFIXES } = require('../main/company-edge-browser');

test('只回收超过时限的 hub-posts- / hub-attendance- 目录，别的和新近的不动', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, ageMs) => {
    const full = path.join(dir, name); fs.mkdirSync(path.join(full, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(full, 'Default', 'Cookies'), 'x');
    const when = new Date(Date.now() - ageMs); fs.utimesSync(full, when, when);
    return full;
  };
  const oldPosts = make('hub-posts-old', 7 * 3600000), oldAtt = make('hub-attendance-old', 30 * 3600000);
  const fresh = make('hub-posts-fresh', 60000), other = make('someone-else', 30 * 3600000), kept = make('hub-posts-kept', 30 * 3600000);
  const removed = sweepStale({ dir, keep: kept, logger: {} });
  assert.equal(removed, 2);
  assert.equal(fs.existsSync(oldPosts), false);
  assert.equal(fs.existsSync(oldAtt), false);
  assert.ok(fs.existsSync(fresh) && fs.existsSync(other) && fs.existsSync(kept));
  assert.deepEqual(STALE_PREFIXES, ['hub-posts-', 'hub-attendance-']);
});

test('Hub 真正退出时走同步收尾（will-quit；before-quit 可能被会议页否决，不在那里关）', () => {
  const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  assert.match(main, /app\.on\('will-quit', \(\) => \{ try \{ companyForumEdge\.closeSync\(\); \}/);
  assert.doesNotMatch(main, /app\.on\('before-quit', \(\) => \{ (?:companyForumEdge|forumEdge)\.closeSync/);
  const src = fs.readFileSync(require.resolve('../main/company-edge-browser.js'), 'utf8');
  assert.match(src, /closeSync: stopSync/);
});

// r38b 审查 P1：在用的副本一个文件都不能删。旧做法直接递归删，碰到被锁的 Cookie 前已经把没锁的 Preferences 删掉了。
function makeProfile(dir, name, ageMs = 7 * 3600000) {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, '00-preferences.txt'), 'active profile important file');
  fs.writeFileSync(path.join(full, 'zz-cookies.db'), 'cookie placeholder');
  return full;
}
const age = (full, ms) => { const when = new Date(Date.now() - ms); fs.utimesSync(full, when, when); };

test('建它的 Hub 进程还活着：陈旧也不动；进程已退：回收', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sweep-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = makeProfile(dir, 'hub-posts-live'), dead = makeProfile(dir, 'hub-attendance-dead');
  const { markOwner } = require('../main/company-attendance-edge');
  markOwner(live, process.pid);
  const gone = require('node:child_process').spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(gone.status, 0);
  markOwner(dead, gone.pid);
  age(live, 30 * 3600000); age(dead, 30 * 3600000);
  assert.equal(sweepStale({ dir, logger: {} }), 1);
  assert.ok(fs.existsSync(path.join(live, '00-preferences.txt')) && fs.existsSync(path.join(live, 'zz-cookies.db')));
  assert.equal(fs.existsSync(dead), false);
  assert.deepEqual(fs.readdirSync(dir), ['hub-posts-live']);
});

test('目录里有文件被别的进程独占：整个目录原样保留，没锁的重要文件也在', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-sweep-lock-'));
  const full = makeProfile(dir, 'hub-posts-active');
  age(full, 7 * 3600000);
  const locked = path.join(full, 'zz-cookies.db').replace(/'/g, "''");
  const holder = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `$s=[System.IO.File]::Open('${locked}','Open','ReadWrite','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 60; $s.Dispose()`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { holder.kill(); } catch { /* 已退 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PowerShell 没有锁上文件')), 30000);
    holder.stdout.on('data', d => { if (String(d).includes('locked')) { clearTimeout(timer); resolve(); } });
    holder.on('exit', () => { clearTimeout(timer); reject(new Error('PowerShell 提前退出')); });
  });
  age(full, 7 * 3600000);
  assert.equal(sweepStale({ dir, logger: {} }), 0);
  assert.ok(fs.existsSync(path.join(full, 'zz-cookies.db')), '被锁的 Cookie 在');
  assert.ok(fs.existsSync(path.join(full, '00-preferences.txt')), '没锁的 Preferences 也在');
  assert.deepEqual(fs.readdirSync(dir), ['hub-posts-active'], '没有留下改名后的半截目录');
  holder.kill();
  await new Promise(r => holder.once('exit', r));
  assert.equal(sweepStale({ dir, logger: {} }), 1, '放开后下次回收');
});
