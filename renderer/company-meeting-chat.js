'use strict';
// 会议页右栏「助手对话」：每题一张聊天卡，写清这题到了哪一步、卡在哪、为什么失败（2026-11-24 用户反馈：问了没回应、看不出卡在哪）。
// 数据按《契约-会议问答每题数据 v1》：持久字段 phase/steps/engine/model/speed/startedAt/firstTokenAt/errorKind/errorHint/history，
// 实时字段 live{phase,partial,chars,firstTokenAt,lastOutputAt,pid,slot,queueAhead}。缺字段（老后端、老数据）时降级成 排队/处理中/完成/失败。
// 这里只放纯函数（不碰 DOM），页面负责挂载与事件。

const SPEEDS = [['fast', '快速'], ['normal', '中等'], ['deep', '深入']];
const SPEED_LABEL = Object.fromEntries(SPEEDS);
const ENGINE_LABEL = { codeagent: 'CodeAgent', 'codeagent-lite': 'CodeAgent-Lite', claude: 'Claude Code', codex: 'Codex', 'api-gateway': '部门 API key（网关）' };
const QUEUED_PHASES = ['queued', 'waiting-context', 'waiting-slot'];
const RUNNING_PHASES = ['starting', 'thinking', 'streaming'];
const IN_FLIGHT = ['queued', 'running'];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (Number.isFinite(v) ? v : null);

// 「4.2 秒」「12.5 秒」「1 分 5 秒」：1 分钟内留一位小数（整数不带 .0），首字快慢一眼能比。
function seconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace(/.0$/, '')} 秒`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
// 「320 字」「1.2 万字」
function chars(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万字` : `${Math.round(n)} 字`;
}
function engineText(q) {
  const engine = ENGINE_LABEL[q?.engine] || q?.engine || '';
  return engine && q?.model ? `${engine}（${q.model}）` : engine || q?.model || '';
}

// 这题此刻处于哪个阶段。state 是最终裁判：done/error 不被过期的 live.phase 盖掉；
// queued/running 取 live.phase → phase，和 state 对不上（老后端、推送领先一步）时按 state 降级。
function questionPhase(q) {
  if (!q) return 'queued';
  const live = q.live?.phase, saved = q.phase;
  if (q.state === 'done') return 'done';
  if (q.state === 'error') return q.errorKind === 'cancelled' || saved === 'cancelled' || live === 'cancelled' ? 'cancelled' : 'error';
  const p = live || saved;
  if (q.state === 'running') return RUNNING_PHASES.includes(p) ? p : 'running';
  if (QUEUED_PHASES.includes(p)) return p;
  if (RUNNING_PHASES.includes(p)) return p; // 推送已到「启动」，轮询还没跟上
  return 'queued';
}
const isInFlight = q => IN_FLIGHT.includes(q?.state);
// 这一次提问的时刻：重答 / 重试时是 retriedAt，否则 queuedAt。「首字」「已等」都从这里算（与后端 history.firstTokenMs 同口径）。
const askedAt = q => num(q?.retriedAt) ?? num(q?.queuedAt);
const PHASE_RANK = { queued: 0, 'waiting-context': 1, 'waiting-slot': 1, running: 2, starting: 2, thinking: 3, streaming: 4, done: 5, error: 5, cancelled: 5 };
// 轮询结果并进当前状态：同一次提问（askedAt 相同）里，新轮询的阶段比已知的（推送带来的）旧，就保留已知的阶段与文字；
// 都在出字时保留更长的 partial。重答（askedAt 变了）以轮询为准。
function mergeQuestionState(prev, next) {
  if (!prev?.answers?.length || !next?.answers) return next;
  const known = new Map(prev.answers.map(q => [q.id, q]));
  next.answers = next.answers.map(q => {
    const old = known.get(q.id);
    if (!old || askedAt(old) !== askedAt(q)) return q;
    const rankOld = PHASE_RANK[questionPhase(old)] ?? 0, rankNew = PHASE_RANK[questionPhase(q)] ?? 0;
    if (rankOld > rankNew) return { ...q, state: old.state, phase: old.phase, answer: old.answer ?? q.answer, firstTokenAt: old.firstTokenAt ?? q.firstTokenAt, at: old.at ?? q.at, errorKind: old.errorKind ?? q.errorKind, _pendingDetail: old._pendingDetail, live: { ...(q.live || {}), ...(old.live || {}) } };
    const a = String(old.live?.partial || ''), b = String(q.live?.partial || '');
    if (isInFlight(q) && a.length > b.length) return { ...q, live: { ...(q.live || {}), partial: a, chars: Math.max(Number(q.live?.chars) || 0, Number(old.live?.chars) || 0, a.length) } };
    return q;
  });
  return next;
}

// 同一场会议里每题前面还有几题（老后端没有 live.queueAhead 时用它）。
// 正在派的那题排最前；重试的旧卡保留原时间，但不插到已派出的题前面。
function questionQueue(meeting) {
  const pending = (meeting?.answers || []).filter(q => isInFlight(q));
  const active = pending.find(q => q.id === meeting?.questionJob?.questionId && meeting.questionJob.state !== 'error')
    || pending.find(q => q.state === 'running');
  const queue = active ? [active, ...pending.filter(q => q !== active)] : pending;
  const ahead = new Map();
  for (const q of pending) if (q.state === 'queued') ahead.set(q.id, queue.indexOf(q));
  return ahead;
}

// 卡片状态行：{ phase, tone, label, verb, since, hint }。since 给每秒计时器用（毫秒时间戳），没有就不显示计时。
function questionStatus(q, { queueAhead = null } = {}) {
  const phase = questionPhase(q), live = q?.live || {}, steps = Array.isArray(q?.steps) && !q?._pendingDetail ? q.steps : [];
  const step = steps.length ? steps[steps.length - 1] : null, stepNo = steps.length;
  const stepText = (fallback, wanted) => (step && (!wanted || step.phase === wanted) && step.text ? `第 ${stepNo} 步 · ${step.text}` : stepNo ? `第 ${stepNo} 步 · ${fallback}` : fallback);
  const ahead = num(live.queueAhead) ?? num(queueAhead);
  const stepAt = phaseName => num([...steps].reverse().find(s => s.phase === phaseName)?.at);
  switch (phase) {
    case 'queued': {
      if (q?.waiting && !q.phase && !live.phase) return { phase, tone: 'wait', label: String(q.waiting), verb: '已等', since: num(q.waitingSince) ?? num(q.queuedAt), hint: '' };
      const label = ahead > 0 ? `已送达 · 前面还有 ${ahead} 题` : ahead === 0 ? '已送达 · 下一个就是它' : '已送达 · 排队中';
      return { phase, tone: 'wait', label, verb: '已等', since: askedAt(q), hint: '' };
    }
    case 'waiting-context':
      return { phase, tone: 'wait', label: q?.waiting || '等会议理解会话就绪', verb: '已等', since: num(q?.waitingSince) ?? stepAt(phase) ?? num(q?.queuedAt), hint: '最长 3 分钟' };
    case 'waiting-slot': {
      const slot = live.slot;
      const busy = slot && Number.isFinite(slot.running) && Number.isFinite(slot.max) ? ` · 全机 ${slot.running}/${slot.max} 在用` : '';
      return { phase, tone: 'wait', label: `等回答进程位${busy}`, verb: '已等', since: num(q?.waitingSince) ?? stepAt(phase) ?? num(q?.queuedAt), hint: '前面的问答答完就轮到' };
    }
    case 'starting': {
      const who = engineText(q);
      return { phase, tone: 'run', label: stepText(who ? `正在启动 ${who}` : '正在启动回答进程', 'starting'), verb: '已', since: num(q?.startedAt) ?? stepAt(phase) ?? num(q?.dispatchedAt), hint: '' };
    }
    case 'thinking': {
      const base = step?.phase === 'thinking' && step.text ? step.text : '等第一个字';
      return { phase, tone: 'run', label: `${stepNo ? `第 ${stepNo} 步 · ` : ''}${base}`, verb: /等.{0,2}第一个字/.test(base) ? '已' : '等第一个字 · 已', since: num(q?.startedAt) ?? stepAt(phase) ?? num(q?.dispatchedAt), hint: '' };
    }
    case 'streaming': {
      const n = num(live.chars) ?? (live.partial ? String(live.partial).length : null);
      return { phase, tone: 'run', label: `正在回答${n ? ` · 已出 ${chars(n)}` : ''}`, verb: '已用', since: num(live.firstTokenAt) ?? num(q?.firstTokenAt) ?? num(q?.startedAt), hint: '' };
    }
    case 'running':
      return { phase, tone: 'run', label: '正在查阅会议内容', verb: '已用', since: num(q?.dispatchedAt) ?? num(q?.queuedAt), hint: '' };
    case 'done': {
      const asked = askedAt(q) ?? num(q?.startedAt);
      const first = num(q?.firstTokenAt) != null && asked != null ? seconds(q.firstTokenAt - asked) : '';
      const total = num(q?.durationMs) != null ? seconds(q.durationMs) : asked != null && num(q?.at) != null ? seconds(q.at - asked) : '';
      const speed = SPEED_LABEL[q?.speed] ? `${SPEED_LABEL[q.speed]}档` : '';
      const parts = [first && `首字 ${first}`, total && `全部 ${total}`, speed].filter(Boolean);
      return { phase, tone: 'done', label: (q?.phase || q?.speed || q?.firstTokenAt) ? ['完成', ...parts].join(' · ') : ['已回答', total && `用时 ${total}`].filter(Boolean).join(' · '), verb: '', since: null, hint: '' };
    }
    case 'cancelled':
      return { phase, tone: 'error', label: '已取消', verb: '', since: null, hint: '' };
    default: {
      const reason = cleanError(q?.error);
      return { phase: 'error', tone: 'error', label: `没答上：${reason}`, verb: '', since: null, hint: q?.errorHint || '' };
    }
  }
}
function cleanError(error) {
  const text = String(error || '暂时没有收到回答').replace(/cli-not-ready/g, 'CodeAgent 还没启动好，稍后点重试').trim();
  return text + (/[。！？.!?]$/.test(text) ? '' : '。');
}

// 失败卡上的按钮，按契约第 4 节的类别给；老数据没有 errorKind 时给「重试 + 看后台」。
const ERROR_ACTIONS = {
  'engine-not-ready': ['engine', 'backstage', 'retry'],
  'context-not-ready': ['fast', 'backstage', 'retry'],
  'service-not-ready': ['retry'],
  'spawn-failed': ['engine', 'backstage'],
  'idle-timeout': ['retry', 'speed', 'backstage'],
  'total-timeout': ['retry', 'speed', 'backstage'],
  'exit-nonzero': ['retry', 'backstage'],
  'empty-answer': ['retry', 'speed'],
  'too-long': ['fast'],
  interrupted: ['retry'],
  cancelled: ['retry'],
  unknown: ['retry', 'backstage'],
};
function errorActions(q) {
  return ERROR_ACTIONS[q?.errorKind] || ['retry', 'backstage'];
}
// 「用 X 重答」可选的档位：除去本题当前档。
function reanswerSpeeds(q) {
  const current = SPEED_LABEL[q?.speed] ? q.speed : null;
  return SPEEDS.map(([v]) => v).filter(v => v !== current && (current || v !== 'fast'));
}

// 「助手对话」tab 角标：完成或失败、而用户还没在该 tab 里看到过的题数。首次载入一场会议时已有的都算看过。
function createChatBadge() {
  let meetingId, seen = new Set();
  const key = q => `${q.id}|${q.state}|${q.at ?? ''}|${(q.history || []).length}`;
  return {
    sync(meeting, chatActive) {
      const answers = (meeting?.answers || []).filter(q => ['done', 'error'].includes(q.state));
      if (meeting?.id !== meetingId) { meetingId = meeting?.id; seen = new Set(answers.map(key)); return 0; }
      if (chatActive) { for (const q of answers) seen.add(key(q)); return 0; }
      return answers.filter(q => !seen.has(key(q))).length;
    },
  };
}

// 会议 AI 起不来 / 问答线异常：「助手对话」顶部一条醒目提示。没有就返回 null。
function laneAlert(status, meeting) {
  if (!meeting) return null;
  const who = String(meeting.engineLabel || 'CodeAgent').split(' · ')[0];
  const lane = status?.questionLaneError || meeting.questionLaneError;
  if (status?.engineError) return { kind: 'engine', text: `${cleanError(status.engineError)}问答也要等它，可以在「更多」里换个会议 AI。` };
  if (meeting.agent?.state === 'error') return { kind: 'engine', text: `会议 AI（${who}）没起来：${cleanError(meeting.agent.error || meeting.error || '启动异常')}问答和纪要都要等它，可以换个引擎，或打开后台看原因。` };
  if (lane?.text) return { kind: 'lane', text: `问答这条线出了异常：${cleanError(lane.text)}可以换个引擎，或打开后台看原因。` };
  // 新后端：单题失败/取消只在那张卡上；顶部红条只认整条问答线异常（questionLaneError）。老后端没有这个字段才看 questionError。
  if (meeting.questionError && !(status && 'questionLaneError' in status)) return { kind: 'lane', text: `问答出了异常：${cleanError(meeting.questionError)}` };
  return null;
}

// 卡片的「版本」：除流式文字外影响显示的字段。流式文字单独就地更新，不整卡重画。
function cardVersion(q, ctx = {}) {
  const live = q.live || {};
  const ans = String(q.answer || ''), digest = ans.length + ':' + ans.slice(0, 32) + ':' + ans.slice(-32);
  return JSON.stringify([q.q, q.state, questionPhase(q), digest, q._pendingDetail ? 1 : 0, q.error, q.errorKind, q.errorHint, q.truncated, q.speed, q.engine, q.model, q.startedAt, q.firstTokenAt, q.durationMs, q.at, q.queuedAt, q.retriedAt, q.waiting, q.waitingSince, (q.steps || []).length, (q.steps || []).at?.(-1)?.text, (q.history || []).length,
    live.queueAhead, live.slot?.running, live.slot?.max, live.firstTokenAt, ctx.queueAhead, ctx.engines, ctx.backstageOpen]);
}

// 一张卡的 HTML。markdown(text) 由页面注入（已消毒）。在途卡的流式文字放 .meeting-chat-partial（纯文本，出字时就地改）。
function chatCardHtml(q, { markdown = s => esc(s), queueAhead = null, engines = [], clock = '' } = {}) {
  const st = questionStatus(q, { queueAhead }), id = esc(q.id), live = q.live || {};
  const timer = st.since != null ? ` · ${esc(st.verb || '已等')} <span data-wait-since="${st.since}"></span>` : '';
  const dots = st.tone === 'run' ? '<span class="meeting-question-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : '';
  const hint = st.hint ? `<small class="meeting-chat-hint">${esc(st.hint)}</small>` : '';
  const status = `<div class="meeting-chat-status" data-tone="${st.tone}" role="status">${dots}<span class="meeting-chat-label">${esc(st.label)}</span>${timer}${hint}</div>`;
  const refs = [...new Set(String(q.answer || '').match(/\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/g) || [])];
  const answer = String(q.answer || '').replace(/\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/g, '').trim();
  const clipped = q.truncated ? '<p class="meeting-question-error">回答过长，仅保留部分内容。</p>' : '';
  const sources = refs.length ? `<span class="meeting-question-sources">依据 ${refs.map(esc).join(' ')}</span>` : '';
  const partial = isInFlight(q) && live.partial ? String(live.partial) : '';
  let body = '';
  if (st.phase === 'done') body = `<div class="meeting-answer-body">${markdown(answer)}</div>${clipped}`;
  else if (st.phase === 'error' && q._pendingDetail) body = '<p class="meeting-chat-hint">没答上，正在获取原因…</p>';
  else if (st.phase === 'error' || st.phase === 'cancelled') body = `${st.phase === 'error' ? `<p class="meeting-question-error">${esc(st.label)}纪要不受影响。</p>${st.hint ? `<p class="meeting-chat-next">下一步：${esc(st.hint)}</p>` : ''}` : ''}${answer ? '<p class="meeting-chat-hint">已收到的部分回答：</p><div class="meeting-answer-body">' + markdown(answer) + '</div>' + clipped : ''}`;
  else body = `<div class="meeting-chat-partial"${partial ? '' : ' hidden'}>${esc(partial)}</div>`;
  const btn = (attr, label, primary) => `<button type="button" class="meeting-question-button${primary ? ' primary' : ''}" ${attr}>${label}</button>`;
  const speedButtons = reanswerSpeeds(q).map(v => btn(`data-reanswer="${id}" data-speed-to="${v}"`, `用${SPEED_LABEL[v]}重答`)).join('');
  const engineMenu = engines.length ? `<details class="meeting-engine-menu"><summary class="meeting-question-button">换引擎重答</summary><div class="meeting-engine-list">${engines.map(e => btn(`data-reanswer="${id}" data-engine-to="${esc(e.id)}"`, esc(e.label || e.id))).join('')}</div></details>` : '';
  const backstage = btn(`data-backstage="${id}"`, '看后台');
  let tools = '';
  if (st.phase === 'done') tools = btn(`data-copy-answer="${id}"`, '复制') + btn(`data-followup-question="${id}"`, '追问') + speedButtons + backstage;
  else if (st.phase === 'error' && q._pendingDetail) tools = backstage;
  else if (st.phase === 'error' || st.phase === 'cancelled') {
    const acts = st.phase === 'cancelled' ? ['retry'] : errorActions(q);
    tools = acts.map((a, i) => a === 'retry' ? btn(`data-retry-question="${id}"`, '重试', i === 0)
      : a === 'fast' ? btn(`data-reanswer="${id}" data-speed-to="fast"`, '用快速档重答', i === 0)
        : a === 'speed' ? speedButtons
          : a === 'engine' ? (engineMenu || '')
            : a === 'backstage' ? backstage : '').join('');
  } else tools = btn(`data-cancel-question="${id}"`, '取消') + backstage;
  const actions = `<div class="meeting-question-actions">${st.phase === 'done' || answer ? sources : ''}<span class="meeting-question-tools">${tools}</span></div>`;
  const history = (q.history || []).length ? `<details class="meeting-chat-history"><summary>之前的回答 ${q.history.length} 版</summary>${[...q.history].reverse().map(h => `<div class="meeting-chat-old"><small>${esc([SPEED_LABEL[h.speed] ? SPEED_LABEL[h.speed] + '档' : '', engineText(h), h.durationMs ? '全部 ' + seconds(h.durationMs) : '', h.firstTokenMs ? '首字 ' + seconds(h.firstTokenMs) : ''].filter(Boolean).join(' · '))}</small>${h.answer ? `<div class="meeting-answer-body">${markdown(String(h.answer).replace(/\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/g, '').trim())}</div>` : `<p class="meeting-question-error">${esc(cleanError(h.error))}</p>`}</div>`).join('')}</details>` : '';
  return `<article class="meeting-chat-card" data-answer="${id}" data-question-state="${esc(q.state || 'queued')}" data-phase="${st.phase}">`
    + `<div class="meeting-chat-q"><p>${esc(q.q)}</p>${clock ? `<time>${esc(clock)}</time>` : ''}</div>`
    + `<div class="meeting-chat-a">${status}${body}${actions}${history}</div></article>`;
}

// 推送事件并进这一题：只动 live 和阶段，不改答案正文（正文以轮询为准）。返回是否有变化。
function applyQuestionPush(meeting, payload) {
  const q = (meeting?.answers || []).find(x => x.id === payload?.questionId);
  if (!q || meeting.id !== payload.meetingId) return null;
  if (['done', 'error'].includes(q.state) && Number.isFinite(q.at) && Number.isFinite(payload.at) && payload.at < q.at) return null; // 过期推送
  const live = { ...(q.live || {}) };
  for (const k of ['phase', 'partial', 'chars', 'firstTokenAt', 'lastOutputAt']) if (payload[k] !== undefined) live[k] = payload[k];
  q.live = live;
  if (RUNNING_PHASES.includes(payload.phase) && q.state === 'queued') q.state = 'running';
  if (payload.phase === 'done' && isInFlight(q)) { q.state = 'done'; if (payload.partial) q.answer = payload.partial; if (Number.isFinite(payload.firstTokenAt)) q.firstTokenAt = payload.firstTokenAt; q.at = payload.at ?? q.at; }
  if ((payload.phase === 'error' || payload.phase === 'cancelled') && isInFlight(q)) { q.state = 'error'; if (payload.phase === 'cancelled') q.errorKind = 'cancelled'; q.at = payload.at ?? q.at; }
  if (payload.phase && payload.phase !== 'streaming' && payload.phase !== q.phase) {
    q._pendingDetail = true; // 步骤、引擎、错误原因不在推送里：等页面补拉的那次轮询
    if (['starting', 'thinking'].includes(payload.phase) && !Number.isFinite(q.startedAt) && Number.isFinite(payload.at)) q.startedAt = payload.at;
  }
  if (payload.phase) q.phase = payload.phase;
  return q;
}

module.exports = { SPEEDS, SPEED_LABEL, questionPhase, questionStatus, questionQueue, mergeQuestionState, askedAt, errorActions, reanswerSpeeds, createChatBadge, laneAlert, cardVersion, chatCardHtml, applyQuestionPush, isInFlight, seconds, chars, engineText };
