'use strict';
// Codex 终端会话「思考中途断掉」（rsi-q）：rollout 把断流、限额等记在 task_complete.error，以前卡片只显示半截回答，
// 看着像正常答完，也没有「重试这一条」。现在报错接在正文末尾、回合标成执行失败，卡片据此给出处理按钮。全部为合成数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexRolloutText } = require('../core/codex-transcript-parser');
const { classifyError } = require('../renderer/turn-error-help');
const { displayChatTurns } = require('../renderer/simple-chat-display');
const { displayTurns } = require('../core/conversation-display');

const L = o => JSON.stringify(o);
const t = s => new Date(Date.UTC(2026, 10, 21, 1, 0, s)).toISOString();
function rollout(error) {
  return [
    L({ timestamp: t(0), type: 'session_meta', payload: { id: 's1', cwd: 'D:/x' } }),
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'user_message', message: '帮我看看', turn_id: 't1' } }),
    L({ timestamp: t(2), type: 'event_msg', payload: { type: 'agent_message', message: '我先读一下代码', phase: 'commentary', turn_id: 't1' } }),
    L({ timestamp: t(9), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error, duration_ms: 8000 } }),
  ].join('\n');
}
const assistant = text => parseCodexRolloutText(text).find(turn => turn.role === 'assistant');

test('task_complete.error：报错接在半截回答后面，回合标成执行失败（不再像答完）', () => {
  const turn = assistant(rollout({ message: 'stream disconnected before completion: error sending request', codex_error_info: 'response_stream_disconnected' }));
  assert.equal(turn.nativeOutcome, 'failed');
  assert.equal(turn.stopReason, 'task_error');
  assert.equal(turn.source, 'codex_rollout', '已结束的一轮，不是还在输出');
  const paragraphs = turn.text.split('\n\n');
  assert.equal(paragraphs[0], '我先读一下代码');
  assert.equal(paragraphs.at(-1), 'API Error（这一轮没有完成）: stream disconnected before completion: error sending request');
});

test('卡片最后一段能被认成报错并给「重试这一条」；公司反代以句号结尾的中文报错也认', () => {
  const last = text => assistant(rollout({ message: text })).text.split('\n\n').at(-1);
  const disconnect = classifyError(last('stream disconnected before completion: error sending request'));
  assert.ok(disconnect, '断流要给处理按钮');
  assert.ok(disconnect.actions.includes('retry'));
  const proxy = classifyError(last('公司模型的回复中途超时断开（超过了反代的等待时间），这一轮没有完成，请重试。'));
  assert.ok(proxy, '以句号结尾也要认');
  assert.ok(proxy.actions.includes('retry'));
  assert.equal(classifyError(last('You’ve hit your usage limit. Visit the usage page to purchase more credits.')).kind, 'quota');
  // 回答正文里拿「API Error」来解释、以句号结尾的普通句子仍不当报错。
  assert.equal(classifyError('API Error 一般是上游服务出错，可以稍后再试。'), null);
});

test('正常完成、Esc 中断的回合不受影响', () => {
  const ok = [
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'user_message', message: 'hi', turn_id: 't1' } }),
    L({ timestamp: t(2), type: 'event_msg', payload: { type: 'agent_message', message: 'hello', phase: 'final_answer', turn_id: 't1' } }),
    L({ timestamp: t(3), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'hello' } }),
  ].join('\n');
  const done = assistant(ok);
  assert.equal(done.nativeOutcome, 'completed');
  assert.equal(done.text, 'hello');
  const aborted = assistant([
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    L({ timestamp: t(1), type: 'event_msg', payload: { type: 'user_message', message: 'hi', turn_id: 't1' } }),
    L({ timestamp: t(2), type: 'event_msg', payload: { type: 'agent_message', message: 'partial', phase: 'commentary', turn_id: 't1' } }),
    L({ timestamp: t(3), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } }),
  ].join('\n'));
  assert.equal(aborted.nativeOutcome, 'interrupted');
  assert.ok(!aborted.text.includes('API Error'));
});

test('断流后拆卡仍显示独立报错、失败状态与重试入口，重解析时消息 ID 稳定', () => {
  const raw = rollout({ message: 'stream disconnected before completion' });
  const turn = assistant(raw);
  const cards = displayTurns([turn]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].text, '我先读一下代码');
  const error = cards.at(-1);
  assert.equal(error.deliveryContext.nativeOutcome, 'failed');
  assert.equal(error.text, 'API Error（这一轮没有完成）: stream disconnected before completion');
  assert.ok(classifyError(error.text).actions.includes('retry'));
  assert.equal(error.id, displayTurns([assistant(raw)]).at(-1).id);
  const chat = displayChatTurns([turn]);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].text, error.text);
  assert.equal(chat[0].deliveryContext.nativeOutcome, 'failed');
  assert.equal(chat[0].chatProcessMessages[0].text, '我先读一下代码');
});
