'use strict';
// 权限模式落盘（2026-11-20 二期自测发现）：会话文件白名单漏了 permissionMode，从会话文件恢复会变回完全放开。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('会话文件落盘保留 permissionMode（漏了它，从会话文件恢复会悄悄变回完全放开）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-store-'));
  const before = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = dir;
  try {
    const store = require('../core/session-store');
    store.saveSessionFile('perm-store-1', { hubId: 'perm-store-1', kind: 'codex', cwd: dir, permissionMode: 'default' });
    store.saveSessionFile('perm-store-2', { hubId: 'perm-store-2', kind: 'claude', cwd: dir });
    assert.equal(store.loadSessionFile('perm-store-1').permissionMode, 'default');
    assert.equal(store.loadSessionFile('perm-store-2').permissionMode, null);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
