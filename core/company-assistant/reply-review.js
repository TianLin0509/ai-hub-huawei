'use strict';
// 待回复复核（2026-11-16）：工作日 9:00 / 13:00 / 19:00 请公司助理的 CodeAgent 逐个判断「我是不是真的欠对方一句回复」。
// 规则（data.awaiting + core/reply-judge）先粗筛，AI 读最近 10 条上下文定档：reply 该回 / maybe 可能要回 / no 不用回。
// 结论按「复核时会话的最后一条」记账：之后对方或我再说话，就退回规则判定，等下一轮。
const D = require('./data');

const REVIEW_HOURS = Object.freeze([9, 13, 19]);
const WINDOW_MS = 3 * 86400000;      // 只看近 3 天
const MIN_WAIT_MS = 30 * 60000;      // 30 分钟内的不急着判
const MAX_CONVS = 30;
const CONTEXT = 10;

/** 当前时刻落在哪个复核时段（如 "2026-11-16@780"）；当天第一个时段之前返回 ''。 */
function slotOf(now) {
  const p = D.dateParts(now), minute = p.hour * 60 + p.minute;
  const passed = REVIEW_HOURS.map(h => h * 60).filter(m => m <= minute);
  return passed.length ? `${D.dayKey(now)}@${passed[passed.length - 1]}` : '';
}
function nextSlotAt(now) {
  for (let d = 0; d < 8; d += 1) for (const h of REVIEW_HOURS) {
    const day = D.dayKey(now + d * 86400000), at = Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+08:00`);
    if (at > now) return at;
  }
  return null;
}

/** 候选：近 3 天、超过 30 分钟、最后一条是别人说的私聊（不管规则怎么判），外加有 @我 的群。 */
function candidates(snapshot, { now = Date.now(), myName = '', done = new Set(), settings = null } = {}) {
  const out = [];
  const fresh = at => Number.isFinite(at) && now - at <= WINDOW_MS && now - at >= MIN_WAIT_MS;
  for (const conv of snapshot.conversations || []) {
    const list = D.convRows(snapshot, settings, conv.id);
    if (!list.length) continue;
    const last = list[list.length - 1];
    if (conv.group) {
      // 群：按 @我 那条计时（之后的闲聊不影响）；上下文取 @我 前后几句、我之后的发言和最近几句
      const hitIdx = list.map((m, i) => (!m.mine && (m.atMe || (!!myName && m.text.includes('@' + myName))) && !done.has(m.sourceId) ? i : -1)).filter(i => i >= 0);
      if (!hitIdx.length || !fresh(list[hitIdx[hitIdx.length - 1]].at)) continue;
      const keep = new Set();
      for (const i of hitIdx.slice(-3)) for (let k = i - 2; k <= i + 2; k += 1) if (k >= 0 && k < list.length) keep.add(k);
      list.forEach((m, i) => { if (m.mine && i > hitIdx[0]) keep.add(i); });
      for (let k = Math.max(0, list.length - 4); k < list.length; k += 1) keep.add(k);
      const idx = [...keep].sort((a, b) => a - b).slice(-CONTEXT * 2);
      out.push({ conv, last, at: list[hitIdx[hitIdx.length - 1]].at, rows: idx.map((k, j) => ({ m: list[k], gap: j > 0 && k !== idx[j - 1] + 1 })) });
      continue;
    }
    if (last.mine || done.has(last.sourceId) || !fresh(last.at)) continue;
    out.push({ conv, last, at: last.at, rows: list.slice(-CONTEXT).map(m => ({ m, gap: false })) });
  }
  out.sort((a, b) => b.at - a.at);
  const when = at => (Number.isFinite(at) ? `${D.dayKey(at).slice(5)} ${D.clock(at)}` : '时间未知');
  const line = ({ m, gap }) => `${gap ? '…\n' : ''}${when(m.at)} ${m.mine ? '我' : m.sender}${m.atMe ? '（@我）' : ''}: ${D.short(m.text || m.preview, 200)}`;
  return out.slice(0, MAX_CONVS).map((x, i) => ({ c: `c${i + 1}`, conv: x.conv.id, convName: x.conv.name, group: !!x.conv.group,
    lastKey: D.reviewAnchor(x.conv, D.convRows(snapshot, settings, x.conv.id), myName, settings), lines: x.rows.map(line) }));
}

function prompt(cands, { now = Date.now() } = {}) {
  return [
    `请帮我复核 WeLink 里的「等你回复」（现在是 ${D.displayTime(now)}）。下面每段是一个我还没接话的会话的最近消息，按时间从早到晚。`,
    '逐个判断我是不是真的欠对方一句回复：',
    '- "reply"：对方在等我回应——向我提问、请我审核/确认/帮忙、要我给材料或时间、发出邀请、交代需要我确认的安排；群聊里只算明确冲着我来的。',
    '- "maybe"：回一句更好，但不回也不失礼，例如对方分享信息、通知进展，话题还开着。',
    '- "no"：这轮已经自然结束——对方回了「好的/收到/谢谢」或表情；对方只是回答了我的问题且没有反问；群发通知；@我 的事我在后面已经回应过。',
    '拿不准时宁可判 "maybe"，不要把真正在等我的判成 "no"。只根据下面的内容判断，不需要调用工具。',
    '只输出 JSON 代码块：{"items":[{"c":"c1","verdict":"reply","reason":"不超过 20 字：reply 写我该回什么；maybe/no 写依据"}]}，每个会话都要有一条。',
    '',
    ...cands.flatMap(x => [`## ${x.c}｜${x.group ? '群「' + x.convName + '」' : '私聊「' + x.convName + '」'}`, ...x.lines, '']),
  ].join('\n');
}

/** 解析 CodeAgent 的回答 → { 会话 id: { lastKey, verdict, reason } }；读不出返回 null。 */
function parse(text, cands) {
  const raw = String(text || '');
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = block ? block[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let data; try { data = JSON.parse(body); } catch { return null; }
  const byC = new Map((cands || []).map(x => [x.c, x]));
  const items = {};
  for (const row of Array.isArray(data?.items) ? data.items : []) {
    const cand = byC.get(String(row?.c || '').trim());
    const verdict = String(row?.verdict || '').trim().toLowerCase();
    if (!cand || !['reply', 'maybe', 'no'].includes(verdict)) continue;
    items[cand.conv] = { lastKey: cand.lastKey, verdict, reason: D.short(String(row.reason || '').trim(), 40) };
  }
  return Object.keys(items).length ? items : null;
}

module.exports = { REVIEW_HOURS, slotOf, nextSlotAt, candidates, prompt, parse };
