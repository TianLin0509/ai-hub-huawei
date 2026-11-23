'use strict';

// CodeAgent 终端把模型权限问题写在屏幕上，通常不会进入 transcript。
// 规则集中放在这里，便于随着 CLI 文案变化补充，而不把普通回答当成错误。
const MODEL_REVOKED_RULES = Object.freeze([
  // 反馈未保留 CLI 原文：以目录限制关键词兜底，优先于同一错误里的模型权限文案。
  { id: 'untrusted-repo', kind: 'trusted-repo-required', test: /(?:非(?:公司)?可信仓|不在[^。.!?]{0,40}可信(?:仓|目录)|(?:目录|仓库)[^。.!?]{0,40}(?:不受信任|未受信任|未被信任)|\buntrusted\s+(?:repo(?:sitory)?|director(?:y|ies))\b|\bnot\s+(?:in\s+(?:a\s+|the\s+)?|a\s+)?trusted\s+(?:repo(?:sitory)?|directory)\b|(?:repo(?:sitory)?|directory)[^。.!?]{0,40}\b(?:is\s+not|isn't|not)\s+trusted\b)/i, reason: '当前目录不在公司可信仓，CodeAgent 被风控' },
  { id: 'repo-risk-control', kind: 'trusted-repo-required', test: /(?:(?:可信仓|trusted\s+(?:repo(?:sitory)?|directory))[^。.!?]{0,80}(?:风控|拒绝|禁止|denied|blocked|required)|(?:风控|拒绝|禁止|denied|blocked|requires?)[^。.!?]{0,80}(?:可信仓|trusted\s+(?:repo(?:sitory)?|directory)))/i, reason: '当前目录不在公司可信仓，CodeAgent 被风控' },
  { id: 'directory-risk-control', kind: 'trusted-repo-required', test: /(?:当前目录|当前仓库)[^。.!?]{0,60}(?:被风控|触发风控|风控拦截)/, reason: '当前目录不在公司可信仓，CodeAgent 被风控' },
  { id: 'permission-adjusted', test: /(?:当前|所选|请求的|该)?\s*(?:模型|model)[^\n]{0,100}(?:(?:升级|调整|收回|撤销|变更)[^\n]{0,80}(?:权限|使用权限|访问权限)|(?:upgraded|updated|changed)[^\n]{0,80}permissions?)/i, reason: '模型权限已被调整或收回' },
  { id: 'permission-denied', test: /(?:模型|model)[^\n]{0,100}(?:无权|无权限|没有[^\n]{0,20}权限|权限不足|not\s+allowed|access\s+denied|permission\s+denied|forbidden)/i, reason: '当前账号没有这个模型的使用权限' },
  { id: 'model-retired', test: /(?:模型|model)[^\n]{0,100}(?:已下线|下线|已停用|停用|已移除|移除|不存在|找不到|not\s+found|does\s+not\s+exist|retired|deprecated|disabled|removed|unavailable)/i, reason: '模型已下线或当前不可用' },
  { id: 'request-error-code', test: /SessionRequestError(?:_\d+)?/i, reason: 'CodeAgent 拒绝了当前模型请求' },
]);

const SYSTEM_ERROR_SOURCES = new Set([
  'codeagent-screen-error', 'screen-error', 'cli-error-card', 'session-record-error', 'codeagent-output-error',
  'codeagent-stream', 'cli-output', 'terminal-error', 'transcript-error',
]);

function classifyCodeAgentError(text, { source = 'codeagent-screen-error', role = 'system', error = true } = {}) {
  if (!SYSTEM_ERROR_SOURCES.has(source) || !error || role === 'assistant' || role === 'user') return null;
  const value = String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  for (const rule of MODEL_REVOKED_RULES) {
    if (rule.test.test(value) && (rule.kind || /(?:模型|model)/i.test(value))) {
      return { kind: rule.kind || 'model-revoked', rule: rule.id, reason: rule.reason, text: value.slice(0, 500) };
    }
  }
  return null;
}

function classifyModelRevocation(text, options) {
  const result = classifyCodeAgentError(text, options);
  return result?.kind === 'model-revoked' ? result : null;
}

const detectModelRevocation = classifyModelRevocation;
const isModelRevocationText = (text, options) => !!classifyModelRevocation(text, options);

module.exports = { MODEL_REVOKED_RULES, SYSTEM_ERROR_SOURCES, classifyCodeAgentError, classifyModelRevocation, detectModelRevocation, isModelRevocationText };
