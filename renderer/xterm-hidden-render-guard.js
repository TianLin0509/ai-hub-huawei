'use strict';
// 看不见的终端不整屏重画（2026-10-11 界面卡顿取证）。
//
// xterm 5.5 每滚动一行都会刷新选区：onScroll → SelectionService.refresh → 下一帧
// RenderService.handleSelectionChanged → 渲染器 handleSelectionChanged。DOM 渲染器
// （卡片视图里卸掉 Canvas 后就是它）在这里不管有没有选区都会重画全部行，而且这条路
// 不检查 RenderService 的暂停状态（终端 display:none 或不在视口时 xterm 自己会暂停普通刷新）。
// 藏起来的终端量不到字宽（返回 0 不进缓存），于是每个字都要强制重算一次样式。
// 隔离实测：3 个持续输出的会话藏在卡片后面，再叠一个侧栏呼吸动画，界面进程 60–70%、
// 每秒样式重算 2300 次、帧数掉到 72。
//
// 处理：暂停时只记下选区状态和「待补」标记，不调渲染器；终端重新可见时（xterm 的
// IntersectionObserver 回调解除暂停），用最后一次的选区补调一次，渲染器随之重画全部行。
// 依赖的是 xterm 内部字段；字段不存在（升级后结构变了）就什么都不做，行为退回原样。
//
// 诊断计数（2026-11-23）：退回原样是静默的，xterm 升级后字段对不上时保护会整体失效而没人知道。
// 这里按终端记「装上 / 退回（及原因）」，全局累计「跳过的整屏重画 / 补画」次数；第一次退回时在控制台警告一次。
// 读数：hiddenRenderGuardStats()（渲染进程里也挂在 window.__hubHiddenRenderGuardStats 上，便于取证）。
const stats = { installed: 0, fallback: 0, disabled: 0, reasons: {}, skipped: 0, replayed: 0, warned: false };
function noteFallback(reason, logger = console) {
  stats.fallback++;
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  if (!stats.warned) { stats.warned = true; logger?.warn?.(`[xterm-hidden-render-guard] 隐藏终端重画保护没装上（${reason}），xterm 内部结构可能变了，已退回原样`); }
  return false;
}
function installHiddenRenderGuard(terminal, env = process.env, logger = console) {
  if (env.HUB_DISABLE_HIDDEN_RENDER_GUARD === '1') { stats.disabled++; return false; }
  const rs = terminal && terminal._core && terminal._core._renderService;
  if (rs && rs.__hubHiddenGuard) return false;   // 同一个终端重复调用：已经装过，不算退回
  if (!rs) return noteFallback('no-render-service', logger);
  if (typeof rs.handleSelectionChanged !== 'function') return noteFallback('no-handleSelectionChanged', logger);
  if (typeof rs._handleIntersectionChange !== 'function') return noteFallback('no-_handleIntersectionChange', logger);
  if (!('_isPaused' in rs)) return noteFallback('no-_isPaused', logger);
  if (!rs._selectionState) return noteFallback('no-_selectionState', logger);
  stats.installed++;
  const originalSelection = rs.handleSelectionChanged;
  const originalIntersection = rs._handleIntersectionChange;
  rs.__hubHiddenGuard = { skipped: 0, replayed: 0, pending: null };
  rs.handleSelectionChanged = function guardedSelectionChanged(start, end, columnSelectMode) {
    if (this._isPaused) {
      this._selectionState.start = start;
      this._selectionState.end = end;
      this._selectionState.columnSelectMode = columnSelectMode;
      this.__hubHiddenGuard.pending = [start, end, columnSelectMode];
      this.__hubHiddenGuard.skipped++;
      stats.skipped++;
      return;
    }
    this.__hubHiddenGuard.pending = null;
    return originalSelection.call(this, start, end, columnSelectMode);
  };
  rs._handleIntersectionChange = function guardedIntersectionChange(entry) {
    const result = originalIntersection.call(this, entry);
    const pending = this.__hubHiddenGuard.pending;
    if (!this._isPaused && pending) {
      this.__hubHiddenGuard.pending = null;
      this.__hubHiddenGuard.replayed++;
      stats.replayed++;
      originalSelection.apply(this, pending);
    }
    return result;
  };
  return true;
}

function hiddenRenderGuardStats() { const { warned, ...rest } = stats; return { ...rest, reasons: { ...stats.reasons } }; }
if (typeof window !== 'undefined') window.__hubHiddenRenderGuardStats = hiddenRenderGuardStats;

module.exports = { installHiddenRenderGuard, hiddenRenderGuardStats };
