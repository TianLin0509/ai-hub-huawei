'use strict';
// 依次跑项目声明的测试闸门，写成一份 Markdown，作为负责人或裁判的固定输入。只给事实，不打分。
// HUB-H 口径：公司仓库多数没有 .agents/project.json，这时不跑测试，只核对提交并比改动规模。
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const Gate = require('./delivery-gate');

const LABELS = 'ABCDEFGHIJ';
// 主干探测会试几个不存在的分支名：stderr 收进管道，不往 Hub 日志里打 fatal（审查建议 1）。
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function trunkNames(worktree) {
  const names = [];
  try { const t = JSON.parse(fs.readFileSync(path.join(worktree, '.agents', 'project.json'), 'utf8')).trunk; if (t) names.push(t); } catch {}
  try { const head = git(worktree, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']); if (head) names.push(head); } catch {}
  names.push('origin/main', 'origin/master', 'main', 'master');
  return [...new Set(names)];
}
// 候选是否可信：目录在、当前提交就是交付写的 SHA、没有未提交改动。返回 null 表示可信，否则返回原因。
function verifyCandidate(candidate) {
  const { worktree, sha } = candidate;
  try {
    if (!path.isAbsolute(worktree) || !fs.statSync(worktree).isDirectory()) return `候选目录不存在：${worktree}`;
    if (git(worktree, ['rev-parse', 'HEAD']).toLowerCase() !== sha) return `候选目录当前提交不是 ${sha}`;
    if (git(worktree, ['status', '--porcelain', '--untracked-files=no'])) return '候选目录有未提交改动，结果无法绑定该提交';
    return null;
  } catch (error) { return `无法核对候选：${String(error.message || error).split('\n')[0]}`; }
}
// 相对主干分叉点的改动；主干找不到时退回与父提交比，仍给出可读的规模。
function diffStat(candidate) {
  const { worktree, sha } = candidate;
  const bases = [...trunkNames(worktree).map(t => `${t}...${sha}`), `${sha}~1..${sha}`];
  for (const base of bases) {
    try {
      const files = git(worktree, ['diff', '--name-only', base]).split(/\r?\n/).filter(Boolean);
      const short = git(worktree, ['diff', '--shortstat', base]);
      const num = re => Number((short.match(re) || [])[1] || 0);
      let commits = null;
      try { commits = Number(git(worktree, ['rev-list', '--count', base.replace('...', '..')])) || null; } catch {}
      return { files, insertions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/), base, commits };
    } catch {}
  }
  return null;
}
function minutes(ms) { return !(ms > 0) ? '—' : ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`; }
function gateText(g) {
  if (!g) return '—';
  if (g.state === 'passed') return `通过（${minutes(g.durationMs)}）`;
  if (g.state === 'failed') return `未通过：\`${g.failedCommand}\` 退出码 ${g.exitCode}`;
  if (g.state === 'skipped') return `未跑：${g.reason}`;
  return g.state;
}
/**
 * entries: [{ memberId, name, deliveryPath, elapsedMs }]，按参赛顺序。
 * 依次跑闸门（不并发，避免多份全量测试同时抢 CPU 和端口）。
 * 返回 { state: 'done', rows, markdown } 或 { state: 'cancelled' }。
 */
async function scorecard({ goal = '', entries, dir, signal, runGate = Gate.runGate }) {
  const rows = [];
  for (const [i, e] of entries.entries()) {
    const label = LABELS[i] || String(i + 1);
    let candidate = null;
    try { candidate = e.deliveryPath ? Gate.parseCandidate(fs.readFileSync(e.deliveryPath, 'utf8')) : null; } catch {}
    const row = { ...e, label, candidate, stat: null, gate: null };
    if (!e.deliveryPath) { row.gate = { state: 'skipped', reason: '没有交付' }; rows.push(row); continue; }
    if (!candidate) { row.gate = { state: 'skipped', reason: '交付里没有 CANDIDATE 行（非代码任务或漏写）' }; rows.push(row); continue; }
    const bad = verifyCandidate(candidate);
    if (bad) { row.gate = { state: 'skipped', reason: bad }; rows.push(row); continue; }
    // 提交核对过了：不管项目有没有测试闸门，改动规模都统计。
    row.stat = diffStat(candidate);
    const hasGate = fs.existsSync(path.join(candidate.worktree, '.agents', 'project.json'));
    const pre = hasGate ? Gate.preflight(candidate) : { skipped: '项目未声明测试命令（没有 .agents/project.json），只比提交与改动规模' };
    if (pre.skipped) row.gate = { state: 'skipped', reason: pre.skipped };
    else {
      const result = await runGate({ candidate, commands: pre.commands, logPath: path.join(dir, `race-gate-${label}.log`), signal });
      if (result.state === 'cancelled' || signal?.aborted) return { state: 'cancelled' };
      row.gate = result;
    }
    rows.push(row);
  }
  return { state: 'done', rows, markdown: render(goal, rows) };
}
function render(goal, rows) {
  const counts = new Map();
  for (const r of rows) for (const f of r.stat?.files || []) counts.set(f, (counts.get(f) || 0) + 1);
  const shared = [...counts].filter(([, n]) => n > 1).map(([f]) => f);
  const anyGate = rows.some(r => r.gate && r.gate.state !== 'skipped');
  const lines = ['# 赛马成绩单（Hub 实测）', '', `目标：${goal}`, '',
    '下表由 Hub 亲自核对得出：提交是否与交付一致、相对主干的改动规模、提交数；项目声明了测试命令（.agents/project.json 的 test）时，还在该提交上跑了测试。用时从成员建好算到 Hub 收到交付。只列事实，不打分。', '',
    ...(anyGate ? [] : ['这个项目没有声明测试命令，本轮没有跑测试，只比提交与改动规模；功能好坏请抽查代码或让裁判按任务要求核对。', '']),
    '| 编号 | 参赛者 | 用时 | 候选提交 | 提交数 | 改动规模 | Hub 测试闸门 |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const scale = r.stat ? `${r.stat.files.length} 个文件 +${r.stat.insertions}/-${r.stat.deletions}` : '—';
    lines.push(`| ${r.label} | ${r.name} | ${minutes(r.elapsedMs)} | ${r.candidate ? r.candidate.sha.slice(0, 10) : '—'} | ${r.stat?.commits ?? '—'} | ${scale} | ${gateText(r.gate)} |`);
  }
  lines.push('', '## 各候选明细', '');
  for (const r of rows) {
    lines.push(`### ${r.label} · ${r.name}`, `- 交付文件：${r.deliveryPath || '无'}`);
    if (r.candidate) lines.push(`- 候选：${r.candidate.worktree} ${r.candidate.sha}`);
    if (r.stat?.base) lines.push(`- 比较基准：${r.stat.base}`);
    if (r.gate?.logPath) lines.push(`- 测试日志：${r.gate.logPath}`);
    if (r.stat?.files.length) lines.push(`- 改动文件：${r.stat.files.slice(0, 20).join('、')}${r.stat.files.length > 20 ? ` 等 ${r.stat.files.length} 个` : ''}`);
    lines.push('');
  }
  if (shared.length) lines.push('## 多个候选都改了的文件', '', shared.slice(0, 30).join('、'), '', '这些文件是方案分歧最集中的地方，可优先对比。', '');
  return lines.join('\n');
}

module.exports = { scorecard, render, diffStat, verifyCandidate };
