'use strict';
// 主页的助理会话卡片原来把 Hub 的内部标记原样显示（2026-11-18 用户反馈：整理未读邮件时看到 [mail:AAMk… 像乱码，
// 左侧助理页里没有）。规则收在 renderer/assistant-source-marks.js，这里测两件事：
//   1) 纯函数本身：出处编号换成「出处」标签、收工回执整行去掉，其他方括号一个字符都不动；
//   2) 卡片正文的真实链路：renderMessageBody（markdown）→ tagSourceMarks，结果里不再出现编号原文。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const marks = require('../renderer/assistant-source-marks');
const { renderMessageBody } = require('../renderer/conversation-message-view');

const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const renderMarkdown = text => marked.parse(String(text || ''), { breaks: true, gfm: true });
const cardBody = (text, isUser = false) => marks.tagSourceMarks(
  renderMessageBody(text, { isUser, foldLong: false, escapeHtml, renderMarkdown }), escapeHtml);

test('出处编号换成「出处」标签，点开走助理页；普通方括号和链接不动', () => {
  const html = marks.tagSourceMarks('<p>邮件 [mail:AAMkADY5L4GUAAA=] 和消息 <code>[msg:conv-1:k9]</code></p>', escapeHtml);
  assert.ok(!html.includes('[mail:'), '编号原文不再出现：' + html);
  assert.ok(!html.includes('[msg:'), '行内代码里的编号同样换掉：' + html);
  assert.match(html, /data-action="assistant-source" data-source="mail:AAMkADY5L4GUAAA="[^>]*title="查看出处 · 邮件">出处</);
  assert.match(html, /data-source="msg:conv-1:k9"[^>]*title="查看出处 · 消息"/);
  // 一个方括号里并列多个编号：拆成多个标签。
  const many = marks.tagSourceMarks('<p>见 [cal:5d7e9a13, mail:AAMk&amp;x]</p>', escapeHtml);
  assert.equal((many.match(/data-action="assistant-source"/g) || []).length, 2, many);
  assert.ok(many.includes('data-source="mail:AAMk&amp;x"'), '编号里的 & 仍按 HTML 转义写回：' + many);
  // 不是出处编号的方括号、链接文字、属性值都原样保留。
  for (const kept of ['<p>[备注] 要看</p>', '<p><a href="https://x">[msg:a](https://x)</a></p>', '<a title="[msg:z]">x</a>']) {
    assert.equal(marks.tagSourceMarks(kept, escapeHtml), kept, kept);
  }
});

test('收工回执整行去掉：中英文冒号、带不带方括号、混在句末都认', () => {
  const token = '574a2955-999e-4177-89cb-a0828b17e12c';
  assert.equal(marks.stripReceiptMarks(`分好了。\n\n[助理回执:${token}]`), '分好了。');
  assert.equal(marks.stripReceiptMarks(`分好了。\n助理回执：${token}`), '分好了。');
  assert.equal(marks.stripReceiptMarks(`分好了。[助理回执:${token}] 就这些`), '分好了。 就这些');
  // 没有回执的正文一个字符都不动；非字符串原样返回。
  const plain = '第一行\n第二行 [mail:AAMk=]\n';
  assert.equal(marks.stripReceiptMarks(plain), plain);
  assert.equal(marks.stripReceiptMarks(undefined), undefined);
  // 「助理回执」四个字出现在正常句子里、后面不是编号：不删。
  assert.equal(marks.stripReceiptMarks('助理回执是 Hub 内部用的'), '助理回执是 Hub 内部用的');
});

test('卡片正文链路：助理整理未读邮件的回答里，看不到编号原文和回执，只留「出处」标签', () => {
  const token = '574a2955-999e-4177-89cb-a0828b17e12c';
  const answer = ['**要你处理（2）**', '',
    '1. iLearning「无线通用业务能力认证考试」：今天 11:08 到，建议今天内打开确认时间并报名 [mail:...L4GUAAA=]',
    '2. songfeiyu（宋飞宇）无主题邮件：建议点开扫一眼 [mail:...L4GOAAA=]', '',
    `[助理回执:${token}]`].join('\n');
  const html = cardBody(marks.stripReceiptMarks(answer));
  assert.ok(!html.includes('[mail:'), '正文里不再出现编号原文：' + html);
  assert.ok(!html.includes('助理回执'), '回执不进卡片：' + html);
  assert.equal((html.match(/class="turn-source-tag"/g) || []).length, 2, html);
  assert.ok(html.includes('<strong>要你处理（2）</strong>'), 'markdown 照常渲染：' + html);
  // 用户自己写的 [mail:…] 字样（转义过的用户文本）同样变标签，和助理页一致。
  assert.match(cardBody('看看 [mail:AAMk=]', true), /class="turn-source-tag"/);
});

test('卡片渲染接线：只有公司助理会话的回合带标记，其他会话正文不动', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'), 'utf8');
  assert.match(src, /const assistantMarks = session\?\.purpose === 'company-assistant';/);
  assert.match(src, /if \(assistantMarks\) turn = stripAssistantReceipts\(turn\);/);
  assert.match(src, /assistantSourceMarks: true/);
  assert.match(src, /const sourceTags = html => turn\.assistantSourceMarks \? require\('\.\/assistant-source-marks'\)\.tagSourceMarks\(html, escapeHtml\) : html;/);
  assert.match(src, /const body = sourceTags\(/);
  assert.match(src, /data-action="assistant-source"/);
  assert.match(src, /win\.__companyAssistantShowSource/);
  // 助理页用同一套识别规则，点开出处的入口对得上。
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(page, /require\('\.\/assistant-source-marks'\)\.replaceSourceMarks\(html, ids =>/);
  assert.match(page, /window\.__companyAssistantShowSource = async source =>/);
});
