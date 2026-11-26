'use strict';
// 自有 API 两个选项的说明（2026-11-27 同事反馈分不清「API 网关」和「自有接口」）：
// 弹窗里两个选项下各有一行说明；「问一下 Hub」说明书（成员版、公开版）写同一句；英文词典有译文。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GATEWAY = '部门统一发的 key，走公司 API 网关，按部门计费，模型由网关提供';
const OWN = '自己填 URL、模型名和 key，任何兼容 OpenAI 或 Anthropic 的接口都可以';

test('弹窗：API 网关、自有接口两个选项按钮里各带一行说明', () => {
  const source = read('renderer/company-api-settings.js');
  assert.ok(source.includes(`gateway: '${GATEWAY}'`), 'API 网关说明');
  assert.ok(source.includes(`own: '${OWN}'`), '自有接口说明');
  const button = mode => source.match(new RegExp(`data-api-mode="${mode}"[^\\n]*?</button>`))?.[0] || '';
  assert.match(button('gateway'), /<small class="company-api-mode-note">\$\{MODE_NOTES\.gateway\}<\/small>/);
  assert.match(button('own'), /<small class="company-api-mode-note">\$\{MODE_NOTES\.own\}<\/small>/);
  assert.doesNotMatch(button('proxy'), /MODE_NOTES/, '公司模型不加');
});

test('说明书两版都写了这两句，答疑能读到', () => {
  for (const file of ['core/help-ask/manual-member.md', 'core/help-ask/manual-public.md']) {
    // 公开版树不带成员版说明书（public-target.json 排除），那里只核公开版这一份。
    if (file.endsWith('manual-member.md') && !fs.existsSync(path.join(__dirname, '..', file))) continue;
    const text = read(file);
    assert.ok(text.includes(`**API 网关**：${GATEWAY}。`), file + ' API 网关');
    assert.ok(text.includes(`**自有接口**：${OWN}`), file + ' 自有接口');
  }
});

test('英文词典有这两句的译文', () => {
  const en = JSON.parse(read('core/i18n/locales/en/launch.json'));
  assert.match(en[GATEWAY] || '', /API gateway/);
  assert.match(en[OWN] || '', /OpenAI- or Anthropic-compatible/);
});
