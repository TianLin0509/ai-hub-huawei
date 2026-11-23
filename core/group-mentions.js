'use strict';
// 群聊 @点名解析：主进程派发与渲染进程「目标 X/Y」芯片共用同一套规则。
// 中文里 @ 后面常常不留空格（「@m1帮我看下」）：整段连着的文字不是名字时，再看它是不是以某个成员名开头、后面紧跟汉字。
// 以前这种写法认不出来，消息静默发给所有成员（用户反馈：@ 没有作用）。
const MENTION_ALL = ['all', '全部', '所有人'];
const CJK = /[一-鿿]/;
function memberMentionKeys(mem) {
  const position = Number.isInteger(mem.index) ? [`成员${mem.index + 1}`] : [];
  return [mem.memberId, mem.displayName, mem.kind, mem.model, ...(mem.aliases || []), ...position]
    .filter(Boolean).map(x => String(x).toLowerCase().replace(/\s+/g, ''));
}
function resolveMention(rawToken, members) {
  const token = String(rawToken || '').toLowerCase().replace(/[._-]+$/, '');
  if (MENTION_ALL.includes(token)) return { all: true };
  const exact = members.filter(mem => memberMentionKeys(mem).includes(token));
  if (exact.length) return { hit: exact.length === 1 ? exact[0] : null };
  if (MENTION_ALL.some(key => token.startsWith(key) && CJK.test(token[key.length] || ''))) return { all: true };
  let best = null, bestLength = 0, tied = false;
  for (const mem of members) {
    for (const key of memberMentionKeys(mem)) {
      if (!token.startsWith(key) || !CJK.test(token[key.length] || '')) continue;
      if (key.length > bestLength) { best = mem; bestLength = key.length; tied = false; }
      else if (key.length === bestLength && best !== mem) tied = true;
    }
  }
  return { hit: tied ? null : best };
}
function parseGroupTargets(userInput, members, participants, requireAllMentions = false) {
  const selected = Array.isArray(participants) ? participants : [];
  const selectedMembers = members.filter(m => selected.includes(m.index));
  const mentionRe = /@([A-Za-z0-9_.\-一-鿿]+)/g;
  const mentioned = [];
  let unresolved = false;
  let m;
  while ((m = mentionRe.exec(userInput || '')) !== null) {
    const { all, hit } = resolveMention(m[1], members);
    if (all) return { targets: members, mentions: ['all'] };
    if (!hit) unresolved = true;
    if (hit && !mentioned.some(x => x.sid === hit.sid)) mentioned.push(hit);
  }
  if ((!requireAllMentions || !unresolved) && mentioned.length > 0) return { targets: mentioned, mentions: mentioned.map(x => x.memberId) };
  return { targets: selectedMembers, mentions: [] };
}

module.exports = { MENTION_ALL, CJK, memberMentionKeys, resolveMention, parseGroupTargets };
