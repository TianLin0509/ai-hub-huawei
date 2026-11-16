'use strict';
// 「我是不是真的欠对方一句回复」的规则判定（2026-11-16，从微信 Tab v0.5 搬来，WeLink 共用）。
// 2026-11-15 真实数据实测：微信「待回复」26 条里约 20 条是正常收尾（回表情、「好的/谢谢」、打招呼、群发通知、我问对方答）。
// 只看对方最后一段连续发言（burst）和我紧挨着的上一段，纯函数、与消息来源无关。
// 消息形状：{ mine: true|false|null, kind: 'text'|'sticker'|'system'|'other', text, at }，按时间从早到晚。

const WEAK_EXPIRE_MS = 24 * 3600 * 1000;    // 没有问句的「可能要回」只在 24 小时内显示

// 明确问句、请求：直接算
const ASK_RE = /[?？]|吗|[呢么][\s。.!！~～]*$|别忘了|不要忘了|你记得|记得帮|能不能|可不可以|可以不|是否|在不在|在吗|要不要|行不行|好不好|方便吗|你帮我|帮我[看查找弄问拿带]|帮个忙|帮下忙|麻烦你|请你|请您|请帮|辛苦你|^\s*请(?!问题)|[，,。；;]\s*请|麻烦.{0,4}(看|确认|审|回|发|帮|处理)|请.{0,6}(确认|审核|审批|评审|反馈|回复|看下|看一下|核对|处理)/;
// 疑问词：前面有「不知道」这类转述时只是陈述
const WH_RE = /什么|啥|哪|何时|几时|几点|几号|几个|几天|多久|多少|谁|为啥|为什么|怎么|咋|干嘛|干啥|是不是|有没有|([一-丌与-龥])不\1|要不|来个|发我|给我发/;
const WH_NEG_RE = /不知道|不清楚|不晓得|不确定|没想到|谁知道|没什么|什么都|啥都|哪都|谁都|怎么都|多少有点|多少也|都可以|也可以|也是可以|都行|随便|无所谓/;
// 我上一句是不是在问（宽松：我问了、对方答了没反问＝这轮聊完了）
const MY_ASK_RE = /怎么|什么|啥|哪|几|多少|谁|为啥|为什么|可以不|行不|[?？]|吗/;
// 收尾话：整句只由这些词（加语气词、标点、表情）组成
const ACK_WORD = '好的|好滴|好嘞|好哒|好吧|好呀|好|嗯|恩|哦|噢|喔|ok|okk|okay|收到|了解|明白|知道了|行|没问题|谢谢|谢啦|多谢|感谢|不客气|不用谢|没事|晚安|拜拜|再见|哈|嘿|嘻|呵|嗷|对|是的|是|可以|你|呀|啊|啦|了|呢|哒|滴|的|吧|哇|耶|辛苦|辛苦了';
const ACK_RE = new RegExp(`^(?:${ACK_WORD})+$`, 'i');
const NOTICE_RE = /^\s*【|⏰|🛒|#\S+|双1[12]|优惠|福利|活动时间|温馨提示|报名|团购|秒杀|下单/g;
const GREET_RE = /打招呼的消息|已添加了|通过了你的朋友验证/;

/** 去掉标点、空白、[微笑] 这类表情码和 emoji，剩下的才是「说了什么」。 */
function bareText(s) {
  // WeLink 文本表情的真实编码带 U+2060 前缀，例如 /CY、/OK；普通斜杠正文保留。
  return String(s || '').replace(/\u2060(?:\/[A-Za-z;:]{1,3}|\[[^\]\s]{1,12}\])/g, '')
    .replace(/\[[^\]\s]{1,8}\]/g, '').replace(/[\p{P}\p{S}\p{Extended_Pictographic}\s‍️]/gu, '').trim();
}
function asks(m) {
  if (m.kind === 'sticker') return false;
  const t = String(m.text || '');
  return ASK_RE.test(t) || (WH_RE.test(t) && !WH_NEG_RE.test(t));
}
function isAck(m) {
  if (m.kind === 'sticker') return true;
  if (m.kind !== 'text') return false;
  const t = bareText(m.text);
  return !t || (t.length <= 12 && ACK_RE.test(t));
}
function isNotice(m) {
  const t = String(m.text || '');
  return m.kind === 'text' && t.length >= 30 && (t.match(NOTICE_RE) || []).length >= 2;
}

// 群发通知里也会有「请提前报名」；但明确冲着我来的请求/问句不能被当成通知
const PERSONAL_RE = /[?？]|请你|请您|你帮我|麻烦你|你记得|回复我|回我|你确认|你看下|你看一下|等你/;
const isBroadcast = m => isNotice(m) && !PERSONAL_RE.test(String(m.text || m.content || ''));

/**
 * 一对一会话：判断欠不欠回复。msgs 按时间从早到晚（可含系统提示）。
 * 返回 { level: 'strong'|'weak', reason, message } 或 { closed: 原因 }。
 *  - 对方在问/求我 → strong（该回）；message 是那句问话
 *  - 最后一句是表情、「好的/谢谢」之类 → closed:ack
 *  - 加好友的打招呼、群发通知 → closed:greeting / closed:notice
 *  - 我刚问了对方、对方答了且没反问 → closed:answered
 *  - 其他陈述 → weak（可能要回）
 */
function judgeDirect(msgs) {
  const all = Array.isArray(msgs) ? msgs : [];
  const real = all.filter((m) => m && m.kind !== 'system');
  const burst = [];
  for (let i = real.length - 1; i >= 0; i -= 1) { if (real[i].mine !== false) break; burst.push(real[i]); }
  if (!burst.length) return { closed: 'mine' };
  const last = burst[0];
  if (burst.every(isBroadcast)) return { closed: 'notice' };        // 群发通知里的「请提前报名」不算请我
  const askMsg = burst.find(asks);
  if (askMsg) return { level: 'strong', reason: 'ask', message: askMsg };
  if (isAck(last)) return { closed: 'ack' };
  const greet = all.some((m) => m && m.kind === 'system' && GREET_RE.test(String(m.text || '')));
  if (greet && !real.some((m) => m.mine === true)) return { closed: 'greeting' };
  if (burst.every(isBroadcast) || isBroadcast(last)) return { closed: 'notice' };
  const myPrev = [];
  for (let i = real.length - 1 - burst.length; i >= 0; i -= 1) { if (real[i].mine !== true) break; myPrev.push(real[i]); }
  if (myPrev.some((m) => asks(m) || MY_ASK_RE.test(String(m.text || '')))) return { closed: 'answered' };
  return { level: 'weak', reason: 'statement', message: last };
}

module.exports = { WEAK_EXPIRE_MS, judgeDirect, asks, isAck, isNotice, bareText };
