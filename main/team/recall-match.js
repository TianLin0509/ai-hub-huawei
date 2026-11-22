'use strict';
// 招人前先找原作者：只复用本队近期交付的 CodeAgent 会话，审查保持独立。
const RECALL_WINDOW_MS = 48 * 3600_000;
const MAX_CONTEXT_PCT = 70;
const REVIEW = /审查|复审|审核|验收|评审|review/i;
const REVIEW_INPUT = /(按|根据|依据|针对|落实)?(审查|复审|评审|review)(意见|结论|发现|指出的?|反馈|报告)/gi;
const REWORK = /返工|接手|原分支|原作者|接着做|继续做|继续修|按审查意见|根据审查意见|修审查/;
const roleCore = s => String(s || '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
function bigrams(s) {
  const t = roleCore(s).replace(/\s/g, ''), out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}
function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}
const normDir = d => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function classify(spec) {
  if (spec.fresh === true) return 'fresh';
  const role = roleCore(`${spec.role} ${spec.title || ''}`).replace(REVIEW_INPUT, ' ');
  const task = String(spec.task || '').replace(REVIEW_INPUT, ' ');
  // 去掉作为返工依据的「审查意见/结论」后，剩余审查要求一律用新人，覆盖「请对 m1 做代码审查」。
  if (REVIEW.test(role) || REVIEW.test(task)) return 'review';
  return REWORK.test(`${spec.role} ${spec.title || ''} ${spec.task || ''}`) ? 'rework' : 'other';
}
function planRecalls(planMembers, team, { now, leadCwd, sessionInfo }) {
  const used = new Set();
  return planMembers.map((spec, index) => {
    const kind = classify(spec);
    if (kind === 'fresh' || kind === 'review') return { index, action: 'new', reason: kind === 'review' ? '审查类用新人，保证独立' : '计划要求新人' };
    const want = normDir(spec.cwd || leadCwd);
    const pool = (team?.members || []).filter(m => {
      if (used.has(m.memberId) || m.status !== 'dismissed' || m.dismissReason !== 'delivered' || !m.sid || m.kind !== spec.kind) return false;
      if (!m.dismissedAt || now < m.dismissedAt || now - m.dismissedAt > RECALL_WINDOW_MS) return false;
      const s = sessionInfo(m.sid);
      if (!s?.exists || s.inOtherTeam || !/^codeagent(?:-resume)?$/.test(s.kind || '') || !want || normDir(s.cwd) !== want) return false;
      // 号池身份与点名模型都要一致，避免复用成另一个账号或模型。
      if ((s.codeagentPoolAccount || m.account) !== spec.account) return false;
      const model = s.fixedModel || s.currentModel?.id || (typeof s.currentModel === 'string' ? s.currentModel : '') || m.model;
      if (spec.model && String(model || '').toLowerCase() !== spec.model.toLowerCase()) return false;
      return Number.isFinite(s.contextPct) && s.contextPct >= 0 && s.contextPct < MAX_CONTEXT_PCT;
    });
    const scored = pool.map(m => ({ m, score: similarity(`${spec.role} ${spec.title || ''}`, `${m.role} ${m.title || ''}`) })).sort((a, b) => b.score - a.score);
    if (kind === 'rework') {
      const named = [...`${spec.role} ${spec.title || ''} ${spec.task}`.matchAll(/\bm(\d+)\b/g)].map(x => 'm' + x[1]);
      // 点名的作者不可用时照常新招，不能擅自换成另一个相似岗位。
      const hit = named.length ? pool.find(m => named.includes(m.memberId)) : scored[0]?.score >= 0.3 ? scored[0].m : null;
      if (hit) {
        used.add(hit.memberId);
        return { index, action: 'recall', memberId: hit.memberId, reason: `返工叫回原成员 ${hit.memberId}` };
      }
    } else if (scored[0]?.score >= 0.6) {
      return { index, action: 'hint', memberId: scored[0].m.memberId, reason: `${scored[0].m.memberId} 做过岗位相近的任务` };
    }
    return { index, action: 'new', reason: '没有符合条件的原成员' };
  });
}
function recallText(spec, member) {
  return [`【回到队里 · 新任务】请继续「${member.title || member.role}」的工作，以下面的任务为准。`,
    `分工：${spec.role}`, `任务：${spec.task}`,
    '完成后用 send --to lead --deliver 交付；卡住、失败、要拍板加 --wake。'].join('\n');
}
module.exports = { planRecalls, recallText, classify, similarity, RECALL_WINDOW_MS, MAX_CONTEXT_PCT };
