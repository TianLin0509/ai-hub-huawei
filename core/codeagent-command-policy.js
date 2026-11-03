'use strict';
const { isCodeAgentKind } = require('./ai-kinds');

// 项目现有启动/菜单路径明确使用的本地命令。没有完整的 CodeAgent 命令清单；
// 其他 slash 可能是技能，按普通发送跟踪，以现有 STARTING 15s TTL 防止未知本地命令挂住。
const CODEAGENT_LOCAL_COMMANDS = new Set(['/help', '/model', '/compact', '/clear', '/config', '/skills']);
function isSkillsMenuCommand(kind, text) { return isCodeAgentKind(kind) && /^\s*\/skills\s*$/i.test(text); }
function isPtyLocalCommand(session, text) {
  if (session?.agentRuntime !== 'pty') return false;
  const command = String(text || '').trimStart().match(/^\/\S+/)?.[0];
  if (!command) return false;
  return !isCodeAgentKind(session.kind) || CODEAGENT_LOCAL_COMMANDS.has(command.toLowerCase());
}
module.exports = { isPtyLocalCommand, CODEAGENT_LOCAL_COMMANDS, isSkillsMenuCommand };
