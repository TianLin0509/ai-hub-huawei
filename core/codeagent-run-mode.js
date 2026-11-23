'use strict';
// CodeAgent 普通会话的运行方式（2026-11-22 试点）：
//   pty   —— 现有方式，终端里跑真实 CLI，出厂默认；
//   serve —— 卡片走 CodeAgent serve 接口，点「后台」才把真实终端接到同一会话。
// 只有启动中心新建的普通 CodeAgent 会话会带这个选项，组队、助理和其他自动会话默认走 PTY；
// 用户在「功能使用的 Agent」里给某功能选了 CodeAgent-Lite 时，功能会话带 codeagentLiteFeature 显式放行 serve。
const PTY = 'pty';
const SERVE = 'serve';
const normalizeRunMode = value => (value === SERVE ? SERVE : PTY);
const EXCLUDED_PURPOSES = new Set(['avatar-agent', 'company-assistant', 'company-forum', 'company-ai', 'hub-assistant', 'hub-photo-assistant']);

function usesServeRuntime(kind, opts = {}) {
  if (String(kind || '').replace(/-resume$/, '') !== 'codeagent') return false;
  if (normalizeRunMode(opts.codeagentRunMode) !== SERVE) return false;
  if (opts.resumePicker || opts.meetingId || opts.teamId || opts.teamRole) return false;
  if (opts.codeagentLiteFeature === true) return true;
  return !EXCLUDED_PURPOSES.has(opts.purpose);
}

function withRunModeInJson(raw, mode) {
  const runtime = raw && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime) ? raw.runtime : {};
  return { ...raw, runtime: { ...runtime, codeagentRunMode: normalizeRunMode(mode) } };
}

module.exports = { PTY, SERVE, EXCLUDED_PURPOSES, normalizeRunMode, usesServeRuntime, withRunModeInJson };
