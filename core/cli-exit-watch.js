'use strict';

// CodeAgent 回合进行中 CLI 进程退出（崩溃、被杀、登录失效），外层 PowerShell 还活着，PTY 不退出，
// 界面会一直显示"工作中"。主进程定时查"终端是否已回到宿主提示符"：
// 连续两次命中，且两次之间终端没有任何新输出（活着的 CLI 会持续重绘），才结束这一轮。
const { isCodeAgentKind } = require('./ai-kinds.js');

const CLI_EXIT_CHECK_MS = 15_000;

function createCliExitWatch({ manager, onExited, intervalMs = CLI_EXIT_CHECK_MS, now = () => Date.now(),
  setTimer = setInterval, clearTimer = clearInterval }) {
  const seen = new Map(); // sessionId -> lastOutputAt at the previous hit
  let timer = null;
  function tick() {
    for (const [sessionId, entry] of manager.sessions) {
      const info = entry && entry.info;
      if (!info || info.agentRuntime !== 'pty' || !isCodeAgentKind(info.kind) || !entry.agentTurnActive
          || /^(dormant|closed)$/.test(String(info.status || '')) || !manager.isHostShellActive(sessionId)) {
        seen.delete(sessionId);
        continue;
      }
      const outputAt = Number(entry.lastOutputAt) || 0;
      if (!seen.has(sessionId) || seen.get(sessionId) !== outputAt) { seen.set(sessionId, outputAt); continue; }
      seen.delete(sessionId);
      const failedAt = now();
      if (manager.noteAgentTurnFinished(sessionId, { failedAt, message: 'cli-exited-to-shell' })) {
        try { onExited({ sessionId, failedAt, kind: info.kind }); } catch { /* 只影响提示 */ }
      }
    }
  }
  return {
    start() { if (!timer) { timer = setTimer(tick, intervalMs); timer?.unref?.(); } },
    stop() { if (timer) { clearTimer(timer); timer = null; } },
    tick,
  };
}

module.exports = { createCliExitWatch, CLI_EXIT_CHECK_MS };
