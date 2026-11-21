'use strict';
// 公司电脑（装了 CodeAgent CLI）上，新建会话与 AI 群聊默认用 CodeAgent，并把它排在会话类型第一位；
// 同时记住用户上次选的会话类型（2026-10-08 用户在公司真机验收后提出）。没装 CodeAgent 的电脑行为不变。
const LAST_KIND_KEY = 'hub:lastSessionKind';
let installed = null;
let pending = null;

function refresh(ipcRenderer) {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => ipcRenderer.invoke('codeagent:available'))
      .then(result => { installed = !!(result && result.installed); return installed; })
      .catch(() => { installed = false; return false; });
  }
  return pending;
}

// 只保留 CodeAgent 的发行版（公司纯净版）不必等检测结果，一律按「装了」处理默认值。
const codeAgentOnly = (() => {
  const { kindAllowed, target } = require('../core/distribution');
  return kindAllowed('codeagent') && (target === 'company' || !kindAllowed('claude'));
})();

function isInstalled() { return codeAgentOnly || installed === true; }
// 实际检测结果（null = 还没测完）：不受「公司纯净版默认按装了处理」影响，给「是不是 API 用户」这类判断用。
function detectedInstalled() { return installed; }

function rememberKind(kind) {
  try { if (kind) localStorage.setItem(LAST_KIND_KEY, String(kind)); } catch {}
}

// 上次选过且仍可用的类型优先；没有记录时，装了 CodeAgent 就默认它，否则沿用 Claude。
function preferredKind(validKinds = []) {
  let last = null;
  try { last = localStorage.getItem(LAST_KIND_KEY); } catch {}
  if (last && validKinds.includes(last)) return last;
  // 实测没装 CodeAgent（多半是 API 用户）就默认 Claude，让他第一眼看到「用部门 API key」；只剩 CodeAgent 可选时仍是它。
  const useCodeagent = installed === false ? !validKinds.includes('claude') : isInstalled();
  return useCodeagent && validKinds.includes('codeagent') ? 'codeagent' : 'claude';
}

function defaultGroupMembers(fallback) {
  if (!isInstalled()) return fallback.map(x => ({ ...x }));
  return [{ kind: 'codeagent', model: 'GLM-5.2-WX-Auto' }, { kind: 'codeagent', model: 'MiniMax-M2.7' }];
}

// 新建 AI 群聊的默认成员按本机实际能用的 AI 选（11-21 全新用户深查 #9）：
// kinds 是可选成员（界面顺序），available(kind) 返回 true 能用 / false 确认没装 / null 还不知道。
// CodeAgent 实测装了（或公司纯净版还没测完）→ 两个 CodeAgent；否则从确认能用的里挑两个（只有一种就同一种开两个）；
// 一个都没有、且每种都确认没装 → 仍给 fallback，但 missing=true，界面就地说明缺什么、去哪装。
function groupMembersFor(kinds = [], available = () => null, fallback = []) {
  const list = (kinds || []).filter(Boolean);
  const ca = available('codeagent');
  if (list.includes('codeagent') && (ca === true || (ca === null && isInstalled()))) {
    return { members: [{ kind: 'codeagent', model: 'GLM-5.2-WX-Auto' }, { kind: 'codeagent', model: 'MiniMax-M2.7' }], missing: false };
  }
  const ready = list.filter(kind => kind !== 'codeagent' && available(kind) === true);
  if (ready.length) return { members: [ready[0], ready[1] || ready[0]].map(kind => ({ kind })), missing: false };
  const allMissing = list.length > 0 && list.every(kind => available(kind) === false);
  return { members: fallback.map(x => ({ ...x })), missing: allMissing };
}

module.exports = { LAST_KIND_KEY, refresh, isInstalled, rememberKind, preferredKind, defaultGroupMembers, groupMembersFor, detectedInstalled };
