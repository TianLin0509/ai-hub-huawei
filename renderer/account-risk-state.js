'use strict';
// 风控标记在界面侧的唯一副本：账号页、账号标签、启动中心都从这里读。
const { inForce, keyOf } = require('../core/account-risk-flags');

let snapshot = {};
const listeners = new Set();

function publish(next) {
  snapshot = next && typeof next === 'object' ? next : {};
  for (const listener of listeners) listener();
}
function connect(ipcRenderer) {
  ipcRenderer.on?.('account-risk:changed', (_event, next) => publish(next));
  return refresh(ipcRenderer);
}
async function refresh(ipcRenderer) {
  try {
    const result = await ipcRenderer.invoke('account-risk:list');
    if (result?.ok) publish(result.data);
    return result;
  } catch (error) { return { ok: false, error: error.message }; }
}
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }

const entry = (kind, profileId) => snapshot[keyOf(kind, profileId)] || null;
function active(kind, profileId, now = Date.now()) {
  const flag = entry(kind, profileId)?.active;
  return inForce(flag, now) ? flag : null;
}
function shortDate(at) {
  const date = new Date(at);
  return `${date.getMonth() + 1}-${date.getDate()}`;
}
const untilText = flag => flag.until == null ? '手动解除前' : `至 ${shortDate(flag.until)}`;
// 账号标签紧凑后缀 / 下拉菜单与启动中心的一行 / 悬停时的完整说明。
const chipSuffix = (kind, profileId) => active(kind, profileId) ? ' ⚠ 风控' : '';
function optionNote(kind, profileId) {
  const flag = active(kind, profileId);
  return flag ? `⚠ 风控观察中（${untilText(flag)}），不推荐` : '';
}
function describe(kind, profileId) {
  const flag = active(kind, profileId);
  if (!flag) return '';
  return `${shortDate(flag.flaggedAt)} 标记风控观察${flag.note ? `（${flag.note}）` : ''}，${untilText(flag)}不推荐使用，自动换号会跳过`;
}

module.exports = { active, chipSuffix, connect, describe, entry, optionNote, publish, refresh, shortDate, subscribe, untilText };
