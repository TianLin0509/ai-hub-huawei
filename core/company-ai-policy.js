'use strict';
// Distribution identity comes from the shipped marker, never from an API key or user preference.
const distribution = require('./distribution');
const companyOnly = () => distribution.target === 'company';
function assertExternalAiAllowed() {
  if (companyOnly()) throw new Error('公司版 AI 任务只使用 CodeAgent；语音只使用本地识别，不调用外部 AI 服务。');
}
function assertKind(kind) {
  if (!distribution.kindAllowed(kind)) throw new Error('当前发行版不支持此会话类型，请选择启动中心提供的工具。');
}
// Single-session CLI availability does not widen company automation or group membership.
function taskKindAllowed(kind) {
  return distribution.kindAllowed(kind)
    && (!companyOnly() || String(kind || '').replace(/-resume$/, '') === 'codeagent');
}
function assertTaskKind(kind) {
  assertKind(kind);
  if (!taskKindAllowed(kind)) throw new Error('公司版造梦、群聊与组队只使用 CodeAgent；其他工具请从启动中心新建单会话。');
}
module.exports = { companyOnly, assertExternalAiAllowed, assertKind, taskKindAllowed, assertTaskKind };
