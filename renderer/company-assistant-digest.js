'use strict';

// 定时汇总的清单：沿用「今天」栏的行样式（5.5.11 起的 .ca-ti），每行点正文看出处、右侧「处理了」。
function digestList(notice, esc) {
  if (notice.kind !== 'digest') return '';
  const names = { private: '私聊未回', mention: '@你待处理', commitment: '答应的事', mail: '重要邮件' };
  return `<div class="ca-digest-list">${(notice.detail?.items || []).map(item => `<div class="ca-ti">
    <button type="button" class="ca-ti-main" data-ca="source:${esc(item.source)}" data-source-day="${esc(item.day)}" title="${esc(item.sourceLabel || '查看出处')}">${esc(item.text)}<span class="ca-ti-tags"><span class="ca-ti-tag${item.isNew ? ' amber' : ''}">${esc(names[item.kind] || '')}${item.isNew ? ' · 新' : ''}</span>${item.due ? `<span class="ca-ti-tag red">截止 ${esc(item.due)}</span>` : ''}</span></button>
    <span class="ca-ti-acts"><button type="button" data-ca="done:${esc(item.source)}" title="点了以后这件事不再出现在汇总里">处理了</button></span>
  </div>`).join('')}</div>`;
}

module.exports = { digestList };
