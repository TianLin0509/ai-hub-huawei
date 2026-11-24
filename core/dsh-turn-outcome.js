'use strict';
// DSH 一轮结束时怎么算、失败时给用户哪句话（2026-11-24 WeLink 反馈：DSH 经常弹「上一轮执行失败 · Codex turn failed」）。
//
// 以前 Hub 把 DSH 除「完成 / 中断」以外的结束都当失败，其中「某一步写到了单步输出上限」（max-tokens）并不是失败：
// 回答已经写出来了，只是那一步停在上限处；这种结束也不带原因，界面只好兜底成写死的 Codex 文案。
// 口径和提示闸门（core/notice-gate.js）一致：只有这一轮真没跑成、要用户再发一次的，才显示「上一轮执行失败」，并给一句人话。

// DSH 终端模式事件日志里 turn/end 的 reason.kind（@deepseek-ai/dsh-session TurnEndReasonMap）。
function dshTurnStatus(kind) {
  if (kind === 'completed' || kind === 'max-tokens') return 'completed';
  // forked 只出现在分叉出来的会话开头（源会话那一轮在分叉点还没结束），不是这里执行失败。
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked') return 'interrupted';
  return 'failed';
}

// 卡片模式走 ACP，DSH 的结束原因被桥换成 stopReason（max-tokens → max_tokens，blocked → refusal）。
function dshStopStatus(stopReason) {
  if (stopReason === 'end_turn' || stopReason === 'max_tokens') return 'completed';
  if (stopReason === 'cancelled') return 'interrupted';
  return 'failed';
}

const BLOCKED_TEXT = '这一轮被 DSH 的插件拦下了，没有调用模型；可以改一下再发';
const UNKNOWN_TEXT = 'DSH 这一轮没跑完，没有拿到具体原因；可以直接再发一次';
const TRANSPORT = /\bterminated\b|premature close|\bECONN[A-Z]+\b|fetch failed|socket hang up|other side closed|\bnetwork\b|stream ended (?:before|without)/i;
const TIMEOUT = /\btime(?:d)?\s*out\b|timeout/i;

// 从「400: {"error":{"message":"…"}}」这类原文里取出服务端给的那句话。
function serverMessage(text) {
  const start = text.indexOf('{');
  if (start < 0) return '';
  try {
    const body = JSON.parse(text.slice(start));
    const m = body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '');
    return typeof m === 'string' ? m : '';
  } catch { return ''; }
}

// DSH 报的失败原文 → 一行人话。公司反代给的中文提示原样保留（它已经讲清了卡在哪一步），只去掉协议外壳和内部标记。
function dshFailureText(raw, { kind } = {}) {
  if (kind === 'blocked' || raw === 'refusal') return BLOCKED_TEXT;
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return UNKNOWN_TEXT;
  const status = /^([45]\d\d)\b\s*[:：]?\s*/.exec(text);
  const inner = serverMessage(text);
  if (inner) text = inner.trim();
  else if (status) text = text.slice(status[0].length).trim() || text;
  text = text.replace(/\s*\[connection interrupted\]\s*/gi, ' ').trim();
  if (/[一-鿿]/.test(text)) return text.slice(0, 200);
  if (TRANSPORT.test(text)) return '和模型服务的连接中途断了，可以直接再发一次';
  if (TIMEOUT.test(text)) return '模型服务长时间没有回应，可以直接再发一次';
  const code = status ? `（HTTP ${status[1]}）` : '';
  return `DSH 调用模型失败${code}：${text.slice(0, 160)}`;
}

module.exports = { dshTurnStatus, dshStopStatus, dshFailureText, BLOCKED_TEXT, UNKNOWN_TEXT };
