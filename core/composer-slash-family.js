'use strict';
// 会话属于哪一家（决定「/」选择框列哪套命令、技能怎么写）；CodeAgent 走自己的选择框，返回 null。
const { isCodeAgentKind, isClaudeFamily } = require('./ai-kinds');
function slashFamily(session) {
  const kind = String(session?.kind || '');
  if (!kind || isCodeAgentKind(kind)) return null;
  const base = kind.replace(/-resume$/, '');
  if (isClaudeFamily(kind) || (base === 'deepseek' && session.ccSessionId && !session.codexSid)) return 'claude';
  if (base === 'codex' || base === 'deepseek') return 'codex';
  if (base === 'deepseek-acp') return 'dsh';
  if (base === 'pi') return 'pi';
  return null;
}
module.exports = { slashFamily };
