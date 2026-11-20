'use strict';

// 卡片引用（renderer/card-quote.js）：发给模型的格式、芯片标签、复用粘贴块的展开，以及接线契约。
// 真实界面的选中→浮标→芯片→发送由隔离 Hub 的 CDP 脚本验收（见任务目录的截图证据）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const quote = require('../renderer/card-quote.js');
const chips = require('../renderer/composer-paste-chips.js');

const ts = new Date(2026, 10, 20, 14, 32).getTime();

// 1. 时间与来源标注
assert.strictEqual(quote.formatQuoteTime(ts), '11-20 14:32');
assert.strictEqual(quote.formatQuoteTime(String(ts)), '11-20 14:32', 'numeric string timestamps work');
assert.strictEqual(quote.formatQuoteTime(null), '');
assert.strictEqual(quote.formatQuoteTime('not a date'), '');
assert.strictEqual(quote.quoteSourceLabel({ who: 'Claude', role: 'assistant', ts }), 'Claude · 回答 · 11-20 14:32');
assert.strictEqual(quote.quoteSourceLabel({ who: 'Codex', role: 'assistant', partial: true }), 'Codex · 回答片段');
assert.strictEqual(quote.quoteSourceLabel({ who: '我', role: 'user', ts }), '我的提问 · 11-20 14:32', 'no redundant "我"');
assert.strictEqual(quote.quoteSourceLabel({}), '回答', 'missing parts are dropped, not filled with placeholders');

// 2. 发给模型的正文：Markdown 引用块，空行保留成 ">"，结尾空一行接用户的话
const block = quote.formatQuoteBlock({ who: 'Claude', role: 'assistant', ts, partial: true },
  '\n第一行\r\n\n  缩进行 x\n\n');
assert.strictEqual(block, '> 引用自【Claude · 回答片段 · 11-20 14:32】：\n> 第一行\n>\n>   缩进行 x\n\n');
assert.strictEqual(quote.formatQuoteBlock({}, '   \n  '), '', 'blank selections produce nothing');
const fenced = quote.formatQuoteBlock({ who: 'Claude' }, '```js\nconst a = 1;\n```');
assert.ok(fenced.includes('> ```js\n> const a = 1;\n> ```'), 'code fences stay intact inside the quote');

// 3. 芯片标签：短、带来源和开头几个字
const label = quote.quoteChipLabel({ who: 'Claude', role: 'assistant', ts }, '这是一段比较长的中文回答内容用来测试截断效果');
assert.strictEqual(label, '❝ 引用 · Claude · 11-20 14:32 ·「这是一段比较长的中文回答内容用来…」');
assert.ok(quote.quoteChipLabel({ who: '我', role: 'user' }, '短').includes('我的提问'));

// 4. 复用粘贴块：引用块带 kind/label/title，展开后与格式化正文逐字相同；普通粘贴块不受影响
const meta = quote.quoteChipMeta({ who: 'Claude', role: 'assistant', ts }, '原文');
const id = chips.registerPaste(quote.formatQuoteBlock({ who: 'Claude', role: 'assistant', ts }, '原文'), meta);
const entry = chips.pasteEntry(id);
assert.strictEqual(entry.kind, 'quote');
assert.strictEqual(entry.title, '引用自 Claude · 回答 · 11-20 14:32');
assert.strictEqual(entry.previewText, '原文', 'hover preview shows the passage, not the > markup');
const raw = `${chips.MARK_START}${id}${chips.MARK_END}这里为什么这么设计？`;
assert.strictEqual(chips.expandPasteMarkers(raw),
  '> 引用自【Claude · 回答 · 11-20 14:32】：\n> 原文\n\n这里为什么这么设计？');
const plain = chips.registerPaste('普通粘贴');
assert.deepStrictEqual(chips.pasteEntry(plain), { text: '普通粘贴', lines: 1, chars: 4 }, 'paste entries unchanged');

// 5. 接线契约
const readSource = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
const cardRenderer = readSource('renderer', 'turn-card-renderer.js');
assert.ok(cardRenderer.includes('data-action="quote"'), 'every message card has a 引用 button');
const renderer = readSource('renderer', 'renderer.js');
assert.ok(renderer.includes("if (action === 'quote')"), 'card button handled');
assert.ok(renderer.includes('cardQuote.createSelectionQuoteButton('), 'selection float button mounted');
assert.ok(renderer.includes('quoteText: (text, card) =>'), 'right-click menu offers 引用到输入框');
assert.ok(/function resolveComposerForCard[\s\S]*?String\(cardSid\) !== String\(liveSid\)\) return null/.test(renderer),
  'quotes never land in another session\'s composer');
const menu = readSource('renderer', 'card-selection-context-menu.js');
assert.ok(menu.includes("action === 'quote'"));
const html = readSource('renderer', 'index.html');
assert.ok(html.includes('data-action="quote" hidden>引用到输入框'));

// 6. 群聊用同一套：引用块进群聊输入框，来源带轮次
assert.strictEqual(quote.quoteSourceLabel({ who: 'Codex', round: 3, partial: true }), 'Codex · 第3轮 · 回答片段');
assert.ok(quote.quoteChipLabel({ who: 'Codex', round: 3 }, '片段').includes('第3轮'));
const room = readSource('renderer', 'meeting-room.js');
const addQuoteChip = room.slice(room.indexOf('function _addQuoteChip'), room.indexOf('function _clearQuoteChips'));
assert.ok(addQuoteChip.includes('card-quote.js') && addQuoteChip.includes('.insertQuoteIntoComposer(input'),
  'group quotes go into the composer as quote chips');
assert.ok(room.includes("_gcQuoteFloatBtn.textContent = '❝ 引用'"), 'group float button matches single-session wording');

console.log('unit-card-quote: ok');
