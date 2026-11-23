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
      // 共享 serve（CodeAgent-Lite）没有终端横幅可看，鉴权与限流错误只出现在原生运行时字段里：一并检查，明确失败就不空等。
      for (const issue of [meta.connectionIssue, meta.nativeActionError, meta.nativeRuntime?.error, meta.nativeRuntime?.reason]) {
        if (!issue) continue;
        const text = typeof issue === 'string' ? issue : String(issue.message || issue.reason || issue.text || '');
        if (login(issue) || (text && login(text))) return message;
        if (text && /\b429\b|rate.?limit|too many requests|额度已用完|请求过多/i.test(text)) return 'Agent 额度已用完或请求过多（429），请稍后重试或换个账号';
      }
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
