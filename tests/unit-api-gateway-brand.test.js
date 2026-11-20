'use strict';
// 网关界面不写平台名（2026-11-21 公开版用词合规，负责人定：成员版、公开版一样，只写「API 网关 / 网关」，
// 同事靠设置页标题旁的预填网关地址认出是哪个网关）。本机代理翻好的报错统一用「API 网关：」开头，报错卡按它认。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../core/api-gateway-errors');
const help = require('../renderer/turn-error-help');

const body = message => JSON.stringify({ error: { message } });
const line = (status, raw, ctx) => `API Error: ${status} ${JSON.stringify({ type: 'error', error: { message: errors.sentence(errors.classify({ status, body: raw, ...ctx })) } })}`;

test('网关报错、报错卡说明和按钮都只写「API 网关 / 网关」（平台名由发版预检把关）', () => {
  assert.equal(errors.GATEWAY_BRAND, undefined, '品牌常量已删');
  const texts = [
    errors.classify({ networkCode: 'unreachable' }).message,
    ...[[401, ''], [500, ''], [418, ''], [403, body('用户额度不足')]].map(([s, b]) => errors.sentence(errors.classify({ status: s, body: b }))),
    help.ACTION_LABELS['gateway-settings'],
    help.classifyError(line(401, '')).detail, help.classifyError(line(403, body('用户额度不足'))).detail,
  ];
  for (const text of texts) assert.match(text, /网关/, text);
  assert.equal(help.ACTION_LABELS['gateway-settings'], '打开网关设置');
  assert.match(errors.classify({ networkCode: 'unreachable' }).message, /^连不上网关：/);
});

test('报错以「API 网关：」开头，报错卡认出 key 无效 / 额度 / 模型用不了', () => {
  assert.equal(errors.ERROR_PREFIX, 'API 网关：', 'renderer/turn-error-help.js 的正则写死了这个前缀');
  assert.ok(errors.sentence(errors.classify({ status: 401 })).startsWith(errors.ERROR_PREFIX));
  assert.equal(help.classifyError(line(401, '')).kind, 'gateway-key');
  assert.equal(help.classifyError(line(403, body('用户额度不足'))).kind, 'gateway-quota');
  assert.equal(help.classifyError(line(503, body('No available channel for model m under group free'), { model: 'm', usable: ['a'] })).kind, 'gateway-model');
});
