'use strict';

//   成员默认照旧免审批；只硬拦 5 类危险动作，另有「只读」成员（审查类任务）拒绝写文件。
//   ① git push（含推内源）、合入或改写主干（master/main/trunk/develop，config teamMemberGuard.protectedBranches 可改；含 merge_task.py）
//   ② 关闭/重启/kill 生产 Hub，或按进程名、命令行子串成批杀进程
//   ③ 删除任务声明目录（成员工作目录、成员入队后新建的 D:\AIWork 任务目录、临时目录）以外的文件
//   ④ 改 Hub 生产数据目录下的配置与状态
//   ⑤ 读取或使用按量计费 API 的密钥（部门 API key 网关、DeepSeek / Anthropic / OpenAI）
// 原则：误拦一次的代价大于漏拦（误报当场放宽）。解析不了、拿不准的一律放行；
// 只读 git 命令、worktree 里的 commit、隔离 Hub 的启停都不能拦。
// 这里是纯函数（除了可注入的 branchOf / dirBirth），便于单测；判定入口 classify()。

const path = require('path');

const CATEGORY = Object.freeze({
  git: '① 推送或改写主干',
  hub: '② 关闭、重启或成批杀进程',
  del: '③ 删除任务目录以外的文件',
  data: '④ 改 Hub 生产配置与状态',
  api: '⑤ 读取或使用按量计费 API 密钥',
  read: '只读成员写文件',
});

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const DEFAULT_PROTECTED_BRANCHES = Object.freeze(['master', 'main', 'trunk', 'develop']);
function branchMatcher(list) {
  const names = (Array.isArray(list) && list.length ? list : DEFAULT_PROTECTED_BRANCHES)
    .map(x => String(x || '').trim()).filter(x => /^[\w./-]{1,100}$/.test(x)).map(x => x.replace(/[.]/g, '\\.'));
  return new RegExp('^(' + (names.length ? names : DEFAULT_PROTECTED_BRANCHES).join('|') + ')$', 'i');
}
// Hub 数据目录里算「配置与状态」的子目录；根目录下的文件一律算。其余（transcripts、artifacts、
// orchestration、task-docs、memory…）是 Hub 允许会话读写的工作区，不拦。
const CHANNEL_STATE_DIRS = [];
const DATA_STATE_DIRS = ['team', 'teams', 'control', 'codeagent-pool', 'codeagent-launch', 'native-agent-settings', 'api-gateway',
  ...CHANNEL_STATE_DIRS, 'company-assistant', 'company-model-proxy', 'community', 'profile', 'sessions', 'hub-cli', 'mcp-profiles',
  'hub-rules', 'app-update'];
// 只认「取值」的写法（$X、${X}、$env:X、%X%、environ/getenv/process.env、printenv X、env:X），
// 在代码里 grep 这个名字不算读取密钥。
const KEY = '(DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CLAUDE_API_KEY)';
const API_KEY_NAMES = new RegExp([
  String.raw`\$\{?` + KEY + String.raw`\b`, String.raw`\$env:` + KEY + String.raw`\b`, '%' + KEY + '%',
  String.raw`environ(?:\.get)?\s*[\[(]\s*["']` + KEY, String.raw`getenv\s*\(\s*["']` + KEY,
  String.raw`process\.env\.` + KEY + String.raw`\b`, String.raw`printenv\s+` + KEY + String.raw`\b`, String.raw`(?:^|[\s(])env:` + KEY + String.raw`\b`,
].join('|'), 'i');
const API_HOSTS = /\bapi\.(deepseek\.com|anthropic\.com|openai\.com)\b/i;
// 部门 API key 在 Hub 数据目录 api-gateway/gateway.json 里（加密存放）；命令里直接读它也算 ⑤。
const GATEWAY_STORE = /api-gateway[\\/]+gateway\.json/i;
// 直接 curl 部门网关不拦：不带 key 调不通，带 key 时上面的取值写法或读 gateway.json 已经拦下（拿不准放行）。

// ---------- 命令行切分 ----------
// 按 && || ; | 换行切成若干段，每段再按空白切词（尊重单双引号）。只为匹配，不追求 100% 的 shell 语义。
function splitSegments(command) {
  const out = [];
  let cur = '', quote = '';
  const s = String(command || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';' || (c === '|' ) || (c === '&' && s[i + 1] === '&')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' && s[i + 1] === '|') || (c === '&' && s[i + 1] === '&')) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function tokenize(segment) {
  const out = [];
  let cur = '', quote = '', has = false;
  for (const c of String(segment || '')) {
    if (quote) { if (c === quote) quote = ''; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}
// 去掉 & / . / call 这类前缀和 cmd /c、powershell -Command 外壳，返回真正的命令词序列。
function stripPrefix(tokens) {
  let t = tokens.slice();
  while (t.length && /^(&|\.|call|sudo|exec|time|nohup)$/i.test(t[0])) t.shift();
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift(); // FOO=bar cmd
  return t;
}
function baseName(word) {
  return path.basename(String(word || '').replace(/^["']|["']$/g, '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}
// 嵌套外壳：cmd /c "…"、powershell -Command "…"、bash -c "…" 里的命令也要看。
function innerCommands(tokens) {
  const head = baseName(tokens[0]);
  if (head === 'cmd') {
    const i = tokens.findIndex(x => /^\/[ck]$/i.test(x));
    if (i >= 0) return [tokens.slice(i + 1).join(' ')];
  }
  if (head === 'powershell' || head === 'pwsh') {
    const i = tokens.findIndex(x => /^-(c|command)$/i.test(x));
    if (i >= 0) return [tokens.slice(i + 1).join(' ')];
  }
  if (head === 'bash' || head === 'sh') {
    const i = tokens.findIndex(x => x === '-c' || x === '-lc');
    if (i >= 0) return [tokens.slice(i + 1).join(' ')];
  }
  return [];
}
// 逐段跟踪工作目录：cd / Set-Location / pushd 之后的命令按新目录解析相对路径和 git 仓库（Codex 审查 P1）。
const PUSH_CMDS = new Set(['pushd', 'push-location']);
const POP_CMDS = new Set(['popd', 'pop-location']);
const CD_CMDS = new Set(['cd', 'chdir', 'set-location', 'sl', ...PUSH_CMDS]);
function allCommands(command, depth = 0, start = null, env = {}) {
  const result = [];
  let cwd = start;
  const stack = []; // pushd / popd（Push-Location / Pop-Location）的目录栈
  for (const seg of splitSegments(command)) {
    const tokens = stripPrefix(tokenize(seg));
    if (!tokens.length) continue;
    const head = baseName(tokens[0]);
    if (POP_CMDS.has(head)) { if (stack.length) cwd = stack.pop(); continue; }
    if (CD_CMDS.has(head)) {
      const target = tokens.slice(1).find(t => !/^(-|\/d$)/i.test(t));
      const resolved = target ? resolvePath(target, cwd, env) : null;
      if (PUSH_CMDS.has(head)) stack.push(cwd);
      cwd = resolved || (target ? null : cwd); // 解析不了（变量）：之后的相对路径一律当作未知
      continue;
    }
    result.push({ seg, tokens, cwd });
    if (depth < 2) for (const inner of innerCommands(tokens)) result.push(...allCommands(inner, depth + 1, cwd, env));
  }
  return result;
}

// ---------- 路径 ----------
function norm(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  // Git Bash 写法 /c/Users/... → C:\Users\...
  const m = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(s);
  if (m) s = m[1] + ':\\' + m[3];
  s = s.replace(/\//g, '\\');
  return path.win32.normalize(s).replace(/\\+$/, '').toLowerCase();
}
function expandVars(p, env) {
  const home = env.USERPROFILE || env.HOME || '';
  const temp = env.TEMP || env.TMP || '';
  return String(p)
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/\$env:(USERPROFILE|HOME)\b/ig, home).replace(/\$(HOME|USERPROFILE)\b/g, home).replace(/%(USERPROFILE|HOME)%/ig, home)
    .replace(/\$env:(TEMP|TMP)\b/ig, temp).replace(/\$(TEMP|TMP)\b/g, temp).replace(/%(TEMP|TMP)%/ig, temp);
}
function resolvePath(p, cwd, env = {}) {
  const raw = expandVars(String(p || '').replace(/^["']|["']$/g, ''), env);
  if (!raw) return null;
  if (/[$%`]/.test(raw)) return null; // 还剩变量：解析不了，放行
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) return norm(raw);
  if (/^\/[a-zA-Z](\/|$)/.test(raw)) return norm(raw);
  if (/^\//.test(raw)) return null; // /tmp、/dev/null 之类 Git Bash 虚拟路径
  if (!cwd) return null;
  return norm(path.win32.join(String(cwd), raw));
}
function within(child, root) {
  if (!child || !root) return false;
  const c = norm(child), r = norm(root);
  return c === r || c.startsWith(r + '\\');
}
function isNullTarget(t) { return /^(\/dev\/null|nul|\$null|&\d|\d)$/i.test(String(t || '').trim()); }

// 写重定向目标：> file、>> file、2> file；引号里的 >、>&2、2>&1、> /dev/null、> $null 不算写。
function redirectTargets(seg) {
  const s = String(seg || '');
  const out = [];
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c !== '>') continue;
    if (s[i - 1] === '-' || s[i - 1] === '=') continue; // -> / => 之类
    let j = i + 1;
    if (s[j] === '>') j++;
    if (s[j] === '&') { i = j; continue; }
    while (s[j] === ' ' || s[j] === '\t') j++;
    let target = '';
    if (s[j] === '"' || s[j] === "'") { const q = s[j]; const k = s.indexOf(q, j + 1); target = s.slice(j + 1, k < 0 ? s.length : k); j = k < 0 ? s.length : k + 1; }
    else { while (j < s.length && !/[\s;&|<>]/.test(s[j])) target += s[j++]; }
    i = j - 1;
    if (target && !isNullTarget(target)) out.push(target);
  }
  return out;
}

// ---------- 规则 ① git ----------
const GIT_REWRITE = new Set(['merge', 'rebase', 'reset', 'cherry-pick', 'am', 'revert', 'pull']);
function gitInvocation(tokens) {
  if (baseName(tokens[0]) !== 'git') return null;
  let dir = null, i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C' && tokens[i + 1]) { dir = tokens[i + 1]; i += 2; continue; }
    if (/^--(git-dir|work-tree)$/.test(tokens[i])) { i += 2; continue; }
    if (tokens[i] === '-c') { i += 2; continue; }
    i++;
  }
  return { sub: String(tokens[i] || '').toLowerCase(), args: tokens.slice(i + 1), dir };
}
async function checkGit({ tokens }, ctx) {
  const g = gitInvocation(tokens);
  if (!g) {
    if (tokens.some(t => /(^|[\\/])merge_task\.py$/i.test(t))) return { category: 'git', reason: '运行 merge_task.py（合入主干）' };
    return null;
  }
  const { sub, args } = g;
  if (sub === 'push') return { category: 'git', reason: 'git push（推送到远端）' };
  const PROTECTED_BRANCH = ctx.protectedBranch || branchMatcher();
  const namesProtected = args.some(a => PROTECTED_BRANCH.test(a.replace(/^refs\/heads\//, '').replace(/^origin\//, '')));
  if (sub === 'branch' && namesProtected && args.some(a => /^-(f|D|M|C|-force|-delete)$/.test(a) || /^-[a-zA-Z]*[fDMC]/.test(a)))
    return { category: 'git', reason: `git branch ${args.join(' ')}（改写主干）` };
  if (sub === 'update-ref' && args.some(a => /^refs\/heads\//i.test(a) && PROTECTED_BRANCH.test(a.replace(/^refs\/heads\//i, ''))))
    return { category: 'git', reason: 'git update-ref 改写主干' };
  if ((sub === 'checkout' || sub === 'switch') && namesProtected && args.some(a => /^-[BC]$/.test(a)))
    return { category: 'git', reason: `git ${sub} ${args.join(' ')}（重置主干）` };
  // 只有当前分支是主干时，下面这些才算改写主干；worktree 里的功能分支照常。
  // reset：带模式，或第一个非选项参数是会移动分支的提交（HEAD~1、HEAD^、哈希、远端分支）才算改写；
  // git reset、git reset HEAD 文件、git reset -- 文件 只是撤暂存。
  // 带路径（pathspec，或 -- 之后的路径）的 reset 只改暂存区，不移动分支（Codex 复审 P2）。
  const resetPaths = args.includes('--') || args.filter(a => !a.startsWith('-')).length > 1;
  const resetMoves = sub === 'reset' && !resetPaths && (args.some(a => /^--(hard|soft|mixed|keep|merge)$/.test(a))
    || /^(HEAD[~^]|HEAD@\{|ORIG_HEAD$|[0-9a-f]{7,40}$|origin\/|upstream\/|@\{u\}|@~|@\^)/i.test(args.find(a => !a.startsWith('-')) || ''));
  const rewrite = GIT_REWRITE.has(sub)
    && !(sub === 'reset' && !resetMoves)
    && !args.some(a => /^--(abort|continue|quit|skip)$/.test(a));
  const isCommit = sub === 'commit';
  if (!rewrite && !isCommit) return null;
  const dir = g.dir ? resolvePath(g.dir, ctx.cwd, ctx.env) : (ctx.cwd ? norm(ctx.cwd) : null);
  if (!dir || typeof ctx.branchOf !== 'function') return null;
  let branch = null;
  try { branch = await ctx.branchOf(dir); } catch { branch = null; }
  if (!branch || !PROTECTED_BRANCH.test(branch)) return null;
  // commit 只在 hubProgramDir（以源码方式运行的 Hub 目录；安装版没有）里拦；其他项目在主干上提交属于本地可回退操作，不拦。
  if (isCommit) return [].concat(ctx.hubProgramDir || []).some(d => within(dir, d))
    ? { category: 'git', reason: `在生产 Hub 目录的 ${branch} 上直接提交` } : null;
  return { category: 'git', reason: `git ${sub}（当前在 ${branch} 分支，会改写主干）` };
}

// ---------- 规则 ② 杀进程 ----------
const HUB_IMAGE = /^(electron|node|ai[ -]?hub([ -]community)?)(\.exe)?$/i;
function checkKill({ tokens, seg }, ctx) {
  const head = baseName(tokens[0]);
  const lower = seg.toLowerCase();
  if (head === 'taskkill') {
    const im = tokens.findIndex(t => /^[/-]im$/i.test(t));
    if (im >= 0) return { category: 'hub', reason: `taskkill /IM ${tokens[im + 1] || ''}（按进程名成批结束）` };
    if (tokens.some(t => /^[/-]fi$/i.test(t))) return { category: 'hub', reason: 'taskkill /FI（按条件成批结束进程）' };
    const pids = pidArgs(tokens, /^[/-]pid$/i);
    if (pids.some(p => ctx.protectedPids.has(p))) return { category: 'hub', reason: `结束生产 Hub 进程（PID ${pids.join(',')}）` };
    return null;
  }
  if (head === 'stop-process' || head === 'kill' || head === 'spps') {
    if (tokens.some(t => /^-name$/i.test(t)) || (head === 'stop-process' && tokens.length > 1 && !tokens.some(t => /^-(id|inputobject)$/i.test(t)) && /^[a-z]/i.test(tokens[1]) && !/^-/.test(tokens[1])))
      return { category: 'hub', reason: 'Stop-Process -Name（按进程名成批结束）' };
    const pids = tokens.slice(1).filter(t => /^\d+$/.test(t)).map(Number);
    if (pids.some(p => ctx.protectedPids.has(p))) return { category: 'hub', reason: `结束生产 Hub 进程（PID ${pids.join(',')}）` };
    // 管道进来的进程对象（Get-Process xxx | Stop-Process）在 checkKillPipeline 里看
    return null;
  }
  if (head === 'pkill' || head === 'killall') return { category: 'hub', reason: `${head}（按名字或命令行成批结束进程）` };
  if (head === 'wmic' && /\bprocess\b/.test(lower) && /\b(delete|terminate)\b/.test(lower)) return { category: 'hub', reason: 'wmic process … delete/terminate（按条件结束进程）' };
  return null;
}
function pidArgs(tokens, flag) {
  const out = [];
  tokens.forEach((t, i) => { if (flag.test(t) && /^\d+$/.test(tokens[i + 1] || '')) out.push(Number(tokens[i + 1])); });
  return out;
}
// 整条命令层面：Get-Process/Get-CimInstance … | … Stop-Process / Terminate —— 按名字或命令行子串筛进程再杀。
function checkKillPipeline(command) {
  const c = String(command || '');
  const killer = /\b(stop-process|spps|invoke-cimmethod[^|]*terminate|\.terminate\(\)|\.kill\(\)|taskkill)\b/i;
  if (!killer.test(c)) return null;
  if (/\b(get-process|gps|ps)\b[^|]*\|/i.test(c) && /\|\s*(stop-process|spps|foreach-object[^|]*(stop-process|kill))/i.test(c))
    return { category: 'hub', reason: 'Get-Process … | Stop-Process（按进程名成批结束）' };
  if (/\b(get-ciminstance|get-wmiobject|gcim|gwmi)\b[^|]*win32_process/i.test(c) && /commandline|name\s*-(like|match|eq)/i.test(c))
    return { category: 'hub', reason: '按命令行子串筛进程后结束' };
  return null;
}

// ---------- 规则 ③ 删除 ----------
const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred']);
function deleteTargets(tokens) {
  const head = baseName(tokens[0]);
  if (!DELETE_CMDS.has(head)) return null;
  const out = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^-(path|literalpath)$/i.test(t)) { if (tokens[i + 1]) out.push(tokens[++i]); continue; }
    if (/^(-|\/[a-zA-Z]$)/.test(t)) continue; // 选项：-rf、-Recurse、/s /q
    out.push(t);
  }
  return out.map(t => t.replace(/,$/, ''));
}
async function checkDelete({ tokens }, ctx) {
  const targets = deleteTargets(tokens);
  if (!targets || !targets.length) return null;
  for (const t of targets) {
    const resolved = resolvePath(t.replace(/[*?].*$/, '') || '.', ctx.cwd, ctx.env);
    if (!resolved) continue; // 解析不了的放行
    if (await allowedForDelete(resolved, ctx)) continue;
    return { category: 'del', reason: `删除 ${t}（在任务目录以外：${resolved}）` };
  }
  return null;
}
async function allowedForDelete(resolved, ctx) {
  if ((ctx.allowRoots || []).some(r => within(resolved, r))) return true;
  // 成员入队后自己在工作根（D:\AIWork 等）下新建的任务目录（worktree、产物目录）也算任务声明目录。
  for (const root of ctx.workRoots || []) {
    if (!within(resolved, root) || norm(resolved) === norm(root)) continue;
    const top = norm(path.win32.join(root, path.win32.relative(norm(root), resolved).split('\\')[0]));
    if (typeof ctx.dirBirth === 'function' && ctx.joinedAt) {
      let born = null;
      try { born = await ctx.dirBirth(top); } catch { born = null; }
      if (born == null) return true; // 目录不存在：没有可删的东西
      if (born >= ctx.joinedAt - 60 * 1000) return true;
    }
  }
  return false;
}

// ---------- 规则 ④ Hub 生产配置与状态 ----------
function isProtectedData(resolved, ctx) {
  if (!resolved) return false;
  return [].concat(ctx.hubDataDir || []).some(dir => {
    const root = norm(dir);
    if (!root || !within(resolved, root) || resolved === root) return false;
    const rel = path.win32.relative(root, resolved).split('\\');
    if (rel.length === 1) return true; // 根目录下的文件：config.json、state、sqlite…
    return DATA_STATE_DIRS.includes(rel[0]);
  });
}
const COPY_VERBS = new Set(['copy-item', 'cp', 'copy', 'cpi', 'install']);
const WRITE_VERBS = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'copy-item', 'cp', 'copy', 'cpi',
  'move-item', 'mv', 'move', 'mi', 'rename-item', 'ren', 'rni', 'tee', 'tee-object', 'touch', 'mkdir', 'md', 'install', 'clear-content', 'clc']);
function writeTargets({ tokens, seg }, ctx) {
  const head = baseName(tokens[0]);
  const out = redirectTargets(seg).map(t => resolvePath(t, ctx.cwd, ctx.env)).filter(Boolean);
  const isSedI = head === 'sed' && tokens.some(t => /^-i/.test(t) || t === '--in-place');
  const isDelete = DELETE_CMDS.has(head);
  if (WRITE_VERBS.has(head) || isSedI || isDelete) {
    const positional = [];
    let destination = null;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^-(destination)$/i.test(t)) { destination = tokens[++i]; continue; }
      // cp/mv -t 目录、--target-directory[=]目录：写进的是这个目录（Codex 复审 P1）。
      if (t === '-t' || t === '--target-directory') { destination = tokens[++i]; continue; }
      if (t.startsWith('--target-directory=')) { destination = t.slice('--target-directory='.length); continue; }
      if (/^-(path|literalpath|filepath|value|encoding|itemtype|name)$/i.test(t)) { if (!/^-(path|literalpath|filepath)$/i.test(t)) { i++; continue; } positional.push(tokens[++i]); continue; }
      if (/^-/.test(t) || /^\/[a-zA-Z]$/.test(t)) continue;
      positional.push(t);
    }
    // 复制只写目标：cp 源 目标、Copy-Item 源 -Destination 目标；复制源只是读（Codex 审查 P2：误拦从生产 config 复制到临时目录）。
    const targets = COPY_VERBS.has(head) ? [destination || positional[positional.length - 1]] : [...positional, destination];
    for (const t of targets) {
      const r = t ? resolvePath(t, ctx.cwd, ctx.env) : null;
      if (r) out.push(r);
    }
  }
  return out;
}
function checkDataWrite(cmd, ctx) {
  for (const target of writeTargets(cmd, ctx)) {
    if (isProtectedData(target, ctx)) return { category: 'data', reason: `改写 Hub 生产数据：${target}` };
  }
  return null;
}

// ---------- 规则 ⑤ 按量计费 API ----------
// 只有真正发请求的命令才算调用计费 API：curl/wget/Invoke-RestMethod 等，或 python -c / node -e 内联脚本。
// 在代码里 rg/grep 这个域名不算（Codex 审查 P2）。
const REQUEST_TOOLS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'https', 'xh', 'httpie']);
function checkApiRequest({ tokens, seg }) {
  const host = seg.match(API_HOSTS);
  if (!host) return null;
  const head = baseName(tokens[0]);
  const inline = /^(python|python3|py|node|deno|bun|ruby|perl)$/.test(head) && tokens.some(t => /^-(c|e|-eval)$/.test(t));
  return REQUEST_TOOLS.has(head) || inline ? { category: 'api', reason: `直接调用 ${host[0]}` } : null;
}
function checkApi(command) {
  const c = String(command || '');
  const key = c.match(API_KEY_NAMES);
  if (key) return { category: 'api', reason: `读取或使用 ${key.slice(1).find(Boolean) || 'API 密钥'}` };
  if (GATEWAY_STORE.test(c)) return { category: 'api', reason: '读取 Hub 保存的部门 API key（api-gateway/gateway.json）' };
  return null;
}

// ---------- 只读成员 ----------
const READONLY_GIT = new Set(['commit', 'add', 'rm', 'mv', 'checkout', 'switch', 'reset', 'merge', 'rebase', 'stash', 'apply', 'am',
  'cherry-pick', 'revert', 'push', 'pull', 'tag', 'restore', 'clean', 'worktree', 'init', 'clone', 'fetch']);
function checkReadOnlyShell(cmd, ctx) {
  const head = baseName(cmd.tokens[0]);
  const g = gitInvocation(cmd.tokens);
  if (g && READONLY_GIT.has(g.sub) && !(g.sub === 'stash' && /^(list|show)$/.test(g.args[0] || '')) && !(g.sub === 'worktree' && /^list$/.test(g.args[0] || '')) && !(g.sub === 'tag' && !g.args.length))
    return { category: 'read', reason: `只读成员不能执行 git ${g.sub}` };
  if (/^(npm|pnpm|yarn|pip|pip3|uv)$/.test(head) && /^(install|i|add|uninstall|remove|ci|update|sync)$/i.test(cmd.tokens[1] || ''))
    return { category: 'read', reason: `只读成员不能执行 ${head} ${cmd.tokens[1]}` };
  const targets = writeTargets(cmd, ctx).filter(t => !(ctx.tempRoots || []).some(r => within(t, r)));
  if (targets.length) return { category: 'read', reason: `只读成员不能写 ${targets[0]}` };
  return null;
}

// ---------- 入口 ----------
// input: { toolName, toolInput }
// ctx: { cwd, access:'read'|'write', env, allowRoots[], tempRoots[], workRoots[], joinedAt, hubDataDir, hubProgramDir,
//        protectedPids:Set<number>, protectedBranches[], branchOf(dir)→Promise<string>, dirBirth(dir)→Promise<ms|null> }
// 返回 null 表示放行；否则 { category, label, reason, command }
async function classify(input, ctx0 = {}) {
  const ctx = { env: {}, allowRoots: [], tempRoots: [], workRoots: [], protectedPids: new Set(), ...ctx0 };
  if (!(ctx.protectedPids instanceof Set)) ctx.protectedPids = new Set(ctx.protectedPids || []);
  ctx.protectedBranch = branchMatcher(ctx.protectedBranches);
  const toolName = String(input?.toolName || '');
  const toolInput = input?.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {};
  const finish = (hit, command) => hit ? { ...hit, label: CATEGORY[hit.category], command: String(command || '').slice(0, 500) } : null;

  if (WRITE_TOOLS.has(toolName)) {
    const file = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';
    const resolved = resolvePath(file, ctx.cwd, ctx.env);
    if (resolved && isProtectedData(resolved, ctx)) return finish({ category: 'data', reason: `${toolName} 改写 Hub 生产数据：${resolved}` }, `${toolName} ${file}`);
    if (ctx.access === 'read' && !(resolved && ctx.tempRoots.some(r => within(resolved, r))))
      return finish({ category: 'read', reason: `只读成员不能用 ${toolName} 写 ${file || '文件'}` }, `${toolName} ${file}`);
    return null;
  }
  if (!SHELL_TOOLS.has(toolName)) return null;
  const command = String(toolInput.command || '');
  if (!command.trim()) return null;

  const api = checkApi(command);
  if (api) return finish(api, command);
  const pipe = checkKillPipeline(command);
  if (pipe) return finish(pipe, command);
  const cmds = allCommands(command, 0, ctx.cwd ? norm(ctx.cwd) : null, ctx.env);
  for (const cmd of cmds) {
    const c = { ...ctx, cwd: cmd.cwd };
    const hit = checkApiRequest(cmd) || (await checkGit(cmd, c)) || checkKill(cmd, c) || checkDataWrite(cmd, c) || (await checkDelete(cmd, c));
    if (hit) return finish(hit, command);
  }
  if (ctx.access === 'read') for (const cmd of cmds) {
    const hit = checkReadOnlyShell(cmd, { ...ctx, cwd: cmd.cwd });
    if (hit) return finish(hit, command);
  }
  return null;
}


module.exports = { classify, CATEGORY, DEFAULT_PROTECTED_BRANCHES, DATA_STATE_DIRS, splitSegments, tokenize, resolvePath, redirectTargets, isProtectedData, within, norm };
