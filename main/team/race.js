'use strict';
// 做同一道题；成员交付先由 Hub 收着，全部交齐（或建失败、离队）后 Hub 核对候选、出成绩单，只叫醒负责人一次，
// 送一条带成绩单路径的汇总消息——不让 N 份交付轮流叫醒负责人、占它上下文。
// HUB-H 口径：成员都是 CodeAgent；个人账号同时干活上限 3 位（超出排队）；项目没有 .agents/project.json 测试闸门时
// 成绩单只比提交与改动规模（main/groupchat/race-scorecard.js）。
const fs = require('node:fs'), path = require('node:path');
const Race = require('../groupchat/race-scorecard');

const DONE_STATES = ['failed', 'dismissed', 'interrupted'];
// 掉队兜底：首位交付后再等这么久，其余人还没交就先出成绩单；晚交的照常作为普通交付转给负责人。
// config team.raceStragglerMinutes 可改。
const STRAGGLER_MS = 45 * 60 * 1000;

function kickoffLines({ worktreeReady = false } = {}) {
  return [
    '这是一场赛马：几位成员同时做同一道题，互不参考、互不等待，最后由负责人对照 Hub 核对的成绩单选一份采用。',
    ...(worktreeReady ? ['- 代码任务：就在上面 Hub 建好的独立 worktree 里实现；按项目规则准备依赖，不在仓库主目录改文件。'] : [
      '- 代码任务：在任务项目的独立 git worktree 实现，目录建在项目同级目录，目录和分支都命名为「日期-时分-race-你的成员编号」（如 20261128-2030-race-m2），已存在就加后缀；不在仓库主目录改文件。',
    ]),
    '- 完成后提交全部改动、保持 worktree 干净，交付消息单独一行写 `CANDIDATE: <worktree 绝对路径> <完整 40 位提交 SHA>`，再写做法要点（3 行内）、实际验证与结果、已知风险。不合并、不推送、不改版本号。',
    '- 不改代码的任务（方案、分析、文稿）把成品写进文件，交付消息给路径和结论，省略 CANDIDATE 行。',
    '- 用 `send --to lead --deliver` 交付一次即可：Hub 等所有参赛者交齐后统一交给负责人，中途不要发进度汇报。',
    '',
  ];
}
function planMembers(team, plan) { return (team.members || []).filter(m => m.planId === plan.id); }
// 全员要么已交付，要么已经不可能交付（建失败、被请离、被打断）；且至少一人交付。
function ready(team, plan, { now = Date.now(), stragglerMs = STRAGGLER_MS } = {}) {
  const ms = planMembers(team, plan), done = ms.filter(m => m.raceDeliveryPath);
  if (!ms.length || !done.length) return false;
  if (ms.every(m => m.raceDeliveryPath || DONE_STATES.includes(m.status))) return true;
  const first = Math.min(...done.map(m => Number(m.raceDeliveredAt) || now));
  return now - first >= stragglerMs;
}
function stragglers(team, plan) { return planMembers(team, plan).filter(m => !m.raceDeliveryPath && !DONE_STATES.includes(m.status)); }
function recordDelivery(dir, member, text, id = Date.now().toString(36)) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${member.memberId}-交付-${id}.md`); // 每次交付单独存，返工重交不覆盖旧文件
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
async function score({ team, plan, dir, signal, scorecard = Race.scorecard }) {
  const ms = planMembers(team, plan);
  const entries = ms.map(m => ({ memberId: m.memberId, name: `${m.memberId} ${m.title || ''}（${m.model || m.kind}）`.replace(/\s+（/, '（'),
    deliveryPath: m.raceDeliveryPath || '', elapsedMs: m.raceDeliveryPath ? Math.max(0, (m.raceDeliveredAt || 0) - (m.joinedAt || 0)) : 0 }));
  const file = path.join(dir, '赛马成绩单.md');
  let rows = [];
  try {
    const result = await scorecard({ goal: plan.task || plan.goal, entries, dir, signal });
    // Hub 关闭时中止了测试：不写半份成绩单，交给调用方保留「出分中」，重启后重做（审查建议 2）。
    if (result?.state === 'cancelled' || signal?.aborted) throw Object.assign(new Error('赛马成绩单因 Hub 关闭中止'), { cancelled: true });
    rows = result.rows || [];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, result.markdown, 'utf8');
  } catch (error) {
    if (error?.cancelled) throw error;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, ['# 赛马成绩单（Hub 生成失败）', '', `Hub 没能完成候选核对与测试：${error.message}`, '', ...entries.map(e => `- ${e.name}：${e.deliveryPath || '没有交付'}`), ''].join('\n'), 'utf8');
    rows = entries.map(e => ({ ...e, gate: { state: 'skipped', reason: 'Hub 成绩单生成失败' } }));
  }
  return { file, rows };
}
function gateWord(g) {
  if (!g) return '—';
  if (g.state === 'passed') return '测试通过';
  if (g.state === 'failed') return '测试未通过';
  return `未测（${String(g.reason || '').slice(0, 40)}）`;
}
function leadMessage({ plan, file, rows, cmd, late = [], stragglerMin = STRAGGLER_MS / 60000 }) {
  const delivered = rows.filter(r => r.deliveryPath).length;
  return [
    `【赛马结果 · 计划 ${plan.id}】${delivered}/${rows.length} 位参赛者已交付。Hub 已逐个核对候选提交、统计改动规模，项目声明了测试命令的还亲自跑了测试。成绩单：${file}`,
    ...(late.length ? [`${late.join('、')} 在首位交付 ${Math.round(stragglerMin)} 分钟后仍未交付，先按已交的出成绩单；它们之后交的会作为普通交付转给你，也可以 status 看它是否卡住、send 催它。`] : []),
    ...rows.map(r => `- ${r.label || ''} ${r.name}：${gateWord(r.gate)}${r.stat ? `，${r.stat.files.length} 个文件 +${r.stat.insertions}/-${r.stat.deletions}` : ''}${r.deliveryPath ? `；交付 ${r.deliveryPath}` : '；没有交付'}`),
    '下一步：读成绩单，挑 1–2 份候选抽查关键改动（也可以派一个不参赛的子 Agent 当裁判，只回推荐哪份、理由、值得从落选方案嫁接的点），再选定。',
    `选定后给胜者发合入指令（\`"${cmd}" send --to <编号> --message "按项目合入入口合入你的候选…"\`，Hub 会叫回它的原会话）；落选者 Hub 稍后自动离队休眠，它们的 worktree 按项目规则清理。都不满意就说明原因，可以让其中一位返工。`,
  ].join('\n');
}
// 个人账号同时干活上限（PERSONAL_MEMBER_LIMIT）提示：超出的参赛者排队，开工晚、成绩单也会等它们。
// stragglerMs 用实际生效的掉队时限（config team.raceStragglerMinutes 可改；审查建议 3）。
function personalQueueNote(plan, personalId, limit, stragglerMs = STRAGGLER_MS) {
  const n = (plan.members || []).filter(m => m.account === personalId).length;
  if (n <= limit) return '';
  return `这场赛马有 ${n} 位参赛者用个人账号，个人账号同时最多 ${limit} 位在干活，其余 ${n - limit} 位排队、开工会晚；首位交付 ${Math.round(stragglerMs / 60000)} 分钟后还没交的先不等。想同时开跑可以给部分参赛者换号池账号。`;
}

module.exports = { STRAGGLER_MS, DONE_STATES, kickoffLines, ready, stragglers, recordDelivery, score, leadMessage, planMembers, personalQueueNote };
