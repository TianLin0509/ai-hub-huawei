'use strict';
// 本地规则起会话标题（2026-10-30 用户：公司版自动起名不再开一个 CodeAgent 会话，改成很轻的本地规则）。
// 起因：公司 AI「会话标题」任务每次开一个完整的 CodeAgent 会话（30–90 秒、几百 MB），还出现在侧栏；
// 那个会话不带 --model，CodeAgent 记着的模型名写错时直接报「模型不存在」。
// 规则：去掉代码块、链接和 Markdown 符号，路径只留文件名 → 去掉开头的口头语（帮我、请、你看下……）
// → 取第一句；超过 16 字宽（汉字算 1、字母数字算半个）先试第一个逗号前，还长就截断 → 去掉句尾语气词和标点。不调用任何模型。

const MAX = 16;
// 显示宽度：汉字等算 1，字母数字和半角符号算 0.5（「PfScheduler.cc 的权重更新」不该比同样长的中文句子先被截断）
const widthOf = str => [...str].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1), 0);
const LEAD = /^(?:(?:那|那么|好的?|嗯|哦|ok|OK|麻烦你?|请你?|帮我|帮忙|你(?:先|再)?|我(?:想|要|需要)|能不能|可不可以|可以|然后|现在|另外|再)\s*[，,、]?\s*)+/;
const LEAD_VERB = /^(?:(?:帮我|给我)?(?:看|查|确认|检查|分析|研究)(?:一)?下(?:看)?|看看|查查)\s*[，,、:：]?\s*/;
const TAIL = /[\s，,。.！!？?；;：:、~～…\-—]+$|(?:吗|呢|吧|啊|呀|哈|了吧)+$/;

function stripNoise(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/[^\s)）]+/g, ' ')
    .replace(/(?:[A-Za-z]:|[\w.-]+)?(?:[\\/][^\s\\/：:，,。]+){2,}/g, m => (/^[\d\\/.\s-]+$/.test(m) ? m : ' ' + m.split(/[\\/]/).filter(Boolean).pop() + ' '))
    .replace(/[#*_>\[\]{}<>|]/g, ' ')
    .replace(/^[\s\-+\d.、)）]+/gm, '');
}

function firstSentence(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(l => /[\p{L}\p{N}]/u.test(l));
  // 【引用会话】【公司回执】这类系统前缀行不代表这次要做的事
  const line = lines.find(l => !/^【[^】]{1,20}】/.test(l)) || lines[0] || '';
  return (line.split(/[。！？!?；;]/)[0] || '').trim();
}

function trimEnds(s) {
  let out = s.trim();
  for (let i = 0; i < 3 && TAIL.test(out); i += 1) out = out.replace(TAIL, '').trim();
  return out;
}

// 截到 max 字，但不把英文单词、数字或模型名截成半截：落在一串字母数字中间时，这串不长就补完，长就退到它前面。
function cutAt(s, maxWidth) {
  const chars = [...s];
  if (widthOf(s) <= maxWidth) return s;
  let max = 0, w = 0;
  while (max < chars.length && w + widthOf(chars[max]) <= maxWidth) { w += widthOf(chars[max]); max += 1; }
  const word = /[A-Za-z0-9._-]/;
  if (!word.test(chars[max - 1]) || !word.test(chars[max])) return chars.slice(0, max).join('');
  let start = max - 1; while (start > 0 && word.test(chars[start - 1])) start -= 1;
  let end = max; while (end < chars.length && word.test(chars[end])) end += 1;
  if (end <= max + 6) return chars.slice(0, end).join('');
  return start >= 4 ? chars.slice(0, start).join('') : chars.slice(0, max).join('');
}

function titleFromPrompt(text) {
  let s = firstSentence(stripNoise(text));
  for (let i = 0; i < 3; i += 1) { const next = s.replace(LEAD, '').replace(LEAD_VERB, '').trim(); if (next === s) break; s = next; }
  s = trimEnds(s);
  if (widthOf(s) > MAX) {
    const head = trimEnds(s.split(/[，,]/)[0] || '');
    s = widthOf(head) >= 4 && widthOf(head) <= MAX ? head : trimEnds(cutAt(s, MAX));
  }
  return [...s].length >= 2 ? s : '';
}

module.exports = { titleFromPrompt, MAX };
