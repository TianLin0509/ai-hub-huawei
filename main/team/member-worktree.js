'use strict';
// 成员的工作目录是 git 仓库的主目录（不是已有 worktree）、且不是只读审查时，Hub 从主干拉一个
// worktree + 分支给它，避免多人在主目录互相踩、或在共享依赖里装包把依赖弄坏。
// 建不出来不拦人：返回 error，由调用方照常开工并在开工消息里说明。
// 不做自动删除：带依赖 junction 的目录删错会穿透到生产依赖，清理按项目规则手工做。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const DEP_LINKS = ['node_modules'];

function git(args, cwd, timeout = 120000) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return new Promise((resolve, reject) => execFile('git', args, { cwd, env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(Error(String(stderr || error.message).trim().split('\n').slice(-2).join(' '))) : resolve(String(stdout).trim())));
}
// 按真实路径比：Windows 短文件名（如 L00807~1）、目录链接和 git 返回的长路径要认成同一个（公司真机验收发现）。
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();
const day = t => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const slug = s => {
  const name = String(s || '');
  const ascii = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  // 非 ASCII 部分不能只删掉：不同中文仓库会得到相同目录名。
  return /[^\x00-\x7f]/.test(name)
    ? ascii.slice(0, 15) + '-' + createHash('sha256').update(name).digest('hex').slice(0, 8)
    : ascii.slice(0, 24);
};

// 只有「git 仓库主目录」才需要：已是 worktree、不是 git、子目录都原样返回 null。
async function mainCheckout(cwd) {
  // 快速预检：主目录里 .git 是文件夹（worktree 里是文件）；不是就不起 git 进程。
  try { if (!fs.statSync(path.join(cwd, '.git')).isDirectory()) return null; } catch { return null; }
  // 只用 Git 2.5 起就有的参数：部分公司电脑仍是 Git 2.8（没有 --absolute-git-dir）。
  let top, gitDir, common;
  try {
    [top, gitDir, common] = await Promise.all([git(['rev-parse', '--show-toplevel'], cwd, 15000),
      git(['rev-parse', '--git-dir'], cwd, 15000), git(['rev-parse', '--git-common-dir'], cwd, 15000)]);
  } catch { return null; }
  if (!same(top, cwd)) return null;
  const abs = p => path.isAbsolute(p) ? p : path.join(cwd, p);
  if (!same(abs(gitDir), abs(common))) return null;
  return top;
}

function projectConfig(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, '.agents', 'project.json'), 'utf8')); } catch { return {}; }
}

async function prepareMemberWorktree({ cwd, memberId, leadSid, access, enabled, now = Date.now() }) {
  if (enabled === false || access === 'read') return null;
  const repo = await mainCheckout(cwd);
  if (!repo) return null;
  const project = projectConfig(repo);
  const root = project.worktreeRoot && fs.existsSync(project.worktreeRoot) ? project.worktreeRoot : path.dirname(repo);
  const lead = String(leadSid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'lead';
  const stem = `${day(now)}-${slug(path.basename(repo))}-${memberId}-${lead}`, branchStem = `feat/team-${day(now)}-${lead}-${memberId}`;
  const branchTaken = async b => { try { await git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + b], repo, 15000); return true; } catch { return false; } };
  try {
    const trunk = project.trunk || 'HEAD';
    const base = await git(['rev-parse', '--verify', trunk + '^{commit}'], repo, 15000).catch(() => git(['rev-parse', 'HEAD'], repo, 15000));
    // 撞名（同一天同一负责人同编号再招）就加 -2、-3…，不退回主目录（Codex 审查 P2）。
    let dir = '', branch = '';
    for (let i = 1; i <= 9 && !dir; i++) {
      const suffix = i === 1 ? '' : '-' + i, d = path.join(root, stem + suffix), b = branchStem + suffix;
      if (!fs.existsSync(d) && !(await branchTaken(b))) { dir = d; branch = b; }
    }
    if (!dir) throw Error(`同名目录或分支已用到 -9：${path.join(root, stem)}`);
    await git(['worktree', 'add', '-b', branch, dir, base], repo);
    const links = [];
    for (const dep of DEP_LINKS) {
      const source = path.join(repo, dep), target = path.join(dir, dep);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      fs.symlinkSync(source, target, 'junction');
      links.push(dep);
    }
    return { path: dir, branch, base, repo, links };
  } catch (error) {
    return { error: String(error.message || error), repo };
  }
}

function kickoffLines(worktree) {
  if (!worktree) return [];
  if (worktree.error) return [`工作目录：Hub 没能替你建独立 worktree（${worktree.error}）。改代码前先按项目规则自己从主干建 worktree，不要在仓库主目录 ${worktree.repo} 直接改。`, ''];
  return [
    `工作目录：Hub 已替你建好独立 worktree ${worktree.path}（分支 ${worktree.branch}，基线 ${worktree.base}），你就在这里改和提交，不要再另建，也不要回仓库主目录 ${worktree.repo} 改文件。`,
    ...(worktree.links.length ? [`- ${worktree.links.join('、')} 是指向主目录的目录链接（junction）：不要在这里安装、裁剪依赖，也不要递归删除它。`] : []),
    '',
  ];
}

// 同步预检：不需要建 worktree 的成员不进异步流程，原有开工时序保持不变。
function mayNeedWorktree({ cwd, access, enabled }) {
  if (enabled === false || access === 'read' || !cwd) return false;
  try { return fs.statSync(path.join(cwd, '.git')).isDirectory(); } catch { return false; }
}

module.exports = { prepareMemberWorktree, kickoffLines, mainCheckout, mayNeedWorktree };
