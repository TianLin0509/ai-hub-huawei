'use strict';
// 复用已有鉴权错误和稳定终端横幅判定，后台任务看到明确登录失败就结束等待。
// options.settleMs（2026-11-24）：后台功能（论坛 / 文字 / 会议 / 分身）没有助理那样按回合的重试，网关报错（限流、5xx、超时等）
// 稳定这么久仍没有新回答就收场，不空等十几分钟。助理不传（0），保持原来「只提前收 key / 地址类」的行为。
function createReader(deps = {}, { settleMs = 0 } = {}) {
  const monitors = new Map(), apiSeen = new Map();
  const login = require('./launch-auth').isLoginFailure;
  const message = 'Agent 尚未登录或授权已失效，请在账号页重新登录后重试';
  const now = () => (deps.now ? deps.now() : Date.now());
  const readApi = meta => (deps.readTurnApiError ? deps.readTurnApiError(meta) : require('./company-assistant/turn-api-error').lastApiError(meta.transcriptPath));
  // 走部门 API key 的会话：一律按网关口径（core/assistant-gateway-route.js），认不出的也给网关的一行，绝不落成 CodeAgent 的「尚未登录」。
  function gatewayRead(id, meta, baseline) {
    const route = require('./assistant-gateway-route');
    const last = readApi(meta), fresh = last && last.id !== baseline ? last : null;
    if (!fresh) { apiSeen.delete(id); return ''; }
    const gw = route.gatewayFailure(fresh.text);
    if (gw.actions.includes('gateway-settings')) return gw.line; // key / 地址类重发也没用，立即收
    if (!settleMs) return '';
    const seen = apiSeen.get(id);
    if (!seen || seen.errorId !== fresh.id) { apiSeen.set(id, { errorId: fresh.id, at: now() }); return ''; }
    return now() - seen.at >= settleMs ? gw.line : '';
  }
  const reader = {
    forget(id) { monitors.delete(id); apiSeen.delete(id); },
    read(id, baseline = null) {
      const meta = deps.getSession?.(id);
      if (!meta) { monitors.delete(id); apiSeen.delete(id); return ''; }
      if (require('./assistant-gateway-route').isGatewaySession(meta)) {
        const gw = gatewayRead(id, meta, baseline);
        if (gw) return gw;
        const out = readAgent(id, meta, baseline, { skipApi: true });
        // 运行时字段 / 终端横幅给出的登录、限流结论也换成网关口径（不叫用户去账号页重登 CodeAgent）。
        return out ? require('./assistant-gateway-route').gatewayFailure(out === message ? '' : out).line : '';
      }
      return readAgent(id, meta, baseline);
    },
  };
  function readAgent(id, meta, baseline, { skipApi = false } = {}) {
      // 共享 serve（CodeAgent-Lite）没有终端横幅可看，鉴权与限流错误只出现在原生运行时字段里：一并检查，明确失败就不空等。
      for (const issue of [meta.connectionIssue, meta.nativeActionError, meta.nativeRuntime?.error, meta.nativeRuntime?.reason]) {
        if (!issue) continue;
        const text = typeof issue === 'string' ? issue : String(issue.message || issue.reason || issue.text || '');
        if (login(issue) || (text && login(text))) return message;
        if (text && /\b429\b|rate.?limit|too many requests|额度已用完|请求过多/i.test(text)) return 'Agent 额度已用完或请求过多（429），请稍后重试或换个账号';
      }
      const error = skipApi ? null : readApi(meta);
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
  }
  return reader;
}
module.exports = { createReader };
