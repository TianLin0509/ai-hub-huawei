'use strict';
// 在跑一览（2026-11-20）：用户问「在跑什么 / 进展如何」时，程序生成一份只读快照，不经过模型。
// 侧栏「在跑一览」按钮和公司助理的 running_overview 工具用同一份数据。
// 分组（每个会话只进一组，按先后顺序判定）：
//   在等你回复：会话停在确认/选择或答完等你，或进展卡里有还没回复的「等你拍板」；
//   卡住嫌疑：运行异常、进展卡自报「卡住」、在跑但很久没输出，或命中下面两条矛盾提示；
//   运行中：这一刻在跑；
//   刚完成：没在跑，最近 3 小时内有输出；
//   其余：只计数（空闲更久、休眠、群聊成员和各类内部会话）。
// 矛盾提示规则故意只有两条，照带不解释：
//   ⚠A 进展卡写着在跑（状态「顺利」或「有风险」），但会话超过 1 小时没有任何输出；
//   ⚠B 会话正在跑，但进展卡超过 3 小时没更新。
// 文字版全文 ≤4 KB，超出时从优先级低的组开始折叠成「另有 N 个」。
// 状态只取 session-manager 已有字段和进展卡服务已有快照，不新增任何采集。

const CAP = 4 * 1024;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SILENT_WARN_MS = HOUR;          // ⚠A
const CARD_STALE_WARN_MS = 3 * HOUR;  // ⚠B
const BUSY_SILENT_MS = 30 * MIN;      // 在跑但这么久没输出，算卡住嫌疑
const RECENT_DONE_MS = 3 * HOUR;      // 刚完成的窗口
const CARD_FRESH_MS = DAY;
const WAIT_KEEP_MS = DAY;             // 等你回复超过一天、会话也没动静的，归到「其余」，不占行            // ⚠A 只看一天内还更新过的卡，旧卡不翻旧账
const GROUPS = [
  ['waiting', '在等你回复'],
  ['suspect', '卡住嫌疑'],
  ['running', '运行中'],
  ['done', '刚完成'],
];
const RUNNING_CARD = new Set(['顺利', '有风险']);

const bytes = s => Buffer.byteLength(String(s), 'utf8');
const one = (s, n) => { const t = String(s || '').replace(/[\r\n|｜]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
function ago(at, now) {
  if (!at) return '没有输出记录';
  const ms = Math.max(0, now - at);
  if (ms < MIN) return '刚刚';
  if (ms < HOUR) return Math.round(ms / MIN) + ' 分钟前';
  if (ms < DAY) return (Math.round(ms / HOUR * 10) / 10) + ' 小时前';
  return Math.round(ms / DAY) + ' 天前';
}
const span = (at, now) => ago(at, now).replace(/前$/, '');
// 输出时间：session-manager 在会话条目上实时记的输出时间（调用方经 facts.outputAt 传入）优先，再看信息里的输出/完成时间。
// 不用 lastMessageTime：新建会话时它就被设成当前时间，不代表有输出（Codex 审查 P1）。
function lastOutputAt(s, f = {}) {
  return Math.max(0, Number(f.outputAt) || 0, ...['lastOutputAt', 'lastCompletedAt'].map(k => Number(s && s[k]) || 0));
}
function teamTag(id, teams) {
  for (const t of teams || []) {
    if (t.leadSid === id) return { role: 'lead', text: '负责人' };
    const m = (t.members || []).find(x => x.sid === id && x.status !== 'dismissed');
    if (m) return { role: 'member', text: '成员 ' + (m.memberId || m.role || ''), leadSid: t.leadSid };
  }
  return null;
}
function pendingDecision(card) {
  return !!(card && card.plain && card.plain.decision && !card.decisionAnsweredAt);
}
function cardLine(card) {
  if (!card) return '';
  return (card.plain && card.plain.line) || (card.ghost && card.ghost.line) || card.cardTitle || '';
}
function warningsOf({ busy, card, outAt, now }) {
  const out = [];
  if (card && card.plain && RUNNING_CARD.has(card.plain.status) && card.mtimeMs && now - card.mtimeMs < CARD_FRESH_MS && now - (outAt || 0) > SILENT_WARN_MS)
    out.push(`卡写在跑，但 ${outAt ? span(outAt, now) : '一直'}没输出`);
  if (busy && card && card.mtimeMs && now - card.mtimeMs > CARD_STALE_WARN_MS)
    out.push(`在跑，但进展卡 ${span(card.mtimeMs, now)}没更新`);
  return out;
}

/**
 * 纯函数。sessions：session-manager 的会话信息（getAllSessions 的形状）；cards：进展卡服务 snapshot()；
 * teams：组队服务 listTeams()；facts(s) 返回 { busy, needsInput, needsLabel, failed, completed, completedAt, outputAt, listed, kind }，
 * 由调用方按 Hub 现有判断给出。「刚完成」必须有完成证据（completed），只有近期活动不算。
 */
function buildRunningOverview({ sessions = [], cards = [], teams = [], now = Date.now(), facts = () => ({}) } = {}) {
  const cardOf = new Map((cards || []).map(c => [c.sessionId, c]));
  const rows = [], rest = { total: 0 };
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    const f = facts(s) || {};
    if (f.listed === false) { rest.total++; continue; }
    const card = cardOf.get(s.id) || null;
    const outAt = lastOutputAt(s, f);
    const busy = !!f.busy;
    const warnings = warningsOf({ busy, card, outAt, now });
    const cardStuck = card && card.plain && card.plain.status === '卡住';
    let group = null, state;
    const fresh = busy || (outAt && now - outAt <= WAIT_KEEP_MS);
    if (f.needsInput && fresh) { group = 'waiting'; state = f.needsLabel || (busy ? '停在确认或选择上' : '答完了，在等你'); }
    else if (pendingDecision(card) && (fresh || now - (card.mtimeMs || 0) <= WAIT_KEEP_MS)) { group = 'waiting'; state = '进展卡在等你拍板'; }
    else if (f.failed) { group = 'suspect'; state = '运行异常'; }
    else if (cardStuck) { group = 'suspect'; state = '进展卡自报卡住'; }
    else if (busy && outAt && now - outAt > BUSY_SILENT_MS) { group = 'suspect'; state = '在跑，但久没输出'; }
    else if (warnings.length) { group = 'suspect'; state = busy ? '在跑' : '空闲'; }
    else if (busy) { group = 'running'; state = '在跑'; }
    else if (f.completed && (Number(f.completedAt) || outAt) && now - (Number(f.completedAt) || outAt) <= RECENT_DONE_MS) { group = 'done'; state = '已答完'; }
    if (!group) { rest.total++; continue; }
    const decision = group === 'waiting' && pendingDecision(card) ? card.plain.decision : null;
    rows.push({
      id: s.id, title: one(s.title || s.name || '未命名会话', 40), kind: f.kind || String(s.kind || ''), group, state,
      outAt: outAt || null, silent: ago(outAt, now), line: one(cardLine(card), 60),
      decision: decision ? { question: one(decision.question, 50), recommendation: one(decision.recommendation, 30) } : null,
      team: teamTag(s.id, teams), warnings,
    });
  }
  const order = Object.fromEntries(GROUPS.map(([k], i) => [k, i]));
  rows.sort((a, b) => order[a.group] - order[b.group] || (b.outAt || 0) - (a.outAt || 0));
  const counts = Object.fromEntries(GROUPS.map(([k]) => [k, rows.filter(r => r.group === k).length]));
  counts.rest = rest.total;
  return { rows, counts, at: now, ...renderText({ rows, counts, now }) };
}

function rowText(r) {
  const parts = [r.title, r.kind, r.state, r.silent === '没有输出记录' ? r.silent : r.silent + '有输出'];
  if (r.decision) parts.push('拍板：' + r.decision.question + (r.decision.recommendation ? '（推荐 ' + r.decision.recommendation + '）' : ''));
  else if (r.line) parts.push('卡：' + r.line);
  if (r.team) parts.push(r.team.text);
  return '- ' + parts.filter(Boolean).join('｜') + (r.warnings.length ? ' ⚠ ' + r.warnings.join('；') : '');
}

function renderText({ rows, counts, now }) {
  const stamp = new Date(now + 8 * HOUR).toISOString().slice(5, 16).replace('T', ' ');
  const head = `【在跑一览 · ${stamp}】` + GROUPS.map(([k, name]) => `${name} ${counts[k]}`).join(' · ') + ` · 其余 ${counts.rest}`;
  const tail = `其余 ${counts.rest} 个会话（空闲更久、休眠、群聊成员、内部会话）没列出。⚠ 是程序发现的矛盾，照带不解释。`;
  // 先按优先级尽量放行，放不下的从低优先级组折叠。
  const keep = new Map(GROUPS.map(([k]) => [k, []]));
  let budget = CAP - bytes(head) - bytes(tail) - GROUPS.length * 60;
  for (const r of rows) {
    const line = rowText(r);
    if (bytes(line) + 1 > budget) continue;
    budget -= bytes(line) + 1; keep.get(r.group).push(line);
  }
  const out = [head];
  for (const [k, name] of GROUPS) {
    if (!counts[k]) continue;
    const lines = keep.get(k), hidden = counts[k] - lines.length;
    out.push(`【${name}（${counts[k]}）】`, ...lines);
    if (hidden > 0) out.push(`- （另有 ${hidden} 个没列出）`);
  }
  if (!rows.length) out.push('现在没有在跑、在等你或刚完成的会话。');
  out.push(tail);
  const text = out.join('\n');
  return { text, bytes: bytes(text) };
}

// ---- 主进程侧取数：只读 Hub 已有的会话信息、进展卡快照和组队表 ----
function createRunningOverview({ getSessions, getCards = () => [], getTeams = () => [], isAgentTurnActive = () => false,
  isReportedRunning = null, getLastOutputAt = () => 0, exclude = () => false, now = () => Date.now() } = {}) {
  const truth = require('./session-runtime-truth');
  const attention = require('./session-attention-state');
  const { getKindLabel } = require('./ai-kinds');
  function facts(s, extraExclude) {
    // 带 purpose 的是助理、论坛摘要这类内部会话；meetingId 是群聊成员：都只计数。
    const listed = !s.purpose && !s.meetingId && !exclude(s) && !(extraExclude && extraExclude(s))
      && !['closed', 'dormant', 'suspending'].includes(s.status);
    let state = 'unknown';
    try { state = truth.getSessionRuntimeTruth(s).state; } catch {}
    const reported = typeof isReportedRunning === 'function' ? isReportedRunning(s) : null;
    // 在跑：回合在进行 > 界面的在跑报告 > 可信的运行时状态；旧字段 status=running 只在都没有时兜底（Codex 审查 P2）。
    const trusted = state && state !== 'unknown';
    const busy = !!isAgentTurnActive(s.id) || (reported != null ? reported === true
      : trusted ? ['starting', 'running'].includes(state) : s.status === 'running');
    let att = 'none';
    try { att = attention.attentionStateOf(s); } catch {}
    // 权威状态 waiting（等批准、等确认）也算在等你（Codex 审查 P1）。
    const approval = state === 'waiting';
    const needsInput = approval || s.needsUserInput === true || att === 'needs-input';
    const failed = state === 'failed' || s.status === 'error';
    // 完成证据：运行时状态「已完成」、答完待看，或记过完成时间且之后没被中断/出错。
    const completedAt = Number(s.lastCompletedAt) || 0;
    const completed = state === 'completed' || att === 'reply-ready' || (completedAt > 0 && !['interrupted', 'failed', 'starting', 'running', 'waiting'].includes(state));
    let outputAt = 0;
    try { outputAt = Number(getLastOutputAt(s.id)) || 0; } catch {}
    const kind = getKindLabel(String(s.kind || '').replace(/-resume$/, ''));
    return { listed, busy, needsInput, needsLabel: approval ? '在等你批准或确认' : '', failed, completed, completedAt, outputAt, kind };
  }
  // exclude：调用方再排除一批（公司助理排除它自己那些问答会话）。
  function get({ exclude: extraExclude = null } = {}) {
    let cards = [], teams = [];
    try { cards = getCards() || []; } catch {}
    try { teams = getTeams() || []; } catch {}
    return buildRunningOverview({ sessions: getSessions() || [], cards, teams, now: now(), facts: s => facts(s, extraExclude) });
  }
  return { get, facts };
}

module.exports = { buildRunningOverview, createRunningOverview, renderText, CAP, SILENT_WARN_MS, CARD_STALE_WARN_MS, BUSY_SILENT_MS, RECENT_DONE_MS };
