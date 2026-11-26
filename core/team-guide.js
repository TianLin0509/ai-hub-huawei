'use strict';
// 组队指路（R47，2026-11-26）：Hub 启动 Agent 时写进系统提示的一段固定说明，让「组个队做 X」一句话就能走到组队。
// Team guide: a fixed section appended to the launch system prompt so "form a team to do X" reaches the team flow.
// 不受「规则」页开关影响（规则全关也带），由 session-manager hubRulesSystemPrompt 追加。
// Independent of the Rules-page toggle; appended by session-manager hubRulesSystemPrompt.
// 只给 CodeAgent 会话（含恢复）带；不带的会话：Hub 招来的团队成员（成员不能招人）、群聊成员、自动分配任务的无人值守会话；场景 / 写作等自带人设的会话在更早一步已整体跳过。
// CodeAgent sessions only (incl. resume); skipped for: team members spawned by Hub (members cannot recruit), group-chat members and unattended auto-dispatch sessions;
// scene / writing sessions with their own persona are already skipped earlier.
const { createHash } = require('node:crypto');

const GUIDE_LABEL = '组队指路';
const TEAM_GUIDE = [
  '## 组队指路 / Team guide',
  '用户要组队、开几个会话并行、把活分给几个人做，或让你当负责人时：',
  '1. 先读内置技能 company-team，按其中步骤办；',
  '2. 用 Hub 的组队命令 hub-team（Hub 数据目录下 team\\hub-team.cmd）：先跑 status、accounts，再写计划文件执行 propose，成员会出现在左侧栏，用户点开就能追问；',
  '3. 你自带的子任务工具只用于你自己干活，不算用户要的团队。',
  '单人很快能做完的任务照常自己做。',
  'When the user asks to form a team, run several sessions in parallel, split work among several people, or make you the lead:',
  '1. Read the built-in company-team skill and follow its steps.',
  '2. Use the Hub team command hub-team (team\\hub-team.cmd under the Hub data directory): run status and accounts, then write a plan file and run propose; members appear in the left sidebar where the user can open them.',
  '3. Your own sub-task tools are for your own work and do not count as the team the user asked for.',
  'Small tasks one session can finish quickly stay with you.',
].join('\n');
const GUIDE_VERSION = createHash('sha256').update(TEAM_GUIDE, 'utf8').digest('hex').slice(0, 12);

// { label, text, version }；不该带时返回 null。Returns null when the session should not carry the guide.
function teamGuideFor({ kind, purpose, hubTeamMember, meetingId } = {}) {
  // HUB-H 组队只支持 CodeAgent，company-team 技能也只装在 CodeAgent 号池里。Team flow is CodeAgent-only.
  if (!require('./ai-kinds').isCodeAgentKind(String(kind || ''))) return null;
  if (hubTeamMember) return null;
  // 群聊成员（会议室里的会话）是被叫来回答的，不自己组队。Group-chat members answer in the room; they do not form teams.
  if (meetingId) return null;
  if (require('./auto-dispatch-rules').isAutoDispatchPurpose(purpose)) return null;
  return { label: GUIDE_LABEL, text: TEAM_GUIDE, version: GUIDE_VERSION };
}

// 系统提示里可能同时有几段额外内容（自动分配任务规则、组队指路），合成一段交给 hub-rules systemPromptFile。
// Merge several extra sections into one for hub-rules systemPromptFile; null when there is none.
function joinExtras(list) {
  const parts = (list || []).filter(p => p && p.text);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return { label: parts.map(p => p.label).join(' + '), text: parts.map(p => String(p.text).trim()).join('\n\n'),
    version: parts.map(p => p.version).join('+') };
}

module.exports = { TEAM_GUIDE, GUIDE_LABEL, GUIDE_VERSION, teamGuideFor, joinExtras };
