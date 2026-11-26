'use strict';
// 桌宠待办卡片的一行输入（2026-11-26）：从「3点 交周报」「明天 订会议室」「30分钟后 回电话」里认出时间，剩下的当标题。
// 按北京时间理解；只认常见说法，认不出就当不定时待办（宁可不设提醒，也不猜错时间）。
const BJ = 8 * 3600000, DAY = 86400000, MIN = 60000;
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const num = s => (/^\d+$/.test(s) ? Number(s) : CN[s]);
const bjDay = ms => Math.floor((ms + BJ) / DAY);
const bjMidnight = ms => bjDay(ms) * DAY - BJ;

// 返回 { title, at（毫秒，或 null）, later（移到「稍后」，不设时间）}。
// 时间词只认句首或句尾（「3点 交周报」「交周报 明天3点」）；句子中间的不动——「订周四会议室」是要订周四的会议室，不是周四提醒。
const TOKENS = {
  rel: /(\d{1,3}|半)\s*(分钟|小时|个小时)\s*以?后/,
  date: /今天|今晚|明天|明早|明晚|后天/,
  week: /(下)?(?:周|星期|礼拜)([一二三四五六日天])/,
  time: /(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]|十[一二])\s*(?:[:：]\s*(\d{2})|点\s*(半|一刻|三刻|\d{1,2}\s*分?)?|时)/,
};
const SEP = '[\\s，,。:：、]*';
const EDGE = Object.fromEntries(Object.entries(TOKENS).map(([k, re]) => [k, [new RegExp('^' + SEP + '(?:' + re.source + ')' + SEP), new RegExp(SEP + '(?:' + re.source + ')' + SEP + '$')]]));

function parseTodo(text, now = Date.now()) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  let rest = raw, at = null, later = false, m;
  const got = {};
  // 从两头一层层剥：每类最多认一次，剥不动为止。
  for (let round = 0; round < 4; round += 1) {
    let progressed = false;
    for (const key of ['rel', 'date', 'week', 'time']) {
      if (got[key] || (key === 'week' && got.date) || (key === 'date' && got.week)) continue;
      for (const re of EDGE[key]) {
        const hit = rest.match(re);
        if (!hit) continue;
        const inner = hit[0].match(TOKENS[key]);
        if (key === 'time' && num(inner[2]) == null) continue;
        // 句首光写数字加「点」、后面紧跟字（「3点建议」）不算时间；带「下午」、冒号写法或前面已有日期（「明天3点开会」）才算。
        if (key === 'time' && hit.index === 0 && !inner[1] && inner[3] == null && !got.date && !got.week
          && rest.length > hit[0].length && !/[\s，,。:：、]$/.test(hit[0])) continue;
        got[key] = inner; rest = (rest.slice(0, hit.index) + ' ' + rest.slice(hit.index + hit[0].length)).trim(); progressed = true; break;
      }
    }
    if (!progressed) break;
  }

  if ((m = got.rel)) {
    const n = m[1] === '半' ? 0.5 : Number(m[1]);
    const ms = /小时/.test(m[2]) ? n * 60 * MIN : n * MIN;
    // 1 分钟到 7 天之外（「半分钟后」「0分钟后」「999小时后」）：保留原文并提示，不悄悄丢掉提醒。
    if (!(ms >= MIN && ms <= 7 * DAY)) return { title: [...raw].slice(0, 80).join(''), at: null, later: false, warn: '相对时间要在 1 分钟到 7 天之间，先按不定时记下' };
    at = now + ms;
  } else {
    let dayOffset = null, dateWord = '';
    if ((m = got.date)) {
      dayOffset = { 今天: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2 }[m[0]];
      dateWord = m[0];
    } else if ((m = got.week)) {
      const want = WEEK[m[2]], today = new Date(now + BJ).getUTCDay();
      // 「周五」指这周还没过的那天（今天或已过就指下周）；「下周一」指下一个自然周的周一。
      let d = (want - today + 7) % 7;
      if (m[1]) d = ((8 - today) % 7 || 7) + (want + 6) % 7;
      else if (d === 0) d = 7;
      dayOffset = d; dateWord = m[0];
    }
    let hour = null, minute = 0;
    if ((m = got.time)) {
      hour = num(m[2]);
      const part = m[1] || (/晚/.test(dateWord) ? '晚上' : /早/.test(dateWord) ? '上午' : '');
      const tail = m[3] || m[4] || '';
      minute = tail === '半' ? 30 : tail === '一刻' ? 15 : tail === '三刻' ? 45 : (parseInt(tail, 10) || 0);
      if (/下午|傍晚|晚上/.test(part) && hour < 12) hour += 12;
      else if (part === '中午' && hour < 6) hour += 12;
      else if (!part && hour >= 1 && hour <= 7) hour += 12;   // 上班时间里说「3点」指下午
      if (hour > 23 || minute > 59) return { title: [...raw].slice(0, 80).join(''), at: null, later: false, warn: '时间没看懂，先按不定时记下' };
    }
    if (dayOffset != null || hour != null) {
      const base = bjMidnight(now) + (dayOffset || 0) * DAY;
      if (hour == null) { hour = /晚/.test(dateWord) ? 20 : 9; minute = 0; }
      at = base + hour * 3600000 + minute * MIN;
      if (dayOffset == null && at <= now) at += DAY;          // 只说了钟点、今天已过：指明天
      if (at <= now) return { title: [...raw].slice(0, 80).join(''), at: null, later: false, warn: '这个时间已经过了，先按不定时记下' };
    }
  }
  const cut = s => { rest = rest.replace(s, ' '); };

  if (at == null && (m = rest.match(/^(以后|稍后|回头|有空|改天)[，,\s]*|[，,\s]*(以后|稍后|回头|有空|改天)(再说|再做|再弄)?$/))) { later = true; cut(m[0]); }

  let title = rest.replace(/\s+/g, ' ').replace(/^[\s，,。.：:、]+|[\s，,。.：:、]+$/g, '').trim();
  if (!title) title = raw;
  return { title: [...title].slice(0, 80).join(''), at, later };
}

// 卡片上的时间小标：今天只写钟点，其他写「明天 9:00」「周五 10:00」「11-30 9:00」。
function whenText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at + BJ), hm = d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  const diff = bjDay(at) - bjDay(now);
  if (diff === 0) return hm;
  if (diff === 1) return '明天 ' + hm;
  if (diff === -1) return '昨天 ' + hm;
  if (diff > 1 && diff < 7) return '周' + '日一二三四五六'[d.getUTCDay()] + ' ' + hm;
  return (d.getUTCMonth() + 1) + '-' + d.getUTCDate() + ' ' + hm;
}

module.exports = { parseTodo, whenText, bjDay };
