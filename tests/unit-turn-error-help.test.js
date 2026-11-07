'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyError } = require('../renderer/turn-error-help');

const kind = text => classifyError(text)?.kind || null;

test('公司 CodeAgent 真实样本归到正确的类', () => {
  assert.equal(kind('API Error token消耗过快， 已达到4亿上限'), 'quota');
  assert.equal(kind('API Error: 模型 "deepseek-v4-flash-0731" 不存在或配置有误，请检查模型配置'), 'model');
  assert.equal(kind('Error: 模型 "codeagent-mainmodel-4-5-20250929" 不存在或配置有误，请检查模型配置'), 'model');
});

test('常见英文报错归类', () => {
  assert.equal(kind('API Error: 401 {"error":{"type":"authentication_error","message":"OAuth token has expired. Please run /login"}}'), 'auth');
  assert.equal(kind('API Error: 429 {"error":{"type":"rate_limit_error","message":"Your credit balance is too low."}}'), 'quota');
  assert.equal(kind('API Error: 429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}'), 'rate');
  assert.equal(kind('API Error: 500 {"error":{"type":"api_error","message":"upstream connect error"}}'), 'service');
  assert.equal(kind('API Error: 400 {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), 'context');
  assert.equal(kind('API Error: 418 teapot'), 'other');
});

test('普通回答不算报错：只有以报错开头的段落才处理', () => {
  assert.equal(kind('这是因为 API Error: 429 表示限流'), null);
  assert.equal(kind('API Error: 401 表示登录过期，重新登录即可。'), null);
  assert.equal(kind('API Error: 429 ' + '解释'.repeat(500)), null);
  assert.equal(kind('Error handling 这段代码要改'), null);
  assert.equal(kind('模型不存在的时候怎么办？'), null);
  assert.equal(kind(''), null);
  assert.equal(kind(null), null);
});

test('每一类都给出标题、说明和至少一个能点的动作', () => {
  for (const sample of ['API Error: 401', 'API Error: 模型 "x" 不存在', 'API Error 额度', 'API Error prompt is too long', 'API Error 429', 'API Error 503', 'API Error ?']) {
    const info = classifyError(sample);
    assert.ok(info.title && info.detail && info.actions.length >= 1, sample);
  }
});
