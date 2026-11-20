'use strict';
// 首次准备里「手动选 CodeAgent」（2026-11-21）：只经定位中心记账——弹框选文件走 harness:pick-path，
// 已知路径（从发现的版本里点一份）走 harness:set-path 不弹框。试跑通过才保存，主进程再同步给 CodeAgent 的启动配置（main.js 的 locator.onManual）。
// 返回 { canceled } | { ok:true, result } | { ok:false, error }。
async function pickCodeAgent(ipcRenderer, fix = {}) {
  const file = typeof fix.path === 'string' && fix.path ? fix.path : '';
  const r = await ipcRenderer.invoke(file ? 'harness:set-path' : 'harness:pick-path', file ? { id: 'codeagent', path: file } : { id: 'codeagent' });
  if (!r) return { canceled: true };
  if (r.ok === false) return { ok: false, error: r.error || '没能选上' };
  if (r.reasonCode === 'manual-path-failed' || r.verdict !== 'ok') return { ok: false, error: r.reason || '选的程序没通过试跑', result: r };
  return { ok: true, result: r };
}
module.exports = { pickCodeAgent };
