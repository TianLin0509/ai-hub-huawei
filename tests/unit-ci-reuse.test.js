'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, onlyReleaseChanges } = require('../scripts/ci-reuse');

const versionDiff = '--- a/package.json\n+++ b/package.json\n@@\n-  "version": "5.5.12",\n+  "version": "5.5.13",\n';
const git = (diffsBySha = {}, ancestors = ['A', 'B']) => ({
  isAncestor: a => ancestors.includes(a),
  diffs: a => diffsBySha[a] || {},
});
const run = (id, headSha, extra = {}) => ({ id, headSha, status: 'completed', conclusion: 'success', isTag: false, ...extra });

test('version-only release commit reuses the verified parent; tag still packages', () => {
  const g = git({ A: { 'package.json': versionDiff, 'community-edition.json': 'x', 'INSTALL.md': 'x' } });
  const tag = decide({ head: 'H', isTag: true, currentRunId: 9, runs: [run(1, 'A')], git: g });
  assert.equal(tag.skipTests, true); assert.equal(tag.skipPackage, false);
  const branch = decide({ head: 'H', isTag: false, currentRunId: 9, runs: [run(1, 'A')], git: g });
  assert.equal(branch.skipTests, true); assert.equal(branch.skipPackage, true);
});

test('any code change or extra package.json change forces full verification', () => {
  assert.equal(onlyReleaseChanges({ 'core/x.js': '+a' }).ok, false);
  assert.equal(onlyReleaseChanges({ 'package.json': versionDiff + '+    "left-pad": "1.0.0",\n' }).ok, false);
  const g = git({ A: { 'core/x.js': '+a' } });
  assert.equal(decide({ head: 'H', isTag: true, currentRunId: 9, runs: [run(1, 'A')], git: g }).skipTests, false);
});

test('failed, unfinished or non-ancestor runs are never reused', () => {
  const g = git({ A: {} });
  for (const r of [run(1, 'A', { conclusion: 'failure' }), run(1, 'A', { status: 'in_progress', conclusion: null }), run(1, 'Z')]) {
    assert.equal(decide({ head: 'H', isTag: true, currentRunId: 9, runs: [r], git: g }).skipTests, false);
  }
  // 同一提交上有失败的标签构建：那条分支运行的「成功」可能只是让路跳过，不可信。
  const runs = [run(1, 'A'), run(2, 'A', { isTag: true, conclusion: 'failure' })];
  assert.equal(decide({ head: 'H', isTag: true, currentRunId: 9, runs, git: g }).skipTests, false);
});

test('branch run yields to a queued tag run of the same commit', () => {
  const runs = [run(5, 'H', { isTag: true, status: 'queued', conclusion: null })];
  const d = decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: git() });
  assert.equal(d.skipTests, true); assert.equal(d.skipPackage, true);
  const t = decide({ head: 'H', isTag: true, currentRunId: 5, runs, git: git() });
  assert.equal(t.skipTests, false);
});
