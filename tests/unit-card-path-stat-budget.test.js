'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('A2-10 statBudget 限制 collectPathCandidates 的同步磁盘查询次数', () => {
  const { collectPathCandidates } = require('../renderer/path-candidates.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-budget-'));
  const realExists = fs.existsSync, realStat = fs.statSync;
  let calls = 0;
  fs.existsSync = (...a) => { calls++; return realExists.apply(fs, a); };
  fs.statSync = (...a) => { calls++; return realStat.apply(fs, a); };
  try {
    const text = Array.from({ length: 500 }, (_, i) => `word${i}.txt sub/dir${i}/file${i}.md`).join(' ');
    calls = 0;
    collectPathCandidates(text, cwd, { statBudget: { remaining: 64 } });
    const limited = calls;
    calls = 0;
    collectPathCandidates(text, cwd, {});
    const unlimited = calls;
    assert.ok(limited <= 64, `有预算时查询 ${limited} 次`);
    assert.ok(unlimited > 200, `无预算对照 ${unlimited} 次`);
  } finally {
    fs.existsSync = realExists; fs.statSync = realStat;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('A2-10 卡片包装路径时带预算并跳过代码块', () => {
  const root = path.join(__dirname, '..', 'renderer');
  const r = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(r, /statBudget: opts\.statBudget \|\| \{ remaining: 64 \}/);
  const t = fs.readFileSync(path.join(root, 'turn-card-renderer.js'), 'utf8');
  assert.match(t, /wrapPathLinksInElement\(bodyEl, \{ sessionId, skipCodeBlocks: true \}\)/);
});
