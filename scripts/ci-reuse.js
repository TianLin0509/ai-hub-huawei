#!/usr/bin/env node
'use strict';
// 同一份代码只完整验证一次（2026-11-06 用户定）：
// - 若某个已成功的 CI 运行测过的提交是当前提交的祖先，且两者之间只改了发版文件（版本号、发布说明、安装文档），
//   就复用那次的测试结果：分支/PR 运行直接跳过重活；标签运行只做打包、装机冒烟和发布。
// 只看 GitHub 上真实成功的运行，不读任何本地记录；查不到或出错就照常完整验证。
const { execFileSync } = require('child_process');
const fs = require('fs');

const RELEASE_FILES = new Set([
  'community-edition.json', 'tools/public-edition/public-target.json',
  'INSTALL.md', 'README.md', 'docs/AGENT-QUICKSTART.md', 'docs/COMPANY-CODE-AGENT.md', 'docs/CUSTOMIZE.md',
  'scripts/install-release.ps1',
]);
const VERSION_ONLY_FILES = new Set(['package.json', 'package-lock.json']);
const QUICK_SINCE = '2026-11-09T00:00:00Z';

// diffs: { file: unifiedDiffText }，只含改动的文件。
function onlyReleaseChanges(diffs) {
  for (const [file, text] of Object.entries(diffs)) {
    if (RELEASE_FILES.has(file)) continue;
    if (!VERSION_ONLY_FILES.has(file)) return { ok: false, reason: `改了发版文件以外的 ${file}` };
    const changed = text.split(/\r?\n/).filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (changed.some(l => !/^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(l))) return { ok: false, reason: `${file} 除版本号外还有改动` };
  }
  return { ok: true };
}

// 运行档位（2026-11-09 用户定：按改动选测试、只在发版时打包）：
// - quick：推到 main。只跑单测和泄露闸门，不打包、不跑端到端。
// - full：每晚定时、手动触发、PR。单测 + 端到端 + 公开版测试，不打包。
// - release：标签。单测、泄露闸门、打包、装机冒烟、发布。
function modeFor(eventName, ref) {
  if (String(ref || '').startsWith('refs/tags/')) return 'release';
  return eventName === 'push' ? 'quick' : 'full';
}

// runs: [{ id, headSha, event, status, conclusion, isTag, quick }]；git: { isAncestor(a,b), diffs(a,b) }
// mode 不是 quick 时，quick 运行没跑端到端和公开版测试，不能拿来复用。
function decide({ head, isTag, currentRunId, runs, git, mode = isTag ? 'release' : 'quick' }) {
  // 2026-11-09：测试只在打标签前跑一次（发版脚本的本机预检），标签构建只打包、装机冒烟和发布。
  if (isTag) return { skipTests: true, skipPackage: false, reason: '发版脚本的本机预检已跑过测试，标签构建只打包' };
  if (!isTag) {
    const tagRun = runs.find(r => r.id !== currentRunId && r.isTag && r.headSha === head && r.status !== 'completed');
    if (tagRun) return { skipTests: true, skipPackage: true, reason: `同一提交的标签构建 ${tagRun.id} 已在排队或在跑，由它完整验证` };
  }
  // 「让给标签构建」而跳过的分支运行也会显示成功；同一提交只要有失败的运行或还没跑完的标签运行，就不信它。
  const distrusted = new Set(runs.filter(r => r.id !== currentRunId && (
    (r.status === 'completed' && r.conclusion === 'failure') || (r.isTag && r.status !== 'completed'))).map(r => r.headSha));
  for (const r of runs) {
    if (r.id === currentRunId || r.status !== 'completed' || r.conclusion !== 'success') continue;
    if (mode !== 'quick' && r.quick) continue;
    if (distrusted.has(r.headSha)) continue;
    if (r.headSha !== head && !git.isAncestor(r.headSha, head)) continue;
    const check = r.headSha === head ? { ok: true } : onlyReleaseChanges(git.diffs(r.headSha, head));
    if (!check.ok) continue;
    return { skipTests: true, skipPackage: !isTag, reason: `复用运行 ${r.id}（提交 ${r.headSha.slice(0, 9)}）的完整验证，之后只改了发版文件` };
  }
  return { skipTests: false, skipPackage: false, reason: '没有可复用的验证结果，完整验证' };
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

function main() {
  const head = process.env.GITHUB_SHA || sh('git', ['rev-parse', 'HEAD']);
  const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/');
  const mode = modeFor(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF);
  const currentRunId = Number(process.env.GITHUB_RUN_ID || 0);
  const repo = process.env.GITHUB_REPOSITORY;
  let result;
  try {
    const fetchRuns = () => JSON.parse(sh('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?per_page=60`])).workflow_runs.map(r => ({
      id: r.id, headSha: r.head_sha, event: r.event, status: r.status, conclusion: r.conclusion,
      isTag: r.event === 'push' && /^v\d/.test(r.head_branch || '') && r.head_branch !== 'main',
      // 档位上线之前的 main 推送运行是完整验证；之后的才是 quick。按运行创建时间区分。
      quick: r.event === 'push' && r.head_branch === 'main' && String(r.created_at || '') >= QUICK_SINCE,
    }));
    let runs = fetchRuns();
    // 发版提交和标签一起推，标签那条运行可能晚几秒才登记：分支上的发版提交最多等 90 秒找它。
    if (!isTag && /^release: v\d/.test(sh('git', ['log', '-1', '--format=%s', head]))) {
      for (let i = 0; i < 9 && !runs.some(r => r.isTag && r.headSha === head); i += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        runs = fetchRuns();
      }
    }
    const git = {
      isAncestor(a, b) {
        try { sh('git', ['cat-file', '-e', a + '^{commit}']); } catch { return false; }
        try { sh('git', ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
      },
      diffs(a, b) {
        const out = {};
        const names = sh('git', ['diff', '--name-only', a, b]).split(/\r?\n/).filter(Boolean);
        // 有一个发版文件以外的文件就不必再取逐文件差异，留个占位让判定失败。
        const other = names.find(f => !RELEASE_FILES.has(f) && !VERSION_ONLY_FILES.has(f));
        if (other) return { [other]: '' };
        for (const f of names) out[f] = VERSION_ONLY_FILES.has(f) ? sh('git', ['diff', a, b, '--', f]) : '';
        return out;
      },
    };
    result = decide({ head, isTag, currentRunId, runs, git, mode });
  } catch (error) {
    result = { skipTests: false, skipPackage: false, reason: '查询复用信息出错，完整验证：' + String(error.message).split('\n')[0] };
  }
  console.log(`[ci-reuse] 档位 ${mode}；${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip_tests=${result.skipTests}\nskip_package=${result.skipPackage}\nmode=${mode}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 验证复用\n${result.reason}\n`);
}

if (require.main === module) main();
module.exports = { onlyReleaseChanges, decide, modeFor, RELEASE_FILES };
