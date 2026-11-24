'use strict';
// DSH 一轮结束的判定与失败人话（2026-11-24 WeLink：DSH 经常弹「上一轮执行失败 · Codex turn failed」）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dshTurnStatus, dshStopStatus, dshFailureText, BLOCKED_TEXT, UNKNOWN_TEXT } = require('../core/dsh-turn-outcome');

function runTurn(reason) {
  const { DshCliSession } = require('../core/dsh-cli-session');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turn-outcome-'));
  try {
    const s = new DshCliSession({ id: 'h1', kind: 'deepseek-acp', home });
    s.seen = new Set();
    const events = [];
    s.on('lifecycle', e => events.push(e));
    s.event({ seq: 1, type: 'turn/start', time: 1, data: { turn: 1 } });
    s.event({ seq: 2, type: 'user/message', time: 2, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } });
    s.event({ seq: 3, type: 'turn/end', time: 3, data: { turn: 1, reason } });
    return { end: events.find(e => /^turn-(complete|error|aborted)$/.test(e.type)), runtime: s.runtime };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('终端模式：写到单步输出上限算完成，不再弹「上一轮执行失败」', () => {
  const { end, runtime } = runTurn({ kind: 'max-tokens' });
  assert.equal(end.type, 'turn-complete');
  assert.equal(runtime.state, 'completed');
  assert.equal(dshTurnStatus('forked'), 'interrupted');
});

test('终端模式真失败：事件带上人话（主进程读 message），不再是写死的 Codex 文案', () => {
  const raw = '400: {"type":"error","error":{"type":"api_error","message":"公司模型上游返回 HTTP 502，已自动重试过"}}';
  const { end, runtime } = runTurn({ kind: 'error', error: { message: raw, code: 'INVALID_REQUEST' } });
  assert.equal(end.type, 'turn-error');
  assert.equal(end.message, '公司模型上游返回 HTTP 502，已自动重试过');
  assert.equal(runtime.reason, end.message);
  assert.equal(end.rawReason, raw);
  // 被插件拦下：原来没有任何原因，现在说清是插件拦的。
  assert.equal(runTurn({ kind: 'blocked' }).end.message, BLOCKED_TEXT);
});

test('失败原文 → 一行人话', () => {
  assert.equal(dshFailureText(''), UNKNOWN_TEXT);
  assert.equal(dshFailureText('公司模型连接中途断开了 [connection interrupted]'), '公司模型连接中途断开了');
  assert.equal(dshFailureText('terminated'), '和模型服务的连接中途断了，可以直接再发一次');
  assert.equal(dshFailureText('Request timed out.'), '模型服务长时间没有回应，可以直接再发一次');
  assert.equal(dshFailureText('401: {"error":{"message":"invalid api key"}}'), 'DSH 调用模型失败（HTTP 401）：invalid api key');
  assert.equal(dshFailureText('401 Unauthorized'), 'DSH 调用模型失败（HTTP 401）：Unauthorized');
  // 闸门照样认得出要用户动手的（401 / 登录）。
  const { classify } = require('../core/notice-gate');
  assert.equal(classify({ message: dshFailureText('401 Unauthorized'), level: 'error' }), 'blocking');
});

test('卡片模式：max_tokens 算完成；拦下、出错都换成人话', () => {
  assert.equal(dshStopStatus('max_tokens'), 'completed');
  assert.equal(dshStopStatus('refusal'), 'failed');
  const { AcpSession } = require('../core/acp-session');
  const { DshCardSession } = require('../core/dsh-card-session');
  const original = AcpSession.prototype.finish;
  const calls = [];
  AcpSession.prototype.finish = function (active, status, error) { calls.push([status, error]); };
  try {
    const finish = DshCardSession.prototype.finish;
    finish.call({}, {}, 'failed', '原生执行停止：max_tokens', { stopReason: 'max_tokens' });
    finish.call({}, {}, 'failed', '原生执行停止：refusal', { stopReason: 'refusal' });
    finish.call({}, {}, 'failed', '502: {"error":{"message":"公司模型的号都被暂停了"}}');
  } finally { AcpSession.prototype.finish = original; }
  assert.deepEqual(calls, [['completed', null], ['failed', BLOCKED_TEXT], ['failed', '公司模型的号都被暂停了']]);
});

test('主进程和界面的兜底文案不再写死 Codex，没有 message 时也读 reason', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.doesNotMatch(main + renderer, /'Codex turn failed'/);
  assert.match(main, /message: ev\.message \|\| ev\.reason/);
});
