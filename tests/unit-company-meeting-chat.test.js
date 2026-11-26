'use strict';
// 会议页右栏「助手对话」卡片的纯函数：阶段降级、状态文案、失败按钮、角标、推送合并（契约 v1 · 2026-11-24）。
const assert = require('node:assert/strict');
const chat = require('../renderer/company-meeting-chat');
const { questionPhase, questionStatus, questionQueue, errorActions, reanswerSpeeds, createChatBadge, laneAlert, chatCardHtml, applyQuestionPush, cardVersion, seconds, chars } = chat;

// ---- 阶段：state 是最终裁判，live/phase 只细分 ----
assert.equal(questionPhase({ state: 'queued' }), 'queued', 'legacy queued');
assert.equal(questionPhase({ state: 'running' }), 'running', 'legacy running degrades to generic running');
assert.equal(questionPhase({ state: 'done' }), 'done');
assert.equal(questionPhase({ state: 'error' }), 'error');
assert.equal(questionPhase({ state: 'error', errorKind: 'cancelled' }), 'cancelled');
assert.equal(questionPhase({ state: 'queued', phase: 'waiting-slot' }), 'waiting-slot');
assert.equal(questionPhase({ state: 'queued', phase: 'queued', live: { phase: 'waiting-context' } }), 'waiting-context', 'live wins over persisted');
assert.equal(questionPhase({ state: 'running', phase: 'thinking', live: { phase: 'streaming' } }), 'streaming');
assert.equal(questionPhase({ state: 'running', phase: 'queued' }), 'running', 'mismatched phase falls back to state');
assert.equal(questionPhase({ state: 'done', live: { phase: 'streaming' } }), 'done', 'stale live never overrides a finished answer');
assert.equal(questionPhase({ state: 'queued', live: { phase: 'starting' } }), 'starting', 'push one step ahead of poll');
assert.equal(questionPhase(null), 'queued');

// ---- 状态文案（契约第 3 节示例） ----
const t0 = 1_700_000_000_000;
let s = questionStatus({ state: 'queued', queuedAt: t0, live: { queueAhead: 2 } });
assert.deepEqual([s.tone, s.label, s.since], ['wait', '已送达 · 前面还有 2 题', t0]);
assert.equal(questionStatus({ state: 'queued', queuedAt: t0 }, { queueAhead: 0 }).label, '已送达 · 下一个就是它');
assert.equal(questionStatus({ state: 'queued', queuedAt: t0 }).label, '已送达 · 排队中');
s = questionStatus({ state: 'queued', waiting: '等会议理解会话就绪', waitingSince: t0 + 5 });
assert.deepEqual([s.label, s.since], ['等会议理解会话就绪', t0 + 5], 'legacy waiting text kept');
s = questionStatus({ state: 'queued', phase: 'waiting-context', waitingSince: t0 });
assert.match(s.label, /等会议理解会话就绪/); assert.match(s.hint, /3 分钟/);
s = questionStatus({ state: 'queued', phase: 'waiting-slot', queuedAt: t0, live: { slot: { running: 3, max: 3 } } });
assert.equal(s.label, '等回答进程位 · 全机 3/3 在用', 'says what it waits for, not "0 questions ahead"');
const steps = [{ at: t0, phase: 'queued', text: '已送达' }, { at: t0 + 10, phase: 'queued', text: '派出' }, { at: t0 + 20, phase: 'starting', text: '正在启动 Claude Code（glm-4.6）' }];
s = questionStatus({ state: 'running', phase: 'starting', engine: 'claude', model: 'glm-4.6', startedAt: t0 + 20, steps });
assert.equal(s.label, '第 3 步 · 正在启动 Claude Code（glm-4.6）'); assert.equal(s.since, t0 + 20);
s = questionStatus({ state: 'running', phase: 'starting', engine: 'claude', model: 'glm-4.6', startedAt: t0 });
assert.equal(s.label, '正在启动 Claude Code（glm-4.6）', 'no steps → no step number');
s = questionStatus({ state: 'running', phase: 'thinking', startedAt: t0, steps: [...steps, { at: t0 + 30, phase: 'thinking', text: '材料已送入 1.2 万字' }] });
assert.equal(s.label, '第 4 步 · 材料已送入 1.2 万字'); assert.equal(s.verb, '等第一个字 · 已');
s = questionStatus({ state: 'running', phase: 'thinking', startedAt: t0 });
assert.equal(s.label, '等第一个字');
s = questionStatus({ state: 'running', phase: 'streaming', startedAt: t0, live: { partial: 'x'.repeat(320), chars: 320, firstTokenAt: t0 + 4000 } });
assert.deepEqual([s.label, s.since], ['正在回答 · 已出 320 字', t0 + 4000]);
assert.equal(questionStatus({ state: 'running', dispatchedAt: t0 }).label, '正在查阅会议内容');
s = questionStatus({ state: 'done', phase: 'done', speed: 'fast', queuedAt: t0, firstTokenAt: t0 + 4200, durationMs: 12500 });
assert.equal(s.label, '完成 · 首字 4.2 秒 · 全部 12.5 秒 · 快速档');
assert.equal(questionStatus({ state: 'done', queuedAt: t0, at: t0 + 31000 }).label, '已回答 · 用时 31 秒', 'legacy done');
s = questionStatus({ state: 'error', error: 'cli-not-ready', errorHint: '换个引擎再试' });
assert.equal(s.label, '没答上：CodeAgent 还没启动好，稍后点重试。'); assert.equal(s.hint, '换个引擎再试');
assert.equal(questionStatus({ state: 'error', errorKind: 'cancelled' }).label, '已取消');
assert.equal(seconds(4200), '4.2 秒'); assert.equal(seconds(65000), '1 分 5 秒'); assert.equal(chars(12000), '1.2 万字');

// ---- 排队名次（老后端） ----
const qm = { answers: [{ id: 'a', state: 'running' }, { id: 'b', state: 'queued' }, { id: 'c', state: 'queued' }, { id: 'd', state: 'done' }], questionJob: { questionId: 'a', state: 'running' } };
assert.deepEqual([...questionQueue(qm)], [['b', 1], ['c', 2]]);

// ---- 失败按钮（契约第 4 节） ----
assert.deepEqual(errorActions({ errorKind: 'engine-not-ready' }), ['engine', 'backstage', 'retry']);
assert.deepEqual(errorActions({ errorKind: 'context-not-ready' }), ['fast', 'backstage', 'retry']);
assert.deepEqual(errorActions({ errorKind: 'too-long' }), ['fast']);
assert.deepEqual(errorActions({}), ['retry', 'backstage'], 'legacy error');
assert.deepEqual(reanswerSpeeds({ speed: 'fast' }), ['normal', 'deep']);
assert.deepEqual(reanswerSpeeds({ speed: 'deep' }), ['fast', 'normal']);
assert.deepEqual(reanswerSpeeds({}), ['normal', 'deep'], 'legacy answers default to the fast tier upgrade path');

// ---- 卡片 HTML ----
const engines = [{ id: 'claude:glm', label: 'Claude Code · glm' }];
let html = chatCardHtml({ id: 'q1', q: '谁负责<补测>？', state: 'queued', queuedAt: t0 }, { queueAhead: 1 });
assert.match(html, /data-phase="queued"/); assert.match(html, /谁负责&lt;补测&gt;？/); assert.match(html, /data-wait-since="1700000000000"/);
assert.match(html, /data-cancel-question="q1"/); assert.match(html, /data-backstage="q1"/);
html = chatCardHtml({ id: 'q2', q: 'x', state: 'running', phase: 'streaming', live: { partial: '王工<b>', chars: 4, firstTokenAt: t0 } });
assert.match(html, /class="meeting-chat-partial">王工&lt;b&gt;</); assert.match(html, /meeting-question-dots/);
html = chatCardHtml({ id: 'q3', q: 'x', state: 'done', phase: 'done', speed: 'fast', answer: '答案 [事件 5]', history: [{ speed: 'fast', answer: '旧答案', durationMs: 9000 }] }, { engines });
assert.match(html, /data-copy-answer="q3"/); assert.match(html, /data-speed-to="normal"/); assert.match(html, /data-speed-to="deep"/);
assert.doesNotMatch(html, /data-speed-to="fast"/, 'no "redo at the same tier" button');
assert.match(html, /之前的回答 1 版/); assert.match(html, /依据 \[事件 5\]/);
html = chatCardHtml({ id: 'q4', q: 'x', state: 'error', errorKind: 'engine-not-ready', error: '会议 AI 没起来' }, { engines });
assert.match(html, /data-engine-to="claude:glm"/); assert.match(html, /data-retry-question="q4"/); assert.match(html, /纪要不受影响/);
html = chatCardHtml({ id: 'q5', q: 'x', state: 'error', errorKind: 'cancelled' });
assert.match(html, /data-phase="cancelled"/); assert.match(html, /data-retry-question="q5"/); assert.doesNotMatch(html, /纪要不受影响/);
assert.notEqual(cardVersion({ id: 'a', state: 'running', live: { partial: 'a' } }), cardVersion({ id: 'a', state: 'running', live: { phase: 'streaming', partial: 'a' } }));
assert.equal(cardVersion({ id: 'a', state: 'running', phase: 'streaming', live: { partial: 'a' } }), cardVersion({ id: 'a', state: 'running', phase: 'streaming', live: { partial: 'ab' } }), 'streamed text does not force a full card redraw');

// ---- 角标 ----
const badge = createChatBadge();
const m = { id: 'm1', answers: [{ id: 'old', state: 'done', at: 1 }] };
assert.equal(badge.sync(m, false), 0, 'existing answers on first load are not new');
m.answers.push({ id: 'n1', state: 'running' }); assert.equal(badge.sync(m, false), 0);
m.answers[1].state = 'done'; m.answers[1].at = 2; assert.equal(badge.sync(m, false), 1);
m.answers.push({ id: 'n2', state: 'error', at: 3 }); assert.equal(badge.sync(m, false), 2);
assert.equal(badge.sync(m, true), 0, 'viewing the chat tab clears the badge');
assert.equal(badge.sync(m, false), 0);
m.answers[1].history = [{}]; m.answers[1].at = 4; assert.equal(badge.sync(m, false), 1, 'a re-answer completing badges again');
assert.equal(badge.sync({ id: 'm2', answers: [{ id: 'x', state: 'done' }] }, false), 0, 'switching meetings resets');

// ---- 顶部醒目提示 ----
assert.equal(laneAlert({}, null), null);
assert.equal(laneAlert({}, { agent: { state: 'ready' } }), null);
let alert = laneAlert({}, { engineLabel: 'CodeAgent · glm', agent: { state: 'error', error: 'spawn ENOENT' } });
assert.equal(alert.kind, 'engine'); assert.match(alert.text, /CodeAgent/); assert.match(alert.text, /spawn ENOENT/);
alert = laneAlert({ questionLaneError: { at: 1, text: 'tick 失败' } }, { agent: { state: 'ready' } });
assert.equal(alert.kind, 'lane'); assert.match(alert.text, /tick 失败/);

// ---- 推送合并 ----
const pm = { id: 'm1', answers: [{ id: 'p', state: 'queued', queuedAt: t0 }] };
assert.equal(applyQuestionPush(pm, { meetingId: 'other', questionId: 'p', phase: 'starting' }), null, 'other meeting ignored');
let q = applyQuestionPush(pm, { meetingId: 'm1', questionId: 'p', phase: 'starting', at: t0 + 1 });
assert.equal(q.state, 'running'); assert.equal(questionPhase(q), 'starting');
q = applyQuestionPush(pm, { meetingId: 'm1', questionId: 'p', phase: 'streaming', partial: '王工', chars: 2, firstTokenAt: t0 + 900, at: t0 + 900 });
assert.equal(q.live.partial, '王工'); assert.equal(questionStatus(q).label, '正在回答 · 已出 2 字');
q = applyQuestionPush(pm, { meetingId: 'm1', questionId: 'p', phase: 'done', partial: '王工负责', firstTokenAt: t0 + 900, at: t0 + 3000 });
assert.equal(q.state, 'done'); assert.equal(q.answer, '王工负责');
assert.equal(applyQuestionPush(pm, { meetingId: 'm1', questionId: 'p', phase: 'streaming', at: t0 + 2000 }), null, 'stale push after done ignored');
console.log('meeting chat cards: phase fallback, status text, error buttons, badge, lane alert, push merge PASS');

// ---- 看后台抽屉（老后端兜底） ----
const { backstageHtml, fallbackLog, logText, isMissingHandler } = require('../renderer/company-meeting-backstage');
assert.equal(isMissingHandler(new Error("No handler registered for 'company-assistant:meeting-question-log'")), true);
assert.equal(isMissingHandler(new Error('读取超时')), false);
const oldQ = { id: 'o1', q: '谁负责？', state: 'error', error: 'CodeAgent 启动异常', queuedAt: t0, dispatchedAt: t0 + 1000, at: t0 + 5000 };
const fb = fallbackLog(oldQ, { sessionId: 'und-1', agent: { state: 'error', error: 'spawn ENOENT' }, engineLabel: 'CodeAgent · glm' });
assert.equal(fb.fallback, true); assert.equal(fb.understanding.sessionId, 'und-1');
assert.deepEqual(fb.lines.map(l => l.kind), ['step', 'step', 'stderr']);
html = backstageHtml(oldQ, fb, { engines });
assert.match(html, /详细记录.*需新版后端/); assert.match(html, /CodeAgent 启动异常/); assert.match(html, /data-hub-backstage="und-1" data-hub-backstage-from="meeting"/); assert.match(html, /data-engine-to="claude:glm"/);
const newLog = { ok: true, meta: { engine: 'claude', model: 'glm-4.6', mode: 'fresh', speed: 'fast', contextChars: 12000, pid: 77, slot: { running: 1, max: 3 }, command: 'claude --print' }, lines: [{ at: t0, kind: 'event', text: 'system init' }, { at: t0 + 1, kind: 'stderr', text: 'warn' }], understanding: {} };
const live = { id: 'l1', q: '门限？', state: 'running', phase: 'thinking', speed: 'fast', queuedAt: t0, startedAt: t0 };
html = backstageHtml(live, newLog, { engines });
assert.doesNotMatch(html, /需新版后端/); assert.match(html, /进程号<\/dt><dd>77/); assert.match(html, /1\.2 万字/); assert.match(html, /data-cancel-question="l1"/); assert.match(html, /每秒刷新/);
assert.doesNotMatch(html, /data-engine-to/, 'no re-answer while still in flight');
const text = logText(live, newLog);
assert.match(text, /问题：门限？/); assert.match(text, /引擎：Claude Code（glm-4.6）/); assert.match(text, /\[错误输出\] warn/);
console.log('meeting backstage drawer: old-backend fallback, live meta, copy text PASS');

// ---- 推送先到、旧轮询后到：卡片不回退（审查必改 2） ----
{
  const { mergeQuestionState, askedAt } = chat;
  const prev = { id: 'm1', answers: [{ id: 'a', state: 'running', phase: 'thinking', queuedAt: t0 }] };
  applyQuestionPush(prev, { meetingId: 'm1', questionId: 'a', phase: 'streaming', partial: 'x'.repeat(300), chars: 300, firstTokenAt: t0 + 900, at: t0 + 2000 });
  const stale = { id: 'm1', answers: [{ id: 'a', state: 'running', phase: 'streaming', queuedAt: t0, live: { phase: 'streaming', partial: 'x'.repeat(120), chars: 120 } }] };
  let merged = mergeQuestionState(prev, stale);
  assert.equal(merged.answers[0].live.partial.length, 300, 'older poll does not shorten the streamed text');
  assert.equal(questionStatus(merged.answers[0]).label, '正在回答 · 已出 300 字');
  const thinkingPoll = { id: 'm1', answers: [{ id: 'a', state: 'running', phase: 'thinking', queuedAt: t0 }] };
  assert.equal(questionPhase(mergeQuestionState(prev, thinkingPoll).answers[0]), 'streaming', 'older poll does not move the phase back');
  applyQuestionPush(prev, { meetingId: 'm1', questionId: 'a', phase: 'done', partial: '最终答案', at: t0 + 5000 });
  merged = mergeQuestionState(prev, { id: 'm1', answers: [{ id: 'a', state: 'running', phase: 'streaming', queuedAt: t0, live: { partial: 'x' } }] });
  assert.equal(merged.answers[0].state, 'done', 'done does not flash back to running');
  assert.equal(merged.answers[0].answer, '最终答案');
  const fresh = { id: 'm1', answers: [{ id: 'a', state: 'done', phase: 'done', queuedAt: t0, answer: '服务器版答案', durationMs: 4000 }] };
  assert.equal(mergeQuestionState(prev, fresh).answers[0].answer, '服务器版答案', 'a finished poll wins');
  const re = { id: 'm1', answers: [{ id: 'a', state: 'queued', phase: 'queued', queuedAt: t0, retriedAt: t0 + 9000 }] };
  assert.equal(mergeQuestionState(prev, re).answers[0].state, 'queued', 're-answer (new attempt) follows the poll');
  // 首字口径：从这一次提问（重答时为 retriedAt）算
  assert.equal(askedAt({ queuedAt: 1, retriedAt: 5 }), 5);
  assert.match(questionStatus({ state: 'done', phase: 'done', queuedAt: t0, retriedAt: t0 + 60000, firstTokenAt: t0 + 63000, durationMs: 8000, speed: 'normal' }).label, /首字 3 秒/);
}

// ---- XSS：题目、流式文字、错误、stderr、命令行、引擎名里的标签全部转义 ----
{
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const noTags = (html, label) => { assert.doesNotMatch(html, /<script|<img/i, label + ": raw tag"); assert.doesNotMatch(html.replace(/="[^"]*"/g, '=""'), /<[a-z][^>]*\son\w+=/i, label + ": attribute breakout"); };
  noTags(chatCardHtml({ id: 'x"><b', q: evil, state: 'running', phase: 'streaming', engine: evil, model: evil, live: { partial: evil } }), 'streaming card');
  noTags(chatCardHtml({ id: 'e', q: 'q', state: 'error', error: evil, errorHint: evil, answer: evil, history: [{ answer: evil, error: evil, engine: evil }] }), 'error card (markdown stub escapes)');
  noTags(chatCardHtml({ id: 'd', q: 'q', state: 'done', answer: evil }, { engines: [{ id: evil, label: evil }] }), 'done card with engine menu');
  const evilLog = { ok: true, meta: { engine: evil, model: evil, command: 'claude --print ' + evil, cwd: evil, mode: evil }, lines: [{ at: t0, kind: 'stderr', text: evil }, { at: t0, kind: evil, text: evil }], understanding: { sessionId: '"><img src=x onerror=alert(3)>', engineLabel: evil, error: evil } };
  noTags(backstageHtml({ id: 'z', q: evil, state: 'error', error: evil }, evilLog, { engines: [{ id: evil, label: evil }], error: evil }), 'backstage drawer');
  // 回答正文只经过注入的 markdown()（页面里是 marked + DOMPurify 消毒），卡片自身不拼未转义的正文
  let seen = []; chatCardHtml({ id: 'm', q: 'q', state: 'done', answer: '正文' }, { markdown: s => { seen.push(s); return '[md]'; } });
  assert.deepEqual(seen, ['正文']);
}
console.log('meeting chat: poll/push merge, first-token from this attempt, XSS escaping PASS');

// ---- m4 实测 6 项必改的纯函数部分 ----
{
  // #4 失败卡显示 errorHint（「你下一步可以做什么」）
  const h = chatCardHtml({ id: 'h', q: 'q', state: 'error', errorKind: 'idle-timeout', error: '太久没有输出', errorHint: '换中等档再问一次' });
  assert.match(h, /class="meeting-chat-next">下一步：换中等档再问一次</);
  // #4 新后端（status 带 questionLaneError 键，即使为 null）单题失败不挂顶部红条；老后端照旧
  assert.equal(laneAlert({ questionLaneError: null }, { questionError: '已取消，可以继续问下一题' }), null);
  assert.equal(laneAlert({}, { questionError: '旧后端问答异常' }).kind, 'lane');
  // #5 阶段推送（不带详情）：不显示过时步数、计时从推送时刻起；失败推送先说「正在获取原因」，不给错按钮
  const pm2 = { id: 'm1', answers: [{ id: 's', state: 'queued', phase: 'queued', queuedAt: t0, steps: [{ at: t0, phase: 'queued', text: '已送达' }] }] };
  let q = applyQuestionPush(pm2, { meetingId: 'm1', questionId: 's', phase: 'starting', at: t0 + 500 });
  const st = questionStatus(q);
  assert.equal(st.label, '正在启动回答进程', 'no stale step number before the detail poll');
  assert.equal(st.since, t0 + 500);
  q = applyQuestionPush(pm2, { meetingId: 'm1', questionId: 's', phase: 'error', at: t0 + 900 });
  const eh = chatCardHtml(q);
  assert.match(eh, /正在获取原因/); assert.doesNotMatch(eh, /data-retry-question/); assert.match(eh, /data-backstage="s"/);
  // 补拉的轮询到了：详情齐全，标记消失
  const merged = chat.mergeQuestionState(pm2, { id: 'm1', answers: [{ id: 's', state: 'error', phase: 'error', errorKind: 'exit-nonzero', error: '退出码 2', queuedAt: t0 }] });
  assert.equal(merged.answers[0]._pendingDetail, undefined); assert.match(chatCardHtml(merged.answers[0]), /data-retry-question="s"/);
  // 非阻塞：后端 thinking 文案「模型已就绪，等待第一个字。」不再重复「等第一个字」
  assert.equal(questionStatus({ state: 'running', phase: 'thinking', startedAt: t0, steps: [{ at: t0, phase: 'thinking', text: '模型已就绪，等待第一个字。' }] }).verb, '已');
  // #3 抽屉里的「提问到首字」从本次重答算
  const bh = backstageHtml({ id: 'r', q: 'q', state: 'done', queuedAt: t0, retriedAt: t0 + 120000, firstTokenAt: t0 + 121670 }, { ok: true, meta: {}, lines: [], understanding: {} });
  assert.match(bh, /提问到首字<\/dt><dd>1\.7 秒/);
  // #1 长命令整行、单行省略、点开看全
  const longCmd = 'C:/Users/x/AppData/Roaming/npm/claude.cmd --print --settings D:/tmp/' + 'a'.repeat(200) + '.json';
  const lh = backstageHtml({ id: 'l', q: 'q', state: 'running', phase: 'thinking', queuedAt: t0 }, { ok: true, meta: { command: longCmd, cwd: 'D:/meetings/' + 'b'.repeat(80) }, lines: [], understanding: {} });
  assert.match(lh, /meeting-backstage-wide"><dt>命令<\/dt><dd><details class="meeting-backstage-long"/);
  assert.match(lh, /meeting-backstage-wide"><dt>工作目录/);
  // #6 打开理解会话失败的说明写进抽屉
  assert.match(backstageHtml({ id: 'n', q: 'q', state: 'done' }, { ok: true, meta: {}, lines: [], understanding: {} }, { sessionNote: '理解会话已休眠或已关闭' }), /meeting-backstage-note">理解会话已休眠或已关闭/);
}
console.log('meeting chat: m4 fixes (error hint, single-question errors stay on the card, push without detail, thinking text, re-answer first token, long command, session note) PASS');
