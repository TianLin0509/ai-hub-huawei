'use strict';
// R61：公司模型线路打开了 Codex 的断流重试（core/company-model-proxy.js CODEX_STREAM_RETRIES）。Codex 重试时重发同一次模型请求，
// 失败那次出到一半的正文没有 item/completed，重试从头再出一遍。卡片上不能同一段话显示两次，最终回答里也不能混进半截。全部为合成事件。
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexNativeSession } = require('../core/codex-native-session');

function turn() {
  const s = new CodexNativeSession({});
  s.threadId = 't1';
  Object.assign(s.runtime, { threadId: 't1', connection: 'connected', state: 'idle' });
  s.notification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1', status: 'inProgress', items: [] } } });
  const n = (method, params) => s.notification({ method, params: { threadId: 't1', turnId: 'u1', ...params } });
  const say = (id, text, phase) => {
    n('item/started', { item: { id, type: 'agentMessage', text: '' } });
    n('item/agentMessage/delta', { itemId: id, delta: text });
    if (phase) n('item/completed', { item: { id, type: 'agentMessage', text, phase } });
  };
  return { s, n, say };
}

test('断流重试：失败那次的半截回答从卡片去掉，重试出的完整回答只显示一次；之前已完成的过渡话和工具保留', () => {
  const { s, n, say } = turn();
  say('m0', '我先看看配置文件。', 'commentary');
  n('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'type config.json', status: 'inProgress' } });
  n('item/completed', { item: { id: 'c1', type: 'commandExecution', command: 'type config.json', status: 'completed' } });
  say('m1', '结论是');
  n('item/started', { item: { id: 'r1', type: 'reasoning', summary: [] } });
  n('error', { willRetry: true, error: { message: 'stream disconnected before completion' } });
  say('m2', '结论是 SRS 周期配 20 ms。', 'final_answer');
  assert.deepEqual([...s.items.keys()], ['m0', 'c1', 'm2']);
  assert.equal(s.finalText(), '结论是 SRS 周期配 20 ms。');
  assert.equal(s.runtime.state, 'running', '重试提示不是终态');
});

test('不再重试的报错（willRetry 为假）不动已显示的内容', () => {
  const { s, n, say } = turn();
  say('m1', '写到一半');
  n('error', { willRetry: false, error: { message: 'stream disconnected before completion' } });
  assert.equal(s.items.get('m1').text, '写到一半');
});
