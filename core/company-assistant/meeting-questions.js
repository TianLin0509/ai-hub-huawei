'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { errorInfo } = require('../../main/ask-aside/answer-stream');
const { QuestionRuntime } = require('../../main/ask-aside/question-runtime');
const SPEEDS = new Set(['fast', 'normal', 'deep']);
const FIELDS = ['phase', 'steps', 'engine', 'model', 'mode', 'speed', 'startedAt', 'firstTokenAt', 'errorKind', 'errorHint'];
function phase(companion, m, q, value, text, meta = {}) {
  const changed = q.phase !== value || !q.steps?.length;
  Object.assign(q, meta, { phase: value });
  if (value !== 'waiting-context') { delete q.waiting; delete q.waitingSince; }
  q.state = ['queued', 'waiting-context', 'waiting-slot'].includes(value) ? 'queued' : ['starting', 'thinking', 'streaming'].includes(value) ? 'running' : value === 'done' ? 'done' : 'error';
  if (changed) q.steps = [...(q.steps || []), { at: companion.now(), phase: value, text }].slice(-12);
  if (changed && ['cancelled', 'error'].includes(value) && !(m.questionJob?.questionId === q.id && m.questionJob?.requestId)
    && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(q.id || '')) {
    try {
      const log = new QuestionRuntime({ meetingId: m.id, questionId: q.id, engine: q.engine || '', model: q.model || '', mode: q.mode || 'fresh', speed: q.speed || m.questionSpeed || 'fast', now: () => companion.now() });
      Object.assign(log.meta, { cwd: companion.dir(m.id), command: '', contextChars: 0, pid: null, startedAt: q.startedAt || null, firstTokenAt: q.firstTokenAt || null, endedAt: companion.now(), errorKind: q.errorKind || '', errorHint: q.errorHint || '' });
      for (const step of q.steps) { log.log('step', step.text); log.lines.at(-1).at = step.at; }
      log.save(companion.dir(m.id), { sessionId: m.sessionId, state: m.agent?.state || '', error: m.error || '', engineLabel: m.engineLabel || '' });
    } catch (error) { m.questionLaneError = { at: companion.now(), text: '后台记录暂未存好：' + error.message }; }
  }
  if (changed) companion.deps.getMeetingAskAside?.()?.notifyMeetingQuestion?.({ meetingId: m.id, questionId: q.id, phase: value,
    partial: q.answer || '', chars: (q.answer || '').length, firstTokenAt: q.firstTokenAt || null, lastOutputAt: null, at: companion.now() });
  return changed;
}
function speed(value) { if (!SPEEDS.has(value)) throw Error('问答速度无效'); return value; }
function validateEngine(companion, m, value) {
  if (!value) return '';
  let selected; try { selected = companion.engineFor?.(m); } catch { /* Explicit replacement can recover an unavailable old engine. */ }
  if (!['codeagent', 'codeagent-lite', 'claude', 'codex', 'api-gateway'].includes(String(value).split('|')[0])) throw Error('这个问答引擎不可用');
  const list = require('./meeting-engine').engines(companion.terminals());
  const [kind, model] = String(value).split('|'), mapped = require('../../main/ask-aside/fresh-target').harness(kind);
  if (!list.some(e => e.harness === mapped) && require('../../main/ask-aside/fresh-target').harness(selected?.harness) !== mapped) throw Error('这个问答引擎不在可用清单中');
  if (model && !list.some(e => e.id === value) && value !== `${selected?.harness}|${selected?.model || ''}`) throw Error('这个问答引擎不在可用清单中');
  return value;
}
function reset(companion, m, q, options = {}, archive = true) {
  const queuedAt = Number.isFinite(q.queuedAt) ? q.queuedAt : Number.isFinite(q.at) ? q.at : companion.now();
  const chosenSpeed = speed(options.speed || q.speed || m.questionSpeed || 'fast');
  const chosenEngine = options.engine || (q.engine ? `${q.engine.split('|')[0]}|${q.model || q.engine.split('|')[1] || ''}` : '');
  const [requestedHarness, requestedModel] = String(chosenEngine).split('|');
  const chosenHarness = require('../../main/ask-aside/fresh-target').harness(requestedHarness);
  if (options.engine) validateEngine(companion, m, options.engine);
  if (archive) q.history = [...(q.history || []), { speed: q.speed || m.questionSpeed || 'fast', engine: q.engine || '', model: q.model || '', mode: q.mode || 'fork',
    answer: q.answer || '', error: q.error || '', errorKind: q.errorKind || '', durationMs: q.durationMs || 0,
    firstTokenMs: q.firstTokenAt ? Math.max(0, q.firstTokenAt - (q.retriedAt || q.queuedAt || q.dispatchedAt || q.firstTokenAt)) : null, at: q.at || companion.now() }].slice(-5);
  for (const key of ['answer', 'error', 'errorKind', 'errorHint', 'startedAt', 'firstTokenAt', 'dispatchedAt', 'durationMs', 'at', 'truncated', 'waiting', 'waitingSince', 'steps', 'phase', 'model', 'engine']) delete q[key];
  Object.assign(q, { speed: chosenSpeed, ...(chosenHarness ? { engine: chosenHarness, model: requestedModel || '' } : {}), mode: options.engine || chosenSpeed === 'fast' ? 'fresh' : 'fork', queuedAt, retriedAt: companion.now() });
  phase(companion, m, q, 'queued', '问题已送达，等待派发。');
  if (m.questionJob?.state === 'error') m.questionJob = null; m.questionError = ''; delete m.questionLaneError;
}
function control(companion, m, op, value) {
    if (op === 'question-speed') { m.questionSpeed = speed(value); return true; }
    if (op === 'ask') {
      const request = value && typeof value === 'object' ? value : { q: value }, text = String(request.q || '').trim();
      if (!text || text.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('请输入不超过一万字的问题');
      const q = { id: randomUUID(), q: text }; reset(companion, m, q, request, false); delete q.retriedAt; m.answers.push(q); return true;
    }
    if (op === 'reanswer' || op === 'retry-question') {
      const request = op === 'reanswer' ? value || {} : { id: value };
      const q = m.answers.find(q => q.id === request.id); if (!q) throw Error('没有找到这道问题');
      if (!['done', 'error'].includes(q.state)) throw Error('这题还在答，先取消或等它答完');
      reset(companion, m, q, request); return true;
    }
    if (op === 'cancel-question') {
      const q = m.answers.find(q => q.id === value); if (!q || !['queued', 'running'].includes(q.state)) throw Error('这题已经结束');
      const job = m.questionJob, service = companion.deps.getMeetingAskAside?.();
      if (job?.questionId === q.id && job.requestId) {
        if (!service?.cancelMeeting?.({ sessionId: job.sourceSessionId, meetingId: m.id, id: job.requestId })) throw Error('这题已结束，请刷新状态');
        return 'service'; // Its callback owns cancellation state; never save this stale meeting snapshot.
      }
      phase(companion, m, q, 'cancelled', '已取消。', { error: '已取消', ...errorInfo({ cancelled: true }), at: companion.now() });
      if (job?.questionId === q.id) m.questionJob = null;
      return true;
    }
    return false;
}
function apply(companion, id, token, questionId, snapshot) {
  const m = companion.load(id), pending = companion.questionDispatches?.get(id);
  if (!m.questionJob && pending?.token === token) m.questionJob = { ...pending };
  if (m.questionJob?.token !== token) return;
  const q = m.answers.find(q => q.id === questionId); if (!q) return;
  if (['done', 'error', 'cancelled'].includes(snapshot.phase) && m.questionJob?.requestId) { companion.collectAside(m); return; }
  q.dispatchedAt ||= m.questionJob.sentAt;
  const changed = q.phase !== snapshot.phase || JSON.stringify(q.steps || []) !== JSON.stringify(snapshot.steps || []);
  for (const field of FIELDS) if (snapshot[field] !== undefined) q[field] = snapshot[field];
  if (q.phase !== 'waiting-context') { delete q.waiting; delete q.waitingSince; }
  if (['queued', 'waiting-context', 'waiting-slot'].includes(q.phase)) { q.state = 'queued'; m.questionJob.state = 'queued'; }
  else if (['starting', 'thinking', 'streaming'].includes(q.phase)) { q.state = 'running'; m.questionJob.state = 'running'; }
  // Terminal answer/error belongs to collectAside, after service has committed the result.
  if (changed) companion.save(m);
}
function view(companion, m) {
  if (!m) return m;
  const pending = m.answers.filter(q => ['queued', 'running'].includes(q.state)), service = companion.deps.getMeetingAskAside?.();
  const active = pending.find(q => q.id === m.questionJob?.questionId && m.questionJob.state !== 'error') || pending.find(q => q.state === 'running');
  const queue = active ? [active, ...pending.filter(q => q !== active)] : pending;
  return { ...m, questionSpeed: m.questionSpeed || 'fast', answers: m.answers.map(q => {
    const live = service?.meetingLive?.({ meetingId: m.id, questionId: q.id });
    const queued = ['queued', 'running'].includes(q.state);
    return { ...q, ...(live || queued ? { live: { phase: q.phase || q.state, partial: q.answer || '', chars: (q.answer || '').length, firstTokenAt: q.firstTokenAt || null,
      lastOutputAt: null, pid: null, slot: service?.slotStatus?.() || { running: 0, max: 3 }, ...live, queueAhead: Math.max(0, queue.findIndex(p => p.id === q.id)) } } : {}) };
  }) };
}
function log(companion, { meetingId, questionId }) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(questionId || '')) throw Error('问题编号无效');
  const m = companion.load(meetingId); if (!m.answers.some(q => q.id === questionId)) throw Error('没有找到这道问题');
  const understanding = { sessionId: m.sessionId, state: m.agent?.state || '', error: m.error || '', engineLabel: m.engineLabel || '', lastActivityAt: m.updatedAt || m.agent?.at || null };
  const live = companion.deps.getMeetingAskAside?.()?.meetingQuestionLog?.({ meetingId, questionId });
  if (live) return { ...live, understanding };
  try { return { ...JSON.parse(fs.readFileSync(path.join(companion.dir(meetingId), 'question-logs', questionId + '.json'), 'utf8')), understanding }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { ok: true, meta: {}, lines: (m.answers.find(q => q.id === questionId).steps || []).map(s => ({ at: s.at, kind: 'step', text: s.text })), understanding }; }
}
module.exports = { control, phase, apply, view, log, FIELDS };
