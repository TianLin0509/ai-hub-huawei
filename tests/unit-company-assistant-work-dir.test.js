'use strict';
// 助理设置 ·「我的工作目录」（2026-11-19，管家 r38d 方案 A）：默认取最近一次新建会话的目录，可手动改；
// 助理会话的当前目录不变，只在提问里告诉它用户文件在哪。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CompanyAssistant } = require('../core/company-assistant/service');

function fixture(t, sessions = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-work-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'hub');
  const a = new CompanyAssistant({ dataDir, noTools: true, noTimer: true, bus: { latest: () => [] }, welinkRun: async () => ({ code: 0, stdout: '{}' }), getSession: () => null,
    getAllSessions: () => sessions.filter(s => s.live), listKnownSessions: () => sessions.filter(s => !s.live) });
  a.cli = () => ''; a.changed = () => {};
  return { a, root };
}

test('没设置、也没有会话：不写工作目录这一行（和以前一样）', t => {
  const { a } = fixture(t);
  assert.deepEqual(a.userWorkDir(), { path: '', from: '' });
  assert.equal(a.workDirLine(), '');
  assert.equal(a.status().workDir.path, '');
});

test('自动取最近一次新建的普通会话目录，跳过助理自己的会话和助理数据目录', t => {
  const sessions = [];
  const { a, root } = fixture(t, sessions);
  const older = path.join(root, 'older'), newer = path.join(root, 'newer');
  sessions.push(
    { id: '1', cwd: older, createdAt: 100, live: true },
    { id: '2', cwd: newer, createdAt: 300 },
    { id: '3', cwd: path.join(a.dir, 'workspace'), createdAt: 900, live: true },
    { id: '4', cwd: path.join(root, 'assistant'), createdAt: 800, purpose: 'company-assistant', live: true },
  );
  assert.deepEqual(a.userWorkDir(), { path: path.resolve(newer), from: 'recent' });
  assert.ok(a.workDirLine().startsWith('我的工作目录：' + path.resolve(newer)));
});

test('手动选的目录优先；改回空就重新跟随最近会话；不存在的目录拒绝', t => {
  const sessions = [];
  const { a, root } = fixture(t, sessions);
  const chosen = path.join(root, '我的 文件'); fs.mkdirSync(chosen);
  sessions.push({ id: '1', cwd: path.join(root, 'recent'), createdAt: 5, live: true });
  a.setSettings({ workDir: chosen });
  assert.deepEqual(a.userWorkDir(), { path: chosen, from: 'manual' });
  assert.throws(() => a.setSettings({ workDir: path.join(root, 'missing') }), /已存在的文件夹/);
  assert.throws(() => a.setSettings({ workDir: 'relative' }), /已存在的文件夹/);
  a.setSettings({ workDir: '' });
  assert.equal(a.userWorkDir().from, 'recent');
});

test('提问里带上工作目录，固定规则前缀不变（缓存命中不受影响）', t => {
  const sessions = [];
  const { a, root } = fixture(t, sessions);
  const before = a.composePrompt({ prompt: '你好', id: 'j1' }, 'desk');
  sessions.push({ id: '1', cwd: path.join(root, 'proj'), createdAt: 5, live: true });
  const after = a.composePrompt({ prompt: '你好', id: 'j2' }, 'desk');
  assert.ok(!before.includes('我的工作目录'));
  assert.ok(after.includes('我的工作目录：' + path.join(root, 'proj')));
  const head = s => s.slice(0, s.indexOf('当前时间（上海）'));
  assert.equal(head(after), head(before));
});

test('自动取到的目录只读：提问里说「可以读、不要写」；手动选的才说可以写（维护人 2026-11-19 拍板）', t => {
  const sessions = [];
  const { a, root } = fixture(t, sessions);
  sessions.push({ id: '1', cwd: path.join(root, 'proj'), createdAt: 5, live: true });
  const auto = a.workDirLine();
  assert.match(auto, /可以用完整路径读/);
  assert.match(auto, /不要往这里写文件/);
  assert.doesNotMatch(auto, /唯一可以写文件/);
  const chosen = path.join(root, 'mine'); fs.mkdirSync(chosen);
  a.setSettings({ workDir: chosen });
  const manual = a.workDirLine();
  assert.match(manual, /唯一可以写文件的位置/);
  assert.doesNotMatch(manual, /不要往这里写/);
});

test('手动选的目录被删后不再注入，也不悄悄换成最近会话的目录', t => {
  const sessions = [];
  const { a, root } = fixture(t, sessions);
  sessions.push({ id: '1', cwd: path.join(root, 'proj'), createdAt: 5, live: true });
  const chosen = path.join(root, 'gone'); fs.mkdirSync(chosen);
  a.setSettings({ workDir: chosen });
  fs.rmdirSync(chosen);
  assert.equal(a.userWorkDir().path, '');
  assert.equal(a.userWorkDir().from, 'manual-missing');
  assert.equal(a.workDirLine(), '');
  assert.ok(!a.composePrompt({ prompt: '你好', id: 'j3' }, 'desk').includes('我的工作目录'));
});
