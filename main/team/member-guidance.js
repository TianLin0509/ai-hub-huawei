'use strict';

function delegationGuidance() {
  // 成员可能是 CodeAgent、Claude Code、Codex 或 DSH（R58b），这段说明对各后端通用。Shared by every member backend.
  return '需要额外人手向负责人说明，由负责人用 hub-team propose 创建成员，让用户在左侧栏看到、点开和追问。Task、subagent（子任务）工具只用于自己做事，不算用户要求的侧栏团队。多行消息用 --message-file，计划用 --plan-file，避免 .cmd 截断换行；PowerShell 调用命令路径前加 &。';
}

// 开工时直接交给成员，不依赖负责人再次转述。
const RECEIPT_FORMAT = [
  '交付或汇报的回执格式：',
  '1. 第一句先回答负责人的问题，再讲结果或功能能否使用；',
  '2. 对照验收标准说明达到与否；',
  '3. 给出证据位置（命令与输出摘要、文件路径）；',
  '4. 说明未完成项与风险。',
];
module.exports = { delegationGuidance, RECEIPT_FORMAT };
