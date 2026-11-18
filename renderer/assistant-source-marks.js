'use strict';
// 公司助理（会话 purpose = company-assistant）的问答里带两类只给 Hub 看的标记：
//   1) 出处编号 [msg:…] [meeting:…]（旧写法 mtg:）[cal:…] [mail:…]：助理页换成灰色「出处」标签，点开看本机原文；
//   2) 收工回执 [助理回执:<本问编号>]：Hub 据此判断这一问答完（core/company-assistant/service.js
//      的提问里写明「这一行不会显示给用户」），助理页存聊天记录前就剥掉了。
// 助理页（renderer/company-assistant-page.js）两样都处理过，主页的助理会话卡片原来直接显示 CLI 原文，
// 用户看到的就是 [mail:AAMk… 和 [助理回执:…] 这种像乱码的东西（2026-11-18 用户反馈）。
// 规则收在这一个文件里，两边共用，避免再次只修一边。

const unescHtml = v => String(v ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));
// 正文里的出处编号（或包在行内代码里）。作用在已转义 / 已净化的 HTML 上。
const SOURCE_MARK_RE = /<code>\[([^\]<>]+)\]<\/code>|\[([^\]<>]+)\]/g;
const SOURCE_ID = /^(?:msg|meeting|mtg|cal|mail):\S+$/;
const SOURCE_KINDS = Object.freeze({ msg: '消息', meeting: '会议', mtg: '会议', cal: '日程', mail: '邮件' });
const sourceKindLabel = id => SOURCE_KINDS[String(id || '').split(':')[0]] || '记录';

// 找出正文里的出处编号，交给 render(ids) 换成标签；一个方括号里可能并列多个编号。
// 链接文字 [..](..) 与属性里的方括号不动；编号不合规的方括号（如 [备注]）原样保留。
function replaceSourceMarks(html, render) {
  return String(html || '').replace(SOURCE_MARK_RE, (all, coded, plain, offset, whole) => {
    if (whole[offset + all.length] === '(' || /=["'][^"']*$/.test(whole.slice(Math.max(0, offset - 200), offset))) return all;
    const ids = unescHtml(coded ?? plain).split(/[,，;；、]\s*|\s+/).map(s => s.trim()).filter(Boolean);
    if (!ids.length || !ids.every(id => SOURCE_ID.test(id))) return all;
    return render(ids);
  });
}

// 主页会话卡片用的标签：文字与助理页一样写「出处」，点开交给助理页显示本机原文。
function tagSourceMarks(html, escapeHtml) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : v => String(v ?? '');
  return replaceSourceMarks(html, ids => ids.map(id =>
    `<button type="button" class="turn-source-tag" data-action="assistant-source" data-source="${esc(id)}" title="查看出处 · ${esc(sourceKindLabel(id))}">出处</button>`).join(''));
}

// 收工回执：整行只有回执的（正常写法）连行一起去掉，混在句末的只去掉标记本身。
// 编号是 UUID，这里不认识本问的编号，按形状匹配；没写「助理回执」四个字的正文一个字符都不动。
const RECEIPT_MARK_RE = /\[?\s*助理回执\s*[:：]\s*[0-9a-fA-F][0-9a-fA-F-]{7,63}\s*\]?/g;
function stripReceiptMarks(text) {
  if (typeof text !== 'string' || !text.includes('助理回执')) return text;
  const kept = [];
  for (const line of text.split('\n')) {
    const cleaned = line.replace(RECEIPT_MARK_RE, '');
    if (line.trim() && !cleaned.trim()) continue;
    kept.push(cleaned);
  }
  return kept.join('\n').replace(/\s+$/, '');
}

module.exports = { replaceSourceMarks, tagSourceMarks, stripReceiptMarks, sourceKindLabel, SOURCE_ID, SOURCE_MARK_RE };
