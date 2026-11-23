'use strict';
function nativeUiLabel(session) {
  if (session?.cardRunMode === 'card' && session?.runtimeBackend === 'claude-stream-json') return 'Claude Code · 卡片试点';
  if (session?.cardRunMode === 'card' && session?.runtimeBackend === 'acp') return 'DSH · 卡片试点';
  if (session?.runtimeBackend === 'claude-stream-json') return 'Claude';
  if (session?.codeagentRunMode === 'serve') return 'CodeAgent-Lite';
  return session?.runtimeBackend==='acp'
    ? require('./ai-kinds').getKindLabel(String(session.kind || '').replace(/-resume$/,''))
    : 'Codex';
}
function nativeOpeningBanner(session) {
  if (session?.runtimeBackend === 'claude-stream-json') return 'Claude 已连接。请使用 Hub 输入框发送消息；本页显示引擎原始输出。';
  return session?.runtimeBackend==='acp'
    ? `${nativeUiLabel(session)} 已连接，请在 Hub 输入框发送。`
    : 'Codex 已连接。请使用 Hub 输入框发送消息。';
}
module.exports={nativeUiLabel,nativeOpeningBanner};
