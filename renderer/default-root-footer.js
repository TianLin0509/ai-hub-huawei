'use strict';
// 新建会话底栏左侧的默认工作目录：路径本身可点，点开选文件夹、保存为「新建会话默认工作目录」。
// 起因（2026-11-23）：设置页早有这一项，但同事两次问「左下角的默认工作目录能改吗？C 盘快满了」——
// 看得见路径的地方改不了，能改的地方找不到。所在盘用了 85% 以上时，同一处给一行提示。

const DISK_WARN_PCT = 85;

function diskHint(hit, warnPct = DISK_WARN_PCT) {
  if (!hit || !(Number(hit.pct) >= warnPct)) return '';
  const drive = String(hit.root || '').replace(/[\\/]+$/, '') || '所在盘';
  const free = Number.isFinite(Number(hit.freeGb)) ? `，剩 ${hit.freeGb} GB` : '';
  return `${drive} 盘已用 ${hit.pct}%${free}，点上面的路径可改到别的盘。`;
}

// 选文件夹 → 保存。返回 { ok, root?, message? }；取消选择返回 { ok: false, canceled: true }。
async function changeDefaultRoot(ipcRenderer) {
  // 读不到配置就不知道是否被环境变量锁定：直接说明，不弹选择框，免得「显示改了、实际没变」。
  let config;
  try { config = await ipcRenderer.invoke('get-hub-config-raw'); } catch (error) { config = { readError: (error && error.message) || String(error) }; }
  if (!config || typeof config !== 'object' || config.readError) {
    return { ok: false, message: `读不到当前设置（${(config && config.readError) || '没有返回结果'}），这次没改默认工作目录。稍后再点一次，或到设置 → 新建会话默认工作目录里改。` };
  }
  if (config.workspaceRootEnv) {
    return { ok: false, message: `默认工作目录由环境变量 AI_HUB_WORKSPACE_ROOT 指定（${config.workspaceRootEnv}），这里改不了；去掉该环境变量后再改。` };
  }
  const picked = await ipcRenderer.invoke('workspace:pick-default-root');
  if (!picked) return { ok: false, canceled: true };
  const result = await ipcRenderer.invoke('save-hub-config', { defaultWorkspaceRoot: picked });
  if (!result || !result.success) {
    return { ok: false, message: `默认工作目录没改成：${(result && result.message) || '保存失败'}。换一个文件夹再试。` };
  }
  try { document.dispatchEvent(new CustomEvent('hub-config-saved', { detail: { defaultWorkspaceRoot: picked } })); } catch {}
  return { ok: true, root: picked };
}

module.exports = { DISK_WARN_PCT, diskHint, changeDefaultRoot };
