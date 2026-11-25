'use strict';
// 设置菜单「检查更新」旁的一行版本状态（2026-11-21，同事反馈小版本不弹窗、以为没更新）：
// 不弹窗、不挂红点，只在打开菜单时看得见——已是最新 / 有新版本 x.y.z / 正在下载 / 已就绪。
// state 是主进程 main/app-update-controller.js 推来的更新状态。labelVersion：菜单项标题已写了「有新版本 vX」时传 X，这行就只写当前版本，不重复。

function menuStatusText(state, { labelVersion = '' } = {}) {
  if (!state) return '';
  const current = String(state.current || '').trim();
  const cur = current ? `v${current}` : '';
  if (state.phase === 'checking') return '正在检查…';
  const latest = state.latest ? String(state.latest.version || '') : '';
  const pending = !!latest && !!state.plan && state.plan.kind !== 'none';
  if (pending && labelVersion && labelVersion === latest) return cur ? `当前 ${cur}` : '';
  if (pending && state.phase === 'ready') return `v${latest} 已就绪，重启生效`;
  if (pending && state.phase === 'downloading') return `正在下载 v${latest}`;
  if (pending && ['available', 'applying', 'error'].includes(state.phase)) return `有新版本 v${latest}`;
  if (state.phase === 'none' && state.pending) return '暂无可装的新版本';
  if (state.phase === 'none' || (latest && !pending)) return cur ? `已是最新 ${cur}` : '已是最新';
  return cur ? `当前 ${cur}` : '';
}

module.exports = { menuStatusText };
