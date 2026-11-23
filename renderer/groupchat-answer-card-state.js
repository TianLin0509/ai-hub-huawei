'use strict';
// 回答文件模式下一张成员卡片的状态与按钮安排（纯函数，渲染层只负责把结果拼成 HTML）。
// 卡片头只露当下最该点的一两个按钮，其余进「更多」。

function statusBucket(status) {
  if (status === 'completed' || status === 'manual_extracted') return 'done';
  if (status === 'thinking' || status === 'streaming' || status === 'soft_alert' || status === 'queued'
      || status === 'awaiting_binding' || status === 'awaiting_final_text' || status === 'recovering') return 'running';
  if (status === 'errored' || status === 'timeout' || status === 'send_stuck' || status === 'transport_lost') return 'warn';
  if (status === 'off' || status === 'absent' || status === 'superseded' || status === 'interrupted') return 'muted';
  return 'idle';
}

// 这位成员本轮是否还在干活（还在干活时不给「提取」「重新发送」，免得拿到半截回答或让它同时做两份）。
// 整轮要等最慢的成员结束才结算；在那之前按这位成员自己的状态判断，先答完的人不必陪着等。
function memberRunning(state, message) {
  if (!state) return true;
  const n = Number(message.turnNum);
  const settled = (Array.isArray(state.turns) ? state.turns : []).find(t => t && Number(t.n) === n)?.byStatus?.[message.sid];
  if (settled) return statusBucket(settled) === 'running';
  const own = String(message.status || '');
  const persisted = !String(message.id || '').startsWith('pending-');
  if (persisted && own && own !== 'handed_off' && ['done', 'warn', 'muted'].includes(statusBucket(own))) return false;
  const live = Number(state.currentTurn) === n ? state._partialBy?.[message.sid]?.status : '';
  for (const s of [live, own]) {
    if (!s || s === 'handed_off') continue;
    if (s === 'accepted') return true;
    return statusBucket(s) === 'running';
  }
  return !!state.currentMode && state.currentMode !== 'idle' && Number(state.currentTurn) === n;
}

// 还在跑、尚无正文时卡片上的一句状态（与逐字收录卡片同一套说法）。
function waitingText(status) {
  return status === 'queued' ? '本条消息已排队，前一条任务结束后才会发送。'
    : status === 'accepted' ? '引擎已收到本条消息，正在等待执行。'
    : status === 'awaiting_binding' ? 'Agent 已开始工作，正在等待会话记录绑定；不会自动重复发送。'
    : status === 'awaiting_final_text' ? '本轮答案尚待确认，正在核对最终记录。'
    : status === 'recovering' ? 'Hub 正在按本轮凭证恢复，不会重复发送。'
    : status === 'soft_alert' ? '等待时间较长，仍在运行；可点「打开 CLI」看一眼。'
    : '思考中…';
}

/**
 * @returns {{ hasText, running, sendStuck, status, statusText, body, cursor, exposed: string[], more: string[], retry: string }}
 * body：text | stuck | failure | waiting | running | missing
 * 按钮键：submitAgain 再次发送 · recollect 重新提取 · extract 提取 · retryFailed 重试（报错时外露）
 *        resend 重新发送（收在「更多」）· openCli 打开 CLI · viewPrompt / copyPrompt
 *        modelChange 点此换模型（模型权限被收回时最先露出）
 *        trustedRepo 换到可信仓目录新建会话（目录受限时优先处理）
 */
function plan({ message, opts = {}, state, failureText = '', modelRevoked = false, trustedRepoRequired = false }) {
  const answer = message.answer || null;
  const hasText = !!String(message.content || '').trim();
  const status = String(opts.status || message.status || '');
  const sendStuck = !trustedRepoRequired && (opts.sendStatus || message.sendStatus) === 'stuck';
  const running = !trustedRepoRequired && !answer && memberRunning(state, message);
  const hasSid = !!message.sid;
  const failureCode = String((message.failure && message.failure.code) || message.statusReason || '');
  const failed = !hasText && !!failureText;
  const statusText = sendStuck ? '输入未提交'
    : status === 'waiting' ? '等待你的回复'
    : running ? (hasText ? '正在发言' : '思考中') : '';
  const body = hasText ? 'text' : sendStuck ? 'stuck' : failed ? 'failure'
    : status === 'waiting' ? 'waiting' : running ? 'running' : 'missing';
  // 重新发送：成员已停下才给。缺回答不等于没收到任务，所以默认收进「更多」；
  // 本轮明确报错（且不是「提交待核对」）时直接露出「重试」。
  const canResend = hasSid && !trustedRepoRequired && !running && !sendStuck && failureCode !== 'submission_unknown';
  // 模型权限被收回时先换模型，原样重试只会再失败一次。
  const retryFailed = canResend && !modelRevoked && !hasText && (failed || status === 'errored' || status === 'timeout');
  const readError = !!answer?.readError;
  const exposed = [];
  if (hasSid) {
    if (trustedRepoRequired) exposed.push('trustedRepo');
    else if (modelRevoked) exposed.push('modelChange');
    if (sendStuck) exposed.push('submitAgain');
    if (readError) exposed.push('recollect');
    if (!hasText && !readError && !running && !sendStuck) exposed.push('extract');
    if (retryFailed) exposed.push('retryFailed');
    if (!hasText) exposed.push('openCli');
  }
  const more = [];
  if (message.sourcePrompt) more.push('viewPrompt', 'copyPrompt');
  if (hasSid && hasText) more.push('openCli');
  return { hasText, running, sendStuck, status, statusText, body, cursor: running && !sendStuck,
    exposed, more, retry: canResend && !retryFailed ? 'resend' : '' };
}

module.exports = { statusBucket, memberRunning, waitingText, plan };
