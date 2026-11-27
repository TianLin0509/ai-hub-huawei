// 2026-11-27 Claude 入口回报缓存命中：上游 chat 用量的 cached_tokens 拆成 Anthropic 的 cache_read_input_tokens，
// 两者相加仍等于上游 prompt_tokens（上下文总量不变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertChatJson, convertChatResponse } from '../core/company-proxy/messages-converter.mjs';

const sse = frames => new Response(frames.map(f => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });

test('非流式：有缓存命中时拆成 input + cache_read，合计不变；没有命中时不加字段', () => {
  const hit = convertChatJson({ id: 'c', model: 'm', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11710, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 11648 } } });
  assert.deepEqual(hit.usage, { input_tokens: 62, cache_read_input_tokens: 11648, output_tokens: 3 });
  const miss = convertChatJson({ id: 'c', model: 'm', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  assert.deepEqual(miss.usage, { input_tokens: 10, output_tokens: 1 });
});

test('流式：message_delta 的用量带上缓存命中', async () => {
  const res = await convertChatResponse(sse([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] },
    { id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'c', model: 'm', choices: [], usage: { prompt_tokens: 500, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9999 } } }, '[DONE]']));
  const text = await res.text();
  const delta = text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(e => e.type === 'message_delta');
  assert.deepEqual(delta.usage, { input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 2 }, '命中数超过总量时按总量截');
});

// 2026-11-27 思考档位照传：Claude Code 的 output_config.effort、DSH 的 reasoning_effort 原样给上游（low/medium），更高的按 high。
import { createClaudeAdapter, createDshAdapter, upstreamEffort } from '../core/company-proxy/adapters.mjs';

test('档位映射：low/medium 照传，high/xhigh/max/缺省都按 high', () => {
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max', '', undefined, 'LOW'].map(upstreamEffort), ['low', 'medium', 'high', 'high', 'high', 'high', 'high', 'low']);
});

test('Claude 入口：开思考时按 output_config.effort 给上游；不开思考不带档位', () => {
  const a = createClaudeAdapter({ defaultModel: 'm', resolve: x => x });
  const msg = [{ role: 'user', content: 'hi' }];
  assert.equal(a.convertRequest({ model: 'm', messages: msg, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }).reasoning_effort, 'low');
  assert.equal(a.convertRequest({ model: 'm', messages: msg, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }).reasoning_effort, 'high');
  assert.equal(a.convertRequest({ model: 'm', messages: msg, thinking: { type: 'enabled', budget_tokens: 2000 } }).reasoning_effort, 'high');
  assert.equal('reasoning_effort' in a.convertRequest({ model: 'm', messages: msg }), false);
});

test('DSH 入口：reasoning_effort low/medium 照传', () => {
  const d = createDshAdapter({ defaultModel: 'm', resolve: x => x });
  assert.equal(d.convertRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' }).reasoning_effort, 'medium');
  assert.equal(d.convertRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled' } }).reasoning_effort, 'high');
});
