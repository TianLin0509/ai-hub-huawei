'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, onlyReleaseChanges, modeFor } = require('../scripts/ci-reuse');

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
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs: [run(1, 'A')], git: g }).skipTests, false);
});

test('failed, unfinished or non-ancestor runs are never reused', () => {
  const g = git({ A: {} });
  for (const r of [run(1, 'A', { conclusion: 'failure' }), run(1, 'A', { status: 'in_progress', conclusion: null }), run(1, 'Z')]) {
    assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs: [r], git: g }).skipTests, false);
  }
  // 同一提交上有失败的标签构建：那条分支运行的「成功」可能只是让路跳过，不可信。
  const runs = [run(1, 'A'), run(2, 'A', { isTag: true, conclusion: 'failure' })];
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: g }).skipTests, false);
});

test('branch run yields to a queued tag run of the same commit', () => {
  const runs = [run(5, 'H', { isTag: true, status: 'queued', conclusion: null })];
  const d = decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: git() });
  assert.equal(d.skipTests, true); assert.equal(d.skipPackage, true);
  const t = decide({ head: 'H', isTag: true, currentRunId: 5, runs, git: git() });
  assert.equal(t.skipTests, true);
});

test('run mode: tag releases, main push is quick, schedule/dispatch/PR are full', () => {
  assert.equal(modeFor('push', 'refs/tags/v5.6.0'), 'release');
  assert.equal(modeFor('push', 'refs/heads/main'), 'quick');
  for (const e of ['schedule', 'workflow_dispatch', 'pull_request']) assert.equal(modeFor(e, 'refs/heads/main'), 'full');
});

test('quick runs are reused only by quick runs', () => {
  const runs = [run(1, 'H', { quick: true })];
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: git(), mode: 'quick' }).skipTests, true);
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: git(), mode: 'full' }).skipTests, false);
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs, git: git(), mode: 'release' }).skipTests, false);
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs: [run(2, 'H')], git: git(), mode: 'full' }).skipTests, true);
});

test('标签构建只打包：测试已由发版脚本的本机预检跑过', () => {
  const d = decide({ head: 'H', isTag: true, currentRunId: 9, runs: [], git: git() });
  assert.equal(d.skipTests, true);
  assert.equal(d.skipPackage, false);
});

test('runs verified under a different Node version are not reused', () => {
  const g = { ...git({ A: { 'package.json': versionDiff } }), nodeVersion: sha => (sha === 'A' ? '' : '24') };
  const d = decide({ head: 'H', isTag: false, currentRunId: 9, runs: [run(1, 'A')], git: g });
  assert.equal(d.skipTests, false);
  const same = { ...g, nodeVersion: () => '24' };
  assert.equal(decide({ head: 'H', isTag: false, currentRunId: 9, runs: [run(1, 'A')], git: same }).skipTests, true);
});

test('CI workflows take the Node version from .node-version', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, '.node-version'), 'utf8'), /^\d+\s*$/);
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/meeting-flow-diagnostic.yml', 'tools/public-edition/overlay/.github/workflows/ci.yml']) {
    if (!fs.existsSync(path.join(root, f))) continue; // 公开版裁掉了部分流程文件
    const yml = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(yml, /node-version:\s*\d/, f + ' 不另写 Node 版本');
    assert.match(yml, /node-version-file:/, f);
  }
});
