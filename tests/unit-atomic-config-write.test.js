'use strict';
// 配置文件原子写：写到一半失败不破坏原文件；主配置损坏时回退 .bak。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('../core/atomic-write');

test('写临时文件失败（磁盘满）：原文件内容不变，不留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"a":1}');
  const failing = { ...fs, writeFileSync(f, ...r) { if (String(f).endsWith('.tmp')) { fs.writeFileSync(f, '{"a'); throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } return fs.writeFileSync(f, ...r); }, renameSync: fs.renameSync, rmSync: fs.rmSync };
  assert.throws(() => writeFileAtomic(failing, file, '{"a":2}'), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('成功写入后内容是新的，backup 留下旧内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"a":1}');
  writeFileAtomic(fs, file, '{"a":2}', { backup: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak']);
});

test('只有 writeFileSync 的替身 fs 仍可用（退回直接写）', () => {
  const calls = [];
  writeFileAtomic({ writeFileSync: (f, t) => calls.push([f, t]) }, 'x.json', 'T');
  assert.deepEqual(calls, [['x.json', 'T']]);
});

test('hub-config：saveConfig 原子写并留 .bak，主文件损坏时 loadConfigJson 回退 .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubcfg-'));
  process.env.CLAUDE_HUB_DATA_DIR = dir; delete process.env.CLAUDE_PROXY;
  const cfg = require('../core/hub-config');
  cfg.saveConfig({ acp: { v: 1 } });
  cfg.saveConfig({ acp: { v: 2 } });
  fs.writeFileSync(path.join(dir, 'config.json'), ''); // 模拟写到一半被截断
  cfg.clearConfigCache?.();
  assert.equal(cfg.getConfig().acp.v, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json.bak'), 'utf8')).acp.v, 1);
});
