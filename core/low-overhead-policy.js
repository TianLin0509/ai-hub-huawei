'use strict';
// 低开销模式（2026-11-23 P1）：一个开关 + 保活会话数，运行期切换、免重启生效。
// 默认关闭；关闭时每个策略函数都返回和原来完全一样的值，调用方据此走原路径（零回归）。
//
// P1 v2（与主干「低开销模式」统一）：开关真值就是 core/optional-features.js 的 lowOverhead()（设置「资源与后台」
// 那个总开关），保活会话数也记在同一个 optional-features.json（lowOverheadKeepAlive，1 | 2 | 3，默认 2）。
// 这里只放纯策略；状态对象统一为 { on, enabled: on, keepAlive }，两种写法都认。
//
// 六项策略：
//   L1 活跃会话保活软上限（main/low-overhead-controller.js 定时巡检，挑人用 pickSoftCapVictims）
//   L2 新建 CodeAgent 会话优先走共享 serve（卡片），真实 HOME 不变
//   L3 桌宠静默省电：空闲不排帧、停装饰循环动画，提醒气泡照常
//   L4 历史搜索子进程空闲 10 分钟退出，下次搜索自动拉起
//   L5 终端回滚 10000→3000 行，非当前终端不闪光标
//   L6 非关键后台刷新放慢 4 倍，state.json 最短落盘间隔 2→5 秒（退出前照常立刻刷盘）

const KEEP_ALIVE_CHOICES = [1, 2, 3];
const DEFAULT_KEEP_ALIVE = 2;

// L1
const SOFT_CAP_CHECK_MS = 60 * 1000;
// 当前会话挂着不动超过 30 分钟，才不再豁免。
const FOCUS_IDLE_EXEMPT_MS = 30 * 60 * 1000;
// 被挤出保活名额的会话，至少已经 10 分钟没有输入输出才休眠，免得刚切走就被收。
const SOFT_CAP_MIN_IDLE_MS = 10 * 60 * 1000;
const SOFT_CAP_REASON = 'low-overhead-cap';
const BUSY_STATUSES = new Set(['running', 'waiting', 'starting', 'suspending']);
// 这些原因说明会话属于别的流程（群聊、后台任务、受保护任务），软上限不碰。
// native-session-id-missing：还没绑定原生会话 ID，休眠了也恢复不回来，同样不碰、也不计入可回收数。
const PROTECTED_REASONS = new Set(['pinned', 'meeting-member', 'active-task', 'protected-session',
  'suspend-pending', 'pty-turn-unfinished', 'native-turn-unfinished', 'codeagent-not-settled', 'native-session-id-missing']);
// 助理、分身等后台用途沿用 CodeAgent 试点的排除表（成员版/公开版各自一份），再加自动起名与编排会话。
const ASSISTANT_PURPOSES = new Set([...require('./codeagent-run-mode').EXCLUDED_PURPOSES, 'auto-title', 'hub-orchestrator']);

// L4
const SEARCH_IDLE_EXIT_MS = 10 * 60 * 1000;
// L5
const NORMAL_SCROLLBACK = 10000;
const LOW_SCROLLBACK = 3000;
// L6
const BACKGROUND_SLOWDOWN = 4;
const NORMAL_STATE_SAVE_MIN_MS = 2000;
const LOW_STATE_SAVE_MIN_MS = 5000;

const STRATEGY_LINES = [
  '活跃会话按上限自动休眠（正在回答、待审批、置顶的不动，点开即恢复）',
  'CodeAgent 新会话默认卡片模式，共用一个后台进程',
  '桌宠静默省电，提醒气泡照常',
  '历史搜索进程空闲 10 分钟退出，下次搜索自动拉起',
  '终端回滚收敛到 3000 行，后台终端不闪光标',
  '后台状态刷新放慢 4 倍，状态存盘合并',
];

function normalizeKeepAlive(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_KEEP_ALIVE;
  return Math.min(3, Math.max(1, n));
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const on = source.on === true || source.enabled === true;
  return { on, enabled: on, keepAlive: normalizeKeepAlive(source.keepAlive ?? DEFAULT_KEEP_ALIVE) };
}

// ── L1 ──────────────────────────────────────────────────────────────
// items：每个活会话一条 { sessionId, eligible, reason, status, settled, pinned, pendingApproval,
//   hidden, purpose, exempt, focused, focusedAt, idleMs, lastActivityAt }。
// 返回 { victims, kept, exempt }：victims 按最后活动从早到晚排，调用方依次休眠。
//
// 焦点保护（Codex R3 / Gemini P1-1）：30 分钟从「上次输入输出」和「这次切过来看」两者中较晚的那个算起——
// 一小时前答完的旧会话刚被点开阅读，立刻受保护；挂着不动满 30 分钟才解除。
function focusIdleMsOf(item, now) {
  const idleMs = Number(item.idleMs);
  const focusedAt = Number(item.focusedAt);
  const base = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : null;
  if (Number.isFinite(focusedAt) && focusedAt > 0 && Number.isFinite(now)) {
    const sinceFocus = Math.max(0, now - focusedAt);
    return base == null ? sinceFocus : Math.min(base, sinceFocus);
  }
  return base;
}

function exemptReason(item, { focusIdleMs = FOCUS_IDLE_EXEMPT_MS, now = Date.now() } = {}) {
  if (item.exempt) return 'external';
  if (item.pinned) return 'pinned';
  if (item.pendingApproval) return 'pending-approval';
  if (item.settled === false || BUSY_STATUSES.has(String(item.status || ''))) return 'busy';
  if (item.focused) {
    const focusIdle = focusIdleMsOf(item, now);
    if (!(focusIdle >= focusIdleMs)) return 'focused';
  }
  if (!item.eligible && PROTECTED_REASONS.has(item.reason)) return item.reason;
  // 时间全空的异常输入：不知道多久没动，保守跳过（不能当成「无限久以前」排最旧先收）。
  if (!(Number(item.lastActivityAt) > 0)) return 'no-activity-time';
  return null;
}

function pickSoftCapVictims(items, options = {}) {
  const keepAlive = normalizeKeepAlive(options.keepAlive);
  const focusIdleMs = Number(options.focusIdleMs) > 0 ? Number(options.focusIdleMs) : FOCUS_IDLE_EXEMPT_MS;
  const now = Number.isFinite(Number(options.now)) && Number(options.now) > 0 ? Number(options.now) : Date.now();
  const normal = (items || []).filter(item => item && item.sessionId && !item.hidden && !ASSISTANT_PURPOSES.has(item.purpose || ''));
  const exempt = [];
  const reclaimable = [];
  for (const item of normal) {
    const why = exemptReason(item, { focusIdleMs, now });
    if (why) exempt.push({ sessionId: item.sessionId, why });
    else reclaimable.push(item);
  }
  // 最近用过的排前面，保活前 keepAlive 个；其余从最早的开始收。
  reclaimable.sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0));
  const kept = reclaimable.slice(0, keepAlive);
  const victims = reclaimable.slice(keepAlive)
    .filter(item => item.eligible !== false)
    .sort((a, b) => (Number(a.lastActivityAt) || 0) - (Number(b.lastActivityAt) || 0));
  return { victims, kept, exempt, reclaimableCount: reclaimable.length };
}

// ── L2 ──────────────────────────────────────────────────────────────
// 启动中心里 CodeAgent 新会话用哪种运行方式。开启时优先 serve（共享进程），
// 用户在这次面板里亲手选了 PTY 就尊重他的选择。
function codeagentRunModeFor(savedMode, state, { explicit = false } = {}) {
  const saved = savedMode === 'serve' ? 'serve' : 'pty';
  if (!normalizeState(state).enabled || explicit) return saved;
  return 'serve';
}

// ── L3 ──────────────────────────────────────────────────────────────
const petLowPower = state => normalizeState(state).enabled;

// ── L4 ──────────────────────────────────────────────────────────────
// 返回 null 表示沿用原策略（常驻或 HUB_SESSION_SEARCH_IDLE_MS）。
const searchIdleExitMs = state => (normalizeState(state).enabled ? SEARCH_IDLE_EXIT_MS : null);

// ── L5 ──────────────────────────────────────────────────────────────
function terminalOptions(state, { active = true } = {}) {
  if (!normalizeState(state).enabled) return { scrollback: NORMAL_SCROLLBACK, cursorBlink: true };
  return { scrollback: LOW_SCROLLBACK, cursorBlink: active === true };
}

// ── L6 ──────────────────────────────────────────────────────────────
const backgroundIntervalMs = (baseMs, state) => (normalizeState(state).enabled ? baseMs * BACKGROUND_SLOWDOWN : baseMs);
const stateSaveMinIntervalMs = state => (normalizeState(state).enabled ? LOW_STATE_SAVE_MIN_MS : NORMAL_STATE_SAVE_MIN_MS);

// ⓘ 悬停说明：第一行是标题，其余每行一项（hub-tooltip 按「首行标题 + 条目」排版）。
// 和主干「资源与后台」的说明合成一张卡：后台可选功能怎么处理 + 会话与运行期六项节能。
const BACKGROUND_LINES = [
  '打开：后台可选功能全部关掉，只留会话核心；哪项用到了，在它自己的页面上点「开启」',
  '关闭：底栏读数、搜索索引、额度刷新恢复老版本的行为，助理等可选功能保持原样',
];
function strategyHint() {
  return ['低开销模式（切换立即生效，关掉即恢复原样）', ...BACKGROUND_LINES,
    ...STRATEGY_LINES.map((line, i) => `会话节能 ${i + 1}：${line}`),
    '新装默认打开；老用户升级不改任何开关'].join('\n');
}

module.exports = {
  KEEP_ALIVE_CHOICES,
  DEFAULT_KEEP_ALIVE,
  SOFT_CAP_CHECK_MS,
  SOFT_CAP_MIN_IDLE_MS,
  SOFT_CAP_REASON,
  FOCUS_IDLE_EXEMPT_MS,
  SEARCH_IDLE_EXIT_MS,
  NORMAL_SCROLLBACK,
  LOW_SCROLLBACK,
  BACKGROUND_SLOWDOWN,
  NORMAL_STATE_SAVE_MIN_MS,
  LOW_STATE_SAVE_MIN_MS,
  STRATEGY_LINES,
  normalizeKeepAlive,
  normalizeState,
  focusIdleMsOf,
  exemptReason,
  pickSoftCapVictims,
  codeagentRunModeFor,
  petLowPower,
  searchIdleExitMs,
  terminalOptions,
  backgroundIntervalMs,
  stateSaveMinIntervalMs,
  strategyHint,
};
