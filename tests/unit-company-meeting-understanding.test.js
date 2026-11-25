'use strict';
// 「会议理解」tab 顶部理解线健康提示、会议 AI 来源、录像补索引、会后纪要失败（契约 7 / 7.1 · 2026-11-24）。
const assert = require('node:assert/strict');
const { stageLine, understandingAlert, engineLine, repairText, reviewStage } = require('../renderer/company-meeting-understanding');
const { meetingAsrState } = require('../renderer/company-meeting-asr-state');

// 老后端：没有这些字段 → 不显示、沿用原写法
assert.equal(stageLine({}), ''); assert.equal(understandingAlert({}), null); assert.equal(engineLine({}), ''); assert.equal(repairText(null), '');
assert.equal(reviewStage({}, false), null);

// 状态行：进行中的阶段写进状态行；需要用户处理的进醒目提示
assert.equal(stageLine({ understandingStage: { stage: 'idle', text: '' } }), '');
assert.equal(stageLine({ understandingStage: { stage: 'running', text: 'Claude Code 正在整理（12 秒）' } }), 'Claude Code 正在整理（12 秒）');
assert.equal(stageLine({ understandingStage: { stage: 'waiting-cli-ready', text: '终端还没就绪，后台每 15 秒重发 · 已等 30 秒' } }), '终端还没就绪，后台每 15 秒重发 · 已等 30 秒');
assert.equal(stageLine({ understandingStage: { stage: 'error', text: '理解出错' } }), '', 'errors go to the alert, not the status line');

let a = understandingAlert({ understandingStage: { stage: 'error', text: '会议 AI 启动失败：spawn ENOENT', ops: ['understand'] },
  understandingRetry: { count: 1, max: 3, nextInMs: 30000, lastError: { kind: 'start', label: '启动失败' } } });
assert.equal(a.text, '会议 AI 启动失败：spawn ENOENT');
assert.deepEqual(a.ops.map(o => o.op), ['understand', 'pick-engine']);
assert.equal(a.sub, '已自动重试 1/3 次（启动失败），30 秒后再试');
a = understandingAlert({ understandingStage: { stage: 'error', text: 'x', ops: [] }, understandingRetry: { count: 3, max: 3, stopped: '已自动重试 3 次仍失败', lastError: { label: '网关报错' } } });
assert.match(a.sub, /已自动重试 3 次仍失败（网关报错）/);
a = understandingAlert({ understandingStage: { stage: 'error', text: 'x', ops: [] }, understandingRetry: { count: 1, retrying: true } });
assert.match(a.sub, /正在自动重试第 2 次/);
a = understandingAlert({ understandingStage: { stage: 'waiting-receipt', text: '会话空闲 20 秒，还没收到本轮回执', ops: ['understand'] } });
assert.deepEqual(a.ops.map(o => o.label), ['放弃这轮，重新整理']);
a = understandingAlert({ understandingStage: { stage: 'blocked-by-asr', text: '有 2 段转写失败，最终复核没触发', ops: ['retry-asr', 'skip-failed-asr'] } });
assert.deepEqual(a.ops.map(o => o.op), ['retry-asr', 'skip-failed-asr']);
a = understandingAlert({ understandingStage: { stage: 'blocked-by-asr', text: 't', ops: ['retry-asr', 'skip-failed-asr'] } }, { live: true });
assert.deepEqual(a.ops.map(o => o.op), ['retry-asr'], 'no skip button while recording');

// 旧会话关不掉、删除中：只有灰字说明时用 info 色
a = understandingAlert({ understandingStage: { stage: 'running', text: 'r' }, pendingClose: { count: 1, attempts: 2 } });
assert.equal(a.tone, 'info'); assert.match(a.text, /后台第 2 次重试中/); assert.deepEqual(a.ops, []);
a = understandingAlert({ pendingClose: { count: 1, attempts: 6, gaveUp: true } });
assert.match(a.text, /停手/); assert.deepEqual(a.ops.map(o => o.op), ['close-old-sessions']);
a = understandingAlert({ pendingClose: { count: 2, attempts: 1, rotationPaused: true, limit: 2, text: '旧理解会话关不掉（2 个），暂停换新会话，继续用当前会话' } });
assert.equal(a.text, '旧理解会话关不掉（2 个），暂停换新会话，继续用当前会话'); assert.deepEqual(a.ops.map(o => o.op), ['close-old-sessions']);
a = understandingAlert({ understandingStage: { stage: 'error', text: '换引擎要等它们关掉', ops: ['close-old-sessions', 'understand'] }, pendingClose: { rotationPaused: true, text: 't' } });
assert.deepEqual(a.ops.map(o => o.op), ['close-old-sessions', 'understand', 'pick-engine'], 'no duplicate 再关一次');
assert.match(understandingAlert({ lifecycle: { removing: true } }).text, /正在删除这场会议/);
a = understandingAlert({ engineError: '所选的会议 AI 已不可用（终端没装或模型已下线），请在「更多」里重新选择' });
assert.equal(a.tone, 'warn'); assert.deepEqual(a.ops.map(o => o.op), ['pick-engine']);

// 会议 AI 来源
assert.equal(engineLine({ engineCurrent: 'Claude Code · GLM 5', engineSource: 'global' }), '会议 AI：Claude Code · GLM 5（来自设置默认）');
assert.equal(engineLine({ engineCurrent: 'CodeAgent · DeepSeek Flash', engineSource: 'auto', engineNote: '设置里选的会议 AI 当前不可用，本次沿用默认。' }), '会议 AI：CodeAgent · DeepSeek Flash（来自自动推荐） · 设置里选的会议 AI 当前不可用，本次沿用默认。');

// 录像补索引
assert.match(repairText({ repairing: { startedAt: 1, bytesTotal: 2 } }), /正在为录像补索引/);
assert.equal(repairText({ repairPending: '索引还在补，先打开原片；稍后再试可拖动。' }), '索引还在补，先打开原片；稍后再试可拖动。');
assert.match(repairText({ repairFailure: { kind: 'transient', nextAt: 5 } }), /稍后自动再试/);
assert.match(repairText({ repairFailure: { kind: 'permanent', nextAt: null } }), /可直接打开原片/);
assert.equal(repairText({ seekIndexVersion: 1 }), '');

// 会后：纪要失败与整理中分开
assert.equal(reviewStage({ understandingStage: { stage: 'error', text: '网关 502' } }, false).text, '纪要没整理出来');
assert.equal(reviewStage({ understandingStage: { stage: 'error', text: 'x' } }, true), null, 'a finished summary is not shown as failed');
assert.equal(reviewStage({ understandingStage: { stage: 'running', text: 'x' } }, false), null);

// 用户跳过的失败转写段算已处理（skip-failed-asr）
const s = meetingAsrState({ ready: true }, { summary: '纪要', events: [{ kind: 'audio', asr: 'skipped' }, { kind: 'audio', asr: 'done' }] });
assert.equal(s.pending, 0); assert.equal(s.reviewReady, true);
console.log('meeting understanding health: stage line, alert ops, retry/close/lifecycle, engine source, recording repair, review failure, skipped ASR PASS');
