'use strict';
// 群聊「小队模式」的文字协议（2026-11-19，反馈 1574aa0b 与群里「n 个 agent 各答各的、没协作」）。
// 负责人在回答末尾写派工块，Hub 按块叫醒成员；成员做完 Hub 自动交回负责人。
// 纯文字、不依赖 MCP，任何 CLI 成员都能用。这里只放纯函数，状态与派发在 main/groupchat/squad-engine.js。

const { imageInputSupport } = require('./image-input-support');
const DEFAULT_MAX_ROUNDS = 6;
const MAX_TASKS_PER_ROUND = 8;
const HEADER_RE = /^\s*[【\[]\s*派工\s*[·・:：\-\s]?\s*(依次|顺序|串行|同时|并行)?\s*[】\]]\s*$/;
const TASK_RE = /^\s*[-*]?\s*@([A-Za-z0-9_.\-一-鿿]+)\s*[:：]?\s*(.*)$/;

// 小队与已有的编排类工作流互斥：同一个群只能有一种「谁来派工」的规则。
function conflict(meeting) {
  if (!meeting) return '';
  const wf = meeting.serialWorkflow || {};
  if (meeting.orchestration && meeting.orchestration.enabled === true) return '这个群已开负责人编排，小队模式不能同时开';
  if (meeting.scene === 'dev' || wf.enabled || wf.fileFlowVersion || wf.deliveryVersion) return '这个群已开工作流（开发/交付/按顺序发言），小队模式不能同时开；先关掉工作流再开';
  return '';
}

function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const rounds = Math.round(Number(value.maxRounds));
  return {
    enabled: value.enabled === true,
    leaderMemberId: value.leaderMemberId ? String(value.leaderMemberId) : '',
    maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.min(rounds, 20) : DEFAULT_MAX_ROUNDS,
    previousParticipants: Array.isArray(value.previousParticipants)
      ? value.previousParticipants.filter(Number.isInteger) : null,
  };
}

/**
 * 从负责人的回答里取最后一个派工块。
 * resolve(token) → { memberId, label } | null：把 @ 后面的名字认成成员（由调用方按群成员给）。
 * 返回 { mode: 'sequential'|'parallel', tasks: [{ memberId, label, task }], skipped: [token] } 或 null（没有派工块）。
 */
function parseDispatch(text, resolve) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let start = -1;
  let modeWord = '';
  // 代码块和引用里的派工块是举例说明，不算数（Codex 审查 2026-11-20：示例会被当真派工）。
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(lines[i])) continue;
    const match = HEADER_RE.exec(lines[i].replace(/^[#*\s]+|[*\s]+$/g, ''));
    if (match) { start = i; modeWord = match[1] || ''; }
  }
  if (start < 0) return null;
  const mode = /同时|并行/.test(modeWord) ? 'parallel' : 'sequential';
  const raw = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) continue;
    if (/^\s*[【\[]/.test(line)) break;
    const task = TASK_RE.exec(line);
    if (task) {
      current = { token: task[1].replace(/[._-]+$/, ''), text: task[2].trim() };
      raw.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) break;      // 派工块后面不是 @ 行：块已结束
      continue;
    }
    if (!line.trim()) { current = null; continue; }
    current.text = current.text ? `${current.text}\n${line.trim()}` : line.trim();
  }
  const tasks = [];
  const skipped = [];
  for (const item of raw) {
    const member = typeof resolve === 'function' ? resolve(item.token) : null;
    if (!member || !item.text) { skipped.push(item.token); continue; }
    const same = tasks.find(t => t.memberId === member.memberId);
    if (same) { same.task = `${same.task}\n${item.text}`; continue; }
    if (tasks.length >= MAX_TASKS_PER_ROUND) { skipped.push(item.token); continue; }
    tasks.push({ memberId: member.memberId, label: member.label || member.memberId, task: item.text });
  }
  return { mode, tasks, skipped };
}

// 成员清单里写上每位的后端擅长什么，负责人好按长处分工（R58b 光杆司令修法 G1）。
const KIND_STRENGTHS = Object.freeze({
  codeagent: '擅长实现与改代码，能用公司内网工具',
  claude: '适合异构审查、方案复核、长文档归纳',
  codex: '适合异构审查、代码复核与补测试',
  'deepseek-acp': '适合异构审查与推理复核',
});
function rosterLines(members, leaderMemberId) {
  return members.filter(m => m.memberId !== leaderMemberId)
    // 能看图的成员标出来，用户发了图片时负责人好把看图的活派给他。
    .map(m => {
      const strength = KIND_STRENGTHS[String(m.kind || '').replace(/-(?:resume|lite)$/, '')];
      return `- @${m.memberId}：${m.label}${m.kind ? `（${m.kind}${m.model ? ' / ' + m.model : ''}）` : ''}${imageInputSupport(m) === true ? '，能看图' : ''}${strength ? '，' + strength : ''}`;
    });
}

function leaderPrompt(userText, { members = [], leaderMemberId = '', maxRounds = DEFAULT_MAX_ROUNDS } = {}) {
  const roster = rosterLines(members, leaderMemberId);
  return [
    '【小队模式 · 你是负责人】',
    '用户只和你对话。你理解需求、拆任务、派给成员、验收结果，最后向用户汇报。',
    roster.length ? '小队成员（派工时用 @编号）：\n' + roster.join('\n') : '小队里暂时没有其他成员，直接回答用户。',
    '需要分工时，在回答最后单独写派工块，Hub 只认这个格式：',
    '【派工·依次】（或【派工·同时】）',
    '@m2：要做的事，写清目标和交付要求',
    '@m3：……',
    '「依次」按顺序一位做完再叫下一位，后一位能看到前一位的回答；「同时」一起开工。',
    '用户开了小队就是希望分工：能拆开的活至少派给一位成员，你负责拆分、验收和汇总；只有一句话就能答完的问题才直接回答、不写派工块。',
    `成员做完 Hub 会自动把回答交回给你；你验收后可以再写派工块继续，或者不写派工块、直接给用户最终答复（先结论，再依据）。每次用户发话后最多连续派工 ${maxRounds} 轮。`,
    '',
    '## 用户这次说',
    String(userText || ''),
  ].join('\n');
}

function memberPrompt(task, { leaderLabel = '负责人', mode = 'sequential', index = 0, total = 1, others = [] } = {}) {
  const lines = [`【小队任务 · ${leaderLabel} 派给你】`, String(task || '').trim(), ''];
  if (mode === 'sequential' && total > 1) {
    lines.push(`这是本轮第 ${index + 1}/${total} 棒${index > 0 ? '，前面成员的回答见上方群聊记录' : ''}。`);
  }
  if (mode === 'parallel' && others.length) {
    lines.push(`本轮同时开工的还有：${others.join('、')}。你只做派给你的这项。`);
  }
  lines.push('做完直接给出结果：先写结论，再写依据。不需要 @ 别人，Hub 会把你的回答自动交回负责人。');
  return lines.join('\n');
}

function handbackPrompt(outcomes, { round = 1, maxRounds = DEFAULT_MAX_ROUNDS } = {}) {
  const atLimit = round >= maxRounds;
  const lines = [`【Hub 交回 · 第 ${round}/${maxRounds} 轮】`];
  for (const item of outcomes) {
    lines.push(item.ok
      ? `- @${item.memberId} ${item.label}：已交回（回答见上方群聊记录）`
      : `- @${item.memberId} ${item.label}：没有完成（${reasonText(item.reason)}）`);
  }
  lines.push('');
  lines.push(atLimit
    ? `已连续派工 ${maxRounds} 轮，到达本次上限，这次不能再派工。请直接给用户汇报：完成了什么、还差什么、建议下一步；用户回话后可以继续。`
    : '请验收：要返工或做下一步，就再写一个派工块（格式同前）；已经完成，就不写派工块，直接给用户最终答复。');
  return lines.join('\n');
}

// 成员没交回时的原因：派发层给的是内部代码，小队提示与交回负责人时换成一句人话（R38）。
const REASON_TEXT = {
  hard_timeout: '长时间没收到它答完的信号',
  response_timeout: '长时间没收到它答完的信号',
  cli_not_ready: '它的 CLI 还没启动好，任务没送到',
  session_not_ready: '它的会话还没就绪，任务没送到',
  submission_unknown: '没能确认它收到了任务',
  send_exception: '任务发送出错',
  send_failed: '任务发送出错',
  superseded: '被新的一轮派发打断了',
  provider_aborted: '它的这一轮被中断了',
  provider_error: '它这一轮异常结束了',
  runtime_exited: '它的 CLI 已退出',
  network_interrupted: '网络连接中断',
  provider_unavailable: '模型服务暂时不可用',
  rate_limited: '请求触发限流',
  quota_exceeded: '额度已用尽',
  token_plan_quota: '套餐额度已用完，等重置',
  token_plan_quota_rerouted: '套餐额度已用完，已改走 DeepSeek API',
  auth_required: '登录或授权已失效',
  context_limit: '上下文长度超限',
  trusted_repo_required: '当前目录不在公司可信仓，被风控拦下',
  stuck: '任务可能没送到，没收到它的确认',
};
// 派发层的原因可能是内部代码（response_timeout 等）或带本地路径的异常原文：
// 认得的代码换成人话；不认得的代码、带路径的原文一律换成通用说法，不把英文代码和路径露给用户。
function reasonText(reason) {
  const raw = String(reason || '').trim();
  if (!raw) return '没有收到回答';
  if (REASON_TEXT[raw]) return REASON_TEXT[raw];
  if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(raw)) return '它这一轮异常结束了';
  if (/[A-Za-z]:[\\/]|(?:^|\s)\/[^\s]+\/|\\\\/.test(raw) || !/[一-鿿]/.test(raw)) return '任务派发出错';
  return raw.slice(0, 120);
}

// 成员没交回时写进群里的一行提示：写明是谁、什么原因，不让失败静默吞掉。
function memberFailureNote(label, reason) {
  return `小队成员 @${label} 的回答没能交回负责人：${reasonText(reason)}。`;
}

// 负责人收不到消息、重启会话就能接上的几类原因（R46）：CLI 退回系统终端、没启动好、进程退出、会话没就绪。
// Leader failures that a session restart fixes (R46): CLI back at the shell, not ready, exited, session not ready.
const LEADER_RESTART_CODES = new Set(['cli_not_ready', 'cli-not-ready', 'cli-exited', 'cli_exited', 'runtime_exited', 'session_not_ready']);
// 终端 CLI 与 DSH / 千问 / pi / CodeAgent serve / 原生连接各自的掉线说法（R46 审查 P1-5）。
// Disconnect wordings of the terminal CLI and the DSH / Qwen / pi / CodeAgent serve / native drivers (R46 review P1-5).
const LEADER_DOWN_RE = /CLI 已退出|(?:DSH|pi|千问)\s*(?:CLI\s*)?已退出|退出到系统终端|CLI 没有启动|会话还没就绪|未找到 .{0,20}CLI|未连接|尚未连接|连接已断开|原生连接不可用|(?:CLI|会话)\s*已关闭/;
function leaderNeedsRestart(reason) {
  const raw = String(reason || '').trim();
  return LEADER_RESTART_CODES.has(raw) || LEADER_DOWN_RE.test(raw);
}

// 负责人可能还在跑、或不确定收没收到（超时、粘贴卡住、提交结果不明）：不能直接再发一遍，否则同一棒会双发（R46 审查 P1-2）。
// The leader may still be running or may have received it (timeout, stuck paste, unknown submission): never resend blindly (R46 review P1-2).
const LEADER_UNCERTAIN_CODES = new Set(['hard_timeout', 'response_timeout', 'stuck', 'submission_unknown', 'unconfirmed']);

// 负责人这一棒没接住时的接续方式：restart-resend 重启并重发；restart-only 只重启、不重发；resend 直接重发。
// How to resume a halted leader leg: restart and resend; restart only (no resend); or resend without restart.
function leaderRecoverMode(reason) {
  if (leaderNeedsRestart(reason)) return 'restart-resend';
  if (LEADER_UNCERTAIN_CODES.has(String(reason || '').trim())) return 'restart-only';
  return 'resend';
}

// 重发同一棒：按是否真的重启过说明原因，避免负责人以为是新需求。
// Resend the same leg, explaining whether the session was restarted, so it does not read as a new request.
function resumePrompt(input, { restarted = true } = {}) {
  const head = restarted
    ? '（Hub 提示：你的会话刚重启，上一条消息没有送到，下面原样重发，接着做即可。）'
    : '（Hub 提示：上一条消息你没有给出有效回答，下面原样重发一次，接着做即可。）';
  return `${head}\n\n${String(input || '')}`;
}

function dispatchNote(task) {
  const summary = String(task.task || '').split('\n')[0].slice(0, 120);
  return `负责人派给 @${task.label}：${summary}`;
}

module.exports = {
  DEFAULT_MAX_ROUNDS,
  MAX_TASKS_PER_ROUND,
  normalizeConfig,
  conflict,
  parseDispatch,
  leaderPrompt,
  memberPrompt,
  handbackPrompt,
  leaderNeedsRestart,
  leaderRecoverMode,
  resumePrompt,
  dispatchNote,
  reasonText,
  memberFailureNote,
};
