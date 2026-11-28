'use strict';
// 隔离守卫判定（2026-11-28 事故后加）：子进程命令行用到生产数据目录、或 renderer 的 userData 不在隔离目录下就判违规。合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { violation } = require('./helpers/isolation-guard');
const B = String.fromCharCode(92);
const win = (...parts) => parts.join(B);
const prodDirs = [win('c:', 'users', 'u', 'appdata', 'roaming', 'ai-hub-community'), win('c:', 'users', 'u', '.ai-hub-community')];
const prodUserData = win('C:', 'Users', 'u', 'AppData', 'Roaming', 'ai-hub-community');
const isoElsewhere = win('D:', 'Temp', 'x');

test('正常隔离：renderer 的 userData 在隔离目录下，不报', () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const ud = path.join(iso, 'data', 'electron-userdata'); fs.mkdirSync(ud, { recursive: true });
  const procs = [{ pid: 10, ppid: 1, cmd: '"hub.exe" app --remote-debugging-port=1' },
    { pid: 11, ppid: 10, cmd: `"hub.exe" --type=renderer --user-data-dir="${ud}" --app-user-model-id=x` }];
  assert.equal(violation({ rootPid: 10, isolatedRoot: iso, procs, prodDirs }), '');
  fs.rmSync(iso, { recursive: true, force: true });
});

test('子进程用到生产 userData（这次事故的现场）：报违规', () => {
  const procs = [{ pid: 10, ppid: 1, cmd: '"hub.exe" probe.js' },
    { pid: 11, ppid: 10, cmd: `"hub.exe" --type=crashpad-handler --user-data-dir=${prodUserData} /prefetch` }];
  assert.match(violation({ rootPid: 10, isolatedRoot: isoElsewhere, procs, prodDirs }), /生产数据目录/);
});

test('命令行出现 .ai-hub-community（斜杠写法也认）：报违规；不是它子进程的生产 Hub 不算', () => {
  const procs = [{ pid: 10, ppid: 1, cmd: '"hub.exe" app' }, { pid: 12, ppid: 10, cmd: 'x C:/Users/u/.ai-hub-community/avatar' }];
  assert.match(violation({ rootPid: 10, isolatedRoot: isoElsewhere, procs, prodDirs }), /生产数据目录/);
  const prodRenderer = { pid: 99, ppid: 5, cmd: `"hub.exe" --type=renderer --user-data-dir=${prodUserData}` };
  assert.equal(violation({ rootPid: 10, isolatedRoot: isoElsewhere, procs: [procs[0], prodRenderer], prodDirs }), '');
});

test('renderer 的 userData 在别处（非生产、非隔离）：同样报', () => {
  const procs = [{ pid: 10, ppid: 1, cmd: 'hub.exe' }, { pid: 11, ppid: 10, cmd: `hub.exe --type=renderer --user-data-dir="${win('E:', 'other', 'ud')}"` }];
  assert.match(violation({ rootPid: 10, isolatedRoot: isoElsewhere, procs, prodDirs }), /不在隔离目录下/);
});
