'use strict';
// 「只允许改工作目录内的文件」（R34，2026-11-24，WeLink 反馈：选了工作目录，AI 还是把别处的核心代码改了）。
//
// 工作目录本身只是会话的启动目录（cwd），三种后端都不会因为它就不去改别处的文件：
//   Claude Code / CodeAgent：Hub 默认用 bypassPermissions 启动，改哪里都不问；Windows 上没有命令行沙箱。
//   Codex：Hub 用 danger-full-access；workspace-write 沙箱在 Windows 上不可用（公司真机报
//          「read cap sid file」，所有命令都跑不了），所以 Codex 拦不住，只能提示。
// 能拦的部分：Claude Code / CodeAgent 的 PreToolUse hook 在任何权限档下都会先执行，退出码 2 即拒绝这次工具调用。
// Hub 把这条 hook 写进本次启动专用的 --settings 叠加文件（Hub 数据目录里），不改用户自己的 settings.json。
// 只管改文件的工具（Edit / Write / MultiEdit / NotebookEdit）；AI 用命令行、脚本写别处仍拦不住，界面如实说明。
// 公司 CodeAgent 1.2615.02.05 核实（Q-1124-60，2026-11-24 只读查帮助与内网手册）：PreToolUse 在用（Hub 的 ask-gate /
// upload-guard 就挂在这里），手册《Hooks使用指导》3.5：exit 2 阻止本次工具调用、stderr 交给模型；没有 --sandbox 启动参数。
// CodeAgent 另有 Windows 沙箱（settings 的 sandbox 对象，默认关，开了连命令行写工作区外也拦），和 Codex 同源；
// Codex 同款沙箱在公司真机 unelevated + workspace-write 报错，CodeAgent 这一路要真机实测后才考虑接入，这里不开。

const fs = require('fs');
const os = require('os');
const path = require('path');

const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
// 组队成员危险动作硬拦（main/team/member-guard.js，2026-11-28 移植）：和本守卫共用同一个 hook 入口、同一个脚本，
// 成员会话再加上命令类工具；脚本先做本地的工作目录判断，再问 Hub 成员守卫。两项都开时只起一个 PowerShell。
const MEMBER_MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit';
const SCRIPT = 'hub-workspace-guard.ps1';

// 哪些后端能真拦（改文件工具这一层），哪些只是提示。
const GUARDED_KINDS = Object.freeze(['claude', 'codeagent']);
function baseKind(kind) { return String(kind || '').replace(/-resume$/, ''); }
function supports(kind) { return GUARDED_KINDS.includes(baseKind(kind)); }

// 界面上「工作目录」旁的一行说明；勾选与否、后端能不能拦，说法不同。
// available=false：后端本身能拦，但这次的启动方式挂不上（CodeAgent Lite：工具在共享 serve 进程里执行）。
const HINT_ONLY = '只是提示 AI，拦不住它改别处的文件；重要代码请先提交或备份。';
const GUARD_ON = '已限制只能改工作区内的文件；AI 用命令行或脚本仍可能改到别处，重要代码请先提交或备份。';
const GUARD_OFF = '不勾时只是提示 AI，拦不住它改别处的文件；重要代码请先提交或备份。';
function note(kind, enabled, { available = true } = {}) {
  if (baseKind(kind) === 'powershell') return '';
  if (!supports(kind) || !available) return HINT_ONLY;
  return enabled ? GUARD_ON : GUARD_OFF;
}

// 放行的目录：工作目录、本次已加的额外目录（--add-dir），以及 CLI 自己记计划、记忆和临时文件的地方。
function allowedRoots({ cwd, addDirs = [], configDir = '', env = process.env } = {}) {
  const roots = [];
  const seen = new Set();
  const add = dir => {
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) return;
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(resolved);
    // 再加真实路径：工作目录经 junction / 符号链接打开，或 TEMP 是 8.3 短名时，AI 写的真实长路径也算在内；
    // 拦截脚本那边会顺着链接解出写入的真实位置再比。
    try {
      const real = fs.realpathSync.native(resolved);
      if (real && !seen.has(real.toLowerCase())) { seen.add(real.toLowerCase()); roots.push(real); }
    } catch {}
  };
  add(cwd);
  for (const dir of addDirs || []) add(String(dir || ''));
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const cliDir = configDir || env.CLAUDE_CONFIG_DIR || (home ? path.join(home, '.claude') : '');
  if (cliDir) { add(path.join(cliDir, 'plans')); add(path.join(cliDir, 'projects')); add(path.join(cliDir, 'todos')); }
  add(env.TEMP || env.TMP || os.tmpdir());
  return roots;
}

function encodeRoots(roots) { return Buffer.from(JSON.stringify(roots), 'utf8').toString('base64'); }

// settings.hooks 片段。命令首词必须是裸命令名（见 core/hook-runner.js）；PowerShell 每台 Windows 都有。
// member 为真：第二个参数写 member，脚本再问 Hub 成员守卫；只开成员守卫时第一个参数是空数组。
function claudeHooks({ roots, scriptPath, member = false }) {
  const list = Array.isArray(roots) ? roots : [];
  if ((!list.length && !member) || !scriptPath) return null;
  const command = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath.replace(/\\/g, '/')}" ${encodeRoots(list)}${member ? ' member' : ''}`;
  return { PreToolUse: [{ matcher: member ? MEMBER_MATCHER : MATCHER, hooks: [{ type: 'command', command, timeout: 20 }] }] };
}

function scriptPath() {
  const scriptsDir = path.join(__dirname, '..', 'scripts').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return path.join(scriptsDir, SCRIPT);
}

// 用户个人策略里也可能带 hooks（core/agent-user-context.js claudeSharedConfig）：按事件拼接，不互相覆盖。
function mergeHooks(base, extra) {
  const out = {};
  for (const source of [base, extra]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [event, groups] of Object.entries(source)) {
      if (!Array.isArray(groups)) continue;
      out[event] = [...(out[event] || []), ...groups];
    }
  }
  return out;
}

// 会话选项 → 叠加进 --settings 的内容；没开或后端不支持时返回 null。
// 工作目录限制（opts.workspaceGuard）和组队成员守卫合成一条 hook：一个判定入口。
function settingsOverlay(kind, opts, { cwd, addDirs, configDir, env, sessionId } = {}) {
  if (!opts || !supports(kind)) return null;
  const workspace = opts.workspaceGuard === true;
  const member = isMember(opts, sessionId);
  if (!workspace && !member) return null;
  const hooks = claudeHooks({ roots: workspace ? allowedRoots({ cwd, addDirs, configDir, env }) : [], scriptPath: scriptPath(), member });
  return hooks ? { hooks } : null;
}

// 组队成员判定（main.js 接组队名册）：新建时 opts.memberGuard，恢复、原地重拉时按名册。没接上时只认 opts。
let memberPredicate = null;
function setMemberPredicate(fn) { memberPredicate = typeof fn === 'function' ? fn : null; }
function isMember(opts, sessionId) {
  if (opts && opts.memberGuard === true) return true;
  const id = sessionId || (opts && opts.id);
  if (!memberPredicate || !id) return false;
  try { return !!memberPredicate(String(id)); } catch { return false; }
}

module.exports = { HINT_ONLY, GUARD_ON, GUARD_OFF, MATCHER, MEMBER_MATCHER, setMemberPredicate, isMember, GUARDED_KINDS, supports, note, allowedRoots, encodeRoots, claudeHooks, mergeHooks, scriptPath, settingsOverlay };
