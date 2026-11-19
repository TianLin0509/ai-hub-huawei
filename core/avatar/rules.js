'use strict';
// 替身（数字分身）的规则层：全部是纯函数，不调用模型。
// 「这条消息替身能做到哪一步」只由这里决定：模型只负责写草稿，写出来的话发不发、给不给看，模型说了不算。
// 依据（2026-11-12 回放 120 条真实消息）：模型自认十足把握的 16 条里 3 条有问题；回上级的 16 条草稿里 4 条有问题，其中 2 条是替本人应承了没应承的事。

const LEVELS = Object.freeze([
  { id: 0, name: '不读', hint: '这个会话替身完全不看' },
  { id: 1, name: '只听', hint: '读消息攒上下文，不提醒也不起草' },
  { id: 2, name: '提醒', hint: '告诉你谁在等，不起草' },
  { id: 3, name: '起草', hint: '写好草稿，你确认后才发' },
]);
const MAX_LEVEL = 3;
const SELF_PREFIX = '【数字分身】';
// 对方是替身或自动回复：不回，防止两个替身对聊。
const AUTO_REPLY = /^\s*(?:🤖|【数字分身】|\[数字分身\]|\[替身\]|【替身】|\[自动回复\]|【自动回复】|【助理】)/;

// 内容闸：命中任何一类，这条最多只提醒。
const SENSITIVE = Object.freeze([
  ['人事', /绩效|考评|薪酬|工资|奖金|涨薪|调薪|晋升|任职资格|离职|辞职|去留|裁员|劝退|招聘|面试评价|投诉|举报|体检|生病|住院|病假|抑郁|怀孕/],
  ['拍板', /批准|审批|签字|拍板|你来定|你决定|你定一下|评价一下|怎么评价|打个分|同不同意/],
  ['凭据', /密码|口令|令牌|token|验证码|密钥|转账|汇款|付款|借.{0,4}账号/i],
  ['指令', /忽略(?:以上|上面|之前|前面)|无视(?:以上|上面|之前)|按(?:下面|以下)的?(?:指令|要求)(?:回复|执行|输出)|ignore\s+(?:all\s+|the\s+)?(?:previous|above)|system\s*prompt|系统提示词/i],
]);
// 应承词：草稿里出现就标红（回放里最伤的一类错）。只看草稿，不看来消息。
const COMMIT = /^(?:好的?|好滴|可以|行|ok+|没问题|收到|嗯+|我来|我去|马上|会的|一定)(?:[\s，,。！!~～]|$)|我来(?:搞|做|弄|处理|跟|写|看)|没问题|(?:明天|今晚|今天|下午|晚点|稍后|回头|周[一二三四五六日末])(?:给|发|交|弄|搞定|同步)|马上(?:给|发|弄|处理|安排)|我(?:负责|跟进|安排)|保证|答应/i;
// 交办句式：某人常对本人这样说话，多半是上级。只用来给出「建议保护」，由本人确认。
const ASSIGN = /给我|尽快|你来(?:搞|做|弄|写|跟)?|对一下|截止|今天内|汇报一下|抓紧|安排一下|跟进一下|发我|出一版|什么时候能/;
const TITLE = /部长|总监|总裁|经理|主任|首席|Fellow|高级技术专家|总工|院长|主管/i;

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// 职级（2026-11-12 用户：WeLink 里能看到对方等级，比我高的就是领导）。
// 来源是通讯录 search person 的「职位」（appointPos），如「技术专家B(5G AI算法专家)」。括号里是岗位名，不参与比较。
// 排序口径（AI 按常见写法推的，用户未逐级确认）：工程师 < 高级工程师 < 主任工程师 < 某某专家 < 高级专家 < 资深专家 < 首席；
// 同一档里 B 高于 A。带部长、总监、总裁、院长、总经理、主管的是行政主管，不看职级，直接当上级。
const MANAGER = /部长|总监|总裁|院长|总经理|主管|^经理$/;
function rankOf(title) {
  const t = clean(title).replace(/[（(].*$/, '').trim();
  if (!t) return null;
  if (MANAGER.test(t)) return { manager: true, rank: 100, title: t };
  const ab = /B$/i.test(t) ? 1 : 0;
  let base = null;
  if (/首席|Fellow/i.test(t)) base = 26;
  else if (/资深.*专家/.test(t)) base = 22;
  else if (/高级.*专家/.test(t)) base = 19;
  else if (/专家/.test(t)) base = 16;
  else if (/主任工程师/.test(t)) base = 14;
  else if (/高级工程师/.test(t)) base = 12;
  else if (/工程师/.test(t)) base = 10;
  else if (/技师|事务员|专员/.test(t)) base = /高级/.test(t) ? 6 : /中级/.test(t) ? 4 : 2;
  return base === null ? null : { manager: false, rank: base + ab, title: t };
}
// 对方职级比本人高，或者是行政主管 → 按上级保护。任何一方认不出职级就不判（返回 null），交给建议和手动设置。
function aboveMe(theirTitle, myTitle) {
  const them = rankOf(theirTitle), me = rankOf(myTitle);
  if (!them || !me) return null;
  if (them.manager && me.manager) return null; // 两位主管之间分不出高低
  if (them.manager !== me.manager) return them.manager;
  return them.rank > me.rank;
}
const isText = m => !m.contentType || /TEXT/i.test(m.contentType);

function sensitiveHit(text) {
  const s = String(text || '');
  for (const [name, re] of SENSITIVE) if (re.test(s)) return name;
  return '';
}
const commitRisk = text => COMMIT.test(clean(text));
const isAutoReply = text => AUTO_REPLY.test(String(text || ''));

// 从一轮采集的快照里找出「轮到本人回」的机会。
//   私聊：最后一句是别人说的 → 从本人上一句之后的所有来消息合成一个机会；
//   群：有人 @ 本人且之后本人没在这个群说过话。
// 每个机会的编号由「会话 + 第一条没回的消息」决定，同一轮对话后面再来消息仍是同一个机会。
function opportunities(snapshot) {
  const out = [];
  for (const conv of snapshot?.conversations || []) {
    const list = (snapshot.messages || {})[conv.id] || [];
    if (!list.length) continue;
    let lastMine = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].mine) { lastMine = i; break; }
    const tail = list.slice(lastMine + 1);
    if (!tail.length) continue;
    const pick = conv.group ? tail.filter(m => m.atMe) : tail;
    if (!pick.length) continue;
    const first = pick[0], last = pick[pick.length - 1];
    const full = pick.map(m => isText(m) ? clean(m.text) : '［非文字消息］').filter(Boolean).join('\n');
    out.push({
      id: `${conv.id}:${first.key}`, conv: conv.id, convName: conv.name || conv.id, group: !!conv.group,
      account: conv.group ? last.account : conv.id, who: conv.group ? last.sender : (conv.name || last.sender),
      firstKey: first.key, lastKey: last.key, since: first.at || 0, at: last.at || 0, count: pick.length,
      text: full.slice(0, 1200), sensitive: sensitiveHit(full), auto: pick.some(m => isAutoReply(m.text)),
      hasNonText: pick.some(m => !isText(m)), onlyNonText: pick.every(m => !isText(m) || !clean(m.text)),
      senders: [...new Set(list.slice(-20).filter(m => !m.mine).map(m => m.account))],
    });
  }
  return out.sort((a, b) => a.since - b.since);
}

// 本人在这个机会之后说的话（用来判断「已经自己回了」并留作对照）。
function replyAfter(snapshot, item) {
  const list = (snapshot?.messages || {})[item.conv] || [];
  const start = list.findIndex(m => m.key === item.lastKey);
  const from = start >= 0 ? start + 1 : list.findIndex(m => (m.at || 0) > (item.at || 0));
  if (from < 0) return null;
  const mine = [];
  for (const m of list.slice(from)) { if (m.mine) mine.push(m); else if (mine.length) break; }
  if (!mine.length) return null;
  return { at: mine[0].at || 0, text: mine.map(m => isText(m) ? clean(m.text) : '［非文字消息］').filter(Boolean).join('\n').slice(0, 1200) };
}

// 名单里一个对象的设置。没登记过的人按「起草」处理：这一版最高也只到起草，发出去之前一定经过本人。
function entryOf(roster, item) {
  const table = item.group ? roster?.groups : roster?.people;
  return (table && table[item.group ? item.conv : item.account]) || null;
}

// 这条消息替身能做到哪一步：依次过对象闸、内容闸，取最低。返回档位、原因和要标出来的风险。
function decide(item, roster = {}) {
  const entry = entryOf(roster, item);
  const reasons = [], flags = [];
  let level = Number.isInteger(entry?.level) ? Math.max(0, Math.min(MAX_LEVEL, entry.level)) : MAX_LEVEL;
  const cap = (n, why) => { if (n < level) { level = n; reasons.push(why); } };
  if (entry && level < MAX_LEVEL) reasons.push(`名单里设的是「${LEVELS[level].name}」`);
  const person = roster?.people?.[item.account];
  if (person?.protected) flags.push('leader');
  else if (item.group && (item.senders || []).some(a => roster?.people?.[a]?.protected)) flags.push('leader-present');
  if (item.auto || isAutoReply(item.text)) cap(1, '对方是自动回复或另一个替身，不回');
  if (item.onlyNonText) cap(2, '对方发的是图片或文件，替身看不到内容');
  else if (item.hasNonText) flags.push('non-text');
  const hit = item.sensitive || sensitiveHit(item.text);
  if (hit) cap(2, { 人事: '涉及人事、绩效或健康', 拍板: '要你拍板或评价', 凭据: '涉及密码、验证码或钱', 指令: '消息里带着针对 AI 的指令' }[hit]);
  return { level, reasons, flags, sensitive: hit };
}

// 发送前检查（本人点了发送之后）：收信方由程序从待办记录里取，页面和模型都改不了。
function checkSend(item, text, { ackRisk = false } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return '草稿是空的';
  if (body.length > 2000) return '超过 2000 字，请在 WeLink 里直接发';
  if (!item || !item.conv) return '找不到这条消息对应的会话';
  if (isAutoReply(body)) return '本人确认发送的话不带「数字分身」前缀';
  if (commitRisk(body) && (item.flags || []).some(f => f === 'leader' || f === 'leader-present') && !ackRisk) return 'NEED_ACK';
  return '';
}

// welink-cli 的 --text 支持 \n 等转义：把真换行和反斜杠转成它认的写法，路径里的反斜杠不被吃掉。
const cliText = text => String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');

// 两段话像不像（字的二元组重合度，0–1）。只用来把「几乎一样」的对照先挑出来，不当质量分。
function similarity(a, b) {
  const grams = s => { const t = clean(s).replace(/[\s，。！？、,.!?~～…]/g, ''); const set = new Set(); if (t.length === 1) set.add(t); for (let i = 0; i + 1 < t.length; i += 1) set.add(t.slice(i, i + 2)); return set; };
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let both = 0; for (const g of x) if (y.has(g)) both += 1;
  return both / (x.size + y.size - both);
}

// 人设卡初稿：从本人最近发的话里统计，不调用模型。
function personaFrom(texts) {
  const list = (texts || []).map(clean).filter(t => t && t.length <= 200);
  if (list.length < 20) return '';
  const lens = list.map(t => t.length).sort((a, b) => a - b), median = lens[Math.floor(lens.length / 2)], p90 = lens[Math.floor(lens.length * 0.9)];
  const period = list.filter(t => /[。.]$/.test(t)).length, count = new Map();
  for (const t of list) if (t.length <= 6) count.set(t, (count.get(t) || 0) + 1);
  const common = [...count.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => `「${t}」`);
  return [
    `我发消息很短：一半不超过 ${median} 个字，九成不超过 ${p90} 个字。一件事常拆成两三条短消息连着发。`,
    period * 10 < list.length ? '句末基本不加句号。' : '',
    common.length ? `常用的短回复：${common.join('')}。` : '',
    '说话直接，先给判断再说理由，不客套，不用「您好」「请问」「感谢您的」这类书面语。',
  ].filter(Boolean).join('\n');
}

// 谁该进保护名单（建议）：常对本人用交办句式的人。rows：{ account, name, text }（别人发给本人的话）。
function suggestProtected(rows, { min = 5 } = {}) {
  const hit = new Map();
  for (const r of rows || []) {
    if (!r.account || !ASSIGN.test(String(r.text || ''))) continue;
    const cur = hit.get(r.account) || { account: r.account, name: r.name || r.account, n: 0 };
    cur.n += 1; hit.set(r.account, cur);
  }
  return [...hit.values()].filter(x => x.n >= min).sort((a, b) => b.n - a.n).slice(0, 12).map(x => ({ account: x.account, name: x.name, why: `近期 ${x.n} 次用交办的口气对你说话` }));
}

module.exports = { rankOf, aboveMe, LEVELS, MAX_LEVEL, SELF_PREFIX, SENSITIVE, TITLE, clean, sensitiveHit, commitRisk, isAutoReply, opportunities, replyAfter, entryOf, decide, checkSend, cliText, similarity, personaFrom, suggestProtected };
