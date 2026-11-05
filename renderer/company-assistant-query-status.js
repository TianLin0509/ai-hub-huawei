'use strict';
const { displayTime } = require('../core/company-assistant/data');

function messageCoverage(scope) {
  if (!scope) return null;
  const active = (scope.conversations || []).filter(c => !c.retained);
  const retrying = scope.retrying ?? (!scope.partial ? active.filter(c => c.reason === 'query-failed').length : 0);
  const failures = active.filter(c => c.failureCount >= 3).map(c => `${c.name}：${c.lastError || c.reason}`);
  const rotation = scope.rotating ? `${scope.priorityPending ? '可能有新消息的会话正优先更新' : '已优先核对可能有新消息的会话'}，其余定期核对（本轮更新 ${scope.completed || 0}/${scope.scheduled ?? scope.known ?? 0} 个会话）${scope.neverFetched ? `；${scope.neverFetched} 个会话尚未首次取到` : ''}` : '';
  const mode = scope.mode === 'full-check' ? '完整核对' : scope.mode === 'incremental' ? '增量更新' : scope.mode === 'query' ? '即时查询' : '';
  const audit = mode ? `${mode}；最近完整核对：${Number.isFinite(scope.lastFullCheckAt) ? displayTime(scope.lastFullCheckAt) : '尚未完成'}` : '';
  const reasons = [scope.stale ? '最近会话查询失败，显示上次记录' : '', scope.rateLimited ? `WeLink 限流，已取 ${scope.completed || 0} 个会话，其余下轮继续` : scope.partial ? `${scope.partial} 个会话未取全` : '',
    !scope.rateLimited ? rotation : '', retrying ? `${retrying} 个会话查询失败，下轮重试` : '', failures.length ? failures.join('；') : '',
    scope.identityMissing ? '账号编号暂未取得，沿用缓存，下轮核对' : '', scope.retained ? `${scope.retained} 个会话已掉出最近列表，仅保留回看窗口内缓存` : '',
    scope.neverFetched && !scope.partial && !rotation ? `${scope.neverFetched} 个会话尚未首次取到` : '', scope.directoryFallback ? '已退回兼容查询，覆盖待核对' : '', scope.limited ? `按设置只查询最近 ${scope.maxConversations} 个会话` : '',
    scope.directoryInvalid ? `${scope.directoryInvalid} 条会话目录记录无法解析` : '', active.some(c => c.unknownTime) ? '部分消息缺少时间，无法确认是否覆盖所选时段' : '', audit].filter(Boolean);
  const warning = scope.partial || scope.neverFetched || scope.priorityPending || scope.stale && !scope.cached || scope.directoryFallback || scope.directoryInvalid || scope.limited || active.some(c => c.unknownTime);
  return { status: warning ? 'partial' : scope.rateLimited || scope.stale || retrying || scope.identityMissing ? 'deferred' : rotation ? 'rotating' : 'complete', ...(mode ? { mode: scope.mode } : {}), ...(scope.rateLimited ? { reason: 'rate-limited' } : rotation ? { reason: 'rotation' } : {}), reasonLabel: reasons.join('；') };
}

function queryStatus(coverage, error, count) {
  if (coverage?.status === 'updating') return { label: '正在更新', color: 'ok', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'failed' || !coverage && error) return { label: '查询失败', color: 'warn', detail: error?.text || coverage?.reasonLabel || '' };
  if (coverage?.status === 'partial') return { label: '未取全', color: 'warn', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'deferred') return { label: '下轮更新', color: 'ok', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'rotating') return { label: '轮转中', color: 'ok', detail: coverage.reasonLabel || '' };
  if (coverage?.status === 'complete') return { label: `已取到 ${count ?? 0} 条`, color: 'ok', detail: coverage.mode ? coverage.reasonLabel || '' : '' };
  return { label: '', color: '', detail: '尚未确认' };
}

const errorMatches = (name, error) => error.label.startsWith(name) || name === '消息' && error.label.startsWith('最近会话');

function queryRows(data) {
  const errors = data.errors || [];
  return [['会议', data.counts?.meetings, data.meetingCoverage, 'meetings'], ['日程', data.counts?.calendar, data.calendarCoverage, 'calendar'],
    ['消息', data.counts?.messages, messageCoverage(data.scope), 'messages'], ['未读邮件', data.counts?.mails, data.mailCoverage, 'mails']]
    .map(([name, count, coverage, key]) => ({ name, ...queryStatus(data.updating?.includes(key) ? { status: 'updating', reasonLabel: '正在取数，暂显示上次完成的数据' } : coverage, errors.find(error => errorMatches(name, error)), count) }));
}

function refreshNotice(data) {
  const rows = queryRows(data);
  for (const error of data.errors || []) if (!rows.some(row => errorMatches(row.name, error))) rows.push({ name: error.label, ...queryStatus(null, error) });
  const failed = [...new Set(rows.filter(row => row.label === '查询失败').map(row => row.name))];
  const partial = [...new Set(rows.filter(row => row.label === '未取全').map(row => row.name))];
  return [failed.length ? `有 ${failed.length} 项没取到：${failed.join('、')}` : '', partial.length ? `有 ${partial.length} 项未取全：${partial.join('、')}` : ''].filter(Boolean).join('；');
}

module.exports = { messageCoverage, queryStatus, queryRows, refreshNotice };
