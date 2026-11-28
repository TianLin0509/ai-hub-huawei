'use strict';
// 统计层（蒸馏自己 L1）：纯规则，不调模型。只看本人消息（r.m 为真）；别人的消息只用时间戳算「回复快慢」，内容不读。
// rows：档案记录 { m, t, at, c?, g? }。c 是会话编号（不给就当同一个会话），g 为真表示群聊（群里不算回复时长）。
// t 应当是去敏后的文字。
const crypto = require('node:crypto');
const { TOPIC_WORDS } = require('./topic-words');

const HOUR = 3600000, DAY = 86400000, TZ = 8 * HOUR; // 作息按上海时间
const BURST_MS = 60000, REPLY_MAX_MS = 12 * HOUR;
const pct = (n, d) => (d ? Math.round((n * 100) / d) : 0);
const idOf = (kind, text) => kind + '-' + crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 10);
const EMOJI = /\p{Extended_Pictographic}|\[[一-龥A-Za-z]{1,4}\]/u;
const EN = /[A-Za-z]{3,}/;
const STYLE = {
  conclusion: /^(?:结论|我觉得|我认为|建议|应该|可以|不行|没问题|行|对|不对|是的|不是)|先(?:说|给)结论/,
  ask: /[?？]$|[吗呢么]$|(?:多少|怎么|为什么|为啥|啥|哪个|哪里|几点|是不是|能不能|有没有)/,
  decline: /不行|不用了?|算了|先不|没空|不太方便|下次|暂时不|不考虑|不了/,
  forward: /找(?:一下|下|他|她)|问(?:问|一下|下)|转给|转发|拉(?:个|一下)|让.{1,6}看/,
};
const hourOf = at => new Date(at + TZ).getUTCHours();
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

// 最短的、覆盖九成消息的一段连续钟点（可以跨零点）。返回 [起, 止]（都含），没有消息时返回 [9, 18]。
function activeSpan(hours) {
  const total = hours.reduce((a, b) => a + b, 0);
  if (!total) return [9, 18];
  let best = null;
  for (let len = 1; len <= 24 && !best; len += 1) {
    for (let from = 0; from < 24; from += 1) {
      let sum = 0; for (let k = 0; k < len; k += 1) sum += hours[(from + k) % 24];
      if (sum * 10 >= total * 9 && (!best || sum > best.sum)) best = { from, to: (from + len - 1) % 24, sum };
    }
  }
  return [best.from, best.to];
}

function computeStats(rows) {
  const all = (rows || []).filter(r => r && Number.isFinite(Number(r.at)));
  const mine = all.filter(r => r.m && typeof r.t === 'string' && r.t.trim());
  const texts = mine.map(r => r.t.replace(/\s+/g, ' ').trim());
  const n = texts.length;
  const lens = texts.map(t => t.length).sort((a, b) => a - b);
  const stats = {
    median: quantile(lens, 0.5), p90: quantile(lens, 0.9),
    periodRate: pct(texts.filter(t => /[。.]$/.test(t)).length, n),
    emojiRate: pct(texts.filter(t => EMOJI.test(t)).length, n),
    burstRate: 0, enMixRate: pct(texts.filter(t => EN.test(t.replace(/\[[^\]]*\]/g, ''))).length, n),
  };
  // 按会话分组、按时间排好，算连发和回复时长。
  const convs = new Map();
  for (const r of all) { const k = r.c ?? ''; if (!convs.has(k)) convs.set(k, []); convs.get(k).push(r); }
  let burst = 0; const replies = [];
  for (const list of convs.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i]; if (!r.m) continue;
      const next = list[i + 1];
      if (next && next.m && next.at - r.at <= BURST_MS) burst += 1;
      const prev = list[i - 1];
      if (prev && !prev.m && !r.g && r.at >= prev.at && r.at - prev.at <= REPLY_MAX_MS) replies.push(r.at - prev.at);
    }
  }
  stats.burstRate = pct(burst, n);
  // 口头禅：≤6 字、出现 ≥3 次的短回复。
  const count = new Map();
  // 去敏留下的「某同事」和各种 [占位] 不算口头禅（审查 P2）。
  for (const t of texts) if (t.length <= 6 && !/某同事|\[[^\]]*\]/.test(t)) count.set(t, (count.get(t) || 0) + 1);
  const catchphrases = [...count.entries()].filter(([, k]) => k >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([text, k]) => ({ id: idOf('c', text), text, n: k, locked: false }));
  // 习性。
  const hours = Array(24).fill(0);
  for (const r of mine) hours[hourOf(r.at)] += 1;
  const [activeFrom, activeTo] = activeSpan(hours);
  const times = mine.map(r => r.at).sort((a, b) => a - b);
  const days = n ? Math.max(1, Math.ceil((times[times.length - 1] - times[0] + 1) / DAY)) : 0;
  const sortedReplies = replies.sort((a, b) => a - b);
  const style = {};
  for (const [k, re] of Object.entries(STYLE)) style[k] = pct(texts.filter(t => re.test(t)).length, n);
  const topics = TOPIC_WORDS.map(([text, re]) => ({ text, n: texts.filter(t => re.test(t)).length }))
    .filter(x => x.n >= 3).sort((a, b) => b.n - a.n).slice(0, 8).map(x => ({ id: idOf('t', x.text), text: x.text, n: x.n, locked: false }));
  const habits = {
    hours, activeFrom, activeTo,
    // 有样本时至少记 1（1 分钟内回），0 只表示没有数据。
    replyMedianMin: sortedReplies.length ? Math.max(1, Math.round(quantile(sortedReplies, 0.5) / 60000)) : 0,
    dailyMsgs: days ? Math.round(n / days) : 0,
    style, topics,
  };
  return { stats, catchphrases, habits, tone: toneFrom(stats, habits, n), tags: tagsFrom(stats, habits, n), mine: n, days };
}

// 统计得出的口吻要点：每条都带依据（只有数字，不带原话）。
function toneFrom(s, h, n) {
  if (n < 20) return [];
  const out = [];
  const add = (text, basis) => out.push({ id: idOf('s', text), text, basis, locked: false });
  if (s.median <= 10) add(`发消息很短，一件事常拆成几条`, `本人 ${n} 条消息里一半不超过 ${s.median} 字，九成不超过 ${s.p90} 字`);
  else add(`消息偏长，习惯一条说完整`, `本人 ${n} 条消息长度中位数 ${s.median} 字`);
  if (s.periodRate < 10) add('句末基本不加句号', `${100 - s.periodRate}% 的消息句末没有句号`);
  if (s.burstRate >= 20) add('爱连发几条短消息', `${s.burstRate}% 的消息一分钟内紧跟着又发一条`);
  if (s.emojiRate >= 15) add('常带表情', `${s.emojiRate}% 的消息带表情`);
  if (s.enMixRate >= 15) add('中英混着说，术语直接用英文', `${s.enMixRate}% 的消息带英文词`);
  if (h.style.ask >= 25) add('常用提问推进，追问细节', `${h.style.ask}% 的消息是问句`);
  if (h.style.conclusion >= 10) add('先给判断再说理由', `${h.style.conclusion}% 的消息以判断开头`);
  return out;
}
// 性格标签（默认不打开；本人勾选的才放进广场）。
function tagsFrom(s, h, n) {
  if (n < 20) return [];
  const tags = [];
  const add = text => tags.push({ id: idOf('g', text), text, on: false });
  if (s.median <= 8) add('话少直给');
  if ([22, 23, 0, 1, 2, 3].includes(h.activeTo)) add('夜猫子');
  if (h.activeFrom <= 7) add('早起');
  if (h.replyMedianMin && h.replyMedianMin <= 3) add('秒回');
  if (s.emojiRate >= 20) add('表情包达人');
  if (s.enMixRate >= 20) add('中英混搭');
  if (h.style.conclusion >= 15) add('先给结论');
  if (h.style.ask >= 30) add('爱追问');
  if (h.dailyMsgs >= 60) add('话痨');
  return tags;
}

module.exports = { computeStats, activeSpan, hourOf, idOf };
