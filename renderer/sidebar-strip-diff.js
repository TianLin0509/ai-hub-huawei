'use strict';
// 底部状态条网络区的重画决策（2026-11-23 开销优化）。
// 状态条每 5 秒刷新一次（CPU、内存、网速、出口）。以前只要整条有一处变了，网络区（求助、用户群按钮、VPN 行、网速）
// 就整段 innerHTML 重写一遍。这里按「上次 / 这次」的文本签名决定怎么画：
//   'skip'     网络区一字未变：不动；
//   'transfer' 只有网速那一小段变了：只换网速；
//   'all'      别的也变了（出口、节点、按钮）：整段重写。
function stripNetworkPlan(prev, next) {
  if (!prev || !next) return 'all';
  if (prev.inner === next.inner) return 'skip';
  if (!prev.transfer || !next.transfer) return 'all';
  const rest = (parts) => String(parts.inner).replace(String(parts.transfer), '');
  return prev.transfer !== next.transfer && rest(prev) === rest(next) ? 'transfer' : 'all';
}
module.exports = { stripNetworkPlan };
