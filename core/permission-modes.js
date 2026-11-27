'use strict';
// 启动中心「权限模式」：每个 AI 编程工具能选哪几档、怎么叫、一句白话说明、不支持的档为什么不支持。
// 主进程（核对 IPC 传来的值、落盘恢复）和启动中心（画下拉）共用这一张表。
// 两个「默认」分开（2026-11-26）：
//   DEFAULT_MODE = 主进程缺省，始终「完全放开」：组队成员、群聊、助理、会议等后台会话不经启动中心，靠它保持免确认，不变；
//   launchDefault(kind) = 启动中心给新用户的默认，取这个工具支持的最保守一档（不默认完全放开）。
//   老用户升级后保留原来的选择（renderer/launch-last-permission.js 的一次性迁移）。
// auto（安全分类器自动批准）只给 CodeAgent：Claude Code 的 auto 每步多一次分类器调用、另外计费。
// Codex（2026-11-20 Windows PTY 实测 codex 0.169）：「每步确认」= 只读沙箱 + 按需批准
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

// 下拉里的显示顺序：保守的在前。
const ORDER = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
// 新用户默认取第一个支持的（「只讨论不改」虽然更严，但什么都做不了，不拿来当默认）。
const CONSERVATIVE = Object.freeze(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);

const BYPASS_RISK = 'AI 执行命令、改删文件前不再问你。只在愿意交给 AI 的文件夹里用；公司手册提醒不要只为少点确认而选它。';
const UNSUPPORTED_NOTE = '暂不支持切换';

const SUPPORTED = Object.freeze({
  claude: Object.freeze(['bypassPermissions', 'acceptEdits', 'default', 'plan']),
  codex: Object.freeze(['bypassPermissions', 'default']),
  codeagent: Object.freeze(['bypassPermissions', 'acceptEdits', 'default', 'plan', 'auto']),
  // DSH（2026-11-26 读 @deepseek-ai/dsh 0.2.2 与 dsh-tui 0.20 源码）：权限 = 沙箱 + 越界才问（DSH_PERMISSION_MODE 三档）。
  // 没有「每次调用工具都问」：只有命令被沙箱挡住、模型申请一次性升权时才弹「允许一次 / 拒绝」。
  'deepseek-acp': Object.freeze(['bypassPermissions', 'acceptEdits', 'default']),
  // opencode（2026-11-26）：permission 配置（edit / bash 的 allow、ask、deny）+ 自带的 plan 智能体，见 core/opencode-cli-profile.js permissionConfig。
  opencode: Object.freeze(['bypassPermissions', 'acceptEdits', 'default', 'plan']),
});
const SWITCHABLE_KINDS = Object.freeze(Object.keys(SUPPORTED));

// 不支持的档写清原因（下拉里灰掉、悬停看原因）。没写的按通用说法。
const REASONS = Object.freeze({
  claude: Object.freeze({ auto: 'Claude Code 的自动判断每步要多调一次分类器、另外计费，Hub 不开放。' }),
  codex: Object.freeze({
    acceptEdits: 'Codex 在 Windows 上没有「只放开改文件」的工作区沙箱，做不到改文件不问、命令要问。',
    plan: 'Codex 没有只讨论不改的启动参数。',
    auto: '自动判断是 CodeAgent 的公司安全分类器，Codex 没有。',
  }),
  codeagent: Object.freeze({}),
  'deepseek-acp': Object.freeze({
    plan: 'DSH 的计划模式启动时进不去：会话里输入 /plan 或按 Shift+Tab 切到「只讨论不改」。',
    auto: 'DSH 的自动审查还只是实验功能，终端版没有；自动判断是 CodeAgent 的公司安全分类器。',
  }),
  pi: Object.freeze({
    acceptEdits: 'pi 本身没有权限确认机制，所有操作都直接执行。',
    default: 'pi 本身没有权限确认机制，所有操作都直接执行。',
    plan: 'pi 没有计划模式。',
    auto: '自动判断是 CodeAgent 的公司安全分类器，pi 没有。',
  }),
});
const GENERIC_AUTO = '自动判断是 CodeAgent 的公司安全分类器，这个工具没有。';

// 已开的会话怎么换档：这里改的只影响之后新建的会话。
const LIVE_SWITCH = Object.freeze({
  claude: '已开的会话不受影响：要当场换档，点进终端按 Shift+Tab 轮换（不用重启）；Hub 恢复或重启这个会话时回到启动时选的档。',
  codeagent: '已开的会话不受影响：要当场换档，点进终端按 Shift+Tab 轮换（不用重启）；Hub 恢复或重启这个会话时回到启动时选的档。',
  codex: '已开的会话不受影响：要当场换档，在终端输入 /permissions 选择（不用重启）；Hub 恢复或重启这个会话时回到启动时选的档。',
  'deepseek-acp': '已开的会话不受影响：以保守档启动的终端会话可点进终端按 Shift+Tab 在「每步确认 / 自动改文件 / 只讨论不改」间轮换（不用重启）；完全放开启动的会话和卡片方式要新建会话才能换档。注意：只约束 DSH 默认的标准预设；在终端用 /preset 换成别的预设（如梁神模式）后工具不受这里约束。',
});

function baseKind(kind) { return String(kind || '').replace(/-resume$/, ''); }

function modesFor(kind) { return SUPPORTED[baseKind(kind)] || [DEFAULT_MODE]; }

function supportsSwitch(kind) { return !!SUPPORTED[baseKind(kind)]; }

function launchDefault(kind) { const list = modesFor(kind); return CONSERVATIVE.find(mode => list.includes(mode)) || DEFAULT_MODE; }

// 只认白名单值：IPC 字符串会拼进命令行。不认的返回 null，由调用方落回默认。
function normalize(kind, mode) {
  const list = SUPPORTED[baseKind(kind)];
  return list && typeof mode === 'string' && list.includes(mode) ? mode : null;
}

// 同一档在不同工具上的说明不同时，这里覆盖（Codex 的每步确认靠只读沙箱实现）。
const DESC_BY_KIND = Object.freeze({
  codex: Object.freeze({ default: '要改文件、运行命令时先问你（只读沙箱 + 按需批准）；批准的那一步按本机权限执行。' }),
  'deepseek-acp': Object.freeze({
    acceptEdits: '工作目录内改文件、跑命令直接做（命令在沙箱里跑）；要动工作目录以外时先问你。DSH 要给工作目录和临时目录加权限标记：若报「grant failed」（部分 D 盘目录不允许），请改用「每步确认」。',
    default: '只读沙箱：看代码不问；要改文件、跑会改东西的命令时先问你「允许一次 / 拒绝」。',
  }),
});

function describe(kind, mode) { return DESC_BY_KIND[baseKind(kind)]?.[mode] || MODES[mode]?.desc || ''; }

function unsupportedReason(kind, mode) {
  if (modesFor(kind).includes(mode)) return '';
  const own = REASONS[baseKind(kind)]?.[mode];
  if (own) return own;
  if (!supportsSwitch(kind)) return `这个工具${UNSUPPORTED_NOTE}权限模式，始终完全放开。`;
  return mode === 'auto' ? GENERIC_AUTO : '这个工具没有这一档。';
}

function liveSwitchNote(kind) { return LIVE_SWITCH[baseKind(kind)] || '这里改的只影响之后新建的会话；已开的会话要换档，请新建一个。'; }

// 下拉选项：五档全列，按保守在前排序；不支持的带 disabled 和原因。userDefault 是这个工具当前的默认档，标「（默认）」。
function optionsFor(kind, { userDefault = launchDefault(kind) } = {}) {
  const list = modesFor(kind);
  return ORDER.map(id => {
    const supported = list.includes(id);
    return { id, supported, desc: supported ? describe(kind, id) : unsupportedReason(kind, id),
      label: MODES[id].label + (supported && id === userDefault ? '（默认）' : supported ? '' : '（不支持）') };
  });
}

// DSH：每档 = 沙箱 + 审批（DSH_PERMISSION_MODE 定启动档）；终端版 Shift+Tab 轮换的档位表（dsh-tui modes）把所选档排第一。
// 轮换表里不放完全放开，免得选了保守档的人一按 Shift+Tab 就全放开；选完全放开启动的会话沿用原来的单档配置，
// 老用户（默认完全放开）启动 DSH 的参数与升级前一字不差。
// approval=never 在 DSH 里是「越界直接拒、不弹框」，所以只配给完全放开。
const DSH_BUNDLES = Object.freeze({
  acceptEdits: Object.freeze({ id: 'hub-edit', plan: false, sandbox: 'workspace-write', approval: 'ask' }),
  default: Object.freeze({ id: 'hub-ask', plan: false, sandbox: 'read-only', approval: 'ask' }),
  plan: Object.freeze({ id: 'hub-plan', plan: true, sandbox: 'read-only', approval: 'ask' }),
  bypassPermissions: Object.freeze({ id: 'hub-full', plan: false, sandbox: 'danger-full-access', approval: 'never' }),
});
function dshPermission(mode) {
  const chosen = normalize('deepseek-acp', mode) || DEFAULT_MODE;
  const cycle = chosen === DEFAULT_MODE ? [chosen] : [chosen, ...['acceptEdits', 'default', 'plan'].filter(id => id !== chosen)];
  return { mode: chosen, sandbox: DSH_BUNDLES[chosen].sandbox, policy: chosen === DEFAULT_MODE ? 'bypass' : 'ask',
    modes: cycle.map(id => ({ ...DSH_BUNDLES[id], label: MODES[id].label })) };
}

// Codex 命令行：完全放开沿用原来的旁路参数；每步确认去掉旁路参数，用 -c 覆盖审批与沙箱（-c 优先于 config.toml）。
function codexPermissionArgs(mode) {
  return mode === 'default'
    ? { flag: '', approval: 'on-request', sandbox: 'read-only' }
    : { flag: ' --dangerously-bypass-approvals-and-sandbox', approval: 'never', sandbox: 'danger-full-access' };
}

module.exports = { DEFAULT_MODE, MODES, ORDER, BYPASS_RISK, UNSUPPORTED_NOTE, SWITCHABLE_KINDS, baseKind, modesFor, supportsSwitch, launchDefault,
  normalize, optionsFor, describe, unsupportedReason, liveSwitchNote, codexPermissionArgs, dshPermission };
