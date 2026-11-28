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
// CodeAgent 成员由启动叠加文件里的同步 hook 硬拦（main/team/member-guard.js）。
function guardGuidance(access) {
  const lines = [
    '权限边界：以下 5 类动作 Hub 会直接拦下并报告负责人：① git push（含推内源）、合入或改写主干（master/main 等）；' +
      '② 关闭/重启/kill 生产 Hub，或按进程名、命令行子串成批杀进程；③ 删除任务目录（工作目录、你开的 worktree、临时目录）以外的文件；' +
      '④ 改 Hub 数据目录的配置与状态；⑤ 读取或使用部门 API key 等按量计费的 API 密钥。被拦时不换命令或通道绕过，等负责人放行或改做法。',
  ];
  if (access === 'read') lines.push('你是只读成员（Hub 拒绝写文件，临时目录除外）：只读代码、跑只读检查，结论写进回执；不改文件、不提交。');
  return [...lines, ''];
}

module.exports = { delegationGuidance, guardGuidance, RECEIPT_FORMAT };
