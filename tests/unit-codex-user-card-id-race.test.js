'use strict';
// 2026-11-07：Codex 0.164 先落 response_item(role=user)，约 0.6 秒后才落 item_completed(UserMessage)。
// 卡片刷新恰好落在这两条之间时，旧解析给用户卡的 id 取自 response_item，之后换成 item_completed 的 id，
// 增量挂卡认不出是同一张，同一句话就显示两遍（真实隔离 Hub 长会话复现；本机 40 份真实记录里 98 条消息有 39 条处在这种窗口）。
const test = require('node:test');
const assert = require('node:assert');
const { parseCodexRolloutText } = require('../core/codex-transcript-parser');

const rec = o => JSON.stringify(o);
const responseUser = (ts, id, text) => rec({ timestamp: ts, type: 'response_item', payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] } });
const eventUser = (ts, id, text) => rec({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'turn-' + id, item: { type: 'UserMessage', id, content: [{ type: 'text', text }] } } });
const started = ts => rec({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 'x' } });
const answer = (ts, text) => rec({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } });

const users = text => parseCodexRolloutText(text).filter(t => t.role === 'user');

test('user card id is the same before and after the item_completed mirror lands', () => {
  const lines = [
    started('2026-11-08T03:22:24.000Z'),
    responseUser('2026-11-08T03:22:24.524Z', 'msg_a', '只回复 K4'),
    eventUser('2026-11-08T03:22:25.133Z', 'item_a', '只回复 K4'),
    answer('2026-11-08T03:22:27.000Z', 'K4'),
  ];
  const early = users(lines.slice(0, 2).join('\n'));
  const full = users(lines.join('\n'));
  assert.strictEqual(early.length, 1);
  assert.strictEqual(full.length, 1);
  assert.strictEqual(full[0].id, early[0].id, 'live card keeps its id');
  assert.strictEqual(full[0].sourceIndex, early[0].sourceIndex);
});

test('a repeated prompt in a later turn keeps its own card', () => {
  const lines = [
    responseUser('2026-11-08T03:22:24.524Z', 'msg_a', '继续'),
    eventUser('2026-11-08T03:22:25.133Z', 'item_a', '继续'),
    answer('2026-11-08T03:22:27.000Z', 'ok'),
    responseUser('2026-11-08T03:23:24.524Z', 'msg_b', '继续'),
    eventUser('2026-11-08T03:23:25.133Z', 'item_b', '继续'),
    answer('2026-11-08T03:23:27.000Z', 'ok'),
  ];
  const ids = users(lines.join('\n')).map(t => t.id);
  assert.strictEqual(ids.length, 2);
  assert.notStrictEqual(ids[0], ids[1]);
  assert.strictEqual(users(lines.slice(0, 4).join('\n'))[1].id, ids[1]);
});

test('an event without a preceding response_item keeps its own record id', () => {
  const only = users(eventUser('2026-11-08T03:22:25.133Z', 'item_a', '你好'));
  assert.strictEqual(only.length, 1);
  assert.match(only[0].id, /item_a/);
});
