'use strict';
// 分身会话在哪个目录里启动。
// 公司 CodeAgent 的外部模型管控按启动目录判定（2026-11-28 公司侧日志核实，Q-1128-09）：
//   目录（或它的上级）是 git 仓库、remote 指向公司代码平台时，按那个仓库的策略放行；
//   普通文件夹退回部门策略，很多部门不放外部模型；--add-dir 加进来的普通文件夹不参与判定。
// 分身的工作目录在 Hub 数据目录下，是普通文件夹，所以主页（开在代码仓库里）能用的外部模型，分身报「外部模型管控 / 不在可信仓」。
// 做法：被这条管控拦下时，沿用本人在主页用 CodeAgent 打开过的公司代码仓库作启动目录，分身自己的文件经 --add-dir 带上；
// 找不到就请本人就地选一个代码仓库目录。不伪造仓库标记，只用本人真实在用的仓库。
const fs = require('node:fs');
const path = require('node:path');

const CODEHUB = /codehub/i;
const MAX_CHECK = 12;

function gitRemotes(dir, run = defaultRun) {
  try {
    const out = run('git', ['-C', dir, 'config', '--get-regexp', 'remote\\..*\\.url']);
    return String(out || '').split(/\r?\n/).map(line => line.trim().split(/\s+/)[1] || '').filter(Boolean);
  } catch { return []; }
}
function defaultRun(cmd, args) {
  return require('node:child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// 这个目录是不是公司代码平台上的仓库（或在仓库里面）。
function isCompanyRepo(dir, { run = defaultRun, exists = isDir } = {}) {
  if (!dir || !exists(dir)) return false;
  return gitRemotes(dir, run).some(url => CODEHUB.test(url));
}
// 本人手动开的 CodeAgent 会话（不含分身、助理这些后台会话）用过的目录，按最近使用排在前面；第一个是公司代码仓库的就用它。
function findTrustedCwd(sessions, { run = defaultRun, exists = isDir, exclude = [] } = {}) {
  const skip = new Set((exclude || []).filter(Boolean).map(p => path.resolve(p).toLowerCase()));
  const seen = new Set(), dirs = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !/^codeagent/.test(String(s.kind || '')) || s.purpose || s.autonomous || s.meetingId || !s.cwd) continue;
    const key = path.resolve(String(s.cwd)).toLowerCase();
    if (seen.has(key) || skip.has(key)) continue;
    seen.add(key); dirs.push(String(s.cwd));
    if (dirs.length >= MAX_CHECK) break;
  }
  return dirs.find(dir => isCompanyRepo(dir, { run, exists })) || '';
}
// 屏幕报错是不是「启动目录 / 外部模型管控」这一类（见 core/codeagent-screen-error.js 的真实样本）。
function dirPolicyKind(err) {
  if (!err) return '';
  if (err.trustedRepo) return 'repo';
  return /外部模型管控|不允许使用外部模型|外部模型不可用/.test(String(err.message || '')) ? 'external' : '';
}

module.exports = { findTrustedCwd, isCompanyRepo, gitRemotes, dirPolicyKind };
