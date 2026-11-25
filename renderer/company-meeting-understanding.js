'use strict';
// 「会议理解」tab 顶部：理解线此刻卡在哪、为什么、能点什么（契约 7.1，m5 laneHealth）；
// 以及会议 AI 用的是谁（engineCurrent / engineSource）、录像补索引状态（m6）。纯函数，页面负责挂载。
// 老后端没有这些字段时返回 null / 空串，页面沿用原来的写法。

const OP_LABEL = { understand: '重新整理', 'retry-asr': '重试失败转写', 'skip-failed-asr': '跳过失败段出纪要', 'close-old-sessions': '再关一次' };
const SOURCE_LABEL = { meeting: '本场选择', global: '设置默认', auto: '自动推荐' };
// 需要用户注意的阶段放进醒目提示；其余（启动、整理中、等终端就绪、未确认收到）只写在状态行。
const ALERT_STAGES = new Set(['error', 'waiting-receipt', 'blocked-by-asr']);

const secs = ms => Math.max(0, Math.round(ms / 1000));
function waitText(ms) { const s = secs(ms); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; }

// 状态行里替代「CodeAgent 正在整理（X 秒）」的一句：没有 stage（老后端）或 idle 时返回 ''。
function stageLine(status) {
  const st = status?.understandingStage;
  if (!st || !st.stage || st.stage === 'idle' || ALERT_STAGES.has(st.stage)) return '';
  return String(st.text || '').trim();
}

// 醒目提示：{ tone, text, sub, ops:[{op,label}] }；没有要提示的返回 null。
function understandingAlert(status, { live = false } = {}) {
  if (!status) return null;
  const st = status.understandingStage, retry = status.understandingRetry, close = status.pendingClose, life = status.lifecycle;
  const ops = [], subs = [];
  let text = '', tone = 'warn';
  if (status.engineError) { text = status.engineError; ops.push({ op: 'pick-engine', label: '重新选择会议 AI' }); }
  else if (st && ALERT_STAGES.has(st.stage)) {
    text = String(st.text || (st.stage === 'error' ? '会议理解出错了' : '')).trim();
    for (const op of st.ops || []) if (!(op === 'skip-failed-asr' && live)) ops.push({ op, label: st.stage === 'waiting-receipt' && op === 'understand' ? '放弃这轮，重新整理' : OP_LABEL[op] || op });
    if (st.stage === 'error') ops.push({ op: 'pick-engine', label: '换引擎' });
  }
  if (retry && (retry.count || retry.retrying || retry.stopped)) {
    const why = retry.lastError?.label ? `（${retry.lastError.label}）` : '';
    subs.push(retry.retrying ? `正在自动重试第 ${(retry.count || 0) + 1} 次${why}` : retry.stopped ? `${retry.stopped}${why}`
      : `已自动重试 ${retry.count}/${retry.max || 3} 次${why}${Number.isFinite(retry.nextInMs) ? `，${waitText(retry.nextInMs)}后再试` : ''}`);
  }
  if (close) {
    subs.push(close.text || (close.gaveUp ? `旧理解会话关不掉，已试 ${close.attempts || 0} 次后停手（旧终端还占着内存）` : `旧理解会话关不掉，后台第 ${close.attempts || 1} 次重试中`));
    if ((close.gaveUp || close.rotationPaused) && !ops.some(o => o.op === 'close-old-sessions')) ops.push({ op: 'close-old-sessions', label: OP_LABEL['close-old-sessions'] });
  }
  if (life?.removing) subs.push('正在删除这场会议，关会话最长约 25 秒');
  else if (life?.closingOldSessions) subs.push('后台正在关旧理解会话');
  if (!text && !subs.length) return null;
  if (!text) { tone = 'info'; text = subs.shift(); }
  return { tone, text, sub: subs.join('；'), ops };
}

// 「当前用的是 <engineCurrent>（来自 本场选择｜设置默认｜自动推荐）」，附 engineNote。
function engineLine(status) {
  if (!status?.engineCurrent) return '';
  const from = SOURCE_LABEL[status.engineSource] ? `（来自${SOURCE_LABEL[status.engineSource]}）` : '';
  return `会议 AI：${status.engineCurrent}${from}${status.engineNote ? ' · ' + status.engineNote : ''}`;
}

// 录像补索引：进行中、等待（索引还在补）、失败；都没有返回 ''。
function repairText(full) {
  if (!full) return '';
  if (full.repairing) return '正在为录像补索引，补好后可拖动进度条（录像本身没丢）';
  if (full.repairPending) return String(full.repairPending);
  if (full.repairFailure) return full.repairFailure.nextAt ? '录像补索引没成功，稍后自动再试' : '录像补索引没成功，可直接打开原片，拖动可能不准';
  return '';
}

// 会后大卡头部：纪要失败（原因）与「整理中」分开。返回 null 表示沿用转写状态的写法。
function reviewStage(status, reviewReady) {
  const st = status?.understandingStage;
  if (reviewReady || !st) return null;
  if (st.stage === 'error') return { tone: 'red', text: '纪要没整理出来', detail: String(st.text || '').trim() };
  if (st.stage === 'blocked-by-asr') return { tone: 'amber', text: '纪要等转写', detail: String(st.text || '').trim() };
  return null;
}

module.exports = { stageLine, understandingAlert, engineLine, repairText, reviewStage, OP_LABEL };
