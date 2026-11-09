'use strict';
// 功能在后台替用户开的 CodeAgent 会话（PPT 找页、简报、团队分析、会议助理、助理问答、公司 AI 任务、论坛整理）
// 统一进侧栏「后台任务」分组：用户随时能看到进展，又不挤占自己的会话。
const BACKGROUND_PURPOSES = new Set(['company-assistant', 'company-ai', 'company-forum']);
const RESIDENT_PURPOSE = 'company-assistant';
const RESIDENT_TITLE = /^(?:公司助理(?: · 手机)?$|助理问答 · |手机问答 · )/;
const KEEP_FINISHED = 20;
const BUSY_NOTICE = '后台任务运行中，只能查看；结束后可继续提问';

const isBackgroundPurpose = purpose => BACKGROUND_PURPOSES.has(purpose);
const wasUsed = item => !!(item.lastCompletedAt || item.runStartedAt || item.lastRunStartedAt || item.lastMessageTime);
const isResidentCandidate = item => item?.purpose === RESIDENT_PURPOSE && RESIDENT_TITLE.test(String(item.title || ''));

// 预开但还没接过活的空会话不列出；运行中的全部列出，已结束的只留最近 KEEP_FINISHED 条。
function selectBackgroundTasks(items, { residentId = null, isRunning = () => false, activityTime = () => 0, keep = KEEP_FINISHED } = {}) {
  const tasks = items.filter(item => isBackgroundPurpose(item.purpose) && item.id !== residentId);
  const byRecent = (a, b) => activityTime(b) - activityTime(a);
  const running = tasks.filter(isRunning).sort(byRecent);
  const finished = tasks.filter(item => !isRunning(item) && wasUsed(item)).sort(byRecent).slice(0, keep);
  return { running, finished, items: [...running, ...finished] };
}

// 默认跟随运行状态：有任务在跑就展开，全部结束就折叠。用户手动点过，在运行状态变化前听用户的。
function backgroundExpanded(anyRunning, override) {
  return override && override.anyRunning === anyRunning ? override.expanded : anyRunning;
}

module.exports = { BUSY_NOTICE, KEEP_FINISHED, backgroundExpanded, isBackgroundPurpose, isResidentCandidate, selectBackgroundTasks };
