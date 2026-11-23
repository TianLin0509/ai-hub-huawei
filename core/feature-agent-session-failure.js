'use strict';
// 复用已有鉴权错误和稳定终端横幅判定，后台任务看到明确登录失败就结束等待。
function createReader(deps = {}) {
  const monitors = new Map();
  const login = require('./launch-auth').isLoginFailure;
  const message = 'Agent 尚未登录或授权已失效，请在账号页重新登录后重试';
  return {
    read(id, baseline = null) {
      const meta = deps.getSession?.(id);
      if (!meta) { monitors.delete(id); return ''; }
      for (const issue of [meta.connectionIssue, meta.nativeActionError, meta.nativeRuntime?.error]) if (issue && login(issue)) return message;
      const error = deps.readTurnApiError ? deps.readTurnApiError(meta) : require('./company-assistant/turn-api-error').lastApiError(meta.transcriptPath);
      if (error && error.id !== baseline && (login(error.text) || /\b401\b|未登录|登录过期|认证失败/i.test(error.text))) return message;
      if (!deps.readTerminalScreen) return '';
      let screen;
      try { screen = deps.readTerminalScreen(id); } catch { return ''; } // 读不到终端不是登录失败。
      const text = screen?.text || '';
      if (!monitors.has(id)) {
        if (monitors.size >= 32) monitors.delete(monitors.keys().next().value);
        monitors.set(id, require('./host-shell-detector').createAuthBannerMonitor());
      }
      return monitors.get(id).tick(text, screen?.activity ?? text) === 'confirmed' ? message : '';
    },
    forget(id) { monitors.delete(id); },
  };
}
module.exports = { createReader };
