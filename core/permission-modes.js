'use strict';
// 启动中心「权限模式」（2026-11-20 产品负责人拍板）：每个 AI 编程工具能选哪几档、怎么叫、一句白话说明。
// 主进程（核对 IPC 传来的值、落盘恢复）和启动中心（画下拉）共用这一张表。
// 默认一律「完全放开」：组队成员、群聊、助理等后台会话不经启动中心，靠主进程这个缺省值保持免确认。
// auto（安全分类器自动批准）只给 CodeAgent：Claude Code 的 auto 每步多一次分类器调用、另外计费。
// Codex（二期，2026-11-20 Windows PTY 实测 codex 0.169）：「每步确认」= 只读沙箱 + 按需批准
// （approval_policy=on-request, sandbox_mode=read-only）：要写文件、跑命令就弹「Would you like to run…」，终端里选；
// 批准的那一步在沙箱外执行。on-request + danger-full-access 实测不弹确认，所以不提供；workspace-write 在 Windows 上不可用。

const DEFAULT_MODE = 'bypassPermissions';

const MODES = Object.freeze({
  bypassPermissions: { label: '完全放开', desc: 'AI 直接执行命令、改删文件，不再问你，速度最快。' },
  acceptEdits: { label: '自动改文件', desc: '改文件直接做；运行命令前先问你。' },
  default: { label: '每步确认', desc: '改文件、运行命令前都先问你。' },
  plan: { label: '只讨论不改', desc: '计划模式：只读代码、出方案，不改文件、不执行命令。' },
  auto: { label: '自动判断', desc: '由公司安全分类器自动批准或拒绝，危险操作会被拦下。' },
});

const BYPASS_RISK = 'AI 执行命令、改删文件前不再问你。只在愿意交给 AI 的文件夹里用；公司手册提醒不要只为少点确认而选它。';
const UNSUPPORTED_NOTE = '暂不支持切换';

const SUPPORTED = Object.freeze({
  claude: Object.freeze(['bypassPermissions', 'acceptEdits', 'default', 'plan']),
  codex: Object.freeze(['bypassPermissions', 'default']),
  codeagent: Object.freeze(['bypassPermissions', 'acceptEdits', 'default', 'plan', 'auto']),
});

function baseKind(kind) { return String(kind || '').replace(/-resume$/, ''); }

function modesFor(kind) { return SUPPORTED[baseKind(kind)] || [DEFAULT_MODE]; }

function supportsSwitch(kind) { return !!SUPPORTED[baseKind(kind)]; }

// 只认白名单值：IPC 字符串会拼进命令行。不认的返回 null，由调用方落回默认。
function normalize(kind, mode) {
  const list = SUPPORTED[baseKind(kind)];
  return list && typeof mode === 'string' && list.includes(mode) ? mode : null;
}

// 同一档在不同工具上的说明不同时，这里覆盖（Codex 的每步确认靠只读沙箱实现）。
const DESC_BY_KIND = Object.freeze({
  codex: Object.freeze({ default: '要改文件、运行命令时先问你（只读沙箱 + 按需批准）；批准的那一步按本机权限执行。' }),
});

function describe(kind, mode) { return DESC_BY_KIND[baseKind(kind)]?.[mode] || MODES[mode]?.desc || ''; }

function optionsFor(kind) {
  return modesFor(kind).map(id => ({ id, label: MODES[id].label + (id === DEFAULT_MODE ? '（默认）' : ''), desc: describe(kind, id) }));
}

// Codex 命令行：完全放开沿用原来的旁路参数；每步确认去掉旁路参数，用 -c 覆盖审批与沙箱（-c 优先于 config.toml）。
function codexPermissionArgs(mode) {
  return mode === 'default'
    ? { flag: '', approval: 'on-request', sandbox: 'read-only' }
    : { flag: ' --dangerously-bypass-approvals-and-sandbox', approval: 'never', sandbox: 'danger-full-access' };
}

module.exports = { DEFAULT_MODE, MODES, BYPASS_RISK, UNSUPPORTED_NOTE, baseKind, modesFor, supportsSwitch, normalize, optionsFor, describe, codexPermissionArgs };
