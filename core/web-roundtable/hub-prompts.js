'use strict';
// Hub 网页圆桌的提示词（2026-10-28）。措辞照搬 AI 圆桌 lite v0.8.0 的 src/core.js（与 AI圆桌 Android 0.19.0 同源），
// 让同一个问题在 lite、Android、Hub 里得到同样的讨论材料。区别只有一处：Hub 里同一网站可以开「主」「副」两个号，
// 成员按网页会话区分，不按网站区分，名字带上身份以免两份 DeepSeek 回答分不清。

const IN_BODY = '请直接在对话正文中完整写出你的回答。';
const DISCUSSION_MAIN = '以下是其他 AI 对同一问题的回答，请分析他们的观点，指出你认同和不认同的地方，并给出你的改进回答。';
const COLLAB_MAIN = '以下是队友们对同一问题的回答。你们是协作关系，目标是共同得出最优方案。请吸收队友回答中的亮点和你没想到的角度，补充你认为重要而尚未覆盖的内容，整合各方优势，给出一个更完善的综合回答。';
const INSPIRE_MAIN = '以下是其他 AI 对同一问题的回答，供你参考和启发。请不要逐条点评或复述，而是把它们当作灵感：先找出其中你没想到、能让答案更好的思路、事实或角度，再与你自己的思考碰撞、组合、延伸，争取提出任何一方单独都没想到的新想法；你原有回答中仍然站得住的独到之处请保留，不必为了一致而趋同。请直接给出你升级后的完整回答，最后用一两句话说明受到了哪些启发、新增了什么。';
const DISCUSSION_HINTS = [
  '这是第1轮辩论。请仔细阅读其他参与者的初始回答，找出核心分歧和共识。',
  '这是第2轮辩论。经过上一轮交锋，请聚焦于仍存在分歧的关键点，深化你的论证或修正你的观点。',
  '这是第3轮辩论。辩论已进入深水区，请避免重复已达成共识的内容，集中攻克剩余分歧点，给出最终立场。',
];
const COLLAB_HINTS = [
  '这是第1轮协作。请仔细阅读队友们的回答，找出各自的亮点和你没想到的角度。',
  '这是第2轮协作。队友们已经互相补充了一轮，请在此基础上进一步整合，查漏补缺。',
  '这是第3轮协作。方案已趋于成熟，请做最终打磨：精简冗余，强化核心结论，形成一份完整方案。',
];
const INSPIRE_HINTS = [
  '这是第1轮互相激发。请先读完其他 AI 的回答，留意哪些地方触动了你、补上了你的盲区。',
  '这是第2轮互相激发。大家已经互相启发过一轮，请寻找还没被挖掘的方向，让答案再上一个台阶。',
];
const SUMMARY_DEPTH = { '简要结论': '简要结论与可执行的下一步', '深入分析': '深入分析（共识、分歧、依据、仍待确认的问题与建议）' };
const TEMPLATES = Object.freeze({
  'discuss.debate': `{轮次引导}\n\n${DISCUSSION_MAIN}${IN_BODY}\n\n{队友回答}`,
  'discuss.collab': `{轮次引导}\n\n${COLLAB_MAIN}${IN_BODY}\n\n{队友回答}`,
  inspire: `{轮次引导}\n\n${INSPIRE_MAIN}${IN_BODY}\n\n{队友回答}`,
  summary: '请作为圆桌队长，总结以下讨论，输出{总结要求}。成员之间的一致意见同样需要依据，未经核实之处请标明。请直接在对话正文中完整写出总结。\n\n问题：\n{问题}\n\n{各家回答}',
});
const KIND_NAMES = Object.freeze({ ask: '同题提问', discuss: '观点讨论', inspire: '互相激发', summary: '队长总结' });
const STYLE_NAMES = Object.freeze({ debate: '互挑错', collab: '取长补短' });
const MAX_PROMPT = 120000;
const PEER_KINDS = new Set(['discuss', 'inspire']);

// 一次替换完，问题或回答里恰好出现「{各家回答}」也不会被二次替换。
const fill = (template, values) => template.replace(/\{(轮次引导|队友回答|总结要求|问题|各家回答)\}/g, (slot, name) => name in values ? values[name] : slot);

function roundHint(table, kind, style) {
  if (kind === 'inspire') {
    const n = table.rounds.filter(r => r.kind === 'inspire').length + 1;
    return INSPIRE_HINTS[n - 1] || `这是第${n}轮互相激发。请聚焦仍可突破的地方，避免重复已有内容。`;
  }
  const collab = style === 'collab';
  const n = table.rounds.filter(r => r.kind === 'discuss' && (r.style || 'debate') === (collab ? 'collab' : 'debate')).length + 1;
  return collab ? COLLAB_HINTS[n - 1] || `这是第${n}轮协作。请继续整合，聚焦尚未完善的部分。` : DISCUSSION_HINTS[n - 1] || `这是第${n}轮辩论。请只针对仍有分歧的核心问题发表精炼观点。`;
}

// 最近一轮里每位成员的完整回答（跳过的不算）。
function latestAnswers(table) {
  const latest = table.rounds.at(-1);
  return latest ? latest.jobs.filter(j => j.status === 'done' && j.text) : [];
}
// 第一轮的问题：互评、汇总都围绕它。
function originalQuestion(table) {
  return table.rounds.find(r => r.kind === 'ask')?.prompt || '';
}

// 返回 [{ member, prompt }]。member 是网页会话 id；label(member) 给出「DeepSeek」或「DeepSeek（副）」这样的称呼。
function composePrompts(kind, text, table, { captain, depth = '简要结论', style = 'debate', label = m => m } = {}) {
  if (!KIND_NAMES[kind]) throw new Error('不支持的圆桌操作。');
  text = String(text || '');
  const latest = table.rounds.at(-1), answers = latestAnswers(table);
  if (kind === 'ask' && !text.trim()) throw new Error('请先输入问题。');
  if (PEER_KINDS.has(kind) && answers.length < 2) throw new Error(`至少需要两份完整回答才能进行${KIND_NAMES[kind]}。`);
  if (PEER_KINDS.has(kind) && latest.jobs.some(j => j.status !== 'skipped' && (j.status !== 'done' || !j.text))) throw new Error(`本轮仍有没完成的回答。请等它答完、重新读取或跳过这位成员，再${KIND_NAMES[kind]}。`);
  if (kind === 'summary' && !answers.length) throw new Error('还没有完整的回答可以汇总。');
  if (kind === 'summary' && !table.members.includes(captain)) throw new Error('请选择一位圆桌成员当队长。');
  const supplement = text.trim() && kind !== 'ask' ? `\n\n用户补充要求：\n${text}` : '';
  const targets = kind === 'summary' ? [captain] : table.members;
  const question = originalQuestion(table);
  return targets.map(member => {
    let prompt = text;
    if (PEER_KINDS.has(kind)) {
      const key = kind === 'inspire' ? 'inspire' : style === 'collab' ? 'discuss.collab' : 'discuss.debate';
      const peers = answers.filter(a => a.member !== member);
      prompt = fill(TEMPLATES[key], { 轮次引导: roundHint(table, kind, style), 队友回答: peers.map(a => `【${label(a.member)} 的回答】:\n${a.text}`).join('\n\n') }) + supplement;
    }
    if (kind === 'summary') {
      prompt = fill(TEMPLATES.summary, { 总结要求: SUMMARY_DEPTH[depth] || SUMMARY_DEPTH['简要结论'], 问题: question || latest.prompt, 各家回答: answers.map(a => `--- ${label(a.member)} ---\n${a.text}`).join('\n\n') }) + supplement;
    }
    prompt = forNewcomer(table, member, prompt);
    if (prompt.length > MAX_PROMPT) throw new Error(`完整上下文超过 ${MAX_PROMPT.toLocaleString()} 字符，尚未发送。请缩短材料或另开圆桌；不会自动截断。`);
    return { member, prompt };
  });
}

// 中途加入、此前没在自己网页上见过原始问题的成员，前面补一句在讨论什么（与 lite forNewcomer 同措辞）。
function forNewcomer(table, member, prompt) {
  const original = originalQuestion(table);
  if (!prompt || !original.trim() || !table.rounds.length || prompt.includes(original)) return prompt;
  const reached = table.rounds.some(r => r.jobs.some(j => j.member === member && (j.status === 'done' || !!j.text || (j.phase && j.phase !== 'not_sent'))));
  if (reached) return prompt;
  return `（你是中途加入这场讨论的成员。原始问题：\n${original}）\n\n${prompt}`;
}

module.exports = { composePrompts, KIND_NAMES, STYLE_NAMES, SUMMARY_DEPTH, TEMPLATES, MAX_PROMPT };
