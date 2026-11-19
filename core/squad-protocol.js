'use strict';
// 群聊「小队模式」的文字协议（2026-11-19，反馈 1574aa0b 与群里「n 个 agent 各答各的、没协作」）。
// 负责人在回答末尾写派工块，Hub 按块叫醒成员；成员做完 Hub 自动交回负责人。
// 纯文字、不依赖 MCP，任何 CLI 成员都能用。这里只放纯函数，状态与派发在 main/groupchat/squad-engine.js。

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

function rosterLines(members, leaderMemberId) {
  return members.filter(m => m.memberId !== leaderMemberId)
    .map(m => `- @${m.memberId}：${m.label}${m.kind ? `（${m.kind}${m.model ? ' / ' + m.model : ''}）` : ''}`);
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
    `成员做完 Hub 会自动把回答交回给你；你验收后可以再写派工块继续，或者不写派工块、直接给用户最终答复（先结论，再依据）。简单问题直接回答，不写派工块。每次用户发话后最多连续派工 ${maxRounds} 轮。`,
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
      : `- @${item.memberId} ${item.label}：没有完成（${item.reason || '未拿到回答'}）`);
  }
  lines.push('');
  lines.push(atLimit
    ? `已连续派工 ${maxRounds} 轮，到达本次上限，这次不能再派工。请直接给用户汇报：完成了什么、还差什么、建议下一步；用户回话后可以继续。`
    : '请验收：要返工或做下一步，就再写一个派工块（格式同前）；已经完成，就不写派工块，直接给用户最终答复。');
  return lines.join('\n');
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
  dispatchNote,
};
