'use strict';

// CodeAgent 终端把模型权限问题写在屏幕上，通常不会进入 transcript。
// 规则集中放在这里，便于随着 CLI 文案变化补充，而不把普通回答当成错误。
const MODEL_REVOKED_RULES = Object.freeze([
  { id: 'permission-adjusted', test: /(?:当前|所选|请求的|该)?\s*(?:模型|model)[^\n]{0,100}(?:(?:升级|调整|收回|撤销|变更)[^\n]{0,80}(?:权限|使用权限|访问权限)|(?:upgraded|updated|changed)[^\n]{0,80}permissions?)/i, reason: '模型权限已被调整或收回' },
  { id: 'permission-denied', test: /(?:模型|model)[^\n]{0,100}(?:无权|无权限|没有[^\n]{0,20}权限|权限不足|not\s+allowed|access\s+denied|permission\s+denied|forbidden)/i, reason: '当前账号没有这个模型的使用权限' },
  { id: 'model-retired', test: /(?:模型|model)[^\n]{0,100}(?:已下线|下线|已停用|停用|已移除|移除|不存在|找不到|not\s+found|does\s+not\s+exist|retired|deprecated|disabled|removed|unavailable)/i, reason: '模型已下线或当前不可用' },
  { id: 'request-error-code', test: /SessionRequestError(?:_\d+)?/i, reason: 'CodeAgent 拒绝了当前模型请求' },
]);

const SYSTEM_ERROR_SOURCES = new Set([
  'codeagent-screen-error', 'screen-error', 'cli-error-card', 'session-record-error', 'codeagent-output-error',
  'codeagent-stream', 'cli-output', 'terminal-error', 'transcript-error',
]);

function classifyModelRevocation(text, { source = 'codeagent-screen-error', role = 'system', error = true } = {}) {
  if (!SYSTEM_ERROR_SOURCES.has(source) || !error || role === 'assistant' || role === 'user') return null;
  const value = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  for (const rule of MODEL_REVOKED_RULES) {
    if (rule.test.test(value) && /(?:模型|model)/i.test(value)) {
      return { kind: 'model-revoked', rule: rule.id, reason: rule.reason, text: value.slice(0, 500) };
    }
  }
  return null;
}

const detectModelRevocation = classifyModelRevocation;
const isModelRevocationText = (text, options) => !!classifyModelRevocation(text, options);

module.exports = { MODEL_REVOKED_RULES, SYSTEM_ERROR_SOURCES, classifyModelRevocation, detectModelRevocation, isModelRevocationText };
