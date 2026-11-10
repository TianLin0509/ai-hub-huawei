'use strict';

const { isAiKind } = require('./ai-kinds');

function defaultSessionTitle(counters, kind, opts = {}, ai = isAiKind(String(kind).replace(/-resume$/, ''))) {
  if (opts.title) return opts.title;
  if (ai) {
    counters.aiSessionCounter = (counters.aiSessionCounter || 0) + 1;
    return `新会话 ${counters.aiSessionCounter}`;
  }
  counters.psCounter = (counters.psCounter || 0) + 1;
  return `PowerShell ${counters.psCounter}`;
}

module.exports = { defaultSessionTitle };
